const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { fixture } = require('./continuity-fixture.cjs');
const { Peer } = require('./workspace-protocol.cjs');
const { reveal } = require('./ui-helpers.cjs');
(async () => {
  const f = await fixture({ env: { EYA_BROWSER_CHROMIUM: process.env.EYA_BROWSER_EXECUTABLE || chromium.executablePath() } });
  let control;
  try {
    const first = await f.client(); await f.named(first, 'Browser fixture');
    const id = await first.evaluate(() => EyaPanels.create('web-browser'));
    await first.evaluate(async id => { await EyaPanels.call(id, 'restoreRemote'); }, id); await f.saved(first);
    const workspace = await first.evaluate(() => EyaWorkspaces.getState().workspace);
    const session = workspace.tabs.find(tab => tab.id === id).session;
    assert.equal(typeof session, 'string');
    control = new Peer(f.url, 'eya-terminal-v1', 'eya-workspace-v1:{}'); await control.state();
    const initial = (await control.request('session.list')).sessions.find(item => item.id === session);
    assert.equal(initial.started, true);
    await first.context().close();
    const second = await f.client({ type: 'svg' }); await second.evaluate(id => EyaWorkspaces.open(id), workspace.id);
    const state = await second.evaluate(async id => { const remote = await EyaPanels.call(id, 'restoreRemote'); return { id: remote.sessionId, resumed: remote.sessionState.resumed }; }, id);
    assert.deepEqual(state, { id: session, resumed: true });
    const secondOwner = (await control.request('session.list')).sessions.find(item => item.id === session).client;
    assert.notEqual(secondOwner, initial.client);
    const third = await f.client(); await third.evaluate(id => EyaWorkspaces.open(id), workspace.id);
    await third.getByRole('button', { name: 'Take over', exact: true }).waitFor();
    assert.equal((await control.request('session.list')).sessions.find(item => item.id === session).client, secondOwner, 'Opening another client must not silently steal Chromium');
    await third.getByRole('button', { name: 'Take over', exact: true }).click();
    await second.getByRole('button', { name: 'Take over', exact: true }).waitFor();
    const thirdState = await third.evaluate(async id => { const remote = await EyaPanels.call(id, 'restoreRemote'); return remote.sessionId; }, id);
    assert.equal(thirdState, session);
    await (await reveal(third, '#disconnect')).click();
    let detached;
    for (let attempt = 0; attempt < 60; attempt++) {
      detached = (await control.request('session.list')).sessions.find(item => item.id === session);
      if (detached.status === 'detached') break;
      await third.waitForTimeout(50);
    }
    assert.equal(detached.status, 'detached');
    await third.waitForTimeout(1200);
    assert.equal((await control.request('session.list')).sessions.find(item => item.id === session).status, 'detached', 'Manual disconnect pauses browser reconnection');
    await third.locator('#connect').click(); await third.locator('#start-connection').click();
    await third.waitForFunction(() => document.querySelector('#status').textContent === 'Connected');
    await third.evaluate(async id => { await EyaPanels.call(id, 'restoreRemote'); }, id);
    assert.equal((await control.request('session.list')).sessions.find(item => item.id === session).status, 'attached');
    await third.evaluate(id => EyaPanels.close(id), id);
    for (let attempt = 0; attempt < 60; attempt++) {
      if (!(await control.request('session.list')).sessions.some(item => item.id === session)) break;
      await third.waitForTimeout(50);
    }
    assert.equal((await control.request('session.list')).sessions.some(item => item.id === session), false);
    assert.deepEqual(f.errors, []);
    console.log('Browser workspaces: real Chromium retained across HTML/SVG clients, explicit takeover UI, manual detach/resume and close/end passed');
  } finally { control?.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
