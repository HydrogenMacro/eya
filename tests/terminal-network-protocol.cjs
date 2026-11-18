// Real Noise/WebSocket/PTY regression tests. Only disposable server roots are used.
// Build client/server first; run NODE_PATH=client/node_modules node tests/terminal-network-protocol.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { inflateRawSync } = require('node:zlib');
const { performance } = require('node:perf_hooks');
const { fixture } = require('./continuity-fixture.cjs');
const { Peer } = require('./workspace-protocol.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const random = () => randomBytes(32).toString('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const octal = value => [...Buffer.from(value)].map(byte => `\\${byte.toString(8).padStart(3, '0')}`).join('');
function offset(type, value, tail = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(9 + tail.length); bytes[0] = type;
  bytes.writeBigUInt64BE(BigInt(value), 1); tail.copy(bytes, 9); return bytes;
}

class TerminalPeer {
  constructor(peer, state, token) {
    this.peer = peer; this.state = state; this.token = token;
    this.input = state.nextInput ?? state.input; this.output = state.output;
    this.unread = Buffer.alloc(0); this.rawFrames = 0; this.compressedFrames = 0;
  }
  inputAt(start, bytes) { this.peer.send(offset(0, start, Buffer.from(bytes))); }
  send(text) {
    const bytes = Buffer.from(text); this.inputAt(this.input, bytes); this.input += bytes.length;
  }
  command(command) { this.send(command + '\r'); }
  ack(value = this.output) { this.peer.send(offset(2, value)); }
  async packet(acknowledge = true) {
    const packet = Buffer.from(await this.peer.wait(bytes => bytes[0] === 8 || bytes[0] === 11));
    assert.ok(packet.length > 9); assert.equal(Number(packet.readBigUInt64BE(1)), this.output, 'Output is contiguous in decoded bytes');
    let decoded;
    if (packet[0] === 11) {
      assert.equal(this.state.compression, 'deflate-raw', 'Compressed output requires negotiation');
      assert.ok(packet.length > 13); const length = packet.readUInt32BE(9);
      assert.ok(length > 0 && length <= 8192, 'Decoded compressed output has a hard per-frame bound');
      const result = inflateRawSync(packet.subarray(13), { maxOutputLength: 8192, info: true });
      assert.equal(result.engine.bytesWritten, packet.length - 13, 'Each frame contains exactly one independent DEFLATE block');
      decoded = result.buffer; assert.equal(decoded.length, length, 'Decoded length matches its envelope'); this.compressedFrames++;
      assert.ok(length >= 256, 'Small output remains raw without waiting for a full block');
      const framedSize = bytes => bytes + 16 + (bytes + 16 < 126 ? 2 : 4);
      assert.ok(framedSize(length + 9) - framedSize(packet.length) >= 16, 'Compression is used only when its complete frame saves at least sixteen bytes');
    } else { decoded = packet.subarray(9); this.rawFrames++; }
    assert.ok(decoded.length > 0 && decoded.length <= 8192);
    this.output += decoded.length; if (acknowledge) this.ack(); return decoded;
  }
  async through(marker, acknowledge = true) {
    const needle = Buffer.from(marker); let result = this.unread; this.unread = Buffer.alloc(0);
    for (;;) {
      const index = result.indexOf(needle);
      if (index >= 0) { this.unread = result.subarray(index + needle.length); return result.subarray(0, index + needle.length); }
      result = Buffer.concat([result, await this.packet(acknowledge)]);
      assert.ok(result.length <= 4 * 1024 * 1024, 'Test transcript is bounded');
    }
  }
  async initialize() {
    const marker = `INITIALIZED-${random()}`;
    this.command(`stty -echo -opost; PS1=''; printf '${octal(marker)}'`);
    await this.through(marker); this.unread = Buffer.alloc(0);
  }
  async ping() {
    const nonce = Buffer.alloc(8); nonce.writeDoubleBE(performance.now()); this.peer.send(Buffer.concat([Buffer.from([3]), nonce]));
    const reply = Buffer.from(await this.peer.wait(bytes => bytes[0] === 3)); assert.deepEqual(reply.subarray(1), nonce);
  }
  close() { this.peer.close(); }
}

async function scenario(env, verify) {
  const f = await fixture({ env: { EYA_SESSION_BUFFER_BYTES: '65536', ...env } });
  const peers = [];
  function peer(...args) { const instance = new Peer(...args); peers.push(instance); return instance; }
  let control, identity;
  async function terminal(values = {}) {
    const token = values.token || random();
    const connection = peer(f.url, 'eya-terminal-v1', 'eya-ready-v4:' + JSON.stringify({ token, output: 0, create: true, client: identity.client, ...values }));
    const state = await connection.state(); assert.equal(state.state, 'ready');
    assert.equal(state.maxOutputChunk, 8192); assert.ok(state.outputWindow >= 4096 && state.outputWindow <= 32768);
    return new TerminalPeer(connection, state, token);
  }
  async function end(instance) {
    const result = await control.request('session.end', { session: instance.token }); assert.equal(result.ok, true);
    instance.close();
  }
  try {
    control = peer(f.url, 'eya-terminal-v1', 'eya-workspace-v1:{}'); identity = await control.state();
    await verify({ f, terminal, control, end });
  }
  finally { for (const connection of peers) connection.close(); await f.close(); }
}

(async () => {
  await scenario({}, async ({ f, terminal, control, end }) => {
    // Unicode, ANSI, repeated logs and incompressible bytes all share one lossless stream.
    const output = Buffer.concat([
      Buffer.from(Array.from({ length: 1600 }, (_, i) => `\x1b[${31 + i % 6}mrow=${i} λ日本語🙂 elapsed=${i % 17}ms\x1b[0m\n`).join('')),
      ...Array.from({ length: 512 }, (_, i) => createHash('sha256').update(`entropy ${i}`).digest()),
    ]);
    const filename = path.join(f.files, "output with 'quotes'.bin"); await fs.writeFile(filename, output);
    for (const compression of [undefined, null, false, 'not-supported', 'deflate-raw']) {
      const instance = await terminal({ compression });
      assert.equal(instance.state.compression ?? null, compression === 'deflate-raw' ? 'deflate-raw' : null);
      await instance.initialize();
      const marker = `END-${random()}`;
      instance.command(`cat -- ${quote(filename)}; printf '${octal(marker)}'`);
      const transcript = await instance.through(marker);
      assert.deepEqual(transcript, Buffer.concat([output, Buffer.from(marker)]), `Exact output for negotiated value ${compression}`);
      if (compression === 'deflate-raw') {
        assert.ok(instance.compressedFrames > 0, 'Compressible PTY output uses negotiated compression');
        assert.ok(instance.rawFrames > 0, 'Small/incompressible output falls back to raw frames');
      } else assert.equal(instance.compressedFrames, 0, 'Legacy/unsupported/off peers see only raw output');
      await end(instance);
    }

    const concurrent = await Promise.all([terminal({ compression: 'deflate-raw' }), terminal({ compression: null })]);
    await Promise.all(concurrent.map(instance => instance.initialize()));
    await Promise.all(concurrent.map(async (instance, index) => {
      const marker = `INDEPENDENT-${index}-${random()}`;
      instance.command(`cat -- ${quote(filename)}; printf '${octal(marker)}'`);
      assert.deepEqual(await instance.through(marker), Buffer.concat([output, Buffer.from(marker)]), 'Simultaneous terminals keep independent codec, byte offsets and transcripts');
    }));
    assert.ok(concurrent[0].compressedFrames > 0); assert.equal(concurrent[1].compressedFrames, 0);
    await Promise.all(concurrent.map(end));

    // Preserve a partial frame, disconnect before its ACK, and change codec.
    // A resume's accepted output offset must truncate replay in original bytes.
    let instance = await terminal({ compression: 'deflate-raw' }); await instance.initialize();
    const before = instance.output, marker = `REPLAY-END-${random()}`;
    instance.command(`cat -- ${quote(filename)}; printf '${octal(marker)}'`);
    const first = await instance.packet(false); const retained = Math.max(1, Math.floor(first.length / 2));
    instance.ack(before + Math.floor(retained / 2));
    instance.close(); await delay(100);
    instance = await terminal({ token: instance.token, compression: null, create: false, output: before + retained });
    assert.equal(instance.state.resumed, true); assert.equal(instance.state.compression ?? null, null);
    assert.equal(instance.output, before + retained);
    const replay = await instance.through(marker);
    assert.deepEqual(Buffer.concat([first.subarray(0, retained), replay]), Buffer.concat([output, Buffer.from(marker)]), 'Partial compressed replay can continue as raw without missing or duplicating bytes');

    const rawBefore = instance.output, secondMarker = `REENCODE-END-${random()}`;
    instance.command(`cat -- ${quote(filename)}; printf '${octal(secondMarker)}'`);
    const firstRaw = await instance.packet(false), keepRaw = Math.max(1, Math.floor(firstRaw.length / 2));
    const oldToken = instance.token; instance.close(); await delay(100);
    instance = await terminal({ token: oldToken, compression: 'deflate-raw', create: false, output: rawBefore + keepRaw });
    const reencoded = await instance.through(secondMarker);
    assert.deepEqual(Buffer.concat([firstRaw.subarray(0, keepRaw), reencoded]), Buffer.concat([output, Buffer.from(secondMarker)]), 'Replay can negotiate compression anew on a raw-to-compressed reconnect');
    assert.ok(instance.compressedFrames > 0, 'Retained original bytes are re-encoded with the new connection codec');

    // Send one input twice without consuming its ACK; reconnect with the same
    // input range. Only one actual PTY write/command execution is allowed.
    const inputBefore = instance.input;
    const mutation = Buffer.from('EYA_ONCE=$(( ${EYA_ONCE:-0} + 1 ))\r');
    instance.inputAt(inputBefore, mutation); instance.inputAt(inputBefore, mutation); instance.input += mutation.length;
    // A same-connection heartbeat fences the actor's receipt of both copies.
    await instance.ping(); instance.close(); await delay(100);
    const resumed = await terminal({ token: instance.token, compression: 'deflate-raw', create: false, output: instance.output });
    assert.ok(resumed.state.nextInput >= inputBefore + mutation.length);
    resumed.inputAt(inputBefore, mutation);
    const onceMarker = `ONCE-${random()}`;
    resumed.command(`printf '${octal(onceMarker)}=%s' "$EYA_ONCE"`);
    const once = await resumed.through(`${onceMarker}=1`);
    assert.ok(!once.includes(Buffer.from(`${onceMarker}=2`)), 'A retransmitted input range cannot execute twice');
    await end(resumed);

    // Withhold output ACKs while producing far more than the replay window.
    // The actor must still accept input, echo pings, Inspect and explicit end.
    const busy = await terminal({ compression: 'deflate-raw' }); await busy.initialize();
    busy.command("yes 'bulk output competing with keyboard input' ");
    await busy.packet(false); await delay(200);
    const started = performance.now(); await busy.ping();
    assert.ok(performance.now() - started < 2000, 'Heartbeats stay responsive with an output-saturated terminal');
    const inspectedAt = performance.now();
    const listed = await control.request('session.list'); const state = listed.sessions.find(item => item.id === busy.token);
    assert.ok(performance.now() - inspectedAt < 2000, 'Inspect is not starved by blocked terminal output');
    assert.equal(state.status, 'attached');
    const network = state.network; assert.ok(network);
    assert.ok(Number.isFinite(network.outputInFlight) && network.outputInFlight > 0 && network.outputInFlight <= 32768, 'Outstanding decoded output never exceeds the largest credit window');
    assert.ok(Number.isFinite(network.outputWindow) && network.outputWindow >= 4096 && network.outputWindow <= 32768);
    // A window can shrink below already-sent bytes; it cannot retract them.
    assert.ok(network.writerQueued >= 0 && network.writerQueued <= 16, 'Writer queue is bounded separately from output credit');
    assert.ok(state.replayBytes > 0 && state.replayBytes <= 65536 + 8192, 'The configured replay limit plus at most one reader chunk is bounded');
    assert.ok(state.replayBytes <= network.outputWindow + 8192, 'A continuously attached terminal backpressures the producer near its live window rather than filling the larger detached replay cap');
    assert.ok(network.compressedFrames > 0); assert.ok(network.outputRawBytes > network.outputFramedBytes);
    assert.ok(Number.isFinite(network.outputAckAgeMs));
    const beforeInterrupt = busy.input; busy.send('\x03'); await busy.ping();
    let after;
    for (let tries = 0; tries < 100; tries++) {
      after = (await control.request('session.list')).sessions.find(item => item.id === busy.token);
      if (after.input >= beforeInterrupt + 1) break;
      await delay(10);
    }
    assert.ok(after.input >= beforeInterrupt + 1, 'Ctrl-C reaches the PTY while output ACKs are withheld');
    await end(busy);
    console.log('Terminal protocol: negotiated/raw compatibility, exact mixed-byte output, bounded frames, raw fallback, partial replay with codec switch, duplicate-input recovery, saturated-output input/ping/Inspect/end passed');
  });
  await scenario({ EYA_TERMINAL_COMPRESSION: 'off' }, async ({ terminal, end }) => {
    const instance = await terminal({ compression: 'deflate-raw' });
    assert.equal(instance.state.compression ?? null, null, 'Server operator can disable compression');
    await instance.initialize(); const marker = `DISABLED-${random()}`;
    instance.command(`head -c 32768 /dev/zero; printf '${octal(marker)}'`);
    const transcript = await instance.through(marker);
    assert.deepEqual(transcript, Buffer.concat([Buffer.alloc(32768), Buffer.from(marker)]));
    assert.equal(instance.compressedFrames, 0); await end(instance);
    console.log('Terminal protocol: server compression opt-out passed');
  });
  await assert.rejects(fixture({ env: { EYA_TERMINAL_COMPRESSION: 'yes' } }), /EYA_TERMINAL_COMPRESSION must be auto or off/);
  console.log('Terminal protocol: invalid compression configuration fails startup');
})().catch(error => { console.error(error); process.exitCode = 1; });
