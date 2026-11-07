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
const { safeDownloadFilename } = loaded.exports;

assert.equal(safeDownloadFilename("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf", 'https://example.test/a'), 'résumé.pdf');
assert.equal(safeDownloadFilename('attachment; filename="report.zip"', 'https://example.test/a'), 'report.zip');
assert.equal(safeDownloadFilename('', 'https://example.test/path%20name.tar.gz'), 'path name.tar.gz');
assert.equal(safeDownloadFilename('', 'https://example.test/a/b', '../../private.txt'), 'private.txt');
assert.equal(safeDownloadFilename('', 'https://example.test/a', 'bad\u0000:name?.txt'), 'bad__name_.txt');
assert.equal(safeDownloadFilename('', 'https://example.test/a', 'x'.repeat(200)).length, 180);
assert.equal(safeDownloadFilename('', 'https://example.test/a', '...'), 'download');
console.log('browser download filename tests passed');
