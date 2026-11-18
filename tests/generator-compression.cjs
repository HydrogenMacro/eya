const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {fixture,KEY} = require('./continuity-fixture.cjs');
(async()=>{
  const f=await fixture();
  try {
    const page=await f.client({connect:false});await page.goto(f.http);
    const template=await fs.readFile('client.html','utf8');
    const config={url:f.url,key:KEY,startupPanel:'none'};
    const html=template.replace('<script id="eya-config" type="application/json">{}</script>',()=>'<script id="eya-config" type="application/json">'+JSON.stringify(config)+'</script>');
    const artifacts=await page.evaluate(html=>Object.fromEntries(Object.entries(EyaGenerator).map(([name,fn])=>[name,fn(html)])),html);
    for(const [name,content]of Object.entries(artifacts)) {
      let url=content;
      if(name!=='dataUrl'){const filename=path.join(f.root,`compression-${name}.${name.toLowerCase().includes('svg')?'svg':'html'}`);await fs.writeFile(filename,content);url=pathToFileURL(filename).href;}
      const filename=path.join(f.files,'compression-newlines.py');await fs.writeFile(filename,'first = 1\nsecond = 2\n');
      await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});await page.locator('#url').waitFor();
      assert.equal(await page.locator('#url').evaluate(element=>element.value),config.url,name);assert.equal(await page.locator('#key').evaluate(element=>element.value),config.key,name);
      await page.waitForFunction(()=>window.EyaWorkspaces && (EyaWorkspaces.getState().workspace || document.querySelector('#dialog-error')?.textContent));
      if(name==='dataUrl' && !await page.evaluate(()=>!!EyaWorkspaces.getState().workspace)) {assert.match(await page.locator('#dialog-error').textContent(),/Cannot reach the server/);assert.equal(await page.locator('#start-connection').isEnabled(),true);console.log('dataUrl: config and runtime initialized; loopback WebSocket blocked by browser local-network policy, recoverable error checked');continue;}
      await page.waitForFunction(()=>EyaWorkspaces.getState().workspace);
      await page.evaluate(path=>EyaPanels.openFile(path),filename);
      await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.press('End');await page.keyboard.press('Enter');await page.keyboard.type('inserted = 3');
      await page.waitForFunction(()=>[...document.querySelectorAll('.panel-tab-dirty')].some(element=>element.textContent.includes('●')));
      await page.keyboard.press('Control+s');await page.waitForFunction(()=>document.querySelector('.save-button')?.disabled===true&&[...document.querySelectorAll('.panel-tab-dirty')].every(element=>!element.textContent.includes('●')));
      assert.equal(await fs.readFile(filename,'utf8'),'first = 1\ninserted = 3\nsecond = 2\n',name);
      console.log(`${name}: artifact startup, encrypted file access, CodeMirror newlines and save passed (${Buffer.byteLength(content)} bytes)`);
    }
    await page.goto(f.http);
    const xml=await page.evaluate(()=>EyaGenerator.svgClient('<html><body><script>window.cdataValue="]]>";</'+'script></body></html>'));
    const filename=path.join(f.root,'compression-cdata.svg');await fs.writeFile(filename,xml);await page.goto(pathToFileURL(filename).href);assert.equal(await page.evaluate(()=>window.cdataValue),']]>');
    assert.deepEqual(f.errors,[]);
  } finally {await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
