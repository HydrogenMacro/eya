const { chromium } = require('playwright');
const { reveal, selectControl, controlValue } = require('./ui-helpers.cjs');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
const path = require('node:path');
let THREE;

const root = process.env.EYA_TEST_ROOT;
if (!root) throw Error('EYA_TEST_ROOT is required');

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
  THREE = await import('../client/node_modules/three/build/three.module.js');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: [...(process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : []), '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let page;
  try {
    await fs.writeFile(path.join(root, 'box.stl'), boxSTL(40));
    await fs.writeFile(path.join(root, 'box.glb'), boxGLB());
    page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.resolve('client.html')).href);
    await page.locator('#url').fill('ws://127.0.0.1:18765/ws');
    await page.locator('#key').fill('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    await page.locator('#start-connection').click();
    await page.locator('#status').filter({ hasText: 'Connected' }).waitFor();
    await page.locator('#files').click();
    await page.locator('#file-list tr').filter({ hasText: 'box.stl' }).dblclick();
    const cad = page.locator('.cad-viewer');
    await cad.locator('.cad-stats').filter({ hasText: 'Bounds X 40 × Y 30 × Z 8 mm' }).waitFor();
    if (!await cad.locator('canvas').count()) throw Error(`CAD canvas unavailable: ${await cad.locator('.cad-status').textContent()}`);
    const gpu = await cad.locator('canvas').evaluate(canvas => !!canvas.getContext('webgl2'));
    if (!gpu) throw Error('CAD viewer did not create a WebGL2 context');
    await selectControl(page, cad.locator('select[aria-label="CAD view"]'), 'front');
    await cad.getByRole('button', { name: 'Fit', exact: true }).click();
    await selectControl(page, cad.locator('select[aria-label="CAD measurement"]'), 'distance');
    await (await reveal(page, cad.getByLabel('Snap vertices', { exact: true }))).uncheck();
    const stage = await cad.locator('.cad-stage').boundingBox();
    await page.mouse.click(stage.x + stage.width / 2 - 15, stage.y + stage.height / 2);
    await page.mouse.click(stage.x + stage.width / 2 + 15, stage.y + stage.height / 2);
    await cad.locator('.cad-measurement').filter({ hasText: 'ΔX' }).waitFor();
    if ((await cad.locator('.cad-measurement').textContent()).includes('≈ 0 mm')) throw Error('Picking different surface points yielded zero distance');
    await selectControl(page, cad.locator('select[aria-label="CAD measurement"]'), 'angle');
    await page.mouse.click(stage.x + stage.width / 2 - 15, stage.y + stage.height / 2);
    await page.mouse.click(stage.x + stage.width / 2 + 15, stage.y + stage.height / 2);
    await page.mouse.click(stage.x + stage.width / 2 + 15, stage.y + stage.height / 2 - 15);
    await cad.locator('.cad-measurement').filter({ hasText: '≈ 90°' }).waitFor();
    await selectControl(page, cad.locator('select[aria-label="CAD measurement"]'), 'area');
    await page.mouse.click(stage.x + stage.width / 2, stage.y + stage.height / 2);
    await cad.locator('.cad-measurement').filter({ hasText: '320 mm²' }).waitFor();
    await selectControl(page, cad.locator('select[aria-label="CAD measurement"]'), 'volume');
    await page.mouse.click(stage.x + stage.width / 2, stage.y + stage.height / 2);
    await cad.locator('.cad-measurement').filter({ hasText: '9,600 mm³' }).waitFor();
    await selectControl(page, cad.locator('select[aria-label="CAD measurement"]'), 'off');
    await selectControl(page, cad.locator('select[aria-label="CAD selection"]'), 'face');
    await page.mouse.click(stage.x + stage.width / 2, stage.y + stage.height / 2);
    await cad.locator('.cad-measurement').filter({ hasText: 'Selected face' }).waitFor();
    await selectControl(page, cad.locator('select[aria-label="CAD selection"]'), 'loop');
    await page.mouse.click(stage.x + stage.width / 2, stage.y + stage.height / 2);
    await cad.locator('.cad-measurement').filter({ hasText: 'Selected face loop' }).waitFor();
    await selectControl(page, cad.locator('select[aria-label="CAD selection"]'), 'off');
    await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
    if ((await page.evaluate(id => EyaPanels.call(id, 'cadState'), `file:${root}/box.stl`)).hoveredPart === null) throw Error('Hover did not identify a model part');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('eya-cad-settings', { detail: { navigationMode: 'firstPerson', movementSpeed: 1 } })));
    const firstPersonBefore = await page.evaluate(id => EyaPanels.call(id, 'cadState').position, `file:${root}/box.stl`);
    await cad.locator('.cad-stage').focus(); await page.keyboard.press('w');
    const firstPersonAfter = await page.evaluate(id => EyaPanels.call(id, 'cadState').position, `file:${root}/box.stl`);
    if (JSON.stringify(firstPersonBefore) === JSON.stringify(firstPersonAfter)) throw Error('First-person W movement did not move the camera');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('eya-cad-settings', { detail: { navigationMode: 'orbit' } })));
    await selectControl(page, cad.locator('select[aria-label="CAD display mode"]'), 'wireframe');
    await selectControl(page, cad.locator('select[aria-label="Section plane"]'), 'x');
    if (await cad.locator('input[aria-label="X section minimum coordinate"]').count() !== 1 || await cad.locator('input[aria-label="X section maximum coordinate"]').count() !== 1) throw Error('Paired numerical section controls are missing');
    const panelId = `file:${root}/box.stl`;
    const before = await page.evaluate(id => EyaPanels.call(id, 'cadState'), panelId);
    if (before.sectionPlanes !== 2 || before.gridPlanes !== 'all' || !before.axisCoordinates) throw Error(`Viewer helpers were not initialized: ${JSON.stringify(before)}`);
    // Close Files: model reload must still work without an open browser panel.
    await page.evaluate(() => EyaPanels.close('browser'));
    await fs.writeFile(path.join(root, 'box.stl'), boxSTL(60));
    await cad.locator('.cad-stats').filter({ hasText: 'Bounds X 60' }).waitFor({ timeout: 10000 });
    const after = await page.evaluate(id => EyaPanels.call(id, 'cadState'), panelId);
    if (JSON.stringify(before.position) !== JSON.stringify(after.position) || JSON.stringify(before.target) !== JSON.stringify(after.target) || before.zoom !== after.zoom) throw Error('Live reload reset the camera');
    if (await controlValue(cad.locator('select[aria-label="CAD display mode"]')) !== 'wireframe' || await controlValue(cad.locator('select[aria-label="Section plane"]')) !== 'x') throw Error('Live reload reset display controls');
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

    await page.locator('#files').click();
    await page.locator('#file-list tr').filter({ hasText: 'box.glb' }).dblclick();
    const glb = page.locator('.viewer[data-path$="/box.glb"] .cad-viewer');
    await glb.locator('.cad-stats').filter({ hasText: 'Bounds X 40' }).waitFor();
    await selectControl(page, glb.locator('select[aria-label="Measurement units"]'), 'cm');
    await glb.locator('.cad-stats').filter({ hasText: 'Bounds X 4 × Y 3 × Z 0.8 cm' }).waitFor();
    await selectControl(page, glb.locator('select[aria-label="Measurement units"]'), 'mm');
    await glb.locator('.cad-parts summary').click();
    await glb.getByLabel('Plate_GLB').uncheck();
    const showAll = glb.getByRole('button', { name: 'Show all', exact: true });
    if (await showAll.isDisabled()) throw Error('Show all was not enabled after hiding a part');
    await showAll.click();
    if (!await glb.getByLabel('Plate_GLB').isChecked()) throw Error('Show all did not restore the hidden part');
    if (process.env.EYA_TEST_BUILD123D) {
      await page.locator('[data-tab=browser]').click();
      await page.locator('#file-list tr').filter({ hasText: 'cad_model.glb' }).dblclick();
      await page.locator('.viewer[data-path$="/cad_model.glb"] .cad-stats').filter({ hasText: 'Bounds X 40 × Y 30 × Z 8 mm' }).waitFor();
      await selectControl(page, page.locator('.viewer[data-path$="/cad_model.glb"] select[aria-label="CAD display mode"]'), 'edges');
      if (process.env.EYA_TEST_OUTPUT) await page.screenshot({ path: path.join(process.env.EYA_TEST_OUTPUT, 'cad-build123d.png') });
      await page.locator('[data-tab]').filter({ hasText: 'box.glb' }).click();
    }
    // Unsupported external glTF resources must fail locally without making network requests.
    await fs.writeFile(path.join(root, 'external.gltf'), JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'https://example.invalid/private.bin', byteLength: 12 }] }));
    let externalRequests = 0;
    page.on('request', request => { if (request.url().includes('example.invalid')) externalRequests++; });
    await page.locator('[data-tab=browser]').click();
    await (await reveal(page, '#file-refresh')).click();
    await page.locator('#file-list tr').filter({ hasText: 'external.gltf' }).dblclick();
    await page.locator('.viewer[data-path$="/external.gltf"] .cad-status').filter({ hasText: 'relative file paths' }).waitFor();
    if (externalRequests) throw Error('glTF loaded an external resource');
    await page.locator('[data-tab]').filter({ hasText: 'box.glb' }).click();
    if (errors.length) throw Error(`CAD page errors: ${errors.join('; ')}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await glb.locator('canvas').waitFor({ state: 'visible' });
    const mobile = await glb.evaluate(element => {
      const event = new Event('touchmove', { bubbles: true, cancelable: true });
      element.querySelector('.cad-toolbar').dispatchEvent(event);
      return { width: element.getBoundingClientRect().width, viewport: innerWidth, canvasHeight: element.querySelector('canvas').clientHeight, toolbarScrollAllowed: !event.defaultPrevented };
    });
    if (mobile.width > mobile.viewport || mobile.canvasHeight < 60 || !mobile.toolbarScrollAllowed) throw Error(`Unusable mobile CAD layout: ${JSON.stringify(mobile)}`);
    console.log('CAD STL/GLB rendering, units, part visibility, picking measurements, camera-preserving live reload, invalid-export recovery, pause, and mobile layout passed');
  } finally {
    await page?.evaluate(() => document.getElementById('end-session')?.click()).catch(() => {});
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
