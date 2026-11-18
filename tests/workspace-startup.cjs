const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { fixture, KEY } = require('./continuity-fixture.cjs');
const { Peer } = require('./workspace-protocol.cjs');
const { reveal } = require('./ui-helpers.cjs');

(async () => {
  const f = await fixture(); let control;
  try {
    const page = await f.client({ startupPanel: null });
    await page.waitForFunction(() => EyaPanels.layout().flatMap(group => group.panels).some(id => id.startsWith('terminal-') && EyaPanels.call(id, 'getState').connected));
    const terminal = await page.evaluate(() => EyaPanels.layout().flatMap(group => group.panels).find(id => id.startsWith('terminal-')));
    assert.equal(await page.locator('header #files').count(), 0, 'Files button is removed from the header');
    control = new Peer(f.url, 'eya-terminal-v1', 'eya-workspace-v1:{}'); await control.state();
    const original = (await control.request('session.list')).sessions;
    assert.equal(original.length, 1); assert.equal(original[0].kind, 'terminal');
    assert.deepEqual((await f.snapshot()).workspaces, [], 'Anonymous startup is never written to disk');
    await page.evaluate(id => {
      EyaPanels.minimize(id);
      EyaPanels.call(id, 'sendInput', "stty -echo; printf 'MINIMIZED_TERMINAL_ALIVE\\n'\r");
      EyaPanels.openStart();
    }, terminal);
    assert.equal(await page.locator(`.panel-tab[data-panel="${terminal}"]`).count(), 0);
    assert.equal(await page.evaluate(id => EyaPanels.call(id, 'getState').connected, terminal), true);
    await page.getByRole('searchbox', { name: 'Search minimized tabs', exact: true }).fill('terminal');
    await page.getByRole('button', { name: 'Reopen Terminal', exact: true }).click();
    await page.waitForFunction(id => EyaPanels.call(id, 'getText').includes('MINIMIZED_TERMINAL_ALIVE'), terminal);
    assert.deepEqual((await control.request('session.list')).sessions.map(session => session.id), original.map(session => session.id), 'Minimized terminal work continues in the same session');
    await (await reveal(page, '#disconnect')).click();
    await page.locator('#connect').click(); await page.locator('#start-connection').click();
    await page.waitForFunction(id => EyaPanels.call(id, 'getState').connected, terminal);
    assert.deepEqual((await control.request('session.list')).sessions.map(session => session.id), original.map(session => session.id), 'Reconnect resumes the startup terminal without creating another');
    await page.evaluate(id => EyaPanels.close(id), terminal);
    await page.waitForFunction(() => EyaPanels.layout().every(group => group.panels.every(id => !id.startsWith('terminal-'))));
    // A later Connect remains a reconnect even after its default tab was closed.
    await (await reveal(page, '#disconnect')).click();
    await page.locator('#connect').click(); await page.locator('#start-connection').click();
    await page.locator('#status[data-connected=true]').waitFor({ state: 'attached' });
    assert.deepEqual((await control.request('session.list')).sessions, []);

    // Exercise the actual generator and downloaded files, including SVG config.
    for (const [format, startup] of [['html', 'files'], ['svg', 'none'], ['html', 'proxy-browser'], ['svg', 'proxy-browser']]) {
      const generated = await f.client({ connect: false }); await generated.goto(f.http);
      await generated.locator('#server').fill(f.http); await generated.locator('#key').fill(KEY);
      await generated.locator('#startup-panel').selectOption(startup);
      await generated.locator('#generator-nav [data-page=export]').click();
      await generated.locator('#format').selectOption(format);
      const pending = generated.waitForEvent('download'); await generated.locator('button[type=submit]').click();
      const download = await pending, filename = path.join(f.root, `generated-startup.${format}`); await download.saveAs(filename);
      const content = await fs.readFile(filename, 'utf8');
      assert.ok(content.includes(`"startupPanel":"${startup}"`), 'The generator embeds the selected starting panel');
      await generated.goto(pathToFileURL(filename).href);
      await generated.waitForFunction(() => EyaWorkspaces.getState().workspace);
      if (startup === 'files') await generated.locator('.file-instance tbody tr').filter({ hasText: 'seed.txt' }).waitFor();
      else if (startup === 'proxy-browser') {
        await generated.locator('.eya-browser-proxy-warning').waitFor();
        assert.equal(await generated.getByLabel('Address or search').evaluate(element => element.value), '');
        assert.equal(await generated.evaluate(() => __sockets.some(socket => /\/browser-render-ws(?:\?|$)/.test(socket.url))), false, 'Proxy startup never starts Chromium');
      }
      else await generated.waitForTimeout(300);
      assert.equal(await generated.locator('.instance-terminal').count(), 0);
      assert.deepEqual((await control.request('session.list')).sessions, []);
      await generated.context().close();
    }
    assert.deepEqual(f.errors, []);
    console.log('Workspace startup: one default terminal, no hidden connector, no replay on reconnect, ephemeral anonymous state, removed Files header and generated HTML/SVG starting-panel choices passed');
  } finally { control?.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
