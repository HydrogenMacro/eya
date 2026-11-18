// Real CDP/Noise recovery: no production decoder mocks and no Internet sites.
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const net = require('node:net');
const Noise = require('noise-handshake'), Cipher = require('noise-handshake/cipher');
const { chromium } = require('playwright');
const { fixture, KEY } = require('./continuity-fixture.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));


async function createRelay(port) {
  const sockets = new Set(); let downstream = null, manuallyPaused = false, resumeTimer = null;
  const server = net.createServer(client => {
    const upstream = net.connect(port, '127.0.0.1'); sockets.add(client); sockets.add(upstream); downstream = upstream;
    client.pipe(upstream);
    upstream.on('data', data => { if (!client.write(data)) upstream.pause(); });
    client.on('drain', () => { if (!manuallyPaused) upstream.resume(); });
    upstream.on('end', () => client.end());
    for (const [source, destination] of [[client, upstream], [upstream, client]]) {
      source.on('error', () => destination.destroy());
      source.on('close', () => { sockets.delete(source); destination.destroy(); });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}/browser-render-ws`,
    pauseDown(ms) {
      manuallyPaused = true; downstream.pause(); clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => { manuallyPaused = false; downstream?.resume(); }, ms);
    },
    async close() { clearTimeout(resumeTimer); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}

function inspectTiles(bytes, meta) {
  assert.equal(bytes.subarray(0, 4).toString(), 'EYT1');
  const edge = bytes.readUInt16BE(4), count = bytes.readUInt16BE(6);
  assert.ok(edge === 64 || edge === 128);
  assert.equal(count, meta.tiles);
  const columns = Math.ceil(meta.pixelWidth / edge), rows = Math.ceil(meta.pixelHeight / edge);
  assert.ok(meta.pixelWidth * meta.pixelHeight <= 4_194_304);
  if (!meta.base) assert.equal(count, columns * rows);
  const seen = new Set(); let offset = 8;
  for (let i = 0; i < count; i++) {
    assert.ok(offset + 7 <= bytes.length);
    const index = bytes.readUInt16BE(offset), mode = bytes[offset + 2], length = bytes.readUInt32BE(offset + 3); offset += 7;
    assert.ok(index < columns * rows && !seen.has(index)); seen.add(index);
    assert.ok(mode === 0 || (mode === 1 && meta.base !== 0));
    assert.ok(length > 0 && offset + length <= bytes.length);
    const x = (index % columns) * edge, y = Math.floor(index / columns) * edge;
    const expected = Math.min(edge, meta.pixelWidth - x) * Math.min(edge, meta.pixelHeight - y) * 4;
    assert.equal(zlib.inflateRawSync(bytes.subarray(offset, offset + length), { maxOutputLength: expected }).length, expected);
    offset += length;
  }
  assert.equal(offset, bytes.length);
}

(async () => {
  const f = await fixture({ binary: process.env.EYA_STREAM_SERVER_BINARY, env: { EYA_BROWSER_CHROMIUM: process.env.EYA_BROWSER_EXECUTABLE || chromium.executablePath(), EYA_BROWSER_GPU_MODE: 'off' } });
  let socket, relay;
  try {
    relay = await createRelay(f.port);
    const encoder = new TextEncoder(), decoder = new TextDecoder();
    const handshake = new Noise('NNpsk0', true, null, { psk: Buffer.from(KEY, 'hex') });
    handshake.initialise(encoder.encode('eya-browser-render-v1'));
    socket = new WebSocket(relay.url); socket.binaryType = 'arraybuffer';
    let tx, rx, stage = 0, pending = null, evaluationId = 0, scheduling = null;
    const events = [], frames = [], errors = [];
    const send = bytes => socket.send(tx.encrypt(bytes));
    const command = (opcode, data) => send(Uint8Array.of(opcode, ...encoder.encode(JSON.stringify(data))));
    const ack = (seq, success) => { const bytes = new Uint8Array(6); bytes[0] = 39; new DataView(bytes.buffer).setUint32(1, seq); bytes[5] = success ? 1 : 0; send(bytes); };
    const legacyAck = seq => { const bytes = new Uint8Array(5); bytes[0] = 5; new DataView(bytes.buffer).setUint32(1, seq); send(bytes); };
    socket.onopen = () => socket.send(handshake.send());
    socket.onmessage = ({ data }) => {
      try {
        if (!stage) { handshake.recv(new Uint8Array(data)); tx = new Cipher(handshake.tx); rx = new Cipher(handshake.rx); stage = 1; send(encoder.encode('eya-browser-render-ready-v1')); return; }
        const message = rx.decrypt(new Uint8Array(data)), opcode = message[0];
        if (stage === 1) { assert.equal(decoder.decode(message), 'eya-browser-render-ready-v1'); stage = 2; send(Uint8Array.of(1)); return; }
        if ([129, 133, 134].includes(opcode)) {
          const event = JSON.parse(decoder.decode(message.subarray(1))); events.push(event);
          if (scheduling && event.id === scheduling.evaluationId) {
            scheduling.reply = event;
            scheduling.interleaved = pending?.meta.seq === scheduling.seq;
            scheduling.chunksAtReply = pending?.next;
          }
        }
        if (opcode === 130 || opcode === 147) {
          assert.equal(pending, null, 'A complete frame precedes the next frame metadata');
          const meta = JSON.parse(decoder.decode(message.subarray(1)));
          assert.ok(meta.bytes > 0 && meta.bytes <= 16 * 1024 * 1024);
          assert.equal(meta.chunks, Math.ceil(meta.bytes / (48 * 1024)));
          pending = { meta, opcode, bytes: Buffer.alloc(meta.bytes), next: 0 };
          if (scheduling && !scheduling.started && meta.bytes > 5 * 1024 * 1024) {
            scheduling.started = true; scheduling.seq = meta.seq; scheduling.chunks = meta.chunks;
            // Pause only the server->client leg. Inputs and debugger commands
            // still reach the server while its output socket is backpressured.
            relay.pauseDown(200);
            command(4, { tabId: 'tiles', type: 'key', action: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 });
            command(7, { id: scheduling.evaluationId, tabId: 'tiles', expression: 'window.__schedulerInput' });
          }
        } else if (opcode === 131 || opcode === 148) {
          assert.ok(pending); assert.equal(opcode, pending.opcode === 147 ? 148 : 131);
          const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
          assert.equal(view.getUint32(1), pending.meta.seq); assert.equal(view.getUint16(5), pending.next);
          pending.bytes.set(message.subarray(7), pending.next * 48 * 1024); pending.next++;
          if (pending.next === pending.meta.chunks) {
            const complete = pending; pending = null;
            if (complete.opcode === 147) inspectTiles(complete.bytes, complete.meta);
            else { assert.ok(complete.bytes[0] === 0x89 || complete.bytes[0] === 0xff); legacyAck(complete.meta.seq); }
            frames.push({ ...complete.meta, opcode: complete.opcode, at: performance.now() });
          }
        }
      } catch (error) { errors.push(error); }
    };
    socket.onerror = event => errors.push(Error('Live browser socket failed: ' + event.type));
    socket.onclose = event => errors.push(Error('Live browser socket closed: ' + event.code));
    const until = async (find, timeout = 15000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (errors.length) throw errors[0]; const result = find(); if (result) return result; await delay(20); }
      throw Error('Missing live tile event: ' + JSON.stringify({ events: events.slice(-6), frames: frames.slice(-5) }));
    };
    const evaluate = async (expression, tabId = 'tiles') => { const id = ++evaluationId; command(7, { id, tabId, expression }); const result = await until(() => events.find(e => e.id === id)); assert.equal(result.exception || '', ''); return result; };
    const resize = async ({ tabs = true, capabilities = ['stream-settings-v1', 'tiles-rgba-v1'], width = 800, height = 600, format = 'png' } = {}) => {
      const before = events.length;
      command(3, { tabId: 'tiles', width, height, capabilities, stream: { format, quality: 80, maxWidth: 1280, maxHeight: 720, tiles: tabs } });
      if (capabilities.length) return until(() => events.slice(before).find(e => e.type === 'stream-settings'));
    };
    const nextTile = (after, timeout = 15000) => until(() => frames.slice(after).find(frame => frame.opcode === 147), timeout);
    const mutate = value => evaluate(`document.querySelector('#tick').textContent=${JSON.stringify(value)};true`);

    await until(() => events.find(e => e.type === 'ready'));
    command(27, { tabId: 'tiles' }); await until(() => events.find(e => e.type === 'tab-activated'));
    // Missing/unknown capability fields cannot reinterpret tiles:true.
    await resize({ capabilities: [], format: 'png' });
    let before = frames.length;
    await evaluate(`document.body.innerHTML='<style>body{margin:0;font:16px monospace}p{margin:5px}</style><span id="tick">Ready</span>'+Array.from({length:50},(_,i)=>'<p>Document '+i+' · precise text 0.125 mm · café 中文</p>').join('');true`);
    await until(() => frames.slice(before).find(frame => frame.width === 800));
    assert.equal(frames.at(-1).format, 'jpeg'); assert.equal(frames.some(frame => frame.opcode === 147), false);
    let selected = await resize({ capabilities: ['future-tiles-v9', 'stream-settings-v1'] });
    assert.deepEqual(selected.capabilities, ['stream-settings-v1']);
    before = frames.length; await mutate('PNG only'); await until(() => frames.slice(before).find(frame => frame.format === 'png'));
    assert.equal(frames.some(frame => frame.opcode === 147), false);

    before = frames.length;
    selected = await resize({ capabilities: ['stream-settings-v1', 'tiles-rgba-v1', 'future-tiles-v9'] });
    assert.deepEqual(selected.capabilities, ['stream-settings-v1', 'tiles-rgba-v1']);
    await mutate('Keyframe'); let frame = await nextTile(before); assert.equal(frame.base, 0);
    const first = frame;
    before = frames.length; legacyAck(first.seq); ack((first.seq + 100) >>> 0, true); await mutate('Delta after correct ACK'); await delay(300);
    assert.equal(frames.length, before, 'Legacy or wrong-sequence ACK cannot release a tile reference');
    ack(first.seq, true); frame = await nextTile(before); assert.equal(frame.base, first.seq);
    ack(frame.seq, true);

    // Rejected updates re-key, then repeated failures select independent PNG.
    before = frames.length; await mutate('Rejected delta'); frame = await nextTile(before);
    for (let failure = 0; failure < 3; failure++) {
      before = frames.length; ack(frame.seq, false);
      if (failure < 2) { frame = await nextTile(before); assert.equal(frame.base, 0); }
    }
    await until(() => events.find(e => e.type === 'stream-fallback'));
    await until(() => frames.slice(before).find(frame => frame.opcode === 130 && frame.format === 'png'));
    before = frames.length; await mutate('Fallback remains live'); await until(() => frames.slice(before).find(frame => frame.format === 'png'));
    assert.equal(frames.slice(before).some(frame => frame.opcode === 147), false);

    // Explicit re-selection permits recovery. A dropped ACK is bounded.
    before = frames.length; await resize(); await mutate('Dropped ACK'); frame = await nextTile(before); assert.equal(frame.base, 0);
    const dropped = frame; before = frames.length; await mutate('Final input while ACK is missing');
    frame = await nextTile(before, 25000); // watchdog regenerates a canonical keyframe in 15 seconds
    assert.equal(frame.base, 0); assert.ok(frame.at - dropped.at >= 14000, 'Dropped ACK waits for the watchdog'); ack(frame.seq, true);

    // Disabling tiles while a tile awaits ACK must not leave capture stuck.
    before = frames.length; await mutate('Disable pending'); frame = await nextTile(before);
    before = frames.length; await resize({ tabs: false }); await mutate('Independent PNG after disable');
    await until(() => frames.slice(before).find(frame => frame.opcode === 130 && frame.format === 'png'));
    before = frames.length; await resize({ width: 640, height: 480 }); await mutate('Resized keyframe'); frame = await nextTile(before);
    assert.equal(frame.base, 0);
    // CDP may deliver a capture started before the device-metrics command.
    // ACK that complete image, then require the final requested geometry.
    for (let attempt = 0; frame.pixelWidth !== 640 && attempt < 3; attempt++) {
      ack(frame.seq, true); before = frames.length; await mutate('Settled resize ' + attempt); frame = await nextTile(before);
    }
    assert.equal(frame.base, 0); assert.equal(frame.pixelWidth, 640); assert.equal(frame.pixelHeight, 480); ack(frame.seq, true);

    // Switching retained targets establishes a new canonical surface.
    before = frames.length; command(27, { tabId: 'second' }); frame = await nextTile(before); assert.equal(frame.tabId, 'second'); assert.equal(frame.base, 0); ack(frame.seq, true);
    assert.equal((await evaluate('document.visibilityState', 'second')).result, 'visible');
    before = frames.length; await evaluate("document.body.textContent='Second target repaint';true", 'second');
    frame = await nextTile(before); assert.equal(frame.tabId, 'second'); ack(frame.seq, true);
    before = frames.length; command(27, { tabId: 'tiles' }); frame = await nextTile(before); assert.equal(frame.tabId, 'tiles'); assert.equal(frame.base, 0); ack(frame.seq, true);
    const visibility = await evaluate('document.visibilityState');
    assert.equal(visibility.result, 'visible', 'A retained target must become visible before subsequent repaint capture');
    // A large independent image must not monopolize the session handler.
    // This is a scheduling regression, not a WAN latency benchmark: the relay
    // deliberately stops downstream reads for 200ms while leaving uplink free.
    before = frames.length;
    const settingsBefore = events.length;
    command(3, { tabId: 'tiles', width: 2000, height: 1200, capabilities: ['stream-settings-v1'], stream: { format: 'png', quality: 80, maxWidth: 8192, maxHeight: 8192, tiles: false } });
    await until(() => events.slice(settingsBefore).find(event => event.type === 'stream-settings' && event.stream?.maxWidth === 8192));
    const dimensions = await evaluate('JSON.stringify([innerWidth,innerHeight])');
    assert.deepEqual(JSON.parse(dimensions.result), [2000, 1200]);
    await evaluate("document.body.style.background='#eef';true");
    await until(() => frames.slice(before).find(frame => frame.format === 'png' && frame.width === 2000));
    scheduling = { evaluationId: ++evaluationId, started: false };
    await evaluate(`(()=>{document.body.innerHTML='<canvas width="2000" height="1200"></canvas>';document.body.style.margin='0';window.__schedulerInput=0;document.onkeydown=()=>{window.__schedulerInput++;};const c=document.querySelector('canvas'),x=c.getContext('2d'),im=x.createImageData(c.width,c.height);let seed=17;for(let i=0;i<im.data.length;i+=4){for(let channel=0;channel<3;channel++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;im.data[i+channel]=seed>>>24;}im.data[i+3]=255;}x.putImageData(im,0,0);return true;})()`);
    await until(() => scheduling.reply, 30000);
    assert.equal(scheduling.reply.result, 1, 'Input reached Chromium while the display frame was still sending');
    assert.equal(scheduling.interleaved, true, 'Input readback is delivered between display chunks');
    assert.ok(scheduling.chunksAtReply < scheduling.chunks);
    console.log(`Large-frame input readback arrived after chunk ${scheduling.chunksAtReply}/${scheduling.chunks}.`);
    await until(() => frames.find(frame => frame.seq === scheduling.seq), 30000);
    assert.deepEqual(errors, []); send(Uint8Array.of(6));
    console.log('Live tiles: explicit capability selection, canonical/delta ACKs, rejection fallback, dropped-ACK recovery, pending disable, resize, retained-tab resets and input scheduling passed.');
  } finally { socket?.close(); await relay?.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
