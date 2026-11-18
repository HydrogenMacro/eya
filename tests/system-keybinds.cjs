const assert=require('node:assert/strict');
const {buildSync}=require('esbuild');
const {chromium}=require('playwright');
(async()=>{
 const code=buildSync({stdin:{contents:"export * from './client/keybinds-core.js';export * from './client/system-panels.js';",resolveDir:process.cwd()},bundle:true,platform:'browser',format:'iife',globalName:'SystemKeys',write:false}).outputFiles[0].text;
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.goto('about:blank');await page.addScriptTag({content:code});
  await page.evaluate(()=>{window.task=SystemKeys.createTaskManager({request:async()=>({})});window.docker=SystemKeys.createDockerPanel({request:async()=>({})});document.body.append(task.element,docker.element);task.element.tabIndex=0;docker.element.tabIndex=0;});
  await page.evaluate(()=>task.api.setView('performance'));await page.locator('.task-manager-v2').focus();await page.keyboard.press('Control+f');
  assert.equal(await page.getByRole('searchbox',{name:'Find process',exact:true}).evaluate(input=>input===document.activeElement),true);assert.equal(await page.evaluate(()=>task.api.getState().view),'processes');
  await page.locator('.docker-panel').focus();await page.keyboard.press('Control+f');assert.equal(await page.getByRole('searchbox',{name:'Find Docker item',exact:true}).evaluate(input=>input===document.activeElement),true);
  await page.evaluate(()=>SystemKeys.setKeybinds({'task.search':['Alt+p'],'docker.search':['Alt+d']}));
  await page.locator('.task-manager-v2').focus();await page.keyboard.press('Control+f');assert.equal(await page.getByRole('searchbox',{name:'Find process',exact:true}).evaluate(input=>input===document.activeElement),false);
  await page.keyboard.press('Alt+p');assert.equal(await page.getByRole('searchbox',{name:'Find process',exact:true}).evaluate(input=>input===document.activeElement),true);
  await page.locator('.docker-panel').focus();await page.keyboard.press('Alt+d');assert.equal(await page.getByRole('searchbox',{name:'Find Docker item',exact:true}).evaluate(input=>input===document.activeElement),true);
  await page.evaluate(()=>{task.onClose();docker.onClose();});console.log('Task Manager and Docker scoped Find defaults, live rebindings, and performance-to-process search passed.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
