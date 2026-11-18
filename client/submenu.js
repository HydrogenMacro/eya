import { icon, registerMenuLayer } from './ui.js';

let submenuSequence = 0;
// A submenu shares its parent's dismissal boundary but has its own top-layer panel.
export function createSubmenu({ parent, trigger, label = 'Open with', items = [], onChoose = () => {} }) {
  const panel = document.createElement('div'); panel.className = 'ui-menu ui-submenu'; panel.id = `eya-submenu-${++submenuSequence}`;
  panel.setAttribute('role', 'menu'); panel.setAttribute('aria-label', label); panel.setAttribute('popover', 'manual'); panel.hidden = true;
  parent.append(panel); trigger.dataset.keepOpen = ''; trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-controls', panel.id); trigger.setAttribute('aria-expanded', 'false');
  const chevron = document.createElement('span'); chevron.className = 'ui-submenu-chevron'; chevron.textContent = '›'; chevron.setAttribute('aria-hidden', 'true'); trigger.append(chevron);
  const native = typeof panel.showPopover === 'function', abort = new AbortController();
  if (!native) panel.removeAttribute('popover');
  const unregister = registerMenuLayer(parent, panel);
  let opened = false, destroyed = false, timer, choices = items;
  const buttons = () => [...panel.querySelectorAll('[role=menuitem]')].filter(button => !button.hidden && !button.disabled);
  function position() {
    if (!opened) return;
    const viewport = window.visualViewport || { offsetLeft:0, offsetTop:0, width:innerWidth, height:innerHeight };
    const minX = viewport.offsetLeft + 6, minY = viewport.offsetTop + 6, maxX = viewport.offsetLeft + viewport.width - 6, maxY = viewport.offsetTop + viewport.height - 6;
    panel.style.maxWidth = `${Math.max(0,viewport.width-12)}px`; panel.style.maxHeight = `${Math.max(0,viewport.height-12)}px`;
    const owner = parent.getBoundingClientRect(), row = trigger.getBoundingClientRect(), width = panel.offsetWidth, height = panel.offsetHeight;
    const right = owner.right + 3, left = owner.left - width - 3;
    const flip = right + width > maxX && (left >= minX || owner.left - minX > maxX - owner.right);
    let top = row.top, side = flip ? 'left' : 'right';
    if (right + width > maxX && left < minX) {
      // Narrow screens keep the triggering row exposed so hover cannot steal its click.
      const below = maxY - row.bottom - 3, above = row.top - minY - 3;
      const down = below >= above; side = down ? 'below' : 'above';
      panel.style.maxHeight = `${Math.max(30,down ? below : above)}px`;
      top = down ? row.bottom + 3 : row.top - panel.offsetHeight - 3;
    }
    panel.dataset.side = side;
    panel.style.left = `${Math.max(minX,Math.min(flip ? left : right,maxX-width))}px`;
    panel.style.top = `${Math.max(minY,Math.min(top,maxY-panel.offsetHeight))}px`;
  }
  function close(restoreFocus = false) {
    clearTimeout(timer); if (!opened) return; opened = false;
    if (native && panel.matches(':popover-open')) panel.hidePopover();
    panel.hidden = true; trigger.setAttribute('aria-expanded','false');
    if (!native && parent.isConnected) parent.append(panel);
    if (restoreFocus && trigger.isConnected) trigger.focus({preventScroll:true});
  }
  function open(focus = false) {
    clearTimeout(timer); if (destroyed || trigger.disabled || trigger.hidden || !trigger.isConnected || parent.hidden) return;
    if (!opened) {
      opened = true; panel.hidden = false;
      if (native) panel.showPopover(); else document.body.append(panel);
      trigger.setAttribute('aria-expanded','true');
    }
    position(); if (focus) buttons()[0]?.focus({preventScroll:true});
  }
  const delayedClose = event => { if (event?.pointerType === 'touch') return; clearTimeout(timer); timer = setTimeout(() => close(),180); };
  trigger.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') open(); }, {signal:abort.signal});
  trigger.addEventListener('pointerleave', delayedClose, {signal:abort.signal});
  panel.addEventListener('pointerenter', () => clearTimeout(timer), {signal:abort.signal});
  panel.addEventListener('pointerleave', delayedClose, {signal:abort.signal});
  trigger.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); open(true); }, {signal:abort.signal});
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); open(true); }
    else if (opened && ['ArrowLeft','Escape'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); close(true); }
  }, {signal:abort.signal});
  panel.addEventListener('keydown', event => {
    if (['ArrowLeft','Escape'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (!['ArrowDown','ArrowUp','Home','End','Tab'].includes(event.key)) return;
    event.stopPropagation(); if (event.key === 'Tab') { close(); return; }
    event.preventDefault(); const options = buttons(), index = options.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length-1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length;
    options[next]?.focus({preventScroll:true}); options[next]?.scrollIntoView({block:'nearest'});
  }, {signal:abort.signal});
  panel.addEventListener('pointerdown', event => event.stopPropagation(), {signal:abort.signal});
  document.addEventListener('pointerdown', event => { if (opened && !parent.contains(event.target) && !panel.contains(event.target)) close(); }, {signal:abort.signal});
  parent.addEventListener('toggle', event => { if (event.target === parent && event.newState === 'closed') close(); }, {signal:abort.signal});
  const observer = new MutationObserver(() => { if (parent.hidden || !parent.isConnected) close(); }); observer.observe(parent, {attributes:true,attributeFilter:['hidden']});
  window.addEventListener('resize', position, {signal:abort.signal}); window.addEventListener('scroll', position, {capture:true,signal:abort.signal});
  window.visualViewport?.addEventListener('resize', position, {signal:abort.signal}); window.visualViewport?.addEventListener('scroll', position, {signal:abort.signal});
  function setItems(next) {
    choices = next; panel.replaceChildren();
    for (const item of choices) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'ui-menu-item'; button.setAttribute('role','menuitem'); button.dataset.submenuItem = item.id;
      if (item.icon) button.append(icon(item.icon)); const text = document.createElement('span'); text.textContent = item.title; button.append(text); button.disabled = item.disabled === true;
      button.onclick = event => { event.preventDefault(); event.stopPropagation(); close(); onChoose(item); item.action?.(); }; panel.append(button);
    }
    if (opened) position();
  }
  setItems(items);
  return { panel, open, close, position, setItems, contains:target => trigger.contains(target) || panel.contains(target), destroy() {
    if (destroyed) return; close(); destroyed = true; abort.abort(); observer.disconnect(); unregister(); panel.remove(); chevron.remove();
    trigger.removeAttribute('aria-haspopup'); trigger.removeAttribute('aria-controls'); trigger.removeAttribute('aria-expanded'); delete trigger.dataset.keepOpen;
  } };
}
