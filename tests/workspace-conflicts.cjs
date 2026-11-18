const assert = require('node:assert/strict');
const { fixture } = require('./continuity-fixture.cjs');

(async () => {
  const f = await fixture();
  try {
    const first = await f.client(); await f.named(first, 'Conflict fixture');
    await first.evaluate(() => EyaPanels.create('files')); await f.saved(first);
    const id = await first.evaluate(() => EyaWorkspaces.getState().workspace.id);
    const second = await f.client(); await second.evaluate(id => EyaWorkspaces.open(id), id);

    // Lose an already committed update's reply, then change local state again
    // before recovery. Reconciliation must recognize the earlier commit.
    await first.evaluate(() => {
      window.__sockets[0].onmessage = () => {};
      EyaPanels.create('files');
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await f.snapshot()).workspaces.find(workspace => workspace.id === id).tabs.length === 2) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal((await f.snapshot()).workspaces.find(workspace => workspace.id === id).tabs.length, 2);
    await first.evaluate(() => { EyaPanels.openStart(); window.__sockets[0].close(); });
    await first.waitForFunction(() => document.querySelector('#status').dataset.connected === 'true' && !EyaWorkspaces.getState().pending && EyaWorkspaces.getState().workspace.tabs.length === 3);
    assert.equal(await first.evaluate(() => EyaWorkspaces.getState().conflict), false, 'A lost reply must not create a false conflict');
    assert.equal((await f.snapshot()).workspaces.find(workspace => workspace.id === id).tabs.length, 3);

    // A genuinely stale client keeps local state and resolves explicitly via UI.
    await second.evaluate(() => EyaPanels.create('files')); await second.evaluate(() => EyaWorkspaces.save());
    await second.waitForFunction(() => EyaWorkspaces.getState().conflict);
    await f.manage(second);
    await second.getByRole('button', { name: 'Reload saved workspace', exact: true }).click();
    await second.waitForFunction(() => !EyaWorkspaces.getState().conflict && EyaWorkspaces.getState().workspace.tabs.length === 3);
    await second.locator('#workspaces-dialog').waitFor({ state: 'hidden' });

    // Offline declarative changes stay in this page, then commit on readiness.
    await first.context().setOffline(true);
    await first.evaluate(() => window.__sockets.filter(socket => socket.readyState === WebSocket.OPEN).forEach(socket => socket.close()));
    await first.waitForFunction(() => document.querySelector('#status').textContent.includes('Reconnecting'));
    await first.evaluate(() => EyaPanels.openStart());
    // Closing and recreating a start tab always changes a descriptor ID.
    await first.evaluate(() => {
      const id = EyaPanels.layout().flatMap(group => group.panels).find(id => id.startsWith('start-'));
      EyaPanels.close(id); EyaPanels.openStart();
    });
    await first.waitForFunction(() => EyaWorkspaces.getState().pending);
    assert.match(await first.locator('#workspace-sync').textContent(), /Offline.*unsaved/);
    await first.context().setOffline(false); await first.evaluate(() => window.dispatchEvent(new Event('online'))); await f.saved(first);
    assert.equal(await first.evaluate(() => EyaWorkspaces.getState().workspace.id), id);
    assert.deepEqual(f.errors, []);
    console.log('Workspace conflicts: lost committed replies with newer local edits, explicit stale-revision reload, and offline declarative sync passed');
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
