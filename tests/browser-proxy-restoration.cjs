const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');
(async () => {
  const bundle = buildSync({ entryPoints: [path.resolve('client/browser-panel.js')], bundle: true, platform: 'browser', format: 'iife', globalName: 'EyaBrowser', write: false }).outputFiles[0].text;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank'); await page.addScriptTag({ content: bundle });
    await page.evaluate(() => {
      window.requests = []; window.reconnects = 0;
      window.makePanel = () => {
        const panel = EyaBrowser.createBrowserPanel({ serverRenderedByDefault: false,
          reconnectProxy: async () => { reconnects++; panel.api.setProxyConnectionState('ready'); },
          request: async (url, options = {}) => {
            requests.push({ url, method: options.method || 'GET' });
            if (url.endsWith('/failure')) throw Error('Fixture unsupported. Use Browser.');
            return { status: 200, url, headers: [['content-type', 'text/html']], body: new TextEncoder().encode(`<title>${new URL(url).pathname}</title><p>Fixture</p><form method="post" action="/submit"><button>Submit</button></form>`) };
          } });
        panel.element.style.height = '650px'; document.body.append(panel.element); return panel;
      };
      window.original = makePanel();
    });
    await page.evaluate(() => original.api.navigate('https://fixture.test/first'));
    await page.evaluate(() => { original.api.newTab('https://fixture.test/second'); });
    await page.waitForFunction(() => original.api.proxyState.tabs[1]?.url === 'https://fixture.test/second');
    await page.getByLabel('Browser options').click(); await page.getByTitle('Zoom in', { exact: true }).click();
    await page.getByLabel('Browser options').click();
    const snapshot = await page.evaluate(() => original.api.proxyState);
    assert.deepEqual(snapshot, { v: 1, tabs: [{ url: 'https://fixture.test/first' }, { url: 'https://fixture.test/second' }], active: 1, zoom: 1.1 });
    await page.evaluate(() => {
      original.onClose(); original.element.remove(); requests.length = 0;
      window.restored = makePanel();
    });
    assert.equal(await page.evaluate(state => restored.api.restoreProxyState(state), snapshot), true);
    await page.waitForFunction(() => requests.length === 1 && restored.api.restorableUrl === 'https://fixture.test/second');
    assert.deepEqual(await page.evaluate(() => requests), [{ url: 'https://fixture.test/second', method: 'GET' }], 'Only active saved GET loads initially');
    assert.equal(await page.locator('.eya-browser-frame').last().getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await page.locator('.eya-browser-frame').last().evaluate(frame => frame.style.transform), 'scale(1.1)');
    await page.getByLabel('Browser tabs', { exact: true }).click();
    await page.locator('.eya-browser-tab').first().click();
    await page.waitForFunction(() => requests.length === 2 && restored.api.restorableUrl === 'https://fixture.test/first');
    await page.evaluate(() => restored.api.setProxyConnectionState('closed'));
    await page.getByRole('button', { name: 'Reconnect the proxy without reloading pages' }).click();
    assert.equal(await page.evaluate(() => reconnects), 1);
    assert.equal(await page.evaluate(() => requests.length), 2, 'Reconnect never reloads pages');
    await page.locator('.eya-browser-frame').first().contentFrame().getByRole('button', { name: 'Submit' }).click();
    await page.waitForFunction(() => requests.some(request => request.method === 'POST') && restored.api.url === 'https://fixture.test/submit');
    assert.equal((await page.evaluate(() => restored.api.proxyState)).tabs[0].url, '', 'POST result is blank in snapshot');
    await page.evaluate(() => restored.api.navigate('https://fixture.test/failure'));
    assert.equal((await page.evaluate(() => restored.api.proxyState)).tabs[0].url, '', 'Failed GET is blank in snapshot');
    await page.getByText('Fixture unsupported. Use Browser.', { exact: true }).waitFor();
    await page.evaluate(() => restored.onClose());
    console.log('Proxy restoration: multi-tab GET state, lazy inactive load, active/zoom/sandbox retention, no reconnect reload or POST/failure replay passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
