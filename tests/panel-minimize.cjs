const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { build } = require('esbuild');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const bundle = await build({ entryPoints: ['client/panels.js'], bundle: true, platform: 'browser', format: 'iife', globalName: 'PanelModule', write: false });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eya-panel-minimize-'));
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const html = `<style>
      *{box-sizing:border-box}body{margin:0;font:14px system-ui}#workspace{height:780px;display:flex;min-height:0}
      .panel-group{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column}.panel-group-header,.panel-tabs,.panel-group-actions,.panel-tab{display:flex}
      .panel-group-header{flex:none}.panel-host{display:flex;flex:1;min-height:0}.panel-surface{flex:1;min-width:0;min-height:0}.panel-surface[hidden],[hidden]{display:none!important}
      .panel-split{display:flex;flex:1;min-height:0}.panel-sash{width:7px}.panel-tab-title{min-width:0}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden}
    </style><main id="workspace"></main>`;
    const filename = path.join(directory, 'client.html'); await fs.writeFile(filename, html); await page.goto(pathToFileURL(filename).href);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      window.workbench = new PanelModule.PanelWorkbench(document.querySelector('#workspace'));
      window.events = { closed: 0, deactivated: 0 };
      const element = document.createElement('textarea'); element.value = 'dirty buffer survives'; element.dataset.original = 'yes';
      workbench.register({ id: 'draft', title: 'Draft notes', kind: 'notes', dirty: true, element, onClose: () => events.closed++, onDeactivate: () => events.deactivated++ });
      workbench.open('draft'); window.original = element;
      for (let index = 0; index < 24; index++) workbench.registerType({ id: `tool-${index}`, title: `Tool ${index}`, category: 'Tools', create: ({ id }) => ({ id, element: document.createElement('section') }) });
    });
    assert.equal(await page.locator('.panel-tab-minimize').count(), 0);
    await page.getByRole('button', { name: 'Panel layout', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Minimize panel', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => ({ closed: events.closed, deactivated: events.deactivated, mounted: original.isConnected, minimized: workbench.panels.get('draft').minimized, grouped: !!workbench.panels.get('draft').groupId })), { closed: 0, deactivated: 1, mounted: true, minimized: true, grouped: false });
    assert.equal(await page.locator('.panel-tab[data-panel=draft]').count(), 0);
    assert.equal(await page.locator('.panel-switcher option[value=draft]').count(), 0);
    const state = await page.evaluate(() => workbench.serialize());
    assert.equal(state.tabs.find(tab => tab.id === 'draft').minimized, true); assert.deepEqual(state.layout.tabs, []);

    await page.evaluate(() => workbench.openStart());
    await page.getByRole('searchbox', { name: 'Search panels', exact: true }).fill('Tool 23');
    assert.equal(await page.getByRole('region', { name: 'Panel types', exact: true }).getByRole('button').count(), 1);
    await page.getByRole('searchbox', { name: 'Search minimized tabs', exact: true }).fill('absent');
    await page.getByText('No minimized tabs match “absent”.', { exact: true }).waitFor();
    await page.getByRole('searchbox', { name: 'Search minimized tabs', exact: true }).fill('notes');
    await page.getByRole('button', { name: 'Reopen Draft notes', exact: true }).click();
    assert.equal(await page.evaluate(() => workbench.panels.get('draft').element === original && original.value === 'dirty buffer survives'), true);
    assert.equal(await page.evaluate(() => events.closed), 0); assert.equal(await page.locator('.panel-start').count(), 0);
    assert.equal((await page.evaluate(() => workbench.serialize())).tabs[0].minimized, false);

    // Terminal tabs keep their compact strip; the shared tab menu still hides
    // the mounted terminal and the launcher reopens the same instance.
    await page.evaluate(() => {
      const element = document.createElement('section'); element.dataset.terminalInstance = 'original';
      workbench.register({ id: 'terminal-test', title: 'Terminal test', kind: 'terminal', element });
      workbench.open('terminal-test');
    });
    assert.equal(await page.locator('.panel-tab[data-panel="terminal-test"] .panel-tab-minimize').count(), 0);
    assert.equal(await page.locator('.panel-tab[data-panel="draft"] .panel-tab-minimize').count(), 0);
    await page.getByRole('button', { name: 'Panel layout', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Minimize panel', exact: true }).click();
    assert.equal(await page.evaluate(() => workbench.panels.get('terminal-test').minimized && workbench.panels.get('terminal-test').element.isConnected), true);
    await page.evaluate(() => workbench.openStart());
    await page.getByRole('button', { name: 'Reopen Terminal test', exact: true }).click();
    assert.equal(await page.evaluate(() => workbench.panels.get('terminal-test').element.dataset.terminalInstance), 'original');
    assert.equal(await page.locator('.panel-tab[data-panel="terminal-test"] .panel-tab-minimize').count(), 0);
    await page.evaluate(() => workbench.close('terminal-test'));

    // Each list has its own scroll surface, and content changes update an
    // already-open launcher without replacing either search input.
    await page.evaluate(() => {
      workbench.openStart();
      for (let index = 0; index < 24; index++) {
        const id = `background-${index}`; workbench.register({ id, title: `Background ${index}`, kind: 'notes', element: document.createElement('section') }); workbench.open(id); workbench.minimize(id);
      }
      workbench.openStart();
    });
    await page.getByRole('button', { name: 'Reopen Background 23', exact: true }).waitFor({ state: 'attached' });
    let overflow = await page.locator('.panel-start-browser').evaluateAll(nodes => nodes.map(node => ({ scrollable: node.scrollHeight > node.clientHeight, overflow: getComputedStyle(node).overflowY })));
    assert.ok(overflow.every(node => node.scrollable && node.overflow === 'auto'));
    await page.setViewportSize({ width: 390, height: 844 });
    overflow = await page.locator('.panel-start-browser').evaluateAll(nodes => nodes.map(node => node.scrollHeight > node.clientHeight && node.clientHeight > 0)); assert.deepEqual(overflow, [true, true]);

    // Restored minimized entries remain outside the split tree. Closing them
    // still runs cleanup exactly once, and workspace clear includes them.
    const restoredCount = await page.evaluate(() => {
      workbench.minimize('draft');
      const state = workbench.serialize();
      workbench.clear({ detach: true }); events.restoredClosed = 0;
      for (const tab of state.tabs) {
        workbench.register({ id: tab.id, title: tab.title, kind: tab.kind, descriptor: tab, element: document.createElement('section'), onClose: () => events.restoredClosed++ });
        workbench.open(tab.id);
      }
      workbench.restoreMinimized(state.tabs); workbench.restoreLayout(state.layout);
      return state.tabs.length;
    });
    assert.equal(await page.evaluate(() => workbench.panels.get('draft').minimized), true);
    await page.evaluate(() => workbench.close('draft'));
    assert.equal(await page.evaluate(() => events.closed), 1); assert.equal(await page.evaluate(() => events.restoredClosed), 1);
    await page.evaluate(() => workbench.clear({ detach: true }));
    assert.equal(await page.evaluate(() => events.restoredClosed), restoredCount);
    assert.equal(await page.evaluate(() => [...workbench.panels.values()].filter(panel => panel.groupId || panel.minimized).length), 0);
    assert.deepEqual(errors, []);
    console.log('Panel minimization: hidden mounted state, lifecycle safety, descriptor/layout restoration, independent searchable scrolling lists and cleanup passed');
  } finally { await browser.close(); await fs.rm(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
