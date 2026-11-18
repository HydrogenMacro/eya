// Shared by the original Files pane and independent file browsers.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export function sortFiles(entries, sort = {}) {
  if (!sort.key || !sort.direction) return entries;
  const value = item => sort.key === 'type' ? (item.kind === 'directory' ? 'folder' : item.name.split('.').slice(1).at(-1) || '') : item[sort.key];
  return [...entries].sort((a, b) => {
    const x = value(a), y = value(b);
    const delta = ['size', 'modified'].includes(sort.key) ? (Number(x) || 0) - (Number(y) || 0) : collator.compare(String(x || ''), String(y || ''));
    return (sort.direction === 'descending' ? -1 : 1) * delta;
  });
}
export function bindFileSorting(header, changed) {
  let sort = {};
  for (const [index, key] of ['name', 'size', 'modified', 'type'].entries()) {
    const cell = header.cells[index];
    const button = document.createElement('button'); button.type = 'button'; button.className = 'file-sort';
    const label = cell.textContent; button.textContent = label; button.setAttribute('aria-label', label); cell.replaceChildren(button);
    cell.setAttribute('aria-sort', 'none');
    button.onclick = () => {
      sort = sort.key !== key || !sort.direction ? { key, direction: 'ascending' } : sort.direction === 'ascending' ? { key, direction: 'descending' } : {};
      for (const sibling of header.cells) { sibling.setAttribute('aria-sort', sibling === cell ? sort.direction || 'none' : 'none'); }
      changed(sort);
    };
  }
}
export function modifiedDate(value, now = new Date()) {
  if (!value) return '—';
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return '—';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (date >= today && date < new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)) return `Today at ${time}`;
  if (date >= yesterday && date < today) return `Yesterday at ${time}`;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })} at ${time}`;
}
