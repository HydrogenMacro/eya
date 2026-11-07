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
const { sanitizeBrowserBookmarkImport, createBrowserBookmarkExport } = loaded.exports;

const input = {
  format: 'eya-browser-bookmarks', version: 1,
  bookmarks: [
    { url: 'https://example.test/path', title: 'Example', at: 123 },
    { url: 'https://example.test/path#fragment', title: 'Duplicate canonical URL' },
    { url: 'javascript:alert(1)', title: 'Unsafe' },
    { url: 'https://user:pass@example.test/', title: 'Credentials' },
    { url: 'file:///etc/passwd', title: 'Local file' },
    { url: 'not a URL' },
  ],
};
const imported = sanitizeBrowserBookmarkImport(JSON.stringify(input));
assert.deepEqual(imported, [
  { url: 'https://example.test/path', title: 'Example', at: 123 },
  { url: 'https://example.test/path#fragment', title: 'Duplicate canonical URL', at: imported[1].at },
]);
assert.equal(sanitizeBrowserBookmarkImport({ ...input, bookmarks: input.bookmarks }, 1).length, 1, 'import honors the bookmark cap');
assert.throws(() => sanitizeBrowserBookmarkImport('{'), /valid JSON/);
assert.throws(() => sanitizeBrowserBookmarkImport({ ...input, version: 2 }), /not supported/);
assert.throws(() => sanitizeBrowserBookmarkImport(' '.repeat(1024 * 1024 + 1)), /1 MiB/);
assert.throws(() => sanitizeBrowserBookmarkImport(input, 201), RangeError);

const exported = createBrowserBookmarkExport(imported, 456);
assert.equal(exported.format, 'eya-browser-bookmarks');
assert.equal(exported.version, 1);
assert.equal(exported.exportedAt, 456);
assert.deepEqual(sanitizeBrowserBookmarkImport(exported), imported);
assert.throws(() => createBrowserBookmarkExport({}), TypeError);

console.log('Browser bookmark import/export validation passed.');
