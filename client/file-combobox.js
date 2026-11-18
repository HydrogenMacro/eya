import { icon } from './ui.js';

let sequence = 0;
export function normalizeFilePath(path) {
  const parts = [];
  for (const part of path.split('/')) { if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part); }
  return '/' + parts.join('/');
}

// Keep DOM focus in the input: assistive technology follows aria-activedescendant,
// while pointer choices work without blurring the input before click is delivered.
export function createFileCombobox(input, { label, suggestions, choose, complete }) {
  const list = document.createElement('div'); list.className = 'file-combobox-options';
  list.id = `file-combobox-${++sequence}`; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', label);
  list.setAttribute('popover', 'manual'); list.hidden = true;
  const anchor = input.parentElement; anchor.append(list);
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false'); input.autocomplete = 'off';
  const abort = new AbortController(), native = typeof list.showPopover === 'function';
  let items = [], active = -1, opened = false, wanted = false, generation = 0, timer;
  function hide() {
    opened = false; active = -1;
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
    if (native && list.matches(':popover-open')) list.hidePopover();
    list.hidden = true; if (!native) anchor.append(list);
  }
  function close() { wanted = false; generation++; clearTimeout(timer); hide(); }
  function position() {
    const rect = input.getBoundingClientRect(), viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    list.style.width = `${Math.max(0, Math.min(Math.max(rect.width, 240), width - 16))}px`;
    list.style.left = `${Math.max(left + 8, Math.min(rect.left, left + width - list.offsetWidth - 8))}px`;
    list.style.maxHeight = `${Math.min(300, Math.max(80, height / 2 - 16))}px`;
    list.style.top = `${rect.bottom + list.offsetHeight + 4 <= top + height ? rect.bottom + 4 : Math.max(top + 8, rect.top - list.offsetHeight - 4)}px`;
  }
  function select(index) {
    active = index;
    for (let i = 0; i < list.children.length; i++) list.children[i].setAttribute('aria-selected', String(i === active));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', list.children[active].id);
      list.children[active].scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function update(values) {
    if (document.activeElement !== input) return;
    const selectedPath = items[active]?.path;
    items = values.slice(0, 100); list.replaceChildren(); active = -1;
    input.removeAttribute('aria-activedescendant');
    if (!items.length) { hide(); return; }
    for (const [index, item] of items.entries()) {
      const option = document.createElement('div'); option.id = `${list.id}-${index}`;
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
      const text = document.createElement('span'); text.textContent = item.path; option.append(icon(item.kind === 'directory' ? 'Folder' : 'File'), text);
      option.title = item.path;
      option.addEventListener('pointerdown', event => event.preventDefault());
      option.onclick = () => { close(); choose(item); };
      list.append(option);
    }
    opened = true; list.hidden = false; input.setAttribute('aria-expanded', 'true');
    if (native) { if (!list.matches(':popover-open')) list.showPopover(); }
    else document.body.append(list);
    position();
    const previous = items.findIndex(item => item.path === selectedPath);
    if (previous >= 0) select(previous);
  }
  async function show(direction) {
    wanted = true;
    const token = ++generation;
    try {
      const values = await suggestions();
      if (token !== generation) return;
      update(values);
      if (opened && direction) select(direction > 0 ? 0 : items.length - 1);
    } catch { if (token === generation) close(); }
  }
  input.addEventListener('input', event => { close(); if (!event.isComposing) { wanted = true; timer = setTimeout(() => show(), 200); } }, { signal: abort.signal });
  input.addEventListener('focus', () => { if (input.value) show(); }, { signal: abort.signal });
  input.addEventListener('blur', close, { signal: abort.signal });
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation(); clearTimeout(timer);
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      if (!opened) show(direction); else select(active < 0 ? direction > 0 ? 0 : items.length - 1 : (active + direction + items.length) % items.length);
    } else if (opened && active >= 0 && ['Home', 'End'].includes(event.key)) {
      event.preventDefault(); select(event.key === 'Home' ? 0 : items.length - 1);
    } else if (opened && active >= 0 && event.key === 'Enter') {
      event.preventDefault(); event.stopImmediatePropagation(); const item = items[active]; close(); choose(item);
    } else if (wanted && event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); close();
    } else if (event.key === 'Tab') {
      if (opened && active >= 0) complete?.(items[active]);
      close();
    }
  }, { capture: true, signal: abort.signal });
  document.addEventListener('pointerdown', event => { if (event.target !== input && !list.contains(event.target)) close(); }, { signal: abort.signal });
  window.addEventListener('resize', close, { signal: abort.signal });
  document.addEventListener('scroll', event => { if (opened && !list.contains(event.target)) close(); }, { capture: true, signal: abort.signal });
  return { update(values) { if (wanted) update(values); }, close, destroy() { close(); abort.abort(); list.remove(); } };
}
