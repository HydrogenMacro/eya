const assert = require('node:assert/strict');
const { deflateRawSync } = require('node:zlib');
const { buildSync } = require('esbuild');
const { chromium } = require('playwright');
const payload = (pixels, mode = 0) => {
  const compressed = deflateRawSync(pixels), bytes = Buffer.alloc(15 + compressed.length);
  bytes.write('EYT1'); bytes.writeUInt16BE(64, 4); bytes.writeUInt16BE(1, 6); bytes[10] = mode; bytes.writeUInt32BE(compressed.length, 11); compressed.copy(bytes, 15); return [...bytes];
};
const meta = (seq, base = 0, extra = {}) => ({ seq, base, width: 800, height: 450, format: 'rgba-tiles-v1', pixelWidth: 2, pixelHeight: 2, tiles: 1, ...extra });
(async () => {
  const bundle = buildSync({ entryPoints: ['client/browser-panel.js'], bundle: true, platform: 'browser', format: 'iife', globalName: 'EyaBrowserPanel', write: false }).outputFiles[0].text;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.route('http://example.test/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' })); await page.goto('http://example.test/'); await page.addScriptTag({ content: bundle });
    await page.evaluate(() => {
      window.acks = []; window.resizes = [];
      const panel = EyaBrowserPanel.createBrowserPanel({ request: async () => {}, openWebSocket: async () => {}, preferences: { stream: { format: 'efficient' } }, openRemoteBrowser: async handlers => {
        window.handlers = handlers;
        const transport = { ready: true, capabilities: [], start() { handlers.onEvent({ type: 'ready' }, 'status'); }, activateTab(tabId) { window.tabId = tabId; return Promise.resolve({}); }, navigate(url, tabId) { window.tabId = tabId; }, privacy() {}, filters() { return Promise.resolve(); }, userscripts() { return Promise.resolve(); }, ack(seq) { window.acks.push([seq, 'image']); }, ackTiles(seq, okay) { window.acks.push([seq, okay]); }, close() {}, resize(width, height, tabId, stream) {
          window.resizes.push(stream);
          if (!transport.capabilities.length) queueMicrotask(() => { transport.capabilities = ['stream-settings-v1', 'tiles-rgba-v1']; handlers.onEvent({ type: 'stream-settings', capabilities: transport.capabilities }, 'status'); });
        } };
        return transport;
      } });
      panel.element.style.cssText = 'height:600px;width:900px'; document.body.append(panel.element); window.panel = panel; panel.api.navigate('https://example.test/');
      window.frame = (bytes, metadata) => handlers.onFrame(new Uint8Array(bytes), { ...metadata, tabId: window.tabId });
      window.canvasPixel = () => [...document.querySelector('.eya-browser-remote-canvas').getContext('2d').getImageData(0, 0, 1, 1).data];
    });
    await page.waitForFunction(() => window.tabId && resizes.some(value => value.format === 'png'));
    const resizes = await page.evaluate(() => window.resizes); assert.equal(resizes[0].format, 'jpeg'); assert.ok(resizes.some(stream => stream.format === 'png' && stream.tiles));
    const red = Uint8Array.from([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);
    await page.evaluate(({ data, meta }) => frame(data, meta), { data: payload(red), meta: meta(1) }); await page.waitForFunction(() => acks.some(value => value[0] === 1));
    assert.deepEqual(await page.evaluate(() => canvasPixel()), [255, 0, 0, 255]); assert.deepEqual(await page.evaluate(() => acks.at(-1)), [1, true]);
    const xor = new Uint8Array(16); for (let i = 0; i < 16; i += 4) { xor[i] = 255; xor[i + 1] = 255; }
    await page.evaluate(({ data, meta }) => frame(data, meta), { data: payload(xor, 1), meta: meta(2, 1) }); await page.waitForFunction(() => acks.some(value => value[0] === 2)); assert.deepEqual(await page.evaluate(() => canvasPixel()), [0, 255, 0, 255]);
    // Full independent image presentation hides, but does not replace, the tile reference.
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2; const context = canvas.getContext('2d'); context.fillStyle = 'blue'; context.fillRect(0, 0, 2, 2); const blob = await new Promise(resolve => canvas.toBlob(resolve));
      handlers.onFrame(new Uint8Array(await blob.arrayBuffer()), { seq: 3, format: 'png', width: 800, height: 450, tabId });
    });
    await page.waitForFunction(() => acks.some(value => value[0] === 3)); assert.equal(await page.locator('.eya-browser-remote-canvas').isVisible(), false);
    await page.evaluate(({ meta }) => frame([69, 89, 84, 49, 0, 64, 0, 0], meta), { meta: meta(4, 2, { tiles: 0 }) }); await page.waitForFunction(() => acks.some(value => value[0] === 4));
    assert.equal(await page.locator('.eya-browser-remote-canvas').isVisible(), true); assert.deepEqual(await page.evaluate(() => canvasPixel()), [0, 255, 0, 255]);
    // The first valid tile of a malformed update is never committed to the visible canvas.
    const bad = payload(red); bad.push(0);
    await page.evaluate(({ data, meta }) => frame(data, meta), { data: bad, meta: meta(5, 4) }); await page.waitForFunction(() => acks.some(value => value[0] === 5)); assert.deepEqual(await page.evaluate(() => acks.at(-1)), [5, false]); assert.deepEqual(await page.evaluate(() => canvasPixel()), [0, 255, 0, 255]);
    await page.evaluate(({ data, meta }) => frame(data, meta), { data: payload(red), meta: meta(6) }); await page.waitForFunction(() => acks.some(value => value[0] === 6)); assert.deepEqual(await page.evaluate(() => canvasPixel()), [255, 0, 0, 255]);
    await page.evaluate(({ data, meta }) => handlers.onFrame(new Uint8Array(data), { ...meta, tabId: 'stale-tab' }), { data: payload(red), meta: meta(7) }); assert.deepEqual(await page.evaluate(() => acks.at(-1)), [7, false]);
    // A closed panel rejects a decode that was already pending and never swaps the display.
    await page.evaluate(({ data, meta }) => { frame(data, meta); panel.onClose(); }, { data: payload(xor, 1), meta: meta(8, 6) }); await page.waitForTimeout(30); assert.ok(!(await page.evaluate(() => acks)).some(value => value[0] === 8 && value[1] === true));
    console.log('Efficient negotiation fallback, atomic canvas presentation, XOR updates, retained reference across PNG fallback, malformed/stale frames and close-during-decode passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
