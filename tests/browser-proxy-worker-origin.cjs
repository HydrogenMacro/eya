const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { chromium } = require('playwright');

(async()=>{
  const filename=path.resolve('client/browser-panel.js');
  const result=buildSync({entryPoints:[filename],bundle:true,platform:'node',format:'cjs',write:false});
  const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));loaded._compile(result.outputFiles[0].text,filename);
  const {buildIframeRuntime,browserFrameCsp}=loaded.exports;
  const upstream='https://worker-origin.example.test/docs/index.html';
  const browser=await chromium.launch({headless:true,executablePath:process.env.EYA_BROWSER_EXECUTABLE});
  try{
    const page=await browser.newPage(),direct=[],requests=[],errors=[];
    await page.route('https://**/*',route=>{direct.push(route.request().url());return route.abort();});
    page.on('pageerror',error=>errors.push(error.message));
    await page.exposeBinding('__workerSource',(_,request)=>{
      assert.ok(requests.length<4,'Fixture worker source count is bounded');
      assert.equal(request.transferSource,true);assert.equal(request.resourceType,'script');
      assert.equal(request.url,'https://worker-origin.example.test/worker.js');requests.push(request.url);
      return {source:"self.onmessage=event=>self.postMessage('echo:'+event.data)",url:request.url,sources:{}};
    });
    const runtime=buildIframeRuntime('worker-origin-regression','',{},upstream);
    await page.evaluate(({runtime,csp,upstream})=>{
      const frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-scripts');document.body.append(frame);window.fixtureFrame=frame;
      addEventListener('message',event=>{
        if(event.source!==frame.contentWindow||event.origin!=='null'||event.data?.type!=='eya-ready')return;
        const channel=new MessageChannel();window.fixturePort=channel.port1;
        channel.port1.onmessage=async({data})=>{
          if(data.type!=='resource')return;
          try{const source=await __workerSource(data);channel.port1.postMessage({type:'resource-source',id:data.id,...source});}
          catch(error){channel.port1.postMessage({type:'resource-error',id:data.id,error:String(error)});}
        };
        frame.contentWindow.postMessage({type:'eya-connect',nonce:'worker-origin-regression'},'*',[channel.port2]);
      });
      frame.srcdoc=`<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><base data-eya-proxy-base href="${upstream}"><script>${runtime}<\/script>`;
    },{runtime,csp:browserFrameCsp(),upstream});
    const frame=page.frames().find(frame=>frame.parentFrame()===page.mainFrame());
    await frame.waitForFunction(()=>typeof __eyaLocation==='function');
    const outcome=await frame.evaluate(async()=>{
      document.querySelector('base').remove();
      const nativeBase=document.baseURI;
      const run=url=>new Promise((resolve,reject)=>{
        let worker;try{worker=new Worker(url);}catch(error){reject(error);return;}
        worker.onmessage=event=>{worker.terminate();resolve(event.data);};
        worker.onerror=event=>{worker.terminate();reject(Error(event.message));};
        worker.postMessage('ping');
      });
      const first=await run('https://worker-origin.example.test/worker.js');
      const second=await run('../worker.js');
      let foreign='';try{new Worker('https://other.example.test/worker.js');}catch(error){foreign=error.name;}
      return {nativeBase,first,second,foreign,origin};
    });
    assert.ok(!outcome.nativeBase.startsWith('https://worker-origin.example.test/'),'Injected base actually removed');
    assert.equal(outcome.first,'echo:ping');assert.equal(outcome.second,'echo:ping');assert.equal(outcome.foreign,'SecurityError');assert.equal(outcome.origin,'null');
    assert.equal(requests.length,2,'Both same-origin workers use the source bridge; foreign worker never does');
    assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts');
    assert.deepEqual(direct,[]);assert.deepEqual(errors,[]);
    await page.evaluate(()=>{fixturePort.close();fixtureFrame.remove();});
    console.log('Proxy workers: canonical upstream origin survives removed base, absolute/relative workers execute through bridge, foreign origins stay denied.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
