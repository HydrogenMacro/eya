const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { chromium } = require('playwright');

function exportsFrom(filename) {
  const source = path.resolve(filename), loaded = new Module(source, module);
  loaded.filename = source; loaded.paths = Module._nodeModulePaths(path.dirname(source));
  loaded._compile(buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, source);
  return loaded.exports;
}
const scriptUrl = source => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(source);
const cssUrl = source => 'data:text/css;charset=utf-8,' + encodeURIComponent(source);
const escapeScript = source => source.replace(/<\/script/gi, '<\\/script');

async function main() {
  const { installProxyDomResources, prepareProxyStaticResources } = exportsFrom('client/browser-proxy-dom.js');
  const { browserFrameCsp, scanHtmlTagTokens } = exportsFrom('client/browser-panel.js');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE });
  const requests = [], calls = [];
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.route('**/*', route => { requests.push(route.request().url()); return route.abort('blockedbyclient'); });
    const sources = new Map([
      ['property.js', `window.executions.push('property');window.identities.push(document.currentScript.src);`],
      ['attribute.js', `window.executions.push('attribute');`],
      ['fragment.js', `window.executions.push('fragment');`],
      ['connected.js', `window.executions.push('connected');`],
      ['slow.js', `window.order.push('slow');`],
      ['fast.js', `window.order.push('fast');`],
      ['removed.js', `window.executions.push('removed');`],
      ['cancelled.js', `window.executions.push('cancelled');`],
      ['obsolete.js', `window.executions.push('obsolete');`],
      ['replacement.js', `window.executions.push('replacement');`],
      ['shadow.js', `window.executions.push('shadow');`],
      ['a.js', `window.order.push('a');window.depA=true;window.identities.push(document.currentScript.src);`],
      ['b.js', `if(!window.depA)throw Error('Missing parser dependency');window.order.push('b');window.depB=true;`],
      ['c.js', `if(!window.depB)throw Error('Missing defer dependency');window.order.push('c');window.depC=true;`],
    ]);
    await page.exposeBinding('__proxyTestLoad', async (_, url, kind, options) => {
      const name = new URL(url).pathname.split('/').pop(); calls.push({ url, kind, options });
      if (['slow.js','removed.js','cancelled.js','obsolete.js'].includes(name)) await new Promise(resolve => setTimeout(resolve, 120));
      if (name === 'failure.js') throw Error('Fixture upstream failure');
      if (kind === 'stylesheet') return cssUrl('.shadow-probe{color:rgb(12,34,56)}');
      if (kind === 'image') return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>');
      assert.ok(sources.has(name), 'Unexpected fixture script: ' + url);
      return scriptUrl(sources.get(name));
    });
    await page.setContent('<!doctype html><iframe sandbox="allow-scripts"></iframe>');
    const bootstrap = `window.executions=[];window.order=[];window.identities=[];window.errors=[];window.resourceFailures=[];addEventListener('error',e=>window.errors.push(String(e.message)));window.domTools=(${installProxyDomResources.toString()})({load:(...args)=>window.__proxyTestLoad(...args),loadModule:async()=>{throw Error('Not used')},getUrl:()=>"https://docs.test/base/",report:error=>window.resourceFailures.push(error)});`;
    const documentSource = contents => '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="' + browserFrameCsp() + '"><script>' + escapeScript(bootstrap) + '</script></head><body>' + contents + '</body></html>';
    await page.locator('iframe').evaluate((frame, source) => { frame.srcdoc = source; }, documentSource(''));
    let frame = page.frames().find(frame => frame.parentFrame() === page.mainFrame());
    await frame.waitForFunction(() => !!window.domTools);
    assert.equal(await frame.evaluate(() => location.origin), 'null');
    assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');

    await frame.evaluate(() => {
      const property = document.createElement('script'); property.src = 'property.js'; document.head.appendChild(property);
      const attribute = document.createElement('script'); attribute.setAttribute('src', 'attribute.js'); document.head.append(attribute);
      const fragment = document.createDocumentFragment(), script = document.createElement('script'); script.src = 'fragment.js'; fragment.append(script); document.head.appendChild(fragment);
      const connected = document.createElement('script'); document.head.appendChild(connected); connected.src = 'connected.js';
    });
    await frame.waitForFunction(() => window.executions.length === 4);
    assert.deepEqual((await frame.evaluate(() => window.executions)).sort(), ['attribute','connected','fragment','property']);
    assert.deepEqual(await frame.evaluate(() => window.identities), ['https://docs.test/base/property.js']);

    await frame.evaluate(() => {
      for (const name of ['slow.js','fast.js']) { const script = document.createElement('script'); script.async = false; script.src = name; document.head.appendChild(script); }
    });
    await frame.waitForFunction(() => window.order.length === 2);
    assert.deepEqual(await frame.evaluate(() => window.order), ['slow','fast'], 'Ordered dynamic scripts execute in insertion order despite reversed fetch completion');

    await frame.evaluate(() => {
      window.errorEvents = 0;
      const script = document.createElement('script'); script.onerror = () => window.errorEvents++;
      script.src = 'failure.js'; document.head.appendChild(script);
    });
    await frame.waitForFunction(() => window.errorEvents > 0);
    assert.equal(await frame.evaluate(() => window.errorEvents), 1);
    assert.match((await frame.evaluate(() => window.resourceFailures)).join('\n'), /Fixture upstream failure/);

    // A native SRI rejection already dispatched its error event. The proxy must
    // report the failure without synthesizing a second loader callback.
    await frame.evaluate(() => {
      window.nativeErrorEvents=0;
      const script=document.createElement('script');
      script.integrity='sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      script.onerror=()=>window.nativeErrorEvents++;
      script.src='property.js';document.head.appendChild(script);
    });
    await frame.waitForFunction(()=>window.nativeErrorEvents>0);
    await page.waitForTimeout(50);
    assert.equal(await frame.evaluate(()=>window.nativeErrorEvents),1,'Native resource errors must not be dispatched twice');

    await frame.evaluate(() => {
      const removed = document.createElement('script'); removed.src = 'removed.js'; document.head.appendChild(removed); removed.remove();
      const cancelled = document.createElement('script'); cancelled.src = 'cancelled.js'; document.head.appendChild(cancelled); cancelled.removeAttribute('src');
      const stale = document.createElement('script'); stale.src = 'obsolete.js'; document.head.appendChild(stale); stale.src = 'replacement.js';
    });
    await frame.waitForFunction(() => window.executions.includes('replacement'));
    await page.waitForTimeout(180);
    const executed = await frame.evaluate(() => window.executions);
    assert.ok(!executed.includes('removed'), 'Removed pending script must not execute');
    assert.ok(!executed.includes('cancelled'), 'Removing src must cancel its pending resource');
    assert.ok(!executed.includes('obsolete'), 'Replacing src must prevent stale execution');

    await frame.evaluate(() => {
      const host = document.createElement('div'); document.body.append(host); const root = host.attachShadow({ mode:'open' });
      const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = 'shadow.css';
      const script = document.createElement('script'); script.src = 'shadow.js';
      const image = document.createElement('img'); image.src = 'shadow.svg'; image.id = 'shadow-image';
      const probe = document.createElement('p'); probe.className = 'shadow-probe'; probe.textContent = 'Shadow text';
      root.append(style, script, image, probe); window.testShadow = root;
    });
    await frame.waitForFunction(() => window.executions.includes('shadow') && getComputedStyle(testShadow.querySelector('.shadow-probe')).color === 'rgb(12, 34, 56)' && testShadow.querySelector('img').naturalWidth === 2);
    await frame.evaluate(() => {
      const image = document.createElement('img');
      image.id = 'inline-image';
      image.setAttribute('data-eya-src', 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"/>'));
      testShadow.append(image);
    });
    await frame.waitForFunction(() => testShadow.getElementById('inline-image').naturalWidth === 3);
    assert.ok(calls.some(call => call.url === 'https://docs.test/base/shadow.css' && call.kind === 'stylesheet'));

    // Exercise the production static preloader with the real HTML token scanner
    // before the native parser sees srcdoc. The bootstrap remains the first script.
    const prepared = await page.evaluate(async ({ prepare, scan, html }) => {
      const prepareResources = (0,eval)('(' + prepare + ')'), scanTags = (0,eval)('(' + scan + ')');
      const parseTag = (source, tag) => {
        const template = document.createElement('template'); template.innerHTML = source.slice(tag.start,tag.end);
        return template.content.firstElementChild;
      };
      return prepareResources(html, 'https://docs.test/base/', (...args) => window.__proxyTestLoad(...args), parseTag, scanTags);
    }, { prepare:prepareProxyStaticResources.toString(), scan:scanHtmlTagTokens.toString(), html:'<script data-eya-src="a.js"></script><script defer data-eya-src="b.js"></script><script defer data-eya-src="c.js"></script><template><script data-eya-src="unused.js"></script></template><script>addEventListener("DOMContentLoaded",()=>{window.order.push("dom:"+String(!!window.depC))})</script>' });
    assert.ok(prepared.includes('data-eya-original-src="https://docs.test/base/a.js"'));
    assert.ok(!calls.some(call => call.url.endsWith('/unused.js')), 'Template contents remain inert');
    await page.locator('iframe').evaluate((iframe, source) => { iframe.srcdoc = source; }, documentSource(prepared));
    frame = page.frames().find(frame => frame.parentFrame() === page.mainFrame());
    await frame.waitForFunction(() => window.order?.includes('dom:true'));
    assert.deepEqual(await frame.evaluate(() => window.order), ['a','b','c','dom:true']);
    assert.deepEqual(await frame.evaluate(() => window.identities), ['https://docs.test/base/a.js']);
    assert.deepEqual(await frame.evaluate(() => window.errors), []);
    assert.deepEqual(requests, [], 'Opaque frame must not reach a native HTTP request route');
    assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
    console.log('Proxy DOM: pre-insertion/property/attribute/fragment hooks, ordered scripts/currentScript, failures, cancellation/stale work, shadow resources and native parser/defer/DOMContentLoaded order passed.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
