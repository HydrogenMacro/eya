import { icon, buttonIcon } from './ui.js';

export function settingsNavigation(dialog, { groups = [], getPanels = () => [], activatePanel = () => {} } = {}) {
  const sections = [...dialog.querySelectorAll('[data-settings]')].sort((a,b) => groups.findIndex(group => group.title === a.querySelector('h3').textContent) - groups.findIndex(group => group.title === b.querySelector('h3').textContent));
  const search = dialog.querySelector('#settings-search'); search.placeholder = 'Search settings';
  const title = dialog.querySelector('h2');
  const header = document.createElement('div'); header.className = 'dialog-heading';
  title.before(header); header.append(title);
  const back = document.createElement('button'); back.type = 'button'; buttonIcon(back, 'ArrowLeft', 'Back', true); header.prepend(back);
  const close = dialog.querySelector('#close-settings'); buttonIcon(close, 'X', 'Close', true); header.append(close);
  const home = document.createElement('div'); home.className = 'settings-categories';
  search.closest('.settings-search').after(home);
  const empty = document.createElement('p'); empty.className = 'settings-empty'; empty.textContent = 'No settings found.'; home.after(empty);
  let selected = null;
  const entries = sections.map((section, index) => {
    const heading = section.querySelector('h3');
    const group = groups.find(item => item.title === heading.textContent) || { id: `section-${index}`, title: heading.textContent, icon: 'SlidersHorizontal' };
    section.dataset.settingsGroup = group.id;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'settings-category';
    button.append(icon(group.icon), document.createTextNode(group.title), icon('ChevronDown'));
    button.onclick = () => open(group.id);
    home.append(button);
    return { ...group, section, heading, button };
  });
  const live = document.createElement('div'); live.className = 'settings-live-panels'; home.append(live);
  function paintPanels() {
    live.replaceChildren();
    const panels = [...getPanels()].filter(panel => panel.groupId && panel.api?.openSettings);
    if (!panels.length) return;
    const heading = document.createElement('h3'); heading.textContent = 'Open panels'; live.append(heading);
    for (const panel of panels) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'settings-category';
      button.append(icon('SlidersHorizontal'), document.createTextNode(panel.title || panel.kind), icon('ChevronDown'));
      button.onclick = () => { dialog.close(); activatePanel(panel); panel.api.openSettings(); };
      live.append(button);
    }
  }
  function render() {
    const query = search.value.trim().toLowerCase();
    home.hidden = !!selected || !!query;
    back.hidden = !selected && !query;
    title.textContent = query ? 'Search settings' : entries.find(item => item.id === selected)?.title || 'Settings';
    let count = 0;
    for (const entry of entries) {
      let matches = 0;
      for (const field of entry.section.querySelectorAll('.setting')) {
        const found = !query || `${entry.title} ${field.textContent}`.toLowerCase().includes(query);
        field.hidden = !found;
        if (found) matches++;
      }
      const visible = query ? matches > 0 : entry.id === selected;
      entry.section.hidden = !visible;
      entry.heading.hidden = !query;
      if (visible) count++;
    }
    empty.hidden = !query || count > 0;
  }
  function open(id = null) { selected = id; search.value = ''; paintPanels(); render(); }
  back.onclick = () => open();
  search.addEventListener('input', render);
  open();
  return { open, refresh: () => { paintPanels(); render(); } };
}
