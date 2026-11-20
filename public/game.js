(() => {
  'use strict';

  // ------------------------------------------------------------------ helpers
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ordinal = (n) => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  const screens = {};
  ['join', 'lobby', 'race', 'results'].forEach((k) => { screens[k] = $('#screen-' + k); });
  let currentScreen = 'join';
  function show(name) {
    currentScreen = name;
    for (const k in screens) screens[k].classList.toggle('active', k === name);
    if (name === 'race') focusInput();
  }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // -------------------------------------------------------------------- state
  let ws = null;
  let myId = null;
  let room = null;        // latest snapshot from the server
  let inviteOrigin = location.origin;
  let offset = 0;         // serverTime - localTime
  let played = false;     // did I take part in the current/last race?
  let lastState = '';

  let text = '';
  let chars = [];         // <span> per character
  let typed = '';
  let prefix = 0;         // number of correct characters from the start
  let errors = 0;
  let finishedLocal = false;
  let lastSent = { p: -1, e: -1 };
  const keyTimes = [];    // timestamps of recent correct keys (speed -> scenery)

  const now = () => Date.now() + offset;

  // ------------------------------------------------------------------ network
  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function connectAndJoin(roomCode) {
    const name = $('#name').value.trim();
    try { localStorage.setItem('turbotype-name', name); } catch (_) { /* ignore */ }
    $('#joinError').textContent = '';
    const payload = { t: 'join', name, room: roomCode };

    if (ws && ws.readyState === 1) { send(payload); return; }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host);
    ws.onopen = () => send(payload);
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (_) { return; }
      onMessage(m);
    };
    ws.onclose = () => {
      if (myId) {
        toast('Connection lost. Reloading...');
        setTimeout(() => { location.href = location.pathname; }, 1500);
      } else {
        $('#joinError').textContent = 'Cannot reach the game server. Is it running?';
      }
    };
  }

  function onMessage(m) {
    switch (m.t) {
      case 'joined':
        myId = m.id;
        if (
          location.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) &&
          m.lanOrigin
        ) inviteOrigin = m.lanOrigin;
        $('#roomTag').hidden = false;
        $('#roomTagCode').textContent = m.room;
        try { history.replaceState(null, '', '?room=' + m.room); } catch (_) { /* ignore */ }
        break;

      case 'error':
        $('#joinError').textContent = m.msg;
        toast(m.msg);
        break;

      case 'start':
        beginRace(m.text);
        break;

      case 'room':
        room = m;
        offset = m.now - Date.now();
        handleRoom();
        break;
    }
  }

  function handleRoom() {
    const st = room.state;
    if (st === 'lobby' || (st === 'finished' && !played)) {
      if (currentScreen !== 'lobby') show('lobby');
      renderLobby();
    } else if (st === 'countdown' || st === 'racing') {
      if (played && currentScreen !== 'race') show('race');
    } else if (st === 'finished') {
      renderResults();
      if (currentScreen !== 'results') show('results');
    }
    lastState = st;
  }

  // ------------------------------------------------------------------- lobby
  function renderLobby() {
    $('#lobbyCode').textContent = room.code;
    const list = $('#lobbyPlayers');
    list.textContent = '';
    for (const p of room.players) {
      const li = el('li');
      const chip = el('span', 'chip');
      chip.style.background = p.color;
      li.appendChild(chip);
      li.appendChild(el('span', '', p.name));
      const tags = [];
      if (p.id === room.hostId) tags.push('host');
      if (p.id === myId) tags.push('you');
      if (tags.length) li.appendChild(el('span', 'tag', tags.join(', ')));
      list.appendChild(li);
    }
    const iAmHost = room.hostId === myId;
    $('#btnStart').hidden = !iAmHost;
    $('#lobbyWait').hidden = iAmHost;
  }

  // ----------------------------------------------------------------- results
  function renderResults() {
    const body = $('#resultsBody');
    body.textContent = '';
    const players = room.players.slice().sort((a, b) => (a.rank || 99) - (b.rank || 99));
    for (const p of players) {
      const tr = el('tr', (p.id === myId ? 'me ' : '') + (p.rank === 1 ? 'first' : ''));
      tr.appendChild(el('td', '', p.rank ? ordinal(p.rank) : '-'));

      const nameTd = el('td');
      const cell = el('div', 'name-cell');
      const chip = el('span', 'chip');
      chip.style.background = p.color;
      cell.appendChild(chip);
      cell.appendChild(el('span', '', p.name + (p.id === myId ? ' (you)' : '')));
      nameTd.appendChild(cell);
      tr.appendChild(nameTd);

      const total = room.total || 1;
      const acc = p.progress + p.errors > 0 ? Math.round((p.progress / (p.progress + p.errors)) * 100) : 100;
      const wpm = p.finished ? p.wpm : p.wpm || 0;
      tr.appendChild(el('td', '', String(wpm)));
      tr.appendChild(el('td', '', acc + '%'));
      tr.appendChild(el('td', '', p.finished ? (p.timeMs / 1000).toFixed(1) + 's' : 'DNF ' + Math.round((p.progress / total) * 100) + '%'));
      body.appendChild(tr);
    }
    const iAmHost = room.hostId === myId;
    $('#btnAgain').hidden = !iAmHost;
    $('#resultsWait').hidden = iAmHost;
  }

  // ------------------------------------------------------------------ typing
  const input = $('#hiddenInput');
  const line = $('#line');
  const typebar = $('#typebar');
  let charW = 18;

  function focusInput() { try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); } }

  function buildText(t) {
    text = t;
    line.textContent = '';
    chars = [];
    for (const c of t) {
      const s = document.createElement('span');
      s.textContent = c;
      line.appendChild(s);
      chars.push(s);
    }
    // measure one character of the monospace font
    const probe = el('span', '', 'MMMMMMMMMM');
    probe.style.visibility = 'hidden';
    probe.style.position = 'absolute';
    line.appendChild(probe);
    charW = probe.getBoundingClientRect().width / 10 || 18;
    line.removeChild(probe);
    updateText();
  }

  function prefixOf(v) {
    let i = 0;
    while (i < v.length && i < text.length && v[i] === text[i]) i++;
    return i;
  }

  function updateText() {
    for (let i = 0; i < chars.length; i++) {
      let cls = '';
      if (i < prefix) cls = 'ok';
      else if (i < typed.length) cls = 'bad';
      else if (i === typed.length && !finishedLocal) cls = 'cur';
      if (chars[i].className !== cls) chars[i].className = cls;
    }
    const vw = line.parentElement.clientWidth;
    const caretX = typed.length * charW;
    const target = vw * 0.32 - caretX;
    line.style.transform = 'translateX(' + target.toFixed(1) + 'px)';
  }

  function isRacing() {
    return !!room && played && !finishedLocal && room.state !== 'finished' && now() >= room.startAt;
  }

  function beginRace(t) {
    played = true;
    finishedLocal = false;
    typed = '';
    prefix = 0;
    errors = 0;
    lastSent = { p: -1, e: -1 };
    keyTimes.length = 0;
    input.value = '';
    $('#finishNote').hidden = true;
    for (const k in display) delete display[k];
    shownWpm = 0;
    speed = 0;
    show('race');
    buildText(t);
  }

  input.addEventListener('input', () => {
    if (!isRacing()) { input.value = typed; return; }
    let v = input.value;
    const p = prefixOf(v);
    if (v.length > p + 6) v = v.slice(0, p + 6); // stop after a few wrong keys
    if (v.length > text.length) v = v.slice(0, text.length);

    if (v.length > typed.length) {
      for (let i = typed.length; i < v.length; i++) {
        if (v[i] !== text[i]) errors++;
      }
    }
    const before = prefix;
    typed = v;
    input.value = v;
    prefix = prefixOf(v);
    if (prefix > before) keyTimes.push(performance.now());

    if (prefix >= text.length) {
      finishedLocal = true;
      send({ t: 'progress', p: prefix, e: errors });
      lastSent = { p: prefix, e: errors };
      input.blur();
    }
    updateText();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Backspace' || !isRacing()) return;
    e.preventDefault();
    if (!typed.length) return;
    typed = typed.slice(0, -1);
    input.value = typed;
    prefix = prefixOf(typed);
    updateText();
  });

  input.addEventListener('paste', (e) => e.preventDefault());
  input.addEventListener('drop', (e) => e.preventDefault());
  input.addEventListener('focus', () => typebar.classList.add('focus'));
  input.addEventListener('blur', () => typebar.classList.remove('focus'));
  typebar.addEventListener('click', focusInput);
  document.addEventListener('keydown', (e) => {
    if (currentScreen !== 'race' || document.activeElement === input) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    focusInput();
  });

  // send progress to server (only when it changed)
  setInterval(() => {
    if (!played || !ws || ws.readyState !== 1 || !room) return;
    if (finishedLocal) {
      // keep re-sending until the server confirms the finish (it may clamp very fast input)
      const me = room.players.find((p) => p.id === myId);
      if (room.state !== 'finished' && me && !me.finished) send({ t: 'progress', p: prefix, e: errors });
      return;
    }
    if (prefix !== lastSent.p || errors !== lastSent.e) {
      send({ t: 'progress', p: prefix, e: errors });
      lastSent = { p: prefix, e: errors };
    }
  }, 80);

  // ------------------------------------------------------------ track drawing
  const cv = $('#track');
  const cx = cv.getContext('2d');
  const gaugeCv = $('#gauge');
  const gx = gaugeCv.getContext('2d');
  const display = {};     // id -> smoothed progress 0..1
  let scroll = 0;         // scenery offset
  let speed = 0;          // scenery speed px/s
  let shownWpm = 0;
  let wheelAngle = 0;

  const stars = Array.from({ length: 70 }, (_, i) => ({
    x: ((i * 97) % 100) / 100,
    y: ((i * 53) % 100) / 100,
    r: 0.6 + ((i * 31) % 10) / 10
  }));

  function layout(n) {
    const w = cv.parentElement.clientWidth || 800;
    const laneH = 46;
    const sceneH = 118;
    const h = sceneH + Math.max(n, 2) * laneH + 14;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.height = h + 'px';
    }
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h, laneH, sceneH, s: clamp(w / 900, 0.62, 1) };
  }

  function drawScenery(L) {
    const { w, h, sceneH } = L;
    // night sky
    const sky = cx.createLinearGradient(0, 0, 0, sceneH);
    sky.addColorStop(0, '#0c0a2c');
    sky.addColorStop(1, '#3a2478');
    cx.fillStyle = sky;
    cx.fillRect(0, 0, w, sceneH);
    cx.fillStyle = '#fff';
    for (const st of stars) {
      cx.globalAlpha = 0.5 + st.r * 0.25;
      cx.fillRect(st.x * w, st.y * (sceneH - 50), st.r, st.r);
    }
    cx.globalAlpha = 1;

    // tree line (slow parallax)
    const step = 54;
    const period = Math.ceil((w + 120) / step) * step;
    for (let i = 0; i < period / step; i++) {
      const tx = ((((i * step - scroll * 0.2) % period) + period) % period) - 60;
      const th = 22 + ((i * 37) % 26);
      cx.fillStyle = i % 2 ? '#14352a' : '#1a4733';
      cx.beginPath();
      cx.ellipse(tx, sceneH - 36, 34, th, 0, Math.PI, 0);
      cx.fill();
    }
    cx.fillStyle = '#14352a';
    cx.fillRect(0, sceneH - 38, w, 10);

    // guard rail
    const railY = sceneH - 30;
    cx.fillStyle = '#8d8fa0';
    cx.fillRect(0, railY, w, 4);
    cx.fillRect(0, railY + 10, w, 4);
    cx.fillStyle = '#c9cad6';
    const postGap = 44;
    const off = (scroll * 0.6) % postGap;
    for (let x = -off; x < w; x += postGap) cx.fillRect(x, railY - 2, 4, 20);

    // red/white curb
    const curbY = sceneH - 12;
    const sw = 22;
    const coff = scroll % (sw * 2);
    for (let x = -coff - sw * 2; x < w + sw; x += sw * 2) {
      cx.fillStyle = '#e5322d';
      cx.fillRect(x, curbY, sw, 12);
      cx.fillStyle = '#f1efe8';
      cx.fillRect(x + sw, curbY, sw, 12);
    }

    // road
    cx.fillStyle = '#34353e';
    cx.fillRect(0, sceneH, w, h - sceneH);
    cx.fillStyle = '#2a2b33';
    cx.fillRect(0, h - 8, w, 8);
  }

  function drawLaneLines(L, n) {
    const { w, sceneH, laneH } = L;
    cx.save();
    cx.strokeStyle = 'rgba(255,255,255,.32)';
    cx.lineWidth = 2;
    cx.setLineDash([20, 24]);
    cx.lineDashOffset = scroll % 44;
    for (let k = 1; k < n; k++) {
      const y = sceneH + k * laneH;
      cx.beginPath();
      cx.moveTo(0, y);
      cx.lineTo(w, y);
      cx.stroke();
    }
    cx.restore();
  }

  function drawFinish(L, n) {
    const { w, sceneH, laneH } = L;
    const x = w - 26;
    const sq = 8;
    const rows = Math.ceil((n * laneH) / sq);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < 2; c++) {
        cx.fillStyle = (r + c) % 2 ? '#111' : '#f1efe8';
        cx.fillRect(x + c * sq, sceneH + r * sq, sq, sq);
      }
    }
  }

  function wheel(x, y, r) {
    cx.fillStyle = '#0b0b10';
    cx.beginPath();
    cx.arc(x, y, r, 0, Math.PI * 2);
    cx.fill();
    cx.fillStyle = '#c9cad6';
    cx.beginPath();
    cx.arc(x, y, r * 0.55, 0, Math.PI * 2);
    cx.fill();
    cx.strokeStyle = '#555';
    cx.lineWidth = 1.5;
    for (let i = 0; i < 3; i++) {
      const a = wheelAngle + (i * Math.PI) / 3;
      cx.beginPath();
      cx.moveTo(x - Math.cos(a) * r * 0.55, y - Math.sin(a) * r * 0.55);
      cx.lineTo(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55);
      cx.stroke();
    }
  }

  // Side-view car facing right. (x, y) = centre of the car on the ground line.
  function drawCar(x, y, color, s, moving) {
    cx.save();
    cx.translate(x, y);
    cx.scale(s, s);

    cx.fillStyle = 'rgba(0,0,0,.35)';
    cx.beginPath();
    cx.ellipse(0, 2, 34, 4, 0, 0, Math.PI * 2);
    cx.fill();

    if (moving) { // headlight glow
      const g = cx.createLinearGradient(34, 0, 90, 0);
      g.addColorStop(0, 'rgba(255,240,170,.35)');
      g.addColorStop(1, 'rgba(255,240,170,0)');
      cx.fillStyle = g;
      cx.beginPath();
      cx.moveTo(33, -9);
      cx.lineTo(90, -20);
      cx.lineTo(90, 0);
      cx.lineTo(33, -5);
      cx.fill();
    }

    // body
    cx.fillStyle = color;
    cx.beginPath();
    cx.moveTo(-34, -4);
    cx.lineTo(-34, -12);
    cx.quadraticCurveTo(-32, -15, -24, -15);
    cx.lineTo(-14, -16);
    cx.lineTo(-7, -23);
    cx.lineTo(10, -23);
    cx.lineTo(21, -15);
    cx.lineTo(30, -13);
    cx.quadraticCurveTo(35, -11, 35, -4);
    cx.closePath();
    cx.fill();

    // window
    cx.fillStyle = 'rgba(15,22,40,.88)';
    cx.beginPath();
    cx.moveTo(-10, -16.5);
    cx.lineTo(-5.5, -21);
    cx.lineTo(8.5, -21);
    cx.lineTo(16, -16.5);
    cx.closePath();
    cx.fill();

    // shading + lights
    cx.fillStyle = 'rgba(0,0,0,.22)';
    cx.fillRect(-34, -8, 69, 4);
    cx.fillStyle = '#ffe88a';
    cx.fillRect(31, -11, 4, 3);
    cx.fillStyle = '#ff3b3b';
    cx.fillRect(-34, -11, 3, 3);

    wheel(-19, -2, 6.5);
    wheel(21, -2, 6.5);
    cx.restore();
  }

  function drawBadge(x, y, label) {
    cx.save();
    cx.fillStyle = '#27c46b';
    cx.beginPath();
    cx.moveTo(x - 30, y - 10);
    cx.lineTo(x + 2, y - 10);
    cx.lineTo(x + 10, y);
    cx.lineTo(x + 2, y + 10);
    cx.lineTo(x - 30, y + 10);
    cx.closePath();
    cx.fill();
    cx.fillStyle = '#052013';
    cx.font = '700 15px "Barlow Condensed", sans-serif';
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.fillText(label, x - 12, y + 1);
    cx.restore();
  }

  function drawTrack(dt) {
    const players = room ? room.players : [];
    const n = players.length;
    const L = layout(n);
    drawScenery(L);
    drawLaneLines(L, n);
    drawFinish(L, n);

    const total = room && room.total ? room.total : Math.max(text.length, 1);
    const x0 = 28 + 36 * L.s;
    const x1 = L.w - 34 - 36 * L.s;

    // live ordering for the "#rank" badge
    const order = players
      .map((p) => ({
        id: p.id,
        prog: p.id === myId ? prefix / total : p.progress / total,
        rank: p.rank || 99
      }))
      .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : b.prog - a.prog));

    players.forEach((p, i) => {
      const mine = p.id === myId;
      const target = mine ? prefix / total : p.progress / total;
      if (display[p.id] === undefined) display[p.id] = 0;
      display[p.id] += (target - display[p.id]) * Math.min(1, dt * (mine ? 22 : 10));
      const x = x0 + (x1 - x0) * clamp(display[p.id], 0, 1);
      const y = L.sceneH + i * L.laneH + L.laneH * 0.8;
      const moving = room && room.state === 'racing' && !p.finished;

      drawCar(x, y, p.color, L.s, moving);

      cx.font = '600 13px "Barlow Condensed", sans-serif';
      cx.textAlign = 'center';
      cx.textBaseline = 'alphabetic';
      cx.fillStyle = 'rgba(0,0,0,.55)';
      const label = p.name + (mine ? ' (you)' : '') + (p.rank && room.state !== 'lobby' && p.finished ? '  ' + ordinal(p.rank) : '');
      cx.fillText(label, x + 1, y - 27 * L.s + 1);
      cx.fillStyle = mine ? '#ffd36a' : '#f1efe8';
      cx.fillText(label, x, y - 27 * L.s);

      if (mine && room.state !== 'countdown') {
        const rank = order.findIndex((o) => o.id === myId) + 1;
        drawBadge(Math.max(36, x - 36 * L.s - 22), y - 10, '#' + rank);
      }
    });
  }

  // ----------------------------------------------------------------- gauge
  function drawGauge(wpm) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = gaugeCv.clientWidth || 130;
    const cssH = gaugeCv.clientHeight || 86;
    if (gaugeCv.width !== Math.round(cssW * dpr)) {
      gaugeCv.width = Math.round(cssW * dpr);
      gaugeCv.height = Math.round(cssH * dpr);
    }
    gx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gx.clearRect(0, 0, cssW, cssH);
    const cxp = cssW / 2;
    const cyp = cssH * 0.56;
    const r = Math.min(cssW * 0.4, cssH * 0.5);
    const a0 = Math.PI * 0.8;
    const sweep = Math.PI * 1.4;
    const max = 150;

    const zones = [['#27c46b', 0.5], ['#ffb020', 0.8], ['#e5322d', 1]];
    let from = 0;
    gx.lineWidth = 6;
    for (const [col, to] of zones) {
      gx.strokeStyle = col;
      gx.globalAlpha = 0.85;
      gx.beginPath();
      gx.arc(cxp, cyp, r, a0 + sweep * from, a0 + sweep * to);
      gx.stroke();
      from = to;
    }
    gx.globalAlpha = 1;

    gx.strokeStyle = '#c9cad6';
    gx.lineWidth = 1.5;
    for (let i = 0; i <= 10; i++) {
      const a = a0 + (sweep * i) / 10;
      const r1 = r - 7;
      const r2 = r - (i % 5 === 0 ? 14 : 11);
      gx.beginPath();
      gx.moveTo(cxp + Math.cos(a) * r1, cyp + Math.sin(a) * r1);
      gx.lineTo(cxp + Math.cos(a) * r2, cyp + Math.sin(a) * r2);
      gx.stroke();
    }

    const na = a0 + sweep * clamp(wpm / max, 0, 1);
    gx.strokeStyle = '#ff4a4a';
    gx.lineWidth = 3;
    gx.lineCap = 'round';
    gx.beginPath();
    gx.moveTo(cxp, cyp);
    gx.lineTo(cxp + Math.cos(na) * (r - 10), cyp + Math.sin(na) * (r - 10));
    gx.stroke();
    gx.fillStyle = '#c9cad6';
    gx.beginPath();
    gx.arc(cxp, cyp, 4, 0, Math.PI * 2);
    gx.fill();
  }

  // -------------------------------------------------------------------- HUD
  let lastCountText = '';
  function updateHud(dt) {
    if (!room) return;
    const t = now();
    const cd = $('#countdown');
    let label = '';
    let go = false;

    if (room.state === 'countdown' || t < room.startAt) {
      const secs = Math.ceil((room.startAt - t) / 1000);
      label = secs > 0 ? String(Math.min(secs, 3)) : '';
    } else if (t - room.startAt < 700) {
      label = 'GO!';
      go = true;
    }
    if (label !== lastCountText) {
      cd.textContent = label;
      cd.classList.toggle('go', go);
      lastCountText = label;
    }

    const elapsed = Math.max(0, (t - room.startAt) / 1000);
    const me = room.players.find((p) => p.id === myId);
    let timeShown = elapsed;
    if (finishedLocal && me && me.finished) timeShown = me.timeMs / 1000;
    if (room.state === 'finished') timeShown = Math.min(elapsed, room.limitMs / 1000);
    const m = Math.floor(timeShown / 60);
    $('#hudTime').textContent = m + ':' + (timeShown % 60).toFixed(1).padStart(4, '0');

    // WPM
    let wpm = 0;
    if (finishedLocal && me && me.finished) wpm = me.wpm;
    else if (isRacing() && elapsed > 1) wpm = prefix / 5 / (elapsed / 60);
    shownWpm += (wpm - shownWpm) * Math.min(1, dt * 6);
    $('#hudWpm').textContent = String(Math.round(shownWpm));
    drawGauge(shownWpm);

    // scenery speed follows recent typing speed
    const nowMs = performance.now();
    while (keyTimes.length && nowMs - keyTimes[0] > 1500) keyTimes.shift();
    const cps = keyTimes.length / 1.5;
    const racing = room.state === 'racing' && !finishedLocal;
    const targetSpeed = racing ? 60 + cps * 55 : room.state === 'racing' ? 120 : 0;
    speed += (targetSpeed - speed) * Math.min(1, dt * 4);
    scroll += speed * dt;
    wheelAngle += speed * dt * 0.12;

    const note = $('#finishNote');
    if (finishedLocal && me && me.finished && room.state !== 'finished') {
      note.hidden = false;
      note.textContent = 'You finished ' + ordinal(me.rank) + ' at ' + me.wpm + ' WPM. Waiting for the others...';
    }
  }

  let last = performance.now();
  function frame(t) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    if (currentScreen === 'race' && room) {
      updateHud(dt);
      drawTrack(dt);
    }
  }
  requestAnimationFrame(frame);
  window.addEventListener('resize', () => { if (text) updateText(); });

  // --------------------------------------------------------------- UI events
  try { $('#name').value = localStorage.getItem('turbotype-name') || ''; } catch (_) { /* ignore */ }
  const qRoom = new URLSearchParams(location.search).get('room');
  if (qRoom) $('#code').value = qRoom.toUpperCase().slice(0, 4);

  $('#btnCreate').addEventListener('click', () => connectAndJoin(''));
  $('#btnJoin').addEventListener('click', () => {
    const code = $('#code').value.trim();
    if (code.length < 4) { $('#joinError').textContent = 'Enter the 4-letter room code.'; return; }
    connectAndJoin(code);
  });
  $('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnJoin').click(); });
  $('#name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ($('#code').value.trim() ? $('#btnJoin') : $('#btnCreate')).click();
  });

  $('#btnStart').addEventListener('click', () => send({ t: 'start' }));
  $('#btnAgain').addEventListener('click', () => send({ t: 'start' }));
  $('#btnLeave').addEventListener('click', () => { location.href = location.pathname; });
  $('#btnCopy').addEventListener('click', async () => {
    const link = inviteOrigin + '/?room=' + (room ? encodeURIComponent(room.code) : '');
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied');
    } catch (_) {
      window.prompt('Copy this invite link:', link);
    }
  });
})();
