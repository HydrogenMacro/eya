const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Peer } = require('./workspace-protocol.cjs');
const { fixture } = require('./continuity-fixture.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  // A deliberately short browser TTL must never become a terminal deadline.
  const f = await fixture({ env: { EYA_SESSION_TTL_SECONDS: '1', EYA_SESSION_BUFFER_BYTES: '65536' } });
  const peers = [];
  const token = randomBytes(32).toString('hex');
  const terminal = create => {
    const peer = new Peer(f.url, 'eya-terminal-v1', 'eya-ready-v4:' + JSON.stringify({ token, output: 0, fresh: true, create, client: 'lifetime-test' }));
    peers.push(peer); return peer;
  };
  const control = () => {
    const peer = new Peer(f.url, 'eya-terminal-v1', 'eya-workspace-v1:{"client":null}');
    peers.push(peer); return peer;
  };
  let input = 0;
  async function command(peer, value) {
    const text = Buffer.from(value + '\n');
    const frame = Buffer.alloc(9 + text.length); frame[0] = 0;
    frame.writeBigUInt64BE(BigInt(input), 1); text.copy(frame, 9); input += text.length;
    peer.send(frame);
    await peer.wait(bytes => bytes[0] === 9 && Buffer.from(bytes).readBigUInt64BE(1) === BigInt(input));
  }
  async function contents(filename, predicate) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await fs.readFile(filename, 'utf8').catch(() => '');
      if (predicate(value)) return value;
      await delay(50);
    }
    throw Error(`Expected shell result missing: ${filename}`);
  }
  try {
    const cwd = path.join(f.files, "retained cwd 'with spaces'"); await fs.mkdir(cwd);
    const quoted = "'" + cwd.replaceAll("'", "'\\''") + "'";
    const first = terminal(true); assert.equal((await first.state()).resumed, false);
    await command(first, `stty -echo; cd -- ${quoted}; EYA_RETAINED_VALUE=still-here; printf '%s\\n' "$$" > ../shell-before; (sleep 2; printf done > ../detached-job) &`);
    const pid = (await contents(path.join(f.files, 'shell-before'), value => /^\d+\n$/.test(value))).trim();
    // There is no workspace/control socket or browser page keeping this alive.
    first.close(); await delay(3500);
    process.kill(Number(pid), 0);
    await contents(path.join(f.files, 'detached-job'), value => value === 'done');
    const second = terminal(false); const ready = await second.state();
    assert.equal(ready.state, 'ready'); assert.equal(ready.resumed, true);
    input = ready.nextInput;
    await command(second, `printf '%s\\n%s\\n%s\\n' "$$" "$PWD" "$EYA_RETAINED_VALUE" > ../shell-after`);
    assert.equal(await contents(path.join(f.files, 'shell-after'), value => value.endsWith('still-here\n')), `${pid}\n${cwd}\nstill-here\n`);
    second.close(); await delay(100);
    const service = control(); assert.equal((await service.state()).state, 'ready');
    const listed = await service.request('session.list');
    assert.equal(listed.terminalTtl, null);
    assert.equal(listed.browserTtl, 1);
    assert.equal(listed.sessions.find(session => session.id === token).status, 'detached');
    assert.equal((await service.request('session.end', { session: token })).ok, true);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!(await service.request('session.list')).sessions.some(session => session.id === token)) break;
      if (attempt === 99) throw Error('Explicit close did not release terminal slot');
      await delay(50);
    }
    assert.throws(() => process.kill(Number(pid), 0), error => error.code === 'ESRCH');
    const missing = terminal(false); assert.equal((await missing.state()).state, 'expired');
    console.log('No clients open: background job, shell PID/cwd/environment survive beyond TTL; detached discovery and explicit close cleanup passed');
  } finally {
    for (const peer of peers) peer.close();
    await f.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
