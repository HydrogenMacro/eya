const { chromium } = require('playwright');
const { reveal } = require('./ui-helpers.cjs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const Original = WebSocket;
    window.WebSocket = class extends Original {
      constructor(...args) { super(...args); window.__testSocket = this; }
    };
  });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const octal = value => [...value].map(char => `\\${char.charCodeAt(0).toString(8).padStart(3, '0')}`).join('');
  const output = () => page.locator('.xterm-screen').innerText();
  async function waitFor(text) { await page.waitForFunction(text => document.querySelector('.xterm-screen').innerText.includes(text), text, { timeout: 15000 }); }
  async function command(text) { await page.keyboard.type(text); await page.keyboard.press('Enter'); }
  try {
    await page.goto(pathToFileURL(path.resolve('client.html')).href);
    await page.locator('#url').fill('ws://127.0.0.1:18765/ws');
    await page.locator('#key').fill('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    await page.locator('#default-command').fill('EYA_DEFAULT_RUNS=$(( ${EYA_DEFAULT_RUNS:-0} + 1 ))');
    await page.locator('#start-connection').click();
    await page.locator('#status').filter({ hasText: 'Connected' }).waitFor();
    await command(`stty -echo; EYA_SAVED_PID=$$; EYA_COUNT=0; printf '${octal('READY_RESUME')}\\n'`);
    await waitFor('READY_RESUME');

    await command(`(sleep 1; printf '${octal('OUTPUT_WHILE_OFFLINE')}\\n') &`);
    await context.setOffline(true);
    await page.evaluate(() => window.__testSocket.close());
    await page.locator('#status').filter({ hasText: 'Reconnecting' }).waitFor();
    await command(`test "$EYA_SAVED_PID" = "$$" && printf '${octal('SAME_SHELL_BUFFERED_INPUT')}\\n'`);
    await page.waitForTimeout(1400);
    if ((await output()).includes('SAME_SHELL_BUFFERED_INPUT')) throw Error('Offline input unexpectedly executed while offline');
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.locator('#status').filter({ hasText: 'session resumed' }).waitFor({ timeout: 15000 });
    await waitFor('OUTPUT_WHILE_OFFLINE'); await waitFor('SAME_SHELL_BUFFERED_INPUT');

    // Lose all encrypted replies after sending input, including its acknowledgement.
    // Reattachment's input offset must prevent replaying an already executed command.
    await page.evaluate(() => { window.__testSocket.onmessage = () => {}; });
    await command('EYA_COUNT=$((EYA_COUNT+1))');
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__testSocket.close());
    await page.locator('#status').filter({ hasText: 'session resumed' }).waitFor({ timeout: 15000 });
    await command(`printf '${octal('COUNT_AFTER_REPLAY=')}%s\\n' "$EYA_COUNT"`);
    await waitFor('COUNT_AFTER_REPLAY=1');
    if ((await output()).includes('COUNT_AFTER_REPLAY=2')) throw Error('Acknowledgement loss duplicated terminal input');

    await command(`stty -echo -icanon; printf '${octal('WAITING_FOR_RAW_INPUT')}\\n'; sleep 4; head -c 100000 >/dev/null; stty -echo icanon; printf '${octal('BLOCKED_INPUT_DRAINED')}\\n'`);
    await waitFor('WAITING_FOR_RAW_INPUT');
    await page.keyboard.insertText('x'.repeat(100000));
    await page.waitForTimeout(100);
    await page.evaluate(() => window.__testSocket.close());
    await page.locator('#status').filter({ hasText: 'session resumed' }).waitFor({ timeout: 2500 });
    await waitFor('BLOCKED_INPUT_DRAINED');

    // More than the test server's 64 KiB replay buffer: PTY backpressure must
    // retain the whole stream rather than dropping old output or killing it.
    await command(`(sleep 1; head -c 1000000 /dev/zero | tr '\\0' x; printf '\\n${octal('BACKPRESSURE_SURVIVED')}\\n') &`);
    await context.setOffline(true);
    await page.evaluate(() => window.__testSocket.close());
    await page.waitForTimeout(1800);
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitFor('BACKPRESSURE_SURVIVED');

    await (await reveal(page, '#disconnect')).click();
    await page.waitForTimeout(800);
    if (!(await page.locator('#status').textContent()).includes('Disconnected')) throw Error('Explicit disconnect did not pause retries');
    await page.locator('#connect').click(); await page.locator('#start-connection').click();
    await page.locator('#status').filter({ hasText: 'session resumed' }).waitFor();
    await command(`test "$EYA_SAVED_PID" = "$$" && printf '${octal('MANUAL_RESUME_OK')}\\n'`);
    await waitFor('MANUAL_RESUME_OK');
    await command(`printf '${octal('DEFAULT_COMMAND_RUNS=')}%s\\n' "$EYA_DEFAULT_RUNS"`);
    await waitFor('DEFAULT_COMMAND_RUNS=1');

    if (process.env.EYA_TEST_SESSION_TTL) {
      await (await reveal(page, '#disconnect')).click();
      await page.waitForTimeout((Number(process.env.EYA_TEST_SESSION_TTL) + 2) * 1000);
      await page.locator('#connect').click(); await page.locator('#start-connection').click();
      await page.locator('#error').filter({ hasText: 'ended or expired' }).waitFor();
      if ((await page.locator('#status').textContent()).includes('Connected')) throw Error('Expired session silently created a replacement shell');
      await page.locator('#connect').click(); await page.locator('#start-connection').click();
      await page.locator('#status').filter({ hasText: 'Connected' }).waitFor();
    }
    await page.evaluate(() => document.getElementById('end-session').click());
    await page.locator('#status').filter({ hasText: 'ended explicitly' }).waitFor();
    if (errors.length) throw Error(errors.join('; '));
    console.log('Network loss, buffered input/output, persistent shell identity, lost-ack replay, output backpressure, manual resume, expiry, and explicit termination passed');
  } finally {
    await page.evaluate(() => document.getElementById('end-session')?.click()).catch(() => {});
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
