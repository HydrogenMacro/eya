const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { reveal, selectControl, controlValue } = require('./ui-helpers.cjs');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    for (const viewport of [{ width: 1280, height: 850 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(pathToFileURL(path.resolve('client.html')).href);
      await page.locator('#close-connect').click();
      if (await page.locator('.app-header button:visible').count() > 3) throw Error('The app header is still crowded');
      if (await page.locator('.app-header button:visible svg.ui-icon').count() !== 3) throw Error('Header icons are missing');
      if (await page.locator('.panel-group-actions button:visible').count() !== 4) throw Error('Quick panel creation and split controls are missing');
      if (await page.locator('#settings').isVisible() || await page.locator('#disconnect').isVisible()) throw Error('Secondary workspace actions were not tucked into the menu');
      const workspace = page.getByRole('button', { name: 'Workspace menu', exact: true });
      await workspace.focus(); await page.keyboard.press('ArrowDown');
      await page.locator('#settings').waitFor({ state: 'visible' });
      if (!await page.locator('#settings').evaluate(element => element === document.activeElement)) throw Error('Menu keyboard focus did not reach the first item');
      const bounds = await page.locator('.ui-menu:visible').boundingBox();
      if (bounds.x < 0 || bounds.x + bounds.width > viewport.width + 1) throw Error('Menu overflows the viewport');
      await page.keyboard.press('Escape');
      if (await workspace.getAttribute('aria-expanded') !== 'false') throw Error('Escape did not close the menu');
      if (!await workspace.evaluate(element => element === document.activeElement)) throw Error('Escape did not restore trigger focus');
      await (await reveal(page, '#settings')).click();
      await page.locator('#settings-dialog').waitFor({ state: 'visible' });
      if (await page.locator('.ui-menu:visible').count()) throw Error('Opening Settings left a menu floating over the dialog');
      if (await page.locator('#local-echo,#split-direction,#panel-size,#panel-visible').count()) throw Error('Removed settings remain in the UI');
      await selectControl(page, '#theme', 'light');
      await selectControl(page, '#ui-style', 'rounded');
      if (await controlValue(page.locator('#theme')) !== 'light' || await controlValue(page.locator('#ui-style')) !== 'rounded') throw Error('Custom appearance dropdowns did not update settings');
      const theme = page.locator('.ui-select:has(> #theme) > .ui-select-trigger');
      await theme.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home'); await page.keyboard.press('Enter');
      if (await controlValue(page.locator('#theme')) !== 'dark') throw Error('Custom dropdown keyboard selection failed');
      await theme.click(); await page.keyboard.press('Escape');
      if (await theme.getAttribute('aria-expanded') !== 'false' || !await theme.evaluate(element => element === document.activeElement)) throw Error(`Dropdown Escape did not return focus: ${JSON.stringify(await theme.evaluate(element => ({ expanded: element.getAttribute('aria-expanded'), active: document.activeElement?.outerHTML, dialog: document.querySelector('#settings-dialog').open })))}`);
      await page.locator('#close-settings').click();
      await page.keyboard.press('Control+,');
      await page.locator('#settings-dialog').waitFor({ state: 'visible' });
      await page.locator('#close-settings').click();
    }
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.getByRole('button', { name: 'Split right', exact: true }).first().click();
    if (await page.locator('.panel-group').count() !== 2) throw Error('Panel menu did not split the group');
    await page.getByRole('button', { name: 'Panel layout', exact: true }).first().click();
    if (!await page.getByRole('menuitem', { name: 'Move to next group', exact: true }).first().isEnabled()) throw Error('Panel menu did not enable moving after a new group was created');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Panel layout', exact: true }).last().click();
    await page.getByRole('menuitem', { name: 'Close empty group', exact: true }).last().click();
    if (await page.locator('.panel-group').count() !== 1) throw Error('Panel menu did not close an empty group');
    if (errors.length) throw Error(errors.join('; '));
    await page.getByRole('button', { name: 'New panel', exact: true }).first().click();
    await page.locator('.panel-start').waitFor({ state: 'visible' });
    const starter = page.locator('.panel-start');
    if (!await starter.getByRole('searchbox', { name: 'Search panels' }).isVisible()) throw Error('New panel launcher search is missing');
    const launcherLayout = await starter.locator('.panel-start-browser').evaluate(element => ({ overflowY: getComputedStyle(element).overflowY, minHeight: getComputedStyle(element).minHeight }));
    if (!['auto', 'scroll'].includes(launcherLayout.overflowY) || launcherLayout.minHeight !== '0px') throw Error(`Panel launcher is not independently scrollable: ${JSON.stringify(launcherLayout)}`);
    if (await starter.locator('.panel-start-category').count() < 2) throw Error('Panel launcher did not group registered tools by category');
    for (const name of ['Terminal', 'File browser', 'Task Manager', 'Docker']) if (!await starter.getByRole('button', { name, exact: true }).isVisible()) throw Error(`New panel launcher did not list ${name}`);
    console.log('Compact icon headers, responsive menus, custom appearance controls, keyboard focus, Escape dismissal, Settings shortcut, quick split and new-panel actions passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
