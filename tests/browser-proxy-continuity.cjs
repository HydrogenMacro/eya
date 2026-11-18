const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const Noise = require('noise-handshake');
const Cipher = require('noise-handshake/cipher');
const enc = new TextEncoder(), dec = new TextDecoder();
const key = '11'.repeat(32), sockets = [], requests = [], states = [];
let pauseHandshake = false, rejectConnections = false;
function load(name) {
  const file = path.resolve(__dirname, '../client', name);
  const result = buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false,
    alias: { 'sodium-native': path.resolve(__dirname, '../client/node_modules/sodium-javascript/index.js') } });
  const value = new Module(file, module); value.filename = file; value.paths = Module._nodeModulePaths(path.dirname(file));
  value._compile(result.outputFiles[0].text, file); return value.exports;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(test) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (test()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('Fixture timed out');
}
class Socket {
  static OPEN = 1;
  constructor() {
    this.readyState = 0; this.bufferedAmount = 0; sockets.push(this);
    this.noise = new Noise('NNpsk0', false, null, { psk: new Uint8Array(32).fill(17) });
    this.noise.initialise(enc.encode('eya-browser-v1'));
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      if (rejectConnections) { this.onerror?.(); return; }
      this.readyState = 1; this.onopen?.();
    });
  }
  emit(bytes) { queueMicrotask(() => { if (this.readyState === 1) this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }); }); }
  reply(bytes) { this.emit(this.tx.encrypt(bytes)); }
  send(raw) {
    if (this.readyState !== 1) throw Error('Socket closed');
    const bytes = new Uint8Array(raw);
    if (!this.noise.complete) {
      this.noise.recv(bytes); const response = this.noise.send(); this.tx = new Cipher(this.noise.tx); this.rx = new Cipher(this.noise.rx); this.emit(response); return;
    }
    const plain = this.rx.decrypt(bytes);
    if (dec.decode(plain) === 'eya-browser-ready-v1') {
      this.finishHandshake = () => this.reply(enc.encode('eya-browser-ready-v1'));
      if (!pauseHandshake) this.finishHandshake(); return;
    }
    if (plain[0] === 1) {
      const request = JSON.parse(dec.decode(plain.subarray(1))); requests.push(request);
      if (request.url.includes('/hold')) return;
      const meta = enc.encode(JSON.stringify({ id: request.id, ok: true, status: 200, headers: {}, url: request.url }));
      const first = new Uint8Array(meta.length + 1); first[0] = 2; first.set(meta, 1); this.reply(first);
      const last = new Uint8Array(8); last[0] = 3; new DataView(last.buffer).setUint32(1, request.id); last[5] = 1; last.set([1, 2], 6); this.reply(last); return;
    }
    if (plain[0] === 6) {
      const open = JSON.parse(dec.decode(plain.subarray(1)));
      const result = enc.encode(JSON.stringify({ id: open.id, ok: true, sendCredit: 8 }));
      const frame = new Uint8Array(result.length + 1); frame[0] = 7; frame.set(result, 1); this.reply(frame); return;
    }
    if ([4, 10].includes(plain[0])) return;
    throw Error(`Unexpected opcode ${plain[0]}`);
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.onclose?.()); }
}
async function main() {
  const { sanitizeProxyState, proxyRestoreUrl } = load('browser-proxy-state.js');
  assert.equal(proxyRestoreUrl('https://user:password@example.test'), '');
  assert.equal(proxyRestoreUrl('file:///private'), '');
  assert.equal(proxyRestoreUrl('https://example.test/' + 'a'.repeat(4096)), '');
  assert.equal(sanitizeProxyState(null, 'https://example.test/legacy').tabs[0].url, 'https://example.test/legacy');
  assert.equal(sanitizeProxyState({ v: 2, tabs: [{ url: 'https://example.test/unknown' }] }).tabs[0].url, '');
  const saved = sanitizeProxyState({ v: 1, active: 2, zoom: 1.4, extra: 'ignored', tabs: [
    { url: 'https://example.test/one', body: 'NEVER SAVE' }, { url: '' }, { url: 'https://example.test/three' }] });
  assert.deepEqual(saved, { v: 1, active: 2, zoom: 1.4, tabs: [{ url: 'https://example.test/one' }, { url: '' }, { url: 'https://example.test/three' }] });
  const huge = sanitizeProxyState({ v: 1, active: 23, zoom: Infinity, tabs: Array.from({ length: 100 }, () => ({ url: 'https://example.test/' + '😀'.repeat(600) })) });
  assert.equal(huge.tabs.length, 24); assert.equal(huge.active, 23); assert.equal(huge.zoom, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) < 7000); assert.ok(huge.tabs.some(tab => !tab.url));
  const { createBrowserTransport, createRecoveringBrowserTransport } = load('browser-transport.js');
  const old = global.WebSocket; global.WebSocket = Socket;
  let transport;
  try {
    rejectConnections = true;
    transport = createRecoveringBrowserTransport({ url: 'ws://example.test/ws', key, onState: state => states.push(state) });
    await until(() => states.at(-1) === 'retrying');
    assert.equal(transport.ready, false, 'initial handshake failure leaves a live recovery handle');
    rejectConnections = false;
    await until(() => transport.ready);
    assert.equal(transport.ready, true);
    let socketClosed = 0;
    await transport.openWebSocket('wss://example.test/socket', { onClose: () => socketClosed++ });
    const posted = transport.request('https://example.test/hold-post', { method: 'POST', body: 'mutation' });
    await until(() => requests.length === 1);
    sockets.at(-1).close();
    await assert.rejects(posted, error => error.completion === 'unknown' && /may have completed/.test(error.message));
    assert.equal(socketClosed, 1); assert.equal(transport.ready, false);
    const count = sockets.length;
    await assert.rejects(transport.request('https://example.test/post-again', { method: 'POST', body: 'mutation' }), error => error.completion === 'not-sent');
    await assert.rejects(transport.openWebSocket('wss://example.test/socket'));
    assert.equal(sockets.length, count, 'mutations/socket creation cannot expedite recovery');
    pauseHandshake = true;
    await until(() => sockets.length === count + 1 && sockets.at(-1).finishHandshake);
    assert.equal(states.at(-1), 'reconnecting', 'idle disconnect starts a new handshake automatically');
    const controller = new AbortController();
    const cancelled = transport.request('https://example.test/cancelled', { signal: controller.signal });
    const first = transport.request('https://example.test/next');
    const second = transport.request('https://example.test/second', { method: 'HEAD' });
    await until(() => sockets.at(-1).finishHandshake && sockets.length === count + 1);
    controller.abort(); await assert.rejects(cancelled, error => error.name === 'AbortError');
    sockets.at(-1).finishHandshake(); pauseHandshake = false;
    assert.deepEqual((await first).body, new Uint8Array([1, 2])); await second;
    assert.equal(sockets.length, count + 1, 'concurrent future reads share one fresh Noise channel');
    assert.equal(requests.filter(request => request.url.includes('hold-post')).length, 1, 'interrupted mutation is never replayed');
    assert.equal(requests.filter(request => request.url.includes('cancelled')).length, 0, 'aborted reconnect waiter never dispatches');
    assert.equal(socketClosed, 1, 'upstream sockets are not reopened');
    const read = transport.request('https://example.test/hold-get');
    await until(() => requests.some(request => request.url.endsWith('hold-get'))); sockets.at(-1).close();
    await assert.rejects(read, /not retried/);
    const beforeRetry = requests.length;
    rejectConnections = true;
    const beforeFailures = sockets.length;
    await until(() => sockets.length > beforeFailures && states.at(-1) === 'retrying');
    rejectConnections = false;
    await until(() => transport.ready);
    assert.equal(requests.length, beforeRetry, 'automatic recovery does not reload pages or requests');
    sockets.at(-1).close(); await tick();
    transport.pause();
    const pausedCount = sockets.length;
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(sockets.length, pausedCount, 'explicit pause cancels automatic recovery');
    assert.equal(states.at(-1), 'paused');
    await assert.rejects(transport.reconnect(), /resume/);
    pauseHandshake = true;
    transport.resume();
    const pending = transport.reconnect(); await until(() => sockets.at(-1).finishHandshake);
    transport.close(); await assert.rejects(pending, /closed/); assert.equal(transport.ready, false);
    await assert.rejects(transport.request('https://example.test/after-close'), /closed/);
    assert.ok(states.includes('connecting') && states.includes('ready') && states.includes('closed'));
    pauseHandshake = false;
    const queuedTransport = await createBrowserTransport({ url: 'ws://example.test/ws', key });
    const beforeQueue = requests.length;
    const queued = Array.from({ length: 10 }, (_, i) => queuedTransport.request(`https://example.test/hold-queue-${i}`));
    const outcomes = Promise.allSettled(queued);
    await until(() => requests.length === beforeQueue + 8); sockets.at(-1).close();
    const settled = await outcomes;
    assert.equal(requests.length, beforeQueue + 8, 'connection close must reject queued work before releasing request slots');
    assert.ok(settled.every(item => item.status === 'rejected'));
    assert.equal(settled.filter(item => item.reason.completion === 'not-sent').length, 2);
    pauseHandshake = true;
    const incomplete = createBrowserTransport({ url: 'ws://example.test/ws', key });
    await until(() => sockets.at(-1).finishHandshake); sockets.at(-1).close();
    await assert.rejects(incomplete, /closed/, 'close after cipher setup must reject the handshake');
  } finally { transport?.close(); for (const socket of sockets) socket.close(); global.WebSocket = old; }
  console.log('Proxy workspace state, automatic channel recovery, pause/resume, aborts and no request replay passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
