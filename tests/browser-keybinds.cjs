const assert=require('node:assert/strict');
const {buildSync}=require('esbuild');
const {chromium}=require('playwright');
(async()=>{
 const code=buildSync({stdin:{contents:"export * from './client/browser-panel.js';export * from './client/keybinds-core.js';",resolveDir:process.cwd()},bundle:true,platform:'browser',format:'iife',globalName:'BrowserKeys',write:false}).outputFiles[0].text;
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:800}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://localhost/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'}));await page.goto('http://localhost/');await page.addScriptTag({content:code});
  await page.evaluate(()=>{
   window.globals=[];
   window.panel=BrowserKeys.createBrowserPanel({serverRenderedByDefault:false,onGlobalShortcut:id=>globals.push(id),request:async(url)=>({status:200,url,headers:[['content-type','text/html']],body:new TextEncoder().encode('<!doctype html><title>Keys</title><input id="field" value="selectable text"><p>Find this text</p><script>window.capturedPort=false;const portPost=MessagePort.prototype.postMessage;MessagePort.prototype.postMessage=function(...args){window.capturedPort=true;return portPost.apply(this,args)};const portHandler=Object.getOwnPropertyDescriptor(MessagePort.prototype,\"onmessage\");Object.defineProperty(MessagePort.prototype,\"onmessage\",{configurable:true,get(){window.capturedPort=true;return portHandler.get.call(this)},set(value){window.capturedPort=true;return portHandler.set.call(this,value)}});for(const name of [\"data\",\"ports\"]){const descriptor=Object.getOwnPropertyDescriptor(MessageEvent.prototype,name);Object.defineProperty(MessageEvent.prototype,name,{configurable:true,get(){if(this.currentTarget instanceof MessagePort)window.capturedPort=true;return descriptor.get.call(this)}})}<\/script>')})});
   document.body.append(panel.element);panel.element.style.cssText='width:900px;height:650px';return panel.api.navigate('https://example.test/');
  });
  const frame=page.frameLocator('.eya-browser-frame');await frame.locator('#field').waitFor();
  const focus=()=>frame.locator('#field').focus();
  await focus();await page.keyboard.press('Control+f');await page.getByLabel('Find in page',{exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(()=>BrowserKeys.setKeybinds({'browser.find':['Alt+g'],'global.settings':['Alt+o']}));
  await focus();await page.keyboard.press('Control+f');assert.equal(await page.getByLabel('Find in page',{exact:true}).isVisible(),false,'Old binding is disabled inside sandbox');
  await page.keyboard.press('Alt+g');await page.getByLabel('Find in page',{exact:true}).waitFor();await page.keyboard.press('Escape');
  await focus();await page.keyboard.press('Alt+o');await page.waitForFunction(()=>globals.length===1);assert.deepEqual(await page.evaluate(()=>globals),['global.settings']);
  await frame.locator('#field').evaluate(field=>field.dispatchEvent(new KeyboardEvent('keydown',{key:'o',altKey:true,bubbles:true,cancelable:true})));assert.equal(await page.evaluate(()=>globals.length),1,'Synthetic page events cannot trigger global actions');
  await frame.locator('#field').evaluate(field=>{Object.defineProperty(KeyboardEvent.prototype,'key',{configurable:true,get:()=> 'o'});Object.defineProperty(KeyboardEvent.prototype,'altKey',{configurable:true,get:()=>true});field.focus();});
  await page.keyboard.press('b');assert.equal(await page.evaluate(()=>globals.length),1,'Page prototype getters cannot forge a trusted shortcut');
  assert.equal(await frame.locator('#field').evaluate(()=>window.capturedPort),false,'Page prototype hooks cannot capture the private port');
  await page.evaluate(()=>BrowserKeys.setKeybinds({'browser.find':[]}));await focus();await page.keyboard.press('Alt+g');assert.equal(await page.getByLabel('Find in page',{exact:true}).isVisible(),false,'Unassignment is applied to an already loaded page');
  await page.evaluate(()=>panel.onClose());assert.deepEqual(errors,[]);console.log('Sandboxed browser live shortcut remapping, disabling, global relay, and synthetic-event isolation passed.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
