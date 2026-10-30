const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    page.on('pageerror', e => console.error('Page error:', e));
    await page.goto('http://127.0.0.1:18765/');
    const key = Object.hasOwn(process.env, 'EYA_TEST_KEY')
      ? process.env.EYA_TEST_KEY
      : '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    await page.locator('#key').fill(key);
    await page.locator('#command').fill("printf '\\104\\105\\106\\101\\125\\114\\124\\137\\103\\115\\115\\115\\101\\116\\104\\n'");
    await page.locator('#font').setInputFiles(process.env.EYA_TEST_FONT || '/usr/share/fonts/adobe-source-code-pro-fonts/SourceCodePro-Bold.otf');
    await page.locator('#size').fill('18');
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button[type=submit]').click()]);
    const filename = '/tmp/eya-generated-test.html';
    await download.saveAs(filename);
    const html = fs.readFileSync(filename, 'utf8');
    if (!html.includes(key) || !html.includes('127.0.0.1:18765/ws') || !html.includes('DEFAULT_COMMAND') || !html.includes('data:')) throw Error('Generated configuration is missing');
    await page.goto(pathToFileURL(filename).href);
    if (await page.locator('#url').inputValue() !== 'ws://127.0.0.1:18765/ws') throw Error('URL not configured');
    if (await page.locator('#key').inputValue() !== key || await page.locator('#font-size').inputValue() !== '18') throw Error('Client defaults not configured');
    await page.waitForFunction(() => [...document.fonts].some(font => font.family === 'EyaEmbeddedFont' && font.status === 'loaded'), null, { timeout: 5000 });
    await page.locator('#start-connection').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent === 'Connected', null, { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('.xterm-screen').innerText.includes('DEFAULT_COMMAND'), null, { timeout: 5000 });
    await page.keyboard.type("head -c 400000 /dev/zero | tr '\\0' x; printf '\\n\\106\\114\\117\\127\\137\\124\\105\\123\\124\\137\\120\\101\\123\\123\\105\\104\\n'");
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.xterm-screen').innerText.includes('FLOW_TEST_PASSED'), null, { timeout: 20000 });
    await page.locator('#settings').click();
    await page.locator('#font-size').fill('21');
    await page.locator('#font-size').blur();
    await page.locator('#local-echo').check();
    await page.locator('#close-settings').click();
    await page.reload();
    if (await page.locator('#font-size').inputValue() !== '21') throw Error('Display settings were not saved');
    if (!await page.locator('#local-echo').isChecked()) throw Error('Instant settings were not saved');
    console.log('Generator, embedded font/key/URL and large encrypted output passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
