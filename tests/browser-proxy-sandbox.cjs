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
      window.panels = [];
      window.makePanel = () => {
        const panel = EyaBrowser.createBrowserPanel({ serverRenderedByDefault: false,
          request: async url => ({ status: 200, url, headers: [['content-type', 'text/html']], body: new TextEncoder().encode(`<!doctype html><title>Sandbox</title><p id="ready">Ready</p><script>
            let parentAccess='blocked',frameAccess='blocked';
            try { parent.document.body.dataset.escaped='yes';parentAccess='allowed' } catch {}
            try { frameElement.removeAttribute('sandbox');frameAccess='allowed' } catch {}
            const result={parentAccess,frameAccess,origin:globalThis.origin,stored:localStorage.getItem('secret'),cookie:document.cookie};
            if(!result.stored){localStorage.setItem('secret','private');document.cookie='token=private; Path=/'}
            document.querySelector('#ready').textContent=JSON.stringify(result);
          <\/script>`) }) });
        panel.element.style.height = '500px'; document.body.append(panel.element); panels.push(panel); return panel;
      };
      window.first = makePanel();
    });
    await page.evaluate(() => first.api.navigate('https://fixture.test/one'));
    const firstFrame = page.locator('.eya-browser-frame').first();
    const result = async locator => {
      await locator.contentFrame().locator('#ready').filter({ hasText: 'parentAccess' }).waitFor();
      return JSON.parse(await locator.contentFrame().locator('#ready').textContent());
    };
    assert.deepEqual(await result(firstFrame), { parentAccess: 'blocked', frameAccess: 'blocked', origin: 'null', stored: null, cookie: '' });
    assert.equal(await firstFrame.getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await page.evaluate(() => document.body.dataset.escaped), undefined);
    await page.evaluate(() => first.api.navigate('https://fixture.test/two'));
    assert.equal((await result(firstFrame)).stored, 'private', 'Virtual local storage survives same-panel navigation');
    await page.evaluate(() => { window.second = makePanel(); return second.api.navigate('https://fixture.test/one'); });
    const secondFrame = page.locator('.eya-browser-frame').nth(1);
    assert.equal((await result(secondFrame)).stored, null, 'Another panel must not inherit private virtual storage');
    assert.equal((await result(secondFrame)).cookie, '', 'Cookies must remain per-panel');
    assert.equal(await secondFrame.getAttribute('sandbox'), 'allow-scripts');
    await page.evaluate(() => panels.forEach(panel => panel.onClose()));
    await page.evaluate(() => { window.third = makePanel(); return third.api.navigate('https://fixture.test/one'); });
    assert.equal((await result(page.locator('.eya-browser-frame').last())).stored, null, 'Closing a panel must not seed later panels with secret state');
    await page.evaluate(() => third.onClose());
    console.log('Proxy sandbox: opaque origin, parent/frame isolation, fixed allow-scripts policy, same-panel storage and cross-panel cookie/storage isolation passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
