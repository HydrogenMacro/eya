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
      for (const id of ['one', 'two', 'three']) {
        const element = document.createElement('section');
        element.textContent = id;
        element.dataset.testPanel = id;
        EyaPanels.register({ id, title: id, element });
        EyaPanels.open(id, { groupId: EyaPanels.groupOf('terminal') });
      }
      EyaPanels.split('one', 'vertical', 'terminal');
      EyaPanels.split('two', 'horizontal', 'terminal');
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
    if (!await page.locator('#terminal-pane').isVisible()) throw Error('Moving an active tab left its source group blank');
    await page.evaluate(() => EyaPanels.activate('one'));
    const sourceTab = page.locator('[data-panel=one]');
    const destination = page.locator('[data-panel=terminal]').locator('..');
    await sourceTab.dragTo(destination);
    const moved = await page.evaluate(() => EyaPanels.groupOf('one') === EyaPanels.groupOf('terminal'));
    if (!moved) throw Error('Dragging a tab between groups did not move it');

    await page.setViewportSize({ width: 390, height: 844 });
    await selectControl(page, '.panel-switcher', 'two');
    if (!await page.locator('[data-test-panel=two]').isVisible()) throw Error('Mobile switcher cannot reach another split group');
    await selectControl(page, '.panel-switcher', 'terminal');
    if (!await page.locator('#terminal-pane').isVisible()) throw Error('Mobile switcher cannot return to Terminal');
    console.log('Nested split resizing, keyboard sashes, moving and dragging tabs, and mobile cross-group switching passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
