const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./continuity-fixture.cjs');

(async () => {
  const f = await fixture();
  try {
    const page = await f.client();
    const seed = path.join(f.files, 'seed.txt');
    await page.evaluate(() => {
      const send = WebSocket.prototype.send, queue = [];
      window.holdFileTraffic = () => { WebSocket.prototype.send = function(data) { queue.push([this, data]); }; };
      window.releaseFileTraffic = () => { WebSocket.prototype.send = send; for (const [socket, data] of queue.splice(0)) send.call(socket, data); };
    });
    await page.evaluate(seed => { holdFileTraffic(); window.opening = EyaPanels.openFile(seed); }, seed);
    const viewer = page.locator('.viewer').filter({ has: page.locator('.viewer-message') });
    await viewer.getByRole('status').filter({ hasText: 'Loading seed.txt' }).waitFor();
    assert.equal(await viewer.getByRole('button', { name: 'Refresh', exact: true }).isDisabled(), true);
    const id = await page.evaluate(() => EyaPanels.layout().flatMap(group => group.panels).find(id => id.startsWith('file-')));
    await page.evaluate(() => releaseFileTraffic());
    await page.evaluate(() => window.opening);
    await page.locator('.cm-content').filter({ hasText: 'initial fixture' }).waitFor();
    const refresh = page.locator('.viewer-actions').getByRole('button', { name: 'Refresh', exact: true });
    await fs.writeFile(seed, 'manual refresh result\n');
    await refresh.click();
    await page.locator('.cm-content').filter({ hasText: 'manual refresh result' }).waitFor();
    await page.locator('.cm-content').fill('unsaved buffer');
    assert.equal(await refresh.isDisabled(), true);
    await page.evaluate(id => EyaPanels.close(id), id);

    // Closing a pending open must prevent a late response from recreating it.
    await page.evaluate(seed => { holdFileTraffic(); window.opening = EyaPanels.openFile(seed); }, seed);
    await page.locator('.viewer-message').filter({ hasText: 'Loading seed.txt' }).waitFor();
    await page.evaluate(() => EyaPanels.close(EyaPanels.layout().flatMap(group => group.panels).find(id => id.startsWith('file-'))));
    await page.evaluate(() => releaseFileTraffic());
    await page.evaluate(() => window.opening);
    assert.equal(await page.locator('.viewer').count(), 0);

    const missing = path.join(f.files, 'missing.txt');
    await page.evaluate(missing => EyaPanels.openFile(missing), missing);
    await page.locator('.viewer-message').waitFor();
    await fs.writeFile(missing, 'retry succeeded\n');
    await page.locator('.viewer-actions').getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.locator('.cm-content').filter({ hasText: 'retry succeeded' }).waitFor();

    // Both browser implementations expose Refresh outside their menus.
    await page.evaluate(() => EyaPanels.open('browser'));
    await page.locator('#file-refresh').waitFor({ state: 'visible' });
    await fs.writeFile(path.join(f.files, 'new-entry.txt'), 'new');
    await page.locator('#file-refresh').click();
    await page.locator('#file-list tr').filter({ hasText: 'new-entry.txt' }).waitFor();
    await page.evaluate(() => EyaPanels.create('files'));
    await page.locator('.file-instance-toolbar').getByRole('button', { name: 'Refresh', exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
    console.log('File viewers: immediate loading panes, manual refresh, dirty buffers, close races, retry and browser toolbar controls passed');
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
