'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { attach } = require('./lib/ws');
const PASSAGES = require('./lib/passages');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const LAN_IP = Object.values(os.networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address || '';
const LAN_ORIGIN = LAN_IP ? 'http://' + LAN_IP + ':' + PORT : '';

// ---- Game settings (tweak freely) -----------------------------------------
const MAX_PLAYERS = 8;          // players per room (client draws one lane each)
const COUNTDOWN_MS = 4000;      // 3..2..1..GO
const RACE_LIMIT_MS = 120000;   // race ends after 2 minutes even if nobody finishes
const TICK_MS = 100;            // how often the server broadcasts live positions
const MAX_CPS = 30;             // anti-cheat: max characters/second (30 cps = 360 WPM)
const COLORS = ['#ff3d3d', '#ffb020', '#27d17f', '#2d9cff', '#b45cff', '#ff5fa8', '#e8e8ee', '#19d3d3'];
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O to avoid confusion

// ---- Static file server ----------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

// ---- Rooms -----------------------------------------------------------------
/** @type {Map<string, any>} */
const rooms = new Map();
let nextId = 1;

function makeCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
    if (!rooms.has(code)) return code;
  }
}

function createRoom() {
  const room = {
    code: makeCode(),
    players: new Map(),
    hostId: null,
    state: 'lobby', // lobby -> countdown -> racing -> finished
    text: '',
    lastPassage: -1,
    startAt: 0,
    finishedCount: 0
  };
  rooms.set(room.code, room);
  return room;
}

function cleanName(raw) {
  let name = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);
  if (!name) name = 'Racer' + Math.floor(100 + Math.random() * 900);
  return name;
}

function pickColor(room) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[0];
}

function playerWpm(room, p, now) {
  if (p.finished) return p.timeMs > 0 ? Math.round(p.progress / 5 / (p.timeMs / 60000)) : 0;
  if (room.state !== 'racing') return 0;
  const elapsed = now - room.startAt;
  if (elapsed < 1500) return 0;
  return Math.round(p.progress / 5 / (elapsed / 60000));
}

function snapshot(room) {
  const now = Date.now();
  return {
    t: 'room',
    code: room.code,
    state: room.state,
    hostId: room.hostId,
    now,
    startAt: room.startAt,
    limitMs: RACE_LIMIT_MS,
    total: room.text.length,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      progress: p.progress,
      errors: p.errors,
      finished: p.finished,
      rank: p.rank,
      timeMs: p.timeMs,
      wpm: playerWpm(room, p, now)
    }))
  };
}

function broadcast(room, obj) {
  const data = typeof obj === 'string' ? obj : JSON.stringify(obj);
  for (const p of room.players.values()) p.conn.send(data);
}

function sendRoom(room) {
  broadcast(room, snapshot(room));
}

/** Move countdown -> racing when the time has come. */
function advance(room, now) {
  if (room.state === 'countdown' && now >= room.startAt) room.state = 'racing';
}

function finishRace(room) {
  if (room.state === 'finished') return;
  room.state = 'finished';
  // Racers who did not finish are ranked by how far they got.
  const unfinished = [...room.players.values()]
    .filter((p) => !p.finished)
    .sort((a, b) => b.progress - a.progress);
  for (const p of unfinished) p.rank = ++room.finishedCount;
  sendRoom(room);
}

function startRace(room) {
  let idx;
  do { idx = Math.floor(Math.random() * PASSAGES.length); }
  while (PASSAGES.length > 1 && idx === room.lastPassage);
  room.lastPassage = idx;
  room.text = PASSAGES[idx];
  room.finishedCount = 0;
  room.state = 'countdown';
  room.startAt = Date.now() + COUNTDOWN_MS;
  for (const p of room.players.values()) {
    p.progress = 0;
    p.errors = 0;
    p.finished = false;
    p.rank = 0;
    p.timeMs = 0;
  }
  broadcast(room, { t: 'start', text: room.text, startAt: room.startAt });
  sendRoom(room);
}

function removePlayer(room, player) {
  room.players.delete(player.id);
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === player.id) room.hostId = room.players.values().next().value.id;
  sendRoom(room);
}

// Server heartbeat: live positions + state changes.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    advance(room, now);
    if (room.state === 'racing') {
      const everyoneDone = [...room.players.values()].every((p) => p.finished);
      if (everyoneDone || now - room.startAt >= RACE_LIMIT_MS) {
        finishRace(room);
        continue;
      }
    }
    if (room.state === 'countdown' || room.state === 'racing') sendRoom(room);
  }
}, TICK_MS);

// ---- WebSocket messages ----------------------------------------------------
attach(server, (conn) => {
  let player = null;
  let room = null;

  const fail = (msg) => conn.send(JSON.stringify({ t: 'error', msg }));

  conn.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join') {
      if (player) return;
      const code = String(m.room || '').trim().toUpperCase();
      let target;
      if (code) {
        target = rooms.get(code);
        if (!target) return fail('Room ' + code + ' was not found. Check the code and try again.');
        if (target.state === 'countdown' || target.state === 'racing') {
          return fail('That race has already started. Join when it finishes.');
        }
        if (target.players.size >= MAX_PLAYERS) return fail('That room is full (' + MAX_PLAYERS + ' players).');
      } else {
        target = createRoom();
      }
      room = target;
      player = {
        id: 'p' + nextId++,
        name: cleanName(m.name),
        color: pickColor(room),
        conn,
        progress: 0,
        errors: 0,
        finished: false,
        rank: 0,
        timeMs: 0
      };
      room.players.set(player.id, player);
      if (!room.hostId) room.hostId = player.id;
      conn.send(JSON.stringify({ t: 'joined', id: player.id, room: room.code, lanOrigin: LAN_ORIGIN }));
      sendRoom(room);
      return;
    }

    if (!player || !room) return;

    if (m.t === 'start') {
      if (room.hostId !== player.id) return;
      if (room.state !== 'lobby' && room.state !== 'finished') return;
      startRace(room);
      return;
    }

    if (m.t === 'progress') {
      const now = Date.now();
      advance(room, now);
      if (room.state !== 'racing' || player.finished) return;
      const total = room.text.length;
      const elapsedSec = Math.max(0, (now - room.startAt) / 1000);
      let p = Math.floor(Number(m.p));
      if (!Number.isFinite(p) || p <= player.progress) return;
      p = Math.min(p, total, Math.floor(elapsedSec * MAX_CPS) + 10); // anti-cheat cap
      if (p <= player.progress) return;
      player.progress = p;
      const e = Math.floor(Number(m.e));
      if (Number.isFinite(e) && e >= 0) player.errors = Math.min(e, 9999);
      if (p >= total) {
        player.finished = true;
        player.timeMs = now - room.startAt;
        player.rank = ++room.finishedCount;
        sendRoom(room);
      }
    }
  });

  conn.on('close', () => {
    if (player && room) removePlayer(room, player);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  TurboType is running!\n');
  console.log('  This computer :  http://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) console.log('  Same Wi-Fi    :  http://' + i.address + ':' + PORT);
    }
  }
  console.log('\n  Press Ctrl+C to stop.\n');
});

module.exports = server;
