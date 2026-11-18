const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    for (const file of ['client.html', 'client/generator.html']) {
      await page.goto(pathToFileURL(path.resolve(file)).href);
      const result = await page.evaluate(() => {
        const meta = document.querySelector('meta[name=viewport]').content;
        const gesture = new Event('gesturestart', { bubbles: true, cancelable: true });
        document.body.dispatchEvent(gesture);
        return { meta, prevented: gesture.defaultPrevented, touchAction: getComputedStyle(document.documentElement).touchAction };
      });
      if (!/maximum-scale=1/.test(result.meta) || !/user-scalable=no/.test(result.meta) || !result.prevented || result.touchAction.includes('pinch-zoom')) throw Error(`${file}: ${JSON.stringify(result)}`);
      const session = await context.newCDPSession(page);
      await session.send('Input.synthesizePinchGesture', { x: 195, y: 400, scaleFactor: 2, relativeSpeed: 800 });
      if (await page.evaluate(() => visualViewport.scale) !== 1) throw Error(`${file} allowed a pinch zoom`);
      await session.detach();
    }
    await page.goto(pathToFileURL(path.resolve('client.html')).href);
    const sizes = await page.evaluate(() => {
      const host = document.createElement('div');
      host.innerHTML = '<input style="font:11px monospace"><textarea style="font-size:12px"></textarea><select style="font-size:13px"><option>One</option></select><div contenteditable="plaintext-only" style="font-size:10px">Edit</div>';
      document.body.append(host);
      return [...host.children].map(el => { el.focus(); return [getComputedStyle(el).fontSize, visualViewport.scale]; });
    });
    if (sizes.some(([size, scale]) => parseFloat(size) < 16 || scale !== 1)) throw Error(`Mobile editable controls: ${JSON.stringify(sizes)}`);
    await context.close();
    console.log('Mobile zoom checks passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
