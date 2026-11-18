const assert = require('node:assert/strict');
const { fixture } = require('./continuity-fixture.cjs');
const { Peer } = require('./workspace-protocol.cjs');
const octal = value => [...value].map(char => `\\${char.charCodeAt(0).toString(8).padStart(3, '0')}`).join('');
(async () => {
  const f = await fixture(); let control, sender;
  try {
    const first = await f.client({ webgl: false }); await f.named(first, 'Terminal fixture');
    const id = await first.evaluate(() => EyaPanels.create('terminal'));
    await first.waitForFunction(id => EyaPanels.call(id, 'getState').connected, id);
    await f.saved(first);
    const workspace = await first.evaluate(() => EyaWorkspaces.getState().workspace);
    const session = workspace.tabs.find(tab => tab.id === id).session;
    await first.evaluate(({ id, script }) => EyaPanels.call(id, 'sendInput', script), { id, script: `stty -echo -icanon; printf '${octal('INPUT_BLOCKED')}\\n'; sleep 6; head -c 100000 >/dev/null; stty -echo icanon; printf '${octal('INPUT_DRAINED')}\\n'\r` });
    await first.locator('.xterm-screen').filter({ hasText: 'INPUT_BLOCKED' }).waitFor();
    control = new Peer(f.url, 'eya-terminal-v1', 'eya-workspace-v1:{}'); await control.state();
    // Normal clients intentionally pace large pastes now. Inject accepted-but-
    // unwritten bytes through a protocol peer so this test still covers a fresh
    // renderer's nextInput cursor rather than unsent page-owned paste bytes.
    const owner = (await control.request('session.list')).sessions.find(item => item.id === session).client;
    sender = new Peer(f.url, 'eya-terminal-v1', 'eya-ready-v4:' + JSON.stringify({ token: session, client: owner, fresh: true, create: false, output: 0 }));
    const state = await sender.state(); assert.equal(state.state, 'ready');
    for (let position = 0; position < 100000; position += 60000) {
      const size = Math.min(60000, 100000 - position), bytes = Buffer.alloc(9 + size, 'x'); bytes[0] = 0;
      bytes.writeBigUInt64BE(BigInt(state.nextInput + position), 1); sender.send(bytes);
    }
    let queued = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      queued = (await control.request('session.list')).sessions.find(item => item.id === session)?.queuedInput || 0;
      if (queued >= 100000) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(queued >= 100000, 'The actor has accepted input which has not reached the PTY writer yet');
    sender.close(); await first.context().close();
    const second = await f.client({ type: 'svg', webgl: false }); await second.evaluate(id => EyaWorkspaces.open(id), workspace.id);
    await second.waitForFunction(id => EyaPanels.call(id, 'getState').connected, id);
    await second.evaluate(({ id, command }) => EyaPanels.call(id, 'sendInput', command), { id, command: `printf '${octal('NEW_CLIENT_INPUT_SURVIVED')}\\n'\r` });
    await second.locator('.xterm-screen').filter({ hasText: 'NEW_CLIENT_INPUT_SURVIVED' }).waitFor({ timeout: 15000 });
    assert.equal(await second.evaluate(id => EyaPanels.call(id, 'getState').connected, id), true);
    assert.deepEqual(f.errors, []);
    await second.evaluate(id => EyaPanels.close(id), id);
    console.log('Fresh terminal attachment appends input after accepted-but-unwritten bytes without dropping or duplicating keystrokes');
  } finally { sender?.close(); control?.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
