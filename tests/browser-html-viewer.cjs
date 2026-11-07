const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');
const Module = require('node:module');

async function main() {
  const source = path.resolve(__dirname, '../client/html-viewer.js');
  const bundle = buildSync({ entryPoints: [source], bundle: true, platform: 'browser', format: 'iife', globalName: 'EyaHTMLViewer', write: false });
  const syntaxBundle = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false });
  const loaded = new Module(source, module); loaded.filename = source; loaded.paths = Module._nodeModulePaths(path.dirname(source));
  loaded._compile(syntaxBundle.outputFiles[0].text, source);
  new Function(loaded.exports.buildLocalViewerBridge('viewer-test-nonce', 1));
  assert.doesNotMatch(loaded.exports.localHtmlViewerCsp(true), /navigate-to/, 'local Rustdoc CSP must not rely on the unsupported navigate-to directive');
  assert.match(loaded.exports.localHtmlViewerCsp(false), /connect-src 'none'/, 'scripts-off local documents must not have network connections');
  assert.equal(loaded.exports.localPath('../search.index/index.js', '/docs/crate/index.html').path, '/docs/search.index/index.js');
  assert.equal(loaded.exports.pathIsWithin(loaded.exports.localPath('%2e%2e%2Foutside.js', '/docs/index.html').path, '/docs'), false,
    'percent-encoded path separators bypassed the approved-root check');
  assert.equal(loaded.exports.localPath('https://outside.example/a.js', '/docs/index.html'), null);
  assert.equal(loaded.exports.pathIsWithin('/docs/search.index/index.js', '/docs'), true);
  assert.equal(loaded.exports.pathIsWithin('/outside.js', '/docs'), false);
  console.log('Local viewer bridge syntax and approved-root path checks passed.');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage();
    const directRequests = [];
    page.on('request', request => { if (/^https?:/i.test(request.url())) directRequests.push(request.url()); });
    await page.route('https://outside.example/**', route => route.abort());
    await page.goto('about:blank');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const fixture = {
      '/docs/search.js': `document.querySelector('#query').addEventListener('input',()=>{const index=document.createElement('script');index.onload=()=>{if(!window.__rustdocIndex?.includes('Widget'))throw Error('Rustdoc index script did not execute');Event.prototype.preventDefault=()=>{};const result=document.createElement('a');result.href='struct.Widget.html';result.textContent='Widget result';document.querySelector('#results').replaceChildren(result)};index.src='search-index.js';document.head.appendChild(index);for(const src of ['../outside.js','https://outside.example/evil.js']){const script=document.createElement('script');script.src=src;document.head.appendChild(script)}const hint=document.createElement('link');hint.rel='preconnect';hint.href='https://outside.example/dynamic';document.head.appendChild(hint)});document.body.dataset.searchReady='1';`,
      '/docs/search-index.js': `window.__rustdocIndex=['Widget'];`,
      '/other/second.html': '<!doctype html><title>Second</title><p id=section>Second document</p>',
      '/outside.js': `window.__outsideExecuted=true;`,
    };
    await page.evaluate(({ html, fixture }) => {
      const encode = value => new TextEncoder().encode(value);
      window.__fixture = fixture;
      const resources = new Map(Object.entries(window.__fixture).map(([name, value]) => [name, encode(value)]));
      resources.set('/docs/index.html', encode(html));
      window.__reads = [];
      const tab = { path: '/docs/index.html', name: 'index.html', bytes: encode(html) };
      const viewer = window.__viewer = EyaHTMLViewer.createHtmlViewer(tab, {
        async readResource(file) {
          window.__reads.push(file);
          const bytes = resources.get(file);
          if (!bytes) throw Error(`Missing test fixture ${file}`);
          return { bytes: bytes.slice() };
        },
        openFile(file) { window.__opened = file; },
      });
      document.body.append(viewer.element);
    }, { html: '<!doctype html><title>Crate</title><meta http-equiv="refresh" content="0;url=https://outside.example/refresh"><img src="https://outside.example/pixel.png"><link rel="stylesheet" href="https://outside.example/evil.css"><link rel="preconnect" href="https://outside.example"><input id="query"><div id="results"></div><a href="../other/second.html#section">Next document</a><script src="search.js"></script>', fixture });
    const frame = page.frameLocator('.html-viewer-frame');
    await frame.locator('#query').fill('Widget');
    await page.waitForTimeout(80);
    assert.equal(await frame.locator('#results a').count(), 0, 'local scripts ran before the explicit trusted-docs opt-in');
    assert.equal(await page.getByLabel('Run scripts from these local documents').count(), 0, 'the viewer must not expose unavailable script controls');
    await frame.getByRole('link', { name: 'Next document' }).click();
    await frame.getByText('Second document').waitFor();
    assert.ok((await page.evaluate(() => window.__reads)).includes('/other/second.html'), 'relative links must load through the file callback');
    await page.getByTitle('Back in HTML history').click();
    await frame.getByRole('link', { name: 'Next document' }).waitFor();
    assert.deepEqual(directRequests, [], 'local document rendering must not make direct requests');
    console.log('Local HTML viewer follows relative links with scripts disabled.');
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
