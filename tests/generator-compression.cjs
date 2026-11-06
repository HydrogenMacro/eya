const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = process.env.EYA_TEST_ROOT;
if (!root) throw Error('EYA_TEST_ROOT is required');
(async () => {
  const browser = await chromium.launch({headless:true,executablePath:process.env.EYA_BROWSER_EXECUTABLE,args:process.env.EYA_BROWSER_NO_SANDBOX?['--no-sandbox']:[]});
  const page = await browser.newPage(); const errors=[];page.on('pageerror',error=>errors.push(error.message));
  try {
    await page.goto('http://127.0.0.1:18765/');
    const template = await fs.readFile('client.html','utf8');
    const config = {url:'ws://127.0.0.1:18765/ws',key:'000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'};
    const html = template.replace('<script id="eya-config" type="application/json">{}</script>',()=>'<script id="eya-config" type="application/json">'+JSON.stringify(config)+'</script>');
    const artifacts = await page.evaluate(html=>Object.fromEntries(Object.entries(EyaGenerator).map(([name,fn])=>[name,fn(html)])),html);
    for (const [name,content] of Object.entries(artifacts)) {
      let url;
      if(name==='dataUrl')url=content;
      else {const filename=path.join(root,`compression-${name}.${name.toLowerCase().includes('svg')?'svg':'html'}`);await fs.writeFile(filename,content);url=pathToFileURL(filename).href;}
      await fs.writeFile(path.join(root,'compression-newlines.py'),'first = 1\nsecond = 2\n');
      await page.goto(url);
      await page.locator('#url').waitFor();
      if(await page.locator('#url').evaluate(element=>element.value)!==config.url||await page.locator('#key').evaluate(element=>element.value)!==config.key)throw Error(`${name}: embedded config was lost`);
      await page.locator('#start-connection').click();await page.locator('#status').filter({hasText:'Connected'}).waitFor();
      await page.locator('#files').click();await page.locator('#file-list tr').filter({hasText:'compression-newlines.py'}).dblclick();
      await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.press('End');await page.keyboard.press('Enter');await page.keyboard.type('inserted = 3');
      await page.waitForFunction(()=>[...document.querySelectorAll('.panel-tab-dirty')].some(element=>element.textContent.includes('●')));
      await page.keyboard.press('Control+s');
      await page.waitForFunction(()=>document.querySelector('.save-button')?.disabled===true && [...document.querySelectorAll('.panel-tab-dirty')].every(element=>!element.textContent.includes('●')));
      const saved=await fs.readFile(path.join(root,'compression-newlines.py'),'utf8');
      if(saved!=='first = 1\ninserted = 3\nsecond = 2\n')throw Error(`${name}: CodeMirror newline save failed: ${JSON.stringify(saved)}`);
      await page.evaluate(()=>document.getElementById('end-session').click());await page.locator('#status').filter({hasText:'ended explicitly'}).waitFor();
      console.log(`${name}: standalone startup, embedded settings, encrypted connection, CodeMirror newlines, and save passed (${Buffer.byteLength(content)} bytes)`);
    }
    // SVG script payloads must preserve strings containing XML delimiters.
    await page.goto('http://127.0.0.1:18765/');
    const xml = await page.evaluate(()=>EyaGenerator.svgClient('<html><body><script>window.cdataValue="]]>";</'+'script></body></html>'));
    const filename=path.join(root,'compression-cdata.svg');await fs.writeFile(filename,xml);await page.goto(pathToFileURL(filename).href);
    if(await page.evaluate(()=>window.cdataValue)!==']]>')throw Error('SVG script payload changed the program');
    if(errors.length)throw Error(errors.join('; '));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
