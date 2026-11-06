import { icon, buttonIcon, createMenu, menuAction, menuHeading } from './ui.js';

export class PanelWorkbench {
  constructor(root) {
    this.root = root;
    this.panels = new Map();
    this.types = new Map();
    this.pendingIds = new Set();
    this.nextPanel = 1;
    this.groups = new Map();
    this.nextGroup = 1;
    this.draggedPanel = '';
    this.activeGroup = null;
    if (!document.getElementById('panel-launcher-style')) {
      const style = document.createElement('style'); style.id = 'panel-launcher-style';
      style.textContent = `
        .panel-group-actions>.panel-quick{width:30px;height:32px;padding:5px;border:0;border-radius:0;background:transparent}
        .panel-group-actions>.panel-quick:hover{background:#304957}
        .panel-start{display:flex;flex-direction:column;min-width:0;min-height:0;padding:clamp(18px,4vw,42px);overflow:hidden}
        .panel-start-header{flex:0 0 auto;width:min(100%,900px);margin:0 auto 18px}
        .panel-start-kicker{margin:0 0 5px;color:var(--ui-accent,#7fdbc5);font-size:11px;font-weight:750;letter-spacing:.09em;text-transform:uppercase}
        .panel-start h2{margin:0;font-size:clamp(22px,3vw,30px);letter-spacing:-.035em}
        .panel-start-description{max-width:620px;margin:7px 0 16px;color:var(--ui-muted,#9bb0bc);font-size:13px;line-height:1.45}
        .panel-start-search{display:flex;align-items:center;gap:9px;max-width:620px;padding:0 12px;border:1px solid var(--ui-border,#344854);border-radius:calc(var(--ui-radius,5px) + 3px);background:var(--ui-control,#253541)}
        .panel-start-search:focus-within{border-color:var(--ui-accent,#7fdbc5);box-shadow:0 0 0 2px color-mix(in srgb,var(--ui-accent,#7fdbc5) 20%,transparent)}
        .panel-start-search>.ui-icon{flex:0 0 auto;width:17px;color:var(--ui-muted,#9bb0bc)}
        .panel-start-search>input{width:100%;min-width:0;margin:0;padding:11px 0;border:0;outline:0;background:transparent;font-size:16px}
        .panel-start-results{min-height:18px;margin:7px 2px 0;color:var(--ui-muted,#9bb0bc);font-size:11px}
        .panel-start-browser{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:0 max(2px,calc((100% - 900px)/2)) 24px}
        .panel-start-category{margin:0 0 20px}
        .panel-start-category>h3{position:sticky;top:0;z-index:1;margin:0 0 8px;padding:7px 2px 6px;background:var(--ui-bg,#10151b);color:var(--ui-muted,#9bb0bc);font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase}
        .panel-start-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,290px),1fr));gap:8px}
        .panel-start-item{display:grid;grid-template-columns:42px minmax(0,1fr) 18px;align-items:center;gap:12px;min-height:72px;padding:11px 12px;text-align:left;border-color:var(--ui-border,#344854);background:color-mix(in srgb,var(--ui-control,#253541) 76%,transparent)}
        .panel-start-item:hover{border-color:color-mix(in srgb,var(--ui-accent,#7fdbc5) 55%,var(--ui-border,#344854));transform:translateY(-1px)}
        .panel-start-item-icon{display:grid;place-items:center;width:42px;height:42px;border-radius:11px;background:color-mix(in srgb,var(--ui-accent,#7fdbc5) 14%,var(--ui-surface,#192730));color:var(--ui-accent,#7fdbc5)}
        .panel-start-item-icon>.ui-icon{width:21px;height:21px}
        .panel-start-item-copy{display:flex;min-width:0;flex-direction:column;gap:3px}
        .panel-start-item-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:700;color:var(--ui-fg,#e4edf2)}
        .panel-start-item-description{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;color:var(--ui-muted,#9bb0bc);font-size:12px;line-height:1.35}
        .panel-start-item-arrow{width:16px;color:var(--ui-muted,#9bb0bc);opacity:.55}
        .panel-start-item:hover .panel-start-item-arrow{color:var(--ui-accent,#7fdbc5);opacity:1;transform:translateX(2px)}
        .panel-start-empty{display:grid;min-height:180px;place-items:center;padding:24px;border:1px dashed var(--ui-border,#344854);border-radius:var(--ui-radius,5px);color:var(--ui-muted,#9bb0bc);text-align:center}
        .panel-start-status{flex:0 0 auto;width:min(100%,900px);min-height:20px;margin:0 auto;color:#edbda7;font-size:13px}
        .panel-empty>button{background:transparent;border-color:transparent}.panel-group-header{min-height:35px}
        @media(max-width:760px),(pointer:coarse){.panel-group-actions>.panel-quick{width:30px;height:36px}.panel-tab{max-width:170px}.panel-start{padding:14px}.panel-start-header{margin-bottom:10px}.panel-start-description{margin-bottom:12px}.panel-start-browser{padding-inline:0}.panel-start-list{grid-template-columns:1fr}.panel-start-item{min-height:68px}.panel-start-category>h3{top:-1px}}
      `;
      (document.head || document.querySelector('head')).append(style);
    }
    this.switcher = document.createElement('select');
    this.switcher.className = 'panel-switcher';
    this.switcher.setAttribute('aria-label', 'Switch panel');
    this.switcher.onchange = () => this.activate(this.switcher.value);
    root.before(this.switcher);
    root.replaceChildren();
    this.createGroup(root);
    this.staging = document.createElement('div');
    this.staging.className = 'panel-staging';
    this.staging.hidden = true;
    root.append(this.staging);
  }

