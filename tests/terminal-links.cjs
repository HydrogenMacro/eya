const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {buildSync}=require('esbuild');
const {chromium}=require('playwright');
(async()=>{
  const source=fs.readFileSync('client/terminal-panel.js','utf8').replace('const terminal = new Terminal(', 'const terminal = window.testTerminal = new Terminal(')+'\nwindow.createTerminalPanel=createTerminalPanel;';
  const bundle=buildSync({stdin:{contents:source,resolveDir:path.resolve('client')},bundle:true,write:false,format:'iife'}).outputFiles[0].text;
  const browser=await chromium.launch({headless:true,executablePath:process.env.EYA_BROWSER_EXECUTABLE,args:process.env.EYA_BROWSER_NO_SANDBOX?['--no-sandbox']:[]});
  try{
    const page=await browser.newPage({viewport:{width:900,height:650}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(`<style>${fs.readFileSync('client/node_modules/@xterm/xterm/css/xterm.css','utf8')} .instance-terminal{width:780px;height:500px}.ui-menu[hidden]{display:none}.ui-menu{background:#17232c}</style>`);
    await page.addScriptTag({content:bundle});
    await page.evaluate(()=>{
      const getContext=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl2'?null:getContext.call(this,type,...args);};
      window.opened=[];window.external=[];window.sizes=[];window.open=(...args)=>external.push(args);
      window.panel=createTerminalPanel({id:'terminal',url:'ws://127.0.0.1:18765/ws',key:'test',restoring:true,openLink:url=>opened.push(url),onFontSize:size=>sizes.push(size)});document.body.append(panel.element);panel.onLayout();
    });
    const write=text=>page.evaluate(text=>new Promise(resolve=>testTerminal.write(text,resolve)),text);
    await write('\x1b[2J\x1b[Hhttps://example.test/path?q=1\r\n\x1b]8;;https://osc.test/path\x07OSC link\x1b]8;;\x07\r\n\x1b]8;;javascript:alert(1)\x07Unsafe link\x1b]8;;\x07');
    const screen=page.locator('.xterm-screen');
    async function clickCell(column,row){const rect=await screen.boundingBox(),size=await page.evaluate(()=>({cols:testTerminal.cols,rows:testTerminal.rows})),x=rect.x+(column-.5)*rect.width/size.cols,y=rect.y+(row-.5)*rect.height/size.rows;await page.mouse.move(x,y);await page.waitForTimeout(250);await page.mouse.click(x,y);}
    await clickCell(5,1);assert.deepEqual(await page.evaluate(()=>opened),['https://example.test/path?q=1']);
    await clickCell(3,2);assert.deepEqual(await page.evaluate(()=>opened),['https://example.test/path?q=1','https://osc.test/path']);
    await clickCell(3,3);assert.equal(await page.evaluate(()=>opened.length),2);assert.deepEqual(await page.evaluate(()=>external),[]);
    await page.evaluate(()=>{window.mouseReports=[];testTerminal.onData(value=>mouseReports.push(value));});
    await write('\x1b[?1000h\x1b[?1006h');await clickCell(5,1);assert.equal(await page.evaluate(()=>opened.length),2);assert.ok(await page.evaluate(()=>mouseReports.some(value=>/\x1b\[<0;/.test(value))),'Terminal links must preserve application mouse tracking');await write('\x1b[?1000l\x1b[?1006l');
    // Font menu zoom alters xterm metrics and refits its columns; session stays put.
    const before=await page.evaluate(()=>({font:testTerminal.options.fontSize,cols:testTerminal.cols,session:panel.serialize().session}));
    await page.getByRole('button',{name:'Terminal actions',exact:true}).click();await page.getByRole('menuitem',{name:'Zoom in',exact:true}).click();
    assert.equal(await page.evaluate(()=>testTerminal.options.fontSize),before.font+1);assert.ok(await page.evaluate(()=>testTerminal.cols)<before.cols);assert.equal(await page.evaluate(()=>panel.serialize().session),before.session);
    await page.getByRole('button',{name:'Terminal actions',exact:true}).click();await page.getByRole('menuitem',{name:'Zoom out',exact:true}).click();assert.equal(await page.evaluate(()=>testTerminal.options.fontSize),before.font);
    await page.evaluate(()=>{panel.api.zoomFont(100);panel.api.zoomFont(-100);});assert.deepEqual(await page.evaluate(()=>sizes),[16,15,36,8]);assert.equal(await page.evaluate(()=>panel.api.getState().fontSize),8);
    // The textual provider follows wrapping and Unicode cell offsets.
    await page.evaluate(()=>panel.api.updateOptions({fontSize:15}));
    const prefix=await page.evaluate(()=> ' '.repeat(testTerminal.cols-12));await write('\x1b[2J\x1b[H'+prefix+'https://wrapped.test/long/path\r\n界 https://unicode.test/path).');
    await clickCell(4,2);assert.equal((await page.evaluate(()=>opened)).at(-1),'https://wrapped.test/long/path');
    await clickCell(8,3);assert.equal((await page.evaluate(()=>opened)).at(-1),'https://unicode.test/path');
    // Standalone consumers retain a safe external-tab fallback.
    await page.evaluate(()=>{panel.onClose({detach:true});panel.element.remove();window.panel=createTerminalPanel({id:'fallback',url:'ws://127.0.0.1:18765/ws',key:'test',restoring:true});document.body.append(panel.element);panel.onLayout();});
    await write('\x1b[2J\x1b[Hhttps://outside.test/');await clickCell(5,1);assert.deepEqual(await page.evaluate(()=>external),[['https://outside.test/','_blank','noopener,noreferrer']]);
    assert.deepEqual(errors,[]);await page.evaluate(()=>panel.onClose({detach:true}));
    console.log('Terminal HTTP/OSC8 links, blocked unsafe schemes, wrapped/Unicode link cells, safe external fallback and bounded menu font zoom passed.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
