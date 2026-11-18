const { chromium } = require('playwright');
const { reveal, selectControl, controlValue } = require('./ui-helpers.cjs');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
const path = require('node:path');
let THREE;
const {zipSync,strToU8} = require('fflate');

let root = process.env.EYA_TEST_ROOT;
const { fixture } = require('./continuity-fixture.cjs');
let suite;

function boxSTL(width) {
  const geometry = new THREE.BoxGeometry(width, 30, 8).toNonIndexed();
  const positions = geometry.attributes.position;
  const buffer = Buffer.alloc(84 + positions.count / 3 * 50);
  buffer.writeUInt32LE(positions.count / 3, 80);
  let offset = 84;
  for (let i = 0; i < positions.count; i += 3) {
    // Deliberately malformed zero facet normals exercise the viewer's normal-repair path.
    for (const value of [0, 0, 0]) { buffer.writeFloatLE(value, offset); offset += 4; }
    for (let j = 0; j < 3; j++) for (const value of [positions.getX(i + j), positions.getY(i + j), positions.getZ(i + j)]) { buffer.writeFloatLE(value, offset); offset += 4; }
    offset += 2;
  }
  geometry.dispose();
  return buffer;
}

function boxGLB() {
  const geometry = new THREE.BoxGeometry(0.04, 0.008, 0.03).toNonIndexed();
  const position = Buffer.from(geometry.attributes.position.array.buffer);
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'Plate GLB' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.8, 0.7, 1], metallicFactor: 0 } }],
    buffers: [{ byteLength: position.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: position.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: geometry.attributes.position.count, type: 'VEC3', min: [-0.02, -0.004, -0.015], max: [0.02, 0.004, 0.015] }],
  };
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32); text.copy(padded);
  const output = Buffer.alloc(12 + 8 + padded.length + 8 + position.length);
  output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(padded.length, 12); output.writeUInt32LE(0x4e4f534a, 16); padded.copy(output, 20);
  output.writeUInt32LE(position.length, 20 + padded.length); output.writeUInt32LE(0x004e4942, 24 + padded.length); position.copy(output, 28 + padded.length);
  geometry.dispose();
  return output;
}

