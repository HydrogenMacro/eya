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

// Chromium exposes this legacy method on SVG documents but throws when xterm probes it.
try { document.queryCommandSupported?.('copy'); }
catch { Object.defineProperty(document, 'queryCommandSupported', { configurable: true, value: () => false }); }

const $ = id => document.getElementById(id);
const encoder = new TextEncoder();
const MAX_COMMAND_LENGTH = 8192;
let config = {};
try { config = JSON.parse($('eya-config').textContent) || {}; } catch { /* Defaults are safe. */ }
let preferences = {};
try { preferences = JSON.parse(localStorage.getItem('eya-settings') || '{}') || {}; } catch { /* Storage is optional. */ }
const themes = {
  dark: { background: '#10151b', foreground: '#e4edf2' },
  light: { background: '#f4f5f1', foreground: '#1c2830', cursor: '#1c2830' },
};
const validNumber = (value, min, max, fallback) => Number.isInteger(value) && value >= min && value <= max ? value : fallback;
const validBoolean = (value, fallback) => typeof value === 'boolean' ? value : fallback;
const fontSize = validNumber(preferences.fontSize, 8, 36, validNumber(config.fontSize, 8, 36, 15));
const scrollback = validNumber(preferences.scrollback, 0, 50000, validNumber(config.scrollback, 0, 50000, 5000));
const theme = themes[preferences.theme] ? preferences.theme : (themes[config.theme] ? config.theme : 'dark');
const cursorBlink = validBoolean(preferences.cursorBlink, validBoolean(config.cursorBlink, true));
const cursorStyle = ['block', 'underline', 'bar'].includes(preferences.cursorStyle) ? preferences.cursorStyle : (['block', 'underline', 'bar'].includes(config.cursorStyle) ? config.cursorStyle : 'block');
const localEcho = validBoolean(preferences.localEcho, validBoolean(config.localEcho, false));
const scrollOnUserInput = validBoolean(preferences.scrollOnUserInput, validBoolean(config.scrollOnUserInput, true));
const panelVisible = validBoolean(preferences.panelVisible, validBoolean(config.panelVisible, false));
const splitDirection = ['vertical', 'horizontal'].includes(preferences.splitDirection) ? preferences.splitDirection : (['vertical', 'horizontal'].includes(config.splitDirection) ? config.splitDirection : 'vertical');
const panelSize = validNumber(preferences.panelSize, 25, 75, validNumber(config.panelSize, 25, 75, 46));
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
let rtt = 180;
let echoTimer, echoSequence = 0;
let echoQueue = [];
let ctrlArmed = false;
let viewportFrame;
let directionTimer, directionInterval, activeDirection = '';
let touchGesture;
let fileRequestId = 0, fileRefreshTimer, fileSearchTimer;
let currentPath = '', directoryEntries = [], selectedEntry, historyPaths = [], historyIndex = -1;
let activeFileTab = 'browser';
const filePending = new Map();
const fileTabs = new Map();
const decoder = new TextDecoder();
const fatalDecoder = new TextDecoder('utf-8', { fatal: true });
const TEXT_EDITOR_LIMIT = 5 * 1024 * 1024;

async function deriveKey(secret) {
  // Keep generated clients compatible with the original hexadecimal key format.
  if (/^[0-9a-f]{64}$/i.test(secret)) return Uint8Array.from(secret.match(/../g), hex => parseInt(hex, 16));
  if (!crypto?.subtle) throw Error('This browser cannot derive a key from a password.');
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(secret)));
}

try { $('url').value = config.url || localStorage.getItem('eya-url') || ''; } catch { $('url').value = config.url || ''; }
$('key').value = config.key || '';
$('default-command').value = typeof config.defaultCommand === 'string' ? config.defaultCommand : '';
$('font-size').value = fontSize;
$('scrollback').value = scrollback;
$('theme').value = theme;
$('cursor-blink').checked = cursorBlink;
$('cursor-style').value = cursorStyle;
$('local-echo').checked = localEcho;
$('scroll-on-input').checked = scrollOnUserInput;
$('panel-visible').checked = panelVisible;
$('split-direction').value = splitDirection;
$('panel-size').value = panelSize;
$('panel-size-value').textContent = panelSize;
$('refresh-interval').value = refreshInterval;
$('show-hidden').checked = showHidden;
$('editor-wrap').checked = editorWrap;
$('editor-line-numbers').checked = editorLineNumbers;
$('confirm-delete').checked = confirmDelete;
$('starting-directory').value = startingDirectory;
document.body.dataset.split = splitDirection;
document.documentElement.style.setProperty('--panel-size', `${panelSize}%`);
document.body.classList.toggle('panel-visible', panelVisible);
$('files').setAttribute('aria-pressed', String(panelVisible));

