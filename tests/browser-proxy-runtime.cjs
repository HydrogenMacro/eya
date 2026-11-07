const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');

async function main() {
  const source = path.resolve(__dirname, '../client/browser-panel.js');
  const bundle = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false });
  const loaded = new Module(source, module);
  loaded.filename = source;
  loaded.paths = Module._nodeModulePaths(path.dirname(source));
  loaded._compile(bundle.outputFiles[0].text, source);
  const runtime = loaded.exports.buildIframeRuntime('browser-runtime-test', '', {
    local: { persisted: 'read-before-page-script' }, session: { tab: 'session-before-page-script' }, localQuota: 128, sessionQuota: 128,
  }, 'https://example.test/base/');
  const userscripts = loaded.exports.serializeUserscriptElements([{ id: 'runtime-request-script', grants: ['GM_xmlhttpRequest'], runAt: 'document-end', source: `GM_xmlhttpRequest({ url: 'https://api.example.test/gm-data', timeout: 5000, onload: result => parent.postMessage({ type: 'test-gm-request', status: result.status, text: result.responseText, headers: result.responseHeaders }, '*'), onerror: error => parent.postMessage({ type: 'test-gm-request', error: error.error }, '*') });` }, { id: 'runtime-resource-script', grants: ['GM_getResourceURL'], resources: { pixel: { text: '', url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==' } }, source: `const img=new Image();img.onload=()=>{window.__eyaResourceLoaded=true};img.onerror=()=>{window.__eyaResourceLoaded=false};img.src=GM_getResourceURL('pixel');` }]);
  const frameCsp = loaded.exports.browserFrameCsp();
  assert.match(frameCsp, /form-action 'none'/, 'Proxy iframe CSP must disable native form submissions');
  assert.doesNotMatch(frameCsp, /navigate-to/, 'Proxy iframe must not rely on the unsupported navigate-to directive');
  const moduleWorkerUrl = 'https://example.test/base/module-worker.js';
  const moduleDependencyUrl = 'https://example.test/base/module-dependency.js';
  const pageModuleUrl = 'https://example.test/base/page-module.js';
  const pageModuleDependencyUrl = 'https://example.test/base/page-module-dependency.js';
  const moduleWorkerSource = `import { prefix } from './module-dependency.js'; self.onmessage = async event => { const response = await fetch('/worker-data'); const text = await response.text(); const xhr = new XMLHttpRequest(); xhr.open('GET', '/worker-xhr-data'); xhr.onload = () => self.postMessage(prefix + event.data + ':' + text + ':' + xhr.status + ':' + xhr.responseText + ':' + xhr.getResponseHeader('x-bridge-check')); xhr.send(); };`;
  const moduleDependencySource = `export const prefix = 'module:';`;
  const moduleImports = loaded.exports.parseModuleWorkerImports(moduleWorkerSource, moduleWorkerUrl).imports;
  const moduleWorkerGraph = {
    source: moduleWorkerSource,
    url: moduleWorkerUrl,
    order: [moduleDependencyUrl, moduleWorkerUrl],
    modules: {
      [moduleWorkerUrl]: { source: moduleWorkerSource, imports: moduleImports },
      [moduleDependencyUrl]: { source: moduleDependencySource, imports: [] },
    },
  };
  const pageModuleSource = `import { prefix } from './page-module-dependency.js'; parent.postMessage({ type: 'test-page-module', value: prefix + 'ok' }, '*');`;
  const pageModuleGraph = {
    source: pageModuleSource,
    url: pageModuleUrl,
    order: [pageModuleDependencyUrl, pageModuleUrl],
    modules: {
      [pageModuleUrl]: { source: pageModuleSource, imports: loaded.exports.parseModuleWorkerImports(pageModuleSource, pageModuleUrl).imports },
      [pageModuleDependencyUrl]: { source: "export const prefix = 'page-module:';", imports: [] },
    },
  };
  new Function(runtime);
  const { scanHtmlTagTokens, parsedTagAttributes, sanitizeHtmlFragment, sanitizeHtmlFragmentContent, neutralizeDirectResources, rewriteLocationNavigations } = loaded.exports;
  const scriptNavigationSource = rewriteLocationNavigations("location.href = 'https://example.test/base/script-navigation';");
  assert.match(scriptNavigationSource, /window\.__eyaNavigate/, 'direct Location href assignments in page scripts must be rewritten through the bridge');
  const shadowedWindow = "function f(window) { location.href = '/x'; }";
  assert.equal(rewriteLocationNavigations(shadowedWindow), shadowedWindow, 'a shadowed window must not receive generated bridge calls');
  const calls = [];
  const bridgeWindow = { __eyaNavigate: (...args) => { calls.push(args); return 'absolute-url'; } };
  const execute = source => new Function('window', rewriteLocationNavigations(source))(bridgeWindow);
  assert.equal(execute("return (location.href = '/relative');"), '/relative', 'assignment expressions must retain their original value');
  assert.equal(execute("let count = 0; const result = location.assign('/next', ++count); return [count, result];")[0], 1, 'navigation arguments must all be evaluated');
  assert.deepEqual(calls, [['/relative', 'push'], ['/next', 'push']]);
  calls.length = 0;
  assert.equal(execute("return (location.href = (location.assign('/inner'), '/outer'));"), '/outer');
  execute("location.assign(location.replace('/nested')); location.reload();");
  assert.deepEqual(calls, [['/inner', 'push'], ['/outer', 'push'], ['/nested', 'replace'], [undefined, 'push'], [undefined, 'reload']], 'nested navigations must retain execution order');
  assert.throws(() => execute('location.assign();'), TypeError, 'assign without an argument must throw');
  const browserBundle = buildSync({ entryPoints: [source], bundle: true, platform: 'browser', format: 'iife', globalName: 'eyaBrowserTest', write: false }).outputFiles[0].text;
  const rewriteHtml = 'eyaBrowserTest.neutralizeDirectResources';

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.EYA_BROWSER_EXECUTABLE,
    args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [],
  });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.addScriptTag({ content: browserBundle });
    assert.match(await page.evaluate(() => eyaBrowserTest.sanitizeHtmlFragment('<script>location.href="/rewritten-inline"</script>')), /window\.__eyaNavigate/, 'inline scripts must be rewritten before srcdoc installation');
    const parseTimeRequests = [];
    const directUpstreamRequests = [];
    page.on('request', request => { if (/^https:\/\/example\.test\//.test(request.url())) directUpstreamRequests.push(request.url()); });
    await page.route('https://parse-leak.test/**', async route => { parseTimeRequests.push(route.request().url()); await route.abort(); });
    const directNavigationRequests = [];
    await page.route('https://example.test/base/script-navigation', async route => { directNavigationRequests.push(route.request().url()); await route.abort(); });
    const pageValue = name => page.evaluate(name => Promise.race([Promise.resolve(window[name]), new Promise((_, reject) => setTimeout(() => reject(Error(`Timed out waiting for ${name}`)), 8000))]), name);
    const rewrittenMarkup = await page.evaluate(({ source }) => {
      const rewrite = (0, eval)(source);
      return rewrite('<!doctype html><meta http-equiv="refresh" content="0;url=https://bad.test"><base href="https://bad.test/"><img src=https://img.test/a.png srcset="https://img.test/a.png 1x, https://img.test/b.png 2x"><link rel="preload" as="image" imagesrcset="https://img.test/a.png 1x"><link rel="canonical" href="https://good.test/canonical"><link rel="preconnect" href="https://bad.test"><a href="https://good.test/">link</a><svg><use href="#symbol"></use></svg><iframe src="https://bad.test/"></iframe><div style="background-image:url(https://img.test/bg.png)"></div>');
    }, { source: rewriteHtml });
    assert.match(rewrittenMarkup, /data-eya-src="https:\/\/img\.test\/a\.png"/, 'HTML parser did not neutralize an unquoted resource URL');
    assert.match(rewrittenMarkup, /data-eya-srcset=/, 'HTML parser did not neutralize srcset candidates');
    assert.match(rewrittenMarkup, /data-eya-imagesrcset=/, 'HTML parser did not neutralize preload imagesrcset');
    assert.match(rewrittenMarkup, /<a href="https:\/\/good\.test\/">link<\/a>/, 'HTML parser changed ordinary links before click interception');
    assert.match(rewrittenMarkup, /<link rel="canonical" href="https:\/\/good\.test\/canonical">/, 'metadata link URLs must not become proxy fetches');
    assert.doesNotMatch(rewrittenMarkup, /rel="preconnect"/, 'network hints must not open direct upstream connections');
    assert.match(rewrittenMarkup, /<use href="#symbol"><\/use>/, 'same-document SVG references must remain local');
    assert.doesNotMatch(rewrittenMarkup, /<iframe|http-equiv="refresh"|<base\b/, 'HTML parser left an unproxied navigation surface');
    const parseSafety = await page.evaluate(({ source }) => {
      const rewrite = (0, eval)(source);
      return rewrite('<!doctype html><html><head><title>safe parse</title><link rel="stylesheet" href="https://parse-leak.test/style.css"></head><body><img src="https://parse-leak.test/image.png"><iframe src="https://parse-leak.test/frame"></iframe><video poster="https://parse-leak.test/poster.png"></video></body></html>');
    }, { source: rewriteHtml });
    assert.match(parseSafety, /<title>safe parse<\/title>/, 'template parser must preserve the document head');
    assert.match(parseSafety, /data-eya-src="https:\/\/parse-leak\.test\/image\.png"/, 'remote images must be deferred to the proxy loader');
    assert.match(parseSafety, /data-eya-src="https:\/\/parse-leak\.test\/poster\.png"/, 'media posters must be deferred to the proxy loader');
    await page.waitForTimeout(100);
    assert.deepEqual(parseTimeRequests, [], 'rewriting hostile HTML must not trigger direct requests while parsing');
    await page.evaluate(({ runtime, userscripts, frameCsp, moduleWorkerUrl, moduleWorkerGraph, pageModuleUrl, pageModuleGraph }) => {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      window.__legacyBridgeMessages = [];
      window.addEventListener('message', event => {
        if (event.source === frame.contentWindow && /^eya-(navigate|open-tab|download|cookie|console|network|dom|storage)$/.test(event.data?.type || '')) {
          window.__legacyBridgeMessages.push(event.data.type);
        }
      });
      window.__cancelObserved = false;
      const requestUrls = new Map();
      window.__beaconRequest = new Promise(resolve => { window.__resolveBeaconRequest = resolve; });
      window.__relativeFetchRequest = new Promise(resolve => { window.__resolveRelativeFetchRequest = resolve; });
      window.__beaconAccepted = new Promise(resolve => {
        window.addEventListener('message', event => {
          if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.type === 'test-beacon') resolve(event.data.accepted);
        });
      });
      window.__testResultPromise = new Promise((resolve, reject) => {
        setTimeout(() => reject(Error('Timed out waiting for the iframe XHR result')), 8000);
        window.addEventListener('message', event => {
          if (event.data?.type === 'test-result') resolve(event.data);
        });
      });
      window.__findOpenResult = new Promise(resolve => { window.__resolveFindOpen = resolve; });
      window.__gmRequestResult = new Promise(resolve => window.addEventListener('message', event => { if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.type === 'test-gm-request') resolve(event.data); }));
      window.__gmBridgeDeleted = new Promise(resolve => window.addEventListener('message', event => { if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.type === 'test-gm-bridge') resolve(event.data.deleted); }));
      window.__bridgeReady = new Promise(resolve => {
        window.addEventListener('message', event => {
          if (event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.type !== 'eya-ready') return;
          const channel = new MessageChannel();
          channel.port1.onmessage = ({ data }) => {
            if (data.type === 'storage') {
              (window.__storageUpdates ||= []).push(data);
              return;
            }
            if (data.type === 'find-open') { window.__resolveFindOpen(true); return; }
            if (data.type === 'find-result') { window.__resolveFindResult?.(data); return; }
            if (data.type === 'navigation-unhandled') { window.__resolveUnhandledNavigation(data); return; }
            if (data.type === 'history' || data.type === 'history-go') { (window.__historyMessages ||= []).push(data); return; }
            if (data.type === 'navigate' && data.url.endsWith('/submit')) { window.__resolveFormNavigation(data); return; }
            if (data.type === 'navigate' && data.url.endsWith('/submitter')) { window.__resolveSubmitterNavigation(data); return; }
            if (data.type === 'navigate' && data.url.endsWith('/linked')) { window.__resolveLinkNavigation(data); return; }
            if (data.type === 'navigate' && data.url.endsWith('/script-navigation')) { window.__resolveScriptNavigation(data); return; }
            if (data.type === 'open-tab') { window.__resolveNewTabRequest(data); return; }
            if (data.type === 'download') { window.__resolveDownloadRequest(data); return; }
            if (data.type === 'dom') {
              const find = nodes => {
                for (const node of nodes || []) {
                  if (node.attrs?.some(([name, value]) => name === 'id' && value === 'highlight-target')) return node;
                  const found = find(node.children); if (found) return found;
                }
                return null;
              };
              const target = find(data.tree);
              if (target && window.__resolveElementBridge) {
                window.__testPort.postMessage({ type: 'highlight-node', id: target.id });
                window.__resolveElementBridge(target); window.__resolveElementBridge = null;
              }
              return;
            }
            if (data.type === 'cancel') { window.__cancelObserved = true; return; }
            if (data.type === 'evaluate-result') { window.__resolveEvaluationResult(data); return; }
            if (data.type === 'inspect-node-result') { window.__resolveInspectNode(data); return; }
            if (data.type === 'edit-node-result') { window.__resolveEditNode(data); return; }
            if (data.type === 'ws-open') {
              window.__webSocketRequest = data;
              channel.port1.postMessage({ type: 'ws-open-result', id: data.id, ok: true, protocol: 'echo.v1' });
              return;
            }
            if (data.type === 'ws-send') {
              channel.port1.postMessage({ type: 'ws-message', id: data.id, kind: data.kind, body: data.body }, [data.body]);
              return;
            }
            if (data.type === 'ws-close') {
              channel.port1.postMessage({ type: 'ws-close', id: data.id, code: 1000, reason: 'done', wasClean: true });
              return;
            }
            if (data.type === 'resource' && data.transferSource === true) {
              if (data.moduleMode && data.pageModule) channel.port1.postMessage({ type: 'resource-source', id: data.id, ...pageModuleGraph });
              else if (data.moduleMode) channel.port1.postMessage({ type: 'resource-source', id: data.id, ...moduleWorkerGraph });
              else channel.port1.postMessage({ type: 'resource-source', id: data.id, source: `self.onmessage = async event => { const response = await fetch('/worker-data'); const text = await response.text(); const xhr = new XMLHttpRequest(); xhr.open('GET', '/worker-xhr-data'); xhr.onload = () => self.postMessage('classic:' + event.data + ':' + text + ':' + xhr.status + ':' + xhr.responseText + ':' + xhr.getResponseHeader('x-bridge-check')); xhr.send(); };`, url: data.url, sources: {} });
              return;
            }
            if (data.type === 'request') {
              if (data.url.endsWith('/worker-xhr-data')) (window.__workerXhrRequests ||= []).push({ method: data.method, resourceType: data.resourceType, url: data.url });
              if (data.url.endsWith('/gm-data')) window.__gmRequestMeta = { userscriptId: data.userscriptId || '', followRedirects: data.followRedirects, credentials: data.credentials };
              if (data.url.endsWith('/gm-forge')) window.__forgedUserscriptMeta = { userscriptId: data.userscriptId || '', followRedirects: data.followRedirects };
              if (data.url.endsWith('/formdata')) {
                window.__resolveFormDataRequest({ headers: data.headers, body: new TextDecoder().decode(data.body) });
                channel.port1.postMessage({ type: 'response', id: data.id, status: 204, statusText: 'No Content', url: data.url, headers: [], body: null });
                return;
              }
              if (data.discardBody) {
                window.__resolveBeaconRequest({ url: data.url, method: data.method, body: new TextDecoder().decode(data.body) });
                channel.port1.postMessage({ type: 'response', id: data.id, status: 204, statusText: 'No Content', url: data.url, headers: [], body: null });
                return;
              }
              if (data.url === 'https://example.test/base/relative-fetch') window.__resolveRelativeFetchRequest(data.url);
              if (data.url.endsWith('/slow')) return;
              requestUrls.set(data.id, data.url);
              channel.port1.postMessage({ type: 'response', id: data.id, status: data.url.endsWith('/gm-forge') ? 204 : 200, statusText: 'OK', url: data.url, stream: !data.url.endsWith('/gm-forge'), body: null,
                headers: [['content-type', data.url.endsWith('/events') ? 'text/event-stream' : 'text/plain'], ['x-bridge-check', 'passed']] });
            } else if (data.type === 'credit') {
              const body = new TextEncoder().encode(requestUrls.get(data.id)?.endsWith('/events') ? 'data: hello\n\n' : requestUrls.get(data.id)?.endsWith('/gm-data') ? 'gm-ok' : 'xhr-ok');
              channel.port1.postMessage({ type: 'chunk', id: data.id, body: body.buffer }, [body.buffer]);
              channel.port1.postMessage({ type: 'response-end', id: data.id });
              requestUrls.delete(data.id);
            }
          };
          window.__inspectNodeResult = new Promise(resolve => { window.__resolveInspectNode = resolve; });
          window.__editNodeResult = new Promise(resolve => { window.__resolveEditNode = resolve; });
          channel.port1.start();
          window.__testPort = channel.port1;
          frame.contentWindow.postMessage({ type: 'eya-connect', nonce: 'browser-runtime-test' }, '*', [channel.port2]);
          channel.port1.postMessage({ type: 'storage-sync', area: 'local', action: 'set', key: 'synced', value: 'from-other-tab', url: 'https://example.test/' });
          resolve();
        });
      });
      window.__formNavigation = new Promise(resolve => { window.__resolveFormNavigation = resolve; });
      window.__formDataRequest = new Promise(resolve => { window.__resolveFormDataRequest = resolve; });
      window.__submitterNavigation = new Promise(resolve => { window.__resolveSubmitterNavigation = resolve; });
      window.__linkNavigation = new Promise(resolve => { window.__resolveLinkNavigation = resolve; });
      window.__scriptNavigation = new Promise(resolve => { window.__resolveScriptNavigation = resolve; });
      window.__unhandledNavigation = new Promise(resolve => { window.__resolveUnhandledNavigation = resolve; });
      window.__historyMessages = [];
      window.__newTabRequest = new Promise(resolve => { window.__resolveNewTabRequest = resolve; });
      window.__downloadRequest = new Promise(resolve => { window.__resolveDownloadRequest = resolve; });
      window.__elementBridge = new Promise(resolve => { window.__resolveElementBridge = resolve; });
      window.__highlightObserved = new Promise(resolve => {
        window.addEventListener('message', event => {
          if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.type === 'test-highlight') resolve(event.data);
        });
      });
      window.__eventSourceMessage = new Promise(resolve => {
        window.addEventListener('message', event => {
          if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.type === 'test-eventsource') resolve(event.data);
        });
      });
      window.__webSocketOpen = new Promise(resolve => {
        window.addEventListener('message', event => {
          if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.type === 'test-websocket-open') resolve(event.data);
        });
      });
      window.__webSocketClosed = new Promise(resolve => {
        window.addEventListener('message', event => {
          if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.type === 'test-websocket-close') resolve(event.data);
        });
      });
      window.__classicWorkerResult = new Promise(resolve => window.addEventListener('message', event => { if (event.data?.type === 'test-classic-worker') resolve(event.data.value); }));
      window.__moduleWorkerResult = new Promise(resolve => window.addEventListener('message', event => { if (event.data?.type === 'test-module-worker') resolve(event.data.value); }));
      window.__pageModuleResult = new Promise(resolve => window.addEventListener('message', event => { if (event.source === frame.contentWindow && event.data?.type === 'test-page-module') resolve(event.data.value); }));
      if (frame.getAttribute('sandbox') !== 'allow-scripts') throw Error('browser iframe sandbox allows an unproxied capability');
      frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${frameCsp}"><base data-eya-proxy-base href="https://example.test/base/"><script>${runtime}<\/script>${userscripts}<script>delete window.__eyaUserscriptRequest;parent.postMessage({type:'test-gm-bridge',deleted:typeof window.__eyaUserscriptRequest==='undefined'},'*');<\/script><body><script type="module" data-eya-module data-eya-src="${pageModuleUrl}"><\/script><script>
        const report = (ok, detail) => parent.postMessage({ type: 'test-result', ok, detail }, '*');
        addEventListener('message', event => { if (event.data?.type === 'test-location-navigation') (0, eval)(event.data.source); });
        Event.prototype.stopImmediatePropagation = () => {};
        window.find = () => false;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
        fetch('https://example.test/gm-forge', { userscriptId: 'runtime-request-script', followRedirects: false }).catch(() => {});
        window.__capturedBridgePort = false;
        addEventListener('message', event => { if (event.data?.type === 'eya-connect') window.__capturedBridgePort = !!event.ports[0]; }, true);
        window.__storageEvent = new Promise(resolve => addEventListener('storage', event => { if (event.key === 'synced') resolve({ key: event.key, value: localStorage.getItem(event.key) }); }));
        if (localStorage.getItem('persisted') !== 'read-before-page-script' || sessionStorage.getItem('tab') !== 'session-before-page-script') throw Error('Storage snapshot was unavailable to the first page script');
        localStorage.setItem('page-write', 'persisted'); sessionStorage.setItem('session-write', 'retained');
        const highlightTarget = document.createElement('div'); highlightTarget.id = 'highlight-target'; highlightTarget.textContent = 'Highlight target'; document.body.append(highlightTarget);
        const proxiedSocket = new WebSocket('wss://example.test/socket', ['echo.v1']);
        proxiedSocket.binaryType = 'arraybuffer';
        let socketEchoedText = false;
        proxiedSocket.onopen = () => { parent.postMessage({ type: 'test-websocket-open', protocol: proxiedSocket.protocol }, '*'); proxiedSocket.send('hello'); };
        proxiedSocket.onmessage = event => {
          if (typeof event.data === 'string') { socketEchoedText = event.data === 'hello'; proxiedSocket.send(new Uint8Array([1, 2, 3])); }
          else {
            const bytes = [...new Uint8Array(event.data)];
            if (!socketEchoedText || bytes.join(',') !== '1,2,3') throw Error('WebSocket binary echo did not preserve bytes');
            proxiedSocket.onclose = event => parent.postMessage({ type: 'test-websocket-close', code: event.code, reason: event.reason, wasClean: event.wasClean }, '*');
            proxiedSocket.close(1000, 'done');
          }
        };
        const highlightObserver = new MutationObserver(() => { if (highlightTarget.style.outline.includes('2px') && highlightTarget.style.outline.includes('solid')) { highlightObserver.disconnect(); parent.postMessage({ type: 'test-highlight', ok: true }, '*'); } });
        highlightObserver.observe(highlightTarget, { attributes: true, attributeFilter: ['style'] });
        const eventSource = new EventSource('/events');
        eventSource.onmessage = event => { eventSource.close(); parent.postMessage({ type: 'test-eventsource', data: event.data }, '*'); };
        const classicWorker = new Worker('/classic-worker.js');
        classicWorker.onmessage = event => { classicWorker.terminate(); parent.postMessage({ type: 'test-classic-worker', value: event.data }, '*'); };
        classicWorker.postMessage('ping');
        const moduleWorker = new Worker('/module-worker.js', { type: 'module' });
        moduleWorker.onmessage = event => { moduleWorker.terminate(); parent.postMessage({ type: 'test-module-worker', value: event.data }, '*'); };
        moduleWorker.postMessage('ping');
        fetch('relative-fetch').then(response => response.text()).catch(() => {});
        const multipart = new FormData(); multipart.append('field', 'native-boundary');
        fetch('https://example.test/formdata', { method: 'POST', body: multipart }).catch(() => {});
        const beaconAccepted = navigator.sendBeacon('https://example.test/beacon', 'beacon body');
        parent.postMessage({ type: 'test-beacon', accepted: beaconAccepted }, '*');
        const xhr = new XMLHttpRequest(); const states = [];
        xhr.onreadystatechange = () => states.push(xhr.readyState);
        xhr.open('GET', '/ok');
        xhr.onload = () => {
          try {
            if (xhr.status !== 200 || xhr.responseText !== 'xhr-ok' || xhr.getResponseHeader('x-bridge-check') !== 'passed') throw Error('XHR response fields were not preserved');
            if (![1, 2, 3, 4].every(state => states.includes(state))) throw Error('XHR readyState sequence was incomplete');
            const slow = new XMLHttpRequest();
            slow.onabort = () => {
              report(true, 'XHR response, state changes, headers, and abort relay passed');
              const form = document.createElement('form'); form.method = 'post'; form.action = 'https://example.test/submit';
              const field = document.createElement('input'); field.name = 'q'; field.value = 'browser works'; form.append(field); document.body.append(form); form.requestSubmit();
              const overrideForm = document.createElement('form'); overrideForm.method = 'get'; overrideForm.action = 'https://example.test/default-action';
              const overrideField = document.createElement('input'); overrideField.name = 'answer'; overrideField.value = 'button override'; overrideForm.append(overrideField);
              const overrideButton = document.createElement('button'); overrideButton.type = 'submit'; overrideButton.formAction = 'https://example.test/submitter'; overrideButton.formMethod = 'post'; overrideButton.formEnctype = 'text/plain'; overrideButton.formTarget = '_self'; overrideForm.append(overrideButton); document.body.append(overrideForm); overrideButton.click();
            const link = document.createElement('a'); link.href = 'https://example.test/linked'; link.textContent = 'link'; document.body.append(link);
            const newTab = document.createElement('a'); newTab.href = 'https://example.test/new-tab'; newTab.target = '_blank'; document.body.append(newTab);
            const download = document.createElement('a'); download.href = 'https://example.test/report.zip'; download.download = 'report.zip'; document.body.append(download);
            setTimeout(() => { link.click(); newTab.click(); download.click(); }, 50);
            };
            slow.onerror = () => report(false, 'aborted XHR fired error instead of abort');
            slow.open('GET', 'https://example.test/slow'); slow.send();
            setTimeout(() => slow.abort(), 30);
          } catch (error) { report(false, error.message); }
        };
        xhr.onerror = () => report(false, 'XHR bridge request failed'); xhr.send();
      <\/script>`;
      document.body.append(frame);
    }, { runtime, userscripts, frameCsp, moduleWorkerUrl, moduleWorkerGraph, pageModuleUrl, pageModuleGraph });
    await pageValue('__bridgeReady');
    assert.equal(await pageValue('__gmBridgeDeleted'), true, 'the temporary userscript request bridge must be deleted before site scripts execute');
    const gmResult = await pageValue('__gmRequestResult');
    assert.deepEqual(gmResult, { type: 'test-gm-request', status: 200, text: 'gm-ok', headers: 'content-type: text/plain\r\nx-bridge-check: passed' }, 'document-end GM_xmlhttpRequest must use the captured bridge');
    const gmMeta = await page.evaluate(() => window.__gmRequestMeta);
    assert.equal(gmMeta.userscriptId, 'runtime-request-script', 'the parent must receive the validated userscript identity');
    assert.equal(gmMeta.followRedirects, false, 'userscript requests must fail closed on redirects');
    assert.equal(gmMeta.credentials, 'omit', 'userscript requests must omit ambient credentials');
    const forgedMeta = await page.waitForFunction(() => window.__forgedUserscriptMeta || null, { timeout: 8000 }).then(handle => handle.jsonValue());
    assert.equal(forgedMeta.userscriptId, '', 'page fetch options cannot forge a userscript identity');
    assert.equal(forgedMeta.followRedirects, true, 'page fetch options cannot disable redirect handling');
    assert.equal(await pageValue('__findOpenResult'), true, 'Ctrl+F inside the sandbox did not open the parent Find UI');
    assert.equal(await page.frames()[1].evaluate(() => window.__capturedBridgePort), false,
      'the page realm captured the transferred parent bridge port');
    assert.deepEqual(await page.frames()[1].evaluate(() => window.__storageEvent), { key: 'synced', value: 'from-other-tab' },
      'localStorage changes from another tab did not update the page storage shim');
    await page.waitForFunction(() => (window.__storageUpdates || []).some(item => item.area === 'session' && item.action === 'set' && item.key === 'session-write'));
    await page.evaluate(() => {
      window.__evaluationResult = new Promise(resolve => { window.__resolveEvaluationResult = resolve; });
      window.__testPort.postMessage({ type: 'evaluate', id: 41, code: "document.title = 'Console Works'; 42" });
    });
    const evaluation = await pageValue('__evaluationResult');
    assert.equal(evaluation?.value, 42, 'DevTools evaluation did not return the page expression value');
    assert.equal(await page.frames()[1].title(), 'Console Works', 'DevTools evaluation did not run in the page context');
    const outcome = await pageValue('__testResultPromise');
    assert.equal(outcome?.ok, true, outcome?.detail || 'iframe XHR smoke test did not report success');
    await page.waitForFunction(() => window.__cancelObserved, null, { timeout: 1000 });
    assert.equal(await pageValue('__cancelObserved'), true, 'XHR abort did not reach the parent relay');
    const form = await pageValue('__formNavigation');
    assert.equal(form?.method, 'POST', 'form navigation did not preserve the POST method');
    assert.equal(form?.url, 'https://example.test/submit', 'form navigation URL was incorrect');
    assert.equal(form?.headers?.some(([name, value]) => name.toLowerCase() === 'content-type' && value.includes('application/x-www-form-urlencoded')), true, 'form content type was not encoded');
    assert.equal(new TextDecoder().decode(form.body), 'q=browser+works', 'form body was not encoded');
    const formData = await pageValue('__formDataRequest');
    const multipartType = formData?.headers?.find(([name]) => name.toLowerCase() === 'content-type')?.[1] || '';
    assert.match(multipartType, /^multipart\/form-data;\s*boundary=/i, 'native Request must preserve FormData boundary metadata');
    assert.match(formData.body, /name="field"\r\n\r\nnative-boundary/, 'FormData fields must use the native multipart encoding');
    const submitter = await pageValue('__submitterNavigation');
    assert.equal(submitter?.method, 'POST', 'submitter method override was ignored');
    assert.equal(submitter?.url, 'https://example.test/submitter', 'submitter action override was ignored');
    assert.equal(submitter?.headers?.some(([name, value]) => name.toLowerCase() === 'content-type' && value.includes('text/plain')), true, 'submitter enctype override was ignored');
    assert.equal(new TextDecoder().decode(submitter.body), 'answer=button override\r\n', 'submitter form data was not encoded');
    const link = await pageValue('__linkNavigation');
    assert.equal(link?.url, 'https://example.test/linked', 'link navigation did not route through the parent bridge');
    const newTab = await pageValue('__newTabRequest');
    assert.equal(newTab?.url, 'https://example.test/new-tab', 'target=_blank link did not request an Eya tab');
    const download = await pageValue('__downloadRequest');
    assert.equal(download?.url, 'https://example.test/report.zip', 'download link did not request a proxied download');
    assert.equal(download?.filename, 'report.zip', 'download attribute filename was not relayed');
    const element = await pageValue('__elementBridge');
    assert.equal(element?.tag, 'div', 'Elements snapshot did not include the test node');
    await page.evaluate(id => window.__testPort.postMessage({ type: 'inspect-node', id }), element.id);
    const inspection = await pageValue('__inspectNodeResult');
    assert.equal(inspection?.computed?.display, 'block', 'Elements did not report the selected node computed style');
    assert.equal(typeof inspection?.box?.width, 'number', 'Elements did not report the selected node box dimensions');
    await page.evaluate(id => window.__testPort.postMessage({ type: 'edit-node', id, kind: 'text', value: 'Edited target' }), element.id);
    const textEdit = await pageValue('__editNodeResult');
    assert.equal(textEdit?.ok, true, 'Elements did not apply bounded leaf text edits');
    assert.equal(await page.frames()[1].locator('#highlight-target').textContent(), 'Edited target');
    await page.locator('iframe').evaluate((frame, source) => frame.contentWindow.postMessage({ type: 'test-location-navigation', source }, '*'), scriptNavigationSource);
    const scriptNavigation = await pageValue('__scriptNavigation');
    assert.equal(scriptNavigation?.url, 'https://example.test/base/script-navigation', 'script-driven Location navigation did not route through the bridge');
    assert.equal(scriptNavigation?.history, 'push', 'script navigation did not preserve push history intent');
    assert.deepEqual(directNavigationRequests, [], 'script-driven navigation bypassed the WebSocket bridge');
    await page.evaluate(() => {
      window.__findResult = new Promise(resolve => { window.__resolveFindResult = resolve; });
      window.__testPort.postMessage({ type: 'find-in-page', id: 77, text: 'Edited target', backwards: false, reset: true });
    });
    const findResult = await pageValue('__findResult');
    assert.equal(findResult?.found, true, 'sandbox Find did not locate page text through the private bridge');
    await page.evaluate(id => {
      window.__editNodeResult = new Promise(resolve => { window.__resolveEditNode = resolve; });
      window.__testPort.postMessage({ type: 'edit-node', id, kind: 'attribute', property: 'aria-label', value: 'Edited label' });
    }, element.id);
    const attributeEdit = await pageValue('__editNodeResult');
    assert.equal(attributeEdit?.ok, true, 'Elements did not apply an allowed accessibility attribute edit');
    assert.equal(await page.frames()[1].locator('#highlight-target').getAttribute('aria-label'), 'Edited label');
    await page.evaluate(id => {
      window.__editNodeResult = new Promise(resolve => { window.__resolveEditNode = resolve; });
      window.__testPort.postMessage({ type: 'edit-node', id, kind: 'attribute', property: 'href', value: 'https://tracker.example/' });
    }, element.id);
    const unsafeAttributeEdit = await pageValue('__editNodeResult');
    assert.equal(unsafeAttributeEdit?.ok, false, 'Elements rejected URL-bearing attributes');
    await page.evaluate(id => {
      window.__editNodeResult = new Promise(resolve => { window.__resolveEditNode = resolve; });
      window.__testPort.postMessage({ type: 'edit-node', id, kind: 'style', property: 'color', value: 'rgb(1, 2, 3)' });
    }, element.id);
    const styleEdit = await pageValue('__editNodeResult');
    assert.equal(styleEdit?.ok, true, 'Elements did not apply an allowed inline style edit');
    await page.evaluate(id => {
      window.__inspectNodeResult = new Promise(resolve => { window.__resolveInspectNode = resolve; });
      window.__testPort.postMessage({ type: 'inspect-node', id });
    }, element.id);
    assert.equal((await pageValue('__inspectNodeResult'))?.computed?.color, 'rgb(1, 2, 3)',
      'Elements did not refresh computed styles after an edit');
    await page.evaluate(id => {
      window.__editNodeResult = new Promise(resolve => { window.__resolveEditNode = resolve; });
      window.__testPort.postMessage({ type: 'edit-node', id, kind: 'style', property: 'background-image', value: 'url(https://tracker.example/pixel)' });
    }, element.id);
    const unsafeStyleEdit = await pageValue('__editNodeResult');
    assert.equal(unsafeStyleEdit?.ok, false, 'Elements rejected style properties that can load external resources');
    const highlight = await pageValue('__highlightObserved');
    assert.equal(highlight?.ok, true, 'Elements selection did not highlight the frame node');
    const eventSource = await pageValue('__eventSourceMessage');
    assert.equal(eventSource?.data, 'hello', 'EventSource event data was not parsed and delivered');
    const wsOpen = await pageValue('__webSocketOpen');
    assert.equal(wsOpen?.protocol, 'echo.v1', 'WebSocket subprotocol was not exposed after the bridged handshake');
    const wsRequest = await pageValue('__webSocketRequest');
    assert.equal(wsRequest?.url, 'wss://example.test/socket', 'WebSocket URL did not reach the parent proxy bridge');
    assert.deepEqual(wsRequest?.protocols, ['echo.v1'], 'WebSocket subprotocol offers were not relayed');
    const wsClose = await pageValue('__webSocketClosed');
    assert.equal(wsClose?.code, 1000, 'WebSocket close code was not preserved');
    assert.equal(wsClose?.wasClean, true, 'WebSocket clean close was not preserved');
    assert.equal(await pageValue('__relativeFetchRequest'), 'https://example.test/base/relative-fetch', 'relative fetch URL did not use the rewritten document base');
    assert.equal(await pageValue('__classicWorkerResult'), 'classic:ping:xhr-ok:200:xhr-ok:passed', 'classic Worker XHR did not use the bridged request path');
    assert.equal(await pageValue('__moduleWorkerResult'), 'module:ping:xhr-ok:200:xhr-ok:passed', 'module Worker XHR or fetch bridge failed');
    const workerXhrRequests = await page.evaluate(() => window.__workerXhrRequests || []);
    assert.equal(workerXhrRequests.length, 2, 'classic and module Workers must each route their XHR through the page bridge');
    assert.equal(workerXhrRequests.every(request => request.resourceType === 'xmlhttprequest' && request.method === 'GET'), true,
      'Worker XHR must retain its request type and method through the relay');
    assert.equal(await pageValue('__pageModuleResult'), 'page-module:ok', 'proxied page module imports did not execute inside the sandbox');
    assert.equal(await pageValue('__beaconAccepted'), true, 'sendBeacon did not accept the bounded request');
    const beacon = await pageValue('__beaconRequest');
    assert.equal(beacon?.method, 'POST', 'sendBeacon did not use POST');
    assert.equal(beacon?.url, 'https://example.test/beacon', 'sendBeacon did not use the parent proxy bridge');
    assert.equal(beacon?.body, 'beacon body', 'sendBeacon body was not preserved');
    assert.deepEqual(await pageValue('__legacyBridgeMessages'), [],
      'page actions and reports must use the private per-document channel, not window messages');
    const sandboxFrame = page.frames().find(frame => frame !== page.mainFrame());
    assert.ok(sandboxFrame, 'sandbox frame was not created');
    await sandboxFrame.waitForFunction(() => window.__eyaResourceLoaded === true, { timeout: 8000 });
    const routeState = await sandboxFrame.evaluate(() => {
      history.pushState({ route: 'one' }, '', '/route-one?tab=1');
      const first = { base: document.baseURI, state: history.state, length: history.length };
      history.pushState({ route: 'two' }, '', '/route-two');
      return { first, second: { base: document.baseURI, state: history.state, length: history.length } };
    });
    assert.deepEqual(routeState.first, { base: 'https://example.test/route-one?tab=1', state: { route: 'one' }, length: 2 },
      'pushState must update relative URL resolution and expose cloned route state');
    assert.deepEqual(routeState.second, { base: 'https://example.test/route-two', state: { route: 'two' }, length: 3 },
      'subsequent SPA routes must extend the virtual same-document history');
    assert.equal(await sandboxFrame.evaluate(() => { try { history.pushState({}, '', 'https://other.example/escape'); return 'accepted'; } catch (error) { return error.name; } }), 'SecurityError',
      'virtual pushState must reject cross-origin destinations');
    await page.waitForFunction(() => window.__historyMessages.filter(item => item.type === 'history').length >= 2);
    const routeMessages = await page.evaluate(() => window.__historyMessages.filter(item => item.type === 'history'));
    assert.deepEqual(routeMessages.slice(-2).map(({ action, url, index }) => ({ action, url, index })), [
      { action: 'push', url: 'https://example.test/route-one?tab=1', index: 1 },
      { action: 'push', url: 'https://example.test/route-two', index: 2 },
    ], 'same-document routes must update the parent address/history without fetching a new document');
    assert.deepEqual(directUpstreamRequests, [], 'virtual SPA routes must not cause client-side upstream navigation requests');
    await sandboxFrame.evaluate(() => { window.__lastRoutePop = null; addEventListener('popstate', event => { window.__lastRoutePop = { base: document.baseURI, state: event.state } }); history.back(); });
    await page.waitForFunction(() => window.__historyMessages.some(item => item.type === 'history-go' && item.delta === -1));
    await page.evaluate(() => window.__testPort.postMessage({ type: 'history-traverse', index: 1 }));
    await sandboxFrame.waitForFunction(() => window.__lastRoutePop?.base === 'https://example.test/route-one?tab=1');
    assert.deepEqual(await sandboxFrame.evaluate(() => window.__lastRoutePop), { base: 'https://example.test/route-one?tab=1', state: { route: 'one' } },
      'parent-driven back/forward must restore SPA state and dispatch popstate');
    const beforeReplaceLength = await sandboxFrame.evaluate(() => history.length);
    await sandboxFrame.evaluate(() => history.replaceState({ route: 'one-edited' }, '', '/route-one-edited'));
    assert.deepEqual(await sandboxFrame.evaluate(() => ({ base: document.baseURI, state: history.state, length: history.length })),
      { base: 'https://example.test/route-one-edited', state: { route: 'one-edited' }, length: beforeReplaceLength },
      'replaceState must update the current virtual entry without growing history');
    await page.waitForFunction(() => window.__historyMessages.filter(item => item.type === 'history' && item.action === 'replace').length >= 1);
    await sandboxFrame.evaluate(() => {
      const event = new Event('navigate', { cancelable: false });
      Object.defineProperty(event, 'destination', { value: { url: 'https://direct-navigation.example/escape', sameDocument: false } });
      Object.defineProperty(event, 'navigationType', { value: 'push' });
      window.navigation.dispatchEvent(event);
    });
    const unhandledNavigation = await pageValue('__unhandledNavigation');
    assert.equal(unhandledNavigation?.url, 'https://direct-navigation.example/escape', 'non-cancelable navigation must be reported for parent-side frame shutdown');
    assert.equal(await sandboxFrame.evaluate(() => document.documentElement.childElementCount), 0, 'the sandbox must stop and clear itself immediately when navigation cannot be canceled');
    console.log('Browser proxy runtime navigation, Find, API relay, storage, DevTools, forms, Workers, and page-module checks passed.');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
