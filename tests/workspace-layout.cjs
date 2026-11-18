const assert = require('node:assert/strict');
const { fixture } = require('./continuity-fixture.cjs');
(async () => {
  const f = await fixture();
  const register = page => page.evaluate(() => {
    for (const [id, width, height] of [['wide', 450, 220], ['medium', 350, 180], ['small', 280, 200]]) EyaPanels.registerType({
      id, title: id, minWidth: width, minHeight: height,
      create: ({ id }) => { const element = document.createElement('section'); element.dataset.testMinimum = id; element.textContent = id; return { id, title: id, element }; },
    });
  });
  const dimensions = page => page.evaluate(() => [...document.querySelectorAll('.panel-group')].filter(element => getComputedStyle(element).display !== 'none').map(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, tabs: [...element.querySelectorAll('[data-panel]')].map(tab => tab.dataset.panel) })));
  try {
    const first = await f.client(); await f.named(first, 'Layout fixture'); await register(first);
    const ids = await first.evaluate(async () => {
      const a = await EyaPanels.create('wide'), b = await EyaPanels.create('medium'), c = await EyaPanels.create('small');
      EyaPanels.split(b, 'vertical', a); EyaPanels.split(c, 'horizontal', a); return { a, b, c };
    });
    const root = first.locator('#workspace > .panel-split > .panel-sash');
    const bounds = await root.boundingBox(); await first.mouse.move(bounds.x + 3, bounds.y + 20); await first.mouse.down(); await first.mouse.move(15, bounds.y + 20); await first.mouse.up();
    let sizes = await dimensions(first);
    assert.ok(sizes.find(group => group.tabs.includes(ids.a)).width >= 449.5, 'Sash respects the largest minimum within its nested split');
    assert.ok(sizes.find(group => group.tabs.includes(ids.b)).width >= 349.5);
    const nested = first.locator('#workspace > .panel-split > .panel-split > .panel-sash');
    await nested.focus(); for (let index = 0; index < 30; index++) await first.keyboard.press('ArrowUp');
    sizes = await dimensions(first);
    assert.ok(sizes.find(group => group.tabs.includes(ids.a)).height >= 219.5); assert.ok(sizes.find(group => group.tabs.includes(ids.c)).height >= 199.5);
    await f.saved(first);
    const record = await first.evaluate(() => EyaWorkspaces.getState().workspace);
    await first.setViewportSize({ width: 900, height: 300 });
    await first.waitForFunction(() => document.querySelector('#workspace').classList.contains('panel-constrained'));
    assert.equal((await dimensions(first)).length, 1, 'Impossible height uses the single-group presentation above the mobile width breakpoint');
    await f.saved(first); assert.deepEqual((await f.snapshot()).workspaces.find(workspace => workspace.id === record.id).layout, record.layout);
    const restored = await f.client({ type: 'svg', viewport: { width: 1100, height: 900 } }); await register(restored);
    await restored.evaluate(id => EyaWorkspaces.open(id), record.id);
    sizes = await dimensions(restored);
    assert.ok(sizes.find(group => group.tabs.includes(ids.a)).width >= 449.5); assert.ok(sizes.find(group => group.tabs.includes(ids.b)).width >= 349.5);
    assert.ok(sizes.find(group => group.tabs.includes(ids.c)).height >= 199.5);
    await restored.setViewportSize({ width: 375, height: 700 });
    await restored.evaluate(id => EyaPanels.activate(id), ids.a); assert.equal((await dimensions(restored)).length, 1);
    // Unknown panel kinds remain recoverable entries and keep the saved tree.
    const unknown = await f.client(); await unknown.evaluate(id => EyaWorkspaces.open(id), record.id);
    assert.equal(await unknown.locator('.viewer-message').count(), 3);
    assert.equal(await unknown.evaluate(() => EyaPanels.layout().flatMap(group => group.panels).length), 3);
    assert.deepEqual(f.errors, []);
    console.log('Workspace layout: declared pane minimums, nested sash clamping, short/narrow collapse, SVG restoration and unknown-kind placeholders passed');
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
