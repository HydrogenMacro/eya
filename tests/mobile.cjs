const { chromium } = require('playwright');
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
    const barLayout = await bar.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, bottom: element.getBoundingClientRect().bottom, viewport: innerHeight }));
    if (barLayout.scrollWidth > barLayout.clientWidth || Math.abs(barLayout.bottom - barLayout.viewport) > 2) throw Error(`Mobile key bar layout is invalid: ${JSON.stringify(barLayout)}`);

    async function typeCommand(command) {
      await page.locator('#terminal').click();
      await page.keyboard.type(command);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(100);
    }
    async function waitForOutput(text) {
      await page.locator('.xterm-screen').filter({ hasText: text }).waitFor({ timeout: 5000 });
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

    await typeCommand("stty -echo -icanon; v=$(head -c 3 | od -An -t x1 | tr -d ' \\n'); stty sane; printf '\\nARROW_%s\\n' \"$v\"");
    const pad = await page.locator('#arrow-pad').boundingBox();
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
    console.log('Mobile key bar, Ctrl, paste, joystick arrows, touch selection and context menu passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
