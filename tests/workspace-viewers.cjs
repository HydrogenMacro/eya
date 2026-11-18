const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { fixture } = require('./continuity-fixture.cjs');
const { reveal } = require('./ui-helpers.cjs');

(async () => {
  const f = await fixture();
  try {
    await execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x96:rate=10', '-t', '45', '-c:v', 'libvpx-vp9', '-b:v', '80k', '-an', '-y', path.join(f.files, 'video.webm')]);
    await fs.writeFile(path.join(f.files, 'model.stl'), 'solid test\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid test\n');
    const page = await f.client(); await f.named(page, 'Viewer fixture');
    const workspace = await page.evaluate(() => EyaWorkspaces.getState().workspace.id);
    const openFile = filename => page.evaluate(path => EyaPanels.openFile(path), path.join(f.files, filename));
    await openFile('seed.txt');
    const editor = page.locator('.cm-content'); await editor.fill('unsaved local buffer');
    const editorId = await page.evaluate(() => EyaPanels.layout().flatMap(group => group.panels).find(id => id.startsWith('file-')));
    await (await reveal(page, '#disconnect')).click();
    assert.equal(await editor.innerText(), 'unsaved local buffer');
    await page.locator('#connect').click(); await page.locator('#start-connection').click();
    await page.waitForFunction(() => document.querySelector('#status').dataset.connected === 'true');
    assert.equal(await editor.innerText(), 'unsaved local buffer');
    await fs.writeFile(path.join(f.files, 'seed.txt'), 'new external version\n');
    await page.evaluate(id => EyaPanels.call(id, 'save'), editorId);
    assert.equal(await fs.readFile(path.join(f.files, 'seed.txt'), 'utf8'), 'new external version\n');
    assert.ok(await page.locator('.panel-tab-dirty').filter({ hasText: '●' }).count(), 'Rejected version conflict retains the dirty buffer');
    await page.getByRole('status').filter({ hasText: 'File changed while saving' }).waitFor();

    await openFile('model.stl');
    await page.waitForFunction(() => document.querySelector('.cad-viewer')?.dataset.revision === '1');
    const cadId = await page.evaluate(() => EyaPanels.layout().flatMap(group => group.panels).find(id => document.querySelector(`[data-panel="${id}"]`)?.textContent.includes('model.stl')));
    const before = await page.evaluate(id => EyaPanels.call(id, 'cadState'), cadId);
    await (await reveal(page, '#disconnect')).click();
    assert.deepEqual(await page.evaluate(id => EyaPanels.call(id, 'cadState'), cadId), before, 'Same-page disconnect retains the loaded CAD model and camera');
    await page.locator('#connect').click(); await page.locator('#start-connection').click();
    await page.waitForFunction(() => document.querySelector('#status').dataset.connected === 'true');
    const task = await page.evaluate(() => EyaPanels.create('task-manager'));
    await page.waitForFunction(id => EyaPanels.call(id, 'getState').processes > 0, task);
    const docker = await page.evaluate(() => EyaPanels.create('docker'));
    await page.locator('.docker-status').filter({ hasText: /./ }).waitFor();
    await openFile('video.webm');
    let video = page.frameLocator('.native-video-frame').locator('video[src]'); await video.waitFor();
    await video.evaluate(v => new Promise((resolve, reject) => { if (v.readyState >= 1) return resolve(); const timer = setTimeout(() => reject(Error('Video metadata timed out')), 20000); v.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve(); }, { once: true }); }));
    await video.evaluate(v => { v.currentTime = 17; v.pause(); });
    await video.evaluate(v => new Promise(resolve => { if (!v.seeking) return resolve(); v.addEventListener('seeked', resolve, { once: true }); }));
    await page.waitForFunction(() => EyaWorkspaces.getState().pending);
    await f.saved(page);
    const stored = (await f.snapshot()).workspaces.find(record => record.id === workspace);
    const media = stored.tabs.find(tab => tab.config.path?.endsWith('/video.webm'));
    assert.ok(Math.abs(media.config.time - 17) < 0.25, `Saved seek position ${media.config.time}`);
    assert.equal(media.config.paused, true);
    assert.ok(stored.tabs.some(tab => tab.kind === 'task-manager')); assert.ok(stored.tabs.some(tab => tab.kind === 'docker'));
    assert.ok(!JSON.stringify(stored).includes('unsaved local buffer'), 'Editor drafts are not persisted');

    await page.context().close();
    const restored = await f.client({ type: 'svg' }); await restored.evaluate(id => EyaWorkspaces.open(id), workspace);
    await restored.locator('.viewer-message').filter({ hasText: 'File changed since this tab was saved' }).waitFor({ state: 'attached' });
    await restored.waitForFunction(() => document.querySelector('.cad-viewer')?.dataset.revision === '1');
    await restored.evaluate(id => EyaPanels.activate(id), media.id);
    // Playwright's FrameLocator expects an uppercase HTML nodeName, while SVG
    // foreignObject elements use lowercase names. Use the attached Frame itself.
    let playerFrame;
    for (let attempt = 0; attempt < 100; attempt++) {
      playerFrame = restored.frames().find(frame => frame.url().includes('/eya-media/player.html'));
      if (playerFrame) break;
      await restored.waitForTimeout(50);
    }
    assert.ok(playerFrame, 'SVG client attaches the real player frame');
    video = playerFrame.locator('video[src]'); await video.waitFor();
    await video.evaluate(v => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(`Resume position timed out: ${v.currentTime}, ${v.error?.message || ''}`)), 20000); const check = () => { if (v.readyState >= 1 && !v.seeking && Math.abs(v.currentTime - 17) < 0.25) { clearTimeout(timer); v.removeEventListener('timeupdate', check); resolve(); } }; v.addEventListener('timeupdate', check); check(); }));
    assert.equal(await video.evaluate(v => v.paused), true);
    // A service-worker restart must rebuild a decoder/stream, while the same
    // versioned file and saved seek position remain attached to the tab.
    const cdp = await restored.context().newCDPSession(restored);
    await cdp.send('ServiceWorker.enable'); await cdp.send('ServiceWorker.stopAllWorkers');
    await restored.waitForTimeout(11000); await cdp.detach();
    await video.evaluate(v => { v.currentTime = 30; });
    await video.evaluate(v => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(`Worker recovery seek failed: ${v.currentTime} ${v.error?.message || ''}`)), 20000); const check = () => { if (!v.seeking && Math.abs(v.currentTime - 30) < 0.25 && v.readyState >= 2) { clearTimeout(timer); resolve(); } }; v.addEventListener('seeked', check, { once: true }); check(); }));
    await restored.evaluate(id => EyaPanels.activate(id), editorId);
    await restored.getByRole('button', { name: 'Reload current file', exact: true }).click();
    await restored.locator('.cm-content').filter({ hasText: 'new external version' }).waitFor();
    assert.equal(await restored.locator('.instance-terminal').count(), 0, 'All viewer/system recovery works without a PTY');
    assert.deepEqual(f.errors, []);
    console.log('Workspace viewers: dirty editor recovery/version conflicts, CAD retention/reopen, system-panel recipes, HTML-to-SVG video seek restoration and media-worker restart passed');
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
