import Noise from 'noise-handshake';
import Cipher from 'noise-handshake/cipher';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { PanelWorkbench } from './panels.js';
import { createCadViewer, isCadFile } from './cad.js';
import { createTerminalPanel } from './terminal-panel.js';
import { createFileBrowser } from './file-browser.js';
import { createTaskManager, createDockerPanel } from './system-panels.js';
import { icon, buttonIcon, createMenu, menuAction, menuHeading, closeMenus, notify, startControlEnhancement, attachFileDropzone } from './ui.js';

// Chromium exposes this legacy method on SVG documents but throws when xterm probes it.
try { document.queryCommandSupported?.('copy'); }
catch { Object.defineProperty(document, 'queryCommandSupported', { configurable: true, value: () => false }); }

const $ = id => document.getElementById(id);
const pageBody = document.body || document.querySelector('body');
const workspaceMenu = createMenu('Workspace menu');
$('app-menu-slot').append(workspaceMenu.element);
menuHeading(workspaceMenu.panel, 'Workspace');
menuAction(workspaceMenu.panel, $('settings'), 'Settings');
menuHeading(workspaceMenu.panel, 'Connection');
menuAction(workspaceMenu.panel, $('disconnect'), 'Unplug');
buttonIcon($('connect'), 'Plug', 'Connect');
buttonIcon($('files'), 'FolderOpen', 'Files');
const fileMenu = createMenu('File browser menu');
$('file-menu-slot').append(fileMenu.element);
menuAction(fileMenu.panel, $('file-new-folder'), 'FolderPlus');
menuAction(fileMenu.panel, $('file-refresh'), 'RefreshCw');
menuHeading(fileMenu.panel, 'Navigate');
menuAction(fileMenu.panel, $('file-up'), 'ArrowUp');
menuAction(fileMenu.panel, $('file-forward'), 'ArrowRight');
menuHeading(fileMenu.panel, 'Panel');
menuAction(fileMenu.panel, $('file-close'), 'X');
buttonIcon($('file-back'), 'ArrowLeft', 'Back', true);
buttonIcon($('file-go'), 'ArrowRight', 'Go', true);
buttonIcon($('file-upload'), 'Upload', 'Upload', true);
$('path-toolbar').prepend(icon('Search'));
for (const [action, name] of Object.entries({ open: 'File', download: 'Download', rename: 'Pencil', delete: 'Trash2' })) {
  const button = $('file-entry-menu').querySelector(`[data-file-action=${action}]`);
  buttonIcon(button, name); button.setAttribute('role', 'menuitem');
}
const encoder = new TextEncoder();
const MAX_COMMAND_LENGTH = 8192;
let config = {};
try { config = JSON.parse($('eya-config').textContent) || {}; } catch { /* Defaults are safe. */ }
let preferences = {};
try { preferences = JSON.parse(localStorage.getItem('eya-settings') || '{}') || {}; } catch { /* Storage is optional. */ }
let cadPreferences = {};
try { cadPreferences = JSON.parse(localStorage.getItem('eya-cad-settings') || '{}') || {}; } catch { /* Storage is optional. */ }
const CAD_SHARED_KEYS = ['mode', 'gridPlanes', 'axisCoordinates', 'sectionGizmos', 'rotationGizmo', 'navigationMode', 'orbitStyle', 'movementSpeed', 'lookSpeed', 'invertLook', 'hoverHighlights', 'measurementColor', 'measurementPointSize', 'selectionColor', 'selectionMode'];
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
const terminal = new Terminal({ cursorBlink, cursorStyle, fontSize, scrollback, scrollOnUserInput, rightClickSelectsWord: true, theme: themes[theme] });
const fit = new FitAddon();
terminal.loadAddon(fit); terminal.open($('terminal')); fit.fit();

let socket, outbound, inbound, awaitingHandshake = false, pingTimer, failed = false, connectionId = 0;
let resumableSession = null, transportReady = false, reconnectTimer, handshakeTimer, inputFlushTimer, reconnectAttempts = 0, reconnectEnabled = false;
const MAX_PENDING_INPUT = 256 * 1024;
let ctrlArmed = false;
let viewportFrame;
let directionTimer, directionInterval, activeDirection = '', directionGesture, directionData = '';
let touchGesture;
let fileRequestId = 0, fileRefreshTimer, fileSearchTimer;
let fileNavigationPending = 0, fileNavigationGeneration = 0;
let currentPath = '', directoryEntries = [], selectedEntry, historyPaths = [], historyIndex = -1;
let fileMenuEntry;
let activeFileTab = 'browser';
const filePending = new Map();
const fileTabs = new Map();
const fileOpenings = new Map();
const decoder = new TextDecoder();
const fatalDecoder = new TextDecoder('utf-8', { fatal: true });
const TEXT_EDITOR_LIMIT = 5 * 1024 * 1024;
const terminalPanelElement = $('terminal-pane');
const connectionNotice = document.createElement('div');
connectionNotice.id = 'connection-notice'; connectionNotice.setAttribute('role', 'status');
connectionNotice.hidden = true; terminalPanelElement.append(connectionNotice);
const browserPanelElement = $('file-panel');
const workbench = new PanelWorkbench($('workspace'));
workbench.register({
  id: 'terminal', title: 'Terminal', kind: 'terminal', element: terminalPanelElement, retain: true,
  onActivate: () => { activeFileTab = ''; scheduleResize(); },
  onLayout: scheduleResize,
  api: { focus: () => terminal.focus(), sendInput: text => sendInput(String(text)), clear: () => terminal.clear() },
});
workbench.register({
  id: 'browser', title: 'Files', kind: 'browser', legacyTab: 'browser', element: browserPanelElement, retain: true,
  onActivate: () => {
    activeFileTab = 'browser';
    if (outbound && !currentPath) navigateTo($('starting-directory').value.trim(), true);
  },
  onClose: () => {
    pageBody.classList.remove('panel-visible');
    $('files').setAttribute('aria-pressed', 'false');
  },
  api: { navigate: path => navigateTo(path), refresh: () => refreshFiles(false), getPath: () => currentPath,
    focusPath: () => $('file-path').focus(), focusSearch: () => $('file-search').focus() },
});
workbench.open('terminal');

async function deriveKey(secret) {
  // Keep generated clients compatible with the original hexadecimal key format.
  if (/^[0-9a-f]{64}$/i.test(secret)) return Uint8Array.from(secret.match(/../g), hex => parseInt(hex, 16));
  if (!crypto?.subtle) throw Error('This browser cannot derive a key from a password.');
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(secret)));
}

