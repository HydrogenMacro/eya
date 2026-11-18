const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, KEY } = require('./continuity-fixture.cjs');

(async () => {
  const f = await fixture();
  try {
    const binary = path.join(f.files, 'keyboard.bin'), text = path.join(f.files, 'keyboard.txt');
    await fs.writeFile(binary, Buffer.from([0, 1, 2, 255]));
    await fs.writeFile(text, Array.from({ length: 100 }, (_, n) => `Line ${n}`).join('\n'));
    for (const type of ['html', 'svg']) {
      const seed = await f.client({ type, connect: false });
      const context = await seed.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      // Headless Chromium has no OS keyboard. Model its independent visual
      // viewport resize/pan events while keeping the real layout viewport fixed.
      await context.addInitScript(() => {
        const viewport = new EventTarget();
        Object.assign(viewport, { height: 844, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 });
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
        window.keyboardViewport = (values, event = 'resize') => { Object.assign(viewport, values); viewport.dispatchEvent(new Event(event)); };
      });
      const page = await context.newPage(); page.on('pageerror', error => f.errors.push(error.message));
      await page.goto(seed.url()); await seed.context().close();
      await page.locator('#url').fill(f.url); await page.locator('#key').fill(KEY); await page.locator('#start-connection').tap();
      await page.waitForFunction(() => EyaWorkspaces.getState().workspace);
      await page.evaluate(() => {
        const input = document.createElement('textarea'); input.className = 'eya-browser-text-surface'; input.inputMode = 'none';
        window.keyboardActivations = [];
        EyaPanels.register({ id: 'keyboard-browser-test', kind: 'web-browser', title: 'Browser test', element: input, api: {
          sendAuxKey() {}, activateKeyboard() { keyboardActivations.push(window.event?.type); input.inputMode = 'text'; input.focus(); return document.activeElement === input; },
          dismissKeyboard() { input.inputMode = 'none'; },
        } });
        EyaPanels.open('keyboard-browser-test');
      });
      await page.getByRole('button', { name: 'Activate keyboard' }).tap();
      assert.deepEqual(await page.evaluate(() => keyboardActivations), ['touchend'], `${type}: focus is requested once during the native touch gesture`);
      assert.equal(await page.evaluate(() => document.activeElement?.className), 'eya-browser-text-surface');
      async function viewport(values, event) {
        await page.evaluate(({ values, event }) => keyboardViewport(values, event), { values, event });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      async function aligned(label) {
        const state = await page.evaluate(() => {
          const body = document.body.getBoundingClientRect(), header = document.querySelector('.app-header').getBoundingClientRect();
          return { top: body.top, height: body.height, headerTop: header.top, visibleTop: visualViewport.offsetTop, visibleHeight: visualViewport.height, x: scrollX, y: scrollY, scale: visualViewport.scale };
        });
        assert(Math.abs(state.top - state.visibleTop) <= 1 && Math.abs(state.height - state.visibleHeight) <= 1 && Math.abs(state.headerTop - state.visibleTop) <= 1, `${type} ${label}: ${JSON.stringify(state)}`);
        assert.equal(state.y, 0); assert.equal(state.x, 0); assert.equal(state.scale, 1);
      }
      async function visibleInput(input) {
        assert.equal(await input.evaluate(input => { const r = input.getBoundingClientRect(); return r.top >= visualViewport.offsetTop && r.bottom <= visualViewport.offsetTop + visualViewport.height; }), true, `${type}: focused input stays above keyboard`);
      }
      await page.evaluate(file => EyaPanels.openFile(file), binary);
      const edit = page.getByRole('textbox', { name: 'Edit selected value', exact: true });
      await edit.tap(); await viewport({ height: 390, offsetTop: 230 });
      await aligned('bottom binary input'); await visibleInput(edit); await edit.fill('42');
      // A pan may arrive later, without a resize, and focus can move between
      // controls while the keyboard stays open.
      await viewport({ offsetTop: 175 }, 'scroll'); await aligned('late focus pan');
      if (type === 'html') {
        // Reproduce the separate layout-viewport scroll left by browser focus,
        // after its visual-viewport events have already settled.
        const displaced = await page.evaluate(() => {
          const probe = document.createElement('div'); probe.id = 'keyboard-scroll-probe'; probe.style.height = '1800px';
          document.documentElement.append(probe); window.scrollTo(0, 140); return scrollY;
        });
        assert.equal(displaced, 140, 'fixture produces genuine document displacement');
        await page.waitForFunction(() => scrollY === 0); await aligned('late document auto-scroll');
        await page.evaluate(() => document.getElementById('keyboard-scroll-probe').remove());
      }
      await page.evaluate(file => EyaPanels.openFile(file), text);
      const editor = page.locator('.cm-content:visible'); await editor.tap();
      await viewport({ height: 320, offsetTop: 200 }); await aligned('CodeMirror');
      await page.keyboard.press('Control+End'); await page.keyboard.type('typed');
      await viewport({ height: 844, offsetTop: 0 }); await aligned('keyboard dismissed with editor focused');
      assert.match(await editor.textContent(), /typed$/);
      await page.evaluate(() => {
        const scroller = document.createElement('div'); scroller.id = 'keyboard-scroller'; scroller.style.cssText = 'flex:1;min-height:0;overflow:auto';
        const space = document.createElement('div'); space.style.height = '540px';
        const input = document.createElement('input'); input.id = 'keyboard-bottom'; input.type = 'text'; input.setAttribute('aria-label', 'Nested bottom input');
        scroller.append(space, input);
        EyaPanels.register({ id: 'keyboard-nested', title: 'Nested input', element: scroller }); EyaPanels.open('keyboard-nested');
      });
      const nested = page.getByRole('textbox', { name: 'Nested bottom input' }); await nested.tap();
      await viewport({ height: 350, offsetTop: 180 }); await aligned('nested input'); await visibleInput(nested);
      assert((await page.locator('#keyboard-scroller').evaluate(node => node.scrollTop)) > 0);
      await page.evaluate(() => document.getElementById('settings').click());
      await page.locator('#settings-dialog .settings-category').filter({ hasText: /^Terminal$/ }).click();
      const command = page.locator('#default-command'); await command.focus();
      await viewport({ height: 300, offsetTop: 170 }); await aligned('settings'); await visibleInput(command);
      const dialog = await page.locator('#settings-dialog').boundingBox();
      assert(dialog.y >= 170 && dialog.y + dialog.height <= 470, `${type}: dialog fits visual viewport`);
      await page.locator('#close-settings').click();
      await viewport({ height: 844, offsetTop: 0 }); await aligned('dialog dismissal');
      await page.setViewportSize({ width: 844, height: 390 }); await viewport({ height: 220, offsetTop: 60, width: 844 }); await aligned('rotation');
      await viewport({ height: 390, offsetTop: 0 }); await aligned('landscape dismissal');
      // Browser/accessibility zoom is allowed to pan without our fighting it.
      await viewport({ scale: 2, height: 195, offsetTop: 80 });
      assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--eya-viewport-top')), '0px');
      await viewport({ scale: 1, height: 390, offsetTop: 0 });
      await context.close();
    }
    assert.deepEqual(f.errors, []);
    console.log('Mobile keyboard: bottom inputs, late visual pan, CodeMirror typing/dismissal, nested scrolling, settings, rotation and zoom passed in HTML/SVG.');
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
