import { buttonIcon, createMenu, menuAction } from './ui.js';
import { createRadioTabs } from './radio-tabs.js';

const MODES = ['hex', 'binary', 'unsigned', 'signed'], WIDTHS = [1, 2, 4, 8];
const MAX_SCROLL_HEIGHT = 8_000_000, HISTORY_BYTES = 8 * 1024 * 1024, MAX_EDIT_BYTES = 1024 * 1024;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
let viewerSequence = 0;
export const BINARY_DEFAULTS = Object.freeze({ mode: 'hex', width: 1, endian: 'little', showText: true, offsets: true, lineNumbers: true, bytesPerRow: 0, groupSize: 4, groupGap: 8, textEncoding: 'ascii', offsetFormat: 'hex', uppercase: true, fontSize: 13, fontFamily: 'monospace', rowHeight: 24, alternateRows: false, dimZeros: true, selectionColor: '#71baff', matchColor: '#dbb032' });
export function normalizeBinaryPreferences(value = {}) {
  const out = { ...BINARY_DEFAULTS };
  for (const [key, options] of Object.entries({ mode: MODES, width: WIDTHS, endian: ['little', 'big'], bytesPerRow: [0, 4, 8, 16, 32, 64], groupSize: [1, 2, 4, 8, 16], textEncoding: ['ascii', 'utf-8', 'windows-1252', 'utf-16le', 'utf-16be'], offsetFormat: ['hex', 'decimal'], fontFamily: ['monospace', 'Consolas', 'Courier New'] })) if (options.includes(value[key])) out[key] = value[key];
  for (const key of ['showText', 'offsets', 'lineNumbers', 'uppercase', 'alternateRows', 'dimZeros']) if (typeof value[key] === 'boolean') out[key] = value[key];
  for (const [key, min, max] of [['groupGap', 0, 24], ['fontSize', 10, 24], ['rowHeight', 18, 48]]) if (Number.isFinite(Number(value[key]))) out[key] = Math.max(min, Math.min(max, Number(value[key])));
  for (const key of ['selectionColor', 'matchColor']) if (/^#[\da-f]{6}$/i.test(value[key])) out[key] = value[key];
  return out;
}
export function binaryInteger(bytes, offset, width, endian = 'little', signed = false) {
  if (!Number.isInteger(offset) || !WIDTHS.includes(width) || offset < 0 || offset + width > bytes.length) throw Error('The selected value extends past the file.');
  let value = 0n;
  for (let i = 0; i < width; i++) value = value << 8n | BigInt(bytes[offset + (endian === 'big' ? i : width - 1 - i)]);
  return signed && value & 1n << BigInt(width * 8 - 1) ? value - (1n << BigInt(width * 8)) : value;
}
export function binaryEncodeInteger(text, width, endian = 'little', signed = false, radix = 10) {
  if (!WIDTHS.includes(width)) throw Error('Choose 1, 2, 4, or 8 bytes.');
  text = String(text).trim();
  if (text.length > width * 8 + 4) throw Error('The value is too large for the selected width.');
  const pattern = radix === 16 ? /^(?:0x)?[\da-f]+$/i : radix === 2 ? /^(?:0b)?[01]+$/i : /^-?\d+$/;
  if (!pattern.test(text)) throw Error(radix === 16 ? 'Enter a hexadecimal value.' : radix === 2 ? 'Enter a binary value.' : 'Enter an integer.');
  let value = BigInt(radix === 16 ? '0x' + text.replace(/^0x/i, '') : radix === 2 ? '0b' + text.replace(/^0b/i, '') : text);
  const bits = BigInt(width * 8), limit = 1n << bits, low = signed ? -(1n << bits - 1n) : 0n, high = signed ? (1n << bits - 1n) - 1n : limit - 1n;
  if (value < low || value > high) throw Error(`Value must be between ${low} and ${high}.`);
  if (value < 0) value += limit;
  const result = new Uint8Array(width);
  for (let i = 0; i < width; i++) { result[endian === 'big' ? width - 1 - i : i] = Number(value & 255n); value >>= 8n; }
  return result;
}
export function binarySearchPattern(text, type = 'text', maxBytes = 4096) {
  if (!['text', 'hex', 'binary'].includes(type)) throw Error('Unknown search format.');
  if (!text) throw Error('Enter a search value.');
  if (text.length > maxBytes * 8 + 4096) throw Error(`Value is limited to ${maxBytes.toLocaleString('en-US')} bytes.`);
  let result;
  if (type === 'text') result = new TextEncoder().encode(text);
  else {
    const compact = text.replace(/\s+/g, '');
    const size = type === 'binary' ? 8 : 2, pattern = type === 'binary' ? /^[01]+$/ : /^[\da-f]+$/i;
    if (!pattern.test(compact) || compact.length % size) throw Error(type === 'binary' ? 'Use complete groups of 8 bits.' : 'Use complete pairs of hexadecimal digits.');
    result = new Uint8Array(compact.match(new RegExp(`.{${size}}`, 'g')).map(value => parseInt(value, type === 'binary' ? 2 : 16)));
  }
  if (result.length > maxBytes) throw Error(`Value is limited to ${maxBytes.toLocaleString('en-US')} bytes.`);
  return result;
}
const cloneBytes = value => value instanceof Uint8Array ? value.slice() : value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : (() => { throw Error('Expected file bytes.'); })();
let latinMap;
function encodeText(text, encoding) {
  if (encoding === 'utf-8') return new TextEncoder().encode(text);
  if (encoding.startsWith('utf-16')) { const bytes = new Uint8Array(text.length * 2), big = encoding === 'utf-16be'; for (let i = 0; i < text.length; i++) { const value = text.charCodeAt(i); bytes[i * 2 + (big ? 0 : 1)] = value >>> 8; bytes[i * 2 + (big ? 1 : 0)] = value & 255; } return bytes; }
  if (!latinMap) { latinMap = new Map(); const decoder = new TextDecoder('windows-1252'); for (let i = 0; i < 256; i++) latinMap.set(decoder.decode(Uint8Array.of(i)), i); }
  return Uint8Array.from([...text].map(character => { const value = encoding === 'ascii' ? character.codePointAt(0) < 128 ? character.codePointAt(0) : undefined : latinMap.get(character); if (value === undefined) throw Error(`Text contains characters outside ${encoding === 'ascii' ? 'ASCII' : 'Windows-1252'}.`); return value; }));
}

export function createBinaryViewer({ bytes = new Uint8Array(), preferences = {}, onChange = () => {}, onPreferencesChange = () => {}, save, openSettings, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  let data = cloneBytes(bytes), state = normalizeBinaryPreferences(preferences), disposed = false, frame = 0, searchGeneration = 0, saving = false;
  maxBytes = Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? maxBytes : DEFAULT_MAX_BYTES;
  let selected = 0, anchor = 0, caret = 0, selectionLength = state.width, bytesPerRow = 16, visibleRowCount = 1, match = null, editMode = 'number', dragging = null, suppressClick = false;
  let undoStack = [], redoStack = [], historySize = 0, serial = 0, revision = 0, savedRevision = 0, currentPattern = new Uint8Array();
  selected = anchor = caret = Number.isSafeInteger(preferences.offset) ? Math.max(0, Math.min(data.length, preferences.offset)) : 0;
  let restoreOffset = Number.isSafeInteger(preferences.scrollOffset) ? Math.max(0, preferences.scrollOffset) : null;
  const instance = `binary-${++viewerSequence}`, menus = [], abort = new AbortController();
  const root = document.createElement('div'); root.className = 'binary-viewer';
  const toolbar = document.createElement('div'); toolbar.className = 'binary-toolbar'; toolbar.setAttribute('aria-label', 'Binary toolbar');
  const formatControls = document.createElement('div'); formatControls.className = 'binary-format-controls';
  const toolbarDivider = document.createElement('span'); toolbarDivider.className = 'binary-toolbar-divider'; toolbarDivider.setAttribute('aria-hidden', 'true');
  const toolbarActions = document.createElement('div'); toolbarActions.className = 'binary-toolbar-actions';
  toolbar.append(formatControls, toolbarDivider, toolbarActions);
  const viewport = document.createElement('div'); viewport.className = 'binary-viewport'; viewport.tabIndex = 0; viewport.setAttribute('role', 'grid'); viewport.setAttribute('aria-label', 'Binary data'); viewport.setAttribute('aria-multiselectable', 'true');
  const spacer = document.createElement('div'); spacer.className = 'binary-spacer'; const rows = document.createElement('div'); rows.className = 'binary-rows'; spacer.append(rows); viewport.append(spacer);
  const editForm = document.createElement('form'); editForm.className = 'binary-edit';
  const info = document.createElement('div'); info.className = 'binary-info'; info.setAttribute('aria-label', 'Selected value');
  const status = document.createElement('div'); status.className = 'binary-status'; status.setAttribute('role', 'status'); status.hidden = true;
  const fileStatus = document.createElement('div'); fileStatus.className = 'binary-file-status';
  root.append(toolbar, viewport, editForm, info, status, fileStatus);
  function button(host, title, glyph, action) { const element = document.createElement('button'); element.type = 'button'; buttonIcon(element, glyph, title, true); element.onclick = action; host.append(element); return element; }
  function choice(host, title, options, value, change) {
    const select = document.createElement('select'); select.setAttribute('aria-label', title);
    for (const [key, name] of options) { const option = document.createElement('option'); option.value = key; option.textContent = name; select.append(option); }
    select.value = value; select.onchange = () => change(select.value); host.append(select); return select;
  }
  function menu(label, iconName, host, role = 'dialog') { const item = createMenu(label, { iconName, role }); item.panel.classList.add('binary-popover'); menus.push(item); host.append(item.element); return item; }
  function preferencesChanged() { onPreferencesChange({ ...state }); }
  const modeSelect = choice(formatControls, 'Display', [['hex', 'Hex'], ['binary', 'Bin'], ['unsigned', 'Uint'], ['signed', 'Int']], state.mode, value => { state.mode = value; preferencesChanged(); resize(); updateInspector(true); });
  const widthTabs = createRadioTabs({ label: 'Value width', options: WIDTHS.map(value => ({ value, label: String(value), title: `${value} byte${value === 1 ? '' : 's'}` })), value: state.width, compact: true, onChange: value => { state.width = Number(value); select(selected); preferencesChanged(); } }); formatControls.append(widthTabs.element);
  const endianTabs = createRadioTabs({ label: 'Byte order', options: [{ value: 'little', label: 'LE', title: 'Little endian' }, { value: 'big', label: 'BE', title: 'Big endian' }], value: state.endian, compact: true, onChange: value => { state.endian = value; preferencesChanged(); updateInspector(true); } }); formatControls.append(endianTabs.element);
  const searchMenu = menu('Find', 'Search', toolbarActions), gotoMenu = menu('Go to offset', 'MoveRight', toolbarActions);
  const searchForm = document.createElement('form'); searchForm.className = 'binary-search'; searchMenu.panel.append(searchForm);
  const searchInput = document.createElement('input'); searchInput.type = 'search'; searchInput.maxLength = 32768; searchInput.setAttribute('aria-label', 'Search bytes'); searchInput.placeholder = 'Find'; searchInput.autocomplete = 'off'; searchForm.append(searchInput);
  const searchType = choice(searchForm, 'Search as', [['text', 'Text'], ['hex', 'Hex'], ['binary', 'Bin']], 'text', invalidateSearch);
  button(searchForm, 'Previous match', 'ChevronUp', () => find(-1)); button(searchForm, 'Next match', 'ChevronDown', () => find(1));
  searchInput.oninput = invalidateSearch; searchInput.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); find(event.shiftKey ? -1 : 1); } }; searchForm.onsubmit = event => { event.preventDefault(); find(1); };
  const gotoForm = document.createElement('form'); gotoForm.className = 'binary-goto'; gotoMenu.panel.append(gotoForm);
  const gotoInput = document.createElement('input'); gotoInput.type = 'text'; gotoInput.maxLength = 18; gotoInput.placeholder = '0x00'; gotoInput.setAttribute('aria-label', 'Go to offset'); gotoForm.append(gotoInput);
  const gotoButton = button(gotoForm, 'Go', 'ArrowRight', goTo); gotoButton.type = 'submit'; gotoButton.onclick = null; gotoForm.onsubmit = event => { event.preventDefault(); goTo(); };
  function goTo() { try { const text = gotoInput.value.trim(); if (!/^(?:0x[\da-f]+|\d+)$/i.test(text)) throw Error('Enter a decimal or 0x hexadecimal offset.'); const offset = Number(text); if (!Number.isSafeInteger(offset) || offset < 0 || offset > data.length) throw Error('Offset is outside the file.'); select(offset); gotoMenu.close(); viewport.focus(); } catch (error) { message(error.message); } }
  if (typeof openSettings === 'function') button(toolbarActions, 'Binary settings', 'Settings', openSettings);
  else {
    const settingsMenu = menu('Binary settings', 'Settings', toolbarActions); settingsMenu.panel.classList.add('binary-local-settings');
    for (const [key, title, options] of [
      ['showText', 'Text column'], ['offsets', 'Offsets'], ['lineNumbers', 'Line numbers'], ['uppercase', 'Uppercase hex'], ['alternateRows', 'Alternate rows'], ['dimZeros', 'Dim zero bytes'],
      ['bytesPerRow', 'Bytes per row', [0,4,8,16,32,64]], ['groupSize', 'Group size', [1,2,4,8,16]], ['textEncoding', 'Text encoding', ['ascii','utf-8','windows-1252','utf-16le','utf-16be']], ['offsetFormat', 'Offset format', ['hex','decimal']], ['fontFamily', 'Font', ['monospace','Consolas','Courier New']],
      ['fontSize', 'Font size', 'number'], ['rowHeight', 'Row height', 'number'], ['groupGap', 'Group gap', 'number'], ['selectionColor', 'Selection color', 'color'], ['matchColor', 'Search color', 'color'],
    ]) {
      const label = document.createElement('label'); label.textContent = title;
      let input;
      const update = value => { applyPreferences({ [key]: value }); preferencesChanged(); };
      if (Array.isArray(options)) input = choice(label, title, options.map(value => [String(value), value === 0 ? 'Auto' : String(value)]), String(state[key]), value => update(typeof state[key] === 'number' ? Number(value) : value));
      else { input = document.createElement('input'); input.type = options || 'checkbox'; input.setAttribute('aria-label', title); if (input.type === 'checkbox') input.checked = state[key]; else input.value = state[key]; input.onchange = () => update(input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value); label.append(input); }
      input.dataset.preference = key; settingsMenu.panel.append(label);
    }
  }
  const editInput = document.createElement('input'); editInput.type = 'text'; editInput.maxLength = MAX_EDIT_BYTES; editInput.setAttribute('aria-label', 'Edit selected value'); editInput.autocomplete = 'off'; editInput.spellcheck = false; editForm.append(editInput);
  const editTabs = createRadioTabs({ label: 'Edit as', options: [{ value: 'number', label: '', title: 'Number', icon: 'Hash' }, { value: 'text', label: '', title: 'Text', icon: 'Type' }], value: editMode, compact: true, onChange: value => { editMode = value; updateInspector(true); } }); editTabs.element.classList.add('binary-edit-type'); editForm.append(editTabs.element);
  const applyButton = button(editForm, 'Apply', 'Check', () => {}); applyButton.type = 'submit';
  const rowMenu = menu('Row actions', 'Ellipsis', editForm, 'menu');
  const action = (label, glyph, callback) => { const element = document.createElement('button'); element.type = 'button'; element.textContent = label; element.onclick = () => { try { callback(); } catch (error) { message(error.message); } }; menuAction(rowMenu.panel, element, glyph); return element; };
  const insertButton = action('Insert row', 'Plus', insertRow), deleteButton = action('Delete selection', 'Trash2', deleteSelection);
  const undoButton = action('Undo', 'Undo2', undo), redoButton = action('Redo', 'Redo2', redo), saveButton = typeof save === 'function' ? action('Save', 'Save', saveNow) : null;
  editForm.onsubmit = event => { event.preventDefault(); try { const replacement = editMode === 'text' ? encodeText(editInput.value, state.textEncoding) : binaryEncodeInteger(editInput.value, state.width, state.endian, state.mode === 'signed', state.mode === 'hex' ? 16 : state.mode === 'binary' ? 2 : 10); if (selected === data.length) insert(selected, replacement); else overwrite(selected, replacement); select(selected + replacement.length); viewport.focus(); } catch (error) { message(error.message); } };
  function message(text) { status.textContent = text; status.hidden = !text; }
  function invalidateSearch() { searchGeneration++; match = null; viewport.removeAttribute('aria-busy'); message(''); scheduleRender(); }
  function selectedEnd() { return Math.min(data.length, selected + selectionLength); }
  function offsetText(offset) { return state.offsetFormat === 'decimal' ? String(offset) : `0x${offset.toString(16)[state.uppercase ? 'toUpperCase' : 'toLowerCase']()}`; }
  function updateInspector(force = false) {
    const available = Math.min(state.width, data.length - selected); info.replaceChildren();
    const value = (text, key) => { const span = document.createElement('span'); span.textContent = text; if (key) span.dataset.value = key; info.append(span); };
    value(`@${offsetText(selected)}:`);
    if (available === state.width) {
      const unsigned = binaryInteger(data, selected, state.width, state.endian), signed = binaryInteger(data, selected, state.width, state.endian, true), hex = unsigned.toString(16).padStart(state.width * 2, '0');
      value(`0b${unsigned.toString(2).padStart(state.width * 8, '0')}`, 'binary'); value(`0x${state.uppercase ? hex.toUpperCase() : hex}`, 'hex'); value(`${unsigned}uint`, 'unsigned'); value(`${signed}int`, 'signed');
      if (force || document.activeElement !== editInput) editInput.value = editMode === 'text' ? new TextDecoder(state.textEncoding === 'ascii' ? 'windows-1252' : state.textEncoding).decode(data.subarray(selected, selectedEnd())) : state.mode === 'hex' ? hex[state.uppercase ? 'toUpperCase' : 'toLowerCase']() : state.mode === 'binary' ? unsigned.toString(2).padStart(state.width * 8, '0') : String(state.mode === 'signed' ? signed : unsigned);
    } else { value('—'); if (force || document.activeElement !== editInput) editInput.value = selected === data.length && editMode === 'number' ? '0' : ''; }
    editInput.placeholder = selected === data.length ? 'New value' : 'Value';
    applyButton.disabled = selected !== data.length && editMode === 'number' && available !== state.width;
    insertButton.disabled = data.length + bytesPerRow > maxBytes; deleteButton.disabled = selectedEnd() === selected;
    undoButton.disabled = !undoStack.length; redoButton.disabled = !redoStack.length; if (saveButton) saveButton.disabled = saving || revision === savedRevision;
    root.dataset.dirty = String(revision !== savedRevision); root.dataset.offset = String(selected); root.dataset.selectionLength = String(selectedEnd() - selected); root.dataset.mode = state.mode; root.dataset.length = String(data.length);
  }
  function byteText(value) { const text = state.mode === 'hex' ? value.toString(16).padStart(2, '0') : state.mode === 'binary' ? value.toString(2).padStart(8, '0') : String(state.mode === 'signed' && value >= 128 ? value - 256 : value); return state.uppercase ? text.toUpperCase() : text; }
  function textAt(index) {
    const byte = data[index], encoding = state.textEncoding;
    const printable = value => value.replace(/[\x00-\x1f\x7f-\x9f]/g, '·');
    if (encoding.startsWith('utf-16')) {
      if (index % 2) return '';
      const unitAt = offset => encoding === 'utf-16be' ? data[offset] * 256 + data[offset + 1] : data[offset] + data[offset + 1] * 256;
      const unit = unitAt(index);
      if (unit >= 0xdc00 && unit <= 0xdfff && index >= 2 && unitAt(index - 2) >= 0xd800 && unitAt(index - 2) <= 0xdbff) return '';
      const next = unitAt(index + 2), length = unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 4 : 2;
      return printable(new TextDecoder(encoding).decode(data.subarray(index, index + length)));
    }
    if (encoding === 'utf-8') {
      if ((byte & 0xc0) === 0x80) {
        for (let distance = 1; distance <= 3 && distance <= index; distance++) {
          const start = data[index - distance], length = start >= 0xc2 && start < 0xe0 ? 2 : start >= 0xe0 && start < 0xf0 ? 3 : start >= 0xf0 && start <= 0xf4 ? 4 : 0;
          if (length > distance) try { new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(index - distance, index - distance + length)); return ''; } catch { /* Invalid continuation bytes remain visible. */ }
        }
        return '�';
      }
      const length = byte < 128 || byte < 0xc2 || byte > 0xf4 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
      return printable(new TextDecoder('utf-8').decode(data.subarray(index, index + length)));
    }
    if (encoding === 'ascii') return byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '·';
    return printable(new TextDecoder('windows-1252').decode(data.subarray(index, index + 1)));
  }
  function rowHeight() { return Math.max(state.rowHeight, state.fontSize + 4); }
  function layoutMetrics() { const total = Math.ceil((data.length + 1) / bytesPerRow), physicalHeight = Math.min(MAX_SCROLL_HEIGHT, total * rowHeight()), visible = Math.max(1, Math.min(200, Math.ceil(viewport.clientHeight / rowHeight()))); return { total, physicalHeight, visible, compressed: total * rowHeight() > MAX_SCROLL_HEIGHT }; }
  function rowAtScroll(metrics) { return metrics.compressed ? Math.floor(viewport.scrollTop / Math.max(1, metrics.physicalHeight - viewport.clientHeight) * Math.max(0, metrics.total - metrics.visible)) : Math.floor(viewport.scrollTop / rowHeight()); }
  function render() {
    if (disposed) return; if (frame) cancelAnimationFrame(frame); frame = 0;
    const metrics = layoutMetrics(), start = Math.max(0, rowAtScroll(metrics) - 3), end = Math.min(metrics.total, start + metrics.visible + 7); visibleRowCount = metrics.visible;
    spacer.style.height = `${Math.max(metrics.physicalHeight, 1)}px`; rows.style.top = `${metrics.compressed ? viewport.scrollTop - (rowAtScroll(metrics) - start) * rowHeight() : start * rowHeight()}px`;
    rows.replaceChildren(); viewport.setAttribute('aria-rowcount', String(metrics.total)); viewport.setAttribute('aria-colcount', String(bytesPerRow));
    const fragment = document.createDocumentFragment();
    for (let row = start; row < end; row++) {
      const line = document.createElement('div'); line.className = 'binary-row'; if (state.alternateRows && row % 2) line.classList.add('alternate'); line.setAttribute('role', 'row'); line.setAttribute('aria-rowindex', String(row + 1));
      if (state.lineNumbers) { const number = document.createElement('span'); number.className = 'binary-line-number'; number.textContent = String(row + 1); line.append(number); }
      if (state.offsets) { const offset = document.createElement('span'); offset.className = 'binary-offset'; offset.textContent = state.offsetFormat === 'decimal' ? String(row * bytesPerRow) : (row * bytesPerRow).toString(16).padStart(8, '0')[state.uppercase ? 'toUpperCase' : 'toLowerCase'](); line.append(offset); }
      const cells = document.createElement('div'); cells.className = 'binary-cells'; const text = document.createElement('div'); text.className = 'binary-text'; text.setAttribute('aria-label', `${state.textEncoding} text`);
      for (let column = 0; column < bytesPerRow; column++) {
        const index = row * bytesPerRow + column, cell = document.createElement('span'); cell.className = 'binary-byte'; cell.setAttribute('role', 'gridcell'); cell.setAttribute('aria-colindex', String(column + 1));
        if (column && column % state.groupSize === 0) cell.classList.add('group-start');
        if (index <= data.length) {
          cell.dataset.offset = String(index); cell.id = `${instance}-${index}`; cell.textContent = index === data.length ? '+' : byteText(data[index]); if (index === data.length) cell.classList.add('binary-eof');
          cell.setAttribute('aria-label', index === data.length ? 'End of file' : `Offset ${index}, ${state.mode} ${cell.textContent}`); cell.setAttribute('aria-selected', String(index >= selected && index < selectedEnd()));
          if (index >= selected && index < selectedEnd()) cell.classList.add('selected'); if (index === selected) cell.classList.add('active'); if (state.dimZeros && data[index] === 0) cell.classList.add('zero');
          if (match !== null && index >= match && index < match + currentPattern.length) cell.classList.add('search-match');
          if (state.showText) { const letter = document.createElement('span'); letter.textContent = index === data.length ? '' : textAt(index); letter.dataset.offset = String(index); if (index >= selected && index < selectedEnd()) letter.className = 'selected'; text.append(letter); }
        }
        cells.append(cell);
      }
      line.append(cells); if (state.showText) line.append(text); fragment.append(line);
    }
    rows.append(fragment); const active = rows.querySelector(`[data-offset="${selected}"]`); if (active) viewport.setAttribute('aria-activedescendant', active.id); else viewport.removeAttribute('aria-activedescendant');
  }
  function scheduleRender() { if (!disposed && !frame) frame = requestAnimationFrame(render); }
  function reveal() { const metrics = layoutMetrics(), target = Math.floor(selected / bytesPerRow), visibleStart = rowAtScroll(metrics); if (target < visibleStart || target >= visibleStart + metrics.visible - 1) viewport.scrollTop = metrics.compressed ? target / Math.max(1, metrics.total - metrics.visible) * Math.max(0, metrics.physicalHeight - viewport.clientHeight) : target * rowHeight(); render(); }
  function select(offset, extend = false, length) {
    searchGeneration++; match = null; viewport.removeAttribute('aria-busy'); offset = Math.max(0, Math.min(data.length, Number.isFinite(offset) ? Math.floor(offset) : 0));
    caret = offset;
    if (extend) { selected = Math.min(anchor, offset); selectionLength = Math.abs(anchor - offset) + (offset < data.length ? 1 : 0); }
    else { selected = anchor = offset; selectionLength = length === undefined ? state.width : Math.max(0, Math.min(data.length - offset, Number.isFinite(length) ? Math.floor(length) : 0)); }
    updateInspector(true); reveal();
  }
  function resize() {
    if (disposed) return;
    const oldTop = restoreOffset ?? rowAtScroll(layoutMetrics()) * bytesPerRow; restoreOffset = null;
    const characterWidth = state.fontSize * .62, byteWidth = (state.mode === 'binary' ? 8 : state.mode === 'hex' ? 2 : state.mode === 'signed' ? 4 : 3) * characterWidth + 10;
    const fixed = (state.lineNumbers ? 48 : 0) + (state.offsets ? 82 : 0) + 20 + (state.showText ? 20 : 0);
    const available = Math.max(1, (viewport.clientWidth - fixed) / (byteWidth + state.groupGap / state.groupSize + (state.showText ? characterWidth : 0)));
    bytesPerRow = state.bytesPerRow || [1,2,4,8,16,32,64].filter(value => value <= available).at(-1) || 1;
    root.style.setProperty('--binary-byte-width', `${byteWidth}px`); root.style.setProperty('--binary-text-width', `${characterWidth}px`); root.style.setProperty('--binary-row-height', `${rowHeight()}px`); root.style.setProperty('--binary-font-size', `${state.fontSize}px`); root.style.setProperty('--binary-font', state.fontFamily); root.style.setProperty('--binary-group-gap', `${state.groupGap}px`); root.style.setProperty('--binary-selection', state.selectionColor); root.style.setProperty('--binary-match', state.matchColor); root.dataset.bytesPerRow = String(bytesPerRow);
    const metrics = layoutMetrics(), row = Math.floor(oldTop / bytesPerRow); spacer.style.height = `${metrics.physicalHeight}px`; viewport.scrollTop = metrics.compressed ? row / Math.max(1, metrics.total - metrics.visible) * Math.max(0, metrics.physicalHeight - viewport.clientHeight) : row * rowHeight(); render(); updateInspector();
  }
  function applyPreferences(next) {
    const top = rowAtScroll(layoutMetrics()) * bytesPerRow, oldWidth = state.width; state = normalizeBinaryPreferences({ ...state, ...next });
    modeSelect.value = state.mode; widthTabs.setValue(state.width); endianTabs.setValue(state.endian);
    for (const input of root.querySelectorAll('[data-preference]')) { const value = state[input.dataset.preference]; if (input.type === 'checkbox') input.checked = value; else input.value = value; }
    if (oldWidth !== state.width) selectionLength = state.width; restoreOffset = top; resize(); updateInspector(true);
  }
  function changed() { invalidateSearch(); updateInspector(); resize(); onChange({ dirty: revision !== savedRevision, revision, offset: selected, length: data.length }); }
  function applySplice(offset, remove, replacement) {
    if (replacement.length === remove) data.set(replacement, offset);
    else { const next = new Uint8Array(data.length - remove + replacement.length); next.set(data.subarray(0, offset)); next.set(replacement, offset); next.set(data.subarray(offset + remove), offset + replacement.length); data = next; }
  }
  function splice(offset, remove, replacement) {
    if (disposed) throw Error('The binary viewer is closed.');
    if (!(replacement instanceof Uint8Array) || replacement.length > MAX_EDIT_BYTES || !Number.isSafeInteger(remove) || remove < 0 || remove > MAX_EDIT_BYTES) throw Error('Each edit is limited to 1 MiB.');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + remove > data.length) throw Error('The edit extends past the file.');
    const length = data.length - remove + replacement.length;
    if (length > maxBytes && length > data.length) throw Error(`File size is limited to ${maxBytes.toLocaleString('en-US')} bytes.`);
    if (replacement.length === remove && replacement.every((value, index) => value === data[offset + index])) return false;
    const patch = { offset, before: data.slice(offset, offset + remove), after: replacement.slice(), beforeId: revision, afterId: ++serial };
    applySplice(offset, remove, patch.after); revision = patch.afterId; undoStack.push(patch);
    for (const old of redoStack) historySize -= old.before.length + old.after.length; redoStack = []; historySize += patch.before.length + patch.after.length;
    while (historySize > HISTORY_BYTES || undoStack.length > 1000) { const old = undoStack.shift(); historySize -= old.before.length + old.after.length; }
    selected = anchor = caret = Math.min(offset, data.length); selectionLength = Math.max(state.width, replacement.length); changed(); return true;
  }
  function overwrite(offset, replacement) { return splice(offset, replacement.length, replacement); }
  function insert(offset, replacement) { return splice(offset, 0, replacement); }
  function deleteRange(offset, length) { return splice(offset, length, new Uint8Array()); }
  function insertRow() { const offset = selected; insert(offset, new Uint8Array(bytesPerRow)); select(offset, false, bytesPerRow); viewport.focus(); }
  function deleteSelection() { const offset = selected, length = selectedEnd() - selected; if (!length) return false; deleteRange(offset, length); select(offset); viewport.focus(); return true; }
  function undo() { const patch = undoStack.pop(); if (!patch) return; applySplice(patch.offset, patch.after.length, patch.before); revision = patch.beforeId; redoStack.push(patch); select(patch.offset, false, patch.before.length); changed(); }
  function redo() { const patch = redoStack.pop(); if (!patch) return; applySplice(patch.offset, patch.before.length, patch.after); revision = patch.afterId; undoStack.push(patch); select(patch.offset, false, patch.after.length); changed(); }
  function markSaved(value = revision) { if (disposed) return; savedRevision = value; updateInspector(); onChange({ dirty: revision !== savedRevision, revision, offset: selected, length: data.length }); }
  async function saveNow() { if (saving || typeof save !== 'function' || revision === savedRevision) return; const captured = revision; saving = true; updateInspector(); try { await save(data.slice()); if (!disposed) { markSaved(captured); message('Saved'); } } catch (error) { if (!disposed) message(error.message || String(error)); } finally { saving = false; if (!disposed) updateInspector(); } }
  async function scan(pattern, start, end, last, generation) {
    const prefix = new Uint32Array(pattern.length);
    for (let i = 1, j = 0; i < pattern.length; i++) { while (j && pattern[i] !== pattern[j]) j = prefix[j - 1]; if (pattern[i] === pattern[j]) j++; prefix[i] = j; }
    let found = -1, matched = 0;
    for (let i = start; i < Math.min(data.length, end + pattern.length); i++) {
      if (i % 262144 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); if (disposed || generation !== searchGeneration) return -2; }
      while (matched && data[i] !== pattern[matched]) matched = prefix[matched - 1];
      if (data[i] === pattern[matched]) matched++;
      if (matched === pattern.length) { const offset = i - pattern.length + 1; if (offset <= end) { found = offset; if (!last) return found; } matched = prefix[matched - 1]; }
    }
    return found;
  }
  async function find(direction = 1) {
    const generation = ++searchGeneration;
    try {
      if (searchType.value === 'text' && searchInput.value.length > 4096) throw Error('Search is limited to 4,096 bytes.');
      const pattern = searchType.value === 'text' ? encodeText(searchInput.value, state.textEncoding) : binarySearchPattern(searchInput.value, searchType.value);
      if (!pattern.length) throw Error('Enter a search value.');
      if (pattern.length > 4096) throw Error('Search is limited to 4,096 bytes.');
      currentPattern = pattern;
      viewport.setAttribute('aria-busy', 'true'); message('Searching…');
      const last = data.length - pattern.length;
      if (last < 0) { match = null; message('No match'); return false; }
      const start = match === null ? selected : match + (direction < 0 ? -1 : 1);
      let result, wrapped = false;
      if (direction < 0) { result = await scan(pattern, 0, Math.min(last, start), true, generation); if (result === -1) { wrapped = true; result = await scan(pattern, Math.max(0, start + 1), last, true, generation); } }
      else { result = await scan(pattern, Math.max(0, start), last, false, generation); if (result === -1) { wrapped = true; result = await scan(pattern, 0, Math.min(last, start - 1), false, generation); } }
      if (disposed || generation !== searchGeneration || result === -2) return false;
      if (result < 0) { match = null; message('No match'); scheduleRender(); return false; }
      match = result; selected = anchor = caret = result; selectionLength = pattern.length; updateInspector(); reveal(); message(`${wrapped ? 'Wrapped · ' : ''}Match at 0x${result.toString(16).toUpperCase()}`); return true;
    } catch (error) { if (generation === searchGeneration) message(error.message); return false; }
    finally { if (generation === searchGeneration) viewport.removeAttribute('aria-busy'); }
  }
  function showSearch() { searchMenu.open(); searchInput.focus(); searchInput.select(); }
  viewport.addEventListener('scroll', scheduleRender);
  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.pointerType === 'touch') return;
    const cell = event.target.closest('[data-offset]'); if (!cell) return;
    select(Number(cell.dataset.offset), event.shiftKey); dragging = { id: event.pointerId, start: Number(cell.dataset.offset) }; suppressClick = false; viewport.setPointerCapture(event.pointerId); event.preventDefault(); viewport.focus({ preventScroll: true });
  });
  viewport.addEventListener('pointermove', event => {
    if (!dragging || event.pointerId !== dragging.id || !(event.buttons & 1)) return;
    const rect = viewport.getBoundingClientRect(); if (event.clientY < rect.top + rowHeight()) viewport.scrollTop -= rowHeight(); else if (event.clientY > rect.bottom - rowHeight()) viewport.scrollTop += rowHeight();
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-offset]'); if (!cell || !viewport.contains(cell)) return;
    const offset = Number(cell.dataset.offset); if (offset !== dragging.start) suppressClick = true; select(offset, true);
  });
  const endDrag = () => { dragging = null; }; viewport.addEventListener('pointerup', endDrag); viewport.addEventListener('pointercancel', endDrag); viewport.addEventListener('lostpointercapture', endDrag);
  viewport.addEventListener('click', event => { if (suppressClick) { suppressClick = false; return; } const cell = event.target.closest('[data-offset]'); if (!cell) return; select(Number(cell.dataset.offset), event.shiftKey); viewport.focus({ preventScroll: true }); });
  viewport.addEventListener('dblclick', event => { const cell = event.target.closest('[data-offset]'); if (!cell) return; select(Number(cell.dataset.offset)); editInput.focus(); editInput.select(); });
  viewport.addEventListener('keydown', event => {
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); showSearch(); return; }
    if (command && event.key.toLowerCase() === 'g') { event.preventDefault(); gotoMenu.open(); gotoInput.focus(); return; }
    if (command && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
    if (command && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
    if (command && event.key.toLowerCase() === 's' && save) { event.preventDefault(); saveNow(); return; }
    if (command && event.key.toLowerCase() === 'a') { event.preventDefault(); select(0, false, data.length); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); try { deleteSelection(); } catch (error) { message(error.message); } return; }
    if (event.key === 'Insert') { event.preventDefault(); try { insertRow(); } catch (error) { message(error.message); } return; }
    let next = caret;
    if (event.key === 'ArrowRight') next++;
    else if (event.key === 'ArrowLeft') next--;
    else if (event.key === 'ArrowDown') next += bytesPerRow;
    else if (event.key === 'ArrowUp') next -= bytesPerRow;
    else if (event.key === 'PageDown') next += bytesPerRow * Math.max(1, visibleRowCount - 1);
    else if (event.key === 'PageUp') next -= bytesPerRow * Math.max(1, visibleRowCount - 1);
    else if (event.key === 'Home') next = command ? 0 : Math.floor(caret / bytesPerRow) * bytesPerRow;
    else if (event.key === 'End') next = command ? data.length : Math.min(data.length, Math.floor(caret / bytesPerRow) * bytesPerRow + bytesPerRow - 1);
    else if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); editInput.focus(); editInput.select(); return; }
    else if (event.key === 'Escape') { invalidateSearch(); select(selected); return; }
    else return;
    event.preventDefault(); select(next, event.shiftKey);
  });
  viewport.addEventListener('copy', event => { if (!data.length || !event.clipboardData) return; event.preventDefault(); const end = Math.min(selectedEnd(), selected + MAX_EDIT_BYTES); event.clipboardData.setData('text/plain', [...data.subarray(selected, end)].map(value => value.toString(16).padStart(2, '0')[state.uppercase ? 'toUpperCase' : 'toLowerCase']()).join(' ')); if (end < selectedEnd()) message('Copied the first 1 MiB.'); });
  viewport.addEventListener('paste', event => { if (!event.clipboardData) return; event.preventDefault(); try { const text = event.clipboardData.getData('text/plain'); const replacement = state.mode === 'hex' ? binarySearchPattern(text, 'hex', MAX_EDIT_BYTES) : state.mode === 'binary' ? binarySearchPattern(text, 'binary', MAX_EDIT_BYTES) : binaryEncodeInteger(text, state.width, state.endian, state.mode === 'signed'); if (selected === data.length) insert(selected, replacement); else overwrite(selected, replacement); select(selected + replacement.length); } catch (error) { message(error.message); } });
  root.addEventListener('keydown', event => { if (event.key === 'Escape') menus.forEach(item => item.close()); });
  window.addEventListener('resize', () => menus.forEach(item => item.position()), { signal: abort.signal });
  const observer = new ResizeObserver(resize); observer.observe(viewport); updateInspector(); resize();
  return {
    element: root, menuPanel: rowMenu.panel, fileStatusElement: fileStatus,
    get dirty() { return revision !== savedRevision; }, get revision() { return revision; },
    getBytes: () => data.slice(), markSaved, overwrite, insert, deleteRange, insertRow, deleteSelection, undo, redo,
    select: (offset, length) => select(offset, false, length), applyPreferences,
    async search(query, type = 'text', direction = 1) { if (typeof query !== 'string' || query.length > (type === 'text' ? 4096 : 32768)) { invalidateSearch(); message('Search is limited to 4,096 bytes.'); return false; } searchInput.value = query; searchType.value = type; invalidateSearch(); return find(direction); },
    findNext: () => find(1), findPrevious: () => find(-1),
    load(value) { if (revision !== savedRevision) throw Error('Save or discard binary edits before reloading.'); const top = rowAtScroll(layoutMetrics()) * bytesPerRow; data = cloneBytes(value); undoStack = []; redoStack = []; historySize = 0; revision = savedRevision = ++serial; invalidateSearch(); selected = anchor = caret = Math.min(selected, data.length); selectionLength = state.width; restoreOffset = top; updateInspector(true); resize(); },
    snapshot: () => ({ ...state, offset: selected, scrollOffset: rowAtScroll(layoutMetrics()) * bytesPerRow }), resize,
    dispose() { if (disposed) return; disposed = true; searchGeneration++; observer.disconnect(); abort.abort(); if (frame) cancelAnimationFrame(frame); menus.forEach(item => item.destroy()); root.remove(); data = new Uint8Array(); undoStack = []; redoStack = []; },
  };
}
