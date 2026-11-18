const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { build } = require('esbuild');
const { fixture, KEY } = require('./continuity-fixture.cjs');
const { Peer } = require('./workspace-protocol.cjs');

(async () => {
  const f = await fixture();
  const release = (await fs.readFile('VERSION', 'utf8')).trim();
  const peers = [];
  try {
    const page = await f.client({ connect: false });
    // Model the first update-capable release, from before the server’s first stable major release.
    // No workspace or terminal code is present in this harness: recovery must be independent.
    const result = await build({ stdin: { contents: "import * as updates from './client/client-updates.js'; import * as artifacts from './client/client-artifacts.js'; window.API={...updates,...artifacts}; window.updater=updates.setupClientUpdates({getConnection:()=>window.connection,config:window.config,notify:message=>window.notice=message});", resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', write: false,
      alias: { 'sodium-universal': './client/sodium-browser.js' }, plugins: [{ name: 'old-client-version', setup(builder) { builder.onLoad({ filter: /\/version\.js$/ }, () => ({ contents: "export const CLIENT_VERSION='0.1.0';", loader: 'js' })); } }] });
    const config = { url: f.url, key: KEY, startupPanel: 'none', defaultCommand: 'echo DO_NOT_RUN', futureSetting: '</script><script>window.injected=true</script>', terminalCompression: false, fontSize: 19, font: `data:font/woff2;base64,${(await fs.readFile('client/fonts/0xProto.woff2')).toString('base64')}` };
    const ids = ['client-version', 'server-version', 'client-update-note', 'client-update-status'];
    const buttons = ['check', 'download', 'save', 'reload', 'open'];
    const harness = '<!doctype html><meta charset="utf-8"><body>' + ids.map(id => `<p id="${id}"></p>`).join('') + '<button id="client-update-indicator" hidden>Update</button>' + buttons.map(name => `<button id="client-update-${name}">${name}</button>`).join('') + `<script>window.connection=${JSON.stringify({ url: f.url, key: KEY })};window.config=${JSON.stringify(config).replace(/</g, '\\u003c')};</script><script>${result.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`;
    const harnessFile = path.join(f.root, 'old-client.html'); await fs.writeFile(harnessFile, harness);
    await page.goto(pathToFileURL(harnessFile).href);
    await page.evaluate(async () => {
      const { compareVersions: compare } = API;
      const versions = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
      for (let i = 1; i < versions.length; i++) if (compare(versions[i - 1], versions[i]) !== -1 || compare(versions[i], versions[i - 1]) !== 1) throw Error('SemVer order failed');
      if (compare('1.0.0+a', '1.0.0+b') !== 0 || compare('99999999999999999.0.0', '99999999999999998.0.0') !== 1) throw Error('SemVer precision failed');
      for (const invalid of ['01.0.0', '1.0', '1.0.0-01', 'v1.0.0']) {
        let failed = false; try { compare(invalid, '1.0.0'); } catch { failed = true; } if (!failed) throw Error('Accepted bad SemVer');
      }
      let bad = false; try { API.updateEndpoint('ws://example/ws?key=secret'); } catch { bad = true; } if (!bad) throw Error('Credentials/query accepted');
      if (API.updateEndpoint('wss://example/prefix/ws') !== 'wss://example/prefix/ws/update') throw Error('Proxy prefix lost');
      const m = { v: 1, client: '1.0.0', server: '1.0.0', bytes: 3, chunk: 32768, artifact: 'html-template-v1', config: 'eya-config-v1', sha256: '0'.repeat(64), future: true };
      API.validateManifest(m);
      for (const patch of [{bytes:33554433}, {chunk:65536}, {artifact:'future'}, {sha256:'bad'}]) {
        let failed = false; try { API.validateManifest({...m,...patch}); } catch { failed = true; } if (!failed) throw Error('Invalid manifest accepted');
      }
      for (const response of [{v:1, offset:1, data:'YWJj'}, {v:1,offset:0,data:'YQ=='}, {v:1,offset:0,data:'YWJj'}]) {
        let failed = false; try { await API.downloadTemplate({request:async()=>response},m); } catch { failed = true; } if (!failed) throw Error('Corrupt download accepted');
      }
      let interrupted = false; try { await API.downloadTemplate({request:async()=>{throw Error('interrupted');}},m); } catch { interrupted = true; } if (!interrupted) throw Error('Interruption swallowed');
      let badAuth = false, channel;
      try { channel=await API.openUpdateChannel({...connection,key:'wrong password'}); await channel.request('manifest'); } catch { badAuth=true; } finally {channel?.close();}
      if (!badAuth) throw Error('Wrong update password authenticated');
      const channel2=await API.openUpdateChannel(connection);
      try {
        let rejected=false; try {await channel2.request('future.operation',{future:true});} catch(error){rejected=error.message.includes('unsupported_operation');} if(!rejected)throw Error('Unknown operation not rejected');
        const manifest=await channel2.request('manifest');
        if(manifest.artifact!=='html-template-v1'||manifest.config!=='eya-config-v1'||manifest.chunk!==32768||manifest.v!==1)throw Error('Frozen bootstrap-v1 changed');
        try {await channel2.request('read',{offset:0,sha256:'0'.repeat(64)});throw Error('Stale release accepted');}catch(error){if(!error.message.includes('release_changed'))throw error;}
        try {await channel2.request('read',{offset:manifest.bytes,sha256:manifest.sha256});throw Error('Bad offset accepted');}catch(error){if(!error.message.includes('invalid_offset'))throw error;}
      } finally {channel2.close();}
    });
    const noPty = new Peer(f.url, 'eya-terminal-v1', 'eya-workspace-v1:{}'); peers.push(noPty); await noPty.state();
    assert.deepEqual((await noPty.request('session.list')).sessions, [], 'Update/auth checks spawned a session');
    await page.evaluate(() => updater.connected());
    await page.waitForFunction(release => document.getElementById('client-update-status').textContent.includes(release + ' is available'), release);
    assert.equal(await page.locator('#client-update-indicator').isVisible(), true);
    assert.ok((await page.evaluate(() => notice)).includes(release));
    await page.evaluate(() => updater.connected()); // throttled checks must retain the result
    assert.match(await page.locator('#client-update-status').textContent(), /is available/);
    for (const type of ['html', 'svg']) {
      if (type === 'svg') {
        const svg = await page.evaluate(html => API.svgClient(html), harness);
        const filename = path.join(f.root, 'old-client.svg'); await fs.writeFile(filename, svg); await page.goto(pathToFileURL(filename).href);
        await page.evaluate(() => updater.check());
      }
      await page.evaluate(() => { window.showSaveFilePicker = undefined; });
      const downloaded = page.waitForEvent('download'); await page.locator('#client-update-indicator').click();
      const download = await downloaded; assert.equal(download.suggestedFilename(), `eya-client.${type}`);
      const filename = path.join(f.root, `updated.${type}`); await download.saveAs(filename);
      assert.match(await page.locator('#client-update-status').textContent(), /still running 0\.1\.0/);
      const updated = await page.context().newPage();
      await updated.goto(pathToFileURL(filename).href); await updated.locator('#url').waitFor();
      assert.equal(await updated.locator('#key').evaluate(node => node.value), KEY);
      assert.equal(await updated.locator('#url').evaluate(node => node.value), f.url);
      const embedded = await updated.locator('#eya-config').evaluate(node => JSON.parse(node.textContent));
      assert.deepEqual(embedded, { ...config, hosted: false });
      assert.equal(await updated.evaluate(() => window.injected), undefined);
      assert.equal(await updated.locator('#client-version').textContent(), release);
      await updated.waitForFunction(() => document.getElementById('client-update-status').textContent === 'Your client is up to date.');
      assert.equal(await updated.locator('#client-update-indicator').isHidden(), true);
      // Embedded credentials may finish automatic connection while the update
      // status is being checked. Start it only if no workspace is ready yet.
      await updated.evaluate(() => { if (!EyaWorkspaces.getState().workspace) document.getElementById('start-connection').click(); });
      await updated.waitForFunction(() => EyaWorkspaces.getState().workspace);
      await updated.waitForFunction(() => document.getElementById('client-update-status').textContent === 'Your client is up to date.');
      await updated.close();
    }
    // Exercise the same production save path with a browser file-picker/writer stub.
    await page.goto(pathToFileURL(harnessFile).href);
    await page.evaluate(() => { window.showSaveFilePicker=async()=>({createWritable:async()=>{window.writerOpened=true;return {write:async blob=>window.savedArtifact=await blob.text(),close:async()=>{},abort:async()=>{}};}}); });
    await page.evaluate(() => updater.check());
    await page.locator('#client-update-indicator').click();
    await page.waitForFunction(() => window.savedArtifact);
    assert.equal(await page.evaluate(() => writerOpened), true);
    assert.match(await page.evaluate(() => savedArtifact), /Eya workspace/);
    await page.waitForFunction(release => document.getElementById('client-update-status').textContent.includes(release + ' saved'), release);
    await page.evaluate(() => {window.savedArtifact=null;window.writerOpened=false;window.showSaveFilePicker=async()=>{throw new DOMException('canceled','AbortError');};document.getElementById('client-update-indicator').click();});
    await page.waitForFunction(() => document.getElementById('client-update-status').textContent === 'Update save canceled.');
    assert.equal(await page.evaluate(() => writerOpened), false);
    // Data origins cannot be overwritten, but can fetch and download an HTML replacement.
    await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(harness));
    assert.match(await page.locator('#client-update-note').textContent(), /cannot be replaced in place/);
    assert.equal(await page.locator('#client-update-save').isHidden(), true);
    await page.evaluate(() => updater.check());
    const dataStatus = await page.locator('#client-update-status').textContent();
    if (dataStatus.includes('is available')) {
      const dataDownload = page.waitForEvent('download'); await page.locator('#client-update-download').click();
      assert.equal((await dataDownload).suggestedFilename(), 'eya-client.html');
    } else {
      assert.match(dataStatus, /Could not check from this data URL/);
      assert.equal(await page.locator('#client-update-open').isVisible(), true);
      const popupPromise = page.context().waitForEvent('page'); await page.locator('#client-update-open').click();
      const popup = await popupPromise; await popup.waitForURL(f.http + '/client.html');
      await popup.locator('#client-version').waitFor({ state: 'attached' });
      assert.equal(await popup.locator('#client-version').textContent(), release);
      await popup.close();
    }
    // Generator and updater share SVG helpers: preserve compressed packaging too.
    await page.goto(f.http + '/');
    const generated = await page.evaluate(html => ({ html: EyaGenerator.compressedDocument(html), svg: EyaGenerator.compressedSvgClient(html), data: EyaGenerator.dataUrl('<!doctype html><p id="probe">Data URL unpacked</p>') }), await fs.readFile(path.join(f.root, 'updated.html'), 'utf8'));
    for (const type of ['html', 'svg']) {
      const filename = path.join(f.root, `compressed-current.${type}`);
      await fs.writeFile(filename, generated[type]);
      await page.goto(pathToFileURL(filename).href);
      await page.locator('#url').waitFor();
      assert.equal(await page.locator('#url').evaluate(node => node.value), f.url);
      assert.equal(await page.locator('#key').evaluate(node => node.value), KEY);
      assert.equal(await page.locator('#client-version').textContent(), release);
      await page.waitForFunction(() => EyaWorkspaces.getState().workspace);
    }
    // Full clients can exceed Chromium's data-navigation length cap, independently of updating.
    await page.goto(generated.data); await page.getByText('Data URL unpacked', { exact: true }).waitFor();
    assert.deepEqual((await noPty.request('session.list')).sessions, [], 'Updated pages with startupPanel none spawned PTYs');
    assert.deepEqual(f.errors, []);
    console.log('Client update: frozen bootstrap, direct old→current HTML/SVG, data URL recovery, config/font preservation, save/cancel, auth, bounds, corruption and interruption passed');
  } finally { for (const peer of peers) peer.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
