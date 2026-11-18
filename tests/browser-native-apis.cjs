const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');
(async () => {
  const bundle = buildSync({ entryPoints: ['client/browser-panel.js'], bundle: true, platform: 'browser', format: 'iife', globalName: 'EyaBrowser', write: false });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('about:blank'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      window.uploads = []; window.saved = []; window.cancelled = []; window.prints = []; window.dialogReplies = []; window.nativeReplies = [];
      window.panel = EyaBrowser.createBrowserPanel({ request: async () => {},
        fileRequest: async (op, values) => op === 'stat' ? { size: 4 } : { path: '/', entries: [{ kind: 'file', name: 'seed.txt', path: '/seed.txt', size: 4 }] },
        readLocalFile: async () => ({ bytes: new TextEncoder().encode('seed') }),
        uploadServerFile: async (path, blob, overwrite) => { if (path === '/exists') throw Error('File already exists'); saved.push({ path, text: await blob.text(), overwrite }); },
        openRemoteBrowser: async handlers => {
          window.handlers = handlers;
          return { ready: true, start() {}, privacy() {}, resize() {}, activateTab: async () => ({}), navigate(url, id) { window.tabId = id; },
            async uploadPageFiles(tab, id, files, progress) { uploads.push({ tab, id, files: await Promise.all(files.map(async f => ({ name: f.name, text: await f.text() }))) }); progress(9, 9); },
            cancelPageFileChooser(tab, id) { cancelled.push(id); }, respondToJavaScriptDialog(tab, id, accept, text) { dialogReplies.push({ id, accept, text }); handlers.onEvent({ type: 'javascript-dialog-result', tabId: tab, id, ok: true }); },
            respondToNativeAction(tab, id, value, error) { nativeReplies.push({ id, value, error }); },
            evaluate: async () => ({ result: JSON.stringify(window.contextResult) }), printPage(tab) { prints.push(tab); }, close() {} };
        },
      });
      document.body.append(panel.element); panel.element.style.cssText = 'height:700px;width:360px'; panel.api.navigate('https://example.test');
    });
    await page.waitForFunction(() => window.tabId);
    await page.evaluate(() => handlers.onEvent({ type: 'file-chooser', tabId, id: 1, multiple: true, accept: '.txt' }));
    const picker = page.getByRole('dialog', { name: 'Choose files for web page', exact: true }); await picker.waitFor();
    await picker.locator('input[type=file]').setInputFiles({ name: 'device.txt', mimeType: 'text/plain', buffer: Buffer.from('local') });
    assert.equal(await picker.locator('input[type=file]').getAttribute('accept'), '.txt');
    await picker.getByRole('button', { name: 'Browse server files', exact: true }).click();
    await picker.getByRole('button', { name: 'seed.txt (4 bytes)', exact: true }).click();
    await picker.getByRole('button', { name: 'Use selected files', exact: true }).click();
    await picker.waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => uploads[0].files), [{ name: 'device.txt', text: 'local' }, { name: 'seed.txt', text: 'seed' }]);
    await page.evaluate(() => handlers.onEvent({ type: 'file-chooser', tabId, id: 2, multiple: false }));
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => cancelled), [2]);
    for (const type of ['alert', 'confirm', 'prompt']) {
      await page.evaluate(type => handlers.onEvent({ type: 'javascript-dialog', tabId, id: 10, dialogType: type, message: `Test ${type}`, defaultPrompt: 'default' }), type);
      const dialog = page.locator('.eya-browser-page-dialog'); await dialog.waitFor();
      if (type === 'prompt') await dialog.getByRole('textbox').fill('answer');
      await dialog.getByRole('button', { name: type === 'confirm' ? 'Dismiss the web page dialog' : 'Accept the web page dialog', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    assert.deepEqual(await page.evaluate(() => dialogReplies.map(x => [x.accept, x.text])), [[true, 'default'], [false, ''], [true, 'answer']]);
    await page.evaluate(() => handlers.onEvent({ type: 'print-request', tabId }));
    await page.getByRole('dialog', { name: 'Print page', exact: true }).getByRole('button', { name: 'Create page PDF', exact: true }).click();
    assert.equal(await page.evaluate(() => prints.length), 1);
    await page.evaluate(() => {
      handlers.onEvent({ type: 'download-start', id: 50, filename: 'page.pdf' });
      handlers.onDownload(new TextEncoder().encode('%PDF-fixture'), { id: 50 });
    });
    await page.getByRole('button', { name: 'Save page.pdf to server', exact: true }).click();
    const save = page.getByRole('dialog', { name: 'Save download to server', exact: true });
    await save.getByRole('textbox').fill('/exists'); await save.getByRole('button', { name: 'Save', exact: true }).click();
    await save.getByText('File already exists', { exact: true }).waitFor();
    await save.getByRole('textbox').fill('/saved.pdf'); await save.getByRole('button', { name: 'Save', exact: true }).click();
    await save.waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => saved), [{ path: '/saved.pdf', text: '%PDF-fixture', overwrite: false }]);
    await page.evaluate(() => handlers.onEvent({ type: 'native-action', tabId, id: 80, origin: 'https://example.test', kind: 'clipboard-read', data: {} }));
    await page.getByRole('dialog', { name: 'Page native action', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.evaluate(() => nativeReplies.at(-1).error), 'AbortError');
    await page.evaluate(() => handlers.onEvent({ type: 'native-action', tabId, id: 81, origin: 'https://wrong.test', kind: 'clipboard-read', data: {} }));
    assert.equal(await page.evaluate(() => nativeReplies.at(-1).error), 'NotAllowedError', 'Mismatched prompt origins must be rejected');
    await page.evaluate(() => {
      window.contextResult = { allowed: true, href: 'https://example.test/link' };
      const surface = document.querySelector('.eya-browser-text-surface'), r = surface.getBoundingClientRect();
      surface.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
    });
    await page.getByRole('menuitem', { name: 'Open link in new tab', exact: true }).click();
    assert.equal(await page.locator('.eya-browser-tab-count').textContent(), '2');
    await page.evaluate(() => {
      window.contextResult = { allowed: false, href: '' };
      const surface = document.querySelector('.eya-browser-text-surface'), r = surface.getBoundingClientRect();
      surface.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
    });
    await page.waitForTimeout(50);
    assert.equal(await page.getByRole('menuitem', { name: 'Copy', exact: true }).isVisible(), true, 'Eya context actions override custom page menus');
    await page.evaluate(() => panel.onClose()); assert.deepEqual(errors, []);
    console.log('Native browser UI: mixed device/server files, cancellation, dialogs, print confirmation, and safe server download save passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
