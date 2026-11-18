import { icon } from './ui.js';

export function createAuxiliaryBar(bar, { send, paste, activateKeyboard, toggleModifier, panelId }) {
  let gesture, timer, repeat, pointerActivated = false, fnMode = 0;
  const modes = { ctrl: 0, alt: 0, shift: 0 };
  let lastActivation = { key: '', time: 0 };
  const arrows = { up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C' };
  const pages = { up: '\x1b[5~', down: '\x1b[6~', left: '\x1b[H', right: '\x1b[F' };
  const functions = ['\x1bOP', '\x1bOQ', '\x1bOR', '\x1bOS', ...[15,17,18,19,20,21,23,24].map(n => `\x1b[${n}~`)];
  function svg(contents) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', '0 0 32 28'); el.setAttribute('aria-hidden', 'true'); el.classList.add('aux-glyph'); el.innerHTML = contents; return el;
  }
  function button(key, name, glyph, parent = bar) {
    const el = document.createElement('button'); el.type = 'button'; el.dataset.key = key; el.title = name; el.setAttribute('aria-label', name);
    if (typeof glyph === 'string') { if (glyph) { const label = document.createElement('span'); label.textContent = glyph; el.append(label); } } else el.append(glyph);
    parent.append(el); return el;
  }
  bar.replaceChildren();
  const main = document.createElement('div'), fn = document.createElement('div'), numbers = document.createElement('div');
  main.className = fn.className = 'aux-row'; fn.hidden = true; numbers.className = 'aux-row aux-numbers'; numbers.hidden = true; bar.append(main, fn, numbers);
  button('escape', 'Escape', icon('CircleArrowOutUpLeft'), main);
  button('tab', 'Tab', svg('<path d="M4 14h20m-6-6 6 6-6 6M28 6v16" fill="none" stroke="currentColor" stroke-width="1.8"/>'), main);
  const modifierButtons = {};
  modifierButtons.ctrl = button('ctrl', 'Ctrl: tap once, double tap to lock', icon('ChevronUp'), main);
  const pg = button('page', 'Page navigation: swipe up Page Up, down Page Down, left Home, right End; hold to repeat', svg('<text x="16" y="17" text-anchor="middle" font-size="10" fill="currentColor">Pg</text><path d="m12 5 4-3 4 3m-8 18 4 3 4-3M6 10l-4 4 4 4m20-8 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/>'), main);
  const shiftAlt = button('shift-alt', 'Shift or Alt: swipe left for Shift, right for Alt', icon('ArrowBigUpDash'), main);
  modifierButtons.shift = shiftAlt.firstElementChild;
  modifierButtons.alt = icon('Option');
  shiftAlt.append(modifierButtons.alt);
  shiftAlt.setAttribute('aria-pressed', 'false');
  button('keyboard', 'Activate keyboard', icon('Keyboard'), main);
  const fnToggle = button('fn', 'Function keys: tap once, double tap to lock', 'Fn', main);
  fnToggle.setAttribute('aria-pressed', 'false');
  button('paste', 'Paste', icon('ClipboardPaste'), main);
  const pad = button('arrows', 'Arrow keys: swipe in a direction and hold to repeat', icon('Move'), main); pad.id = 'arrow-pad';
  button('menu', 'Numbers and symbols', icon('Ellipsis'), main);
  for (let i = 0; i < 6; i++) {
    const el = button(`f${i}`, `F${i*2+1} / F${i*2+2}; swipe left for odd, right for even`, '', fn);
    for (const number of [i*2+1, i*2+2]) { const symbol = document.createElement('span'); symbol.textContent = `F${number}`; el.append(symbol); }
  }
  for (let i = 0; i < 3; i++) { const blank = document.createElement('span'); blank.setAttribute('aria-hidden', 'true'); if (!i) blank.dataset.fnLock = ''; fn.append(blank); }
  const back = button('back', 'Back to auxiliary keys; Fn active', icon('ArrowLeft'), fn);
  const upperSymbols = ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')'];
  const lowerSymbols = ['/', '.', '-', '_', '=', '+', '[', ']', '\\', '↩'];
  for (let i = 0; i < 10; i++) {
    const digit = String((i + 1) % 10);
    const el = button(`number-${digit}`, `${digit}; swipe up ${upperSymbols[i]}; swipe down ${i === 9 ? 'back to auxiliary keys' : lowerSymbols[i]}`, '', numbers);
    for (const [name, value] of [['primary', digit], ['up', upperSymbols[i]], ['down', lowerSymbols[i]]]) {
      const symbol = document.createElement('span'); symbol.className = `aux-number-${name}`; symbol.textContent = value; el.append(symbol);
    }
  }
  function numberLayer(value) { stop(); numbers.hidden = !value; main.hidden = value; fn.hidden = true; }
  function previewSymbol(el, direction) {
    const key = el.dataset.key;
    if (key.startsWith('number-')) {
      const i = (Number(key.slice(7)) + 9) % 10;
      return direction === 'up' ? upperSymbols[i] : direction === 'down' ? lowerSymbols[i] : '';
    }
    if (/^f\d$/.test(key)) return `F${Number(key.slice(1))*2 + (direction === 'right' ? 2 : 1)}`;
    if (key === 'page') return { up: 'PgUp', down: 'PgDn', left: 'Home', right: 'End' }[direction];
    if (key === 'arrows') return { up: '↑', down: '↓', left: '←', right: '→' }[direction];
    if (key === 'shift-alt') return { left: '⇧', right: '⌥' }[direction];
    return '';
  }
  function preview(el, direction, distance) {
    const symbol = previewSymbol(el, direction);
    if (!symbol) { el.classList.remove('aux-swiping'); return; }
    let ghost = el.querySelector('.aux-preview');
    if (!ghost) { ghost = document.createElement('span'); ghost.className = 'aux-preview'; ghost.setAttribute('aria-hidden', 'true'); el.append(ghost); }
    ghost.textContent = symbol;
    const progress = Math.min(1, Math.max(0, (distance - 5) / 32));
    const offset = (1 - progress) * 14;
    ghost.style.transform = `translate(calc(-50% + ${direction === 'left' ? -offset : direction === 'right' ? offset : 0}px),calc(-50% + ${direction === 'up' ? -offset : direction === 'down' ? offset : 0}px)) scale(${.55 + progress * .45})`;
    ghost.style.color = `color-mix(in srgb, var(--ui-fg,white) ${Math.round(progress*100)}%, #92979c)`;
    el.style.setProperty('--aux-fade', String(1 - progress)); el.classList.add('aux-swiping');
  }
  function overlay(mode) {
    stop(); numbers.hidden = true; fnMode = mode; main.hidden = !!mode; fn.hidden = !mode;
    fnToggle.setAttribute('aria-pressed', String(!!mode));
    fn.classList.toggle('aux-locked', mode === 2); back.classList.toggle('aux-symbol-active', !!mode);
  }
  function activate(key, direction) {
    const time = performance.now(), mode = key === 'fn' ? fnMode : modes[key];
    const double = lastActivation.key === key && time - lastActivation.time < 400;
    const next = mode === 2 ? 0 : mode === 1 ? (direction || double ? 2 : 0) : 1;
    lastActivation = { key, time };
    if (key === 'fn') overlay(next);
    else { modes[key] = next; toggleModifier(key, next > 0, next === 2); }
  }
  function action(el, direction = '') {
    const key = el.dataset.key;
    if (key.startsWith('number-')) {
      const digit = key.slice(7), i = (Number(digit) + 9) % 10;
      if (digit === '0' && direction === 'down') { numberLayer(false); return; }
      return send(direction === 'up' ? upperSymbols[i] : direction === 'down' ? lowerSymbols[i] : digit);
    }
    else if (key === 'menu') numberLayer(true);
    else if (key === 'ctrl') activate(key);
    else if (key === 'shift-alt') {
      if (direction === 'left' || direction === 'right') activate(direction === 'left' ? 'shift' : 'alt', direction);
    }
    else if (key === 'keyboard') activateKeyboard();
    else if (key === 'page' || key === 'arrows') { if (direction) return send((key === 'page' ? pages : arrows)[direction]); }
    else if (/^f\d$/.test(key)) {
      const even = direction === 'right';
      for (const child of fn.querySelectorAll('[data-key^=f] span')) child.classList.remove('aux-symbol-active');
      el.children[even ? 1 : 0].classList.add('aux-symbol-active');
      const result = send(functions[Number(key.slice(1))*2 + (even ? 1 : 0)]);
      if (fnMode === 1) overlay(0);
      return result;
    }
    else if (key === 'fn') activate('fn');
    else if (key === 'back') overlay(0);
    else if (key === 'paste') paste();
    else if (key !== 'menu') return send(({ escape: '\x1b', tab: '\t' })[key] || key);
  }
  function stop() {
    clearTimeout(timer); clearInterval(repeat);
    if (gesture) {
      delete gesture.el.dataset.direction; gesture.el.classList.remove('aux-press', 'aux-swiping');
      gesture.el.style.removeProperty('--aux-fade'); gesture.el.querySelector('.aux-preview')?.remove();
    }
    gesture = null;
  }
  bar.addEventListener('pointerdown', event => {
    let el = event.target.closest('button');
    if (!el && event.target.closest('[data-fn-lock]') && fnMode === 1) el = fnToggle;
    if (!el?.dataset.key || !event.isPrimary || event.button > 0 || gesture) return;
    event.preventDefault(); pointerActivated = true; el.classList.add('aux-press'); el.setPointerCapture(event.pointerId);
    gesture = { el, id: event.pointerId, x: event.clientX, y: event.clientY, direction: '', panel: panelId() };
  });
  bar.addEventListener('pointermove', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 10) { clearTimeout(timer); clearInterval(repeat); gesture.direction = ''; delete gesture.el.dataset.direction; }
    if (distance < 5) { gesture.el.classList.remove('aux-swiping'); return; }
    const direction = Math.abs(dx) > Math.abs(dy) ? dx < 0 ? 'left' : 'right' : dy < 0 ? 'up' : 'down';
    preview(gesture.el, direction, distance);
    if (distance < 10 || gesture.direction === direction) return;
    clearTimeout(timer); clearInterval(repeat);
    gesture.direction = direction; gesture.el.dataset.direction = direction;
    if (['page', 'arrows'].includes(gesture.el.dataset.key)) {
      const data = action(gesture.el, direction);
      const tick = () => { if (!gesture || gesture.panel !== panelId()) { stop(); return; } if (typeof data === 'function') data(); else if (data) send(data); };
      timer = setTimeout(() => { tick(); if (gesture) repeat = setInterval(tick, 75); }, 400);
    }
  });
  bar.addEventListener('pointerup', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const { el, direction } = gesture;
    if (!['page', 'arrows'].includes(el.dataset.key) && (!direction || previewSymbol(el, direction))) action(el, direction);
    stop();
  });
  for (const type of ['pointercancel', 'lostpointercapture']) bar.addEventListener(type, stop);
  // Pointer actions are handled above; keyboard and assistive clicks use click.
  bar.addEventListener('click', event => { if (pointerActivated) { pointerActivated = false; return; } if (event.detail === 0 && event.target.closest('button')?.dataset.key) action(event.target.closest('button')); });
  bar.addEventListener('keydown', event => {
    pointerActivated = false;
    const el = event.target.closest('button'), direction = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[event.key];
    if (el && direction && previewSymbol(el, direction)) { event.preventDefault(); action(el, direction); }
  });
  window.addEventListener('blur', stop);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  return { stop, sync({ ctrlKey, shiftKey, altKey }, locks = new Set()) {
    for (const [key, value] of Object.entries({ ctrl: ctrlKey, shift: shiftKey, alt: altKey })) {
      modes[key] = value ? locks.has(key) ? 2 : 1 : 0;
      const el = modifierButtons[key];
      el.classList.toggle('aux-symbol-active', !!value); el.classList.toggle('aux-locked', modes[key] === 2);
      if (key === 'ctrl') el.setAttribute('aria-pressed', String(!!value));
    }
    shiftAlt.setAttribute('aria-pressed', String(!!(shiftKey || altKey)));
  } };
}
