// Feasibility comparison on actual CDP screencast pixels, outside Eya transport.
// NODE_PATH=client/node_modules node tests/browser-compression-candidates.cjs [report.json]
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { performance } = require('node:perf_hooks');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');

const width = 1280, height = 720, samples = Math.max(1, Math.min(10, Number(process.env.EYA_CANDIDATE_SAMPLES) || 3));
const tileSizes = [64, 128], headerBytes = 8, tileHeaderBytes = 7;
const chunkBytes = 48 * 1024;
function estimatedWireBytes(bytes, format, tiles = 0, base = 1) {
  if (!bytes) return 0;
  const chunks = Math.ceil(bytes / chunkBytes);
  const meta = {seq:1,tabId:'bench',width,height,bytes,chunks,format};
  if (format === 'rgba-tiles-v1') Object.assign(meta,{pixelWidth:width,pixelHeight:height,base,tiles});
  return bytes + chunks * 23 + Buffer.byteLength(JSON.stringify(meta)) + 17;
}
const deflate = bytes => zlib.deflateRawSync(bytes, { level: 1 });
const round = value => Math.round(value * 100) / 100;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const scene = `<style>*{box-sizing:border-box}body{margin:0;background:#fff;color:#15232e;font:16px Arial}header{height:64px;padding:20px;background:#e8eff5;border-bottom:1px solid #abc}main{padding:20px;display:grid;grid-template-columns:740px 1fr;gap:20px}p{margin:0;padding:8px;border-bottom:1px solid #d6e0e8}#text{height:36px;font:18px monospace}#caret{display:inline-block;width:2px;height:18px;background:#15232e;vertical-align:middle}canvas{width:460px;height:260px}aside{background:#f1f5f8;padding:14px}.small{font-size:12px;color:#a23}.medium{font-size:14px;color:#279}</style><header>Documents / research · <b>Streaming benchmark</b></header><main><section><div id="text">Editable document <i id="caret"></i></div><div id="rows">${Array.from({length:40},(_,i)=>`<p>Document ${String(i).padStart(2,'0')} · Notes, research and meeting minutes · ${i*2387} bytes</p>`).join('')}</div></section><aside><h2>Activity chart</h2><canvas width="460" height="260"></canvas><p>Mixed text and textured image</p><p class="small">12px: syntax → ffi é é 漢字 العربية</p><p class="medium">14px: a += 1; Thin strokes 0123456789</p><p>16px: selection, caret, crisp colored text</p></aside></main>`;

