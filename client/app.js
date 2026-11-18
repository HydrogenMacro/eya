import { deriveKey } from './noise-key.js';
import { randomId } from './ids.js';
import { setKeybinds, getKeybinds, matchesKeybind, createKeybindSettings } from './keybinds.js';
import { SETTINGS_FIELDS, SETTINGS_GROUPS, normalizeSettings, getSetting, setSetting, readSettingsControls, writeSettingsControls, createSettingControl } from './settings-schema.js';
import { checkCredentials, hostedClientUrl, normalizeConnectionUrl } from './connection-form.js';
import { settingsNavigation } from './settings-navigation.js';
import { discoverSubtitles } from './video-subtitles.js';
import { createFileClipboard, createFileSelection } from './file-selection.js';
import { fileProgress, setFileProgressUnit } from './file-progress.js';
import { bindFileSorting, sortFiles, modifiedDate } from './file-presentation.js';
import { fileIcon } from './file-icons.js';
import { createAuxiliaryBar } from './auxiliary-bar.js';
import { preventPageZoom } from './mobile-zoom.js';
import { trackWorkspaceViewport } from './mobile-viewport.js';
import { setupClientUpdates } from './client-updates.js';
import { WIRE_CAPABILITIES, selectedCapabilities, receiveExtension } from './wire.js';
import Noise from 'noise-handshake';
import Cipher from 'noise-handshake/cipher';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { PanelWorkbench } from './panels.js';
import { createWorkspaces } from './workspaces.js';
import { createConnectionLifecycle, PendingRequests } from './connection-lifecycle.js';
import { createCadViewer, isCadFile } from './cad.js';
import { createTerminalPanel } from './terminal-panel.js';
import { createFileBrowser } from './file-browser.js';
import { createFileCombobox, normalizeFilePath } from './file-combobox.js';
import { bindFileEntryInteractions } from './file-entry-interactions.js';
import { createHtmlViewer } from './html-viewer.js';
import { createMarkdownViewer } from './markdown-viewer.js';
import { createBinaryViewer } from './binary-viewer.js';
import { createMobileWorkspaceNavigator } from './mobile-workspace.js';
import { createSubmenu } from './submenu.js';
import { FILE_OPENER_TYPES, fileExtension, isBinaryContent } from './file-openers.js';
import { createServerSettings } from './server-settings.js';
import { createImageViewer } from './image-viewer.js';
import { nativeVideoStream } from './native-video-stream.js';
import { createVideoControls } from './video-controls.js';
import { createBrowserPanel } from './browser-panel.js';
import { sanitizeProxyState } from './browser-proxy-state.js';
import { createBrowserRenderTransport, createRecoveringBrowserTransport } from './browser-transport.js';
import { createTaskManager, createDockerPanel } from './system-panels.js';
import { icon, buttonIcon, createMenu, menuAction, menuHeading, closeMenus, notify, startControlEnhancement, attachFileDropzone } from './ui.js';

preventPageZoom();

// Chromium exposes this legacy method on SVG documents but throws when xterm probes it.
try { document.queryCommandSupported?.('copy'); }
catch { Object.defineProperty(document, 'queryCommandSupported', { configurable: true, value: () => false }); }

const $ = id => document.getElementById(id);
const pageBody = document.body || document.querySelector('body');
let legacyPathCombo, legacySearchCombo, legacySearchRoot = null;
let legacyOpenWith;
const workspaceMenu = createMenu('Workspace menu');
$('app-menu-slot').append(workspaceMenu.element);
menuHeading(workspaceMenu.panel, 'General');
menuAction(workspaceMenu.panel, $('settings'), 'Settings');
const serverSettingsButton = document.createElement('button'); serverSettingsButton.textContent = 'Server configuration';
menuAction(workspaceMenu.panel, serverSettingsButton, 'SlidersHorizontal');
const updatesButton = document.createElement('button'); updatesButton.textContent = 'Client updates';
menuAction(workspaceMenu.panel, updatesButton, 'Download');
updatesButton.onclick = () => openDialog($('updates-dialog'));
$('close-updates').onclick = () => closeDialog($('updates-dialog'));
buttonIcon($('close-updates'), 'X', 'Close', true);
menuHeading(workspaceMenu.panel, 'Connection');
menuAction(workspaceMenu.panel, $('disconnect'), 'Unplug');
buttonIcon($('connect'), 'Plug', 'Connect');
const fileMenu = createMenu('File browser menu');
$('file-menu-slot').append(fileMenu.element);
menuAction(fileMenu.panel, $('file-new-folder'), 'FolderPlus');
buttonIcon($('file-refresh'), 'RefreshCw', 'Refresh', true);
menuHeading(fileMenu.panel, 'Navigate');
menuAction(fileMenu.panel, $('file-up'), 'ArrowUp');
menuAction(fileMenu.panel, $('file-forward'), 'ArrowRight');
menuHeading(fileMenu.panel, 'Panel');
menuAction(fileMenu.panel, $('file-close'), 'X');
buttonIcon($('file-back'), 'ArrowLeft', 'Back', true);
buttonIcon($('file-go'), 'ArrowRight', 'Go', true);
buttonIcon($('file-upload'), 'Upload', 'Upload', true);
const directoryTerminal = document.createElement('button'); directoryTerminal.type = 'button'; buttonIcon(directoryTerminal, 'Terminal', 'Open directory in terminal', true);
directoryTerminal.onclick = () => openDirectoryTerminal(currentPath); $('file-upload').before(directoryTerminal);
$('path-toolbar').prepend(icon('Search'));
for (const [action, name] of Object.entries({ open: 'File', download: 'Download', copy: 'Copy', rename: 'Pencil', delete: 'Trash2' })) {
  const button = $('file-entry-menu').querySelector(`[data-file-action=${action}]`);
  buttonIcon(button, name); button.setAttribute('role', 'menuitem');
}
const encoder = new TextEncoder();
const MAX_COMMAND_LENGTH = 8192;
let config = {};
try { config = JSON.parse($('eya-config').textContent) || {}; } catch { /* Defaults are safe. */ }
const clientUpdates = setupClientUpdates({ config, notify, getConnection: () => ({ url: $('url').value.trim(), key: $('key').value }) });
const startupPanel = ['terminal', 'files', 'web-browser', 'proxy-browser', 'task-manager', 'docker', 'start', 'none'].includes(config.startupPanel) ? config.startupPanel : 'terminal';
let preferences = normalizeSettings(config);
if (typeof config.reduceMotion !== 'boolean') preferences.reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
// Registry additions appear in both configuration surfaces without extra markup.
for (const group of SETTINGS_GROUPS) {
  let section = [...document.querySelectorAll('[data-settings]')].find(node => node.querySelector('h3')?.textContent === group.title);
  if (!section) { section = document.createElement('section'); section.className = 'settings-section'; section.dataset.settings = ''; const heading = document.createElement('h3'); heading.textContent = group.title; section.append(heading); $('settings-error').before(section); }
  for (const field of SETTINGS_FIELDS.filter(item => item.group === group.id)) if (!$(field.id)) section.append(createSettingControl(field));
}
writeSettingsControls($('settings-dialog'), preferences);

setKeybinds(config.keybinds);
let cadPreferences = { ...preferences.cad };

const CAD_SHARED_KEYS = ['unit', 'stlUnit', 'live', 'interval', 'snap', 'viewSectionPosition', 'viewSectionDistance', 'viewSectionFlip', 'sectionAxes', 'sectionRanges', 'mode', 'opacity', 'showEdges', 'showPoints', 'gizmoSize', 'speedModifier', 'sidebar', 'gridPlanes', 'infiniteGrid', 'gridLines', 'gridFill', 'decimalPlaces', 'axisCoordinates', 'sectionGizmos', 'rotationGizmo', 'orbitStyle', 'orbitPivot', 'movementSpeed', 'lookSpeed', 'invertLook', 'hoverHighlights', 'measurementColor', 'measurementPointSize', 'selectionColor', 'selectionMode'];
const themes = {
  dark: { background: '#10151b', foreground: '#e4edf2' },
  light: { background: '#f4f5f1', foreground: '#1c2830', cursor: '#1c2830' },
  midnight: { background: '#0c1022', foreground: '#d5ddff', cursor: '#aaa4ff' },
  solarized: { background: '#002b36', foreground: '#93a1a1', cursor: '#b58900' },
};
const validNumber = (value, min, max, fallback) => Number.isInteger(value) && value >= min && value <= max ? value : fallback;
const validBoolean = (value, fallback) => typeof value === 'boolean' ? value : fallback;
const validChoice = (value, choices, fallback) => choices.includes(value) ? value : fallback;
const validColor = (value, fallback) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : fallback;
const validDecimal = (value, min, max, fallback) => Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max ? Number(value) : fallback;
const fontSize = validNumber(preferences.fontSize, 8, 36, validNumber(config.fontSize, 8, 36, 15));
const scrollback = validNumber(preferences.scrollback, 0, 50000, validNumber(config.scrollback, 0, 50000, 5000));
const theme = themes[preferences.theme] ? preferences.theme : (themes[config.theme] ? config.theme : 'dark');
const cursorBlink = validBoolean(preferences.cursorBlink, validBoolean(config.cursorBlink, true));
const cursorStyle = ['block', 'underline', 'bar'].includes(preferences.cursorStyle) ? preferences.cursorStyle : (['block', 'underline', 'bar'].includes(config.cursorStyle) ? config.cursorStyle : 'block');
const scrollOnUserInput = validBoolean(preferences.scrollOnUserInput, validBoolean(config.scrollOnUserInput, true));
const refreshInterval = [0, 2, 5, 10, 30].includes(preferences.refreshInterval) ? preferences.refreshInterval : 5;
const showHidden = validBoolean(preferences.showHidden, false);
const editorWrap = validBoolean(preferences.editorWrap, true);
const editorLineNumbers = validBoolean(preferences.editorLineNumbers, true);
const confirmDelete = validBoolean(preferences.confirmDelete, true);
const startingDirectory = typeof preferences.startingDirectory === 'string' ? preferences.startingDirectory : (typeof config.startingDirectory === 'string' ? config.startingDirectory : '');
let socket, outbound, inbound, awaitingHandshake = false, pingTimer, failed = false, connectionId = 0;
let resumableSession = null, transportReady = false, reconnectTimer, handshakeTimer, inputFlushTimer, reconnectAttempts = 0, reconnectEnabled = false;
let wireCapabilities = [];
setInterval(() => { if ($('key').value) clientUpdates.connected(); }, 60000);
let ctrlArmed = false;
let altArmed = false, shiftArmed = false;
let auxiliaryBar;
const modifierLocks = new Set();
let fileRequestId = 0, fileRefreshTimer, fileSearchTimer;
let fileNavigationPending = 0, fileNavigationGeneration = 0;
let currentPath = '', directoryEntries = [], selectedEntry, historyPaths = [], historyIndex = -1;
let fileMenuEntry;
let activeFileTab = 'browser';
const filePending = new PendingRequests();
const lifecycle = createConnectionLifecycle();
let workspacePreferences = { ...preferences };
let workspaceGeneration = 0;
const pendingSessionEnds = new Set();
function endRemote(session) {
  pendingSessionEnds.add(session);
  if (transportReady) fileRequest('session.end', { session }).then(() => pendingSessionEnds.delete(session)).catch(cause => notify(cause.message));
}
const fileTabs = new Map();
const fileOpenings = new Map();
const fileClipboard = createFileClipboard({ read: readFile, upload: uploadBytes, request: fileRequest, identity: () => resumableSession });
const decoder = new TextDecoder();
const fatalDecoder = new TextDecoder('utf-8', { fatal: true });
const TEXT_EDITOR_LIMIT = 5 * 1024 * 1024;
const browserPanelElement = $('file-panel');
const workbench = new PanelWorkbench($('workspace'));
const mobileNavigator = createMobileWorkspaceNavigator({ workbench, onPositionChange: position => {
  preferences.mobilePanelButtonPosition = { ...position }; workspacePreferences.mobilePanelButtonPosition = { ...position };
  $('mobile-panel-button-position').value = JSON.stringify(position); workspaces.changed();
} });
workbench.register({
  id: 'browser', title: 'Files', kind: 'browser', legacyTab: 'browser', element: browserPanelElement, retain: true,
  serialize: () => ({ id: 'browser', kind: 'files', title: 'Files', config: { cwd: currentPath } }),
  onActivate: () => {
    activeFileTab = 'browser'; browserSelection.update();
    if (outbound && !currentPath) navigateTo($('starting-directory').value.trim(), true);
  },
  onClose: () => {
    pageBody.classList.remove('panel-visible');
    legacyPathCombo?.close(); legacySearchCombo?.close();
  },
  onDeactivate: () => { legacyPathCombo?.close(); legacySearchCombo?.close(); },
  api: { openSettings: () => openSettingsGroup('files'), navigate: path => navigateTo(path), refresh: () => refreshFiles(false), getPath: () => currentPath,
    focusPath: () => $('file-path').focus(), focusSearch: () => $('file-search').focus() },
});

let directorySort = {};
const browserSelection = createFileSelection({ body: $('file-list'), getEntries: () => sortFiles(directoryEntries, directorySort), getPath: () => currentPath,
  clipboard: fileClipboard, request: fileRequest, refresh: () => navigateTo(currentPath, false), preferences: browserPreferences,
  report: message => { $('file-status').textContent = message; }, onDelete: closeDeletedFiles, beforeDelete: prepareFileDeletion,
  identity: () => `${connectionId}:${workspaceGeneration}`, valid: () => transportReady });
$('path-toolbar').after(browserSelection.element);

