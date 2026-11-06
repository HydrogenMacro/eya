const { chromium }=require('playwright');
const {build}=require('../client/node_modules/esbuild');
const fs=require('node:fs/promises');const path=require('node:path');
(async()=>{
 const bundle=await build({stdin:{contents:"import {createDockerPanel} from './client/docker-panel.js';import {startControlEnhancement} from './client/ui.js';window.Docker={createDockerPanel,startControlEnhancement};",resolveDir:path.resolve('.')},bundle:true,write:false,format:'iife',platform:'browser'});
 const browser=await chromium.launch({executablePath:process.env.EYA_BROWSER_EXECUTABLE,args:process.env.EYA_BROWSER_NO_SANDBOX?['--no-sandbox']:[]});
 const page=await browser.newPage({viewport:{width:1100,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 try{
  await page.setContent(`<html><head><style>*{box-sizing:border-box}body{margin:0;display:flex;height:100vh;--ui-bg:#10151b;--ui-fg:white;--ui-surface:#192730;--ui-control:#253541;--ui-border:#344854;--ui-muted:#9bb0bc;--ui-accent:#7fdbc5}.ui-menu[hidden]{display:none}.ui-menu{position:fixed;background:#192730;z-index:20}.ui-icon{width:18px;height:18px}.sr-only{position:absolute;width:1px;height:1px;clip:rect(0,0,0,0);overflow:hidden}${await fs.readFile('client/charts.css','utf8')}${await fs.readFile('client/components.css','utf8')}</style></head><body></body></html>`);
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.evaluate(()=>{window.calls=[];window.opened=[];window.commands=[];let sample=0;window.panel=Docker.createDockerPanel({request:async(op,args)=>{calls.push({op,args});if(op==='docker.list')return {containers:[{ID:'abcdef123456',Names:'web',State:'running',Status:'Up 1h',Image:'test/web',Labels:'com.docker.compose.project=demo,com.docker.compose.service=web',Ports:'8080->80'}],usage:[{ID:'abcdef123456',CPUPerc:`${++sample}%`,MemUsage:'20 MiB / 1 GiB',NetIO:'1 MiB / 2 MiB'}]};if(op==='compose.list')return {projects:[{Name:'demo',Status:'running(1)',ConfigFiles:'/tmp/demo/compose.yml'}]};if(op==='docker.inspect')return {output:JSON.stringify([{State:{Status:'running',Health:{Status:'healthy'}},Config:{Image:'test/web'},Mounts:[{Type:'bind',Source:'/tmp/source.txt',Destination:'/app/source.txt'}]}])};if(op==='docker.logs')return {output:'first line\nsecond line'};if(op==='docker.top')return {output:'PID CMD\n1 nginx'};if(op==='docker.resources')return {items:[{ID:'abc123',Repository:'test/web',Tag:'latest',Size:'20 MiB'}]};if(op==='docker.resource.inspect')return {output:'[{"Size":20000000}]'};return {};},openFile:async path=>opened.push(path),openTerminal:command=>commands.push(command)});document.body.append(panel.element);Docker.startControlEnhancement();panel.onActivate();});
  await page.getByText('web',{exact:true}).waitFor();await page.evaluate(()=>panel.api.refresh());
  if(await page.locator('.docker-graphs svg').count()!==2)throw Error('Missing CPU/memory charts');
  await page.locator('.docker-table tbody tr').first().click();await page.getByText('healthy',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Open compose.yml',exact:true}).click();
  await page.waitForFunction(()=>opened.includes('/tmp/demo/compose.yml'));
  await page.getByRole('button',{name:'Open terminal',exact:true}).click();await page.waitForFunction(()=>commands[0]==="docker exec -it 'abcdef123456' /bin/sh");
  await page.getByRole('button',{name:'Logs',exact:true}).click();await page.getByText('first line\nsecond line',{exact:true}).waitFor();
  await page.getByRole('searchbox',{name:'Filter logs'}).fill('second');if((await page.locator('.docker-detail-content pre').innerText())!=='second line')throw Error('Log filter failed');
  await page.getByRole('button',{name:'Processes',exact:true}).click();await page.getByText('PID CMD\n1 nginx',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Close details',exact:true}).click();
  await page.getByRole('button',{name:'Compose',exact:true}).click();await page.getByText('demo',{exact:true}).click();
  await page.locator('.machine-services').getByRole('button',{name:'web',exact:true}).click();await page.getByRole('menuitem',{name:'Restart',exact:true}).click();
  await page.waitForFunction(()=>calls.some(c=>c.op==='compose.action'&&c.args.service==='web'));
  await page.getByRole('button',{name:'Images',exact:true}).click();await page.getByText('test/web',{exact:true}).click();await page.locator('.docker-detail-content pre').filter({hasText:'20000000'}).waitFor();
  await page.getByRole('button',{name:'Docker view options',exact:true}).click();await page.getByText('Show charts',{exact:true}).locator('..').locator('input').uncheck();
  if(await page.locator('.docker-graphs').isVisible())throw Error('Graph customization failed');
  await page.keyboard.press('Escape');await page.getByRole('button',{name:'Containers',exact:true}).click();await page.getByText('web',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});const box=await page.locator('.machine-row-actions button').first().boundingBox();if(!box||box.x+box.width>390)throw Error('Mobile actions overflow');
  await page.evaluate(()=>panel.onClose());if(errors.length)throw Error(errors.join('; '));console.log('Docker graphs, container details/logs/processes, compose editor/terminal integration, resources, customization and mobile controls passed');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
