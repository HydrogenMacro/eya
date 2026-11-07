const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');

async function main() {
  const bundle = buildSync({ entryPoints: ['client/browser-panel.js'], bundle: true, platform: 'browser', format: 'iife', globalName: 'EyaBrowserPanel', write: false }).outputFiles[0].text;
  const svg = fs.readFileSync('client/hosted.svg');
  const generator = fs.readFileSync('client/generator.js', 'utf8');
  const prelude = generator.match(/function svgPrelude\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(prelude, 'standalone SVG prelude must exist');
  const standalone = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><foreignObject width="100%" height="100%"><html xmlns="http://www.w3.org/1999/xhtml"><head/><body/></html></foreignObject><script><![CDATA[(${prelude})();]]></script></svg>`;
  const server = http.createServer((request, response) => {
    if (request.url === '/client.svg') { response.writeHead(200, { 'content-type': 'image/svg+xml' }); response.end(svg); }
    else if (request.url === '/standalone.svg') { response.writeHead(200, { 'content-type': 'image/svg+xml' }); response.end(standalone); }
    else { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><html><head></head><body></body></html>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
    const page = await browser.newPage();
    for (const name of ['client.svg', 'standalone.svg']) {
      await page.goto(`http://127.0.0.1:${server.address().port}/${name}`);
      await page.waitForFunction(() => !!document.body && !!document.head);
      const result = await page.evaluate(code => {
        const module = Function(`${code}; return EyaBrowserPanel;`)();
        window.svgNavigations = [];
        const panel = module.createBrowserPanel({ request: async () => { throw Error('not used'); }, openRemoteBrowser: async () => ({ ready: true, start() {}, privacy() {}, resize() {}, async activateTab() { return {}; }, navigate(url) { window.svgNavigations.push(url); }, closeTab() {}, close() {} }) });
        document.body.append(panel.element);
        return { namespace: panel.element.namespaceURI, styles: !!document.head.querySelector('#eya-browser-panel-styles'), mounted: !!document.body.querySelector('.eya-web-browser') };
      }, bundle);
      assert.deepEqual(result, { namespace: 'http://www.w3.org/1999/xhtml', styles: true, mounted: true }, name);
      await page.getByLabel('Address or search').fill('https://example.test/');
      await page.getByTitle('Navigate').click();
      await page.waitForFunction(() => window.svgNavigations.includes('https://example.test/'));
      await page.getByLabel('Browser tabs').click();
      await page.getByTitle('New tab').click();
      assert.equal(await page.locator('.eya-browser-tab').count(), 2, name);
    }
    console.log('Browser panel mounts in hosted and standalone SVG clients.');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
