const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');

// Exercise the real iframe host styles separately from playback and transport.
(async () => {
  const code = buildSync({ entryPoints: ['client/video-controls.js'], bundle: true, platform: 'browser', format: 'iife', globalName: 'VideoControls', write: false }).outputFiles[0].text;
  const host = fs.readFileSync('client/media-player.html', 'utf8').replace(/<script[^>]*>.*?<\/script>/, '');
  const shellCss = fs.readFileSync('client/template.html', 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1]
    + fs.readFileSync('client/components.css', 'utf8') + fs.readFileSync('client/mobile.css', 'utf8');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.route('http://eya.test/player', route => route.fulfill({ contentType: 'text/html', body: host }));
    await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${shellCss}</style><header class="app-header">Eya</header><main id="workspace"><div class="panel-group mobile-active"><div class="panel-group-header">Video</div><div class="panel-host"><div class="panel-surface"><div class="viewer"><div class="viewer-actions">Video file</div><div class="viewer-body video-viewer-body"><iframe class="native-video-frame" src="http://eya.test/player"></iframe></div></div></div></div></div></main>`);
    const frame = await page.locator('iframe').elementHandle().then(handle => handle.contentFrame());
    await frame.waitForLoadState();
    await frame.addScriptTag({ content: code });
    await frame.evaluate(() => document.body.append(VideoControls.createVideoControls(document.querySelector('video')).element));
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      const hostLayout = await frame.evaluate(() => {
        scrollTo(100, 100);
        return { width: innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, height: innerHeight, x: scrollX, y: scrollY, position: getComputedStyle(document.body).position };
      });
      const frameBounds = await page.locator('iframe').boundingBox();
      assert.ok(Math.abs(hostLayout.width - frameBounds.width) <= 1, JSON.stringify({ hostLayout, frameBounds }));
      assert.ok(Math.abs(hostLayout.width - hostLayout.clientWidth) <= 1, JSON.stringify(hostLayout));
      assert.ok(hostLayout.scrollWidth <= hostLayout.width + 1 && hostLayout.scrollHeight <= hostLayout.height + 1, JSON.stringify(hostLayout));
      assert.equal(hostLayout.x, 0); assert.equal(hostLayout.y, 0); assert.equal(hostLayout.position, 'fixed');
      const shellLayout = await page.locator('.viewer-body').evaluate(element => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, frameHeight: element.querySelector('iframe').getBoundingClientRect().height, windowHeight: innerHeight, y: scrollY }));
      assert.ok(shellLayout.scrollHeight <= shellLayout.clientHeight + 1 && shellLayout.scrollWidth <= shellLayout.clientWidth + 1, JSON.stringify(shellLayout));
      assert.ok(Math.abs(shellLayout.frameHeight - shellLayout.clientHeight) <= 1, JSON.stringify(shellLayout));
      assert.equal(shellLayout.y, 0);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await frame.evaluate(() => {
      const menu = document.querySelector('.eya-video-settings'); menu.hidden = false;
      const contents = document.createElement('div'); contents.style.height = '1400px'; contents.textContent = 'Scrollable player settings'; menu.append(contents);
    });
    const menu = await page.frameLocator('iframe').locator('.eya-video-settings').boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const x = menu.x + menu.width / 2, y = menu.y + menu.height * 0.75;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 100 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await frame.waitForFunction(() => document.querySelector('.eya-video-settings').scrollTop > 0);
    assert.equal(await frame.evaluate(() => scrollY), 0);
    assert.equal(await page.evaluate(() => scrollY), 0);
    await cdp.detach();
    // Insecure origins use the same controls directly in the whole-file viewer.
    await page.addScriptTag({ content: code });
    await page.evaluate(() => document.querySelector('.viewer-body').replaceChildren(VideoControls.createVideoControls(document.createElement('video')).element));
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      const layout = await page.locator('.viewer-body').evaluate(element => ({ height: element.clientHeight, scrollHeight: element.scrollHeight, width: element.clientWidth, scrollWidth: element.scrollWidth, playerHeight: element.querySelector('.eya-video-player').getBoundingClientRect().height, y: scrollY }));
      assert.ok(layout.scrollHeight <= layout.height + 1 && layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
      assert.ok(Math.abs(layout.height - layout.playerHeight) <= 1, JSON.stringify(layout));
      assert.equal(layout.y, 0);
    }
    console.log('Mobile streamed and whole-file video fit their panels without page scrolling; settings still scroll locally.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
