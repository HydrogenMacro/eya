const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');

(async()=>{
  const bundle=buildSync({stdin:{contents:"import {createCadViewer} from './cad.js';import * as THREE from 'three';window.createCadViewer=createCadViewer;window.THREE=THREE;",resolveDir:path.resolve('client')},bundle:true,write:false,format:'iife'}).outputFiles[0].text;
  const template=await fs.readFile('client/template.html','utf8'),css=template.match(/<style>([\s\S]*?)<\/style>/)[1]+(await Promise.all(['components','themes','docking','mobile'].map(name=>fs.readFile(`client/${name}.css`,'utf8')))).join('\n');
  const browser=await chromium.launch({headless:true,executablePath:process.env.EYA_BROWSER_EXECUTABLE,args:[...(process.env.EYA_BROWSER_NO_SANDBOX?['--no-sandbox']:[]),'--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
    for(const mobile of [false,true]){
      const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile}),page=await context.newPage(),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\nbody{display:flex;margin:0;height:100vh}.cad-viewer{width:100%}</style>`);await page.addScriptTag({content:bundle});
      await page.evaluate(async mobile=>{
        const geometry=new THREE.BoxGeometry(40.123456,30.654321,8.987654).toNonIndexed(),position=geometry.attributes.position,bytes=new Uint8Array(84+position.count/3*50),view=new DataView(bytes.buffer);view.setUint32(80,position.count/3,true);
        for(let i=0,offset=84;i<position.count;i+=3,offset+=50)for(let j=0;j<3;j++)for(let k=0;k<3;k++)view.setFloat32(offset+12+j*12+k*4,position.getComponent(i+j,k),true);
        window.layoutBytes=bytes;window.viewer=createCadViewer({path:'/box.stl',preferences:{decimalPlaces:2,sidebar:{side:mobile?'bottom':'right',size:280}}});document.body.append(viewer.element);await viewer.load(bytes);geometry.dispose();
      },mobile);
      const cad=page.locator('.cad-viewer'),stage=cad.locator('.cad-stage'),state=()=>page.evaluate(()=>viewer.snapshot());
      assert.equal(await cad.getByLabel('Perpendicular to view',{exact:true}).count(),0);
      assert.equal((await state()).sectionPlanes,1);assert.ok((await state()).viewSectionDistance>0);assert.ok(await cad.getByLabel('Distance from camera',{exact:true}).evaluate(input=>input.validity.valid));
      assert.match(await cad.locator('.cad-stats').textContent(),/X 40\.12 × Y 30\.65 × Z 8\.99/);
      for(const axis of ['X','Y','Z']){
        const low=await cad.getByLabel(`${axis} section minimum coordinate`,{exact:true}).boundingBox(),slider=await cad.getByLabel(`${axis} section minimum`,{exact:true}).boundingBox(),high=await cad.getByLabel(`${axis} section maximum coordinate`,{exact:true}).boundingBox();
        assert.ok(low.x+low.width<=slider.x+1);assert.ok(slider.x+slider.width<=high.x+1);
        assert.ok(Math.abs(low.y+low.height/2-slider.y-slider.height/2)<2);assert.ok(Math.abs(high.y+high.height/2-slider.y-slider.height/2)<2);
        if(mobile)assert.ok(slider.height>=44);
      }
      await cad.getByLabel('X section minimum coordinate',{exact:true}).fill('-3.14159265');await stage.click({position:{x:30,y:100}});
      assert.equal(await cad.getByLabel('X section minimum coordinate',{exact:true}).inputValue(),'-3.14');
      await page.evaluate(()=>window.dispatchEvent(new CustomEvent('eya-cad-settings',{detail:{decimalPlaces:1}})));
      assert.match(await cad.locator('.cad-stats').textContent(),/X 40\.1 × Y 30\.7 × Z 9/);
      const before=await stage.boundingBox();await cad.getByRole('button',{name:'Close sidebar',exact:true}).click();
      assert.equal((await state()).sidebar.collapsed,true);assert.equal(await cad.getByRole('tab',{name:'Sections',exact:true}).count(),0);
      await page.waitForFunction(()=>{const r=document.querySelector('.cad-stage').getBoundingClientRect();return document.querySelector('.cad-layout').clientWidth===Math.round(r.width);});
      const after=await stage.boundingBox();assert.ok(mobile?after.height>before.height:after.width>before.width);
      await page.evaluate(async()=>{const sidebar=viewer.snapshot().sidebar;viewer.dispose();viewer.element.remove();window.viewer=createCadViewer({path:'/box.stl',preferences:{sidebar,decimalPlaces:1}});document.body.append(viewer.element);await viewer.load(layoutBytes);});
      assert.equal((await state()).sidebar.collapsed,true);
      const handle=await cad.getByRole('button',{name:'Open sidebar',exact:true}).boundingBox();assert.ok(Math.abs(handle.y+handle.height/2-after.y-after.height/2)<2);assert.ok(Math.abs(handle.x+handle.width-after.x-after.width)<2);
      await cad.getByRole('button',{name:'Open sidebar',exact:true}).click();assert.equal((await state()).sidebar.collapsed,false);
      await cad.getByRole('button',{name:'Reset',exact:true}).click();assert.equal((await state()).sectionPlanes,1);assert.ok((await state()).viewSectionDistance>0);
      await page.evaluate(async()=>{const bytes=layoutBytes.slice(),view=new DataView(bytes.buffer);for(let offset=84;offset<bytes.length;offset+=50)for(let vertex=0;vertex<3;vertex++)for(let axis=0;axis<3;axis++){const position=offset+12+vertex*12+axis*4;view.setFloat32(position,view.getFloat32(position,true)*1e-5,true);}await viewer.load(bytes);window.dispatchEvent(new CustomEvent('eya-cad-settings',{detail:{unit:'in',decimalPlaces:0}}));});
      await cad.getByRole('button',{name:'Reset',exact:true}).click();const nearInput=cad.getByLabel('Distance from camera',{exact:true});assert.ok(Number(await nearInput.inputValue())>0);assert.ok(Number(await nearInput.getAttribute('min'))>0);assert.match(await nearInput.inputValue(),/e-/);assert.ok(await nearInput.evaluate(input=>input.validity.valid));assert.ok((await state()).viewSectionDistance>0);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
      await page.screenshot({path:`/tmp/eya-cad-layout-${mobile?'mobile':'desktop'}.png`});await page.evaluate(()=>viewer.dispose());await context.close();
    }
    console.log('CAD compact layout: inline endpoints, precision, always-active view plane and collapsible sidebar passed on desktop/mobile');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