  createGroup(parent) {
    const id = `group-${this.nextGroup++}`;
    const element = document.createElement('section');
    element.className = 'panel-group';
    element.dataset.group = id;
    const header = document.createElement('header');
    header.className = 'panel-group-header';
    const tabs = document.createElement('nav');
    tabs.className = 'panel-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Panel tabs');
    const actions = document.createElement('div');
    actions.className = 'panel-group-actions';
    const splitRight = this.actionButton('⇥', 'Split active panel right');
    const splitDown = this.actionButton('⇩', 'Split active panel down');
    const add = this.actionButton('+', 'New panel');
    buttonIcon(add, 'Plus', 'New panel', true); add.classList.add('panel-quick');
    buttonIcon(splitRight, 'Columns2', 'Split right', true); splitRight.classList.add('panel-quick');
    buttonIcon(splitDown, 'Rows2', 'Split down', true); splitDown.classList.add('panel-quick');
    const close = this.actionButton('×', 'Close empty panel group');
    const move = this.actionButton('⇄', 'Move active panel to next group');
    const menu = createMenu('Panel layout', { onOpen: () => {
      close.disabled = !!group.panels.length || this.groups.size === 1;
      move.disabled = !group.active || this.groups.size === 1;
    } });
    menuAction(menu.panel, move, 'MoveRight', 'Move to next group');
    menuHeading(menu.panel, 'Group');
    menuAction(menu.panel, close, 'X', 'Close empty group');
    actions.append(add, splitRight, splitDown, menu.element);
    header.append(tabs, actions);
    const host = document.createElement('div');
    host.className = 'panel-host';
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    const emptyAdd = this.actionButton('+ New panel', 'New panel');
    buttonIcon(emptyAdd, 'Plus', 'New panel'); empty.append(emptyAdd);
    host.append(empty);
    element.append(header, host);
    const group = { id, element, tabs, host, empty, menu, panels: [], active: '' };
    this.groups.set(id, group);
    parent.append(element);
    add.onclick = emptyAdd.onclick = () => this.openStart(group.id);
    splitRight.onclick = () => this.splitActive(group, 'vertical');
    splitDown.onclick = () => this.splitActive(group, 'horizontal');
    close.onclick = () => this.removeEmptyGroup(group);
    move.onclick = () => {
      const others = [...this.groups.values()].filter(candidate => candidate !== group);
      if (group.active && others.length) this.move(group.active, others[0].id);
    };
    element.addEventListener('pointerdown', () => this.setActiveGroup(group));
    for (const target of [tabs, host]) {
      target.addEventListener('dragover', event => { if (this.draggedPanel) event.preventDefault(); });
      target.addEventListener('drop', event => {
        event.preventDefault();
        const targetTab = event.target.closest?.('[data-panel]');
        if (this.draggedPanel) this.move(this.draggedPanel, group.id, true, targetTab?.dataset.panel);
      });
    }
    this.renderGroup(group);
    return group;
  }

  actionButton(text, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.title = label;
    button.setAttribute('aria-label', label);
    return button;
  }

  registerType(definition) {
    if (!definition || typeof definition.id !== 'string' || !definition.id || typeof definition.create !== 'function') throw Error('A panel type requires an id and create function.');
    if (this.types.has(definition.id)) throw Error(`Panel type ${definition.id} is already registered.`);
    const keywords = Array.isArray(definition.keywords) ? definition.keywords : typeof definition.keywords === 'string' ? definition.keywords.split(/[\s,]+/) : [];
    this.types.set(definition.id, {
      ...definition,
      title: typeof definition.title === 'string' && definition.title.trim() ? definition.title.trim() : definition.id,
      icon: typeof definition.icon === 'string' && definition.icon ? definition.icon : 'File',
      description: typeof definition.description === 'string' ? definition.description.trim() : '',
      category: typeof definition.category === 'string' && definition.category.trim() ? definition.category.trim() : 'General',
      keywords: keywords.map(value => String(value).trim()).filter(Boolean),
      order: Number.isFinite(definition.order) ? definition.order : 100,
      hidden: definition.hidden === true,
    });
    this.refreshStarters();
    return definition.id;
  }

  listTypes() {
    return [...this.types.values()]
      .filter(type => !type.hidden)
      .sort((a, b) => a.order - b.order || a.category.localeCompare(b.category) || a.title.localeCompare(b.title))
      .map(({ id, title, icon, description, category, keywords, order }) => ({ id, title, icon, description, category, keywords: [...keywords], order }));
  }

  async create(typeId, options = {}) {
    const type = this.types.get(typeId);
    if (!type) throw Error(`Unknown panel type ${typeId}.`);
    const groupId = this.groups.has(options.groupId) ? options.groupId : this.activeGroup?.id;
    let id = options.id;
    if (id && (this.panels.has(id) || this.pendingIds.has(id))) throw Error(`Panel ${id} is already registered or opening.`);
    if (!id) do { id = `${typeId}:${this.nextPanel++}`; } while (this.panels.has(id) || this.pendingIds.has(id));
    this.pendingIds.add(id);
    try {
      const result = await type.create({ ...options, id, type: typeId, groupId, workbench: this });
      let panelId;
      if (typeof result === 'string') panelId = result;
      else {
        try { panelId = this.register({ icon: type.icon, ...result, id: result?.id || id, kind: result?.kind || typeId }); }
        catch (error) { result?.onClose?.(); throw error; }
      }
      this.open(panelId, { groupId });
      return panelId;
    } finally { this.pendingIds.delete(id); }
  }

  openStart(groupId = this.activeGroup?.id) {
    const existing = [...this.panels.values()].find(panel => panel.kind === 'start' && panel.groupId === groupId);
    if (existing) { this.activate(existing.id); return existing.id; }
    let id; do { id = `start:${this.nextPanel++}`; } while (this.panels.has(id) || this.pendingIds.has(id));
    const element = document.createElement('section'); element.className = 'panel-start';
    const header = document.createElement('header'); header.className = 'panel-start-header';
    const kicker = document.createElement('p'); kicker.className = 'panel-start-kicker'; kicker.textContent = 'App launcher';
    const heading = document.createElement('h2'); heading.textContent = 'New panel';
    const description = document.createElement('p'); description.className = 'panel-start-description'; description.textContent = 'Open a tool in this panel group. New panel types appear here automatically.';
    const searchLabel = document.createElement('label'); searchLabel.className = 'panel-start-search';
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search panels…'; search.autocomplete = 'off'; search.spellcheck = false; search.setAttribute('aria-label', 'Search panels');
    searchLabel.append(icon('Search'), search);
    const results = document.createElement('div'); results.className = 'panel-start-results'; results.setAttribute('aria-live', 'polite');
    header.append(kicker, heading, description, searchLabel, results);
    const browser = document.createElement('div'); browser.className = 'panel-start-browser'; browser.setAttribute('role', 'region'); browser.setAttribute('aria-label', 'Panel types');
    const empty = document.createElement('div'); empty.className = 'panel-start-empty'; empty.hidden = true;
    const status = document.createElement('div'); status.className = 'panel-start-status'; status.setAttribute('role', 'status');
    element.append(header, browser, status);
    const renderStart = () => {
      const query = search.value.trim().toLocaleLowerCase();
      const types = this.listTypes().filter(type => !query || [type.id, type.title, type.description, type.category, ...type.keywords].join(' ').toLocaleLowerCase().includes(query));
      const groups = new Map();
      for (const type of types) {
        if (!groups.has(type.category)) groups.set(type.category, []);
        groups.get(type.category).push(type);
      }
      const sections = [];
      for (const [category, entries] of groups) {
        const categoryElement = document.createElement('section'); categoryElement.className = 'panel-start-category'; categoryElement.setAttribute('aria-label', category);
        const categoryHeading = document.createElement('h3'); categoryHeading.textContent = category;
        const list = document.createElement('div'); list.className = 'panel-start-list';
        for (const type of entries) {
          const button = this.actionButton(type.title, type.title); button.className = 'panel-start-item';
          const iconTile = document.createElement('span'); iconTile.className = 'panel-start-item-icon'; iconTile.append(icon(type.icon));
          const copy = document.createElement('span'); copy.className = 'panel-start-item-copy';
          const title = document.createElement('span'); title.className = 'panel-start-item-title'; title.textContent = type.title;
          const detail = document.createElement('span'); detail.className = 'panel-start-item-description'; detail.textContent = type.description || `Open ${type.title}`;
          copy.append(title, detail);
          const arrow = icon('ArrowRight'); arrow.classList.add('panel-start-item-arrow');
          button.replaceChildren(iconTile, copy, arrow);
          button.setAttribute('aria-label', type.title);
          button.onclick = async () => {
            button.disabled = true; status.textContent = '';
            const destination = this.panels.get(id)?.groupId;
            try {
              await this.create(type.id, { groupId: destination });
              if (this.panels.has(id)) this.close(id);
            } catch (error) { status.textContent = error.message || 'Could not open panel'; }
            finally { button.disabled = false; }
          };
          list.append(button);
        }
        categoryElement.append(categoryHeading, list); sections.push(categoryElement);
      }
      empty.textContent = query ? `No panels match “${search.value.trim()}”.` : 'No panel types are registered yet.';
      empty.hidden = types.length > 0;
      browser.replaceChildren(...sections, empty);
      results.textContent = `${types.length} panel${types.length === 1 ? '' : 's'}${query ? ' found' : ' available'}`;
    };
    search.addEventListener('input', renderStart);
    search.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); browser.querySelector('.panel-start-item')?.focus(); }
      else if (event.key === 'Escape' && search.value) { event.preventDefault(); search.value = ''; renderStart(); }
    });
    browser.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...browser.querySelectorAll('.panel-start-item:not(:disabled)')];
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (Math.max(0, index) + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next].focus(); buttons[next].scrollIntoView({ block: 'nearest' });
    });
    this.register({ id, title: 'New panel', kind: 'start', element, renderStart, onActivate: () => {
      if (matchMedia('(pointer:fine)').matches) queueMicrotask(() => search.focus({ preventScroll: true }));
    } });
    this.panels.get(id).renderStart();
    this.open(id, { groupId });
    return id;
  }

  refreshStarters() { for (const panel of this.panels.values()) panel.renderStart?.(); }

  register(definition) {
    if (!definition || typeof definition.id !== 'string' || !definition.id || !(definition.element instanceof Element)) {
      throw Error('A panel requires a unique id and DOM element.');
    }
    if (this.panels.has(definition.id)) throw Error(`Panel ${definition.id} is already registered.`);
    const panel = {
      title: definition.id,
      closeable: true,
      retain: false,
      dirty: false,
      ...definition,
      groupId: '',
    };
    panel.element.classList.add('panel-surface');
    panel.element.hidden = true;
    this.staging.append(panel.element);
    this.panels.set(panel.id, panel);
    return panel.id;
  }

  update(id, changes) {
    const panel = this.requirePanel(id);
    if (changes.element && changes.element !== panel.element) {
      if (!(changes.element instanceof Element)) throw Error('Panel element must be a DOM element.');
      changes.element.classList.add('panel-surface');
      changes.element.hidden = panel.element.hidden;
      if (panel.element.isConnected) panel.element.replaceWith(changes.element);
      panel.element = changes.element;
    }
    for (const field of ['title', 'dirty', 'kind', 'icon', 'onActivate', 'onDeactivate', 'onLayout', 'onClose', 'beforeClose']) {
      if (Object.hasOwn(changes, field)) panel[field] = changes[field];
    }
    const group = this.groups.get(panel.groupId);
    if (group) this.renderGroup(group);
  }

  open(id, options = {}) {
    const panel = this.requirePanel(id);
    if (!panel.groupId) {
      const group = this.groups.get(options.groupId) || this.activeGroup || this.groups.values().next().value;
      group.panels.push(id);
      panel.groupId = group.id;
      group.host.append(panel.element);
      this.renderGroup(group);
    }
    if (options.activate !== false) this.activate(id);
    return panel.groupId;
  }

  activate(id) {
    const panel = this.requirePanel(id);
    if (!panel.groupId) this.open(id, { activate: false });
    const group = this.groups.get(panel.groupId);
    if (group.active && group.active !== id) this.panels.get(group.active)?.onDeactivate?.();
    group.active = id;
    this.setActiveGroup(group);
    for (const panelId of group.panels) {
      const candidate = this.panels.get(panelId);
      candidate.element.hidden = panelId !== id;
    }
    this.renderGroup(group);
    panel.onActivate?.();
    panel.onLayout?.();
    return id;
  }

  close(id, force = false) {
    const panel = this.panels.get(id);
    if (!panel || !panel.groupId || (!panel.closeable && !force)) return false;
    if (!force && panel.beforeClose?.() === false) return false;
    const group = this.groups.get(panel.groupId);
    const index = group.panels.indexOf(id);
    panel.onDeactivate?.();
    group.panels.splice(index, 1);
    panel.groupId = '';
    panel.element.hidden = true;
    if (panel.retain) this.staging.append(panel.element);
    else panel.element.remove();
    if (group.active === id) group.active = group.panels[Math.min(index, group.panels.length - 1)] || '';
    panel.onClose?.();
    if (!panel.retain) this.panels.delete(id);
    if (!group.panels.length && this.groups.size > 1) this.removeEmptyGroup(group);
    else if (group.active) this.activate(group.active);
    else this.renderGroup(group);
    this.notifyLayout();
    return true;
  }

  move(id, groupId, activate = true, beforeId) {
    const panel = this.requirePanel(id);
    const destination = this.groups.get(groupId);
    if (!destination) throw Error(`Panel group ${groupId} does not exist.`);
    const source = this.groups.get(panel.groupId);
    if (source?.id === destination.id) {
      if (beforeId && beforeId !== id) {
        source.panels = source.panels.filter(panelId => panelId !== id);
        const index = source.panels.indexOf(beforeId);
        source.panels.splice(index < 0 ? source.panels.length : index, 0, id);
        this.renderGroup(source);
      }
      if (activate) this.activate(id);
      return destination.id;
    }
    if (source) {
      source.panels = source.panels.filter(panelId => panelId !== id);
      if (source.active === id) source.active = source.panels.at(-1) || '';
      this.renderGroup(source);
      for (const panelId of source.panels) this.panels.get(panelId).element.hidden = panelId !== source.active;
    }
    const index = destination.panels.indexOf(beforeId);
    destination.panels.splice(index < 0 ? destination.panels.length : index, 0, id);
    panel.groupId = destination.id;
    destination.host.append(panel.element);
    this.renderGroup(destination);
    if (activate) this.activate(id);
    if (source && !source.panels.length && this.groups.size > 1) this.removeEmptyGroup(source);
    this.notifyLayout();
    return destination.id;
  }

  split(id, direction = 'vertical', referenceId) {
    const reference = referenceId ? this.requirePanel(referenceId) : this.activePanel;
    const group = reference?.groupId ? this.groups.get(reference.groupId) : this.activeGroup;
    if (!group) throw Error('There is no panel group to split.');
    const created = this.splitGroup(group, direction);
    if (id) this.move(id, created.id, true);
    else this.setActiveGroup(created);
    return created.id;
  }

  splitActive(group, direction) {
    const created = this.splitGroup(group, direction);
    if (group.active && group.panels.length > 1) this.move(group.active, created.id, true);
    else this.setActiveGroup(created);
  }

  splitGroup(group, direction) {
    const orientation = this.orientation(direction);
    const parent = group.element.parentElement;
    const split = document.createElement('div');
    split.className = 'panel-split';
    split.dataset.orientation = orientation;
    split.style.flex = group.element.style.flex;
    group.element.style.flex = '1 1 0';
    parent.replaceChild(split, group.element);
    const sash = document.createElement('div');
    sash.className = 'panel-sash';
    sash.tabIndex = 0;
    sash.setAttribute('role', 'separator');
    sash.setAttribute('aria-label', 'Resize panels');
    split.append(group.element, sash);
    const created = this.createGroup(split);
    this.bindSash(split, sash);
    this.notifyLayout();
    return created;
  }

  bindSash(split, sash) {
    const setRatio = percent => {
      const [first, second] = [...split.children].filter(child => child !== sash);
      first.style.flex = `0 0 ${Math.max(15, Math.min(85, percent))}%`;
      second.style.flex = '1 1 0';
      sash.setAttribute('aria-valuenow', String(Math.round(percent)));
      this.notifyLayout();
    };
    sash.setAttribute('aria-valuemin', '15');
    sash.setAttribute('aria-valuemax', '85');
    let drag;
    sash.addEventListener('pointerdown', event => {
      event.preventDefault();
      sash.setPointerCapture(event.pointerId);
      const rect = split.getBoundingClientRect();
      drag = { pointerId: event.pointerId, rect };
      sash.classList.add('dragging');
    });
    sash.addEventListener('pointermove', event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const vertical = split.dataset.orientation === 'vertical';
      const raw = vertical ? (event.clientX - drag.rect.left) / drag.rect.width : (event.clientY - drag.rect.top) / drag.rect.height;
      const percent = Math.max(0.15, Math.min(0.85, raw)) * 100;
      setRatio(percent);
    });
    const stop = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = undefined;
      sash.classList.remove('dragging');
      this.notifyLayout();
    };
    sash.addEventListener('pointerup', stop);
    sash.addEventListener('pointercancel', stop);
    sash.addEventListener('lostpointercapture', stop);
    sash.addEventListener('keydown', event => {
      const vertical = split.dataset.orientation === 'vertical';
      const delta = vertical ? { ArrowLeft: -5, ArrowRight: 5 }[event.key] : { ArrowUp: -5, ArrowDown: 5 }[event.key];
      if (!delta) return;
      event.preventDefault();
      const first = split.firstElementChild.getBoundingClientRect();
      const total = split.getBoundingClientRect();
      setRatio((vertical ? first.width / total.width : first.height / total.height) * 100 + delta);
    });
    sash.addEventListener('dblclick', () => {
      setRatio(50);
    });
  }

  setOrientation(id, direction) {
    const panel = this.requirePanel(id);
    const parent = this.groups.get(panel.groupId)?.element.parentElement;
    if (parent?.classList.contains('panel-split')) parent.dataset.orientation = this.orientation(direction);
    this.notifyLayout();
  }

  setSize(id, percentage) {
    const panel = this.requirePanel(id);
    const element = this.groups.get(panel.groupId)?.element;
    const split = element?.parentElement;
    if (!split?.classList.contains('panel-split')) return;
    const groups = [...split.children].filter(child => child !== split.querySelector(':scope > .panel-sash'));
    const size = Math.max(15, Math.min(85, Number(percentage)));
    if (groups[0] === element) {
      groups[0].style.flex = `0 0 ${size}%`;
      groups[1].style.flex = '1 1 0';
    } else {
      groups[0].style.flex = `0 0 ${100 - size}%`;
      groups[1].style.flex = '1 1 0';
    }
    this.notifyLayout();
  }

  removeEmptyGroup(group) {
    if (group.panels.length || this.groups.size === 1) return false;
    const split = group.element.parentElement;
    const sibling = [...split.children].find(child => child !== group.element && !child.classList.contains('panel-sash'));
    const parent = split.parentElement;
    group.menu.destroy();
    sibling.style.flex = split.style.flex || '1 1 0';
    parent.replaceChild(sibling, split);
    this.groups.delete(group.id);
    const next = sibling.matches('.panel-group') ? this.groups.get(sibling.dataset.group) : this.findFirstGroup(sibling);
    if (next && this.activeGroup === group) {
      this.setActiveGroup(next);
      if (next.active) this.activate(next.active);
    }
    this.notifyLayout();
    return true;
  }

  findFirstGroup(root) {
    const element = root.matches?.('.panel-group') ? root : root.querySelector?.('.panel-group');
    return element ? this.groups.get(element.dataset.group) : undefined;
  }

  setActiveGroup(group) {
    this.activeGroup = group;
    for (const candidate of this.groups.values()) candidate.element.classList.toggle('mobile-active', candidate === group);
    const active = this.panels.get(group.active);
    const body = document.body || this.root.closest('body') || document.querySelector('body');
    body?.classList.toggle('terminal-panel-active', active?.kind === 'terminal');
    this.renderSwitcher();
  }

  renderGroup(group) {
    group.tabs.replaceChildren();
    for (const id of group.panels) {
      const panel = this.panels.get(id);
      if (!panel) continue;
      const tab = document.createElement('div');
      tab.className = 'panel-tab';
      tab.dataset.panel = id;
      tab.dataset.tab = panel.legacyTab || id;
      tab.title = panel.title;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(group.active === id));
      tab.tabIndex = group.active === id ? 0 : -1;
      tab.draggable = true;
      const title = document.createElement('span');
      title.className = 'panel-tab-title';
      title.textContent = panel.title;
      const dirty = document.createElement('span');
      dirty.className = 'panel-tab-dirty';
      dirty.textContent = panel.dirty ? '●' : '';
      const kindIcon = { terminal: 'Terminal', browser: 'FolderOpen', cad: 'Box', text: 'FileCode', image: 'Image', system: 'Activity', docker: 'Container', start: 'Plus' };
      tab.append(icon(panel.icon || kindIcon[panel.kind] || 'File'), title, dirty);
      if (panel.closeable) {
        const close = this.actionButton('×', `Close ${panel.title}`);
        close.className = 'panel-tab-close';
        buttonIcon(close, 'X', `Close ${panel.title}`, true);
        close.onclick = event => { event.stopPropagation(); this.close(id); };
        tab.append(close);
      }
      tab.addEventListener('click', () => this.activate(id));
      tab.addEventListener('keydown', event => {
        if (event.target !== tab) return;
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.activate(id); }
        const index = group.panels.indexOf(id);
        const next = event.key === 'ArrowRight' ? group.panels[(index + 1) % group.panels.length]
          : event.key === 'ArrowLeft' ? group.panels[(index + group.panels.length - 1) % group.panels.length]
          : event.key === 'Home' ? group.panels[0] : event.key === 'End' ? group.panels.at(-1) : '';
        if (next) {
          event.preventDefault();
          this.activate(next);
          [...group.tabs.children].find(element => element.dataset.panel === next)?.focus();
        }
      });
      tab.addEventListener('dragstart', event => {
        this.draggedPanel = id;
        event.dataTransfer?.setData('text/plain', id);
        event.dataTransfer && (event.dataTransfer.effectAllowed = 'move');
      });
      tab.addEventListener('dragend', () => { this.draggedPanel = ''; });
      group.tabs.append(tab);
    }
    group.empty.hidden = !!group.panels.length;
    for (const button of group.element.querySelectorAll(':scope > .panel-group-header .panel-group-actions button')) {
      if (button.title === 'Close empty panel group') button.disabled = !!group.panels.length || this.groups.size === 1;
      if (button.title === 'Move active panel to next group') button.disabled = !group.active || this.groups.size === 1;
    }
    this.renderSwitcher();
  }

  renderSwitcher() {
    this.switcher.replaceChildren();
    for (const group of this.groups.values()) for (const id of group.panels) {
      const panel = this.panels.get(id);
      const option = document.createElement('option');
      option.value = id;
      option.textContent = `${panel.dirty ? '● ' : ''}${panel.title}`;
      option.selected = this.activeGroup === group && group.active === id;
      this.switcher.append(option);
    }
  }

  notifyLayout() {
    for (const group of this.groups.values()) {
      const panel = this.panels.get(group.active);
      if (panel && !panel.element.hidden) panel.onLayout?.();
    }
  }

  orientation(direction) {
    return ['horizontal', 'down', 'column'].includes(direction) ? 'horizontal' : 'vertical';
  }

  requirePanel(id) {
    const panel = this.panels.get(id);
    if (!panel) throw Error(`Panel ${id} is not registered.`);
    return panel;
  }

  isOpen(id) { return !!this.panels.get(id)?.groupId; }
  groupOf(id) { return this.panels.get(id)?.groupId || ''; }
  get activePanel() { return this.activeGroup ? this.panels.get(this.activeGroup.active) : undefined; }
  snapshot() {
    return [...this.groups.values()].map(group => ({ id: group.id, panels: [...group.panels], active: group.active }));
  }
}
