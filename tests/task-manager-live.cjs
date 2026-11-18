const assert = require('node:assert/strict');
const { fixture } = require('./continuity-fixture.cjs');

(async () => {
  const f = await fixture();
  try {
    const page = await f.client();
    // History collects while no Task Manager exists, independently of its UI.
    await page.waitForTimeout(1600);
    const id = await page.evaluate(() => EyaPanels.create('task-manager'));
    const graph = page.locator('.task-manager-v2 .live-chart-svg').first();
    await page.waitForFunction(() => {
      const text = document.querySelector('.task-manager-v2 .live-chart-svg')?.getAttribute('aria-label');
      return Number(text?.match(/(\d+) samples/)?.[1]) >= 4;
    });
    assert.equal(await page.locator('.task-manager-v2 .live-chart-empty').first().isVisible(), false);
    const count = Number((await graph.getAttribute('aria-label')).match(/(\d+) samples/)[1]);
    await page.evaluate(id => EyaPanels.minimize(id), id);
    await page.waitForTimeout(1600);
    await page.evaluate(id => EyaPanels.open(id), id);
    await page.waitForFunction(count => {
      const text = document.querySelector('.task-manager-v2 .live-chart-svg')?.getAttribute('aria-label');
      return Number(text?.match(/(\d+) samples/)?.[1]) >= count + 3;
    }, count);
    assert.equal(await page.evaluate(id => EyaPanels.call(id, 'getSettings').interval, id), 500);
    assert.deepEqual(f.errors, []);
    console.log('Live Task Manager: authenticated startup history, populated first-open graphs and inactive-panel gap recovery passed');
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
