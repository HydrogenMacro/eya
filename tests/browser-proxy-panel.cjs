const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');

(async () => {
  const bundle = buildSync({ entryPoints: [path.resolve('client/browser-panel.js')], bundle: true, platform: 'browser', format: 'iife', globalName: 'EyaBrowser', write: false }).outputFiles[0].text;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await page.goto('about:blank'); await page.addScriptTag({ content: bundle });
    await page.evaluate(() => {
      window.requests = []; window.changes = 0;
      window.panel = EyaBrowser.createBrowserPanel({ serverRenderedByDefault: false,
        onStateChange() { window.changes++; },
        request: async (url, options) => {
          window.requests.push({ url, method: options.method || 'GET' });
          return { status: 200, url, headers: [['content-type', 'text/html']], body: new TextEncoder().encode('<!doctype html><title>Proxy fixture</title><p>Selectable proxy text</p><a href="https://fixture.test/next">Next</a><form action="https://fixture.test/submitted" method="post"><input name="answer" value="yes"><input name="method" value="clobber" hidden><input name="target" value="clobber" hidden><input name="enctype" value="clobber" hidden><button id="action" name="reportValidity">Submit</button></form>') };
        },
        readLocalFile: async path => {
          if (path === '/slow.html') return new Promise(resolve => { window.finishLocal = () => resolve({ meta: { path }, bytes: new TextEncoder().encode('<p>Late local</p>') }); });
          return { meta: { path }, bytes: new TextEncoder().encode('<title>Local fixture</title><p>Local document</p><script>parent.__localScriptRan=true</script>') };
        },
      });
      document.body.append(panel.element); panel.element.style.cssText = 'height:720px;width:100%';
    });
    assert.equal(await page.evaluate(() => panel.kind), 'proxy-browser');
    await page.getByText('Experimental · Some requests may use this device’s network.').waitFor();
    await page.getByLabel('Browser options').click();
    assert.equal(await page.getByRole('button', { name: 'Open a local HTML file', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Save current page as PDF', exact: true }).count(), 0);
    assert.equal(await page.getByLabel('Stream encoding', { exact: true }).count(), 0);
    await page.getByLabel('Browser options').click();
    await page.getByLabel('Address or search').fill('https://fixture.test/'); await page.getByLabel('Address or search').press('Enter');
    const frame = page.frameLocator('.eya-browser-frame');
    await frame.getByText('Selectable proxy text').waitFor();
    assert.equal(await page.evaluate(() => panel.api.restorableUrl), 'https://fixture.test/');
    await frame.getByRole('link', { name: 'Next', exact: true }).click();
    await page.waitForFunction(() => panel.api.url === 'https://fixture.test/next');
    await page.getByLabel('Browser options').click(); await page.getByTitle('Zoom in', { exact: true }).click();
    assert.equal(await page.locator('.eya-browser-frame').evaluate(el => el.style.transform), 'scale(1.1)');
    const geometry = await page.locator('.eya-browser-frame').evaluate(el => ({ frame: el.getBoundingClientRect().width, content: el.parentElement.getBoundingClientRect().width }));
    assert.ok(Math.abs(geometry.frame - geometry.content) < 2, 'Zoom preserves the panel width');
    await page.getByLabel('Browser options').click();
    await frame.getByRole('button', { name: 'Submit', exact: true }).click();
    await page.waitForFunction(() => requests.some(request => request.method === 'POST'));
    await page.waitForFunction(() => panel.api.url === 'https://fixture.test/submitted');
    assert.equal(await page.evaluate(() => panel.api.restorableUrl), '', 'A submitted page must not restore by replaying the request');
    await page.getByLabel('Browser options').click(); await page.getByRole('button', { name: 'Open a local HTML file', exact: true }).click();
    await page.getByLabel('Path to local HTML file under the Eya file root').fill('/slow.html');
    await page.getByRole('button', { name: 'Open the selected local HTML file' }).click();
    await page.getByRole('button', { name: 'Cancel opening a local document' }).click();
    await page.evaluate(() => window.finishLocal());
    assert.equal(await page.locator('.html-viewer').count(), 0, 'Cancel must discard a pending local document');
    await page.getByRole('button', { name: 'Open a local HTML file', exact: true }).click();
    await page.getByLabel('Path to local HTML file under the Eya file root').fill('/index.html');
    await page.getByRole('button', { name: 'Open the selected local HTML file' }).click();
    await page.frameLocator('.html-viewer-frame').getByText('Local document').waitFor();
    assert.equal(await page.evaluate(() => window.__localScriptRan), undefined);
    await page.getByRole('button', { name: 'Return to proxy browsing' }).click();
    await frame.getByText('Selectable proxy text').waitFor();
    assert.ok(await page.evaluate(() => changes > 0), 'Navigation reports saved-state changes');
    await page.setViewportSize({ width: 390, height: 800 });
    await page.locator('.eya-browser-actions').evaluate(el => { el.open = true; });
    await page.getByRole('button', { name: 'Toggle developer tools', exact: true }).click();
    await page.getByRole('tab', { name: 'Console panel', exact: true }).waitFor();
    assert.equal(await page.locator('.eya-web-browser').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'Proxy tools must fit a narrow panel');
    await page.evaluate(() => panel.onClose());
    console.log('Proxy panel: separate controls, navigation/forms, sessionless safe restore URL, zoom, local HTML and pending-open cancellation passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
