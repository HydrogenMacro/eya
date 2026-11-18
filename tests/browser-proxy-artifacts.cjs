const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const Noise = require('noise-handshake');
const Cipher = require('noise-handshake/cipher');
const { fixture, CLIENT_TYPES } = require('./continuity-fixture.cjs');

const password = 'test password for opaque client origins';
const psk = createHash('sha256').update(password).digest();
const site = 'https://client-format.test';
const pages = {
  '/': ['text/html', `<!doctype html><title>Start</title><link rel="stylesheet" href="/guide.css">
    <h1>Start reading</h1><a href="/chapter#section">Open chapter</a>
    <button id="search">Search docs</button><output></output><script src="/guide.js" defer></script>`],
  '/chapter': ['text/html', '<!doctype html><title>Chapter</title><h1>Chapter</h1><h2 id="section">Selected section</h2>'],
  '/guide.css': ['text/css', 'h1 { color: rgb(12, 34, 56) }'],
  '/guide.js': ['application/javascript', `document.querySelector('#search').onclick = async () => {
      document.querySelector('output').textContent = await (await fetch('/results')).text();
    }; document.querySelector('#search').dataset.ready = 'yes';`],
  '/results': ['text/plain', 'Search results loaded'],
};

// A bounded in-process Noise responder for a reserved upstream name. It avoids
// using public sites as fixtures and keeps the real server's private-IP denial.
function proxyPeer(route, calls, errors) {
  const handshake = new Noise('NNpsk0', false, null, { psk });
  handshake.initialise(Buffer.from('eya-browser-v1'));
  let inbound, outbound, ready = false;
  const send = bytes => route.send(Buffer.from(outbound.encrypt(bytes)));
  route.onMessage(bytes => {
    try {
      if (!inbound) {
        handshake.recv(bytes);
        route.send(Buffer.from(handshake.send()));
        inbound = new Cipher(handshake.rx); outbound = new Cipher(handshake.tx);
        return;
      }
      const payload = Buffer.from(inbound.decrypt(bytes));
      if (!ready) {
        assert.equal(payload.toString(), 'eya-browser-ready-v1');
        ready = true; send(payload);
        return;
      }
      if (payload[0] === 4 || payload[0] === 5) return;
      assert.equal(payload[0], 1);
      const request = JSON.parse(payload.subarray(1));
      const url = new URL(request.url);
      assert.equal(url.origin, site);
      assert.equal(request.method, 'GET');
      calls.push(url.pathname);
      const response = pages[url.pathname];
      const [type, text] = response || ['text/plain', 'Missing'];
      const body = Buffer.from(text);
      const meta = { id: request.id, ok: true, status: response ? 200 : 404, url: `${url.origin}${url.pathname}`, headers: { 'content-type': type } };
      send(Buffer.concat([Buffer.of(2), Buffer.from(JSON.stringify(meta))]));
      const chunk = Buffer.alloc(6);
      chunk[0] = 3; chunk.writeUInt32BE(request.id, 1); chunk[5] = 1;
      send(Buffer.concat([chunk, body]));
    } catch (error) {
      errors.push(error);
      void route.close({ code: 1011 }).catch(() => {});
    }
  });
}

