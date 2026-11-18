const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');

(async()=>{
  const bundle=buildSync({stdin:{contents:"import {createCadViewer} from './cad.js';import * as THREE from 'three';window.createCadViewer=createCadViewer;window.THREE=THREE;",resolveDir:path.resolve('client')},bundle:true,write:false,format:'iife'}).outputFiles[0].text;
  const template=await fs.readFile('client/template.html','utf8'),css=template.match(/<style>([\s\S]*?)<\/style>/)[1]+(await Promise.all(['components','themes','docking','mobile','mobile-workspace'].map(name=>fs.readFile(`client/${name}.css`,'utf8')))).join('\n');
  const browser=await chromium.launch({headless:true,executablePath:process.env.EYA_BROWSER_EXECUTABLE,args:[...(process.env.EYA_BROWSER_NO_SANDBOX?['--no-sandbox']:[]),'--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>${css}</style>`);await page.addScriptTag({content:bundle});
    await page.evaluate(async()=>{
      const geometry=new THREE.BoxGeometry(40,30,8).toNonIndexed(),position=geometry.attributes.position,bytes=new Uint8Array(84+position.count/3*50),view=new DataView(bytes.buffer);view.setUint32(80,position.count/3,true);
      for(let i=0,offset=84;i<position.count;i+=3,offset+=50)for(let j=0;j<3;j++)for(let k=0;k<3;k++)view.setFloat32(offset+12+j*12+k*4,position.getComponent(i+j,k),true);
      window.viewer=createCadViewer({path:'/box.stl',preferences:{sidebar:{side:'bottom',size:280}}});document.body.append(viewer.element);await viewer.load(bytes);geometry.dispose();
    });
    const state=()=>page.evaluate(()=>viewer.snapshot()),cad=page.locator('.cad-viewer'),stage=cad.locator('.cad-stage');
    const session=await context.newCDPSession(page);
    const touch=async(type,x,y)=>session.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{x,y}],modifiers:0});
    const drag=async(from,to,check)=>{const hold=await page.evaluate(point=>!!document.elementFromPoint(point.x,point.y)?.closest('[data-dock-tab]'),from);await touch('touchStart',from.x,from.y);if(hold)await page.waitForTimeout(520);for(let i=1;i<=6;i++)await touch('touchMove',from.x+(to.x-from.x)*i/6,from.y+(to.y-from.y)*i/6);if(check)await check();await touch('touchEnd',to.x,to.y);};
    const sash=await cad.getByRole('separator',{name:'Resize sidebar',exact:true}).boundingBox();assert.ok(sash.height>=20);
    const before=(await state()).sidebar.size;
    await drag({x:sash.x+sash.width/2,y:sash.y+sash.height/2},{x:sash.x+sash.width/2,y:sash.y+sash.height/2-45});assert.ok((await state()).sidebar.size>before+25);
    const low=cad.getByLabel('X section minimum',{exact:true}),high=cad.getByLabel('X section maximum',{exact:true});let range=await low.boundingBox();assert.ok(range.height>=44);
    await drag({x:range.x+13,y:range.y+22},{x:range.x+range.width*.25,y:range.y+22});assert.ok(Number(await low.inputValue())>150);assert.equal((await state()).sectionPlanes,3);assert.equal((await state()).helperClipPlanes,0);
    await drag({x:range.x+range.width-13,y:range.y+22},{x:range.x+range.width*.75,y:range.y+22});assert.ok(Number(await high.inputValue())<850);
    // Coincident thumbs remain independently movable in both directions.
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('eya-cad-settings',{detail:{sectionRanges:{x:[.5,.5]}}})));
    range=await low.boundingBox();await drag({x:range.x+range.width/2,y:range.y+22},{x:range.x+range.width*.8,y:range.y+22});assert.ok(Number(await high.inputValue())>650);
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('eya-cad-settings',{detail:{sectionRanges:{x:[.5,.5]}}})));
    await drag({x:range.x+range.width/2,y:range.y+22},{x:range.x+range.width*.2,y:range.y+22});assert.ok(Number(await low.inputValue())<350);
    await cad.getByRole('button',{name:'Reset',exact:true}).tap();
    const number=cad.getByLabel('X section minimum coordinate',{exact:true});await number.tap();assert.ok(parseFloat(await number.evaluate(el=>getComputedStyle(el).fontSize))>=16);await number.fill('');await number.pressSequentially('-12.5');assert.equal(await number.inputValue(),'-12.5');await stage.tap();assert.equal(await number.inputValue(),'-12.5');
    assert.equal(await page.evaluate(()=>visualViewport.scale),1);assert.equal(await page.evaluate(()=>scrollY),0);assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight>innerHeight),false);
    await cad.getByRole('button',{name:'Reset',exact:true}).tap();
    // A real touch drag near a panel edge inserts even far below its strip.
    const source=await cad.getByRole('tab',{name:'Selection',exact:true}).boundingBox(),group=await cad.locator('.dock-group').boundingBox();
    await drag({x:source.x+source.width/2,y:source.y+source.height/2},{x:group.x+3,y:group.y+group.height*.65},async()=>{assert.equal(await page.locator('.dock-tab-insertion:not([hidden])').count(),1);assert.equal(await page.locator('.dock-drop-preview:not([hidden])').count(),0);});
    assert.equal(await cad.locator('.dock-group').count(),1);
    await cad.getByRole('tab',{name:'Selection',exact:true}).tap();await cad.getByRole('button',{name:'Divide sidebar',exact:true}).tap();
    assert.equal(await cad.locator('.dock-group').count(),2);assert.equal(await page.locator('.dock-drop-preview:not([hidden])').count(),0);
    // Merge back into the original strip using touch.
    const moved=await cad.getByRole('tab',{name:'Selection',exact:true}).boundingBox(),target=await cad.getByRole('tab',{name:'Parts',exact:true}).boundingBox();
    await drag({x:moved.x+moved.width/2,y:moved.y+moved.height/2},{x:target.x+target.width/2,y:target.y+target.height/2});assert.equal(await cad.locator('.dock-group').count(),1);
    await cad.getByRole('tab',{name:'Selection',exact:true}).tap();await cad.getByRole('button',{name:'Front view',exact:true}).tap();await cad.getByRole('button',{name:'Fit',exact:true}).tap();
    let rect=await stage.boundingBox();const fit=await state(),radius=Math.hypot(40,30,8)*.65,pixel=rect.height/(radius*2)*fit.zoom;
    const tapPoint=async(x,z)=>page.touchscreen.tap(rect.x+rect.width/2+x*pixel,rect.y+rect.height/2-z*pixel);
    await stage.focus();await page.keyboard.press('Escape');await tapPoint(-20,4);await tapPoint(-20,4);assert.equal((await state()).selectionCount,0);
    assert.equal(await cad.getByRole('radio',{name:'Toggle',exact:true}).count(),0);
    await tapPoint(-20,4);assert.equal((await state()).selectionCount,1);await tapPoint(20,0);assert.equal((await state()).selectionCount,2);assert.ok((await state()).measurementGuides>=1);assert.equal((await state()).annotationLabels,0);
    const distance=cad.locator('.cad-selection-distance');await distance.waitFor();assert.ok(await distance.getByRole('rowheader',{name:'ΔX, Y, Z',exact:true}).count());
    assert.ok(await cad.locator('.cad-cell-scroll').evaluateAll(cells=>cells.every(cell=>getComputedStyle(cell).overflowX==='auto')));
    await tapPoint(20,4);assert.equal((await state()).selectionCount,2);await cad.locator('.cad-selection-error:not([hidden])').waitFor();
    await cad.getByRole('radio',{name:'Selection 2',exact:true}).tap();assert.ok(await cad.getByRole('button',{name:'Zoom to selection 2',exact:true}).isEnabled());await cad.getByRole('button',{name:'Deselect selection 2',exact:true}).tap();assert.equal((await state()).selectionCount,1);assert.equal(await cad.locator('.cad-selection-error:not([hidden])').count(),0);
    await tapPoint(-20,4);assert.equal((await state()).selectionCount,0);await tapPoint(0,0);assert.equal((await state()).selectionCount,1);await cad.getByRole('radio',{name:'Overview',exact:true}).tap();await cad.locator('.cad-selection-overview').filter({hasText:'Rectangle'}).waitFor();await cad.getByRole('rowheader',{name:'1 · Side A',exact:true}).waitFor();
    const initial=await state();await page.evaluate(()=>window.dispatchEvent(new CustomEvent('eya-cad-settings',{detail:{infiniteGrid:true}})));assert.ok((await state()).gridExtent>initial.gridExtent);
    // Pinch zoom changes both numeric ticks and actual grid cell spacing.
    rect=await stage.boundingBox();await session.send('Input.synthesizePinchGesture',{x:rect.x+rect.width/2,y:rect.y+rect.height*.7,scaleFactor:2,relativeSpeed:300});
    await page.waitForFunction(zoom=>viewer.snapshot().zoom>zoom*1.5,initial.zoom);
    const zoomed=await state();assert.ok(zoomed.zoom>initial.zoom);assert.ok(zoomed.gridStep<initial.gridStep);assert.ok(zoomed.axisTickCount<=40);assert.equal(await page.evaluate(()=>visualViewport.scale),1);
    // Dispatch two actual touch contacts as well as Chromium's Ctrl-wheel pinch.
    const center={x:rect.x+rect.width/2,y:rect.y+rect.height*.7},contacts=spread=>[{id:41,x:center.x-spread,y:center.y},{id:42,x:center.x+spread,y:center.y}];
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:contacts(30)});
    for(let spread=35;spread<=60;spread+=5)await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:contacts(spread)});
    await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});assert.ok((await state()).zoom>zoomed.zoom*1.8);assert.equal((await state()).selectionCount,1);
    await page.screenshot({path:'/tmp/eya-cad-mobile.png'});assert.deepEqual(errors,[]);await page.evaluate(()=>viewer.dispose());await context.close();
    console.log('CAD real mobile touch: resize, dual sliders, coincident thumbs, tabs, two-selection toggle, radio detail tables, pattern/closest guides, pinch grids and page bounds passed');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
