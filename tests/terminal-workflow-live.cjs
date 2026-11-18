const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {fixture}=require('./continuity-fixture.cjs');
const {selectControl,reveal}=require('./ui-helpers.cjs');
const octal=value=>[...value].map(character=>`\\${character.charCodeAt(0).toString(8).padStart(3,'0')}`).join('');
(async()=>{
  const f=await fixture();
  try{
    const directoryName="quoted ' $(touch EYA_INJECTION) ; spaces",directory=path.join(f.files,directoryName);await fs.mkdir(directory);
    const page=await f.client({webgl:false});await f.named(page,'Terminal workflow');
    const panelIds=()=>page.evaluate(()=>EyaPanels.layout().flatMap(group=>group.panels));
    const send=async(id,text)=>page.evaluate(({id,text})=>EyaPanels.call(id,'sendInput',text),{id,text});
    const read=async id=>page.evaluate(id=>EyaPanels.call(id,'getText','all'),id);
    const terminal=await page.evaluate(()=>EyaPanels.create('terminal'));
    await page.waitForFunction(id=>EyaPanels.call(id,'getState').connected,terminal);
    const terminalSurface=page.locator('.instance-terminal').first();
    async function printLink(escapeText){await send(terminal,`stty -echo; printf '${escapeText}'\r`);}
    async function clickLink(label){
      const row=terminalSurface.locator('.xterm-rows > div').filter({hasText:label}).first();await row.waitFor();const box=await row.boundingBox();
      await page.mouse.move(box.x+24,box.y+box.height+8);await page.mouse.move(box.x+24,box.y+box.height/2);await page.waitForTimeout(500);await page.mouse.click(box.x+24,box.y+box.height/2);
    }
    assert.equal(await page.locator('#terminal-link-target').inputValue(),'browser');
    const internalUrl='https://terminal-link.example.test/route?from=pty',beforeBrowser=await panelIds();
    await printLink(`\\033[2J\\033[H${internalUrl}\\r\\n`);await clickLink(internalUrl);
    // Routing is independent of whether server Chromium is installed. The actual
    // Browser panel is created through its encrypted transport and receives URL.
    await page.locator('.eya-web-browser').waitFor();await page.waitForFunction(url=>document.querySelector('.eya-web-browser .eya-address')?.value===url,internalUrl);
    const browser=(await panelIds()).find(id=>!beforeBrowser.includes(id));assert.ok(browser,'Default terminal link must create a Browser panel');
    await page.evaluate(id=>EyaPanels.close(id),browser);await page.evaluate(id=>EyaPanels.activate(id),terminal);
    // Rebinding the destination immediately affects already-open terminals.
    await selectControl(page,'#terminal-link-target','external');await page.locator('#close-settings').click();
    await page.evaluate(()=>{window.externalLinks=[];window.open=(...args)=>externalLinks.push(args);});
    const externalUrl='https://outside.example.test/osc8';await printLink(`\\033[2J\\033[H\\033]8;;${externalUrl}\\007EXTERNAL LINK\\033]8;;\\007\\r\\n`);await clickLink('EXTERNAL LINK');
    await page.waitForFunction(()=>externalLinks.length>0,{},{timeout:5000});
    assert.deepEqual(await page.evaluate(()=>externalLinks),[[externalUrl,'_blank','noopener,noreferrer']]);assert.equal(await page.locator('.eya-web-browser').count(),0);
    const workspaceId=await page.evaluate(()=>EyaWorkspaces.getState().workspace.id),font=await page.evaluate(id=>EyaPanels.call(id,'getState').fontSize,terminal);
    const screenBox=await terminalSurface.locator('.xterm-screen').boundingBox();await page.mouse.click(screenBox.x+30,screenBox.y+50,{button:'right'});await page.locator('#terminal-zoom-in').click();
    assert.equal(await page.evaluate(id=>EyaPanels.call(id,'getState').fontSize,terminal),font+1);assert.equal(Number(await page.locator('#font-size').inputValue()),font+1);
    await f.saved(page);let durable=(await f.snapshot()).workspaces.find(workspace=>workspace.id===workspaceId);assert.equal(durable.preferences.fontSize,font+1);assert.equal(durable.preferences.terminalLinkTarget,'external');
    await terminalSurface.getByRole('button',{name:'Terminal actions',exact:true}).click();await page.getByRole('menuitem',{name:'Zoom out',exact:true}).click();assert.equal(await page.evaluate(id=>EyaPanels.call(id,'getState').fontSize,terminal),font);
    await f.saved(page);durable=(await f.snapshot()).workspaces.find(workspace=>workspace.id===workspaceId);assert.equal(durable.preferences.fontSize,font);
    // Startup command runs after cd, once, with a path containing shell syntax.
    const startup=`printf '${octal('DIRECTORY_STARTUP')}\\n'`;await(await reveal(page,'#default-command')).fill(startup);await page.locator('#default-command').dispatchEvent('change',{bubbles:true});await page.locator('#close-settings').click();
    const files=await page.evaluate(cwd=>EyaPanels.create('files',{cwd}),directory);
    async function createdTerminal(action){const before=await panelIds();await action();await page.waitForFunction(before=>EyaPanels.layout().flatMap(group=>group.panels).some(id=>!before.includes(id)),before);const id=(await panelIds()).find(id=>!before.includes(id));await page.waitForFunction(id=>EyaPanels.call(id,'getState').connected,id);await page.waitForFunction(id=>EyaPanels.call(id,'getText','all').includes('DIRECTORY_STARTUP'),id);return id;}
    async function checkDirectory(id){
      await send(id,`printf '${octal('WORKFLOW_CWD=')}%s\\n' "$PWD"\r`);await page.waitForFunction(({id,expected})=>EyaPanels.call(id,'getText','all').includes('WORKFLOW_CWD='+expected),{id,expected:await fs.realpath(directory)});
      assert.equal((await read(id)).split('DIRECTORY_STARTUP').length-1,1,'Directory startup command must run once');
      await assert.rejects(fs.stat(path.join(f.files,'EYA_INJECTION')),{code:'ENOENT'});
    }
    for(const [id,selector] of [[files,'.file-instance'],['browser','#file-panel']]){
      await page.evaluate(({id,cwd})=>{EyaPanels.open(id);return EyaPanels.call(id,'navigate',cwd);},{id,cwd:directory});
      const filesSurface=page.locator(selector);await filesSurface.getByRole('button',{name:'Open directory in terminal',exact:true}).waitFor();
      const fromToolbar=await createdTerminal(()=>filesSurface.getByRole('button',{name:'Open directory in terminal',exact:true}).click());await checkDirectory(fromToolbar);
      await page.evaluate(({id,cwd})=>{EyaPanels.activate(id);return EyaPanels.call(id,'navigate',cwd);},{id,cwd:f.files});
      await filesSurface.getByRole('button',{name:'Actions for '+directoryName,exact:true}).click();const fromRow=await createdTerminal(()=>page.getByRole('menuitem',{name:'Open in terminal',exact:true}).click());await checkDirectory(fromRow);
    }
    assert.deepEqual(f.errors,[]);
    console.log('Built-client encrypted terminal links route to Browser/default or external/configured; menu font zoom persists; directory toolbar/row actions preserve quoted cwd and reject shell injection.');
  }finally{await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
