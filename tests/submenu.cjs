const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {build} = require('esbuild');
const {chromium} = require('playwright');
(async()=>{
 const bundle=await build({stdin:{contents:"export {createMenu,menuAction,startControlEnhancement} from './client/ui.js';export {createSubmenu} from './client/submenu.js';export {createFileBrowser} from './client/file-browser.js';",resolveDir:process.cwd()},bundle:true,format:'iife',globalName:'TestUI',write:false});
 const template=await fs.readFile('client/template.html','utf8'),css=template.match(/<style>([\s\S]*?)<\/style>/)[1]+await fs.readFile('client/components.css','utf8');
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try{
  for(const fallback of [false,true]){
   const page=await browser.newPage({viewport:{width:900,height:650}});await page.setContent(`<style>${css}.fixture{position:fixed;right:8px;top:40px;width:80px;height:50px;overflow:hidden}</style><div class=fixture></div>`);await page.addScriptTag({content:bundle.outputFiles[0].text});
   await page.evaluate(fallback=>{
    if(fallback)HTMLElement.prototype.showPopover=undefined;
    window.chosen=[];window.parentMenu=TestUI.createMenu('File actions');document.querySelector('.fixture').append(parentMenu.element);
    const button=document.createElement('button');button.type='button';button.textContent='Open With…';TestUI.menuAction(parentMenu.panel,button,'File');
    window.submenu=TestUI.createSubmenu({parent:parentMenu.panel,trigger:button,label:'Open example.svg with',items:[{id:'image',title:'Image viewer',action:()=>chosen.push('image')},{id:'text',title:'Text editor',action:()=>chosen.push('text')},{id:'binary',title:'Binary viewer',action:()=>chosen.push('binary')}],onChoose:()=>parentMenu.close()});
    window.enhancement=TestUI.startControlEnhancement();
   },fallback);
   await page.getByRole('button',{name:'File actions',exact:true}).click();await page.getByRole('menuitem',{name:'Open With…',exact:true}).hover();
   const submenu=page.getByRole('menu',{name:'Open example.svg with',exact:true});await submenu.waitFor();assert.equal(await submenu.getAttribute('data-side'),'left');
   assert.equal(await page.locator('.file-open-with select').count(),0);
   const b=await submenu.boundingBox();assert.ok(b.x>=0&&b.x+b.width<=900&&b.y+b.height<=650);
   await page.getByRole('menuitem',{name:'Text editor',exact:true}).hover();await page.waitForTimeout(250);assert.equal(await page.getByRole('menu',{name:'File actions',exact:true}).isVisible(),true,'Parent remains open while interacting with submenu');
   await page.getByRole('menuitem',{name:'Text editor',exact:true}).click();assert.deepEqual(await page.evaluate(()=>chosen),['text']);assert.equal(await submenu.isVisible(),false);
   await page.getByRole('button',{name:'File actions',exact:true}).focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowRight');assert.equal(await page.getByRole('menuitem',{name:'Image viewer',exact:true}).evaluate(el=>el===document.activeElement),true);
   await page.keyboard.press('ArrowDown');assert.equal(await page.getByRole('menuitem',{name:'Text editor',exact:true}).evaluate(el=>el===document.activeElement),true);
   await page.keyboard.press('End');assert.equal(await page.getByRole('menuitem',{name:'Binary viewer',exact:true}).evaluate(el=>el===document.activeElement),true);
   await page.keyboard.press('ArrowLeft');assert.equal(await submenu.isVisible(),false);assert.equal(await page.getByRole('menuitem',{name:'Open With…',exact:true}).evaluate(el=>el===document.activeElement),true);
   await page.keyboard.press('ArrowRight');await page.keyboard.press('Escape');assert.equal(await submenu.isVisible(),false);assert.equal(await page.getByRole('menu',{name:'File actions',exact:true}).isVisible(),true);
   await page.keyboard.press('Escape');assert.equal(await page.getByRole('menu',{name:'File actions',exact:true}).isVisible(),false);
   await page.setViewportSize({width:320,height:480});await page.getByRole('button',{name:'File actions',exact:true}).click();await page.getByRole('menuitem',{name:'Open With…',exact:true}).click();const mobile=await submenu.boundingBox();assert.ok(mobile.x>=0&&mobile.x+mobile.width<=320&&mobile.y>=0&&mobile.y+mobile.height<=480);
   await page.locator('body').click({position:{x:5,y:450}});assert.equal(await submenu.isVisible(),false);
   await page.evaluate(()=>{submenu.destroy();parentMenu.destroy();enhancement.stop?.();});await page.close();
  }
  const touch=await browser.newPage({viewport:{width:320,height:600},hasTouch:true,isMobile:true});
  await touch.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}.fixture{position:fixed;right:8px;top:40px}</style><div class=fixture></div>`);await touch.addScriptTag({content:bundle.outputFiles[0].text});
  await touch.evaluate(()=>{window.picked=[];const menu=TestUI.createMenu('Touch file actions');document.querySelector('.fixture').append(menu.element);const trigger=document.createElement('button');trigger.textContent='Open With…';TestUI.menuAction(menu.panel,trigger,'File');TestUI.createSubmenu({parent:menu.panel,trigger,label:'Touch open with',items:[{id:'text',title:'Text editor',action:()=>picked.push('text')}],onChoose:()=>menu.close()});});
  await touch.getByRole('button',{name:'Touch file actions',exact:true}).tap();await touch.getByRole('menuitem',{name:'Open With…',exact:true}).tap();await touch.waitForTimeout(300);
  const touchMenu=touch.getByRole('menu',{name:'Touch open with',exact:true});assert.equal(await touchMenu.isVisible(),true,'Touch release keeps the submenu open for the next tap');
  await touchMenu.getByRole('menuitem',{name:'Text editor',exact:true}).tap();assert.deepEqual(await touch.evaluate(()=>picked),['text']);await touch.close();
  console.log('Submenus: native/fallback clipping escape, hover/click selection, parent lifetime, keyboard navigation mobile edge clamp and touch tap lifetime passed');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
