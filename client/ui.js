import {
  createElement, ArrowLeft, ArrowRight, ArrowUp, CornerUpLeft, X, Ellipsis, EllipsisVertical,
  Settings, Unplug, Plug, Folder, FolderOpen, FolderPlus, Upload, Download, RefreshCw,
  Search, Save, Copy, File, FileCode, Image, Box, Link, Columns2, Rows2, MoveRight,
  Maximize, Ruler, SlidersHorizontal, Layers, Terminal, ChevronDown, Check, Pencil, Trash2,
  Plus, Cpu, Container, Play, Square, Activity, Palette, ListFilter, Pause, Logs, Info, Globe,
  CornerDownLeft, ClipboardPaste, Delete, Command, Move, ChevronsUp, ChevronsDown, ChevronFirst, ChevronLast, LogOut, IndentIncrease, ArrowDown,
} from 'lucide';

const icons = { ArrowLeft, ArrowRight, ArrowUp, CornerUpLeft, X, Ellipsis, EllipsisVertical,
  Settings, Unplug, Plug, Folder, FolderOpen, FolderPlus, Upload, Download, RefreshCw,
  Search, Save, Copy, File, FileCode, Image, Box, Link, Columns2, Rows2, MoveRight,
  Maximize, Ruler, SlidersHorizontal, Layers, Terminal, ChevronDown, Check, Pencil, Trash2,
  Plus, Cpu, Container, Play, Square, Activity, Palette, ListFilter, Pause, Logs, Info, Globe,
  CornerDownLeft, ClipboardPaste, Delete, Command, Move, ChevronsUp, ChevronsDown, ChevronFirst, ChevronLast, LogOut, IndentIncrease, ArrowDown };

export function icon(name) {
  return createElement(icons[name] || File, { class: 'ui-icon', width: 18, height: 18, 'stroke-width': 1.8, 'aria-hidden': 'true', focusable: 'false' });
}

export function buttonIcon(button, name, label = button.textContent.trim(), iconOnly = false) {
  const span = document.createElement('span'); span.className = iconOnly ? 'sr-only' : 'button-label'; span.textContent = label;
  button.replaceChildren(icon(name), span);
  button.classList.toggle('icon-button', iconOnly);
  button.setAttribute('aria-label', label);
  if (!button.title) button.title = label;
  return button;
}

const menus = new Set();
let menuSequence = 0;
export function closeMenus(inside) { for (const menu of menus) if (!inside || !menu.panel.contains(inside)) menu.close(); }
let toast, toastTimer;
export function notify(message) {
  if (!toast) {
    toast = document.createElement('div'); toast.className = 'ui-toast'; toast.setAttribute('role', 'status');
    (document.body || document.querySelector('body')).append(toast);
  }
  toast.textContent = message; toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}

// Native popovers escape clipping; dismissal is handled here consistently across
// touch browsers. Auto-popover light-dismiss can run between pointerup and click
// on its trigger, making the same tap close and then reopen the popup.
// The fallback temporarily portals the panel into the page body on older browsers.
export function createMenu(label, { iconName = 'Ellipsis', role = 'menu', iconOnly = true, onOpen } = {}) {
  const element = document.createElement('div'); element.className = 'ui-menu-anchor';
  const trigger = document.createElement('button'); trigger.type = 'button';
  buttonIcon(trigger, iconName, label, iconOnly);
  trigger.classList.add('menu-trigger');
  trigger.setAttribute('aria-haspopup', role);
  trigger.setAttribute('aria-expanded', 'false');
  const panel = document.createElement('div'); panel.className = 'ui-menu';
  panel.id = `eya-menu-${++menuSequence}`; panel.setAttribute('role', role); panel.setAttribute('aria-label', label);
  panel.setAttribute('popover', 'manual'); panel.hidden = true;
  trigger.setAttribute('aria-controls', panel.id);
  element.append(trigger, panel);
  const native = typeof panel.showPopover === 'function';
  const abort = new AbortController();
  let opened = false;
  function close(restoreFocus = false) {
    if (!opened) return;
    opened = false;
    if (native && panel.matches(':popover-open')) panel.hidePopover();
    panel.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    if (!native) element.append(panel);
    if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
  }
  function position() {
    const rect = trigger.getBoundingClientRect();
    const viewport = window.visualViewport || { offsetLeft: 0, offsetTop: 0, width: innerWidth, height: innerHeight };
    const left = viewport.offsetLeft + 8, top = viewport.offsetTop + 8;
    const width = panel.offsetWidth, height = panel.offsetHeight;
    panel.style.left = `${Math.max(left, Math.min(rect.right - width, left + viewport.width - width - 16))}px`;
    panel.style.top = `${Math.max(top, Math.min(rect.bottom + 5, top + viewport.height - height - 16))}px`;
  }
  function open(focus = false) {
    closeMenus(trigger);
    opened = true; panel.hidden = false;
    if (native) panel.showPopover();
    else (document.body || document.querySelector('body')).append(panel);
    trigger.setAttribute('aria-expanded', 'true'); onOpen?.(); position();
    if (focus) panel.querySelector('button:not(:disabled),select,input')?.focus({ preventScroll: true });
  }
  const api = { element, trigger, panel, open, close, position, destroy() { close(); abort.abort(); menus.delete(api); panel.remove(); element.remove(); } };
  menus.add(api);
  trigger.onclick = event => { event.preventDefault(); opened ? close() : open(); };
  trigger.addEventListener('keydown', event => { if (role !== 'listbox' && event.key === 'ArrowDown') { event.preventDefault(); open(true); } }, { signal: abort.signal });
  panel.addEventListener('toggle', event => {
    if (event.newState === 'closed' && opened && !panel.matches(':popover-open')) close();
  }, { signal: abort.signal });
  panel.addEventListener('click', event => {
    if (role === 'menu' && event.target.closest('button') && !event.target.closest('[data-keep-open]')) close();
  }, { signal: abort.signal });
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (role !== 'menu' || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...panel.querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    event.preventDefault(); items[next]?.focus();
  }, { signal: abort.signal });
  document.addEventListener('keydown', event => {
    if (opened && event.key === 'Escape') { event.preventDefault(); close(true); }
  }, { signal: abort.signal });
  document.addEventListener('pointerdown', event => {
    if (opened && !element.contains(event.target) && !panel.contains(event.target)) close();
  }, { signal: abort.signal });
  window.addEventListener('resize', () => { if (opened) position(); }, { signal: abort.signal });
  window.visualViewport?.addEventListener('resize', () => { if (opened) position(); }, { signal: abort.signal });
  return api;
}

