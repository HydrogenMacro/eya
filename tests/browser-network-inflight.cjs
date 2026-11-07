const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');

async function main() {
  const source = path.resolve(__dirname, '../client/browser-panel.js');
  const bundle = buildSync({ entryPoints: [source], bundle: true, platform: 'browser', format: 'iife', globalName: 'EyaBrowser', write: false });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(async () => {
      const encoder = new TextEncoder();
      const userScript = `// ==UserScript==\n// @name Resource fixture\n// @match https://example.test/*\n// @grant GM_getResourceURL\n// @resource pixel https://example.test/pixel.gif\n// @run-at document-end\n// ==/UserScript==\nconst img=new Image();img.onload=()=>document.querySelector('#asset-check').dataset.resourceLoaded='yes';img.src=GM_getResourceURL('pixel');`;
      const stored = new Map([['eya-browser-userscripts-v1', JSON.stringify([{ id: 'resource-test', enabled: true, source: userScript }])]]);
      Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)) } });
      window.__networkStream = null;
      window.__resourceRequests = [];
      const request = async rawUrl => {
        const url = new URL(rawUrl).href;
        window.__resourceRequests.push(url);
        if (url === 'https://example.test/pixel.gif') {
          const bytes = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='), char => char.charCodeAt(0));
          return { status: 200, url, headers: [['content-type', 'image/gif']], cookies: [], body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
        }
        if (url === 'https://example.test/') return {
          status: 200, url, headers: [['content-type', 'text/html']], cookies: [],
          body: encoder.encode('<!doctype html><html><head><title>Network test</title><link rel="stylesheet" href="/test.css"></head><body><span id="asset-check">asset</span><script src="/test.js"></script><script>fetch("/pending").then(response=>response.text())</script></body></html>'),
        };
        if (url === 'https://example.test/test.js' || url === 'https://example.test/test.css' || url === 'https://example.test/nested.css') {
          const isScript = url.endsWith('.js');
          const quotedData = btoa('#asset-check { font-weight: 700; }');
          const unquotedData = btoa('#asset-check { border-top: 3px solid; }');
          const content = isScript ? "document.querySelector('#asset-check').dataset.scriptLoaded='yes'" : url.endsWith('/nested.css') ? '#asset-check { background-color: rgb(4, 5, 6); }' : `/* @import "/comment-fake.css"; url('/comment-fake.png') */ @import "/nested.css" screen; @import url("data:text/css;base64,${quotedData}") screen; @import url(data:text/css;base64,${unquotedData}) screen; #asset-check { color: rgb(1, 2, 3); } #asset-check::after { content: 'url("/string-fake.png")'; }`;
          return { status: 200, url, headers: [['content-type', isScript ? 'text/javascript' : 'text/css']], cookies: [], body: new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(content)); controller.close(); } }) };
        }
        if (url === 'https://example.test/pending') return new Promise(resolve => {
          window.__resolveNetworkResponse = () => resolve({
            status: 200, url, headers: [['content-type', 'text/plain']], cookies: [],
            body: new ReadableStream({ start(controller) { window.__networkStream = controller; controller.enqueue(encoder.encode('a')); } }),
          });
        });
        throw Error(`Unexpected URL ${url}`);
      };
      const panel = window.EyaBrowser.createBrowserPanel({ request, preferences: { devtoolsOpen: true } });
      window.__browserPanel = panel;
      document.body.append(panel.element);
      await panel.api.navigate('https://example.test/');
      panel.element.querySelector('[aria-label="Network panel"]').click();
    });
    const asset = page.frameLocator('.eya-browser-frame').locator('#asset-check');
    await asset.waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForFunction(() => { const frame = document.querySelector('.eya-browser-frame'); return frame?.getAttribute('sandbox') === 'allow-scripts'; });
    await page.frameLocator('.eya-browser-frame').locator('#asset-check[data-script-loaded="yes"]').waitFor({ timeout: 8000 });
    await page.frameLocator('.eya-browser-frame').locator('#asset-check[data-resource-loaded="yes"]').waitFor({ timeout: 8000 });
    assert.equal(await asset.getAttribute('data-script-loaded'), 'yes', 'proxied classic script must execute inside the opaque frame');
    assert.equal(await asset.evaluate(element => getComputedStyle(element).color), 'rgb(1, 2, 3)', 'proxied stylesheet must apply inside the opaque frame');
    assert.equal(await asset.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(4, 5, 6)', 'proxied CSS imports must preserve their media condition');
    assert.equal(await asset.evaluate(element => getComputedStyle(element).fontWeight), '700', 'quoted data URL imports must remain intact');
    assert.equal(await asset.evaluate(element => getComputedStyle(element).borderTopWidth), '3px', 'unquoted data URL imports must remain intact');
    assert.equal(await asset.evaluate(element => getComputedStyle(element, '::after').content), '"url(\\"/string-fake.png\\")"', 'CSS content strings must remain unchanged');
    assert.deepEqual(await page.evaluate(() => window.__resourceRequests.filter(url => /(?:comment|string)-fake/.test(url))), [], 'CSS comments and strings must not trigger resource requests');
    const childFrame = page.frames().find(frame => frame !== page.mainFrame());
    await childFrame.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = `/* @import "/dynamic-fake.css"; */ @import url("data:text/css;base64,${btoa('#asset-check { letter-spacing: 3px; }')}") screen; #asset-check::before { content: 'url("/dynamic-fake.png")'; }`;
      document.head.appendChild(style);
    });
    await childFrame.waitForFunction(() => getComputedStyle(document.querySelector('#asset-check')).letterSpacing === '3px', null, { timeout: 8000 });
    assert.deepEqual(await page.evaluate(() => window.__resourceRequests.filter(url => url.includes('dynamic-fake'))), [], 'dynamic CSS comments and strings must not fetch resources');
    const pending = page.locator('.eya-network-row').filter({ hasText: 'Pending' });
    await pending.first().waitFor({ state: 'visible', timeout: 8000 });
    assert.match(await pending.first().textContent(), /https:\/\/example\.test\/pending/, 'request appears before response headers');
    await page.evaluate(() => window.__resolveNetworkResponse());
    const requestRow = page.locator('.eya-network-row').filter({ hasText: '/pending' });
    await page.waitForFunction(() => [...document.querySelectorAll('.eya-network-row')].some(row => row.textContent.includes('200') && row.textContent.includes('/pending')));
    await requestRow.click();
    await page.waitForFunction(() => document.querySelector('.eya-devtools-details')?.textContent.includes('Transferred: 1 bytes'));
    const clearButton = page.locator('.eya-devtools-toolbar button[aria-label="Clear current DevTools output"]');
    await clearButton.click();
    await page.evaluate(() => window.__networkStream.close());
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.eya-network-row').count(), 0, 'completion after clearing Network must not recreate a removed row');
    await page.evaluate(() => window.__browserPanel.api.dispose());
    console.log('Network requests appear while pending, update with response metadata, and stay cleared after completion.');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exit(1); });
