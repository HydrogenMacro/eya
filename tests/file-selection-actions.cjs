const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./continuity-fixture.cjs');

(async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.files, 'alpha.txt'), 'alpha bytes\n');
    await fs.writeFile(path.join(f.files, 'beta.txt'), 'beta bytes\n');
    await fs.writeFile(path.join(f.files, 'transparent.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="16" height="16" fill="red"/></svg>');
    const page = await f.client(); await f.named(page, 'File actions');
    await page.evaluate(directory => { EyaPanels.open('browser'); return EyaPanels.call('browser', 'navigate', directory); }, f.files);
    const legacy = page.locator('#file-panel'), row = name => legacy.locator('tbody tr').filter({ hasText: name });
    await row('alpha.txt').click(); await row('beta.txt').click({ modifiers: ['Control'] }); await row('seed.txt').click({ modifiers: ['Alt'] });
    assert.equal(await legacy.locator('tr.selected').count(), 3);
    await row('seed.txt').click({ modifiers: ['Alt'] }); assert.equal(await legacy.locator('tr.selected').count(), 2);
    await page.keyboard.press('Control+c');
    await legacy.getByRole('status').filter({ hasText: '2 files copied' }).waitFor();
    const modernId = await page.evaluate(cwd => EyaPanels.create('files', { cwd }), path.join(f.files, 'folder'));
    const modern = page.locator('.file-instance');
    await modern.getByRole('button', { name: 'Paste files', exact: true }).click();
    await modern.locator('.file-status').filter({ hasText: 'Pasted 2 files' }).waitFor();
    assert.equal(await fs.readFile(path.join(f.files, 'folder', 'alpha.txt'), 'utf8'), 'alpha bytes\n');
    assert.equal(await fs.readFile(path.join(f.files, 'folder', 'beta.txt'), 'utf8'), 'beta bytes\n');

    const a = modern.locator('tbody tr').filter({ hasText: 'alpha.txt' });
    await a.click(); await page.keyboard.press('Control+c'); await page.keyboard.press('Control+v');
    await modern.locator('tbody tr').filter({ hasText: 'alpha copy.txt' }).waitFor();
    assert.equal(await fs.readFile(path.join(f.files, 'folder', 'alpha copy.txt'), 'utf8'), 'alpha bytes\n');
    await a.click(); await modern.locator('tbody tr').filter({ hasText: 'beta.txt' }).click({ modifiers: ['Alt'] });
    await page.evaluate(id => EyaPanels.call(id, 'refresh'), modernId);
    assert.equal(await modern.locator('tr.selected').count(), 2, 'Refresh preserves all selected rows');
    await modern.getByRole('button', { name: 'Delete selected entries', exact: true }).click();
    await modern.locator('.file-status').filter({ hasText: 'Deleted 2/2 entries' }).waitFor();
    for (const name of ['alpha.txt', 'beta.txt']) await assert.rejects(fs.stat(path.join(f.files, 'folder', name)), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(f.files, 'alpha.txt'), 'utf8'), 'alpha bytes\n', 'Copying and deleting copies preserve the source');

    // Canceling the dirty-editor confirmation must happen before deleting anything.
    await page.evaluate(file => EyaPanels.openFile(file), path.join(f.files, 'alpha.txt'));
    await page.locator('.cm-content').fill('unsaved source edits');
    await page.evaluate(() => EyaPanels.activate('browser'));
    await row('alpha.txt').click(); await row('beta.txt').click({ modifiers: ['Control'] });
    let rejectedDirtyDelete = false;
    page.__dialogHandler = dialog => {
      if (dialog.message().includes('discard unsaved edits')) { rejectedDirtyDelete = true; return dialog.dismiss(); }
      return dialog.accept();
    };
    await legacy.getByRole('button', { name: 'Delete selected entries', exact: true }).click();
    assert.equal(rejectedDirtyDelete, true);
    assert.equal(await fs.readFile(path.join(f.files, 'alpha.txt'), 'utf8'), 'alpha bytes\n');
    assert.equal(await fs.readFile(path.join(f.files, 'beta.txt'), 'utf8'), 'beta bytes\n');
    page.__dialogHandler = dialog => dialog.accept();
    // Checkboxes support selection without modifier keys on a narrow display.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(id => EyaPanels.activate(id), modernId);
    await modern.getByRole('checkbox', { name: 'Select alpha copy.txt', exact: true }).check();
    assert.equal(await modern.locator('tr.selected').count(), 1);
    assert.equal(await modern.locator('.file-selection-bar').evaluate(element => element.scrollWidth <= element.clientWidth), true);

    const imagePath = path.join(f.files, 'transparent.svg');
    await page.evaluate(imagePath => EyaPanels.openFile(imagePath), imagePath);
    const image = page.locator('.image-viewer-body');
    await image.waitFor(); assert.equal(await image.getAttribute('data-checkerboard'), 'true');
    assert.match(await image.evaluate(element => getComputedStyle(element).backgroundImage), /conic-gradient/);
    await page.getByRole('radio', { name: 'White background', exact: true }).check();
    assert.equal(await image.evaluate(element => getComputedStyle(element).backgroundImage), 'none');
    assert.equal(await image.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
    for (const label of ['Zoom out', 'Zoom in', 'Reset image view', 'Copy image']) {
      const button = page.locator('.viewer-actions').getByRole('button', { name: label, exact: true });
      assert.equal(await button.locator('svg').count(), 1);
      assert.equal(await button.locator('.sr-only').count(), 1);
    }
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: 'Copy image', exact: true }).click();
    await page.locator('.ui-toast').filter({ hasText: 'Image copied' }).waitFor();
    assert.deepEqual(await page.evaluate(async () => {
      const items = await navigator.clipboard.read(), blob = await items.find(item => item.types.includes('image/png')).getType('image/png');
      const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
      return { width: bitmap.width, height: bitmap.height, alpha: context.getImageData(63, 63, 1, 1).data[3] };
    }), { width: 64, height: 64, alpha: 0 }, 'Copy button writes transparent PNG pixels through the real Clipboard API');
    await page.keyboard.press('Escape');
    await page.locator('.viewer-actions').getByRole('button', { name: 'Refresh', exact: true }).click();
    await f.saved(page);
    const workspaceId = await page.evaluate(() => EyaWorkspaces.getState().workspace.id);
    const saved = (await f.snapshot()).workspaces.find(record => record.id === workspaceId).tabs.find(tab => tab.config.path === imagePath);
    assert.deepEqual(saved.config.imageBackground, { mode: 'white', checkerboard: false, color1: '#ffffff', color2: '#a8a8a8' });
    await page.evaluate(id => EyaWorkspaces.open(id), workspaceId);
    await page.evaluate(id => EyaPanels.activate(id), saved.id);
    await page.locator('.image-viewer-body[data-checkerboard=false]').waitFor();
    assert.equal(await page.locator('.image-viewer-body').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)', 'Saved image background restores with the workspace');
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.evaluate(id => {
      EyaPanels.register({ id: 'hover-other', element: document.createElement('textarea') }); EyaPanels.open('hover-other');
      EyaPanels.split(id, 'vertical', 'hover-other'); EyaPanels.activate('hover-other');
      const mode = document.querySelector('#panel-focus-mode'); mode.value = 'hover'; mode.dispatchEvent(new Event('change', { bubbles: true }));
    }, saved.id);
    await page.mouse.move(0, 0); await page.locator('.image-viewer-body').hover();
    assert.equal(await page.locator('.image-viewer-body').evaluate(element => document.activeElement === element), true, 'Hover focuses the image canvas instead of its background radios');
    const transform = await page.locator('.image-viewer-body img').evaluate(element => element.style.transform);
    await page.keyboard.press('ArrowRight');
    assert.notEqual(await page.locator('.image-viewer-body img').evaluate(element => element.style.transform), transform, 'Hovered image receives keyboard pan commands');
    assert.deepEqual(f.errors, []);
    console.log('File actions: Ctrl/Alt selection, shared copy/paste, same-folder duplicates, multi-delete, touch controls, and saved image background presets passed');
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
