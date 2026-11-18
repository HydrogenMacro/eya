const assert=require('node:assert/strict');
const path=require('node:path');
const Module=require('node:module');
const {buildSync}=require('esbuild');
const {chromium}=require('playwright');
const {fixture,KEY}=require('./continuity-fixture.cjs');
(async()=>{
 const f=await fixture({env:{EYA_BROWSER_CHROMIUM:process.env.EYA_BROWSER_EXECUTABLE||chromium.executablePath()}});let transport;
 try{
  const source=path.resolve('client/browser-transport.js'),code=buildSync({entryPoints:[source],bundle:true,platform:'node',format:'cjs',write:false,alias:{'sodium-native':path.resolve('client/node_modules/sodium-javascript/index.js')}}).outputFiles[0].text;
  const loaded=new Module(source,module);loaded.filename=source;loaded.paths=Module._nodeModulePaths(path.dirname(source));loaded._compile(code,source);
  const events=[],downloads=[],frames=[];
  transport=await loaded.exports.createBrowserRenderTransport({url:f.url,key:KEY,onEvent:(e,c)=>{if(c==='status')events.push(e)},onFrame:(bytes,meta)=>{frames.push({bytes,meta});transport.ack(meta.seq)},onDownload:(bytes,meta)=>downloads.push({bytes,meta})});
  const until=async find=>{const deadline=Date.now()+15000;while(Date.now()<deadline){const found=find();if(found)return found;await new Promise(r=>setTimeout(r,20));}throw Error('Missing event: '+JSON.stringify(events.slice(-6)));};
  await transport.start();await transport.activateTab('stream');assert.throws(()=>transport.downloadImage('stream',10,10),/image-download-v1/);
  transport.resize(1600,900,'stream',{format:'png',quality:80,maxWidth:960,maxHeight:540});
  await until(()=>transport.capabilities.includes('image-download-v1'));
  await transport.evaluate('stream',`document.body.innerHTML='<img style="width:200px;height:200px" src="data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%2210%22%20height=%2210%22%3E%3Crect%20width=%2210%22%20height=%2210%22%20fill=%22red%22/%3E%3C/svg%3E">';true`);
  await until(()=>frames.find(f=>f.meta.format==='png'));
  const png=frames.find(f=>f.meta.format==='png');assert.equal(Buffer.from(png.bytes).subarray(1,4).toString(),'PNG');
  transport.downloadImage('stream',50,50);await until(()=>downloads[0]);assert.equal(downloads[0].meta.filename,'image.svg');assert.match(Buffer.from(downloads[0].bytes).toString(),/^<svg/);
  await transport.evaluate('stream',`const blob=new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>'],{type:'image/svg+xml'});document.querySelector('img').src=URL.createObjectURL(blob);true`);
  transport.downloadImage('stream',50,50);await until(()=>downloads[1]);assert.match(Buffer.from(downloads[1].bytes).toString(),/^<svg/);
  // A new tab reuses the selected encoder and retained tabs still render.
  await transport.activateTab('second');await transport.evaluate('second',`document.body.textContent='Second tab';true`);await until(()=>frames.find(f=>f.meta.tabId==='second'&&f.meta.format==='png'));
  transport.resize(1600,900,'second',{format:'jpeg',quality:60,maxWidth:1280,maxHeight:720});
  await until(()=>events.find(e=>e.type==='stream-settings'&&e.stream.format==='jpeg'));
  await transport.evaluate('second',`document.body.textContent='JPEG again';true`);await until(()=>frames.find(f=>f.meta.tabId==='second'&&f.meta.format==='jpeg'));
  console.log('Live negotiated PNG/JPEG streaming, retained-tab encoding, data/blob image downloads and explicit unsupported fallback passed.');
 }finally{transport?.close();await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
