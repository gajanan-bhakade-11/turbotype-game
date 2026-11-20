'use strict';
// Starts the server and plays a full race with 3 bots (needs Node 22+ for the built-in WebSocket client).
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3999;
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore'
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { console.error('FAIL:', msg); server.kill(); process.exit(1); };

function joinBot(name, cps, room) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:' + PORT);
    const b = { name, cps, ws, snap: null, text: '', startAt: 0, room: null };
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name, room: room || '' }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'joined') { b.id = m.id; b.room = m.room; resolve(b); }
      if (m.t === 'start') { b.text = m.text; b.startAt = m.startAt; }
      if (m.t === 'room') b.snap = m;
    };
  });
}

(async () => {
  await sleep(600);
  const host = await joinBot('Host', 14);
  const bots = [host, await joinBot('Slow', 6, host.room), await joinBot('Mid', 10, host.room)];
  await sleep(300);
  if (host.snap.players.length !== 3) fail('expected 3 players in lobby, got ' + host.snap.players.length);

  bots[1].ws.send(JSON.stringify({ t: 'start' }));
  await sleep(200);
  if (host.snap.state !== 'lobby') fail('non-host started the race');

  host.ws.send(JSON.stringify({ t: 'start' }));
  await sleep(300);
  if (host.snap.state !== 'countdown') fail('state should be countdown, is ' + host.snap.state);
  if (!host.text) fail('no text received');

  const late = await new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:' + PORT);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name: 'Late', room: host.room }));
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'error') resolve(m.msg); };
  });
  if (!/already started/.test(late)) fail('late joiner not rejected: ' + late);

  bots[2].ws.send(JSON.stringify({ t: 'progress', p: 9999, e: 0 })); // during countdown: ignored

  const total = host.text.length;
  await sleep(Math.max(0, host.startAt - Date.now()) + 50);
  const t0 = Date.now();
  bots[2].ws.send(JSON.stringify({ t: 'progress', p: total, e: 0 })); // instant-finish cheat
  await sleep(200);
  const cheat = host.snap.players.find((p) => p.name === 'Mid');
  if (cheat.finished || cheat.progress > 20) fail('anti-cheat failed, progress=' + cheat.progress);

  const timers = bots.map((b) => setInterval(() => {
    const p = Math.min(total, Math.floor(((Date.now() - t0) / 1000) * b.cps));
    b.ws.send(JSON.stringify({ t: 'progress', p, e: 1 }));
  }, 100));

  const deadline = Date.now() + 70000;
  while (host.snap.state !== 'finished' && Date.now() < deadline) await sleep(200);
  timers.forEach(clearInterval);
  if (host.snap.state !== 'finished') fail('race did not finish');

  const sorted = host.snap.players.slice().sort((a, b) => a.rank - b.rank);
  console.log('Results:', sorted.map((p) => p.name + ' #' + p.rank + ' ' + p.wpm + 'wpm').join(' | '));
  if (sorted.map((p) => p.name).join() !== 'Host,Mid,Slow') fail('wrong order ' + sorted.map((p) => p.name).join());

  host.ws.send(JSON.stringify({ t: 'start' }));
  await sleep(300);
  if (host.snap.state !== 'countdown') fail('rematch did not start');
  if (host.snap.players.some((p) => p.progress !== 0)) fail('progress not reset');

  console.log('PASS: lobby, host-only start, countdown, late-join block, anti-cheat, ranking, rematch');
  server.kill();
  process.exit(0);
})().catch((e) => fail(e.stack || e));
