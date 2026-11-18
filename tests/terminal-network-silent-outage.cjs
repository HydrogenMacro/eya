// Real silent network failure in a private namespace. Build client/server first.
// NODE_PATH=client/node_modules node tests/terminal-network-silent-outage.cjs
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'), nativeFs=require('node:fs');
const {execFileSync}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const {fixture}=require('./continuity-fixture.cjs');
const run=(name,args)=>execFileSync(name,args,{stdio:['ignore','pipe','pipe']});
(async()=>{
  const current=await fs.readlink('/proc/self/ns/net');
  if(!process.env.EYA_SILENT_CHILD){const fd=nativeFs.openSync('/proc/self/ns/net','r');try{execFileSync('unshare',['--user','--map-root-user','--net',process.execPath,__filename],{env:{...process.env,EYA_SILENT_CHILD:'1'},stdio:['inherit','inherit','inherit',fd]});}finally{nativeFs.closeSync(fd);}return;}
  const parent=await fs.readlink('/proc/self/fd/3');assert.match(parent,/^net:\[\d+\]$/);assert.notEqual(current,parent);
  run('ip',['link','set','lo','up']);const f=await fixture({env:{EYA_SESSION_TTL_SECONDS:'120'}});
  let shaped=false;
  const clear=()=>{if(shaped){run('tc',['qdisc','del','dev','lo','root']);shaped=false;}};
  try{
    const page=await f.client({webgl:false});const id=await page.evaluate(()=>EyaPanels.create('terminal'));
    await page.waitForFunction(id=>EyaPanels.call(id,'getState').connected,id);
    await page.evaluate(id=>EyaPanels.call(id,'sendInput',"stty -echo; EYA_OUTAGE_PID=$$; printf 'EYA_OUTAGE_READY\\n'\r"),id);
    await page.locator('.xterm-screen').filter({hasText:'EYA_OUTAGE_READY'}).waitFor();
    await f.saved(page);
    const original=await page.evaluate(()=>EyaWorkspaces.getState().workspace);
    // Let all earlier callbacks/ACKs settle before dropping every TCP packet.
    await page.waitForTimeout(100);
    run('tc',['qdisc','add','dev','lo','root','netem','loss','100%']);shaped=true;
    const start=performance.now();let state;
    for(;;){
      state=await page.evaluate(id=>({terminal:EyaPanels.call(id,'getState'),workspaceStatus:document.querySelector('#status').textContent,sockets:window.__sockets.map(socket=>socket.readyState)}),id);
      if(!state.terminal.connected||performance.now()-start>36000)break;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    console.log(JSON.stringify({noProgressMs:performance.now()-start,...state}));
    assert.equal(state.terminal.connected,false,'The heartbeat must leave a dead attachment without waiting for the native WebSocket close handshake');
    assert.notEqual(state.workspaceStatus,'Connected','Workspace services must also leave a silent closing socket');
    await page.evaluate(id=>EyaPanels.call(id,'sendInput',"test \"$EYA_OUTAGE_PID\" = \"$$\" && printf 'EYA_SILENT_RECOVERED\\n'\r"),id);
    clear();const resume=performance.now();
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await page.locator('.xterm-screen').filter({hasText:'EYA_SILENT_RECOVERED'}).waitFor({timeout:30000});
    await page.waitForFunction(id=>EyaPanels.call(id,'getState').pendingInput===0,id);
    await page.waitForFunction(()=>document.querySelector('#status').textContent==='Connected');
    const recovered=await page.evaluate(()=>EyaWorkspaces.getState().workspace);
    assert.equal(recovered.id,original.id);
    assert.equal(recovered.tabs.find(tab=>tab.id===id).session,original.tabs.find(tab=>tab.id===id).session);
    assert.deepEqual(f.errors,[]);console.log(`Silent TCP outage retained the shell, retried within the progress deadline, and resumed in ${Math.round(performance.now()-resume)}ms`);
  }finally{clear();await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
