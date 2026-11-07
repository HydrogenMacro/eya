const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');
const Noise = require('noise-handshake');
const Cipher = require('noise-handshake/cipher');

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const key = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0')).join('');
let responder, serverSend, serverReceive, activeSocket, openedId = 0;
let sawClientCredit = false;
let resolveSentMessage;
const sentMessage = new Promise(resolve => { resolveSentMessage = resolve; });
let rangeRequest = null;
let uploadRequest = null;
const rangeRequested = new Promise(resolve => { global.__resolveRangeRequested = resolve; });
const uploadRequested = new Promise(resolve => { global.__resolveUploadRequested = resolve; });
const uploadBytesReceived = new Promise(resolve => { global.__resolveUploadBytes = resolve; });
const cancelUploadRequested = new Promise(resolve => { global.__resolveCancelUploadRequested = resolve; });
const cancelObserved = new Promise(resolve => { global.__resolveCancelObserved = resolve; });
const rangeIds = new Set();
const sendChunks = new Map();
const uploadChunks = new Map();
function within(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

class MockWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor() {
    activeSocket = this; this.readyState = MockWebSocket.CONNECTING; this.bufferedAmount = 0;
    queueMicrotask(() => { this.readyState = MockWebSocket.OPEN; this.onopen?.(); });
  }
  send(raw) {
    const bytes = new Uint8Array(raw); this.bufferedAmount += bytes.byteLength;
    setTimeout(() => { this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes.byteLength); }, 0);
    queueMicrotask(() => this.#serverReceive(bytes));
  }
  close() { this.readyState = MockWebSocket.CLOSED; queueMicrotask(() => this.onclose?.()); }
  emit(bytes) { queueMicrotask(() => this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })); }
  async #serverReceive(bytes) {
    try {
      if (!responder.complete) {
        responder.recv(bytes);
        const reply = responder.send();
        if (responder.complete) { serverSend = new Cipher(responder.tx); serverReceive = new Cipher(responder.rx); }
        this.emit(reply); return;
      }
      const message = serverReceive.decrypt(bytes);
      if (decoder.decode(message) === 'eya-browser-ready-v1') {
        this.emit(serverSend.encrypt(encoder.encode('eya-browser-ready-v1'))); return;
      }
      if (message[0] === 1) {
        const request = JSON.parse(decoder.decode(message.subarray(1)));
        if (request.bodySize) {
          if (request.url.endsWith('/cancel-upload')) { global.__resolveCancelUploadRequested(request); return; }
          uploadRequest = request; global.__resolveUploadRequested(request);
          uploadChunks.set(request.id, { expected: request.bodySize, sequence: 0, chunks: [] });
          const credit = new Uint8Array(9); credit[0] = 14; const view = new DataView(credit.buffer); view.setUint32(1, request.id); view.setUint32(5, 4);
          this.emit(serverSend.encrypt(credit)); return;
        }
        rangeRequest = request; rangeIds.add(request.id); global.__resolveRangeRequested(request);
        const meta = encoder.encode(JSON.stringify({ id: request.id, ok: true, status: 206, cacheHit: true,
          headers: { 'accept-ranges': 'bytes', 'content-range': 'bytes 5-9/10', 'content-length': '5', 'content-type': 'application/octet-stream' },
          cookies: [], url: request.url }));
        const frame = new Uint8Array(meta.length + 1); frame[0] = 2; frame.set(meta, 1);
        this.emit(serverSend.encrypt(frame));
        if (request.initialCredit > 0) {
          const bytes = Uint8Array.from([5, 6, 7, 8, 9]);
          const chunk = new Uint8Array(6 + bytes.length); chunk[0] = 3; new DataView(chunk.buffer).setUint32(1, request.id); chunk[5] = 1; chunk.set(bytes, 6);
          rangeIds.delete(request.id); this.emit(serverSend.encrypt(chunk));
        }
        return;
      }
      if (message[0] === 13) {
        const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
        const id = view.getUint32(1), sequence = view.getUint32(5), final = message[9] === 1, upload = uploadChunks.get(id);
        assert.ok(upload, 'upload chunk must follow upload metadata');
        assert.equal(sequence, upload.sequence++, 'upload chunks must be ordered');
        upload.chunks.push(message.slice(10));
        const currentBytes = upload.chunks.reduce((total, part) => total + part.length, 0);
        assert.ok(currentBytes <= upload.expected, 'upload must not exceed its declared size');
        if (!final) {
          const credit = new Uint8Array(9); credit[0] = 14; new DataView(credit.buffer).setUint32(1, id); new DataView(credit.buffer).setUint32(5, 1);
          this.emit(serverSend.encrypt(credit)); return;
        }
        assert.equal(currentBytes, upload.expected, 'final upload chunk must end at the declared size');
        const body = new Uint8Array(currentBytes); let offset = 0;
        for (const part of upload.chunks) { body.set(part, offset); offset += part.length; }
        uploadChunks.delete(id); global.__resolveUploadBytes(body);
        const meta = encoder.encode(JSON.stringify({ id, ok: true, status: 200, headers: {}, cookies: [], url: 'https://example.test/upload' }));
        const metaFrame = new Uint8Array(meta.length + 1); metaFrame[0] = 2; metaFrame.set(meta, 1); this.emit(serverSend.encrypt(metaFrame));
        const response = new Uint8Array(7); response[0] = 3; new DataView(response.buffer).setUint32(1, id); response[5] = 1; response[6] = 9; this.emit(serverSend.encrypt(response)); return;
      }
      if (message[0] === 4 && message.length === 5) {
        const id = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(1);
        uploadChunks.delete(id); global.__resolveCancelObserved(id);
        const lateCredit = new Uint8Array(9); lateCredit[0] = 14; new DataView(lateCredit.buffer).setUint32(1, id); new DataView(lateCredit.buffer).setUint32(5, 1);
        setTimeout(() => this.emit(serverSend.encrypt(lateCredit)), 0); return;
      }
      if (message[0] === 5) {
        const id = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(1);
        if (!rangeIds.has(id)) throw Error(`Unexpected HTTP response credit for request ${id}`);
        const bytes = Uint8Array.from([5, 6, 7, 8, 9]);
        const chunk = new Uint8Array(6 + bytes.length); chunk[0] = 3; new DataView(chunk.buffer).setUint32(1, id); chunk[5] = 1; chunk.set(bytes, 6);
        rangeIds.delete(id); this.emit(serverSend.encrypt(chunk)); return;
      }
      if (message[0] === 6) {
        const open = JSON.parse(decoder.decode(message.subarray(1))); openedId = open.id;
        const result = encoder.encode(JSON.stringify({ id: open.id, ok: true, protocol: 'echo.v1', sendCredit: 8, cookies: [] }));
        const frame = new Uint8Array(result.length + 1); frame[0] = 7; frame.set(result, 1);
        this.emit(serverSend.encrypt(frame)); return;
      }
      if (message[0] === 8) {
        const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
        const id = view.getUint32(1), messageId = view.getUint32(5), kind = message[9], final = message[10] !== 0;
        const entry = sendChunks.get(messageId) || { id, kind, chunks: [] }; entry.chunks.push(message.slice(11)); sendChunks.set(messageId, entry);
        const credit = new Uint8Array(5); credit[0] = 12; new DataView(credit.buffer).setUint32(1, id);
        this.emit(serverSend.encrypt(credit));
        if (final) {
          const size = entry.chunks.reduce((total, part) => total + part.length, 0); const body = new Uint8Array(size); let offset = 0;
          for (const part of entry.chunks) { body.set(part, offset); offset += part.length; }
          sendChunks.delete(messageId); resolveSentMessage({ kind: entry.kind, body });
        }
        return;
      }
      if (message[0] === 11) { sawClientCredit = true; return; }
      if (message[0] === 10) {
        const frame = new Uint8Array(11); frame[0] = 10; new DataView(frame.buffer).setUint32(1, new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(1)); new DataView(frame.buffer).setUint16(5, 1000); frame.set(encoder.encode('done'), 7);
        this.emit(serverSend.encrypt(frame)); return;
      }
      throw Error(`Unexpected client opcode ${message[0]}`);
    } catch (error) { this.onerror?.(error); }
  }
}

