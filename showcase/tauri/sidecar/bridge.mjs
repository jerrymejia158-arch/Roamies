// The phone bridge: lets a Roamie on a phone use this computer's brain.
// A small HTTP server that (1) serves the phone page (phone.html and the shared creature files) and (2) upgrades
// /ws to a WebSocket carrying the same JSON messages the desktop shell and the brain exchange over stdin/stdout.
// - Off unless asked for (ROAMIES_BRIDGE). It listens on loopback, or on this computer's Tailscale address
//   (ROAMIES_BRIDGE=tailscale): never on every interface.
// - A phone must say hello with the pairing token before anything else is read or sent. The token is
//   ROAMIES_BRIDGE_TOKEN, else one made on first use and kept in <data dir>/bridge.json (private, 0600).
// - No dependencies: the WebSocket framing (RFC 6455, text frames only) is done here.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_IN = 1 << 20; // a phone sends words and taps, never audio: 1 MB is far more than any message needs
const HELLO_MS = 5000; // how long a new connection has to say hello
const MAX_FAILS = 10, FAIL_WINDOW_MS = 60_000; // wrong tokens before new connections are refused for a while
export const DEFAULT_PORT = 3917;

// Tools that act on this computer's screen, apps or disk. A request that came from the phone can't use them:
// the person isn't looking at this screen, and a phone shouldn't be able to run commands here.
export const PHONE_BLOCKED_TOOLS = new Set(['take_screenshot', 'list_windows', 'read_window', 'act_in_app', 'draw', 'see_photo', 'run_command', 'write_file', 'open']);
export const phoneBlockedNote = (name) => `${name} works on the computer's own screen and files, and this request came from the phone. Answer without it, or say it has to be asked at the computer.`;

/** What a phone may send. Everything else is dropped. */
export const PHONE_TYPES = new Set(['ask', 'voice', 'answer', 'stop', 'ui_ready', 'reply_said', 'ping']);

/** The Sec-WebSocket-Accept value for a client's key. */
export const acceptKey = (key) => createHash('sha1').update(key + WS_GUID).digest('base64');

/** One unmasked frame (server to client). opcode 1 = text, 8 = close, 9 = ping, 10 = pong. */
export function encodeFrame(payload, opcode = 1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const n = body.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, body]);
}

/** Reads client frames out of a byte stream. push(chunk) returns the whole messages in it as { opcode, data };
 *  throws on anything a browser wouldn't send (unmasked, oversized, a broken continuation). */
export class FrameReader {
  constructor(max = MAX_IN) { this.buf = Buffer.alloc(0); this.parts = []; this.partOp = 0; this.size = 0; this.max = max; }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const fin = !!(this.buf[0] & 0x80), opcode = this.buf[0] & 0x0f;
      if (this.buf[0] & 0x70) throw new Error('reserved bits set');
      if (!(this.buf[1] & 0x80)) throw new Error('client frame not masked');
      let len = this.buf[1] & 0x7f, at = 2;
      if (len === 126) { if (this.buf.length < 4) break; len = this.buf.readUInt16BE(2); at = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) break;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(this.max)) throw new Error('message too large');
        len = Number(big); at = 10;
      }
      if (len > this.max) throw new Error('message too large');
      if (this.buf.length < at + 4 + len) break;
      const mask = this.buf.subarray(at, at + 4), data = Buffer.from(this.buf.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(at + 4 + len);
      if (opcode >= 8) { // control frames are never fragmented
        if (!fin || len > 125) throw new Error('bad control frame');
        out.push({ opcode, data });
        continue;
      }
      if (opcode === 0 && !this.partOp) throw new Error('continuation without a start');
      if (opcode !== 0 && this.partOp) throw new Error('new message inside a fragmented one');
      if (opcode !== 0) this.partOp = opcode;
      this.size += data.length;
      if (this.size > this.max) throw new Error('message too large');
      this.parts.push(data);
      if (fin) {
        out.push({ opcode: this.partOp, data: this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts) });
        this.parts = []; this.partOp = 0; this.size = 0;
      }
    }
    return out;
  }
}

/** Whether `given` is the pairing token, compared in constant time (hashed first, so lengths don't leak). */
export function tokenOk(given, token) {
  if (typeof given !== 'string' || typeof token !== 'string' || token.length < 16) return false;
  const a = createHash('sha256').update(given).digest(), b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

/** This computer's Tailscale IPv4 address (100.64.0.0/10), or null. `ifaces`: os.networkInterfaces(). */
export function tailscaleAddress(ifaces = os.networkInterfaces()) {
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [p, q] = a.address.split('.').map(Number);
      if (p === 100 && q >= 64 && q <= 127) return a.address;
    }
  }
  return null;
}

/** Where to listen for a ROAMIES_BRIDGE value: "1"/"on"/"local" = loopback, "tailscale" = the Tailscale address,
 *  or a literal loopback or Tailscale IPv4. Anything else (0.0.0.0, a LAN address, a name) is refused: null. */
export function bridgeHost(value, ifaces = os.networkInterfaces()) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v || v === '0' || v === 'off') return null;
  if (v === '1' || v === 'on' || v === 'local' || v === 'localhost' || v === '127.0.0.1') return '127.0.0.1';
  const ts = tailscaleAddress(ifaces);
  if (v === 'tailscale') return ts;
  return ts && v === ts ? ts : null;
}

