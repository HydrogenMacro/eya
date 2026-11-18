const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { chromium } = require('playwright');

const source = path.resolve(__dirname, '../client/browser-proxy-apis.js');
const compiled = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = new Module(source, module);
loaded.filename = source;
loaded.paths = Module._nodeModulePaths(path.dirname(source));
loaded._compile(compiled.outputFiles[0].text, source);
const installer = loaded.exports.installProxyUnsupportedApis.toString();
new Function(`return (${installer});`);

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE,
    args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage();
    const parentSentinel = 'outer-page-private';
    await page.evaluate(({ installer, parentSentinel }) => {
      window.secret = parentSentinel;
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.srcdoc = `<script>window.reports=[];window.nativeCalls=0;window.nativeStorageError='';try{indexedDB}catch(e){window.nativeStorageError=e.message};
        const calls=()=>{nativeCalls++;return Promise.resolve('should-not-run')};
        Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:calls,writeText:calls}});
        Object.defineProperty(navigator,'credentials',{configurable:true,value:{get:calls,create:calls}});
        Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:calls,getDisplayMedia:calls,enumerateDevices:calls}});
        Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition(){nativeCalls++},watchPosition(){nativeCalls++},clearWatch(){nativeCalls++}}});
        Object.defineProperty(navigator,'share',{configurable:true,value:calls});Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});
        Object.defineProperty(navigator,'permissions',{configurable:true,value:{query(value){nativeCalls++;return Promise.reject(new TypeError('native '+value?.name))}}});
        Object.defineProperty(window,'caches',{configurable:true,get(){throw new DOMException('original sandbox error','SecurityError')}});
        window.showOpenFilePicker=calls;
        window.absentApiBefore=typeof window.showSaveFilePicker;
        (${installer})((api,message)=>reports.push({api,message}));
        window.installReady=true;<\/script><button id="target">Target</button>`;
      document.body.append(frame);
    }, { installer, parentSentinel });
    const frame = page.frames().find(candidate => candidate !== page.mainFrame());
    await frame.waitForFunction(() => window.installReady);
    const results = await frame.evaluate(async () => {
      const denied = async action => { try { await action(); return 'resolved'; } catch (error) { return { name: error.name, message: error.message }; } };
      const sync = action => { try { action(); return 'returned'; } catch (error) { return { name: error.name, message: error.message }; } };
      const values = {
        clipboard: await denied(() => navigator.clipboard.readText()),
        clipboardAgain: await denied(() => navigator.clipboard.readText()),
        credentials: await denied(() => navigator.credentials.get({ publicKey: {} })),
        camera: await denied(() => navigator.mediaDevices.getUserMedia({ video: true })),
        devices: await denied(() => navigator.mediaDevices.enumerateDevices()),
        share: await denied(() => navigator.share({ text: 'hi' })),
        canShare: navigator.canShare({ text: 'hi' }),
        picker: await denied(() => showOpenFilePicker()),
        permission: await denied(() => navigator.permissions.query({ name: 'camera' })),
        unknownPermission: await denied(() => navigator.permissions.query({ name: 'unknown-permission' })),
        storage: sync(() => indexedDB),
        cacheStorage: sync(() => caches),
        parent: sync(() => parent.secret),
        print: sync(() => window.print()),
        dialog: sync(() => confirm('Is this allowed?')),
        fullscreen: await denied(() => document.getElementById('target').requestFullscreen()),
        absentUnchanged: typeof showSaveFilePicker === absentApiBefore,
      };
      values.geo = await new Promise(resolve => {
        values.watchId = navigator.geolocation.watchPosition(() => resolve({ unexpectedSuccess: true }), error => resolve({ code: error.code, message: error.message }));
      });
      navigator.geolocation.clearWatch(values.watchId);
      if (typeof Notification === 'function') values.notification = { permission: Notification.permission, request: await Notification.requestPermission(), create: sync(() => new Notification('No')) };
      if (typeof SharedWorker === 'function') values.sharedWorker = sync(() => new SharedWorker('https://example.test/worker.js'));
      values.nativeCalls = nativeCalls;
      values.nativeStorageError = nativeStorageError;
      values.reports = reports;
      return values;
    });
    for (const key of ['clipboard', 'clipboardAgain', 'credentials', 'camera', 'devices', 'share', 'picker', 'permission', 'print', 'dialog', 'fullscreen']) {
      assert.equal(results[key].name, 'NotSupportedError', key);
      assert.match(results[key].message, /Open in Browser\./, key);
    }
    assert.equal(results.unknownPermission.name, 'TypeError', 'Unknown descriptor validation remains native');
    assert.equal(results.canShare, false);
    assert.equal(results.storage.name, 'SecurityError');
    if (results.nativeStorageError) assert.equal(results.storage.message, results.nativeStorageError, 'Keep native opaque-origin error details');
    assert.equal(results.cacheStorage.name, 'SecurityError');
    assert.equal(results.cacheStorage.message, 'original sandbox error', 'Do not mask an existing native sandbox rejection');
    assert.equal(results.parent.name, 'SecurityError', 'Scripts cannot access the client document');
    assert.equal(results.geo.code, 1);
    assert.equal(results.watchId, 0);
    assert.equal(results.absentUnchanged, true, 'Do not invent unavailable browser features');
    assert.equal(results.nativeCalls, 1, 'Only unknown permission validation may call a native mock');
    if (results.notification) {
      assert.equal(results.notification.permission, 'denied');
      assert.equal(results.notification.request, 'denied');
      assert.equal(results.notification.create.name, 'NotSupportedError');
    }
    if (results.sharedWorker) assert.equal(results.sharedWorker.name, 'NotSupportedError');
    assert.equal(results.reports.filter(row => row.api === 'Clipboard.readText').length, 1, 'Repeated calls do not flood diagnostics');
    assert.ok(results.reports.every(row => row.message.length < 160));
    assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
    console.log('Proxy unsupported API errors, denial callbacks, diagnostics, native storage errors and opaque iframe isolation passed.');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
