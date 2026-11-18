// Real local HTML/SVG clients, mobile CPU emulation, reconnect and hidden panels.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { fixture, KEY } = require('./continuity-fixture.cjs');
const { Peer } = require('./workspace-protocol.cjs');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
(async () => {
  const f = await fixture(); let control;
  try {
    await fs.writeFile(path.join(f.files, 'network-output.txt'), Array.from({ length: 500 }, (_, i) => `\x1b[32mterminal ${i} 界🙂 retained output\x1b[0m\n`).join('') + 'EYA_NETWORK_OUTPUT_DONE\n');
    control = new Peer(f.url, 'eya-terminal-v1', 'eya-workspace-v1:{}'); await control.state();
    for (const type of ['html', 'svg']) {
      const page = await f.client({ type, webgl: false, viewport: { width: 375, height: 740 } });
      const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      const id = await page.evaluate(() => EyaPanels.create('terminal'));
      const send = value => page.evaluate(({ id, value }) => EyaPanels.call(id, 'sendInput', value), { id, value });
      const wait = async text => {
        try { await page.waitForFunction(text => [...document.querySelectorAll('.instance-terminal .xterm-screen')].some(el => el.textContent.includes(text)), text, { timeout: 30000 }); }
        catch (error) { console.error('Terminal while waiting for', text, await page.locator('.instance-terminal .xterm-rows').innerText()); throw error; }
      };
      await page.waitForFunction(id => EyaPanels.call(id, 'getState').connected, id);
      assert.equal(await page.evaluate(id => EyaPanels.call(id, 'getState').network.compression, id), 'deflate-raw');
      await send(`stty -echo; cat -- ${quote(path.join(f.files, 'network-output.txt'))}\r`); await wait('EYA_NETWORK_OUTPUT_DONE');
      assert.equal(await page.locator(`.panel-tab[data-panel="${id}"] .panel-tab-minimize`).count(), 0);
      // A non-echo read must stay blank; responsiveness must never guess input.
      await send("printf 'EYA_SECRET_READ\\n'; read -r EYA_SECRET; printf 'EYA_SECRET_DONE\\n'\r"); await wait('EYA_SECRET_READ');
      await send('EYA_SHOULD_NOT_BE_LOCALLY_ECHOED'); await page.waitForTimeout(100);
      assert.equal(await page.locator('.instance-terminal .xterm-rows').innerText().then(s => s.includes('EYA_SHOULD_NOT_BE_LOCALLY_ECHOED')), false);
      await send('\r'); await wait('EYA_SECRET_DONE');
      if (type === 'html') {
        // Real full-screen programs, including bracketed paste and IME. The
        // suite requires nano/top from the disposable server's Linux PATH.
        const edited = path.join(f.files, 'network-nano.txt');
        await send(`nano -I -- ${quote(edited)}\r`); await wait('[ New File ]');
        await page.evaluate(id => EyaPanels.call(id, 'focus'), id);
        await cdp.send('Input.imeSetComposition', { text: '界', selectionStart: 1, selectionEnd: 1 });
        await cdp.send('Input.insertText', { text: '界' });
        await wait('界');
        await page.evaluate(id => EyaPanels.call(id, 'paste', '🙂\nnetwork paste'), id);
        await wait('network paste');
        await page.setViewportSize({ width: 740, height: 375 });
        await send('\x0f'); await wait('File Name to Write:'); await send('\r');
        await wait('Wrote'); await send('\x18');
        await send("printf 'EYA_EDITOR_EXITED\\n'\r"); await wait('EYA_EDITOR_EXITED');
        assert.equal(await fs.readFile(edited, 'utf8'), '界🙂\nnetwork paste\n', 'IME and bracketed paste preserve exact Unicode/newlines through a real editor');
        await send('LC_ALL=C top -d 0.2\r'); await wait('Tasks:');
        await page.setViewportSize({ width: 375, height: 740 }); await wait('Tasks:');
        await send('q'); await send("printf 'EYA_TOP_EXITED\\n'\r"); await wait('EYA_TOP_EXITED');
        const payload = 'abc界'.repeat(16000), pasted = path.join(f.files, 'network-paste.txt');
        await send(`stty -icanon; printf 'EYA_PASTE_READY\\n'; head -c ${Buffer.byteLength(payload)} > ${quote(pasted)}; stty icanon; printf 'EYA_PASTE_DONE\\n'\r`);
        await wait('EYA_PASTE_READY'); await send(payload); await wait('EYA_PASTE_DONE');
        assert.equal(await fs.readFile(pasted, 'utf8'), payload, 'A large ACK-paced Unicode paste is exact');
        console.log('Real Nano IME/bracketed-paste, Top resize and 96KiB ACK-paced Unicode paste passed');
      }
      await page.evaluate(id => EyaPanels.minimize(id), id);
      await send("(sleep .2; printf 'EYA_BACKGROUND_OUTPUT\\n') &\r"); await wait('EYA_BACKGROUND_OUTPUT');
      assert.equal(await page.evaluate(id => EyaPanels.call(id, 'getState').connected, id), true);
      await page.evaluate(() => { for (const socket of window.__sockets) socket.close(); });
      await page.context().setOffline(true);
      await page.waitForFunction(id => !EyaPanels.call(id, 'getState').connected, id);
      await send("printf 'EYA_OFFLINE_ONCE\\n'\r");
      await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
      await new Promise(resolve => setTimeout(resolve, 300));
      await cdp.send('Page.setWebLifecycleState', { state: 'active' });
      await page.context().setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await wait('EYA_OFFLINE_ONCE');
      await page.waitForFunction(id => EyaPanels.call(id, 'getState').pendingInput === 0, id);
      const text = await page.locator('.instance-terminal .xterm-screen').textContent();
      assert.equal(text.split('EYA_OFFLINE_ONCE').length - 1, 1, 'Queued command executes exactly once after suspension/outage');
      await page.evaluate(id => EyaPanels.open(id), id);
      await page.waitForFunction(id => EyaPanels.call(id, 'getState').connected, id);
      console.log(`${type}: mobile CPU4x, compressed Unicode/ANSI, no password prediction, minimized output, suspension and offline replay passed`);
      await page.evaluate(id => EyaPanels.close(id), id); await page.context().close();
    }
    // Actual downloaded artifact, not a hand-built configuration.
    for (const format of ['html', 'svg']) {
      const generator = await f.client({ connect: false }); await generator.goto(f.http);
      await generator.locator('#server').fill(f.http); await generator.locator('#key').fill(KEY);
      await generator.locator('#startup-panel').selectOption('terminal');
      await generator.locator('#generator-nav [data-page=terminal]').click();
      await generator.getByRole('checkbox', { name: 'Compress output' }).uncheck();
      await generator.locator('#generator-nav [data-page=export]').click(); await generator.locator('#format').selectOption(format);
      const pending = generator.waitForEvent('download'); await generator.locator('button[type=submit]').click();
      const download = await pending, filename = path.join(f.root, `network-off.${format}`); await download.saveAs(filename);
      assert.ok((await fs.readFile(filename, 'utf8')).includes('"terminalCompression":false'));
      await generator.goto(pathToFileURL(filename).href); await generator.locator('#start-connection').click();
      await generator.waitForFunction(() => EyaPanels.layout().flatMap(g => g.panels).some(id => id.startsWith('terminal-') && EyaPanels.call(id, 'getState').connected));
      const id = await generator.evaluate(() => EyaPanels.layout().flatMap(g => g.panels).find(id => id.startsWith('terminal-')));
      // Inspect is server-owned authoritative negotiation evidence.
      const sessions = (await control.request('session.list')).sessions.filter(s => s.kind === 'terminal');
      assert.equal(sessions.length, 1); assert.equal(sessions[0].network.compression, false, 'Generated off setting negotiates raw output');
      await generator.evaluate(id => EyaPanels.close(id), id); await generator.context().close();
    }
    assert.deepEqual(f.errors, []);
    console.log('Terminal local-client network integration passed');
  } finally { control?.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
