const { chromium } = require('playwright');
const { reveal } = require('./ui-helpers.cjs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.EYA_BROWSER_EXECUTABLE,
    args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [],
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => 'PASTE_OK',
        writeText: async value => { globalThis.__copiedText = value; },
      },
    });
  });
  const page = await context.newPage();
  page.on('pageerror', error => console.error('Page error:', error));
  try {
    await page.goto(pathToFileURL(path.resolve('client.html')).href);
    await page.locator('#url').fill('ws://127.0.0.1:18765/ws');
    await page.locator('#key').fill('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    await page.locator('#start-connection').click();
    await page.locator('#status').filter({ hasText: 'Connected' }).waitFor({ timeout: 10000 });

    const bar = page.locator('#keybar');
    if (!await bar.isVisible()) throw Error('Mobile key bar is not visible');
    const barLayout = await bar.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight:element.clientHeight, scrollHeight:element.scrollHeight, bottom: element.getBoundingClientRect().bottom, viewport: innerHeight }));
    if (barLayout.scrollWidth > barLayout.clientWidth || barLayout.scrollHeight > barLayout.clientHeight || Math.abs(barLayout.bottom - barLayout.viewport) > 2) throw Error(`Mobile key bar layout is invalid: ${JSON.stringify(barLayout)}`);
    if (await bar.locator('button').count() !== 14 || await bar.locator('button > svg').count() !== 14) throw Error('Mobile keys are missing icons or useful controls');
    if (process.env.EYA_TEST_OUTPUT) await page.screenshot({path:path.join(process.env.EYA_TEST_OUTPUT,'mobile-keybar.png')});
    const scrollLock = await page.evaluate(() => { scrollTo(0, 100); return { y: scrollY, htmlOverflow: getComputedStyle(document.documentElement).overflow, bodyPosition: getComputedStyle(document.body).position }; });
    if (scrollLock.y !== 0 || scrollLock.htmlOverflow !== 'hidden' || scrollLock.bodyPosition !== 'fixed') throw Error(`Full-page mobile scrolling is not locked: ${JSON.stringify(scrollLock)}`);

    await page.locator('#files').click();
    await page.locator('#file-list tr').first().waitFor({ timeout: 5000 });
    const panelLayout = await page.locator('#file-panel').evaluate(element => {
      const rect = element.getBoundingClientRect();
      const inputSizes = [...element.querySelectorAll('input')].filter(input => !input.hidden).map(input => parseFloat(getComputedStyle(input).fontSize));
      return { left: rect.left, right: rect.right, viewport: innerWidth, terminalVisible: getComputedStyle(document.querySelector('#terminal-pane')).display !== 'none', keybarVisible: getComputedStyle(document.querySelector('#keybar')).display !== 'none', inputSizes };
    });
    if (panelLayout.terminalVisible || panelLayout.keybarVisible || panelLayout.left > 5 || panelLayout.right < panelLayout.viewport - 5 || panelLayout.inputSizes.some(size => size < 16)) throw Error(`Mobile file panel layout is invalid: ${JSON.stringify(panelLayout)}`);
    await page.locator('#file-list tr').filter({ hasText: 'seed.txt' }).dblclick();
    await page.locator('.cm-content').waitFor();
    const editorBefore = await page.locator('.cm-content').evaluate(element => {
      const body = document.body.getBoundingClientRect();
      return { fontSize: parseFloat(getComputedStyle(element).fontSize), scale: visualViewport?.scale || 1, bodyWidth: body.width, bodyHeight: body.height, nested: !!element.closest('#file-panel') };
    });
    await page.locator('.cm-content').click();
    await page.waitForTimeout(150);
    const editorAfter = await page.locator('.cm-content').evaluate(element => {
      const body = document.body.getBoundingClientRect();
      return { scale: visualViewport?.scale || 1, bodyWidth: body.width, bodyHeight: body.height };
    });
    if (editorBefore.fontSize < 16 || editorBefore.nested || editorBefore.scale !== 1 || editorAfter.scale !== 1 || editorBefore.bodyWidth !== editorAfter.bodyWidth || editorBefore.bodyHeight !== editorAfter.bodyHeight) throw Error(`Mobile editor zoomed or resized the app: ${JSON.stringify({ editorBefore, editorAfter })}`);
    await page.locator('[data-tab=browser]').click();
    await (await reveal(page, '#file-close')).click();
    if (!await bar.isVisible()) throw Error('Mobile key bar was not restored after closing Files');

    async function typeCommand(command) {
      await page.locator('#terminal').click();
      await page.keyboard.type(command);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(100);
    }
    async function waitForOutput(text) {
      try { await page.waitForFunction(text => [...document.querySelectorAll('.xterm-screen')].some(screen => screen.textContent.replace(/\s/g, '').includes(text.replace(/\s/g, ''))), text, { timeout: 5000 }); }
      catch { throw Error(`Missing terminal output ${text}: ${(await page.locator('.xterm-screen').textContent()).slice(-1200)}`); }
    }

    await typeCommand("stty -echo -icanon; v=$(head -c 2 | od -An -t x1 | tr -d ' \\n'); stty sane; printf '\\nKEYS_%s\\n' \"$v\"");
    await page.locator('[data-key=escape]').click();
    await page.locator('[data-key=tab]').click();
    await waitForOutput('KEYS_1b09');

    await typeCommand("stty -echo -icanon -isig; v=$(head -c 1 | od -An -t x1 | tr -d ' \\n'); stty sane; printf '\\nCTRL_%s\\n' \"$v\"");
    await page.locator('[data-key=ctrl]').click();
    if (await page.locator('[data-key=ctrl]').getAttribute('aria-pressed') !== 'true') throw Error('Ctrl did not arm');
    await page.keyboard.type('c');
    await waitForOutput('CTRL_03');

    const keys = ['home','end','page-up','page-down','interrupt','eof','backspace','enter'];
    await typeCommand("stty -echo -icanon -isig; v=$(head -c 18 | od -An -t x1 | tr -d ' \\n'); stty sane; printf '\\nEXTRA_%s\\n' \"$v\"");
    for (const key of keys) await page.locator(`[data-key="${key}"]`).tap();
    await waitForOutput('EXTRA_1b5b481b5b461b5b357e1b5b367e03047f0a');

    await typeCommand("stty -echo -icanon -isig; v=$(head -c 6 | od -An -t x1 | tr -d ' \\n'); stty sane; printf '\\nCTRL_HOME_%s\\n' \"$v\"");
    await page.locator('[data-key=ctrl]').tap(); await page.locator('[data-key=home]').tap();
    await waitForOutput('CTRL_HOME_1b5b313b3548');

    await typeCommand("stty -echo -icanon; v=$(head -c 3 | od -An -t x1 | tr -d ' \\n'); stty sane; printf '\\nARROW_%s\\n' \"$v\"");
    const arrowKey = page.locator('#arrow-pad');
    if (await arrowKey.evaluate(element => element.tagName) !== 'BUTTON' || await page.locator('#arrow-stick').count()) throw Error('Directional control is not a normal key');
    const pad = await arrowKey.boundingBox();
    await page.mouse.move(pad.x + pad.width / 2, pad.y + pad.height / 2);
    await page.mouse.down();
    await page.mouse.move(pad.x + pad.width / 2, pad.y + 3);
    await page.mouse.up();
    await waitForOutput('ARROW_1b5b41');

    await typeCommand("stty -echo -icanon; v=$(head -c 6 | od -An -t x1 | tr -d ' \\n'); stty sane; printf '\\nARROW_REPEAT_%s\\n' \"$v\"");
    await page.mouse.move(pad.x + pad.width / 2, pad.y + pad.height / 2);
    await page.mouse.down();
    await page.mouse.move(pad.x + pad.width / 2, pad.y + 3);
    await page.waitForTimeout(460);
    await page.mouse.up();
    await waitForOutput('ARROW_REPEAT_1b5b411b5b41');

    await typeCommand("stty -echo -icanon; v=$(head -c 6 | od -An -t x1 | tr -d ' \\n'); stty sane; printf '\\nBLUR_STOP_%s\\n' \"$v\"");
    await page.mouse.move(pad.x + pad.width / 2, pad.y + pad.height / 2); await page.mouse.down();
    await page.mouse.move(pad.x + pad.width / 2, pad.y + 3);
    await page.evaluate(()=>window.dispatchEvent(new Event('blur'))); await page.waitForTimeout(500); await page.mouse.up();
    await page.keyboard.type('XYZ'); await waitForOutput('BLUR_STOP_1b5b4158595a');

    await typeCommand("stty -echo -icanon; v=$(head -c 8); stty sane; printf '\\n%s\\n' \"$v\"");
    await page.locator('[data-key=paste]').click();
    await waitForOutput('PASTE_OK');

    await typeCommand("printf 'TOUCH_SELECTION_TEXT\\n'");
    await waitForOutput('TOUCH_SELECTION_TEXT');
    const screen = await page.locator('.xterm-screen').boundingBox();
    const cdp = await context.newCDPSession(page);
    const start = { x: screen.x + 30, y: screen.y + screen.height * 0.7 };
    const end = { x: screen.x + screen.width - 30, y: start.y };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    await page.waitForTimeout(550);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.locator('#terminal-menu').waitFor({ state: 'visible', timeout: 3000 });
    if (await page.locator('#copy-selection').isDisabled()) throw Error('Touch drag did not create a terminal selection');

    await page.locator('#terminal').dispatchEvent('contextmenu', { clientX: 20, clientY: 20, button: 2 });
    await page.locator('#terminal-menu').waitFor({ state: 'visible' });
    console.log('Mobile scroll lock, file workspace, safe input sizing, key bar, Ctrl, paste, swipe-and-hold arrow key, touch selection and context menu passed');
  } finally {
    await page.evaluate(() => document.getElementById('end-session')?.click()).catch(() => {});
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
