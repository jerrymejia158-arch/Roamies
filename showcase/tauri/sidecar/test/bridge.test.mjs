// The phone bridge: framing, pairing, what a phone may send, where it may listen, and the files it serves.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FrameReader, PHONE_BLOCKED_TOOLS, PHONE_TYPES, acceptKey, bridgeHost, encodeFrame, pageId, pairingToken, phoneDrawProblem, startBridge, staticFile, tailscaleAddress, tokenOk } from '../bridge.mjs';

// ---------- pure parts ----------
assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='); // the RFC 6455 example

const masked = (text, { opcode = 1, fin = true } = {}) => {
  const body = Buffer.from(text), mask = Buffer.from([1, 2, 3, 4]);
  const head = body.length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | body.length])
    : Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([head, mask, Buffer.from(body.map((b, i) => b ^ mask[i & 3]))]);
};
{
  const r = new FrameReader();
  const whole = masked('{"type":"ask","text":"hi"}');
  assert.deepEqual(r.push(whole.subarray(0, 5)), []); // split across chunks
  assert.equal(r.push(whole.subarray(5))[0].data.toString(), '{"type":"ask","text":"hi"}');
  const long = 'x'.repeat(300);
  assert.equal(r.push(masked(long))[0].data.toString(), long); // 16-bit length
  assert.deepEqual(r.push(masked('ab', { fin: false })), []); // fragmented
  assert.equal(r.push(masked('cd', { opcode: 0 }))[0].data.toString(), 'abcd');
  assert.throws(() => new FrameReader().push(Buffer.from([0x81, 0x02, 0x61, 0x62])), /not masked/);
  assert.throws(() => new FrameReader(100).push(masked(long)), /too large/);
  assert.throws(() => new FrameReader().push(masked('x', { opcode: 0 })), /continuation/);
}
assert.equal(encodeFrame('hi').toString('hex'), '81026869');
assert.equal(encodeFrame('y'.repeat(70000)).readBigUInt64BE(2), 70000n);

const TOKEN = 'a-long-enough-pairing-token';
assert.ok(tokenOk(TOKEN, TOKEN));
assert.ok(!tokenOk('a-long-enough-pairing-tokeN', TOKEN));
assert.ok(!tokenOk(undefined, TOKEN));
assert.ok(!tokenOk('short', 'short')); // a short token never pairs anything

const ifaces = { lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], eth: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }], ts: [{ family: 'IPv4', internal: false, address: '100.101.102.103' }] };
assert.equal(tailscaleAddress(ifaces), '100.101.102.103');
assert.equal(tailscaleAddress({ eth: ifaces.eth }), null);
assert.equal(bridgeHost('tailscale', ifaces), '100.101.102.103');
assert.equal(bridgeHost('100.101.102.103', ifaces), '100.101.102.103');
assert.equal(bridgeHost('on', ifaces), '127.0.0.1');
for (const refused of ['0.0.0.0', '192.168.1.20', '::', 'example.com', '', 'off', '100.99.99.99']) assert.equal(bridgeHost(refused, ifaces), null, refused);
assert.equal(bridgeHost('tailscale', { eth: ifaces.eth }), null); // no Tailscale: off, not a fallback to the LAN

for (const t of ['run_command', 'write_file', 'act_in_app', 'take_screenshot', 'open']) assert.ok(PHONE_BLOCKED_TOOLS.has(t), t);
for (const t of ['remember_commitment', 'fetch_url', 'forget_fact', 'draw', 'show_list']) assert.ok(!PHONE_BLOCKED_TOOLS.has(t), t);