async function main() {
  const source = path.resolve(__dirname, '../client/browser-transport.js');
  const bundle = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', alias: { 'sodium-native': path.resolve(__dirname, '../client/node_modules/sodium-javascript/index.js') }, write: false });
  const loaded = new Module(source, module); loaded.filename = source; loaded.paths = Module._nodeModulePaths(path.dirname(source));
  loaded._compile(bundle.outputFiles[0].text, source);
  const previousWebSocket = global.WebSocket; global.WebSocket = MockWebSocket;
  try {
    responder = new Noise('NNpsk0', false, null, { psk: Uint8Array.from({ length: 32 }, (_, index) => index) });
    responder.initialise(encoder.encode('eya-browser-v1'));
    const transport = await loaded.exports.createBrowserTransport({ url: 'ws://example.test/ws', key });
    const received = new Promise(resolve => {
      global.__receivedSocketMessage = resolve;
    });
    const closed = new Promise(resolve => { global.__closedSocket = resolve; });
    const socket = await transport.openWebSocket('wss://example.test/socket', {
      protocols: ['echo.v1'], origin: 'https://example.test',
      onMessage: event => global.__receivedSocketMessage(event), onClose: event => global.__closedSocket(event),
    });
    assert.equal(socket.protocol, 'echo.v1');

    const rangeResponse = await transport.request('https://example.test/video.mp4', { headers: { Range: 'bytes=5-9' }, stream: true, bypassCache: true });
    const upstreamRange = await within(rangeRequested, 1000, 'Range request did not reach the encrypted transport');
    assert.equal(upstreamRange.headers.range, 'bytes=5-9', 'Range header must survive Noise WebSocket framing');
    assert.equal(upstreamRange.bypassCache, true, 'DevTools cache bypass must survive Noise WebSocket framing');
    assert.equal(rangeResponse.status, 206, 'partial content status must survive the transport');
    assert.equal(rangeResponse.cacheHit, true, 'cache-hit metadata must survive the transport');
    assert.equal(rangeResponse.headers['content-range'], 'bytes 5-9/10', 'Content-Range must survive the transport');
    const rangeReader = rangeResponse.body.getReader();
    const rangeChunk = await within(rangeReader.read(), 1000, 'Range response body did not stream');
    assert.deepEqual([...rangeChunk.value], [5, 6, 7, 8, 9], 'range response bytes must remain exact');
    assert.equal(rangeChunk.done, false);
    assert.equal((await rangeReader.read()).done, true, 'range stream must close after its final chunk');

    const requestBody = Uint8Array.from({ length: 180 * 1024 }, (_, index) => index % 239);
    activeSocket.bufferedAmount = 600 * 1024;
    setTimeout(() => { activeSocket.bufferedAmount = 0; }, 40);
    const uploadResponse = await within(transport.request('https://example.test/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: requestBody }), 5000, 'credited upload did not complete');
    const uploadMetadata = await within(uploadRequested, 1000, 'large upload metadata did not reach the encrypted transport');
    const receivedUpload = await within(uploadBytesReceived, 1000, 'large upload chunks did not complete');
    assert.equal(uploadMetadata.bodySize, requestBody.byteLength, 'large body size must be declared without base64');
    assert.equal(uploadMetadata.bodyBase64, undefined, 'large body must not be base64-expanded into the request metadata frame');
    assert.deepEqual(receivedUpload, requestBody, 'credited upload chunks must reconstruct exact request bytes');
    assert.deepEqual(uploadResponse.body, Uint8Array.from([9]), 'large upload response must return through the ordinary response path');

    const abortUpload = new AbortController();
    const cancelledUpload = transport.request('https://example.test/cancel-upload', { method: 'POST', body: new Uint8Array(80 * 1024), signal: abortUpload.signal });
    await within(cancelUploadRequested, 1000, 'cancellable upload metadata did not reach the mock proxy');
    abortUpload.abort(Error('cancel test'));
    await assert.rejects(cancelledUpload, /cancel test/);
    await within(cancelObserved, 1000, 'upload cancellation did not reach the proxy');
    const afterCancel = await within(transport.request('https://example.test/video.mp4'), 1000, 'late upload credit closed the shared transport');
    assert.deepEqual(afterCancel.body, Uint8Array.from([5, 6, 7, 8, 9]), 'transport remains usable after cancelling an upload');

    const payload = Uint8Array.from({ length: 600 * 1024 }, (_, index) => index % 251);
    socket.send(payload, 2);
    const echoed = await within(sentMessage, 5000, 'WebSocket send-credit flow timed out');
    assert.equal(echoed.kind, 2);
    assert.deepEqual(echoed.body, payload, 'large binary message must survive chunking and send credits');

    const inbound = new Uint8Array(14); const view = new DataView(inbound.buffer);
    inbound[0] = 9; view.setUint32(1, openedId); view.setUint32(5, 77); inbound[9] = 2; inbound[10] = 1; inbound.set([4, 5, 6], 11);
    activeSocket.emit(serverSend.encrypt(inbound));
    const message = await within(received, 1000, 'WebSocket receive timed out');
    assert.deepEqual([...message.data], [4, 5, 6]);
    socket.credit();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sawClientCredit, true, 'page acknowledgement must grant upstream receive credit');

    socket.close(1000, 'done');
    const close = await within(closed, 1000, 'WebSocket close timed out');
    assert.equal(close.code, 1000);
    transport.close();
    console.log('Browser Noise HTTP range forwarding, credited request uploads, WebSocket multiplexing, chunking, and bidirectional credits passed.');
  } finally { global.WebSocket = previousWebSocket; delete global.__receivedSocketMessage; delete global.__closedSocket; delete global.__resolveRangeRequested; delete global.__resolveUploadRequested; delete global.__resolveUploadBytes; delete global.__resolveCancelUploadRequested; delete global.__resolveCancelObserved; }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
