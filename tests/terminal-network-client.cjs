const assert = require('node:assert/strict');
const { deflateRawSync, inflateRawSync, constants } = require('node:zlib');
const { createHash } = require('node:crypto');
const { build } = require('esbuild');
const { chromium } = require('playwright');
const Module = require('node:module');

async function modules() {
  const result = await build({ stdin: { contents: "export * from './client/terminal-codec.js'; export * from './client/terminal-network.js';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
  const module = new Module('terminal-network-test'); module._compile(result.outputFiles[0].text, 'terminal-network-test.cjs'); return module.exports;
}

const stub = `
export class Terminal {
  constructor() { this.cols=80; this.rows=24; this.options={}; this._core={_selectionService:{}}; this.modes={mouseTrackingMode:'none'}; this.buffer={active:{viewportY:0}}; window.__terminal=this; this.writes=[]; this.writeBuffers=[]; this.callbacks=[]; }
  loadAddon() {} open(element) { element.style.width='800px'; element.style.height='400px'; }
  onData(callback) { this.input=callback; return {dispose(){}}; }
  onBinary() { return {dispose(){}}; }
  registerLinkProvider() { return {dispose(){}}; }
  write(bytes, callback) { this.writes.push([...bytes]); this.writeBuffers.push(bytes); if(window.__holdRender) this.callbacks.push(callback); else queueMicrotask(callback); }
  focus(){} clear(){} reset(){this.writes=[];} dispose(){} paste(text){this.input(text);} getSelection(){return '';} hasSelection(){return false;} selectAll(){} clearSelection(){} select(){} scrollLines(){}
}
export class FitAddon { fit(){} }
export class WebglAddon { onContextLoss(){} dispose(){} }
`;

async function main() {
  const { inflateTerminalBlock, reconnectDelay, heartbeatDeadline, INPUT_IN_FLIGHT_BYTES } = await modules();
  const corpora = [Buffer.from('one key'), Buffer.from('colored prompt \x1b[32muser@host\x1b[0m$ '), Buffer.alloc(8192, 97),
    Buffer.concat(Array.from({ length: 256 }, (_, i) => createHash('sha256').update(`block ${i}`).digest())),
    Buffer.from(Array.from({ length: 160 }, (_, i) => `\x1b[${i % 24};1H worker=${i} value=${i % 17}\r\n`).join(''))];
  let valid = 0;
  for (const source of corpora) for (const size of [1, 13, 257, 1024, 8192]) for (const level of [0, 1, 6, 9]) for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FIXED, constants.Z_HUFFMAN_ONLY, constants.Z_RLE]) {
    const plain = source.subarray(0, size), compressed = deflateRawSync(plain, { level, strategy });
    if (compressed.length > 8192) continue;
    assert.deepEqual(Buffer.from(inflateTerminalBlock(compressed, plain.length)), plain); valid++;
  }
  const bomb = deflateRawSync(Buffer.alloc(1024 * 1024, 97));
  assert.throws(() => inflateTerminalBlock(bomb, 8192), /Invalid compressed/);
  assert.throws(() => inflateTerminalBlock(Buffer.alloc(8193), 1), /Invalid compressed/);
  const block = deflateRawSync(Buffer.from('repeat me '.repeat(300)));
  for (const length of [0, -1, 8193, NaN, 12.5, 2999, 3001]) assert.throws(() => inflateTerminalBlock(block, length), /Invalid compressed/);
  for (let length = 0; length < block.length; length++) assert.throws(() => inflateTerminalBlock(block.subarray(0, length), 3000), /Invalid compressed/);
  assert.throws(() => inflateTerminalBlock(Buffer.concat([block, Buffer.from([0])]), 3000), /Invalid compressed/);
  assert.throws(() => inflateTerminalBlock(Buffer.concat([block, block]), 3000), /Invalid compressed/);
  assert.throws(() => inflateTerminalBlock(Uint8Array.of(7), 1), /Invalid compressed/);
  // Mutation differential: any accepted block must agree exactly with zlib,
  // including its consumed input length. This tests malformed Huffman tables,
  // distances, stored blocks and EOF handling without allocating large output.
  for (let i = 0; i < 1000; i++) {
    const data = Buffer.from(block); data[i % data.length] ^= (i * 71 % 255) + 1;
    let decoded;
    try { decoded = inflateTerminalBlock(data, 3000); } catch { continue; }
    const reference = inflateRawSync(data, { info: true, maxOutputLength: 8192 });
    assert.equal(reference.engine.bytesWritten, data.length); assert.deepEqual(Buffer.from(decoded), reference.buffer);
  }
  assert.equal(reconnectDelay(0, 0), 400); assert.equal(reconnectDelay(0, 1), 500);
  assert.equal(reconnectDelay(100, 1), 10000); assert.equal(heartbeatDeadline(0), 30000); assert.equal(heartbeatDeadline(10000), 60000);

  const bundle = await build({ stdin: { contents: "import {createTerminalPanel} from './client/terminal-panel.js'; window.createTerminalPanel=createTerminalPanel;", resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', write: false,
    plugins: [{ name: 'terminal-test-stubs', setup(build) {
      build.onResolve({ filter: /^@xterm\// }, args => ({ path: args.path, namespace: 'test' }));
      build.onResolve({ filter: /^noise-handshake(?:\/cipher)?$/ }, args => ({ path: args.path, namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path.startsWith('@xterm/') ? stub : args.path.endsWith('/cipher')
        ? 'export default class Cipher {nonce=0; encrypt(bytes){this.nonce++;return bytes;} decrypt(bytes){this.nonce++;return bytes;}}'
        : 'export default class Noise {initialise(){} send(){return Uint8Array.of(255);} recv(){this.complete=true;this.tx={};this.rx={};}}' }));
    } }],
  });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage();
    await page.setContent('<style>body{width:900px;height:600px}</style>');
    await page.evaluate(() => {
      window.__sockets=[]; window.__holdRender=false;
      window.WebSocket = class {
        static OPEN=1;
        constructor() { this.readyState=1; this.bufferedAmount=0; this.sent=[]; window.__sockets.push(this); queueMicrotask(()=>this.onopen?.()); }
        emit(bytes) { const message=Uint8Array.from(bytes);if(message[0]===9)window.__serverInputAck=Number(new DataView(message.buffer).getBigUint64(1));this.onmessage?.({data:message.buffer}); }
        send(data) {
          const bytes=Uint8Array.from(data); this.sent.push([...bytes]);
          if(bytes[0]===255) queueMicrotask(()=>this.emit([]));
          else if(bytes[0]===101) { this.confirmation=JSON.parse(new TextDecoder().decode(bytes).slice('eya-ready-v4:'.length)); queueMicrotask(()=>this.emit([7,...new TextEncoder().encode(JSON.stringify({state:'ready', input:window.__serverInputAck||0, nextInput:window.__serverInputAck||0, output:this.confirmation.output, compression:window.__serverCompression===undefined?this.confirmation.compression||null:window.__serverCompression, resumed:!this.confirmation.create}))])); }
        }
        close() { this.readyState=3; queueMicrotask(()=>this.onclose?.()); }
      };
      window.offset=(type,value)=>{const bytes=new Uint8Array(9);bytes[0]=type;new DataView(bytes.buffer).setBigUint64(1,BigInt(value));return bytes;};
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => { window.panel=createTerminalPanel({id:'test',url:'ws://localhost/',key:'00'.repeat(32)});document.body.append(panel.element);panel.onLayout(); });
    await page.waitForFunction(() => panel.api.getState().connected);
    assert.equal(await page.evaluate(() => __sockets[0].confirmation.compression), 'deflate-raw');
    await page.evaluate(() => { panel.api.sendInput('a');panel.api.sendInput('β');panel.api.sendInput('c'); });
    let frames = await page.evaluate(() => __sockets[0].sent.filter(bytes=>bytes[0]===0));
    assert.equal(frames.length, 1); assert.equal(new TextDecoder().decode(Uint8Array.from(frames[0].slice(9))), 'aβc');
    await page.evaluate(() => __sockets[0].emit(offset(9,4)));
    await page.evaluate(() => panel.api.sendInput('p'.repeat(100000)));
    assert.equal(await page.evaluate(() => panel.api.getState().network.sentUnacknowledgedInput), INPUT_IN_FLIGHT_BYTES);
    assert.equal(await page.evaluate(() => panel.api.getState().network.queuedUnsentInput), 100000-INPUT_IN_FLIGHT_BYTES);
    frames = await page.evaluate(() => __sockets[0].sent.filter(bytes=>bytes[0]===0));
    assert.ok(frames.every(bytes=>bytes.length<=4105));
    await page.evaluate(() => __sockets[0].emit(offset(9,16388)));
    assert.equal(await page.evaluate(() => panel.api.getState().network.sentUnacknowledgedInput), INPUT_IN_FLIGHT_BYTES);
    const sizesBefore = await page.evaluate(() => __sockets[0].sent.filter(bytes=>bytes[0]===1).length);
    await page.evaluate(() => { panel.onLayout();panel.onLayout();panel.onActivate(); });
    assert.equal(await page.evaluate(() => __sockets[0].sent.filter(bytes=>bytes[0]===1).length), sizesBefore);

    // Render ACKs are cumulative, callback-based and flush even at the tail.
    await page.evaluate(() => { window.__holdRender=true; const socket=__sockets[0];for(let i=0;i<3;i++)socket.emit([...offset(8,i),120]); });
    assert.equal(await page.evaluate(() => __sockets[0].sent.filter(bytes=>bytes[0]===2).length),0);
    await page.evaluate(() => { __terminal.callbacks.splice(0).forEach(callback=>callback()); });
    await page.waitForFunction(() => __sockets[0].sent.some(bytes=>bytes[0]===2));
    const acks=await page.evaluate(() => __sockets[0].sent.filter(bytes=>bytes[0]===2));
    assert.equal(acks.length,1); assert.equal(new DataView(Uint8Array.from(acks[0]).buffer).getBigUint64(1),3n);
    const compressed=deflateRawSync(Buffer.from('compressed output '.repeat(100)));
    await page.evaluate(({compressed,length})=>{const header=new Uint8Array(13);header.set(offset(11,3));new DataView(header.buffer).setUint32(9,length);__sockets[0].emit([...header,...compressed]);}, {compressed:[...compressed],length:1800});
    assert.equal(await page.evaluate(()=>panel.api.getState().network.decodedOutputBytes),1803);
    const writes = await page.evaluate(()=>__terminal.writes.length);
    await page.evaluate(({compressed,length})=>{const header=new Uint8Array(13);header.set(offset(11,3));new DataView(header.buffer).setUint32(9,length);__sockets[0].emit([...header,...compressed]);}, {compressed:[...compressed],length:1800});
    assert.equal(await page.evaluate(()=>__terminal.writes.length),writes,'Compressed replay is decoded but never displayed twice');
    assert.equal(await page.evaluate(()=>panel.api.getState().network.decodedOutputBytes),1803);
    // Finish surviving renderer work after a fresh transport attaches. Its
    // callback must ACK through the current connection rather than stall replay.
    await page.evaluate(()=>panel.api.reconnect());
    await page.waitForFunction(()=>__sockets.length===2&&panel.api.getState().connected);
    await page.evaluate(()=>__sockets[1].emit([...offset(8,1803),120]));
    await page.evaluate(()=>__terminal.callbacks.splice(0).forEach(callback=>callback()));
    await page.waitForFunction(()=>__sockets[1].sent.some(bytes=>bytes[0]===2));
    assert.equal(await page.evaluate(()=>panel.api.getState().network.outputBacklog),0);
    const partial = deflateRawSync(Buffer.alloc(100,120));
    await page.evaluate(compressed=>{
      const header=new Uint8Array(13);header.set(offset(11,1800));new DataView(header.buffer).setUint32(9,100);
      __sockets[1].emit([...header,...compressed]);
    }, [...partial]);
    assert.deepEqual(await page.evaluate(()=>{const bytes=__terminal.writeBuffers.at(-1);return [bytes.length,bytes.buffer.byteLength];}),[96,96], 'A partial replay retains only its newly accepted suffix');
    // Invalid compressed input stops the transport rather than corrupting xterm.
    const invalidResult=await page.evaluate(()=>{
      const socket=__sockets[1], before=__terminal.writes.length;
      socket.close=function(){this.readyState=2;};
      const header=new Uint8Array(13);header.set(offset(11,1900));new DataView(header.buffer).setUint32(9,1);
      socket.emit([...header,7]);socket.emit([...offset(8,1900),120]);
      return {connected:panel.api.getState().connected,additionalWrites:__terminal.writes.length-before};
    });
    assert.deepEqual(invalidResult,{connected:false,additionalWrites:0},'Malformed output immediately fences queued later messages even while native close is pending');
    await page.waitForFunction(()=>!panel.api.getState().connected);
    assert.match(await page.locator('.instance-terminal-status').textContent(),/Invalid compressed/);
    await page.evaluate(()=>panel.onClose({detach:true}));

    // An old server may ignore the advertised codec. A disabled codec is never
    // advertised, and a server cannot enable it against the client's choice.
    for (const compression of [true,false]) {
      await page.evaluate(compression=>{
        window.__serverInputAck=0;window.__serverCompression=null;window.__holdRender=false;
        window.panel=createTerminalPanel({id:'fallback',url:'ws://localhost/',key:'00'.repeat(32),compression});document.body.append(panel.element);
      },compression);
      await page.waitForFunction(()=>panel.api.getState().connected);
      assert.equal(await page.evaluate(()=>__sockets.at(-1).confirmation.compression),compression?'deflate-raw':undefined);
      await page.evaluate(()=>__sockets.at(-1).emit([...offset(8,0),111,107]));
      assert.equal(await page.evaluate(()=>panel.api.getState().network.decodedOutputBytes),2);
      await page.evaluate(()=>panel.onClose({detach:true}));
    }
    await page.evaluate(()=>{
      window.__serverCompression='deflate-raw';
      window.panel=createTerminalPanel({id:'forbidden',url:'ws://localhost/',key:'00'.repeat(32),compression:false});document.body.append(panel.element);
    });
    await page.waitForFunction(()=>document.querySelectorAll('.instance-terminal-status')[3]?.textContent.includes('Unsupported terminal compression'));
    assert.equal(await page.evaluate(()=>panel.api.getState().connected),false);
    await page.evaluate(()=>panel.onClose({detach:true}));

    // Reject an oversized envelope before attempting any decryption/decoding
    // or handing bytes to the terminal. The browser owns the initial WS buffer.
    await page.evaluate(()=>{
      window.__serverCompression=null;window.__serverInputAck=0;
      window.panel=createTerminalPanel({id:'frame-bound',url:'ws://localhost/',key:'00'.repeat(32)});document.body.append(panel.element);
    });
    await page.waitForFunction(()=>panel.api.getState().connected);
    await page.evaluate(()=>__sockets.at(-1).emit(new Uint8Array(65536)));
    await page.waitForFunction(()=>!panel.api.getState().connected);
    assert.match(await page.evaluate(()=>panel.element.querySelector('.instance-terminal-status').textContent), /frame too large/);
    assert.equal(await page.evaluate(()=>__terminal.writes.length),0);
    await page.evaluate(()=>panel.onClose({detach:true}));

    // Deterministic clock: a progressing link lives past the former 15-second
    // timeout, while a silent link still closes after the bounded deadline.
    await page.evaluate(()=>{
      window.__clock=1000;window.__realNow=performance.now.bind(performance);
      Object.defineProperty(performance,'now',{configurable:true,value:()=>window.__clock});
      window.__realInterval=setInterval;window.__realClearInterval=clearInterval;
      window.setInterval=callback=>{window.__heartbeatTick=callback;return 12345;};window.clearInterval=()=>{};
      window.__serverCompression=null;window.__serverInputAck=0;
      window.panel=createTerminalPanel({id:'heartbeat',url:'ws://localhost/',key:'00'.repeat(32)});document.body.append(panel.element);
    });
    await page.waitForFunction(()=>panel.api.getState().connected);
    await page.evaluate(()=>{window.__clock=21000;window.__heartbeatTick();});
    assert.equal(await page.evaluate(()=>panel.api.getState().connected),true);
    await page.evaluate(()=>{window.__clock=22000;__sockets.at(-1).emit([...offset(8,0),120]);window.__clock=51000;window.__heartbeatTick();});
    assert.equal(await page.evaluate(()=>panel.api.getState().connected),true);
    const stopped = await page.evaluate(()=>{
      window.__beforeDeadlineSockets=__sockets.length;
      window.__beforeDeadlineToken=__sockets.at(-1).confirmation.token;
      // Native close need not emit an event when every network packet is lost.
      __sockets.at(-1).close=function(){this.readyState=2;};
      window.__clock=53000;window.__heartbeatTick();
      return panel.api.getState().connected;
    });
    assert.equal(stopped,false,'The deadline fences the transport before a native close event');
    await page.waitForFunction(()=>__sockets.length>window.__beforeDeadlineSockets&&panel.api.getState().connected);
    assert.equal(await page.evaluate(()=>__sockets.at(-1).confirmation.create),false);
    assert.equal(await page.evaluate(()=>__sockets.at(-1).confirmation.token===window.__beforeDeadlineToken),true);
    await page.evaluate(()=>{
      panel.onClose({detach:true});window.setInterval=window.__realInterval;window.clearInterval=window.__realClearInterval;
      Object.defineProperty(performance,'now',{configurable:true,value:window.__realNow});
    });
    await page.close();
    console.log(`Terminal client: ${valid} bounded DEFLATE vectors, mutation/malformed rejection, batching, ACK-paced paste, cumulative render ACKs, resize suppression, reconnect callbacks, fallback and progress-aware heartbeat passed`);
  } finally { await browser.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
