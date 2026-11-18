// Self-contained: only disposable server/state/file fixtures; no browser storage.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { fixture } = require('./continuity-fixture.cjs');

(async () => {
  const f = await fixture();
  const root = f.files;
  try {
    const first = await f.client({ webgl: false });
    const initial = await first.evaluate(() => EyaWorkspaces.getState().workspace);
    assert.equal(initial.tabs.length, 0, 'The explicit startupPanel:none configuration starts without a terminal');
    assert.equal(await first.locator('.instance-terminal').count(), 0);
    const files = await first.evaluate(() => EyaPanels.create('files'));
    await first.locator('.file-instance tbody tr').filter({ hasText: 'seed.txt' }).waitFor();
    await first.evaluate(({ id, cwd }) => EyaPanels.call(id, 'navigate', cwd), { id: files, cwd: path.join(root, 'folder') });
    const secondFiles = await first.evaluate(() => EyaPanels.create('files'));
    await first.locator('.file-instance:visible tbody tr').filter({ hasText: 'seed.txt' }).waitFor();
    await first.evaluate(id => EyaPanels.split(id, 'vertical'), secondFiles);
    await first.evaluate(() => EyaWorkspaces.save()); await f.saved(first);
    assert.equal((await f.snapshot()).workspaces.length, 0, 'Anonymous tabs and layout are ephemeral until explicitly saved');
    await f.named(first, 'Continuity workspace');
    const durable = (await f.snapshot()).workspaces.find(w => w.id === initial.id);
    assert.equal(durable.tabs.length, 2); assert.equal(durable.layout.type, 'split');
    assert.equal(durable.tabs.find(tab => tab.id === files).config.cwd, path.join(root, 'folder'));
    const originalRatio = durable.layout.ratio;
    await first.setViewportSize({ width: 375, height: 700 });
    await first.evaluate(() => EyaWorkspaces.save()); await f.saved(first);
    assert.equal((await f.snapshot()).workspaces.find(w => w.id === initial.id).layout.ratio, originalRatio);
    await first.setViewportSize({ width: 1440, height: 900 });

    const second = await f.client({ webgl: false });
    assert.notEqual(await second.evaluate(() => EyaWorkspaces.getState().workspace.id), initial.id);
    await second.evaluate(id => EyaWorkspaces.open(id), initial.id);
    await second.waitForFunction(id => EyaWorkspaces.getState().workspace.id === id, initial.id);
    assert.equal(await second.evaluate(id => EyaPanels.call(id, 'getPath'), files), path.join(root, 'folder'));
    assert.equal(await second.locator('.panel-split').count(), 1);

    const terminal = await first.evaluate(() => EyaPanels.create('terminal'));
    await first.waitForFunction(id => EyaPanels.call(id, 'getState').connected, terminal);
    await first.evaluate(id => EyaPanels.call(id, 'sendInput', "stty -echo; EYA_CONTINUITY_PID=$$; printf 'CONTINUITY_READY\\n'\r"), terminal);
    await first.waitForFunction(() => document.body.textContent.includes('CONTINUITY_READY'));
    const terminalCwd = path.join(root, 'terminal working directory'); await fs.mkdir(terminalCwd);
    await first.evaluate(({ id, cwd }) => EyaPanels.call(id, 'sendInput', `cd -- '${cwd.replaceAll("'", "'\\''")}'; EYA_CONTINUITY_CWD=$(pwd -P); printf 'TERMINAL_CWD=%s\\n' "$EYA_CONTINUITY_CWD"\r`), { id: terminal, cwd: terminalCwd });
    await first.locator('.xterm-screen').filter({ hasText: `TERMINAL_CWD=${terminalCwd}` }).waitFor();
    await first.evaluate(() => EyaWorkspaces.save()); await f.saved(first);
    const session = (await f.snapshot()).workspaces.find(w => w.id === initial.id).tabs.find(tab => tab.id === terminal).session;
    assert.equal(typeof session, 'string');
    await first.evaluate(() => window.__sockets[0].close());
    await first.locator('#status').filter({ hasText: 'Connected' }).waitFor();
    await first.waitForFunction(id => EyaPanels.call(id, 'getState').connected, terminal);
    await first.evaluate(id => EyaPanels.call(id, 'sendInput', "test \"$EYA_CONTINUITY_PID\" = \"$$\" && printf 'CONTINUITY_SAME_SHELL\\n'\r"), terminal);
    await first.waitForFunction(() => document.body.textContent.includes('CONTINUITY_SAME_SHELL'));

    // Second client has a stale revision. A tab edit must remain local and visibly conflict.
    await second.evaluate(() => EyaPanels.create('files')); await second.evaluate(() => EyaWorkspaces.save());
    await second.waitForFunction(() => EyaWorkspaces.getState().conflict);
    assert.equal((await f.snapshot()).workspaces.find(w => w.id === initial.id).tabs.filter(tab => tab.kind === 'terminal').length, 1);
    await first.context().close();
    const third = await f.client({ webgl: false });
    await third.evaluate(id => EyaWorkspaces.open(id), initial.id);
    await third.waitForFunction(id => EyaPanels.call(id, 'getState')?.connected, terminal);
    await third.evaluate(id => EyaPanels.call(id, 'sendInput', "test \"$EYA_CONTINUITY_PID\" = \"$$\" && test \"$(pwd -P)\" = \"$EYA_CONTINUITY_CWD\" && printf 'CONTINUITY_NEW_CLIENT\\n'\r"), terminal);
    await third.waitForFunction(() => document.body.textContent.includes('CONTINUITY_NEW_CLIENT'));
    await third.evaluate(id => EyaPanels.close(id), terminal); await third.evaluate(() => EyaWorkspaces.save()); await f.saved(third);
    const replacement = await third.evaluate(() => EyaPanels.create('terminal'));
    await third.waitForFunction(id => EyaPanels.call(id, 'getState').connected, replacement);
    await third.evaluate(() => EyaWorkspaces.save()); await f.saved(third);
    const newSession = (await f.snapshot()).workspaces.find(w => w.id === initial.id).tabs.find(tab => tab.id === replacement).session;
    assert.notEqual(newSession, session, 'A new terminal must create a new session');
    await third.context().close(); await f.stop(); await f.start();
    const fourth = await f.client({ webgl: false }); await fourth.evaluate(id => EyaWorkspaces.open(id), initial.id);
    await fourth.waitForFunction(id => EyaPanels.call(id, 'getState')?.ended, replacement);
    assert.equal(await fourth.locator('.panel-split').count(), 1, 'Layout survives server restart');
    assert.equal(await fourth.evaluate(id => EyaPanels.call(id, 'getPath'), files), path.join(root, 'folder'));
    assert.deepEqual(f.errors, []);
    console.log('Workspace continuity: ephemeral anonymous clients, explicit named save, disabled storage, cwd/layout persistence, responsive ratios, terminal recovery, conflicts and restart passed');
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