function inheritedWebSocketUrl() {
  if (!['http:', 'https:'].includes(location.protocol)) return '';
  const url = new URL('ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
const inheritedUrl = inheritedWebSocketUrl();
try { $('url').value = config.url || (config.hosted ? inheritedUrl : localStorage.getItem('eya-url')) || inheritedUrl; }
catch { $('url').value = config.url || inheritedUrl; }
$('key').value = config.key || '';
$('default-command').value = typeof config.defaultCommand === 'string' ? config.defaultCommand : '';
$('font-size').value = fontSize;
$('scrollback').value = scrollback;
$('theme').value = theme;
$('ui-density').value = ['comfortable', 'compact'].includes(preferences.uiDensity) ? preferences.uiDensity : 'comfortable';
$('ui-style').value = ['default', 'rounded', 'square'].includes(preferences.uiStyle) ? preferences.uiStyle : 'default';
$('accent-color').value = ['mint', 'blue', 'violet', 'amber'].includes(preferences.accentColor) ? preferences.accentColor : 'mint';
$('reduce-motion').checked = validBoolean(preferences.reduceMotion, matchMedia('(prefers-reduced-motion: reduce)').matches);
$('editor-font-size').value = validNumber(preferences.editorFontSize, 12, 28, 16);
$('editor-tab-size').value = [2, 4, 8].includes(preferences.editorTabSize) ? preferences.editorTabSize : 4;
$('file-details').checked = validBoolean(preferences.fileDetails, true);
$('cad-display-mode').value = validChoice(cadPreferences.mode, ['shaded', 'edges', 'wireframe'], 'edges');
$('cad-grid-planes').value = validChoice(cadPreferences.gridPlanes, ['off', 'xy', 'all'], cadPreferences.grid === false ? 'off' : 'all');
$('cad-axis-coordinates').checked = validBoolean(cadPreferences.axisCoordinates, true);
$('cad-section-gizmos').checked = validBoolean(cadPreferences.sectionGizmos, true);
$('cad-rotation-gizmo').checked = validBoolean(cadPreferences.rotationGizmo, true);
$('cad-navigation-mode').value = validChoice(cadPreferences.navigationMode, ['orbit', 'firstPerson'], 'orbit');
$('cad-orbit-style').value = validChoice(cadPreferences.orbitStyle, ['turntable', 'free'], 'turntable');
$('cad-movement-speed').value = validDecimal(cadPreferences.movementSpeed, 0.25, 4, 1);
$('cad-look-speed').value = validDecimal(cadPreferences.lookSpeed, 0.25, 3, 1);
$('cad-invert-look').checked = validBoolean(cadPreferences.invertLook, false);
$('cad-hover-highlights').checked = validBoolean(cadPreferences.hoverHighlights, true);
$('cad-measurement-color').value = validColor(cadPreferences.measurementColor, '#ff4f9a');
$('cad-measurement-point-size').value = validDecimal(cadPreferences.measurementPointSize, 0.5, 3, 1.5);
$('cad-selection-color').value = validColor(cadPreferences.selectionColor, '#66ff99');
$('cad-selection-mode').value = validChoice(cadPreferences.selectionMode, ['part', 'face', 'loop'], 'face');
$('cursor-blink').checked = cursorBlink;
$('cursor-style').value = cursorStyle;
$('scroll-on-input').checked = scrollOnUserInput;
$('refresh-interval').value = refreshInterval;
$('show-hidden').checked = showHidden;
$('editor-wrap').checked = editorWrap;
$('editor-line-numbers').checked = editorLineNumbers;
$('confirm-delete').checked = confirmDelete;
$('starting-directory').value = startingDirectory;
applyAppearance();
pageBody.classList.add('connection-offline');
$('files').setAttribute('aria-pressed', 'false');

function syncCadSettingsForm(value) {
  if (['shaded', 'edges', 'wireframe'].includes(value.mode)) $('cad-display-mode').value = value.mode;
  if (['off', 'xy', 'all'].includes(value.gridPlanes)) $('cad-grid-planes').value = value.gridPlanes;
  if (['orbit', 'firstPerson'].includes(value.navigationMode)) $('cad-navigation-mode').value = value.navigationMode;
  if (['turntable', 'free'].includes(value.orbitStyle)) $('cad-orbit-style').value = value.orbitStyle;
  if (['part', 'face', 'loop'].includes(value.selectionMode)) $('cad-selection-mode').value = value.selectionMode;
  for (const [key, id] of [['axisCoordinates', 'cad-axis-coordinates'], ['sectionGizmos', 'cad-section-gizmos'], ['rotationGizmo', 'cad-rotation-gizmo'], ['invertLook', 'cad-invert-look'], ['hoverHighlights', 'cad-hover-highlights']]) if (typeof value[key] === 'boolean') $(id).checked = value[key];
  for (const [key, id] of [['movementSpeed', 'cad-movement-speed'], ['lookSpeed', 'cad-look-speed'], ['measurementPointSize', 'cad-measurement-point-size']]) if (Number.isFinite(Number(value[key]))) $(id).value = value[key];
  for (const [key, id] of [['measurementColor', 'cad-measurement-color'], ['selectionColor', 'cad-selection-color']]) if (/^#[\da-f]{6}$/i.test(value[key] || '')) $(id).value = value[key];
}

function status(text) {
  $('status').textContent = text;
  if (!transportReady) connectionNotice.textContent = text;
}
function error(text) { $('error').textContent = text; $('error').hidden = !text; }
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
    error('Could not send encrypted terminal data.');
    socket.close();
    return false;
  }
}
function offsetMessage(type, offset) {
  const message = new Uint8Array(9); message[0] = type;
  new DataView(message.buffer).setBigUint64(1, BigInt(offset));
  return message;
}
function readOffset(message, offset = 1) {
  const value = Number(new DataView(message.buffer, message.byteOffset, message.byteLength).getBigUint64(offset));
  if (!Number.isSafeInteger(value)) throw Error('Terminal sequence limit reached.');
  return value;
}
function acknowledgeInput(offset) {
  const session = resumableSession;
  if (!session || !Number.isSafeInteger(offset) || offset < session.inputAck || offset > session.input) throw Error('Invalid input acknowledgement');
  session.inputAck = offset;
  while (session.pending[0] && session.pending[0].offset + session.pending[0].bytes.length <= offset) session.pending.shift();
}
function flushInput() {
  clearTimeout(inputFlushTimer);
  if (!transportReady || !resumableSession || resumableSession.ending) return;
  for (const entry of resumableSession.pending) {
    if (entry.sent === connectionId) continue;
    if (socket?.bufferedAmount > 512 * 1024) { inputFlushTimer = setTimeout(flushInput, 20); return; }
    const message = new Uint8Array(9 + entry.bytes.length);
    message.set(offsetMessage(0, entry.offset)); message.set(entry.bytes, 9);
    if (!send(message)) return;
    entry.sent = connectionId;
  }
}
function sendInput(data) {
  const session = resumableSession;
  if (!session || session.ended || session.ending) return false;
  const bytes = encoder.encode(data);
  if (session.input - session.inputAck + bytes.length > MAX_PENDING_INPUT) {
    error('The pending input buffer is full (256 KiB). Wait for reconnection before typing more.');
    return false;
  }
  for (let i = 0; i < bytes.length; i += 60000) {
    const chunk = bytes.slice(i, i + 60000);
    session.pending.push({ offset: session.input, bytes: chunk, sent: -1 });
    session.input += chunk.length;
  }
  flushInput();
  if (!transportReady) status(`${reconnectEnabled ? 'Reconnecting' : 'Disconnected'} — session retained; ${session.input - session.inputAck} input bytes buffered`);
  return true;
}
function setCtrlArmed(value) {
  ctrlArmed = value;
  $('ctrl-key').classList.toggle('active', value);
  $('ctrl-key').setAttribute('aria-pressed', String(value));
}
function applyCtrl(data) {
  if (!ctrlArmed || !data) return data;
  setCtrlArmed(false);
  const code = data.charCodeAt(0);
  let control;
  if (code >= 0x40 && code <= 0x5f) control = code - 0x40;
  else if (code >= 0x60 && code <= 0x7f) control = code - 0x60;
  else if (code === 0x20) control = 0;
  else return data;
  return String.fromCharCode(control) + data.slice(1);
}
function sendKey(data) {
  if (ctrlArmed) {
    const navigation = /^\x1b\[(?:([ABCDHF])|(\d+)~)$/.exec(data);
    if (navigation) data = navigation[1] ? `\x1b[1;5${navigation[1]}` : `\x1b[${navigation[2]};5~`;
    else if (data === '\x7f') data = '\x17';
    setCtrlArmed(false);
  }
  const active = workbench.activePanel;
  if (active?.kind === 'terminal' && active.id !== 'terminal') { active.api.sendInput(data); active.api.focus(); }
  else { sendInput(data); terminal.focus(); }
  return data;
}
function resize() {
  try { fit.fit(); } catch { return; }
  if (transportReady) {
    const cols = terminal.cols, rows = terminal.rows;
    send(Uint8Array.of(1, cols >> 8, cols & 255, rows >> 8, rows & 255));
  }
}
function scheduleResize() {
  cancelAnimationFrame(viewportFrame);
  viewportFrame = requestAnimationFrame(() => {
    const editing = document.activeElement?.closest?.('.cm-editor');
    if (window.visualViewport && !editing) document.documentElement.style.setProperty('--eya-viewport-height', `${window.visualViewport.height}px`);
    resize();
  });
}
window.addEventListener('resize', scheduleResize);
window.visualViewport?.addEventListener('resize', scheduleResize);
window.visualViewport?.addEventListener('scroll', scheduleResize);
document.addEventListener('focusout', scheduleResize);
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
terminal.onData(data => {
  data = applyCtrl(data);
  sendInput(data);
});

const keyActions = {
  escape: () => sendKey('\x1b'),
  tab: () => sendKey('\t'),
  ctrl: () => { setCtrlArmed(!ctrlArmed); (workbench.activePanel?.api?.focus || (() => terminal.focus()))(); },
  paste: () => pasteFromClipboard(),
  copy: () => copySelection(),
  home: () => sendKey('\x1b[H'), end: () => sendKey('\x1b[F'),
  'page-up': () => sendKey('\x1b[5~'), 'page-down': () => sendKey('\x1b[6~'),
  interrupt: () => { setCtrlArmed(false); sendKey('\x03'); },
  eof: () => { setCtrlArmed(false); sendKey('\x04'); },
  backspace: () => sendKey('\x7f'), enter: () => sendKey('\r'),
};
const keyIcons = {
  escape: ['LogOut','Esc','Escape'], tab: ['IndentIncrease','Tab','Tab'], ctrl: ['Command','Ctrl','Ctrl'],
  home: ['ChevronFirst','Home','Home'], end: ['ChevronLast','End','End'],
  'page-up': ['ChevronsUp','PgUp','Page Up'], 'page-down': ['ChevronsDown','PgDn','Page Down'],
  copy: ['Copy','Copy','Copy selection'], paste: ['ClipboardPaste','Paste','Paste'],
  interrupt: ['Square','^C','Interrupt (Ctrl+C)'], eof: ['LogOut','^D','End of input (Ctrl+D)'],
  backspace: ['Delete','Bksp','Backspace'], enter: ['CornerDownLeft','Enter','Enter'],
};
for (const button of document.querySelectorAll('#keybar [data-key]')) {
  let pointerActivated = false;
  const [glyph, label, accessible] = keyIcons[button.dataset.key];
  buttonIcon(button, glyph, label); button.setAttribute('aria-label', accessible); button.title = accessible;
  button.addEventListener('pointerdown', event => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    pointerActivated = true;
    keyActions[button.dataset.key]?.();
  });
  button.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') pointerActivated = false; });
  button.addEventListener('click', event => {
    // Some mobile browsers synthesize detail=0 clicks after touch pointerdown.
    // Consume that click rather than sending the key twice; keyboard/AT clicks
    // without a preceding pointer activation still work.
    if (pointerActivated) { pointerActivated = false; event.preventDefault(); return; }
    if (event.detail === 0) keyActions[button.dataset.key]?.();
  });
}

const directionKeys = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' };
buttonIcon($('arrow-pad'), 'Move', 'Arrows');
$('arrow-pad').setAttribute('aria-label', 'Arrow key; swipe in a direction, then hold to repeat');
function directionIcon(direction) {
  $('arrow-pad').querySelector('.ui-icon').replaceWith(icon(({up:'ArrowUp',down:'ArrowDown',left:'ArrowLeft',right:'ArrowRight'})[direction] || 'Move'));
}
function directionFromDrag(event) {
  if (!directionGesture || event.pointerId !== directionGesture.pointerId) return '';
  const x = event.clientX - directionGesture.x;
  const y = event.clientY - directionGesture.y;
  if (Math.hypot(x, y) < 10) return '';
  return Math.abs(x) > Math.abs(y) ? (x < 0 ? 'left' : 'right') : (y < 0 ? 'up' : 'down');
}
function stopDirection(event) {
  if (event && directionGesture && event.pointerId !== directionGesture.pointerId) return;
  clearTimeout(directionTimer);
  clearInterval(directionInterval);
  directionTimer = directionInterval = undefined;
  activeDirection = '';
  directionData = '';
  directionGesture = undefined;
  $('arrow-pad').dataset.direction = '';
  directionIcon('');
}
function setDirection(direction) {
  if (direction === activeDirection) return;
  clearTimeout(directionTimer);
  clearInterval(directionInterval);
  activeDirection = direction;
  $('arrow-pad').dataset.direction = direction;
  directionIcon(direction);
  if (!direction) return;
  directionData = sendKey(directionKeys[direction]);
  const repeat = () => {
    if (directionGesture?.panel !== workbench.activePanel?.id) { stopDirection(); return; }
    if (directionData) sendKey(directionData);
  };
  directionTimer = setTimeout(() => {
    repeat();
    if (directionGesture) directionInterval = setInterval(repeat, 75);
  }, 400);
}
$('arrow-pad').addEventListener('pointerdown', event => {
  if (directionGesture) return;
  event.preventDefault();
  directionGesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panel: workbench.activePanel?.id };
  $('arrow-pad').setPointerCapture(event.pointerId);
  setDirection('');
});
$('arrow-pad').addEventListener('pointermove', event => {
  if ($('arrow-pad').hasPointerCapture(event.pointerId)) setDirection(directionFromDrag(event));
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) $('arrow-pad').addEventListener(type, event => stopDirection(event));
window.addEventListener('blur', () => stopDirection());
document.addEventListener('visibilitychange', () => { if (document.hidden) stopDirection(); });
$('arrow-pad').addEventListener('keydown', event => {
  const direction = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' })[event.key];
  if (direction) { event.preventDefault(); sendKey(directionKeys[direction]); }
});

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
async function copySelection() {
  const active = workbench.activePanel;
  const target = active?.kind === 'terminal' && active.id !== 'terminal' ? active.api : terminal;
  const text = target.getSelection();
  if (!text) { notify('Select terminal text to copy'); return; }
  try { await navigator.clipboard.writeText(text); }
  catch { if (!fallbackCopy(text)) error('The selection could not be copied.'); }
  hideTerminalMenu();
  target.focus();
}
async function pasteFromClipboard() {
  setCtrlArmed(false);
  let text;
  try { text = await navigator.clipboard.readText(); }
  catch { text = window.prompt('Paste terminal text:'); }
  const active = workbench.activePanel;
  if (typeof text === 'string' && text) {
    if (active?.kind === 'terminal' && active.id !== 'terminal') active.api.paste(text);
    else terminal.paste(text);
  }
  hideTerminalMenu();
  if (active?.kind === 'terminal' && active.id !== 'terminal') active.api.focus(); else terminal.focus();
}
function showTerminalMenu(x, y) {
  const menu = $('terminal-menu');
  $('copy-selection').disabled = !terminal.hasSelection();
  menu.hidden = false;
  const width = menu.offsetWidth, height = menu.offsetHeight;
  const viewport = window.visualViewport || { offsetLeft: 0, offsetTop: 0, width: innerWidth, height: innerHeight };
  menu.style.left = `${Math.max(viewport.offsetLeft + 6, Math.min(x, viewport.offsetLeft + viewport.width - width - 6))}px`;
  menu.style.top = `${Math.max(viewport.offsetTop + 6, Math.min(y, viewport.offsetTop + viewport.height - height - 6))}px`;
}
function hideTerminalMenu() { $('terminal-menu').hidden = true; }
$('copy-selection').onclick = copySelection;
$('paste-selection').onclick = pasteFromClipboard;
$('select-all').onclick = () => { terminal.selectAll(); $('copy-selection').disabled = false; };
$('clear-selection').onclick = () => { terminal.clearSelection(); hideTerminalMenu(); terminal.focus(); };
$('terminal-menu').addEventListener('pointerdown', event => event.stopPropagation());
document.addEventListener('pointerdown', event => { if (!$('terminal-menu').contains(event.target)) hideTerminalMenu(); });
$('terminal').addEventListener('contextmenu', event => {
  event.preventDefault();
  showTerminalMenu(event.clientX, event.clientY);
});

function terminalCell(event) {
  const screen = $('terminal').querySelector('.xterm-screen');
  if (!screen || !terminal.cols || !terminal.rows) return null;
  const rect = screen.getBoundingClientRect();
  const col = Math.max(0, Math.min(terminal.cols - 1, Math.floor((event.clientX - rect.left) * terminal.cols / rect.width)));
  const visibleRow = Math.max(0, Math.min(terminal.rows - 1, Math.floor((event.clientY - rect.top) * terminal.rows / rect.height)));
  return { col, row: terminal.buffer.active.viewportY + visibleRow };
}
function updateTouchSelection(event) {
  const end = terminalCell(event);
  if (!end || !touchGesture?.start) return;
  const startIndex = touchGesture.start.row * terminal.cols + touchGesture.start.col;
  const endIndex = end.row * terminal.cols + end.col;
  const first = Math.min(startIndex, endIndex), last = Math.max(startIndex, endIndex);
  terminal.select(first % terminal.cols, Math.floor(first / terminal.cols), last - first + 1);
}
function finishTouch(event) {
  if (!touchGesture || event.pointerId !== touchGesture.pointerId) return;
  clearTimeout(touchGesture.timer);
  if (touchGesture.selecting) {
    updateTouchSelection(event);
    showTerminalMenu(event.clientX, event.clientY);
  } else if (!touchGesture.scrolling) {
    terminal.focus();
  }
  touchGesture = undefined;
}
$('terminal').addEventListener('pointerdown', event => {
  if (event.pointerType !== 'touch' || touchGesture) return;
  hideTerminalMenu();
  const start = terminalCell(event);
  touchGesture = { pointerId: event.pointerId, start, x: event.clientX, y: event.clientY, lastY: event.clientY, scrolling: false, selecting: false };
  $('terminal').setPointerCapture(event.pointerId);
  touchGesture.timer = setTimeout(() => {
    if (!touchGesture || touchGesture.scrolling || !start) return;
    touchGesture.selecting = true;
    terminal.select(start.col, start.row, 1);
    navigator.vibrate?.(20);
  }, 480);
});
$('terminal').addEventListener('pointermove', event => {
  if (!touchGesture || event.pointerId !== touchGesture.pointerId) return;
  event.preventDefault();
  if (touchGesture.selecting) { updateTouchSelection(event); return; }
  if (Math.hypot(event.clientX - touchGesture.x, event.clientY - touchGesture.y) > 8) {
    touchGesture.scrolling = true;
    clearTimeout(touchGesture.timer);
  }
  if (touchGesture.scrolling) {
    const screen = $('terminal').querySelector('.xterm-screen');
    const cellHeight = screen ? screen.getBoundingClientRect().height / terminal.rows : 16;
    const lines = Math.trunc((touchGesture.lastY - event.clientY) / Math.max(1, cellHeight));
    if (lines) { terminal.scrollLines(lines); touchGesture.lastY -= lines * cellHeight; }
  }
});
for (const type of ['pointerup', 'pointercancel']) $('terminal').addEventListener(type, finishTouch);
scheduleResize();

function terminalOptions() {
  return { fontSize: Number($('font-size').value), scrollback: Number($('scrollback').value),
    theme: themes[$('theme').value] || themes.dark, cursorBlink: $('cursor-blink').checked,
    cursorStyle: $('cursor-style').value, scrollOnUserInput: $('scroll-on-input').checked };
}
function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme = $('theme').value;
  root.dataset.density = $('ui-density').value;
  root.dataset.uiStyle = $('ui-style').value;
  root.dataset.accent = $('accent-color').value;
  root.classList.toggle('reduce-motion', $('reduce-motion').checked);
  root.style.setProperty('--editor-font-size', `${Math.max(12, Math.min(28, Number($('editor-font-size').value) || 16))}px`);
  root.classList.toggle('hide-file-details', !$('file-details').checked);
}
function applySettings(event) {
  const size = Number($('font-size').value);
  const lines = Number($('scrollback').value);
  if (!Number.isInteger(size) || size < 8 || size > 36 || !Number.isInteger(lines) || lines < 0 || lines > 50000) {
    setDialogError('Font size must be 8–36 and scrollback must be 0–50000.');
    return false;
  }
  setDialogError('');
  terminal.options.fontSize = size;
  terminal.options.scrollback = lines;
  terminal.options.theme = themes[$('theme').value] || themes.dark;
  terminal.options.cursorBlink = $('cursor-blink').checked;
  terminal.options.cursorStyle = $('cursor-style').value;
  terminal.options.scrollOnUserInput = $('scroll-on-input').checked;
  const interval = Number($('refresh-interval').value);
  const measurementPointSize = validDecimal($('cad-measurement-point-size').value, 0.5, 3, 1.5);
  $('cad-measurement-point-size').value = measurementPointSize;
  const cadMovementSpeed = validDecimal($('cad-movement-speed').value, 0.25, 4, 1);
  const cadLookSpeed = validDecimal($('cad-look-speed').value, 0.25, 3, 1);
  $('cad-movement-speed').value = cadMovementSpeed; $('cad-look-speed').value = cadLookSpeed;
  applyAppearance();
  for (const panel of workbench.panels.values()) if (panel.id !== 'terminal' && panel.kind === 'terminal') panel.api?.updateOptions?.(terminalOptions());
  try {
    localStorage.setItem('eya-settings', JSON.stringify({
      fontSize: size, scrollback: lines, theme: $('theme').value,
      cursorBlink: $('cursor-blink').checked, cursorStyle: $('cursor-style').value,
      scrollOnUserInput: $('scroll-on-input').checked,
      refreshInterval: interval, showHidden: $('show-hidden').checked,
      editorWrap: $('editor-wrap').checked, editorLineNumbers: $('editor-line-numbers').checked,
      confirmDelete: $('confirm-delete').checked, startingDirectory: $('starting-directory').value.trim(),
      uiDensity: $('ui-density').value, uiStyle: $('ui-style').value, accentColor: $('accent-color').value,
      reduceMotion: $('reduce-motion').checked, editorFontSize: Number($('editor-font-size').value),
      editorTabSize: Number($('editor-tab-size').value), fileDetails: $('file-details').checked,
    }));
  } catch { /* Storage is optional. */ }
  cadPreferences = {
    ...cadPreferences,
    mode: validChoice($('cad-display-mode').value, ['shaded', 'edges', 'wireframe'], 'edges'),
    gridPlanes: validChoice($('cad-grid-planes').value, ['off', 'xy', 'all'], 'all'),
    axisCoordinates: $('cad-axis-coordinates').checked,
    sectionGizmos: $('cad-section-gizmos').checked,
    rotationGizmo: $('cad-rotation-gizmo').checked,
    navigationMode: validChoice($('cad-navigation-mode').value, ['orbit', 'firstPerson'], 'orbit'),
    orbitStyle: validChoice($('cad-orbit-style').value, ['turntable', 'free'], 'turntable'),
    movementSpeed: cadMovementSpeed, lookSpeed: cadLookSpeed, invertLook: $('cad-invert-look').checked,
    hoverHighlights: $('cad-hover-highlights').checked,
    measurementColor: validColor($('cad-measurement-color').value, '#ff4f9a'),
    measurementPointSize,
    selectionColor: validColor($('cad-selection-color').value, '#66ff99'),
    selectionMode: validChoice($('cad-selection-mode').value, ['part', 'face', 'loop'], 'face'),
  };
  try { localStorage.setItem('eya-cad-settings', JSON.stringify(cadPreferences)); } catch { /* Storage is optional. */ }
  window.dispatchEvent(new CustomEvent('eya-cad-settings', { detail: { ...cadPreferences } }));
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
    const url = new URL($('url').value.trim());
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw Error();
    return { url, command };
  } catch {
    setDialogError('Enter a valid ws:// or wss:// URL without credentials.');
    return null;
  }
}
function openConnection() { setDialogError(''); openDialog($('connect-dialog')); }
function setConnectionAppearance(connected) {
  pageBody.classList.toggle('connection-offline', !connected);
  $('disconnect').disabled = !connected && !awaitingHandshake && !reconnectEnabled;
  $('end-session').disabled = !connected;
  buttonIcon($('connect'), 'Plug', connected ? 'Session' : 'Connect');
  $('connect').classList.toggle('primary', !connected);
  $('connect').title = connected ? 'Connection details' : 'Connect to server';
  connectionNotice.hidden = connected;
  if (!connected && !connectionNotice.textContent) connectionNotice.textContent = $('status').textContent;
}
function announceDisconnect(message) {
  connectionNotice.textContent = `Disconnected — ${message}`;
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
  rejectFileRequests('Disconnected.');
  clearInterval(fileRefreshTimer);
  $('file-status').textContent = 'Connect to browse files.';
  $('latency').textContent = '';
  status('Disconnected — session retained; click Connect to resume');
  if (hadConnection) announceDisconnect('Session retained on the server. Connect to resume.');
  else setConnectionAppearance(false);
}
const endSessionButton = document.createElement('button');
endSessionButton.id = 'end-session'; endSessionButton.type = 'button'; endSessionButton.textContent = 'End session';
endSessionButton.disabled = true;
$('connect-dialog').querySelector('.actions').prepend(endSessionButton);
endSessionButton.onclick = () => {
  if (transportReady) {
    if (resumableSession) { resumableSession.pending = []; resumableSession.ending = true; }
    clearTimeout(inputFlushTimer);
    send(Uint8Array.of(10));
  }
};
setConnectionAppearance(false);