function inheritedWebSocketUrl() {
  if (!['http:', 'https:'].includes(location.protocol)) return '';
  const url = new URL('ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
const inheritedUrl = inheritedWebSocketUrl();
$('url').value = config.url || inheritedUrl;
$('key').value = config.key || '';
buttonIcon($('client-update-indicator'), 'Download', 'Download client update', true);
if ($('key').value) queueMicrotask(() => clientUpdates.connected());
$('default-command').value = typeof config.defaultCommand === 'string' ? config.defaultCommand : '';
$('font-size').value = fontSize;
$('scrollback').value = scrollback;
$('theme').value = theme;
$('ui-density').value = ['comfortable', 'compact'].includes(preferences.uiDensity) ? preferences.uiDensity : 'comfortable';
$('ui-style').value = ['default', 'rounded', 'square'].includes(preferences.uiStyle) ? preferences.uiStyle : 'default';
$('accent-color').value = ['mint', 'blue', 'violet', 'amber'].includes(preferences.accentColor) ? preferences.accentColor : 'mint';
$('panel-focus-mode').value = validChoice(preferences.panelFocusMode, ['click', 'hover'], 'click');
$('panel-focus-border').checked = validBoolean(preferences.panelFocusBorder, false);
$('reduce-motion').checked = validBoolean(preferences.reduceMotion, matchMedia('(prefers-reduced-motion: reduce)').matches);
$('editor-font-size').value = validNumber(preferences.editorFontSize, 12, 28, 16);
$('editor-tab-size').value = [2, 4, 8].includes(preferences.editorTabSize) ? preferences.editorTabSize : 4;
$('file-details').checked = validBoolean(preferences.fileDetails, true);
$('cad-display-mode').value = validChoice(cadPreferences.mode, ['flat', 'zebra', 'shaded', 'edges', 'wireframe'], 'shaded');
$('cad-grid-planes').value = validChoice(cadPreferences.gridPlanes, ['off', 'xy', 'all'], cadPreferences.grid === false ? 'off' : 'all');
$('cad-axis-coordinates').checked = validBoolean(cadPreferences.axisCoordinates, true);
$('cad-section-gizmos').checked = validBoolean(cadPreferences.sectionGizmos, true);
$('cad-rotation-gizmo').checked = validBoolean(cadPreferences.rotationGizmo, true);
$('cad-orbit-style').value = validChoice(cadPreferences.orbitStyle, ['turntable', 'free'], 'turntable');
$('cad-movement-speed').value = validDecimal(cadPreferences.movementSpeed, 0.25, 4, 1);
$('cad-look-speed').value = validDecimal(cadPreferences.lookSpeed, 0.25, 3, 1);
$('cad-invert-look').checked = validBoolean(cadPreferences.invertLook, false);
$('cad-hover-highlights').checked = validBoolean(cadPreferences.hoverHighlights, true);
$('cad-measurement-color').value = validColor(cadPreferences.measurementColor, '#ff4f9a');
$('cad-measurement-point-size').value = validDecimal(cadPreferences.measurementPointSize, 0.5, 3, 1.5);
$('cad-selection-color').value = validColor(cadPreferences.selectionColor, '#66ff99');
$('cursor-blink').checked = cursorBlink;
$('cursor-style').value = cursorStyle;
$('scroll-on-input').checked = scrollOnUserInput;
$('refresh-interval').value = refreshInterval;
$('file-autoreload').checked = validBoolean(preferences.fileAutoreload, true);
$('transfer-unit').value = validChoice(preferences.transferUnit, ['auto', 'bytes', 'kb', 'mb'], 'bytes');
setFileProgressUnit($('transfer-unit').value);
$('show-hidden').checked = showHidden;
$('editor-wrap').checked = editorWrap;
$('editor-line-numbers').checked = editorLineNumbers;
$('confirm-delete').checked = confirmDelete;
$('starting-directory').value = startingDirectory;
applyAppearance();
pageBody.classList.add('connection-offline');

function syncCadSettingsForm(value) {
  if (typeof value.infiniteGrid === 'boolean') $('cad-infinite-grid').checked = value.infiniteGrid;
  if (Number.isInteger(value.decimalPlaces)) $('cad-decimal-places').value = value.decimalPlaces;
  for (const key of ['gridLines','gridFill']) if (typeof value[key] === 'boolean') $(key === 'gridLines' ? 'cad-grid-lines' : 'cad-grid-fill').checked = value[key];
  if (value.sidebar?.side) $('cad-sidebar-side').value = value.sidebar.side;
  if (Number.isFinite(value.viewSectionDistance)) $('cad-view-section-distance').value = value.viewSectionDistance;
  if (['flat', 'zebra', 'shaded', 'edges', 'wireframe'].includes(value.mode)) $('cad-display-mode').value = value.mode;
  if (['off', 'xy', 'all'].includes(value.gridPlanes)) $('cad-grid-planes').value = value.gridPlanes;
  if (['target', 'origin', 'model'].includes(value.orbitPivot)) $('cad-orbit-pivot').value = value.orbitPivot;
  if (['turntable', 'free'].includes(value.orbitStyle)) $('cad-orbit-style').value = value.orbitStyle;
  for (const [key, id] of [['axisCoordinates', 'cad-axis-coordinates'], ['sectionGizmos', 'cad-section-gizmos'], ['rotationGizmo', 'cad-rotation-gizmo'], ['invertLook', 'cad-invert-look'], ['hoverHighlights', 'cad-hover-highlights'], ['showEdges','cad-show-edges'], ['showPoints','cad-show-points']]) if (typeof value[key] === 'boolean') $(id).checked = value[key];
  for (const [key, id] of [['movementSpeed', 'cad-movement-speed'], ['lookSpeed', 'cad-look-speed'], ['measurementPointSize', 'cad-measurement-point-size'], ['opacity','cad-opacity'], ['gizmoSize','cad-gizmo-size'], ['speedModifier','cad-speed-modifier']]) if (Number.isFinite(Number(value[key]))) $(id).value = value[key];
  for (const [key, id] of [['measurementColor', 'cad-measurement-color'], ['selectionColor', 'cad-selection-color']]) if (/^#[\da-f]{6}$/i.test(value[key] || '')) $(id).value = value[key];
}

function status(text) {
  $('status').textContent = text;
}
function error(text) { $('error').textContent = text; $('error').hidden = !text; if ($('connect-dialog').open && text) { $('dialog-error').textContent = text; $('dialog-error').hidden = false; connectionFeedback('', false); } }
function setDialogError(text) {
  const target = $('settings-dialog').open ? $('settings-error') : $('dialog-error');
  target.textContent = text;
  target.hidden = !text;
}
function openDialog(dialog) { closeMenus(); hideFileEntryMenu(); hideTerminalMenu(); if (!dialog.open) dialog.showModal(); }
function closeDialog(dialog) { if (dialog.open) dialog.close(); }
function send(bytes) {
  if (socket?.readyState !== WebSocket.OPEN || !outbound) return false;
  if (outbound.nonce >= 0xffffffff || socket.bufferedAmount > 1024 * 1024) {
    failed = true;
    error('The connection is overloaded or has reached its message limit. Reconnect to continue.');
    socket.close();
    return false;
  }
  try { socket.send(outbound.encrypt(bytes)); return true; } catch {
    failed = true;
    error('Could not send encrypted request.');
    socket.close();
    return false;
  }
}
function setModifier(name, value) {
  if (name === 'ctrl') ctrlArmed = value;
  if (name === 'alt') altArmed = value;
  if (name === 'shift') shiftArmed = value;
  auxiliaryBar?.sync({ ctrlKey: ctrlArmed, altKey: altArmed, shiftKey: shiftArmed }, modifierLocks);
  workbench.activePanel?.api?.setAuxModifiers?.({ ctrlKey: ctrlArmed, altKey: altArmed, shiftKey: shiftArmed });
}
document.addEventListener('eya-active-panel-change', () => { modifierLocks.clear(); for (const name of ['ctrl','alt','shift']) setModifier(name, false); stopDirection(); });
function takeModifiers() {
  const modifiers = { ctrlKey: ctrlArmed, altKey: altArmed, shiftKey: shiftArmed };
  for (const name of ['ctrl', 'alt', 'shift']) setModifier(name, modifierLocks.has(name));
  return modifiers;
}
function applyModifiers(data) {
  if (!data) return data;
  const { ctrlKey, altKey, shiftKey } = takeModifiers();
  const navigation = /^\x1b\[(?:([ABCDHF])|(\d+)~)$/.exec(data);
  const modifier = 1 + (shiftKey ? 1 : 0) + (altKey ? 2 : 0) + (ctrlKey ? 4 : 0);
  if (/^\x1bO[PQRS]$/.test(data) && modifier > 1) return `\x1b[1;${modifier}${data.at(-1)}`;
  if (navigation && modifier > 1) return navigation[1] ? `\x1b[1;${modifier}${navigation[1]}` : `\x1b[${navigation[2]};${modifier}~`;
  if (data === '\t' && shiftKey) data = '\x1b[Z';
  else if (shiftKey && data.length === 1) data = data.toUpperCase();
  if (ctrlKey && data === '\x7f') data = '\x17';
  else if (ctrlKey && data.length === 1) {
    const code = data.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
    else if (code === 32) data = '\0';
  }
  return (altKey ? '\x1b' : '') + data;
}
const auxiliaryKeyNames = { '\x1b': 'Escape', '\t': 'Tab', '\x1b[H': 'Home', '\x1b[F': 'End', '\x1b[5~': 'PageUp', '\x1b[6~': 'PageDown', '\x1b[3~': 'Delete', '\x1b[A': 'ArrowUp', '\x1b[B': 'ArrowDown', '\x1b[C': 'ArrowRight', '\x1b[D': 'ArrowLeft' };
for (const [i, code] of ['\x1bOP','\x1bOQ','\x1bOR','\x1bOS', ...[15,17,18,19,20,21,23,24].map(n => `\x1b[${n}~`)].entries()) auxiliaryKeyNames[code] = `F${i+1}`;
function sendKey(data, repeatedModifiers) {
  const active = workbench.activePanel;
  if (active?.api?.sendAuxKey) {
    const modifiers = repeatedModifiers || takeModifiers();
    active.api.sendAuxKey(auxiliaryKeyNames[data] || (data.length === 1 ? data : undefined), modifiers, true);
    return () => active.api.sendAuxKey(auxiliaryKeyNames[data] || (data.length === 1 ? data : undefined), modifiers, true);
  }
  if (active?.kind !== 'terminal') return '';
  data = applyModifiers(data);
  active.api.sendInput(data); active.api.focus();
  return () => active.api.sendInput(data);
}
function resize() {
  for (const panel of workbench.panels.values()) if (panel.groupId && !panel.element.hidden) panel.onLayout?.();
}
const { schedule: scheduleResize } = trackWorkspaceViewport(resize);
let scrollTouch;
document.addEventListener('touchstart', event => {
  const touch = event.touches.length === 1 ? event.touches[0] : null;
  scrollTouch = touch ? { id: touch.identifier, x: touch.clientX, y: touch.clientY } : null;
}, { passive: true });
document.addEventListener('touchend', () => { scrollTouch = null; }, { passive: true });
document.addEventListener('touchcancel', () => { scrollTouch = null; }, { passive: true });
document.addEventListener('touchmove', event => {
  if (event.touches?.length > 1) { scrollTouch = null; return; }
  const touch = event.touches?.[0];
  const previous = touch && scrollTouch?.id === touch.identifier ? scrollTouch : null;
  const dx = previous ? touch.clientX - previous.x : 0, dy = previous ? touch.clientY - previous.y : 0;
  if (touch) scrollTouch = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
  const horizontal = Math.abs(dx) > Math.abs(dy), delta = horizontal ? dx : dy;
  let target = event.target instanceof Element ? event.target : event.target?.parentElement;
  const manual = target?.closest('#terminal,.instance-terminal-surface,.cad-stage,.panel-sash,#arrow-pad');
  while (!manual && target && target !== pageBody && target !== document.documentElement) {
    const style = getComputedStyle(target);
    const extent = horizontal ? target.scrollWidth - target.clientWidth : target.scrollHeight - target.clientHeight;
    const overflow = horizontal ? style.overflowX : style.overflowY;
    if (/(auto|scroll)/.test(overflow) && extent > 1) {
      const position = horizontal ? target.scrollLeft : target.scrollTop;
      if (!delta || (delta > 0 && position > 0) || (delta < 0 && position < extent - 1)) return;
      // Stop gestures at a contained panel's boundary before the browser can
      // chain them to the document or interpret them as pull-to-refresh.
      if (['contain', 'none'].includes(horizontal ? style.overscrollBehaviorX : style.overscrollBehaviorY)) break;
    }
    target = target.parentElement;
  }
  if (event.cancelable) event.preventDefault();
}, { passive: false });
auxiliaryBar = createAuxiliaryBar($('keybar'), {
  send: sendKey, paste: pasteFromClipboard, panelId: () => workbench.activePanel?.id,
  activateKeyboard() {
    const panel = workbench.activePanel;
    if (panel?.kind === 'web-browser') activateBrowserKeyboard();
    else if (panel?.api?.focusInput) panel.api.focusInput();
    else panel?.api?.focus?.();
  },
  toggleModifier(name, value, locked) {
    if (locked) modifierLocks.add(name); else modifierLocks.delete(name);
    setModifier(name, value);
    const api = workbench.activePanel?.api;
    if (api?.focusInput) api.focusInput(); else api?.focus?.();
  },
});
const keyboardButton = document.createElement('button');
keyboardButton.type = 'button'; keyboardButton.textContent = 'Activate keyboard';
keyboardButton.className = 'browser-keyboard-activate';
$('keybar').append(keyboardButton);
let browserKeyboardRequested = false, browserKeyboardWasVisible = false;
function updateBrowserKeyboardBar() {
  const browser = workbench.activePanel?.kind === 'web-browser';
  const viewport = window.visualViewport;
  const visible = !!viewport && window.innerHeight - viewport.height > 120;
  if (browserKeyboardWasVisible && !visible && browser) {
    browserKeyboardRequested = false;
    workbench.activePanel?.api?.dismissKeyboard?.();
  }
  browserKeyboardWasVisible = visible;
  const editing = document.activeElement?.matches?.('input:not([inputmode=none]), textarea:not([inputmode=none]), [contenteditable=true]:not([inputmode=none])');
  $('keybar').classList.toggle('browser-keyboard-inactive', browser && !visible && !browserKeyboardRequested && !editing);
}
function activateBrowserKeyboard() {
  // Set this before focusing: focus events synchronously update the bar.
  browserKeyboardRequested = true;
  if (!workbench.activePanel?.api?.activateKeyboard?.()) browserKeyboardRequested = false;
  updateBrowserKeyboardBar();
}
// Keep the current page input from losing focus to the button. Focus the text
// input directly from the touch gesture, while mobile browsers allow a keyboard.
keyboardButton.addEventListener('pointerdown', event => { if (event.isPrimary && event.button === 0) event.preventDefault(); });
// Request focus in the native touch event, before the browser synthesizes a
// click. Cancel that click to avoid focusing twice.
keyboardButton.addEventListener('touchend', event => {
  if (event.changedTouches.length !== 1 || event.touches.length) return;
  event.preventDefault();
  activateBrowserKeyboard();
}, { passive: false });
keyboardButton.addEventListener('click', activateBrowserKeyboard);
document.addEventListener('eya-active-panel-change', () => { browserKeyboardRequested = false; updateBrowserKeyboardBar(); });
document.addEventListener('focusin', updateBrowserKeyboardBar);
document.addEventListener('focusout', () => { queueMicrotask(() => {
  if (!document.activeElement?.matches?.('.eya-browser-text-surface')) browserKeyboardRequested = false;
  updateBrowserKeyboardBar();
}); });
window.visualViewport?.addEventListener('resize', updateBrowserKeyboardBar);
function stopDirection() { auxiliaryBar?.stop(); }

function fallbackCopy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.cssText = 'position:fixed;opacity:0;inset:0';
  pageBody.append(area);
  area.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { /* Clipboard API may be unavailable too. */ }
  area.remove();
  return copied;
}
async function pasteFromClipboard() {
  takeModifiers();
  const active = workbench.activePanel;
  const target = active?.api;
  const focus = () => { if (target?.focusInput) target.focusInput(); else target?.focus?.(); };
  focus();
  hideTerminalMenu();
  try {
    const text = await navigator.clipboard.readText();
    // Clipboard permission may resolve after the user changes panels.
    if (workbench.activePanel?.id !== active?.id) return;
    if (text) target?.paste?.(text);
    focus();
  } catch {
    if (workbench.activePanel?.id !== active?.id) return;
    focus();
    notify('Use the native Paste menu or keyboard paste in the focused input.');
  }
}
function showTerminalMenu(x, y) {
  const menu = $('terminal-menu');
  menu.hidden = false;
  const width = menu.offsetWidth, height = menu.offsetHeight;
  const viewport = window.visualViewport || { offsetLeft: 0, offsetTop: 0, width: innerWidth, height: innerHeight };
  menu.style.left = `${Math.max(viewport.offsetLeft + 6, Math.min(x, viewport.offsetLeft + viewport.width - width - 6))}px`;
  menu.style.top = `${Math.max(viewport.offsetTop + 6, Math.min(y, viewport.offsetTop + viewport.height - height - 6))}px`;
}
function hideTerminalMenu() { $('terminal-menu').hidden = true; }
$('view-terminal-text').onclick = () => { hideTerminalMenu(); workbench.activePanel?.api?.viewText?.(); };
$('paste-selection').onclick = pasteFromClipboard;
$('terminal-menu').addEventListener('pointerdown', event => event.stopPropagation());
document.addEventListener('pointerdown', event => { if (!$('terminal-menu').contains(event.target)) hideTerminalMenu(); });
document.addEventListener('contextmenu', event => {
  if (!event.target.closest?.('.instance-terminal-surface')) return;
  event.preventDefault();
  if (workbench.activePanel?.api?.getState?.().mouseTracking === 'none') showTerminalMenu(event.clientX, event.clientY);
});
scheduleResize();

function terminalOptions() {
  return { fontFamily: embeddedFontLoaded ? 'EyaEmbeddedFont, monospace' : 'monospace', fontSize: Number($('font-size').value), scrollback: Number($('scrollback').value),
    theme: themes[$('theme').value] || themes.dark, cursorBlink: $('cursor-blink').checked,
    cursorStyle: $('cursor-style').value, scrollOnUserInput: $('scroll-on-input').checked };
}
function openWebLink(value) {
  let url; try { url = new URL(value); } catch { return; }
  if (!['http:', 'https:'].includes(url.protocol)) return;
  if ($('terminal-link-target').value === 'external') window.open(url.href, '_blank', 'noopener,noreferrer');
  else workbench.create('web-browser', { initialUrl: url.href }).catch(cause => notify(cause.message));
}
for (const [id, delta] of [['terminal-zoom-in', 1], ['terminal-zoom-out', -1]]) $(id).onclick = () => { hideTerminalMenu(); workbench.activePanel?.api?.zoomFont?.(delta); };
const serverSettings = createServerSettings({ request: fileRequest, capabilities: () => wireCapabilities });
const serverSettingsDialog = document.createElement('dialog'); serverSettingsDialog.id = 'server-settings-dialog';
const serverSettingsTitle = document.createElement('h2'); serverSettingsTitle.textContent = 'Server configuration';
const closeServerSettings = document.createElement('button'); closeServerSettings.type = 'button'; closeServerSettings.textContent = 'Close'; closeServerSettings.onclick = () => closeDialog(serverSettingsDialog);
serverSettingsDialog.append(serverSettingsTitle, serverSettings.element, closeServerSettings); pageBody.append(serverSettingsDialog);
serverSettingsButton.onclick = () => { openDialog(serverSettingsDialog); serverSettings.refresh(); };
function applyAppearance() {
  const root = document.documentElement;
  workbench.focusMode = $('panel-focus-mode').value;
  root.classList.toggle('panel-focus-border', $('panel-focus-border').checked);
  root.dataset.theme = $('theme').value;
  root.dataset.density = $('ui-density').value;
  root.dataset.uiStyle = $('ui-style').value;
  root.dataset.accent = $('accent-color').value;
  root.classList.toggle('reduce-motion', $('reduce-motion').checked);
  root.style.setProperty('--editor-font-size', `${Math.max(12, Math.min(28, Number($('editor-font-size').value) || 16))}px`);
  root.classList.toggle('hide-file-details', !$('file-details').checked);
  let position; try { position = JSON.parse($('mobile-panel-button-position').value); } catch { position = {x:0.95,y:0.65}; }
  mobileNavigator.update({ enabled:$('mobile-floating-panel-switcher').checked, position });
}
function applySettings(event) {
  const size = Number($('font-size').value);
  const lines = Number($('scrollback').value);
  if (!Number.isInteger(size) || size < 8 || size > 36 || !Number.isInteger(lines) || lines < 0 || lines > 50000) {
    setDialogError('Font size must be 8–36 and scrollback must be 0–50000.');
    return false;
  }
  setDialogError('');
  const interval = Number($('refresh-interval').value);
  const measurementPointSize = validDecimal($('cad-measurement-point-size').value, 0.5, 3, 1.5);
  $('cad-measurement-point-size').value = measurementPointSize;
  const cadMovementSpeed = validDecimal($('cad-movement-speed').value, 0.25, 4, 1);
  const cadLookSpeed = validDecimal($('cad-look-speed').value, 0.25, 3, 1);
  $('cad-movement-speed').value = cadMovementSpeed; $('cad-look-speed').value = cadLookSpeed;
  applyAppearance();
  setFileProgressUnit($('transfer-unit').value);
  for (const panel of workbench.panels.values()) if (panel.kind === 'terminal') panel.api?.updateOptions?.(terminalOptions());
  workspacePreferences = {
      fontSize: size, scrollback: lines, theme: $('theme').value,
      cursorBlink: $('cursor-blink').checked, cursorStyle: $('cursor-style').value,
      scrollOnUserInput: $('scroll-on-input').checked,
      transferUnit: $('transfer-unit').value, refreshInterval: interval, fileAutoreload: $('file-autoreload').checked, showHidden: $('show-hidden').checked,
      editorWrap: $('editor-wrap').checked, editorLineNumbers: $('editor-line-numbers').checked,
      confirmDelete: $('confirm-delete').checked, startingDirectory: $('starting-directory').value.trim(),
      uiDensity: $('ui-density').value, uiStyle: $('ui-style').value, accentColor: $('accent-color').value,
      panelFocusMode: $('panel-focus-mode').value, panelFocusBorder: $('panel-focus-border').checked,
      reduceMotion: $('reduce-motion').checked, editorFontSize: Number($('editor-font-size').value),
      editorTabSize: Number($('editor-tab-size').value), fileDetails: $('file-details').checked,
    };
  workspacePreferences = readSettingsControls($('settings-dialog'), { base: workspacePreferences });
  const changedGroups = new Set(SETTINGS_FIELDS.filter(field => JSON.stringify(getSetting(preferences, field)) !== JSON.stringify(getSetting(workspacePreferences, field))).map(field => field.group));
  preferences = workspacePreferences;
  workspaces.changed();
  cadPreferences = {
    ...workspacePreferences.cad,
    mode: validChoice($('cad-display-mode').value, ['flat', 'zebra', 'shaded', 'edges', 'wireframe'], 'shaded'),
    gridPlanes: validChoice($('cad-grid-planes').value, ['off', 'xy', 'all'], 'all'),
    axisCoordinates: $('cad-axis-coordinates').checked,
    sectionGizmos: $('cad-section-gizmos').checked,
    rotationGizmo: $('cad-rotation-gizmo').checked,
    orbitStyle: validChoice($('cad-orbit-style').value, ['turntable', 'free'], 'turntable'),
    movementSpeed: cadMovementSpeed, lookSpeed: cadLookSpeed, invertLook: $('cad-invert-look').checked,
    hoverHighlights: $('cad-hover-highlights').checked,
    measurementColor: validColor($('cad-measurement-color').value, '#ff4f9a'),
    measurementPointSize,
    selectionColor: validColor($('cad-selection-color').value, '#66ff99'),
  };

  workspacePreferences.cad = { ...cadPreferences };
  for (const panel of workbench.panels.values()) {
    if (['web-browser', 'proxy-browser'].includes(panel.kind) && changedGroups.has('browser')) panel.api?.updateSettings?.(preferences.browser);
    if (panel.kind === 'system' && changedGroups.has('taskManager')) panel.api?.updateSettings?.(preferences.taskManager);
    if (panel.kind === 'docker' && changedGroups.has('docker')) panel.api?.updateSettings?.(preferences.docker);
  }
  for (const tab of fileTabs.values()) {
    if (changedGroups.has('binary') && tab.binaryViewer) tab.binaryViewer.applyPreferences(preferences.binary);
    if (changedGroups.has('image') && tab.imageControls) { tab.imageBackground = { ...preferences.image }; tab.imageControls.updateSettings(preferences.image); }
    if (changedGroups.has('video')) { tab.player?.updateSettings?.(preferences.video); tab.videoStream?.updateSettings?.(preferences.video); }
    if (changedGroups.has('audio') && tab.audio) { tab.audio.playbackRate = preferences.audio.speed; tab.audio.loop = preferences.audio.loop; }
  }
  if (changedGroups.has('cad')) window.dispatchEvent(new CustomEvent('eya-cad-settings', { detail: { ...cadPreferences, sidebar: { side:cadPreferences.sidebar?.side || 'right' } } }));
  restartFileRefresh();
  if (['editor-wrap', 'editor-line-numbers', 'editor-tab-size', 'theme'].includes(event?.target?.id)) updateEditorConfiguration();
  resize();
  return true;
}
function validateConnection() {
  const command = $('default-command').value;
  if (!$('key').value.length) {
    setDialogError('Enter the shared password.');
    return null;
  }
  if (command.length > MAX_COMMAND_LENGTH || command.includes('\0')) {
    setDialogError(`Default command must be at most ${MAX_COMMAND_LENGTH} characters and cannot contain a NUL byte.`);
    return null;
  }
  try {
    const url = normalizeConnectionUrl($('url').value.trim());
    return { url, command };
  } catch (cause) {
    setDialogError(cause.message || 'Enter a valid server address.');
    return null;
  }
}
function openConnection() { setDialogError(''); openDialog($('connect-dialog')); queueCredentialCheck(); }
function setConnectionAppearance(connected) {
  pageBody.classList.toggle('connection-offline', !connected); $('status').dataset.connected = String(connected);
  $('disconnect').disabled = !connected && !awaitingHandshake && !reconnectEnabled;

  buttonIcon($('connect'), 'Plug', connected ? 'Session' : 'Connect');
  $('connect').classList.toggle('primary', !connected);
  $('connect').title = connected ? 'Connection details' : 'Connect to server';

}
function announceDisconnect(message) {
  status(`Disconnected — ${message}`);
  setConnectionAppearance(false);
}
function disconnect() {
  const hadConnection = !!outbound || awaitingHandshake;
  reconnectEnabled = false;
  clearTimeout(reconnectTimer); clearTimeout(handshakeTimer); clearTimeout(inputFlushTimer);
  connectionId++;
  failed = false;
  clearInterval(pingTimer);
  socket?.close();
  socket = outbound = inbound = null;
  awaitingHandshake = false;
  transportReady = false;
  lifecycle.update({ ready: false, generation: connectionId, reason: 'Disconnected', mode: 'paused' });
  workspaces.disconnected();
  for (const panel of workbench.panels.values()) panel.api?.detach?.();
  rejectFileRequests('Disconnected. Mutations may have completed; refresh before retrying.');
  clearInterval(fileRefreshTimer);
  $('file-status').textContent = 'Connect to browse files.';
  $('latency').textContent = '';
  status('Disconnected');
  if (hadConnection) announceDisconnect('Session retained on the server. Connect to resume.');
  else setConnectionAppearance(false);
}
setConnectionAppearance(false);

let embeddedFontLoaded = false;
if (config.font) {
  const face = new FontFace('EyaEmbeddedFont', `url(${JSON.stringify(config.font)})`);
  face.load().then(loaded => {
    document.fonts.add(loaded);
    embeddedFontLoaded = true;
    for (const panel of workbench.panels.values()) if (panel.kind === 'terminal') panel.api?.updateOptions?.(terminalOptions());
    resize();
  }).catch(() => error('The embedded font could not be loaded. Using the browser’s monospace font.'));
}

$('connect').onclick = openConnection;
function openSettingsGroup(group) { settingsPages.open(group); openDialog($('settings-dialog')); }
const settingsPages = settingsNavigation($('settings-dialog'), { groups: SETTINGS_GROUPS, getPanels: () => workbench.panels.values(), activatePanel: panel => workbench.activate?.(panel.id) });
$('settings').onclick = () => { settingsPages.open(); openDialog($('settings-dialog')); setDialogError(''); };
const keybindSettings = createKeybindSettings({ onChange: value => {
  workspacePreferences.keybinds = value; workspaces.changed();
  for (const tab of fileTabs.values()) tab.videoStream?.updateSettings?.(preferences.video);
  document.dispatchEvent(new CustomEvent('eya-keybinds-change'));
} });
const keybindButton = document.createElement('button'); keybindButton.textContent = 'Keyboard shortcuts';
menuAction(workspaceMenu.panel, keybindButton, 'Command'); workspaceMenu.panel.insertBefore(keybindButton, workspaceMenu.panel.querySelectorAll('.ui-menu-heading')[1]); keybindButton.onclick = () => keybindSettings.open();
function runGlobalShortcut(id) {
  const actions = {
    'global.settings': () => $('settings').click(), 'global.keybinds': () => keybindSettings.open(),
    'global.workspaces': () => workspaces.manage(), 'global.launcher': () => workbench.openStart(),
    'global.terminal': () => workbench.create('terminal').catch(cause => notify(cause.message)),
    'global.files': () => setPanelVisible(true),
    'global.closePanel': () => { if (workbench.activePanel) workbench.close(workbench.activePanel.id); },
    'global.minimizePanel': () => { if (workbench.activePanel) workbench.minimize(workbench.activePanel.id); },
  };
  if (!actions[id]) return false; actions[id](); return true;
}
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || $('keybinds-dialog')?.open) return;
  if (matchesKeybind('global.settings', event)) { event.preventDefault(); event.stopPropagation(); runGlobalShortcut('global.settings'); return; }
  if (document.querySelector('dialog[open]')) return;
  for (const id of ['global.keybinds','global.workspaces','global.launcher','global.terminal','global.files','global.closePanel','global.minimizePanel']) {
    if (matchesKeybind(id, event)) { event.preventDefault(); event.stopPropagation(); runGlobalShortcut(id); return; }
  }
  if (workbench.activePanel?.kind === 'browser') {
    for (const [id, method] of [['files.search','focusSearch'],['files.path','focusPath']]) if (matchesKeybind(id,event)) { event.preventDefault(); event.stopPropagation(); workbench.activePanel.api[method](); return; }
  }
}, { capture: true });
$('disconnect').onclick = disconnect;
let credentialTimer, credentialAbort, credentialGeneration = 0;
const dataConnection = location.protocol === 'data:';
function connectionError(message, unreachable = false) {
  if (unreachable && dataConnection) {
    $('connection-open-server-client').hidden = false;
    return `${message} This browser may block server connections from data URLs.`;
  }
  return message;
}
function connectionFeedback(text, busy = false) {
  $('connection-check-status').textContent = text;
  $('connection-spinner').hidden = !busy;
  $('start-connection').disabled = busy && text === 'Connecting…';
}
function cancelCredentialCheck() {
  clearTimeout(credentialTimer); credentialAbort?.abort(); credentialAbort = null; credentialGeneration++;
  connectionFeedback('');
}
function queueCredentialCheck() {
  cancelCredentialCheck();
  $('connection-open-server-client').hidden = true;
  if (!transportReady && reconnectEnabled && resumableSession && (resumableSession.key !== $('key').value || resumableSession.url !== normalizeEnteredUrl())) {
    const initial = !resumableSession.client && !workspaces.getState().workspace;
    disconnect(); if (initial) resumableSession = null;
  }
  if (!$('connect-dialog').open || !$('url').value.trim() || !$('key').value) return;
  if (transportReady && resumableSession?.key === $('key').value && resumableSession?.url === normalizeEnteredUrl()) return;
  const generation = credentialGeneration;
  connectionFeedback('Checking…', true); $('dialog-error').hidden = true;
  credentialTimer = setTimeout(async () => {
    const connection = validateConnection();
    if (!connection) { connectionFeedback(''); return; }
    const key = $('key').value;
    credentialAbort = new AbortController();
    try {
      await checkCredentials({ url: connection.url.href, key, signal: credentialAbort.signal });
      if (generation !== credentialGeneration || !$('connect-dialog').open) return;
      connectionFeedback('Password verified');
      // Switching a live server still needs an explicit user action and its existing confirmation.
      if (resumableSession && (resumableSession.url !== connection.url.href || resumableSession.key !== key)) return;
      $('start-connection').click();
    } catch (cause) {
      if (generation !== credentialGeneration || cause.name === 'AbortError') return;
      connectionFeedback(''); setDialogError(connectionError(cause.message, cause.code === 'unreachable'));
    }
  }, 650);
}
function normalizeEnteredUrl() { try { return normalizeConnectionUrl($('url').value.trim()).href; } catch { return ''; } }
for (const id of ['url', 'key']) $(id).addEventListener('input', queueCredentialCheck);
$('toggle-password').onclick = () => {
  const shown = $('key').type === 'password'; $('key').type = shown ? 'text' : 'password';
  $('toggle-password').textContent = shown ? 'Hide' : 'Show';
  $('toggle-password').ariaLabel = shown ? 'Hide password' : 'Show password';
  $('toggle-password').setAttribute('aria-pressed', String(shown));
};
$('connect-dialog').addEventListener('close', cancelCredentialCheck);
$('connect-dialog').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing && event.target !== $('connection-open-server-client')) { event.preventDefault(); cancelCredentialCheck(); $('start-connection').click(); } });
$('connection-open-server-client').onclick = () => {
  try { window.open(hostedClientUrl($('url').value.trim()), '_blank', 'noopener'); }
  catch (cause) { setDialogError(cause.message); }
};
$('close-connect').onclick = () => closeDialog($('connect-dialog'));
buttonIcon($('close-connect'), 'X', 'Close', true);
$('close-settings').onclick = () => { closeDialog($('settings-dialog')); workbench.activePanel?.api?.focus?.(); };
for (const { id } of SETTINGS_FIELDS) {
  $(id).addEventListener('input', applySettings);
  $(id).addEventListener('change', applySettings);
}


