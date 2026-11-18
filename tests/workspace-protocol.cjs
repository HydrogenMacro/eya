const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const Noise = require('noise-handshake');
const Cipher = require('noise-handshake/cipher');
const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const encoder = new TextEncoder(), decoder = new TextDecoder();
const random = () => require('node:crypto').randomBytes(32).toString('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class Peer {
  constructor(url, prologue, confirmation) {
    this.queue = []; this.waiters = []; this.nextId = 1;
    const noise = new Noise('NNpsk0', true, null, { psk: key }); noise.initialise(encoder.encode(prologue));
    this.ws = new WebSocket(url); this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => this.ws.send(noise.send());
    this.ws.onmessage = event => {
      try {
        const bytes = new Uint8Array(event.data);
        if (!this.rx) { noise.recv(bytes); this.rx = new Cipher(noise.rx); this.tx = new Cipher(noise.tx); this.send(encoder.encode(confirmation)); return; }
        const plain = this.rx.decrypt(bytes); this.queue.push(plain); this.drain();
      } catch (error) { for (const waiter of this.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); } }
    };
  }
  send(bytes) { this.ws.send(this.tx.encrypt(bytes)); }
  drain() {
    for (const waiter of [...this.waiters]) {
      const index = this.queue.findIndex(waiter.predicate);
      if (index < 0) continue;
      const [value] = this.queue.splice(index, 1); this.waiters.splice(this.waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(value);
    }
  }
  wait(predicate = () => true) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: setTimeout(() => { this.waiters.splice(this.waiters.indexOf(waiter), 1); reject(Error('Protocol response timed out')); }, 10000) };
      this.waiters.push(waiter); this.drain();
    });
  }
  async state() { return JSON.parse(decoder.decode((await this.wait(bytes => bytes[0] === 7)).subarray(1))); }
  async request(op, values = {}) {
    const id = this.nextId++; this.send(Uint8Array.from([4, ...encoder.encode(JSON.stringify({ ...values, id, op }))]));
    const chunks = [];
    for (;;) {
      const bytes = await this.wait(bytes => (bytes[0] === 4 && JSON.parse(decoder.decode(bytes.subarray(1))).id === id) || (bytes[0] === 6 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(1) === id));
      if (bytes[0] === 4) return JSON.parse(decoder.decode(bytes.subarray(1)));
      chunks.push(Buffer.from(bytes.subarray(6)));
      if (bytes[5]) return JSON.parse(Buffer.concat(chunks).toString());
    }
  }
  close() { this.ws.close(); }
}
module.exports = { Peer };
if (require.main === module) (async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eya-workspace-protocol-'));
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const server = spawn(path.resolve('eya-server/target/debug/eya-server'), [], { env: { ...process.env, EYA_KEY: key.toString('hex'), EYA_BIND: `127.0.0.1:${port}`, EYA_CWD: directory, EYA_STATE_DIR: path.join(directory, 'state'), EYA_SESSION_TTL_SECONDS: '3', EYA_BROWSER_CHROMIUM: '/nonexistent/eya-test-chromium' }, stdio: ['ignore', 'ignore', 'pipe'] });
  const peers = [];
  const peer = (...args) => { const instance = new Peer(...args); peers.push(instance); return instance; };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Server startup timed out')), 10000);
      server.once('error', reject); server.once('exit', code => { clearTimeout(timer); reject(Error(`Server exited ${code}`)); });
      server.stderr.on('data', data => { if (String(data).includes('Eya listening')) { clearTimeout(timer); resolve(); } });
    });
    const control = peer(`ws://127.0.0.1:${port}/ws`, 'eya-terminal-v1', 'eya-workspace-v1:{}');
    const initial = await control.state(); assert.equal(initial.state, 'ready');
    const otherControl = peer(`ws://127.0.0.1:${port}/ws`, 'eya-terminal-v1', 'eya-workspace-v1:{}');
    const otherInitial = await otherControl.state();
    assert.notEqual(initial.workspace.id, otherInitial.workspace.id);
    const scoped = await control.request('workspace.list', { client: otherInitial.client });
    assert.deepEqual(scoped.workspaces.map(workspace => workspace.id), [initial.workspace.id], 'Workspace listings scope anonymous records to the authenticated connection, ignoring supplied client IDs');
    const minimized = { id: 'future-tab', kind: 'future-panel', title: 'Background view', minimized: true, config: {} };
    const updated = await control.request('workspace.update', { workspace: initial.workspace.id, revision: initial.workspace.revision, tabs: [minimized], layout: initial.workspace.layout });
    assert.equal(updated.ok, true); assert.equal(updated.workspace.tabs[0].minimized, true);
    await assert.rejects(fs.access(path.join(directory, 'state', 'workspaces.json')), { code: 'ENOENT' }, 'Anonymous metadata must not be written to disk');
    const saved = await control.request('workspace.rename', { workspace: initial.workspace.id, revision: updated.workspace.revision, name: 'Protocol workspace' });
    assert.equal(saved.ok, true);
    const disk = JSON.parse(await fs.readFile(path.join(directory, 'state', 'workspaces.json'), 'utf8'));
    assert.equal(disk.workspaces.length, 1); assert.equal(disk.workspaces[0].tabs[0].minimized, true);
    assert.equal(disk.workspaces[0].name, 'Protocol workspace');
    assert.equal((await otherControl.request('workspace.list')).workspaces.length, 2, 'Other clients see saved workspaces plus their own anonymous workspace');
    assert.deepEqual((await control.request('session.list')).sessions, []);
    assert.equal((await control.request('list', { path: directory })).ok, true);
    assert.equal((await control.request('system.stats')).ok, true);
    assert.deepEqual((await control.request('session.list')).sessions, [], 'File and machine operations must not create PTYs');
    const canceled = random();
    assert.equal((await control.request('session.end', { session: canceled })).ok, true);
    const lateTerminal = peer(`ws://127.0.0.1:${port}/ws`, 'eya-terminal-v1', 'eya-ready-v4:' + JSON.stringify({ token: canceled, output: 0, create: true, client: initial.client }));
    assert.equal((await lateTerminal.state()).state, 'ended', 'An end arriving before create must fence the late create');
    const lateBrowser = peer(`ws://127.0.0.1:${port}/browser-render-ws`, 'eya-browser-render-v1', 'eya-browser-session-v1:' + JSON.stringify({ session: canceled, client: initial.client, create: true }));
    assert.equal(JSON.parse(decoder.decode(await lateBrowser.wait())).state, 'expired');
    console.log('PTY-free workspace services passed');
    const token = random();
    const terminal = (client, extra = {}) => peer(`ws://127.0.0.1:${port}/ws`, 'eya-terminal-v1', 'eya-ready-v4:' + JSON.stringify({ token, output: 0, create: false, client, ...extra }));
    const first = terminal(initial.client, { create: true }); assert.equal((await first.state()).state, 'ready');
    const denied = terminal('second-client', { fresh: true }); assert.equal((await denied.state()).state, 'in-use');
    const takeover = terminal('second-client', { fresh: true, takeover: true }); assert.equal((await takeover.state()).state, 'ready');
    assert.equal((await first.state()).state, 'taken-over');
    takeover.close(); await delay(100);
    const recovered = terminal('third-client', { fresh: true }); assert.equal((await recovered.state()).state, 'ready');
    const listed = await control.request('session.list'); assert.equal(listed.sessions.find(session => session.id === token).client, 'third-client');
    assert.equal((await control.request('session.end', { session: token })).ok, true);
    assert.equal((await recovered.state()).state, 'ended');
    assert.equal((await control.request('session.end', { session: token })).ok, true, 'Ending an already ended session is idempotent');
    console.log('Terminal ownership and takeover passed');

    const browserId = random();
    const browser = (client, extra = {}) => peer(`ws://127.0.0.1:${port}/browser-render-ws`, 'eya-browser-render-v1', 'eya-browser-session-v1:' + JSON.stringify({ session: browserId, client, create: false, ...extra }));
    const browserState = async peer => JSON.parse(decoder.decode(await peer.wait()));
    const browserFirst = browser(initial.client, { create: true }); assert.equal((await browserState(browserFirst)).state, 'ready');
    // Chromium startup errors must be explicit, and the session remains manageable.
    browserFirst.send(Uint8Array.of(1)); const startup = await browserFirst.wait(bytes => bytes[0] === 129);
    assert.match(JSON.parse(decoder.decode(startup.subarray(1))).message, /EYA_BROWSER_CHROMIUM/);
    const browserDenied = browser('second-client'); assert.equal((await browserState(browserDenied)).state, 'in-use');
    const browserTakeover = browser('second-client', { takeover: true }); assert.equal((await browserState(browserTakeover)).resumed, true);
    assert.equal(JSON.parse(decoder.decode((await browserFirst.wait(bytes => bytes[0] === 129)).subarray(1))).type, 'taken-over');
    browserTakeover.close(); await delay(100);
    const browserRecovered = browser('third-client'); assert.equal((await browserState(browserRecovered)).state, 'ready');
    assert.equal((await control.request('session.list')).sessions.find(session => session.id === browserId).status, 'attached');
    browserRecovered.close(); await delay(4200);
    assert.equal((await control.request('session.list')).sessions.some(session => session.id === browserId), false, 'Detached browser expires');
    const expired = browser('fourth-client'); assert.equal((await browserState(expired)).state, 'expired');
    assert.equal((await control.request('workspace.list')).workspaces.length, 1, 'Another client’s anonymous workspace is not listed');
    console.log('Workspace protocol: ephemeral/scoped anonymous metadata, explicit save, minimized descriptors, PTY-free services, terminal/browser exclusivity, takeover/end, detach/resume, startup errors and expiry passed');
  } finally {
    for (const peer of peers) peer.close();
    if (server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
