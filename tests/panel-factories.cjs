const { chromium } = require('playwright');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let extra;
  try {
    await page.goto(pathToFileURL(path.resolve('client.html')).href);
    await page.locator('#url').fill('ws://127.0.0.1:18765/ws');
    await page.locator('#key').fill('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    await page.locator('#start-connection').click();
    await page.locator('#status').filter({ hasText: 'Connected' }).waitFor();
    await page.getByRole('button', { name: 'New panel', exact: true }).first().click();
    await page.locator('.panel-start').waitFor();
    await page.evaluate(() => {
      EyaPanels.registerType({ id: 'test-notes', title: 'Test notes', icon: 'FileCode', category: 'Extensions', description: 'A temporary text scratchpad.', keywords: ['scratchpad', 'memo'], order: 5, create({ id }) {
        const element = document.createElement('textarea'); element.value = id;
        return { id, title: 'Test notes', element };
      } });
    });
    const starter = page.locator('.panel-start');
    const metadata = await page.evaluate(() => EyaPanels.listTypes().find(type => type.id === 'test-notes'));
    if (metadata.category !== 'Extensions' || metadata.description !== 'A temporary text scratchpad.' || !metadata.keywords.includes('scratchpad')) throw Error(`Panel launcher metadata was lost: ${JSON.stringify(metadata)}`);
    const search = starter.getByRole('searchbox', { name: 'Search panels' });
    await search.fill('scratchpad');
    if (await starter.getByRole('button', { name: 'Test notes', exact: true }).count() !== 1 || await starter.getByRole('button', { name: 'Terminal', exact: true }).count()) throw Error('Panel launcher keyword search did not filter results');
    await search.fill('does-not-exist');
    await starter.locator('.panel-start-empty').filter({ hasText: 'No panels match' }).waitFor();
    await search.press('Escape');
    if (await search.inputValue() || await starter.getByRole('button', { name: 'Terminal', exact: true }).count() !== 1) throw Error('Panel launcher search did not clear with Escape');
    await search.fill('test notes');
    await starter.getByRole('button', { name: 'Test notes', exact: true }).click();
    const first = await page.evaluate(() => EyaPanels.layout().flatMap(group => group.panels).find(id => id.startsWith('test-notes:')));
    const second = await page.evaluate(() => EyaPanels.create('test-notes'));
    if (!first || first === second) throw Error('Panel factories did not create unique instances');
    await page.evaluate(([first, second]) => { EyaPanels.close(first); EyaPanels.close(second); }, [first, second]);
    extra = await page.evaluate(() => EyaPanels.create('terminal'));
    await page.waitForFunction(id => EyaPanels.call(id, 'getState').connected, extra);
    await page.evaluate(id => EyaPanels.call(id, 'sendInput', "printf '\\105\\130\\124\\122\\101\\137\\124\\105\\122\\115\\137\\117\\113\\n'\r"), extra);
    await page.locator('.instance-terminal .xterm-screen').filter({ hasText: 'EXTRA_TERM_OK' }).waitFor();
    if ((await page.locator('#terminal .xterm-screen').textContent()).includes('EXTRA_TERM_OK')) throw Error('Terminal instances shared output');
    await page.evaluate(id => {
      EyaPanels.call(id, 'reconnect');
      EyaPanels.call(id, 'sendInput', "printf '\\102\\125\\106\\106\\105\\122\\105\\104\\137\\117\\113\\n'\r");
    }, extra);
    await page.locator('.instance-terminal .xterm-screen').filter({ hasText: 'BUFFERED_OK' }).waitFor();
    await page.evaluate(id => EyaPanels.call(id, 'end'), extra);
    await page.getByRole('button', { name: 'Start new terminal session', exact: true }).click();
    await page.waitForFunction(id => EyaPanels.call(id, 'getState').connected && !EyaPanels.call(id, 'getState').ended, extra);
    await page.evaluate(id => EyaPanels.close(id), extra); extra = null;
    if (await page.locator('.instance-terminal').count()) throw Error('Closing an independent terminal left its DOM behind');
    if (errors.length) throw Error(errors.join('; '));
    console.log('Panel type registry, searchable metadata-driven launcher, live starter updates, unique instances, terminal output isolation, buffered reconnect, explicit restart, and cleanup passed');
  } finally {
    if (extra) await page.evaluate(id => EyaPanels.close(id), extra).catch(() => {});
    await page.evaluate(() => document.getElementById('end-session')?.click()).catch(() => {});
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