if (config.font) {
  const face = new FontFace('EyaEmbeddedFont', `url(${JSON.stringify(config.font)})`);
  face.load().then(loaded => {
    document.fonts.add(loaded);
    terminal.options.fontFamily = 'EyaEmbeddedFont, monospace';
    resize();
  }).catch(() => error('The embedded font could not be loaded. Using the browser’s monospace font.'));
}

$('connect').onclick = openConnection;
$('settings').onclick = () => { openDialog($('settings-dialog')); setDialogError(''); };
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === ',') {
    event.preventDefault(); event.stopPropagation(); $('settings').click();
  }
  if (document.querySelector('dialog[open]')) return;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.shiftKey && event.key.toLowerCase() === 'p') {
    event.preventDefault(); event.stopPropagation(); workbench.openStart();
  } else if (mod && event.shiftKey && event.code === 'Backquote') {
    event.preventDefault(); event.stopPropagation(); workbench.create('terminal').catch(cause => notify(cause.message));
  } else if (mod && event.shiftKey && event.key.toLowerCase() === 'e') {
    event.preventDefault(); event.stopPropagation(); setPanelVisible(true);
  } else if (mod && event.key.toLowerCase() === 'f' && typeof workbench.activePanel?.api?.focusSearch === 'function') {
    event.preventDefault(); event.stopPropagation(); workbench.activePanel.api.focusSearch();
  } else if (workbench.activePanel?.kind === 'browser' && mod && event.key.toLowerCase() === 'l') {
    event.preventDefault(); event.stopPropagation(); workbench.activePanel.api[event.key.toLowerCase() === 'l' ? 'focusPath' : 'focusSearch']?.();
  }
}, { capture: true });
$('disconnect').onclick = disconnect;
$('close-connect').onclick = () => closeDialog($('connect-dialog'));
$('close-settings').onclick = () => { closeDialog($('settings-dialog')); terminal.focus(); };
for (const id of ['font-size', 'scrollback', 'theme', 'cursor-blink', 'cursor-style', 'scroll-on-input', 'refresh-interval', 'show-hidden', 'editor-wrap', 'editor-line-numbers', 'confirm-delete', 'starting-directory', 'ui-density', 'ui-style', 'accent-color', 'reduce-motion', 'editor-font-size', 'editor-tab-size', 'file-details', 'cad-display-mode', 'cad-grid-planes', 'cad-axis-coordinates', 'cad-section-gizmos', 'cad-rotation-gizmo', 'cad-navigation-mode', 'cad-orbit-style', 'cad-movement-speed', 'cad-look-speed', 'cad-invert-look', 'cad-hover-highlights', 'cad-measurement-color', 'cad-measurement-point-size', 'cad-selection-color', 'cad-selection-mode']) {
  $(id).addEventListener('input', applySettings);
  $(id).addEventListener('change', applySettings);
}

