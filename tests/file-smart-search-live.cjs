const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./continuity-fixture.cjs');

(async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.files, 'folder', 'child.txt'), 'combobox child\n');
    const page = await f.client();
    await page.evaluate(cwd => { EyaPanels.open('browser'); return EyaPanels.call('browser', 'navigate', cwd); }, f.files);
    const modernId = await page.evaluate(cwd => EyaPanels.create('files', { cwd }), f.files);
    for (const [id, selector] of [[modernId, '.file-instance'], ['browser', '#file-panel']]) {
      await page.evaluate(id => EyaPanels.activate(id), id);
      const scope = page.locator(selector);
      const directory = scope.getByRole('combobox', { name: 'Current directory', exact: true });
      const search = scope.getByRole('combobox', { name: 'Search files', exact: true });
      await directory.fill(path.join(f.files, 'fol'));
      const pathList = page.locator(`#${await directory.getAttribute('aria-controls')}`);
      await pathList.getByRole('option', { name: path.join(f.files, 'folder'), exact: true }).waitFor();
      await directory.press('ArrowDown'); await directory.press('Enter');
      await scope.locator('tbody tr').filter({ hasText: 'child.txt' }).waitFor();
      await search.fill('../seed');
      assert.equal(await search.inputValue(), 'seed');
      const searchList = page.locator(`#${await search.getAttribute('aria-controls')}`);
      await searchList.getByRole('option', { name: path.join(f.files, 'seed.txt'), exact: true }).waitFor();
      assert.equal(await directory.inputValue(), f.files);
      await search.press('ArrowUp'); await search.press('Enter');
      await page.locator('.cm-content').filter({ hasText: 'initial fixture' }).waitFor();
      await page.evaluate(id => EyaPanels.activate(id), id);
      await directory.fill(`${f.files}/folder/../`);
      assert.equal(await directory.inputValue(), f.files + '/');
      await directory.press('Enter');
      await scope.locator('tbody tr').filter({ hasText: 'seed.txt' }).waitFor();
      await search.fill('child');
      await searchList.getByRole('option', { name: path.join(f.files, 'folder', 'child.txt'), exact: true }).waitFor();
      await search.press('Escape');
      assert.equal(await search.getAttribute('aria-expanded'), 'false');
    }
    assert.deepEqual(f.errors, []);
    console.log('Live legacy and independent file-browser path/search suggestions, relative parents, keyboard opening and dismissal passed');
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exit(1); });
