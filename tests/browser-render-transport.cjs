const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');
const Noise = require('noise-handshake');
const Cipher = require('noise-handshake/cipher');

const encoder = new TextEncoder(), decoder = new TextDecoder();
const key = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0')).join('');
let responder, serverSend, serverReceive, activeSocket;
let failFirstStart = true;
const received = [];
let resolveFrame;
const frameReady = new Promise(resolve => { resolveFrame = resolve; });

class MockWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor(url) { this.url = url; activeSocket = this; this.readyState = 0; queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
  send(raw) { queueMicrotask(() => this.#receive(new Uint8Array(raw))); }
  close() { this.readyState = 3; queueMicrotask(() => this.onclose?.()); }
  emit(bytes) { queueMicrotask(() => this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })); }
  async #receive(bytes) {
    if (!responder.complete) {
      responder.recv(bytes); const reply = responder.send();
      if (responder.complete) { serverSend = new Cipher(responder.tx); serverReceive = new Cipher(responder.rx); }
      this.emit(reply); return;
    }
    const message = serverReceive.decrypt(bytes);
    if (decoder.decode(message) === 'eya-browser-render-ready-v1') {
      this.emit(serverSend.encrypt(encoder.encode('eya-browser-render-ready-v1'))); return;
    }
    const opcode = message[0]; received.push(message.slice());
    if (opcode === 1) {
      if (failFirstStart) {
        failFirstStart = false;
        this.emit(serverSend.encrypt(Uint8Array.of(129, ...encoder.encode('{"type":"error","message":"Chromium could not start"}'))));
        return;
      }
      this.emit(serverSend.encrypt(Uint8Array.of(129, ...encoder.encode('{"type":"ready"}'))));
      const meta = encoder.encode(JSON.stringify({ seq: 7, width: 2, height: 1, bytes: 5, chunks: 1 }));
      this.emit(serverSend.encrypt(Uint8Array.of(130, ...meta)));
      this.emit(serverSend.encrypt(Uint8Array.of(131, 0, 0, 0, 7, 0, 0, 1, 2, 3, 4, 5)));
      this.emit(serverSend.encrypt(Uint8Array.of(129, ...encoder.encode(JSON.stringify({ type: 'download-start', id: 9, url: 'https://example.test/file.bin', filename: 'file.bin' })))));
      const file = encoder.encode('file!');
      this.emit(serverSend.encrypt(Uint8Array.of(143, ...encoder.encode(JSON.stringify({ id: 9, filename: 'file.bin', bytes: file.byteLength, chunks: 1 })))));
      this.emit(serverSend.encrypt(Uint8Array.of(144, 0, 0, 0, 9, 0, 0, ...file)));
      return;
    }
    if (opcode === 27) {
      const request = JSON.parse(decoder.decode(message.subarray(1)));
      this.emit(serverSend.encrypt(Uint8Array.of(129, ...encoder.encode(JSON.stringify({ type: 'tab-activated', tabId: request.tabId, url: '' })))));
      return;
    }
    if (opcode === 28) return;
    if (opcode === 35) {
      const request = JSON.parse(decoder.decode(message.subarray(1)));
      const response = encoder.encode(JSON.stringify({ id: request.requestId, ok: true, phase: 'action-triggered', tabId: request.tabId, extensionId: request.extensionId }));
      this.emit(serverSend.encrypt(Uint8Array.of(139, ...response)));
      return;
    }
    if (opcode === 7) {
      const request = JSON.parse(decoder.decode(message.subarray(1)));
      const result = encoder.encode(JSON.stringify({ id: request.id, tabId: request.tabId, result: { result: { type: 'object', className: 'Object', description: 'Object', objectId: 'object-1' } }, remoteObject: { type: 'object', className: 'Object', description: 'Object', objectId: 'object-1' } }));
      this.emit(serverSend.encrypt(Uint8Array.of(134, ...result)));
      return;
    }
    if (opcode === 8) return;
    if (opcode === 11) {
      const id = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(1);
      const result = encoder.encode(JSON.stringify({ id, ok: true }));
      this.emit(serverSend.encrypt(Uint8Array.of(135, ...result)));
      return;
    }
    if (opcode === 26) {
      const request = JSON.parse(decoder.decode(message.subarray(1)));
      const response = encoder.encode(JSON.stringify({ id: request.id, ok: true }));
      this.emit(serverSend.encrypt(Uint8Array.of(145, ...response)));
      return;
    }
    if (opcode === 12) {
      const request = JSON.parse(decoder.decode(message.subarray(1)));
      const response = encoder.encode(JSON.stringify({ id: request.id, tabId: request.tabId, sources: [{ url: 'https://example.test/app.js', kind: 'Script', mimeType: 'text/javascript' }] }));
      this.emit(serverSend.encrypt(Uint8Array.of(136, ...response)));
      return;
    }
    if (opcode === 13) {
      const request = JSON.parse(decoder.decode(message.subarray(1)));
      const response = encoder.encode(JSON.stringify({ id: request.id, tabId: request.tabId, kind: 'content', url: request.url, contentBytes: 5, chunks: 1, truncated: false }));
      this.emit(serverSend.encrypt(Uint8Array.of(136, ...response)));
      this.emit(serverSend.encrypt(Uint8Array.of(137, request.id >>> 24, request.id >>> 16 & 255, request.id >>> 8 & 255, request.id & 255, 0, 0, ...encoder.encode('hello'))));
      return;
    }
    if (opcode === 14 || opcode === 15) {
      const request = JSON.parse(decoder.decode(message.subarray(1)));
      const result = opcode === 14 ? { id: request.id, tabId: request.tabId, cookies: [{ name: 'session', value: 'secret', domain: 'example.test', path: '/', httpOnly: true, secure: true }] } : { id: request.id, tabId: request.tabId, ok: true };
      this.emit(serverSend.encrypt(Uint8Array.of(138, ...encoder.encode(JSON.stringify(result)))));
      return;
    }
    if (opcode === 16) {
      const request = JSON.parse(decoder.decode(message.subarray(1)));
      const reply = Uint8Array.of(139, ...encoder.encode(JSON.stringify({ id: request.id, ok: true, phase: 'ready' })));
      this.emit(serverSend.encrypt(reply));
      return;
    }
    if (opcode === 17 && message.byteLength > 11) {
      const view = new DataView(message.buffer, message.byteOffset, message.byteLength), id = view.getUint32(1), fileIndex = view.getUint16(5), offset = view.getUint32(7);
      const reply = Uint8Array.of(139, ...encoder.encode(JSON.stringify({ id, ok: true, phase: 'chunk', fileIndex, offset: offset + message.byteLength - 11 })));
      this.emit(serverSend.encrypt(reply));
      return;
    }
    if (opcode === 18 && message.byteLength === 5) {
      const id = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(1);
      const result = { id, ok: true, phase: 'installed', extension: { id: 'a'.repeat(32), name: 'Test extension', hasAction: true } };
      this.emit(serverSend.encrypt(Uint8Array.of(139, ...encoder.encode(JSON.stringify(result)))));
      return;
    }
    if (opcode === 19) {
      const request = JSON.parse(decoder.decode(message.subarray(1)));
      const reply = Uint8Array.of(139, ...encoder.encode(JSON.stringify({ id: request.requestId, ok: true, phase: 'removed' })));
      this.emit(serverSend.encrypt(reply));
      return;
    }
    if (opcode === 21) {
      const request = JSON.parse(decoder.decode(message.subarray(1)));
      const result = { id: request.id, tabId: request.tabId, ok: true, breakpointId: request.action === 'setBreakpoint' ? 'bp-1' : '', properties: request.action === 'getProperties' ? [{ name: 'count', value: { type: 'number', value: 7 }, enumerable: true, writable: true, configurable: true }] : [], scopeChain: request.action === 'getScopes' ? [{ type: 'local', name: 'work', object: { objectId: 'scope-1', type: 'object', className: 'Object', description: 'Local' } }] : [] };
      this.emit(serverSend.encrypt(Uint8Array.of(140, ...encoder.encode(JSON.stringify(result)))));
      if (request.action === 'pause') {
        const event = { method: 'Debugger.paused', params: { reason: 'other', callFrames: [{ callFrameId: 'frame-1', functionName: 'work', url: 'https://example.test/app.js', location: { lineNumber: 8, columnNumber: 2 } }] } };
        this.emit(serverSend.encrypt(Uint8Array.of(132, ...encoder.encode(JSON.stringify(event)))));
      }
      return;
    }
    if (opcode === 22) {
      const request = JSON.parse(decoder.decode(message.subarray(1)));
      const body = encoder.encode('remote response body');
      const metadata = encoder.encode(JSON.stringify({ id: request.id, tabId: request.tabId, contentBytes: body.byteLength, chunks: 1, truncated: false }));
      this.emit(serverSend.encrypt(Uint8Array.of(141, ...metadata)));
      this.emit(serverSend.encrypt(Uint8Array.of(142, request.id >>> 24, request.id >>> 16 & 255, request.id >>> 8 & 255, request.id & 255, 0, 0, ...body)));
      return;
    }
    if (opcode === 5) resolveFrame(new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(1));
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
    responder.initialise(encoder.encode('eya-browser-render-v1'));
    let frameValue, statusValue, cdpValue, downloadValue;
    const transport = await loaded.exports.createBrowserRenderTransport({
      url: 'ws://example.test/ws', key,
      onEvent: (value, channel) => { if (channel === 'status' && value.type === 'ready') statusValue = value; if (channel === 'cdp') cdpValue = value; },
      onFrame: (bytes, metadata) => { frameValue = { bytes: [...bytes], metadata }; },
      onDownload: (bytes, metadata) => { downloadValue = { bytes: [...bytes], metadata }; },
    });
    assert.equal(activeSocket.url, 'ws://example.test/browser-render-ws');
    await assert.rejects(transport.start(), /Chromium could not start/, 'startup must retain the server failure');
    const firstStart = transport.start(), secondStart = transport.start();
    assert.equal(firstStart, secondStart, 'concurrent callers must share one startup');
    await firstStart;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(frameValue.bytes, [1, 2, 3, 4, 5]);
    assert.equal(frameValue.metadata.seq, 7);
    assert.deepEqual(downloadValue, { bytes: [...encoder.encode('file!')], metadata: { id: 9, filename: 'file.bin' } });
    assert.equal(statusValue.type, 'ready');
    transport.ack(7);
    assert.equal(await frameReady, 7);
    const evaluation = await transport.evaluate('eya-browser-11', '1 + 6');
    assert.equal(evaluation.remoteObject.objectId, 'object-1');
    await transport.evaluate('eya-browser-11', 'localValue', 'frame-1');
    await transport.activateTab('eya-browser-11');
    transport.navigate('https://example.test/path', 'eya-browser-11');
    await transport.activateTab('eya-browser-12');
    transport.closeTab('eya-browser-12');
    transport.resize(5000, 10, 'eya-browser-11');
    await transport.userscripts(['(()=>{document.documentElement.dataset.test="ok"})()']);
    assert.equal((await transport.filters({ version: 1, hosts: ['ads.example'], rules: [] })).ok, true);
    const filterHeader = JSON.parse(decoder.decode(received.find(message => message[0] === 24).subarray(1)));
    assert.equal(filterHeader.hostCount, 1, 'filter upload header must include host count for server validation');
    assert.equal(filterHeader.ruleCount, 0, 'filter upload header must include rule count for server validation');
    transport.privacy({ blockTrackers: true, blockThirdParty: true, stripTracking: false });
    const sources = await transport.sources('eya-browser-11');
    assert.equal(sources.sources[0].url, 'https://example.test/app.js');
    const source = await transport.sourceContent('eya-browser-11', 'https://example.test/app.js');
    assert.equal(source.text, 'hello');
    assert.equal(source.truncated, false);
    const cookies = await transport.cookies('eya-browser-11', 'https://example.test');
    assert.equal(cookies.cookies[0].httpOnly, true);
    assert.equal((await transport.clearSiteData('eya-browser-11', 'https://example.test')).ok, true);
    const extensionManifest = encoder.encode(JSON.stringify({ manifest_version: 3, name: 'Test extension', version: '1.0' }));
    const extensionFile = (path, bytes) => ({ webkitRelativePath: `test-extension/${path}`, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    const extension = await transport.installExtension([extensionFile('manifest.json', extensionManifest), extensionFile('content.js', encoder.encode('x'.repeat(50_000)))]);
    assert.deepEqual(extension, { id: 'a'.repeat(32), name: 'Test extension', hasAction: true });
    const action = await transport.triggerExtensionAction(extension.id, 'eya-tab-1');
    assert.equal(action.phase, 'action-triggered');
    const actionMessage = received.find(message => message[0] === 35);
    assert.deepEqual(JSON.parse(decoder.decode(actionMessage.subarray(1))), { requestId: action.id, extensionId: extension.id, tabId: 'eya-tab-1' });
    assert.equal((await transport.removeExtension(extension.id)).phase, 'removed');
    const breakpoint = await transport.debugger('eya-browser-11', 'setBreakpoint', { url: 'https://example.test/app.js', line: 9 });
    assert.equal(breakpoint.breakpointId, 'bp-1');
    await transport.debugger('eya-browser-11', 'pause');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(cdpValue.method, 'Debugger.paused');
    await transport.debugger('eya-browser-11', 'resume'); await transport.debugger('eya-browser-11', 'stepOver'); await transport.debugger('eya-browser-11', 'stepInto'); await transport.debugger('eya-browser-11', 'stepOut');
    await transport.debugger('eya-browser-11', 'removeBreakpoint', { breakpointId: breakpoint.breakpointId });
    const properties = await transport.debugger('eya-browser-11', 'getProperties', { objectId: 'object-1' });
    assert.equal(properties.properties[0].name, 'count');
    assert.equal(properties.properties[0].value.value, 7);
    const scopes = await transport.debugger('eya-browser-11', 'getScopes', { callFrameId: 'frame-1' });
    assert.equal(scopes.scopes[0].object.objectId, 'scope-1');
    assert.equal(scopes.scopes[0].name, 'work');
    assert.deepEqual(await transport.networkBody('request-1', 'eya-browser-11'), { text: 'remote response body', truncated: false });
    assert.deepEqual(JSON.parse(decoder.decode(received.findLast(message => message[0] === 22).subarray(1))), { id: 1, requestId: 'request-1', tabId: 'eya-browser-11' });
    await assert.rejects(transport.debugger('eya-browser-11', 'setBreakpoint', { url: 'https://example.test/app.js', line: 0 }), /Breakpoint source or line is invalid/);
    transport.cancelDownload(9);
    transport.input({ type: 'key', action: 'keyDown', key: 'a' }, 'eya-browser-11');
    transport.close();
    await new Promise(resolve => setTimeout(resolve, 10));
    const opcodes = received.map(message => message[0]);
    assert.deepEqual(opcodes, [1, 1, 5, 7, 7, 27, 2, 27, 28, 3, 9, 10, 11, 24, 25, 26, 8, 12, 13, 14, 15, 16, 17, 17, 17, 18, 35, 19, 21, 21, 21, 21, 21, 21, 21, 21, 21, 22, 23, 4, 6]);
    assert.deepEqual(JSON.parse(decoder.decode(received[4].subarray(1))), { id: 2, tabId: 'eya-browser-11', expression: 'localValue', callFrameId: 'frame-1' });
    assert.deepEqual(JSON.parse(decoder.decode(received.findLast(message => message[0] === 21).subarray(1))), { id: 9, tabId: 'eya-browser-11', action: 'getScopes', callFrameId: 'frame-1' });
    assert.deepEqual(JSON.parse(decoder.decode(received[5].subarray(1))), { tabId: 'eya-browser-11' });
    assert.deepEqual(JSON.parse(decoder.decode(received[6].subarray(1))), { tabId: 'eya-browser-11', url: 'https://example.test/path' });
    assert.deepEqual(JSON.parse(decoder.decode(received[7].subarray(1))), { tabId: 'eya-browser-12' });
    assert.deepEqual(JSON.parse(decoder.decode(received[8].subarray(1))), { tabId: 'eya-browser-12' });
    assert.deepEqual(JSON.parse(decoder.decode(received[9].subarray(1))), { width: 1920, height: 240, tabId: 'eya-browser-11' });
    assert.equal(JSON.parse(decoder.decode(received[10].subarray(1))).totalBytes, encoder.encode(JSON.stringify(['(()=>{document.documentElement.dataset.test="ok"})()'])).byteLength);
    assert.deepEqual(JSON.parse(decoder.decode(received[11].subarray(7))), ['(()=>{document.documentElement.dataset.test="ok"})()']);
    assert.deepEqual(JSON.parse(decoder.decode(received.find(message => message[0] === 8).subarray(1))), { blockTrackers: true, blockThirdParty: true, stripTracking: false });
    console.log('browser remote-render Noise transport tests passed');
  } finally { global.WebSocket = previousWebSocket; }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
