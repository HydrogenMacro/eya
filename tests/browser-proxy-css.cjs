const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { chromium } = require('playwright');

async function main() {
  const filename = path.resolve('client/browser-proxy-css.js');
  const loaded = new Module(filename, module); loaded.filename = filename;
  loaded._compile(buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, filename);
  const { createProxyCssTools } = loaded.exports, tools = createProxyCssTools();
  const source = String.raw`/* url(ignored.png) @import "ignored.css" */
    @import /* preserve */ "theme\2e css" layer(docs) supports(display: grid) screen and (min-width: 1px);
    @import url('print.css') print;
    @layer docs { @font-face { font-family: Docs; src: url(font.woff2) format("woff2") } }
    body { background: URL("image\)one.svg"); mask: u\72 l(icon\(x\).svg); content: "url(no.png)"; }
    .data { background: url("data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0(1)\"/></svg>"); }
    .embedded { mask: url(\64 ata:image/svg+xml,abc); background: url("blob:kept"); filter: url(#filter); }
  `;
  const tokens = tools.scan(source);
  assert.deepEqual(tokens.map(token => [token.url, token.kind]), [
    ['theme.css','stylesheet'], ['print.css','stylesheet'], ['font.woff2','font'],
    ['image)one.svg','image'], ['icon(x).svg','image'],
    ['data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"><path d="M0(1)"/></svg>','image'],
    ['data:image/svg+xml,abc','image'], ['blob:kept','image'], ['#filter','image'],
  ]);
  const calls = [];
  const rewritten = await tools.rewrite(source, 'https://docs.test/assets/', async (url, kind) => { calls.push([url, kind]); return 'blob:proxy-' + calls.length; });
  assert.deepEqual(calls.map(call => call[0]), ['https://docs.test/assets/theme.css','https://docs.test/assets/print.css','https://docs.test/assets/font.woff2','https://docs.test/assets/image)one.svg','https://docs.test/assets/icon(x).svg']);
  assert.ok(rewritten.includes('@import /* preserve */ "blob:proxy-1" layer(docs) supports(display: grid) screen and (min-width: 1px);'));
  assert.ok(rewritten.includes(String.raw`url("data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0(1)\"/></svg>")`));
  assert.ok(rewritten.includes(String.raw`url(\64 ata:image/svg+xml,abc)`));
  assert.ok(rewritten.includes('content: "url(no.png)"'));

  // Bad URL/string tokens cannot make the scanner reinterpret their contents as
  // another valid request, and ordinary strings/comments never cause requests.
  assert.deepEqual(tools.scan(String.raw`a{b:url(a"url(evil.png));content:"url(fake)"}/*url(fake)*/`), []);
  assert.deepEqual(tools.scan('a{b:url("unterminated\n)}'), []);
  assert.equal(tools.scan(String.raw`@import "line\
break.css";`)[0].url, 'linebreak.css');
  assert.equal(tools.scan(String.raw`a{b:u\000072l(\000066 ont.svg)}`)[0].url, 'font.svg');
  assert.equal(tools.scan('a{b:url("zero\\0 replacement.svg")}')[0].url, 'zero\ufffdreplacement.svg');
  assert.throws(() => tools.scan('a'.repeat(33), { maxChars: 32 }), /character limit/);
  assert.throws(() => tools.scan('url(a)url(b)', { maxResources: 1 }), /too many resource/);
  assert.throws(() => tools.scan('url(a)', { maxResources: -1 }), /Invalid/);
  assert.throws(() => tools.scan('{'.repeat(1025)), /nesting/);
  assert.throws(() => tools.scan('', { maxChars: 8 * 1024 * 1024 + 1 }), /character limit/);
  await assert.rejects(tools.rewrite('a{b:url(x)}', 'https://docs.test/', async () => 'x'.repeat(100), { maxChars: 32 }), /character limit/);
  const failed = await tools.rewrite('@import "bad.css" layer(x);a{b:url(bad.png)}', 'https://docs.test/', async () => { throw Error('Unavailable'); });
  assert.equal(failed, '@import "data:text/css," layer(x);a{b:url(about:blank)}');
  const escaped = await tools.rewrite('a{b:url(x)}', 'https://docs.test/', async () => 'blob:"\\\n');
  assert.equal(tools.scan(escaped)[0].url, 'blob:"\\\n');

  // The installed opaque-frame runtime must have no hidden module closure.
  const cloned = Function('return (' + createProxyCssTools.toString() + ')()')();
  assert.deepEqual(cloned.scan(source), tools.scan(source));
  assert.equal(await cloned.rewrite(source, 'https://docs.test/', async () => 'blob:proxy'), await tools.rewrite(source, 'https://docs.test/', async () => 'blob:proxy'));

  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE });
  try {
    const page = await browser.newPage();
    const svgCss = String.raw`@layer docs { body { font-family: monospace; color: rgb(12, 34, 56); --icon:url("data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0(1)\"/></svg>"); } .after { color: rgb(65, 43, 21); } }`;
    const safeCss = await tools.rewrite(svgCss, 'https://docs.test/', () => { throw Error('Embedded SVG must not be fetched'); });
    assert.equal(safeCss, svgCss, 'Escaped embedded SVG CSS must remain byte-identical');
    await page.setContent('<!doctype html><style>' + safeCss + '</style><p class="after">After embedded SVG</p>');
    const computed = await page.evaluate(() => ({ font: getComputedStyle(document.body).fontFamily, body: getComputedStyle(document.body).color, after: getComputedStyle(document.querySelector('p')).color }));
    assert.deepEqual(computed, { font: 'monospace', body: 'rgb(12, 34, 56)', after: 'rgb(65, 43, 21)' });

    if (process.env.EYA_PROXY_CSS_FIXTURE) {
      const actual = await fs.readFile(process.env.EYA_PROXY_CSS_FIXTURE, 'utf8');
      const unexpected = [];
      const output = await tools.rewrite(actual, 'https://pixijs.com/assets/css/', async (url, kind) => {
        assert.ok(!url.includes('data:image'), 'Embedded SVG must never become an upstream URL');
        unexpected.push([url, kind]); return 'data:application/octet-stream;base64,';
      });
      await page.setContent('<!doctype html><html data-theme="light"><head><style>' + output + '</style></head><body><main>Actual documentation CSS</main></body></html>');
      const font = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
      assert.equal(font, 'Roboto, "Roboto Fallback", system-ui, sans-serif', 'Real PixiJS body rules survive embedded SVG rewriting');
      console.log(`Actual PixiJS CSS: ${actual.length} characters, ${tools.scan(actual).length} URL tokens, ${unexpected.length} upstream resources, font ${font}.`);
    }
  } finally { await browser.close(); }
  console.log('Proxy CSS: escaped URLs/data SVG, imports/layers/media/supports, comments/strings, font classification, bounds, failures and browser parsing passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
