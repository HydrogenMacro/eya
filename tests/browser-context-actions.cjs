const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {buildSync}=require('esbuild');
(async()=>{
 const code=buildSync({entryPoints:['client/browser-panel.js'],bundle:true,platform:'browser',format:'iife',globalName:'EyaBrowser',write:false}).outputFiles[0].text;
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1000,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('about:blank');await page.addScriptTag({content:code});
  await page.evaluate(()=>{
   window.inputs=[];window.images=[];window.resizes=[];window.ackTimes=[];
   window.panel=EyaBrowser.createBrowserPanel({request:async()=>{},openRemoteBrowser:async handlers=>{
    window.handlers=handlers;
    return {ready:true,start(){},privacy(){},resize(...args){resizes.push(args)},activateTab:async()=>({}),navigate(url,id){window.tabId=id},input(value){inputs.push(value)},downloadImage(...args){images.push(args)},evaluate:async(id,expression)=>{window.lastExpression=expression;return {result:JSON.stringify({allowed:false,href:'https://example.test/link',image:true})}},ack(seq){ackTimes.push({seq,time:performance.now()})},close(){}};
   }});document.body.append(panel.element);panel.element.style.cssText='width:700px;height:600px';panel.api.navigate('https://example.test');
  });await page.waitForFunction(()=>window.tabId);
  const surface=page.locator('.eya-browser-text-surface');const bounds=await surface.boundingBox();const point={x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2};
  const context=async()=>{await page.mouse.click(point.x,point.y,{button:'right'});await page.getByRole('menuitem',{name:'Download image',exact:true}).waitFor();};
  await context();
  assert.equal(await page.evaluate(()=>inputs.filter(i=>i.action==='mousePressed'||i.action==='mouseReleased').length),0,'Right press/release never reaches the page');
  assert.equal(await page.getByRole('menuitem',{name:'Copy',exact:true}).locator('svg').count(),1);
  await page.mouse.click(point.x+50,point.y+80);await page.getByRole('menuitem',{name:'Download image',exact:true}).waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>inputs.filter(i=>i.action==='mousePressed'||i.action==='mouseReleased').length),0,'Dismissing menu consumes pointerdown/up and click');
  await page.mouse.click(point.x+50,point.y+80);assert.equal(await page.evaluate(()=>inputs.filter(i=>i.action==='mousePressed').length),1);
  await context();await page.getByRole('menuitem',{name:'Download image',exact:true}).click();assert.equal(await page.evaluate(()=>images.length),1);
  await context();await page.getByRole('menuitem',{name:'Select all text',exact:true}).click();assert.match(await page.evaluate(()=>lastExpression),/selectNodeContents/);
  await page.mouse.dblclick(point.x-80,point.y-80);assert.equal(await page.evaluate(()=>inputs.findLast(i=>i.action==='mousePressed').clickCount),2,'Double click selects remote words');
  await page.getByLabel('Browser options',{exact:true}).click();
  for(const label of ['Stream resolution','Stream encoding','JPEG quality','Frame rate limit'])await page.getByLabel(label,{exact:true}).waitFor();
  await page.getByLabel('Stream resolution',{exact:true}).selectOption('1280');await page.getByLabel('JPEG quality',{exact:true}).selectOption('60');
  assert.equal(await page.evaluate(()=>resizes.at(-1)[3].maxWidth),1280);assert.equal(await page.evaluate(()=>resizes.at(-1)[3].quality),60);
  assert.deepEqual(await page.evaluate(()=>panel.api.streamSettings),{format:'jpeg',quality:60,resolution:'1280',fps:60});
  for(const label of ['Zoom out','Zoom in','Reset zoom','Show page downloads','Save current page as PDF'])assert.equal(await page.getByRole('button',{name:label,exact:true}).locator('svg').count(),1);
  await page.evaluate(()=>{panel.element.style.height='280px';window.dispatchEvent(new Event('resize'));});
  assert.ok(await page.locator('.eya-browser-actions-panel').evaluate(el=>el.getBoundingClientRect().bottom<=document.querySelector('.eya-web-browser').getBoundingClientRect().bottom),'Stream options scroll within a short browser panel');
  await page.getByLabel('Frame rate limit',{exact:true}).selectOption('5');
  await page.evaluate(async()=>{const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;const blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg'));const bytes=new Uint8Array(await blob.arrayBuffer());window.frameSentAt=performance.now();handlers.onFrame(bytes,{seq:77,tabId,width:700,height:500});});
  await page.waitForFunction(()=>ackTimes.some(ack=>ack.seq===77));
  assert.ok(await page.evaluate(()=>ackTimes.find(ack=>ack.seq===77).time-frameSentAt>=170),'5 fps limit paces the frame acknowledgment after decode');
  await page.evaluate(()=>panel.onClose());assert.deepEqual(errors,[]);
  console.log('Browser context override, dismissal consumption, selection actions, image download, menu icons and stream controls passed.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
