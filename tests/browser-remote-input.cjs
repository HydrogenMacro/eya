const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');

(async () => {
  const bundle = buildSync({ entryPoints: ['client/browser-panel.js'], bundle: true, platform: 'browser', format: 'iife', globalName: 'EyaBrowser', write: false });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 2 });
    await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="margin:0"></body>' }));
    await page.goto('http://localhost/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      window.inputs = []; window.resizes = []; window.copied = []; window.acks = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async write(items) { if (window.denyClipboard) throw Error('Clipboard denied'); const blob = await items[0].getType('text/plain'); window.copied.push(await blob.text()); }, async writeText(text) { if (window.denyClipboard) throw Error('Clipboard denied'); window.copied.push(text); } } });
      const remote = document.createElement('iframe'); document.body.append(remote); remote.style.cssText = 'position:absolute;left:-2000px;width:600px;height:300px';
      remote.contentDocument.body.innerHTML = '<textarea>hello remote world</textarea><input type="password" value="secret">';
      window.remote = remote;
      const field = remote.contentDocument.querySelector('textarea'); field.focus(); field.setSelectionRange(6, 12);
      window.panel = EyaBrowser.createBrowserPanel({ request: async () => {}, openRemoteBrowser: async handlers => {
        window.handlers = handlers;
        return { ready: true, start() {}, privacy() {}, resize(w, h) { window.resizes.push([w, h]); }, async activateTab() { return {}; }, navigate(url, id) { window.tabId = id; }, input(input) { window.inputs.push(input); }, insertText(text) { window.inputs.push({ text }); }, async evaluate(id, expression) { remote.contentDocument.querySelector('textarea').focus(); try { return { result: remote.contentWindow.eval(expression) }; } finally { document.querySelector('.eya-browser-text-surface').focus(); } }, ack(seq) { window.acks.push(seq); }, close() {} };
      } });
      document.body.append(panel.element); panel.element.style.cssText = 'width:600px;height:400px';
      panel.api.navigate('https://example.test/');
      window.frame = async (width, height, seq) => {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
        handlers.onFrame(new Uint8Array(await blob.arrayBuffer()), { width, height, seq, tabId });
      };
    });
    await page.waitForFunction(() => window.tabId && window.resizes.length);
    const expected = await page.locator('.eya-browser-content').evaluate(el => [Math.round(el.getBoundingClientRect().width * devicePixelRatio), Math.round(el.getBoundingClientRect().height * devicePixelRatio)]);
    assert.deepEqual(await page.evaluate(() => window.resizes.at(-1)), expected, 'viewport matches panel content times DPR');
    await page.evaluate(async () => window.frame(1000, 500, 1));
    await page.waitForFunction(() => window.acks.includes(1));
    await page.evaluate(() => {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1.5 });
      window.dispatchEvent(new Event('resize'));
    });
    const changedDpr = await page.locator('.eya-browser-content').evaluate(el => [Math.round(el.getBoundingClientRect().width * 1.5), Math.round(el.getBoundingClientRect().height * 1.5)]);
    assert.deepEqual(await page.evaluate(() => window.resizes.at(-1)), changedDpr, 'DPR changes resize an existing panel');
    await page.evaluate(() => { panel.element.style.width = '2500px'; window.dispatchEvent(new Event('resize')); });
    assert.ok(await page.evaluate(() => window.resizes.at(-1)[0] > 1920), 'large DPR-scaled panels are not capped at 1920 pixels');
    await page.evaluate(() => { panel.element.style.width = '600px'; window.dispatchEvent(new Event('resize')); });
    const surface = page.locator('.eya-browser-text-surface');
    let rect = await surface.boundingBox();
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    let click = await page.evaluate(() => window.inputs.findLast(input => input.action === 'mousePressed'));
    assert.ok(Math.abs(click.x - 500) < 1 && Math.abs(click.y - 250) < 1, 'mouse uses displayed frame dimensions');
    await page.evaluate(() => { inputs = []; });
    await page.mouse.move(rect.x + rect.width / 4, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width * 0.7, rect.y + rect.height / 2, { steps: 5 });
    await page.mouse.up();
    assert.ok(await page.evaluate(() => inputs.some(input => input.action === 'mouseMoved' && input.buttons === 1 && input.button === 'left')), 'drag moves retain the CDP held button');
    await surface.evaluate(el => {
      const r = el.getBoundingClientRect(), common = { pointerId: 901, pointerType: 'mouse', clientX: r.x + r.width / 3, clientY: r.y + r.height / 2, bubbles: true, cancelable: true };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...common, button: 0, buttons: 1 }));
      el.dispatchEvent(new PointerEvent('pointermove', { ...common, clientX: r.x + r.width * 0.8, button: -1, buttons: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...common, clientX: r.x + r.width * 0.8, button: 0, buttons: 0 }));
    });
    assert.deepEqual(await page.evaluate(() => inputs.slice(-3).map(input => input.action)), ['mousePressed', 'mouseMoved', 'mouseReleased'], 'pending drag move precedes an immediate pointer release');
    await surface.evaluate(el => {
      const r = el.getBoundingClientRect(), common = { pointerId: 902, pointerType: 'mouse', clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, bubbles: true };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...common, button: 0, buttons: 1 }));
      el.dispatchEvent(new PointerEvent('lostpointercapture', common));
    });
    assert.deepEqual(await page.evaluate(() => { const input = inputs.at(-1); return { action: input.action, button: input.button, buttons: input.buttons }; }), { action: 'mouseReleased', button: 'left', buttons: 0 }, 'losing pointer capture releases the held remote button');
    await page.evaluate(() => { panel.element.style.width = '500px'; });
    rect = await surface.boundingBox();
    await page.mouse.click(rect.x + rect.width * 0.75, rect.y + rect.height / 2);
    click = await page.evaluate(() => window.inputs.findLast(input => input.action === 'mousePressed'));
    assert.ok(Math.abs(click.x - 750) < 1 && Math.abs(click.y - 250) < 1, 'old frame stays correctly mapped during resize');
    await surface.evaluate(el => { const bounds = el.getBoundingClientRect(); el.dispatchEvent(new WheelEvent('wheel', { clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2, deltaY: 30, bubbles: true, cancelable: true })); });
    await page.waitForFunction(() => window.inputs.some(input => input.action === 'mouseWheel'));
    assert.equal(await page.evaluate(() => window.inputs.findLast(input => input.action === 'mouseWheel').deltaY), 60, 'wheel distance scales with the displayed image');
    const before = await page.evaluate(() => window.inputs.filter(input => input.action === 'mousePressed').length);
    await page.mouse.click(rect.x + rect.width / 2, rect.y + 1);
    assert.equal(await page.evaluate(() => window.inputs.filter(input => input.action === 'mousePressed').length), before, 'letterbox bars do not click the page');
    await surface.focus();
    await page.keyboard.press('Control+c');
    await page.waitForFunction(() => window.copied.at(-1) === 'remote');
    await page.keyboard.press('Control+x');
    await page.waitForFunction(() => window.remote.contentDocument.querySelector('textarea').value === 'hello  world');
    await page.evaluate(() => { const field = remote.contentDocument.querySelector('textarea'); field.setSelectionRange(0, 5); window.denyClipboard = true; });
    await page.keyboard.press('Control+x');
    await page.getByText('Clipboard denied', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => remote.contentDocument.querySelector('textarea').value), 'hello  world', 'failed clipboard write must not delete text');
    await page.evaluate(() => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { getData: () => 'pasted text' } });
      document.querySelector('.eya-browser-text-surface').dispatchEvent(event);
    });
    assert.ok(await page.evaluate(() => window.inputs.some(input => input.text === 'pasted text')), 'paste reaches the remote input');
    await page.evaluate(() => {
      window.inputs = [];
      panel.api.sendAuxKey('Delete', { ctrlKey: true, altKey: true, shiftKey: true });
      panel.api.paste('auxiliary paste');
    });
    assert.deepEqual(await page.evaluate(() => inputs.slice(0, 2).map(({ action, key, modifiers }) => ({ action, key, modifiers }))), [
      { action: 'keyDown', key: 'Delete', modifiers: 11 }, { action: 'keyUp', key: 'Delete', modifiers: 11 },
    ]);
    assert.ok(await page.evaluate(() => inputs.some(input => input.text === 'auxiliary paste')));
    await page.evaluate(() => { inputs = []; panel.api.setAuxModifiers({ shiftKey: true }); });
    await page.keyboard.type('a');
    assert.ok(await page.evaluate(() => inputs.some(input => input.text === 'A')), 'sticky Shift modifies typed text');
    await page.evaluate(() => { inputs = []; panel.api.setAuxModifiers({ ctrlKey: true }); });
    await page.keyboard.type('c');
    assert.ok(await page.evaluate(() => inputs.some(input => input.key === 'c' && input.modifiers === 2)), 'sticky Ctrl modifies typed keys');
    assert.ok(await page.evaluate(() => !inputs.some(input => input.text === 'c')), 'Ctrl shortcut must not insert plain text');
    await page.evaluate(() => {
      const password = remote.contentDocument.querySelector('input'); password.focus(); password.select();
      if (remote.contentWindow.eval(EyaBrowser.remoteClipboardExpression()) !== '') throw Error('Password copied');
      panel.onClose();
    });
    console.log('Remote DPR sizing, displayed-frame pointer mapping, and clipboard passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
