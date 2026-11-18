const assert = require('node:assert/strict');
const fs = require('node:fs');
const { build } = require('esbuild');
const { fixture, KEY } = require('./continuity-fixture.cjs');

(async () => {
  const f = await fixture();
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const bundle = await build({ stdin: { contents: fs.readFileSync('client/terminal-panel.js', 'utf8').replace('const terminal = new Terminal(', 'const terminal = window.testTerminal = new Terminal(').replace('function sendInput(text) {', 'function sendInput(text) { (window.sentInputs ||= []).push(text);') + '\nwindow.createTerminalPanel = createTerminalPanel;', resolveDir: require('node:path').resolve('client') }, bundle: true, platform: 'browser', format: 'iife', write: false });
    const open = async sessionId => {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, hasTouch: true });
      page.on('pageerror', error => f.errors.push(error.message));
      await page.setContent(`<style>${fs.readFileSync('client/node_modules/@xterm/xterm/css/xterm.css', 'utf8')} .instance-terminal{width:900px;height:500px}</style><button id="outside">Outside</button>`);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.evaluate(({ url, key, sessionId }) => {
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(type, ...args) { return type === 'webgl2' ? null : getContext.call(this, type, ...args); };
        window.panel = createTerminalPanel({ id: 'terminal', url, key, sessionId, restoring: !!sessionId, client: sessionId ? 'other-client' : 'first-client', command: '', transformInput(data) { window.transformedInputs ||= []; transformedInputs.push(data); const armed = window.modifierArmed; window.modifierArmed = false; return (armed ? '\x1b' : '') + data; } });
        document.body.append(panel.element); panel.onLayout();
      }, { url: f.url, key: KEY, sessionId });
      return page;
    };
    const first = await open();
    await first.waitForFunction(() => panel.api.getState().connected);
    const sessionId = await first.evaluate(() => panel.serialize().session);
    // Isolate real renderer input from shell effects while testing the pinned
    // xterm adapter. Protocol assertions below use a separate live attachment.
    await first.evaluate(() => { window.inputEvents = []; window.modifierArmed = true; window.transformedInputs = []; testTerminal.onData(data => inputEvents.push(data)); });
    await first.evaluate(() => new Promise(resolve => testTerminal.write('\r\nSELECTABLE CONTENT\r\n\x1b[?1000h\x1b[?1006h', resolve)));
    const screen = first.locator('.xterm-screen');
    const rect = await screen.boundingBox();
    await first.mouse.move(rect.x + 20, rect.y + 20); await first.mouse.down();
    await first.mouse.move(rect.x + 160, rect.y + 20, { steps: 6 }); await first.mouse.up();
    assert.equal(await first.evaluate(() => testTerminal.hasSelection()), false);
    assert.ok(await first.evaluate(() => inputEvents.some(text => /\x1b\[<0;\d+;\d+M/.test(text))), 'ordinary mouse press reaches the app');
    await first.keyboard.down('Shift'); await first.mouse.click(rect.x + 40, rect.y + 30); await first.keyboard.up('Shift');
    assert.equal(await first.evaluate(() => testTerminal.hasSelection()), false);
    assert.ok(await first.evaluate(() => inputEvents.some(text => /\x1b\[<4;\d+;\d+M/.test(text))), 'Shift mouse press remains app input');
    await first.mouse.click(rect.x + 60, rect.y + 30, { button: 'right' });
    assert.ok(await first.evaluate(() => inputEvents.some(text => /\x1b\[<2;\d+;\d+M/.test(text))), 'right mouse press reaches the app');
    await first.mouse.move(rect.x + 40, rect.y + 30); await first.mouse.wheel(0, 120);
    await first.waitForFunction(() => inputEvents.some(text => /\x1b\[<65;/.test(text)));
    const wheelEvents = await first.evaluate(() => inputEvents.filter(text => /\x1b\[<65;/.test(text)).length);
    const cdp = await first.context().newCDPSession(first);
    const touch = { x: rect.x + 90, y: rect.y + 180 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...touch, y: touch.y - 100 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await first.waitForFunction(count => inputEvents.filter(text => /\x1b\[<65;/.test(text)).length > count, wheelEvents);
    assert.equal(await first.evaluate(() => testTerminal.hasSelection()), false, 'touch drags scroll the application without selecting terminal text');
    assert.equal(await first.evaluate(() => modifierArmed), true, 'mouse reports do not consume an armed keyboard modifier');
    assert.deepEqual(await first.evaluate(() => transformedInputs), [], 'mouse reports bypass the keyboard modifier transform');
    assert.ok(await first.evaluate(() => inputEvents.every(report => sentInputs.includes(report))), 'mouse reports reach input unchanged');
    // xterm 6 emits SGR and binary reports. Exercise the exact URXVT form
    // too, so the adapter retains its boundary if an encoder offers it later.
    await first.evaluate(() => testTerminal._core.coreService.triggerDataEvent('\x1b[32;12;3M', true));
    assert.equal(await first.evaluate(() => sentInputs.at(-1)), '\x1b[32;12;3M');
    assert.equal(await first.evaluate(() => modifierArmed), true);
    await first.keyboard.type('a');
    assert.equal(await first.evaluate(() => sentInputs.at(-1)), '\x1ba', 'ordinary typed characters still use the armed keyboard modifier');
    assert.equal(await first.evaluate(() => modifierArmed), false);


    await first.evaluate(() => new Promise(resolve => testTerminal.write('\x1b[?1000l\x1b[?1006l\x1b[2J\x1b[H' + Array.from({ length: 70 }, (_, i) => `SCROLL_LINE_${i}\r\n`).join(''), resolve)));
    await first.mouse.move(rect.x + 20, rect.y + 20); await first.mouse.down(); await first.mouse.move(rect.x + 160, rect.y + 40, { steps: 6 }); await first.mouse.up();
    assert.equal(await first.evaluate(() => testTerminal.hasSelection()), false);
    const before = await first.evaluate(() => testTerminal.buffer.active.viewportY);
    await first.mouse.wheel(0, -180);
    await first.waitForFunction(before => testTerminal.buffer.active.viewportY < before, before);
    await first.evaluate(() => testTerminal.scrollToBottom());
    const touchBefore = await first.evaluate(() => testTerminal.buffer.active.viewportY);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...touch, y: touch.y + 90 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await first.waitForFunction(before => testTerminal.buffer.active.viewportY < before, touchBefore);

    await first.evaluate(() => panel.api.viewText());
    const modal = first.getByRole('dialog', { name: 'Terminal text', exact: true }); await modal.waitFor();
    const all = await modal.getByRole('textbox', { name: 'Copyable terminal text' }).inputValue();
    assert.ok(all.includes('SCROLL_LINE_0') && all.includes('SCROLL_LINE_69'), 'scrollback snapshot includes retained lines and screen');
    await modal.getByLabel('Terminal text buffer').selectOption('screen');
    const visible = await modal.getByRole('textbox', { name: 'Copyable terminal text' }).inputValue();
    assert.ok(visible.length < all.length && visible.includes('SCROLL_LINE_'), 'screen snapshot is limited to the visible viewport');
    await first.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copied = text; } }, configurable: true }));
    await modal.getByRole('button', { name: 'Copy text', exact: true }).click();
    assert.equal(await first.evaluate(() => copied), visible);
    await modal.getByRole('button', { name: 'Close terminal text', exact: true }).click();
    await first.waitForFunction(() => document.activeElement === testTerminal.textarea);
    // A competing owner only takes over on focus. The replaced visible client
    // must stay blocked rather than fighting to reclaim the session.
    const second = await open(sessionId);
    await second.getByRole('button', { name: 'Take over', exact: true }).waitFor();
    assert.equal(await second.evaluate(() => panel.api.getState().connected), false);
    await second.locator('.xterm-helper-textarea').focus();
    await second.waitForFunction(() => panel.api.getState().connected);
    await first.getByRole('button', { name: 'Take over', exact: true }).waitFor();
    await first.waitForTimeout(350);
    assert.equal(await first.evaluate(() => panel.api.getState().connected), false);
    assert.equal(await second.evaluate(() => panel.api.getState().connected), true);
    await first.locator('#outside').focus(); await first.locator('.xterm-helper-textarea').focus();
    await first.waitForFunction(() => panel.api.getState().connected);
    await second.getByRole('button', { name: 'Take over', exact: true }).waitFor();
    await second.waitForTimeout(350);
    assert.equal(await second.evaluate(() => panel.api.getState().connected), false);
    await second.evaluate(() => panel.api.focus());
    await second.waitForFunction(() => panel.api.getState().connected);
    assert.equal(await second.evaluate(() => panel.serialize().session), sessionId, 'takeover retains the same shell');
    await second.waitForFunction(() => panel.api.getState().pendingInput === 0);
    await second.evaluate(() => { panel.api.detach(); panel.api.updateOptions({ fontSize: 8 }); window.binaryEvents = []; testTerminal.onBinary(data => binaryEvents.push(data)); });
    await second.evaluate(() => new Promise(resolve => testTerminal.write('\x1b[?1000h\x1b[?1006l', resolve)));
    const legacy = await second.locator('.xterm-screen').boundingBox();
    await second.mouse.click(legacy.x + legacy.width - 25, legacy.y + 20);
    const binary = await second.evaluate(() => ({ bytes: binaryEvents.flatMap(text => [...text].map(char => char.charCodeAt(0))), pending: panel.api.getState().pendingInput }));
    assert.ok(binary.bytes.some(byte => byte > 127), 'legacy mouse report exercises non-ASCII bytes');
    assert.equal(binary.pending, binary.bytes.length, 'binary mouse input counts raw bytes rather than UTF-8 re-encoding');

    assert.deepEqual(f.errors, []);
    console.log('Terminal mouse/scroll pass-through, disabled inline selection, copyable buffer modal, and focus takeover passed');
  } finally { await browser.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
