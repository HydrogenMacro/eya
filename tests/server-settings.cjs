const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { fixture } = require('./continuity-fixture.cjs');
const { Peer } = require('./workspace-protocol.cjs');
const encoder = new TextEncoder();
if(process.env.EYA_TEST_TRACE)for(const name of ['request','state']){const original=Peer.prototype[name];Peer.prototype[name]=async function(...args){console.log('start',name,...args);const result=await original.apply(this,args);console.log('done',name,JSON.stringify(result).slice(0,180));return result;};}
const random = () => randomBytes(32).toString('hex');
(async () => {
  const f = await fixture({env:{EYA_TERMINAL_SESSIONS:'3',EYA_FULL_BROWSER_SESSIONS:'3',EYA_BROWSER_CHROMIUM:'/nonexistent/eya-test-chromium'}}), peers = [];
  const peer = (confirmation, browser = false) => { const p = new Peer(browser ? f.url.replace('/ws','/browser-render-ws') : f.url,browser ? 'eya-browser-render-v1':'eya-terminal-v1',confirmation);peers.push(p);return p; };
  const workspace = capabilities => peer('eya-workspace-v1:'+JSON.stringify({capabilities}));
  try {
    const old = workspace([]); assert.deepEqual((await old.state()).capabilities,[]);
    assert.match((await old.request('server.config.get')).error,/unsupported_feature/);
    assert.equal((await old.request('list',{path:f.files})).ok,true);
    const generic = workspace(['extensions-v1','future-unknown']);assert.deepEqual((await generic.state()).capabilities,['extensions-v1']);
    assert.match((await generic.request('server.config.set',{revision:1,settings:{terminalSessions:1}})).error,/unsupported_feature/);
    const current = workspace(['extensions-v1','server-config-v1','future-unknown']);
    const ready = await current.state();assert.deepEqual(ready.capabilities,['extensions-v1','server-config-v1']);
    let config = await current.request('server.config.get',{future:true});assert.equal(config.ok,true);assert.equal(config.settings.terminalSessions,3);assert.equal(config.scope,'process');
    assert.ok(!JSON.stringify(config).includes('0001020304050607'),'Settings never include the shared secret');
    const terminals = [random(),random()];
    const openTerminal = (token,create=true) => peer('eya-ready-v4:'+JSON.stringify({token,output:0,create}));
    for (const token of terminals) assert.equal((await openTerminal(token).state()).state,'ready');
    const browsers=[random(),random()];
    const openBrowser = (id,create=true) => peer('eya-browser-session-v1:'+JSON.stringify({session:id,client:ready.client,create}),true);
    const browserState = async p => JSON.parse(new TextDecoder().decode(await p.wait()));
    for(const id of browsers)assert.equal((await browserState(openBrowser(id))).state,'ready');
    config = await current.request('server.config.get');assert.equal(config.usage.terminalSessions,2);assert.equal(config.usage.fullBrowserSessions,2);
    const revision=config.revision;
    const applied = await current.request('server.config.set',{revision,settings:{terminalSessions:1,fullBrowserSessions:1,machineJobs:5},future:{ignored:true}});
    assert.equal(applied.ok,true);assert.equal(applied.usage.terminalSessions,2);assert.equal(applied.usage.fullBrowserSessions,2);
    assert.equal((await openTerminal(random()).state()).state,'full');assert.equal((await browserState(openBrowser(random()))).state,'full');
    assert.equal((await openTerminal(terminals[0],false).state()).state,'ready','Existing terminal can reattach above the lower quota');
    assert.equal((await browserState(openBrowser(browsers[0],false))).state,'ready','Existing browser can reattach above the lower quota');
    const listed=await current.request('session.list');assert.ok(terminals.every(id=>listed.sessions.some(session=>session.id===id)));
    assert.equal((await current.request('server.config.set',{revision,settings:{terminalSessions:4}})).ok,false,'Stale updates reject');
    assert.equal((await current.request('server.config.set',{revision:applied.revision,settings:{terminalSessions:4,machineJobs:99999}})).ok,false,'Invalid changes reject atomically');
    assert.equal((await current.request('server.config.get')).settings.terminalSessions,1);
    for(const id of [...terminals,...browsers])assert.equal((await current.request('session.end',{session:id})).ok,true);
    const waitUntil=Date.now()+3000;while((await current.request('server.config.get')).usage.terminalSessions>0&&Date.now()<waitUntil)await new Promise(resolve=>setTimeout(resolve,20));
    const created=random();assert.equal((await openTerminal(created).state()).state,'ready','New sessions resume below the quota');await current.request('session.end',{session:created});
    await f.stop();for(const p of peers)p.close();await f.start();
    const restarted=workspace(['extensions-v1','server-config-v1']);await restarted.state();assert.equal((await restarted.request('server.config.get')).settings.terminalSessions,3,'Restart restores environment defaults');
    console.log('Server settings: negotiated access, legacy fallback, live quotas, retained sessions/resume, atomic validation, revision conflicts and restart defaults passed');
  } finally { for(const p of peers)p.close();await f.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
