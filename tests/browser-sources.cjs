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

const { boundDevtoolsSource, findSourceMatchRanges } = loaded.exports;
assert.deepEqual(boundDevtoolsSource('abc😀', 4), { text: 'abc', bytes: 3, truncated: true },
  'source truncation respects UTF-8 byte boundaries');
assert.deepEqual(boundDevtoolsSource('abc', 3), { text: 'abc', bytes: 3, truncated: false });
assert.deepEqual(boundDevtoolsSource('abc', 0), { text: '', bytes: 0, truncated: true });
assert.throws(() => boundDevtoolsSource('text', -1), /byte limit/);
assert.deepEqual(findSourceMatchRanges('Alpha alpha aLpHa', 'ALPHA').matches, [
  { from: 0, to: 5 }, { from: 6, to: 11 }, { from: 12, to: 17 },
], 'source search is case insensitive and reports UTF-16 ranges');
assert.deepEqual(findSourceMatchRanges('const a+b = 1;', 'a+b').matches, [
  { from: 6, to: 9 },
], 'source search treats query text literally');
assert.deepEqual(findSourceMatchRanges('a😀A', 'a').matches, [
  { from: 0, to: 1 }, { from: 3, to: 4 },
], 'source search offsets account for UTF-16 surrogate pairs');
assert.deepEqual(findSourceMatchRanges('aaaa', 'a', 2), {
  matches: [{ from: 0, to: 1 }, { from: 1, to: 2 }], truncated: true,
}, 'source search bounds high frequency matches');
assert.deepEqual(findSourceMatchRanges('abc', 'b'.repeat(257)), { matches: [], truncated: false },
  'oversized source search terms are ignored');
assert.throws(() => findSourceMatchRanges('abc', 'a', 0), /match limit/);
console.log('Browser DevTools source bounds and text search passed.');
