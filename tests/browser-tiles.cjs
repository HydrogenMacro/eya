const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { deflateRawSync } = require('node:zlib');
const { buildSync } = require('esbuild');

function load(source) {
  const filename = path.resolve(source);
  const code = buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename)); loaded._compile(code, filename); return loaded.exports;
}
function payload(records, edge = 64) {
  const header = Buffer.alloc(8); header.write('EYT1'); header.writeUInt16BE(edge, 4); header.writeUInt16BE(records.length, 6);
  return Buffer.concat([header, ...records.flatMap(({ index, mode = 0, pixels, compressed }) => {
    const body = compressed || deflateRawSync(pixels), meta = Buffer.alloc(7); meta.writeUInt16BE(index); meta[2] = mode; meta.writeUInt32BE(body.length, 3); return [meta, body];
  })]);
}
const metadata = (seq, base = 0, changes = {}) => ({ format: 'rgba-tiles-v1', seq, base, width: 640, height: 480, pixelWidth: 2, pixelHeight: 2, tiles: 1, tabId: 'test', ...changes });

(async () => {
  const { createBrowserTileDecoder, validateBrowserTileMetadata, browserTilesSupported } = load('client/browser-tiles.js');
  const pixels = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 90, 100, 110, 255]);
  const decoder = createBrowserTileDecoder();
  const first = await decoder.decode(payload([{ index: 0, pixels }]), metadata(1)); decoder.commit(first);
  assert.deepEqual(first.pixels, pixels);
  const delta = new Uint8Array(16); delta[12] = 90 ^ 42;
  const second = await decoder.decode(payload([{ index: 0, mode: 1, pixels: delta }]), metadata(2, 1)); decoder.commit(second);
  assert.equal(second.pixels[12], 42); assert.equal(first.pixels[12], 90, 'previous displayed/reference buffers are immutable');
  const retained = await decoder.decode(payload([]), metadata(3, 2, { tiles: 0 })); decoder.commit(retained);
  assert.deepEqual(retained.pixels, second.pixels, 'zero-tile update can restore canonical surface after a PNG fallback');
  // Partial edge tiles copy into the correct rows, and the keyframe must cover all tiles.
  const edgeDecoder = createBrowserTileDecoder(), left = new Uint8Array(64 * 2 * 4).fill(17), right = new Uint8Array(2 * 4).fill(99);
  const edge = await edgeDecoder.decode(payload([{ index: 1, pixels: right }, { index: 0, pixels: left }]), metadata(1, 0, { pixelWidth: 65, pixelHeight: 2, tiles: 2 }));
  assert.equal(edge.pixels[64 * 4], 99); assert.equal(edge.pixels[65 * 4], 17); edgeDecoder.commit(edge);
  // The shared inflater's larger tile bound is exercised independently of the
  // terminal's existing 8 KiB vectors, including incompressible stored blocks.
  for (const source of [new Uint8Array(65536).fill(37), Uint8Array.from({ length: 65536 }, (_, index) => (Math.imul(index, 1009) ^ (index >>> 3)) & 255)]) {
    for (const level of [0, 1, 6, 9]) {
      const large = await createBrowserTileDecoder().decode(payload([{ index: 0, compressed: deflateRawSync(source, { level }) }], 128), metadata(1, 0, { pixelWidth: 128, pixelHeight: 128 }));
      assert.deepEqual(large.pixels, source);
    }
  }
  // A long keyframe yields before commit, allowing a tab/connection reset to
  // cancel it without exposing a partial surface.
  const nativeChannel = global.MessageChannel, tasks = [];
  global.MessageChannel = class {
    constructor() {
      this.port1 = { close() {}, onmessage: null };
      this.port2 = { close() {}, postMessage: () => tasks.push(() => this.port1.onmessage()) };
    }
  };
  try {
    const batchDecoder = createBrowserTileDecoder();
    const records = Array.from({ length: 17 }, (_, index) => ({ index, pixels: new Uint8Array(64 * 4).fill(index) }));
    const batched = batchDecoder.decode(payload(records), metadata(1, 0, { pixelWidth: 17 * 64, pixelHeight: 1, tiles: 17 }));
    await Promise.resolve(); assert.equal(tasks.length, 1);
    batchDecoder.reset(); tasks.shift()(); await assert.rejects(batched);
  } finally { global.MessageChannel = nativeChannel; }
  const bad = async (bytes, meta = metadata(4, 3)) => assert.rejects(decoder.decode(bytes, meta));
  await bad(payload([{ index: 0, pixels }]), metadata(4, 999));
  await bad(payload([{ index: 0, pixels }]), metadata(4, 3, { tabId: 'other' }));
  await bad(payload([{ index: 0, pixels }]), metadata(4, 3, { pixelWidth: 3 }));
  await bad(payload([{ index: 0, mode: 1, pixels }]), metadata(4));
  await bad(payload([{ index: 1, pixels }]));
  await bad(payload([{ index: 0, mode: 2, pixels }]));
  await bad(payload([{ index: 0, pixels }, { index: 0, pixels }]), metadata(4, 3, { tiles: 2, pixelWidth: 65 }));
  await bad(payload([{ index: 0, pixels }], 32));
  await bad(payload([{ index: 0, pixels: new Uint8Array(15) }]));
  await bad(payload([{ index: 0, pixels: new Uint8Array(1024 * 1024) }]));
  await bad(payload([{ index: 0, compressed: Uint8Array.of(1, 2, 3) }]));
  await bad(payload([{ index: 0, compressed: Buffer.concat([deflateRawSync(pixels), Buffer.from([0])]) }]));
  await bad(Buffer.concat([payload([{ index: 0, pixels }]), Buffer.from([0])]));
  await bad(payload([{ index: 0, pixels }]).subarray(0, 15));
  await bad(payload([]), metadata(4, 0, { tiles: 0 }));
  for (const fields of [{ pixelWidth: 8192, pixelHeight: 8192 }, { seq: 0 }, { seq: 2 ** 32 }, { base: 4 }, { tiles: 1025 }, { pixelWidth: NaN }, { width: 0 }]) assert.throws(() => validateBrowserTileMetadata(metadata(4, 3, fields)));
  const pending = decoder.decode(payload([{ index: 0, pixels }]), metadata(4, 3)); decoder.reset(); await assert.rejects(pending);
  assert.throws(() => decoder.commit(retained), /Invalid/);
  await bad(payload([{ index: 0, pixels }]), metadata(5, 3));
  const recovered = await decoder.decode(payload([{ index: 0, pixels }]), metadata(6)); decoder.commit(recovered);
  assert.equal(browserTilesSupported(), false, 'Node without canvas cannot offer rendering support');
  console.log('Lossless tile reconstruction, XOR, edge geometry, independent references, strict inflation bounds, malformed updates and reset recovery passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
