const assert = require('node:assert/strict');
const fs = require('node:fs');
const { build } = require('../client/node_modules/esbuild');
const { chromium } = require('../client/node_modules/playwright');

(async () => {
  const bundle = await build({ stdin: { contents: "export {DockSidebar, TabDock, dockEdge} from './client/docking.js'; export {PanelWorkbench} from './client/panels.js';", resolveDir: process.cwd() }, bundle: true, format: 'iife', globalName: 'DockTest', write: false });
  const templateStyle = fs.readFileSync('client/template.html', 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1];
  const css = fs.readFileSync('client/docking.css', 'utf8') + fs.readFileSync('client/mobile-workspace.css', 'utf8');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    await page.setContent(`<style>${templateStyle}\n${css}</style><div id="fixture" style="display:flex;width:1100px;height:650px"></div>`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      const content = document.createElement('div'); content.textContent = 'Model';
      globalThis.changes = [];
      globalThis.sidebar = new DockTest.DockSidebar(document.querySelector('#fixture'), { content, tabs: ['sections', 'parts', 'selection'].map(id => { const element = document.createElement('div'); element.textContent = `${id} body`; element.dataset.body = id; return { id, title: id, element }; }), onChange: snapshot => changes.push(snapshot) });
    });
    assert.equal(await page.locator('[data-body=sections]').isVisible(), true);
    await page.getByRole('tab', { name: 'parts', exact: true }).click();
    assert.equal(await page.locator('[data-body=parts]').isVisible(), true);
    assert.equal(await page.locator('[data-body=sections]').isVisible(), false);
    await page.getByRole('button', { name: 'Divide sidebar', exact: true }).click();
    assert.equal(await page.locator('.dock-group').count(), 2);
    assert.equal(await page.locator('.dock-split').getAttribute('data-axis'), 'vertical');
    const separator = page.getByRole('separator', { name: 'Resize tabs', exact: true });
    await separator.focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await separator.getAttribute('aria-valuenow'), '55');
    await page.evaluate(() => sidebar.setSide('bottom'));
    assert.equal(await page.locator('.dock-split').getAttribute('data-axis'), 'horizontal');
    const fixture = await page.locator('#fixture').boundingBox();
    const resize = page.getByRole('separator', { name: 'Resize sidebar', exact: true });
    const oldSize = await page.evaluate(() => sidebar.size);
    await resize.focus(); await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => sidebar.size), oldSize + 16);
    const snapshot = await page.evaluate(() => sidebar.snapshot());
    assert.equal(snapshot.side, 'bottom'); assert.equal(snapshot.layout.ratio, 0.55);
    await page.evaluate(saved => {
      sidebar.destroy(); const fixture = document.querySelector('#fixture'); fixture.replaceChildren();
      const content = document.createElement('div'); content.textContent = 'Restored';
      globalThis.sidebar = new DockTest.DockSidebar(fixture, { content, ...saved, tabs: ['sections', 'parts', 'selection'].map(id => { const element = document.createElement('div'); element.textContent = id; element.dataset.body = id; return { id, title: id, element }; }) });
    }, snapshot);
    assert.equal(await page.locator('.dock-group').count(), 2);
    assert.deepEqual(await page.evaluate(() => sidebar.snapshot()), snapshot);
    // Every part of a group accepts tab insertion; splitting stays explicit.
    const source = page.getByRole('tab', { name: 'selection', exact: true });
    const target = page.locator('.dock-group').filter({ has: page.getByRole('tab', { name: 'parts', exact: true }) });
    const targetRect = await target.boundingBox();
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await source.dispatchEvent('dragstart', { dataTransfer: transfer });
    await target.dispatchEvent('dragover', { dataTransfer: transfer, clientX: targetRect.x + 2, clientY: targetRect.y + targetRect.height / 2 });
    assert.equal(await page.locator('.dock-drop-preview:not([hidden])').count(), 0);
    assert.equal(await page.locator('.dock-tab-insertion:not([hidden])').count(), 1);
    await target.dispatchEvent('drop', { dataTransfer: transfer, clientX: targetRect.x + 2, clientY: targetRect.y + targetRect.height / 2 });
    assert.equal(await page.locator('.dock-group').count(), 2);
    assert.equal(await page.evaluate(()=>sidebar.dock.groupOf('parts')===sidebar.dock.groupOf('selection')),true);
    assert.equal(await page.locator('.dock-drop-preview:not([hidden])').count(), 0);
    // Main workspace uses the same edge controller without changing tab moves.
    await page.evaluate(() => {
      sidebar.destroy(); const root = document.querySelector('#fixture'); root.replaceChildren(); root.id = 'workspace';
      globalThis.workbench = new DockTest.PanelWorkbench(root);
      for (const id of ['one', 'two', 'three']) { const element = document.createElement('div'); element.textContent = id; workbench.register({ id, title: id, element }); workbench.open(id); }
    });
    const mainSource = page.locator('[data-panel=two]');
    const group = page.locator('.panel-group'); const box = await group.boundingBox();
    await mainSource.dispatchEvent('dragstart', { dataTransfer: transfer });
    await group.dispatchEvent('dragover', { dataTransfer: transfer, clientX: box.x + 2, clientY: box.y + box.height / 2 });
    assert.equal(await page.locator('.dock-drop-preview:not([hidden])').count(),0);
    assert.equal(await page.locator('.dock-tab-insertion:not([hidden])').count(),1);
    await group.dispatchEvent('drop', { dataTransfer: transfer, clientX: box.x + 2, clientY: box.y + box.height / 2 });
    assert.equal(await page.locator('.panel-group').count(), 1);
    assert.deepEqual(await page.evaluate(()=>workbench.snapshot()[0].panels),['two','one','three']);
    await page.evaluate(()=>workbench.split('two','vertical'));
    assert.equal(await page.locator('.panel-group').count(),2);
    await page.evaluate(() => { workbench.activate('three'); });
    const third = page.locator('[data-panel=three]'); const destination = page.locator('[data-panel=two]');
    await third.dragTo(destination);
    assert.equal(await page.evaluate(() => workbench.groupOf('two') === workbench.groupOf('three')), true);
    assert.ok(fixture.width > 0);
    const touchContext=await browser.newContext({viewport:{width:1200,height:850},hasTouch:true}),touchPage=await touchContext.newPage();
    await touchPage.setContent(`<style>${templateStyle}\n${css}</style><div id="workspace" style="display:flex;width:1100px;height:650px"></div>`);
    await touchPage.addScriptTag({content:bundle.outputFiles[0].text});
    await touchPage.evaluate(()=>{
      window.workbench=new DockTest.PanelWorkbench(document.querySelector('#workspace'));
      for(const id of ['one','two','three']){const element=document.createElement('div');element.textContent=id;workbench.register({id,title:id,element});workbench.open(id);}
    });
    const cdp=await touchContext.newCDPSession(touchPage),touch=async(type,x,y)=>{await cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{x,y}]});if(type==='touchStart')await touchPage.waitForTimeout(500);};
    const from=await touchPage.locator('[data-panel=two]').boundingBox(),to=await touchPage.locator('.panel-group').boundingBox();
    await touch('touchStart',from.x+from.width/2,from.y+from.height/2);await touch('touchMove',to.x+3,to.y+to.height/2);
    assert.equal(await touchPage.locator('.dock-drop-preview:not([hidden])').count(),0);
    await touch('touchEnd');assert.equal(await touchPage.locator('.panel-group').count(),1);assert.equal(await touchPage.evaluate(()=>workbench.groupOf('one')===workbench.groupOf('two')),true);
    assert.deepEqual(await touchPage.evaluate(()=>[...workbench.groups.values()][0].panels),['two','one','three']);
    const reorderFrom=await touchPage.locator('[data-panel=two]').boundingBox(),reorderTo=await touchPage.locator('[data-panel=one]').boundingBox();
    await touch('touchStart',reorderFrom.x+reorderFrom.width/2,reorderFrom.y+reorderFrom.height/2);await touch('touchMove',reorderTo.x+5,reorderTo.y+reorderTo.height/2);await touch('touchEnd');
    assert.deepEqual(await touchPage.evaluate(()=>[...workbench.groups.values()][0].panels),['two','one','three']);
    const cancelFrom=await touchPage.locator('[data-panel=three]').boundingBox(),cancelTo=await touchPage.locator('[data-panel=one]').boundingBox();
    await touch('touchStart',cancelFrom.x+cancelFrom.width/2,cancelFrom.y+cancelFrom.height/2);await touch('touchMove',cancelTo.x+cancelTo.width/2,cancelTo.y+cancelTo.height/2);await touch('touchCancel');
    assert.deepEqual(await touchPage.evaluate(()=>[...workbench.groups.values()][0].panels),['two','one','three']);assert.equal(await touchPage.locator('.dock-drop-preview:not([hidden])').count(),0);
    // Narrow layouts also suppress splits from native drag-and-drop.
    await touchPage.setViewportSize({width:390,height:844});const narrow=await touchPage.locator('.panel-group').boundingBox(),nativeTransfer=await touchPage.evaluateHandle(()=>new DataTransfer());
    await touchPage.locator('[data-panel=three]').dispatchEvent('dragstart',{dataTransfer:nativeTransfer});
    await touchPage.locator('.panel-group').dispatchEvent('dragover',{dataTransfer:nativeTransfer,clientX:narrow.x+2,clientY:narrow.y+narrow.height/2});assert.equal(await touchPage.locator('.dock-drop-preview:not([hidden])').count(),0);
    await touchPage.locator('.panel-group').dispatchEvent('drop',{dataTransfer:nativeTransfer,clientX:narrow.x+2,clientY:narrow.y+narrow.height/2});assert.equal(await touchPage.locator('.panel-group').count(),1);await touchContext.close();
    console.log('Docking tests passed: tabs, explicit split/resize, side/restore, full-panel insertion and touch tab moves');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
