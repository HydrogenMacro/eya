// Opt-in, changing public-site characterization through the built client and real
// Noise/Rust proxy. No HTTP egress fixture, production server restart or sandbox flags.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fixture, CLIENT_TYPES } = require('./continuity-fixture.cjs');
const SWIFT_NAVIGATOR_DEADLINE_MS = 30000;
const REACT_SEARCH_DEADLINE_MS = 20000;
const FONTS = {react:'Optimistic Text',swift:'Helvetica',pixijs:'Roboto',rust:'Open Sans',python:'-apple-system',mdn:'Inter'};
const SITES = [
  { id: 'react', url: 'https://react.dev/learn', heading: 'Quick Start', link: '/learn/thinking-in-react', next: 'Thinking in React', query: 'useState' },
  { id: 'swift', url: 'https://docs.swift.org/latest/documentation/the-swift-programming-language/', heading: 'The Swift Programming Language', link: '/latest/documentation/the-swift-programming-language/guidedtour', next: 'A Swift Tour', query: 'functions' },
  { id: 'pixijs', url: 'https://pixijs.com/8.x/guides/getting-started/intro', heading: 'Introduction', link: '/8.x/guides/getting-started/quick-start', next: 'Quick Start', query: 'sprite' },
  { id: 'rust', url: 'https://doc.rust-lang.org/book/', heading: 'The Rust Programming Language', link: 'ch01-01-installation.html', next: 'Installation', query: 'ownership' },
  { id: 'python', url: 'https://docs.python.org/3/tutorial/', heading: 'The Python Tutorial', link: 'interpreter.html', next: 'Using the Python Interpreter', query: 'functions' },
  { id: 'mdn', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide', heading: 'JavaScript Guide', link: '/en-US/docs/Web/JavaScript/Guide/Introduction', next: 'Introduction', query: 'closures' },
];
const clean = value => { try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; return url.href; } catch { return String(value).slice(0, 300); } };
const diagnostic = value => String(value).replace(/data:[^\s)]+/g,'data:[omitted]').replace(/blob:[^\s)]+/g,'blob:[omitted]');
const firstLine = error => diagnostic(error.message || error).split('\n')[0].slice(0, 500);
const sha = async filename => createHash('sha256').update(await fs.readFile(filename)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  assert.equal(process.env.EYA_PROXY_PUBLIC, '1', 'Set EYA_PROXY_PUBLIC=1 to contact the listed public documentation sites.');
  const ids = (process.env.EYA_PROXY_PUBLIC_CASES || SITES.map(site => site.id).join(',')).split(',');
  assert.ok(ids.every(id => SITES.some(site => site.id === id)), 'Unknown site');
  const modes = (process.env.EYA_PROXY_PUBLIC_MODES || 'native,proxy').split(',');
  assert.ok(modes.every(mode => ['native','proxy'].includes(mode)), 'Unknown mode');
  const formatOption = process.env.EYA_PROXY_PUBLIC_FORMATS || process.env.EYA_PROXY_PUBLIC_FORMAT || 'html';
  const formats = formatOption === 'all' ? CLIENT_TYPES : [...new Set(formatOption.split(','))];
  assert.ok(formats.every(format => CLIENT_TYPES.includes(format)), 'Unknown client format');
  const variants = modes.flatMap(mode => mode === 'native' ? [{ mode, format: 'native' }] : formats.map(format => ({ mode, format })));
  const out = process.env.EYA_PROXY_PUBLIC_REPORT || '/tmp/eya-proxy-public.json';
  const captures = process.env.EYA_PROXY_PUBLIC_CAPTURES || null;
  const collectDevtools = process.env.EYA_PROXY_PUBLIC_DEVTOOLS === '1';
  if (captures) await fs.mkdir(captures, { recursive: true });
  const binary = process.env.EYA_PROXY_PUBLIC_BINARY || 'eya-server/target/debug/eya-server';
  const report = { schema: 1, generatedAt: new Date().toISOString(), version: (await fs.readFile('VERSION','utf8')).trim(), node: process.version,
    methodology: 'Built standalone client, actual authenticated Noise transport and Rust public egress; fresh native Chromium controls. Read/navigation/search/selection checks, no accounts, credentials, purchases or application forms. Proxy direct HTTP attempts blocked and counted, never used as fallback. Search and ordinary page scripts may send site telemetry. One sequential sample; timings include host load and test waits, not performance benchmarks.',
    configuration: { requireUsable: process.env.EYA_PROXY_PUBLIC_REQUIRE_USABLE === '1', ...(formats.length === 1 ? { format: formats[0] } : {}), formats, dataUrlLoopback: 'Test-only binary WebSocket relay preserves the opaque data origin and real Rust/Noise endpoint where Chromium blocks native loopback.', viewport: { width: 1440, height: 1000 }, contentDeadlineMs: 40000, interactionDeadlineMs: 10000, swiftNavigatorDeadlineMs: SWIFT_NAVIGATOR_DEADLINE_MS, styling:'Loaded sheets plus computed body font matches the native control (known family fallback for proxy-only runs); screenshots supplement, not pixel equivalence', captures }, sourceSha256: {}, rows: [] };
  for (const name of ['client.html','client/browser-panel.js','client/browser-proxy-css.js','client/browser-proxy-dom.js','client/browser-proxy-script.js','client/browser-proxy-worker.js','client/browser-transport.js','eya-server/src/browser.rs','tests/browser-proxy-public.cjs','tests/continuity-fixture.cjs']) report.sourceSha256[name] = await sha(name);
  report.serverBinarySha256 = await sha(binary);
  const f = await fixture({ binary });
  try {
    const browser = await f.getBrowser();
    report.chromium = browser.version();
    for (const site of SITES.filter(site => ids.includes(site.id))) for (const { mode, format } of variants) {
      if (!browser.isConnected()) throw Error('The test browser exited before the remaining rows ran.');
      const label = `${site.id}/${mode === 'proxy' ? format : mode}`;
      const row = { site: site.id, mode, format, ...(format === 'data-url' ? { noiseSocket: 'test-loopback-relay' } : {}), url: site.url, checks: {}, browserErrors: [], consoleErrors: [], directClientRequests: [], clientRequestFailures: [], nativeHttpErrors: [], socketStates: [], encryptedDownBytes: 0, encryptedUpBytes: 0 };
      report.rows.push(row); let page, context, id, observing=true; const started = Date.now();
      const check = async (name, action) => { const time = Date.now(); try { row.checks[name] = { outcome: 'passed', detail: await action(), elapsedMs: Date.now() - time }; } catch(error) { row.checks[name] = { outcome: 'failed', error: firstLine(error), elapsedMs: Date.now() - time }; } console.log(`${label}/${name}: ${row.checks[name].outcome}${row.checks[name].error ? ' '+row.checks[name].error : ''}`); };
      const target = () => mode === 'proxy' ? page.frames().find(frame => frame.parentFrame() === page.mainFrame()) : page.mainFrame();
      const visibleHeading = text => target().getByRole('heading', { ...(site.id === 'mdn' ? { level: 1 } : {}), name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i') }).first();
      const waitHeading = async (text, pathname) => {
        const end = Date.now() + 40000;
        while (Date.now() < end) {
          const frame = target();
          const matchesPath = !pathname || await frame?.evaluate(expected => new URL(document.baseURI).pathname.replace(/\/$/, '') === expected.replace(/\/$/, ''), pathname).catch(() => false);
          if (matchesPath && await visibleHeading(text)?.isVisible().catch(() => false)) return;
          const unavailable = await frame?.getByRole('heading', { name: 'Page unavailable', exact: true }).isVisible().catch(() => false);
          if (unavailable) throw Error((await frame.locator('body').innerText()).slice(0, 500));
          await sleep(200);
        }
        throw Error(`Expected visible article heading: ${text}`);
      };
      const followResult = async link => {
        await link.waitFor({state:'visible'});
        const href=await link.evaluate(el=>el.href);
        const expected=new URL(href);
        assert.ok(['http:','https:'].includes(expected.protocol),'Search result must link to a document');
        await link.click();
        const end=Date.now()+40000;
        while(Date.now()<end){
          const state=await target().evaluate(()=>({base:document.baseURI,heading:document.querySelector('h1')?.textContent?.trim(),text:document.body?.innerText?.length||0})).catch(()=>null);
          if(state&&new URL(state.base).pathname===expected.pathname&&state.heading&&state.text>=200)return {url:clean(href),heading:state.heading};
          await sleep(200);
        }
        throw Error(`Search result did not open its article: ${expected.pathname}`);
      };

      try {
        if (mode === 'proxy') {
          page = await f.client({ type: format, viewport: report.configuration.viewport, webgl: false, storage: true, dataUrlLoopbackRelay: format === 'data-url' });
          context = page.context();
        }
        else { context = await browser.newContext({ viewport: report.configuration.viewport }); page = await context.newPage(); }
        page.setDefaultTimeout(10000);
        page.on('pageerror', error => { if(row.browserErrors.length<40) row.browserErrors.push(firstLine(error)); });
        page.on('console', message => { if(message.type()==='error' && row.consoleErrors.length<60) row.consoleErrors.push(diagnostic(message.text()).slice(0,700)); });
        page.on('requestfailed', request => {if(mode==='proxy'&&/^https?:/.test(request.url())&&row.clientRequestFailures.length<80)row.clientRequestFailures.push({url:clean(request.url()),error:request.failure()?.errorText});});
        page.on('response', response => { if(mode==='native' && response.status()>=400 && row.nativeHttpErrors.length<40) row.nativeHttpErrors.push({url:clean(response.url()),status:response.status()}); });
        page.on('websocket', socket => { if(mode==='proxy' && /\/browser-ws(?:\?|$)/.test(socket.url())) { socket.on('framereceived', frame => {row.encryptedDownBytes += Buffer.byteLength(frame.payload);}); socket.on('framesent', frame => {row.encryptedUpBytes += Buffer.byteLength(frame.payload);}); socket.on('close', ()=>{if(observing&&row.socketStates.length<128)row.socketStates.push('closed');}); } });
        if(mode==='proxy') {
          await page.route('**/*', route => {const request=route.request();if(!/^https?:/.test(request.url()))return route.continue();if(row.directClientRequests.length<80)row.directClientRequests.push({url:clean(request.url()),method:request.method(),resourceType:request.resourceType(),blockedByHarness:true});return route.abort('blockedbyclient');});
          id = await page.evaluate(()=>EyaPanels.create('proxy-browser'));
          const address = page.getByRole('textbox', { name: 'Address or search' });
          await address.focus();
          await page.keyboard.insertText(site.url);
          await page.keyboard.press('Enter');
        } else await page.goto(site.url, { waitUntil:'domcontentloaded', timeout:40000 }).catch(error=>{row.navigationError=firstLine(error);});
        await check('reading', async()=>{await waitHeading(site.heading); return {heading:await visibleHeading(site.heading).innerText(), contentMs:Date.now()-started};});
        if(row.checks.reading.outcome==='passed') {
          await sleep(3000); // Allow hydration; interaction checks still wait independently.
          row.initial = await target().evaluate(()=>({title:document.title,textCharacters:document.body.innerText.length,headings:[...document.querySelectorAll('h1,h2')].slice(0,14).map(el=>el.textContent.trim()),styleSheets:document.styleSheets.length,bodyFont:getComputedStyle(document.body).fontFamily,images:[...document.images].reduce((out,img)=>{out.total++;if(img.complete&&img.naturalWidth)out.loaded++;return out},{total:0,loaded:0}),nestedFrames:document.querySelectorAll('iframe').length}));
          await check('styling',async()=>{
            const nativeFont=report.rows.find(row=>row.site===site.id&&row.mode==='native')?.initial?.bodyFont;
            const expected=nativeFont||FONTS[site.id];
            await target().waitForFunction(({expected,exact})=>document.styleSheets.length>0&&(exact?getComputedStyle(document.body).fontFamily===expected:getComputedStyle(document.body).fontFamily.includes(expected)),{expected,exact:!!nativeFont},{timeout:10000}).catch(()=>{});
            const styles=await target().evaluate(()=>({sheets:document.styleSheets.length,font:getComputedStyle(document.body).fontFamily,links:[...document.querySelectorAll('link[rel=stylesheet]')].map(link=>({loaded:!!link.sheet,href:link.href.startsWith('blob:')?'blob:':link.href.startsWith('data:')?'data:':link.href.slice(0,160)}))}));
            row.styleDiagnostics=styles;
            assert.ok(styles.sheets>0,'Article must load its stylesheet, not only unstyled HTML');
            assert.ok(nativeFont?styles.font===expected:styles.font.includes(expected),`Expected native body font ${expected}, observed ${styles.font}`);
            return styles;
          });
          row.settled=await target().evaluate(()=>({title:document.title,textCharacters:document.body.innerText.length,headings:[...document.querySelectorAll('h1,h2')].slice(0,14).map(el=>el.textContent.trim()),styleSheets:document.styleSheets.length,bodyFont:getComputedStyle(document.body).fontFamily}));
          await check('retainedContent',async()=>{assert.ok(await visibleHeading(site.heading).isVisible(),'Article remains visible after scripts and styles load');assert.ok(row.settled.textCharacters>=200,'Readable article text survives hydration');return {textCharacters:row.settled.textCharacters};});
          if(row.checks.retainedContent.outcome==='passed'){
          await check('selection',async()=>{const paragraphs=target().locator('p');let paragraph;for(let i=0;i<await paragraphs.count();i++){const p=paragraphs.nth(i);if(await p.isVisible()&&await p.evaluate(el=>{const box=el.getBoundingClientRect();if(box.bottom<=0||box.right<=0||box.left>=innerWidth)return false;const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode())if(node.textContent.trim().length>=12&&!node.parentElement.closest('a,button'))return true;return false;})){paragraph=p;break;}}assert.ok(paragraph,'Visible prose paragraph');await paragraph.scrollIntoViewIfNeeded();const point=await paragraph.evaluate(el=>{const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){if(node.textContent.trim().length<12||node.parentElement.closest('a,button'))continue;const range=document.createRange();range.selectNodeContents(node);const r=[...range.getClientRects()].find(r=>r.width>50&&r.height>5);if(r){const p=el.getBoundingClientRect();return{x:r.x-p.x,y:r.y-p.y,width:r.width,height:r.height};}}return null;});assert.ok(point,'Paragraph text range');const box=await paragraph.boundingBox();row.selectionGeometry={box,point,prose:await paragraph.innerText()};await page.mouse.move(box.x+point.x+2,box.y+point.y+point.height/2);await page.mouse.down();await page.mouse.move(box.x+point.x+Math.min(point.width-2,180),box.y+point.y+point.height/2,{steps:12});await page.mouse.up();const selected=await target().evaluate(()=>getSelection().toString());assert.ok(selected.trim().length>=2,'Drag must select actual article text');return{selectedCharacters:selected.length};});
          if (captures) await page.screenshot({path:path.join(captures,`${site.id}-${mode}-${format}.png`),timeout:3000}).catch(()=>{});
          await check('navigation', async () => {
            const href = JSON.stringify(site.link);
            const selector = site.id === 'swift' ? 'a[href*="/guidedtour" i]:visible' : `a[href=${href}]:visible,a[href$=${href}]:visible`;
            const link = target().locator(selector).first();
            await link.click();
            await waitHeading(site.next, site.id === 'mdn' ? site.link : undefined);
            return { heading: await visibleHeading(site.next).innerText() };
          });
          if(row.checks.navigation.outcome==='passed') await check('back',async()=>{if(mode==='proxy')await page.evaluate(id=>EyaPanels.call(id,'back'),id);else await page.goBack({waitUntil:'domcontentloaded'});await waitHeading(site.heading, site.id === 'mdn' ? new URL(site.url).pathname : undefined);return 'Original article restored';});
          await check('search',async()=>{
            const frame=target();
            if(site.id==='react'){const trigger=frame.locator('button[aria-label="Search"]:visible,button:has-text("Search"):visible').first();await trigger.waitFor({timeout:REACT_SEARCH_DEADLINE_MS});await trigger.click();const input=frame.locator('input[type="search"],input.DocSearch-Input').first();await input.fill(site.query);const results=frame.locator('.DocSearch-Hit a[href]');await results.first().waitFor();const count=await results.count();return {results:count,query:site.query,followed:await followResult(results.first())};}
            if(site.id==='pixijs'){const trigger=frame.locator('[data-verify="search-trigger"]:visible').first();const dialog=frame.locator('dialog[data-verify="search-modal"][open]');await trigger.click();let triggerClicks=1;try{await dialog.waitFor({timeout:2000});}catch(error){if(error.name!=='TimeoutError')throw error;if(!await dialog.isVisible()){await trigger.click();triggerClicks++;}await dialog.waitFor();}const input=dialog.locator('input[aria-label="Search"]');await input.fill(site.query);const results=frame.locator('dialog[data-verify="search-modal"] [role="option"]').filter({hasText:new RegExp(site.query,'i')});await results.first().waitFor();const count=await results.count();await frame.getByRole('option',{name:'Sprite',exact:true}).click();await waitHeading('Sprite');const heading=await target().getByRole('heading',{name:'Sprite',exact:true}).first().innerText();return {results:count,query:site.query,followed:{heading},triggerClicks};}
            if(site.id==='rust'){await frame.locator('#mdbook-search-toggle').click();const input=frame.locator('#mdbook-searchbar');await input.fill(site.query);const results=frame.locator('#mdbook-searchresults a');await results.first().waitFor();const count=await results.count();return {results:count,query:site.query,followed:await followResult(results.first())};}
            if(site.id==='python'){const input=frame.locator('input[name="q"]:visible').first();await input.fill(site.query);await input.press('Enter');await waitHeading('Search');const results=target().locator('#search-results li a');await results.first().waitFor();const count=await results.count();return {results:count,query:site.query,followed:await followResult(results.first())};}
            if(site.id==='mdn'){await frame.evaluate(()=>Promise.race([(async()=>{await customElements.whenDefined('mdn-search-modal');await document.querySelector('mdn-search-modal')?.updateComplete;})(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Search custom element did not hydrate within 10 seconds')),10000))]));const trigger=frame.locator('mdn-search-button button[title="Search the site"]:visible').first();await trigger.click();const input=frame.locator('input[type="search"]:visible,input[role="combobox"]:visible,input[name="q"]:visible').first();await input.fill(site.query);const result=frame.locator('mdn-search-modal a[href="/en-US/docs/Web/JavaScript/Guide/Closures"]:visible');await result.waitFor();return {query:site.query,kind:'Query-specific search suggestion followed',followed:await followResult(result)};}
            const input=frame.locator('.navigator-filter input#filter-input');
            const navigatorStarted = Date.now();
            // DocC reads and processes a separate navigation index after the article is visible.
            await input.waitFor({ timeout: SWIFT_NAVIGATOR_DEADLINE_MS });
            const navigatorReadyMs = Date.now() - navigatorStarted;
            await input.fill(site.query);
            const matches=frame.getByRole('link',{name:'Functions',exact:true});await matches.first().waitFor();await input.press('Escape');return{query:site.query,matches:await matches.count(),navigatorReadyMs,kind:'DocC navigator filter (not global full-text search)'};
          });
          }
        }
        if(row.checks.search?.outcome==='failed')row.searchDiagnostics=await target().evaluate(()=>({inputs:[...document.querySelectorAll('input')].map(el=>({type:el.type,placeholder:el.placeholder,label:el.getAttribute('aria-label'),readonly:el.readOnly})),dialogs:[...document.querySelectorAll('dialog,[role=dialog]')].map(el=>({open:el.open,text:el.textContent.slice(0,300)}))})).catch(()=>null);
        if(mode==='proxy') {
          row.sandbox=await page.locator('.eya-browser-frame').first().getAttribute('sandbox');assert.equal(row.sandbox,'allow-scripts');
          row.panelStatus=await page.locator('.eya-browser-status').innerText();
          if (collectDevtools) {
            await page.evaluate(id=>EyaPanels.call(id,'toggleDevtools'),id);
            row.runtimeConsole=diagnostic(await page.locator('.eya-devtools-output').first().innerText()).slice(0,14000);
            await page.getByRole('tab',{name:'Network panel',exact:true}).click();
            row.network=(await page.locator('.eya-devtools-output').first().innerText()).slice(0,24000);
          }
          row.finalAddress=await page.getByLabel('Address or search').evaluate(input=>input.value);
        } else row.finalAddress=clean(page.url());
      } catch(error) { row.harnessError=firstLine(error); }
      finally {
        if(captures && page && !page.isClosed()) await page.screenshot({path:path.join(captures,`${site.id}-${mode}-${format}-final.png`),timeout:3000}).catch(()=>{});
        observing=false; await context?.close(); row.elapsedMs=Date.now()-started;
        row.outcome=row.checks.reading?.outcome!=='passed'||row.checks.retainedContent?.outcome==='failed'?'unreadable':Object.values(row.checks).every(value=>value.outcome==='passed')&&!row.harnessError?'usable':'partial';
        await fs.writeFile(out,JSON.stringify(report,null,2)+'\n');console.log(`${label}: ${row.outcome}, ${row.elapsedMs}ms`);
      }
    }
  } finally { await f.close(); }
  report.summary={rows:report.rows.length,usable:report.rows.filter(row=>row.outcome==='usable').length,partial:report.rows.filter(row=>row.outcome==='partial').length,unreadable:report.rows.filter(row=>row.outcome==='unreadable').length,proxyDirectRequestRows:report.rows.filter(row=>row.mode==='proxy'&&row.directClientRequests.length).length};
  await fs.writeFile(out,JSON.stringify(report,null,2)+'\n');console.log(`Report: ${out}`);
  if(process.env.EYA_PROXY_PUBLIC_REQUIRE_USABLE==='1')assert.deepEqual(report.rows.filter(row=>row.outcome!=='usable').map(row=>({site:row.site,mode:row.mode,format:row.format,outcome:row.outcome,checks:row.checks})),[],'Required public documentation workflows must all be usable');
  assert.deepEqual(report.rows.filter(row=>row.harnessError).map(row=>({site:row.site,mode:row.mode,format:row.format,error:row.harnessError})),[],'Harness errors are distinct from characterized site failures');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
