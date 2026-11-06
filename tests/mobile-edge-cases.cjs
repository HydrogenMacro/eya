const { chromium } = require('playwright');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const errors = [];
  try {
    for (const file of ['client.html', 'client.svg']) {
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:18765/${file}`);
      await page.locator('#start-connection').click();
      await page.locator('#status').filter({ hasText: 'Connected' }).waitFor();
      const id = await page.evaluate(() => EyaPanels.create('task-manager'));
      const task = page.locator('.task-manager-v2');
      await task.locator('tbody tr').first().waitFor();
      await task.getByRole('button', { name: 'Performance', exact: true }).tap();
      const dashboard = task.locator('.task-dashboard');
      await dashboard.locator('.live-chart-svg').first().waitFor();
      const layout = await dashboard.evaluate(element => ({ height: element.clientHeight, scroll: element.scrollHeight, pageWidth: document.documentElement.scrollWidth, width: innerWidth, plots: [...element.querySelectorAll('.live-chart-svg')].map(svg => ({ height: svg.getBoundingClientRect().height, viewHeight: svg.viewBox.baseVal.height, width: svg.getBoundingClientRect().width, viewWidth: svg.viewBox.baseVal.width })) }));
      if (layout.scroll <= layout.height + 50 || layout.height > 844) throw Error(`Performance dashboard cannot scroll: ${JSON.stringify(layout)}`);
      if (layout.pageWidth > layout.width + 1) throw Error('Mobile workbench overflows horizontally');
      for (const plot of layout.plots) if (Math.abs(plot.height - plot.viewHeight) > 1 || plot.height > 220 || plot.height < 80 || Math.abs(plot.width - plot.viewWidth) > 40) throw Error(`Mobile graph stretches its data: ${JSON.stringify(plot)}`);
      const allowed = await dashboard.locator('.live-chart-svg').first().evaluate(element => { const event = new TouchEvent('touchmove', { bubbles: true, cancelable: true }); element.dispatchEvent(event); return !event.defaultPrevented; });
      if (!allowed) throw Error('Global scroll lock blocks graph scrolling');
      const boundaries = await dashboard.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        function blocked(position, delta) {
          element.scrollTop = position;
          const point = y => new Touch({identifier:42,target:element,clientX:bounds.x+30,clientY:y});
          element.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:[point(bounds.y+80)]}));
          const move=new TouchEvent('touchmove',{bubbles:true,cancelable:true,touches:[point(bounds.y+80+delta)]});
          element.dispatchEvent(move);
          element.dispatchEvent(new TouchEvent('touchend',{bubbles:true,touches:[]}));
          return move.defaultPrevented;
        }
        const top=blocked(0,20), bottom=blocked(element.scrollHeight,-20), middle=blocked(100,-20);
        element.scrollTop=0;
        return {top,bottom,middle,pageY:scrollY,overscroll:getComputedStyle(document.documentElement).overscrollBehaviorY};
      });
      if(!boundaries.top||!boundaries.bottom||boundaries.middle||boundaries.pageY||boundaries.overscroll!=='none')throw Error(`Page/pull-to-refresh boundary guard is invalid: ${JSON.stringify(boundaries)}`);
      // Real compositor-driven touch scrolling, rather than setting scrollTop.
      const client = await context.newCDPSession(page), bounds = await dashboard.boundingBox();
      const x = bounds.x + bounds.width / 2, y = bounds.y + Math.min(300, bounds.height - 25);
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 8; step++) { await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 25 }] }); await page.waitForTimeout(20); }
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForFunction(() => document.querySelector('.task-dashboard').scrollTop > 50);
      if(await page.evaluate(()=>scrollY!==0))throw Error('Task scrolling moved the global page');
      // The first tap during native fling scrolling cancels momentum rather than
      // activating a control. Let the gesture settle before testing menu taps.
      await page.waitForTimeout(1000);
      const options = task.getByRole('button', { name: 'Task Manager options', exact: true });
      for (let tap = 0; tap < 8; tap++) { await options.tap(); await page.waitForTimeout(60); if (await options.getAttribute('aria-expanded') !== String(tap % 2 === 0)) throw Error(`Menu reopened or failed after tap ${tap} in ${file}`); }
      await options.tap();
      const select = page.getByRole('combobox', { name: 'Task update interval', exact: true });
      await select.waitFor();
      {
        for (let tap = 0; tap < 6; tap++) { await select.tap(); await page.waitForTimeout(50); if (await select.getAttribute('aria-expanded') !== String(tap % 2 === 0)) throw Error(`Nested select toggled twice after tap ${tap}`); }
        if (await options.getAttribute('aria-expanded') !== 'true') throw Error('Nested dropdown dismissed its parent options');
      }
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
      const chrome = await task.getByRole('button', { name: 'Performance', exact: true }).evaluate(element => ({ selection: getComputedStyle(element).userSelect, touch: getComputedStyle(element).touchAction }));
      if (chrome.selection !== 'none' || !chrome.touch.includes('manipulation')) throw Error('Touch chrome allows selection or double-tap zoom');
      await page.setViewportSize({ width: 844, height: 390 });
      await page.setViewportSize({ width: 320, height: 568 });
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw Error('Small/rotated screen overflows');
      await page.setViewportSize({ width: 390, height: 844 });
      if (process.env.EYA_TEST_OUTPUT) await page.screenshot({ path: path.join(process.env.EYA_TEST_OUTPUT, `mobile-performance-${file}.png`) });
      await page.evaluate(id => { EyaPanels.close(id); document.getElementById('end-session').click(); }, id);
      await page.close();
    }
    if (errors.length) throw Error(errors.join('; '));
    console.log('Real touch performance scrolling, unstretched graphs, repeated/nested menu taps, mobile chrome gestures, rotation, and HTML/SVG passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
