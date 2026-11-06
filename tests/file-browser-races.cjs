const { chromium } = require('playwright');
const { build } = require('esbuild');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eya-browser-races-'));
  const result = await build({ stdin: { contents: `import {createFileBrowser} from ${JSON.stringify(path.resolve('client/file-browser.js'))};
    globalThis.requests=[];
    globalThis.panel=createFileBrowser({id:'test',request:(op,args)=>new Promise((resolve,reject)=>requests.push({op,args,resolve,reject})),
      read:async()=>({bytes:new Uint8Array()}),upload:async()=>{},openFile:()=>{},download:()=>{},
      preferences:()=>({startingDirectory:'/start',showHidden:false,confirmDelete:false,refreshInterval:1})});
    document.body.append(panel.element);panel.onActivate();`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife' });
  const filename = path.join(directory, 'index.html');
  await writeFile(filename, `<!doctype html><html><head><style>.ui-menu[hidden]{display:none!important}.ui-menu[popover]:not(:popover-open){display:none}.ui-icon{width:18px;height:18px}button{min-height:30px}.file-instance{width:700px;height:700px}</style></head><body><script>${result.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`);
  const browser = await chromium.launch({ executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  const settle = async (directory, names = ['one.txt', 'two.txt']) => {
    await page.evaluate(({directory,names}) => requests.shift().resolve({path:directory,entries:names.map(name=>({name,path:`${directory}/${name}`,kind:'file',size:10}))}), {directory,names});
    await page.locator('input[aria-label="Current directory"]').filter({visible:true}).waitFor();
  };
  try {
    await page.clock.install(); await page.goto(pathToFileURL(filename).href);
    await settle('/start');
    await page.evaluate(() => { panel.api.navigate('/slow'); panel.api.refresh(); });
    await page.clock.fastForward(2000);
    if (await page.evaluate(() => requests.length) !== 1) throw Error('Refresh interrupted an in-flight navigation');
    await settle('/slow');
    if (await page.evaluate(() => panel.api.getPath()) !== '/slow') throw Error('Navigation lost to refresh');
    await page.waitForFunction(() => requests.length === 1);
    if (await page.evaluate(() => requests[0].args.path) !== '/slow') throw Error('Queued refresh used an obsolete path');
    await settle('/slow');
    const row = page.locator('tbody tr').filter({hasText:'two.txt'}); await row.click(); await row.focus();
    await page.evaluate(() => { panel.api.refresh(); }); await settle('/slow');
    if (!await row.evaluate(element => element === document.activeElement && element.classList.contains('selected'))) throw Error('Refresh lost row focus/selection');
    await page.clock.fastForward(1000); await page.waitForFunction(() => requests.length === 1);
    await page.getByRole('button', {name:'Actions for two.txt',exact:true}).click();
    await settle('/slow', ['changed.txt']);
    if (!await page.getByRole('menuitem', {name:'Delete',exact:true}).isVisible() || !await row.count()) throw Error('An automatic response dismissed a menu opened midflight');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { panel.api.navigate('/last'); }); await settle('/last');
    await page.getByRole('button', {name:'Back',exact:true}).click();
    await page.evaluate(() => requests.shift().reject(Error('Directory unavailable')));
    await page.getByRole('button', {name:'Back',exact:true}).click();
    if (await page.evaluate(() => requests[0].args.path) !== '/slow') throw Error('Failed history navigation changed the history index');
    await settle('/slow');
    await page.evaluate(() => panel.onClose());
    if (errors.length) throw Error(errors.join('; '));
    console.log('Browser navigation/refresh races, queued path correctness, focus retention, menu stability, and history failure recovery passed');
  } finally { await browser.close(); await rm(directory,{recursive:true,force:true}); }
})().catch(error => {console.error(error);process.exit(1);});
