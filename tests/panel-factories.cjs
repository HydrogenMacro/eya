const { fixture } = require('./continuity-fixture.cjs');

(async () => {
  const f = await fixture();
  const page = await f.client({ viewport: { width: 1400, height: 900 }, startupPanel: 'none', webgl: false });
  const errors = f.errors;
  let extra;
  try {
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
    const first = await page.evaluate(() => EyaPanels.layout().flatMap(group => group.panels).find(id => id.startsWith('test-notes-')));
    const second = await page.evaluate(() => EyaPanels.create('test-notes'));
    if (!first || first === second) throw Error('Panel factories did not create unique instances');
    await page.evaluate(([first, second]) => { EyaPanels.close(first); EyaPanels.close(second); }, [first, second]);
    const reference = await page.evaluate(() => EyaPanels.create('terminal'));
    await page.waitForFunction(id => EyaPanels.call(id, 'getState').connected, reference);
    extra = await page.evaluate(() => EyaPanels.create('terminal'));
    await page.waitForFunction(id => EyaPanels.call(id, 'getState').connected, extra);
    await page.evaluate(id => EyaPanels.call(id, 'sendInput', "printf '\\105\\130\\124\\122\\101\\137\\124\\105\\122\\115\\137\\117\\113\\n'\r"), extra);
    await page.locator('.instance-terminal .xterm-screen').filter({ hasText: 'EXTRA_TERM_OK' }).waitFor();
    if ((await page.locator('.instance-terminal .xterm-screen').first().textContent()).includes('EXTRA_TERM_OK')) throw Error('Terminal instances shared output');
    await page.evaluate(id => {
      EyaPanels.call(id, 'reconnect');
      EyaPanels.call(id, 'sendInput', "printf '\\102\\125\\106\\106\\105\\122\\105\\104\\137\\117\\113\\n'\r");
    }, extra);
    await page.locator('.instance-terminal .xterm-screen').filter({ hasText: 'BUFFERED_OK' }).waitFor();
    await page.evaluate(id => EyaPanels.call(id, 'end'), extra);
    await page.evaluate(id => EyaPanels.call(id, 'restart'), extra);
    await page.waitForFunction(id => EyaPanels.call(id, 'getState').connected && !EyaPanels.call(id, 'getState').ended, extra);
    await page.evaluate(id => EyaPanels.close(id), extra); extra = null;
    await page.evaluate(id => EyaPanels.close(id), reference);
    if (await page.locator('.instance-terminal').count()) throw Error('Closing an independent terminal left its DOM behind');
    if (errors.length) throw Error(errors.join('; '));
    console.log('Panel type registry, searchable metadata-driven launcher, live starter updates, unique instances, terminal output isolation, buffered reconnect, explicit restart, and cleanup passed');
  } finally {
    if (extra) await page.evaluate(id => EyaPanels.close(id), extra).catch(() => {});
    await f.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
