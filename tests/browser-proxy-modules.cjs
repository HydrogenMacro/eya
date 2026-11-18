// Real opaque-frame execution of the production module loader. The bounded test
// bridge supplies source graphs; browser imports still use native ESM identity.
const assert = require('node:assert/strict');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { chromium } = require('playwright');
const path = require('node:path');

(async () => {
  const filename = path.resolve('client/browser-panel.js');
  const compiled = buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false });
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(compiled.outputFiles[0].text, filename);
  const { buildIframeRuntime, browserFrameCsp, parseModuleWorkerImports } = loaded.exports;
  const helperResult = buildSync({ entryPoints: ['client/browser-proxy-script.js'], bundle: true, platform: 'node', format: 'cjs', write: false });
  const helpers = new Module('module-fixture',module);helpers._compile(helperResult.outputFiles[0].text,'module-fixture.cjs');
  const {parseProxyModuleImports}=helpers.exports;
  const base='https://modules.example.test/docs/';
  const sources = new Map(Object.entries({
    'a.js': `import { getB } from './b.js'; import { token } from './shared.js'; export function getA(){return 'A'}; globalThis.moduleState={cycle:getB(),token}; globalThis.runLazy=async()=>{const name='lazy.js';const first=await import('./'+name);const second=await import('./'+name);return {sameNamespace:first===second,sameToken:first.token===token,message:first.message,sharedRuns:globalThis.sharedRuns,lazyRuns:globalThis.lazyRuns}};`,
    'b.js': `import { getA } from './a.js'; export function getB(){return getA()+'B'}`,
    'shared.js': `globalThis.sharedRuns=(globalThis.sharedRuns||0)+1;export const token={id:'shared'};`,
    'lazy.js': `import { token } from './shared.js';export {token};globalThis.lazyRuns=(globalThis.lazyRuns||0)+1;export const message='late import works';`,
  }).map(([name,source])=>[base+name,source]));
  const requests=[];
  function graph(entry) {
    assert.ok(requests.length<8,'Fixture source request bound'); requests.push(entry);
    const modules={},pending=[entry];
    while(pending.length){const url=pending.pop();if(modules[url])continue;const source=sources.get(url);assert.equal(typeof source,'string','Only explicit fixture modules may load');const parsed=parseProxyModuleImports(source,url,{allowComputedDynamicImports:true});assert.equal(parsed.error,'');modules[url]={source:parsed.source,imports:parsed.imports};for(const edge of parsed.imports)pending.push(edge.url);assert.ok(Object.keys(modules).length<=4);}
    return {source:modules[entry].source,url:entry,modules,order:Object.keys(modules),pageModule:true};
  }
  assert.ok(parseModuleWorkerImports("import('./'+name)",base+'worker.js').error,'Computed worker imports remain explicit unsupported');
  const browser=await chromium.launch({headless:true,executablePath:process.env.EYA_BROWSER_EXECUTABLE});
  try {
    const page=await browser.newPage(),direct=[],cspFailures=[];
    await page.route('https://**/*',route=>{direct.push(route.request().url());return route.abort();});
    page.on('requestfailed',request=>{if(request.failure()?.errorText==='csp')cspFailures.push(request.url());});
    await page.exposeBinding('__moduleGraph',(_,url)=>graph(url));
    const runtime=buildIframeRuntime('module-regression','',{},base+'index.html');
    await page.evaluate(({runtime,csp,base})=>{
      const frame=document.createElement('iframe');frame.sandbox='allow-scripts';document.body.append(frame);window.fixtureFrame=frame;window.bridgeErrors=[];
      addEventListener('message',event=>{
        if(event.source!==frame.contentWindow||event.origin!=='null'||event.data?.type!=='eya-ready')return;
        const channel=new MessageChannel();window.fixturePort=channel.port1;
        channel.port1.onmessage=async({data})=>{
          if(data.type==='console'&&data.level==='error')window.bridgeErrors.push(data.args);
          if(data.type!=='resource')return;
          try{if(!data.pageModule||!data.moduleMode||!data.transferSource)throw Error('Fixture only supports page module graphs');const graph=await __moduleGraph(data.url);channel.port1.postMessage({type:'resource-source',id:data.id,...graph});}
          catch(error){channel.port1.postMessage({type:'resource-error',id:data.id,error:String(error)});}
        };
        frame.contentWindow.postMessage({type:'eya-connect',nonce:'module-regression'},'*',[channel.port2]);
      });
      frame.srcdoc=`<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><base data-eya-proxy-base href="${base}"><script>${runtime}<\/script><script type="module" data-eya-module data-eya-src="${base}a.js"><\/script>`;
    },{runtime,csp:browserFrameCsp(),base});
    const frame=page.frames().find(frame=>frame.parentFrame()===page.mainFrame());
    await frame.waitForFunction(()=>globalThis.moduleState?.cycle==='AB',null,{timeout:10000});
    assert.deepEqual(requests,[base+'a.js'],'Computed imports stay lazy before explicit use');
    assert.equal(await frame.evaluate(()=>globalThis.sharedRuns),1,'Cycle dependencies evaluate once');
    await page.waitForTimeout(30); // Entry load is complete before the late import.
    const result=await frame.evaluate(()=>globalThis.runLazy());
    assert.deepEqual(result,{sameNamespace:true,sameToken:true,message:'late import works',sharedRuns:1,lazyRuns:1});
    assert.deepEqual(requests,[base+'a.js',base+'lazy.js'],'Repeated late import shares source and namespace');
    assert.equal(await frame.evaluate(()=>origin),'null');
    assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts');
    assert.deepEqual(await page.evaluate(()=>window.bridgeErrors),[]);
    assert.deepEqual(direct,[],'Native module graph never bypasses the bridge');
    assert.deepEqual(cspFailures,[],'Covered imports must not depend on blocked HTTP retries');
    await page.evaluate(()=>{fixturePort.close();fixtureFrame.remove();});
    console.log('Proxy page modules: cyclic ESM, shared dependency identity, delayed computed imports, lazy single execution and opaque CSP confinement passed.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
