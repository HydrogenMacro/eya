import { icon, buttonIcon, createMenu, menuAction, attachFileDropzone, notify } from './ui.js';

const parent = path => '/' + path.split('/').filter(Boolean).slice(0, -1).join('/');
const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`;

// Each instance owns its directory, selection, history, menus, and refresh lifecycle.
export function createFileBrowser({ id, request, read, upload, openFile, download, preferences, onDelete, rename }) {
  const element = document.createElement('section'); element.className = 'file-instance';
  const toolbar = document.createElement('div'); toolbar.className = 'file-instance-toolbar';
  const pathInput = document.createElement('input'); pathInput.setAttribute('aria-label', 'Current directory'); pathInput.spellcheck = false;
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search files'; search.setAttribute('aria-label', 'Search files');
  const searchbar = document.createElement('div'); searchbar.className = 'file-instance-search'; searchbar.append(icon('Search'), search);
  const view = document.createElement('div'); view.className = 'file-instance-view'; view.tabIndex = 0;
  const table = document.createElement('table'); table.className = 'file-list';
  const head = document.createElement('thead'), header = document.createElement('tr');
  for (const [name, cls] of [['Name', ''], ['Size', 'size'], ['Modified', 'modified'], ['', 'entry-actions']]) { const cell = document.createElement('th'); cell.textContent = name; cell.className = cls; header.append(cell); }
  head.append(header); const body = document.createElement('tbody'); table.append(head, body);
  const empty = document.createElement('div'); empty.className = 'file-empty'; empty.hidden = true; view.append(table, empty);
  const status = document.createElement('div'); status.className = 'file-status'; status.setAttribute('role', 'status');
  const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.hidden = true;
  let current = '', entries = [], selected = '', history = [], index = -1, generation = 0, disposed = false, active = false, timer, searchTimer, menus = [];
  let loading = 0, pendingRefresh = false, forward;
  const options = () => preferences();
  const fail = error => { if (!disposed) status.textContent = error.message || String(error); };
  function button(name, label, action) { const button = document.createElement('button'); button.type = 'button'; buttonIcon(button, name, label, true); button.onclick = action; return button; }
  const back = button('ArrowLeft', 'Back', () => navigateHistory(index - 1)); back.disabled = true;
  const go = button('ArrowRight', 'Go', () => navigate(pathInput.value));
  const uploadButton = button('Upload', 'Upload', () => {});
  const menu = createMenu('File browser menu');
  for (const [label, name, action] of [
    ['New folder', 'FolderPlus', async () => { const name = prompt('New folder name:'); if (name) { try { await request('mkdir', { path: `${current}/${name}` }); await refresh(); } catch (error) { fail(error); } } }],
    ['Refresh', 'RefreshCw', () => refresh()],
    ['Parent directory', 'ArrowUp', () => navigate(parent(current))],
    ['Forward', 'ArrowRight', () => navigateHistory(index + 1)],
  ]) { const actionButton = document.createElement('button'); actionButton.type = 'button'; actionButton.textContent = label; actionButton.onclick = action; menuAction(menu.panel, actionButton, name); if (label === 'Forward') { forward = actionButton; forward.disabled = true; } }
  toolbar.append(back, pathInput, go, uploadButton, menu.element, input);
  element.append(toolbar, searchbar, view, status);
  pathInput.onkeydown = event => { if (event.key === 'Enter') navigate(pathInput.value); };
  search.oninput = () => { clearTimeout(searchTimer); generation++; searchTimer = setTimeout(() => load(current), 250); };
  async function navigate(path, record = true, historyTarget) {
    search.value = ''; clearTimeout(searchTimer);
    return load(path, record, true, false, historyTarget);
  }
  function navigateHistory(target) { if (target >= 0 && target < history.length) return navigate(history[target], false, target); }
  const menuOpen = () => !!element.querySelector('[aria-expanded=true]');
  async function load(path, record = false, scroll = false, automatic = false, historyTarget) {
    if (disposed) return false;
    const token = ++generation, query = search.value.trim();
    loading++;
    try {
      const response = await request(query ? 'search' : 'list', { path: path || options().startingDirectory || '', query, showHidden: options().showHidden });
      if (token !== generation || disposed || (automatic && menuOpen())) return false;
      current = response.path || path || current; pathInput.value = current;
      entries = response.entries;
      if (Number.isInteger(historyTarget)) index = historyTarget;
      if (record && history[index] !== current) { history = history.slice(0, index + 1); history.push(current); index = history.length - 1; }
      if (selected && !entries.some(entry => entry.path === selected)) selected = '';
      back.disabled = index <= 0;
      forward.disabled = index >= history.length - 1;
      render(); if (scroll) view.scrollTop = 0;
      status.textContent = `${entries.length} items`;
      return true;
    } catch (error) { if (token === generation) fail(error); return false; }
    finally {
      loading--;
      if (!loading && pendingRefresh && !disposed) { pendingRefresh = false; queueMicrotask(() => refresh()); }
    }
  }
  function refresh(automatic = false) {
    if (disposed) return Promise.resolve(false);
    if (loading) { if (!automatic) pendingRefresh = true; return Promise.resolve(false); }
    return load(current, false, false, automatic);
  }
  function select(path) { selected = path; for (const row of body.rows) row.classList.toggle('selected', row.dataset.path === path); }
  function activate(item) { if (['directory', 'parent'].includes(item.kind)) navigate(item.path); else openFile(item.path); }
  async function action(item, action) {
    try {
      if (action === 'open') { activate(item); return; }
      if (action === 'download') { const result = await read(item.path); download(item.path, result.bytes); return; }
      if (action === 'rename') { const name = prompt('New name:', item.name); if (!name || name === item.name) return; if (rename) await rename(item.path, name); else await request('rename', { path: item.path, newPath: name }); }
      if (action === 'delete') {
        if (options().confirmDelete && !confirm(`Delete ${item.name}${item.kind === 'directory' ? ' and its contents' : ''}?`)) return;
        await request('delete', { path: item.path, recursive: item.kind === 'directory' }); onDelete?.(item.path);
      }
      await refresh();
    } catch (error) { fail(error); }
  }
  function render() {
    const focusedRow = document.activeElement?.closest?.('tr');
    const ownedFocus = focusedRow && body.contains(focusedRow);
    const focusedPath = ownedFocus && focusedRow.dataset.path;
    const focusedIndex = ownedFocus ? [...body.rows].indexOf(focusedRow) : -1;
    for (const menu of menus) menu.destroy(); menus = []; body.replaceChildren();
    const listed = !search.value && current !== '/' ? [{ name: '..', path: parent(current), kind: 'parent' }, ...entries] : entries;
    for (const item of listed) {
      const row = document.createElement('tr'); row.dataset.path = item.path; row.tabIndex = 0;
      row.classList.toggle('selected', item.path === selected);
      const name = document.createElement('td'); name.className = 'entry-name';
      const label = document.createElement('span'); label.textContent = item.name;
      name.append(icon(item.kind === 'parent' ? 'CornerUpLeft' : item.kind === 'directory' ? 'Folder' : 'File'), label); name.title = item.path;
      const bytes = document.createElement('td'); bytes.className = 'size'; bytes.textContent = item.kind === 'file' ? size(item.size) : '—';
      const modified = document.createElement('td'); modified.className = 'modified'; modified.textContent = item.modified ? new Date(item.modified).toLocaleString() : '—';
      const actions = document.createElement('td'); actions.className = 'entry-actions';
      if (item.kind !== 'parent') {
        const menu = createMenu(`Actions for ${item.name}`, { iconName: 'EllipsisVertical', onOpen: () => select(item.path) }); menus.push(menu);
        menu.trigger.classList.add('file-entry-button');
        for (const [key, title, glyph] of [['open','Open','File'], ['download','Download','Download'], ['rename','Rename','Pencil'], ['delete','Delete','Trash2']]) {
          if (key === 'download' && item.kind === 'directory') continue;
          const button = document.createElement('button'); button.textContent = title; button.type = 'button'; button.onclick = () => action(item, key); menuAction(menu.panel, button, glyph);
        }
        menu.element.onclick = event => event.stopPropagation(); menu.element.ondblclick = event => event.stopPropagation(); actions.append(menu.element);
      }
      row.append(name, bytes, modified, actions); row.onclick = () => select(item.path); row.ondblclick = () => activate(item);
      body.append(row);
    }
    empty.hidden = !!entries.length; empty.textContent = search.value ? 'No matches' : 'Empty folder';
    if (ownedFocus) {
      const row = [...body.rows].find(row => row.dataset.path === focusedPath) || body.rows[Math.min(focusedIndex, body.rows.length - 1)];
      if (row) { select(row.dataset.path); row.focus({ preventScroll: true }); }
      else view.focus({ preventScroll: true });
    }
  }
  element.addEventListener('keydown', event => {
    if (event.target.closest('input,textarea,button,[role=combobox],.ui-menu')) return;
    const listed = [...body.rows], position = listed.findIndex(row => row.dataset.path === selected);
    let next;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !event.altKey) {
      next = event.key === 'Home' ? 0 : event.key === 'End' ? listed.length - 1 : Math.max(0, Math.min(listed.length - 1, position + (event.key === 'ArrowDown' ? 1 : -1)));
      if (listed[next]) { event.preventDefault(); select(listed[next].dataset.path); listed[next].focus(); }
    }
    const item = entries.find(item => item.path === selected);
    if (event.key === 'Enter') { event.preventDefault(); const row = listed.find(row => row.dataset.path === selected); if (row) activate(item || { path: selected, kind: 'parent' }); }
    if (item && ['Delete', 'Backspace', 'F2'].includes(event.key)) { event.preventDefault(); action(item, event.key === 'F2' ? 'rename' : 'delete'); }
    if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); navigate(parent(current)); }
    if (event.key === 'F5') { event.preventDefault(); refresh(); }
  });
  const dropzone = attachFileDropzone(element, { input, button: uploadButton, async onFiles(files) {
    const destination = current;
    if (!destination) { fail(Error('Connect to browse files')); return; }
    for (const file of files) {
      try {
        status.textContent = `Uploading ${file.name}…`;
        try { await upload(`${destination}/${file.name}`, file, false); }
        catch (error) { if (!error.message.includes('already exists') || !confirm(`Replace ${file.name}?`)) throw error; await upload(`${destination}/${file.name}`, file, true); }
      } catch (error) { fail(error); return; }
    }
    notify('Upload complete'); if (destination === current) await refresh();
  } });
  function schedule() {
    clearTimeout(timer); if (!active || disposed) return;
    timer = setTimeout(async () => { if (options().refreshInterval > 0 && !loading && !document.hidden && element.getClientRects().length && !menuOpen()) await refresh(true); schedule(); }, Math.max(1, options().refreshInterval || 5) * 1000);
  }
  return { id, title: 'Files', kind: 'browser', element,
    onActivate() { active = true; if (!current) navigate(options().startingDirectory || ''); else refresh(); schedule(); },
    onDeactivate() { active = false; clearTimeout(timer); },
    onClose() { disposed = true; generation++; clearTimeout(timer); clearTimeout(searchTimer); dropzone(); menu.destroy(); for (const item of menus) item.destroy(); },
    api: { navigate, refresh, getPath: () => current, focusPath: () => pathInput.focus(), focusSearch: () => search.focus() },
  };
}
