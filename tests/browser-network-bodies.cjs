const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');

const source = path.resolve(__dirname, '../client/browser-panel.js');
const bundle = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = new Module(source, module); loaded.filename = source; loaded.paths = Module._nodeModulePaths(path.dirname(source));
loaded._compile(bundle.outputFiles[0].text, source);
const { appendNetworkCaptureChunk, finishNetworkCapture } = loaded.exports;

const splitUtf8 = { chunks: [], bytes: 0, truncated: false };
const encodedJson = new TextEncoder().encode('{"message":"héllo"}');
const splitAt = encodedJson.indexOf(0xc3) + 1;
let used = appendNetworkCaptureChunk(splitUtf8, encodedJson.subarray(0, splitAt), 0, 1024, 1024);
const finalChunk = encodedJson.subarray(splitAt);
used = appendNetworkCaptureChunk(splitUtf8, finalChunk, used, 1024, 1024);
finalChunk.fill(0);
const json = finishNetworkCapture(splitUtf8, 'application/json; charset=utf-8');
assert.equal(json.textLike, true);
assert.match(json.text, /"message": "héllo"/);
assert.equal(json.truncated, false);
assert.equal(json.bytes.byteLength, splitUtf8.bytes, 'capture assembly byte count changed');

const capped = { chunks: [], bytes: 0, truncated: false };
used = appendNetworkCaptureChunk(capped, new Uint8Array(8), 0, 5, 6);
assert.equal(used, 5, 'per-entry budget must cap capture bytes');
assert.equal(capped.bytes, 5);
assert.equal(capped.truncated, true, 'partial response capture must be marked truncated');
const cappedAgain = { chunks: [], bytes: 0, truncated: false };
used = appendNetworkCaptureChunk(cappedAgain, new Uint8Array(3), used, 5, 6);
assert.equal(used, 6, 'panel-wide budget must cap aggregate capture bytes');
assert.equal(cappedAgain.bytes, 1, 'remaining panel budget must be shared across response rows');
assert.equal(cappedAgain.truncated, true);

const binary = finishNetworkCapture({ chunks: [new Uint8Array([0, 255])], bytes: 2, truncated: false }, 'application/octet-stream');
assert.equal(binary.textLike, false, 'binary payloads must not be rendered as text');
assert.equal(binary.bytes[1], 255);
const noRoom = { chunks: [], bytes: 0, truncated: false };
used = appendNetworkCaptureChunk(noRoom, new Uint8Array(3), used, 5, 6);
assert.equal(used, 6);
assert.equal(noRoom.bytes, 0);
assert.equal(noRoom.truncated, true);
const longText = finishNetworkCapture({ chunks: [new TextEncoder().encode('a'.repeat(50))], bytes: 50, truncated: false }, 'text/plain', 12);
assert.match(longText.text, /preview truncated/);
assert.throws(() => appendNetworkCaptureChunk({ chunks: [], bytes: -1 }, new Uint8Array(), 0), /Invalid Network capture state/);

console.log('Browser Network body capture caps, UTF-8 assembly, JSON formatting, and binary handling passed.');