export function menuHeading(panel, text) {
  const heading = document.createElement('div'); heading.className = 'ui-menu-heading'; heading.textContent = text; panel.append(heading);
}

export function menuAction(panel, button, name, label = button.textContent.trim()) {
  buttonIcon(button, name, label); button.classList.add('ui-menu-item'); button.setAttribute('role', 'menuitem');
  panel.append(button); return button;
}

const selectControls = new Map();
function selectLabel(select) {
  if (select.getAttribute('aria-label')) return select.getAttribute('aria-label');
  const label = select.labels?.[0] || select.closest('label');
  if (!label) return select.title || 'Choose option';
  const copy = label.cloneNode(true);
  for (const child of copy.querySelectorAll('select,button,.ui-menu,small')) child.remove();
  return copy.textContent.trim() || 'Choose option';
}

// Retain native form state and change events, while giving every surface the same
// keyboard/touch dropdown. Programmatic .value/.selectedIndex updates stay in sync.
export function enhanceSelect(select) {
  if (selectControls.has(select) || select.multiple || select.size > 1) return selectControls.get(select);
  const menu = createMenu(selectLabel(select), { role: 'listbox', iconName: 'ChevronDown' });
  menu.element.classList.add('ui-select'); menu.trigger.classList.add('ui-select-trigger');
  menu.trigger.classList.remove('icon-button'); menu.trigger.setAttribute('role', 'combobox');
  menu.panel.classList.add('ui-select-options');
  select.replaceWith(menu.element); menu.element.prepend(select);
  select.classList.add('ui-native-select'); select.setAttribute('aria-hidden', 'true'); select.tabIndex = -1;
  const valueLabel = document.createElement('span'); valueLabel.className = 'ui-select-value';
  menu.trigger.replaceChildren(valueLabel, icon('ChevronDown'));
  let optionButtons = [], typeahead = '', typeTimer, destroyed = false;
  const abort = new AbortController();
  const descriptors = [];
  function sync() {
    if (destroyed) return;
    const label = selectLabel(select);
    menu.trigger.setAttribute('aria-label', label); menu.trigger.title = label;
    menu.panel.setAttribute('aria-label', label);
    valueLabel.textContent = select.selectedOptions[0]?.label || 'Choose…';
    menu.trigger.disabled = select.disabled;
    menu.element.hidden = select.hidden;
    menu.element.classList.toggle('panel-switcher-control', select.classList.contains('panel-switcher'));
    optionButtons = [...select.options].map((option, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'ui-select-option';
      button.id = `${menu.panel.id}-option-${index}`; button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === select.selectedIndex)); button.tabIndex = -1;
      button.disabled = option.disabled || option.parentElement?.disabled === true; button.hidden = option.hidden;
      const label = document.createElement('span'); label.textContent = option.label;
      button.append(label, icon('Check'));
      button.onclick = event => { event.preventDefault(); event.stopPropagation(); choose(index); }; return button;
    });
    menu.panel.replaceChildren(...optionButtons);
  }
  function choose(index) {
    if (select.disabled || optionButtons[index]?.disabled) return;
    const changed = select.selectedIndex !== index;
    select.selectedIndex = index;
    if (changed) {
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    menu.close(true);
  }
  function focusOption(index) {
    const options = optionButtons.filter(button => !button.disabled && !button.hidden);
    const requested = optionButtons[index];
    const button = options.includes(requested) ? requested : options[0];
    button?.focus({ preventScroll: true }); button?.scrollIntoView({ block: 'nearest' });
    if (button) menu.trigger.setAttribute('aria-activedescendant', button.id);
  }
  function open() {
    if (menu.trigger.disabled) return;
    if (menu.trigger.getAttribute('aria-expanded') !== 'true') menu.open();
    menu.panel.style.minWidth = `${Math.max(160, menu.trigger.getBoundingClientRect().width)}px`;
    menu.position(); focusOption(select.selectedIndex);
  }
  menu.trigger.onclick = event => { event.preventDefault(); menu.trigger.getAttribute('aria-expanded') === 'true' ? menu.close() : open(); };
  const keydown = event => {
    const enabled = optionButtons.filter(button => !button.disabled && !button.hidden);
    const current = enabled.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (menu.trigger.getAttribute('aria-expanded') !== 'true') { open(); return; }
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length;
      const button = enabled[next]; button?.focus(); button?.scrollIntoView({ block: 'nearest' });
    } else if ((event.key === 'Enter' || event.key === ' ') && event.target === menu.trigger) {
      event.preventDefault(); open();
    } else if (event.key === 'Tab') {
      if (menu.trigger.getAttribute('aria-expanded') === 'true') { menu.trigger.focus(); menu.close(); }
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
      event.preventDefault(); typeahead += event.key.toLocaleLowerCase();
      clearTimeout(typeTimer); typeTimer = setTimeout(() => { typeahead = ''; }, 700);
      open(); const found = enabled.find(button => button.textContent.toLocaleLowerCase().startsWith(typeahead));
      found?.focus(); found?.scrollIntoView({ block: 'nearest' });
    }
  };
  menu.trigger.addEventListener('keydown', keydown, { signal: abort.signal });
  menu.panel.addEventListener('keydown', keydown, { signal: abort.signal });
  select.addEventListener('input', sync, { signal: abort.signal }); select.addEventListener('change', sync, { signal: abort.signal });
  select.addEventListener('focus', () => menu.trigger.focus(), { signal: abort.signal });
  select.addEventListener('click', event => { event.preventDefault(); open(); }, { signal: abort.signal });
  select.addEventListener('invalid', () => menu.trigger.focus(), { signal: abort.signal });
  for (const name of ['value', 'selectedIndex']) {
    const original = Object.getOwnPropertyDescriptor(select, name);
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, name);
    if (!descriptor?.get || !descriptor.set) continue;
    Object.defineProperty(select, name, { configurable: true, get() { return descriptor.get.call(this); }, set(value) { descriptor.set.call(this, value); sync(); } });
    descriptors.push([name, original]);
  }
  const control = { ...menu, sync, destroy() {
    if (destroyed) return; destroyed = true; clearTimeout(typeTimer); abort.abort();
    for (const [name, original] of descriptors) { if (original) Object.defineProperty(select, name, original); else delete select[name]; }
    select.classList.remove('ui-native-select'); select.removeAttribute('aria-hidden'); select.removeAttribute('tabindex');
    if (menu.element.parentNode) menu.element.replaceWith(select);
    menu.destroy(); selectControls.delete(select);
  } };
  selectControls.set(select, control); sync(); return control;
}

