const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./continuity-fixture.cjs');

(async () => {
  const f = await fixture();
  try {
    const filename = path.join(f.files, 'binary.bin');
    await fs.writeFile(filename, Buffer.alloc(4096));
    const page = await f.client(); await f.named(page, 'Binary editor');
    await page.evaluate(filename => EyaPanels.openFile(filename), filename);
    const binary = page.locator('.binary-viewer'); await binary.waitFor();
    const save = page.locator('.binary-popover [role=menuitem][aria-label=Save]');
    const refresh = page.locator('.binary-popover [role=menuitem][aria-label=Refresh]');
    const action = async name => { await binary.getByRole('button', { name: 'Row actions', exact: true }).click(); await page.getByRole('menuitem', { name, exact: true }).click(); };
    assert.equal(await page.locator('.viewer-actions').count(), 0, 'binary has a single top toolbar');
    assert.equal(await save.isDisabled(), true);
    const edit = async (offset, value) => {
      await binary.getByRole('button', { name: 'Go to offset', exact: true }).click();
      const goto = page.getByRole('textbox', { name: 'Go to offset', exact: true });
      await goto.fill(String(offset)); await goto.press('Enter');
      await binary.getByRole('textbox', { name: 'Edit selected value', exact: true }).fill(value);
      await binary.getByRole('button', { name: 'Apply', exact: true }).click();
    };
    await edit(0, 'AA'); assert.equal(await save.isEnabled(), true); assert.equal(await refresh.isDisabled(), true);
    await page.evaluate(() => {
      const send = WebSocket.prototype.send, queue = [];
      window.holdFileTraffic = () => { WebSocket.prototype.send = function(data) { queue.push([this, data]); }; };
      window.releaseFileTraffic = () => { WebSocket.prototype.send = send; for (const [socket, data] of queue.splice(0)) send.call(socket, data); };
      holdFileTraffic();
    });
    await action('Save'); await edit(1, 'BB');
    await page.evaluate(filename => EyaPanels.openFile(filename, 'text'), filename);
    assert.equal(await binary.count(), 1, 'Open With preserves the buffer while an upload is active');
    await page.evaluate(() => releaseFileTraffic());
    await page.locator('#file-status').filter({ hasText: 'binary.bin saved.' }).waitFor({ state: 'attached' });
    assert.deepEqual([...(await fs.readFile(filename)).subarray(0,3)], [170,0,0], 'the first save writes its captured snapshot');
    assert.equal(await binary.getAttribute('data-dirty'), 'true', 'typing during save remains dirty');
    assert.equal(await save.isEnabled(), true);
    await binary.getByRole('grid',{name:'Binary data'}).focus();await page.keyboard.press('Control+s'); await page.waitForFunction(() => document.querySelector('.binary-viewer')?.dataset.dirty === 'false');
    assert.deepEqual([...(await fs.readFile(filename)).subarray(0,3)], [170,187,0]);
    assert.equal(await save.isDisabled(), true); assert.equal(await refresh.isEnabled(), true);
    await edit(2, 'CC');
    const downloadPromise = page.waitForEvent('download');
    await action('Download');
    const download = await downloadPromise;
    assert.deepEqual([...(await fs.readFile(await download.path())).subarray(0,3)], [170,187,204], 'downloads include unsaved binary edits');
    assert.deepEqual([...(await fs.readFile(filename)).subarray(0,3)], [170,187,0], 'download does not mutate the server file');
    // Real insertion/deletion use the same guarded save snapshots as overwrites.
    await binary.getByRole('button', { name: 'Go to offset', exact: true }).click();
    await page.getByRole('textbox', { name: 'Go to offset', exact: true }).fill('4096');
    await page.getByRole('textbox', { name: 'Go to offset', exact: true }).press('Enter');
    await action('Insert row');
    const insertedLength = Number(await binary.getAttribute('data-length'));
    assert(insertedLength > 4096);
    await page.evaluate(() => holdFileTraffic()); await action('Save'); await action('Delete selection');
    assert.equal(await binary.getAttribute('data-length'), '4096');
    await page.evaluate(() => releaseFileTraffic());
    await page.locator('#file-status').filter({ hasText: 'binary.bin saved.' }).waitFor({ state: 'attached' });
    assert.equal((await fs.stat(filename)).size, insertedLength, 'in-flight save captures inserted bytes');
    assert.equal(await binary.getAttribute('data-dirty'), 'true', 'deleting during save remains dirty');
    await binary.getByRole('grid', { name: 'Binary data' }).focus(); await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.querySelector('.binary-viewer')?.dataset.dirty === 'false');
    assert.equal((await fs.stat(filename)).size, 4096, 'next save persists deletion');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForFunction(() => document.querySelector('.binary-toolbar')?.clientWidth <= innerWidth);
      assert.equal(await binary.locator('.binary-toolbar').evaluate(el => el.scrollWidth <= el.clientWidth), true, `${width}px full-client toolbar fits`);
      assert.equal(await binary.locator('.binary-edit').evaluate(el => el.scrollWidth <= el.clientWidth), true, `${width}px full-client edit row fits`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.setViewportSize({ width: 1440, height: 900 }); await edit(2, 'DD');
    // Server-side compare-and-write must reject a stale binary overwrite.
    const external = Buffer.alloc(4096); external[0] = 255; await fs.writeFile(filename, external);
    await action('Save');
    await page.locator('#file-status').filter({ hasText: /changed|conflict|version/i }).waitFor({ state: 'attached' });
    assert.equal(await binary.getAttribute('data-dirty'), 'true');
    assert.deepEqual([...(await fs.readFile(filename)).subarray(0,3)], [255,0,0], 'external replacement survives a stale save');
    const id = await page.evaluate(() => EyaPanels.layout().flatMap(group => group.panels).find(id => id.startsWith('file-')));
    page.__dialogHandler = dialog => dialog.dismiss(); await page.evaluate(id => EyaPanels.close(id), id);
    assert.equal(await binary.count(), 1, 'canceling a dirty close retains the edit buffer');
    page.__dialogHandler = dialog => dialog.accept(); await page.evaluate(id => EyaPanels.close(id), id);
    assert.equal(await binary.count(), 0);
    assert.deepEqual(f.errors, []);
    console.log('Binary live: encrypted overwrite/insert/delete saves, concurrent mutations, unsaved downloads, conflict safety, 320px and dirty close passed');
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
