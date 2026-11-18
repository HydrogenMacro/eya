import { DEFAULT_FILE_OPENERS, normalizeFileOpeners, createFileOpenerControl } from './file-openers.js';
// Shared settings registry: add a field here to expose it in both configuration UIs.
export const SETTINGS_GROUPS = [
  ['appearance', 'Appearance', 'Palette'], ['terminal', 'Terminal', 'Terminal'],
  ['files', 'Files', 'Folder'], ['editor', 'Editor', 'FileCode'], ['binary', 'Binary viewer', 'Hash'], ['browser', 'Browser', 'Globe'],
  ['image', 'Images', 'Image'], ['video', 'Video', 'Film'], ['audio', 'Audio', 'Music'], ['cad', '3D viewer', 'Box'],
  ['taskManager', 'Task Manager', 'Activity'], ['docker', 'Docker', 'Container'],
].map(([id, title, icon]) => ({ id, title, icon }));
const fields = [];
const add = (group, id, key, label, type, value, details = {}) => fields.push({ group, id, key, label, type, default: value, ...details });
const choice = (group, id, key, label, value, options) => add(group, id, key, label, 'select', value, { options: options.map(option => Array.isArray(option) ? option : [option, String(option)]) });
const toggle = (group, id, key, label, value) => add(group, id, key, label, 'checkbox', value);
const number = (group, id, key, label, value, min, max, step = 1) => add(group, id, key, label, 'number', value, { min, max, step });
choice('appearance', 'theme', 'theme', 'Theme', 'dark', [['dark','Dark'],['light','Light'],['midnight','Midnight'],['solarized','Solarized']]);
choice('appearance', 'accent-color', 'accentColor', 'Accent', 'mint', [['mint','Mint'],['blue','Blue'],['violet','Violet'],['amber','Amber']]);
choice('appearance', 'ui-density', 'uiDensity', 'Density', 'comfortable', [['comfortable','Comfortable'],['compact','Compact']]);
choice('appearance', 'ui-style', 'uiStyle', 'Corners', 'default', [['default','Default'],['rounded','Rounded'],['square','Square']]);
choice('appearance', 'panel-focus-mode', 'panelFocusMode', 'Panel focus', 'click', [['click','Click'],['hover','Hover']]);
toggle('appearance', 'panel-focus-border', 'panelFocusBorder', 'Highlight focused panel', false);
toggle('appearance', 'reduce-motion', 'reduceMotion', 'Reduce motion', false);
toggle('appearance', 'mobile-floating-panel-switcher', 'mobileFloatingPanelSwitcher', 'Floating panel switcher on mobile', false);
add('appearance', 'mobile-panel-button-position', 'mobilePanelButtonPosition', 'Panel button position', 'point', { x: 0.95, y: 0.65 }, { hidden: true });
number('terminal', 'font-size', 'fontSize', 'Font size', 15, 8, 36);
number('terminal', 'scrollback', 'scrollback', 'Scrollback lines', 5000, 0, 50000);
choice('terminal', 'cursor-style', 'cursorStyle', 'Cursor', 'block', [['block','Block'],['underline','Underline'],['bar','Bar']]);
toggle('terminal', 'cursor-blink', 'cursorBlink', 'Blink cursor', true);
toggle('terminal', 'scroll-on-input', 'scrollOnUserInput', 'Scroll on input', true);
toggle('terminal', 'terminal-compression', 'terminalCompression', 'Compress output', true);
choice('terminal', 'terminal-link-target', 'terminalLinkTarget', 'Open links in', 'browser', [['browser','Browser panel'],['external','External tab']]);
add('terminal', 'default-command', 'defaultCommand', 'Startup command', 'textarea', '', { maxLength: 8192, hint: 'Runs once per new terminal.' });
choice('files', 'transfer-unit', 'transferUnit', 'Transfer units', 'bytes', [['auto','Automatic'],['bytes','Bytes (B)'],['kb','Kilobytes (KiB)'],['mb','Megabytes (MiB)']]);
add('files', 'starting-directory', 'startingDirectory', 'Starting directory', 'text', '', { maxLength: 4096, placeholder: 'Server working directory' });
choice('files', 'refresh-interval', 'refreshInterval', 'Refresh', 5, [[0,'Off'],[2,'2 seconds'],[5,'5 seconds'],[10,'10 seconds'],[30,'30 seconds']]);
toggle('files', 'file-autoreload', 'fileAutoreload', 'Reload changed files', true);
toggle('files', 'show-hidden', 'showHidden', 'Show hidden files', false);
toggle('files', 'file-details', 'fileDetails', 'Show file details', true);
toggle('files', 'confirm-delete', 'confirmDelete', 'Confirm deletion', true);
add('files', 'file-openers', 'fileOpeners', 'File openers', 'file-openers', DEFAULT_FILE_OPENERS);
number('editor', 'editor-font-size', 'editorFontSize', 'Font size', 16, 12, 28);
choice('editor', 'editor-tab-size', 'editorTabSize', 'Tab size', 4, [2,4,8]);
toggle('editor', 'editor-wrap', 'editorWrap', 'Wrap lines', true);
toggle('editor', 'editor-line-numbers', 'editorLineNumbers', 'Line numbers', true);
choice('binary', 'binary-mode', 'binary.mode', 'Display', 'hex', [['hex','Hex'],['binary','Bin'],['unsigned','Uint'],['signed','Int']]);
choice('binary', 'binary-width', 'binary.width', 'Value width', 1, [[1,'1 byte'],[2,'2 bytes'],[4,'4 bytes'],[8,'8 bytes']]);
choice('binary', 'binary-endian', 'binary.endian', 'Byte order', 'little', [['little','Little endian'],['big','Big endian']]);
choice('binary', 'binary-bytes-per-row', 'binary.bytesPerRow', 'Bytes per row', 0, [[0,'Automatic'],4,8,16,32,64]);
choice('binary', 'binary-group-size', 'binary.groupSize', 'Bytes per group', 4, [1,2,4,8,16]);
number('binary', 'binary-group-gap', 'binary.groupGap', 'Group spacing', 8, 0, 24);
toggle('binary', 'binary-show-text', 'binary.showText', 'Show text column', true);
toggle('binary', 'binary-offsets', 'binary.offsets', 'Show offsets', true);
toggle('binary', 'binary-line-numbers', 'binary.lineNumbers', 'Show line numbers', true);
choice('binary', 'binary-text-encoding', 'binary.textEncoding', 'Text encoding', 'ascii', [['ascii','ASCII'],['utf-8','UTF-8'],['windows-1252','Windows-1252'],['utf-16le','UTF-16 LE'],['utf-16be','UTF-16 BE']]);
choice('binary', 'binary-offset-format', 'binary.offsetFormat', 'Offset format', 'hex', [['hex','Hexadecimal'],['decimal','Decimal']]);
toggle('binary', 'binary-uppercase', 'binary.uppercase', 'Uppercase hexadecimal', true);
number('binary', 'binary-font-size', 'binary.fontSize', 'Font size', 13, 10, 24);
choice('binary', 'binary-font-family', 'binary.fontFamily', 'Font', 'monospace', [['monospace','Monospace'],['Consolas','Consolas'],['Courier New','Courier New']]);
number('binary', 'binary-row-height', 'binary.rowHeight', 'Row height', 24, 18, 48);
toggle('binary', 'binary-alternate-rows', 'binary.alternateRows', 'Alternate row shading', false);
toggle('binary', 'binary-dim-zeros', 'binary.dimZeros', 'Dim zero bytes', true);
add('binary', 'binary-selection-color', 'binary.selectionColor', 'Selection color', 'color', '#71baff');
add('binary', 'binary-match-color', 'binary.matchColor', 'Search match color', 'color', '#dbb032');
choice('browser', 'browser-resolution', 'browser.stream.resolution', 'Stream resolution', 'native', [['native','Native'],['1920','1920 × 1080'],['1280','1280 × 720'],['960','960 × 540']]);
choice('browser', 'browser-format', 'browser.stream.format', 'Stream encoding', 'jpeg', [['jpeg','JPEG (lossy)'],['efficient','Efficient lossless'],['png','PNG (lossless)']]);
choice('browser', 'browser-quality', 'browser.stream.quality', 'JPEG quality', 80, [[95,'95 · Highest'],[80,'80 · Standard'],[60,'60 · Balanced'],[40,'40 · Low bandwidth']]);
choice('browser', 'browser-fps', 'browser.stream.fps', 'Frame rate', 60, [[60,'60 fps'],[30,'30 fps'],[15,'15 fps'],[5,'5 fps']]);
toggle('browser', 'browser-block-trackers', 'browser.blockTrackers', 'Block ads and trackers', false);
toggle('browser', 'browser-block-third-party', 'browser.blockThirdParty', 'Block third-party requests', false);
toggle('browser', 'browser-strip-tracking', 'browser.stripTracking', 'Remove tracking parameters', false);
toggle('browser', 'browser-disable-cache', 'browser.disableCache', 'Disable cache', false);
toggle('browser', 'browser-devtools', 'browser.devtoolsOpen', 'Open developer tools', false);
choice('image', 'image-background-mode', 'image.mode', 'Background', 'checkerboard', [['checkerboard','Checkerboard'],['white','White'],['plain','Plain']]);
add('image', 'image-background-color1', 'image.color1', 'First checker color', 'color', '#d8d8d8');
add('image', 'image-background-color2', 'image.color2', 'Second checker color', 'color', '#a8a8a8');
choice('video', 'video-speed', 'video.speed', 'Playback speed', '1', [['0.5','0.5×'],['0.75','0.75×'],['1','Normal'],['1.25','1.25×'],['1.5','1.5×'],['2','2×']]);
toggle('video', 'video-loop', 'video.loop', 'Loop', false);
choice('video', 'video-subtitle-size', 'video.size', 'Subtitle size', 'medium', [['small','Small'],['medium','Medium'],['large','Large'],['xlarge','Extra large']]);
choice('video', 'video-subtitle-font', 'video.font', 'Subtitle font', 'sans', [['sans','Sans serif'],['serif','Serif'],['mono','Monospace']]);
add('video', 'video-subtitle-color', 'video.color', 'Subtitle color', 'color', '#ffffff');
add('video', 'video-subtitle-background', 'video.background', 'Subtitle background', 'color', '#000000');
choice('video', 'video-subtitle-opacity', 'video.opacity', 'Background opacity', '60', [['0','Transparent'],['30','30%'],['60','60%'],['80','80%'],['100','Solid']]);
choice('video', 'video-subtitle-outline', 'video.outline', 'Subtitle outline', 'shadow', [['none','None'],['shadow','Shadow'],['outline','Outline']]);
choice('video', 'video-subtitle-position', 'video.position', 'Subtitle position', 'bottom', [['bottom','Bottom'],['top','Top']]);
choice('audio', 'audio-speed', 'audio.speed', 'Playback speed', 1, [[0.5,'0.5×'],[0.75,'0.75×'],[1,'Normal'],[1.25,'1.25×'],[1.5,'1.5×'],[2,'2×']]);
toggle('audio', 'audio-loop', 'audio.loop', 'Loop', false);
choice('cad', 'cad-unit', 'cad.unit', 'Measurement units', 'mm', ['mm','cm','in']);
number('cad', 'cad-decimal-places', 'cad.decimalPlaces', 'Decimal places', 3, 0, 10, 1);
choice('cad', 'cad-stl-unit', 'cad.stlUnit', 'STL source units', 'mm', ['mm','cm','m','in']);
toggle('cad', 'cad-live', 'cad.live', 'Live reload', true);
choice('cad', 'cad-interval', 'cad.interval', 'Reload interval', 1000, [[500,'0.5 seconds'],[1000,'1 second'],[2000,'2 seconds'],[5000,'5 seconds']]);
number('cad', 'cad-view-section-distance', 'cad.viewSectionDistance', 'View section distance from camera (mm)', 0.001, 0.000001, 1000000000, 'any');
toggle('cad', 'cad-view-section-flip', 'cad.viewSectionFlip', 'Flip view section', false);
for (const axis of ['x','y','z']) {
  number('cad','cad-section-'+axis+'-min','cad.sectionRanges.'+axis+'.0',axis.toUpperCase()+' section minimum',0,0,1,0.01);
  number('cad','cad-section-'+axis+'-max','cad.sectionRanges.'+axis+'.1',axis.toUpperCase()+' section maximum',1,0,1,0.01);
}
choice('cad', 'cad-display-mode', 'cad.mode', 'Display', 'shaded', [['flat','Flat'],['zebra','Zebra'],['shaded','Shaded']]);
number('cad', 'cad-opacity', 'cad.opacity', 'Opacity', 1, 0.05, 1, 0.05);
toggle('cad', 'cad-show-edges', 'cad.showEdges', 'Edges', true);
toggle('cad', 'cad-show-points', 'cad.showPoints', 'Points', false);
number('cad', 'cad-gizmo-size', 'cad.gizmoSize', 'Gizmo size', 96, 64, 180, 1);
number('cad', 'cad-speed-modifier', 'cad.speedModifier', 'Movement speed modifier', 4, 1, 20, 0.5);
choice('cad', 'cad-sidebar-side', 'cad.sidebar.side', 'Sidebar side', 'right', ['left','right','top','bottom']);
choice('cad', 'cad-grid-planes', 'cad.gridPlanes', 'Grid planes', 'all', [['off','Off'],['xy','XY'],['all','All planes']]);
toggle('cad', 'cad-infinite-grid', 'cad.infiniteGrid', 'Infinite grids', false);
toggle('cad', 'cad-grid-lines', 'cad.gridLines', 'Grid lines', true);
toggle('cad', 'cad-grid-fill', 'cad.gridFill', 'Grid fill', false);
choice('cad', 'cad-orbit-style', 'cad.orbitStyle', 'Orbit', 'turntable', [['turntable','Turntable'],['free','Free orbit']]);
choice('cad', 'cad-orbit-pivot', 'cad.orbitPivot', 'Orbit around', 'target', [['target','View target'],['origin','Origin'],['model','Model center']]);
number('cad', 'cad-movement-speed', 'cad.movementSpeed', 'Movement speed', 1, 0.25, 4, 0.25);
number('cad', 'cad-look-speed', 'cad.lookSpeed', 'Look sensitivity', 1, 0.25, 3, 0.25);
add('cad', 'cad-measurement-color', 'cad.measurementColor', 'Measurement color', 'color', '#ff4f9a');
number('cad', 'cad-measurement-point-size', 'cad.measurementPointSize', 'Measurement point size', 1.5, 0.5, 3, 0.1);
add('cad', 'cad-selection-color', 'cad.selectionColor', 'Selection color', 'color', '#66ff99');
for (const [suffix,key,label,value] of [['invert-look','invertLook','Invert look',false],['axis-coordinates','axisCoordinates','Grid tick marks',true],['section-gizmos','sectionGizmos','Section gizmos',true],['rotation-gizmo','rotationGizmo','Rotation gizmo',true],['hover-highlights','hoverHighlights','Hover highlights',true]]) toggle('cad', 'cad-'+suffix, 'cad.'+key, label, value);
choice('taskManager', 'task-interval', 'taskManager.interval', 'Update interval', 500, [[250,'0.25 seconds'],[500,'0.5 seconds'],[1000,'1 second'],[2000,'2 seconds'],[5000,'5 seconds'],[10000,'10 seconds']]);
choice('taskManager', 'task-range', 'taskManager.range', 'Graph history', 120, [[60,'1 minute'],[120,'2 minutes'],[300,'5 minutes']]);
choice('taskManager', 'task-density', 'taskManager.density', 'Row density', 'comfortable', [['comfortable','Comfortable'],['compact','Compact']]);
choice('taskManager', 'task-chart-style', 'taskManager.chartStyle', 'Graph style', 'area', [['area','Area'],['line','Line']]);
toggle('taskManager', 'task-charts', 'taskManager.charts', 'Show graphs', true);
toggle('taskManager', 'task-tree', 'taskManager.tree', 'Process tree', false);
add('taskManager', 'task-columns', 'taskManager.columns', 'Process columns', 'multiselect', ['name','pid','cpu','rss','uid','state'], { options: [['name','Process'],['pid','PID'],['cpu','CPU'],['rss','Memory'],['uid','User'],['state','State'],['threads','Threads'],['virtualBytes','Virtual memory'],['nice','Nice']], requiredValues: ['name','pid','cpu','rss'] });
choice('docker', 'docker-interval', 'docker.interval', 'Refresh', 5000, [[3000,'3 seconds'],[5000,'5 seconds'],[10000,'10 seconds'],[30000,'30 seconds']]);
choice('docker', 'docker-density', 'docker.density', 'Row density', 'comfortable', [['comfortable','Comfortable'],['compact','Compact']]);
choice('docker', 'docker-chart-style', 'docker.chartStyle', 'Graph style', 'area', [['area','Area'],['line','Line']]);
toggle('docker', 'docker-charts', 'docker.charts', 'Show graphs', true);
toggle('docker', 'docker-image-column', 'docker.columns.image', 'Image column', true);
toggle('docker', 'docker-ports-column', 'docker.columns.ports', 'Ports column', true);
choice('docker', 'docker-tail', 'docker.tail', 'Log lines', 200, [100,200,500,1000,5000]);
toggle('docker', 'docker-timestamps', 'docker.timestamps', 'Log timestamps', true);
export const SETTINGS_FIELDS = fields;
const definition = field => typeof field === 'string' ? fields.find(value => value.key === field || value.id === field) : field;
export function getSetting(source, field) {
  const item = definition(field); return item.key.split('.').reduce((value,key) => value?.[key], source);
}
export function setSetting(target, field, value) {
  const item = definition(field), keys = item.key.split('.'); let parent = target;
  for (let index = 0; index < keys.length - 1; index++) { const key = keys[index]; if (!parent[key] || typeof parent[key] !== 'object') parent[key] = /^\d+$/.test(keys[index+1]) ? [] : {}; parent = parent[key]; }
  parent[keys.at(-1)] = value; return target;
}
export function normalizeSetting(field, value) {
  const item = definition(field);
  if (item.type === 'point') return value && Number.isFinite(value.x) && Number.isFinite(value.y) && value.x >= 0 && value.x <= 1 && value.y >= 0 && value.y <= 1 ? { x:value.x, y:value.y } : { ...item.default };
  if (item.type === 'file-openers') return normalizeFileOpeners(value);
  if (item.type === 'checkbox') return typeof value === 'boolean' ? value : item.default;
  if (item.key === 'cad.mode' && ['edges','wireframe'].includes(value)) return value;
  if (item.type === 'select') return item.options.some(([choice]) => choice === value) ? value : item.default;
  if (item.type === 'multiselect') return Array.isArray(value) ? [...new Set([...(item.requiredValues || []), ...value.filter(key => item.options.some(([choice]) => choice === key))])] : [...item.default];
  if (item.type === 'number') return typeof value === 'number' && Number.isFinite(value) && value >= item.min && value <= item.max && (item.step !== 1 || Number.isInteger(value)) ? value : item.default;
  if (item.type === 'color') return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : item.default;
  return typeof value === 'string' && !value.includes('\0') && value.length <= (item.maxLength || 4096) ? value : item.default;
}
export function normalizeSettings(source = {}) {
  const result = {}; for (const field of fields) setSetting(result, field, normalizeSetting(field, getSetting(source, field)));
  if (['edges','wireframe','shaded'].includes(source.cad?.mode) && typeof source.cad.showEdges !== 'boolean') result.cad.showEdges = source.cad.mode === 'edges';
  return result;
}
function controlId(field, generator) { return generator ? ({'font-size':'size','default-command':'command'}[field.id] || field.id) : field.id; }
export function createSettingControl(field, { generator = false } = {}) {
  if (field.hidden) {
    const input = document.createElement('input'); input.type = 'hidden'; input.hidden = true; input.id = controlId(field,generator); writeControl(input,field,field.default); return input;
  }
  if (field.type === 'file-openers') {
    const row = document.createElement('div'); row.className = 'setting'; row.dataset.settingKey = field.key;
    const title = document.createElement('span'); title.textContent = field.label;
    const control = createFileOpenerControl(); control.id = controlId(field, generator); row.append(title, control); return row;
  }
  const row = document.createElement('label'); row.className = 'setting'; row.dataset.settingKey = field.key;
  const text = document.createElement('span'); text.textContent = field.label;
  const input = document.createElement(field.type === 'select' || field.type === 'multiselect' ? 'select' : field.type === 'textarea' ? 'textarea' : 'input');
  input.id = controlId(field, generator); input.dataset.settingKey = field.key;
  if (field.type === 'select' || field.type === 'multiselect') {
    input.multiple = field.type === 'multiselect';
    for (const [value,label] of field.options) { const option = document.createElement('option'); option.value = String(value); option.textContent = label; input.append(option); }
    if (input.multiple) input.size = Math.min(6, field.options.length);
    if (field.key === 'cad.mode') for (const [value,label] of [['edges','Shaded + edges'],['wireframe','Wireframe']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; option.hidden = true; input.append(option); }
  } else if (field.type !== 'textarea') input.type = field.type;
  if (field.min !== undefined) input.min = field.min;
  if (field.max !== undefined) input.max = field.max;
  if (field.step !== undefined) input.step = field.step;
  if (field.maxLength) input.maxLength = field.maxLength;
  if (field.placeholder) input.placeholder = field.placeholder;
  input.setAttribute('aria-label', field.label); if (field.type === 'text' || field.type === 'textarea') input.spellcheck = false;
  if (field.type === 'checkbox') { row.classList.add('setting-check'); row.append(input,text); } else row.append(text,input);
  if (field.hint) { const hint = document.createElement('small'); hint.textContent = field.hint; row.append(hint); }
  writeControl(input, field, field.default); return row;
}
function writeControl(input, field, value) {
  if (field.type === 'point') input.value = JSON.stringify(value);
  else if (field.type === 'file-openers') input.setValue(value);
  else if (field.type === 'checkbox') input.checked = value;
  else if (field.type === 'multiselect') for (const option of input.options) { option.selected = value.includes(option.value); option.disabled = field.requiredValues?.includes(option.value) || false; }
  else input.value = String(value);
}
export function writeSettingsControls(root, source, { generator = false } = {}) {
  for (const field of fields) { const input = root.querySelector('#'+controlId(field,generator)); if (input) writeControl(input,field,normalizeSetting(field,getSetting(source,field))); }
}
export function readSettingsControls(root = document, { generator = false, base = {} } = {}) {
  const result = structuredClone(base);
  for (const field of fields) {
    const input = root.querySelector('#'+controlId(field,generator)); if (!input) continue;
    let value = field.type === 'file-openers' ? input.getValue() : field.type === 'checkbox' ? input.checked : field.type === 'multiselect' ? [...input.selectedOptions].map(option => option.value) : field.type === 'number' || (field.type === 'select' && typeof field.default === 'number') ? Number(input.value) : input.value;
    if (field.type === 'point') { try { value = JSON.parse(input.value); } catch { value = undefined; } }
    setSetting(result,field,normalizeSetting(field,value));
  }
  return result;
}