export function startControlEnhancement(root = document) {
  const scan = node => {
    if (node.nodeType !== 1 && node.nodeType !== 9) return;
    if (node.matches?.('select')) enhanceSelect(node);
    for (const select of node.querySelectorAll('select')) enhanceSelect(select);
  };
  scan(root);
  const observer = new MutationObserver(records => {
    const changed = new Set();
    for (const record of records) {
      const select = record.target.closest?.('select'); if (select) changed.add(select);
      for (const node of record.addedNodes) scan(node);
    }
    for (const select of changed) selectControls.get(select)?.sync();
    for (const [select, control] of selectControls) if (!select.isConnected) control.destroy();
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label', 'value', 'aria-label', 'hidden'] });
  return () => { observer.disconnect(); for (const control of [...selectControls.values()]) control.destroy(); };
}

export function attachFileDropzone(element, { onFiles, input, button } = {}) {
  const abort = new AbortController(); let depth = 0;
  if (input) {
    input.hidden = true;
    input.addEventListener('change', () => { if (input.files?.length) onFiles?.([...input.files]); input.value = ''; }, { signal: abort.signal });
  }
  if (button && input) button.addEventListener('click', () => input.click(), { signal: abort.signal });
  const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
  element.addEventListener('dragenter', event => { if (!hasFiles(event)) return; event.preventDefault(); depth++; element.classList.add('file-drop-active'); }, { signal: abort.signal });
  element.addEventListener('dragover', event => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }, { signal: abort.signal });
  element.addEventListener('dragleave', event => { if (!hasFiles(event)) return; if (--depth <= 0) { depth = 0; element.classList.remove('file-drop-active'); } }, { signal: abort.signal });
  element.addEventListener('drop', event => { if (!hasFiles(event)) return; event.preventDefault(); depth = 0; element.classList.remove('file-drop-active'); if (event.dataTransfer.files.length) onFiles?.([...event.dataTransfer.files]); }, { signal: abort.signal });
  return () => { abort.abort(); element.classList.remove('file-drop-active'); };
}
