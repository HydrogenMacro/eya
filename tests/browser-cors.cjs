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
const { corsOriginAllowed, corsPreflightAllowed, corsVisibleHeaders, corsMaxAge, corsSafelistedHeader } = loaded.exports;

const origin = 'https://app.example';
assert.equal(corsOriginAllowed({ 'access-control-allow-origin': origin }, origin), true);
assert.equal(corsOriginAllowed({ 'access-control-allow-origin': '*' }, origin), true, 'wildcard origins work without credentials');
assert.equal(corsOriginAllowed({ 'access-control-allow-origin': '*' }, origin, 'include'), false, 'credentialed CORS rejects wildcard origins');
assert.equal(corsOriginAllowed({ 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' }, origin, 'include'), true);

const preflight = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'POST, PUT', 'access-control-allow-headers': 'authorization, x-api-key' };
assert.equal(corsPreflightAllowed(preflight, origin, 'PUT', ['authorization', 'x-api-key'], 'include'), true);
assert.equal(corsPreflightAllowed({ ...preflight, 'access-control-allow-headers': '*' }, origin, 'PUT', ['x-api-key'], 'include'), false, 'credentialed CORS does not treat wildcard headers as permission');
assert.equal(corsPreflightAllowed({ ...preflight, 'access-control-allow-methods': 'POST' }, origin, 'PUT', ['x-api-key'], 'include'), false);
assert.equal(corsPreflightAllowed({ ...preflight, 'access-control-allow-origin': '*' }, origin, 'PUT', ['x-api-key'], 'include'), false);
assert.deepEqual(corsVisibleHeaders({ 'content-type': 'application/json', 'x-secret': 'hidden', 'x-public': 'shown', 'access-control-expose-headers': 'x-public' }), [['content-type', 'application/json'], ['x-public', 'shown']]);
assert.equal(corsMaxAge({ 'access-control-max-age': '3600' }, 1000), 601000);
assert.equal(corsMaxAge({ 'access-control-max-age': '9000' }, 1000), 601000, 'preflight cache age is capped at ten minutes');
assert.equal(corsMaxAge({ 'access-control-max-age': 'invalid' }, 1000), 1000);
assert.equal(corsSafelistedHeader('accept', 'text/html'), true);
assert.equal(corsSafelistedHeader('accept', 'text/html\nX-Evil: yes'), false, 'control bytes require CORS preflight');
assert.equal(corsSafelistedHeader('accept', 'text/html[private]'), false, 'CORS-unsafe punctuation requires preflight');
assert.equal(corsSafelistedHeader('accept-language', 'en-US,fr;q=0.8'), true);
assert.equal(corsSafelistedHeader('accept-language', 'en-US<script>'), false);
assert.equal(corsSafelistedHeader('content-type', 'application/json'), false);
console.log('Browser CORS rules passed.');
