import { buttonIcon, createMenu, menuAction, menuHeading, notify } from './ui.js';

// JSON object key order differs between JS descriptors and server serialization.
// Compare canonical records, including the server's explicit null session field.
const fingerprint = value => JSON.stringify({
  tabs: value.tabs.map(({ id, kind, title, session = null, minimized = false, config = {} }) => ({ id, kind, title, session, minimized, config })),
  layout: value.layout, preferences: value.preferences || {},
}, (key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const button = (text, action) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.onclick = action; return node; };
const iconButton = (name, label, action) => buttonIcon(button(label, action), name, label, true);
const moveType = 'application/x-eya-workspace-tab';

// All state here is page memory. Only acknowledged server revisions are saved.
export function createWorkspaces({ workbench, request, isReady, restoreTab, getPreferences = () => ({}), applyPreferences = () => {}, onWorkspaceChange = () => {} }) {
  let current = null, anonymous = null, baseline = '', pending = false, conflict = false, suspended = false, saving = false, epoch = 0, timer, remote = null, uncertain = null, moving = null, refreshGeneration = 0;
  const quick = createMenu('Workspaces', { iconName: 'Layers', iconOnly: false, onOpen: () => refreshQuick() });
  const label = quick.element;
  quick.trigger.id = 'workspaces';
  const sync = document.createElement('span'); sync.id = 'workspace-sync'; sync.setAttribute('role', 'status');
  const dialog = document.createElement('dialog'); dialog.id = 'workspaces-dialog';
  const heading = document.createElement('h2'); heading.textContent = 'Workspaces';
  const actions = document.createElement('div'); actions.className = 'actions';
  const columns = document.createElement('div'); columns.className = 'workspace-columns';
  const searchList = (title, label, className) => {
    const section = document.createElement('section'); section.className = 'workspace-section';
    const heading = document.createElement('h3'); heading.textContent = title;
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = label; search.setAttribute('aria-label', label);
    const list = document.createElement('div'); list.className = className; list.setAttribute('role', 'list'); list.setAttribute('aria-label', title); list.tabIndex = 0;
    section.append(heading, search, list); columns.append(section);
    return { section, search, list };
  };
  const workspacesList = searchList('Workspaces', 'Search workspaces', 'workspace-list');
  const tabsList = searchList('Open tabs · current workspace', 'Search open tabs', 'workspace-tabs');
  const list = workspacesList.list, tabs = tabsList.list;
  const error = document.createElement('p'); error.setAttribute('role', 'status');
  const moveHint = document.createElement('p'); moveHint.className = 'workspace-move-hint'; moveHint.setAttribute('role', 'status');
  const close = iconButton('X', 'Close workspaces', () => dialog.close());
  actions.append(buttonIcon(button('New workspace', () => run(async () => {
    const name = prompt('Workspace name:'); if (!name?.trim()) return;
    if (!canDiscard()) return;
    const response = await request('workspace.create', { name }); await open(response.workspace);
  })), 'Plus'), iconButton('RefreshCw', 'Refresh workspaces', () => refresh()));
  const header = document.createElement('div'); header.className = 'workspace-dialog-header'; header.append(heading, close);
  dialog.append(header, actions, error, columns, moveHint); (document.body || document.querySelector('body')).append(dialog);
  const style = document.createElement('style'); style.textContent = `
    #workspaces-dialog{width:min(980px,calc(100% - 24px));height:min(820px,88dvh);overflow:hidden;padding:18px}
    #workspaces-dialog[open]{display:grid;grid-template-rows:auto auto auto minmax(0,1fr) auto;gap:8px}
    #workspaces-dialog h2,#workspaces-dialog h3,#workspaces-dialog p{margin:0}#workspaces-dialog h3{font-size:14px}
    .workspace-dialog-header{display:flex;align-items:center;justify-content:space-between;gap:12px}.workspace-dialog-header h2{font-size:19px}.workspace-quick-list{display:flex;flex-direction:column;max-height:310px;overflow:auto;overscroll-behavior:contain}.workspace-quick-list .ui-menu-item[aria-current=true]{color:var(--ui-accent,#7fdbc5)}
    .workspace-columns{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:16px;min-height:0}
    .workspace-section{display:grid;grid-template-rows:auto auto minmax(0,1fr);gap:8px;min-width:0;min-height:0}
    .workspace-section>input{margin:0}.workspace-list,.workspace-tabs{display:flex;flex-direction:column;gap:8px;overflow:auto;overscroll-behavior:contain;min-height:0;padding:2px 4px 2px 2px}
    .workspace-entry{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:9px;border:1px solid var(--ui-border,#344854);border-radius:6px;flex-shrink:0}
    .workspace-entry[hidden]{display:none}.workspace-entry>span{flex:1;min-width:100px;overflow-wrap:anywhere}.workspace-entry>details{width:100%}.workspace-entry .icon-button{position:relative}
    .workspace-entry[aria-current=true]{border-color:var(--ui-accent,#7fdbc5)}.workspace-entry.workspace-drop{outline:2px solid var(--ui-accent,#7fdbc5);background:var(--ui-control,#28434b)}
    .workspace-entry[draggable=true]{cursor:grab}.workspace-entry.workspace-moving{opacity:.65}.workspace-drag-handle{touch-action:none;cursor:grab}
    .workspace-entries{display:grid;gap:6px;max-height:200px;overflow:auto;overscroll-behavior:contain;margin-top:8px}.workspace-entries .workspace-entry{padding:6px}
    .workspace-move-hint:empty{display:none}.workspace-move-hint{font-size:12px;color:var(--ui-muted,#a6b8c3);min-height:1.4em}
    #workspace-sync{font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#workspaces{max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    @media(max-width:680px){#workspaces-dialog{padding:12px}.workspace-columns{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr);gap:12px}.workspace-entry{padding:7px}}
  `;
  (document.head || document.querySelector('head')).append(style);
  function appearance(message) {
    const name = current ? (current.name || 'Anonymous workspace') : 'Workspaces';
    buttonIcon(quick.trigger, 'Layers', name); quick.trigger.disabled = !isReady();
    sync.textContent = message || (conflict ? 'Conflict · open Workspaces' : pending ? (isReady() ? 'Changes pending' : 'Offline · changes unsaved') : current ? (current.name ? 'Saved' : 'Temporary · not saved') : '');
    quick.trigger.title = `${name} · ${sync.textContent}`;
  }
  async function run(action) { try { error.textContent = ''; const result = await action(); if (dialog.open) await refresh(); return result; } catch (cause) { error.textContent = cause.message; notify(cause.message); } }
  function showManager() { quick.close(); if (!dialog.open) dialog.showModal(); refresh(); }
  let quickGeneration = 0;
  async function refreshQuick() {
    const generation = ++quickGeneration; quick.panel.replaceChildren();
    menuHeading(quick.panel, 'Workspaces');
    const entries = document.createElement('div'); entries.className = 'workspace-quick-list'; quick.panel.append(entries);
    const loading = document.createElement('span'); loading.className = 'ui-menu-heading'; loading.textContent = 'Loading…'; entries.append(loading);
    menuAction(quick.panel, button('Manage workspaces', showManager), 'Settings');
    try {
      const records = await request('workspace.list'); if (generation !== quickGeneration) return;
      entries.replaceChildren();
      for (const workspace of records.workspaces) {
        const selected = workspace.id === current?.id;
        const action = button(workspace.name || 'Anonymous workspace', () => run(async () => {
          if (selected) return;
          const response = await request('workspace.load', { workspace: workspace.id }); await open(response.workspace);
        }));
        menuAction(entries, action, selected ? 'Check' : 'Layers'); action.setAttribute('aria-current', String(selected));
      }
      if (!records.workspaces.length) loading.textContent = 'No workspaces';
      if (!records.workspaces.length) entries.append(loading);
      quick.position();
    } catch (cause) { if (generation === quickGeneration) loading.textContent = cause.message; }
  }
  dialog.addEventListener('close', () => { cancelMove(); refreshGeneration++; });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape' && moving) { event.preventDefault(); cancelMove(); } });
  function snapshot() { return { ...workbench.serialize(), preferences: getPreferences() }; }
  function changed() {
    if (!current || suspended) return;
    pending = fingerprint(snapshot()) !== baseline;
    appearance(); clearTimeout(timer);
    if (pending && !conflict) timer = setTimeout(save, 350);
  }
  workbench.root.addEventListener('eya-workbench-change', changed);
  function canDiscard(message = 'Discard unsaved editor buffers, queued terminal input, and pending workspace changes?') {
    return (!pending && ![...workbench.panels.values()].some(panel => (panel.groupId || panel.minimized) && (panel.dirty || (panel.kind === 'terminal' && panel.api?.getState?.().pendingInput > 0)))) || confirm(message);
  }
  async function open(workspace, { force = false } = {}) {
    if (!force) {
      await save();
      if (!canDiscard()) return false;
    }
    const attempt = ++epoch; suspended = true; clearTimeout(timer); conflict = false; remote = uncertain = null;
    onWorkspaceChange();
    workbench.clear({ detach: true }); current = workspace;
    applyPreferences(workspace.preferences || {});
    for (const descriptor of workspace.tabs) {
      if (attempt !== epoch) return false;
      try {
        await restoreTab(descriptor);
        if (attempt === epoch && !workbench.panels.has(descriptor.id)) placeholder(descriptor, 'This descriptor could not be restored independently.');
      }
      catch (cause) { if (attempt === epoch) placeholder(descriptor, cause.message); }
    }
    if (attempt !== epoch) return false;
    workbench.restoreMinimized(workspace.tabs);
    workbench.restoreLayout(workspace.layout);
    // Restoring must not rewrite descriptors because transient defaults changed.
    baseline = fingerprint(snapshot()); suspended = false; pending = false; appearance();
    if (dialog.open) dialog.close();
    return true;
  }
  function placeholder(descriptor, message) {
    if (workbench.panels.has(descriptor.id)) return;
    const element = document.createElement('section'); element.className = 'viewer-message';
    const detail = document.createElement('p'); detail.textContent = `${descriptor.title}: ${message || 'This panel is unavailable'}`;
    const retry = button('Retry', () => run(() => replaceDescriptor(descriptor)));
    element.append(detail, retry);
    if (descriptor.kind === 'file') element.append(button('Reload current file', () => run(async () => {
      if (!confirm('Reload the current file and reset its saved playback position?')) return;
      const current = { ...descriptor, config: { path: descriptor.config.path } };
      await replaceDescriptor(current);
    })));
    workbench.register({ id: descriptor.id, title: descriptor.title, kind: descriptor.kind, descriptor, element });
    workbench.open(descriptor.id);
  }
  async function replaceDescriptor(descriptor) {
    const attempt = epoch, previous = workbench.serialize(), layout = previous.layout;
    suspended = true; clearTimeout(timer); workbench.close(descriptor.id, true, { detach: true });
    try {
      await restoreTab(descriptor);
      if (attempt === epoch && !workbench.panels.has(descriptor.id)) placeholder(descriptor, 'Panel could not be restored.');
    } catch (cause) { if (attempt === epoch) placeholder(descriptor, cause.message); }
    finally {
      if (attempt === epoch) { workbench.restoreMinimized(previous.tabs); workbench.restoreLayout(layout); suspended = false; changed(); }
    }
  }
  async function save() {
    clearTimeout(timer);
    if (!current || !pending || conflict || suspended || saving || !isReady()) return;
    const attempt = epoch, id = current.id, revision = current.revision, value = snapshot(); saving = true;
    try {
      const response = await request('workspace.update', { workspace: id, revision, ...value });
      if (attempt !== epoch) return;
      const server = fingerprint(response.workspace);
      if (response.conflict && server !== fingerprint(value) && server !== uncertain?.fingerprint) { conflict = true; remote = response.workspace; appearance(); return; }
      current = response.workspace; baseline = server; uncertain = null;
      pending = fingerprint(snapshot()) !== baseline; appearance();
    } catch (cause) { if (attempt === epoch) { uncertain = { workspace: id, revision, fingerprint: fingerprint(value) }; pending = true; appearance(`Unsaved · ${cause.message}`); } }
    finally { saving = false; if (pending && !conflict && isReady()) timer = setTimeout(save, 1500); }
  }
  async function authenticated(initial) {
    anonymous = initial.workspace?.id || null;
    if (!current && !initial.workspace) { appearance(initial.warning || 'Create or select a workspace'); if (initial.warning) notify(initial.warning); return { openedInitial: false }; }
    if (!current) { const opened = await open(initial.workspace, { force: true }); if (initial.warning) notify(initial.warning); return { openedInitial: opened, workspace: current }; }
    const attempt = epoch;
    try {
      const response = await request('workspace.load', { workspace: current.id });
      if (attempt !== epoch) return;
      if (response.workspace.revision !== current.revision) {
        const value = fingerprint(response.workspace);
        if (value === fingerprint(snapshot()) || (uncertain?.workspace === current.id && value === uncertain.fingerprint)) { current = response.workspace; baseline = value; pending = fingerprint(snapshot()) !== baseline; uncertain = null; }
        else if (value !== baseline) { remote = response.workspace; conflict = true; }
        else current = response.workspace;
      }
      appearance(); if (pending) save();
    } catch (cause) {
      if (attempt !== epoch) return;
      if (!current.name && initial.workspace && cause.message === 'Workspace no longer exists') {
        // Anonymous records intentionally disappear on server restart. Keep
        // surviving editors/views and bind their recipes to the new temporary
        // record instead of replacing the page or spawning another default tab.
        current = initial.workspace; remote = uncertain = null; conflict = false;
        baseline = fingerprint(current); pending = fingerprint(snapshot()) !== baseline;
        appearance(); if (pending) save();
      } else { conflict = true; appearance(`Workspace unavailable · ${cause.message}`); }
    }
    return { openedInitial: false, workspace: current };
  }
  function row(parent, text, controls = []) {
    const item = document.createElement('div'); item.className = 'workspace-entry'; item.setAttribute('role', 'listitem');
    const copy = document.createElement('span'); copy.textContent = text; item.append(copy, ...controls); parent.append(item);
    item.dataset.search = text.toLocaleLowerCase();
    return item;
  }
  function filter(container, search) {
    const query = search.value.trim().toLocaleLowerCase();
    for (const item of container.children) item.hidden = !!query && !item.dataset.search?.includes(query);
  }
  workspacesList.search.oninput = () => filter(list, workspacesList.search);
  tabsList.search.oninput = () => filter(tabs, tabsList.search);
  function cancelMove() {
    moving = null; moveHint.textContent = '';
    for (const item of dialog.querySelectorAll('.workspace-drop,.workspace-moving')) item.classList.remove('workspace-drop', 'workspace-moving');
  }
  function beginMove(panel) {
    if (!current) return;
    moving = { tab: panel.id, workspace: current.id, epoch };
    moveHint.textContent = `Move ${panel.title} to a workspace`;
    tabs.querySelector(`[data-tab-id="${CSS.escape(panel.id)}"]`)?.classList.add('workspace-moving');
  }
  async function moveTab(targetId) {
    const source = moving; cancelMove();
    if (!source || source.epoch !== epoch || source.workspace !== current?.id || targetId === current.id) return;
    const panel = workbench.panels.get(source.tab);
    if (!panel || !(panel.groupId || panel.minimized)) return;
    if ((panel.dirty || (panel.kind === 'terminal' && panel.api?.getState?.().pendingInput > 0)) && !confirm(`Move ${panel.title} and discard its unsaved buffer or queued input?`)) return;
    changed(); await save();
    if (source.epoch !== epoch) return;
    if (pending || conflict) throw Error('Save or resolve this workspace before moving a tab.');
    const target = await request('workspace.load', { workspace: targetId });
    if (source.epoch !== epoch) return;
    const response = await request('workspace.move_tab', { workspace: current.id, revision: current.revision, target: target.workspace.id, targetRevision: target.workspace.revision, tab: panel.id });
    if (response.conflict) throw Error('A workspace changed. Refresh and retry the move.');
    if (source.epoch !== epoch) return;
    suspended = true;
    try {
      workbench.close(panel.id, true, { detach: true }); current = response.workspace;
      workbench.restoreMinimized(current.tabs); workbench.restoreLayout(current.layout);
      baseline = fingerprint(snapshot()); pending = false; appearance();
    } finally { suspended = false; }
    moveHint.textContent = `${panel.title} moved to ${target.workspace.name || 'Anonymous workspace'}.`;
  }
  function dropTarget(item, workspace) {
    item.dataset.workspaceId = workspace.id; item.tabIndex = 0;
    const allowed = () => moving?.epoch === epoch && moving.workspace === current?.id && workspace.id !== current.id;
    item.addEventListener('dragover', event => {
      if (!allowed() || !event.dataTransfer.types.includes(moveType)) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'move'; item.classList.add('workspace-drop');
    });
    item.addEventListener('dragleave', event => { if (!item.contains(event.relatedTarget)) item.classList.remove('workspace-drop'); });
    item.addEventListener('drop', event => {
      if (!allowed()) return;
      event.preventDefault(); event.stopPropagation();
      const payload = event.dataTransfer.getData(moveType);
      if (payload !== moving.tab) { cancelMove(); return; }
      run(() => moveTab(workspace.id));
    });
    item.addEventListener('keydown', event => {
      if (event.target !== item || event.key !== 'Enter' || !allowed()) return;
      event.preventDefault(); run(() => moveTab(workspace.id));
    });
  }
  function dragTab(item, panel, handle) {
    item.draggable = true; item.dataset.tabId = panel.id;
    item.addEventListener('dragstart', event => {
      if (event.target.closest('button') && !event.target.closest('.workspace-drag-handle')) { event.preventDefault(); return; }
      beginMove(panel); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(moveType, panel.id);
    });
    item.addEventListener('dragend', () => { if (moving) cancelMove(); });
    handle.classList.add('workspace-drag-handle');
    handle.onclick = () => {
      beginMove(panel);
      [...list.querySelectorAll('[data-workspace-id]')].find(row => row.dataset.workspaceId !== current?.id && !row.hidden)?.focus();
    };
    let touch;
    handle.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      event.preventDefault(); beginMove(panel); handle.setPointerCapture(event.pointerId); touch = { id: event.pointerId, target: null };
    });
    handle.addEventListener('pointermove', event => {
      if (touch?.id !== event.pointerId) return;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-workspace-id]');
      for (const row of list.children) row.classList.toggle('workspace-drop', row === target && row.dataset.workspaceId !== current?.id);
      touch.target = target?.dataset.workspaceId;
      // Keep long lists reachable while holding a tab at their upper/lower edge.
      const rect = list.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX <= rect.right) {
        if (event.clientY < rect.top + 30) list.scrollTop -= 20;
        if (event.clientY > rect.bottom - 30) list.scrollTop += 20;
      }
    });
    handle.addEventListener('pointerup', event => {
      if (touch?.id !== event.pointerId) return;
      const target = touch.target; touch = null;
      if (target) run(() => moveTab(target)); else cancelMove();
    });
    handle.addEventListener('pointercancel', () => { touch = null; cancelMove(); });
  }
  async function refresh() {
    if (!isReady()) { error.textContent = 'Connect to manage workspaces.'; return; }
    const generation = ++refreshGeneration;
    try {
      const [records, live] = await Promise.all([request('workspace.list'), request('session.list')]);
      if (generation !== refreshGeneration) return;
      list.replaceChildren(); tabs.replaceChildren(); cancelMove();
      error.textContent = records.warning || '';
      if (conflict) {
        row(list, 'Workspace changed elsewhere', [
          button('Reload saved workspace', () => run(async () => { if (canDiscard()) { const response = await request('workspace.load', { workspace: current.id }); await open(response.workspace, { force: true }); } })),
          button('Keep as new workspace', () => run(async () => {
            if (!canDiscard('Save this layout as a new workspace? Unsaved editor buffers and queued terminal input will be discarded. Live sessions remain in the original workspace.')) return;
            const name = prompt('New workspace name:'); if (!name?.trim()) return;
            const value = snapshot(); value.tabs = value.tabs.map(tab => ({ ...tab, session: null }));
            const created = await request('workspace.create', { name });
            const response = await request('workspace.update', { workspace: created.workspace.id, revision: created.workspace.revision, ...value });
            await open(response.workspace, { force: true });
          })),
        ]);
      }
      for (const workspace of records.workspaces) {
        const selected = workspace.id === current?.id;
        const item = row(list, `${workspace.name || 'Anonymous workspace'}${selected ? ' · open' : ''}${workspace.name ? '' : ' · temporary'} · ${workspace.tabs.length} tabs`, [
          iconButton('FolderOpen', 'Open', () => run(async () => {
            if (selected) { dialog.close(); return; }
            const response = await request('workspace.load', { workspace: workspace.id }); await open(response.workspace);
          })),
          iconButton(workspace.name ? 'Pencil' : 'Save', workspace.name ? 'Rename' : 'Save workspace', () => run(async () => {
            const name = prompt('Workspace name:', workspace.name || ''); if (!name?.trim()) return;
            if (selected) { await save(); if (pending || conflict) throw Error('Resolve pending workspace changes before saving.'); }
            const response = await request('workspace.rename', { workspace: workspace.id, revision: selected ? current.revision : workspace.revision, name });
            if (response.conflict) throw Error('Workspace changed. Refresh and retry.');
            if (selected) { current = response.workspace; appearance(); }
          })),
          iconButton('Copy', 'Save as', () => run(async () => {
            const name = prompt('Copy workspace name:'); if (!name?.trim()) return;
            if (selected) { await save(); if (pending || conflict) throw Error('Resolve pending workspace changes before copying.'); }
            const response = await request('workspace.copy', { workspace: workspace.id, revision: selected ? current.revision : workspace.revision, name });
            if (response.conflict) throw Error('Workspace changed. Refresh and retry.');
          })),
          iconButton('Trash2', 'Delete', () => run(async () => {
            const owned = live.sessions.filter(session => session.workspace === workspace.id);
            if (!confirm(`Delete ${workspace.name || 'Anonymous workspace'}${owned.length ? ` and end its ${owned.length} live sessions` : ''}?`)) return;
            if (selected && !canDiscard()) return;
            const response = await request('workspace.delete', { workspace: workspace.id, revision: workspace.revision });
            if (response.conflict) throw Error('Workspace changed. Refresh and retry.');
            if (selected) {
              suspended = true; workbench.clear({ detach: true }); current = null; pending = false; conflict = false; suspended = false;
              const initial = await request('workspace.start'); anonymous = initial.workspace.id; await open(initial.workspace, { force: true });
            }
            const failures = [];
            for (const session of response.sessions || owned.map(session => session.id)) {
              try { await request('session.end', { session }); } catch (cause) { failures.push(cause.message); }
            }
            if (failures.length) throw Error(`Workspace deleted; ${failures.length} session end requests were not confirmed. Use session.list / session.end to inspect and retry unconfirmed session cleanup.`);
          })),
        ]);
        item.setAttribute('aria-current', String(selected)); dropTarget(item, workspace);
        const details = document.createElement('details');
        const summary = document.createElement('summary'); summary.textContent = 'Saved tabs'; details.append(summary);
        details.addEventListener('toggle', () => {
          if (!details.open || details.children.length > 1) return;
          const entries = document.createElement('div'); entries.className = 'workspace-entries';
          for (const tab of workspace.tabs) {
            const session = live.sessions.find(session => session.id === tab.session);
            const status = tab.session ? (session?.status || 'session unavailable') : ['terminal', 'web-browser'].includes(tab.kind) ? 'no live session' : 'saved';
            const control = selected ? iconButton('Focus', `Focus ${tab.title}`, () => { workbench.activate(tab.id); dialog.close(); }) : button('Open workspace', () => run(async () => {
              const response = await request('workspace.load', { workspace: workspace.id });
              if (await open(response.workspace) && workbench.panels.has(tab.id)) workbench.activate(tab.id);
            }));
            row(entries, `${tab.title} · ${tab.kind}${tab.minimized ? ' · minimized' : ''} · ${status}${tab.config.path || tab.config.cwd ? ` · ${tab.config.path || tab.config.cwd}` : ''}`, [control]);
          }
          if (!workspace.tabs.length) row(entries, 'No saved tabs');
          details.append(entries);
        });
        item.append(details);
      }
      if (!records.workspaces.length) row(list, 'No saved workspaces');
      for (const panel of workbench.panels.values()) if (panel.groupId || panel.minimized) {
        const handle = iconButton('Move', `Move ${panel.title}`, () => {});
        const controls = [handle, iconButton('Focus', `Focus ${panel.title}`, () => { workbench.activate(panel.id); dialog.close(); })];
        if (!panel.minimized) controls.push(iconButton('Minus', `Minimize ${panel.title}`, () => run(async () => { workbench.minimize(panel.id); changed(); await save(); })));
        controls.push(iconButton('X', `Close ${panel.title}`, () => run(async () => { workbench.close(panel.id); changed(); await save(); })));
        const item = row(tabs, `${panel.title} · ${panel.kind}${panel.minimized ? ' · minimized' : ''}${panel.dirty ? ' · unsaved editor buffer' : ''}`, controls);
        dragTab(item, panel, handle);
      }
      if (!tabs.children.length) row(tabs, 'No open tabs');
      filter(list, workspacesList.search); filter(tabs, tabsList.search);
    } catch (cause) { if (generation === refreshGeneration) error.textContent = cause.message; }
  }
  window.addEventListener('beforeunload', event => {
    if (pending || [...workbench.panels.values()].some(panel => (panel.groupId || panel.minimized) && panel.dirty)) { event.preventDefault(); event.returnValue = ''; }
  });
  setInterval(() => {
    if (!current || suspended || !isReady()) return;
    const id = current.id, attempt = epoch;
    request('workspace.renew', { workspace: id }).then(response => {
      if (attempt === epoch && !response.renewed) { conflict = true; appearance('Workspace lease expired · save as a new workspace'); }
    }).catch(cause => { if (attempt === epoch) appearance(`Workspace lease · ${cause.message}`); });
  }, 60000);
  appearance();
  function reset() {
    epoch++; refreshGeneration++; cancelMove(); workspacesList.search.value = tabsList.search.value = '';
    suspended = true; clearTimeout(timer); onWorkspaceChange(); workbench.clear({ detach: true });
    current = anonymous = remote = uncertain = null; baseline = ''; pending = conflict = false; suspended = false; appearance();
  }
  return { label, sync, authenticated, changed, save, reset, open: id => run(async () => { const response = await request('workspace.load', { workspace: id }); await open(response.workspace); }), disconnected: () => appearance(),
    manage: showManager, getState: () => ({ workspace: current, pending, conflict, anonymous }), placeholder };
}