function status(text) { $('status').textContent = text; }
function error(text) { $('error').textContent = text; $('error').hidden = !text; }
function setDialogError(text) {
  const target = $('settings-dialog').open ? $('settings-error') : $('dialog-error');
  target.textContent = text;
  target.hidden = !text;
}
function openDialog(dialog) { if (!dialog.open) dialog.showModal(); }
function closeDialog(dialog) { if (dialog.open) dialog.close(); }
function echoDelay() { return Math.max(80, Math.min(500, Math.round(rtt * 0.8))); }
function viewingLiveOutput() {
  const buffer = terminal.buffer.active;
  return buffer.viewportY === buffer.baseY;
}
function clearLocalEcho() { echoQueue = []; clearTimeout(echoTimer); }
function eraseEcho(entries) {
  // Predictions are deliberately restricted to printable one-cell ASCII that does not wrap.
  // This gives us a safe way to retract them before rendering unexpected server output.
  const count = entries.filter(entry => entry.echoed).length;
  if (count) terminal.write('\b \b'.repeat(count));
}
function scheduleEcho() {
  clearTimeout(echoTimer);
  const sequence = ++echoSequence;
  echoTimer = setTimeout(() => {
    if (sequence !== echoSequence || !outbound || !$('local-echo').checked) return;
    if (!viewingLiveOutput()) { clearLocalEcho(); return; }
    const active = terminal.buffer.active;
    for (const entry of echoQueue) {
      if (entry.echoed || performance.now() - entry.sent < echoDelay()) continue;
      // Do not predict past the right edge: wrapped predictions cannot be safely retracted.
      if (active.cursorX >= terminal.cols - 1) break;
      terminal.write(entry.text);
      entry.echoed = true;
    }
    if (echoQueue.some(entry => !entry.echoed)) scheduleEcho();
  }, echoDelay());
}
function queueLocalEcho(data) {
  if (!$('local-echo').checked || !outbound || !viewingLiveOutput()) return;
  // The server can transform arrow keys, control sequences, Unicode widths and line editing.
  // Limit prediction to the portion that has one obvious terminal representation.
  if (!/^[\x20-\x7e]+$/.test(data)) { clearLocalEcho(); return; }
  const now = performance.now();
  for (const text of data) echoQueue.push({ text, sent: now, echoed: false });
  echoQueue = echoQueue.slice(-120);
  scheduleEcho();
}
function reconcileLocalEcho(output) {
  if (!echoQueue.length) return output;
  let index = 0, suppressed = 0, stillSuppressing = true;
  while (index < output.length && echoQueue.length && output[index] === echoQueue[0].text.charCodeAt(0)) {
    const entry = echoQueue.shift();
    if (stillSuppressing && entry.echoed) suppressed++;
    else stillSuppressing = false;
    index++;
  }
  if (index) {
    if (!echoQueue.length) clearTimeout(echoTimer);
    // Only hide bytes already rendered locally. Fast server echo must still be rendered.
    return output.subarray(suppressed);
  }
  // Server output is not the echo we predicted (for example, a password prompt or a full-screen
  // program). Remove pending predictions before giving the server the final say.
  if (echoQueue.some(entry => entry.echoed)) eraseEcho(echoQueue);
  clearLocalEcho();
  return output;
}
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
function sendInput(data) {
  const bytes = encoder.encode(data);
  for (let i = 0; i < bytes.length; i += 60000) {
    const chunk = bytes.subarray(i, i + 60000);
    const message = new Uint8Array(chunk.length + 1);
    message.set(chunk, 1);
    if (!send(message)) return false;
  }
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
  clearLocalEcho();
  sendInput(data);
  terminal.focus();
}
function resize() {
  try { fit.fit(); } catch { return; }
  if (outbound) {
    const cols = terminal.cols, rows = terminal.rows;
    send(Uint8Array.of(1, cols >> 8, cols & 255, rows >> 8, rows & 255));
  }
}
function scheduleResize() {
  cancelAnimationFrame(viewportFrame);
  viewportFrame = requestAnimationFrame(() => {
    if (window.visualViewport) document.documentElement.style.setProperty('--eya-viewport-height', `${window.visualViewport.height}px`);
    resize();
  });
}
window.addEventListener('resize', scheduleResize);
window.visualViewport?.addEventListener('resize', scheduleResize);
window.visualViewport?.addEventListener('scroll', scheduleResize);
terminal.onData(data => {
  data = applyCtrl(data);
  queueLocalEcho(data);
  sendInput(data);
});

