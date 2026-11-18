const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, KEY } = require('./continuity-fixture.cjs');
const { Peer } = require('./workspace-protocol.cjs');

async function eventually(check, message) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error(message);
}

(async () => {
  const f = await fixture();
  try {
    const page = await f.client({ connect: false });
    await page.locator('#url').fill(f.url); await page.locator('#key').fill('11'.repeat(32));
    await page.locator('#start-connection').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('negotiation failed'));
    const attempts = await page.evaluate(() => window.__sockets.length);
    assert.ok(attempts <= 3, 'Authentication retries must be bounded');
    await page.waitForTimeout(2500);
    assert.equal(await page.evaluate(() => window.__sockets.length), attempts);
    assert.equal(await page.evaluate(() => EyaWorkspaces.getState().workspace), null);
    page.__dialogHandler = dialog => { throw Error(`Correcting an unauthenticated password must not ask to switch server: ${dialog.message()}`); };
    await page.locator('#connect').click(); await page.locator('#key').fill(KEY); await page.locator('#start-connection').click();
    await page.waitForFunction(() => EyaWorkspaces.getState().workspace);
    page.__dialogHandler = undefined;
    await f.named(page, 'Storage failure fixture');

    // Commit an editor save, but drop its reply. Recovery must keep the dirty
    // buffer without repeating a mutation whose outcome is unknown to the page.
    const filename = path.join(f.files, 'seed.txt');
    await page.evaluate(filename => EyaPanels.openFile(filename), filename);
    const text = 'An intentionally uncertain save. '.repeat(37);
    await page.locator('.cm-content').fill(text); await f.saved(page);
    const editor = await page.evaluate(() => EyaPanels.layout().flatMap(group => group.panels).find(id => id.startsWith('file-')));
    await page.evaluate(({ editor, length }) => {
      const socket = window.__sockets.at(-1), send = socket.send.bind(socket);
      socket.send = bytes => {
        send(bytes);
        if (bytes.byteLength === length + 6 + 16) {
          socket.onmessage = () => {};
          window.__droppedSaveReply = true;
        }
      };
      EyaPanels.call(editor, 'save');
    }, { editor, length: Buffer.byteLength(text) });
    await page.waitForFunction(() => window.__droppedSaveReply);
    await eventually(async () => (await fs.readFile(filename, 'utf8')) === text, 'The uncertain save did not commit');
    const committed = await fs.stat(filename, { bigint: true });
    await page.evaluate(() => window.__sockets.at(-1).close());
    await page.waitForFunction(() => document.querySelector('#status').dataset.connected === 'true');
    await page.getByRole('status').filter({ hasText: 'Mutations may have completed' }).waitFor();
    await page.waitForTimeout(2000);
    assert.equal(await page.locator('.cm-content').innerText(), text);
    assert.ok(await page.locator('.panel-tab-dirty').count(), 'An uncertain save keeps its dirty buffer');
    const after = await fs.stat(filename, { bigint: true });
    assert.equal(after.ino, committed.ino); assert.equal(after.mtimeNs, committed.mtimeNs, 'Reconnection must not repeat the file replacement');

    // Replace the directory path with a regular file while retaining the lock's
    // inode. Every attempted metadata commit now fails deterministically.
    const offline = `${f.state}.offline`;
    await fs.rename(f.state, offline); await fs.writeFile(f.state, 'storage temporarily unavailable');
    try {
      await page.evaluate(() => EyaPanels.openStart());
      await page.locator('#workspace-sync').filter({ hasText: 'Unsaved' }).waitFor();
      assert.equal(await page.evaluate(() => EyaWorkspaces.getState().pending), true);
      assert.ok(await page.evaluate(() => EyaPanels.layout().some(group => group.panels.some(id => id.startsWith('start-')))));
      assert.equal(await page.locator('#status').textContent(), 'Connected');
    } finally { await fs.unlink(f.state); await fs.rename(offline, f.state); }
    await f.saved(page);

    // Anonymous records disappear on restart, but a still-open page must keep
    // its dirty/minimized views and rebind their recipes to fresh memory state.
    const temporary = await f.client();
    await temporary.evaluate(filename => EyaPanels.openFile(filename), filename);
    await temporary.locator('.cm-content').fill('Dirty anonymous buffer survives server restart');
    const transient = await temporary.evaluate(() => {
      const id = EyaPanels.layout().flatMap(group => group.panels).find(id => id.startsWith('file-'));
      window.__originalEditor = document.querySelector('.cm-content'); EyaPanels.minimize(id);
      return { id, workspace: EyaWorkspaces.getState().workspace.id };
    });
    await f.saved(temporary); await f.stop(); await f.start();
    await temporary.waitForFunction(id => EyaWorkspaces.getState().workspace?.id !== id && !EyaWorkspaces.getState().pending && document.querySelector('#status').dataset.connected === 'true', transient.workspace);
    assert.equal(await temporary.evaluate(() => window.__originalEditor === document.querySelector('.cm-content')), true);
    assert.equal(await temporary.locator('.cm-content').textContent(), 'Dirty anonymous buffer survives server restart');
    assert.equal(await temporary.locator(`.panel-tab[data-panel="${transient.id}"]`).count(), 0);
    assert.equal((await f.snapshot()).workspaces.some(workspace => workspace.id === transient.workspace), false);
    assert.deepEqual(f.errors, []);
    console.log('Workspace edges: bounded authentication retry, no uncertain-save replay, recoverable storage failure, and same-page dirty/minimized anonymous recovery after server restart passed');
  } finally { await f.close(); }

  const capacity = await fixture(); let peer;
  try {
    peer = new Peer(capacity.url, 'eya-terminal-v1', 'eya-workspace-v1:{}'); await peer.state();
    for (let index = 0; index < 64; index++) assert.equal((await peer.request('workspace.create', { name: `Capacity ${index}` })).ok, true);
    const page = await capacity.client({ connect: false });
    await page.locator('#url').fill(capacity.url); await page.locator('#key').fill(KEY); await page.locator('#start-connection').click();
    await page.waitForFunction(() => document.querySelector('#status').dataset.connected === 'true');
    await page.waitForFunction(() => EyaWorkspaces.getState().workspace);
    assert.equal(await page.evaluate(() => EyaWorkspaces.getState().workspace.name), null, 'A full named store still permits an ephemeral workspace');
    assert.deepEqual((await peer.request('session.list')).sessions, []);
    await capacity.manage(page);
    await page.locator('.workspace-list > .workspace-entry').filter({ has: page.locator(':scope > span').filter({ hasText: /^Capacity 0 ·/ }) }).getByRole('button', { name: 'Delete', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.workspace-list > .workspace-entry').length === 64);
    page.__dialogHandler = dialog => dialog.accept('Recovered from capacity');
    await page.getByRole('button', { name: 'New workspace', exact: true }).click();
    await page.waitForFunction(() => EyaWorkspaces.getState().workspace?.name === 'Recovered from capacity');
    assert.deepEqual((await peer.request('session.list')).sessions, []);
    assert.deepEqual(capacity.errors, []);
    console.log('Workspace capacity: full named storage still allows anonymous work, authenticated management and cleanup without creating a PTY passed');
  } finally { peer?.close(); await capacity.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
