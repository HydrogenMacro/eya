const {chromium}=require('playwright');
const {build}=require('../client/node_modules/esbuild');
const fs=require('node:fs/promises');
const path=require('node:path');
const {selectControl}=require('./ui-helpers.cjs');
(async()=>{
  const bundle=await build({stdin:{contents:"import {createTaskManager} from './client/task-manager.js';import {startControlEnhancement} from './client/ui.js';window.createTaskManager=createTaskManager;window.enhance=startControlEnhancement;",resolveDir:path.resolve('.')},bundle:true,write:false,platform:'browser',format:'iife'});
  const css=(await Promise.all(['client/charts.css','client/components.css','client/themes.css'].map(file=>fs.readFile(file,'utf8')))).join('\n');
  const browser=await chromium.launch({executablePath:process.env.EYA_BROWSER_EXECUTABLE,args:process.env.EYA_BROWSER_NO_SANDBOX?['--no-sandbox']:[]});
  const page=await browser.newPage({viewport:{width:1100,height:900}});const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  try{
    await page.setContent(`<html><head><style>*{box-sizing:border-box}body{margin:0;display:flex;height:100vh}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.ui-menu[hidden]{display:none}.ui-menu{position:fixed;margin:0;max-height:80vh;overflow:auto;z-index:10;background:#253541;color:white;padding:8px}.ui-icon{width:18px;height:18px}${css}</style></head><body></body></html>`);
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    await page.evaluate(()=>{
      window.calls=[];window.terminals=[];let sample=0;
      const request=async(op,args)=>{calls.push({op,args});if(op==='system.process')return{command:'python worker.py',cwd:'/work/project',executable:'/usr/bin/python',io:'read_bytes: 4096\nwrite_bytes: 2048'};
        if(op==='system.signal')return{};
        sample++;return{cpu:{total:sample*100,idle:sample*50,count:2,cores:[{id:'cpu0',total:sample*50,idle:sample*25},{id:'cpu1',total:sample*50,idle:sample*25}]},memory:{total:1024**3,available:512*1024**2,swapTotal:0,swapFree:0,cached:128*1024**2},uptime:3600+sample,load:['0.1','0.2','0.3'],network:{received:sample*4096,sent:sample*2048,interfaces:[{name:'eth0',received:sample*4096,sent:sample*2048}]},processes:[{pid:10,ppid:1,name:'parent',state:'S',startTicks:100,ticks:sample*20,rss:1024**2,threads:3,virtualBytes:4096,uid:1000,command:'parent'},{pid:20,ppid:10,name:'worker',state:'R',startTicks:sample===1?101:202,ticks:sample===1?5:1000+(sample-2)*20,rss:2*1024**2,threads:2,virtualBytes:8192,uid:1000,command:'python worker.py'}]};};
      window.task=createTaskManager({request,openTerminal:command=>terminals.push(command),openFile:()=>{}});document.body.append(task.element);enhance();task.onActivate();
    });
    await page.getByText('worker',{exact:true}).waitFor();await page.evaluate(()=>task.api.refresh());
    if(!await page.locator('.machine-summary').innerText().then(text=>text.includes('50.0%')))throw Error('CPU total delta incorrect');
    const worker=page.locator('tbody tr').filter({hasText:'worker'});
    if(!await worker.innerText().then(text=>text.includes('0.0%')))throw Error('PID reuse created a CPU spike');
    await worker.dblclick();await page.getByText('python worker.py',{exact:true}).waitFor();await page.getByRole('button',{name:'Terminal here',exact:true}).click();
    if(await page.evaluate(()=>terminals[0])!=="cd -- '/work/project'")throw Error('Terminal integration missing');
    await page.getByRole('button',{name:'Close details',exact:true}).click();await worker.focus();await page.keyboard.press('Delete');
    await page.waitForFunction(()=>calls.some(call=>call.op==='system.signal'&&call.args.pid===20&&call.args.startTicks===202));
    await page.getByRole('button',{name:'Performance',exact:true}).click();await page.locator('.task-core').filter({hasText:'CPU0'}).waitFor();await page.getByText('eth0',{exact:true}).waitFor();
    if(await page.locator('.live-chart').count()!==3)throw Error('History charts missing');
    await page.getByRole('button',{name:'Task Manager options',exact:true}).click();
    await selectControl(page,'select[aria-label="Task row density"]','compact');await selectControl(page,'select[aria-label="Task graph history"]','300');
    if(await page.evaluate(()=>task.api.getState().settings.range)!==300)throw Error('Chart history customization failed');
    await page.keyboard.press('Escape');await page.getByRole('button',{name:'Processes',exact:true}).click();
    await page.setViewportSize({width:390,height:844});const action=await page.locator('tbody tr').first().locator('.machine-row-actions button').first().boundingBox();
    if(!action||action.x<0||action.x+action.width>391)throw Error(`Mobile controls overflow ${JSON.stringify(action)}`);
    if(errors.length)throw Error(errors.join('; '));await page.evaluate(()=>task.onClose());
    console.log('Task Manager CPU/PID identity math, histories, core/interface performance, inspector integration, controls, preferences, and phone layout passed');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
