// Shared docking primitives for the workspace and embedded inspectors.
// Layout snapshots contain identifiers only; content stays owned by the caller.
export function dockEdge(rect, x, y, edges = ['left', 'right', 'top', 'bottom']) {
  if (!rect || rect.width <= 0 || rect.height <= 0 || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return '';
  const distances = { left: (x - rect.left) / rect.width, right: (rect.right - x) / rect.width, top: (y - rect.top) / rect.height, bottom: (rect.bottom - y) / rect.height };
  const edge = edges.filter(value => distances[value] <= 0.22).sort((a, b) => distances[a] - distances[b])[0];
  return edge || '';
}

export class EdgeDockController {
  constructor(root, { getItem, resolveTarget, onDrop }) {
    this.root = root; this.getItem = getItem; this.resolveTarget = resolveTarget; this.onDrop = onDrop;
    this.preview = document.createElement('div'); this.preview.className = 'dock-drop-preview'; this.preview.hidden = true; this.preview.setAttribute('aria-hidden', 'true'); document.body.append(this.preview);
    this.marker = document.createElement('div'); this.marker.className='dock-tab-insertion';this.marker.hidden=true;this.marker.setAttribute('aria-hidden','true');document.body.append(this.marker);
    this.touchCleanups=new Set();
    this.over = event => {
      if (!getItem()) return;
      if(event.dataTransfer)this.nativePoint={clientX:event.clientX,clientY:event.clientY,preventDefault(){},stopPropagation(){}};
      const target = this.targetAt(event); if (!target) { this.hide(); return; }
      event.preventDefault(); event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const rect = target.element.getBoundingClientRect();
      const edge = target.canSplit === false ? '' : dockEdge(rect, event.clientX, event.clientY, target.edges);
      if (!edge) { this.preview.hidden=true; this.updateInsertion(target,event); return; }
      this.marker.hidden=true;
      const left = rect.left + (edge === 'right' ? rect.width / 2 : 0), top = rect.top + (edge === 'bottom' ? rect.height / 2 : 0);
      Object.assign(this.preview.style, { left: `${left}px`, top: `${top}px`, width: `${rect.width / (edge === 'left' || edge === 'right' ? 2 : 1)}px`, height: `${rect.height / (edge === 'top' || edge === 'bottom' ? 2 : 1)}px` });
      this.preview.dataset.edge = edge; this.preview.hidden = false;
    };
    this.drop = event => {
      const item = getItem(), target = this.targetAt(event); if(target)this.updateInsertion(target,event); this.hide();
      if (!item || !target) return;
      event.preventDefault(); event.stopPropagation();
      const edge = target.canSplit === false ? '' : dockEdge(target.element.getBoundingClientRect(), event.clientX, event.clientY, target.edges);
      onDrop(item, target, edge, event);
    };
    this.leave = event => { if (!root.contains(event.relatedTarget)) { this.nativePoint=null;this.hide(); } };
    this.end = () => { this.finishDrag(); this.hide(); };
    root.addEventListener('dragover', this.over); root.addEventListener('drop', this.drop); root.addEventListener('dragleave', this.leave);
    document.addEventListener('dragend', this.end); document.addEventListener('drop', this.end); window.addEventListener('blur', this.end);
  }
  hide() { this.preview.hidden = true;this.marker.hidden=true; }
  targetAt(event) {
    const target=document.elementFromPoint(event.clientX,event.clientY);
    if(!target || !this.root.contains(target))return null;
    // Retain the resolver's Event API while choosing its target geometrically.
    return this.resolveTarget(new Proxy(event,{get(value,key){
      if(key==='target')return target;
      const member=Reflect.get(value,key,value);return typeof member==='function'?member.bind(value):member;
    }}));
  }
  beginDrag(handle,event) {
    this.finishDrag();
    const rect=handle.getBoundingClientRect(),grip=this.grip?.handle===handle?this.grip:null;
    const inside=event.clientX>=rect.left&&event.clientX<=rect.right&&event.clientY>=rect.top&&event.clientY<=rect.bottom;
    this.dragGeometry={handle,width:rect.width,height:rect.height,x:grip?.x??(inside?event.clientX-rect.left:rect.width/2),y:grip?.y??(inside?event.clientY-rect.top:rect.height/2)};
    handle.classList.add('dock-tab-dragging');
  }
  ghost(handle) {
    const clone=handle.cloneNode(true);clone.classList.add('dock-tab-ghost');clone.classList.remove('dock-tab-dragging','dock-touch-dragging');
    for(const name of ['id','role','data-panel','data-dock-tab','draggable'])clone.removeAttribute(name);
    clone.querySelectorAll('button,[id]').forEach(node=>node.matches('button')?node.remove():node.removeAttribute('id'));
    clone.setAttribute('aria-hidden','true');clone.inert=true;clone.tabIndex=-1;
    clone.style.width=`${this.dragGeometry.width}px`;clone.style.height=`${this.dragGeometry.height}px`;document.body.append(clone);return clone;
  }
  startNativeDrag(handle,event) {
    this.beginDrag(handle,event);
    const clone=this.nativeImage=this.ghost(handle),rect=handle.getBoundingClientRect();
    clone.style.left=`${rect.left}px`;clone.style.top=`${rect.top}px`;
    event.dataTransfer?.setDragImage(clone,this.dragGeometry.x,this.dragGeometry.y);
    requestAnimationFrame(()=>{clone.remove();if(this.nativeImage===clone)this.nativeImage=null;});
    this.nativeActive=true;
    const scroll=()=>{if(!this.nativeActive)return;if(this.nativePoint&&this.scrollStrip(this.nativePoint))this.over(this.nativePoint);this.nativeScrollFrame=requestAnimationFrame(scroll);};
    this.nativeScrollFrame=requestAnimationFrame(scroll);
  }
  finishDrag() { this.dragGeometry?.handle.classList.remove('dock-tab-dragging');this.dragGeometry=null;this.nativeImage?.remove();this.nativeImage=null;this.nativeActive=false;this.nativePoint=null;cancelAnimationFrame(this.nativeScrollFrame); }
  scrollStrip(event) {
    const target=this.targetAt(event),strip=target?.element.querySelector('.panel-tabs,.dock-tabs'),rect=strip?.getBoundingClientRect();
    if(!rect || strip.scrollWidth<=strip.clientWidth)return false;
    const dx=event.clientX<rect.left+26?-8:event.clientX>rect.right-26?8:0,before=strip.scrollLeft;
    if(dx)strip.scrollLeft+=dx;
    return before!==strip.scrollLeft;
  }
  updateInsertion(target,event) {
    const strip=target.element.querySelector('.panel-tabs,.dock-tabs'),rect=strip?.getBoundingClientRect();
    if(!rect || rect.width<=0 || rect.height<=0){this.marker.hidden=true;return;}
    const tabs=[...strip.querySelectorAll('[data-panel],[data-dock-tab]')].filter(tab=>(tab.dataset.panel||tab.dataset.dockTab)!==this.getItem());
    const center=event.clientX+(this.dragGeometry?this.dragGeometry.width/2-this.dragGeometry.x:0);
    const slots=tabs.map(tab=>({beforeId:tab.dataset.panel||tab.dataset.dockTab,x:tab.getBoundingClientRect().left}));
    slots.push({beforeId:null,x:tabs.at(-1)?.getBoundingClientRect().right||rect.left});
    const slot=slots.reduce((best,slot)=>Math.abs(slot.x-center)<Math.abs(best.x-center)?slot:best);
    target.insertion={beforeId:slot.beforeId};
    const x=slot.x;
    Object.assign(this.marker.style,{left:`${Math.max(rect.left,Math.min(rect.right-2,x))-1}px`,top:`${rect.top+3}px`,height:`${Math.max(12,rect.height-6)}px`});this.marker.hidden=false;
  }
  bindTouch(handle, start, end, {longPress=0,ghost=false} = {}) {
    let drag,timer,clone,scrollFrame=0,lastEvent,originalDraggable;
    handle.classList.add('dock-touch-handle');
    if(longPress)handle.classList.add('dock-long-press');
    const abort=new AbortController(),signal=abort.signal;
    const proxy = event => ({ target:document.elementFromPoint(event.clientX,event.clientY) || document.body, clientX:event.clientX, clientY:event.clientY, preventDefault:()=>event.preventDefault?.(), stopPropagation:()=>event.stopPropagation?.() });
    const positionGhost=event=>{if(clone&&this.dragGeometry){clone.style.left=`${event.clientX-this.dragGeometry.x}px`;clone.style.top=`${event.clientY-this.dragGeometry.y}px`;}};
    const autoScroll=()=>{
      if(!drag?.active || !lastEvent)return;
      if(this.scrollStrip(lastEvent))this.over(proxy(lastEvent));
      scrollFrame=requestAnimationFrame(autoScroll);
    };
    const begin=()=>{
      clearTimeout(timer);if(!drag || !handle.isConnected)return;
      drag.active=true;this.beginDrag(handle,drag);handle.classList.add('dock-touch-dragging');start();
      try{handle.setPointerCapture(drag.id);}catch{/* Pointer may have been canceled by native scrolling. */}
      if(ghost){clone=this.ghost(handle);positionGhost(lastEvent||drag);}
      if(lastEvent)this.over(proxy(lastEvent));scrollFrame=requestAnimationFrame(autoScroll);
    };
    handle.addEventListener('pointerdown',event=>{
      const rect=handle.getBoundingClientRect();this.grip={handle,x:event.clientX-rect.left,y:event.clientY-rect.top};
      if(event.pointerType!=='touch'||event.target.closest('button')&&event.target.closest('button')!==handle)return;
      clearTimeout(timer);if(longPress){originalDraggable=handle.draggable;handle.draggable=false;}drag={id:event.pointerId,x:event.clientX,y:event.clientY,clientX:event.clientX,clientY:event.clientY,active:false};lastEvent=event;
      if(longPress)timer=setTimeout(begin,longPress);else try{handle.setPointerCapture(event.pointerId);}catch{}
    },{signal});
    handle.addEventListener('pointermove',event=>{
      if(!drag||drag.id!==event.pointerId)return;lastEvent=event;
      if(!drag.active&&Math.hypot(event.clientX-drag.x,event.clientY-drag.y)>8){if(longPress){clearTimeout(timer);drag=null;handle.draggable=originalDraggable;return;}begin();}
      if(drag?.active){event.preventDefault();positionGhost(event);this.over(proxy(event));}
    },{signal});
    // Canceling touchmove only after a stationary hold keeps ordinary strip
    // swipes native, then prevents the browser from stealing an active drag.
    handle.addEventListener('touchmove',event=>{if(drag?.active)event.preventDefault();},{passive:false,signal});
    handle.addEventListener('contextmenu',event=>{if(longPress)event.preventDefault();},{signal});
    const stop=event=>{
      if(!drag||event.pointerId!==undefined&&drag.id!==event.pointerId)return;
      clearTimeout(timer);if(originalDraggable!==undefined)handle.draggable=originalDraggable;const active=drag.active;drag=null;lastEvent=null;cancelAnimationFrame(scrollFrame);clone?.remove();clone=null;handle.classList.remove('dock-touch-dragging');
      if(active){event.preventDefault?.();
        const cancel=click=>{if(click.detail===0)return;click.preventDefault();click.stopImmediatePropagation();this.root.removeEventListener('click',cancel,true);};
        const resume=()=>this.root.removeEventListener('click',cancel,true);this.root.addEventListener('pointerdown',resume,{capture:true,once:true});this.root.addEventListener('click',cancel,true);setTimeout(()=>{this.root.removeEventListener('click',cancel,true);this.root.removeEventListener('pointerdown',resume,true);},500);
        if(event.type==='pointerup')this.drop(proxy(event));end();this.finishDrag();this.hide();
      }
    };
    for(const name of ['pointerup','pointercancel','lostpointercapture'])handle.addEventListener(name,stop,{signal});
    window.addEventListener('blur',stop,{signal});document.addEventListener('visibilitychange',()=>{if(document.hidden)stop({});},{signal});
    const cleanup=()=>{stop({});clearTimeout(timer);abort.abort();this.touchCleanups.delete(cleanup);};cleanup.handle=handle;this.touchCleanups.add(cleanup);
    if(!this.cleanupScheduled){this.cleanupScheduled=true;queueMicrotask(()=>{this.cleanupScheduled=false;for(const binding of [...this.touchCleanups])if(!binding.handle.isConnected)binding();});}
  }

  destroy() {
    this.finishDrag();
    for(const cleanup of [...this.touchCleanups])cleanup();
    this.root.removeEventListener('dragover', this.over); this.root.removeEventListener('drop', this.drop); this.root.removeEventListener('dragleave', this.leave);
    document.removeEventListener('dragend', this.end); document.removeEventListener('drop', this.end); window.removeEventListener('blur', this.end); this.preview.remove();this.marker.remove();
  }
}

let nextDockGroup = 0;
const groupNode = tabs => ({ type: 'group', id: `dock-group-${++nextDockGroup}`, tabs, active: tabs[0] || '' });
const clampRatio = value => Number.isFinite(Number(value)) ? Math.min(0.85, Math.max(0.15, Number(value))) : 0.5;

export class TabDock {
  constructor(root, { tabs = [], layout, axis = 'both', onChange = () => {} } = {}) {
    this.root = root; this.root.classList.add('tab-dock'); this.tabs = new Map(tabs.map(tab => [tab.id, tab])); this.axis = axis; this.onChange = onChange; this.dragged = ''; this.groups = new Map();
    const seen = new Set();
    const restore = (node, depth = 0) => {
      if (!node || depth > 16) return null;
      if (node.type === 'split') {
        const first = restore(node.first, depth + 1), second = restore(node.second, depth + 1);
        return first && second ? { type: 'split', axis: axis === 'both' && ['horizontal', 'vertical'].includes(node.axis) ? node.axis : axis === 'both' ? 'horizontal' : axis, ratio: clampRatio(node.ratio), first, second } : first || second;
      }
      if (node.type !== 'group' || !Array.isArray(node.tabs)) return null;
      const ids = node.tabs.filter(id => this.tabs.has(id) && !seen.has(id) && seen.add(id));
      if (!ids.length) return null;
      const group = groupNode(ids); if (ids.includes(node.active)) group.active = node.active; return group;
    };
    this.tree = restore(layout) || groupNode([]);
    const first = this.firstGroup(this.tree); first.tabs.push(...[...this.tabs.keys()].filter(id => !seen.has(id))); if (!first.active) first.active = first.tabs[0] || '';
    this.edgeController = new EdgeDockController(root, {
      getItem: () => this.dragged,
      resolveTarget: event => {
        const element = event.target.closest?.('.dock-group'); if (!element || !root.contains(element)) return null;
        const group = this.groups.get(element.dataset.group); if (!group) return null;
        return { element, group, canSplit: false };
      },
      onDrop: (id, target) => {
        this.move(id, target.group, target.insertion?.beforeId);
        this.dragged = '';
      },
    });
    this.render();
  }
  edges() { return this.axis === 'vertical' ? ['top', 'bottom'] : this.axis === 'horizontal' ? ['left', 'right'] : ['left', 'right', 'top', 'bottom']; }
  firstGroup(node) { return node.type === 'group' ? node : this.firstGroup(node.first); }
  groupOf(id) { return [...this.groups.values()].find(group => group.tabs.includes(id)); }
  snapshot() {
    const visit = node => node.type === 'group' ? { type: 'group', tabs: [...node.tabs], active: node.active } : { type: 'split', axis: node.axis, ratio: node.ratio, first: visit(node.first), second: visit(node.second) };
    return visit(this.tree);
  }
  changed() { this.onChange(this.snapshot()); }
  activate(id) { const group = this.groupOf(id); if (!group) return; group.active = id; this.render(); this.changed(); }
  replace(node, replacement) {
    if (this.tree === node) { this.tree = replacement; return; }
    const visit = parent => { if (parent.type !== 'split') return; for (const key of ['first', 'second']) { if (parent[key] === node) parent[key] = replacement; else visit(parent[key]); } }; visit(this.tree);
  }
  prune(node = this.tree) {
    if (node.type === 'group') return node.tabs.length ? node : null;
    node.first = this.prune(node.first); node.second = this.prune(node.second); return node.first && node.second ? node : node.first || node.second;
  }
  move(id, destination, before) {
    const source = this.groupOf(id); if (!source || !destination) return;
    if (source === destination && before === id) return;
    source.tabs = source.tabs.filter(value => value !== id); if (source.active === id) source.active = source.tabs[0] || '';
    const index = destination.tabs.indexOf(before); destination.tabs.splice(index < 0 ? destination.tabs.length : index, 0, id); destination.active = id;
    this.tree = this.prune() || groupNode([]); this.render(); this.changed();
  }
  split(id, edge = 'end', targetId = id) {
    const source = this.groupOf(id), target = this.groupOf(targetId) || source; if (!source || !target || (source === target && source.tabs.length < 2)) return false;
    const before = ['start', 'left', 'top'].includes(edge), axis = this.axis === 'both' ? ['left', 'right'].includes(edge) ? 'horizontal' : 'vertical' : this.axis;
    source.tabs = source.tabs.filter(value => value !== id); if (source.active === id) source.active = source.tabs[0] || '';
    const created = groupNode([id]); this.replace(target, { type: 'split', axis, ratio: 0.5, first: before ? created : target, second: before ? target : created });
    this.tree = this.prune(); this.render(); this.changed(); return true;
  }
  setAxis(axis) {
    this.axis = ['horizontal', 'vertical', 'both'].includes(axis) ? axis : 'both';
    const visit = node => { if (node.type !== 'split') return; if (this.axis !== 'both') node.axis = this.axis; visit(node.first); visit(node.second); }; visit(this.tree); this.render();
  }
  render() {
    const focused = this.root.contains(document.activeElement) ? document.activeElement.closest('[data-dock-tab]')?.dataset.dockTab || this.groups.get(document.activeElement.closest('.dock-group')?.dataset.group)?.active : '';
    this.groups.clear(); this.root.replaceChildren();
    const visit = node => {
      if (node.type === 'split') {
        const element = document.createElement('div'); element.className = 'dock-split'; element.dataset.axis = node.axis;
        const first = visit(node.first), second = visit(node.second), sash = document.createElement('div'); sash.className = 'dock-sash'; sash.tabIndex = 0; sash.setAttribute('role', 'separator'); sash.setAttribute('aria-label', 'Resize tabs'); sash.setAttribute('aria-orientation', node.axis === 'horizontal' ? 'vertical' : 'horizontal');
        const sync = () => { first.style.flex = `${node.ratio} 1 0`; second.style.flex = `${1 - node.ratio} 1 0`; sash.setAttribute('aria-valuenow', String(Math.round(node.ratio * 100))); }; sync();
        let drag;
        sash.onpointerdown = event => { if (event.button !== 0) return; event.preventDefault(); drag = element.getBoundingClientRect(); sash.setPointerCapture(event.pointerId); };
        sash.onpointermove = event => { if (!drag) return; node.ratio = clampRatio(node.axis === 'horizontal' ? (event.clientX - drag.left) / drag.width : (event.clientY - drag.top) / drag.height); sync(); };
        const stop = () => { if (!drag) return; drag = null; this.changed(); }; sash.onpointerup = stop; sash.onpointercancel = stop; sash.onlostpointercapture = stop;
        sash.onkeydown = event => { const delta = node.axis === 'horizontal' ? { ArrowLeft: -0.05, ArrowRight: 0.05 }[event.key] : { ArrowUp: -0.05, ArrowDown: 0.05 }[event.key]; if (delta) { event.preventDefault(); node.ratio = clampRatio(node.ratio + delta); sync(); this.changed(); } };
        sash.ondblclick = () => { node.ratio = 0.5; sync(); this.changed(); }; element.append(first, sash, second); return element;
      }
      this.groups.set(node.id, node);
      const element = document.createElement('section'); element.className = 'dock-group'; element.dataset.group = node.id;
      const strip = document.createElement('div'); strip.className = 'dock-tabs'; strip.setAttribute('role', 'tablist'); strip.setAttribute('aria-label', 'Sidebar tabs');
      const content = document.createElement('div'); content.className = 'dock-content';
      node.tabs.forEach((id, index) => {
        const tab = this.tabs.get(id), button = document.createElement('button'); button.type = 'button'; button.textContent = tab.title; button.dataset.dockTab = id; button.draggable = true; button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(node.active === id)); button.tabIndex = node.active === id ? 0 : -1;
        button.onclick = () => this.activate(id);
        button.onkeydown = event => { const next = event.key === 'ArrowRight' ? node.tabs[(index + 1) % node.tabs.length] : event.key === 'ArrowLeft' ? node.tabs[(index + node.tabs.length - 1) % node.tabs.length] : event.key === 'Home' ? node.tabs[0] : event.key === 'End' ? node.tabs.at(-1) : ''; if (next) { event.preventDefault(); this.activate(next); [...this.root.querySelectorAll('[data-dock-tab]')].find(item => item.dataset.dockTab === next)?.focus(); } };
        button.ondragstart = event => { this.dragged = id; this.edgeController.startNativeDrag(button,event); event.stopPropagation(); event.dataTransfer?.setData('text/plain', id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; }; button.ondragend = () => { this.dragged = ''; this.edgeController.end(); };
        this.edgeController.bindTouch(button, () => { this.dragged = id; }, () => { this.dragged = ''; }, {longPress:450,ghost:true});
        strip.append(button); tab.element.hidden = node.active !== id; tab.element.setAttribute('role', 'tabpanel'); content.append(tab.element);
      });
      const divide = document.createElement('button'); divide.type = 'button'; divide.className = 'dock-divide'; divide.textContent = this.axis === 'horizontal' ? '◧' : '⬒'; divide.title = 'Divide sidebar'; divide.setAttribute('aria-label', 'Divide sidebar'); divide.disabled = node.tabs.length < 2; divide.onclick = () => this.split(node.active, 'end'); strip.append(divide);
      element.append(strip, content); return element;
    };
    this.root.append(visit(this.tree));
    if (focused) [...this.root.querySelectorAll('[data-dock-tab]')].find(tab => tab.dataset.dockTab === focused)?.focus({ preventScroll:true });
  }
  destroy() { this.edgeController.destroy(); this.root.replaceChildren(); this.groups.clear(); }
}

export class DockSidebar {
  constructor(root, { content, tabs, side = 'right', size = 280, collapsed = false, layout, onChange = () => {} }) {
    this.root = root; this.content = content; this.onChange = onChange; this.collapsed = collapsed === true; this.side = ['left', 'right', 'top', 'bottom'].includes(side) ? side : 'right'; this.size = Number.isFinite(Number(size)) ? Math.max(120, Number(size)) : 280;
    root.classList.add('dock-sidebar-layout'); this.element = document.createElement('aside'); this.element.className = 'dock-sidebar'; this.element.setAttribute('aria-label', 'Model sidebar');
    this.sash = document.createElement('div'); this.sash.className = 'dock-sidebar-sash'; this.sash.tabIndex = 0; this.sash.setAttribute('role', 'separator'); this.sash.setAttribute('aria-label', 'Resize sidebar');
    content.classList.add('dock-main-content'); root.append(content, this.sash, this.element);
    this.dock = new TabDock(this.element, { tabs, layout, axis: this.isVertical() ? 'vertical' : 'horizontal', onChange: () => this.changed() });
    let drag;
    this.sash.onpointerdown = event => { if (event.button !== 0) return; event.preventDefault(); drag = { x: event.clientX, y: event.clientY, size: this.isVertical() ? this.element.clientWidth : this.element.clientHeight }; this.sash.setPointerCapture(event.pointerId); };
    this.sash.onpointermove = event => { if (!drag) return; const delta = this.isVertical() ? event.clientX - drag.x : event.clientY - drag.y; this.setSize(drag.size + delta * (this.side === 'right' || this.side === 'bottom' ? -1 : 1), false); };
    const stop = () => { if (drag) { drag = null; this.changed(); } }; this.sash.onpointerup = stop; this.sash.onpointercancel = stop; this.sash.onlostpointercapture = stop;
    this.sash.onkeydown = event => { const delta = this.isVertical() ? { ArrowLeft: -16, ArrowRight: 16 }[event.key] : { ArrowUp: -16, ArrowDown: 16 }[event.key]; if (delta) { event.preventDefault(); this.setSize(this.size + delta * (this.side === 'right' || this.side === 'bottom' ? -1 : 1)); } };
    this.sash.ondblclick = () => this.setSize(280); this.apply();
  }
  isVertical() { return this.side === 'left' || this.side === 'right'; }
  snapshot() { return { side: this.side, size: this.size, collapsed: this.collapsed, layout: this.dock.snapshot() }; }
  changed() { this.onChange(this.snapshot()); }
  setCollapsed(value) { const collapsed = value === true; if (collapsed === this.collapsed) return; this.collapsed = collapsed; this.apply(); this.changed(); }
  setSide(side) { if (side === this.side || !['left', 'right', 'top', 'bottom'].includes(side)) return; this.side = side; this.dock.setAxis(this.isVertical() ? 'vertical' : 'horizontal'); this.apply(); this.changed(); }
  setSize(size, notify = true) { const available = this.isVertical() ? this.root.clientWidth : this.root.clientHeight; const max = Math.min(available - 80, available * 0.6); this.size = Math.max(120, Math.min(Math.max(120, max), Number(size) || 280)); this.apply(); if (notify) this.changed(); }
  apply() { this.element.hidden = this.sash.hidden = this.collapsed; this.root.dataset.sidebarCollapsed = String(this.collapsed); this.root.dataset.sidebarSide = this.side; this.root.style.setProperty('--dock-sidebar-size', `${this.size}px`); this.sash.setAttribute('aria-orientation', this.isVertical() ? 'vertical' : 'horizontal'); this.sash.setAttribute('aria-valuenow', String(Math.round(this.size))); }
  destroy() { this.dock.destroy(); this.element.remove(); this.sash.remove(); this.content.classList.remove('dock-main-content'); this.root.classList.remove('dock-sidebar-layout'); delete this.root.dataset.sidebarSide; delete this.root.dataset.sidebarCollapsed; }
}