// A drawing from the phone: cards only, nothing that needs this computer's screen.
{
  const CARDS = ['card', 'note', 'list', 'timeline', 'quiz'];
  const says = (marks, extra = {}) => phoneDrawProblem({ beats: [{ say: 'x', marks, ...extra }] }, CARDS);
  assert.equal(says([{ kind: 'timeline', events: [{ when: '1783', text: 'a' }] }, { kind: 'note', text: 'n' }]), '');
  assert.equal(says([{ kind: 'emote', name: 'hype' }, { kind: 'button', text: 'More', action: { do: 'ask', value: 'tell me more' } }]), '');
  assert.equal(phoneDrawProblem({ edit: [{ do: 'clear' }] }, CARDS), '', 'edits alone');
  assert.match(says([{ kind: 'ring', at: { text: 'Share' } }]), /beat 1 ring: marks on the screen can't be drawn/);
  assert.match(says([{ kind: 'card', text: 'c', tie: { text: 'Export' } }]), /leave out at, to and tie/);
  assert.match(says([{ kind: 'note', text: 'n' }], { wait: 'click' }), /no clicks to wait for/);
  assert.match(says([{ kind: 'button', text: 'Open', action: { do: 'open', value: 'https://example.com' } }]), /only a button that asks/);
  assert.match(says([{ kind: 'type', text: 'hello', at: { text: 'Search' } }]), /can't be drawn/);
  assert.match(says([{ kind: 'copy', text: 'secret' }]), /can't be drawn/); // the clipboard is this computer's
  assert.match(phoneDrawProblem({ target: 'Chrome', beats: [{ say: 'x', marks: [{ kind: 'note', text: 'n' }] }] }, CARDS), /leave target out/);
  assert.match(says([{ kind: 'ring', at: { text: 'a' } }]), /cards only \(card, note, list, timeline, quiz\)/);
}
for (const t of ['draw_started', 'draw_wait_done', 'ink_closed', 'ink_action', 'ink_cleared', 'quiz_done', 'list_toggle']) assert.ok(PHONE_TYPES.has(t), t);
for (const t of ['menu', 'panel_key', 'user_click', 'open_link', 'update_status', 'show_list']) assert.ok(!PHONE_TYPES.has(t), t);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-bridge-'));
const root = path.join(tmp, 'web');
fs.mkdirSync(path.join(root, 'roamies'), { recursive: true });
fs.writeFileSync(path.join(root, 'phone.html'), '<!doctype html><title>phone</title>');
fs.writeFileSync(path.join(root, 'roamies', 'core.js'), '// core');
fs.writeFileSync(path.join(tmp, 'secret.json'), '{}');
assert.equal(staticFile(root, '/'), path.join(root, 'phone.html'));
assert.equal(staticFile(root, '/roamies/core.js?v=2'), path.join(root, 'roamies', 'core.js'));
for (const bad of ['/../secret.json', '/%2e%2e/secret.json', '/roamies/../../secret.json', '/.env', '/roamies/.hidden.js', '/notes.txt', '/%00.js', '/%zz']) assert.equal(staticFile(root, bad), null, bad);

{
  const dir = path.join(tmp, 'data');
  const made = pairingToken(dir, {});
  assert.ok(made.length >= 24);
  assert.equal(pairingToken(dir, {}), made); // kept, not remade
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'bridge.json')).mode & 0o777, 0o600);
  assert.equal(pairingToken(dir, { ROAMIES_BRIDGE_TOKEN: 'an-env-token-of-length' }), 'an-env-token-of-length');
  assert.equal(pairingToken(dir, { ROAMIES_BRIDGE_TOKEN: 'short' }), made);
}
await assert.rejects(startBridge({ host: '127.0.0.1', port: 0, token: 'short' }), /too short/);
await assert.rejects(startBridge({ host: null, port: 0, token: TOKEN }), /no address/);

// ---------- a real server and a real client ----------
const got = [], logs = [];
let paired = 0;
const bridge = await startBridge({ host: '127.0.0.1', port: 0, token: TOKEN, root, version: '9.9.9', onMessage: (m) => got.push(m), onPaired: () => paired++, log: (k) => logs.push(k) });
const url = `ws://127.0.0.1:${bridge.port}/ws`;
const open = (u = url) => new Promise((res, rej) => { const ws = new WebSocket(u); ws.inbox = []; ws.onmessage = (e) => ws.inbox.push(JSON.parse(e.data)); ws.onopen = () => res(ws); ws.onerror = () => rej(new Error('connect failed')); });
const until = async (f, ms = 2000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };
const closed = (ws) => new Promise((res) => { ws.onclose = (e) => res(e.code); });