function setPanelVisible(visible) {
  if (visible) workbench.create('files').catch(cause => notify(cause.message));
  else if (workbench.isOpen('browser')) workbench.close('browser');
}

function restartFileRefresh() {
  clearInterval(fileRefreshTimer);
  const seconds = Number($('refresh-interval').value);
  let busy = false;
  fileRefreshTimer = setInterval(async () => {
    if (busy || document.hidden || !transportReady) return;
    busy = true;
    try {
      if (seconds > 0 && workbench.isOpen('browser') && !fileMenuEntry && !fileNavigationPending) await refreshFiles(false);
      for (const tab of fileTabs.values()) {
        if (tab.loading || tab.loadError || tab.saving || tab.renaming || tab.cad || !tab.node?.getClientRects().length) continue;
        const meta = await fileRequest('stat', { path: tab.path });
        if (fileTabs.get(tab.path) !== tab) continue;
        setFileChanged(tab, meta.version !== tab.version);
        if (tab.diskChanged && !tab.dirty && !tab.streaming && $('file-autoreload').checked) await openFile(tab.path, true);
      }
    } catch (cause) { fileFailure(cause); }
    finally { busy = false; }
  }, (seconds || 5) * 1000);
}

function nextFileRequestId() {
  do { fileRequestId = (fileRequestId + 1) >>> 0 || 1; } while (filePending.has(fileRequestId));
  return fileRequestId;
}

function sendFileControl(id, op, values = {}) {
  if (!transportReady) throw Error('Reconnecting: file operations are paused. Retry after the session resumes.');
  const jsonBytes = encoder.encode(JSON.stringify({ ...values, id, op }));
  if (jsonBytes.length > 60000) throw Error('The request is too large. Shorten the path or search text.');
  const message = new Uint8Array(jsonBytes.length + 1);
  message[0] = 4;
  message.set(jsonBytes, 1);
  if (!send(message)) throw Error('Not connected.');
}

function fileRequest(op, values = {}, onProgress) {
  if (filePending.size >= 64) return Promise.reject(Error('Too many pending operations. Wait for earlier requests to finish.'));
  const id = nextFileRequestId();
  return new Promise((resolve, reject) => {
    filePending.set(id, { resolve, reject, onProgress, onJson(response) { filePending.delete(id); resolve(response); } });
    try { sendFileControl(id, op, values); } catch (cause) { filePending.delete(id); reject(cause); }
  });
}

