import Noise from 'noise-handshake';
import Cipher from 'noise-handshake/cipher';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

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
const terminal = new Terminal({ cursorBlink, cursorStyle, fontSize, scrollback, scrollOnUserInput, theme: themes[theme] });
const fit = new FitAddon();
terminal.loadAddon(fit); terminal.open($('terminal')); fit.fit();

let socket, outbound, inbound, awaitingHandshake = false, pingTimer, failed = false, connectionId = 0;
let rtt = 180;
let echoTimer, echoSequence = 0;
let echoQueue = [];

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
function resize() {
  try { fit.fit(); } catch { return; }
  if (outbound) {
    const cols = terminal.cols, rows = terminal.rows;
    send(Uint8Array.of(1, cols >> 8, cols & 255, rows >> 8, rows & 255));
  }
}
window.addEventListener('resize', resize);
terminal.onData(data => { queueLocalEcho(data); sendInput(data); });

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
  try {
    localStorage.setItem('eya-settings', JSON.stringify({
      fontSize: size, scrollback: lines, theme: $('theme').value,
      cursorBlink: $('cursor-blink').checked, cursorStyle: $('cursor-style').value,
      localEcho: $('local-echo').checked, scrollOnUserInput: $('scroll-on-input').checked,
    }));
  } catch { /* Storage is optional. */ }
  if (!$('local-echo').checked) clearLocalEcho();
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
for (const id of ['font-size', 'scrollback', 'theme', 'cursor-blink', 'cursor-style', 'local-echo', 'scroll-on-input']) {
  $(id).addEventListener('input', applySettings);
  $(id).addEventListener('change', applySettings);
}

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
        if (!send(encoder.encode('eya-ready-v2'))) throw Error('Could not confirm the encrypted connection');
        status('Connected');
        resize();
        terminal.focus();
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