const keyActions = {
  escape: () => sendKey('\x1b'),
  tab: () => sendKey('\t'),
  ctrl: () => { setCtrlArmed(!ctrlArmed); terminal.focus(); },
  paste: () => pasteFromClipboard(),
};
for (const button of document.querySelectorAll('#keybar [data-key]')) {
  button.addEventListener('pointerdown', event => {
    event.preventDefault();
    keyActions[button.dataset.key]?.();
  });
  button.addEventListener('click', event => {
    // Keyboard activation has no preceding pointer event.
    if (event.detail === 0) keyActions[button.dataset.key]?.();
  });
}

const directionKeys = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' };
function directionAt(event) {
  const rect = $('arrow-pad').getBoundingClientRect();
  const x = event.clientX - rect.left - rect.width / 2;
  const y = event.clientY - rect.top - rect.height / 2;
  if (Math.hypot(x, y) < Math.min(rect.width, rect.height) * 0.16) return '';
  return Math.abs(x) > Math.abs(y) ? (x < 0 ? 'left' : 'right') : (y < 0 ? 'up' : 'down');
}
function stopDirection() {
  clearTimeout(directionTimer);
  clearInterval(directionInterval);
  directionTimer = directionInterval = undefined;
  activeDirection = '';
  $('arrow-pad').dataset.direction = '';
}
function setDirection(direction) {
  if (direction === activeDirection) return;
  clearTimeout(directionTimer);
  clearInterval(directionInterval);
  activeDirection = direction;
  $('arrow-pad').dataset.direction = direction;
  if (!direction) return;
  sendKey(directionKeys[direction]);
  directionTimer = setTimeout(() => {
    directionInterval = setInterval(() => {
      const key = directionKeys[activeDirection];
      if (key) sendKey(key);
    }, 75);
  }, 360);
}
$('arrow-pad').addEventListener('pointerdown', event => {
  event.preventDefault();
  $('arrow-pad').setPointerCapture(event.pointerId);
  setDirection(directionAt(event));
});
$('arrow-pad').addEventListener('pointermove', event => {
  if ($('arrow-pad').hasPointerCapture(event.pointerId)) setDirection(directionAt(event));
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) $('arrow-pad').addEventListener(type, stopDirection);
$('arrow-pad').addEventListener('keydown', event => {
  const direction = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' })[event.key];
  if (direction) { event.preventDefault(); sendKey(directionKeys[direction]); }
});

function fallbackCopy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.cssText = 'position:fixed;opacity:0;inset:0';
  (document.body || document.querySelector('body')).append(area);
  area.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { /* Clipboard API may be unavailable too. */ }
  area.remove();
  return copied;
}
async function copySelection() {
  const text = terminal.getSelection();
  if (!text) return;
  try { await navigator.clipboard.writeText(text); }
  catch { if (!fallbackCopy(text)) error('The selection could not be copied.'); }
  hideTerminalMenu();
  terminal.focus();
}
async function pasteFromClipboard() {
  setCtrlArmed(false);
  let text;
  try { text = await navigator.clipboard.readText(); }
  catch { text = window.prompt('Paste terminal text:'); }
  if (typeof text === 'string' && text) terminal.paste(text);
  hideTerminalMenu();
  terminal.focus();
}
function showTerminalMenu(x, y) {
  const menu = $('terminal-menu');
  $('copy-selection').disabled = !terminal.hasSelection();
  menu.hidden = false;
  const width = menu.offsetWidth, height = menu.offsetHeight;
  menu.style.left = `${Math.max(6, Math.min(x, innerWidth - width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, (window.visualViewport?.height || innerHeight) - height - 6))}px`;
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

function applySettings() {
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
  const sizePercent = Number($('panel-size').value);
  const interval = Number($('refresh-interval').value);
  document.body.dataset.split = $('split-direction').value;
  document.documentElement.style.setProperty('--panel-size', `${sizePercent}%`);
  $('panel-size-value').textContent = sizePercent;
  setPanelVisible($('panel-visible').checked, false);
  try {
    localStorage.setItem('eya-settings', JSON.stringify({
      fontSize: size, scrollback: lines, theme: $('theme').value,
      cursorBlink: $('cursor-blink').checked, cursorStyle: $('cursor-style').value,
      localEcho: $('local-echo').checked, scrollOnUserInput: $('scroll-on-input').checked,
      panelVisible: $('panel-visible').checked, splitDirection: $('split-direction').value,
      panelSize: sizePercent, refreshInterval: interval, showHidden: $('show-hidden').checked,
      editorWrap: $('editor-wrap').checked, editorLineNumbers: $('editor-line-numbers').checked,
      confirmDelete: $('confirm-delete').checked, startingDirectory: $('starting-directory').value.trim(),
    }));
  } catch { /* Storage is optional. */ }
  if (!$('local-echo').checked) clearLocalEcho();
  restartFileRefresh();
  updateEditorConfiguration();
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
function disconnect() {
  connectionId++;
  failed = false;
  clearInterval(pingTimer);
  clearLocalEcho();
  socket?.close();
  socket = outbound = inbound = null;
  awaitingHandshake = false;
  rejectFileRequests('Disconnected.');
  clearInterval(fileRefreshTimer);
  $('file-status').textContent = 'Connect to browse files.';
  $('latency').textContent = '';
  status('Disconnected');
}

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
$('disconnect').onclick = disconnect;
$('close-connect').onclick = () => closeDialog($('connect-dialog'));
$('close-settings').onclick = () => { closeDialog($('settings-dialog')); terminal.focus(); };
for (const id of ['font-size', 'scrollback', 'theme', 'cursor-blink', 'cursor-style', 'local-echo', 'scroll-on-input', 'panel-visible', 'split-direction', 'panel-size', 'refresh-interval', 'show-hidden', 'editor-wrap', 'editor-line-numbers', 'confirm-delete', 'starting-directory']) {
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
  document.body.classList.toggle('panel-visible', visible);
  $('files').setAttribute('aria-pressed', String(visible));
  $('panel-visible').checked = visible;
  if (remember) applySettings();
  if (visible && outbound && !currentPath) navigateTo($('starting-directory').value.trim(), true);
  scheduleResize();
}

function restartFileRefresh() {
  clearInterval(fileRefreshTimer);
  const seconds = Number($('refresh-interval').value);
  if (seconds > 0) fileRefreshTimer = setInterval(() => {
    if (!document.hidden && outbound && document.body.classList.contains('panel-visible')) refreshFiles(true);
  }, seconds * 1000);
}

function nextFileRequestId() {
  do { fileRequestId = (fileRequestId + 1) >>> 0 || 1; } while (filePending.has(fileRequestId));
  return fileRequestId;
}

function sendFileControl(id, op, values = {}) {
  const jsonBytes = encoder.encode(JSON.stringify({ id, op, ...values }));
  const message = new Uint8Array(jsonBytes.length + 1);
  message[0] = 4;
  message.set(jsonBytes, 1);
  if (!send(message)) throw Error('Not connected.');
}

function fileRequest(op, values = {}) {
  const id = nextFileRequestId();
  return new Promise((resolve, reject) => {
    filePending.set(id, { resolve, reject, onJson(response) { filePending.delete(id); resolve(response); } });
    try { sendFileControl(id, op, values); } catch (cause) { filePending.delete(id); reject(cause); }
  });
}

function readFile(path) {
  const id = nextFileRequestId();
  return new Promise((resolve, reject) => {
    filePending.set(id, { resolve, reject, chunks: [], meta: null, onJson(response) { this.meta = response; } });
    try { sendFileControl(id, 'read', { path }); } catch (cause) { filePending.delete(id); reject(cause); }
  });
}

function uploadBytes(path, bytes, overwrite) {
  const id = nextFileRequestId();
  return new Promise((resolve, reject) => {
    filePending.set(id, {
      resolve, reject,
      onJson(response) {
        if (response.ready) sendUploadChunks(id, bytes).catch(cause => { filePending.delete(id); reject(cause); });
        else if (response.done) { filePending.delete(id); resolve(response); }
      },
    });
    try { sendFileControl(id, 'write', { path, size: bytes.byteLength, overwrite }); }
    catch (cause) { filePending.delete(id); reject(cause); }
  });
}

async function sendUploadChunks(id, bytes) {
  const length = bytes.byteLength;
  if (!length) {
    const message = new Uint8Array(6); message[0] = 5; new DataView(message.buffer).setUint32(1, id); message[5] = 1;
    if (!send(message)) throw Error('Upload failed.');
    return;
  }
  for (let offset = 0; offset < length; offset += 60000) {
    while (socket?.bufferedAmount > 512 * 1024) await new Promise(resolve => setTimeout(resolve, 20));
    const chunk = bytes.subarray(offset, Math.min(length, offset + 60000));
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
  $('file-status').textContent = 'Loading…';
  try {
    const response = await fileRequest('list', { path: path || $('starting-directory').value.trim(), showHidden: $('show-hidden').checked });
    currentPath = response.path;
    directoryEntries = response.entries;
    selectedEntry = undefined;
    $('file-path').value = currentPath;
    $('file-search').value = '';
    if (push && historyPaths[historyIndex] !== currentPath) {
      historyPaths = historyPaths.slice(0, historyIndex + 1);
      historyPaths.push(currentPath);
      historyIndex = historyPaths.length - 1;
    }
    renderDirectory();
    updateNavigationButtons();
    $('file-status').textContent = `${directoryEntries.length} item${directoryEntries.length === 1 ? '' : 's'} in ${currentPath}`;
  } catch (cause) { fileFailure(cause); }
}

function renderDirectory() {
  const body = $('file-list');
  body.replaceChildren();
  for (const item of directoryEntries) {
    const row = document.createElement('tr');
    row.tabIndex = 0;
    row.dataset.path = item.path;
    row.classList.toggle('selected', selectedEntry?.path === item.path);
    const name = document.createElement('td');
    name.textContent = `${item.kind === 'directory' ? '📁' : item.kind === 'symlink' ? '↗' : '📄'} ${item.name}`;
    name.title = item.path;
    const size = document.createElement('td'); size.className = 'size'; size.textContent = item.kind === 'directory' ? '—' : formatSize(item.size);
    const modified = document.createElement('td'); modified.className = 'modified'; modified.textContent = item.modified ? new Date(item.modified).toLocaleString() : '—';
    row.append(name, size, modified);
    row.addEventListener('click', () => selectEntry(item));
    row.addEventListener('dblclick', () => activateEntry(item));
    row.addEventListener('keydown', event => { if (event.key === 'Enter') activateEntry(item); });
    body.append(row);
  }
  $('file-empty').hidden = !!directoryEntries.length;
  $('file-empty').textContent = $('file-search').value ? 'No matching files.' : 'This directory is empty.';
  updateSelectionButtons();
}

function selectEntry(item) { selectedEntry = item; renderDirectory(); }
function activateEntry(item) { if (item.kind === 'directory') navigateTo(item.path, true); else openFile(item.path); }
function updateSelectionButtons() {
  $('file-download').disabled = !selectedEntry || selectedEntry.kind === 'directory';
  $('file-rename').disabled = !selectedEntry;
  $('file-delete').disabled = !selectedEntry;
}
function updateNavigationButtons() {
  $('file-back').disabled = historyIndex <= 0;
  $('file-forward').disabled = historyIndex < 0 || historyIndex >= historyPaths.length - 1;
  $('file-up').disabled = !currentPath || currentPath === '/';
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
  try {
    $('file-status').textContent = `Searching ${currentPath}…`;
    const response = await fileRequest('search', { path: currentPath, query, showHidden: $('show-hidden').checked });
    if ($('file-search').value.trim() !== query) return;
    directoryEntries = response.entries;
    selectedEntry = undefined;
    renderDirectory();
    $('file-status').textContent = `${directoryEntries.length} result${directoryEntries.length === 1 ? '' : 's'} for “${query}”`;
  } catch (cause) { fileFailure(cause); }
}

async function refreshFiles(automatic = false) {
  if (!currentPath || $('file-search').value) return;
  await navigateTo(currentPath, false);
  const tab = fileTabs.get(activeFileTab);
  if (automatic && tab && !tab.dirty) await openFile(tab.path, true);
}

const textExtensions = new Set(['txt','md','markdown','js','mjs','cjs','ts','tsx','jsx','json','html','htm','css','scss','xml','svg','yml','yaml','toml','ini','conf','cfg','sh','bash','zsh','fish','py','rb','rs','go','java','c','h','cpp','hpp','cs','php','sql','log','env','gitignore']);
const imageExtensions = new Set(['png','jpg','jpeg','gif','webp','avif','bmp','ico','svg']);
const videoExtensions = new Set(['mp4','webm','ogv','mov','m4v']);
function extension(path) { const name = baseName(path); return name.includes('.') ? name.split('.').at(-1).toLowerCase() : ''; }
function likelyText(path, bytes) {
  if (bytes.length > TEXT_EDITOR_LIMIT || bytes.subarray(0, 8192).includes(0)) return false;
  if (textExtensions.has(extension(path))) return true;
  try { fatalDecoder.decode(bytes); return true; } catch { return false; }
}
function languageFor(path) {
  const ext = extension(path);
  if (ext === 'json') return json();
  if (['js','mjs','cjs','ts','tsx','jsx'].includes(ext)) return javascript({ typescript: ['ts','tsx'].includes(ext), jsx: ['jsx','tsx'].includes(ext) });
  if (['html','htm'].includes(ext)) return html();
  if (['css','scss'].includes(ext)) return css();
  if (['md','markdown'].includes(ext)) return markdown();
  return [];
}

const fileViewers = [
  { name: 'image', supports: tab => imageExtensions.has(extension(tab.path)), render: renderImageViewer },
  { name: 'video', supports: tab => videoExtensions.has(extension(tab.path)), render: renderVideoViewer },
  { name: 'text', supports: tab => likelyText(tab.path, tab.bytes), render: renderTextEditor },
  { name: 'generic', supports: () => true, render: renderGenericViewer },
];

async function openFile(path, force = false) {
  const existing = fileTabs.get(path);
  if (existing && !force) { activateFileTab(path); return; }
  try {
    $('file-status').textContent = `Opening ${path}…`;
    const result = await readFile(path);
    if (existing && force) {
      if (existing.modified === result.meta.modified && existing.bytes.length === result.bytes.length) return;
      existing.bytes = result.bytes; existing.modified = result.meta.modified;
      if (existing.viewer === 'text') existing.text = decoder.decode(result.bytes);
      renderTabContent(existing);
      $('file-status').textContent = `${baseName(path)} refreshed after an external change.`;
      return;
    }
    const tab = { path, name: baseName(path), bytes: result.bytes, modified: result.meta.modified, dirty: false, view: null, node: null, url: null };
    fileTabs.set(path, tab);
    renderTabContent(tab);
    renderTabs();
    activateFileTab(path);
    $('file-status').textContent = `${tab.name} · ${formatSize(tab.bytes.length)}`;
  } catch (cause) { fileFailure(cause); }
}

function createViewerShell(tab, save = false) {
  const root = document.createElement('div'); root.className = 'viewer';
  const actions = document.createElement('div'); actions.className = 'viewer-actions';
  const path = document.createElement('span'); path.className = 'viewer-path'; path.textContent = tab.path; path.title = tab.path;
  actions.append(path);
  if (save) {
    const button = document.createElement('button'); button.textContent = 'Save'; button.addEventListener('click', () => saveTab(tab)); actions.append(button); tab.saveButton = button;
  }
  const download = document.createElement('button'); download.textContent = 'Download'; download.addEventListener('click', () => downloadTab(tab)); actions.append(download);
  const body = document.createElement('div'); body.className = 'viewer-body';
  root.append(actions, body);
  return { root, body };
}

function renderTabContent(tab) {
  tab.view?.destroy(); tab.view = null;
  if (tab.url) URL.revokeObjectURL(tab.url);
  tab.node?.remove();
  const provider = fileViewers.find(value => value.supports(tab));
  tab.viewer = provider.name;
  tab.node = provider.render(tab);
  tab.node.dataset.path = tab.path;
  tab.node.hidden = activeFileTab !== tab.path;
  $('viewer-view').append(tab.node);
}

function renderTextEditor(tab) {
  const shell = createViewerShell(tab, true);
  const host = document.createElement('div'); host.className = 'editor-host'; shell.body.append(host);
  const text = tab.text ?? decoder.decode(tab.bytes); tab.text = text;
  const extensions = [
    history(), drawSelection(), highlightActiveLine(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), languageFor(tab.path),
    keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { saveTab(tab); return true; } }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
    EditorView.updateListener.of(update => { if (update.docChanged) { tab.text = update.state.doc.toString(); setTabDirty(tab, true); } }),
    EditorView.theme({ '&': { backgroundColor: '#101820', color: '#e4edf2' }, '.cm-content': { caretColor: '#7fdbc5' }, '.cm-gutters': { backgroundColor: '#17232c', color: '#8399a4', border: 'none' }, '&.cm-focused .cm-cursor': { borderLeftColor: '#7fdbc5' }, '.cm-activeLine,.cm-activeLineGutter': { backgroundColor: '#1d2b34' } }, { dark: true }),
  ];
  if ($('editor-line-numbers').checked) extensions.push(lineNumbers());
  if ($('editor-wrap').checked) extensions.push(EditorView.lineWrapping);
  tab.view = new EditorView({ state: EditorState.create({ doc: text, extensions }), parent: host });
  return shell.root;
}

function renderImageViewer(tab) {
  const shell = createViewerShell(tab);
  tab.url = URL.createObjectURL(new Blob([tab.bytes]));
  const image = document.createElement('img'); image.src = tab.url; image.alt = tab.name; shell.body.append(image); return shell.root;
}
function renderVideoViewer(tab) {
  const shell = createViewerShell(tab);
  tab.url = URL.createObjectURL(new Blob([tab.bytes]));
  const video = document.createElement('video'); video.src = tab.url; video.controls = true; video.playsInline = true; shell.body.append(video); return shell.root;
}
function renderGenericViewer(tab) {
  const shell = createViewerShell(tab);
  const message = document.createElement('div'); message.className = 'viewer-message'; message.textContent = `No inline viewer is registered for this ${formatSize(tab.bytes.length)} file. Download it to open it in another app.`; shell.body.append(message); return shell.root;
}

function renderTabs() {
  const bar = $('file-tabs');
  for (const button of [...bar.querySelectorAll('[data-tab]:not([data-tab=browser])')]) button.remove();
  for (const tab of fileTabs.values()) {
    const button = document.createElement('button'); button.className = 'file-tab'; button.dataset.tab = tab.path; button.title = tab.path;
    const name = document.createElement('span'); name.className = 'file-tab-name'; name.textContent = tab.name;
    const dirty = document.createElement('span'); dirty.className = 'tab-dirty'; dirty.textContent = tab.dirty ? '●' : '';
    const close = document.createElement('span'); close.className = 'tab-close'; close.textContent = '×'; close.setAttribute('role', 'button'); close.setAttribute('aria-label', `Close ${tab.name}`);
    close.addEventListener('click', event => { event.stopPropagation(); closeFileTab(tab.path); });
    button.append(name, dirty, close); button.addEventListener('click', () => activateFileTab(tab.path)); bar.append(button);
  }
  updateActiveTabClasses();
}

function activateFileTab(path) {
  activeFileTab = path;
  $('browser-view').classList.toggle('active', path === 'browser');
  $('viewer-view').classList.toggle('active', path !== 'browser');
  for (const tab of fileTabs.values()) if (tab.node) tab.node.hidden = tab.path !== path;
  updateActiveTabClasses();
  fileTabs.get(path)?.view?.focus();
}
function updateActiveTabClasses() { for (const button of $('file-tabs').querySelectorAll('[data-tab]')) button.classList.toggle('active', button.dataset.tab === activeFileTab); }
function closeFileTab(path) {
  const tab = fileTabs.get(path); if (!tab) return;
  if (tab.dirty && !confirm(`Discard unsaved changes to ${tab.name}?`)) return;
  tab.view?.destroy(); if (tab.url) URL.revokeObjectURL(tab.url); tab.node?.remove(); fileTabs.delete(path);
  if (activeFileTab === path) activateFileTab('browser');
  renderTabs();
}
function setTabDirty(tab, dirty) {
  if (tab.dirty === dirty) return;
  tab.dirty = dirty;
  if (tab.saveButton) tab.saveButton.disabled = !dirty;
  renderTabs();
}
async function saveTab(tab) {
  try {
    tab.saveButton.disabled = true; $('file-status').textContent = `Saving ${tab.path}…`;
    const bytes = encoder.encode(tab.text ?? '');
    await uploadBytes(tab.path, bytes, true);
    tab.bytes = bytes; setTabDirty(tab, false); $('file-status').textContent = `${tab.name} saved.`;
    await navigateTo(currentPath, false);
  } catch (cause) { setTabDirty(tab, true); fileFailure(cause); }
}
function downloadBlob(path, bytes) {
  const url = URL.createObjectURL(new Blob([bytes])); const link = document.createElement('a'); link.href = url; link.download = baseName(path); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadTab(tab) { downloadBlob(tab.path, tab.viewer === 'text' ? encoder.encode(tab.text) : tab.bytes); }
function updateEditorConfiguration() { for (const tab of fileTabs.values()) if (tab.viewer === 'text') renderTabContent(tab); }

$('files').onclick = () => setPanelVisible(!document.body.classList.contains('panel-visible'));
$('file-close').onclick = () => setPanelVisible(false);
$('file-tabs').querySelector('[data-tab=browser]').onclick = () => activateFileTab('browser');
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
$('file-upload').onclick = () => $('file-upload-input').click();
$('file-upload-input').addEventListener('change', async () => {
  for (const file of $('file-upload-input').files) {
    const path = `${currentPath}/${file.name}`;
    try { $('file-status').textContent = `Uploading ${file.name}…`; await uploadBytes(path, new Uint8Array(await file.arrayBuffer()), false); }
    catch (cause) {
      if (cause.message.includes('already exists') && confirm(`${file.name} already exists. Replace it?`)) {
        try { await uploadBytes(path, new Uint8Array(await file.arrayBuffer()), true); } catch (retryCause) { fileFailure(retryCause); break; }
      } else { fileFailure(cause); break; }
    }
  }
  $('file-upload-input').value = ''; await navigateTo(currentPath, false);
});
$('file-download').onclick = async () => {
  if (!selectedEntry) return;
  try { $('file-status').textContent = `Downloading ${selectedEntry.name}…`; const result = await readFile(selectedEntry.path); downloadBlob(selectedEntry.path, result.bytes); $('file-status').textContent = `${selectedEntry.name} downloaded.`; } catch (cause) { fileFailure(cause); }
};
$('file-rename').onclick = async () => {
  if (!selectedEntry) return; const name = prompt('New name:', selectedEntry.name); if (!name || name === selectedEntry.name) return;
  try { await fileRequest('rename', { path: selectedEntry.path, newPath: name }); await navigateTo(currentPath, false); } catch (cause) { fileFailure(cause); }
};
$('file-delete').onclick = async () => {
  if (!selectedEntry) return;
  if ($('confirm-delete').checked && !confirm(`Delete ${selectedEntry.name}${selectedEntry.kind === 'directory' ? ' and everything inside it' : ''}? This cannot be undone.`)) return;
  try { await fileRequest('delete', { path: selectedEntry.path, recursive: selectedEntry.kind === 'directory' }); closeFileTab(selectedEntry.path); await navigateTo(currentPath, false); } catch (cause) { fileFailure(cause); }
};

$('start-connection').onclick = async () => {
  if (!applySettings()) return;
  const connection = validateConnection();
  if (!connection) return;
  const attempt = ++connectionId;
  try { localStorage.setItem('eya-url', connection.url.href); } catch { /* Storage is optional for local files. */ }
  socket?.close();
  clearInterval(pingTimer);
  socket = outbound = inbound = null;
  clearLocalEcho();
  failed = false;
  error('');
  $('latency').textContent = '';
  // A fresh session must never inherit another session's prompt or scrollback.
  terminal.reset();
  terminal.clear();
  let handshake, current;
  try {
    const psk = await deriveKey($('key').value);
    if (attempt !== connectionId) return;
    handshake = new Noise('NNpsk0', true, null, { psk });
    handshake.initialise(encoder.encode('eya-terminal-v1'));
    current = new WebSocket(connection.url);
  } catch {
    if (attempt === connectionId) setDialogError('Could not start the encrypted connection. Check the URL and browser support.');
    return;
  }
  if (attempt !== connectionId) { current.close(); return; }
  socket = current;
  current.binaryType = 'arraybuffer';
  awaitingHandshake = true;
  status('Connecting…');
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
        if (!send(encoder.encode('eya-ready-v3'))) throw Error('Could not confirm the encrypted connection');
        status('Connected');
        resize();
        terminal.focus();
        if (document.body.classList.contains('panel-visible')) navigateTo($('starting-directory').value.trim(), true);
        restartFileRefresh();
        if (connection.command) sendInput(connection.command.replace(/\r?\n/g, '\r') + (/[\r\n]$/.test(connection.command) ? '' : '\r'));
        pingTimer = setInterval(() => {
          const message = new Uint8Array(9);
          message[0] = 3;
          new DataView(message.buffer).setFloat64(1, performance.now());
          send(message);
        }, 5000);
      } else {
        if (inbound.nonce >= 0xffffffff) throw Error('Session message limit reached');
        const message = inbound.decrypt(data);
        if (message[0] === 0) {
          const received = message.subarray(1);
          const output = reconcileLocalEcho(received);
          const length = received.length;
          terminal.write(output, () => {
            if (socket === current && outbound) {
              const ack = new Uint8Array(5);
              ack[0] = 2;
              new DataView(ack.buffer).setUint32(1, length);
              send(ack);
            }
          });
        } else if (message[0] === 3 && message.length === 9) {
          const sent = new DataView(message.buffer, message.byteOffset, message.byteLength).getFloat64(1);
          const sample = Math.max(0, performance.now() - sent);
          rtt = Math.round(rtt * 0.75 + sample * 0.25);
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
      error(awaitingHandshake ? 'Authentication failed. Check that the shared passwords match.' : 'Encrypted terminal data was invalid. Reconnect and try again.');
      current.close();
    }
  };
  current.onerror = () => {
    if (socket === current) {
      failed = true;
      error(awaitingHandshake ? 'Could not connect or authenticate. Check the URL, shared password, TLS certificate, network and browser permissions.' : 'The connection failed. Check the network and server availability.');
    }
  };
  current.onclose = () => {
    if (socket === current) {
      clearInterval(pingTimer);
      clearLocalEcho();
      rejectFileRequests('The connection closed.');
      clearInterval(fileRefreshTimer);
      $('latency').textContent = '';
      outbound = inbound = null;
      if (awaitingHandshake && !failed) {
        failed = true;
        error('Authentication did not complete. Check the shared password and server availability.');
      }
      status(failed ? 'Connection failed' : 'Disconnected');
    }
  };
};

openConnection();
