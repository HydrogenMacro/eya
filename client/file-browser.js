import { createSubmenu } from './submenu.js';
import { matchesKeybind } from './keybinds-core.js';
import { createFileClipboard, createFileSelection } from './file-selection.js';
import { fileProgress } from './file-progress.js';
import { bindFileSorting, sortFiles, modifiedDate } from './file-presentation.js';
import { fileIcon } from './file-icons.js';
import { icon, buttonIcon, createMenu, menuAction, attachFileDropzone, notify } from './ui.js';
import { bindFileEntryInteractions } from './file-entry-interactions.js';
import { createFileCombobox, normalizeFilePath as normalize } from './file-combobox.js';

const parent = path => '/' + path.split('/').filter(Boolean).slice(0, -1).join('/');
const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`;

// Each instance owns its directory, selection, history, menus, and refresh lifecycle.
export function createFileBrowser({ openSettings, id, request, read, upload, openFile, getOpeners, openTerminal, download, preferences, onDelete, beforeDelete, clipboard, rename, cwd = '', lifecycle, onStateChange }) {
  const element = document.createElement('section'); element.className = 'file-instance';
  const toolbar = document.createElement('div'); toolbar.className = 'file-instance-toolbar';
  const pathInput = document.createElement('input'); pathInput.setAttribute('aria-label', 'Current directory'); pathInput.spellcheck = false;
  const pathbar = document.createElement('div'); pathbar.className = 'file-path-combobox'; pathbar.append(pathInput);
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search files'; search.setAttribute('aria-label', 'Search files');
  const searchbar = document.createElement('div'); searchbar.className = 'file-instance-search'; searchbar.append(icon('Search'), search);
  const view = document.createElement('div'); view.className = 'file-instance-view'; view.tabIndex = 0;
  const table = document.createElement('table'); table.className = 'file-list';
  const head = document.createElement('thead'), header = document.createElement('tr');
  for (const [name, cls] of [['Name', ''], ['Size', 'size'], ['Modified', 'modified'], ['Type', 'file-type'], ['', 'entry-actions']]) { const cell = document.createElement('th'); cell.textContent = name; cell.className = cls; header.append(cell); }
  head.append(header); const body = document.createElement('tbody'); table.append(head, body);
  const empty = document.createElement('div'); empty.className = 'file-empty'; empty.hidden = true; view.append(table, empty);
  const status = document.createElement('div'); status.className = 'file-status'; status.setAttribute('role', 'status');
  const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.hidden = true;
  let current = cwd, entries = [], selected = '', history = [], index = -1, generation = 0, disposed = false, active = false, timer, searchTimer, menus = [];
  let loading = 0, pendingRefresh = false, forward, searchRoot = null;
  let sorting = {};
  bindFileSorting(header, value => { sorting = value; render(); });
  const options = () => preferences();
  const selection = createFileSelection({ body, getEntries: () => sortFiles(entries, sorting), getPath: () => current,
    clipboard: clipboard || createFileClipboard({ read, upload, request }), request, refresh: () => refresh(), preferences: options,
    report: message => { if (!disposed) status.textContent = message; }, onDelete, beforeDelete, identity: () => lifecycle?.state.generation,
    valid: () => !disposed && lifecycle?.state.ready !== false });
  const fail = error => { if (!disposed) status.textContent = error.message || String(error); };
  function button(name, label, action) { const button = document.createElement('button'); button.type = 'button'; buttonIcon(button, name, label, true); button.onclick = action; return button; }
  const back = button('ArrowLeft', 'Back', () => navigateHistory(index - 1)); back.disabled = true;
  const go = button('ArrowRight', 'Go', () => navigate(normalize(pathValue())));
  const uploadButton = button('Upload', 'Upload', () => {});
  const menu = createMenu('File browser menu');
  for (const [label, name, action] of [
    ['New folder', 'FolderPlus', async () => { const name = prompt('New folder name:'); if (name) { try { await request('mkdir', { path: `${current}/${name}` }); await refresh(); } catch (error) { fail(error); } } }],
    ['Parent directory', 'ArrowUp', () => navigate(parent(current))],
    ['Forward', 'ArrowRight', () => navigateHistory(index + 1)],
  ]) { const actionButton = document.createElement('button'); actionButton.type = 'button'; actionButton.textContent = label; actionButton.onclick = action; menuAction(menu.panel, actionButton, name); if (label === 'Forward') { forward = actionButton; forward.disabled = true; } }
  const terminalButton = button('Terminal', 'Open directory in terminal', () => openTerminal?.(current)); terminalButton.hidden = !openTerminal;
  toolbar.append(back, pathbar, go, button('RefreshCw', 'Refresh', () => refresh()), terminalButton, uploadButton, menu.element, input);
  element.append(toolbar, searchbar, selection.element, view, status);
  const pathValue = () => pathInput.value.startsWith('/') ? pathInput.value : `${current}/${pathInput.value}`;
  pathInput.oninput = () => {
    if (pathInput.value.endsWith('../')) pathInput.value = normalize(pathValue()) + (normalize(pathValue()) === '/' ? '' : '/');
  };
  pathInput.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); pathCombo.close(); navigate(normalize(pathValue())); } };
  const searchSuggestions = () => search.value.trim() ? entries.filter(item => item.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())) : [];
  const searchCombo = createFileCombobox(search, { label: 'File search suggestions', suggestions: searchSuggestions,
    choose: item => { searchCombo.close(); activate(item); }, complete: item => { search.value = item.name; generation++; clearTimeout(searchTimer); searchTimer = setTimeout(() => load(searchRoot || current), 0); } });
  const pathCombo = createFileCombobox(pathInput, { label: 'Directory suggestions', async suggestions() {
    const value = pathValue(), end = value.lastIndexOf('/'), prefix = value.slice(end + 1).toLocaleLowerCase();
    const response = await request('list', { path: normalize(value.slice(0, end) || '/'), showHidden: options().showHidden });
    return response.entries.filter(item => item.name.toLocaleLowerCase().startsWith(prefix));
  }, choose: item => { pathCombo.close(); activate(item); }, complete: item => { pathInput.value = item.path + (item.kind === 'directory' ? '/' : ''); } });
  search.oninput = event => {
    clearTimeout(searchTimer); generation++;
    if (event.isComposing) return;
    let value = search.value, directory = searchRoot || current;
    while (value.startsWith('../')) { directory = parent(directory); value = value.slice(3); }
    if (value !== search.value) { search.value = value; searchRoot = directory; }
    searchTimer = setTimeout(() => load(searchRoot || current, searchRoot !== null), 250);
  };
  search.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); clearTimeout(searchTimer); searchCombo.close(); load(searchRoot || current); } };
  async function navigate(path, record = true, historyTarget) {
    search.value = ''; searchRoot = null; clearTimeout(searchTimer); pathCombo.close(); searchCombo.close();
    return load(path, record, true, false, historyTarget);
  }
  function navigateHistory(target) { if (target >= 0 && target < history.length) return navigate(history[target], false, target); }
  const menuOpen = () => !!element.querySelector('[aria-expanded=true]');
  async function load(path, record = false, scroll = false, automatic = false, historyTarget) {
    if (disposed) return false;
    const token = ++generation, query = search.value.trim();
    loading++;
    status.textContent = `${automatic ? 'Refreshing' : 'Loading'} directory · ${fileProgress()}`;
    view.setAttribute('aria-busy', 'true');
    try {
      const response = await request(query ? 'search' : 'list', { path: path || options().startingDirectory || '', query, showHidden: options().showHidden }, (loaded, total) => { if (token === generation && !disposed) status.textContent = `Loading directory · ${fileProgress(loaded, total)}`; });
      if (token !== generation || disposed || (automatic && menuOpen())) return false;
      const previous = current;
      current = response.path || path || current;
      if (document.activeElement !== pathInput) pathInput.value = current;
      entries = response.entries;
      if (previous !== current) selection.clear();
      if (Number.isInteger(historyTarget)) index = historyTarget;
      if (record && history[index] !== current) { history = history.slice(0, index + 1); history.push(current); index = history.length - 1; }
      if (selected && !entries.some(entry => entry.path === selected)) selected = '';
      back.disabled = index <= 0;
      forward.disabled = index >= history.length - 1;
      render(); if (document.activeElement === search) searchCombo.update(searchSuggestions()); if (scroll) view.scrollTop = 0;
      status.textContent = `${entries.length} items`;
      onStateChange?.();
      return true;
    } catch (error) { if (token === generation) fail(error); return false; }
    finally {
      loading--;
      if (!loading) view.setAttribute('aria-busy', 'false');
      if (!loading && pendingRefresh && !disposed) { pendingRefresh = false; queueMicrotask(() => refresh()); }
    }
  }
  function refresh(automatic = false) {
    if (disposed) return Promise.resolve(false);
    if (loading) { if (!automatic) pendingRefresh = true; return Promise.resolve(false); }
    return load(current, false, false, automatic);
  }
  function select(path, event) { selected = path; selection.select(entries.find(item => item.path === path) || { path, kind: 'parent' }, event); }
  function activate(item) { if (['directory', 'parent'].includes(item.kind)) navigate(item.path); else openFile(item.path); }
  async function action(item, action) {
    try {
      if (action === 'open') { activate(item); return; }
      if (action === 'copy') { selection.copy(); return; }
      if (action === 'delete') { await selection.remove(); return; }
      if (action === 'download') { const result = await read(item.path); download(item.path, result.bytes); return; }
      if (action === 'rename') { const name = prompt('New name:', item.name); if (!name || name === item.name) return; if (rename) await rename(item.path, name); else await request('rename', { path: item.path, newPath: name }); }
      await refresh();
    } catch (error) { fail(error); }
  }
  function render() {
    const focusedRow = document.activeElement?.closest?.('tr');
    const ownedFocus = focusedRow && body.contains(focusedRow);
    const focusedPath = ownedFocus && focusedRow.dataset.path;
    const focusedIndex = ownedFocus ? [...body.rows].indexOf(focusedRow) : -1;
    for (const menu of menus) menu.destroy(); menus = []; body.replaceChildren();
    const sorted = sortFiles(entries, sorting);
    const listed = !search.value && current !== '/' ? [{ name: '..', path: parent(current), kind: 'parent' }, ...sorted] : sorted;
    for (const item of listed) {
      const row = document.createElement('tr'); row.dataset.path = item.path; row.tabIndex = 0;
      row.classList.toggle('selected', selection.has(item.path));
      const name = document.createElement('td'); name.className = 'entry-name';
      const label = document.createElement('span'); label.textContent = item.name;
      name.append(fileIcon(item), label); name.title = item.path;
      const bytes = document.createElement('td'); bytes.className = 'size'; bytes.textContent = item.kind === 'file' ? size(item.size) : '—';
      const modified = document.createElement('td'); modified.className = 'modified'; modified.textContent = modifiedDate(item.modified); modified.title = item.modified ? new Date(item.modified).toLocaleString() : '';
      const type = document.createElement('td'); type.className = 'file-type'; type.textContent = item.kind === 'directory' ? 'Folder' : item.kind === 'parent' ? '—' : item.name.split('.').slice(1).at(-1)?.toUpperCase() || item.kind;
      const actions = document.createElement('td'); actions.className = 'entry-actions';
      if (item.kind !== 'parent') {
        const menu = createMenu(`Actions for ${item.name}`, { iconName: 'EllipsisVertical', onOpen: () => { if (!selection.has(item.path)) select(item.path); } }); menus.push(menu);
        menu.trigger.classList.add('file-entry-button');
        const openers = item.kind === 'file' ? getOpeners?.(item.path) || [] : [];
        for (const [key, title, glyph] of [['open','Open','File'], ['download','Download','Download'], ['copy','Copy selected files','Copy'], ['rename','Rename','Pencil'], ['delete','Delete','Trash2']]) {
          if ((key === 'download' && item.kind === 'directory') || (key === 'copy' && item.kind !== 'file')) continue;
          const button = document.createElement('button'); button.textContent = key === 'open' && openers.length > 1 ? 'Open With…' : title; button.type = 'button';
          if (key === 'open' && openers.length > 1) {
            button.dataset.keepOpen = '';
            menuAction(menu.panel, button, glyph);
            const submenu = createSubmenu({ parent:menu.panel, trigger:button, label:`Open ${item.name} with`, items:openers.map(opener => ({ id:opener.id,title:opener.title,action:() => openFile(item.path,false,opener.id) })), onChoose:() => menu.close() });
            const destroy = menu.destroy; menu.destroy = () => { submenu.destroy(); destroy(); };
          } else { button.onclick = () => action(item, key); menuAction(menu.panel, button, glyph); }
        }
        if (item.kind === 'directory' && openTerminal) { const terminal = document.createElement('button'); terminal.type = 'button'; terminal.textContent = 'Open in terminal'; terminal.onclick = () => openTerminal(item.path); menuAction(menu.panel, terminal, 'Terminal'); }
        menu.element.onclick = event => event.stopPropagation(); menu.element.ondblclick = event => event.stopPropagation(); actions.append(menu.element);
      }
      row.append(name, bytes, modified, type, actions);
      selection.decorate(row, item);
      bindFileEntryInteractions(row, event => select(item.path, event), () => activate(item));
      body.append(row);
    }
    selection.update();
    empty.hidden = !!entries.length; empty.textContent = search.value ? 'No matches' : 'Empty folder';
    if (ownedFocus) {
      const row = [...body.rows].find(row => row.dataset.path === focusedPath) || body.rows[Math.min(focusedIndex, body.rows.length - 1)];
      if (row) { row.focus({ preventScroll: true }); }
      else view.focus({ preventScroll: true });
    }
  }
  element.addEventListener('keydown', event => {
    if (matchesKeybind('files.path', event)) { event.preventDefault(); pathInput.focus(); pathInput.select(); return; }
    if (matchesKeybind('files.search', event)) { event.preventDefault(); search.focus(); search.select(); return; }
    if (selection.keydown(event)) return;
    if (event.target.closest('input,textarea,button,[role=combobox],.ui-menu')) return;
    const listed = [...body.rows], position = listed.findIndex(row => row.dataset.path === selected);
    let next;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !event.altKey) {
      next = event.key === 'Home' ? 0 : event.key === 'End' ? listed.length - 1 : Math.max(0, Math.min(listed.length - 1, position + (event.key === 'ArrowDown' ? 1 : -1)));
      if (listed[next]) { event.preventDefault(); select(listed[next].dataset.path, event); listed[next].focus(); }
    }
    const item = entries.find(item => item.path === selected);
    if (matchesKeybind('files.open', event)) { event.preventDefault(); const row = listed.find(row => row.dataset.path === selected); if (row) activate(item || { path: selected, kind: 'parent' }); }
    if (item && matchesKeybind('files.rename', event)) { event.preventDefault(); action(item, 'rename'); }
    else if (item && matchesKeybind('files.delete', event)) { event.preventDefault(); selection.remove(); }
    if (matchesKeybind('files.parent', event)) { event.preventDefault(); navigate(parent(current)); }
    if (matchesKeybind('files.refresh', event)) { event.preventDefault(); refresh(); }
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
    clearTimeout(timer); if (!active || disposed || lifecycle?.state.ready === false) return;
    timer = setTimeout(async () => { if (options().refreshInterval > 0 && !loading && !document.hidden && element.getClientRects().length && !menuOpen()) await refresh(true); schedule(); }, Math.max(1, options().refreshInterval || 5) * 1000);
  }
  const unsubscribe = lifecycle?.subscribe(state => {
    selection.update();
    if (!state.ready) { generation++; clearTimeout(timer); status.textContent = 'Disconnected · directory retained'; }
    else if (active) { refresh(); schedule(); }
  });
  return { id, title: 'Files', kind: 'browser', element,
    serialize: () => ({ id, title: 'Files', kind: 'files', config: { cwd: current } }),
    onActivate() { active = true; selection.update(); if (!current) navigate(options().startingDirectory || ''); else refresh(); schedule(); },
    onDeactivate() { active = false; clearTimeout(timer); pathCombo.close(); searchCombo.close(); },
    onClose() { disposed = true; generation++; unsubscribe?.(); clearTimeout(timer); clearTimeout(searchTimer); pathCombo.destroy(); searchCombo.destroy(); selection.dispose(); dropzone(); menu.destroy(); for (const item of menus) item.destroy(); },
    api: { openSettings, navigate, refresh, getPath: () => current, focusPath: () => pathInput.focus(), focusSearch: () => search.focus() },
  };
}
