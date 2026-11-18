const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');
const Noise = require('noise-handshake'), Cipher = require('noise-handshake/cipher');
const encoder = new TextEncoder(), decoder = new TextDecoder(), key = '12'.repeat(32);
const code = buildSync({ entryPoints: ['client/browser-transport.js'], bundle: true, platform: 'node', format: 'cjs', write: false, alias: { 'sodium-native': path.resolve('client/node_modules/sodium-javascript/index.js') } }).outputFiles[0].text;
const loaded = new Module(path.resolve('client/browser-transport.js'), module); loaded.filename = path.resolve('client/browser-transport.js'); loaded.paths = Module._nodeModulePaths(path.resolve('client')); loaded._compile(code, loaded.filename);
let socket, selected = [], decoderAvailable = true;
class MockWebSocket {
  static OPEN = 1;
  constructor() { socket = this; this.readyState = 0; this.received = []; this.noise = new Noise('NNpsk0', false, null, { psk: Buffer.from(key, 'hex') }); this.noise.initialise(encoder.encode('eya-browser-render-v1')); queueMicrotask(() => { this.readyState = 1; this.onopen(); }); }
  emit(bytes) { queueMicrotask(() => this.onmessage?.({ data: this.tx.encrypt(bytes).buffer })); }
  json(tag, data) { this.emit(Uint8Array.of(tag, ...encoder.encode(JSON.stringify(data)))); }
  send(bytes) { queueMicrotask(() => {
    if (!this.noise.complete) { this.noise.recv(bytes); const reply = this.noise.send(); this.tx = new Cipher(this.noise.tx); this.rx = new Cipher(this.noise.rx); this.onmessage({ data: reply.buffer }); return; }
    const message = this.rx.decrypt(bytes);
    if (decoder.decode(message) === 'eya-browser-render-ready-v1') { this.emit(encoder.encode('eya-browser-render-ready-v1')); return; }
    this.received.push(message);
    if (message[0] === 3) this.json(129, { type: 'stream-settings', capabilities: selected, stream: { format: 'jpeg' } });
  }); }
  close() { this.readyState = 3; queueMicrotask(() => this.onclose?.()); }
}
const until = async predicate => { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } throw Error('Missing transport result'); };
const metadata = (extra = {}) => ({ seq: 1, tabId: 'test', width: 640, height: 480, bytes: 8, chunks: 1, format: 'rgba-tiles-v1', pixelWidth: 2, pixelHeight: 2, base: 0, tiles: 1, ...extra });
const chunk = (tag = 148) => Uint8Array.of(tag, 0, 0, 0, 1, 0, 0, ...new Uint8Array(8));
(async () => {
  global.WebSocket = MockWebSocket;
  global.ImageData = class {};
  global.document = { createElement: () => ({ getContext: () => decoderAvailable ? {} : null }) };
  const connect = async () => {
    const errors = [], frames = [];
    const transport = await loaded.exports.createBrowserRenderTransport({ url: 'ws://example.test/ws', key, onState: (state, error) => { if (state === 'error') errors.push(error); }, onFrame: (bytes, meta) => frames.push({ bytes, meta }) });
    return { transport, errors, frames, socket };
  };
  selected = ['stream-settings-v1', 'tiles-rgba-v1', 'future-v7'];
  let peer = await connect(); peer.transport.resize(640, 480, 'test', { format: 'jpeg', tiles: true }); await until(() => peer.transport.capabilities.length);
  assert.deepEqual(peer.transport.capabilities, ['stream-settings-v1', 'tiles-rgba-v1']);
  assert.ok(JSON.parse(decoder.decode(peer.socket.received[0].subarray(1))).capabilities.includes('tiles-rgba-v1'));
  peer.socket.json(147, metadata()); peer.socket.emit(chunk()); await until(() => peer.frames.length);
  peer.transport.ackTiles(1, true); await until(() => peer.socket.received.some(message => message[0] === 39));
  assert.deepEqual([...peer.socket.received.find(message => message[0] === 39)], [39, 0, 0, 0, 1, 1]);
  peer.transport.ackTiles(1, false); await until(() => peer.socket.received.filter(message => message[0] === 39).length === 2);
  assert.equal(peer.socket.received.at(-1)[5], 0); assert.throws(() => peer.transport.ackTiles(0, true));
  peer.socket.json(130, { seq: 2, bytes: 1, chunks: 1 }); peer.socket.emit(Uint8Array.of(131, 0, 0, 0, 2, 0, 0, 9)); await until(() => peer.frames.length === 2); peer.transport.ack(2);
  await until(() => peer.socket.received.some(message => message[0] === 5)); peer.transport.close();
  // Old peers omit the selection. Even when offered, no tile format is accepted.
  selected = []; peer = await connect(); peer.transport.resize(640, 480, 'test', { format: 'jpeg', tiles: true }); await until(() => peer.socket.received.length);
  assert.deepEqual(peer.transport.capabilities, []); assert.throws(() => peer.transport.ackTiles(1, true), /negotiated/);
  peer.socket.json(147, metadata()); await until(() => peer.errors.length); assert.match(peer.errors[0].message, /Unnegotiated/); peer.transport.close();
  // A selected capability that was not offered cannot enable a decoder.
  decoderAvailable = false; selected = ['tiles-rgba-v1']; peer = await connect(); peer.transport.resize(640, 480, 'test'); await until(() => peer.socket.received.length);
  assert.ok(!JSON.parse(decoder.decode(peer.socket.received[0].subarray(1))).capabilities.includes('tiles-rgba-v1'));
  peer.socket.json(147, metadata()); await until(() => peer.errors.length); assert.match(peer.errors[0].message, /Unnegotiated/); peer.transport.close(); decoderAvailable = true;
  for (const [meta, tag] of [[metadata({ pixelWidth: 8192, pixelHeight: 8192 }), 148], [metadata(), 131], [metadata({ seq: 2 ** 32 }), 148]]) {
    peer = await connect(); peer.transport.resize(640, 480, 'test'); await until(() => peer.transport.capabilities.length); peer.socket.json(147, meta); peer.socket.emit(chunk(tag)); await until(() => peer.errors.length); assert.equal(peer.frames.length, 0); peer.transport.close();
  }
  peer = await connect(); peer.transport.resize(640, 480, 'test'); await until(() => peer.transport.capabilities.length); peer.socket.json(130, metadata()); await until(() => peer.errors.length); assert.match(peer.errors[0].message, /Unnegotiated/); peer.transport.close();
  delete global.document; delete global.ImageData;
  console.log('Tile offer/selection, legacy fallback, missing decoder, immutable image tags, strict metadata/chunk ordering and presentation ACKs passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
