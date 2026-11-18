// Production CDP -> Rust encoder -> Noise -> browser decode/presentation.
// A bounded TCP shaper controls bytes/second and propagation on a loopback hop.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const net=require('node:net');
const {buildSync}=require('esbuild');
const {chromium}=require('playwright');
const {fixture,KEY}=require('./continuity-fixture.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function shaper(port,{mbps,rtt}) {
  const pairs=new Set(); let downBytes=0,upBytes=0;
  const listener=net.createServer(client=>{
    const upstream=net.connect(port,'127.0.0.1');pairs.add(client);pairs.add(upstream);
    const pump=(source,destination,down)=>{
      const queue=[];let active=false,total=0,ended=false;
      source.on('data',data=>{total+=data.length;if(total>32*1024*1024){source.destroy();destination.destroy();return;}queue.push({data,readyAt:performance.now()+rtt/2});if(total>256*1024)source.pause();run();});
      source.on('end',()=>{ended=true;if(!active&&!queue.length)destination.end();});
      source.on('error',()=>destination.destroy());
      async function run(){if(active)return;active=true;try{while(queue.length&&!destination.destroyed){const {data,readyAt}=queue.shift();if(readyAt>performance.now())await delay(readyAt-performance.now());for(let p=0;p<data.length;p+=4096){const part=data.subarray(p,p+4096);if(down&&mbps)await delay(part.length*8/(mbps*1000));if(down)downBytes+=part.length;else upBytes+=part.length;if(!destination.write(part))await new Promise(resolve=>{destination.once('drain',resolve);destination.once('close',resolve);});}total-=data.length;if(total<128*1024)source.resume();}}finally{active=false;if(ended)destination.end();}}
    };
    pump(client,upstream,false);pump(upstream,client,true);
    client.on('close',()=>{upstream.destroy();pairs.delete(client);});upstream.on('close',()=>{client.destroy();pairs.delete(upstream);});
  });
  await new Promise(r=>listener.listen(0,'127.0.0.1',r));
  return{url:`ws://127.0.0.1:${listener.address().port}/ws`,snapshot:()=>({downBytes,upBytes}),close:async()=>{for(const s of pairs)s.destroy();await new Promise(r=>listener.close(r));}};
}
const scene=`document.body.innerHTML='<style>body{margin:0;background:white;color:#18232c;font:16px monospace}#marker{position:fixed;left:0;top:0;width:20px;height:20px;background:rgb(16,0,0);z-index:2}main{padding:28px;display:grid;grid-template-columns:1fr 1fr;gap:20px}p{margin:4px}canvas{width:560px;height:580px}</style><div id="marker"></div><main><article><h2>Stream text fixture</h2>'+Array.from({length:32},(_,i)=>'<p>File '+i+' · café 中文 العربية · 0.125 mm</p>').join('')+'<span id="typed"></span></article><canvas width="560" height="580"></canvas></main>';let ctx=document.querySelector('canvas').getContext('2d'),im=ctx.createImageData(560,580),seed=17;for(let i=0;i<im.data.length;i+=4){seed=(Math.imul(seed,1664525)+1013904223)>>>0;let v=seed>>>24;im.data[i]=v;im.data[i+1]=(v+33)&255;im.data[i+2]=150;im.data[i+3]=255;}ctx.putImageData(im,0,0);window.step=1;document.onkeydown=()=>{window.step++;document.getElementById('marker').style.background='rgb('+(step*16)+',0,0)';document.getElementById('typed').textContent='Typed '+step;};true`;
(async()=>{
  const f=await fixture({binary:process.env.EYA_STREAM_SERVER_BINARY,env:{EYA_BROWSER_CHROMIUM:process.env.EYA_BROWSER_EXECUTABLE||chromium.executablePath(),EYA_BROWSER_GPU_MODE:'off'}});let browser,shape;
  const results=[];
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.EYA_BROWSER_EXECUTABLE});
    const bundled=entry=>buildSync({entryPoints:[entry],bundle:true,platform:'browser',format:'iife',globalName:entry.includes('transport')?'Transport':'Tiles',write:false}).outputFiles[0].text;
    const transportCode=bundled('client/browser-transport.js'),tileCode=bundled('client/browser-tiles.js');
    for(const profile of [{name:'loopback',mbps:0,rtt:0},{name:'5mbit-50ms',mbps:5,rtt:50}]){
      shape=await shaper(f.port,profile);const page=await browser.newPage();
      await page.goto(f.http);await page.addScriptTag({content:transportCode});await page.addScriptTag({content:tileCode});
      page.on('pageerror',e=>console.error('Harness page:',e.message));
      await page.evaluate(async({url,key})=>{
        window.events=[];window.frames=[];window.decodeErrors=[];window.hold=false;window.held=null;window.expected=0;window.inputs=new Map();window.measurements=[];
        const decoder=Tiles.createBrowserTileDecoder(),canvas=document.createElement('canvas');document.body.replaceChildren(canvas);window.surface=canvas;
        window.ackFrame=(meta,ok=true)=>meta.format==='rgba-tiles-v1'?remote.ackTiles(meta.seq,ok):remote.ack(meta.seq);
        window.remote=await Transport.createBrowserRenderTransport({url,key,onEvent:(e,c)=>{if(c==='status')events.push(e)},onFrame:async(bytes,meta)=>{
          const start=performance.now();let marker,ok=true;
          try{
            if(meta.format==='rgba-tiles-v1'){const frame=await decoder.decode(bytes,meta);canvas.width=frame.width;canvas.height=frame.height;canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(frame.pixels.buffer),frame.width,frame.height),0,0);decoder.commit(frame);}
            else{const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/'+(meta.format||'jpeg')}));canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();}
            marker=Math.round(canvas.getContext('2d').getImageData(8,8,1,1).data[0]/16);
          }catch(e){decodeErrors.push(e.message);ok=false;}
          const at=performance.now(),frame={meta,bytes:bytes.length,decodeMs:at-start,at,marker};frames.push(frame);
          if(inputs.has(marker)){measurements.push({...frame,inputToCanvasMs:at-inputs.get(marker)});inputs.delete(marker);}
          if(hold){held=meta;}else ackFrame(meta,ok);
        }});
        await remote.start();await remote.activateTab('measure');
      },{url:shape.url,key:KEY});
      for(const mode of ['jpeg','png','tiles']){
        const prior=await page.evaluate(()=>frames.length);
        await page.evaluate(({mode,scene})=>{window.hold=false;window.held=null;window.measurements=[];window.inputs.clear();remote.resize(1280,720,'measure',{format:mode==='jpeg'?'jpeg':'png',quality:80,maxWidth:1280,maxHeight:720,tiles:mode==='tiles'});return remote.evaluate('measure','(()=>{'+scene+'})()');},{mode,scene});
        await page.waitForFunction(({prior,mode})=>frames.slice(prior).some(f=>f.marker===1&&(mode==='tiles'?f.meta.format==='rgba-tiles-v1':f.meta.format===mode)),{prior,mode},{timeout:30000}).catch(async e=>{console.error(await page.evaluate(()=>({events:events.slice(-8),frames:frames.slice(-4),decodeErrors})));throw e;});
        await delay(150);
        const initial=await page.evaluate(({prior,mode})=>frames.slice(prior).find(f=>f.marker===1&&(mode==='tiles'?f.meta.format==='rgba-tiles-v1':f.meta.format===mode)),{prior,mode});
        const initialKeyframeBytes=await page.evaluate(prior=>frames.slice(prior).find(f=>f.meta.format==='rgba-tiles-v1'&&f.meta.base===0)?.bytes??null,prior);
        const wireBefore=shape.snapshot();
        for(let i=0;i<12;i++){
          const marker=i+2;
          await page.evaluate(marker=>{inputs.set(marker,performance.now());remote.input({type:'key',action:'keyDown',key:'ArrowRight',code:'ArrowRight',keyCode:39},'measure');},marker);
          await page.waitForFunction(marker=>measurements.some(m=>m.marker===marker),marker,{timeout:20000});
        }
        const measurements=await page.evaluate(()=>measurements),wireAfter=shape.snapshot();
        assert.equal(measurements.length,12);assert.deepEqual(await page.evaluate(()=>decodeErrors),[]);
        const mean=key=>measurements.reduce((s,m)=>s+m[key],0)/measurements.length;
        const latency=measurements.map(m=>m.inputToCanvasMs).sort((a,b)=>a-b);
        results.push({profile:profile.name,mode,samples:12,initialBytes:initial.bytes,initialCanonicalKeyframeBytes:initialKeyframeBytes,meanUpdateBytes:mean('bytes'),meanDecodeApplyMs:mean('decodeMs'),p50InputToCanvasMs:latency[5],p95InputToCanvasMs:latency[11],encryptedDownBytes:wireAfter.downBytes-wireBefore.downBytes,encryptedUpBytes:wireAfter.upBytes-wireBefore.upBytes,formats:[...new Set(measurements.map(m=>m.meta.format))]});
        // Final input while the preceding frame waits for ACK must not disappear.
        await page.evaluate(()=>{hold=true;remote.input({type:'key',action:'keyDown',key:'ArrowRight',code:'ArrowRight',keyCode:39},'measure');});
        await page.waitForFunction(()=>held&&frames.at(-1).marker===14,null,{timeout:20000});
        await page.evaluate(()=>remote.input({type:'key',action:'keyDown',key:'ArrowRight',code:'ArrowRight',keyCode:39},'measure'));
        await delay(200);
        await page.evaluate(()=>{hold=false;ackFrame(held);held=null;});
        await page.waitForFunction(()=>frames.at(-1)?.marker===15,null,{timeout:20000});
        console.error('Measured '+profile.name+' '+mode);
      }
      await page.evaluate(()=>remote.close());await page.close();await shape.close();shape=null;
    }
    const report={description:'Production CDP capture/Rust codec/Noise/bounded TCP shaper/browser decode+canvas.12 real key inputs per mode; canvas commit timing is not physical input-to-photon. Shaper caps downstream byte rate and delays each observed TCP chunk once from arrival time; RTT is nominal, not emulated WAN packet loss. Software Chromium; default JPEG retained. Initial canonical keyframe excluded from update latency, recorded separately.',node:process.version,chromium:browser.version(),arch:process.arch,serverBinary:process.env.EYA_STREAM_SERVER_BINARY||'eya-server/target/debug/eya-server',serverSha256:require('node:crypto').createHash('sha256').update(await fs.readFile(process.env.EYA_STREAM_SERVER_BINARY||'eya-server/target/debug/eya-server')).digest('hex'),sourceSha256:Object.fromEntries(await Promise.all(['eya-server/src/browser_render.rs','eya-server/src/browser_tiles.rs','client/browser-tiles.js','client/browser-transport.js','client/terminal-codec.js'].map(async name=>[name,require('node:crypto').createHash('sha256').update(await fs.readFile(name)).digest('hex')]))),date:new Date().toISOString(),results};
    if(process.env.EYA_STREAM_IMPROVEMENTS_REPORT)await fs.writeFile(process.env.EYA_STREAM_IMPROVEMENTS_REPORT,JSON.stringify(report,null,2)+'\n');
    for(const profile of ['loopback','5mbit-50ms']){const rows=results.filter(r=>r.profile===profile);assert.ok(rows.find(r=>r.mode==='tiles').meanUpdateBytes<rows.find(r=>r.mode==='png').meanUpdateBytes*.15);}
    console.log(JSON.stringify(report,null,2));
  }finally{await shape?.close();await browser?.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
