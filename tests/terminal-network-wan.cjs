// Real TCP delay/loss/rate experiments. Never alters the host network.
// Run inside a private netns after building client/server:
// NODE_PATH=client/node_modules node tests/terminal-network-wan.cjs
// The driver re-execs itself through unshare before touching any interface.
// EYA_WAN_QUICK=1 runs a representative subset. Default runs the full matrix.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { fixture } = require('./continuity-fixture.cjs');
const { Peer } = require('./workspace-protocol.cjs');
const ticks = Number(command('getconf', ['CLK_TCK']));
async function usage(pid) {
  const [stat, status] = await Promise.all([fs.readFile(`/proc/${pid}/stat`, 'utf8'), fs.readFile(`/proc/${pid}/status`, 'utf8')]);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { cpuMs: (Number(fields[11]) + Number(fields[12])) * 1000 / ticks, rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0), highWaterKiB: Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1] || 0) };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
function command(binary, args) { return execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
(async () => {
  const namespace = await fs.readlink('/proc/self/ns/net');
  if (!process.env.EYA_WAN_CHILD) {
    const parentNamespace = fsSync.openSync('/proc/self/ns/net', 'r');
    try {
      execFileSync('unshare', ['--user', '--map-root-user', '--net', process.execPath, __filename], { env: { ...process.env, EYA_WAN_CHILD: '1' }, stdio: ['inherit', 'inherit', 'inherit', parentNamespace] });
    } finally { fsSync.closeSync(parentNamespace); }
    return;
  }
  // The inherited descriptor pins the actual launching namespace. An
  // accidentally inherited environment flag cannot bypass this check.
  const parentNamespace = await fs.readlink('/proc/self/fd/3');
  assert.match(parentNamespace, /^net:\[\d+\]$/);
  assert.notEqual(namespace, parentNamespace, 'Refusing to change the launching network namespace');
  command('ip', ['link', 'set', 'lo', 'up']);
  const f = await fixture({ env: { EYA_SESSION_TTL_SECONDS: '120', EYA_SESSION_BUFFER_BYTES: '65536' } });
  const sourceHashes = Object.fromEntries(await Promise.all(['eya-server/src/main.rs', 'eya-server/src/resume.rs', 'client/terminal-panel.js', 'client/terminal-network.js', 'client/terminal-codec.js', 'client.html', 'tests/terminal-network-wan.cjs'].map(async name => [name, require('node:crypto').createHash('sha256').update(await fs.readFile(name)).digest('hex')])));
  const report = { producedAtUtc: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, kernel: require('node:os').release(), node: process.version, sourceHashes, serverConfiguration: { sessionTtlSeconds: 120, detachedReplayBytes: 65536, compression: 'auto' }, method: 'Linux netem in private user/network namespace; real TCP loss recovery, independent per-port-direction qdiscs', samplesPerProfile: 12, profiles: [] };
  let control, controlHeartbeat;
  function shape({ rtt, kbit, loss = 0, jitter = 0, reorder = false }) {
    try { command('tc', ['qdisc', 'del', 'dev', 'lo', 'root']); } catch {}
    command('tc', ['qdisc', 'add', 'dev', 'lo', 'root', 'handle', '1:', 'prio', 'bands', '3', 'priomap', ...Array(16).fill('2')]);
    for (const [band, direction] of [[1, 'dport'], [2, 'sport']]) {
      const args = ['qdisc', 'add', 'dev', 'lo', 'parent', `1:${band}`, 'handle', `${band}0:`, 'netem', 'limit', '1000', 'delay', `${rtt / 2}ms`];
      if (jitter) args.push(`${jitter}ms`, 'distribution', 'normal');
      if (loss) args.push('loss', `${loss}%`);
      if (reorder) args.push('reorder', '10%', '50%');
      args.push('rate', `${kbit}kbit`, 'seed', String(12345 + band)); command('tc', args);
      command('tc', ['filter', 'add', 'dev', 'lo', 'parent', '1:', 'protocol', 'ip', 'prio', String(band), 'u32', 'match', 'ip', 'protocol', '6', '0xff', 'match', 'ip', direction, String(f.port), '0xffff', 'flowid', `1:${band}`]);
    }
  }
  const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  try {
    await fs.writeFile(path.join(f.files, 'network_bench.py'), `import sys, signal, codecs\nseq=0\ndef stop(sig, frame):\n print('EYA_STOPPED',flush=True); raise SystemExit(0)\nsignal.signal(signal.SIGINT,stop)\nprint('EYA_BENCH_READY',flush=True)\ndec=codecs.getincrementaldecoder('utf-8')()\nwhile True:\n data=sys.stdin.buffer.read(1)\n if not data: break\n text=dec.decode(data)\n for char in text:\n  if char=='l':\n   while True: sys.stdout.write('LOAD_LINE_0000 INFO live output continues until Ctrl-C\\r\\n'); sys.stdout.flush()\n  elif char=='b':\n   for n in range(400): sys.stdout.write('BULK_LINE_%04d INFO workspace terminal retained output cpu=12%% mem=256MiB\\r\\n'%n)\n   print('EYA_BULK_DONE',flush=True)\n  else:\n   seq+=1; print('EYA_KEY_%d:%s'%(seq,char),flush=True)\n`);
    control = new Peer(f.url, 'eya-terminal-v1', 'eya-workspace-v1:{}'); await control.state();
    controlHeartbeat = setInterval(() => {
      control.queue = control.queue.filter(bytes => bytes[0] !== 3);
      if (control.ws.readyState === WebSocket.OPEN) control.send(Uint8Array.of(3, 0, 0, 0, 0, 0, 0, 0, 0));
    }, 5000);
    const selectedProfiles = process.env.EYA_WAN_PROFILE && JSON.parse(process.env.EYA_WAN_PROFILE);
    const profiles = selectedProfiles ? (Array.isArray(selectedProfiles) ? selectedProfiles : [selectedProfiles]) : process.env.EYA_WAN_QUICK ? [{ rtt: 0, kbit: 256 }, { rtt: 250, kbit: 64 }, { rtt: 600, kbit: 32, jitter: 15, loss: 1 }] : [
      ...[0, 80, 250, 600].flatMap(rtt => [32, 64, 256].map(kbit => ({ rtt, kbit }))),
      { rtt: 250, kbit: 64, jitter: 20, loss: 1, reorder: true },
      { rtt: 600, kbit: 32, jitter: 15, loss: 1 },
      { rtt: 250, kbit: 64, competing: true },
    ];
    for (const profile of profiles) for (const compression of [false, true]) {
      // Authenticate on the clean link, then shape the established TCP path.
      try { command('tc', ['qdisc', 'del', 'dev', 'lo', 'root']); } catch {}
      const page = await f.client({ webgl: false, terminalCompression: compression });
      report.chromium = page.context().browser().version();
      const id = await page.evaluate(() => EyaPanels.create('terminal'));
      await page.waitForFunction(id => EyaPanels.call(id, 'getState').connected, id);
      const screen = '.instance-terminal .xterm-screen';
      const send = value => page.evaluate(({ id, value }) => EyaPanels.call(id, 'sendInput', value), { id, value });
      const wait = text => page.locator(screen).filter({ hasText: text }).waitFor({ timeout: 120000 });
      // Observe real renderer mutations in-page; Playwright polling intervals
      // must not become part of the key-to-authoritative-echo measurement.
      const measure = (value, text) => page.evaluate(({ id, value, text }) => new Promise((resolve, reject) => {
        const surface = document.querySelector('.instance-terminal .xterm-screen'), start = performance.now();
        const observer = new MutationObserver(() => {
          if (!surface.textContent.includes(text)) return;
          observer.disconnect(); clearTimeout(timer); resolve(performance.now() - start);
        });
        const timer = setTimeout(() => { observer.disconnect(); reject(Error(`No authoritative output: ${text}`)); }, 120000);
        observer.observe(surface, { subtree: true, childList: true, characterData: true });
        if (!EyaPanels.call(id, 'sendInput', value)) { observer.disconnect(); clearTimeout(timer); reject(Error('Input rejected')); }
      }), { id, value, text });
      await send(`stty -echo -icanon; python3 -u ${shellQuote(path.join(f.files, 'network_bench.py'))}; stty sane\r`); await wait('EYA_BENCH_READY');
      await f.saved(page);
      const session = await page.evaluate(id => EyaWorkspaces.getState().workspace.tabs.find(tab => tab.id === id).session, id);
      await page.evaluate(() => {
        window.__wan = { downBytes: 0, downMessages: 0, upBytes: 0, upMessages: 0 };
        const ws = window.__sockets.at(-1), send = ws.send.bind(ws);
        ws.send = bytes => { window.__wan.upBytes += bytes.byteLength + (bytes.byteLength < 126 ? 6 : 8); window.__wan.upMessages++; return send(bytes); };
        ws.addEventListener('message', event => { const n = event.data.byteLength; window.__wan.downBytes += n + (n < 126 ? 2 : 4); window.__wan.downMessages++; });
      });
      const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
      const beforeCpu = await usage(f.pid), beforeClient = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
      let competitor, competingDone = false, competingDrain;
      if (profile.competing) {
        const token = require('node:crypto').randomBytes(32).toString('hex');
        competitor = new Peer(f.url, 'eya-terminal-v1', 'eya-ready-v4:' + JSON.stringify({ token, output: 0, create: true }));
        const ready = await competitor.state(); assert.equal(ready.state, 'ready');
        const input = Buffer.from('stty -echo; yes\r'), frame = Buffer.alloc(9 + input.length); frame[0] = 0; input.copy(frame, 9); competitor.send(frame);
        competingDrain = (async () => {
          try { while (!competingDone) {
            const bytes = Buffer.from(await competitor.wait());
            if (bytes[0] !== 8) continue;
            const ack = Buffer.alloc(9); ack[0] = 2; ack.writeBigUInt64BE(bytes.readBigUInt64BE(1) + BigInt(bytes.length - 9), 1); competitor.send(ack);
          } } catch (error) { if (!competingDone) throw error; }
        })();
        // Rejections are observed during cleanup even if a peer fails mid-run.
        competingDrain.catch(() => {});
      }
      shape(profile);
      console.log(`WAN profile rtt=${profile.rtt}ms rate=${profile.kbit}kbit/s compression=${compression}`);
      const latency = [];
      for (let n = 1; n <= report.samplesPerProfile; n++) latency.push(await measure('x', `EYA_KEY_${n}:x`));
      // Unicode is sent as real UTF-8 and must produce exactly one response.
      await send('界'); await wait(`EYA_KEY_${report.samplesPerProfile + 1}:界`);
      const before = await page.evaluate(() => ({ ...window.__wan }));
      let start = performance.now(); const firstOutputMs = await measure('b', 'BULK_LINE_'); await wait('EYA_BULK_DONE'); const bulkMs = performance.now() - start;
      const after = await page.evaluate(() => ({ ...window.__wan }));
      await send('l'); await wait('LOAD_LINE_0000'); const ctrlCMs = await measure('\x03', 'EYA_STOPPED');
      const stats = (await control.request('session.list')).sessions.find(item => item.id === session);
      // A temporary transport outage preserves process identity and queued input.
      const oldState = await page.evaluate(id => EyaPanels.call(id, 'getState'), id);
      await page.evaluate(() => window.__sockets.at(-1).close());
      await page.waitForFunction(id => !EyaPanels.call(id, 'getState').connected, id);
      start = performance.now();
      await page.waitForFunction(id => EyaPanels.call(id, 'getState').connected, id, { timeout: 120000 });
      const reconnectMs = performance.now() - start;
      const afterCpu = await usage(f.pid), afterClient = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
      const result = { serverCpuMs: afterCpu.cpuMs - beforeCpu.cpuMs, serverRssKiB: afterCpu.rssKiB, serverHighWaterKiB: afterCpu.highWaterKiB, clientScriptMs: 1000 * (afterClient.ScriptDuration - beforeClient.ScriptDuration), clientTaskMs: 1000 * (afterClient.TaskDuration - beforeClient.TaskDuration), ...profile, compression, samples: latency.length, echoMs: { p50: percentile(latency, .5), p95: percentile(latency, .95), p99: percentile(latency, .99) }, firstOutputMs, bulkMs, ctrlCMs, reconnectMs, bulkDownBytes: after.downBytes - before.downBytes, bulkDownMessages: after.downMessages - before.downMessages, network: await page.evaluate(id => EyaPanels.call(id, 'getState'), id), server: stats, heap: await page.evaluate(() => performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null) };
      assert.ok(stats.network.outputWindow >= 4096 && stats.network.outputWindow <= 32768);
      assert.ok(stats.network.outputInFlight <= 32768, 'Hard decoded in-flight bound holds');
      assert.ok(result.network.network.maxOutputBacklog <= 320 * 1024, 'Renderer backlog stays bounded');
      assert.ok(oldState.connected); assert.ok(result.echoMs.p95 < 30000, 'Typing must make bounded progress');
      report.profiles.push(result); console.log(JSON.stringify(result));
      await page.evaluate(id => EyaPanels.close(id), id); await page.context().close();
      competingDone = true; if (competitor) { competitor.send(Uint8Array.of(10)); competitor.close(); await competingDrain; }
      if (process.env.EYA_WAN_REPORT) await fs.writeFile(process.env.EYA_WAN_REPORT, JSON.stringify(report, null, 2) + '\n');
      await delay(50);
    }
    assert.equal(report.profiles.length, profiles.length * 2);
    assert.deepEqual(f.errors, []);
    if (process.env.EYA_WAN_REPORT) await fs.writeFile(process.env.EYA_WAN_REPORT, JSON.stringify(report, null, 2) + '\n');
    console.log('Real TCP terminal WAN matrix passed');
  } finally {
    clearInterval(controlHeartbeat); control?.close(); await f.close();
    try { command('tc', ['qdisc', 'del', 'dev', 'lo', 'root']); } catch {}
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
