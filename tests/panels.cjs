const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { selectControl } = require('./ui-helpers.cjs');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(pathToFileURL(path.resolve('client.html')).href);
    await page.locator('#close-connect').click();
    await page.evaluate(() => {
      for (const id of ['anchor', 'one', 'two', 'three']) {
        const element = document.createElement('section');
        element.textContent = id;
        element.dataset.testPanel = id;
        const input = document.createElement('input'); input.dataset.testInput = id; element.append(input);
        EyaPanels.register({ id, title: id, element, api: { focus: () => {} } });
        EyaPanels.open(id, { groupId: EyaPanels.groupOf('anchor') });
      }
      EyaPanels.split('one', 'vertical', 'anchor');
      EyaPanels.split('two', 'horizontal', 'anchor');
    });
    const first = page.locator('#workspace > .panel-split');
    const before = await first.locator(':scope > .panel-split').boundingBox();
    const sash = first.locator(':scope > .panel-sash');
    const sashBox = await sash.boundingBox();
    await page.mouse.move(sashBox.x + sashBox.width / 2, sashBox.y + 20);
    await page.mouse.down();
    await page.mouse.move(sashBox.x - 120, sashBox.y + 20);
    await page.mouse.up();
    const after = await first.locator(':scope > .panel-split').boundingBox();
    if (after.width >= before.width - 70) throw Error('Outer sash did not resize its nested split');
    await sash.focus();
    await page.keyboard.press('ArrowRight');
    const keyboardSize = await first.locator(':scope > .panel-split').boundingBox();
    if (keyboardSize.width <= after.width) throw Error('Keyboard resize did not change panel size');

    await page.evaluate(() => {
      EyaPanels.activate('three');
      EyaPanels.move('three', EyaPanels.groupOf('one'));
    });
    if (!await page.locator('[data-test-panel=anchor]').isVisible()) throw Error('Moving an active tab left its source group blank');
    await page.evaluate(() => EyaPanels.activate('one'));
    const sourceTab = page.locator('[data-panel=one]');
    const destination = page.locator('[data-panel=anchor]').locator('..');
    await sourceTab.dragTo(destination);
    const moved = await page.evaluate(() => EyaPanels.groupOf('one') === EyaPanels.groupOf('anchor'));
    if (!moved) throw Error('Dragging a tab between groups did not move it');

    // Group focus follows interaction by default, and optionally mouse hover.
    await page.evaluate(() => {
      EyaPanels.activate('anchor');
      document.querySelector('#panel-focus-border').click();
    });
    const groupTwo = page.locator('[data-test-panel=two]').locator('..').locator('..');
    await groupTwo.hover();
    if (await groupTwo.evaluate(el => el.classList.contains('mobile-active'))) throw Error('Hover changed focus in click mode');
    await page.evaluate(() => {
      const setting = document.querySelector('#panel-focus-mode');
      setting.value = 'hover';
      setting.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.mouse.move(0, 0);
    await groupTwo.hover();
    if (!await groupTwo.evaluate(el => el.classList.contains('mobile-active'))) throw Error('Hover did not focus group');
    if (!await page.locator('[data-test-input=two]').evaluate(el => el === document.activeElement)) throw Error('Hover did not transfer keyboard focus into panel');
    await page.keyboard.type('hover typing');
    if (await page.locator('[data-test-input=two]').inputValue() !== 'hover typing') throw Error('Hovered panel did not receive typing');
    if (!await page.evaluate(() => document.documentElement.classList.contains('panel-focus-border'))) throw Error('Focus border setting was not applied');
    const outline = await groupTwo.evaluate(el => { const style = getComputedStyle(el); return { width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset), style: style.outlineStyle }; });
    if (outline.width < 1 || outline.offset < 0 || outline.style !== 'solid') throw Error('Panel highlight is not outside the panel');
    // Hovering the workbench behind a modal must keep its text field focused.
    await page.evaluate(() => {
      const dialog = document.createElement('dialog'); dialog.id = 'hover-dialog';
      const input = document.createElement('input'); dialog.append(input); document.body.append(dialog); dialog.showModal(); input.focus();
    });
    await page.mouse.move(0, 0);
    const otherBox = await page.locator('[data-test-panel=anchor]').boundingBox();
    await page.mouse.move(otherBox.x + 10, otherBox.y + 10);
    if (!await page.locator('#hover-dialog input').evaluate(el => el === document.activeElement)) throw Error('Hover stole modal focus');
    await page.evaluate(() => document.querySelector('#hover-dialog').remove());
    await page.evaluate(() => EyaPanels.activate('anchor'));
    await page.locator('[data-panel=anchor]').locator('..').locator('..').getByRole('button', { name: 'Panel layout', exact: true }).click();
    await page.mouse.move(0, 0); await groupTwo.hover();
    if (await groupTwo.evaluate(el => el.classList.contains('mobile-active'))) throw Error('Hover changed panel behind open menu');
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      // The legacy context menus route actions through the active panel too.
      EyaPanels.activate('anchor'); document.querySelector('#terminal-menu').hidden = false;
    });
    await page.mouse.move(0, 0); await groupTwo.hover();
    if (await groupTwo.evaluate(el => el.classList.contains('mobile-active'))) throw Error('Hover changed panel behind terminal context menu');
    await page.evaluate(() => document.querySelector('#terminal-menu').hidden = true);
    await page.evaluate(() => {
      const setting = document.querySelector('#panel-focus-mode');
      setting.value = 'click';
      setting.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('[data-panel=anchor]').focus();
    });
    if (!await page.locator('[data-panel=anchor]').evaluate(el => el.closest('.panel-group').classList.contains('mobile-active'))) throw Error('Keyboard focus did not activate group');

    await page.setViewportSize({ width: 390, height: 844 });
    await selectControl(page, '.panel-switcher', 'two');
    if (!await page.locator('[data-test-panel=two]').isVisible()) throw Error('Mobile switcher cannot reach another split group');
    await selectControl(page, '.panel-switcher', 'anchor');
    if (!await page.locator('[data-test-panel=anchor]').isVisible()) throw Error('Mobile switcher cannot return to Terminal');
    console.log('Nested split resizing, keyboard sashes, moving and dragging tabs, and mobile cross-group switching passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