$('settings-search').addEventListener('input', () => {
  const query = $('settings-search').value.trim().toLowerCase();
  for (const section of document.querySelectorAll('[data-settings]')) {
    const headingMatch = !!query && section.querySelector('h3').textContent.toLowerCase().includes(query);
    let matches = 0;
    for (const setting of section.querySelectorAll('.setting')) {
      const match = !query || headingMatch || setting.textContent.toLowerCase().includes(query);
      setting.hidden = !match;
      if (match) matches++;
    }
    section.hidden = !!query && !matches;
  }
});

function setPanelVisible(visible, remember = true) {
  pageBody.classList.toggle('panel-visible', visible);
  $('files').setAttribute('aria-pressed', String(visible));
  if (visible) {
    if (!workbench.isOpen('browser')) {
      const compact = matchMedia('(pointer: coarse), (max-width: 760px)').matches;
      const groupId = compact
        ? workbench.groupOf('terminal')
        : workbench.split(null, 'vertical', 'terminal');
      workbench.open('browser', { groupId });
      if (!compact) workbench.setSize('browser', 46);
    } else workbench.activate('browser');
  } else {
    workbench.close('browser');
    workbench.activate('terminal');
  }
  if (remember) applySettings();
  if (visible && outbound && !currentPath) navigateTo($('starting-directory').value.trim(), true);
  scheduleResize();
}

