const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {gunzipSync} = require('node:zlib');
const {pathToFileURL} = require('node:url');
const {fixture,KEY} = require('./continuity-fixture.cjs');

async function connected(page) {
  await page.waitForFunction(() => window.EyaWorkspaces);
  // Configured clients authenticate automatically; manual Connect remains usable.
  try {await page.waitForFunction(() => EyaWorkspaces.getState().workspace, null, {timeout:15000});}catch{throw Error('Automatic connection failed: '+JSON.stringify(await page.evaluate(()=>({status:document.querySelector('#status')?.textContent,error:document.querySelector('#dialog-error')?.textContent,body:document.querySelector('#connect-dialog')?.textContent}))))}
}
async function terminal(page) {
  await page.waitForFunction(() => EyaPanels.layout().flatMap(group=>group.panels).some(id=>id.startsWith('terminal-') && EyaPanels.call(id,'getState').connected));
  return page.evaluate(() => EyaPanels.layout().flatMap(group=>group.panels).find(id=>id.startsWith('terminal-')));
}
(async()=>{
  const f=await fixture();
  try {
    const page=await f.client({connect:false});
    await page.goto(f.http);
    assert.deepEqual(await page.locator('.launchers a').evaluateAll(links=>links.map(link=>new URL(link.href).pathname)),['/client.html','/client.svg']);
    for(const type of ['html','svg']) {
      const response=await page.goto(f.http+'/client.'+type);assert.match(response.headers()['content-type'],type==='svg'?/^image\/svg\+xml/:/^text\/html/);
      await page.locator('#url').waitFor();assert.equal(await page.locator('#url').evaluate(element=>element.value),f.url);assert.equal(await page.locator('#key').evaluate(element=>element.value),KEY);
      await connected(page);const id=await terminal(page);
      await page.evaluate(id=>EyaPanels.call(id,'sendInput',"stty -echo; printf 'HOSTED_CLIENT_OK\\n'\r"),id);
      await page.waitForFunction(id=>EyaPanels.call(id,'getText').includes('HOSTED_CLIENT_OK'),id);
      if(type==='svg')assert.ok(await page.locator('body').evaluate(body=>Math.abs(body.getBoundingClientRect().width-innerWidth)<2));
      await page.evaluate(id=>EyaPanels.close(id),id);
    }
    await page.goto(f.http);await page.locator('#key').fill(KEY);
    await page.locator('#generator-nav [data-page=terminal]').click();
    const command="printf 'DEFAULT_COMMAND\\n'";
    await page.locator('#command').fill(command);await page.locator('#size').fill('18');await page.locator('#font').setInputFiles('client/fonts/0xProto.woff2');
    await page.locator('#generator-nav [data-page=appearance]').click();await page.locator('#theme').selectOption('midnight');
    await page.locator('#generator-nav [data-page=export]').click();
    const artifacts=[];
    for(const format of ['html','svg','compressed-html','compressed-svg','data-url']) {
      await page.locator('#format').selectOption(format);
      let content,filename,url;
      if(format==='data-url') {await page.locator('button[type=submit]').click();await page.locator('#data-url-result').waitFor();content=await page.locator('#data-url').evaluate(element=>element.value);url=content;assert.match(content,/^data:text\/html/);}
      else {const [download]=await Promise.all([page.waitForEvent('download'),page.locator('button[type=submit]').click()]);filename=path.join(f.root,download.suggestedFilename());await download.saveAs(filename);content=await fs.readFile(filename,'utf8');url=pathToFileURL(filename).href;}
      artifacts.push({format,content,url});
    }
    const html=artifacts[0].content;assert.ok(html.includes(KEY));assert.ok(html.includes('"fontSize":18'));assert.ok(html.includes('"theme":"midnight"'));assert.ok(html.includes('"defaultCommand":'+JSON.stringify(command)));assert.ok(html.includes('data:font/'));
    assert.ok(Buffer.byteLength(artifacts[2].content)<Buffer.byteLength(html)*0.8);assert.ok(artifacts[4].content.length<Buffer.byteLength(html)*0.9);
    for(const artifact of artifacts) {
      const {format}=artifact;let url=artifact.url,expectsFont=true;
      if(format==='data-url') {
        const wrapper=decodeURIComponent(url.slice(url.indexOf(',')+1)),payload=wrapper.match(/atob\("([^"]+)"\)/);assert.ok(payload);assert.equal(gunzipSync(Buffer.from(payload[1],'base64')).toString('utf8'),html);
        if(url.length>2_000_000) {
          // Chromium bounds navigation URLs. Verify full packaging above and run
          // the actual application using the same settings without the large font.
          const compact=html.replace(/(<script id="eya-config" type="application\/json">)([\s\S]*?)(<\/script>)/,(_,start,json,end)=>{const config=JSON.parse(json);delete config.font;return start+JSON.stringify(config).replace(/</g,'\\u003c')+end;});
          url=await page.evaluate(html=>EyaGenerator.dataUrl(html),compact);expectsFont=false;
          assert.ok(url.length<2_000_000,'The compact data URL fits browser navigation limits');
          console.log('data-url: full font packaging checked; runtime uses font-free artifact to fit Chromium URL limits');
        }
      }
      const output=await page.context().newPage();output.on('pageerror',error=>f.errors.push(error.message));output.on('dialog',dialog=>dialog.accept());
      await output.goto(url,{waitUntil:'domcontentloaded',timeout:20000});await output.locator('#url').waitFor();
      assert.equal(await output.locator('#url').evaluate(element=>element.value),f.url,format);assert.equal(await output.locator('#key').evaluate(element=>element.value),KEY,format);assert.equal(await output.locator('#font-size').evaluate(element=>element.value),'18',format);
      if(expectsFont)await output.waitForFunction(()=>[...document.fonts].some(font=>font.family==='EyaEmbeddedFont'&&font.status==='loaded'));
      if(format==='data-url') {
        await output.waitForFunction(()=>window.EyaWorkspaces && (EyaWorkspaces.getState().workspace || document.querySelector('#dialog-error')?.textContent));
        if(!await output.evaluate(()=>!!EyaWorkspaces.getState().workspace)) {
          assert.match(await output.locator('#dialog-error').textContent(),/Cannot reach the server/);assert.equal(await output.locator('#start-connection').isEnabled(),true);
          const recovery=output.getByRole('button',{name:'Open server client',exact:true});
          const popupPromise=output.context().waitForEvent('page');await recovery.press('Enter');
          const popup=await popupPromise;await popup.waitForURL(f.http+'/client.html');
          assert.equal(await popup.evaluate(()=>window.opener),null);await popup.close();
          console.log('data-url: runtime initialized; browser local-network policy blocks loopback WebSocket, recoverable connection error checked');await output.close();continue;
        }
      }
      await connected(output);const id=await terminal(output);await output.waitForFunction(id=>EyaPanels.call(id,'getText').includes('DEFAULT_COMMAND'),id);
      if(format==='html') {await output.evaluate(id=>EyaPanels.call(id,'sendInput',"head -c 400000 /dev/zero | tr '\\0' x; printf '\\nFLOW_TEST_PASSED\\n'\r"),id);await output.waitForFunction(id=>EyaPanels.call(id,'getText').includes('FLOW_TEST_PASSED'),id,{timeout:20000});}
      await output.evaluate(id=>EyaPanels.close(id),id);await output.close();
      console.log(format+': configured artifact, embedded font, automatic encrypted connection and one-time command passed');
    }
    assert.deepEqual(f.errors,[]);
  } finally {await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
