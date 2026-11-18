// Uses the production panel, encrypted transport and server CDP input path.
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { chromium } = require('playwright');
const { fixture, KEY } = require('./continuity-fixture.cjs');
(async () => {
  const f = await fixture({ env: { EYA_BROWSER_CHROMIUM: process.env.EYA_BROWSER_EXECUTABLE || chromium.executablePath() } });
  let browser;
  try {
    const code = buildSync({ stdin: { contents: "export {createBrowserPanel} from './client/browser-panel.js';export {createBrowserRenderTransport} from './client/browser-transport.js';", resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', globalName: 'EyaBrowser', write: false, alias: { 'sodium-universal': path.resolve('client/sodium-browser.js') } }).outputFiles[0].text;
    browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE });
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    page.on('pageerror', error => console.error('Client error:', error.message));
    // A real loopback response establishes the browser's local address space;
    // fulfilling a route synthetically triggers Chromium's local-network gate.
    await page.goto(`${f.http}/browser-input-test`);
    await page.evaluate(() => { document.body.replaceChildren(); document.body.style.margin = '0'; });
    await page.addScriptTag({ content: code });
    await page.evaluate(({ url, key }) => {
      window.events = [];
      window.panel = EyaBrowser.createBrowserPanel({ request: async () => {}, openRemoteBrowser: async handlers => {
        const transport = await EyaBrowser.createBrowserRenderTransport({ url, key, ...handlers, onEvent(value, channel) { events.push(value); handlers.onEvent(value, channel); } });
        window.transport = transport;
        // Use an inert document: the test requires no public network destination.
        transport.navigate = async (_, id) => {
          window.tabId = id;
          await transport.evaluate(id, `document.body.innerHTML='<p style="font:30px monospace;margin:30px 0">hello remote selection world</p><a href="https://example.test/" style="display:block;width:180px">link</a><div style="cursor:col-resize;width:180px">resize</div><input value="field">';true`);
          window.fixtureReady = true;
        };
        return transport;
      } });
      document.body.append(panel.element); panel.element.style.cssText = 'width:800px;height:550px'; panel.api.navigate('https://example.test/');
    }, { url: f.url, key: KEY });
    try { await page.waitForFunction(() => window.fixtureReady && window.transport?.capabilities.includes('cursor-v1'), null, { timeout: 12000 }); }
    catch (error) { console.error(await page.evaluate(() => ({ events, ready: window.fixtureReady, status: document.querySelector('.eya-browser-status')?.textContent, transport: !!window.transport }))); throw error; }
    await page.waitForFunction(() => document.querySelector('.eya-browser-remote-view').naturalWidth > 0);
    const geometry = async () => JSON.parse((await page.evaluate(() => transport.evaluate(tabId, "(()=>{const p=document.querySelector('p').getBoundingClientRect(),a=document.querySelector('a').getBoundingClientRect(),d=document.querySelector('div').getBoundingClientRect(),i=document.querySelector('input').getBoundingClientRect();return JSON.stringify({width:innerWidth,height:innerHeight,p:{x:p.x,y:p.y,width:p.width,height:p.height},a:{x:a.x+10,y:a.y+8},d:{x:d.x+10,y:d.y+8},i:{x:i.x+10,y:i.y+8}})})()"))).result);
    const g = await geometry();
    await page.waitForFunction(width => document.querySelector('.eya-browser-remote-view').naturalWidth === width, g.width);
    const bounds = await page.locator('.eya-browser-text-surface').boundingBox();
    const scale = Math.min(bounds.width / g.width, bounds.height / g.height), left = bounds.x + (bounds.width - g.width * scale) / 2, top = bounds.y + (bounds.height - g.height * scale) / 2;
    const move = async (x, y) => page.mouse.move(left + x * scale, top + y * scale);
    const selection = () => page.evaluate(async () => (await transport.evaluate(tabId, 'getSelection().toString()')).result);
    await move(g.p.x + 3, g.p.y + 15); await page.mouse.down();
    await page.mouse.move(left + (g.p.x + 220) * scale, top + (g.p.y + 15) * scale, { steps: 10 }); await page.mouse.up();
    assert.match(await selection(), /hello remote/, 'drag selects real remote text');
    await move(g.a.x, g.a.y); await page.waitForFunction(() => document.querySelector('.eya-browser-text-surface').style.cursor === 'pointer');
    await move(g.p.x + 35, g.p.y + 15); await page.waitForFunction(() => document.querySelector('.eya-browser-text-surface').style.cursor === 'text');
    await move(g.d.x, g.d.y); await page.waitForFunction(() => document.querySelector('.eya-browser-text-surface').style.cursor === 'col-resize');
    await page.evaluate(() => globalThis.transport.evaluate(tabId, '__eyaCursor("url(https://bad.test/cursor),pointer");true'));
    assert.equal(await page.locator('.eya-browser-text-surface').evaluate(el => el.style.cursor), 'col-resize', 'cursor URLs are rejected');
    await page.mouse.dblclick(left + (g.p.x + 155) * scale, top + (g.p.y + 15) * scale);
    assert.equal(await selection(), 'remote', 'double click selects a word');
    // Separate gesture so the manual click counter starts a fresh sequence.
    await page.waitForTimeout(500);
    for (let index = 0; index < 3; index++) await page.mouse.click(left + (g.p.x + 155) * scale, top + (g.p.y + 15) * scale);
    assert.match(await selection(), /hello remote selection world/, 'triple click selects a paragraph');
    await move(g.i.x, g.i.y); await page.waitForFunction(() => document.querySelector('.eya-browser-text-surface').style.cursor === 'text');
    await page.locator('.eya-browser-text-surface').dispatchEvent('pointerleave');
    assert.equal(await page.locator('.eya-browser-text-surface').evaluate(el => el.style.cursor), 'default', 'leaving the page resets the cursor');
    await move(g.d.x, g.d.y); await page.waitForFunction(() => document.querySelector('.eya-browser-text-surface').style.cursor === 'col-resize');
    await page.evaluate(() => transport.close());
    await page.waitForFunction(() => document.querySelector('.eya-browser-text-surface').style.cursor === 'default');
    await page.evaluate(() => panel.onClose());
    console.log('Live panel → Noise → Chromium drag selection, double/triple click, cursor keywords and cursor-URL rejection passed.');
  } finally { await browser?.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
