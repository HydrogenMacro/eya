// Offline compression experiment, not a production encoder or wire format.
// NODE_PATH=client/node_modules node scripts/browser-compression-analysis.cjs [report.json]
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const zlib = require('node:zlib');
const { performance } = require('node:perf_hooks');
const { chromium } = require('playwright');

const width = 1280, height = 720, tileSize = 64, samples = 3;
const deflate = bytes => zlib.deflateRawSync(bytes, { level: 1 });
const xor = (current, previous) => {
  const out = Buffer.alloc(current.length);
  for (let i = 0; i < out.length; i++) out[i] = current[i] ^ (previous[i] || 0);
  return out;
};
const scene = `<style>*{box-sizing:border-box}body{margin:0;background:#fff;color:#15232e;font:16px Arial}header{height:64px;padding:20px;background:#e8eff5;border-bottom:1px solid #abc}main{padding:20px;display:grid;grid-template-columns:740px 1fr;gap:20px}p{margin:0;padding:8px;border-bottom:1px solid #d6e0e8}#text{height:36px;font:18px monospace}#caret{display:inline-block;width:2px;height:18px;background:#15232e;vertical-align:middle}canvas{width:460px;height:260px}aside{background:#f1f5f8;padding:14px}</style><header>Documents / research · <b id="title">Streaming benchmark</b></header><main><section><div id="text">Editable document <i id="caret"></i></div><div id="rows">${Array.from({length:40},(_,i)=>`<p>Document ${String(i).padStart(2,'0')} · Notes, research and meeting minutes · ${i*2387} bytes</p>`).join('')}</div></section><aside><h2>Activity chart</h2><canvas width="460" height="260"></canvas><p>Mixed text and textured image</p></aside></main>`;

async function prepare(page) {
  await page.setContent(scene);
  await page.evaluate(() => {
    const c = document.querySelector('canvas'), ctx = c.getContext('2d'), image = ctx.createImageData(c.width, c.height);
    let seed = 17;
    for (let i = 0; i < image.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const n = seed >>> 24;
      image.data[i] = (i / 4 % c.width) / 3 + n / 3;
      image.data[i+1] = i / 4 / c.width / 2 + n / 4;
      image.data[i+2] = 90 + n / 2; image.data[i+3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    window.scrollTo(0, 0);
  });
}

async function capture(page, decodePage) {
  const png = await page.screenshot({ type: 'png' });
  const jpeg = await page.screenshot({ type: 'jpeg', quality: 80 });
  const rgba = Buffer.from(await decodePage.evaluate(async base64 => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), c=>c.charCodeAt(0))], {type:'image/png'}));
    const canvas = document.createElement('canvas'); canvas.width=bitmap.width; canvas.height=bitmap.height;
    const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    const chunks=[];
    for(let offset=0;offset<pixels.length;offset+=32768)chunks.push(String.fromCharCode(...pixels.subarray(offset,offset+32768)));
    return btoa(chunks.join(''));
  }, png.toString('base64')), 'base64');
  assert.equal(rgba.length, width * height * 4, 'Screenshot must match the experiment pixel dimensions');
  return { png, jpeg, rgba };
}

function analyze(previous, current) {
  const started = performance.now(), delta = xor(current.rgba, previous.rgba), compressed = deflate(delta);
  const roundtrip = xor(zlib.inflateRawSync(compressed), previous.rgba);
  assert.deepEqual(roundtrip, current.rgba);
  const fullXorMs = performance.now() - started;
  let changedPixels=0;
  for(let i=0;i<delta.length;i+=4) if(delta[i]||delta[i+1]||delta[i+2]||delta[i+3]) changedPixels++;
  const tileStart=performance.now();
  let changedTiles=0,tileRawBytes=32,tileXorBytes=32;
  for(let y=0;y<height;y+=tileSize) for(let x=0;x<width;x+=tileSize) {
    const w=Math.min(tileSize,width-x),h=Math.min(tileSize,height-y);
    const raw=Buffer.alloc(w*h*4),diff=Buffer.alloc(w*h*4);
    let changed=false;
    for(let row=0;row<h;row++) {
      const begin=((y+row)*width+x)*4;
      current.rgba.copy(raw,row*w*4,begin,begin+w*4);
      delta.copy(diff,row*w*4,begin,begin+w*4);
    }
    for(const byte of diff) if(byte){changed=true;break;}
    if(!changed)continue;
    changedTiles++;
    tileRawBytes+=16+deflate(raw).length; tileXorBytes+=16+deflate(diff).length;
  }
  const tileScanEncodeBothMs=performance.now()-tileStart;
  const jpegDelta = xor(current.jpeg, previous.jpeg);
  return { pngBytes:current.png.length,jpeg80Bytes:current.jpeg.length,jpegDeflateBytes:deflate(current.jpeg).length,
    jpegByteXorDeflateBytes:deflate(jpegDelta).length+4,
    changedPixels,changedTiles,fullRgbaXorDeflateBytes:compressed.length+32,
    changedTileRawDeflateBytes:tileRawBytes,changedTileXorDeflateBytes:tileXorBytes,
    fullXorRoundtripMs:fullXorMs,tileScanEncodeBothMs };
}

(async()=>{
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='EYA_KEY'));
  const browser=await chromium.launch({ headless:true,env,executablePath:process.env.EYA_BROWSER_EXECUTABLE });
  try {
    const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
    const decodePage=await browser.newPage();
    const cases=[
      ['unchanged',()=>{}],
      ['caret',()=>document.querySelector('#caret').style.visibility='hidden'],
      ['typing',()=>document.querySelector('#text').prepend('A newly typed sentence. ')],
      ['selection',()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('#rows p'));const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range)}],
      ['scroll-32px',()=>window.scrollBy(0,32)],
      ['image-change',()=>{const c=document.querySelector('canvas'),ctx=c.getContext('2d');ctx.fillStyle='#153b88';ctx.fillRect(0,0,c.width,c.height);ctx.fillStyle='#fff';ctx.font='24px sans-serif';ctx.fillText('New image frame',28,80)}],
    ];
    const results=[];
    for(const [name,change] of cases) {
      const rows=[];
      for(let i=0;i<samples;i++) {
        await prepare(page);
        const previous=await capture(page,decodePage);
        await page.evaluate(change);
        const current=await capture(page,decodePage);
        rows.push(analyze(previous,current));
      }
      const means=Object.fromEntries(Object.keys(rows[0]).map(key=>[key,Math.round(rows.reduce((sum,row)=>sum+row[key],0)/samples*100)/100]));
      results.push({name,...means});
      console.error('Analyzed '+name);
    }
    const report={ description:'Offline screenshot/pixel compression feasibility only; not production CDP screencast, transport, WAN, or input-to-photon measurements. DEFLATE level 1, 64px tiles, 32-byte assumed frame header, 16-byte assumed tile header, 3 samples per scene. PNG pixels round-trip exactly through full XOR+DEFLATE. PNG fidelity is relative to Chromium screenshot output.',date:'2026-11-16',node:process.version,chromium:browser.version(),platform:process.platform,arch:process.arch,width,height,tileSize,samples,results};
    if(process.argv[2])await fs.writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