function readFile(path, onProgress) {
  if (filePending.size >= 64) return Promise.reject(Error('Too many pending operations. Wait for earlier requests to finish.'));
  const id = nextFileRequestId();
  return new Promise((resolve, reject) => {
    filePending.set(id, { resolve, reject, chunks: [], meta: null, received: 0, onProgress, onJson(response) { this.meta = response; onProgress?.(0, response.size); } });
    try { sendFileControl(id, 'read', { path }); } catch (cause) { filePending.delete(id); reject(cause); }
  });
}

// Replay only idempotent, version-checked video reads across brief outages.
async function readVideoRange(tab, offset, length) {
  const identity = resumableSession, deadline = Date.now() + 20000;
  let attempt = connectionId;
  while (Date.now() < deadline) {
    if (resumableSession !== identity || fileTabs.get(tab.path) !== tab) throw Error('Video session changed. Reopen the video.');
    if (!transportReady) { await new Promise(resolve => setTimeout(resolve, 150)); continue; }
    attempt = connectionId;
    try {
      const version = tab.version;
      const result = await readFileRange(tab.path, offset, length, version);
      if (tab.version !== version || fileTabs.get(tab.path) !== tab) return result;
      const ranges = [...(tab.loadedRanges || []), [offset, offset + result.bytes.length]].sort((a, b) => a[0] - b[0]);
      tab.loadedRanges = [];
      for (const range of ranges) {
        const last = tab.loadedRanges.at(-1);
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else tab.loadedRanges.push(range);
      }
      const loaded = tab.loadedRanges.reduce((sum, [start, end]) => sum + end - start, 0);
      tab.progressText = `Streamed · ${fileProgress(loaded, tab.size)}`; updateFileIndicators(tab);
      return result;
    }
    catch (error) { if (transportReady && attempt === connectionId) throw error; }
  }
  throw Error('Video reconnection timed out. Reopen the video to retry.');
}

function readFileRange(path, offset, length, version) {
  if (filePending.size >= 64) return Promise.reject(Error('Too many pending operations.'));
  const id = nextFileRequestId();
  return new Promise((resolve, reject) => {
    filePending.set(id, { resolve, reject, chunks: [], meta: null, onJson(response) { this.meta = response; } });
    try { sendFileControl(id, 'read_range', { path, offset, length, version }); } catch (cause) { filePending.delete(id); reject(cause); }
  });
}

function uploadBytes(path, bytes, overwrite, version) {
  if (filePending.size >= 64) return Promise.reject(Error('Too many pending operations. Wait for earlier requests to finish.'));
  const id = nextFileRequestId();
  return new Promise((resolve, reject) => {
    filePending.set(id, {
      resolve, reject,
      onJson(response) {
        if (response.ready) sendUploadChunks(id, bytes).catch(cause => { filePending.delete(id); reject(cause); });
        else if (response.done) { filePending.delete(id); resolve(response); }
      },
    });
    try { sendFileControl(id, 'write', { path, size: bytes instanceof Blob ? bytes.size : bytes.byteLength, overwrite, version }); }
    catch (cause) { filePending.delete(id); reject(cause); }
  });
}

async function sendUploadChunks(id, bytes) {
  const attempt = connectionId;
  const length = bytes instanceof Blob ? bytes.size : bytes.byteLength;
  if (!length) {
    const message = new Uint8Array(6); message[0] = 5; new DataView(message.buffer).setUint32(1, id); message[5] = 1;
    if (!send(message)) throw Error('Upload failed.');
    return;
  }
  for (let offset = 0; offset < length; offset += 60000) {
    while (socket?.bufferedAmount > 512 * 1024) {
      if (attempt !== connectionId || !transportReady || !filePending.has(id) || socket.readyState !== WebSocket.OPEN) throw Error('Upload interrupted. Retry after reconnection.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (attempt !== connectionId || !transportReady || !filePending.has(id)) throw Error('Upload interrupted. Retry after reconnection.');
    const chunk = bytes instanceof Blob ? new Uint8Array(await bytes.slice(offset, offset + 60000).arrayBuffer()) : bytes.subarray(offset, Math.min(length, offset + 60000));
    if (attempt !== connectionId || !transportReady || !filePending.has(id)) throw Error('Upload interrupted. Retry after reconnection.');
    const message = new Uint8Array(chunk.length + 6);
    message[0] = 5;
    new DataView(message.buffer).setUint32(1, id);
    message[5] = offset + chunk.length === length ? 1 : 0;
    message.set(chunk, 6);
    if (!send(message)) throw Error('Upload failed.');
  }
}

function handleFileResponse(response) {
  const pending = filePending.get(response.id);
  if (!pending) return;
  if (!response.ok) {
    filePending.delete(response.id);
    pending.reject(Error(response.error || 'File operation failed.'));
    return;
  }
  pending.onJson(response);
}

function handleFileChunk(message) {
  const id = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(1);
  const pending = filePending.get(id);
  if (!pending?.chunks) return;
  pending.chunks.push(message.slice(6));
  pending.received = (pending.received || 0) + message.length - 6;
  pending.onProgress?.(pending.received, pending.meta?.size);
  if (!message[5]) return;
  filePending.delete(id);
  const length = pending.chunks.reduce((total, value) => total + value.length, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of pending.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  pending.resolve({ meta: pending.meta, bytes });
}

function handleFileJsonChunk(message) {
  const id = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(1);
  const pending = filePending.get(id);
  if (!pending) return;
  (pending.jsonChunks ||= []).push(message.slice(6));
  pending.received = (pending.received || 0) + message.length - 6;
  pending.onProgress?.(pending.received, message[5] ? pending.received : null);
  if (!message[5]) return;
  const length = pending.jsonChunks.reduce((total, value) => total + value.length, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of pending.jsonChunks) { bytes.set(chunk, offset); offset += chunk.length; }
  pending.jsonChunks = [];
  handleFileResponse(JSON.parse(decoder.decode(bytes)));
}

function rejectFileRequests(message) {
  for (const pending of filePending.values()) pending.reject(Error(message));
  filePending.clear();
}

function fileFailure(cause) {
  $('file-status').textContent = cause?.message || String(cause);
}

async function navigateTo(path, push = true) {
  if (!outbound) { $('file-status').textContent = 'Connect to browse files.'; return; }
  legacyPathCombo?.close(); legacySearchCombo?.close(); legacySearchRoot = null; clearTimeout(fileSearchTimer);
  const generation = ++fileNavigationGeneration; fileNavigationPending++;
  $('file-status').textContent = `Loading directory · ${fileProgress()}`;
  try {
    const response = await fileRequest('list', { path: path || $('starting-directory').value.trim(), showHidden: $('show-hidden').checked }, (loaded, total) => { if (generation === fileNavigationGeneration) $('file-status').textContent = `Loading directory · ${fileProgress(loaded, total)}`; });
    if (generation !== fileNavigationGeneration) return;
    const directoryChanged = currentPath !== response.path;
    const focusedRow = document.activeElement?.closest?.('tr');
    const focusedPath = $('file-list').contains(focusedRow) ? focusedRow.dataset.path : '';
    currentPath = response.path;
    directoryEntries = response.entries;
    if (directoryChanged) browserSelection.clear();
    selectedEntry = !directoryChanged && selectedEntry ? directoryEntries.find(entry => entry.path === selectedEntry.path) : undefined;
    if (document.activeElement !== $('file-path')) $('file-path').value = currentPath;
    $('file-search').value = '';
    if (push && historyPaths[historyIndex] !== currentPath) {
      historyPaths = historyPaths.slice(0, historyIndex + 1);
      historyPaths.push(currentPath);
      historyIndex = historyPaths.length - 1;
    }
    renderDirectory();
    if (!directoryChanged && focusedPath) [...$('file-list').rows].find(row => row.dataset.path === focusedPath)?.focus({ preventScroll: true });
    if (directoryChanged) $('browser-view').scrollTop = 0;
    updateNavigationButtons();
    $('file-status').textContent = `${directoryEntries.length} item${directoryEntries.length === 1 ? '' : 's'} in ${currentPath}`;
  } catch (cause) { if (generation === fileNavigationGeneration) fileFailure(cause); }
  finally { fileNavigationPending--; }
}

bindFileSorting($('file-list').closest('table').tHead.rows[0], sort => { directorySort = sort; renderDirectory(); });
function renderDirectory() {
  const menuEntry = fileMenuEntry && directoryEntries.find(item => item.path === fileMenuEntry.path);
  if (!menuEntry) hideFileEntryMenu();
  const body = $('file-list');
  body.replaceChildren();
  const parent = { name: '..', path: parentPath(currentPath), kind: 'parent', size: 0, modified: 0 };
  const sorted = sortFiles(directoryEntries, directorySort);
  const entries = currentPath !== '/' && !$('file-search').value ? [parent, ...sorted] : sorted;
  for (const item of entries) {
    const row = document.createElement('tr');
    row.tabIndex = 0;
    row.dataset.path = item.path;
    row.classList.toggle('selected', browserSelection.has(item.path));
    const name = document.createElement('td');
    const entryName = document.createElement('span'); entryName.textContent = item.name;
    name.append(fileIcon(item), entryName); name.className = 'entry-name';
    name.title = item.path;
    const size = document.createElement('td'); size.className = 'size'; size.textContent = ['directory', 'parent'].includes(item.kind) ? '—' : formatSize(item.size);
    const modified = document.createElement('td'); modified.className = 'modified'; modified.textContent = modifiedDate(item.modified); modified.title = item.modified ? new Date(item.modified).toLocaleString() : '';
    const type = document.createElement('td'); type.className = 'file-type'; type.textContent = item.kind === 'directory' ? 'Folder' : item.kind === 'parent' ? '—' : extension(item.path).toUpperCase() || item.kind;
    const actions = document.createElement('td'); actions.className = 'entry-actions';
    if (item.kind !== 'parent') {
      const menu = document.createElement('button');
      menu.type = 'button'; menu.className = 'file-entry-button'; buttonIcon(menu, 'EllipsisVertical', `Actions for ${item.name}`, true);
      menu.title = `Actions for ${item.name}`; menu.setAttribute('aria-label', `Actions for ${item.name}`); menu.setAttribute('aria-haspopup', 'menu');
      menu.addEventListener('click', event => { event.stopPropagation(); showFileEntryMenu(item, menu); });
      menu.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); showFileEntryMenu(item, menu); $('file-entry-menu').querySelector('button:not([hidden])')?.focus(); } });
      actions.append(menu);
    }
    row.append(name, size, modified, type, actions);
    browserSelection.decorate(row, item);
    bindFileEntryInteractions(row, event => selectEntry(item, event), () => activateEntry(item));
    row.addEventListener('keydown', event => { if (event.target === row && event.key === 'Enter') { event.preventDefault(); activateEntry(item); } });
    body.append(row);
  }
  browserSelection.update();
  $('file-empty').hidden = !!directoryEntries.length;
  $('file-empty').textContent = $('file-search').value ? 'No matching files.' : 'This directory is empty.';
  if (menuEntry) {
    const row = [...body.rows].find(row => row.dataset.path === menuEntry.path);
    const button = row?.querySelector('.file-entry-button');
    if (button) showFileEntryMenu(menuEntry, button); else hideFileEntryMenu();
  }
}

function selectEntry(item, event) {
  selectedEntry = item; browserSelection.select(item, event);
}
function activateEntry(item) { if (['directory', 'parent'].includes(item.kind)) navigateTo(item.path, true); else openFile(item.path); }
function updateNavigationButtons() {
  $('file-back').disabled = historyIndex <= 0;
  $('file-forward').disabled = historyIndex < 0 || historyIndex >= historyPaths.length - 1;
  $('file-up').disabled = !currentPath || currentPath === '/';
}
function showFileEntryMenu(item, button) {
  legacyOpenWith?.destroy(); legacyOpenWith = null;
  closeMenus();
  if (!browserSelection.has(item.path)) selectEntry(item);
  fileMenuEntry = item;
  const menu = $('file-entry-menu');
  const open = menu.querySelector('[data-file-action=open]');
  const openers = item.kind === 'file' ? fileOpenerChoices(item.path) : [];
  open.querySelector('.button-label').textContent = openers.length > 1 ? 'Open With…' : 'Open';
  open.setAttribute('aria-label', openers.length > 1 ? 'Open With…' : 'Open'); open.title = open.getAttribute('aria-label');
  if (openers.length > 1) {
    legacyOpenWith = createSubmenu({ parent:menu, trigger:open, label:`Open ${item.name} with`,
      items:openers.map(viewer => ({ ...viewer, action:() => openFile(item.path,false,viewer.id) })), onChoose:() => hideFileEntryMenu() });
  }
  const terminal = menu.querySelector('[data-directory-terminal]') || document.createElement('button'); terminal.dataset.directoryTerminal = ''; terminal.type = 'button'; terminal.textContent = 'Open in terminal'; terminal.hidden = item.kind !== 'directory';
  terminal.setAttribute('role', 'menuitem'); terminal.onclick = () => { openDirectoryTerminal(item.path); hideFileEntryMenu(); }; menu.append(terminal);
  menu.querySelector('[data-file-action=download]').hidden = item.kind === 'directory';
  menu.querySelector('[data-file-action=copy]').hidden = item.kind !== 'file';
  menu.hidden = false;
  button.setAttribute('aria-controls', 'file-entry-menu'); button.setAttribute('aria-expanded', 'true');
  const rect = button.getBoundingClientRect();
  const width = menu.offsetWidth, height = menu.offsetHeight;
  const viewport = window.visualViewport || { offsetLeft: 0, offsetTop: 0, width: innerWidth, height: innerHeight };
  menu.style.left = `${Math.max(viewport.offsetLeft + 6, Math.min(rect.right - width, viewport.offsetLeft + viewport.width - width - 6))}px`;
  menu.style.top = `${Math.max(viewport.offsetTop + 6, Math.min(rect.bottom + 4, viewport.offsetTop + viewport.height - height - 6))}px`;
}
function hideFileEntryMenu() {
  legacyOpenWith?.close();
  $('file-entry-menu').hidden = true; fileMenuEntry = undefined;
  for (const trigger of $('file-list').querySelectorAll('[aria-expanded=true]')) trigger.setAttribute('aria-expanded', 'false');
}
function formatSize(value) {
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB']; let amount = value;
  for (const unit of units) { amount /= 1024; if (amount < 1024 || unit === units.at(-1)) return `${amount < 10 ? amount.toFixed(1) : Math.round(amount)} ${unit}`; }
}
function baseName(path) { return path.split('/').filter(Boolean).at(-1) || '/'; }
function parentPath(path) { const parts = path.split('/').filter(Boolean); parts.pop(); return `/${parts.join('/')}`; }

async function searchFiles() {
  const query = $('file-search').value.trim();
  const root = legacySearchRoot || currentPath;
  if (!query) { await navigateTo(root, root !== currentPath); return; }
  const generation = ++fileNavigationGeneration; fileNavigationPending++;
  try {
    $('file-status').textContent = `Searching · ${fileProgress()}`;
    const response = await fileRequest('search', { path: root, query, showHidden: $('show-hidden').checked }, (loaded, total) => { if (generation === fileNavigationGeneration) $('file-status').textContent = `Searching · ${fileProgress(loaded, total)}`; });
    if ($('file-search').value.trim() !== query || generation !== fileNavigationGeneration) return;
    if (root !== currentPath) {
      currentPath = response.path || root; if (document.activeElement !== $('file-path')) $('file-path').value = currentPath; browserSelection.clear();
      if (historyPaths[historyIndex] !== currentPath) { historyPaths = historyPaths.slice(0, historyIndex + 1); historyPaths.push(currentPath); historyIndex = historyPaths.length - 1; }
      updateNavigationButtons();
    }
    directoryEntries = response.entries;
    selectedEntry = undefined;
    renderDirectory();
    legacySearchCombo?.update(legacySearchSuggestions());
    $('file-status').textContent = `${directoryEntries.length} result${directoryEntries.length === 1 ? '' : 's'} for “${query}”`;
  } catch (cause) { if (generation === fileNavigationGeneration) fileFailure(cause); }
  finally { fileNavigationPending--; }
}

async function refreshFiles(automatic = false) {
  if (!currentPath || $('file-search').value) return;
  await navigateTo(currentPath, false);
  const tab = fileTabs.get(activeFileTab);
  if (automatic && $('file-autoreload').checked && tab && !tab.loading && !tab.dirty && !tab.cad && !tab.streaming) await openFile(tab.path, true);
}

