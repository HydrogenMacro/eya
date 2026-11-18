const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');
(async () => {
  const runtime = fs.readFileSync('eya-server/src/browser_native.js', 'utf8');
  const bundle = buildSync({ entryPoints: ['client/browser-native-actions.js'], bundle: true, platform: 'browser', format: 'iife', globalName: 'NativeActions', write: false });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE });
  try {
    const page = await browser.newPage();
    await page.route('https://native.test/**', route => route.fulfill({ contentType: 'text/html', body: '<button id="request">Request</button><a href="mailto:test@example.test" id="email">Email</a>' }));
    await page.goto('https://native.test/');
    await page.evaluate(() => {
      window.requests = [];
      window.__eyaNativeRequest = data => requests.push(JSON.parse(data));
      window.perform = async () => {};
      document.querySelector('#request').onclick = () => { window.operation = perform(); operation.catch(() => {}); };
    });
    await page.addScriptTag({ content: runtime });
    assert.equal(await page.evaluate(() => navigator.canShare({ text: 'hello', url: '/relative' })), true);
    assert.equal(await page.evaluate(() => navigator.canShare({ files: [new File(['x'], 'x.txt')] })), false);
    assert.equal(await page.evaluate(() => navigator.canShare({ url: 'javascript:alert(1)' })), false);
    assert.equal(await page.evaluate(() => navigator.canShare({ text: 'x'.repeat(13000) })), false);
    // A fresh context has no prior activation, so background reads cannot prompt.
    await page.waitForTimeout(5500);
    const cdp = await page.context().newCDPSession(page);
    const background = await cdp.send('Runtime.evaluate', { expression: "navigator.clipboard.readText().then(() => 'bad', e => e.name)", awaitPromise: true, returnByValue: true, userGesture: false });
    assert.equal(background.result.value, 'NotAllowedError');
    for (const [expression, kind, result] of [
      ["navigator.clipboard.writeText('remote text')", 'clipboard-write', ''],
      ['navigator.clipboard.readText()', 'clipboard-read', 'client text'],
      ["navigator.share({title:'Title',text:'hello',url:'/relative'})", 'share', ''],
    ]) {
      await page.evaluate(expression => { window.perform = () => eval(expression); }, expression);
      await page.locator('#request').click();
      const request = await page.evaluate(() => requests.at(-1)); assert.equal(request.kind, kind);
      assert.equal(await page.evaluate(() => navigator.clipboard.readText().then(() => 'bad', error => error.name)), 'InvalidStateError');
      if (kind === 'share') assert.equal(request.data.url, 'https://native.test/relative');
      await page.evaluate(({ id, result }) => __eyaNativeResolve(id, result, ''), { id: request.id, result });
      assert.equal(await page.evaluate(() => operation.then(value => value ?? '')), result);
    }
    await page.evaluate(() => { window.perform = () => navigator.share({ text: 'cancel me' }); });
    await page.locator('#request').click();
    await page.evaluate(() => __eyaNativeResolve(requests.at(-1).id, '', 'AbortError'));
    assert.equal(await page.evaluate(() => operation.catch(e => e.name)), 'AbortError');
    await page.locator('#email').click();
    assert.deepEqual(await page.evaluate(() => { const r=requests.at(-1); return { kind:r.kind, url:r.data.url }; }), { kind: 'external', url: 'mailto:test@example.test' });
    await page.evaluate(() => __eyaNativeResolve(requests.at(-1).id, '', 'AbortError'));
    // Prompt tests run in a separate client page, whose APIs represent the device.
    const client = await browser.newPage();
    await client.route('https://client.test/**', route => route.fulfill({ contentType: 'text/html', body: '<body></body>' }));
    await client.goto('https://client.test/'); await client.addScriptTag({ content: bundle.outputFiles[0].text });
    await client.evaluate(() => {
      window.replies = []; window.writes = []; window.shares = []; window.current = true;
      Object.defineProperty(navigator, 'clipboard', { value: { async readText() { if (window.deny) throw new DOMException('Clipboard denied', 'NotAllowedError'); if (window.delayRead) return new Promise(resolve => { window.finishRead = resolve; }); return window.clipText || 'client secret'; }, async writeText(text) { writes.push(text); } } });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async data => { shares.push(data); } });
      window.actions = NativeActions.createBrowserNativeActions({ host: document.body, isCurrent: () => current, reply: (entry, value, error) => replies.push({ id: entry.id, value, error }) });
      window.show = (kind, data = {}) => actions.open({ id: replies.length + 1, kind, data, origin: 'https://remote.test' });
    });
    const dialog = client.getByRole('dialog', { name: 'Page native action' });
    await client.evaluate(() => show('clipboard-read'));
    assert.deepEqual(await client.evaluate(() => replies), [], 'Clipboard reads must wait for approval');
    await dialog.getByRole('button', { name: 'Allow once', exact: true }).click();
    assert.equal(await client.evaluate(() => replies.at(-1).value), 'client secret');
    await client.evaluate(() => show('clipboard-write', { text: 'copy this' }));
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
    assert.deepEqual(await client.evaluate(() => writes), ['copy this']);
    await client.evaluate(() => show('share', { title: 'Title', text: 'Body', url: 'https://remote.test/' }));
    await dialog.getByRole('button', { name: 'Share', exact: true }).click();
    assert.equal(await client.evaluate(() => shares.length), 1);
    await client.evaluate(() => { Object.defineProperty(navigator, 'share', { value: undefined }); show('share', { text: 'fallback' }); });
    await dialog.getByRole('button', { name: 'Copy instead', exact: true }).click();
    assert.equal(await client.evaluate(() => writes.at(-1)), 'fallback');
    await client.evaluate(() => { window.deny = true; show('clipboard-read'); });
    await dialog.getByRole('button', { name: 'Allow once', exact: true }).click();
    await dialog.getByText('Clipboard denied', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await client.evaluate(() => replies.at(-1).error), 'AbortError');
    await client.evaluate(() => { show('clipboard-read'); current = false; });
    await dialog.getByRole('button', { name: 'Allow once', exact: true }).click();
    assert.equal(await client.evaluate(() => replies.at(-1).error), 'AbortError', 'Switching page must invalidate the prompt');
    await client.evaluate(() => { current = true; window.deny = false; window.delayRead = true; show('clipboard-read'); });
    await dialog.getByRole('button', { name: 'Allow once', exact: true }).click();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    const before = await client.evaluate(() => replies.length);
    await client.evaluate(() => finishRead('late clipboard secret'));
    assert.equal(await client.evaluate(() => replies.length), before, 'A cancelled read must not send a late clipboard value');
    await client.evaluate(() => { current = true; show('external', { url: 'tel:+15551234567' }); });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await client.evaluate(() => actions.destroy());
    console.log('Native action runtime and UI: activation, validation, clipboard approval, share/copy, mailto/tel, cancellation and stale-page handling passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
