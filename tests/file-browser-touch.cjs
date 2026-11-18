const { chromium } = require('playwright');
const { build } = require('esbuild');
const path = require('node:path');

(async () => {
  const bundle = await build({ stdin: { contents: `
    import {createFileBrowser} from ${JSON.stringify(path.resolve('client/file-browser.js'))};
    globalThis.opened=[];
    globalThis.panel=createFileBrowser({id:'touch',request:async(op,{path})=>({path:path||'/start',entries:path==='/start/folder'?[{name:'child.txt',path:'/start/folder/child.txt',kind:'file',size:1}]:[{name:'folder',path:'/start/folder',kind:'directory'},{name:'one.txt',path:'/start/one.txt',kind:'file',size:1}]}),
      read:async()=>({bytes:new Uint8Array()}),upload:async()=>{},openFile:path=>opened.push(path),download:()=>{},
      preferences:()=>({startingDirectory:'/start',refreshInterval:0})});
    document.body.append(panel.element);panel.onActivate();`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife' });
  const browser = await chromium.launch({ executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  const page = await browser.newPage({ viewport: {width:390,height:700},isMobile:true,hasTouch:true });
  page.on('pageerror', error => console.error('Page error:',error));
  try {
    await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>svg{width:20px;height:20px}td{height:44px}body{height:1800px}.ui-menu[popover]:not(:popover-open){display:none}</style><body><script>${bundle.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`);
    const row = name => page.locator('tbody tr').filter({hasText:name});
    await row('folder').tap();
    if (await page.evaluate(()=>panel.api.getPath()) !== '/start') throw Error('One tap opened a folder instead of selecting it');
    await row('folder').tap();
    await row('child.txt').waitFor();
    await row('child.txt').tap(); await row('child.txt').tap();
    if (await page.evaluate(()=>opened.join(',')) !== '/start/folder/child.txt') throw Error('Double tap failed to open the file exactly once: '+await page.evaluate(()=>JSON.stringify(opened)));
    // Mobile browsers that also synthesize dblclick must not open twice.
    await row('child.txt').dispatchEvent('dblclick');
    if (await page.evaluate(()=>opened.length) !== 1) throw Error('Synthetic mobile dblclick opened the file twice');
    await page.evaluate(()=>panel.api.navigate('/start'));
    await row('folder').waitFor();
    await row('folder').tap(); await row('one.txt').tap(); await row('folder').tap();
    if (await page.evaluate(()=>panel.api.getPath()) !== '/start') throw Error('Taps on different entries formed a double tap');
    // Scrolling must cancel a pending tap rather than activate the touched row.
    const target = row('one.txt');
    await target.dispatchEvent('pointerdown',{pointerId:9,pointerType:'touch',isPrimary:true,clientX:30,clientY:100});
    await target.dispatchEvent('pointermove',{pointerId:9,pointerType:'touch',isPrimary:true,clientX:30,clientY:20});
    await target.dispatchEvent('pointerup',{pointerId:9,pointerType:'touch',isPrimary:true,clientX:30,clientY:100});
    await target.tap();
    if (await page.evaluate(()=>opened.length) !== 1) throw Error('Scroll gesture counted as a tap');
    await page.waitForTimeout(850);
    await target.dblclick();
    if (await page.evaluate(()=>opened.length) !== 2) throw Error('Mouse double click no longer opens entries');
    await target.getByRole('button',{name:'Actions for one.txt',exact:true}).tap();
    await page.getByRole('menuitem',{name:'Open',exact:true}).tap();
    if (await page.evaluate(()=>opened.length) !== 3) throw Error('Touch menu Open failed or opened the file more than once');
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:40,y:120}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:40,y:30}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await page.waitForFunction(()=>scrollY>0);
    console.log('Mobile double tap file/folder opening, mouse opening, duplicate suppression, and touch scrolling passed');
  } finally { await page.evaluate(()=>panel?.onClose()).catch(()=>{}); await browser.close(); }
})().catch(error=>{console.error(error);process.exit(1);});
