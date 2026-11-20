# TurboType - multiplayer typing race

## About

Type the text on screen. **Every correct key moves your car forward.** Up to 8 players race in the same room in real time. A wrong key stops your car until you fix it with Backspace.

**Live demo:** [https://turbotype-game.onrender.com](https://turbotype-game.onrender.com)

No database, no framework, **no `npm install` needed** - the server uses only Node.js built-in modules (including a small WebSocket implementation in `lib/ws.js`).

## Run it

Requires Node.js 18 or newer.

```bash
cd turbotype
node server.js        # or: npm start
```

Open http://localhost:3000

* Click **Create a room**, share the 4-letter code (or the "Copy invite link" button).
* The invite link uses the computer's LAN address when the host opened the game at `localhost`. Friends on the same Wi-Fi can open it and enter their name to join. If needed, use `http://<your-computer-ip>:3000` (the server prints it on start) and enter the room code.
* Friends elsewhere on the internet need a publicly hosted version; a LAN invite link only works on the same network.
* The host clicks **Start race**. 3..2..1..GO, then type!

To test alone, open two browser windows (one normal, one incognito) and join the same room.

## Put it online (so friends anywhere can play)

Any host that runs Node.js and supports WebSockets works (Render, Railway, Fly.io, a VPS...).
Start command: `node server.js`. The server reads the `PORT` environment variable. The client automatically uses `wss://` on HTTPS.

## Project structure

```
server.js          HTTP static server + game rooms, countdown, ranking
lib/ws.js          Minimal WebSocket server (no dependencies)
lib/passages.js    Texts used for races - add your own here
public/index.html  Screens: join, lobby, race, results
public/style.css   Night-highway theme
public/game.js     Client: typing logic, canvas track and cars, speedometer, HUD
test/simulate.js   Bot test: plays a full race against the server (npm test)
```

## How it works

1. A player joins (`join`) and gets a lane; the first player is the host.
2. Host sends `start`; the server picks a passage, sends it with a start time, and runs a 4-second countdown.
3. While typing, the client sends `progress` (number of correct characters + mistakes) about 12 times per second.
4. The server validates it (progress can only go up, and is capped at 30 chars/second to stop cheating), then broadcasts every player's position every 100 ms.
5. First to finish the passage is 1st. Race also ends after 2 minutes. The results table shows place, WPM, accuracy and time. Host can start a rematch.

## Easy things to customise (top of `server.js`)

* `MAX_PLAYERS`, `COUNTDOWN_MS`, `RACE_LIMIT_MS`, `MAX_CPS`
* Car colours: `COLORS`
* Texts: `lib/passages.js`
* Look of the track and cars: `drawScenery()` and `drawCar()` in `public/game.js`

## Ideas for next steps

* Login + saved best WPM (MongoDB / PostgreSQL), global leaderboard
* Custom car skins, different tracks (day, desert, rain)
* Public matchmaking queue, spectators, chat
* Replace `lib/ws.js` with the `ws` or `socket.io` package for production scale

Run the automated test with `npm test` (Node 22+).
