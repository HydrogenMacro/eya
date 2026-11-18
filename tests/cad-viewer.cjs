const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');

(async () => {
  const bundle = buildSync({ stdin:{contents:"import {createCadViewer} from './cad.js'; import * as THREE from 'three'; window.createCadViewer=createCadViewer; window.THREE=THREE;", resolveDir:path.resolve('client')}, bundle:true, write:false, format:'iife' }).outputFiles[0].text;
  const template=await fs.readFile('client/template.html','utf8');
  const css=template.match(/<style>([\s\S]*?)<\/style>/)[1]+(await Promise.all(['components','themes','docking','mobile'].map(name=>fs.readFile(`client/${name}.css`,'utf8')))).join('\n');
  const browser=await chromium.launch({headless:true,executablePath:process.env.EYA_BROWSER_EXECUTABLE,args:[...(process.env.EYA_BROWSER_NO_SANDBOX?['--no-sandbox']:[]),'--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
    const page=await browser.newPage({viewport:{width:1280,height:900}}); const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await page.setContent(`<style>${css}\nbody{display:flex;margin:0;height:100vh}.cad-viewer{width:100%}</style>`);
    await page.addScriptTag({content:bundle});
    await page.evaluate(async()=>{
      window.boxSTL=width=>{
        const geometry=new THREE.BoxGeometry(width,30,8).toNonIndexed(),position=geometry.attributes.position;
        const output=new Uint8Array(84+position.count/3*50),view=new DataView(output.buffer);view.setUint32(80,position.count/3,true);
        for(let i=0,offset=84;i<position.count;i+=3,offset+=50)for(let j=0;j<3;j++)for(let k=0;k<3;k++)view.setFloat32(offset+12+j*12+k*4,position.getComponent(i+j,k),true);
        geometry.dispose();return output;
      };
      window.viewer=createCadViewer({path:'/box.stl'});document.body.append(viewer.element);window.loaded=await viewer.load(boxSTL(40));
    });
    assert.equal(await page.evaluate(()=>loaded),true,await page.locator('.cad-status').textContent());
    const cad=page.locator('.cad-viewer'), stage=cad.locator('.cad-stage');
    await cad.locator('.cad-stats').filter({hasText:'Bounds X 40 × Y 30 × Z 8 mm'}).waitFor();
    const state=()=>page.evaluate(()=>viewer.snapshot());
    const setting=detail=>page.evaluate(detail=>window.dispatchEvent(new CustomEvent('eya-cad-settings',{detail})),detail);
    assert.equal(await cad.locator('.cad-axis-button').count(),6);
    assert.equal(await cad.locator('select[aria-label="CAD view"],select[aria-label="CAD measurement"],select[aria-label="CAD selection"]').count(),0);
    assert.equal(await cad.getByRole('tab').count(),3);
    assert.ok((await state()).axisTickCount>6);
    for (const [view,axis,sign] of [['Front','y',-1],['Back','y',1],['Left','x',-1],['Right','x',1],['Top','z',1],['Bottom','z',-1]]) {
      await cad.getByRole('button',{name:view+' view',exact:true}).click();
      const snap=await state(), index={x:0,y:1,z:2}[axis];assert.equal(Math.sign(snap.position[index]-snap.target[index]),sign);
    }
    const gizmo=await cad.locator('.cad-rotation-gizmo').boundingBox(),beforeGizmo=await state();
    await page.mouse.move(gizmo.x+gizmo.width*.3,gizmo.y+gizmo.height*.3);await page.mouse.down();await page.mouse.move(gizmo.x+gizmo.width*.6,gizmo.y+gizmo.height*.5,{steps:5});await page.mouse.up();assert.notDeepEqual((await state()).position,beforeGizmo.position);
    // Use the negative Y dot to view the 40 x 8 front face, then fit.
    await cad.getByRole('button',{name:'Front view',exact:true}).click();await cad.getByRole('button',{name:'Fit',exact:true}).click();
    const tickBefore=(await state()).axisTickStep;
    let zoomRect=await stage.boundingBox();await page.mouse.move(zoomRect.x+zoomRect.width/2,zoomRect.y+zoomRect.height/2);
    for(let i=0;i<10;i++)await page.mouse.wheel(0,-120);
    await page.waitForFunction(step=>viewer.snapshot().axisTickStep<step,tickBefore);
    await cad.getByRole('button',{name:'Fit',exact:true}).click();
    let rect=await stage.boundingBox();
    const radius=Math.sqrt(40**2+30**2+8**2)*.65;
    let pixel=rect.height/(radius*2);
    const point=(x,z)=>({x:rect.x+rect.width/2+x*pixel,y:rect.y+rect.height/2-z*pixel});
    const click=async(x,z,modifiers=[])=>{const p=point(x,z);for(const key of modifiers)await page.keyboard.down(key);await page.mouse.click(p.x,p.y);for(const key of modifiers)await page.keyboard.up(key);};
    await cad.getByRole('tab',{name:'Selection',exact:true}).click();
    const hoverPoint=point(0,0);await page.mouse.move(hoverPoint.x,hoverPoint.y);assert.equal((await state()).hoveredKind,'face');
    await page.keyboard.down('Shift');assert.equal((await state()).hoveredKind,'face');await page.keyboard.up('Shift');
    await click(0,0);await cad.locator('.cad-measurement').filter({hasText:'320 mm²'}).waitFor();assert.equal((await state()).selectionKind,'face');
    // Every camera gesture remains available while a face is selected.
    const beforeOrbit=await state();const center=point(0,0);
    await page.mouse.move(center.x,center.y);await page.mouse.down();await page.mouse.move(center.x+35,center.y+20,{steps:5});await page.mouse.up();
    assert.notDeepEqual((await state()).position,beforeOrbit.position);assert.equal((await state()).selectionCount,1);
    await cad.getByRole('button',{name:'Front view',exact:true}).click();
    await stage.focus();await page.keyboard.press('Escape');
    await cad.getByLabel('Pick geometry',{exact:true}).selectOption('part');await click(0,0);
    await cad.getByRole('radio',{name:'Selection 1',exact:true}).check();await cad.getByRole('table',{name:'Selection 1 measurements',exact:true}).filter({hasText:'9,600 mm³'}).waitFor();
    await stage.focus();await page.keyboard.press('Escape');
    await setting({stlUnit:'cm'});assert.equal((await state()).selectionCount,0);await cad.locator('.cad-stats').filter({hasText:'Bounds X 400 × Y 300 × Z 80 mm'}).waitFor();await setting({stlUnit:'mm'});
    await cad.getByLabel('Pick geometry',{exact:true}).selectOption('loop');await click(0,0);await cad.getByRole('radio',{name:'Selection 1',exact:true}).check();await cad.getByRole('table',{name:'Selection 1 measurements',exact:true}).filter({hasText:'96 mm'}).waitFor();assert.equal((await state()).selectionKind,'loop');
    await stage.focus();await page.keyboard.press('Escape');await cad.getByLabel('Pick geometry',{exact:true}).selectOption('auto');
    await click(-20,4);await click(20,4);assert.equal((await state()).selectionCount,2);await cad.getByRole('radio',{name:'Overview',exact:true}).check();await cad.getByRole('table',{name:'Measurements overview',exact:true}).filter({hasText:'40 mm'}).waitFor();
    await click(20,0);assert.equal((await state()).selectionCount,2);await cad.locator('.cad-selection-error').filter({hasText:'Select up to 2 items.'}).waitFor();
    await click(20,4);assert.equal((await state()).selectionCount,1);await click(20,0);assert.equal((await state()).selectionCount,2);assert.ok((await state()).measurementGuides>0);
    await cad.getByRole('radio',{name:'Selection 2',exact:true}).check();const beforeSelectionZoom=await state();
    await cad.getByRole('button',{name:'Zoom to selection 2',exact:true}).click();const focused=await state();
    assert.deepEqual(focused.target,[20,-15,0]);assert.ok(focused.zoom>beforeSelectionZoom.zoom);assert.equal(focused.selectionCount,2);
    await cad.getByRole('button',{name:'Fit',exact:true}).click();
    await stage.focus();await page.keyboard.press('Escape');assert.equal((await state()).selectionCount,0);
    const edge=point(20,0);await page.mouse.move(edge.x+2,edge.y);assert.equal((await state()).hoveredKind,'edge');
    await page.mouse.click(edge.x+2,edge.y);assert.equal((await state()).selectionKind,'edge');
    await stage.focus();await page.keyboard.press('Escape');assert.equal((await state()).selectionCount,0);
    // Numeric sections activate automatically; both slider ends can be dragged.
    await cad.getByRole('tab',{name:'Sections',exact:true}).click();
    const unclipped=await cad.locator('canvas').screenshot();
    const low=cad.getByLabel('X section minimum',{exact:true}),high=cad.getByLabel('X section maximum',{exact:true});
    const slider=await low.boundingBox();await page.mouse.move(slider.x+6,slider.y+slider.height/2);await page.mouse.down();await page.mouse.move(slider.x+slider.width*.2,slider.y+slider.height/2);await page.mouse.up();
    assert.ok(Number(await low.inputValue())>0);assert.equal((await state()).sectionPlanes,3);
    const clipped=await cad.locator('canvas').screenshot(),sample=point(-16,0);
    const pixelAt=async bytes=>page.evaluate(async({bytes,x,y})=>{const image=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'})),canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);const value=[...context.getImageData(Math.round(x)-2,Math.round(y)-2,5,5).data];image.close();return value;},{bytes:[...bytes],x:sample.x-rect.x,y:sample.y-rect.y});
    const beforePixel=await pixelAt(unclipped),afterPixel=await pixelAt(clipped);assert.notDeepEqual(beforePixel,afterPixel,'Section must actually remove model pixels');await setting({gridPlanes:'off'});const withoutGrid=await pixelAt(await cad.locator('canvas').screenshot());await setting({gridPlanes:'all'});assert.notDeepEqual(afterPixel,withoutGrid,'Reference grid must remain visible in the cut-away area');assert.equal((await state()).helperClipPlanes,0);

    await page.mouse.move(slider.x+slider.width-6,slider.y+slider.height/2);await page.mouse.down();await page.mouse.move(slider.x+slider.width*.8,slider.y+slider.height/2);await page.mouse.up();assert.ok(Number(await high.inputValue())<1000);
    await cad.getByRole('button',{name:'Reset',exact:true}).click();assert.equal((await state()).sectionPlanes,1);
    assert.equal(await cad.getByLabel('View section position',{exact:true}).inputValue(),'0');
    assert.ok(Number(await cad.getByLabel('Distance from camera',{exact:true}).getAttribute('min'))>0);
    assert.equal(await cad.getByLabel('Perpendicular to view',{exact:true}).count(),0);
    await setting({viewSectionDistance:20});assert.equal((await state()).viewSectionDistance,20);
    await cad.getByRole('button',{name:'Reset',exact:true}).click();
    // Display settings change rendering, not only menu labels.
    const screenshots=[];
    for(const mode of ['flat','zebra','shaded']){await setting({mode,showEdges:false});screenshots.push(await cad.locator('canvas').screenshot());}
    assert.ok(!screenshots[0].equals(screenshots[1]));assert.ok(!screenshots[1].equals(screenshots[2]));
    await setting({opacity:.5,showPoints:true,showEdges:true,gizmoSize:132,sidebar:{side:'bottom'}});
    assert.equal((await state()).opacity,.5);assert.equal((await cad.locator('.cad-rotation-gizmo').boundingBox()).width,132);
    await cad.getByRole('tab',{name:'Selection',exact:true}).click();await cad.getByRole('button',{name:'Divide sidebar',exact:true}).click();assert.equal(await cad.locator('.dock-group').count(),2);
    const reloadBefore=await state();assert.equal(await page.evaluate(()=>viewer.load(boxSTL(60))),true);const reloadAfter=await state();
    for(const key of ['position','target','zoom','mode','opacity','showPoints','showEdges','sidebar','gizmoSize','orbitStyle','orbitPivot','gridPlanes','gridLines','gridFill','infiniteGrid','decimalPlaces'])assert.deepEqual(reloadAfter[key],reloadBefore[key],`Reload changed ${key}`);
    assert.equal(await page.evaluate(()=>viewer.load(new TextEncoder().encode('broken'))),false);assert.equal((await state()).revision,reloadAfter.revision);
    // Holding one key moves immediately and continues without keyboard repeat.
    await setting({speedModifier:4,sidebar:{side:'right'}});await stage.focus();
    await page.clock.install({time:new Date('2026-01-01T00:00:00Z')});await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));

    const movement=async(modifier)=>{
      if(modifier)await page.keyboard.down(modifier);
      const before=await state();await page.keyboard.down('w');const instant=await state();await page.clock.runFor(180);const during=await state();await page.keyboard.up('w');if(modifier)await page.keyboard.up(modifier);
      const distance=(a,b)=>Math.hypot(...a.map((value,index)=>value-b[index]));assert.ok(distance(instant.position,before.position)>0);assert.ok(distance(during.position,instant.position)>0);
      return Math.log(during.zoom/before.zoom);
    };
    const normal=await movement(),fast=await movement('Shift'),slow=await movement('Control');assert.ok(fast>normal*2,JSON.stringify({normal,fast,slow}));assert.ok(slow<normal*.6,JSON.stringify({normal,fast,slow}));
    const stopped=await state();await page.clock.runFor(80);assert.deepEqual((await state()).position,stopped.position);
    await page.clock.resume();
    await page.setViewportSize({width:390,height:844});await page.waitForTimeout(30);
    assert.ok((await stage.boundingBox()).height>80);assert.ok((await stage.boundingBox()).width>=70);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:'/tmp/eya-cad-viewer.png'});
    await page.evaluate(()=>viewer.dispose());assert.equal(await page.locator('.dock-drop-preview').count(),0);
    await page.setViewportSize({width:1280,height:900});
    await page.evaluate(async()=>{
      viewer.element.remove();
      const geometry=new THREE.BoxGeometry(.01,.01,.01).toNonIndexed(),position=geometry.attributes.position;
      const bytes=new Uint8Array(position.array.buffer),base64=btoa(String.fromCharCode(...bytes));geometry.dispose();
      window.assembly=reverse=>new TextEncoder().encode(JSON.stringify({asset:{version:'2.0'},extensionsUsed:['KHR_materials_unlit'],materials:[{extensions:{KHR_materials_unlit:{}}}],scene:0,scenes:[{nodes:[0,1]}],nodes:(reverse?['PartB','PartA']:['PartA','PartB']).map((name,i)=>({name,mesh:0,translation:[i*.02,0,0]})),meshes:[{primitives:[{attributes:{POSITION:0},material:0}]}],buffers:[{byteLength:bytes.length,uri:'data:application/octet-stream;base64,'+base64}],bufferViews:[{buffer:0,byteLength:bytes.length}],accessors:[{bufferView:0,componentType:5126,count:position.count,type:'VEC3',min:[-.005,-.005,-.005],max:[.005,.005,.005]}]}));
      window.viewer=createCadViewer({path:'/assembly.gltf'});document.body.append(viewer.element);if(!await viewer.load(assembly(false)))throw Error('Assembly fixture failed');
    });
    await cad.getByRole('tab',{name:'Parts',exact:true}).click();await cad.getByLabel('PartA',{exact:true}).uncheck();
    assert.equal(await page.evaluate(()=>viewer.load(assembly(true))),true);
    const visibility=(await state()).visibleParts;assert.equal(visibility.find(part=>part.name==='PartA').visible,false);assert.equal(visibility.find(part=>part.name==='PartB').visible,true);
    await setting({mode:'zebra'});await cad.locator('canvas').screenshot();
    await setting({mode:'wireframe'});const legacy=await cad.locator('canvas').screenshot();await setting({mode:'flat'});assert.ok(!legacy.equals(await cad.locator('canvas').screenshot()));
    await page.evaluate(()=>viewer.dispose());assert.deepEqual(errors,[]);
    console.log('CAD picking, measurements, camera gestures, sections, display modes, docking, reload state, continuous movement and mobile layout passed');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