const textExtensions = new Set(['txt','md','markdown','js','mjs','cjs','ts','tsx','jsx','json','html','htm','css','scss','xml','svg','yml','yaml','toml','ini','conf','cfg','sh','bash','zsh','fish','py','rb','rs','go','java','c','h','cpp','hpp','cs','php','sql','log','env','gitignore']);
const imageExtensions = new Set(['png','jpg','jpeg','gif','webp','avif','bmp','ico','svg']);
const videoExtensions = new Set(['mp4','webm','ogv','mov','m4v','3gp','3g2','mkv']);
const audioExtensions = new Set(['mp3','wav','ogg','oga','opus','m4a','aac','flac','weba']);
function extension(path) { const name = baseName(path); return name.includes('.') ? name.split('.').at(-1).toLowerCase() : ''; }
function mediaType(path) {
  const ext = extension(path);
  return ({ mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime', '3gp': 'video/3gpp', '3g2': 'video/3gpp2', mkv: 'video/x-matroska', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg; codecs=opus', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', weba: 'audio/webm', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml' })[ext] || 'application/octet-stream';
}
function likelyText(path, bytes) {
  return !isBinaryContent(bytes);
}
function languageFor(path) {
  const ext = extension(path);
  if (ext === 'py') return python();
  if (ext === 'json') return json();
  if (['js','mjs','cjs','ts','tsx','jsx'].includes(ext)) return javascript({ typescript: ['ts','tsx'].includes(ext), jsx: ['jsx','tsx'].includes(ext) });
  if (['html','htm'].includes(ext)) return html();
  if (['css','scss'].includes(ext)) return css();
  if (['md','markdown'].includes(ext)) return markdown();
  return [];
}

const fileViewers = [
  { name: 'markdown', supports: tab => ['md', 'markdown'].includes(extension(tab.path)), render: renderMarkdownViewer },
  { name: 'cad', supports: tab => isCadFile(tab.path), render: renderCadViewer },
  { name: 'html', supports: tab => ['html', 'htm'].includes(extension(tab.path)), render: renderHtmlViewer },
  { name: 'image', supports: tab => imageExtensions.has(extension(tab.path)), render: renderImageViewer },
  { name: 'video', supports: tab => videoExtensions.has(extension(tab.path)), render: renderVideoViewer },
  { name: 'audio', supports: tab => audioExtensions.has(extension(tab.path)), render: renderAudioViewer },
  { name: 'text', supports: tab => likelyText(tab.path, tab.bytes), render: renderTextEditor },
  { name: 'binary', supports: () => true, render: renderBinaryViewer },
  { name: 'generic', supports: () => false, render: renderGenericViewer },
];
function fileOpenerChoices(path) {
  const tab = { path, bytes: new Uint8Array() };
  const configured = preferences.fileOpeners?.[fileExtension(path)];
  return fileViewers.filter(viewer => ['text', 'binary', configured].includes(viewer.name) || viewer.supports(tab)).map(viewer => ({ id: viewer.name, title: FILE_OPENER_TYPES.find(([id]) => id === viewer.name)?.[1] || viewer.name }));
}
function openDirectoryTerminal(path) {
  if (!path) return;
  const quoted = "'" + String(path).replaceAll("'", "'\\''") + "'";
  const startup = $('default-command').value;
  return workbench.create('terminal', { command: `cd -- ${quoted}${startup ? ` && ${startup}` : ''}` }).catch(cause => notify(cause.message));
}

function syncPanelPreferences(key, value) {
  preferences[key] = structuredClone(value); workspacePreferences[key] = preferences[key];
  writeSettingsControls($('settings-dialog'), workspacePreferences); workspaces.changed();
}
function browserPreferences() {
  return { startingDirectory: $('starting-directory').value.trim(), showHidden: $('show-hidden').checked,
    refreshInterval: Number($('refresh-interval').value), confirmDelete: $('confirm-delete').checked };
}
async function openMachinePath(path) {
  let directory;
  try { directory = await fileRequest('list', { path }); } catch { /* Files open in a viewer. */ }
  if (!directory) return openFile(path);
  const id = await workbench.create('files');
  await workbench.requirePanel(id).api.navigate(directory.path);
}
workbench.registerType({ id: 'terminal', title: 'Terminal', icon: 'Terminal', category: 'Workspace', order: 10,
  description: 'Start an interactive shell session.', keywords: ['shell', 'command line', 'console'], create: ({ id, command, title, session, restoring, takeover }) => {
  const connection = resumableSession && { url: new URL(resumableSession.url), key: resumableSession.key, command: $('default-command').value };
  if (!connection) { openConnection(); throw Error('Connect to a server first'); }
  if (!transportReady) throw Error('Connect before opening a terminal.');
  const panel = createTerminalPanel({ id, title: title || 'Terminal', compression: $('terminal-compression').checked, sessionId: session, restoring, takeover, client: resumableSession?.client, onSession: () => workspaces.changed(), endRemote, onContextMenu: showTerminalMenu, openLink: openWebLink, onFontSize: size => { $('font-size').value = size; applySettings(); }, url: connection.url.href, key: connection.key, command: command ?? connection.command, options: terminalOptions(), transformInput: applyModifiers });
  panel.api.openSettings = () => openSettingsGroup('terminal'); return panel;
} });
workbench.registerType({ id: 'files', title: 'File browser', icon: 'FolderOpen', category: 'Workspace', order: 20,
  description: 'Browse, edit, upload, and manage server files.', keywords: ['explorer', 'folders', 'editor'], create: ({ id, cwd }) => createFileBrowser({
  id, cwd, lifecycle, openSettings: () => openSettingsGroup('files'), onStateChange: () => workspaces.changed(), request: fileRequest, read: readFile, upload: uploadBytes, openFile, getOpeners: fileOpenerChoices, openTerminal: openDirectoryTerminal, download: downloadBlob,
  preferences: browserPreferences, clipboard: fileClipboard, onDelete: closeDeletedFiles, beforeDelete: prepareFileDeletion, rename: renameFile,
}) });
workbench.registerType({ id: 'web-browser', title: 'Browser', icon: 'Globe', category: 'Workspace', order: 25,
  description: 'Browse sites through isolated server Chromium.', keywords: ['web', 'internet', 'chromium'], create: async ({ id, session, restoring, stream, initialUrl }) => {
  const connection = resumableSession && { url: new URL(resumableSession.url), key: resumableSession.key, command: $('default-command').value };
  if (!connection || !transportReady) { openConnection(); throw Error('Connect to Eya before opening the browser.'); }
  const transport = createRecoveringBrowserTransport({ url: connection.url.href, key: connection.key });
  let runtimeSession = session || null, disposed = false, paused = false, blocked = false, timer, attempts = 0, takeOver = false;
  const recovery = document.createElement('div'); recovery.className = 'instance-terminal-bar'; recovery.hidden = true;
  const detail = document.createElement('span'); detail.className = 'instance-terminal-status';
  const takeover = document.createElement('button'); takeover.type = 'button'; takeover.textContent = 'Take over';
  const retryBrowser = document.createElement('button'); retryBrowser.type = 'button'; retryBrowser.textContent = 'Reconnect browser';
  const restart = document.createElement('button'); restart.type = 'button'; restart.textContent = 'Start new browser session';
  recovery.append(detail, takeover, retryBrowser, restart);
  const reconnect = () => {
    if (!disposed && !paused && !blocked && runtimeSession) panel.api.restoreRemote().then(() => { attempts = 0; recovery.hidden = true; }).catch(showRecovery);
  };
  function showRecovery(error) {
    if (disposed) return;
    if (['in-use', 'expired', 'full', 'startup-failed'].includes(error.code)) blocked = true;
    recovery.hidden = false; detail.textContent = error.message;
    takeover.hidden = error.code !== 'in-use'; restart.hidden = !['expired', 'startup-failed'].includes(error.code);
    retryBrowser.hidden = ['in-use', 'expired'].includes(error.code);
  }
  const openRemoteBrowser = async handlers => {
    try {
      const createSession = !runtimeSession;
      if (!runtimeSession) { runtimeSession = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join(''); workspaces.changed(); }
      const remote = await createBrowserRenderTransport({ url: connection.url.href, key: connection.key, persistent: true, client: resumableSession.client, sessionId: runtimeSession, createSession, takeover: takeOver, ...handlers,
        onState: (state, error) => {
          handlers.onState?.(state, error);
          if (state === 'error') showRecovery(error);
          if (state === 'closed' && !disposed && !paused && !blocked && runtimeSession) { clearTimeout(timer); timer = setTimeout(reconnect, Math.min(10000, 500 * 2 ** Math.min(attempts++, 5))); }
        },
      });
      runtimeSession = remote.sessionId; takeOver = false; workspaces.changed();
      if (paused || disposed) { remote.close({ detach: true }); throw Error('Browser detached while connecting.'); }
      return remote;
    } catch (error) { showRecovery(error); throw error; }
  };
  const panel = createBrowserPanel({ preferences: { ...preferences.browser, stream: stream || preferences.browser.stream }, onGlobalShortcut: runGlobalShortcut, onSettingsChange: value => syncPanelPreferences('browser', value), request: transport.request, openWebSocket: transport.openWebSocket, openRemoteBrowser, readLocalFile: readFile, openLocalFile: openFile, fileRequest, uploadServerFile: uploadBytes, onAuxModifiersConsumed: takeModifiers, onStateChange: () => { blocked = false; recovery.hidden = true; attempts = 0; workspaces.changed(); }, retainRemoteSession: true });
  panel.element.prepend(recovery);
  if (initialUrl) queueMicrotask(() => panel.api.navigate(initialUrl).catch(cause => notify(cause.message)));
  takeover.onclick = () => { if (confirm('Take over this browser? The other client will be detached.')) { blocked = false; takeOver = true; reconnect(); } };
  retryBrowser.onclick = () => { blocked = false; reconnect(); };
  restart.onclick = () => { if (confirm('Start a new browser session? The previous session cannot be recovered.')) { if (runtimeSession) endRemote(runtimeSession); runtimeSession = null; blocked = false; panel.api.restoreRemote().then(() => { recovery.hidden = true; workspaces.changed(); }).catch(showRecovery); } };
  if (restoring && runtimeSession) queueMicrotask(reconnect);
  return { ...panel, id, title: 'Browser', serialize: () => ({ id, kind: 'web-browser', title: 'Browser', session: runtimeSession, config: { stream: panel.api.streamSettings } }),
    api: { ...panel.api, detach() { paused = true; clearTimeout(timer); transport.pause(); panel.api.detach(); }, resume() { if (paused) { paused = false; transport.resume(); reconnect(); } } },
    onClose(options = {}) { disposed = true; clearTimeout(timer); panel.onClose?.({ detach: true }); transport.close(); if (!options.detach && runtimeSession) endRemote(runtimeSession); } };
} });
workbench.registerType({ id: 'proxy-browser', title: 'Proxy browser', icon: 'Globe', category: 'Workspace', order: 26,
  description: 'Experimental client rendering and local HTML. Some requests may use this device’s network.', keywords: ['web', 'internet', 'proxy', 'html', 'local', 'devtools'], create: async ({ id, initialUrl, proxyState }) => {
  const connection = resumableSession && { url: new URL(resumableSession.url), key: resumableSession.key };
  if (!connection || !transportReady) { openConnection(); throw Error('Connect to Eya before opening the proxy browser.'); }
  let panel, connectionState = 'connecting', connectionError;
  const transport = createRecoveringBrowserTransport({ url: connection.url.href, key: connection.key,
    onState(state, error) { connectionState = state; connectionError = error; panel?.api.setProxyConnectionState(state, error); } });
  panel = createBrowserPanel({ serverRenderedByDefault: false, preferences: preferences.browser,
    request: transport.request, openWebSocket: transport.openWebSocket, readLocalFile: readFile, openLocalFile: openFile,
    reconnectProxy: transport.reconnect,
    onGlobalShortcut: runGlobalShortcut, onSettingsChange: value => syncPanelPreferences('browser', value),
    onStateChange: () => workspaces.changed() });
  panel.api.setProxyConnectionState(connectionState, connectionError);
  // Restore only GET destinations. Other tabs load when explicitly selected;
  // no request, upload, socket or page execution state is replayed on reconnect.
  panel.api.restoreProxyState(sanitizeProxyState(proxyState, initialUrl));
  return { ...panel, id, serialize: () => {
    const proxyState = panel.api.proxyState;
    let initialUrl = proxyState.tabs[proxyState.active].url;
    // Preserve the deployed single-URL fallback for older clients when it fits.
    if (encoder.encode(JSON.stringify({ initialUrl, proxyState })).byteLength > 8192) initialUrl = '';
    return { id, kind: 'proxy-browser', title: 'Proxy browser', config: { initialUrl, proxyState } };
  },
    api: Object.assign(panel.api, { detach: transport.pause, resume: transport.resume }),
    onClose() { panel.onClose(); transport.close(); } };
} });
workbench.registerType({ id: 'task-manager', title: 'Task Manager', icon: 'Activity', category: 'System', order: 30,
  description: 'Inspect processes and live machine resource usage.', keywords: ['processes', 'cpu', 'memory', 'system'], create: ({ id }) => ({
  id, title: 'Task Manager', kind: 'system', ...createTaskManager({ preferences: preferences.taskManager, onSettingsChange: value => syncPanelPreferences('taskManager', value), lifecycle, request: fileRequest, openFile: openMachinePath, openTerminal: command => workbench.create('terminal', { command }) }),
}) });
workbench.registerType({ id: 'docker', title: 'Docker', icon: 'Container', category: 'System', order: 40,
  description: 'Monitor containers, images, logs, and Docker resources.', keywords: ['containers', 'images', 'compose'], create: ({ id }) => ({
  id, title: 'Docker', kind: 'docker', ...createDockerPanel({ preferences: preferences.docker, onSettingsChange: value => syncPanelPreferences('docker', value), lifecycle, request: fileRequest, openFile: openMachinePath, openTerminal: command => workbench.create('terminal', { command }) }),
}) });

const panelApi = {
  openFile: (path, viewer) => openFile(String(path), false, viewer),
  registerType: definition => workbench.registerType(definition),
  listTypes: () => workbench.listTypes(),
  create: (type, options) => workbench.create(type, options),
  openStart: groupId => workbench.openStart(groupId),
  register: definition => workbench.register(definition),
  open: (id, options) => workbench.open(id, options),
  close: id => workbench.close(id),
  minimize: id => workbench.minimize(id),
  activate: id => workbench.activate(id),
  move: (id, groupId) => workbench.move(id, groupId),
  split: (id, direction, referenceId) => workbench.split(id, direction, referenceId),
  update: (id, changes) => workbench.update(id, changes),
  groupOf: id => workbench.groupOf(id),
  layout: () => workbench.snapshot(),
  call(id, method, ...args) {
    const panel = workbench.requirePanel(id);
    if (!Object.hasOwn(panel.api || {}, method) || typeof panel.api[method] !== 'function') throw Error(`Panel ${id} does not expose ${method}.`);
    return panel.api[method](...args);
  },
  registerViewer(provider) {
    if (!provider || typeof provider.name !== 'string' || typeof provider.supports !== 'function' || typeof provider.render !== 'function') {
      throw Error('A viewer requires name, supports, and render fields.');
    }
    fileViewers.splice(fileViewers.findIndex(value => value.name === 'binary'), 0, provider);
  },
};
Object.defineProperty(globalThis, 'EyaPanels', { configurable: true, value: Object.freeze(panelApi) });

