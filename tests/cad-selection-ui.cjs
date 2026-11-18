const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');

// Exercise actual picking and native controls independently of camera navigation.
(async () => {
  const bundle=buildSync({stdin:{contents:"import {createCadSelection} from './cad-selection.js';import * as THREE from 'three';window.createCadSelection=createCadSelection;window.THREE=THREE;",resolveDir:path.resolve('client')},bundle:true,write:false,format:'iife'}).outputFiles[0].text;
  const css=await fs.readFile('client/components.css','utf8');
  const browser=await chromium.launch({headless:true,executablePath:process.env.EYA_BROWSER_EXECUTABLE,args:process.env.EYA_BROWSER_NO_SANDBOX?['--no-sandbox']:[]});
  try {
    for(const mobile of [false,true]) {
      const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:900,height:800},isMobile:mobile,hasTouch:mobile});
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'body{margin:0;background:#17232c;color:white}.cad-stage{position:relative;width:100%;height:300px}.cad-selection-panel{max-width:310px}</style><main><div class="cad-stage"></div><div class="cad-selection-panel"><div class="cad-measurement"></div></div></main>');
      await page.addScriptTag({content:bundle});
      await page.evaluate(()=>{
        window.state={unit:'mm',decimalPlaces:3,measurementColor:'#ff4f9a',measurementPointSize:1.5,selectionColor:'#66ff99',hoverHighlights:true};
        window.scene=new THREE.Scene();window.mesh=new THREE.Mesh(new THREE.BoxGeometry(40,30,8),new THREE.MeshBasicMaterial());mesh.name='Test box';scene.add(mesh);scene.updateMatrixWorld(true);
        window.camera=new THREE.OrthographicCamera(-32,32,24,-24,.01,1000);camera.position.set(0,-100,25);camera.up.set(0,0,1);camera.lookAt(0,0,0);camera.updateMatrixWorld(true);
        const stage=document.querySelector('.cad-stage'),root=document.querySelector('main');
        window.selection=createCadSelection({scene,camera,stage,root,results:document.querySelector('.cad-measurement'),getMeshes:()=>[mesh],getState:()=>state,getRadius:()=>40,getSectionPlanes:()=>[],render:()=>{},focusSelection:bounds=>{window.focusedBounds={min:bounds.min.toArray(),max:bounds.max.toArray()};}});
        selection.refresh();stage.addEventListener('click',event=>selection.select(event));
        window.pointFor=(x,z)=>{const rect=stage.getBoundingClientRect(),p=new THREE.Vector3(x,-15,z).project(camera);return {x:rect.left+(p.x+1)*rect.width/2,y:rect.top+(1-p.y)*rect.height/2};};
      });
      const click=async(x,z,modifiers=[])=>{const p=await page.evaluate(([x,z])=>pointFor(x,z),[x,z]);if(mobile)await page.touchscreen.tap(p.x,p.y);else await page.mouse.click(p.x,p.y,{modifiers});};
      const count=()=>page.locator('main').getAttribute('data-selection-count');
      assert.equal(await page.getByRole('radio',{name:'Overview',exact:true}).isChecked(),true);
      assert.equal(await page.getByRole('radio',{name:'Selection 2',exact:true}).isDisabled(),true);
      await click(-20,4,['Shift']);assert.equal(await count(),'1');assert.equal(await page.locator('main').getAttribute('data-selection-kind'),'vertex');
      await click(20,4,['Control']);assert.equal(await count(),'2');
      assert.equal(await page.evaluate(()=>scene.children.some(item=>item.material?.color?.getHexString()==='c66a20')),true,'Second selection must actually render dark orange');
      const overview=page.getByRole('table',{name:'Measurements overview',exact:true});
      assert.match(await overview.textContent(),/Closest distance ≈ 40 mm/);
      assert.match(await overview.textContent(),/ΔX, Y, Z 40, 0, 0 mm/);
      assert.equal(await page.evaluate(()=>selection.stats().labels),0);assert.ok((await page.evaluate(()=>selection.stats().guides))>0);
      await click(20,-4);assert.equal(await count(),'2');assert.equal(await page.locator('.cad-selection-error').textContent(),'Select up to 2 items.');assert.equal(await page.locator('.cad-selection-error').isVisible(),true);
      const errorBox=await page.locator('.cad-selection-error').boundingBox(),stageBox=await page.locator('.cad-stage').boundingBox();assert.ok(errorBox.x-stageBox.x<15);assert.ok(stageBox.y+stageBox.height-errorBox.y-errorBox.height<15);
      await page.getByRole('radio',{name:'Selection 1',exact:true}).check();
      const first=page.getByRole('table',{name:'Selection 1 measurements',exact:true});assert.match(await first.textContent(),/X, Y, Z -20, -15, 4 mm/);
      await page.getByRole('button',{name:'Zoom to selection 1',exact:true}).click();assert.deepEqual(await page.evaluate(()=>focusedBounds),{min:[-20,-15,4],max:[-20,-15,4]});
      await page.getByRole('button',{name:'Deselect selection 1',exact:true}).click();assert.equal(await count(),'1');assert.equal(await page.locator('.cad-selection-error').isHidden(),true);
      // The former second item becomes the first item and uses the primary color.
      assert.equal(await page.evaluate(()=>scene.children.some(item=>item.material?.color?.getHexString()==='c66a20')),false);
      await click(20,4);assert.equal(await count(),'0','Every click permanently toggles an existing selection');
      await page.getByLabel('Pick geometry',{exact:true}).selectOption('part');await click(0,0);
      await page.getByRole('radio',{name:'Selection 1',exact:true}).check();assert.match(await first.textContent(),/Volume ≈ 9,600 mm³/);
      await page.evaluate(()=>{state.unit='in';state.decimalPlaces=2;selection.refresh();});
      assert.match(await first.textContent(),/Bounds X, Y, Z 1\.57, 1\.18, 0\.31 in/);
      await page.evaluate(()=>{state.unit='cm';state.decimalPlaces=1;selection.refresh();});
      assert.match(await first.textContent(),/Bounds X, Y, Z 4, 3, 0\.8 cm/);
      // Rounded coordinates normalize negative zero instead of rendering "-0".
      await page.evaluate(()=>{selection.clear();state.unit='mm';state.decimalPlaces=2;mesh.position.x=19.999999;mesh.updateMatrixWorld(true);});
      await page.getByLabel('Pick geometry',{exact:true}).selectOption('auto');await click(0,4);await page.getByRole('radio',{name:'Selection 1',exact:true}).check();assert.match(await first.textContent(),/X, Y, Z 0, -15, 4 mm/);assert.doesNotMatch(await first.textContent(),/-0[, ]/);
      if(mobile) {
        await page.evaluate(()=>{state.unit='in';state.decimalPlaces=10;selection.refresh();});
        const radio=await page.getByRole('radio',{name:'Selection 1',exact:true}).boundingBox();assert.ok(radio.height>=44);
        const cell=first.locator('td .cad-cell-scroll').last();assert.equal(await cell.evaluate(node=>getComputedStyle(node).overflowX),'auto');assert.ok(await cell.evaluate(node=>node.scrollWidth>node.clientWidth),'Vector cell must scroll instead of widening pane');
      }
      // Orthographic silhouette endpoints overlap in screen space. Resolve
      // both ordinary ray hits and the just-outside fallback to the front.
      const silhouettes=await page.evaluate(()=>{
        selection.clear();mesh.position.set(0,0,0);mesh.updateMatrixWorld(true);
        const stage=document.querySelector('.cad-stage'),rect=stage.getBoundingClientRect(),samples=[];
        const pickAt=(point,dx=0,dy=0)=>{const projected=new THREE.Vector3(...point).project(camera);const item=selection.pick({clientX:rect.left+(projected.x+1)*rect.width/2+dx,clientY:rect.top+(1-projected.y)*rect.height/2+dy});return {kind:item?.kind,points:item?.primitives.flat().map(value=>value.toArray())};};
        for(const view of ['front','top']) {
          camera.position.set(0,view==='front'?-100:0,view==='top'?100:0);camera.up.set(0,view==='top'?1:0,view==='front'?1:0);camera.lookAt(0,0,0);camera.updateMatrixWorld(true);
          for(const x of [-20,20])for(const vertical of [-1,1]) {
            const point=view==='front'?[x,-15,vertical*4]:[x,vertical*15,4];
            samples.push({expected:point,exact:pickAt(point),outside:pickAt(point,Math.sign(x),-vertical)});
          }
          const point=view==='front'?[20,-15,0]:[20,0,4];samples.push({edge:true,view,exact:pickAt(point),outside:pickAt(point,1)});
        }
        return samples;
      });
      for(const sample of silhouettes)for(const key of ['exact','outside']) {
        assert.equal(sample[key].kind,sample.edge?'edge':'vertex',JSON.stringify(sample));
        if(sample.edge)for(const point of sample[key].points)assert.equal(point[sample.view==='front'?1:2],sample.view==='front'?-15:4,JSON.stringify(sample));
        else assert.deepEqual(sample[key].points,[sample.expected],JSON.stringify(sample));
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.evaluate(()=>selection.dispose());assert.equal(await page.locator('.cad-selection-error').count(),0);assert.deepEqual(errors,[]);
      await page.close();
    }
    console.log('CAD two-item toggle, native subtabs, compact tables, colors, limits, rounding, units, focus/deselect and mobile controls passed');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
