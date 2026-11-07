const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');
(async () => {
  const bundle = buildSync({ entryPoints: [path.resolve('client/browser-panel.js')], bundle: true, platform: 'browser', format: 'iife', globalName: 'EyaBrowser', write: false }).outputFiles[0].text;
  const browser = await chromium.launch({ headless: true, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 }, isMobile: true });
    await page.goto('about:blank'); await page.addScriptTag({ content: bundle });
    await page.evaluate(() => {
      window.navigations = []; window.activations = 0; window.startAttempts = 0;
      window.panel = EyaBrowser.createBrowserPanel({ request: async () => { throw Error('unexpected proxy request'); }, openRemoteBrowser: async () => ({ ready: true, start() { if (++window.startAttempts === 1) return Promise.reject(Error('Chromium could not start')); return new Promise(resolve => { window.finishStartup = resolve; }); }, privacy() {}, resize() {}, filters() { throw Error('filter sync must not block browsing'); }, async activateTab() { window.activations++; return {}; }, navigate(url) { window.navigations.push(url); }, closeTab() {}, close() {} }) });
      document.body.append(window.panel.element); window.panel.element.style.cssText = 'height:650px;width:100%';
    });
    await page.getByLabel('Address or search').fill('https://example.test/'); await page.getByTitle('Navigate').click();
    await page.getByText('Chromium could not start').waitFor();
    assert.equal(await page.evaluate(() => window.activations), 0, 'failed startup must not activate a tab');
    await page.getByTitle('Navigate').click();
    await page.waitForFunction(() => typeof window.finishStartup === 'function');
    assert.equal(await page.evaluate(() => window.activations), 0, 'tab activation must wait for Chromium readiness');
    await page.evaluate(() => window.finishStartup());
    await page.waitForFunction(() => window.navigations.includes('https://example.test/'));
    await page.getByLabel('Browser tabs').click();
    assert.equal(await page.getByTitle('New tab').count(), 1);
    await page.getByTitle('New tab').click();
    assert.equal(await page.locator('.eya-browser-tab').count(), 2);
    await page.locator('.eya-browser-tab-close').last().click();
    assert.equal(await page.locator('.eya-browser-tab').count(), 1);
    assert.equal(await page.getByTitle('Toggle developer tools').count(), 0);
    assert.equal(await page.locator('.eya-browser-bookmarks').count(), 0);
    await page.evaluate(() => window.panel.onClose());
    console.log('Mobile browser navigation and tab menu passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