function openFile(path, force = false, viewer) {
  if (viewer && !fileViewers.some(provider => provider.name === viewer)) return Promise.reject(Error('Viewer unavailable.'));
  if (viewer && fileOpenings.has(path)) return fileOpenings.get(path).then(() => openFile(path, force, viewer));
  const existing = fileTabs.get(path);
  if (viewer && existing && existing.viewer !== viewer) {
    if (existing.saving || existing.renaming) { notify('Wait for the file save or rename to finish.'); return Promise.resolve(); }
    if (existing.dirty && !confirm(`Discard unsaved changes to ${existing.name}?`)) return Promise.resolve();
    setTabDirty(existing, false); existing.text = undefined; existing.lineSeparator = undefined;
    existing.preferredViewer = viewer;
    if (!existing.streaming) { renderTabContent(existing); activateFileTab(path); workspaces.changed(); return Promise.resolve(); }
    force = true;
  }
  if (fileOpenings.has(path)) { if (!force) activateFileTab(path); return fileOpenings.get(path); }
  if (fileTabs.has(path) && !force) { activateFileTab(path); return Promise.resolve(); }
  const pending = loadFile(path, force, viewer ? { config: { viewer } } : null).finally(() => { if (fileOpenings.get(path) === pending) fileOpenings.delete(path); });
  fileOpenings.set(path, pending); return pending;
}
async function loadFile(path, force = false, restored = null) {
  const attempt = connectionId;
  const workspaceAttempt = workspaceGeneration;
  const existing = fileTabs.get(path);
  if (existing && !force) { activateFileTab(path); return; }
  const tab = existing || { path, preferredViewer: restored?.config.viewer, binaryPreferences: restored?.config.binary, resume: { time: restored?.config.time || 0, paused: restored?.config.paused !== false }, panelId: restored?.id || `file-${randomId()}`, name: baseName(path), imageBackground: restored?.config.imageBackground, bytes: new Uint8Array(), dirty: false, view: null, node: null, url: null, loading: true };
  const initial = !existing || !!existing.loadError || !!existing.loading;
  if (initial) {
    tab.loading = true; tab.loadError = null;
    fileTabs.set(path, tab);
    renderTabContent(tab);
    activateFileTab(path);
  }
  try {
    tab.transferring = true; tab.progressText = `Loading · ${fileProgress()}`; updateFileIndicators(tab);
    $('file-status').textContent = `Opening ${path}…`;
    const serverUrl = new URL(resumableSession.url);
    const trustedVideoOrigin = serverUrl.protocol === 'wss:' || serverUrl.hostname === 'localhost' || serverUrl.hostname.endsWith('.localhost') || serverUrl.hostname === '[::1]' || /^127\./.test(serverUrl.hostname);
    const requestedViewer = tab.preferredViewer || preferences.fileOpeners?.[fileExtension(path)];
    const streaming = videoExtensions.has(extension(path)) && (!requestedViewer || requestedViewer === 'video') && trustedVideoOrigin;
    const result = streaming ? { meta: await fileRequest('stat', { path }), bytes: new Uint8Array() } : await readFile(path, (loaded, total) => {
      if (fileTabs.get(path) !== tab) return;
      tab.progressText = `${initial ? 'Loading' : 'Refreshing'} · ${fileProgress(loaded, total)}`; updateFileIndicators(tab);
    });
    if (restored?.config.version && restored.config.version !== result.meta.version) throw Error('File changed since this tab was saved. Reload the current file explicitly.');
    if (restored?.config.viewer && !fileViewers.some(viewer => viewer.name === restored.config.viewer)) throw Error(`Viewer ${restored.config.viewer} is unavailable. Reload with a current viewer explicitly.`);
    if (streaming && (!Number.isSafeInteger(result.meta.size) || result.meta.size < 0)) throw Error('Video size cannot be represented by this browser.');
    if (attempt !== connectionId || workspaceAttempt !== workspaceGeneration) return;
    if (fileTabs.get(path) !== tab || tab.path !== path) return;
    tab.transferring = false; tab.progressText = streaming ? `Streaming · ${fileProgress(0, result.meta.size)}` : '';
    const wasChanged = !!tab.diskChanged || (!initial && tab.version !== result.meta.version);
    if (existing && force && !initial) {
      if (existing.dirty) return;
      if (existing.cad) {
        if (await existing.cad.load(result.bytes)) {
          existing.bytes = result.bytes; existing.modified = result.meta.modified; existing.version = result.meta.version;
          setFileChanged(tab, false, wasChanged);
          workspaces.changed();
        }
        return;
      }
      setFileChanged(tab, false, wasChanged);
      if (streaming) {
        existing.loadedRanges = []; existing.version = result.meta.version; existing.size = result.meta.size; renderTabContent(existing);
        return;
      }
      existing.streaming = false;
      const unchanged = existing.bytes.length === result.bytes.length && existing.bytes.every((byte, index) => byte === result.bytes[index]);
      existing.modified = result.meta.modified; existing.version = result.meta.version; existing.size = result.meta.size; workspaces.changed();
      if (unchanged && existing.viewer !== 'html') return;
      existing.bytes = result.bytes;
      if (existing.viewer === 'text') {
        existing.text = decoder.decode(result.bytes);
        existing.lineSeparator = existing.text.includes('\r\n') ? '\r\n' : '\n';
      }
      renderTabContent(existing);
      $('file-status').textContent = `${baseName(path)} refreshed after an external change.`;
      return;
    }
    Object.assign(tab, { bytes: result.bytes, size: result.meta.size, streaming, modified: result.meta.modified, version: result.meta.version, loading: false, loadError: null });
    fileTabs.set(path, tab);
    renderTabContent(tab);
    $('file-status').textContent = `${tab.name} · ${formatSize(tab.size ?? tab.bytes.length)}`;
  } catch (cause) {
    if (workspaceAttempt !== workspaceGeneration || fileTabs.get(path) !== tab) return;
    if (initial) {
      tab.loading = false; tab.loadError = cause.message || 'Could not open file';
      if (restored) workbench.close(tab.panelId, true);
      else renderTabContent(tab);
    }
    fileFailure(cause); if (restored) throw cause; notify(cause.message || 'Could not open file');
  } finally {
    tab.transferring = false; updateFileIndicators(tab);
  }
}

async function readViewerResource(tab, path, maxBytes) {
  const loads = tab.resourceLoads ||= new Set();
  const item = { loaded: 0, total: null, done: false }; loads.add(item);
  const update = () => {
    const items = [...loads];
    const total = items.every(value => Number.isSafeInteger(value.total)) ? items.reduce((sum, value) => sum + value.total, 0) : null;
    tab.resourceProgress = `Loading resources · ${fileProgress(items.reduce((sum, value) => sum + value.loaded, 0), total)}`;
    updateFileIndicators(tab);
  };
  update();
  try {
    const progress = (loaded, total) => { item.loaded = loaded; item.total = total; update(); };
    if (maxBytes === undefined) return await readFile(path, progress);
    const meta = await fileRequest('stat', { path });
    if (!Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > maxBytes) throw Error('Image exceeds preview budget.');
    const bytes = new Uint8Array(meta.size); progress(0, meta.size);
    for (let offset = 0; offset < meta.size;) {
      if (fileTabs.get(tab.path) !== tab) throw Error('Viewer closed.');
      const length = Math.min(1024 * 1024, meta.size - offset);
      const chunk = await readFileRange(path, offset, length, meta.version);
      if (chunk.bytes.length !== length || chunk.meta?.size !== meta.size || chunk.meta?.version !== meta.version) throw Error('Image changed during preview.');
      bytes.set(chunk.bytes, offset); offset += length; progress(offset, meta.size);
    }
    return { meta, bytes };
  }
  finally {
    item.done = true;
    if ([...loads].every(value => value.done)) { loads.clear(); tab.resourceProgress = ''; }
    updateFileIndicators(tab);
  }
}

function setFileChanged(tab, changed, updated = false) {
  tab.diskChanged = changed;
  if (changed) tab.updatedFromDisk = false;
  else if (updated) tab.updatedFromDisk = true;
  updateFileIndicators(tab);
}
function updateFileIndicators(tab) {
  tab.node?.querySelector('.viewer-body')?.setAttribute('aria-busy', String(!!tab.loading || !!tab.transferring || !!tab.resourceProgress));
  if (tab.refreshButton) tab.refreshButton.disabled = !!tab.dirty || !!tab.loading || !!tab.transferring;
  if (tab.progressLabel) {
    tab.progressLabel.textContent = tab.transferring || tab.loading ? (tab.progressText || `Loading · ${fileProgress()}`) : tab.resourceProgress || (tab.streaming ? tab.progressText : '') || '';
    tab.progressLabel.hidden = !tab.progressLabel.textContent;
  }
  if (tab.changeLabel) {
    tab.changeLabel.textContent = tab.diskChanged ? 'Changed on disk' : tab.updatedFromDisk ? 'Updated from disk' : '';
    tab.changeLabel.hidden = !tab.changeLabel.textContent;
  }
}

function createViewerShell(tab, save = false) {
  tab.shellMenu?.destroy();
  tab.saveButton = null;
  const root = document.createElement('div'); root.className = 'viewer';
  const actions = document.createElement('div'); actions.className = 'viewer-actions';
  const path = document.createElement('span'); path.className = 'viewer-path'; path.textContent = parentPath(tab.path); path.title = tab.path;
  actions.append(path);
  if (save) {
    const button = document.createElement('button'); button.type = 'button'; buttonIcon(button, 'Save', 'Save'); button.className = 'save-button'; button.disabled = !tab.dirty; button.addEventListener('click', () => saveTab(tab)); actions.append(button); tab.saveButton = button;
  }
  const refresh = document.createElement('button'); refresh.type = 'button'; buttonIcon(refresh, 'RefreshCw', 'Refresh', true);
  refresh.disabled = !!tab.loading || !!tab.transferring || !!tab.dirty;
  refresh.addEventListener('click', () => { if (!tab.dirty) openFile(tab.path, true); });
  tab.refreshButton = refresh; actions.append(refresh);
  tab.progressLabel = document.createElement('span'); tab.progressLabel.className = 'file-load-progress'; tab.progressLabel.setAttribute('role', 'status');
  tab.changeLabel = document.createElement('span'); tab.changeLabel.className = 'file-change-indicator'; tab.changeLabel.setAttribute('role', 'status');
  actions.append(tab.progressLabel, tab.changeLabel); updateFileIndicators(tab);
  const menu = createMenu('File actions'); tab.shellMenu = menu;
  const download = document.createElement('button'); download.type = 'button'; download.disabled = !!tab.loading || !!tab.loadError; download.textContent = 'Download'; download.addEventListener('click', () => downloadTab(tab)); menuAction(menu.panel, download, 'Download');
  const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy path'; copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(tab.path); notify('Path copied'); }
    catch { notify(fallbackCopy(tab.path) ? 'Path copied' : 'Could not copy path'); }
  }); menuAction(menu.panel, copy, 'Copy');
  actions.append(menu.element, tab.progressLabel, tab.changeLabel);
  const body = document.createElement('div'); body.className = 'viewer-body';
  root.append(actions, body);
  return { root, body, actions, menu };
}

function renderTabContent(tab) {
  if (tab.binaryViewer) tab.binaryPreferences = tab.binaryViewer.snapshot();
  tab.binaryViewer?.dispose(); tab.binaryViewer = null;
  tab.imageDispose?.(); tab.imageControls = null; tab.imageDispose = null;
  tab.videoDispose?.(); tab.player = null; tab.videoStream = null; tab.audio = null; tab.videoDispose = null;
  tab.htmlViewer?.dispose(); tab.htmlViewer = null;
  tab.cad?.dispose(); tab.cad = null;
  tab.view?.destroy(); tab.view = null;
  if (tab.url) URL.revokeObjectURL(tab.url);
  const preferred = tab.preferredViewer || preferences.fileOpeners?.[fileExtension(tab.path)];
  const provider = fileViewers.find(value => value.name === preferred) || fileViewers.find(value => value.supports(tab));
  tab.viewer = provider.name;
  let node;
  if (tab.loading || tab.loadError) {
    const shell = createViewerShell(tab);
    shell.body.setAttribute('aria-busy', String(!!tab.loading));
    const message = document.createElement('div'); message.className = 'viewer-message'; message.setAttribute('role', 'status');
    message.textContent = tab.loading ? `Loading ${tab.name}…` : tab.loadError;
    shell.body.append(message); node = shell.root;
  } else node = provider.render(tab);
  tab.node = node; updateFileIndicators(tab);
  tab.node.dataset.path = tab.path;
  if (workbench.panels.has(tab.panelId)) {
    workbench.update(tab.panelId, { title: tab.name, dirty: tab.dirty, element: node, kind: tab.viewer });
  } else {
    workbench.register({
      id: tab.panelId,
      title: tab.name,
      kind: tab.viewer,
      legacyTab: tab.path,

      serialize: () => ({ id: tab.panelId, kind: 'file', title: tab.name, config: { path: tab.path, viewer: tab.viewer, version: tab.version, imageBackground: tab.imageBackground, binary: tab.binaryViewer?.snapshot() || tab.binaryPreferences, ...tab.resume } }),
      element: node,
      beforeClose: () => !tab.dirty || confirm(`Discard unsaved changes to ${tab.name}?`),
      onActivate: () => {
        activeFileTab = tab.path;
        if (!matchMedia('(pointer: coarse), (max-width: 760px)').matches) tab.view?.focus();
      },
      onLayout: () => { tab.view?.requestMeasure(); tab.cad?.resize(); tab.binaryViewer?.resize(); },
      api: {
        openSettings: () => { if (tab.player?.openSettings) tab.player.openSettings(); else if (tab.videoStream?.openSettings) tab.videoStream.openSettings(); else openSettingsGroup(({ text: 'editor', binary:'binary', image: 'image', audio: 'audio', cad: 'cad', html: 'files' })[tab.viewer] || 'files'); },
        save: () => ['text', 'binary'].includes(tab.viewer) ? saveTab(tab) : false,
        download: () => !tab.loading && !tab.loadError ? downloadTab(tab) : false,
        refresh: () => !tab.dirty ? openFile(tab.path, true) : false,
        focus: () => {
          if (tab.view) tab.view.focus();
          else tab.node?.querySelector('.image-viewer-body,.cad-stage,.binary-viewport,iframe,video,audio')?.focus({ preventScroll: true });
        },
        fit: () => tab.cad?.fit(),
        cadState: () => tab.cad?.snapshot(),
      },
      onClose: () => {
        tab.binaryViewer?.dispose(); tab.binaryViewer = null;
        tab.shellMenu?.destroy();
        tab.imageDispose?.(); tab.imageControls = null; tab.imageDispose = null;
        tab.videoDispose?.(); tab.player = null; tab.videoStream = null; tab.audio = null; tab.videoDispose = null;
        tab.htmlViewer?.dispose(); tab.htmlViewer = null;
        tab.cad?.dispose(); tab.cad = null;
        tab.view?.destroy();
        if (tab.url) URL.revokeObjectURL(tab.url);
        fileTabs.delete(tab.path);
        fileOpenings.delete(tab.path);
        if (activeFileTab === tab.path) activeFileTab = '';
      },
    });
  }
}

function renderCadViewer(tab) {
  const shell = createViewerShell(tab);
  const preferences = { ...cadPreferences };
  const cad = createCadViewer({
    path: tab.path, preferences,
    savePreferences: value => {
      const changed = CAD_SHARED_KEYS.filter(key => key !== 'sidebar').some(key => JSON.stringify(cadPreferences[key]) !== JSON.stringify(value[key])) || cadPreferences.sidebar?.side !== value.sidebar?.side;
      const savedChanged = JSON.stringify(cadPreferences) !== JSON.stringify({ ...cadPreferences, ...value });
      cadPreferences = structuredClone({ ...cadPreferences, ...value });
      if (savedChanged) syncPanelPreferences('cad', cadPreferences);
      if (changed) { syncCadSettingsForm(cadPreferences); window.dispatchEvent(new CustomEvent('eya-cad-settings', { detail: { ...cadPreferences, sidebar: { side:cadPreferences.sidebar?.side || 'right' } } })); }
    },
    reload: () => openFile(tab.path, true),
    loadResource: path => readViewerResource(tab, path),
  });
  tab.cad = cad;
  const cadOptions = cad.element.querySelector('.ui-menu[aria-label="CAD options"]');
  menuHeading(cadOptions, 'File');
  for (const action of shell.menu.panel.children) action.removeAttribute('role');
  cadOptions.append(...shell.menu.panel.children);
  shell.menu.destroy(); tab.shellMenu = null;
  cad.element.querySelector('.cad-toolbar')?.prepend(tab.refreshButton);
  cad.element.append(tab.progressLabel, tab.changeLabel);
  shell.actions.remove();
  shell.body.classList.add('cad-body'); shell.body.append(cad.element);
  tab.cadBusy = true;
  cad.load(tab.bytes).then(ok => { if (!ok) tab.version = undefined; }).finally(() => { tab.cadBusy = false; });
  return shell.root;
}

// CAD polling is independent of Files visibility and skips unchanged model transfers.
setInterval(async () => {
  if (document.hidden || !transportReady) return;
  for (const tab of fileTabs.values()) {
    if (!tab.cad || tab.cadBusy || !tab.node?.getClientRects().length || Date.now() - (tab.cadChecked || 0) < tab.cad.state.interval) continue;
    tab.cadBusy = true; tab.cadChecked = Date.now();
    const cad = tab.cad, attempt = connectionId;
    try {
      const meta = await fileRequest('stat', { path: tab.path });
      if (fileTabs.get(tab.path) !== tab || attempt !== connectionId || tab.cad !== cad) continue;
      let changed = !meta.version || meta.version !== tab.version;
      if (!changed) {
        for (const [path, version] of cad.dependencies) {
          const dependency = await fileRequest('stat', { path });
          if (!version || version !== dependency.version) { changed = true; break; }
        }
      }
      setFileChanged(tab, changed);
      if (!changed || !$('file-autoreload').checked || !cad.state.live) continue;
      if (fileTabs.get(tab.path) !== tab || attempt !== connectionId || tab.cad !== cad) continue;
      tab.transferring = true;
      const result = await readFile(tab.path, (loaded, total) => { tab.progressText = `Refreshing · ${fileProgress(loaded, total)}`; updateFileIndicators(tab); });
      if (fileTabs.get(tab.path) !== tab || attempt !== connectionId || tab.cad !== cad) continue;
      if (await cad.load(result.bytes)) {
        tab.bytes = result.bytes; tab.version = result.meta.version; tab.modified = result.meta.modified;
        setFileChanged(tab, false, true);
        workspaces.changed();
      }
    } catch (cause) { cad.setStatus(`Keeping previous model. ${cause.message || cause}`); }
    finally { tab.cadBusy = false; tab.transferring = false; updateFileIndicators(tab); }
  }
}, 500);

