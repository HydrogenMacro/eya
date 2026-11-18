const assert = require('node:assert/strict');
const { fixture } = require('./continuity-fixture.cjs');
const octal = value => [...value].map(char => `\\${char.charCodeAt(0).toString(8).padStart(3, '0')}`).join('');
const print = text => `printf '${octal(text)}\\n'`;

(async () => {
  const f = await fixture();
  try {
    const first = await f.client({ webgl: false });
    const session = '4b'.repeat(32);
    const left = await first.evaluate(session => EyaPanels.create('terminal', { session, command: '' }), session);
    const right = await first.evaluate(() => EyaPanels.create('terminal', { command: '' }));
    await first.evaluate(({ left, right }) => {
      EyaPanels.split(right, 'vertical', left);
      const setting = document.querySelector('#panel-focus-mode');
      setting.value = 'hover'; setting.dispatchEvent(new Event('change', { bubbles: true }));
    }, { left, right });
    for (const id of [left, right]) await first.waitForFunction(id => EyaPanels.call(id, 'getState').connected, id);
    const surface = async (page, id) => {
      const group = await page.evaluate(id => EyaPanels.groupOf(id), id);
      return page.locator(`.panel-group[data-group="${group}"] .instance-terminal-surface`);
    };
    const leftSurface = await surface(first, left), rightSurface = await surface(first, right);
    const waitText = (page, id, text) => page.waitForFunction(({ id, text }) => EyaPanels.call(id, 'getText').includes(text), { id, text });
    const typeCommand = async (page, command) => { await page.keyboard.type(command); await page.keyboard.press('Enter'); };
    // Real pointer entry must transfer keyboard focus through the built workbench
    // into xterm, without a click or an explicit focus API call.
    await first.mouse.move(0, 0); await leftSurface.hover();
    assert.equal(await leftSurface.locator('.xterm-helper-textarea').evaluate(element => element === document.activeElement), true);
    await typeCommand(first, `EYA_FOCUS_KEEP=kept; ${print('HOVER_LEFT_RECEIVED')}`);
    await waitText(first, left, 'HOVER_LEFT_RECEIVED');
    await rightSurface.hover();
    assert.equal(await rightSurface.locator('.xterm-helper-textarea').evaluate(element => element === document.activeElement), true);
    await typeCommand(first, print('HOVER_RIGHT_RECEIVED'));
    await waitText(first, right, 'HOVER_RIGHT_RECEIVED');
    assert.equal(await first.evaluate(({ id, text }) => EyaPanels.call(id, 'getText').includes(text), { id: left, text: 'HOVER_RIGHT_RECEIVED' }), false, 'hovered terminal alone receives typing');

    // A newly focused attachment of the retained session must claim ownership
    // automatically. Octal printf avoids matching the shell's command echo.
    const second = await f.client({ webgl: false });
    const competing = await second.evaluate(session => EyaPanels.create('terminal', { session, restoring: true, command: '' }), session);
    await second.waitForFunction(id => EyaPanels.call(id, 'getState').connected, competing);
    await first.waitForFunction(id => !EyaPanels.call(id, 'getState').connected, left);
    await typeCommand(second, `printf '${octal('FOCUS_SECOND_RETAINED')}:%s\\n' "$EYA_FOCUS_KEEP"`);
    await waitText(second, competing, 'FOCUS_SECOND_RETAINED:kept');
    assert.equal(await first.evaluate(id => EyaPanels.call(id, 'getState').connected, right), true, 'other terminal stays attached');

    // Move from the other group back into the blocked terminal. Its hover focus
    // must reclaim the original shell, rather than start a replacement session.
    await first.bringToFront(); await rightSurface.hover(); await leftSurface.hover();
    await first.waitForFunction(id => EyaPanels.call(id, 'getState').connected, left);
    await second.waitForFunction(id => !EyaPanels.call(id, 'getState').connected, competing);
    await typeCommand(first, `printf '${octal('FOCUS_FIRST_RETAINED')}:%s\\n' "$EYA_FOCUS_KEEP"`);
    await waitText(first, left, 'FOCUS_FIRST_RETAINED:kept');
    const sockets = await second.evaluate(() => __sockets.length);
    await second.waitForTimeout(900);
    assert.equal(await second.evaluate(id => EyaPanels.call(id, 'getState').connected, competing), false, 'taken-over attachment remains blocked until another focus action');
    assert.equal(await second.evaluate(() => __sockets.length), sockets, 'blocked attachment does not start a takeover/reconnect loop');
    assert.equal(await first.evaluate(id => EyaPanels.call(id, 'getState').connected, left), true);
    assert.deepEqual(f.errors, []);
    console.log('Built-client hover routes keyboard input to real split terminals; focus takeover preserves the shell and avoids ownership ping-pong');
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
