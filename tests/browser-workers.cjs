const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

async function main() {
  const source = path.resolve(__dirname, '../client/browser-panel.js');
  const bundle = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false });
  const loaded = new Module(source, module);
  loaded.filename = source;
  loaded.paths = Module._nodeModulePaths(path.dirname(source));
  loaded._compile(bundle.outputFiles[0].text, source);

  const runtime = loaded.exports.buildIframeRuntime('worker-runtime-test');
  const workerRuntime = loaded.exports.buildDedicatedWorkerRuntime();
  const moduleWorkerRuntime = loaded.exports.buildModuleWorkerRuntime();
  new Function(runtime);
  new Function(workerRuntime);
  new Function(moduleWorkerRuntime);
  assert.match(loaded.exports.browserFrameCsp(), /worker-src blob:/, 'the sandbox CSP does not allow only the local worker bootstrap');
  assert.match(loaded.exports.browserFrameCsp(), /connect-src 'none'/, 'worker support reopened direct network access');
  assert.match(workerRuntime, /class EyaWorkerXMLHttpRequest/, 'classic Workers do not install the proxied XHR shim');
  assert.match(moduleWorkerRuntime, /class EyaWorkerXMLHttpRequest/, 'module Workers do not install the proxied XHR shim');
  assert.match(workerRuntime, /Synchronous XHR is not supported/, 'Worker XHR must reject synchronous requests instead of blocking outside the relay');
  assert.match(runtime, /transferSource:true/, 'worker source does not use the proxy resource bridge');
  assert.match(runtime, /Worker scripts must be same-origin/, 'worker URLs are not checked against page origin');
  assert.match(runtime, /moduleMode=config\.type==='module'/, 'module Worker options are not routed to the module loader');
  assert.match(moduleWorkerRuntime, /await import\(urls\.get\(base\)\)/, 'module entry point is not loaded from its local blob graph');
  assert.match(runtime, /createModuleGraph/, 'page module scripts do not create a local blob dependency graph');
  assert.match(runtime, /proxyResourceSource\(url,true,true\)/, 'page module scripts do not fetch their static graph over the proxy');
  const parsedImports = loaded.exports.parseClassicWorkerImports(
    '/* importScripts("ignored.js") */ importScripts(/* first */ "./dep.js", /* second */ \'more.js\'); self.importScripts("./nested.js");',
    'https://docs.example/workers/main.js',
  );
  assert.equal(parsedImports.error, '');
  assert.deepEqual(parsedImports.calls.map(call => call.urls), [
    ['https://docs.example/workers/dep.js', 'https://docs.example/workers/more.js'],
    ['https://docs.example/workers/nested.js'],
  ]);
  assert.match(loaded.exports.parseClassicWorkerImports('importScripts(name)', 'https://docs.example/w.js').error, /static string/);
  assert.match(loaded.exports.parseClassicWorkerImports('importScripts("https://outside.example/x.js")', 'https://docs.example/w.js').error, /worker origin/);
  const moduleImports = loaded.exports.parseModuleWorkerImports(
    'import { value } from "./dep.js"; export { value as named } from \'./re-export.js\'; import \'./side-effect.js\';',
    'https://docs.example/modules/main.js',
  );
  assert.equal(moduleImports.error, '');
  assert.deepEqual(moduleImports.imports.map(edge => edge.url), [
    'https://docs.example/modules/dep.js',
    'https://docs.example/modules/re-export.js',
    'https://docs.example/modules/side-effect.js',
  ]);
  assert.match(loaded.exports.parseModuleWorkerImports('await import("./lazy.js")', 'https://docs.example/main.js').error, /Dynamic import/);
  assert.match(loaded.exports.parseModuleWorkerImports('console.log(import.meta.url)', 'https://docs.example/main.js').error, /import.meta/);
  assert.match(loaded.exports.parseModuleWorkerImports('import value from "bare-package"', 'https://docs.example/main.js').error, /Bare/);
  assert.match(loaded.exports.parseModuleWorkerImports('import value from "./data.json" with {type:"json"}', 'https://docs.example/main.js').error, /import attributes/);
  const moduleGraph = {
    'https://docs.example/main.js': { imports: [{ url: 'https://docs.example/dep.js' }] },
    'https://docs.example/dep.js': { imports: [{ url: 'https://docs.example/leaf.js' }] },
    'https://docs.example/leaf.js': { imports: [] },
  };
  assert.deepEqual(loaded.exports.orderWorkerModuleGraph(moduleGraph, 'https://docs.example/main.js'), [
    'https://docs.example/leaf.js', 'https://docs.example/dep.js', 'https://docs.example/main.js',
  ]);
  assert.throws(() => loaded.exports.orderWorkerModuleGraph({
    a: { imports: [{ url: 'b' }] }, b: { imports: [{ url: 'a' }] },
  }, 'a'), /Cyclic/);

  const listeners = [];
  const workerMessages = [];
  const imports = [];
  const self = {
    addEventListener(type, callback) { if (type === 'message') listeners.push(callback); },
    postMessage(message) { workerMessages.push(message); },
    importScripts(url) { imports.push(url); },
    dispatchEvent(event) { for (const callback of listeners) callback(event); return true; },
  };
  const context = {
    self,
    URL,
    Blob,
    Request,
    Response,
    Headers,
    AbortController,
    DOMException,
    Event: class TestEvent extends Event { stopImmediatePropagation() {} },
    EventTarget,
    MessageEvent: class MessageEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
    importScripts: url => imports.push(url),
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Map,
    Promise,
    String,
    Number,
    TypeError,
    Error,
  };
  vm.runInNewContext(workerRuntime, context);

  const sent = [];
  const bridge = { postMessage(message) { sent.push(message); }, start() {} };
  self.dispatchEvent({ type: 'message', data: { type: 'eya-init', base: 'https://docs.example/worker.js' }, ports: [bridge], stopImmediatePropagation() {} });
  self.dispatchEvent({ type: 'message', data: { type: 'eya-source', source: '/* worker source */', base: 'https://docs.example/worker.js', sources: { 'https://docs.example/dependency.js': '/* dependency */' } }, ports: [], stopImmediatePropagation() {} });
  assert.equal(imports.length, 1, 'proxied classic worker source was not imported');
  assert.equal(workerMessages.at(-1).type, 'eya-worker-ready');
  self.importScripts('https://docs.example/dependency.js');
  assert.equal(imports.length, 2, 'preloaded importScripts dependency was not loaded synchronously');
  assert.throws(() => self.importScripts('https://outside.example/blocked.js'), /not preloaded/);

  const responsePromise = self.fetch('/api/data');
  for (let attempt = 0; attempt < 10 && !sent.length; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent[0]?.type, 'fetch');
  assert.equal(sent[0]?.url, 'https://docs.example/api/data');
  bridge.onmessage({ data: { type: 'fetch-response', id: sent[0].id, status: 200, headers: [['content-type', 'text/plain']], body: new TextEncoder().encode('proxied').buffer } });
  assert.equal(await (await responsePromise).text(), 'proxied');

  const waitForRequest = async count => {
    for (let attempt = 0; attempt < 10 && sent.length < count; attempt++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, count, `expected worker request ${count}`);
    return sent[count - 1];
  };
  const emptyPromise = self.fetch('https://docs.example/empty');
  const emptyRequest = await waitForRequest(2);
  bridge.onmessage({ data: { type: 'fetch-response', id: emptyRequest.id, status: 204, headers: [], body: new ArrayBuffer(0) } });
  const emptyResponse = await emptyPromise;
  assert.equal(emptyResponse.status, 204);
  assert.equal(emptyResponse.body, null);

  const opaquePromise = self.fetch('https://outside.example/pixel', { mode: 'no-cors' });
  const opaqueRequest = await waitForRequest(3);
  bridge.onmessage({ data: { type: 'fetch-response', id: opaqueRequest.id, opaque: true, body: new ArrayBuffer(0) } });
  const opaqueResponse = await opaquePromise;
  assert.equal(opaqueResponse.type, 'opaque');
  assert.equal(opaqueResponse.status, 0);

  const controller = new AbortController();
  const aborted = self.fetch('https://docs.example/slow', { signal: controller.signal });
  await waitForRequest(4);
  controller.abort();
  await assert.rejects(aborted, error => error.name === 'AbortError');
  assert.equal(sent.at(-1)?.type, 'fetch-cancel', 'aborted worker fetch did not cancel its proxy request');

  const xhrStates = [];
  const xhrPromise = new Promise((resolve, reject) => {
    const xhr = new self.XMLHttpRequest();
    xhr.responseType = 'json';
    xhr.onreadystatechange = () => xhrStates.push(xhr.readyState);
    xhr.onload = () => resolve({ status: xhr.status, value: xhr.response, header: xhr.getResponseHeader('x-worker-check'), allHeaders: xhr.getAllResponseHeaders(), url: xhr.responseURL });
    xhr.onerror = () => reject(Error('Worker XHR failed'));
    xhr.open('POST', '/xhr-data');
    xhr.setRequestHeader('x-worker-request', 'passed');
    xhr.send('worker body');
  });
  const xhrRequest = await waitForRequest(6);
  assert.equal(xhrRequest.url, 'https://docs.example/xhr-data');
  assert.equal(xhrRequest.method, 'POST');
  assert.deepEqual(xhrRequest.body && [...new Uint8Array(xhrRequest.body)], [...new TextEncoder().encode('worker body')]);
  assert.equal(xhrRequest.headers.find(([name]) => name.toLowerCase() === 'x-worker-request')?.[1], 'passed');
  bridge.onmessage({ data: { type: 'fetch-response', id: xhrRequest.id, status: 201, statusText: 'Created', headers: [['content-type', 'application/json'], ['x-worker-check', 'passed']], url: 'https://docs.example/xhr-data', body: new TextEncoder().encode('{"ok":true}').buffer } });
  const xhrResult = await xhrPromise;
  assert.equal(xhrResult.status, 201);
  assert.equal(xhrResult.value.ok, true, 'Worker XHR JSON response was not decoded');
  assert.equal(xhrResult.header, 'passed', 'Worker XHR response headers were unavailable');
  assert.match(xhrResult.allHeaders, /content-type: application\/json/i);
  assert.equal(xhrResult.url, 'https://docs.example/xhr-data');
  assert.deepEqual(xhrStates, [1, 2, 3, 4], 'Worker XHR ready-state transitions were not delivered in order');

  const xhrAbort = new self.XMLHttpRequest();
  const xhrAbortPromise = new Promise(resolve => { xhrAbort.onabort = resolve; });
  xhrAbort.open('GET', '/slow-xhr'); xhrAbort.send();
  const xhrAbortRequest = await waitForRequest(7);
  xhrAbort.abort();
  await xhrAbortPromise;
  assert.equal(sent.at(-1)?.type, 'fetch-cancel', 'aborting Worker XHR did not cancel its proxied request');
  assert.equal(xhrAbortRequest.url, 'https://docs.example/slow-xhr');

  assert.throws(() => { const xhr = new self.XMLHttpRequest(); xhr.open('GET', '/sync', false); }, /Synchronous XHR/);
  console.log('Classic worker bootstrap, proxied fetch and XHR, response events, and cancellation checks passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