function renderTextEditor(tab) {
  const shell = createViewerShell(tab, tab.bytes.length <= TEXT_EDITOR_LIMIT);
  if (tab.bytes.length > TEXT_EDITOR_LIMIT) {
    const note = document.createElement('p'); note.textContent = 'Large text file · read-only preview of first 5 MiB';
    const preview = document.createElement('pre'); preview.className = 'text-preview-large'; preview.textContent = decoder.decode(tab.bytes.subarray(0, TEXT_EDITOR_LIMIT)); shell.body.append(note, preview); return shell.root;
  }
  const host = document.createElement('div'); host.className = 'editor-host'; shell.body.append(host);
  const text = tab.text ?? decoder.decode(tab.bytes); tab.text = text;
  tab.lineSeparator ??= text.includes('\r\n') ? '\r\n' : '\n';
  const light = $('theme').value === 'light';
  const extensions = [
    EditorState.tabSize.of(Number($('editor-tab-size').value)),
    history(), drawSelection(), highlightActiveLine(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), languageFor(tab.path),
    EditorView.domEventHandlers({ keydown(event, view) {
      if (matchesKeybind('editor.save', event)) { event.preventDefault(); saveTab(tab); return true; }
      for (const [id, run] of [['editor.undo', undo], ['editor.redo', redo], ['editor.find', openSearchPanel]]) if (matchesKeybind(id, event)) { event.preventDefault(); run(view); return true; }
      return false;
    } }),
    keymap.of([indentWithTab, ...defaultKeymap.filter(binding => !['Mod-z','Mod-Shift-z','Mod-y','Mod-f'].includes(binding.key)), ...historyKeymap.filter(binding => !['Mod-z','Mod-Shift-z','Mod-y'].includes(binding.key))]),
    EditorView.updateListener.of(update => { if (update.docChanged) { tab.text = update.state.doc.sliceString(0, update.state.doc.length, tab.lineSeparator); setTabDirty(tab, true); } }),
    EditorView.theme({ '&': { backgroundColor: 'var(--ui-bg)', color: 'var(--ui-fg)' }, '.cm-content': { caretColor: 'var(--ui-accent)' }, '.cm-gutters': { backgroundColor: 'var(--ui-surface)', color: 'var(--ui-muted)', border: 'none' }, '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--ui-accent)' }, '.cm-activeLine,.cm-activeLineGutter': { backgroundColor: 'var(--ui-control)' } }, { dark: !light }),
  ];
  if ($('editor-line-numbers').checked) extensions.push(lineNumbers());
  if ($('editor-wrap').checked) extensions.push(EditorView.lineWrapping);
  tab.view = new EditorView({ state: EditorState.create({ doc: text, extensions }), parent: host });
  return shell.root;
}

function renderImageViewer(tab) {
  const shell = createViewerShell(tab);
  tab.url = URL.createObjectURL(new Blob([tab.bytes], { type: mediaType(tab.path) }));
  const image = document.createElement('img'); image.src = tab.url; image.alt = tab.name;
  const controls = createImageViewer(shell.body, image, { background: tab.imageBackground || preferences.image, download: () => downloadBlob(tab.path, tab.bytes), onBackgroundChange: value => { tab.imageBackground = value; workspaces.changed(); } });
  tab.imageControls = controls; tab.imageDispose = controls.dispose; shell.actions.insertBefore(controls.backgroundControl, shell.menu.element);
  for (const [label, name, action] of [['Zoom out', 'ZoomOut', controls.zoomOut], ['Zoom in', 'ZoomIn', controls.zoomIn], ['Reset image view', 'RotateCcw', controls.reset]]) {
    const button = document.createElement('button'); button.type = 'button'; buttonIcon(button, name, label, true); button.addEventListener('click', action); shell.actions.insertBefore(button, shell.menu.element);
  }
  const copy = document.createElement('button'); copy.type = 'button'; buttonIcon(copy, 'Copy', 'Copy image', true);
  copy.onclick = async () => {
    copy.disabled = true;
    try { await controls.copyImage(); notify('Image copied'); }
    catch (cause) { notify(cause.message || 'Could not copy image'); }
    finally { copy.disabled = false; }
  };
  shell.actions.insertBefore(copy, shell.menu.element);
  return shell.root;
}
function renderVideoViewer(tab) {
  const shell = createViewerShell(tab);
  shell.body.classList.add('video-viewer-body');
  const subtitleSession = resumableSession;
  let closed = false, setSubtitles;
  const scanSubtitles = () => discoverSubtitles(tab.path, fileRequest, readFileRange, () => !closed && resumableSession === subtitleSession).then(tracks => { if (!closed) setSubtitles?.(tracks); }).catch(error => { if (!closed) notify(`Subtitles: ${error.message}`); });
  if (tab.streaming) {
    const frame = document.createElement('iframe'); frame.className = 'native-video-frame'; frame.title = `Video: ${tab.name}`; frame.allowFullscreen = true; frame.allow = 'fullscreen';
    const stream = nativeVideoStream(frame, { url: resumableSession.url, size: tab.size, mime: mediaType(tab.path), preferences: preferences.video, onSettingsChange: value => syncPanelPreferences('video', value), onGlobalShortcut: runGlobalShortcut, resume: tab.resume, onState: value => { tab.resume = value; workspaces.changed(); }, read: (offset, length) => readVideoRange(tab, offset, length), onError: error => notify(error.message || 'Video streaming failed') });
    tab.videoStream = stream;
    const unsubscribe = lifecycle.subscribe(state => { if (state.ready) stream.recover(); });
    setSubtitles = tracks => stream.setSubtitles(tracks);
    tab.videoDispose = () => { closed = true; unsubscribe(); stream.dispose(); }; shell.body.append(frame);
  } else {
    const video = document.createElement('video');
    tab.url = URL.createObjectURL(new Blob([tab.bytes], { type: mediaType(tab.path) })); video.src = tab.url;
    const player = createVideoControls(video, { preferences: preferences.video, onSettingsChange: value => syncPanelPreferences('video', value) }); tab.player = player;
    video.addEventListener('loadedmetadata', () => { video.currentTime = Math.min(tab.resume.time || 0, Number.isFinite(video.duration) ? video.duration : 0); if (tab.resume.paused === false) video.play().catch(() => {}); }, { once: true });
    let lastState = 0;
    const savePosition = () => { if (Date.now() - lastState < 2000 || !Number.isFinite(video.currentTime)) return; lastState = Date.now(); tab.resume = { time: video.currentTime, paused: video.paused }; workspaces.changed(); };
    video.addEventListener('timeupdate', savePosition); video.addEventListener('pause', savePosition);
    setSubtitles = tracks => player.addSubtitles(tracks);
    tab.videoDispose = () => { closed = true; player.dispose(); }; shell.body.append(player.element);
  }
  scanSubtitles();
  return shell.root;
}
function renderAudioViewer(tab) {
  const shell = createViewerShell(tab);
  tab.url = URL.createObjectURL(new Blob([tab.bytes], { type: mediaType(tab.path) }));
  const audio = document.createElement('audio'); audio.src = tab.url; audio.controls = true; audio.preload = 'metadata'; audio.playbackRate = preferences.audio.speed; audio.loop = preferences.audio.loop; tab.audio = audio;
  audio.addEventListener('ratechange', () => syncPanelPreferences('audio', { speed: audio.playbackRate, loop: audio.loop })); shell.body.append(audio); return shell.root;
}
function renderHtmlViewer(tab) {
  const shell = createViewerShell(tab);
  const viewer = createHtmlViewer(tab, { readResource: path => readViewerResource(tab, path), openFile: path => openFile(path) });
  tab.htmlViewer = viewer;
  shell.body.append(viewer.element);
  return shell.root;
}
function renderMarkdownViewer(tab) {
  const shell = createViewerShell(tab);
  tab.htmlViewer = createMarkdownViewer(tab, { readResource: (path, maxBytes) => readViewerResource(tab, path, maxBytes), openFile: path => openFile(path), openLink: openWebLink });
  shell.body.append(tab.htmlViewer.element); return shell.root;
}
function renderBinaryViewer(tab) {
  const shell = createViewerShell(tab, true);
  tab.binaryViewer = createBinaryViewer({ bytes: tab.bytes, preferences:{ ...preferences.binary, ...tab.binaryPreferences }, openSettings:() => openSettingsGroup('binary'), onPreferencesChange: value => {
    const binary = normalizeSettings({binary:value}).binary;
    syncPanelPreferences('binary', binary);
    for (const other of fileTabs.values()) if (other !== tab && other.binaryViewer) other.binaryViewer.applyPreferences(binary);
    workspaces.changed();
  }, onChange:value => setTabDirty(tab,value.dirty) });
  shell.body.addEventListener('keydown', event => {
    if (matchesKeybind('editor.save', event)) { event.preventDefault(); event.stopPropagation(); saveTab(tab); }
  }, { capture: true });
  const binary = tab.binaryViewer;
  menuHeading(binary.menuPanel, 'File');
  menuAction(binary.menuPanel, tab.saveButton, 'Save', 'Save');
  menuAction(binary.menuPanel, tab.refreshButton, 'RefreshCw', 'Refresh');
  binary.menuPanel.append(...shell.menu.panel.children); shell.menu.destroy(); tab.shellMenu = null;
  binary.fileStatusElement.append(tab.progressLabel, tab.changeLabel); shell.actions.remove();
  shell.body.append(tab.binaryViewer.element); return shell.root;
}
function renderGenericViewer(tab) {
  const shell = createViewerShell(tab);
  const message = document.createElement('div'); message.className = 'viewer-message'; message.textContent = 'Preview unavailable'; shell.body.append(message); return shell.root;
}

function activateFileTab(path) {
  if (path === 'browser') {
    if (!workbench.isOpen('browser')) setPanelVisible(true);
    else workbench.activate('browser');
    return;
  }
  const tab = fileTabs.get(path);
  if (!tab) return;
  if (!workbench.isOpen(tab.panelId)) workbench.open(tab.panelId, { groupId: workbench.groupOf('browser') });
  else workbench.activate(tab.panelId);
}
function closeFileTab(path) {
  const tab = fileTabs.get(path); if (!tab) return;
  workbench.close(tab.panelId);
}
function setTabDirty(tab, dirty) {
  if (tab.dirty === dirty) return;
  tab.dirty = dirty;
  updateFileIndicators(tab);
  if (tab.saveButton) tab.saveButton.disabled = !dirty || !!tab.saving || !!tab.renaming;
  workbench.update(tab.panelId, { dirty });
}
async function saveTab(tab) {
  if (tab.saving || tab.renaming || !tab.saveButton || !['text','binary'].includes(tab.viewer)) return;
  tab.saving = true;
  const savedText = tab.text ?? '';
  const binary = tab.binaryViewer, revision = binary?.revision;
  try {
    tab.saveButton.disabled = true; $('file-status').textContent = `Saving ${tab.path}…`;
    const bytes = binary ? binary.getBytes() : encoder.encode(savedText);
    await uploadBytes(tab.path, bytes, true, tab.version);
    if (fileTabs.get(tab.path) !== tab) return;
    const verified = await readFile(tab.path);
    if (fileTabs.get(tab.path) !== tab) return;
    if (verified.bytes.length !== bytes.length || !verified.bytes.every((byte, index) => byte === bytes[index])) throw Error('File changed immediately after saving. Refresh and resolve the conflict before another save.');
    tab.version = verified.meta.version; setFileChanged(tab, false); workspaces.changed();
    tab.bytes = bytes; tab.size = bytes.length; binary?.markSaved(revision); setTabDirty(tab, binary ? binary.dirty : (tab.text ?? '') !== savedText); $('file-status').textContent = `${tab.name} saved.`;
    notify(tab.dirty ? `${tab.name}: saved; newer edits remain unsaved` : `${tab.name} saved`);
    for (const panel of workbench.panels.values()) if (panel.kind === 'browser') panel.api?.refresh?.();
  } catch (cause) {
    if (fileTabs.get(tab.path) === tab) { setTabDirty(tab, true); fileFailure(cause); notify(`Could not save ${tab.name}: ${cause.message || cause}. Your edits are retained.`); }
  } finally {
    tab.saving = false;
    if (tab.saveButton) tab.saveButton.disabled = !tab.dirty;
  }
}
function downloadBlob(path, bytes) {
  const url = URL.createObjectURL(new Blob([bytes])); const link = document.createElement('a'); link.href = url; link.download = baseName(path); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadTab(tab) { if (tab.streaming) { downloadEntry({ path: tab.path, name: tab.name }); return; } downloadBlob(tab.path, tab.binaryViewer ? tab.binaryViewer.getBytes() : tab.viewer === 'text' && tab.text !== undefined ? encoder.encode(tab.text) : tab.bytes); }
function updateEditorConfiguration() { for (const tab of fileTabs.values()) if (tab.viewer === 'text') renderTabContent(tab); }

$('file-close').onclick = () => setPanelVisible(false);
const legacyPathValue = () => $('file-path').value.startsWith('/') ? $('file-path').value : `${currentPath}/${$('file-path').value}`;
const legacySearchSuggestions = () => $('file-search').value.trim() ? directoryEntries.filter(item => item.name.toLocaleLowerCase().includes($('file-search').value.trim().toLocaleLowerCase())) : [];
$('file-path').addEventListener('input', () => { if ($('file-path').value.endsWith('../')) { const path = normalizeFilePath(legacyPathValue()); $('file-path').value = path + (path === '/' ? '' : '/'); } });
legacyPathCombo = createFileCombobox($('file-path'), { label: 'Directory suggestions', async suggestions() {
  const value = legacyPathValue(), end = value.lastIndexOf('/'), prefix = value.slice(end + 1).toLocaleLowerCase();
  const response = await fileRequest('list', { path: normalizeFilePath(value.slice(0, end) || '/'), showHidden: $('show-hidden').checked });
  return response.entries.filter(item => item.name.toLocaleLowerCase().startsWith(prefix));
}, choose: activateEntry, complete: item => { $('file-path').value = item.path + (item.kind === 'directory' ? '/' : ''); } });
legacySearchCombo = createFileCombobox($('file-search'), { label: 'File search suggestions', suggestions: legacySearchSuggestions, choose: activateEntry,
  complete: item => { $('file-search').value = item.name; clearTimeout(fileSearchTimer); fileNavigationGeneration++; fileSearchTimer = setTimeout(searchFiles, 0); } });
$('file-go').onclick = () => navigateTo(normalizeFilePath(legacyPathValue()), true);
$('file-path').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); navigateTo(normalizeFilePath(legacyPathValue()), true); } });
$('file-refresh').onclick = () => refreshFiles(false);
$('file-up').onclick = () => navigateTo(parentPath(currentPath), true);
$('file-back').onclick = () => { if (historyIndex > 0) { historyIndex--; navigateTo(historyPaths[historyIndex], false); } };
$('file-forward').onclick = () => { if (historyIndex < historyPaths.length - 1) { historyIndex++; navigateTo(historyPaths[historyIndex], false); } };
$('file-search').addEventListener('input', event => {
  clearTimeout(fileSearchTimer); fileNavigationGeneration++;
  if (event.isComposing) return;
  let value = $('file-search').value, root = legacySearchRoot || currentPath;
  while (value.startsWith('../')) { root = parentPath(root); value = value.slice(3); }
  if (value !== $('file-search').value) { $('file-search').value = value; legacySearchRoot = root; }
  fileSearchTimer = setTimeout(searchFiles, 350);
});
$('file-search').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); clearTimeout(fileSearchTimer); legacySearchCombo.close(); searchFiles(); } });
$('show-hidden').addEventListener('change', () => { if (currentPath && outbound) navigateTo(currentPath, false); });
$('file-new-folder').onclick = async () => {
  const name = prompt('New folder name:'); if (!name) return;
  try { await fileRequest('mkdir', { path: `${currentPath}/${name}` }); await navigateTo(currentPath, false); } catch (cause) { fileFailure(cause); }
};
attachFileDropzone(browserPanelElement, { input: $('file-upload-input'), button: $('file-upload'), async onFiles(files) {
  const destination = currentPath;
  if (!destination) { fileFailure(Error('Connect to browse files')); return; }
  for (const file of files) {
    const path = `${destination}/${file.name}`;
    try { $('file-status').textContent = `Uploading ${file.name}…`; await uploadBytes(path, file, false); }
    catch (cause) {
      if (cause.message.includes('already exists') && confirm(`${file.name} already exists. Replace it?`)) {
        try { await uploadBytes(path, file, true); } catch (retryCause) { fileFailure(retryCause); break; }
      } else { fileFailure(cause); break; }
    }
  }
  if (currentPath === destination) await navigateTo(currentPath, false);
} });
async function downloadEntry(item) {
  try { $('file-status').textContent = `Downloading ${item.name}…`; const result = await readFile(item.path); downloadBlob(item.path, result.bytes); $('file-status').textContent = `${item.name} downloaded.`; } catch (cause) { fileFailure(cause); }
}
async function renameEntry(item) {
  const name = prompt('New name:', item.name); if (!name || name === item.name) return;
  try { await renameFile(item.path, name); await navigateTo(currentPath, false); } catch (cause) { fileFailure(cause); }
}
async function renameFile(path, newPath) {
  const parts = [];
  for (const part of (newPath.startsWith('/') ? newPath : `${parentPath(path)}/${newPath}`).split('/')) {
    if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part);
  }
  const destination = '/' + parts.join('/');
  if (destination === path) return;
  const affected = [...fileTabs.values()].filter(tab => tab.path === path || tab.path.startsWith(path + '/'));
  for (const tab of affected) {
    if (tab.saving) throw Error('Wait for the file save to finish before renaming.');
    const target = destination + tab.path.slice(path.length);
    if (fileTabs.has(target) && !affected.includes(fileTabs.get(target))) throw Error('Close the destination editor before renaming.');
  }
  for (const tab of affected) { tab.renaming = true; if (tab.saveButton) tab.saveButton.disabled = true; }
  try {
  const response = await fileRequest('rename', { path, newPath });
  const renamed = response.path || destination;
  for (const tab of affected) {
    if (fileTabs.get(tab.path) !== tab) continue;
    const old = tab.path; fileTabs.delete(old);
    tab.path = renamed + old.slice(path.length); tab.name = baseName(tab.path); fileTabs.set(tab.path, tab);
    if (activeFileTab === old) activeFileTab = tab.path;
    const panel = workbench.panels.get(tab.panelId);
    if (panel) panel.legacyTab = tab.path;
    if (tab.cad) renderTabContent(tab);
    else {
      tab.node.dataset.path = tab.path;
      const label = tab.node.querySelector('.viewer-path');
      if (label) { label.textContent = parentPath(tab.path); label.title = tab.path; }
      workbench.update(tab.panelId, { title: tab.name });
    }
  }
  } finally { for (const tab of affected) { tab.renaming = false; if (tab.saveButton) tab.saveButton.disabled = !tab.dirty || !!tab.saving; } }
}
function prepareFileDeletion(items) {
  const affected = [...fileTabs.values()].filter(tab => items.some(item => tab.path === item.path || (item.kind === 'directory' && tab.path.startsWith(item.path + '/'))));
  if (affected.some(tab => tab.saving || tab.renaming)) { notify('Wait for file saves and renames to finish before deleting.'); return false; }
  const dirty = affected.filter(tab => tab.dirty);
  return !dirty.length || confirm(`Delete these files and discard unsaved edits in ${dirty.map(tab => tab.name).join(', ')}?`);
}
function closeDeletedFiles(path) {
  for (const tab of [...fileTabs.values()]) if (tab.path === path || tab.path.startsWith(path + '/')) workbench.close(tab.panelId, true);
}
function deleteEntry(item) {
  if (!browserSelection.has(item.path)) selectEntry(item);
  return browserSelection.remove();
}
for (const button of $('file-entry-menu').querySelectorAll('[data-file-action]')) button.addEventListener('click', () => {
  const item = fileMenuEntry;
  const action = button.dataset.fileAction;
  if (action === 'open' && item?.kind === 'file' && fileOpenerChoices(item.path).length > 1) {
    return; // The shared submenu owns this trigger and its dismissal boundary.
  }
  hideFileEntryMenu();
  if (!item) return;
  if (action === 'open') activateEntry(item);
  else if (action === 'download') downloadEntry(item);
  else if (action === 'copy') browserSelection.copy();
  else if (action === 'rename') renameEntry(item);
  else if (action === 'delete') deleteEntry(item);
});
$('file-entry-menu').addEventListener('pointerdown', event => event.stopPropagation());
$('file-entry-menu').addEventListener('keydown', event => {
  const menu = $('file-entry-menu');
  const items = [...menu.querySelectorAll('button:not([hidden]):not(:disabled)')].filter(button => button.closest('[role=menu]') === menu && !button.closest('[hidden]'));
  const index = items.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault(); const path = fileMenuEntry?.path; hideFileEntryMenu();
    [...$('file-list').rows].find(row => row.dataset.path === path)?.querySelector('button')?.focus();
  } else if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  }
});
document.addEventListener('pointerdown', event => { if (!$('file-entry-menu').contains(event.target) && !legacyOpenWith?.contains(event.target) && !event.target.closest?.('.file-entry-button')) hideFileEntryMenu(); });
$('browser-view').addEventListener('scroll', () => {
  if (!fileMenuEntry) return;
  const button = [...$('file-list').rows].find(row => row.dataset.path === fileMenuEntry.path)?.querySelector('.file-entry-button');
  const bounds = button?.getBoundingClientRect(), view = $('browser-view').getBoundingClientRect();
  if (!bounds || bounds.bottom <= view.top || bounds.top >= view.bottom) hideFileEntryMenu();
  else showFileEntryMenu(fileMenuEntry, button);
}, { passive: true });
browserPanelElement.addEventListener('keydown', event => {
  if (browserSelection.keydown(event)) return;
  if (event.target.closest('input,textarea,select,button,.ui-menu,[role=combobox]')) return;
  const rows = [...$('file-list').rows], index = rows.findIndex(row => row.dataset.path === selectedEntry?.path);
  if (['ArrowDown','ArrowUp','Home','End'].includes(event.key) && !event.altKey) {
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    const row = rows[next], item = row && directoryEntries.find(entry => entry.path === row.dataset.path);
    if (row) { selectEntry(item || { path: row.dataset.path, kind: 'parent' }, event); row.focus(); }
  } else if (selectedEntry && selectedEntry.kind !== 'parent' && (matchesKeybind('files.delete', event) || matchesKeybind('files.rename', event))) {
    event.preventDefault(); hideFileEntryMenu();
    if (matchesKeybind('files.rename', event)) renameEntry(selectedEntry); else deleteEntry(selectedEntry);
  } else if (matchesKeybind('files.parent', event)) { event.preventDefault(); navigateTo(parentPath(currentPath), true); }
  else if (matchesKeybind('files.refresh', event)) { event.preventDefault(); refreshFiles(false); }
});

