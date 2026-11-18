const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const esbuild = require('esbuild');
const {chromium} = require('playwright');

(async () => {
  const bundle = await esbuild.build({entryPoints:['client/generator.js'],bundle:true,platform:'browser',format:'iife',write:false,minify:true});
  const template = await fs.readFile('client/generator.template.html','utf8');
  const generator = template.replace('/* GENERATOR_JS */', () => bundle.outputFiles[0].text.replaceAll('</script','<\\/script'));
  const artifact = await fs.readFile('client.html','utf8');
  const font = await fs.readFile('client/fonts/0xProto.woff2');
  const server = http.createServer((req,res) => {
    if(req.url.startsWith('/fonts/')) {res.writeHead(200,{'content-type':'font/woff2'});res.end(font);}
    else if(req.url==='/client-template.html') {res.writeHead(200,{'content-type':'text/html'});res.end(artifact);}
    else {res.writeHead(200,{'content-type':'text/html'});res.end(generator);}
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.env.EYA_BROWSER_EXECUTABLE,args:process.env.EYA_BROWSER_NO_SANDBOX?['--no-sandbox']:[]});
  try {
    const page=await browser.newPage({acceptDownloads:true});const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const ids=await esbuild.build({entryPoints:['client/ids.js'],bundle:true,platform:'browser',format:'iife',globalName:'EyaIds',write:false});
    await page.goto('data:text/html,<title>Identifiers</title>');await page.addScriptTag({content:ids.outputFiles[0].text});
    const identifiers=await page.evaluate(()=>Array.from({length:1000},()=>EyaIds.randomId()));assert.equal(new Set(identifiers).size,1000);for(const id of identifiers)assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    await page.goto('http://127.0.0.1:'+server.address().port+'/');
    if(process.env.EYA_GENERATOR_SCREENSHOT) await page.screenshot({path:process.env.EYA_GENERATOR_SCREENSHOT,fullPage:true});
    assert.equal(await page.locator('#generator-version').textContent(), 'v'+(await fs.readFile('VERSION','utf8')).trim());
    await page.locator('#key').fill('generator-test-password');
    assert.equal(await page.locator('.generator-page:visible').count(),1);
    await page.locator('#show-key').click();assert.equal(await page.locator('#key').getAttribute('type'),'text');await page.locator('#show-key').click();
    await page.locator('#generator-nav [data-page=appearance]').click();
    await page.locator('#theme').selectOption('solarized');await page.locator('#panel-focus-mode').selectOption('hover');await page.locator('#mobile-floating-panel-switcher').check();
    await page.locator('#generator-nav [data-page=terminal]').click();await page.locator('#size').fill('19');await page.locator('#command').fill("printf '</script>'");
    await page.locator('#terminal-link-target').selectOption('external');
    await page.locator('#generator-nav [data-page=files]').click();
    await page.getByRole('button',{name:'Add extension',exact:true}).click();
    const openerRow=page.locator('#file-openers tbody tr').last(); await openerRow.locator('input').fill('notes'); await openerRow.locator('select').selectOption('markdown');
    await page.locator('#generator-search').fill('quality');assert.ok(await page.locator('#browser-quality').isVisible());assert.equal(await page.locator('#theme').isVisible(),false);
    await page.locator('#browser-quality').selectOption('40');
    await page.locator('#generator-nav [data-page=browser]').click();await page.locator('#browser-format').selectOption('efficient');await page.locator('#browser-resolution').selectOption('1280');await page.locator('#browser-fps').selectOption('15');
    await page.locator('#generator-nav [data-page=binary]').click();await page.locator('#binary-font-size').fill('15');await page.locator('#binary-show-text').uncheck();await page.locator('#binary-bytes-per-row').selectOption('32');await page.locator('#binary-text-encoding').selectOption('utf-8');
    await page.locator('#generator-nav [data-page=taskManager]').click();await page.locator('#task-interval').selectOption('250');await page.locator('#task-tree').check();
    await page.locator('#generator-nav [data-page=audio]').click();await page.locator('#audio-speed').selectOption('1.5');
    await page.locator('#generator-nav [data-page=cad]').click();await page.locator('#cad-unit').selectOption('in');await page.locator('#cad-infinite-grid').check();await page.locator('#cad-decimal-places').fill('2');await page.locator('#cad-grid-fill').check();await page.locator('#cad-grid-lines').uncheck();await page.locator('#cad-orbit-pivot').selectOption('model');assert.equal(await page.locator('#cad-selection-behavior,#cad-navigation-mode,#cad-view-section').count(),0);assert.equal(await page.locator('#cad-axis-coordinates').getAttribute('aria-label'),'Grid tick marks');
    await page.getByRole('button',{name:'Keyboard shortcuts',exact:true}).click();
    await page.getByRole('button',{name:'Change Settings shortcut',exact:true}).click();await page.keyboard.press('Control+Alt+s');
    await page.getByRole('button',{name:'Close keyboard shortcuts',exact:true}).click();
    await page.locator('#generator-nav [data-page=export]').click();
    const [download]=await Promise.all([page.waitForEvent('download'),page.locator('button[type=submit]').click()]);
    const html=await fs.readFile(await download.path(),'utf8');
    const match=html.match(/<script id="eya-config" type="application\/json">(.*?)<\/script>/s);assert.ok(match);
    const config=JSON.parse(match[1]);assert.equal(config.terminalLinkTarget,'external');assert.equal(config.fileOpeners.md,'markdown');assert.equal(config.fileOpeners.notes,'markdown');assert.equal(config.fontSize,19);assert.equal(config.theme,'solarized');assert.equal(config.panelFocusMode,'hover');assert.equal(config.mobileFloatingPanelSwitcher,true);assert.deepEqual(config.mobilePanelButtonPosition,{x:0.95,y:0.65});assert.equal(config.binary.fontSize,15);assert.equal(config.binary.showText,false);assert.equal(config.binary.bytesPerRow,32);assert.equal(config.binary.textEncoding,'utf-8');assert.equal(config.defaultCommand,"printf '</script>'");assert.equal(config.browser.stream.format,'efficient');assert.equal(config.browser.stream.quality,40);assert.equal(config.browser.stream.resolution,'1280');assert.equal(config.browser.stream.fps,15);assert.equal(config.taskManager.interval,250);assert.equal(config.taskManager.tree,true);assert.equal(config.audio.speed,1.5);assert.equal(config.cad.unit,'in');assert.equal(config.cad.infiniteGrid,true);assert.equal(config.cad.decimalPlaces,2);assert.equal(config.cad.gridFill,true);assert.equal(config.cad.gridLines,false);assert.equal(config.cad.orbitPivot,'model');assert.deepEqual(config.keybinds['global.settings'],['Ctrl+Alt+s']);assert.match(config.font,/^data:/);assert.equal(match[1].includes('</script>'),false);
    await page.locator('#format').selectOption('svg');const [svg]=await Promise.all([page.waitForEvent('download'),page.locator('button[type=submit]').click()]);assert.match(await fs.readFile(await svg.path(),'utf8'),/<foreignObject/);
    await page.locator('#format').selectOption('compressed-html');const [compressed]=await Promise.all([page.waitForEvent('download'),page.locator('button[type=submit]').click()]);assert.ok((await fs.stat(await compressed.path())).size < Buffer.byteLength(html));
    await page.locator('#format').selectOption('data-url');await page.locator('button[type=submit]').click();await page.locator('#data-url-result').waitFor();assert.match(await page.locator('#data-url').inputValue(),/^data:text\/html/);
    await page.setViewportSize({width:390,height:844});await page.locator('#generator-nav [data-page=connection]').click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.locator('#generator-nav [data-page=terminal]').click();await page.locator('#size').fill('100');await page.locator('#generator-nav [data-page=export]').click();await page.locator('button[type=submit]').click();assert.ok(await page.locator('#size').isVisible());assert.equal(await page.locator('#size').evaluate(input=>input.validity.valid),false);
    assert.deepEqual(errors,[]);console.log('Generator submenus, shared settings, search, password visibility, shortcuts, config escaping, HTML/SVG/compression and mobile layout passed');
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
