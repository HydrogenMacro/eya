const assert = require('node:assert/strict');
const { fixture } = require('./continuity-fixture.cjs');
const { Peer } = require('./workspace-protocol.cjs');

(async () => {
  const f = await fixture(); let peer;
  try {
    const page = await f.client({ type: 'svg', startupPanel: 'none' });
    const answers = [];
    page.__dialogHandler = dialog => dialog.type() === 'prompt' ? dialog.accept(answers.shift() || '') : dialog.accept();
    const manager = page.locator('#workspaces-dialog');
    const show = async () => {
      if (!await manager.isVisible()) await f.manage(page);
      await manager.locator('[data-workspace-id]').first().waitFor();
    };
    const currentId = () => page.evaluate(() => EyaWorkspaces.getState().workspace.id);
    const anonymous = await currentId();
    await show(); answers.push('Alpha');
    await manager.getByRole('button', { name: 'Save workspace', exact: true }).click();
    await page.waitForFunction(() => EyaWorkspaces.getState().workspace.name === 'Alpha');
    assert.equal((await f.snapshot()).workspaces.find(workspace => workspace.id === anonymous).name, 'Alpha');

    answers.push('Beta'); await manager.getByRole('button', { name: 'New workspace', exact: true }).click();
    await page.waitForFunction(() => EyaWorkspaces.getState().workspace.name === 'Beta');
    assert.equal(await manager.isVisible(), false, 'Opening the newly created workspace closes the modal');
    const beta = await currentId();
    await show(); await manager.locator(`[data-workspace-id="${anonymous}"]`).getByRole('button', { name: 'Open', exact: true }).click();
    await page.waitForFunction(id => EyaWorkspaces.getState().workspace.id === id, anonymous);
    assert.equal(await manager.isVisible(), false);

    peer = new Peer(f.url, 'eya-terminal-v1', 'eya-workspace-v1:{}'); await peer.state();
    for (let index = 0; index < 14; index++) assert.equal((await peer.request('workspace.create', { name: `Scrollable ${index}` })).ok, true);
    const ids = await page.evaluate(async () => {
      const result = [];
      for (let index = 0; index < 18; index++) {
        const id = await EyaPanels.create('files'); EyaPanels.update(id, { title: `Explorer ${index}` }); result.push(id);
      }
      return result;
    });
    await f.saved(page); await show();
    assert.equal(await manager.getByRole('heading', { name: /Active sessions/ }).count(), 0);
    assert.equal(await manager.locator('select').count(), 0, 'Tab movement has no destination dropdown');
    for (const selector of ['.workspace-list', '.workspace-tabs']) {
      assert.ok(await manager.locator(selector).evaluate(list => list.scrollHeight > list.clientHeight), `${selector} scrolls independently`);
    }
    await manager.getByRole('searchbox', { name: 'Search workspaces', exact: true }).fill('Beta');
    assert.equal(await manager.locator('[data-workspace-id]:visible').count(), 1);
    await manager.getByRole('searchbox', { name: 'Search workspaces', exact: true }).fill('');
    await manager.getByRole('searchbox', { name: 'Search open tabs', exact: true }).fill('Explorer 17');
    assert.equal(await manager.locator('[data-tab-id]:visible').count(), 1);
    await manager.getByRole('searchbox', { name: 'Search open tabs', exact: true }).fill('');

    const tab = manager.locator(`[data-tab-id="${ids[0]}"]`);
    assert.equal(await tab.getByRole('button', { name: 'Focus Explorer 0', exact: true }).locator('svg').count(), 1);
    assert.equal(await tab.getByRole('button', { name: 'Close Explorer 0', exact: true }).locator('svg').count(), 1);
    await tab.dragTo(manager.locator(`[data-workspace-id="${beta}"]`));
    await page.waitForFunction(id => !EyaPanels.layout().some(group => group.panels.includes(id)), ids[0]);
    const moved = await f.snapshot();
    assert.ok(moved.workspaces.find(workspace => workspace.id === beta).tabs.some(tab => tab.id === ids[0]));
    assert.ok(!moved.workspaces.find(workspace => workspace.id === anonymous).tabs.some(tab => tab.id === ids[0]));

    const minimized = manager.locator(`[data-tab-id="${ids[1]}"]`);
    await minimized.getByRole('button', { name: 'Minimize Explorer 1', exact: true }).click();
    await minimized.filter({ hasText: 'minimized' }).waitFor();
    assert.ok(!await page.evaluate(id => EyaPanels.layout().some(group => group.panels.includes(id)), ids[1]));
    await minimized.getByRole('button', { name: 'Focus Explorer 1', exact: true }).click();
    assert.equal(await manager.isVisible(), false);
    assert.ok(await page.evaluate(id => EyaPanels.layout().some(group => group.panels.includes(id)), ids[1]));
    await show();
    await manager.locator(`[data-tab-id="${ids[1]}"]`).getByRole('button', { name: 'Close Explorer 1', exact: true }).click();
    await page.waitForFunction(id => !EyaPanels.layout().some(group => group.panels.includes(id)), ids[1]);

    await manager.locator(`[data-tab-id="${ids[2]}"]`).getByRole('button', { name: 'Move Explorer 2', exact: true }).click();
    await manager.locator(`[data-workspace-id="${beta}"]`).focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(id => !EyaPanels.layout().some(group => group.panels.includes(id)), ids[2]);
    assert.ok((await f.snapshot()).workspaces.find(workspace => workspace.id === beta).tabs.some(tab => tab.id === ids[2]), 'Keyboard moves use the same atomic operation');

    // A touch-size viewport still keeps both independent list scroll areas.
    await page.setViewportSize({ width: 375, height: 700 });
    assert.ok(await manager.locator('.workspace-list').evaluate(list => list.scrollHeight > list.clientHeight));
    assert.ok(await manager.locator('.workspace-tabs').evaluate(list => list.scrollHeight > list.clientHeight));
    const bounds = await manager.evaluate(dialog => ({ client: dialog.clientHeight, scroll: dialog.scrollHeight, rect: dialog.getBoundingClientRect().toJSON(), children: [...dialog.children].map(element => ({ tag: element.tagName, className: element.className, rect: element.getBoundingClientRect().toJSON(), scroll: element.scrollHeight })) }));
    assert.ok(bounds.scroll <= bounds.client + 1, `The modal itself does not overflow behind its lists: ${JSON.stringify(bounds)}`);
    assert.deepEqual(f.errors, []);
    console.log('Workspace modal: explicit anonymous save, auto-close, searchable independent scroll lists, Lucide actions, SVG drag-and-drop/keyboard moves and minimized tab focus/close passed');
  } finally { peer?.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