$('start-connection').onclick = async () => {
  cancelCredentialCheck();
  if (!applySettings()) return;
  const connection = validateConnection(); if (!connection) return;
  const key = $('key').value;
  if (!workspaces.getState().workspace) workspaceSettingDefaults = { ...readSettingsControls($('settings-dialog')), keybinds: getKeybinds() };
  if (resumableSession && (resumableSession.url !== connection.url.href || resumableSession.key !== key)) {
    if (workspaces.getState().workspace && !confirm('Switch server? Unsaved workspace changes and editor buffers in this page will be lost.')) return;
    disconnect(); workspaces.reset(); pendingSessionEnds.clear(); resumableSession = null;
  }
  resumableSession ||= { url: connection.url.href, key, client: null, ended: false };
  resumableSession.ended = false; resumableSession.negotiationFailures = 0;
  reconnectEnabled = true; reconnectAttempts = 0;
  connectionFeedback('Connecting…', true); await connectSession();
  clientUpdates.connected();
};

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!reconnectEnabled || !resumableSession || resumableSession.ended) return;
  const delay = Math.min(10000, 500 * 2 ** Math.min(reconnectAttempts++, 5));
  status(`Reconnecting · ${(delay / 1000).toFixed(1)} s`);
  setConnectionAppearance(false);
  reconnectTimer = setTimeout(connectSession, delay);
}
window.addEventListener('online', () => {
  if (reconnectEnabled && !transportReady) { clearTimeout(reconnectTimer); connectSession(); }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && reconnectEnabled && !transportReady) { clearTimeout(reconnectTimer); connectSession(); }
});

async function connectSession() {
  if (!reconnectEnabled || !resumableSession || resumableSession.ended) return;
  const session = resumableSession;
  const attempt = ++connectionId;
  clearTimeout(reconnectTimer); clearTimeout(handshakeTimer); clearTimeout(inputFlushTimer);
  rejectFileRequests('Reconnecting.');
  socket?.close();
  clearInterval(pingTimer);
  socket = outbound = inbound = null;
  transportReady = false;
  failed = false;
  error('');
  $('latency').textContent = '';
  let handshake, current;
  try {
    const psk = deriveKey(session.key);
    if (attempt !== connectionId) return;
    handshake = new Noise('NNpsk0', true, null, { psk });
    handshake.initialise(encoder.encode('eya-terminal-v1'));
    current = new WebSocket(session.url);
  } catch {
    if (attempt === connectionId) {
      reconnectEnabled = false;
      error('Could not start the encrypted connection. Check the URL and browser support.');
      setConnectionAppearance(false);
    }
    return;
  }
  if (attempt !== connectionId) { current.close(); return; }
  socket = current;
  current.binaryType = 'arraybuffer';
  awaitingHandshake = true;
  let lastResponse = Date.now(), opened = false;
  setConnectionAppearance(false);
  status(session.client ? 'Reconnecting…' : 'Connecting…');
  lifecycle.update({ ready: false, generation: attempt, mode: 'automatic', reason: 'Connecting' });
  handshakeTimer = setTimeout(() => { if (socket === current && !transportReady) { if ($('connect-dialog').open) error(connectionError('Connection timed out. Check the server address and password.', !opened)); current.close(); transportClosed(); } }, 12000);
  current.onopen = () => {
    if (socket === current) {
      opened = true;
      try { current.send(handshake.send()); } catch {
        failed = true;
        error('Could not start authentication.');
        current.close(); transportClosed();
      }
    }
  };
  current.onmessage = event => {
    if (socket !== current) return;
    try {
      const data = new Uint8Array(event.data);
      if (awaitingHandshake) {
        handshake.recv(data);
        if (!handshake.complete) throw Error('Incomplete handshake');
        outbound = new Cipher(handshake.tx);
        inbound = new Cipher(handshake.rx);
        awaitingHandshake = false;
        const ready = { client: session.client, capabilities: WIRE_CAPABILITIES };
        if (!send(encoder.encode('eya-workspace-v1:' + JSON.stringify(ready)))) throw Error('Could not confirm the encrypted connection');
      } else {
        if (inbound.nonce >= 0xffffffff) throw Error('Session message limit reached');
        const message = inbound.decrypt(data);
        lastResponse = Date.now();
        if (message[0] === 7) {
          const state = JSON.parse(decoder.decode(message.subarray(1)));
          if (state.state !== 'ready') {
            session.ended = true; reconnectEnabled = false; transportReady = false;
            session.pending = [];
            status(state.message || 'Session ended — start a new session');
            if (state.state !== 'ended') error(state.message || 'The session could not be resumed.');
            $('start-connection').textContent = 'Start new session';
            current.close(); transportClosed(); return;
          }
          wireCapabilities = selectedCapabilities(state);
          session.client = state.client; transportReady = true; reconnectAttempts = 0;
          session.negotiationFailures = 0;
          clearTimeout(handshakeTimer); error('');
          setConnectionAppearance(true); status(''); $('status').title = 'Encrypted connection'; $('start-connection').textContent = 'Connect';
          connectionFeedback('', false); closeDialog($('connect-dialog'));
          const initialPing = new Uint8Array(9); initialPing[0] = 3; new DataView(initialPing.buffer).setFloat64(1, performance.now()); send(initialPing);
          clientUpdates.connected();
          lifecycle.update({ ready: true, generation: attempt, mode: 'automatic', reason: '' });
          for (const session of pendingSessionEnds) endRemote(session);
          for (const panel of workbench.panels.values()) panel.api?.resume?.();
          workspaces.authenticated(state).then(result => {
            if (!result?.openedInitial || session.startupAttempted || session !== resumableSession || attempt !== connectionId || !transportReady || workspaces.getState().workspace?.id !== result.workspace.id) return;
            // Startup is one action per client/server connection identity. A
            // later reconnect must never create another shell or repeat work.
            session.startupAttempted = true;
            if (startupPanel === 'none') return;
            if (startupPanel === 'start') { workbench.openStart(); return; }
            return workbench.create(startupPanel);
          }).catch(cause => error(cause.message));
          restartFileRefresh();
          clearInterval(pingTimer);
          pingTimer = setInterval(() => {
            if (Date.now() - lastResponse > 15000) { current.close(); transportClosed(); return; }
            const ping = new Uint8Array(9); ping[0] = 3;
            new DataView(ping.buffer).setFloat64(1, performance.now()); send(ping);
          }, 5000);
        } else if (message[0] === 12 && transportReady) {
          receiveExtension(message, wireCapabilities);
        } else if (message[0] === 3 && message.length === 9) {
          const sent = new DataView(message.buffer, message.byteOffset, message.byteLength).getFloat64(1);
          const sample = Math.max(0, performance.now() - sent);
          $('latency').textContent = `${Math.round(sample)} ms`;
        } else if (message[0] === 4) {
          handleFileResponse(JSON.parse(decoder.decode(message.subarray(1))));
        } else if (message[0] === 5 && message.length >= 6) {
          handleFileChunk(message);
        } else if (message[0] === 6 && message.length >= 6) {
          handleFileJsonChunk(message);
        } else throw Error('Unexpected server message');
      }
    } catch {
      failed = true;
      reconnectEnabled = false;
      error(awaitingHandshake ? 'Authentication failed. Check that the shared passwords match.' : 'The encrypted session could not be resumed safely. Reconnect to retry.');
      current.close(); transportClosed();
    }
  };
  current.onerror = () => {
    if (socket === current) {
      failed = true;
      if ($('connect-dialog').open) error(connectionError('Cannot reach the server. Check the address, TLS certificate, and network.', !opened));
      status('Connection interrupted');
    }
  };
  function transportClosed() {
    if (socket === current) {
      socket = null;
      const incompleteNegotiation = opened && !transportReady;
      if (incompleteNegotiation && reconnectEnabled && ++session.negotiationFailures >= 3) {
        reconnectEnabled = false;
        error('Authentication or protocol negotiation could not complete. Check the shared password and server version, then Connect to retry.');
        for (const panel of workbench.panels.values()) panel.api?.detach?.();
      }
      clearInterval(pingTimer);
      clearTimeout(handshakeTimer); clearTimeout(inputFlushTimer);
      rejectFileRequests('Connection interrupted. Mutations may have completed; refresh before retrying.');
      clearInterval(fileRefreshTimer);
      $('latency').textContent = '';
      outbound = inbound = null;
      awaitingHandshake = false; transportReady = false;
      lifecycle.update({ ready: false, generation: connectionId, reason: 'Connection closed', mode: reconnectEnabled ? 'automatic' : 'failed' });
      workspaces.disconnected();
      setConnectionAppearance(false);
      if (reconnectEnabled && !session.ended) scheduleReconnect();
      else if (incompleteNegotiation && !reconnectEnabled) status('Authentication or protocol negotiation failed — Connect to retry');
      else if (!session.ended) status('Disconnected');
    }
  }
  current.onclose = transportClosed;
}

let workspaceSettingDefaults = { ...normalizeSettings(config), keybinds: config.keybinds || {} };
const workspaces = createWorkspaces({
  workbench, request: fileRequest, isReady: () => transportReady,
  getPreferences: () => ({ ...workspacePreferences, keybinds: getKeybinds() }),
  onWorkspaceChange: () => { workspaceGeneration++; fileNavigationGeneration++; fileOpenings.clear(); browserSelection.clear(); currentPath = ''; historyPaths = []; historyIndex = -1; hideFileEntryMenu(); },
  applyPreferences: value => {
    setKeybinds(value.keybinds ?? workspaceSettingDefaults.keybinds ?? {});
    const selected = structuredClone(workspaceSettingDefaults);
    for (const field of SETTINGS_FIELDS) { const found = getSetting(value, field); if (found !== undefined) setSetting(selected, field, found); }
    writeSettingsControls($('settings-dialog'), normalizeSettings(selected));
    workspacePreferences = structuredClone(value);
    applySettings();
    workspacePreferences = { ...value, ...workspacePreferences };
  },
  restoreTab: async descriptor => {
    if (descriptor.kind === 'file') { await loadFile(descriptor.config.path, false, descriptor); return; }
    if (descriptor.kind === 'start') {
      workbench.openStart(undefined, descriptor.id);
      return;
    }
    if (descriptor.id === 'browser' && descriptor.kind === 'files') {
      workbench.open('browser'); await navigateTo(descriptor.config.cwd || '', true); return;
    }
    await workbench.create(descriptor.kind, { id: descriptor.id, ...descriptor.config, session: descriptor.session, restoring: true });
  },
});
$('connect').before(workspaces.label, workspaces.sync);
workbench.beforeCreate = () => { if (!workspaces.getState().workspace) throw Error('Connect and select or create a workspace first.'); };
window.EyaWorkspaces = { getState: workspaces.getState, open: workspaces.open, save: () => { workspaces.changed(); return workspaces.save(); } };

startControlEnhancement();
openConnection();
