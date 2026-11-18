export const FILE_OPENER_TYPES = [
  ['markdown', 'Markdown'], ['text', 'Text editor'], ['binary', 'Binary editor'],
  ['html', 'HTML viewer'], ['image', 'Image viewer'], ['video', 'Video player'],
  ['audio', 'Audio player'], ['cad', '3D viewer'],
];
const groups = {
  markdown: 'md markdown', html: 'html htm', image: 'png jpg jpeg gif webp avif bmp ico svg',
  video: 'mp4 webm ogv mov m4v 3gp 3g2 mkv', audio: 'mp3 wav ogg oga opus m4a aac flac weba',
  cad: 'stl glb gltf 3mf',
  text: 'txt js mjs cjs ts tsx jsx json css scss xml yml yaml toml ini conf cfg sh bash zsh fish py rb rs go java c h cpp hpp cs php sql log env gitignore',
};
export const DEFAULT_FILE_OPENERS = Object.fromEntries(Object.entries(groups).flatMap(([type, extensions]) => extensions.split(' ').map(extension => [extension, type])));
export function fileExtension(path) { const name = String(path).split('/').at(-1); return name.includes('.') ? name.split('.').at(-1).toLowerCase() : ''; }
export function normalizeFileOpeners(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_FILE_OPENERS };
  const result = {};
  for (const [extension, type] of Object.entries(value).slice(0, 256)) {
    const key = extension.toLowerCase().replace(/^\./, '');
    if (/^[a-z0-9_+-]{1,32}$/.test(key) && FILE_OPENER_TYPES.some(([name]) => name === type)) result[key] = type;
  }
  return result;
}
export function isBinaryContent(bytes) {
  // Inspect the full bounded transfer: a binary tail must not disappear behind a text prefix.
  let controls = 0;
  for (const byte of bytes) {
    if (byte === 0) return true;
    if (byte < 32 && ![9, 10, 12, 13, 27].includes(byte)) controls++;
  }
  if (controls > bytes.length * 0.01) return true;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (let offset = 0; offset < bytes.length; offset += 65536) decoder.decode(bytes.subarray(offset, offset + 65536), { stream: true });
    decoder.decode(); return false;
  } catch { return true; }
}
export function createFileOpenerControl() {
  const root = document.createElement('div'); root.className = 'file-opener-setting';
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search extensions'; search.setAttribute('aria-label', 'Search file extensions');
  const scroll = document.createElement('div'); scroll.className = 'file-opener-scroll';
  const table = document.createElement('table'); table.setAttribute('aria-label', 'File openers');
  const head = table.createTHead().insertRow(); for (const title of ['Extension', 'Panel type', '']) { const cell = document.createElement('th'); cell.textContent = title; head.append(cell); }
  const body = table.createTBody(); scroll.append(table);
  const add = document.createElement('button'); add.type = 'button'; add.textContent = 'Add extension';
  const error = document.createElement('small'); error.setAttribute('role', 'status');
  root.append(search, scroll, add, error);
  let lastValid = normalizeFileOpeners();
  function changed() { root.dispatchEvent(new Event('change', { bubbles: true })); }
  function filter() { const query = search.value.toLowerCase().replace(/^\./, ''); for (const row of body.rows) row.hidden = !`${row.querySelector('input').value} ${row.querySelector('select').selectedOptions[0]?.textContent}`.toLowerCase().includes(query); }
  function row(extension = '', type = 'text') {
    const row = body.insertRow();
    const input = document.createElement('input'); input.type = 'text'; input.value = extension; input.required = true; input.maxLength = 33; input.placeholder = '.ext'; input.setAttribute('aria-label', 'File extension'); input.spellcheck = false; input.pattern = '\\.?[a-zA-Z0-9_+\\-]{1,32}';
    const select = document.createElement('select'); select.setAttribute('aria-label', `Panel type for ${extension || 'new extension'}`);
    for (const [id, label] of FILE_OPENER_TYPES) { const option = document.createElement('option'); option.value = id; option.textContent = label; select.append(option); } select.value = type;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${extension || 'extension'}`);
    remove.onclick = () => { row.remove(); changed(); };
    input.oninput = () => { input.setCustomValidity(''); select.setAttribute('aria-label', `Panel type for ${input.value || 'new extension'}`); };
    for (const node of [input, select, remove]) row.insertCell().append(node);
    return input;
  }
  add.onclick = () => { if (body.rows.length >= 256) { error.textContent = 'Up to 256 extensions.'; return; } search.value = ''; filter(); row().focus(); };
  search.oninput = event => { event.stopPropagation(); filter(); };
  search.onchange = event => event.stopPropagation();
  root.getValue = () => {
    const value = {}, seen = new Set(); let valid = true; error.textContent = '';
    for (const item of body.rows) {
      const input = item.querySelector('input'), key = input.value.trim().replace(/^\./, '').toLowerCase();
      if (!/^[a-z0-9_+-]{1,32}$/.test(key) || seen.has(key)) { valid = false; input.setCustomValidity(seen.has(key) ? 'Extension already exists.' : 'Enter a file extension.'); error.textContent = input.validationMessage; continue; }
      input.setCustomValidity(''); seen.add(key); value[key] = item.querySelector('select').value;
    }
    if (valid) lastValid = normalizeFileOpeners(value);
    return { ...lastValid };
  };
  root.setValue = value => { lastValid = normalizeFileOpeners(value); body.replaceChildren(); for (const [extension, type] of Object.entries(lastValid).sort(([a],[b]) => a.localeCompare(b))) row(extension, type); filter(); };
  root.setValue(DEFAULT_FILE_OPENERS); return root;
}
