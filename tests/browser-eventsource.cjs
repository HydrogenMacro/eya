const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');

const source = path.resolve(__dirname, '../client/browser-eventsource.js');
const bundle = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = new Module(source, module);
loaded.filename = source;
loaded.paths = Module._nodeModulePaths(path.dirname(source));
loaded._compile(bundle.outputFiles[0].text, source);

const { parseEventSourceBlock } = loaded.exports;
const state = { lastEventId: '', _retry: 3000 };

assert.deepEqual(
  parseEventSourceBlock(': heartbeat\nid: alpha\nevent: update\ndata: first\ndata:second', state),
  { type: 'update', data: 'first\nsecond', lastEventId: 'alpha' },
  'comments, IDs, event names, and multiline data should parse',
);
assert.equal(parseEventSourceBlock('id: beta\nretry: 12', state), null, 'an ID-only block updates state without dispatching a message');
assert.equal(state.lastEventId, 'beta');
assert.equal(state._retry, 250, 'retry values are clamped to a short minimum');
assert.deepEqual(
  parseEventSourceBlock('id: invalid\u0000id\nretry: nope\nevent:\ndata:', state),
  { type: 'message', data: '', lastEventId: 'beta' },
  'NUL IDs are ignored and an empty event name defaults to message',
);
assert.equal(state._retry, 250, 'invalid retry values do not change reconnect delay');
assert.equal(parseEventSourceBlock('retry: 999999', state), null);
assert.equal(state._retry, 30000, 'retry delay is capped');

console.log('Browser EventSource parser rules passed.');
