'use strict';
/**
 * Tiny WebSocket server implementation (RFC 6455) with zero dependencies.
 * Supports text messages, ping/pong, close frames and fragmentation.
 * It is enough for this game; for larger projects use the "ws" package.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 16 * 1024; // game messages are tiny; refuse anything big

class Connection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    this.isAlive = true;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClosed());
    socket.on('error', () => this._onClosed());
  }

  send(str) {
    if (this.closed || !this.socket.writable) return;
    this._writeFrame(0x1, Buffer.from(str, 'utf8'));
  }

  ping() {
    if (this.closed) return;
    this._writeFrame(0x9, Buffer.alloc(0));
  }

  close() {
    if (this.closed) return;
    try {
      this._writeFrame(0x8, Buffer.alloc(0));
      this.socket.end();
    } catch (_) { /* ignore */ }
  }

  terminate() {
    this.socket.destroy();
    this._onClosed();
  }

  _writeFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_PAYLOAD * 2) return this.terminate();
    while (this._parseFrame()) { /* keep parsing */ }
  }

  _parseFrame() {
    const b = this.buffer;
    if (b.length < 2) return false;

    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (b.length < 4) return false;
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (b.length < 10) return false;
      if (b.readUInt32BE(2) !== 0) { this.terminate(); return false; }
      len = b.readUInt32BE(6);
      offset = 10;
    }

    if (!masked || len > MAX_PAYLOAD) { this.terminate(); return false; } // clients must mask
    if (b.length < offset + 4 + len) return false;

    const mask = b.subarray(offset, offset + 4);
    const payload = Buffer.from(b.subarray(offset + 4, offset + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buffer = b.subarray(offset + 4 + len);

    switch (opcode) {
      case 0x8: // close
        this.close();
        break;
      case 0x9: // ping -> pong
        this._writeFrame(0xa, payload);
        break;
      case 0xa: // pong
        this.isAlive = true;
        break;
      case 0x0: // continuation
      case 0x1: // text
      case 0x2: // binary
        this.fragments.push(payload);
        if (fin) {
          const msg = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.isAlive = true;
          this.emit('message', msg);
        }
        break;
      default:
        this.terminate();
        return false;
    }
    return true;
  }

  _onClosed() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

/** Attach WebSocket upgrade handling to a Node http.Server. */
function attach(httpServer, onConnection) {
  const connections = new Set();

  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const conn = new Connection(socket);
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
    onConnection(conn, req);
  });

  // Heartbeat: drop dead connections (closed laptops, lost Wi-Fi...)
  const timer = setInterval(() => {
    for (const conn of connections) {
      if (!conn.isAlive) { conn.terminate(); continue; }
      conn.isAlive = false;
      conn.ping();
    }
  }, 20000);
  timer.unref();
}

module.exports = { attach };
