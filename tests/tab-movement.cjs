const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { build } = require('esbuild');
const { chromium } = require('playwright');

(async () => {
  const bundle = await build({ stdin: { contents: "export {PanelWorkbench} from './panels.js';export {TabDock,EdgeDockController} from './docking.js';", resolveDir: path.resolve('client') }, bundle: true, format: 'iife', globalName: 'Tabs', write: false });
  const template = await fs.readFile('client/template.html', 'utf8');
  const css = template.match(/<style>([\s\S]*?)<\/style>/)[1] + (await Promise.all(['components', 'docking', 'mobile-workspace'].map(name => fs.readFile(`client/${name}.css`, 'utf8')))).join('\n');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 850 } });
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`<style>${css}</style><div id="workspace" style="display:flex;width:1120px;height:740px"></div>`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    assert.deepEqual(await page.evaluate(()=>{
      const root=document.getElementById('workspace'),transfer=new DataTransfer();
      const controller=new Tabs.EdgeDockController(root,{getItem:()=>'',onDrop(){},resolveTarget(event){event.preventDefault();return{target:event.target===root,type:event.type,ctrlKey:event.ctrlKey,transfer:event.dataTransfer===transfer};}});
      const event=new DragEvent('dragover',{clientX:20,clientY:80,ctrlKey:true,dataTransfer:transfer,cancelable:true});
      const result=controller.targetAt(event);controller.destroy();return{...result,prevented:event.defaultPrevented};
    }),{target:true,type:'dragover',ctrlKey:true,transfer:true,prevented:true},'geometric targeting preserves the resolver Event API');
    await page.evaluate(() => {
      window.workbench = new Tabs.PanelWorkbench(document.querySelector('#workspace'));
      for (const id of ['source', 'b', 'c', 'd']) {
        const element = document.createElement('div'); element.textContent = `${id} content`;
        workbench.register({ id, title: id, element }); workbench.open(id);
      }
      window.rightId = workbench.split('b', 'vertical');
      workbench.move('c', rightId); workbench.move('d', rightId);
      for (const [id, width] of [['source',160],['b',80],['c',140],['d',100]]) {
        const tab = document.querySelector(`[data-panel="${id}"]`); tab.style.width = `${width}px`; tab.style.maxWidth = 'none';
      }
    });
    const transfer = await page.evaluateHandle(() => {
      const transfer=new DataTransfer(),set=transfer.setDragImage.bind(transfer);
      transfer.setDragImage=(node,x,y)=>{window.dragImageInfo={opacity:getComputedStyle(node).opacity,x,y};set(node,x,y);};return transfer;
    });
    const source = page.locator('[data-panel=source]'), destination = page.locator('.panel-group').filter({ has: page.locator('[data-panel=b]') });
    const sourceBox = await source.boundingBox(), targetBox = await destination.boundingBox(), cBox = await page.locator('[data-panel=c]').boundingBox();
    const pointerX = cBox.x - 50; // Pointer and dragged center fall in different slots.
    await source.dispatchEvent('pointerdown', { pointerType: 'mouse', button: 0, clientX: sourceBox.x + 12, clientY: sourceBox.y + 10 });
    await source.dispatchEvent('dragstart', { dataTransfer: transfer, clientX: sourceBox.x + 12, clientY: sourceBox.y + 10 });
    assert.equal(await source.evaluate(node => getComputedStyle(node).opacity), '0.3');
    assert.deepEqual(await page.evaluate(()=>dragImageInfo),{opacity:'0.45',x:12,y:10},'native drag image is translucent and preserves the grab point');
    for (const y of [targetBox.y + 15, targetBox.y + targetBox.height / 2, targetBox.y + targetBox.height - 4]) {
      // Deliberately dispatch on the source: the coordinates choose the panel.
      await source.dispatchEvent('dragover', { dataTransfer: transfer, clientX: pointerX, clientY: y });
      const marker = await page.locator('.dock-tab-insertion:not([hidden])').boundingBox();
      assert(Math.abs(marker.x + 1 - cBox.x) <= 1, 'dragged center snaps to the nearest gap at every panel height');
      assert.equal(await page.locator('.dock-drop-preview:not([hidden])').count(), 0);
    }
    // A wide ghost crossing a boundary never chooses the panel instead of the pointer.
    const leftBox = await source.locator('xpath=ancestor::*[contains(@class,"panel-group")][1]').boundingBox();
    await source.dispatchEvent('dragover', { dataTransfer: transfer, clientX: leftBox.x + leftBox.width - 3, clientY: leftBox.y + 200 });
    const leftMarker = await page.locator('.dock-tab-insertion:not([hidden])').boundingBox();
    assert(leftMarker.x < targetBox.x, 'pointer picks the group even when the dragged center crosses into another');
    await destination.dispatchEvent('drop', { dataTransfer: transfer, clientX: pointerX, clientY: targetBox.y + targetBox.height - 4 });
    assert.deepEqual(await page.evaluate(() => workbench.groups.get(workbench.groupOf('b')).panels), ['b', 'source', 'c', 'd']);
    assert.equal(await page.locator('.dock-tab-dragging,.dock-tab-insertion:not([hidden]),.dock-tab-ghost').count(), 0, 'native drop clears feedback');
    // Dropping outside the workbench leaves the order unchanged.
    const b = page.locator('[data-panel=b]');
    await b.dispatchEvent('dragstart', { dataTransfer: transfer });
    await b.dispatchEvent('dragover', { dataTransfer: transfer, clientX: 1190, clientY: 830 });
    assert.equal(await page.locator('.dock-tab-insertion:not([hidden])').count(), 0);
    await b.dispatchEvent('drop', { dataTransfer: transfer, clientX: 1190, clientY: 830 });
    await b.dispatchEvent('dragend', { dataTransfer: transfer });
    assert.deepEqual(await page.evaluate(() => workbench.groups.get(workbench.groupOf('b')).panels), ['b', 'source', 'c', 'd']);
    // Native drags also reach off-screen tabs while the pointer is in content.
    await page.evaluate(()=>{
      const root=document.createElement('div');root.id='scroll-dock';root.style.cssText='position:absolute;left:20px;top:100px;display:flex;width:320px;height:400px;z-index:5';document.body.append(root);
      window.scrollDock=new Tabs.TabDock(root,{tabs:Array.from({length:8},(_,n)=>({id:`scroll-${n}`,title:`Tab ${n}`,element:document.createElement('div')}))});
      root.querySelectorAll('[data-dock-tab]').forEach(tab=>tab.style.width='100px');
    });
    const scrollSource=page.locator('[data-dock-tab=scroll-0]'),scrollGroup=page.locator('#scroll-dock .dock-group'),scrollBox=await scrollGroup.boundingBox();
    await scrollSource.dispatchEvent('dragstart',{dataTransfer:transfer});
    await scrollGroup.dispatchEvent('dragover',{dataTransfer:transfer,clientX:scrollBox.x+scrollBox.width-12,clientY:scrollBox.y+300});
    await page.waitForFunction(()=>document.querySelector('#scroll-dock .dock-tabs').scrollLeft>50);
    await scrollSource.dispatchEvent('dragend',{dataTransfer:transfer});
    const stopped=await page.locator('#scroll-dock .dock-tabs').evaluate(node=>node.scrollLeft);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#scroll-dock .dock-tabs').evaluate(node=>node.scrollLeft),stopped,'cancel stops native auto-scroll');
    await page.evaluate(()=>{scrollDock.destroy();document.getElementById('scroll-dock').remove();});
    // Touch dragging uses exactly the same grab offset and target geometry.
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const touchPage = await mobile.newPage(); touchPage.on('pageerror', error => errors.push(error.message));
    await touchPage.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="dock" style="display:flex;height:740px;width:390px"></div>`);
    await touchPage.addScriptTag({ content: bundle.outputFiles[0].text });
    await touchPage.evaluate(() => {
      window.dock = new Tabs.TabDock(document.getElementById('dock'), { tabs: ['a','b','c'].map(id => ({ id, title: id, element: document.createElement('div') })) });
      for (const id of ['a','b','c']) document.querySelector(`[data-dock-tab="${id}"]`).style.width = '100px';
    });
    const cdp = await mobile.newCDPSession(touchPage);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: ['touchEnd','touchCancel'].includes(type) ? [] : [{ x, y }] });
    const a = await touchPage.locator('[data-dock-tab=a]').boundingBox(), c = await touchPage.locator('[data-dock-tab=c]').boundingBox();
    await touch('touchStart', a.x + 8, a.y + 12); await touchPage.waitForTimeout(520);
    const ghost = touchPage.locator('.dock-tab-ghost'); assert.equal(await ghost.evaluate(node => getComputedStyle(node).opacity), '0.45');
    await touch('touchMove', c.x - 25, 500);
    const marker = await touchPage.locator('.dock-tab-insertion:not([hidden])').boundingBox(), ghostBox = await ghost.boundingBox();
    assert(Math.abs(marker.x + 1 - c.x) <= 1, 'touch center determines the gap far below the strip');
    assert(Math.abs(ghostBox.x - (c.x - 25 - 8)) <= 1, 'ghost preserves the grab point');
    assert(Number(await touchPage.locator('.dock-tab-insertion').evaluate(node => getComputedStyle(node).zIndex)) > Number(await ghost.evaluate(node => getComputedStyle(node).zIndex)), 'marker is visible over the translucent ghost');
    await touch('touchEnd'); assert.deepEqual(await touchPage.evaluate(() => dock.snapshot().tabs), ['b','a','c']);
    assert.equal(await touchPage.locator('.dock-tab-dragging,.dock-tab-ghost,.dock-tab-insertion:not([hidden])').count(), 0);
    await mobile.close(); await context.close(); assert.deepEqual(errors, []);
    console.log('Tab movement: center-based gap snapping, full-panel height/edges, pointer-owned destination, off-center mouse/touch grabs, translucent feedback, matching drops and cleanup passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