(async () => {
  const engine = process.env.EYA_PROXY_ARTIFACT_ENGINE || 'chromium';
  const selectedTypes = process.env.EYA_PROXY_ARTIFACT_FORMATS?.split(',') || CLIENT_TYPES;
  assert.ok(selectedTypes.every(type => CLIENT_TYPES.includes(type)), 'Unknown client format');
  const f = await fixture({ engine, env: { EYA_KEY: password } });
  try {
    for (const type of selectedTypes) {
      const calls = [], peers = [], peerErrors = [], direct = [];
      const page = await f.client({
        type,
        dataUrlLoopbackRelay: true,
        webgl: false,
        async setupContext(context) {
          await context.routeWebSocket(`${f.url.slice(0, -2)}browser-ws`, route => {
            peers.push(route);
            proxyPeer(route, calls, peerErrors);
          });
          await context.route(`${site}/**`, route => { direct.push(route.request().url()); return route.abort(); });
        },
      });
      page.setDefaultTimeout(10000);
      assert.equal(await page.evaluate(() => document.documentElement.localName), type.endsWith('svg') ? 'svg' : 'html', type);
      if (type === 'data-url') {
        assert.deepEqual(await page.evaluate(() => [location.protocol, origin]), ['data:', 'null']);
        if (engine === 'chromium') assert.equal(await page.evaluate(() => !!crypto.subtle), false);
      }
      await page.evaluate(() => EyaPanels.create('proxy-browser'));
      const address = page.getByRole('textbox', { name: 'Address or search' });
      await address.fill(site);
      await address.press('Enter');
      const iframe = page.locator('.eya-browser-frame');
      const frame = page.mainFrame().childFrames()[0] || await page.waitForEvent('frameattached');
      await frame.getByRole('heading', { name: 'Start reading' }).waitFor();
      await frame.locator('#search[data-ready="yes"]').waitFor();
      assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts', type);
      assert.equal(await frame.locator('h1').evaluate(element => getComputedStyle(element).color), 'rgb(12, 34, 56)', type);
      assert.equal(await frame.locator('h1').evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        return getSelection().toString();
      }), 'Start reading', type);
      await frame.getByRole('button', { name: 'Search docs' }).click();
      await frame.getByText('Search results loaded').waitFor();
      await frame.locator('output').evaluate(output => { output.dataset.retainedDocument = 'yes'; output.textContent = ''; });
      const opened = peers.length;
      await peers.at(-1).close({ code: 1012, reason: 'Disposable connection drop' });
      await page.waitForFunction(count => __sockets.filter(socket => /\/browser-ws$/.test(socket.url)).length > count, opened);
      await page.locator('.eya-browser-connection[data-state="ready"]').waitFor();
      await frame.locator('output[data-retained-document="yes"]').waitFor({ state: 'attached' });
      assert.equal(calls.filter(path => path === '/results').length, 1, 'Loss of connection does not replay page work');
      await frame.getByRole('button', { name: 'Search docs' }).click();
      await frame.getByText('Search results loaded').waitFor();
      assert.equal(calls.filter(path => path === '/results').length, 2, 'A fresh request uses the recovered channel');
      await frame.getByRole('link', { name: 'Open chapter' }).click();
      await frame.getByRole('heading', { name: 'Selected section' }).waitFor();
      assert.equal(await address.evaluate(input => input.value), `${site}/chapter#section`, type);
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await frame.getByRole('heading', { name: 'Start reading' }).waitFor();
      assert.ok(['/guide.css', '/guide.js', '/results', '/chapter'].every(path => calls.includes(path)), type);
      assert.deepEqual(peerErrors, []);
      assert.deepEqual(direct, []);
      if (type === 'data-url') {
        const terminal = await page.evaluate(() => EyaPanels.create('terminal'));
        await page.waitForFunction(id => EyaPanels.call(id, 'getState').connected, terminal);
        await page.evaluate(id => EyaPanels.call(id, 'sendInput', "printf 'EYA_DATA_%s\\n' LOCAL_PTY\r"), terminal);
        await page.waitForFunction(id => EyaPanels.call(id, 'getText').includes('EYA_DATA_LOCAL_PTY'), terminal);
        await page.evaluate(id => EyaPanels.close(id), terminal);
        console.log('data-url: non-hex password authenticated a real Rust PTY and returned shell output');
      }
      await page.context().close();
      console.log(`${type}: encrypted proxy, sandbox, styles, selection, search, automatic reconnect, chapter and Back passed`);
    }
    const normalData = await f.client({ type: 'data-url', connect: false });
    await normalData.waitForFunction(() => window.EyaWorkspaces && (EyaWorkspaces.getState().workspace || document.getElementById('dialog-error')?.textContent));
    if (!await normalData.evaluate(() => !!EyaWorkspaces.getState().workspace)) {
      assert.match(await normalData.locator('#dialog-error').textContent(), /Cannot reach the server/);
      assert.equal(await normalData.locator('#start-connection').isEnabled(), true);
      const opened = normalData.context().waitForEvent('page');
      await normalData.getByRole('button', { name: 'Open server client' }).click();
      const hosted = await opened;
      await hosted.waitForFunction(() => window.EyaWorkspaces?.getState().workspace);
      assert.equal(hosted.url(), `${f.http}/client.html`);
      console.log('data-url: Open server client recovered from Chromium’s default local-network restriction');
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
