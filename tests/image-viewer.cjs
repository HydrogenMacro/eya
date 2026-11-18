const { chromium } = require('playwright');
const esbuild = require('esbuild');
const assert = require('node:assert/strict');

(async () => {
  const bundle = await esbuild.build({ entryPoints: ['client/image-viewer.js'], bundle: true, format: 'iife', globalName: 'viewer', write: false });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage();
    await page.setContent('<style>#stage { width: 400px; height: 300px; display: flex; align-items: center; justify-content: center; overflow: hidden } img { width: 100px; height: 100px }</style><div id="stage"><img></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => { const stage = document.querySelector('#stage'); window.backgroundChanges = []; window.controls = viewer.createImageViewer(stage, stage.querySelector('img'), { onBackgroundChange: value => backgroundChanges.push(value) }); document.body.prepend(controls.backgroundControl); });
    const stage = page.locator('#stage'), image = stage.locator('img');
    const before = await image.boundingBox();
    const box = await stage.boundingBox();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2);
    await page.mouse.wheel(0, -200);
    const zoomed = await image.boundingBox();
    assert(zoomed.width > before.width, 'wheel zooms in');
    assert(Math.abs((box.x + box.width / 2 + 40 - zoomed.x) / zoomed.width - (box.x + box.width / 2 + 40 - before.x) / before.width) < 0.01, 'zoom stays anchored at pointer');
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 20); await page.mouse.up();
    const panned = await image.boundingBox();
    assert(Math.abs(panned.x - zoomed.x - 30) < 1 && Math.abs(panned.y - zoomed.y - 20) < 1, 'drag pans image');
    await stage.focus(); await page.keyboard.press('0');
    const reset = await image.boundingBox();
    assert(Math.abs(reset.x - before.x) < 1 && Math.abs(reset.width - before.width) < 1, 'keyboard resets view');
    await page.keyboard.press('ArrowRight');
    assert((await image.boundingBox()).x > reset.x, 'keyboard pans image');
    await page.evaluate(() => window.controls.reset());
    await page.evaluate(() => window.controls.zoomIn());
    assert((await image.boundingBox()).width > before.width, 'button control zooms');
    assert.equal(await page.getByRole('radiogroup', { name: 'Image background' }).count(), 1);
    await page.getByRole('radio', { name: 'White background', exact: true }).check();
    assert.equal(await stage.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
    assert.equal(await stage.evaluate(element => getComputedStyle(element).backgroundImage), 'none');
    await page.keyboard.press('ArrowRight');
    await page.getByRole('radio', { name: 'Plain background', exact: true }).waitFor();
    assert.equal(await page.getByRole('radio', { name: 'Plain background', exact: true }).isChecked(), true, 'native radio arrow navigation selects next swatch');
    assert.equal(await stage.getAttribute('data-image-background'), 'plain');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('radio', { name: 'Checkerboard background', exact: true }).isChecked(), true, 'radio navigation wraps');
    assert.match(await stage.evaluate(element => getComputedStyle(element).backgroundImage), /conic-gradient/);
    assert.deepEqual(await page.evaluate(() => backgroundChanges.map(change => change.mode)), ['white', 'plain', 'checkerboard']);
    // Legacy saved custom colors retain their rendering, without retaining the old color-picker UI.
    await page.evaluate(() => {
      const legacy = document.createElement('div'); legacy.id = 'legacy'; document.body.append(legacy);
      viewer.createImageViewer(legacy, document.createElement('img'), { background: { checkerboard: false, color1: '#123456', color2: '#abcdef' } });
    });
    assert.equal(await page.locator('#legacy').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(18, 52, 86)');
    assert.equal(await page.locator('input[type=color]').count(), 0);
    // Exercise real PNG encoding and inspect copied pixels; display transforms/backgrounds must not be baked in.
    await page.evaluate(() => {
      document.querySelector('#stage img').src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"><path fill="red" d="M0 0h1v1H0z"/></svg>');
      window.ClipboardItem = class { constructor(values) { this.values = values; } };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async items => { window.copiedImage = await items[0].values['image/png']; } } });
    });
    await page.evaluate(() => controls.copyImage());
    assert.deepEqual(await page.evaluate(async () => {
      const bitmap = await createImageBitmap(copiedImage), canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
      return { type: copiedImage.type, width: bitmap.width, height: bitmap.height, pixels: [...context.getImageData(0, 0, 2, 1).data] };
    }), { type: 'image/png', width: 2, height: 1, pixels: [255, 0, 0, 255, 0, 0, 0, 0] });
    assert.match(await page.evaluate(async () => {
      navigator.clipboard.write = async () => { throw Error('Clipboard permission denied'); };
      try { await controls.copyImage(); } catch (error) { return error.message; }
    }), /permission denied/);
    assert.match(await page.evaluate(async () => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      try { await controls.copyImage(); } catch (error) { return error.message; }
    }), /unavailable/);
    console.log('Image viewer zoom, pan, reset, background radios, legacy colors, and PNG clipboard passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
