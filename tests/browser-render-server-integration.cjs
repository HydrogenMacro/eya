const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Noise = require('noise-handshake');
const Cipher = require('noise-handshake/cipher');

async function main() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const server = spawn(path.resolve('eya-server/target/debug/eya-server'), [], {
    cwd: '/tmp', env: { PATH: process.env.PATH, EYA_KEY: key.toString('hex'), EYA_BIND: `127.0.0.1:${port}`, EYA_CWD: '/tmp', EYA_BROWSER_CHROMIUM: '/tmp/eya-deliberately-missing-chromium' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('Server startup timed out')), 10000);
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(Error(`Server exited during startup: ${code}: ${output}`)); });
      server.stderr.on('data', chunk => { output += chunk; if (output.includes('Eya listening on')) { clearTimeout(timer); resolve(); } });
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/browser-render-ws`);
    ws.binaryType = 'arraybuffer';
    const encoder = new TextEncoder(), decoder = new TextDecoder();
    const noise = new Noise('NNpsk0', true, null, { psk: key });
    noise.initialise(encoder.encode('eya-browser-render-v1'));
    let tx, rx, state = 0;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Browser endpoint timed out')), 10000);
      ws.onopen = () => ws.send(noise.send());
      ws.onerror = () => { clearTimeout(timer); reject(Error('Browser endpoint connection failed')); };
      ws.onmessage = event => {
        try {
          const data = new Uint8Array(event.data);
          if (state === 0) {
            noise.recv(data); assert.equal(noise.complete, true);
            tx = new Cipher(noise.tx); rx = new Cipher(noise.rx);
            ws.send(tx.encrypt(encoder.encode('eya-browser-render-ready-v1'))); state = 1; return;
          }
          const message = rx.decrypt(data);
          if (state === 1) { assert.equal(decoder.decode(message), 'eya-browser-render-ready-v1'); ws.send(tx.encrypt(Uint8Array.of(1))); state = 2; return; }
          assert.equal(message[0], 129); const value = JSON.parse(decoder.decode(message.subarray(1)));
          assert.equal(value.type, 'error'); clearTimeout(timer); resolve(value.message);
        } catch (error) { clearTimeout(timer); reject(error); }
      };
    });
    assert.match(result, /EYA_BROWSER_CHROMIUM does not point to a file/);
    ws.close();
    console.log('Main server browser endpoint authenticates and reports Chromium startup errors.');
  } finally {
    server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 3000).unref(); } });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
