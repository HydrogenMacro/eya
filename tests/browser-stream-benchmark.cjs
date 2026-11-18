// Production Noise transport/CDP capture, synthetic dashboard, software Chromium.
// No Internet pages are needed. Includes encoding, encrypted transfer and decode.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { chromium } = require('playwright');
const { fixture, KEY } = require('./continuity-fixture.cjs');
(async () => {
  const f = await fixture({ env: { EYA_BROWSER_CHROMIUM: process.env.EYA_BROWSER_EXECUTABLE || chromium.executablePath(), EYA_BROWSER_GPU_MODE: 'off' } });
  let transport, browser;
  try {
    browser = await chromium.launch({ headless: true });
    const decoder = await browser.newPage();
    const source = path.resolve('client/browser-transport.js');
    const bundle = buildSync({ entryPoints:[source], bundle:true, platform:'node',format:'cjs',write:false,alias:{'sodium-native':path.resolve('client/node_modules/sodium-javascript/index.js')} });
    const loaded = new Module(source, module); loaded.filename = source; loaded.paths = Module._nodeModulePaths(path.dirname(source)); loaded._compile(bundle.outputFiles[0].text, source);
    const events = [], frames = [];
    transport = await loaded.exports.createBrowserRenderTransport({ url:f.url,key:KEY,onEvent:(e,c)=>{if(c==='status')events.push(e);}, onFrame:(bytes,meta)=>{ frames.push({bytes,meta,at:performance.now()}); transport.ack(meta.seq); } });
    const until = async find => { const deadline=Date.now()+15000; while(Date.now()<deadline){const value=find();if(value)return value;await new Promise(r=>setTimeout(r,20));} throw Error('Timed out: '+JSON.stringify(events.slice(-4))); };
    await transport.start();await transport.activateTab('bench');
    await transport.evaluate('bench', `document.body.innerHTML='<style>body{margin:0;background:#17232c;color:#e5eff5;font:22px sans-serif}header{padding:24px;background:#263943}main{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:24px}article{padding:16px;background:#23323f;border-radius:12px}canvas{width:100%;height:580px}p{padding:7px;border-bottom:1px solid #536574}</style><header>Eya remote dashboard · <span id=tick>0</span></header><main><article><h1>Photo / chart region</h1><canvas width=1600 height=900></canvas></article><article><h1>Files and activity</h1>'+Array.from({length:40},(_,i)=>'<p>Document '+i+' · Modified today · '+(i*2391)+' bytes</p>').join('')+'</article></main>';const c=document.querySelector('canvas'),x=c.getContext('2d'),im=x.createImageData(c.width,c.height);let seed=17;for(let i=0;i<im.data.length;i+=4){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const n=seed>>>24;im.data[i]=(i/4)%c.width/7+n/4;im.data[i+1]=(i/4/c.width)/4+n/5;im.data[i+2]=130+n/3;im.data[i+3]=255}x.putImageData(im,0,0);true`);
    const results=[];
    for(const [name,maxWidth,maxHeight,quality,format] of [['native-q80',8192,8192,80,'jpeg'],['1080p-q80',1920,1080,80,'jpeg'],['720p-q60',1280,720,60,'jpeg'],['540p-q40',960,540,40,'jpeg'],['720p-png',1280,720,80,'png']]){
      const startEvents=events.length;
      transport.resize(3840,2160,'bench',{maxWidth,maxHeight,quality,format});
      await until(()=>events.slice(startEvents).some(e=>e.type==='stream-settings'&&e.stream?.format===format&&e.stream?.maxWidth===maxWidth));
      await new Promise(r=>setTimeout(r,300));
      const samples=[];
      for(let i=0;i<6;i++){
        const before=frames.length, started=performance.now();
        await transport.evaluate('bench', `document.getElementById('tick').textContent=${JSON.stringify(name+' '+i)};document.querySelector('main').style.transform='translateY(${i%2}px)';true`);
        const frame=await until(()=>frames.slice(before).find(f=>f.meta.format===format));
        const decoded=await decoder.evaluate(async ({data,format})=>{const bytes=Uint8Array.from(atob(data),x=>x.charCodeAt(0)),begin=performance.now();const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/'+format}));const result={decodeMs:performance.now()-begin,width:bitmap.width,height:bitmap.height};bitmap.close();return result;},{data:Buffer.from(frame.bytes).toString('base64'),format});
        samples.push({bytes:frame.bytes.length,wireBytes:frame.bytes.length+frame.meta.chunks*23+Buffer.byteLength(JSON.stringify(frame.meta))+17,latencyMs:frame.at-started,...decoded});
        assert.equal(frame.meta.width,3840,'Captured frame keeps logical input coordinates');
        assert.ok(decoded.width<=maxWidth&&decoded.height<=maxHeight);
      }
      const average=key=>Math.round(samples.reduce((sum,s)=>sum+s[key],0)/samples.length*100)/100;
      results.push({name,width:samples[0].width,height:samples[0].height,meanBytes:average('bytes'),meanWireBytes:average('wireBytes'),meanDecodeMs:average('decodeMs'),meanCaptureTransferMs:average('latencyMs')});
    }
    for(const row of results){row.reductionPercent=Math.round((1-row.meanBytes/results[0].meanBytes)*1000)/10;row.transferMsAt2Mbit=Math.round(row.meanWireBytes*8/2000);}
    assert.ok(results.find(r=>r.name==='720p-q60').meanBytes<results[0].meanBytes*0.6,'720p lower-quality capture materially reduces frame bytes');
    const report={description:'Six changing dashboard frames per preset; software Chromium, real production Noise transport; 2 Mbit/s transfer is a payload calculation, not WAN latency.',results};
    if(process.env.EYA_STREAM_REPORT)await fs.writeFile(process.env.EYA_STREAM_REPORT,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
  }finally{transport?.close();await browser?.close();await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
