import { buildClient } from './build.mjs';
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

// Build both variants from identical current sources. The baseline reproduces
// the previous esbuild-only pipeline; all features and CSS stay in both builds.
const before = (await buildClient({ optimize:false, output:null })).html;
const after = (await buildClient({ output:null })).html;
const browser = await chromium.launch({headless:true,executablePath:process.env.EYA_BROWSER_EXECUTABLE,args:process.env.EYA_BROWSER_NO_SANDBOX?['--no-sandbox']:[]});
let formats;
try {
  const page=await browser.newPage();
  const generator=await readFile('client/generator.html','utf8');
  await page.route('http://eya.test/',route=>route.fulfill({contentType:'text/html',body:generator}));
  await page.goto('http://eya.test/');
  formats=await page.evaluate(async({before,after})=>{
    const encode=value=>new TextEncoder().encode(value);
    const base64=bytes=>{let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);};
    function legacySvg(html){
      const ns='http://www.w3.org/2000/svg',source=new DOMParser().parseFromString(html,'text/html'),executable=script=>!script.type||/^(application|text)\/(java|ecma)script$/i.test(script.type);
      const prelude='Object.defineProperties(document,{queryCommandSupported:{configurable:true,value:function(){return false}},createElement:{configurable:true,value:function(name,options){return document.createElementNS("http://www.w3.org/1999/xhtml",String(name).toLowerCase(),options)}}});';
      const programs=[prelude,...[...source.scripts].filter(executable).map(script=>script.textContent)];for(const script of [...source.scripts])if(executable(script))script.remove();
      const output=document.implementation.createDocument(ns,'svg'),root=output.documentElement;root.setAttribute('width','100%');root.setAttribute('height','100%');const title=output.createElementNS(ns,'title');title.textContent='Eya terminal';root.append(title);
      const foreign=output.createElementNS(ns,'foreignObject');for(const [key,value]of Object.entries({x:'0',y:'0',width:'100%',height:'100%'}))foreign.setAttribute(key,value);
      const client=output.importNode(source.documentElement,true);client.setAttribute('xmlns','http://www.w3.org/1999/xhtml');client.style.width=client.style.height='100%';foreign.append(client);root.append(foreign);
      for(const program of programs){const script=output.createElementNS(ns,'script'),url='data:application/javascript;base64,'+base64(encode(program));script.setAttribute('href',url);script.setAttributeNS('http://www.w3.org/1999/xlink','xlink:href',url);root.append(script);}
      return '<?xml version="1.0" encoding="UTF-8"?>\n'+new XMLSerializer().serializeToString(output);
    }
    async function legacyCompressed(html){const packed=new Uint8Array(await new Response(new Blob([encode(html)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());return `<!doctype html><meta charset="utf-8"><title>Eya client</title><body style="background:#10151b;color:#e4edf2;font:16px system-ui">Loading Eya…<script>(async()=>{const b=Uint8Array.from(atob('${base64(packed)}'),c=>c.charCodeAt(0)),h=await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).text();document.open();document.write(h);document.close()})().catch(e=>document.body.textContent='Could not unpack Eya: '+e)</script>`;}
    const oldCompressed=await legacyCompressed(before);
    return {
      svg:[encode(legacySvg(before)).length,encode(EyaGenerator.svgClient(after)).length],
      compressedHtml:[encode(oldCompressed).length,encode(EyaGenerator.compressedDocument(after)).length],
      compressedSvg:[null,encode(EyaGenerator.compressedSvgClient(after)).length],
      dataUrl:[('data:text/html;charset=utf-8,'+encodeURIComponent(oldCompressed)).length,EyaGenerator.dataUrl(after).length],
    };
  },{before,after});
}finally{await browser.close();}
const size=html=>({raw:Buffer.byteLength(html),gzip:gzipSync(html,{level:9}).length,brotli:brotliCompressSync(html,{params:{[constants.BROTLI_PARAM_QUALITY]:11}}).length});
const oldSize=size(before),newSize=size(after);
const rows=[['Standalone HTML',oldSize.raw,newSize.raw],['HTML gzip level9',oldSize.gzip,newSize.gzip],['HTML Brotli quality11',oldSize.brotli,newSize.brotli],['Standalone SVG',...formats.svg],['Compressed HTML',...formats.compressedHtml],['Compressed SVG',...formats.compressedSvg],['HTML data URL',...formats.dataUrl]].map(([format,before,after])=>({format,before,after,saved:before?`${((1-after/before)*100).toFixed(1)}%`:'new'}));
console.table(rows);
const output=process.argv[process.argv.indexOf('--json')+1];if(process.argv.includes('--json'))await writeFile(output,JSON.stringify({description:'Same current features; no embedded custom font or configuration.',rows},null,2)+'\n');
