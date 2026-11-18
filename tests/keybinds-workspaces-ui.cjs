const assert = require('node:assert/strict');
const {buildSync}=require('esbuild');
const {chromium}=require('playwright');
(async()=>{
 const source=buildSync({stdin:{contents:"export * from './client/keybinds.js';export * from './client/workspaces.js';export * from './client/image-viewer.js';",resolveDir:process.cwd()},bundle:true,platform:'browser',format:'iife',globalName:'UI',write:false}).outputFiles[0].text;
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('about:blank');await page.addStyleTag({content:'.ui-menu[hidden]{display:none}.ui-icon{width:18px;height:18px}.icon-button{width:32px;height:32px}.sr-only{position:absolute;width:1px;height:1px;clip:rect(0,0,0,0)}dialog{background:#17232c;color:#e4edf0}button{cursor:pointer}'});await page.addScriptTag({content:source});
  await page.evaluate(()=>{window.changes=[];window.shortcuts=UI.createKeybindSettings({onChange:value=>changes.push(value)});shortcuts.open('Browser');});
  await page.getByRole('button',{name:'Video',exact:true}).click();
  assert.equal(await page.locator('[data-action="video.play"]').count(),1);
  await page.getByRole('searchbox',{name:'Search shortcuts'}).fill('Refresh directory');
  assert.equal(await page.locator('[data-action="files.refresh"]').count(),1,'Search reaches other categories');
  await page.getByRole('searchbox',{name:'Search shortcuts'}).fill('Ctrl/Cmd+Shift+p');
  assert.equal(await page.locator('[data-action="global.launcher"]').count(),1,'Search matches displayed shortcuts');
  await page.getByRole('searchbox',{name:'Search shortcuts'}).fill('Play or pause');
  await page.getByRole('button',{name:'Change Play or pause shortcut',exact:true}).click();await page.keyboard.press('Alt+j');
  assert.deepEqual(await page.evaluate(()=>UI.getKeybinds()['video.play']),['Alt+j']);
  assert.ok((await page.evaluate(()=>changes)).length);
  await page.getByRole('button',{name:'Clear Play or pause shortcut',exact:true}).click();assert.deepEqual(await page.evaluate(()=>UI.getKeybinds()['video.play']),[]);
  await page.getByRole('button',{name:'Reset Play or pause shortcut',exact:true}).click();assert.equal(await page.evaluate(()=>Object.hasOwn(UI.getKeybinds(),'video.play')),false);
  await page.getByRole('searchbox',{name:'Search shortcuts'}).fill('Focus address');
  await page.getByRole('button',{name:'Change Focus address shortcut',exact:true}).click();await page.keyboard.press('Control+t');
  assert.match(await page.locator('.keybinds-status').textContent(),/New browser tab/,'Conflicting assignment is rejected');
  assert.equal(await page.evaluate(()=>Object.hasOwn(UI.getKeybinds(),'browser.address')),false);
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'Close keyboard shortcuts',exact:true}).click();
  await page.evaluate(()=>{
   const image=new Image();image.src='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100"/></svg>';
   const host=document.createElement('div');host.id='image-test';host.style.cssText='width:400px;height:300px';host.append(image);document.body.append(host);window.image=image;window.viewer=UI.createImageViewer(host,image);
   UI.setKeybinds({'image.zoomIn':['Alt+i']});host.focus();
  });
  const before=await page.evaluate(()=>image.style.transform);await page.keyboard.press('=');assert.equal(await page.evaluate(()=>image.style.transform),before,'Default stops working after rebind');
  await page.keyboard.press('Alt+i');assert.notEqual(await page.evaluate(()=>image.style.transform),before,'Configured shortcut drives the real image viewer');
  await page.evaluate(()=>{
   const root=document.createElement('div');document.body.append(root);
   const records=[{id:'one',name:'Alpha',revision:1,tabs:[],layout:null,preferences:{}},{id:'two',name:'Beta',revision:1,tabs:[],layout:null,preferences:{}}];
   const bench={root,panels:new Map(),serialize:()=>({tabs:[],layout:null}),clear(){},restoreMinimized(){},restoreLayout(){}};
   window.workspaces=UI.createWorkspaces({workbench:bench,isReady:()=>true,restoreTab(){},request:async(op,args)=>op==='workspace.list'?{workspaces:records}:op==='session.list'?{sessions:[]}:op==='workspace.load'?{workspace:records.find(item=>item.id===args.workspace)}:{}});
   document.body.prepend(workspaces.label,workspaces.sync);window.initialize=workspaces.authenticated({workspace:records[0]});
  });await page.evaluate(()=>initialize);
  await page.locator('#workspaces').click();assert.equal(await page.locator('#workspaces-dialog').isVisible(),false,'Workspace trigger opens a dropdown');
  assert.equal(await page.getByRole('menuitem',{name:'Alpha',exact:true}).getAttribute('aria-current'),'true');
  await page.getByRole('menuitem',{name:'Beta',exact:true}).click();assert.equal(await page.evaluate(()=>workspaces.getState().workspace.id),'two','Quick switch opens selected workspace');
  await page.locator('#workspaces').click();await page.getByRole('menuitem',{name:'Manage workspaces',exact:true}).click();
  const modal=page.locator('#workspaces-dialog');await modal.waitFor();await modal.locator('[data-workspace-id]').first().waitFor();
  for(const label of ['Open','Rename','Save as','Delete'])assert.equal(await modal.getByRole('button',{name:label,exact:true}).first().locator('svg').count(),1,`${label} is an icon action`);
  assert.equal((await modal.locator('.workspace-move-hint').textContent()).trim(),'','No persistent move instructions');
  await page.setViewportSize({width:375,height:700});assert.ok(await modal.evaluate(node=>node.getBoundingClientRect().right<=innerWidth));
  await modal.getByRole('button',{name:'Close workspaces',exact:true}).click();
  await page.evaluate(()=>{shortcuts.open('Global');});assert.ok(await page.locator('#keybinds-dialog').evaluate(node=>node.getBoundingClientRect().right<=innerWidth));
  assert.deepEqual(errors,[]);console.log('Keybind modal categories/search/recording/conflicts/reset, live image rebinding, workspace quick menu/manager icons and narrow layout passed.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
