const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');

(async () => {
  const bundle = buildSync({ entryPoints: ['client/browser-panel.js'], bundle: true, platform: 'browser', format: 'iife', globalName: 'EyaBrowserPanel', write: false });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage();
    await page.route('http://example.test/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await page.goto('http://example.test/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      window.acks = []; window.decoders = [];
      HTMLImageElement.prototype.decode = function () { return new Promise((resolve, reject) => window.decoders.push({ resolve, reject })); };
      const panel = EyaBrowserPanel.createBrowserPanel({
        request: async () => {}, openWebSocket: async () => {},
        openRemoteBrowser: async handlers => {
          window.handlers = handlers;
          return { ready: true, start() { handlers.onEvent({ type: 'ready' }, 'status'); }, activateTab() { return Promise.resolve({}); }, navigate(url, tabId) { window.tabId = tabId; }, resize() {}, privacy() {}, filters() { return Promise.resolve(); }, userscripts() { return Promise.resolve(); }, ack(seq) { window.acks.push(seq); }, close() {} };
        },
      });
      document.body.append(panel.element);
      window.panel = panel;
      window.sendFrame = seq => window.handlers.onFrame(new Uint8Array([1, 2, 3]), { seq, tabId: window.tabId });
      panel.api.navigate('https://example.test/');
    });
    await page.waitForFunction(() => window.tabId);
    const view = page.locator('.eya-browser-remote-view');
    await page.evaluate(() => window.sendFrame(1));
    assert.equal(await view.getAttribute('src'), null);
    await page.evaluate(() => window.decoders.shift().resolve());
    await page.waitForFunction(() => window.acks.includes(1));
    const first = await view.getAttribute('src');
    await page.evaluate(() => window.sendFrame(2));
    assert.equal(await view.getAttribute('src'), first, 'retain the previous frame while decoding');
    assert.deepEqual(await page.evaluate(() => window.acks), [1]);
    await page.evaluate(() => window.decoders.shift().reject(Error('bad image')));
    await page.waitForFunction(() => window.acks.includes(2));
    assert.equal(await view.getAttribute('src'), first, 'retain the previous frame after a decode error');
    await page.evaluate(() => { window.sendFrame(3); window.decoders.shift().resolve(); });
    await page.waitForFunction(() => window.acks.includes(3));
    assert.notEqual(await view.getAttribute('src'), first);
    await page.evaluate(() => window.panel.onClose());
    console.log('Remote browser frame presentation passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
