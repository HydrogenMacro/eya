const { chromium } = require('playwright');
const { reveal, selectControl } = require('./ui-helpers.cjs');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const root = process.env.EYA_TEST_ROOT;
  if (!root) throw Error('EYA_TEST_ROOT is required');
  const THREE = await import('../client/node_modules/three/build/three.module.js');
  const geometry = new THREE.BoxGeometry(0.04, 0.008, 0.03).toNonIndexed();
  const binary = Buffer.from(geometry.attributes.position.array.buffer);
  const model = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'Regression box' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.1, 0.8, 0.6, 1], metallicFactor: 0 } }],
    buffers: [{ byteLength: binary.length, uri: 'mesh.bin' }],
    bufferViews: [{ buffer: 0, byteLength: binary.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: geometry.attributes.position.count, type: 'VEC3', min: [-0.02, -0.004, -0.015], max: [0.02, 0.004, 0.015] }],
  };
  geometry.dispose();
  await fs.writeFile(path.join(root, 'lines.py'), 'first = 1\nsecond = 2\nthird = 3\n');
  await fs.writeFile(path.join(root, 'model.gltf'), JSON.stringify(model));
  await fs.writeFile(path.join(root, 'mesh.bin'), binary);
  const embedded = structuredClone(model); embedded.buffers[0].uri = 'data:application/octet-stream;base64,' + binary.toString('base64');
  await fs.writeFile(path.join(root, 'embedded.gltf'), JSON.stringify(embedded));

  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: [...(process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : []), '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const generator = await browser.newPage({ acceptDownloads: true });
    await generator.goto('http://127.0.0.1:18765/');
    await generator.locator('#key').fill('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    await generator.locator('#format').selectOption('svg');
    const downloadPromise = generator.waitForEvent('download');
    await generator.locator('button[type=submit]').click();
    const svgPath = path.join(root, 'viewer-regression.svg');
    await (await downloadPromise).saveAs(svgPath);
    await generator.close();
    const expected = 'first = 1\ninserted = 4\nsecond = 2\nthird = 3\n';
    for (const documentUrl of [pathToFileURL(path.resolve('client.html')).href, 'http://127.0.0.1:18765/client.html', 'http://127.0.0.1:18765/client.svg', pathToFileURL(svgPath).href]) {
      await fs.writeFile(path.join(root, 'lines.py'), 'first = 1\nsecond = 2\nthird = 3\n');
      await fs.writeFile(path.join(root, 'crlf.py'), 'first = 1\r\n\r\nlast = 2\r\n');
      await fs.writeFile(path.join(root, 'mesh.bin'), binary);
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      try {
        await page.goto(documentUrl);
        await page.locator('#url').fill('ws://127.0.0.1:18765/ws');
        await page.locator('#key').fill('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
        await page.locator('#start-connection').click();
        await page.locator('#status').filter({ hasText: 'Connected' }).waitFor();
        await page.locator('#files').click();
        await page.locator('#file-list tr[data-path$="/lines.py"]').dblclick();
        await page.locator('.cm-content').waitFor();
        await page.locator('.cm-content').click();
        await page.keyboard.press('Control+Home');
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await page.keyboard.type('inserted = 4');
        const editor = await page.locator('.cm-content').evaluate(element => ({
          whitespace: getComputedStyle(element).whiteSpace,
          lines: [...element.querySelectorAll('.cm-line')].map(line => ({ text: line.textContent, y: line.getBoundingClientRect().y, height: line.getBoundingClientRect().height })),
        }));
        if (editor.lines.length !== 5 || editor.lines.some((line, index) => line.height < 16 || index > 0 && line.y < editor.lines[index - 1].y + 15)) throw Error(`Collapsed or overlapping newline in ${documentUrl}: ${JSON.stringify(editor)}`);
        await page.locator('.viewer-actions button').filter({ hasText: 'Save' }).click();
        await page.waitForTimeout(200);
        if (await fs.readFile(path.join(root, 'lines.py'), 'utf8') !== expected) throw Error(`Enter corrupted the saved document in ${documentUrl}`);
        // Enter inserts a line; Backspace rejoins it; Undo/Redo retain blank lines.
        await page.locator('.cm-content').click();
        await page.keyboard.press('Control+End'); await page.keyboard.press('Enter');
        await page.keyboard.press('Backspace'); await page.keyboard.press('Control+z');
        await page.keyboard.press('Control+y');
        await page.locator('.viewer-actions button').filter({ hasText: 'Save' }).click();
        await page.waitForTimeout(150);
        if (await fs.readFile(path.join(root, 'lines.py'), 'utf8') !== expected) throw Error(`Blank-line undo/redo corrupted ${documentUrl}`);
        await page.locator('[data-tab=browser]').click();
        await page.locator('#file-list tr').filter({ hasText: 'crlf.py' }).dblclick();
        const crlfEditor = page.locator('.viewer[data-path$="/crlf.py"]');
        await crlfEditor.locator('.cm-content').click();
        await page.keyboard.press('Control+Home'); await page.keyboard.press('End'); await page.keyboard.press('Enter');
        await page.keyboard.type('inserted = 4');
        await crlfEditor.locator('.viewer-actions button').filter({ hasText: 'Save' }).click();
        await page.waitForTimeout(150);
        if (await fs.readFile(path.join(root, 'crlf.py'), 'utf8') !== 'first = 1\r\ninserted = 4\r\n\r\nlast = 2\r\n') throw Error(`CRLF line endings were lost in ${documentUrl}`);
        await page.locator('[data-tab=browser]').click();
        await page.locator('#file-list tr').filter({ hasText: 'embedded.gltf' }).dblclick();
        await page.locator('.viewer[data-path$="/embedded.gltf"] .cad-stats').filter({ hasText: 'Bounds X 40' }).waitFor();
        await page.locator('[data-tab=browser]').click();
        await page.locator('#file-list tr').filter({ hasText: 'model.gltf' }).dblclick();
        const cad = page.locator('.viewer[data-path$="/model.gltf"] .cad-viewer');
        await cad.locator('.cad-stats').filter({ hasText: 'Bounds X 40 × Y 30 × Z 8 mm' }).waitFor();
        await (await reveal(page, cad.locator('.cad-toolbar label').filter({ hasText: 'Grid' }).locator('input'))).uncheck();
        await selectControl(page, cad.locator('select[aria-label="CAD display mode"]'), 'edges');
        const visible = await cad.locator('canvas').screenshot();
        await cad.locator('.cad-parts input').evaluateAll(inputs => inputs.forEach(input => input.click()));
        const hidden = await cad.locator('canvas').screenshot();
        if (visible.equals(hidden)) throw Error(`Model loaded but did not render any pixels in ${documentUrl}`);
        await cad.locator('.cad-parts input').evaluateAll(inputs => inputs.forEach(input => input.click()));
        const changed = Buffer.from(binary);
        for (let offset = 0; offset < changed.length; offset += 12) changed.writeFloatLE(changed.readFloatLE(offset) * 0.5, offset);
        await fs.writeFile(path.join(root, 'mesh.bin'), changed);
        await cad.locator('.cad-stats').filter({ hasText: 'Bounds X 20' }).waitFor({ timeout: 10000 });
        if (process.env.EYA_TEST_BUILD123D) {
          await page.locator('[data-tab=browser]').click();
          await page.locator('#file-list tr').filter({ hasText: 'build123d.gltf' }).dblclick();
          await page.locator('.viewer[data-path$="/build123d.gltf"] .cad-stats').filter({ hasText: 'Bounds X 40 × Y 30 × Z 8 mm' }).waitFor();
        }
        const relevantErrors = errors.filter(error => !error.includes('404 (Not Found)'));
        if (relevantErrors.length) throw Error(`Viewer errors in ${documentUrl}: ${relevantErrors.join('; ')}`);
        console.log(`Newlines, blank-line undo/redo, glTF sidecars, rendered pixels, and sidecar live reload passed: ${documentUrl}`);
      } finally {
        await page.evaluate(() => document.getElementById('end-session')?.click()).catch(() => {});
        await page.close();
      }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
