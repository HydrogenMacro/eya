const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');

async function main() {
  const source = path.resolve(__dirname, '../client/browser-panel.js');
  const bundle = buildSync({ entryPoints: [source], bundle: true, platform: 'browser', format: 'iife', globalName: 'EyaBrowserPanel', write: false });
  const server = http.createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><html><body></body></html>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try { browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] }); }
  catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const mapped = await page.evaluate(() => {
      const bounds = { left: 10, top: 20, width: 200, height: 600 }, viewport = { width: 320, height: 600 };
      return [EyaBrowserPanel.remoteViewportPoint(bounds, viewport, 110, 320), EyaBrowserPanel.remoteViewportPoint(bounds, viewport, 110, 25), EyaBrowserPanel.remoteViewportPoint(bounds, viewport, 10, 132.5)];
    });
    assert.deepEqual(mapped.map(({ x, y, inside }) => ({ x, y, inside })), [{ x: 160, y: 300, inside: true }, { x: 160, y: 0, inside: false }, { x: 0, y: 0, inside: true }], 'letterboxed input must use the displayed image rectangle and identify the bars');
    await page.evaluate(() => {
      document.body.style.cssText = 'margin:0;height:800px;display:flex';
      window.proxyRequests = 0; window.localFileReads = []; window.remoteNavigations = []; window.remoteHistoryCalls = []; window.remoteActivations = []; window.remoteTabClosures = []; window.remoteInputs = []; window.remotePrivacySettings = []; window.remoteUserscripts = []; window.remoteFilterSnapshots = []; window.remoteEvaluations = []; window.remoteSourceLoads = []; window.remoteNetworkBodies = []; window.remoteSiteDataClears = []; window.remoteExtensionUploads = []; window.remoteExtensionRemovals = []; window.remoteExtensionActions = []; window.remoteClosed = false; window.remoteStarted = false;
      const source = '// ==UserScript==\n// @name Remote test\n// @match https://example.test/*\n// @grant none\n// ==/UserScript==\nwindow.remoteUserScriptRan = true;';
      localStorage.setItem('eya-browser-userscripts-v1', JSON.stringify([{ id: 'remote-test', enabled: true, source }]));
      window.panel = EyaBrowserPanel.createBrowserPanel({
        request: async () => { window.proxyRequests++; throw Error('Proxy path should not be used in remote mode'); },
        openWebSocket: async () => { throw Error('Page WebSocket should not be used in remote mode'); },
        readLocalFile: async path => {
          window.localFileReads.push(path);
          const documents = {
            '/target/doc/index.html': '<!doctype html><title>Rustdoc index</title><h1>Crate documentation</h1><a href="crate/index.html">Open crate</a>',
            '/target/doc/crate/index.html': '<!doctype html><title>Example crate</title><h1>Example crate</h1>',
          };
          if (!documents[path]) throw Error('File not found.');
          return { meta: { path }, bytes: new TextEncoder().encode(documents[path]) };
        },
        openRemoteBrowser: async handlers => {
          window.remoteHandlers = handlers;
          return {
            ready: true,
            start() { window.remoteStarted = true; handlers.onEvent({ type: 'ready', resourceLimits: { enforced: false } }, 'status'); },
            navigate(url, tabId) { window.remoteNavigations.push({ url, tabId }); handlers.onEvent({ type: 'navigating', tabId, url }, 'status'); },
            historyGo(tabId, delta) { window.remoteHistoryCalls.push({ tabId, delta }); },
            activateTab(tabId) { return Promise.resolve().then(() => { window.remoteActivations.push(tabId); const event = { type: 'tab-activated', tabId }; handlers.onEvent(event, 'status'); return event; }); },
            closeTab(tabId) { window.remoteTabClosures.push(tabId); },
            resize() {}, input(value) { window.remoteInputs.push(value); }, privacy(value) { window.remotePrivacySettings.push(value); }, userscripts(value) { window.remoteUserscripts.push(value); return Promise.resolve({ ok: true }); }, filters(value) { window.remoteFilterSnapshots.push(value); return Promise.resolve({ ok: true }); }, ack() {},
            async evaluate(tabId, expression) {
              window.remoteEvaluations.push(expression);
              if (expression.includes('eya-storage-snapshot')) return { id: 1, result: { local: [['local-key', 'local-value']], session: [['session-key', 'session-value']], truncated: false }, exception: null };
              if (expression.includes('eya-performance-snapshot')) return { id: 1, result: { entries: [{ entryType: 'navigation', name: 'https://example.test/full-browser', domInteractive: 13, domContentLoadedEventEnd: 21, loadEventEnd: 34 }, { entryType: 'paint', name: 'first-contentful-paint', startTime: 8 }], memory: { usedJSHeapSize: 1024 * 1024, totalJSHeapSize: 2 * 1024 * 1024 } }, exception: null };
              if (expression.includes('eya-performance-start') || expression.includes('eya-performance-stop')) return { id: 1, result: true, exception: null };
              if (expression.includes('eya-performance-drain')) return { id: 1, result: { entries: [{ entryType: 'mark', name: 'remote-recorded-mark', startTime: 40, duration: 0 }], memory: null }, exception: null };
              if (expression.includes("const k='__eyaDevtoolsState'")) return { id: 1, result: { tree: [{ id: 1, tag: 'p', attrs: [['id', 'remote-p']], text: 'remote text', children: [], hasChildren: false, childrenLoaded: true }], hasMore: false }, exception: null };
              if (expression.includes('getBoundingClientRect')) return { id: 1, result: { id: 1, box: { x: 1, y: 2, width: 30, height: 12 }, computed: { color: 'rgb(0, 0, 0)' } }, exception: null };
              if (expression.includes("return{ok:true}")) return { id: 1, result: { ok: true }, exception: null };
              if (expression.includes("return true})()")) return { id: 1, result: true, exception: null };
              return { id: 1, result: 42, exception: null };
            },
            async sources() { return { sources: [{ url: 'https://example.test/app.js', kind: 'Script', mimeType: 'text/javascript' }] }; },
            async sourceContent(tabId, url) { window.remoteSourceLoads.push(url); return { url, text: 'console.log("remote source loaded")', truncated: false }; },
            async networkBody(requestId) { window.remoteNetworkBodies.push(requestId); return { text: 'remote response preview', truncated: false }; },
            cancelDownload(id) { window.remoteDownloadCancelled = id; },
            async cookies(tabId, origin) { return { cookies: [{ name: 'remote-session', value: 'secret-cookie', domain: new URL(origin).hostname, path: '/', httpOnly: true, secure: true }] }; },
            async clearSiteData(tabId, origin) { window.remoteSiteDataClears.push(origin); return { ok: true }; },
            async installExtension(files) { window.remoteExtensionUploads.push(files.length); return { id: 'a'.repeat(32), name: 'Test extension', hasAction: true }; },
            async removeExtension(id) { window.remoteExtensionRemovals.push(id); return { ok: true, phase: 'removed' }; },
            async triggerExtensionAction(extensionId, tabId) { window.remoteExtensionActions.push({ extensionId, tabId }); return { ok: true, phase: 'action-triggered' }; },
            async debugger(tabId, action, options = {}) {
              if (action === 'getScopes') return { scopes: [{ type: 'local', name: 'work', object: { objectId: 'scope-1', type: 'object', className: 'Object', description: 'Local' } }] };
              if (action === 'getProperties' && options.objectId === 'scope-1') return { properties: [{ name: 'count', value: { type: 'number', value: 7 } }] };
              return { breakpointId: 'bp-1', properties: [], scopes: [] };
            },
            close() { window.remoteClosed = true; },
          };
        },
      });
      panel.element.style.height = '760px'; panel.element.style.width = '100%'; document.body.append(panel.element);
    });
    assert.equal(await page.getByText('Fast proxy', { exact: true }).isDisabled(), true);
    await page.getByTitle('Open a local HTML or Rustdoc page from the Eya file root').click();
    await page.getByLabel('Path to local HTML file under the Eya file root').fill('/target/doc/index.html');
    await page.getByRole('button', { name: 'Open the selected local HTML file' }).click();
    assert.equal(await page.evaluate(() => window.remoteStarted), false);
    await page.locator('.html-viewer-frame').waitFor();
    await page.frameLocator('.html-viewer-frame').getByRole('heading', { name: 'Crate documentation' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.localFileReads), ['/target/doc/index.html']);
    assert.equal(await page.locator('.html-viewer-root').inputValue(), '/target/doc');
    await page.frameLocator('.html-viewer-frame').getByRole('link', { name: 'Open crate' }).click();
    await page.frameLocator('.html-viewer-frame').getByRole('heading', { name: 'Example crate' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.localFileReads), ['/target/doc/index.html', '/target/doc/crate/index.html']);
    await page.getByTitle('Return to web browsing').click();
    await page.locator('.eya-address').fill('https://example.test/full-browser');
    await page.getByTitle('Navigate').click();
    await page.waitForFunction(() => window.remoteStarted);
    await page.waitForFunction(() => window.remotePrivacySettings.length > 0);
    await page.waitForFunction(() => window.remoteFilterSnapshots.length > 0);
    assert.deepEqual(await page.evaluate(() => window.remoteFilterSnapshots[0]), { version: 1, hosts: [], rules: [] });
    assert.deepEqual(await page.evaluate(() => window.remotePrivacySettings[0]), { blockTrackers: true, blockThirdParty: false, stripTracking: true });
    await page.locator('[data-pref="blockThirdParty"]').evaluate(input => { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForFunction(() => window.remotePrivacySettings.length > 1);
    assert.deepEqual(await page.evaluate(() => window.remotePrivacySettings.at(-1)), { blockTrackers: true, blockThirdParty: true, stripTracking: true });
    await page.waitForFunction(() => window.remoteNavigations.some(item => item.url === 'https://example.test/full-browser'), null, { timeout: 3000 });
    await page.waitForFunction(() => window.remoteUserscripts.length > 0);
    const remoteSources = await page.evaluate(() => window.remoteUserscripts[0]);
    assert.equal(remoteSources.length, 1);
    assert.match(remoteSources[0], /remoteUserScriptRan = true/);
    assert.equal(await page.locator('.eya-address').inputValue(), 'https://example.test/full-browser');
    assert.equal(await page.evaluate(() => window.proxyRequests), 0, 'remote navigation must not use the client proxy renderer');

    await page.evaluate(() => window.remoteHandlers.onEvent({
      method: 'Page.frameNavigated', params: { frame: { url: 'https://example.test/final-destination' } },
    }, 'cdp'));
    assert.equal(await page.locator('.eya-address').inputValue(), 'https://example.test/final-destination', 'the address bar must show the committed redirect destination');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('eya-browser-history-v1'))[0].url), 'https://example.test/final-destination', 'saved history must use Chromium’s committed URL');
    await page.locator('.eya-address').fill('https://example.test/next-page');
    await page.getByTitle('Navigate').click();
    await page.waitForFunction(() => window.remoteNavigations.some(item => item.url === 'https://example.test/next-page'));
    await page.evaluate(() => window.remoteHandlers.onEvent({ type: 'history', tabId: window.remoteNavigations.at(-1).tabId, entries: [{ id: 1, url: 'https://example.test/final-destination' }, { id: 2, url: 'https://example.test/next-page' }], currentIndex: 1, canGoBack: true, canGoForward: false }, 'status'));
    await page.getByTitle('Back', { exact: true }).click();
    await page.waitForFunction(() => window.remoteHistoryCalls.some(item => item.delta === -1));

    assert.equal(await page.locator('.eya-browser-tab').first().getAttribute('aria-selected'), 'true');
    const navigationsBeforeTabSwitch = await page.evaluate(() => window.remoteNavigations.length);
    await page.getByTitle('New tab').last().click();
    await page.locator('.eya-address').fill('https://example.test/second-tab');
    await page.getByTitle('Navigate').click();
    await page.waitForFunction(() => window.remoteNavigations.some(item => item.url === 'https://example.test/second-tab'));
    await page.locator('.eya-browser-tab').first().click();
    assert.equal(await page.evaluate(() => window.remoteNavigations.length), navigationsBeforeTabSwitch + 1, 'switching back to a live remote tab must not reload its page');
    assert.ok(await page.evaluate(() => window.remoteActivations.length >= 3), 'Full-browser tab switches must activate the retained CDP target');
    const secondRemoteTabId = await page.evaluate(() => window.remoteNavigations.at(-1).tabId);
    await page.locator('.eya-browser-tab-close').nth(1).click();
    assert.ok((await page.evaluate(() => window.remoteTabClosures)).includes(secondRemoteTabId), 'closing a Full-browser tab must close its server-side target');

    await page.evaluate(() => window.remoteHandlers.onEvent({ type: 'popup-open', tabId: 'eya-popup-1', url: 'https://example.test/popup', title: 'Popup test' }, 'status'));
    await page.waitForFunction(() => window.remoteActivations.includes('eya-popup-1'));
    assert.equal(await page.locator('.eya-address').inputValue(), 'https://example.test/popup', 'a server popup target must become an Eya tab without client-side page navigation');
    await page.evaluate(() => window.remoteHandlers.onEvent({ type: 'tab-closed', tabId: 'eya-popup-1' }, 'status'));
    await page.waitForFunction(() => ![...document.querySelectorAll('.eya-browser-tab')].some(tab => tab.textContent.includes('Popup test')));
    assert.ok(!(await page.evaluate(() => window.remoteTabClosures)).includes('eya-popup-1'), 'a target closed by its page must be removed without sending a redundant close command');

    const box = await page.locator('.eya-browser-remote-view').boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, 'remote viewport must be visible');
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.waitForFunction(() => window.remoteInputs.some(input => input.action === 'mouseMoved'));

    await page.evaluate(() => window.remoteHandlers.onEvent({ method: 'Network.requestWillBeSent', params: { requestId: 'r1', request: { url: 'https://example.test/asset.js', method: 'GET', headers: {} } } }, 'cdp'));
    await page.evaluate(() => window.remoteHandlers.onEvent({ method: 'Network.responseReceived', params: { requestId: 'r1', response: { status: 200, mimeType: 'text/javascript', headers: {} } } }, 'cdp'));
    await page.evaluate(() => window.remoteHandlers.onEvent({ method: 'Network.loadingFinished', params: { requestId: 'r1', encodedDataLength: 22 } }, 'cdp'));
    await page.getByTitle('Toggle developer tools').click();
    await page.getByRole('tab', { name: 'Network' }).click();
    await page.getByText(/https:\/\/example\.test\/asset\.js/).waitFor();
    await page.locator('.eya-network-row').filter({ hasText: /asset\.js/ }).click();
    await page.getByRole('button', { name: 'Fetch a bounded response body from the Full browser session' }).click();
    await page.getByText(/remote response preview/).waitFor();
    assert.deepEqual(await page.evaluate(() => window.remoteNetworkBodies), ['r1']);
    await page.evaluate(() => {
      window.remoteHandlers.onEvent({ method: 'Network.requestWillBeSent', params: { requestId: 'r2', request: { url: 'https://ads.doubleclick.net/pixel', method: 'GET', headers: {} } } }, 'cdp');
      window.remoteHandlers.onEvent({ method: 'Eya.requestBlocked', params: { requestId: 'r2', url: 'https://ads.doubleclick.net/pixel', reason: 'built-in' } }, 'cdp');
    });
    await page.locator('.eya-network-row').filter({ hasText: /ads\.doubleclick\.net/ }).getByText(/blocked/i).waitFor();
    await page.getByRole('tab', { name: 'Console' }).click();
    await page.getByLabel(/JavaScript console input/).fill('6 * 7');
    await page.getByRole('button', { name: 'Evaluate console input' }).click();
    await page.locator('.eya-devtools-row[data-level="result"]').filter({ hasText: /42/ }).waitFor();

    await page.getByRole('tab', { name: 'Elements' }).click();
    await page.getByRole('button', { name: 'Inspect <p#remote-p>' }).waitFor();
    await page.getByRole('button', { name: 'Inspect <p#remote-p>' }).click();
    await page.getByLabel('Edit selected element text').fill('edited remotely');
    await page.getByRole('button', { name: 'Set selected leaf element text' }).click();
    await page.getByText('Applied in the current page.').waitFor();
    assert.ok(await page.evaluate(() => window.remoteEvaluations.some(expression => expression.includes("'__eyaDevtoolsState'"))));
    assert.ok(await page.evaluate(() => window.remoteEvaluations.some(expression => expression.includes("return{ok:true}"))));

    await page.getByRole('tab', { name: 'Sources' }).click();
    await page.evaluate(() => window.remoteHandlers.onEvent({ method: 'Debugger.paused', params: { reason: 'breakpoint', callFrames: [{ callFrameId: 'frame-1', functionName: 'work', url: 'https://example.test/app.js', location: { lineNumber: 4, columnNumber: 1 } }] } }, 'cdp'));
    await page.getByTitle('Inspect local · work variables').waitFor();
    await page.getByTitle('Inspect local · work variables').click();
    await page.getByText('count: 7').waitFor();

    await page.getByRole('tab', { name: 'Sources' }).click();
    await page.getByRole('option', { name: /Open Script source https:\/\/example\.test\/app\.js/ }).click();
    await page.getByText(/remote source loaded/).waitFor();
    assert.deepEqual(await page.evaluate(() => window.remoteSourceLoads), ['https://example.test/app.js']);

    await page.getByRole('tab', { name: 'Performance' }).click();
    await page.getByText(/DOM interactive 13 ms/).waitFor();
    await page.getByRole('button', { name: 'Record' }).click();
    await page.getByText(/remote-recorded-mark/).waitFor();
    await page.getByRole('button', { name: 'Stop' }).click();
    assert.ok(await page.evaluate(() => window.remoteEvaluations.some(expression => expression.includes('eya-performance-start'))));
    assert.ok(await page.evaluate(() => window.remoteEvaluations.some(expression => expression.includes('eya-performance-drain'))));

    await page.getByRole('tab', { name: 'Storage' }).click();
    await page.getByText(/localStorage local-key: local-value/).waitFor();
    await page.getByText(/sessionStorage session-key: session-value/).waitFor();
    await page.getByText(/Cookie remote-session: secret-cookie \[HttpOnly\] \[Secure\]/).waitFor();
    await page.getByTitle('Clear stored data and cookies for the current origin').click();
    await page.waitForFunction(() => window.remoteSiteDataClears.includes('https://example.test'));

    await page.evaluate(() => {
      window.remoteHandlers.onEvent({ type: 'download-start', id: 17, url: 'https://example.test/report.bin', filename: 'report.bin' }, 'status');
      window.remoteHandlers.onEvent({ type: 'download-progress', id: 17, receivedBytes: 4, totalBytes: 4 }, 'status');
      window.remoteHandlers.onDownload(new TextEncoder().encode('data'), { id: 17, filename: 'report.bin' });
    });
    await page.getByRole('tab', { name: 'Downloads' }).click();
    await page.getByText(/report\.bin · ready · 4 bytes/).waitFor();
    await page.getByRole('button', { name: 'Save report.bin' }).click();
    await page.getByText(/report\.bin · saved/).waitFor();

    await page.getByRole('tab', { name: 'Extensions' }).click();
    await page.getByText(/No extensions loaded in this Full browser session/).waitFor();
    await page.evaluate(() => {
      const input = document.querySelector('input[webkitdirectory]');
      const transfer = new DataTransfer();
      for (const [path, content] of [['manifest.json', '{"manifest_version":3,"name":"Test extension","version":"1.0","action":{"default_title":"Run test"}}'], ['content.js', '']]) {
        const file = new File([content], path.split('/').at(-1));
        Object.defineProperty(file, 'webkitRelativePath', { value: `test-extension/${path}` });
        transfer.items.add(file);
      }
      input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.getByText(/Loaded “Test extension”/).waitFor();
    assert.deepEqual(await page.evaluate(() => window.remoteExtensionUploads), [2]);
    assert.equal(await page.getByRole('button', { name: /Unavailable: extension actions/ }).isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.remoteExtensionActions), []);
    await page.getByRole('button', { name: 'Remove extension Test extension' }).click();
    await page.waitForFunction(() => window.remoteExtensionRemovals.length === 1);

    await page.evaluate(() => window.panel.onClose());
    assert.equal(await page.evaluate(() => window.remoteClosed), true, 'closing the panel must stop the server browser');
    console.log('browser remote-render panel smoke test passed');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
