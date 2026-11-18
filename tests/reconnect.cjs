const { chromium } = require('playwright');
const { reveal } = require('./ui-helpers.cjs');
const path = require('node:path');
const fs = require('node:fs/promises');
const { fixture } = require('./continuity-fixture.cjs');

(async () => {
  const ttl = Number(process.env.EYA_TEST_SESSION_TTL || 3);
  const f = await fixture({ env: { EYA_SESSION_TTL_SECONDS: String(ttl), EYA_SESSION_BUFFER_BYTES: '65536' } });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) { return type === 'webgl2' ? null : getContext.call(this, type, ...args); };
    const Original = WebSocket;
    window.__testSockets = [];
    window.WebSocket = class extends Original {
      constructor(...args) { super(...args); if (new URL(args[0]).pathname.endsWith('/ws')) window.__testSockets.push(this); }
    };
  });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const octal = value => [...value].map(char => `\\${char.charCodeAt(0).toString(8).padStart(3, '0')}`).join('');
  const output = () => page.locator('.xterm-screen').innerText();
  async function waitFor(text) { await page.waitForFunction(text => document.querySelector('.xterm-screen').innerText.includes(text), text, { timeout: 15000 }); }
  async function command(text) { await page.evaluate(() => EyaPanels.call(window.__terminalId, 'focus')); await page.keyboard.type(text); await page.keyboard.press('Enter'); }
  try {
    // Opt out of the production startup terminal: this suite creates and
    // instruments exactly one terminal and must not reconnect the wrong socket.
    const html = (await fs.readFile('client.html', 'utf8')).replace('<script id="eya-config" type="application/json">{}</script>', '<script id="eya-config" type="application/json">{"startupPanel":"none"}</script>');
    const filename = path.join(f.root, 'reconnect.html'); await fs.writeFile(filename, html);
    await page.goto(require('node:url').pathToFileURL(filename).href);
    await page.locator('#url').fill(f.url);
    await page.locator('#key').fill('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    await page.evaluate(() => { const input = document.querySelector('#default-command'); input.value = 'EYA_DEFAULT_RUNS=$(( ${EYA_DEFAULT_RUNS:-0} + 1 ))'; input.dispatchEvent(new Event('input', {bubbles:true})); });
    await page.locator('#start-connection').click();
    await page.locator('#status[data-connected=true]').waitFor({state:'attached'});
    await page.evaluate(async () => { window.__terminalId = await EyaPanels.create('terminal'); });
    await page.waitForFunction(() => EyaPanels.call(window.__terminalId, 'getState').connected);
    await command(`stty -echo; EYA_SAVED_PID=$$; EYA_COUNT=0; printf '${octal('READY_RESUME')}\\n'`);
    await waitFor('READY_RESUME');

    const cwd = path.join(f.files, "cwd with spaces and 'quotes'");
    await fs.mkdir(cwd);
    const quotedCwd = "'" + cwd.replaceAll("'", "'\\''") + "'";
    await command(`cd -- ${quotedCwd}; EYA_SAVED_CWD=$(pwd -P); printf '${octal('CWD_READY=')}%s\\n' "$EYA_SAVED_CWD"`);
    await waitFor(`CWD_READY=${cwd}`);

    await command(`(sleep 1; printf '${octal('OUTPUT_WHILE_OFFLINE')}\\n') &`);
    await context.setOffline(true);
    await page.evaluate(() => window.__testSockets.forEach(socket => socket.close()));
    // Chromium may leave native close() pending while offline. Allow the
    // existing 30s heartbeat deadline plus its 5s polling interval to fence it.
    await page.locator('.instance-terminal-status').filter({ hasText: 'Reconnecting' }).waitFor({ timeout: 45000 });
    await command(`test "$EYA_SAVED_PID" = "$$" && printf '${octal('SAME_SHELL_BUFFERED_INPUT')}\\n'`);
    await page.waitForTimeout(1400);
    if ((await output()).includes('SAME_SHELL_BUFFERED_INPUT')) throw Error('Offline input unexpectedly executed while offline');
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.locator('.instance-terminal-status').filter({ hasText: 'session resumed' }).waitFor({ timeout: 15000 });
    await waitFor('OUTPUT_WHILE_OFFLINE'); await waitFor('SAME_SHELL_BUFFERED_INPUT');
    await command(`test "$(pwd -P)" = "$EYA_SAVED_CWD" && printf '${octal('NETWORK_CWD_RETAINED')}\\n'`);
    await waitFor('NETWORK_CWD_RETAINED');

    // Lose all encrypted replies after sending input, including its acknowledgement.
    // Reattachment's input offset must prevent replaying an already executed command.
    await page.evaluate(() => { window.__testSockets.forEach(socket => { socket.onmessage = () => {}; }); });
    await command('EYA_COUNT=$((EYA_COUNT+1))');
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__testSockets.forEach(socket => socket.close()));
    await page.locator('.instance-terminal-status').filter({ hasText: 'session resumed' }).waitFor({ timeout: 15000 });
    await command(`printf '${octal('COUNT_AFTER_REPLAY=')}%s\\n' "$EYA_COUNT"`);
    await waitFor('COUNT_AFTER_REPLAY=1');
    if ((await output()).includes('COUNT_AFTER_REPLAY=2')) throw Error('Acknowledgement loss duplicated terminal input');

    await command(`stty -echo -icanon; printf '${octal('WAITING_FOR_RAW_INPUT')}\\n'; sleep 4; head -c 100000 >/dev/null; stty -echo icanon; printf '${octal('BLOCKED_INPUT_DRAINED')}\\n'`);
    await waitFor('WAITING_FOR_RAW_INPUT');
    await page.keyboard.insertText('x'.repeat(100000));
    await page.waitForTimeout(100);
    await page.evaluate(() => window.__testSockets.forEach(socket => socket.close()));
    await page.locator('.instance-terminal-status').filter({ hasText: 'session resumed' }).waitFor({ timeout: 2500 });
    await waitFor('BLOCKED_INPUT_DRAINED');

    // More than the test server's 64 KiB replay buffer: PTY backpressure must
    // retain the whole stream rather than dropping old output or killing it.
    await command(`(sleep 1; head -c 1000000 /dev/zero | tr '\\0' x; printf '\\n${octal('BACKPRESSURE_SURVIVED')}\\n') &`);
    await context.setOffline(true);
    await page.evaluate(() => window.__testSockets.forEach(socket => socket.close()));
    await page.waitForTimeout(1800);
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitFor('BACKPRESSURE_SURVIVED');

    await (await reveal(page, '#disconnect')).click();
    await page.waitForTimeout(800);
    if (!(await page.locator('#status').textContent()).includes('Disconnected')) throw Error('Explicit disconnect did not pause retries');
    await page.locator('#connect').click(); await page.locator('#start-connection').click();
    await page.locator('.instance-terminal-status').filter({ hasText: 'session resumed' }).waitFor();
    await command(`test "$EYA_SAVED_PID" = "$$" && printf '${octal('MANUAL_RESUME_OK')}\\n'`);
    await waitFor('MANUAL_RESUME_OK');
    await command(`test "$(pwd -P)" = "$EYA_SAVED_CWD" && printf '${octal('MANUAL_CWD_RETAINED')}\\n'`);
    await waitFor('MANUAL_CWD_RETAINED');
    await command(`printf '${octal('DEFAULT_COMMAND_RUNS=')}%s\\n' "$EYA_DEFAULT_RUNS"`);
    await waitFor('DEFAULT_COMMAND_RUNS=1');

    await (await reveal(page, '#disconnect')).click();
    await page.waitForTimeout((ttl + 2) * 1000);
    await page.locator('#connect').click(); await page.locator('#start-connection').click();
    await page.locator('.instance-terminal-status').filter({ hasText: 'session resumed' }).waitFor();
    await command(`test "$EYA_SAVED_PID" = "$$" && test "$(pwd -P)" = "$EYA_SAVED_CWD" && printf '${octal('NO_DETACHED_EXPIRY')}\\n'`);
    await waitFor('NO_DETACHED_EXPIRY');
    await page.evaluate(() => EyaPanels.call(window.__terminalId, 'end'));
    await page.waitForFunction(() => EyaPanels.call(window.__terminalId, 'getState').ended);
    if (errors.length) throw Error(errors.join('; '));
    console.log('Network loss and manual resume retain cwd/shell identity; buffered input/output, lost-ack replay, backpressure, indefinite detached lifetime, and explicit termination passed');
  } catch (error) {
    console.error('Terminal at failure:', await output().catch(() => '<unavailable>'));
    console.error('Connection at failure:', await page.locator('.instance-terminal-status').allTextContents());
    throw error;
  } finally {
    await page.evaluate(() => EyaPanels.call(window.__terminalId, 'end')).catch(() => {});
    await browser.close(); await f.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
