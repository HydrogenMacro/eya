const { chromium } = require('playwright');
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
    await page.goto(pathToFileURL(path.resolve('client.html')).href);
    await page.locator('#url').fill('ws://127.0.0.1:18765/ws');
    await page.locator('#key').fill('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    await page.locator('#start-connection').click();
    await page.locator('#status').filter({ hasText: 'Connected' }).waitFor({ timeout: 10000 });
    await page.locator('#files').click();
    await page.locator('#file-list tr').filter({ hasText: 'seed.txt' }).waitFor();

    await page.locator('#file-list tr').filter({ hasText: 'seed.txt' }).dblclick();
    await page.locator('.cm-content').waitFor();
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nchanged in editor');
    await page.locator('.viewer-actions button').filter({ hasText: 'Save' }).click();
    await page.waitForTimeout(500);
    if (!(await fs.readFile(path.join(root, 'seed.txt'), 'utf8')).includes('changed in editor')) throw Error('CodeMirror save did not update the file');

    await page.locator('[data-tab=browser]').click();
    await page.locator('#file-upload-input').setInputFiles({ name: 'uploaded.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded contents') });
    await page.locator('#file-list tr').filter({ hasText: 'uploaded.txt' }).waitFor();

    page.once('dialog', dialog => dialog.accept('renamed.txt'));
    await page.locator('#file-list tr').filter({ hasText: 'uploaded.txt' }).click();
    await page.locator('#file-rename').click();
    await page.locator('#file-list tr').filter({ hasText: 'renamed.txt' }).waitFor();

    await page.locator('#file-search').fill('renamed');
    await page.locator('#file-status').filter({ hasText: 'result' }).waitFor();
    if (await page.locator('#file-list tr').count() !== 1) throw Error('Recursive file search returned an unexpected result count');
    await page.locator('#file-search').fill('');
    await page.locator('#file-list tr').filter({ hasText: 'renamed.txt' }).waitFor();

    await page.locator('#file-list tr').filter({ hasText: 'renamed.txt' }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#file-download').click();
    const download = await downloadPromise;
    if (download.suggestedFilename() !== 'renamed.txt') throw Error('Download used the wrong filename');

    page.once('dialog', dialog => dialog.accept());
    await page.locator('#file-delete').click();
    await page.locator('#file-list tr').filter({ hasText: 'renamed.txt' }).waitFor({ state: 'detached' });

    await page.locator('#settings').click();
    await page.locator('#settings-search').fill('wrap');
    if (!await page.locator('#editor-wrap').isVisible() || await page.locator('#cursor-style').isVisible()) throw Error('Settings search did not filter settings');
    console.log('File browse, search, upload, download, rename, delete, CodeMirror save, and settings search passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
