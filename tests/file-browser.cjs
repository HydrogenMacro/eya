const { chromium } = require('playwright');
const { reveal } = require('./ui-helpers.cjs');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = process.env.EYA_TEST_ROOT;
if (!root) throw Error('EYA_TEST_ROOT is required');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.EYA_BROWSER_EXECUTABLE,
    args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.on('pageerror', error => console.error('Page error:', error));
  try {
    await fs.mkdir(path.join(root, 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, 'nested', 'child.txt'), 'child contents');
    await Promise.all(['uploaded.txt', 'renamed.txt', 'sound.mp3', 'movie.mp4', 'keyboard-delete.txt', 'keyboard-backspace.txt'].map(name => fs.rm(path.join(root, name), { force: true })));
    await page.goto(pathToFileURL(path.resolve('client.html')).href);
    await page.locator('#url').fill('ws://127.0.0.1:18765/ws');
    await page.locator('#key').fill('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    await page.locator('#start-connection').click();
    await page.locator('#status').filter({ hasText: 'Connected' }).waitFor({ timeout: 10000 });
    await page.locator('#files').click();
    await page.locator('#file-list tr').filter({ hasText: 'seed.txt' }).waitFor();
    if (!(await page.locator('#file-list tr').first().innerText()).includes('..')) throw Error('Parent directory entry is not first');
    const initialWorkbench = await page.evaluate(() => ({ api: typeof EyaPanels?.split === 'function', layout: EyaPanels?.layout() }));
    if (!initialWorkbench.api || initialWorkbench.layout.length !== 2) throw Error(`Generic panel API or initial split is invalid: ${JSON.stringify(initialWorkbench)}`);
    if (!await page.locator('#file-empty').isHidden() || await page.locator('#file-empty').boundingBox()) throw Error('Non-empty directory still laid out its empty state');

    await page.locator('#file-list tr').filter({ hasText: 'nested' }).dblclick();
    await page.locator('#file-list tr').filter({ hasText: 'child.txt' }).waitFor();
    if (!await page.locator('#file-empty').isHidden() || await page.locator('#file-empty').boundingBox()) throw Error('Populated folder showed or laid out its empty state');
    if (await page.locator('#browser-view').evaluate(element => element.scrollTop) !== 0) throw Error('Opening a folder did not start at the top of its file list');
    await page.locator('#file-list tr').filter({ hasText: '..' }).dblclick();
    await page.locator('#file-list tr').filter({ hasText: 'seed.txt' }).waitFor();

    await page.locator('#file-list tr').filter({ hasText: 'seed.txt' }).dblclick();
    await page.locator('.cm-content').waitFor();
    if (await page.locator('#file-panel .cm-content').count()) throw Error('Editor preview is still nested inside the file browser panel');
    const editorPanel = await page.evaluate(() => EyaPanels.layout().flatMap(group => group.panels).find(id => id.startsWith('file:')));
    await page.evaluate(id => EyaPanels.split(id, 'horizontal', 'terminal'), editorPanel);
    const splitState = await page.evaluate(id => ({ layout: EyaPanels.layout(), tab: document.querySelector(`[data-panel="${CSS.escape(id)}"]`)?.draggable, sashes: document.querySelectorAll('.panel-sash').length }), editorPanel);
    if (splitState.layout.length !== 3 || !splitState.tab || splitState.sashes < 2) throw Error(`Tabbed/resizable panel split is invalid: ${JSON.stringify(splitState)}`);
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nchanged in editor');
    await page.locator('.viewer-actions button').filter({ hasText: 'Save' }).click();
    await page.waitForTimeout(500);
    if (!(await fs.readFile(path.join(root, 'seed.txt'), 'utf8')).includes('changed in editor')) throw Error('CodeMirror save did not update the file');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nedit retained through disconnect');
    await (await reveal(page, '#disconnect')).click();
    const saveButton = page.locator('.viewer-actions button').filter({ hasText: 'Save' });
    await saveButton.click();
    await page.locator('#file-status').filter({ hasText: 'Reconnecting' }).waitFor();
    if (await saveButton.isDisabled()) throw Error('An interrupted save left the editor Save action disabled');
    await page.locator('#connect').click(); await page.locator('#start-connection').click();
    await page.locator('#status').filter({ hasText: 'session resumed' }).waitFor();
    await saveButton.click();
    await page.waitForFunction(() => ![...document.querySelectorAll('.panel-tab-dirty')].some(element => element.textContent.includes('●')));
    if (!(await fs.readFile(path.join(root, 'seed.txt'), 'utf8')).includes('edit retained through disconnect')) throw Error('Unsaved editor contents were lost during reconnect');

    await page.locator('[data-tab=browser]').click();
    await page.locator('#file-upload-input').setInputFiles([
      { name: 'uploaded.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded contents') },
      { name: 'sound.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('not-real-audio') },
      { name: 'movie.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not-real-video') },
      { name: 'keyboard-delete.txt', mimeType: 'text/plain', buffer: Buffer.from('delete fixture') },
      { name: 'keyboard-backspace.txt', mimeType: 'text/plain', buffer: Buffer.from('backspace fixture') },
    ]);
    await page.locator('#file-list tr').filter({ hasText: 'uploaded.txt' }).waitFor();

    await page.locator('#file-list tr').filter({ hasText: 'sound.mp3' }).dblclick();
    await page.locator('.viewer-body audio[controls]').waitFor();
    await page.locator('[data-tab=browser]').click();
    await page.locator('#file-list tr').filter({ hasText: 'movie.mp4' }).dblclick();
    await page.locator('.viewer-body video[controls]').waitFor();
    await page.locator('[data-tab=browser]').click();

    page.once('dialog', dialog => dialog.accept('renamed.txt'));
    await page.locator('#file-list tr').filter({ hasText: 'uploaded.txt' }).locator('.file-entry-button').click();
    await page.locator('#file-entry-menu [data-file-action=rename]').click();
    await page.locator('#file-list tr').filter({ hasText: 'renamed.txt' }).waitFor();

    await page.locator('#file-search').fill('renamed');
    await page.locator('#file-status').filter({ hasText: 'result' }).waitFor();
    if (await page.locator('#file-list tr').count() !== 1) throw Error('Recursive file search returned an unexpected result count');
    await page.locator('#file-search').fill('');
    await page.locator('#file-list tr').filter({ hasText: 'renamed.txt' }).waitFor();

    await page.locator('#file-list tr').filter({ hasText: 'renamed.txt' }).locator('.file-entry-button').click();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#file-entry-menu [data-file-action=download]').click();
    const download = await downloadPromise;
    if (download.suggestedFilename() !== 'renamed.txt') throw Error('Download used the wrong filename');

    page.once('dialog', dialog => dialog.accept());
    await page.locator('#file-list tr').filter({ hasText: 'renamed.txt' }).locator('.file-entry-button').click();
    await page.locator('#file-entry-menu [data-file-action=delete]').click();
    await page.locator('#file-list tr').filter({ hasText: 'renamed.txt' }).waitFor({ state: 'detached' });

    for (const [filename, key] of [['keyboard-delete.txt', 'Delete'], ['keyboard-backspace.txt', 'Backspace']]) {
      const row = page.locator('#file-list tr').filter({ hasText: filename });
      await row.click();
      page.once('dialog', dialog => dialog.accept());
      await page.keyboard.press(key);
      await row.waitFor({ state: 'detached' });
      try { await fs.stat(path.join(root, filename)); throw Error(`${key} did not delete the selected file`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }

    await (await reveal(page, '#settings')).click();
    await page.locator('#settings-search').fill('wrap');
    if (!await page.locator('#editor-wrap').isVisible() || await page.locator('#cursor-style').isVisible()) throw Error('Settings search did not filter settings');
    console.log('Parent navigation, per-file menus, Delete/Backspace, audio/video viewers, transfer actions, CodeMirror save, search, and settings passed');
  } finally {
    await page.evaluate(() => document.getElementById('end-session')?.click()).catch(() => {});
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
