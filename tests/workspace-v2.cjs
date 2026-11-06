const { chromium } = require('playwright');
const { selectControl, controlValue } = require('./ui-helpers.cjs');
const path = require('node:path');
const root = process.env.EYA_TEST_ROOT;
if (!root) throw Error('EYA_TEST_ROOT is required');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  try {
    await page.goto(process.env.EYA_TEST_DOCUMENT || 'http://127.0.0.1:18765/client.html');
    await page.locator('#start-connection').click();
    await page.locator('#status').filter({ hasText: 'Connected' }).waitFor();
    const types = await page.evaluate(() => EyaPanels.listTypes().map(type => type.id));
    for (const type of ['terminal', 'files', 'task-manager', 'docker']) if (!types.includes(type)) throw Error(`Missing ${type} panel type`);
    await page.locator('#files').click();
    await page.locator('#file-list tr').filter({hasText:'seed.txt'}).waitFor();
    const ids = await page.evaluate(async () => [await EyaPanels.create('files'), await EyaPanels.create('files')]);
    const active = page.locator('.file-instance:visible');
    await active.locator('tbody tr').filter({hasText:'seed.txt'}).waitFor();
    await page.evaluate(id => EyaPanels.call(id, 'navigate', '/'), ids[0]);
    const paths = await page.evaluate(ids => ids.map(id => EyaPanels.call(id, 'getPath')), ids);
    if (paths[0] !== '/' || paths[1] !== root) throw Error(`File instances share navigation: ${paths}`);
    const name = 'workspace-v2-upload.txt';
    // Chromium's SVG/XHTML inputs work natively, but Playwright's setInputFiles
    // helper rejects their lowercase nodeName. Exercise the same change event.
    await active.locator('input[type=file]').evaluate((input, name) => {
      if (!(input instanceof HTMLInputElement)) throw Error('Invalid upload control');
      const transfer = new DataTransfer(); transfer.items.add(new File(['upload from independent browser\n'], name, {type:'text/plain'}));
      input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles:true}));
    }, name);
    const row = active.locator('tbody tr').filter({hasText:name}); await row.waitFor();
    await row.click(); await row.focus(); await page.keyboard.press('Delete'); await row.waitFor({state:'detached'});
    await page.keyboard.press('Control+l');
    if (!await active.locator('input[aria-label="Current directory"]').evaluate(element => element === document.activeElement)) throw Error('Path shortcut did not focus current browser');
    await page.keyboard.press('Control+f');
    if (!await active.locator('input[type=search]').evaluate(element => element === document.activeElement)) throw Error('Search shortcut did not focus current browser');
    await page.keyboard.press('Control+,'); await page.locator('#settings-dialog').waitFor({state:'visible'});
    await selectControl(page, '#theme', 'light'); await selectControl(page, '#ui-style', 'rounded'); await selectControl(page, '#accent-color', 'violet');
    if (await page.locator('#local-echo,#split-direction,#panel-size').count()) throw Error('Removed settings remain');
    const appearance = await page.evaluate(() => ({...document.documentElement.dataset}));
    if (appearance.theme !== 'light' || appearance.uiStyle !== 'rounded' || appearance.accent !== 'violet') throw Error('Appearance settings did not apply');
    await page.locator('#close-settings').click();
    await page.keyboard.press('Control+Shift+p'); await page.locator('.panel-start:visible').waitFor();
    const launcher = page.locator('.panel-start:visible');
    await launcher.getByRole('searchbox', { name: 'Search panels' }).fill('cpu');
    if (await launcher.getByRole('button', { name: 'Task Manager', exact: true }).count() !== 1 || await launcher.getByRole('button', { name: 'Docker', exact: true }).count()) throw Error('New panel launcher did not search descriptions and keywords');
    await launcher.getByRole('button', {name:'Task Manager',exact:true}).click();
    const task = page.locator('.machine-panel:visible');
    await task.locator('.machine-table tbody tr').first().waitFor();
    if (!/CPU/.test(await task.textContent())) throw Error('Task manager stats missing');
    if (process.env.EYA_TEST_OUTPUT) await page.screenshot({path:path.join(process.env.EYA_TEST_OUTPUT,'workspace-light.png')});
    await page.setViewportSize({width:390,height:844});
    const layout = await page.evaluate(() => ({ width:innerWidth, scroll:document.documentElement.scrollWidth, height:innerHeight, body:document.querySelector('body').getBoundingClientRect().height }));
    if (layout.scroll > layout.width + 1 || layout.body > layout.height + 2) throw Error(`Mobile page overflows: ${JSON.stringify(layout)}`);
    if (process.env.EYA_TEST_OUTPUT) await page.screenshot({path:path.join(process.env.EYA_TEST_OUTPUT,'workspace-mobile.png')});
    await page.evaluate(ids => ids.forEach(id => EyaPanels.close(id)), ids);
    await page.evaluate(() => document.getElementById('end-session').click());
    if (errors.length) throw Error(errors.join('; '));
    console.log('Independent file browsers, upload/delete, focused shortcuts, themes, panel launcher, live task statistics, and mobile layout passed');
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exit(1);});
