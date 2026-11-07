const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');

const source = path.resolve(__dirname, '../client/browser-panel.js');
const bundle = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = new Module(source, module);
loaded.filename = source;
loaded.paths = Module._nodeModulePaths(path.dirname(source));
loaded._compile(bundle.outputFiles[0].text, source);

const { buildIframeRuntime, sanitizeStorageItems } = loaded.exports;
const items = sanitizeStorageItems([
  ['a', 'one'],
  ['a', 'two'],
  ['unicode', '🌊'],
  ['__proto__', 'storage-key'],
  ['bad', 7],
], 64);
assert.deepEqual(items, [['a', 'two'], ['unicode', '🌊'], ['__proto__', 'storage-key']], 'storage sanitizer should keep bounded string entries and the latest duplicate key safely');
assert.deepEqual(sanitizeStorageItems([['first', '1234'], ['second', '5678']], 9), [['first', '1234']], 'storage sanitizer exceeded its UTF-8 byte budget');
assert.deepEqual(sanitizeStorageItems('not an array'), [], 'storage sanitizer accepted an invalid snapshot');

const runtime = buildIframeRuntime('storage-test', '', { local: { persisted: 'value</script><script>bad' }, session: { tab: 'only' }, localQuota: 64 });
assert.doesNotMatch(runtime, /value<\/script>/i, 'storage snapshot can terminate the injected bootstrap script');
assert.match(runtime, /QuotaExceededError/, 'storage shim does not report quota exhaustion');
assert.match(runtime, /storage-sync/, 'storage shim does not accept cross-tab localStorage updates');
new Function(runtime);
console.log('Browser storage snapshot and quota checks passed');
