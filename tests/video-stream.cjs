const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  try {
    await page.goto(process.env.EYA_TEST_DOCUMENT || pathToFileURL(path.resolve('client.html')).href);
    await page.locator('#url').fill('ws://127.0.0.1:18765/ws');
    await page.locator('#key').fill('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    await page.locator('#start-connection').click();
    await page.locator('#status').filter({ hasText: 'Connected' }).waitFor();
    await page.locator('#files').click();
    const name = process.env.EYA_VIDEO_NAME || 'test.mp4';
    await page.locator(`#file-list tr[data-path$="/${name}"]`).dblclick();
    const video = page.frameLocator('.native-video-frame').locator('.eya-video-stage video[src]');
    await video.waitFor();
    await video.evaluate(v => { v.play().catch(() => {}); });
    await video.evaluate(v => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(`Playback timed out: ${v.error?.message || v.networkState}`)), 20000); const check = () => { if (v.currentTime > 0.2) { clearTimeout(timer); v.removeEventListener('timeupdate', check); resolve(); } }; v.addEventListener('timeupdate', check); check(); }));
    const seek = page.frameLocator('.native-video-frame').getByLabel('Seek');
    await seek.hover();
    await page.frameLocator('.native-video-frame').locator('.eya-video-seek-preview canvas:not([hidden])').waitFor({ timeout: 15000 });
    await page.mouse.move(0, 0);
    if (process.env.EYA_TEST_RESTART_WORKER) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('ServiceWorker.enable'); await cdp.send('ServiceWorker.stopAllWorkers');
      await page.waitForTimeout(12000);
      await cdp.detach();
    }
    for (const target of [35, 5]) {
      await video.evaluate((v, time) => { v.currentTime = time; }, target);
      await video.evaluate((v, t) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(`Seek timed out: ${t}, ${v.currentTime}, ${v.error?.message || v.networkState}`)), 20000); const check = () => { if (!v.seeking && v.currentTime > t + 0.2) { clearTimeout(timer); v.removeEventListener('timeupdate', check); resolve(); } }; v.addEventListener('timeupdate', check); check(); }), target);
    }
    const streamUrl = await video.evaluate(v => v.src);
    const outsider = await page.context().newPage();
    try {
      await outsider.goto(new URL('player.html', streamUrl).href);
      await outsider.waitForFunction(() => !!navigator.serviceWorker.controller);
      const status = await outsider.evaluate(url => fetch(url).then(response => response.status), streamUrl);
      if (status !== 404) throw Error(`Another client accessed the video stream: ${status}`);
    } finally { await outsider.close(); }
    const player = page.frameLocator('.native-video-frame');
    await video.hover({ position: { x: 20, y: 20 } });
    await player.getByRole('button', { name: 'Settings', exact: true }).click();
    await player.getByRole('menuitem', { name: 'Subtitles', exact: true }).click();
    await player.getByRole('menuitem', { name: 'How to embed subtitles' }).click();
    await player.getByText('Embedding subtitles with ffmpeg').waitFor();
    await player.getByRole('button', { name: 'Close', exact: true }).click();
    await video.evaluate(v => { const track = v.addTextTrack('subtitles', 'Test embedded track', 'en'); track.addCue(new VTTCue(0, 100, 'Hello from a cue')); });
    await player.getByRole('menuitemradio', { name: 'Test embedded track', exact: true }).click();
    await player.locator('.eya-video-captions').filter({ hasText: 'Hello from a cue' }).waitFor();
    await page.locator('#status').click();
    await player.locator('.eya-video-player.eya-video-ui-hidden').waitFor();
    await video.hover({ position: { x: 20, y: 20 } });
    await player.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    if (errors.length) throw Error(errors.join('\n'));
    console.log(`${name}: playback, remote seeks, and custom subtitle cue rendering passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