async function prepare(page) {
  await page.setContent(scene);
  await page.evaluate(() => {
    const c = document.querySelector('canvas'), ctx = c.getContext('2d'), image = ctx.createImageData(c.width,c.height);
    let seed = 17;
    for(let i=0;i<image.data.length;i+=4){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const n=seed>>>24;image.data[i]=(i/4%c.width)/3+n/3;image.data[i+1]=(i/4/c.width)/2+n/4;image.data[i+2]=90+n/2;image.data[i+3]=255;}
    ctx.putImageData(image,0,0);window.scrollTo(0,0);
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function capture(cdp, decoder, format) {
  let onFrame;
  const start=performance.now();
  const frame = new Promise((resolve,reject) => {
    const timer=setTimeout(()=>{cdp.off('Page.screencastFrame',onFrame);reject(Error('No CDP '+format+' screencast frame'));},5000);
    onFrame=params=>{clearTimeout(timer);cdp.off('Page.screencastFrame',onFrame);resolve(params);};
    cdp.on('Page.screencastFrame',onFrame);
  });
  try {
    await cdp.send('Page.startScreencast',{format,quality:80,maxWidth:width,maxHeight:height,everyNthFrame:1,maxFramesInFlight:1,sendLastFrame:true});
    const params=await frame, captureMs=performance.now()-start;
    await cdp.send('Page.screencastFrameAck',{sessionId:params.sessionId});
    await cdp.send('Page.stopScreencast');
    const bytes=Buffer.from(params.data,'base64');
    const decoded=await decoder.evaluate(async ({base64,format})=>{
      const bytes=Uint8Array.from(atob(base64),x=>x.charCodeAt(0)),start=performance.now();
      const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/'+format}));
      const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
      const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
      const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data,decodeReadbackMs=performance.now()-start;
      const chunks=[];for(let at=0;at<rgba.length;at+=32768)chunks.push(String.fromCharCode(...rgba.subarray(at,at+32768)));
      return {rgba:btoa(chunks.join('')),width:canvas.width,height:canvas.height,decodeReadbackMs};
    },{base64:params.data,format});
    assert.equal(decoded.width,width);assert.equal(decoded.height,height);
    return {bytes,rgba:Buffer.from(decoded.rgba,'base64'),captureMs,decodeReadbackMs:decoded.decodeReadbackMs};
  } catch(error) {await cdp.send('Page.stopScreencast').catch(()=>{});throw error;}
}

function candidate(previous,current,size,mode) {
  const scanStart=performance.now(), tiles=[];
  let scanPackMs=0,encodeMs=0,rawTiles=0,xorTiles=0;
  for(let y=0;y<height;y+=size)for(let x=0;x<width;x+=size){
    const w=Math.min(size,width-x),h=Math.min(size,height-y);let changed=false;
    for(let row=0;row<h&&!changed;row++){const at=((y+row)*width+x)*4;changed=!current.subarray(at,at+w*4).equals(previous.subarray(at,at+w*4));}
    if(!changed)continue;
    const raw=Buffer.alloc(w*h*4),delta=mode==='replacement'?null:Buffer.alloc(w*h*4);
    for(let row=0;row<h;row++){const at=((y+row)*width+x)*4;current.copy(raw,row*w*4,at,at+w*4);if(delta)for(let col=0;col<w*4;col++)delta[row*w*4+col]=current[at+col]^previous[at+col];}
    const beforeEncode=performance.now();
    let encoded,kind;
    if(mode==='xor'){encoded=deflate(delta);kind='xor';}
    else {encoded=deflate(raw);kind='replacement';if(delta){const residual=deflate(delta);if(residual.length<encoded.length){encoded=residual;kind='xor';}}}
    encodeMs+=performance.now()-beforeEncode;
    if(kind==='xor')xorTiles++;else rawTiles++;
    tiles.push({x,y,w,h,kind,data:encoded});
  }
  const totalMs=performance.now()-scanStart;scanPackMs=totalMs-encodeMs;
  const decodeStart=performance.now(),output=Buffer.from(previous);
  for(const tile of tiles){const raw=zlib.inflateRawSync(tile.data,{maxOutputLength:tile.w*tile.h*4});assert.equal(raw.length,tile.w*tile.h*4);for(let row=0;row<tile.h;row++){const at=((tile.y+row)*width+tile.x)*4,from=row*tile.w*4;if(tile.kind==='replacement')raw.copy(output,at,from,from+tile.w*4);else for(let col=0;col<tile.w*4;col++)output[at+col]^=raw[from+col];}}
  assert.deepEqual(output,current,'Candidate must reconstruct exact CDP PNG RGBA');
  return {mode,size,tiles,bytes:tiles.length?tiles.reduce((sum,tile)=>sum+tileHeaderBytes+tile.data.length,headerBytes):0,scanPackMs,encodeMs,totalMs,nodeDecodeApplyMs:performance.now()-decodeStart,changedTiles:tiles.length,rawTiles,xorTiles};
}

async function browserApply(decoder,previous,current,encoded) {
  const result=await decoder.evaluate(async ({base,tiles,width,height})=>{
    const reference=Uint8Array.from(atob(base),c=>c.charCodeAt(0));
    // Allocation/base transfer and base64 transport are excluded from codec timing.
    const packed=tiles.map(tile=>({...tile,data:Uint8Array.from(atob(tile.data),c=>c.charCodeAt(0))}));
    const start=performance.now(),pixels=reference.slice();
    for(const tile of packed){const raw=window.inflateCandidate(tile.data);if(raw.length!==tile.w*tile.h*4)throw Error('Wrong decoded size');for(let row=0;row<tile.h;row++){const at=((tile.y+row)*width+tile.x)*4,from=row*tile.w*4;if(tile.kind==='replacement')pixels.set(raw.subarray(from,from+tile.w*4),at);else for(let col=0;col<tile.w*4;col++)pixels[at+col]^=raw[from+col];}}
    const decodeApplyMs=performance.now()-start,canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const presentStart=performance.now();canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer),width,height),0,0);
    const canvasCommitMs=performance.now()-presentStart;
    const reconstructed=new Uint8Array(await crypto.subtle.digest('SHA-256',pixels));
    return {decodeApplyMs,canvasCommitMs,sha256:Array.from(reconstructed,x=>x.toString(16).padStart(2,'0')).join('')};
  },{base:previous.toString('base64'),tiles:encoded.tiles.map(tile=>({...tile,data:tile.data.toString('base64')})),width,height});
  assert.equal(result.sha256,digest(current),'Browser fflate decoder must reconstruct exact pixels');
  return result;
}