setPanelVisible(false, false);

function restartFileRefresh() {
  clearInterval(fileRefreshTimer);
  const seconds = Number($('refresh-interval').value);
  let busy = false;
  if (seconds > 0) fileRefreshTimer = setInterval(async () => {
    if (busy || document.hidden || !transportReady) return;
    busy = true;
    try {
      if (workbench.isOpen('browser') && !fileMenuEntry && !fileNavigationPending) await refreshFiles(false);
      for (const tab of fileTabs.values()) {
        if (tab.dirty || tab.cad || !tab.node?.getClientRects().length) continue;
        const meta = await fileRequest('stat', { path: tab.path });
        if (!tab.dirty && fileTabs.get(tab.path) === tab && meta.version !== tab.version) await openFile(tab.path, true);
      }
    } catch (cause) { fileFailure(cause); }
    finally { busy = false; }
  }, seconds * 1000);
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

function fileRequest(op, values = {}) {
  if (filePending.size >= 64) return Promise.reject(Error('Too many pending operations. Wait for earlier requests to finish.'));
  const id = nextFileRequestId();
  return new Promise((resolve, reject) => {
    filePending.set(id, { resolve, reject, onJson(response) { filePending.delete(id); resolve(response); } });
    try { sendFileControl(id, op, values); } catch (cause) { filePending.delete(id); reject(cause); }
  });
}

function readFile(path) {
  if (filePending.size >= 64) return Promise.reject(Error('Too many pending operations. Wait for earlier requests to finish.'));
  const id = nextFileRequestId();
  return new Promise((resolve, reject) => {
    filePending.set(id, { resolve, reject, chunks: [], meta: null, onJson(response) { this.meta = response; } });
    try { sendFileControl(id, 'read', { path }); } catch (cause) { filePending.delete(id); reject(cause); }
  });
}

function uploadBytes(path, bytes, overwrite) {
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
    try { sendFileControl(id, 'write', { path, size: bytes instanceof Blob ? bytes.size : bytes.byteLength, overwrite }); }
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
  const generation = ++fileNavigationGeneration; fileNavigationPending++;
  $('file-status').textContent = 'Loading…';
  try {
    const response = await fileRequest('list', { path: path || $('starting-directory').value.trim(), showHidden: $('show-hidden').checked });
    if (generation !== fileNavigationGeneration) return;
    const directoryChanged = currentPath !== response.path;
    const focusedRow = document.activeElement?.closest?.('tr');
    const focusedPath = $('file-list').contains(focusedRow) ? focusedRow.dataset.path : '';
    currentPath = response.path;
    directoryEntries = response.entries;
    selectedEntry = !directoryChanged && selectedEntry ? directoryEntries.find(entry => entry.path === selectedEntry.path) : undefined;
    $('file-path').value = currentPath;
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

function renderDirectory() {
  const menuEntry = fileMenuEntry && directoryEntries.find(item => item.path === fileMenuEntry.path);
  if (!menuEntry) hideFileEntryMenu();
  const body = $('file-list');
  body.replaceChildren();
  const parent = { name: '..', path: parentPath(currentPath), kind: 'parent', size: 0, modified: 0 };
  const entries = currentPath !== '/' && !$('file-search').value ? [parent, ...directoryEntries] : directoryEntries;
  for (const item of entries) {
    const row = document.createElement('tr');
    row.tabIndex = 0;
    row.dataset.path = item.path;
    row.classList.toggle('selected', selectedEntry?.path === item.path);
    const name = document.createElement('td');
    const entryIcon = item.kind === 'parent' ? 'CornerUpLeft' : item.kind === 'directory' ? 'Folder' : item.kind === 'symlink' ? 'Link' : isCadFile(item.path) ? 'Box' : imageExtensions.has(extension(item.path)) ? 'Image' : textExtensions.has(extension(item.path)) ? 'FileCode' : 'File';
    const entryName = document.createElement('span'); entryName.textContent = item.name;
    name.append(icon(entryIcon), entryName); name.className = 'entry-name';
    name.title = item.path;
    const size = document.createElement('td'); size.className = 'size'; size.textContent = ['directory', 'parent'].includes(item.kind) ? '—' : formatSize(item.size);
    const modified = document.createElement('td'); modified.className = 'modified'; modified.textContent = item.modified ? new Date(item.modified).toLocaleString() : '—';
    const actions = document.createElement('td'); actions.className = 'entry-actions';
    if (item.kind !== 'parent') {
      const menu = document.createElement('button');
      menu.type = 'button'; menu.className = 'file-entry-button'; buttonIcon(menu, 'EllipsisVertical', `Actions for ${item.name}`, true);
      menu.title = `Actions for ${item.name}`; menu.setAttribute('aria-label', `Actions for ${item.name}`); menu.setAttribute('aria-haspopup', 'menu');
      menu.addEventListener('click', event => { event.stopPropagation(); showFileEntryMenu(item, menu); });
      menu.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); showFileEntryMenu(item, menu); $('file-entry-menu').querySelector('button:not([hidden])')?.focus(); } });
      actions.append(menu);
    }
    row.append(name, size, modified, actions);
    row.addEventListener('click', () => selectEntry(item));
    row.addEventListener('dblclick', () => activateEntry(item));
    row.addEventListener('keydown', event => { if (event.target === row && event.key === 'Enter') { event.preventDefault(); activateEntry(item); } });
    body.append(row);
  }
  $('file-empty').hidden = !!directoryEntries.length;
  $('file-empty').textContent = $('file-search').value ? 'No matching files.' : 'This directory is empty.';
  if (menuEntry) {
    const row = [...body.rows].find(row => row.dataset.path === menuEntry.path);
    const button = row?.querySelector('.file-entry-button');
    if (button) showFileEntryMenu(menuEntry, button); else hideFileEntryMenu();
  }
}

