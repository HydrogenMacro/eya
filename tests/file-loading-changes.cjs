const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./continuity-fixture.cjs');

(async () => {
  const f = await fixture();
  try {
    const page = await f.client(); await f.named(page, 'File loading settings');
    assert.equal(await page.locator('#file-autoreload').isChecked(), true, 'Autoreload defaults on');
    await page.evaluate(() => {
      const interval = document.querySelector('#refresh-interval'); interval.value = '2'; interval.dispatchEvent(new Event('change'));
    });
    const seed = path.join(f.files, 'seed.txt');
    await page.evaluate(seed => EyaPanels.openFile(seed), seed);
    await fs.writeFile(seed, 'automatically updated\n');
    await page.locator('.cm-content').filter({ hasText: 'automatically updated' }).waitFor();
    await page.locator('.file-change-indicator').filter({ hasText: 'Updated from disk' }).waitFor();
    await page.evaluate(() => { const input = document.querySelector('#file-autoreload'); input.checked = false; input.dispatchEvent(new Event('change')); });
    await f.saved(page);
    const workspaceId = await page.evaluate(() => EyaWorkspaces.getState().workspace.id);
    assert.equal((await f.snapshot()).workspaces.find(record => record.id === workspaceId).preferences.fileAutoreload, false, 'Autoreload preference persists with the workspace');
    await fs.writeFile(seed, 'held external update\n');
    await page.locator('.file-change-indicator').filter({ hasText: 'Changed on disk' }).waitFor();
    assert.match(await page.locator('.cm-content').innerText(), /automatically updated/);
    await page.locator('.viewer-actions').getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.locator('.cm-content').filter({ hasText: 'held external update' }).waitFor();
    await page.locator('.file-change-indicator').filter({ hasText: 'Updated from disk' }).waitFor();
    await page.locator('.cm-content').fill('dirty buffer');
    await page.evaluate(() => { const input = document.querySelector('#file-autoreload'); input.checked = true; input.dispatchEvent(new Event('change')); });
    await fs.writeFile(seed, 'external conflict\n');
    await page.locator('.file-change-indicator').filter({ hasText: 'Changed on disk' }).waitFor();
    assert.equal(await page.locator('.cm-content').innerText(), 'dirty buffer');

    // Hold server messages and deliver the metadata and first data chunk separately.
    const large = path.join(f.files, 'large.txt'); await fs.writeFile(large, 'x'.repeat(240000));
    await page.evaluate(large => {
      const socket = window.__sockets.find(socket => socket.readyState === WebSocket.OPEN);
      const receive = socket.onmessage, queue = [];
      socket.onmessage = event => queue.push(event);
      window.nextFileMessage = () => { if (queue.length) receive.call(socket, queue.shift()); };
      window.queuedFileMessages = () => queue.length;
      window.finishFileMessages = () => { socket.onmessage = receive; for (const event of queue.splice(0)) receive.call(socket, event); };
      window.loadingLargeFile = EyaPanels.openFile(large);
    }, large);
    await page.waitForFunction(() => queuedFileMessages() > 0);
    await page.evaluate(() => nextFileMessage());
    await page.locator('.file-load-progress').filter({ hasText: '0 B / 240,000 B (0%)' }).waitFor();
    await page.waitForFunction(() => queuedFileMessages() > 0);
    await page.evaluate(() => nextFileMessage());
    await page.locator('.file-load-progress').filter({ hasText: '60,000 B / 240,000 B (25%)' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    const progress = page.locator('.file-load-progress:visible');
    assert.equal(await progress.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'Progress fits a narrow pane');
    await page.evaluate(() => finishFileMessages()); await page.evaluate(() => window.loadingLargeFile);
    assert.equal(await page.locator('.file-load-progress:visible').count(), 0);
    await page.evaluate(async () => {
      const send = WebSocket.prototype.send, queue = [];
      WebSocket.prototype.send = function(data) { queue.push([this, data]); };
      window.releaseDirectoryRequest = () => { WebSocket.prototype.send = send; for (const [socket, data] of queue) send.call(socket, data); };
      await EyaPanels.create('files');
    });
    await page.locator('.file-instance .file-status').filter({ hasText: '0 B received · total unknown' }).waitFor();
    await page.evaluate(() => releaseDirectoryRequest());
    await page.locator('.file-instance .file-status').filter({ hasText: '3 items' }).waitFor();
    assert.deepEqual(f.errors, []);
    console.log('File loading: byte progress, autoreload default, disabled autoreload, disk-change indicators and dirty-buffer protection passed');
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
