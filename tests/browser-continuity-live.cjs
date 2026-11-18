// Real Chromium, real Noise sockets, no network page fixtures or production server.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');
const { fixture, KEY } = require('./continuity-fixture.cjs');
const { Peer } = require('./workspace-protocol.cjs');

(async () => {
  const executable = process.env.EYA_BROWSER_EXECUTABLE || chromium.executablePath();
  const f = await fixture({ env: { EYA_BROWSER_CHROMIUM: executable, EYA_SESSION_TTL_SECONDS: '3' } });
  let control; const transports = [];
  async function children() {
    // Tokio can spawn Chromium on any worker thread; Linux records children
    // under the spawning task, rather than only the process's main task.
    const ids = new Set();
    for (const task of await fs.readdir(`/proc/${f.pid}/task`)) {
      try { for (const id of (await fs.readFile(`/proc/${f.pid}/task/${task}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean)) ids.add(id); } catch { /* Worker exited. */ }
    }
    const result = [];
    for (const pid of ids) {
      try {
        const argv = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
        const profile = argv.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
        if (profile) result.push({ pid, profile });
      } catch { /* Short-lived helper exited. */ }
    }
    return result;
  }
  try {
    const source = path.resolve('client/browser-transport.js');
    const bundled = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false, alias: { 'sodium-native': path.resolve('client/node_modules/sodium-javascript/index.js') } });
    const loaded = new Module(source, module); loaded.filename = source; loaded.paths = Module._nodeModulePaths(path.dirname(source)); loaded._compile(bundled.outputFiles[0].text, source);
    control = new Peer(f.url, 'eya-terminal-v1', 'eya-workspace-v1:{}'); const initial = await control.state();
    const connect = async (sessionId, client = initial.client, takeover = false) => {
      let transport;
      transport = await loaded.exports.createBrowserRenderTransport({ url: f.url, key: KEY, persistent: true, sessionId, client, takeover, createSession: !sessionId, onFrame: (bytes, meta) => transport?.ack(meta.seq) });
      transports.push(transport); return transport;
    };
    const first = await connect(); await first.start(); await first.activateTab('continuity-tab');
    const original = await children(); assert.equal(original.length, 1);
    const initialized = await first.evaluate('continuity-tab', "window.__continuity='retained'; document.body.innerHTML='<input id=retained value=unchanged>'; 'initialized'");
    assert.ok(!initialized.exception);
    const id = first.sessionId;
    assert.equal((await control.request('session.list')).sessions.find(session => session.id === id).started, true);
    await assert.rejects(connect(id, 'another-client'), error => error.code === 'in-use');
    first.close({ detach: true });
    const second = await connect(id); await second.start();
    assert.equal(second.sessionState.resumed, true); assert.ok(second.sessionState.tabs.some(tab => tab.id === 'continuity-tab'));
    await second.activateTab('continuity-tab');
    const retained = await second.evaluate('continuity-tab', "window.__continuity + ':' + document.getElementById('retained').value");
    assert.equal(retained.result, 'retained:unchanged');
    assert.deepEqual(await children(), original, 'Reattachment retains the same browser PID and private profile');
    const takeover = await connect(id, 'another-client', true); await takeover.start(); await takeover.activateTab('continuity-tab');
    assert.equal((await takeover.evaluate('continuity-tab', 'window.__continuity')).result, 'retained');
    const independent = await connect(); await independent.start(); await independent.activateTab('other-tab');
    const processes = await children(); assert.equal(processes.length, 2);
    assert.equal(new Set(processes.map(process => process.profile)).size, 2);
    assert.equal((await independent.evaluate('other-tab', 'typeof window.__continuity')).result, 'undefined', 'Two browser processes must have independent pages/profiles');
    await control.request('session.end', { session: id }); await control.request('session.end', { session: independent.sessionId });
    for (let attempt = 0; attempt < 60; attempt++) {
      if (!(await control.request('session.list')).sessions.some(session => session.kind === 'browser')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal((await control.request('session.list')).sessions.some(session => session.kind === 'browser'), false);
    for (const process of processes) { await assert.rejects(fs.stat(process.profile), { code: 'ENOENT' }, 'Chromium profile was not removed'); await assert.rejects(fs.stat(`/proc/${process.pid}`), { code: 'ENOENT' }, 'Chromium process was not reaped'); }
    const expiring = await connect(); await expiring.start(); await expiring.activateTab('animating-tab');
    await expiring.evaluate('animating-tab', "setInterval(()=>document.body.style.background=`rgb(${Math.random()*255},0,0)`,20); 'animating'");
    expiring.close({ detach: true });
    await new Promise(resolve => setTimeout(resolve, 4200));
    assert.equal((await control.request('session.list')).sessions.some(session => session.id === expiring.sessionId), false, 'An animating detached page must still expire');
    const last = await connect(); await last.start(); const lastProcesses = await children();
    const lastId = last.sessionId; control.close(); await f.stop();
    for (const process of lastProcesses) { await assert.rejects(fs.stat(process.profile), { code: 'ENOENT' }, 'Chromium profile was not removed'); await assert.rejects(fs.stat(`/proc/${process.pid}`), { code: 'ENOENT' }, 'Chromium process was not reaped'); }
    await f.start();
    await assert.rejects(connect(lastId), error => error.code === 'expired');
    console.log('Real Chromium continuity: retained DOM/PID/profile, exclusive takeover, independent processes, animated-page expiry, explicit cleanup and server restart passed');
  } finally { for (const transport of transports) transport.close({ detach: true }); control?.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
