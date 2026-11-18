import { matchesKeybind } from './keybinds-core.js';
import { buttonIcon } from './ui.js';

const MAX_BATCH = 1000;
const join = (directory, name) => `${directory === '/' ? '' : directory}/${name}`;
const within = (path, parent) => path === parent || path.startsWith(parent + '/');

// Only paths are retained; file bytes are transferred one file at a time.
export function createFileClipboard({ read, upload, request, identity = () => null }) {
  let clipboard = [], owner;
  const listeners = new Set();
  const changed = () => { for (const listener of listeners) listener(); };
  return {
    get count() { return owner === identity() ? clipboard.length : 0; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    copy(items) {
      if (!items.length || items.length > MAX_BATCH) throw Error(`Select between 1 and ${MAX_BATCH} files.`);
      if (items.some(item => item.kind !== 'file')) throw Error('Copy supports regular files. Select files without folders or symbolic links.');
      clipboard = items.map(({ path, name }) => ({ path, name })); owner = identity(); changed();
      return clipboard.length;
    },
    async paste(directory, report, valid = () => true) {
      const batch = clipboard.slice(), attempt = owner;
      const check = () => { if (identity() !== attempt || !valid()) throw Error('File operation stopped because the connection or pane changed.'); };
      if (!directory || !batch.length || attempt !== identity()) throw Error('Copy files from this connection before pasting.');
      let copied = 0;
      for (const item of batch) {
        check();
        if (!item.name || item.name.includes('/') || item.name.includes('\0') || ['.', '..'].includes(item.name)) throw Error('Invalid file name.');
        report(`Copying ${copied + 1}/${batch.length}: ${item.name}…`);
        const { bytes } = await read(item.path); check();
        const destination = join(directory, item.name);
        if (destination === item.path) {
          const dot = item.name.lastIndexOf('.'), stem = dot > 0 ? item.name.slice(0, dot) : item.name, suffix = dot > 0 ? item.name.slice(dot) : '';
          let created = false;
          for (let index = 1; index <= 100; index++) {
            check();
            try { await upload(join(directory, `${stem} copy${index === 1 ? '' : ` ${index}`}${suffix}`), bytes, false); created = true; break; }
            catch (error) { if (!/already exists/i.test(error.message)) throw error; }
          }
          if (!created) throw Error('Too many existing copies. Rename a copy before pasting again.');
        } else {
          try { await upload(destination, bytes, false); }
          catch (error) {
            if (!/already exists/i.test(error.message)) throw error;
            check();
            if (!confirm(`${item.name} already exists. Replace it?`)) continue;
            const meta = await request('stat', { path: destination }); check();
            await upload(destination, bytes, true, meta.version);
          }
        }
        copied++;
      }
      return copied;
    },
  };
}

export function createFileSelection({ body, getEntries, getPath, clipboard, request, refresh, preferences, report, onDelete = () => {}, beforeDelete = () => true, identity = () => null, valid = () => true }) {
  const selected = new Set();
  let anchor = '', busy = false;
  const element = document.createElement('div'); element.className = 'file-selection-bar'; element.setAttribute('aria-label', 'File selection actions');
  const all = document.createElement('input'); all.type = 'checkbox'; all.setAttribute('aria-label', 'Select all entries');
  const count = document.createElement('span'); count.className = 'file-selection-count'; count.setAttribute('role', 'status');
  const makeButton = (glyph, label, action) => { const button = document.createElement('button'); button.type = 'button'; buttonIcon(button, glyph, label, true); button.onclick = action; element.append(button); return button; };
  element.append(all, count);
  const copyButton = makeButton('Copy', 'Copy selected files', () => copy());
  const pasteButton = makeButton('ClipboardPaste', 'Paste files', () => paste());
  const deleteButton = makeButton('Trash2', 'Delete selected entries', () => remove());
  const items = () => getEntries().filter(item => selected.has(item.path));
  function update() {
    const entries = getEntries(), paths = new Set(entries.map(item => item.path));
    for (const path of selected) if (!paths.has(path)) selected.delete(path);
    for (const row of body.rows) {
      const checked = selected.has(row.dataset.path); row.classList.toggle('selected', checked); row.setAttribute('aria-selected', String(checked));
      const checkbox = row.querySelector('.file-select-checkbox'); if (checkbox) checkbox.checked = checked;
    }
    count.textContent = `${selected.size} selected`;
    all.checked = !!entries.length && selected.size === entries.length; all.indeterminate = !!selected.size && !all.checked; all.disabled = busy || !entries.length;
    copyButton.disabled = busy || !selected.size || items().some(item => item.kind !== 'file');
    pasteButton.disabled = busy || !getPath() || !clipboard?.count;
    deleteButton.disabled = busy || !selected.size;
  }
  all.onchange = () => { selected.clear(); if (all.checked) for (const item of getEntries()) selected.add(item.path); update(); };
  function select(item, event = {}) {
    if (busy) return;
    if (item.kind === 'parent') { selected.clear(); anchor = ''; update(); return; }
    if (event.shiftKey && anchor) {
      const entries = getEntries(), start = entries.findIndex(value => value.path === anchor), end = entries.findIndex(value => value.path === item.path);
      if (!event.ctrlKey && !event.metaKey && !event.altKey) selected.clear();
      if (start >= 0 && end >= 0) for (const value of entries.slice(Math.min(start, end), Math.max(start, end) + 1)) selected.add(value.path);
    } else {
      const toggle = event.ctrlKey || event.metaKey || event.altKey;
      if (!toggle) selected.clear();
      if (toggle && selected.has(item.path)) selected.delete(item.path); else selected.add(item.path);
      anchor = item.path;
    }
    update();
  }
  function decorate(row, item) {
    if (item.kind === 'parent') return;
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'file-select-checkbox'; checkbox.setAttribute('aria-label', `Select ${item.name}`);
    checkbox.onchange = () => select(item, { ctrlKey: true }); row.firstElementChild.prepend(checkbox);
  }
  function copy() {
    try { const total = clipboard.copy(items()); report(`${total} file${total === 1 ? '' : 's'} copied. Choose a folder and Paste.`); }
    catch (error) { report(error.message); }
    update();
  }
  async function paste() {
    if (busy) return;
    busy = true; update(); const directory = getPath(); let message;
    try { const total = await clipboard.paste(directory, report, valid); message = `Pasted ${total} file${total === 1 ? '' : 's'}.`; }
    catch (error) { message = `Paste stopped: ${error.message} Files already copied are retained.`; }
    finally { if (valid() && getPath() === directory) await refresh(); busy = false; update(); if (valid()) report(message); }
  }
  async function remove() {
    if (busy) return;
    const picked = items();
    if (!picked.length) return;
    if (picked.length > MAX_BATCH) { report(`Delete at most ${MAX_BATCH} entries at a time.`); return; }
    const batch = picked.filter(item => !picked.some(parent => parent !== item && parent.kind === 'directory' && within(item.path, parent.path)));
    if (preferences().confirmDelete && !confirm(`Delete ${batch.length} selected entr${batch.length === 1 ? 'y' : 'ies'}${batch.some(item => item.kind === 'directory') ? ' and all contents of selected folders' : ''}? This cannot be undone.`)) return;
    if (!beforeDelete(batch)) return;
    busy = true; update(); const attempt = identity(); let deleted = 0, failure;
    try {
      for (const item of batch) {
        if (!valid() || identity() !== attempt) throw Error('Connection or pane changed.');
        report(`Deleting ${deleted + 1}/${batch.length}: ${item.name}…`);
        await request('delete', { path: item.path, recursive: item.kind === 'directory' });
        deleted++;
        if (!valid() || identity() !== attempt) throw Error('Connection or pane changed.');
        selected.delete(item.path); onDelete(item.path);
      }
    } catch (error) { failure = error.message; }
    finally { if (valid()) await refresh(); busy = false; update(); if (valid()) report(`Deleted ${deleted}/${batch.length} entries.${failure ? ` Stopped: ${failure}` : ''}`); }
  }
  function keydown(event) {
    if (event.target.closest('input:not(.file-select-checkbox),textarea,button,select,[contenteditable],.ui-menu,[role=combobox]')) return false;
    if (matchesKeybind('files.selectAll', event)) { selected.clear(); for (const item of getEntries()) selected.add(item.path); update(); }
    else if (matchesKeybind('files.copy', event)) { if (window.getSelection()?.toString()) return false; copy(); }
    else if (matchesKeybind('files.paste', event)) paste();
    else if (matchesKeybind('files.delete', event) && selected.size) remove();
    else return false;
    event.preventDefault(); event.stopPropagation(); return true;
  }
  const unsubscribe = clipboard?.subscribe(update); update();
  return { element, select, decorate, update, copy, paste, remove, keydown, has: path => selected.has(path), clear() { selected.clear(); anchor = ''; update(); }, dispose: () => unsubscribe?.() };
}