function selectEntry(item) {
  selectedEntry = item;
  for (const row of $('file-list').rows) row.classList.toggle('selected', row.dataset.path === item.path);
}
function activateEntry(item) { if (['directory', 'parent'].includes(item.kind)) navigateTo(item.path, true); else openFile(item.path); }
function updateNavigationButtons() {
  $('file-back').disabled = historyIndex <= 0;
  $('file-forward').disabled = historyIndex < 0 || historyIndex >= historyPaths.length - 1;
  $('file-up').disabled = !currentPath || currentPath === '/';
}
function showFileEntryMenu(item, button) {
  closeMenus();
  selectEntry(item);
  fileMenuEntry = item;
  const menu = $('file-entry-menu');
  menu.querySelector('[data-file-action=download]').hidden = item.kind === 'directory';
  menu.hidden = false;
  button.setAttribute('aria-controls', 'file-entry-menu'); button.setAttribute('aria-expanded', 'true');
  const rect = button.getBoundingClientRect();
  const width = menu.offsetWidth, height = menu.offsetHeight;
  const viewport = window.visualViewport || { offsetLeft: 0, offsetTop: 0, width: innerWidth, height: innerHeight };
  menu.style.left = `${Math.max(viewport.offsetLeft + 6, Math.min(rect.right - width, viewport.offsetLeft + viewport.width - width - 6))}px`;
  menu.style.top = `${Math.max(viewport.offsetTop + 6, Math.min(rect.bottom + 4, viewport.offsetTop + viewport.height - height - 6))}px`;
}
function hideFileEntryMenu() {
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
  if (!query) { await navigateTo(currentPath, false); return; }
  const generation = ++fileNavigationGeneration; fileNavigationPending++;
  try {
    $('file-status').textContent = `Searching ${currentPath}…`;
    const response = await fileRequest('search', { path: currentPath, query, showHidden: $('show-hidden').checked });
    if ($('file-search').value.trim() !== query || generation !== fileNavigationGeneration) return;
    directoryEntries = response.entries;
    selectedEntry = undefined;
    renderDirectory();
    $('file-status').textContent = `${directoryEntries.length} result${directoryEntries.length === 1 ? '' : 's'} for “${query}”`;
  } catch (cause) { if (generation === fileNavigationGeneration) fileFailure(cause); }
  finally { fileNavigationPending--; }
}

async function refreshFiles(automatic = false) {
  if (!currentPath || $('file-search').value) return;
  await navigateTo(currentPath, false);
  const tab = fileTabs.get(activeFileTab);
  if (automatic && tab && !tab.dirty && !tab.cad) await openFile(tab.path, true);
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
  if (bytes.length > TEXT_EDITOR_LIMIT || bytes.subarray(0, 8192).includes(0)) return false;
  if (textExtensions.has(extension(path))) return true;
  try { fatalDecoder.decode(bytes); return true; } catch { return false; }
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
  { name: 'cad', supports: tab => isCadFile(tab.path), render: renderCadViewer },
  { name: 'image', supports: tab => imageExtensions.has(extension(tab.path)), render: renderImageViewer },
  { name: 'video', supports: tab => videoExtensions.has(extension(tab.path)), render: renderVideoViewer },
  { name: 'audio', supports: tab => audioExtensions.has(extension(tab.path)), render: renderAudioViewer },
  { name: 'text', supports: tab => likelyText(tab.path, tab.bytes), render: renderTextEditor },
  { name: 'generic', supports: () => true, render: renderGenericViewer },
];

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
  description: 'Start an interactive shell session.', keywords: ['shell', 'command line', 'console'], create: ({ id, command, title }) => {
  if (command === undefined && !workbench.isOpen('terminal')) return 'terminal';
  const connection = validateConnection();
  if (!connection) { openConnection(); throw Error('Connect to a server first'); }
  return createTerminalPanel({ id, title: title || 'Terminal', url: connection.url.href, key: $('key').value, command: command ?? connection.command, options: terminalOptions(), transformInput: applyCtrl });
} });
workbench.registerType({ id: 'files', title: 'File browser', icon: 'FolderOpen', category: 'Workspace', order: 20,
  description: 'Browse, edit, upload, and manage server files.', keywords: ['explorer', 'folders', 'editor'], create: ({ id }) => createFileBrowser({
  id, request: fileRequest, read: readFile, upload: uploadBytes, openFile, download: downloadBlob,
  preferences: browserPreferences, onDelete: closeFileTab, rename: renameFile,
}) });
workbench.registerType({ id: 'task-manager', title: 'Task Manager', icon: 'Activity', category: 'System', order: 30,
  description: 'Inspect processes and live machine resource usage.', keywords: ['processes', 'cpu', 'memory', 'system'], create: ({ id }) => ({
  id, title: 'Task Manager', kind: 'system', ...createTaskManager({ request: fileRequest, openFile: openMachinePath, openTerminal: command => workbench.create('terminal', { command }) }),
}) });
workbench.registerType({ id: 'docker', title: 'Docker', icon: 'Container', category: 'System', order: 40,
  description: 'Monitor containers, images, logs, and Docker resources.', keywords: ['containers', 'images', 'compose'], create: ({ id }) => ({
  id, title: 'Docker', kind: 'docker', ...createDockerPanel({ request: fileRequest, openFile: openMachinePath, openTerminal: command => workbench.create('terminal', { command }) }),
}) });

const panelApi = {
  openFile: path => openFile(String(path)),
  registerType: definition => workbench.registerType(definition),
  listTypes: () => workbench.listTypes(),
  create: (type, options) => workbench.create(type, options),
  openStart: groupId => workbench.openStart(groupId),
  register: definition => workbench.register(definition),
  open: (id, options) => workbench.open(id, options),
  close: id => workbench.close(id),
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
    fileViewers.splice(-1, 0, provider);
  },
};
Object.defineProperty(globalThis, 'EyaPanels', { configurable: true, value: Object.freeze(panelApi) });

function openFile(path, force = false) {
  if (fileTabs.has(path) && !force) { activateFileTab(path); return Promise.resolve(); }
  if (fileOpenings.has(path)) return fileOpenings.get(path);
  const pending = loadFile(path, force).finally(() => { if (fileOpenings.get(path) === pending) fileOpenings.delete(path); });
  fileOpenings.set(path, pending); return pending;
}
async function loadFile(path, force = false) {
  const attempt = connectionId;
  const existing = fileTabs.get(path);
  if (existing && !force) { activateFileTab(path); return; }
  try {
    $('file-status').textContent = `Opening ${path}…`;
    const result = await readFile(path);
    if (attempt !== connectionId) return;
    if (existing && fileTabs.get(path) !== existing) return;
    if (existing && force) {
      if (existing.dirty) return;
      if (existing.cad) {
        if (await existing.cad.load(result.bytes)) {
          existing.bytes = result.bytes; existing.modified = result.meta.modified; existing.version = result.meta.version;
        }
        return;
      }
      const unchanged = existing.bytes.length === result.bytes.length && existing.bytes.every((byte, index) => byte === result.bytes[index]);
      existing.modified = result.meta.modified; existing.version = result.meta.version;
      if (unchanged) return;
      existing.bytes = result.bytes;
      if (existing.viewer === 'text') {
        existing.text = decoder.decode(result.bytes);
        existing.lineSeparator = existing.text.includes('\r\n') ? '\r\n' : '\n';
      }
      renderTabContent(existing);
      $('file-status').textContent = `${baseName(path)} refreshed after an external change.`;
      return;
    }
    const tab = { path, panelId: `file:${path}`, name: baseName(path), bytes: result.bytes, modified: result.meta.modified, version: result.meta.version, dirty: false, view: null, node: null, url: null };
    fileTabs.set(path, tab);
    renderTabContent(tab);
    activateFileTab(path);
    $('file-status').textContent = `${tab.name} · ${formatSize(tab.bytes.length)}`;
  } catch (cause) { fileFailure(cause); if (!force) notify(cause.message || 'Could not open file'); }
}

