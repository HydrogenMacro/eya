const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { build } = require('esbuild');
const Module = require('node:module');
const { fixture } = require('./continuity-fixture.cjs');
const { Peer } = require('./workspace-protocol.cjs');
const encoder = new TextEncoder(), decoder = new TextDecoder();
const frame = value => Uint8Array.from([12, ...encoder.encode(JSON.stringify(value))]);
const parse = bytes => JSON.parse(decoder.decode(bytes.subarray(1)));
async function exchange(peer, op, id) {
  peer.send(frame({ v: 1, kind: 'request', id, op, future: { ignored: true } }));
  return parse(await peer.wait(bytes => bytes[0] === 12));
}
(async () => {
  const result = await build({ entryPoints: ['client/wire.js'], bundle: true, platform: 'node', format: 'cjs', write: false });
  const module = new Module('wire-tests'); module._compile(result.outputFiles[0].text, 'wire-tests.cjs');
  const { selectedCapabilities, receiveExtension } = module.exports;
  assert.deepEqual(selectedCapabilities({}), []);
  assert.deepEqual(selectedCapabilities({capabilities:['extensions-v1']}), ['extensions-v1']);
  assert.throws(() => selectedCapabilities({capabilities:['future-codec']}));
  receiveExtension(frame({v:1,kind:'event',op:'future.notice',future:true}), ['extensions-v1']);
  assert.throws(() => receiveExtension(frame({v:1,kind:'event',op:'future.notice',required:true}), ['extensions-v1']));
  assert.throws(() => receiveExtension(frame({v:1,kind:'event',op:'future.notice'}), []));
  const f = await fixture(), peers = [];
  const peer = confirmation => { const p = new Peer(f.url, 'eya-terminal-v1', confirmation); peers.push(p); return p; };
  try {
    const old = peer('eya-workspace-v1:{}'); const oldState = await old.state();
    assert.deepEqual(oldState.capabilities, []);
    assert.equal((await old.request('list', {path:f.files})).ok, true);
    const current = peer('eya-workspace-v1:' + JSON.stringify({ capabilities:['future-codec','extensions-v1'],future:true }));
    const state = await current.state(); assert.deepEqual(state.capabilities, ['extensions-v1']);
    assert.deepEqual(state.versions.update, [1]);
    const info = await exchange(current, 'protocol.info', 1); assert.equal(info.ok, true); assert.deepEqual(info.data.terminal,[1,2,3,4]);
    const unknown = await exchange(current, 'future.optimization', 2); assert.equal(unknown.id,2); assert.equal(unknown.error.code,'unsupported_operation');
    current.send(frame({v:1,kind:'event',op:'future.notice',payload:{codec:'unknown'}}));
    const ping=Uint8Array.from([3,0,0,0,0,0,0,0,0]);current.send(ping);
    assert.deepEqual([...await current.wait(bytes=>bytes[0]===3)],[...ping]);
    // Negotiation belongs to each attachment; a resumed terminal can drop it and stays raw.
    const token=randomBytes(32).toString('hex');
    const terminal = peer('eya-ready-v4:'+JSON.stringify({token,output:0,create:true,capabilities:['extensions-v1','future-codec']}));
    const ready=await terminal.state();assert.equal(ready.state,'ready');assert.deepEqual(ready.capabilities,['extensions-v1']);assert.equal(ready.compression,null);
    assert.equal((await exchange(terminal,'protocol.info',3)).ok,true);
    assert.equal((await exchange(terminal,'future.binary-format',4)).error.code,'unsupported_operation');
    terminal.close();
    const resumed=peer('eya-ready-v4:'+JSON.stringify({token,output:0,create:false,capabilities:['future-codec']}));
    const resumedState=await resumed.state();assert.equal(resumedState.resumed,true);assert.deepEqual(resumedState.capabilities,[]);assert.equal(resumedState.compression,null);
    assert.equal((await old.request('session.end',{session:token})).ok,true);
    const closed = new Promise(resolve => old.ws.addEventListener('close', resolve, {once:true}));
    old.send(frame({v:1,kind:'event',op:'unnegotiated'}));
    await Promise.race([closed,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('Unnegotiated extension not rejected')),3000);t.unref();})]);
    console.log('Wire compatibility: legacy baseline, offer/selection intersection, future members/events, correlated errors, terminal resume fallback and unnegotiated rejection passed');
  } finally {for(const peer of peers)peer.close();await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