(async()=>{
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='EYA_KEY'));
  const browser=await chromium.launch({headless:true,env,executablePath:process.env.EYA_BROWSER_EXECUTABLE,args:['--use-gl=angle','--use-angle=swiftshader']});
  try{
    const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1}),decoder=await browser.newPage();
    await decoder.goto('file://'+path.resolve('client.html'));
    const bundle=buildSync({stdin:{contents:"import {inflateSync} from 'fflate'; window.inflateCandidate=inflateSync",resolveDir:path.resolve('client')},bundle:true,write:false,format:'iife',platform:'browser'});
    await decoder.addScriptTag({content:bundle.outputFiles[0].text});
    const cdp=await page.context().newCDPSession(page);await cdp.send('Page.enable');
    const cases=[
      ['unchanged',()=>{}],
      ['caret',()=>document.querySelector('#caret').style.visibility='hidden'],
      ['typing',()=>document.querySelector('#text').prepend('A newly typed sentence. ')],
      ['selection',()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('#rows p'));const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range)}],
      ['scroll-32px',()=>window.scrollBy(0,32)],
      ['scroll-256px',()=>window.scrollBy(0,256)],
      ['image-simplification',()=>{const c=document.querySelector('canvas'),ctx=c.getContext('2d');ctx.fillStyle='#153b88';ctx.fillRect(0,0,c.width,c.height);ctx.fillStyle='#fff';ctx.font='24px sans-serif';ctx.fillText('New image frame',28,80)}],
      ['image-animation',()=>{const c=document.querySelector('canvas'),ctx=c.getContext('2d'),im=ctx.createImageData(c.width,c.height);let seed=29;for(let i=0;i<im.data.length;i+=4){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const n=seed>>>24;im.data[i]=(i/4%c.width)/3+n/3;im.data[i+1]=(i/4/c.width)/2+n/4;im.data[i+2]=90+n/2;im.data[i+3]=255}ctx.putImageData(im,0,0)}],
    ];
    const captureDirectory=process.env.EYA_CANDIDATE_CAPTURE_DIR;
    if(captureDirectory){await fs.mkdir(captureDirectory,{recursive:true});await fs.writeFile(path.join(captureDirectory,'metadata.json'),JSON.stringify({width,height,chromium:browser.version(),cases:cases.map(([name])=>name)},null,2)+'\n');}
    const measurements=[],keyframeMeasurements=[];
    for(const [name,change]of cases){
      for(let index=0;index<samples;index++){
        await prepare(page);const previous=await capture(cdp,decoder,'png');
        await page.evaluate(change);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const current=await capture(cdp,decoder,'png'),jpeg=await capture(cdp,decoder,'jpeg');
        if(captureDirectory&&index===0){await fs.writeFile(path.join(captureDirectory,name+'-base.png'),previous.bytes);await fs.writeFile(path.join(captureDirectory,name+'.png'),current.bytes);}
        const candidates=[];
        if(name==='unchanged')for(const size of tileSizes){
          const encoded=candidate(Buffer.alloc(previous.rgba.length),previous.rgba,size,'replacement');
          const applied=await browserApply(decoder,Buffer.alloc(previous.rgba.length),previous.rgba,encoded);
          const {tiles,...stats}=encoded;
          keyframeMeasurements.push({...stats,index,browserDecodeApplyMs:applied.decodeApplyMs,browserCanvasCommitMs:applied.canvasCommitMs,estimatedWireBytes:estimatedWireBytes(encoded.bytes,'rgba-tiles-v1',tiles.length,0),pngBytes:previous.bytes.length});
        }
        for(const size of tileSizes)for(const mode of ['replacement','xor','adaptive']){
          const encoded=candidate(previous.rgba,current.rgba,size,mode);
          const applied=await browserApply(decoder,previous.rgba,current.rgba,encoded);
          const {tiles,...stats}=encoded;
          candidates.push({...stats,browserDecodeApplyMs:applied.decodeApplyMs,browserCanvasCommitMs:applied.canvasCommitMs,estimatedWireBytes:estimatedWireBytes(encoded.bytes,'rgba-tiles-v1',tiles.length),selectedBytes:Math.min(encoded.bytes,current.bytes.length),selectedWireBytes:Math.min(estimatedWireBytes(encoded.bytes,'rgba-tiles-v1',tiles.length),estimatedWireBytes(current.bytes.length,'png')),selected:encoded.bytes<current.bytes.length?'tiles':'png'});
        }
        const jpegDeflateStarted=performance.now(),jpegDeflated=deflate(jpeg.bytes),jpegDeflateMs=performance.now()-jpegDeflateStarted;
        const regions=await page.evaluate(()=>['.small','.medium','#text','#rows p'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return{selector,x:Math.max(0,Math.floor(r.x)),y:Math.max(0,Math.floor(r.y)),right:Math.min(innerWidth,Math.ceil(r.right)),bottom:Math.min(innerHeight,Math.ceil(r.bottom))};}));
        const textCrops=regions.map(region=>{let squared=0,differing=0,channels=0;for(let y=region.y;y<region.bottom;y++)for(let x=region.x;x<region.right;x++)for(let c=0;c<3;c++){const at=(y*width+x)*4+c,d=jpeg.rgba[at]-current.rgba[at];squared+=d*d;if(d)differing++;channels++;}return{selector:region.selector,rgbRmse:channels?Math.sqrt(squared/channels):0,differingRgbPercent:channels?differing/channels*100:0};});
        let squared=0,differing=0;for(let i=0;i<current.rgba.length;i+=4)for(let channel=0;channel<3;channel++){const d=jpeg.rgba[i+channel]-current.rgba[i+channel];squared+=d*d;if(d)differing++;}
        measurements.push({name,index,pngBytes:current.bytes.length,jpeg80Bytes:jpeg.bytes.length,pngCaptureMs:current.captureMs,jpegCaptureMs:jpeg.captureMs,pngBrowserDecodeReadbackMs:current.decodeReadbackMs,jpegBrowserDecodeReadbackMs:jpeg.decodeReadbackMs,jpegRgbRmse:Math.sqrt(squared/(width*height*3)),jpegDifferingRgbChannels:differing,jpegDeflateBytes:jpegDeflated.length,jpegDeflateMs,pngWireBytes:estimatedWireBytes(current.bytes.length,'png'),jpegWireBytes:estimatedWireBytes(jpeg.bytes.length,'jpeg'),textCrops,candidates});
      }
      console.error('Measured CDP candidate '+name);
    }
    const average=(rows,key)=>round(rows.reduce((sum,row)=>sum+row[key],0)/rows.length);
    const results=cases.map(([name])=>{const rows=measurements.filter(row=>row.name===name),candidateRows=rows[0].candidates.map((candidate,index)=>{const variants=rows.map(row=>row.candidates[index]);return {mode:candidate.mode,size:candidate.size,...Object.fromEntries(Object.keys(candidate).filter(key=>typeof candidate[key]==='number'&&key!=='size').map(key=>[key,average(variants,key)])),selected:variants[0].selected};});const textCrops=rows[0].textCrops.map((crop,index)=>({selector:crop.selector,rgbRmse:average(rows.map(row=>row.textCrops[index]),'rgbRmse'),differingRgbPercent:average(rows.map(row=>row.textCrops[index]),'differingRgbPercent')}));return{name,textCrops,...Object.fromEntries(Object.keys(rows[0]).filter(key=>typeof rows[0][key]==='number'&&key!=='index').map(key=>[key,average(rows,key)])),candidates:candidateRows};});
    const keyframes=tileSizes.map(size=>{const rows=keyframeMeasurements.filter(row=>row.size===size);return{size,...Object.fromEntries(Object.keys(rows[0]).filter(key=>typeof rows[0][key]==='number'&&key!=='size'&&key!=='index').map(key=>[key,average(rows,key)]))};});
    const report={description:'Real CDP PNG/JPEG80 screencast frames at native1280x720; offline codec candidate processing, not production Eya transport or WAN. Node zlib raw DEFLATE level1; browser fflate inflateSync. Every tile candidate reconstructs exact captured PNG RGBA in Node and browser. EYT1 payload8byte header+7byte tile records; estimated wire includes JSON metadata+Noise/chunk framing, excludes WebSocket/TCP/IP/ACK. Unchanged updates omitted. Capture timing includes stop/start behavior and is not steady-state FPS. Decoder timings include copying the reference but exclude base64/test bridge and transfer. Canonical tile keyframe establishment is measured separately. Full PNG decode timing includes getImageData. JPEG differences are from separate same-state capture and are whole-image, not a legibility score.',date:new Date().toISOString(),node:process.version,chromium:browser.version(),platform:process.platform,arch:process.arch,width,height,samples,tileSizes,headerBytes,tileHeaderBytes,keyframes,keyframeMeasurements,results,measurements,sourceSha256:digest(await fs.readFile(__filename))};
    if(process.argv[2])await fs.writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({description:report.description,keyframes,results},null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