function createViewerShell(tab, save = false) {
  tab.shellMenu?.destroy();
  const root = document.createElement('div'); root.className = 'viewer';
  const actions = document.createElement('div'); actions.className = 'viewer-actions';
  const path = document.createElement('span'); path.className = 'viewer-path'; path.textContent = parentPath(tab.path); path.title = tab.path;
  actions.append(path);
  if (save) {
    const button = document.createElement('button'); button.type = 'button'; buttonIcon(button, 'Save', 'Save'); button.className = 'save-button'; button.disabled = !tab.dirty; button.addEventListener('click', () => saveTab(tab)); actions.append(button); tab.saveButton = button;
  }
  const menu = createMenu('File actions'); tab.shellMenu = menu;
  const download = document.createElement('button'); download.type = 'button'; download.textContent = 'Download'; download.addEventListener('click', () => downloadTab(tab)); menuAction(menu.panel, download, 'Download');
  const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy path'; copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(tab.path); notify('Path copied'); }
    catch { notify(fallbackCopy(tab.path) ? 'Path copied' : 'Could not copy path'); }
  }); menuAction(menu.panel, copy, 'Copy');
  actions.append(menu.element);
  const body = document.createElement('div'); body.className = 'viewer-body';
  root.append(actions, body);
  return { root, body, actions, menu };
}

function renderTabContent(tab) {
  tab.cad?.dispose(); tab.cad = null;
  tab.view?.destroy(); tab.view = null;
  if (tab.url) URL.revokeObjectURL(tab.url);
  const provider = fileViewers.find(value => value.supports(tab));
  tab.viewer = provider.name;
  const node = provider.render(tab);
  tab.node = node;
  tab.node.dataset.path = tab.path;
  if (workbench.panels.has(tab.panelId)) {
    workbench.update(tab.panelId, { title: tab.name, dirty: tab.dirty, element: node, kind: tab.viewer });
  } else {
    workbench.register({
      id: tab.panelId,
      title: tab.name,
      kind: tab.viewer,
      legacyTab: tab.path,
      element: node,
      beforeClose: () => !tab.dirty || confirm(`Discard unsaved changes to ${tab.name}?`),
      onActivate: () => {
        activeFileTab = tab.path;
        if (!matchMedia('(pointer: coarse), (max-width: 760px)').matches) tab.view?.focus();
      },
      onLayout: () => { tab.view?.requestMeasure(); tab.cad?.resize(); },
      api: {
        save: () => tab.viewer === 'text' ? saveTab(tab) : false,
        download: () => downloadTab(tab),
        refresh: () => !tab.dirty ? openFile(tab.path, true) : false,
        focus: () => tab.view?.focus(),
        fit: () => tab.cad?.fit(),
        cadState: () => tab.cad?.snapshot(),
      },
      onClose: () => {
        tab.shellMenu?.destroy();
        tab.cad?.dispose(); tab.cad = null;
        tab.view?.destroy();
        if (tab.url) URL.revokeObjectURL(tab.url);
        fileTabs.delete(tab.path);
        if (activeFileTab === tab.path) activeFileTab = '';
      },
    });
  }
}

function renderCadViewer(tab) {
  const shell = createViewerShell(tab);
  let preferences = {};
  try { preferences = JSON.parse(localStorage.getItem('eya-cad-settings') || '{}') || {}; } catch { /* Storage is optional. */ }
  const cad = createCadViewer({
    path: tab.path, preferences,
    savePreferences: value => {
      const changed = CAD_SHARED_KEYS.some(key => JSON.stringify(cadPreferences[key]) !== JSON.stringify(value[key]));
      cadPreferences = { ...cadPreferences, ...value };
      try { localStorage.setItem('eya-cad-settings', JSON.stringify(cadPreferences)); } catch { /* Storage is optional. */ }
      if (changed) { syncCadSettingsForm(cadPreferences); window.dispatchEvent(new CustomEvent('eya-cad-settings', { detail: { ...cadPreferences } })); }
    },
    reload: () => openFile(tab.path, true),
    loadResource: path => readFile(path),
  });
  tab.cad = cad;
  const cadOptions = cad.element.querySelector('.ui-menu[aria-label="CAD options"]');
  menuHeading(cadOptions, 'File');
  for (const action of shell.menu.panel.children) action.removeAttribute('role');
  cadOptions.append(...shell.menu.panel.children);
  shell.menu.destroy(); tab.shellMenu = null;
  shell.actions.remove();
  shell.body.classList.add('cad-body'); shell.body.append(cad.element);
  tab.cadBusy = true;
  cad.load(tab.bytes).then(ok => { if (!ok) tab.version = undefined; }).finally(() => { tab.cadBusy = false; });
  return shell.root;
}

// CAD polling is independent of Files visibility and skips unchanged model transfers.
setInterval(async () => {
  if (document.hidden || !outbound) return;
  for (const tab of fileTabs.values()) {
    if (!tab.cad || !tab.cad.state.live || tab.cadBusy || !tab.node?.getClientRects().length || Date.now() - (tab.cadChecked || 0) < tab.cad.state.interval) continue;
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
      if (!changed) continue;
      if (fileTabs.get(tab.path) !== tab || attempt !== connectionId || tab.cad !== cad) continue;
      const result = await readFile(tab.path);
      if (fileTabs.get(tab.path) !== tab || attempt !== connectionId || tab.cad !== cad) continue;
      if (await cad.load(result.bytes)) {
        tab.bytes = result.bytes; tab.version = result.meta.version; tab.modified = result.meta.modified;
      }
    } catch (cause) { cad.setStatus(`Keeping previous model. ${cause.message || cause}`); }
    finally { tab.cadBusy = false; }
  }
}, 500);

