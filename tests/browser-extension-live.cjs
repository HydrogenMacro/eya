const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  if (process.env.EYA_BROWSER_EXTENSION_INTEGRATION !== '1') {
    console.log('Skipped live Chromium extension smoke test (set EYA_BROWSER_EXTENSION_INTEGRATION=1 to enable).');
    return;
  }
  if (!process.env.EYA_BROWSER_EXECUTABLE) throw Error('Set EYA_BROWSER_EXECUTABLE to the Chromium binary used by the Eya server.');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eya-browser-extension-test-'));
  const extensionDir = path.join(root, 'extension');
  await fs.mkdir(extensionDir);
  await fs.writeFile(path.join(extensionDir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Eya live extension test',
    version: '1.0.0',
    action: { default_popup: 'popup.html' },
    content_scripts: [{ matches: ['https://extension-test.example/*'], js: ['content.js'], run_at: 'document_idle' }],
  }));
  await fs.writeFile(path.join(extensionDir, 'content.js'), `document.documentElement.dataset.eyaExtensionSmoke = 'loaded';`);
  await fs.writeFile(path.join(extensionDir, 'popup.html'), '<!doctype html><title>Extension action popup</title><body>popup target test</body>');

  let browser;
  let context;
  let browserSession;
  let extensionId = '';
  try {
    context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
      headless: true,
      executablePath: process.env.EYA_BROWSER_EXECUTABLE,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [],
    });
    browser = context.browser();
    if (!browser) throw Error('Persistent Chromium context did not expose its browser session.');
    browserSession = await browser.newBrowserCDPSession();
    await context.route('https://extension-test.example/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>Extension smoke page</title></head><body>extension test</body></html>',
    }));
    const page = await context.newPage();
    const loaded = await browserSession.send('Extensions.loadUnpacked', { path: extensionDir });
    extensionId = loaded.id;
    assert.match(extensionId, /^[a-p]{32}$/, 'Chromium must return a valid extension ID');

    await page.goto('https://extension-test.example/');
    await page.waitForFunction(() => document.documentElement.dataset.eyaExtensionSmoke === 'loaded');

    const { targetInfos } = await browserSession.send('Target.getTargets');
    const pageTarget = targetInfos.find(target => target.type === 'page' && target.url === page.url());
    assert.ok(pageTarget, 'the loaded page must have a discoverable Chromium tab target');
    const tabTargets = (await browserSession.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] })).targetInfos.filter(target => target.url === page.url());
    assert.equal(tabTargets.length, 1, 'the fixture page must have one matching Chromium tab target');
    await browserSession.send('Extensions.triggerAction', { id: extensionId, targetId: tabTargets[0].targetId });
    let popupTarget;
    for (let attempt = 0; attempt < 30; attempt++) {
      const targets = await browserSession.send('Target.getTargets');
      popupTarget = targets.targetInfos.find(target => target.type === 'page' && target.url === `chrome-extension://${extensionId}/popup.html`);
      if (popupTarget) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(popupTarget, 'triggering the extension action must expose its popup as an attachable page target');
    await browserSession.send('Target.closeTarget', { targetId: popupTarget.targetId });

    await browserSession.send('Extensions.uninstall', { id: extensionId });
    extensionId = '';
    await page.reload();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.eyaExtensionSmoke || ''), '', 'uninstalled extension must stop injecting its content script');
    console.log('Configured Chromium loaded an MV3 extension, triggered its action popup target, and uninstalled it.');
  } finally {
    if (extensionId && browserSession) {
      try { await browserSession.send('Extensions.uninstall', { id: extensionId }); } catch { /* Browser shutdown also removes the temporary profile extension. */ }
    }
    if (context) await context.close();
    else await browser?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