// The page is served; nothing outside it is.
assert.match(await (await fetch(`http://127.0.0.1:${bridge.port}/`)).text(), /<title>phone<\/title>/);
assert.equal((await fetch(`http://127.0.0.1:${bridge.port}/roamies/core.js`)).status, 200);
assert.equal((await fetch(`http://127.0.0.1:${bridge.port}/..%2fsecret.json`)).status, 404);
assert.equal((await fetch(`http://127.0.0.1:${bridge.port}/`, { method: 'POST' })).status, 405);

// A wrong token is refused, and nothing it sends is read; neither is a message before hello.
{
  const ws = await open();
  const code = closed(ws);
  ws.send(JSON.stringify({ type: 'hello', token: 'not-the-right-token-at-all' }));
  assert.equal(await code, 4401);
  const ws2 = await open();
  const code2 = closed(ws2);
  ws2.send(JSON.stringify({ type: 'ask', text: 'run something' }));
  assert.equal(await code2, 4401);
  assert.equal(got.length, 0);
  assert.equal(bridge.count(), 0);
  assert.equal(bridge.send({ type: 'ui', msg: { kind: 'say', text: 'secret' } }), 0); // nobody paired: nothing goes out
}

// Paired: messages flow both ways, and only the allowed types come through.
const phone = await open();
phone.send(JSON.stringify({ type: 'hello', token: TOKEN }));
await until(() => phone.inbox.length === 1);
assert.deepEqual(phone.inbox[0], { type: 'hello', ok: true, version: '9.9.9', page: pageId(root) });
assert.match(pageId(root), /^[0-9a-f]{12}$/);
{ // the id changes when a page file does, and is empty (never a reload loop) when the page isn't there
  const before = pageId(root);
  fs.writeFileSync(path.join(root, 'roamies', 'core.js'), '// core, changed');
  assert.notEqual(pageId(root), before);
  assert.equal(pageId(path.join(tmp, 'nowhere')), '');
}
assert.equal(paired, 1);
phone.send(JSON.stringify({ type: 'ask', text: 'what is on my list?' }));
phone.send(JSON.stringify({ type: 'menu', id: 'quit' })); // a desktop-only message
phone.send(JSON.stringify({ type: 'panel_key', provider: 'openai', key: 'sk-x' }));
phone.send('not json');
phone.send(JSON.stringify({ type: 'voice', text: 'remind me at five' }));
await until(() => got.length === 2);
assert.deepEqual(got.map((m) => m.type), ['ask', 'voice']);
phone.send(JSON.stringify({ type: 'ping', t: 7 }));
await until(() => phone.inbox.length === 2);
assert.deepEqual(phone.inbox[1], { type: 'pong', t: 7 });
// A spoken reply's audio is a big message: it arrives whole.
const pcm = 'A'.repeat(200_000);
assert.equal(bridge.send({ type: 'ui', msg: { kind: 'speech', id: 1, rate: 24000, pcm } }), 1);
await until(() => phone.inbox.length === 3);
assert.equal(phone.inbox[2].msg.pcm.length, 200_000);

// Too many wrong tokens: new connections are refused for a while, the paired phone stays.
for (let i = 0; i < 8; i++) { const ws = await open(); const c = closed(ws); ws.send(JSON.stringify({ type: 'hello', token: `wrong-token-number-${i}-xxxxxxxx` })); await c; }
await assert.rejects(open(), /connect failed/);
assert.equal(bridge.count(), 1);
assert.ok(logs.includes('bridge_paired') && logs.includes('bridge_refused'));

await bridge.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('bridge tests: passed');