function renderTextEditor(tab) {
  const shell = createViewerShell(tab, true);
  const host = document.createElement('div'); host.className = 'editor-host'; shell.body.append(host);
  const text = tab.text ?? decoder.decode(tab.bytes); tab.text = text;
  tab.lineSeparator ??= text.includes('\r\n') ? '\r\n' : '\n';
  const light = $('theme').value === 'light';
  const extensions = [
    EditorState.tabSize.of(Number($('editor-tab-size').value)),
    history(), drawSelection(), highlightActiveLine(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), languageFor(tab.path),
    keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { saveTab(tab); return true; } }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
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
  const image = document.createElement('img'); image.src = tab.url; image.alt = tab.name; shell.body.append(image); return shell.root;
}
function renderVideoViewer(tab) {
  const shell = createViewerShell(tab);
  tab.url = URL.createObjectURL(new Blob([tab.bytes], { type: mediaType(tab.path) }));
  const video = document.createElement('video'); video.src = tab.url; video.controls = true; video.playsInline = true; video.preload = 'metadata'; shell.body.append(video); return shell.root;
}
function renderAudioViewer(tab) {
  const shell = createViewerShell(tab);
  tab.url = URL.createObjectURL(new Blob([tab.bytes], { type: mediaType(tab.path) }));
  const audio = document.createElement('audio'); audio.src = tab.url; audio.controls = true; audio.preload = 'metadata'; shell.body.append(audio); return shell.root;
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
  if (tab.saveButton) tab.saveButton.disabled = !dirty || !!tab.saving || !!tab.renaming;
  workbench.update(tab.panelId, { dirty });
}
async function saveTab(tab) {
  if (tab.saving || tab.renaming) return;
  tab.saving = true;
  const savedText = tab.text ?? '';
  try {
    tab.saveButton.disabled = true; $('file-status').textContent = `Saving ${tab.path}…`;
    const bytes = encoder.encode(savedText);
    await uploadBytes(tab.path, bytes, true);
    if (fileTabs.get(tab.path) !== tab) return;
    tab.bytes = bytes; setTabDirty(tab, (tab.text ?? '') !== savedText); $('file-status').textContent = `${tab.name} saved.`;
    notify(tab.dirty ? `${tab.name}: saved; newer edits remain unsaved` : `${tab.name} saved`);
    await navigateTo(currentPath, false);
  } catch (cause) {
    if (fileTabs.get(tab.path) === tab) { setTabDirty(tab, true); fileFailure(cause); notify(`Could not save ${tab.name}. Your edits are retained.`); }
  } finally {
    tab.saving = false;
    if (tab.saveButton) tab.saveButton.disabled = !tab.dirty;
  }
}
function downloadBlob(path, bytes) {
  const url = URL.createObjectURL(new Blob([bytes])); const link = document.createElement('a'); link.href = url; link.download = baseName(path); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadTab(tab) { downloadBlob(tab.path, tab.viewer === 'text' ? encoder.encode(tab.text) : tab.bytes); }
function updateEditorConfiguration() { for (const tab of fileTabs.values()) if (tab.viewer === 'text') renderTabContent(tab); }

$('files').onclick = () => setPanelVisible(!workbench.isOpen('browser'));
$('file-close').onclick = () => setPanelVisible(false);
$('file-go').onclick = () => navigateTo($('file-path').value.trim(), true);
$('file-path').addEventListener('keydown', event => { if (event.key === 'Enter') navigateTo($('file-path').value.trim(), true); });
$('file-refresh').onclick = () => refreshFiles(false);
$('file-up').onclick = () => navigateTo(parentPath(currentPath), true);
$('file-back').onclick = () => { if (historyIndex > 0) { historyIndex--; navigateTo(historyPaths[historyIndex], false); } };
$('file-forward').onclick = () => { if (historyIndex < historyPaths.length - 1) { historyIndex++; navigateTo(historyPaths[historyIndex], false); } };
$('file-search').addEventListener('input', () => { clearTimeout(fileSearchTimer); fileSearchTimer = setTimeout(searchFiles, 350); });
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
async function deleteEntry(item) {
  if ($('confirm-delete').checked && !confirm(`Delete ${item.name}${item.kind === 'directory' ? ' and everything inside it' : ''}? This cannot be undone.`)) return;
  try { await fileRequest('delete', { path: item.path, recursive: item.kind === 'directory' }); closeFileTab(item.path); await navigateTo(currentPath, false); } catch (cause) { fileFailure(cause); }
}
for (const button of $('file-entry-menu').querySelectorAll('[data-file-action]')) button.addEventListener('click', () => {
  const item = fileMenuEntry;
  const action = button.dataset.fileAction;
  hideFileEntryMenu();
  if (!item) return;
  if (action === 'open') activateEntry(item);
  else if (action === 'download') downloadEntry(item);
  else if (action === 'rename') renameEntry(item);
  else if (action === 'delete') deleteEntry(item);
});
$('file-entry-menu').addEventListener('pointerdown', event => event.stopPropagation());
$('file-entry-menu').addEventListener('keydown', event => {
  const items = [...$('file-entry-menu').querySelectorAll('button:not([hidden]):not(:disabled)')];
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
document.addEventListener('pointerdown', event => { if (!$('file-entry-menu').contains(event.target) && !event.target.closest?.('.file-entry-button')) hideFileEntryMenu(); });
$('browser-view').addEventListener('scroll', () => {
  if (!fileMenuEntry) return;
  const button = [...$('file-list').rows].find(row => row.dataset.path === fileMenuEntry.path)?.querySelector('.file-entry-button');
  const bounds = button?.getBoundingClientRect(), view = $('browser-view').getBoundingClientRect();
  if (!bounds || bounds.bottom <= view.top || bounds.top >= view.bottom) hideFileEntryMenu();
  else showFileEntryMenu(fileMenuEntry, button);
}, { passive: true });
browserPanelElement.addEventListener('keydown', event => {
  if (event.target.closest('input,textarea,select,button,.ui-menu,[role=combobox]')) return;
  const rows = [...$('file-list').rows], index = rows.findIndex(row => row.dataset.path === selectedEntry?.path);
  if (['ArrowDown','ArrowUp','Home','End'].includes(event.key) && !event.altKey) {
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    const row = rows[next], item = row && directoryEntries.find(entry => entry.path === row.dataset.path);
    if (row) { selectEntry(item || { path: row.dataset.path, kind: 'parent' }); row.focus(); }
  } else if (selectedEntry && selectedEntry.kind !== 'parent' && ['Delete','Backspace','F2'].includes(event.key)) {
    event.preventDefault(); hideFileEntryMenu();
    if (event.key === 'F2') renameEntry(selectedEntry); else deleteEntry(selectedEntry);
  } else if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); navigateTo(parentPath(currentPath), true); }
  else if (event.key === 'F5') { event.preventDefault(); refreshFiles(false); }
});

$('start-connection').onclick = async () => {
  if (!applySettings()) return;
  const connection = validateConnection();
  if (!connection) return;
  const key = $('key').value;
  if (!resumableSession || resumableSession.ended || resumableSession.url !== connection.url.href || resumableSession.key !== key) {
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    resumableSession = {
      token: [...tokenBytes].map(value => value.toString(16).padStart(2, '0')).join(''),
      url: connection.url.href, key, command: connection.command, commandQueued: false,
      create: true, input: 0, inputAck: 0, output: 0, rendered: 0, pending: [], ended: false,
    };
    terminal.reset(); terminal.clear();
    if (connection.command) {
      resumableSession.commandQueued = true;
      sendInput(connection.command.replace(/\r?\n/g, '\r') + (/[\r\n]$/.test(connection.command) ? '' : '\r'));
    }
  }
  reconnectEnabled = true; reconnectAttempts = 0;
  closeDialog($('connect-dialog'));
  await connectSession();
  terminal.focus();
};

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!reconnectEnabled || !resumableSession || resumableSession.ended) return;
  const delay = Math.min(10000, 500 * 2 ** Math.min(reconnectAttempts++, 5));
  status(`Reconnecting in ${(delay / 1000).toFixed(1)} s — session retained; input buffered`);
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
  try { localStorage.setItem('eya-url', session.url); } catch { /* Storage is optional for local files. */ }
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
    const psk = await deriveKey(session.key);
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
  let lastResponse = Date.now();
  setConnectionAppearance(false);
  status(session.create ? 'Connecting…' : 'Reconnecting — terminal session retained');
  handshakeTimer = setTimeout(() => { if (socket === current && !transportReady) current.close(); }, 12000);
  closeDialog($('connect-dialog'));
  current.onopen = () => {
    if (socket === current) {
      try { current.send(handshake.send()); } catch {
        failed = true;
        error('Could not start authentication.');
        current.close();
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
        const ready = { token: session.token, output: session.output, create: session.create };
        if (!send(encoder.encode('eya-ready-v4:' + JSON.stringify(ready)))) throw Error('Could not confirm the encrypted connection');
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
            current.close(); return;
          }
          if (state.output !== session.output) throw Error('Replay offsets differ');
          acknowledgeInput(state.input);
          session.create = false; transportReady = true; reconnectAttempts = 0;
          clearTimeout(handshakeTimer); error('');
          setConnectionAppearance(true); status(state.resumed ? 'Connected — session resumed' : 'Connected');
          $('start-connection').textContent = 'Connect';
          resize();
          if (session.ending) { send(Uint8Array.of(10)); return; }
          if (!state.resumed) terminal.focus();
          if (workbench.isOpen('browser')) navigateTo(currentPath || $('starting-directory').value.trim(), !state.resumed);
          restartFileRefresh();
          if (!session.commandQueued) {
            session.commandQueued = true;
            if (session.command) sendInput(session.command.replace(/\r?\n/g, '\r') + (/[\r\n]$/.test(session.command) ? '' : '\r'));
          }
          flushInput();
          clearInterval(pingTimer);
          pingTimer = setInterval(() => {
            if (Date.now() - lastResponse > 15000) { current.close(); return; }
            const ping = new Uint8Array(9); ping[0] = 3;
            new DataView(ping.buffer).setFloat64(1, performance.now()); send(ping);
          }, 5000);
        } else if (message[0] === 8 && message.length >= 9 && transportReady) {
          const offset = readOffset(message);
          if (offset > session.output) throw Error('Missing terminal output');
          const bytes = message.subarray(9);
          const received = bytes.subarray(Math.min(bytes.length, session.output - offset));
          session.output += received.length;
          const accepted = session.output;
          terminal.write(received, () => {
            session.rendered = Math.max(session.rendered, accepted);
            if (socket === current && transportReady) send(offsetMessage(2, session.rendered));
          });
        } else if (message[0] === 9 && message.length === 9) {
          acknowledgeInput(readOffset(message)); flushInput();
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
      current.close();
    }
  };
  current.onerror = () => {
    if (socket === current) {
      failed = true;
      status('Connection interrupted — terminal retained, input buffered');
    }
  };
  current.onclose = () => {
    if (socket === current) {
      clearInterval(pingTimer);
      clearTimeout(handshakeTimer); clearTimeout(inputFlushTimer);
      rejectFileRequests('The connection closed.');
      clearInterval(fileRefreshTimer);
      $('latency').textContent = '';
      outbound = inbound = null;
      awaitingHandshake = false; transportReady = false;
      setConnectionAppearance(false);
      if (reconnectEnabled && !session.ended) scheduleReconnect();
      else if (!session.ended) status('Disconnected — session retained; click Connect to resume');
    }
  };
}

startControlEnhancement();
openConnection();