(async () => {
  if (!root) { suite = await fixture(); root = suite.files; }
  THREE = await import('../client/node_modules/three/build/three.module.js');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: [...(process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : []), '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let page;
  try {
    await fs.writeFile(path.join(root, 'box.stl'), boxSTL(40));
    await fs.writeFile(path.join(root, 'box.glb'), boxGLB());
    const geometry3mf = new THREE.BoxGeometry(4,3,.8).toNonIndexed(), positions3mf=geometry3mf.attributes.position;
    const vertices3mf=Array.from({length:positions3mf.count},(_,i)=>`<vertex x="${positions3mf.getX(i)}" y="${positions3mf.getY(i)}" z="${positions3mf.getZ(i)}"/>`).join('');
    const triangles3mf=Array.from({length:positions3mf.count/3},(_,i)=>`<triangle v1="${i*3}" v2="${i*3+1}" v3="${i*3+2}"/>`).join('');geometry3mf.dispose();
    await fs.writeFile(path.join(root,'box.3mf'),zipSync({'_rels/.rels':strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="r0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),'3D/3dmodel.model':strToU8(`<model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" name="3MF plate"><mesh><vertices>${vertices3mf}</vertices><triangles>${triangles3mf}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`)}));
    page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.resolve('client.html')).href);
    await page.locator('#url').fill(suite?.url || 'ws://127.0.0.1:18765/ws');
    await page.locator('#key').fill('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    await page.locator('#start-connection').click();
    await page.waitForFunction(() => EyaWorkspaces.getState().workspace);
    const filesId=await page.evaluate(()=>EyaPanels.create('files'));
    await page.evaluate(path=>EyaPanels.openFile(path),path.join(root,'box.stl'));
    const cad = page.locator('.cad-viewer');
    await cad.locator('.cad-stats').filter({ hasText: 'Bounds X 40 × Y 30 × Z 8 mm' }).waitFor();
    if (!await cad.locator('canvas').count()) throw Error(`CAD canvas unavailable: ${await cad.locator('.cad-status').textContent()}`);
    const gpu = await cad.locator('canvas').evaluate(canvas => !!canvas.getContext('webgl2'));
    if (!gpu) throw Error('CAD viewer did not create a WebGL2 context');
    const panelId=await page.locator('[data-tab]').filter({hasText:'box.stl'}).getAttribute('data-panel');
    await cad.getByRole('button', { name:'Front view',exact:true }).click();
    await cad.getByRole('button', { name:'Fit',exact:true }).click();
    await cad.getByRole('tab', { name:'Selection',exact:true }).click();
    const stage = await cad.locator('.cad-stage').boundingBox();
    const center = {x:stage.x+stage.width/2,y:stage.y+stage.height/2};
    await page.mouse.click(center.x,center.y);
    await cad.locator('.cad-measurement').filter({hasText:'320 mm²'}).waitFor();
    await selectControl(page,cad.locator('select[aria-label="Pick geometry"]'),'part');await page.mouse.click(center.x,center.y);
    await cad.locator('.cad-measurement').filter({hasText:'9,600 mm³'}).waitFor();
    await cad.locator('.cad-stage').focus();await page.keyboard.press('Escape');await selectControl(page,cad.locator('select[aria-label="Pick geometry"]'),'loop');await page.mouse.click(center.x,center.y);
    await cad.locator('.cad-measurement').filter({hasText:'96 mm'}).waitFor();
    await page.mouse.move(center.x,center.y);
    if ((await page.evaluate(id => EyaPanels.call(id,'cadState'),panelId)).hoveredPart === null) throw Error('Hover did not identify a model part');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('eya-cad-settings', {detail:{movementSpeed:1}})));
    const firstPersonBefore=await page.evaluate(id=>EyaPanels.call(id,'cadState').position,panelId);
    await cad.locator('.cad-stage').focus();await page.keyboard.down('w');await page.waitForTimeout(100);await page.keyboard.up('w');
    const firstPersonAfter=await page.evaluate(id=>EyaPanels.call(id,'cadState').position,panelId);
    if(JSON.stringify(firstPersonBefore)===JSON.stringify(firstPersonAfter))throw Error('First-person movement did not move the camera');
    await selectControl(page,cad.locator('select[aria-label="CAD display mode"]'),'zebra');
    await cad.getByRole('tab',{name:'Sections',exact:true}).click();
    await cad.getByLabel('X section minimum coordinate',{exact:true}).fill('-10');
    const before=await page.evaluate(id=>EyaPanels.call(id,'cadState'),panelId);
    if(before.sectionPlanes!==3||before.gridPlanes!=='all'||!before.axisCoordinates||before.axisTickCount<6)throw Error(`Viewer helpers failed: ${JSON.stringify(before)}`);
    // Close Files: model reload must still work without an open browser panel.
    await page.evaluate(id=>EyaPanels.close(id),filesId);
    await fs.writeFile(path.join(root, 'box.stl'), boxSTL(60));
    await cad.locator('.cad-stats').filter({ hasText: 'Bounds X 60' }).waitFor({ timeout: 10000 });
    const after = await page.evaluate(id => EyaPanels.call(id, 'cadState'), panelId);
    if (JSON.stringify(before.position) !== JSON.stringify(after.position) || JSON.stringify(before.target) !== JSON.stringify(after.target) || before.zoom !== after.zoom) throw Error('Live reload reset the camera');
    if (await controlValue(cad.locator('select[aria-label="CAD display mode"]')) !== 'zebra' || after.sectionPlanes !== 3) throw Error('Live reload reset display controls');
    const revision = await cad.getAttribute('data-revision');
    await fs.writeFile(path.join(root, 'box.stl'), 'broken model');
    await cad.locator('.cad-status').filter({ hasText: 'Keeping previous model' }).waitFor({ timeout: 10000 });
    if (await cad.getAttribute('data-revision') !== revision) throw Error('Invalid model replaced the last valid model');
    await fs.writeFile(path.join(root, 'box.stl'), boxSTL(80));
    await cad.locator('.cad-stats').filter({ hasText: 'Bounds X 80' }).waitFor({ timeout: 10000 });
    await (await reveal(page, cad.getByLabel('Live reload', { exact: true }))).uncheck();
    await fs.writeFile(path.join(root, 'box.stl'), boxSTL(90));
    await page.waitForTimeout(1500);
    if (!(await cad.locator('.cad-stats').textContent()).includes('Bounds X 80')) throw Error('Paused live reload continued updating');

    await page.evaluate(path=>EyaPanels.openFile(path),path.join(root,'box.glb'));
    const glb = page.locator('.viewer[data-path$="/box.glb"] .cad-viewer');
    await glb.locator('.cad-stats').filter({ hasText: 'Bounds X 40' }).waitFor();
    await selectControl(page, glb.locator('select[aria-label="Measurement units"]'), 'cm');
    await glb.locator('.cad-stats').filter({ hasText: 'Bounds X 4 × Y 3 × Z 0.8 cm' }).waitFor();
    await selectControl(page, glb.locator('select[aria-label="Measurement units"]'), 'mm');
    await glb.getByRole('tab',{name:'Parts',exact:true}).click();
    await glb.getByLabel('Plate_GLB').uncheck();
    const showAll = glb.getByRole('button', { name: 'Show all', exact: true });
    if (await showAll.isDisabled()) throw Error('Show all was not enabled after hiding a part');
    await showAll.click();
    if (!await glb.getByLabel('Plate_GLB').isChecked()) throw Error('Show all did not restore the hidden part');
    if (process.env.EYA_TEST_BUILD123D) {
      await page.evaluate(path=>EyaPanels.openFile(path),path.join(root,'cad_model.glb'));
      await page.locator('.viewer[data-path$="/cad_model.glb"] .cad-stats').filter({ hasText: 'Bounds X 40 × Y 30 × Z 8 mm' }).waitFor();
      await selectControl(page, page.locator('.viewer[data-path$="/cad_model.glb"] select[aria-label="CAD display mode"]'), 'shaded');
      if (process.env.EYA_TEST_OUTPUT) await page.screenshot({ path: path.join(process.env.EYA_TEST_OUTPUT, 'cad-build123d.png') });
      await page.locator('[data-tab]').filter({ hasText: 'box.glb' }).click();
    }
    await page.evaluate(path=>EyaPanels.openFile(path),path.join(root,'box.3mf'));
    await page.locator('.viewer[data-path$="/box.3mf"] .cad-stats').filter({hasText:'Bounds X 40 × Y 30 × Z 8 mm'}).waitFor();
    // Unsupported external glTF resources must fail locally without making network requests.
    await fs.writeFile(path.join(root, 'external.gltf'), JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'https://example.invalid/private.bin', byteLength: 12 }] }));
    let externalRequests = 0;
    page.on('request', request => { if (request.url().includes('example.invalid')) externalRequests++; });
    await page.evaluate(path=>EyaPanels.openFile(path),path.join(root,'external.gltf'));
    await page.locator('.viewer[data-path$="/external.gltf"] .cad-status').filter({ hasText: 'relative file paths' }).waitFor();
    if (externalRequests) throw Error('glTF loaded an external resource');
    await page.locator('[data-tab]').filter({ hasText: 'box.glb' }).click();
    if (errors.length) throw Error(`CAD page errors: ${errors.join('; ')}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await glb.locator('canvas').waitFor({ state: 'visible' });
    const mobile = await glb.evaluate(element => {
      const event = new Event('touchmove', { bubbles: true, cancelable: true });
      element.querySelector('.cad-toolbar').dispatchEvent(event);
      return { width: element.getBoundingClientRect().width, viewport: innerWidth, canvasHeight: element.querySelector('canvas').clientHeight, toolbarScrollAllowed: !event.defaultPrevented || (element.querySelector('.cad-toolbar').scrollHeight <= element.querySelector('.cad-toolbar').clientHeight && element.querySelector('.cad-toolbar').scrollWidth <= element.querySelector('.cad-toolbar').clientWidth) };
    });
    if (mobile.width > mobile.viewport || mobile.canvasHeight < 60 || !mobile.toolbarScrollAllowed) throw Error(`Unusable mobile CAD layout: ${JSON.stringify(mobile)}`);
    // Simulate the visual viewport changes produced by an on-screen keyboard.
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('eya-cad-settings',{detail:{sidebar:{side:'bottom'}}})));
    await glb.getByRole('tab',{name:'Sections',exact:true}).click();
    const coordinate=glb.getByLabel('X section minimum coordinate',{exact:true});await coordinate.focus();
    await page.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:innerHeight-320});Object.defineProperty(visualViewport,'offsetTop',{configurable:true,value:120});visualViewport.dispatchEvent(new Event('resize'));});
    await page.waitForFunction(()=>document.body.getBoundingClientRect().top===120 && document.body.clientHeight===innerHeight-320);
    await page.evaluate(()=>{delete visualViewport.height;delete visualViewport.offsetTop;document.activeElement.blur();visualViewport.dispatchEvent(new Event('resize'));});
    await page.waitForFunction(()=>document.body.getBoundingClientRect().top===0 && document.body.clientHeight===Math.round(visualViewport.height));
    if(await page.evaluate(()=>scrollY!==0 || document.documentElement.scrollHeight>innerHeight))throw Error('CAD keyboard left a displaced or overflowing page');
    console.log('CAD STL/GLB/3MF loading, units, face/loop/part measurements, part visibility, camera-preserving encrypted live reload, invalid-export recovery, pause, and mobile layout passed');
  } finally {
    await page?.evaluate(() => document.getElementById('end-session')?.click()).catch(() => {});
    await browser.close();
    await suite?.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
