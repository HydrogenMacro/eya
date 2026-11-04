const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    page.on('pageerror', e => console.error('Page error:', e.message));
    const key = Object.hasOwn(process.env, 'EYA_TEST_KEY')
      ? process.env.EYA_TEST_KEY
      : '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    await page.goto('http://127.0.0.1:18765/');
    const launchers = await page.locator('.launchers a').evaluateAll(links => links.map(link => new URL(link.href).pathname));
    if (launchers.join(',') !== '/client.html,/client.svg') throw Error(`Hosted client launchers are invalid: ${launchers}`);
    const htmlResponse = await page.goto('http://127.0.0.1:18765/client.html');
    if (!htmlResponse.headers()['content-type']?.startsWith('text/html') || !await page.locator('#connect-dialog').isVisible()) throw Error('Hosted HTML client is unavailable');
    if (await page.locator('#url').inputValue() !== 'ws://127.0.0.1:18765/ws' || await page.locator('#key').inputValue() !== key) throw Error('Hosted HTML did not inherit the server URL and password');
    const svgResponse = await page.goto('http://127.0.0.1:18765/client.svg');
    if (!svgResponse.headers()['content-type']?.startsWith('image/svg+xml')) throw Error('Hosted SVG has the wrong content type');
    try { await page.locator('#connect-dialog').waitFor({ state: 'visible', timeout: 5000 }); }
    catch { throw Error(`Hosted SVG client did not initialize: ${await page.locator('foreignObject').textContent()}`); }
    const svgLayout = await page.locator('body').evaluate(body => ({ width: body.getBoundingClientRect().width, viewport: innerWidth }));
    if (Math.abs(svgLayout.width - svgLayout.viewport) > 2) throw Error(`Hosted SVG client is not responsive: ${JSON.stringify(svgLayout)}`);
    const hostedSvgConfig = await page.locator('#url,#key').evaluateAll(elements => elements.map(element => element.value));
    if (hostedSvgConfig[0] !== 'ws://127.0.0.1:18765/ws' || hostedSvgConfig[1] !== key) throw Error('Hosted SVG did not inherit the server URL and password');
    await page.locator('#start-connection').click();
    await page.locator('#status').filter({ hasText: 'Connected' }).waitFor({ timeout: 10000 });
    await page.locator('#terminal').click();
    await page.keyboard.type("printf '\110\117\123\124\105\104\137\123\126\107\137\117\113\n'");
    await page.keyboard.press('Enter');
    await page.locator('.xterm-screen').filter({ hasText: 'HOSTED_SVG_OK' }).waitFor({ timeout: 5000 });
    await page.goto('http://127.0.0.1:18765/');
    await page.locator('#key').fill(key);
    const defaultCommand = "printf '\\104\\105\\106\\101\\125\\114\\124\\137\\103\\117\\115\\115\\101\\116\\104\\n'";
    await page.locator('#command').fill(defaultCommand);
    await page.locator('#font').setInputFiles(process.env.EYA_TEST_FONT || '/usr/share/fonts/adobe-source-code-pro-fonts/SourceCodePro-Bold.otf');
    await page.locator('#size').fill('18');
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button[type=submit]').click()]);
    const outputDirectory = process.env.EYA_TEST_OUTPUT || '/tmp';
    const filename = path.join(outputDirectory, 'eya-generated-test.html');
    await download.saveAs(filename);
    const html = fs.readFileSync(filename, 'utf8');
    if (!html.includes(key) || !html.includes('127.0.0.1:18765/ws') || !html.includes(JSON.stringify(defaultCommand).slice(1, -1)) || !html.includes('data:') || !html.includes('id="keybar"')) throw Error('Generated HTML configuration or mobile controls are missing');
    await page.locator('#format').selectOption('svg');
    const svgDownloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.locator('button[type=submit]').click();
    let svgDownload;
    try { svgDownload = await svgDownloadPromise; }
    catch { throw Error(`SVG generation failed: ${await page.locator('#error').textContent()}`); }
    const svgFilename = path.join(outputDirectory, 'eya-generated-test.svg');
    await svgDownload.saveAs(svgFilename);
    const svg = fs.readFileSync(svgFilename, 'utf8');
    if (!svg.includes('<foreignObject') || !svg.includes('xmlns="http://www.w3.org/1999/xhtml"') || !svg.includes(key) || !svg.includes('id="keybar"')) throw Error('Generated SVG client is invalid');
    await page.locator('#format').selectOption('compressed-html');
    const compressedDownloadPromise = page.waitForEvent('download');
    await page.locator('button[type=submit]').click();
    const compressedDownload = await compressedDownloadPromise;
    const compressedFilename = path.join(outputDirectory, 'eya-generated-compressed-test.html');
    await compressedDownload.saveAs(compressedFilename);
    const compressedSize = fs.statSync(compressedFilename).size;
    if (compressedSize >= Buffer.byteLength(html) * 0.8) throw Error(`Compressed HTML was not materially smaller (${compressedSize} vs ${Buffer.byteLength(html)})`);
    await page.locator('#format').selectOption('data-url');
    await page.locator('button[type=submit]').click();
    await page.locator('#data-url-result').waitFor({ state: 'visible' });
    const dataUrl = await page.locator('#data-url').inputValue();
    if (!dataUrl.startsWith('data:text/html') || dataUrl.length >= Buffer.byteLength(html) * 0.9) throw Error('Compressed HTML data URL is missing or unexpectedly large');
    const dataPage = await browser.newPage();
    await dataPage.goto(dataUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await dataPage.locator('#connect-dialog').waitFor({ state: 'visible', timeout: 10000 });
    if (await dataPage.locator('#key').inputValue() !== key) throw Error('HTML data URL lost its embedded configuration');
    await dataPage.close();
    await page.goto(pathToFileURL(filename).href);
    if (await page.locator('#url').inputValue() !== 'ws://127.0.0.1:18765/ws') throw Error('URL not configured');
    if (await page.locator('#key').inputValue() !== key || await page.locator('#font-size').inputValue() !== '18') throw Error('Client defaults not configured');
    await page.waitForFunction(() => [...document.fonts].some(font => font.family === 'EyaEmbeddedFont' && font.status === 'loaded'), null, { timeout: 5000 });
    await page.locator('#start-connection').click();
    try {
      await page.waitForFunction(() => document.querySelector('#status').textContent === 'Connected', null, { timeout: 10000 });
    } catch {
      const state = await page.locator('#status').textContent();
      const detail = await page.locator('#error').textContent();
      throw Error(`Generated HTML did not connect (status: ${state}; error: ${detail})`);
    }
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
    await page.goto(pathToFileURL(svgFilename).href);
    const svgUrl = await page.locator('#url').evaluate(element => ({ value: element.value, namespace: element.namespaceURI, type: element.constructor.name }));
    if (svgUrl.value !== 'ws://127.0.0.1:18765/ws') {
      const script = await page.locator('svg > script').evaluateAll(elements => elements.map(element => {
        try { Function(element.textContent); return { syntax: 'valid', length: element.textContent.length, start: element.textContent.slice(0, 40), namespace: element.namespaceURI }; }
        catch (error) { return { syntax: error.message, length: element.textContent.length, start: element.textContent.slice(0, 40), namespace: element.namespaceURI }; }
      }));
      const dom = await page.evaluate(() => ({ configLength: document.getElementById('eya-config')?.textContent.length, terminals: document.querySelectorAll('.xterm-screen').length, dialogOpen: document.getElementById('connect-dialog')?.open }));
      throw Error(`SVG client did not load: ${JSON.stringify({ svgUrl, script, dom })}`);
    }
    await page.locator('#start-connection').click();
    await page.locator('#status').filter({ hasText: 'Connected' }).waitFor({ timeout: 10000 });
    await page.locator('#terminal').click();
    await page.keyboard.type("printf '\123\126\107\137\103\114\111\105\116\124\137\117\113\n'");
    await page.keyboard.press('Enter');
    await page.locator('.xterm-screen').filter({ hasText: 'SVG_CLIENT_OK' }).waitFor({ timeout: 5000 });
    console.log('Hosted credential inheritance, HTML/SVG/data-URL generation, compression, encrypted terminal and large output passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
