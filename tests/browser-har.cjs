const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');

const source = path.resolve(__dirname, '../client/browser-panel.js');
const bundle = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = new Module(source, module); loaded.filename = source; loaded.paths = Module._nodeModulePaths(path.dirname(source));
loaded._compile(bundle.outputFiles[0].text, source);
const { buildHarLog } = loaded.exports;
const log = buildHarLog({ network: [
  { method: 'GET', status: 200, url: 'https://example.test/page?token=secret&client_secret=hidden&q=rust#local', duration: 123, startedAt: 1700000000000, bytes: 456, requestHeaders: [['authorization', 'Bearer private'], ['cookie', 'sid=private'], ['accept', 'text/html']], responseHeaders: [['content-type', 'text/html'], ['set-cookie', 'sid=private']] },
  { method: 'GET', status: 204, url: 'https://tracker.example/pixel', duration: 0, bytes: 0, blocked: 'filter-list', requestHeaders: [], responseHeaders: [] },
  { method: 'WEBSOCKET', status: 'CONNECTING', websocketState: 'CLOSED', url: 'wss://example.test/socket', duration: 19, bytes: 5, requestHeaders: [['x-auth-token', 'private']], responseHeaders: [] },
] }, 1700000001000);
assert.equal(log.log.version, '1.2');
assert.equal(log.log.entries.length, 3);
const [page, blocked, socket] = log.log.entries;
assert.equal(page.startedDateTime, new Date(1700000000000).toISOString());
assert.equal(page.request.url.includes('#'), false, 'HAR must omit the browser-only fragment');
assert.equal(new URL(page.request.url).searchParams.get('token'), '[redacted]', 'HAR URL retained a token query value');
assert.equal(new URL(page.request.url).searchParams.get('client_secret'), '[redacted]');
assert.equal(page.request.queryString.find(item => item.name === 'client_secret').value, '[redacted]');
assert.deepEqual(page.request.headers.map(item => item.value), ['[redacted]', '[redacted]', 'text/html']);
assert.equal(page.response.headers.find(item => item.name === 'set-cookie').value, '[redacted]');
assert.equal(page.response.content.size, 456);
assert.equal(page.timings.wait, 123);
assert.match(blocked.comment, /filter-list/);
assert.equal(socket.response.status, 0);
assert.equal(socket.request.headers[0].value, '[redacted]');
assert.equal(JSON.stringify(log).includes('private'), false, 'HAR export leaked a credential value');
console.log('Browser HAR structure and credential redaction passed.');
