const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');
(async()=>{
  const bundle=buildSync({stdin:{contents:"import {createCadViewer} from './cad.js';import {setKeybinds,createKeybindSettings,getKeybinds} from './keybinds.js';import * as THREE from 'three';Object.assign(window,{createCadViewer,setKeybinds,createKeybindSettings,getKeybinds,THREE});",resolveDir:path.resolve('client')},bundle:true,write:false,format:'iife'}).outputFiles[0].text;
  const template=await fs.readFile('client/template.html','utf8');
  const css=template.match(/<style>([\s\S]*?)<\/style>/)[1]+(await Promise.all(['components','themes','docking','mobile'].map(name=>fs.readFile(`client/${name}.css`,'utf8')))).join('\n');
  const browser=await chromium.launch({headless:true,executablePath:process.env.EYA_BROWSER_EXECUTABLE,args:[...(process.env.EYA_BROWSER_NO_SANDBOX?['--no-sandbox']:[]),'--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
    const page=await browser.newPage({viewport:{width:1280,height:850}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(`<style>${css}\nbody{display:flex;margin:0;height:100vh}.cad-viewer{width:100%}</style>`);await page.addScriptTag({content:bundle});
    assert.equal(await page.evaluate(async()=>{
      const geometry=new THREE.BoxGeometry(40,30,8).toNonIndexed(),position=geometry.attributes.position;
      const output=new Uint8Array(84+position.count/3*50),view=new DataView(output.buffer);view.setUint32(80,position.count/3,true);
      for(let i=0,offset=84;i<position.count;i+=3,offset+=50)for(let j=0;j<3;j++)for(let k=0;k<3;k++)view.setFloat32(offset+12+j*12+k*4,position.getComponent(i+j,k)+[30,20,0][k],true);
      window.viewer=createCadViewer({path:'/offset.stl'});document.body.append(viewer.element);return viewer.load(output);
    }),true);
    const cad=page.locator('.cad-viewer'),stage=cad.locator('.cad-stage');
    const snap=()=>page.evaluate(()=>viewer.snapshot()),setting=detail=>page.evaluate(detail=>dispatchEvent(new CustomEvent('eya-cad-settings',{detail})),detail);
    const distance=(a,b)=>Math.hypot(...a.map((value,index)=>value-b[index]));
    assert.equal(await cad.getByLabel('Navigation mode',{exact:true}).count(),0);
    const rect=await stage.boundingBox(),center={x:rect.x+rect.width*.45,y:rect.y+rect.height*.5};
    await stage.focus();let before=await snap();
    await page.keyboard.down('w');await page.waitForTimeout(80);await page.keyboard.down('w');await page.waitForTimeout(80);await page.keyboard.down('w');await page.waitForTimeout(80);
    const repeated=await snap();assert.ok(repeated.zoom>before.zoom*1.2);assert.ok(distance(repeated.position,before.position)>1);assert.equal(repeated.navigation.movementKeys,1);
    await page.keyboard.up('w');before=await snap();await page.waitForTimeout(70);assert.deepEqual((await snap()).position,before.position);assert.equal((await snap()).navigation.movementKeys,0);
    await page.keyboard.down('s');await page.waitForTimeout(140);await page.keyboard.up('s');assert.ok((await snap()).zoom<before.zoom);
    for(const key of ['a','d','q','e']){before=await snap();await page.keyboard.down(key);await page.waitForTimeout(70);await page.keyboard.up(key);assert.ok(distance((await snap()).position,before.position)>.1,key);}
    await page.mouse.move(center.x,center.y);before=await snap();await page.mouse.wheel(0,-120);await page.waitForTimeout(30);assert.ok((await snap()).zoom>before.zoom);assert.ok(distance((await snap()).position,before.position)>.1);
    await page.clock.install({time:new Date('2026-01-01T00:00:00Z')});await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
    async function forwardRate(modifier) {
      await page.evaluate(()=>viewer.fit());await stage.focus();
      if(modifier)await page.keyboard.down(modifier);
      const initial=await snap();await page.keyboard.down('w');await page.clock.runFor(180);await page.keyboard.up('w');
      if(modifier)await page.keyboard.up(modifier);
      return Math.log((await snap()).zoom/initial.zoom);
    }
    const normal=await forwardRate(),fast=await forwardRate('Shift'),slow=await forwardRate('Control');
    assert.ok(fast>normal*3 && fast<normal*5,JSON.stringify({normal,fast,slow}));assert.ok(slow<normal*.4,JSON.stringify({normal,fast,slow}));
    await page.clock.resume();
    // Looking rotates in place, including at a pole, without a heading flip.
    await page.evaluate(()=>viewer.fit());await cad.getByRole('button',{name:'Front view',exact:true}).click();before=await snap();
    await page.keyboard.down('Alt');await page.mouse.move(center.x,center.y);await page.mouse.down({button:'right'});await page.mouse.move(center.x+35,center.y+20,{steps:4});await page.mouse.up({button:'right'});await page.keyboard.up('Alt');
    assert.deepEqual((await snap()).position,before.position);assert.notDeepEqual((await snap()).target,before.target);
    await cad.getByRole('button',{name:'Top view',exact:true}).click();before=await snap();
    await page.keyboard.down('Alt');await page.mouse.move(center.x,center.y);await page.mouse.down({button:'right'});await page.mouse.move(center.x,center.y+300,{steps:8});await page.mouse.up({button:'right'});await page.keyboard.up('Alt');
    assert.ok((await snap()).navigation.quaternion.every(Number.isFinite));assert.deepEqual((await snap()).position,before.position);
    // Space acquires pointer lock without a mouse button; pointer movement pans.
    await stage.focus();await page.keyboard.down('Space');await page.waitForFunction(()=>viewer.snapshot().navigation.pointerLocked);
    before=await snap();await page.evaluate(()=>{window.lockedPanTargets=[];window.stagePanProbe=()=>lockedPanTargets.push(viewer.snapshot().target);document.addEventListener('pointermove',stagePanProbe);});
    await page.mouse.move(center.x+40,center.y+25,{steps:3});await page.waitForTimeout(30);
    const panTargets=await page.evaluate(()=>{document.removeEventListener('pointermove',stagePanProbe);return lockedPanTargets;});
    // Headless Chromium emits a reverse recenter event after each injected move.
    // Inspect each actual locked event rather than its canceling final position.
    assert.ok(panTargets.some(target=>distance(target,before.target)>.1),'Locked pointer events must pan without a mouse button');
    await page.keyboard.up('Space');await page.waitForFunction(()=>!viewer.snapshot().navigation.pointerLocked);
    // Repeated pole-facing orientations remain finite and preserve drag heading.
    for(const direction of ['Top','Bottom']){
      await cad.getByRole('button',{name:direction+' view',exact:true}).click();before=await snap();
      await page.mouse.move(center.x,center.y);await page.mouse.down();await page.mouse.move(center.x+3,center.y+3);await page.mouse.up();const after=await snap();
      assert.ok(after.navigation.quaternion.every(Number.isFinite));assert.ok(Math.abs(after.navigation.quaternion.reduce((sum,v,index)=>sum+v*before.navigation.quaternion[index],0))>.95,'Pole drag flipped camera');
    }
    await setting({orbitStyle:'free'});await cad.getByRole('button',{name:'Top view',exact:true}).click();before=await snap();
    await page.mouse.move(center.x,center.y);await page.mouse.down();await page.mouse.move(center.x+100,center.y+180,{steps:12});await page.mouse.up();let after=await snap();
    assert.ok(distance(after.navigation.up,before.navigation.up)>.05,'Free orbit must rotate camera up');assert.ok(after.navigation.quaternion.every(Number.isFinite));
    for(const [pivot,target] of [['origin',[0,0,0]],['model',[30,20,0]]]){
      await setting({orbitPivot:pivot});await page.mouse.move(center.x,center.y);await page.mouse.down();await page.mouse.move(center.x+30,center.y+15,{steps:3});await page.mouse.up();assert.ok(distance((await snap()).target,target)<1e-6,pivot);
    }
    await page.evaluate(()=>setKeybinds({'cad.orbitMouse':['Shift+MouseLeft'],'cad.panMouse':['Alt+MouseLeft'],'cad.fast':['Alt'],'cad.slow':['Shift']}));
    before=await snap();await page.mouse.move(center.x,center.y);await page.mouse.down();await page.mouse.move(center.x+35,center.y+20,{steps:4});await page.mouse.up();assert.deepEqual((await snap()).position,before.position,'Unmodified orbit must follow rebound modifier');
    await page.keyboard.down('Shift');await page.mouse.move(center.x,center.y);await page.mouse.down();await page.mouse.move(center.x+35,center.y+20,{steps:4});await page.mouse.up();await page.keyboard.up('Shift');assert.notDeepEqual((await snap()).position,before.position);
    before=await snap();await page.keyboard.down('Alt');await page.mouse.move(center.x,center.y);await page.mouse.down();await page.mouse.move(center.x+35,center.y+20,{steps:4});await page.mouse.up();await page.keyboard.up('Alt');after=await snap();assert.ok(distance(after.target,before.target)>.1);assert.ok(distance(after.navigation.quaternion,before.navigation.quaternion)<1e-6);
    await page.clock.pauseAt(new Date(await page.evaluate(()=>Date.now()+1000)));
    const customFast=await forwardRate('Alt'),customSlow=await forwardRate('Shift');assert.ok(customFast>customSlow*8,JSON.stringify({customFast,customSlow}));
    await page.clock.resume();
    // The keybind editor records a real mouse gesture with its modifier.
    await page.evaluate(()=>{window.keySettings=createKeybindSettings();keySettings.open('3D viewer');});
    const edit=page.locator('[data-action="cad.lookMouse"] .keybinds-edit');await edit.click();await page.keyboard.down('Control');await edit.click({button:'right'});await page.keyboard.up('Control');assert.deepEqual(await page.evaluate(()=>getKeybinds()['cad.lookMouse']),['Ctrl+MouseRight']);
    await page.getByRole('button',{name:'Close keyboard shortcuts',exact:true}).click();
    await stage.focus();await page.keyboard.down('w');await page.waitForTimeout(30);await page.evaluate(()=>viewer.dispose());await page.keyboard.up('w');assert.deepEqual(errors,[]);
    console.log('Always-on CAD movement, repeated keys, visible forward/back dolly, wheel, pointer-lock pan, pole/free orbit, orbit centers and configurable mouse gestures passed.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
