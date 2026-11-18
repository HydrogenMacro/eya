const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');

(async () => {
  const bundle=buildSync({stdin:{contents:"import {createCadViewer} from './cad.js';import * as THREE from 'three';window.createCadViewer=createCadViewer;window.THREE=THREE;",resolveDir:path.resolve('client')},bundle:true,write:false,format:'iife'}).outputFiles[0].text;
  const template=await fs.readFile('client/template.html','utf8');
  const css=template.match(/<style>([\s\S]*?)<\/style>/)[1]+(await Promise.all(['components','themes','docking','mobile'].map(name=>fs.readFile(`client/${name}.css`,'utf8')))).join('\n');
  const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
    const page=await browser.newPage({viewport:{width:1200,height:800}}), errors=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await page.setContent(`<style>${css}</style>`);await page.addScriptTag({content:bundle});
    await page.evaluate(async()=>{
      const geometry=new THREE.BoxGeometry(40.123456,30.987654,8.000001).toNonIndexed(),position=geometry.attributes.position,bytes=new Uint8Array(84+position.count/3*50),view=new DataView(bytes.buffer);view.setUint32(80,position.count/3,true);
      for(let i=0,offset=84;i<position.count;i+=3,offset+=50)for(let j=0;j<3;j++)for(let k=0;k<3;k++)view.setFloat32(offset+12+j*12+k*4,position.getComponent(i+j,k),true);
      window.viewer=createCadViewer({path:'/grid.stl',preferences:{sidebar:{collapsed:true},infiniteGrid:true}});document.body.append(viewer.element);if(!await viewer.load(bytes))throw Error('Fixture load failed');geometry.dispose();
    });
    const cad=page.locator('.cad-viewer'),canvas=cad.locator('canvas');
    const setting=detail=>page.evaluate(detail=>window.dispatchEvent(new CustomEvent('eya-cad-settings',{detail})),detail);
    await cad.locator('.cad-stats').filter({hasText:'Bounds X 40.123 × Y 30.988 × Z 8 mm'}).waitFor();
    await setting({decimalPlaces:1});await cad.locator('.cad-stats').filter({hasText:'Bounds X 40.1 × Y 31 × Z 8 mm'}).waitFor();
    await setting({decimalPlaces:0});await cad.locator('.cad-stats').filter({hasText:'Bounds X 40 × Y 31 × Z 8 mm'}).waitFor();
    await setting({decimalPlaces:3,axisCoordinates:false,rotationGizmo:false,gridPlanes:'xy',gridLines:false,gridFill:false});
    const axes=await canvas.screenshot();await setting({gridPlanes:'off'});const off=await canvas.screenshot();assert.ok(!axes.equals(off),'Axes-only must render visible axes');
    await setting({gridPlanes:'xy',gridFill:true});const filled=await canvas.screenshot();assert.ok(!filled.equals(axes),'Fill must remain with grid lines disabled');
    await setting({gridLines:true});assert.ok(!filled.equals(await canvas.screenshot()),'Grid lines must be independent of fill');
    // Read actual rendered pixels: translucent XY fill extends over the entire
    // orthographic viewport at an oblique angle, including the near foreground.
    await setting({gridLines:false,gridFill:true});
    const samples=async()=>page.evaluate(async bytes=>{
      const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'})),copy=document.createElement('canvas');copy.width=bitmap.width;copy.height=bitmap.height;const ctx=copy.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
      return [.02,.98].flatMap(y=>[.02,.5,.98].map(x=>[...ctx.getImageData(Math.floor(x*copy.width),Math.floor(y*copy.height),1,1).data]));
    },[...await canvas.screenshot()]);
    // A grazing camera puts the foreground plane across the near boundary.
    const stage=await cad.locator('.cad-stage').boundingBox(),state=await page.evaluate(()=>viewer.snapshot());
    const offset=state.position.map((value,i)=>value-state.target[i]),polar=Math.acos(offset[2]/Math.hypot(...offset));
    const dy=-(Math.PI/2-.03-polar)*Math.min(stage.width,stage.height)/(2*Math.PI);
    await page.mouse.move(stage.x+stage.width/2,stage.y+stage.height/2);await page.mouse.down();await page.mouse.move(stage.x+stage.width/2,stage.y+stage.height/2+dy,{steps:8});await page.mouse.up();await page.mouse.wheel(0,1000);
    const foreground=await samples();await setting({gridFill:false});const background=await samples();
    for(let i=0;i<foreground.length;i++)assert.notDeepEqual(foreground[i],background[i],`Grid fill missing at viewport corner ${i}`);
    await setting({gridLines:true,gridFill:true});await page.screenshot({path:'/tmp/eya-cad-grid.png'});
    assert.deepEqual(errors,[]);await page.evaluate(()=>viewer.dispose());
    console.log('CAD precision, axes-only, independent translucent fill/lines and unclipped infinite foreground grid pixels passed');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
