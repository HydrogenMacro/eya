// Exercises real Chromium API events over the real Noise browser transport.
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');
const { fixture, KEY } = require('./continuity-fixture.cjs');
(async () => {
  const f = await fixture({ env: { EYA_BROWSER_CHROMIUM: process.env.EYA_BROWSER_EXECUTABLE || chromium.executablePath() } });
  let transport;
  try {
    const source = path.resolve('client/browser-transport.js');
    const bundle = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, alias: { 'sodium-native': path.resolve('client/node_modules/sodium-javascript/index.js') } });
    const loaded = new Module(source, module); loaded.filename = source; loaded.paths = Module._nodeModulePaths(path.dirname(source)); loaded._compile(bundle.outputFiles[0].text, source);
    const events = [], downloads = [];
    transport = await loaded.exports.createBrowserRenderTransport({ url: f.url, key: KEY, onEvent: (value, channel) => { if (channel === 'status') events.push(value); }, onFrame: (_, meta) => transport?.ack(meta.seq), onDownload: (bytes, meta) => downloads.push({ bytes, meta }) });
    async function until(find) {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) { const result = find(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 20)); }
      throw Error('Expected native event did not arrive: ' + JSON.stringify(events.slice(-8)));
    }
    await transport.start(); await transport.activateTab('native-tab');
    assert.equal((await transport.evaluate('native-tab', 'globalThis.__eyaNativeInstalled')).result, true);
    await transport.evaluate('native-tab', "globalThis.__eyaNativeResolve=(id,value,error)=>{globalThis.__nativeDenied=error};__eyaNativeRequest(JSON.stringify({id:900,kind:'clipboard-read',data:{}}));true");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((await transport.evaluate('native-tab', 'globalThis.__nativeDenied')).result === 'NotAllowedError') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await transport.evaluate('native-tab', 'globalThis.__nativeDenied')).result, 'NotAllowedError', 'Opaque/background pages must not request client capabilities');
    assert.equal(events.some(e => e.type === 'native-action'), false);
    for (const [type, expression, accept, text, expected] of [
      ['alert', "alert('hello');'done'", true, '', 'done'],
      ['confirm', "confirm('continue?')", false, '', false],
      ['prompt', "prompt('name?','default')", true, 'answer', 'answer'],
    ]) {
      const pending = transport.evaluate('native-tab', expression);
      const event = await until(() => events.find(e => e.type === 'javascript-dialog' && e.dialogType === type));
      transport.respondToJavaScriptDialog('native-tab', event.id, accept, text);
      assert.equal((await pending).result, expected);
    }
    await transport.evaluate('native-tab', "document.body.innerHTML='<h1>PDF fixture</h1><input type=file accept=\".txt\" multiple>';window.print();true");
    await until(() => events.find(e => e.type === 'print-request'));
    assert.equal(downloads.length, 0, 'Page print request requires client confirmation');
    transport.printPage('native-tab');
    await until(() => downloads[0]);
    assert.equal(Buffer.from(downloads[0].bytes).subarray(0, 5).toString(), '%PDF-');
    assert.equal(downloads[0].meta.filename, 'page.pdf');
    const { result: serializedPoint } = await transport.evaluate('native-tab', "(()=>{const r=document.querySelector('input').getBoundingClientRect();return JSON.stringify({x:r.x+10,y:r.y+10})})()");
    const point = JSON.parse(serializedPoint);
    transport.input({ type: 'mouse', action: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 }, 'native-tab');
    transport.input({ type: 'mouse', action: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 }, 'native-tab');
    const chooser = await until(() => events.find(e => e.type === 'file-chooser'));
    assert.equal(chooser.multiple, true); assert.equal(chooser.accept, '.txt');
    transport.cancelPageFileChooser('native-tab', chooser.id);
    console.log('Live native browser APIs: native bridge installation and background denial, alert/confirm/prompt, explicit print confirmation, streamed PDF and file accept metadata passed.');
  } finally { transport?.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