/** The pairing token: ROAMIES_BRIDGE_TOKEN when it's long enough, else the saved one, else a new one (saved). */
export function pairingToken(dir, env = process.env) {
  if (typeof env.ROAMIES_BRIDGE_TOKEN === 'string' && env.ROAMIES_BRIDGE_TOKEN.length >= 16) return env.ROAMIES_BRIDGE_TOKEN;
  const file = path.join(dir, 'bridge.json');
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf8')).token;
    if (typeof t === 'string' && t.length >= 16) return t;
  } catch { /* none yet */ }
  const token = randomBytes(24).toString('base64url');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ token }, null, 2), { mode: 0o600 });
  return token;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webmanifest': 'application/manifest+json' };

/** The file under `root` for a request path, or null (outside root, a dot file, an unknown type). "/" is phone.html. */
export function staticFile(root, urlPath) {
  let p;
  try { p = decodeURIComponent(String(urlPath).split('?')[0]); } catch { return null; }
  if (p === '/' || p === '') p = '/phone.html';
  if (p.includes('\0') || p.split('/').some((s) => s.startsWith('.'))) return null;
  const file = path.resolve(root, `.${p}`);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return TYPES[path.extname(file).toLowerCase()] ? file : null;
}

/** Starts the bridge. onMessage(msg) gets each allowed message from a paired phone; onPaired() runs when one pairs.
 *  Resolves { address, port, send(msg), count(), close() }; send goes to every paired phone and returns how many. */
export function startBridge({ host, port = DEFAULT_PORT, token, root, version = '', onMessage = () => {}, onPaired = () => {}, log = () => {} }) {
  if (!host) return Promise.reject(new Error('no address to listen on'));
  if (typeof token !== 'string' || token.length < 16) return Promise.reject(new Error('pairing token too short'));
  const clients = new Set(), sockets = new Set();
  let fails = [];
  const tooManyFails = () => { const now = Date.now(); fails = fails.filter((t) => now - t < FAIL_WINDOW_MS); return fails.length >= MAX_FAILS; };

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const file = root ? staticFile(root, req.url) : null;
    if (!file) { res.writeHead(404).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (String(req.url).split('?')[0] !== '/ws' || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key) { socket.destroy(); return; }
    if (tooManyFails()) { socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return; }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    socket.setNoDelay(true);
    sockets.add(socket);
    const reader = new FrameReader();
    const c = { socket, paired: false, alive: true };
    const close = (code, why = '') => {
      if (socket.destroyed) return;
      const b = Buffer.alloc(2 + Buffer.byteLength(why)); b.writeUInt16BE(code, 0); b.write(why, 2);
      try { socket.end(encodeFrame(b, 8)); } catch { socket.destroy(); }
    };
    const helloTimer = setTimeout(() => { if (!c.paired) close(4408, 'no hello'); }, HELLO_MS);
    socket.on('data', (chunk) => {
      let frames;
      try { frames = reader.push(chunk); } catch (e) { log('bridge_bad_frame', { error: String(e.message) }); close(1002, 'protocol error'); return; }
      for (const f of frames) {
        if (f.opcode === 8) { close(1000); return; }
        if (f.opcode === 9) { socket.write(encodeFrame(f.data, 10)); continue; }
        if (f.opcode === 10) { c.alive = true; continue; }
        if (f.opcode !== 1) { close(1003, 'text only'); return; }
        let m;
        try { m = JSON.parse(f.data.toString('utf8')); } catch { continue; }
        if (!m || typeof m !== 'object' || typeof m.type !== 'string') continue;
        if (!c.paired) {
          if (m.type === 'hello' && tokenOk(m.token, token)) {
            c.paired = true; clearTimeout(helloTimer); clients.add(c);
            socket.write(encodeFrame(JSON.stringify({ type: 'hello', ok: true, version })));
            log('bridge_paired', { phones: clients.size });
            onPaired();
          } else {
            fails.push(Date.now());
            log('bridge_refused', { why: m.type === 'hello' ? 'token' : 'no hello' });
            close(4401, 'not paired');
            return;
          }
          continue;
        }
        if (m.type === 'ping') { socket.write(encodeFrame(JSON.stringify({ type: 'pong', t: m.t ?? null }))); continue; }
        if (PHONE_TYPES.has(m.type)) { try { onMessage(m); } catch (e) { log('bridge_handler', { error: String(e?.message ?? e) }); } }
      }
    });
    const gone = () => { clearTimeout(helloTimer); sockets.delete(socket); if (clients.delete(c)) log('bridge_left', { phones: clients.size }); };
    socket.on('close', gone);
    socket.on('error', gone);
  });

  // A phone that vanished without closing (out of signal) is dropped after two missed pings.
  const beat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { c.socket.destroy(); continue; }
      c.alive = false;
      try { c.socket.write(encodeFrame('', 9)); } catch { c.socket.destroy(); }
    }
  }, 20_000);
  beat.unref?.();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      server.on('error', (e) => log('bridge_error', { error: String(e?.message ?? e) }));
      const at = server.address();
      log('bridge_listening', { address: at.address, port: at.port });
      resolve({
        address: at.address,
        port: at.port,
        count: () => clients.size,
        send(msg) {
          if (!clients.size) return 0;
          const frame = encodeFrame(JSON.stringify(msg));
          let n = 0;
          for (const c of clients) { try { c.socket.write(frame); n++; } catch { c.socket.destroy(); } }
          return n;
        },
        close: () => new Promise((res) => { clearInterval(beat); for (const s of sockets) s.destroy(); sockets.clear(); clients.clear(); server.close(() => res()); }),
      });
    });
  });
}
