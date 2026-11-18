const assert=require('node:assert/strict');
const {build}=require('esbuild');
const {chromium}=require('playwright');
(async()=>{
 const source=await build({entryPoints:['client/server-settings.js'],bundle:true,format:'iife',globalName:'ServerSettings',write:false});
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage();await page.setContent('<body></body>');await page.addScriptTag({content:source.outputFiles[0].text});
  await page.evaluate(()=>{
   window.calls=[];window.caps=[];window.fail=false;
   const settings={terminalSessions:8,workspaceConnections:32,handshakeConnections:8,basicBrowserConnections:4,fullBrowserSessions:4,fullBrowserRuntimes:2,machineJobs:8};
   window.config={revision:1,settings,usage:Object.fromEntries(Object.keys(settings).map(key=>[key,0])),bounds:Object.fromEntries(Object.keys(settings).map(key=>[key,{min:1,max:64}])),scope:'process'};
   window.ui=ServerSettings.createServerSettings({capabilities:()=>caps,request:async(op,args)=>{calls.push({op,args});if(fail)throw Error('Connection interrupted.');if(op==='server.config.set'){Object.assign(config.settings,args.settings);config.revision++;}return structuredClone(config);}});document.body.append(ui.element);
  });
  await page.evaluate(()=>ui.refresh());assert.match(await page.getByRole('status').textContent(),/does not support/);assert.equal(await page.evaluate(()=>calls.length),0);
  await page.evaluate(()=>{caps=['server-config-v1'];return ui.refresh();});assert.equal(await page.getByLabel('Terminal sessions',{exact:true}).inputValue(),'8');
  await page.getByLabel('Terminal sessions',{exact:true}).fill('3');await page.getByRole('button',{name:'Apply',exact:true}).click();await page.getByRole('status').filter({hasText:'Applied.'}).waitFor();
  assert.deepEqual(await page.evaluate(()=>calls.at(-1)),{op:'server.config.set',args:{revision:1,settings:{terminalSessions:3}}});
  await page.evaluate(()=>{fail=true;});await page.getByLabel('Machine jobs',{exact:true}).fill('4');await page.getByRole('button',{name:'Apply',exact:true}).click();await page.getByRole('status').filter({hasText:'Refresh to check'}).waitFor();assert.equal(await page.evaluate(()=>calls.length),3,'Uncertain mutations are not replayed');
  await page.evaluate(()=>{fail=false;return ui.refresh();});assert.equal(await page.getByLabel('Machine jobs',{exact:true}).inputValue(),'8');
  await page.getByLabel('Terminal sessions',{exact:true}).fill('0');await page.getByRole('button',{name:'Apply',exact:true}).click();assert.equal(await page.evaluate(()=>calls.length),4,'Invalid quota is not sent');
  console.log('Server settings UI: unsupported server, load/apply, bounded inputs and uncertain-mutation refresh passed');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
