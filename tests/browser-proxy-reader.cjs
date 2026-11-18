const assert = require('node:assert/strict');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { chromium } = require('playwright');

async function main() {
  const bundle = buildSync({
    entryPoints: [path.resolve('client/browser-panel.js')], bundle: true, platform: 'browser',
    format: 'iife', globalName: 'EyaBrowser', write: false,
  }).outputFiles[0].text;
  const browser = await chromium.launch({
    headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE,
    args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [],
  });
  try {
    const page = await browser.newPage();
    const direct = [];
    await page.route(/^https?:\/\//, route => {
      direct.push(route.request().url());
      return route.abort();
    });
    await page.addInitScript(() => Object.defineProperty(window, 'navigation', { value: undefined }));
    await page.goto('about:blank');
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => {
      window.broker = [];
      window.panel = EyaBrowser.createBrowserPanel({
        serverRenderedByDefault: false,
        preferences: { devtoolsOpen: true },
        async request(url, options) {
          const target = new URL(url);
          broker.push([target.pathname + target.search, options.method]);
          const css = target.pathname === '/style.css';
          const start = '<!doctype html><html onload="document.body.dataset.ran=1"><head><title>Guide</title>'
            + '<meta http-equiv=" refresh " content="0; url=https://leak.test/refresh">'
            + '<meta http-equiv="Content-Security-Policy" content="script-src * unsafe-inline">'
            + '<link rel="prefetch" href="https://leak.test/prefetch"><link rel="stylesheet" href="/style.css">'
            + '<script src="/script.js"></' + 'script><script>document.body.dataset.ran=1</' + 'script></head>'
            + '<body><template shadowrootmode="open"><script>document.body.dataset.ran=1</' + 'script></template>'
            + '<svg><a href="https://leak.test/foreign">Foreign link</a></svg>'
            + '<main><h1>Reader guide</h1><p id="reading">Readable text for selection.</p>'
            + '<a href="#section">Jump to section</a><a href="/chapter" ping="https://leak.test/ping">Read chapter</a>'
            + '<a href="javascript:document.body.dataset.ran=1" onclick="document.body.dataset.ran=1">Script link</a>'
            + '<form action="/search"><label>Query <input name="q"></label><button>Search</button></form>'
            + '<form action="/write" method="post"><button>Post</button></form>'
            + '<div style="height:650px"></div><h2 id="section">Section heading</h2></main></body></html>';
          const body = css ? '#reading{color:rgb(12,34,56)}'
            : target.pathname === '/' ? start : '<!doctype html><h1>' + (target.pathname === '/chapter' ? 'Next chapter' : 'Search result') + '</h1>';
          const data = new TextEncoder().encode(body);
          return {
            status: 200, url,
            headers: [['content-type', css ? 'text/css' : 'text/html']],
            body: options.stream ? new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } }) : data,
          };
        },
      });
      panel.element.style.height = '500px';
      document.body.append(panel.element);
    });
    await page.getByRole('textbox', { name: 'Address or search' }).fill('https://guide.test/');
    await page.getByRole('textbox', { name: 'Address or search' }).press('Enter');
    const iframe = page.locator('.eya-browser-frame');
    const target = iframe.contentFrame();
    await target.getByRole('heading', { name: 'Reader guide' }).waitFor();
    assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
    assert.match(await page.locator('.eya-browser-status').innerText(), /Reader mode/);
    assert.equal(await target.locator('#reading').evaluate(text => getComputedStyle(text).color), 'rgb(12, 34, 56)');
    assert.equal(await target.locator('script[src], meta[http-equiv="refresh" i], svg, template, [onclick], [ping]').count(), 0);
    const csp = await target.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    assert.match(csp, /script-src 'nonce-[a-f0-9]{32}'; worker-src 'none'/);
    assert.doesNotMatch(csp, /script-src[^;]*(?:unsafe|data:|blob:)/);
    assert.equal(await target.locator('body').evaluate(body => {
      const script = document.createElement('script');
      script.textContent = 'document.body.dataset.ran=1';
      document.head.append(script);
      return body.dataset.ran;
    }), undefined, 'the reader CSP must reject an untrusted inline script');
    await target.getByRole('link', { name: 'Script link' }).click();
    await target.getByRole('button', { name: 'Post' }).click();
    assert.equal(await target.locator('body').getAttribute('data-ran'), null);
    await page.getByRole('button', { name: 'Toggle developer tools' }).waitFor({ state: 'detached' });
    assert.equal(await page.locator('.eya-devtools').first().isVisible(), false);
    await page.locator('summary[aria-label="Browser options"]').click();
    await page.getByRole('button', { name: 'Find text in the current page (Ctrl+F)' }).click();
    await page.getByRole('searchbox', { name: 'Find text in the current page' }).fill('Readable text');
    await page.getByRole('searchbox', { name: 'Find text in the current page' }).press('Enter');
    await page.locator('.eya-browser-find-status').filter({ hasText: /^Match found\.$/ }).waitFor();
    await target.getByRole('link', { name: 'Jump to section' }).click();
    await page.waitForFunction(() => panel.api.url.endsWith('#section'));
    assert.ok(await target.locator('body').evaluate(() => window.scrollY > 100), 'fragment links should scroll within the iframe');
    await target.getByRole('link', { name: 'Read chapter' }).click();
    await target.getByRole('heading', { name: 'Next chapter' }).waitFor();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await target.getByRole('heading', { name: 'Reader guide' }).waitFor();
    await target.getByRole('textbox', { name: 'Query' }).fill('network flow');
    await target.getByRole('button', { name: 'Search', exact: true }).click();
    await target.getByRole('heading', { name: 'Search result' }).waitFor();
    assert.deepEqual(await page.evaluate(() => broker), [['/', 'GET'], ['/style.css', 'GET'], ['/chapter', 'GET'], ['/', 'GET'], ['/style.css', 'GET'], ['/search?q=network+flow', 'GET']]);
    assert.deepEqual(direct, []);
    console.log('Proxy reader preserves styled reading, fragment and chapter navigation, Back and GET forms in the opaque sandbox.');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
