const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture } = require('./continuity-fixture.cjs');
(async () => {
  const f = await fixture();
  try {
    const page = await f.client();
    const version = (await fs.readFile('VERSION','utf8')).trim();
    const generator = await fetch(f.http+'/').then(r => r.text());
    assert.match(generator, /id="generator-version"/);
    const generatorPage = await page.context().newPage(); await generatorPage.goto(f.http+'/');
    assert.equal(await generatorPage.locator('#generator-version').textContent(), `v${version}`); await generatorPage.close();
    await page.getByRole('button',{name:'Workspace menu',exact:true}).click();
    const menu = page.getByRole('menu',{name:'Workspace menu',exact:true});
    assert.equal(await menu.locator('.ui-menu-heading').first().textContent(),'General');
    await menu.getByRole('menuitem',{name:'Server configuration',exact:true}).click();
    const dialog = page.locator('#server-settings-dialog'); await dialog.waitFor();
    const terminal = dialog.getByRole('spinbutton',{name:'Terminal sessions',exact:true});
    await page.waitForFunction(() => !document.querySelector('#server-settings-dialog input').disabled);
    const before = Number(await terminal.inputValue()); await terminal.fill(String(before+1));
    await dialog.getByRole('button',{name:'Apply',exact:true}).click();
    await dialog.getByRole('status').filter({hasText:'Applied.'}).waitFor();
    await dialog.getByRole('button',{name:'Close',exact:true}).click();
    await page.getByRole('button',{name:'Workspace menu',exact:true}).click();
    await page.getByRole('menuitem',{name:'Server configuration',exact:true}).click();
    await page.waitForFunction(expected => document.querySelector('#server-settings-dialog input')?.value === String(expected) && !document.querySelector('#server-settings-dialog input').disabled,before+1);
    assert.equal(await page.locator('.instance-terminal').count(),0);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth+1),false);
    assert.deepEqual(f.errors,[]);
    console.log('Built client: General server-config menu, live authenticated form/reopen, no PTY, mobile bounds, served generator version passed');
  } finally { await f.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
