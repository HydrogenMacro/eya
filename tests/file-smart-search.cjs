const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { build } = require('esbuild');

(async () => {
  const bundle = await build({ stdin: { contents: `
    import {createFileBrowser} from ${JSON.stringify(path.resolve('client/file-browser.js'))};
    const all=[{name:'start',path:'/start',kind:'directory'},{name:'root.txt',path:'/root.txt',kind:'file'},
      {name:'folder',path:'/start/folder',kind:'directory'},{name:'one.txt',path:'/start/one.txt',kind:'file'},
      {name:'only.txt',path:'/start/only.txt',kind:'file'},{name:'child.txt',path:'/start/folder/child.txt',kind:'file'}];
    window.opened=[];window.calls=[];
    window.panel=createFileBrowser({id:'search',request:async(op,{path='/start',query=''})=>{
      window.calls.push({op,path,query});
      if(path==='/delayed')await new Promise(resolve=>window.release=resolve);
      return {path,entries:all.filter(item=>op==='search'?item.path.startsWith(path==='/'?'/':path+'/')&&item.name.toLowerCase().includes(query.toLowerCase()):item.path.slice(0,item.path.lastIndexOf('/'))===(path==='/'?'':path))};
    },read:async()=>({bytes:new Uint8Array()}),upload:async()=>{},openFile:path=>opened.push(path),download:()=>{},
      preferences:()=>({startingDirectory:'/start',refreshInterval:0})});
    document.body.append(panel.element);panel.onActivate();`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife' });
  const browser = await chromium.launch({ executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setContent(`<!doctype html><style>svg{width:18px;height:18px}input{height:32px}.file-instance{width:600px}.file-instance-toolbar,.file-instance-search{display:flex}.file-instance-search input{flex:1}${await fs.readFile('client/components.css', 'utf8')}</style><body><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`);
    const directory = page.getByRole('combobox', { name: 'Current directory', exact: true });
    const search = page.getByRole('combobox', { name: 'Search files', exact: true });
    const paths = page.getByRole('listbox', { name: 'Directory suggestions' });
    const matches = page.getByRole('listbox', { name: 'File search suggestions' });
    await page.waitForFunction(() => panel.api.getPath() === '/start');
    await directory.fill('/start/o');
    await paths.getByRole('option').first().waitFor();
    assert.equal(await paths.getByRole('option').count(), 2);
    await directory.press('ArrowUp');
    assert.equal(await paths.getByRole('option', { selected: true }).innerText(), '/start/only.txt');
    await directory.press('Home');
    await directory.press('Enter');
    assert.deepEqual(await page.evaluate(() => opened), ['/start/one.txt']);
    assert.equal(await directory.getAttribute('aria-expanded'), 'false');

    await directory.fill('/start/f'); await paths.getByRole('option').waitFor();
    await directory.press('ArrowDown'); await directory.press('Tab');
    assert.equal(await directory.inputValue(), '/start/folder/');
    assert.equal(await page.evaluate(() => panel.api.getPath()), '/start');
    await directory.focus(); await directory.press('Enter');
    await page.waitForFunction(() => panel.api.getPath() === '/start/folder');
    await directory.fill('/start/folder/../');
    assert.equal(await directory.inputValue(), '/start/');
    await directory.press('Enter');
    await page.waitForFunction(() => panel.api.getPath() === '/start');

    await search.fill('on'); await matches.getByRole('option').first().waitFor();
    await search.press('ArrowDown');
    const selectedId = await search.getAttribute('aria-activedescendant');
    assert.ok(selectedId); assert.equal(await page.locator(`[id="${selectedId}"]`).getAttribute('aria-selected'), 'true');
    await search.press('End'); await search.press('Enter');
    assert.deepEqual(await page.evaluate(() => opened), ['/start/one.txt', '/start/only.txt']);
    await search.fill('child');
    await matches.getByRole('option', { name: '/start/folder/child.txt', exact: true }).waitFor();
    await matches.getByRole('option').click();
    assert.equal(await page.evaluate(() => opened.at(-1)), '/start/folder/child.txt');

    await search.fill('../root');
    assert.equal(await search.inputValue(), 'root');
    await page.waitForFunction(() => panel.api.getPath() === '/');
    await matches.getByRole('option', { name: '/root.txt', exact: true }).waitFor();
    assert.equal(await directory.inputValue(), '/');
    await search.fill('../../');
    assert.equal(await search.inputValue(), '');
    await page.waitForFunction(() => document.querySelector('.file-instance-view').getAttribute('aria-busy') === 'false' && !document.querySelector('[role=combobox][aria-label="Search files"]').value);
    assert.equal(await page.evaluate(() => panel.api.getPath()), '/');

    await directory.fill('/delayed/'); await page.waitForFunction(() => !!window.release);
    await directory.press('Escape'); await directory.press('Tab');
    await page.evaluate(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
    assert.equal(await directory.getAttribute('aria-expanded'), 'false');
    await page.evaluate(() => panel.onClose());
    assert.equal(await page.locator('.file-combobox-options').count(), 0);
    assert.deepEqual(errors, []);
    console.log('Smart file/path combobox suggestions, keyboard selection/completion, relative parents, async dismissal and cleanup passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
