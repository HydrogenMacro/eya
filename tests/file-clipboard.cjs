const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');
const source = path.resolve('client/file-selection.js');
const bundle = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = new Module(source, module); loaded.filename = source; loaded.paths = Module._nodeModulePaths(path.dirname(source)); loaded._compile(bundle.outputFiles[0].text, source);
const { createFileClipboard } = loaded.exports;

(async () => {
  const writes = [], sourceBytes = new Uint8Array([0, 255, 12]);
  let identity = {}, failRead = false, switchOnRead = false, allowReplace = false, collision = true;
  const clipboard = createFileClipboard({
    identity: () => identity,
    read: async () => { if (failRead) throw Error('Read denied'); if (switchOnRead) identity = {}; return { bytes: sourceBytes }; },
    request: async (op, values) => { assert.equal(op, 'stat'); assert.equal(values.path, '/target/file.bin'); return { version: 'current-destination-version' }; },
    upload: async (destination, bytes, overwrite, version) => {
      assert.deepEqual(bytes, sourceBytes);
      if (!overwrite && collision) throw Error('File already exists');
      writes.push({ destination, overwrite, version });
    },
  });
  const item = { path: '/source/file.bin', name: 'file.bin', kind: 'file' };
  assert.throws(() => clipboard.copy([{ ...item, kind: 'directory' }]), /regular files/);
  assert.throws(() => clipboard.copy(Array(1001).fill(item)), /1000/);
  clipboard.copy([item]);
  global.confirm = () => allowReplace;
  assert.equal(await clipboard.paste('/target', () => {}), 0, 'Canceled replacement writes nothing');
  assert.deepEqual(writes, []);
  allowReplace = true;
  assert.equal(await clipboard.paste('/target', () => {}), 1);
  assert.deepEqual(writes.pop(), { destination: '/target/file.bin', overwrite: true, version: 'current-destination-version' });
  failRead = true;
  await assert.rejects(clipboard.paste('/target', () => {}), /Read denied/); assert.deepEqual(writes, []);
  failRead = false; switchOnRead = true;
  await assert.rejects(clipboard.paste('/target', () => {}), /connection or pane changed/); assert.deepEqual(writes, []);
  assert.equal(clipboard.count, 0, 'Clipboard from another connection is unavailable');
  switchOnRead = false; collision = false; clipboard.copy([item]);
  await assert.rejects(clipboard.paste('/target', () => {}, () => false), /connection or pane changed/); assert.deepEqual(writes, []);
  clipboard.copy([{ ...item, name: '../escape.bin' }]);
  await assert.rejects(clipboard.paste('/target', () => {}), /Invalid file name/); assert.deepEqual(writes, []);
  clipboard.copy([item]);
  await clipboard.paste('/source', () => {});
  assert.deepEqual(writes.pop(), { destination: '/source/file copy.bin', overwrite: false, version: undefined });
  console.log('File clipboard: batch bounds, source/read failures, version-checked replacement, cancellation, connection isolation and safe duplicate names passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
