import Noise from 'noise-handshake';
import Cipher from 'noise-handshake/cipher';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { buttonIcon, createMenu, menuAction } from './ui.js';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const MAX_INPUT = 256 * 1024;
const offsetMessage = (type, value) => {
  const bytes = new Uint8Array(9); bytes[0] = type;
  new DataView(bytes.buffer).setBigUint64(1, BigInt(value)); return bytes;
};
function readOffset(bytes) {
  const value = Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(1));
  if (!Number.isSafeInteger(value)) throw Error('Invalid terminal offset'); return value;
}
async function deriveKey(secret) {
  if (/^[0-9a-f]{64}$/i.test(secret)) return Uint8Array.from(secret.match(/../g), hex => parseInt(hex, 16));
  if (!globalThis.crypto?.subtle) throw Error('Password authentication requires a secure browser context.');
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(secret)));
}

// Each panel owns its Noise transport and resumable PTY token. Nothing is shared
// with the primary terminal except connection defaults and appearance options.
export function createTerminalPanel({ id, title = 'Terminal', url, key, command = '', options = {}, onStatus, transformInput } = {}) {
  const endpoint = new URL(url);
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || !key) throw Error('Connect to a server before opening a terminal.');
  if (!document.getElementById('instance-terminal-style')) {
    const style = document.createElement('style'); style.id = 'instance-terminal-style';
    style.textContent = '.instance-terminal{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--ui-terminal-bg,#10151b)}.instance-terminal-bar{display:flex;align-items:center;gap:8px;min-height:36px;padding:2px 7px;border-bottom:1px solid var(--ui-border,#344854);font-size:12px}.instance-terminal-status{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ui-muted,#a9bdc6)}.instance-terminal-surface{flex:1;min-height:0;min-width:0;touch-action:none;overflow:hidden}.instance-terminal.offline .instance-terminal-surface{filter:grayscale(.8);opacity:.65}.instance-terminal-bar .icon-button{border-color:transparent;background:transparent}.instance-terminal-surface .xterm-helper-textarea{font-size:16px!important}';
    (document.head || document.querySelector('head')).append(style);
  }
  const element = document.createElement('section'); element.className = 'instance-terminal offline';
  const bar = document.createElement('div'); bar.className = 'instance-terminal-bar';
  const status = document.createElement('span'); status.className = 'instance-terminal-status'; status.setAttribute('role', 'status');
  const retry = document.createElement('button'); retry.type = 'button'; buttonIcon(retry, 'RefreshCw', 'Reconnect terminal', true);
  const menu = createMenu('Terminal actions');
  const clear = document.createElement('button'); clear.type = 'button'; clear.textContent = 'Clear'; menuAction(menu.panel, clear, 'X');
  const end = document.createElement('button'); end.type = 'button'; end.textContent = 'End session'; menuAction(menu.panel, end, 'Unplug');
  const surface = document.createElement('div'); surface.className = 'instance-terminal-surface';
  bar.append(status, retry, menu.element); element.append(bar, surface);
  const terminal = new Terminal({ fontSize: 15, scrollback: 5000, cursorBlink: true, ...options });
  const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(surface);
  const newToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  let token = newToken();
  const session = { token, create: true, output: 0, rendered: 0, input: 0, ack: 0, pending: [], ended: false };
  let socket, inbound, outbound, ready = false, disposed = false, attempts = 0, generation = 0, autoReconnect = true;
  let reconnectTimer, handshakeTimer, heartbeat, flushTimer, lastResponse = Date.now(), commandQueued = false;
  const abort = new AbortController();
  function setStatus(text) { status.textContent = text; status.title = text; onStatus?.(text); }
  function appearance() {
    element.classList.toggle('offline', !ready); retry.disabled = ready; end.disabled = !ready;
    const label = session.ended ? 'Start new terminal session' : 'Reconnect terminal';
    buttonIcon(retry, session.ended ? 'Play' : 'RefreshCw', label, true); retry.title = label;
  }
  function send(bytes) {
    if (!outbound || socket?.readyState !== WebSocket.OPEN) return false;
    if (outbound.nonce >= 0xffffffff || socket.bufferedAmount > 1024 * 1024) { socket.close(); return false; }
    try { socket.send(outbound.encrypt(bytes)); return true; } catch { socket.close(); return false; }
  }
  function acknowledge(offset) {
    if (!Number.isSafeInteger(offset) || offset < session.ack || offset > session.input) throw Error('Invalid terminal acknowledgement');
    session.ack = offset;
    while (session.pending[0] && session.pending[0].offset + session.pending[0].bytes.length <= offset) session.pending.shift();
  }
  function flush() {
    clearTimeout(flushTimer);
    if (!ready || disposed || session.ended) return;
    for (const entry of session.pending) {
      if (entry.sent === generation) continue;
      if (socket.bufferedAmount > 512 * 1024) { flushTimer = setTimeout(flush, 20); return; }
      const bytes = new Uint8Array(9 + entry.bytes.length); bytes.set(offsetMessage(0, entry.offset)); bytes.set(entry.bytes, 9);
      if (!send(bytes)) return; entry.sent = generation;
    }
  }
  function sendInput(text) {
    if (disposed || session.ended) return false;
    const bytes = encoder.encode(String(text));
    if (session.input - session.ack + bytes.length > MAX_INPUT) { setStatus('Input buffer full'); return false; }
    for (let i = 0; i < bytes.length; i += 60000) {
      const chunk = bytes.slice(i, i + 60000); session.pending.push({ offset: session.input, bytes: chunk, sent: -1 }); session.input += chunk.length;
    }
    flush();
    if (!ready) setStatus(`Reconnecting · ${session.input - session.ack} bytes buffered`);
    return true;
  }
  function resize() {
    if (disposed || !surface.clientWidth || !surface.clientHeight) return;
    try { fit.fit(); } catch { return; }
    if (ready) send(Uint8Array.of(1, terminal.cols >> 8, terminal.cols & 255, terminal.rows >> 8, terminal.rows & 255));
  }
  function endSession() {
    autoReconnect = false; session.ended = true; session.pending = [];
    generation++; clearTimeout(reconnectTimer); clearTimeout(flushTimer); clearTimeout(handshakeTimer); clearInterval(heartbeat);
    if (ready) send(Uint8Array.of(10));
    const previous = socket; socket = null; previous?.close(); inbound = outbound = null;
    ready = false; appearance(); setStatus('Session ended');
  }
  function reconnect() {
    if (disposed || session.ended) return;
    autoReconnect = true; clearTimeout(reconnectTimer); connect();
  }
  function restart() {
    if (disposed || !session.ended) return;
    token = newToken(); Object.assign(session, { token, create: true, output: 0, rendered: 0, input: 0, ack: 0, pending: [], ended: false });
    commandQueued = false; attempts = 0; terminal.reset(); reconnect();
  }
  function scheduleReconnect() {
    if (!autoReconnect || disposed || session.ended) return;
    setStatus(`Reconnecting${session.input > session.ack ? ` · ${session.input - session.ack} bytes buffered` : '…'}`);
    clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, Math.min(10000, 500 * 2 ** Math.min(attempts++, 5)));
  }
  async function connect() {
    if (disposed || session.ended || !autoReconnect) return;
    const attempt = ++generation;
    clearTimeout(reconnectTimer); clearTimeout(handshakeTimer); clearTimeout(flushTimer); clearInterval(heartbeat);
    const previous = socket; socket = null; previous?.close(); inbound = outbound = null; ready = false; appearance();
    setStatus(session.create ? 'Connecting…' : 'Reconnecting…');
    let handshake, current;
    try {
      const psk = await deriveKey(key); if (attempt !== generation || disposed || session.ended || !autoReconnect) return;
      handshake = new Noise('NNpsk0', true, null, { psk }); handshake.initialise(encoder.encode('eya-terminal-v1'));
      current = new WebSocket(endpoint.href);
    } catch (error) {
      if (attempt !== generation || disposed || session.ended) return;
      autoReconnect = false; setStatus(error.message || 'Connection failed'); return;
    }
    socket = current; current.binaryType = 'arraybuffer'; let awaiting = true; lastResponse = Date.now();
    handshakeTimer = setTimeout(() => { if (socket === current && !ready) current.close(); }, 12000);
    current.onopen = () => { if (socket === current) { try { current.send(handshake.send()); } catch { current.close(); } } };
    current.onmessage = event => {
      if (socket !== current || disposed || session.ended) return;
      try {
        const data = new Uint8Array(event.data);
        if (awaiting) {
          handshake.recv(data); if (!handshake.complete) throw Error('Incomplete authentication');
          outbound = new Cipher(handshake.tx); inbound = new Cipher(handshake.rx); awaiting = false;
          if (!send(encoder.encode('eya-ready-v4:' + JSON.stringify({ token, output: session.output, create: session.create })))) throw Error('Connection failed');
          return;
        }
        if (inbound.nonce >= 0xffffffff) throw Error('Terminal message limit reached');
        const message = inbound.decrypt(data); lastResponse = Date.now();
        if (message[0] === 7) {
          const state = JSON.parse(decoder.decode(message.subarray(1)));
          if (state.state !== 'ready') { autoReconnect = false; session.ended = true; session.pending = []; setStatus(state.message || 'Session ended'); current.close(); return; }
          if (state.output !== session.output) throw Error('Terminal replay offsets differ');
          acknowledge(state.input); session.create = false; ready = true; attempts = 0; clearTimeout(handshakeTimer); appearance(); setStatus('Connected'); resize(); flush();
          if (!commandQueued) { commandQueued = true; if (command) sendInput(command.replace(/\r?\n/g, '\r') + (/[\r\n]$/.test(command) ? '' : '\r')); }
          heartbeat = setInterval(() => {
            if (Date.now() - lastResponse > 15000) { current.close(); return; }
            const bytes = new Uint8Array(9); bytes[0] = 3; new DataView(bytes.buffer).setFloat64(1, performance.now()); send(bytes);
          }, 5000);
        } else if (message[0] === 8 && message.length >= 9 && ready) {
          const offset = readOffset(message); if (offset > session.output) throw Error('Missing terminal output');
          const bytes = message.subarray(9); const received = bytes.subarray(Math.min(bytes.length, session.output - offset));
          session.output += received.length; const accepted = session.output;
          terminal.write(received, () => { session.rendered = Math.max(session.rendered, accepted); if (socket === current && ready) send(offsetMessage(2, session.rendered)); });
        } else if (message[0] === 9 && message.length === 9) { acknowledge(readOffset(message)); flush(); }
        else if (message[0] !== 3) throw Error('Unexpected terminal message');
      } catch (error) { autoReconnect = false; setStatus(awaiting ? 'Authentication failed' : error.message || 'Terminal connection failed'); current.close(); }
    };
    current.onclose = () => {
      if (socket !== current) return;
      ready = false; inbound = outbound = null; clearInterval(heartbeat); clearTimeout(handshakeTimer); clearTimeout(flushTimer); appearance();
      if (autoReconnect && !session.ended) scheduleReconnect();
    };
    current.onerror = () => {};
  }
  const observer = new ResizeObserver(resize); observer.observe(surface);
  const onData = terminal.onData(data => { const input = transformInput ? transformInput(data) : data; if (typeof input === 'string' && input.length) sendInput(input); });
  clear.onclick = () => terminal.clear(); end.onclick = endSession; retry.onclick = () => session.ended ? restart() : reconnect();
  const online = () => { if (!ready && autoReconnect && !session.ended) reconnect(); };
  window.addEventListener('online', online, { signal: abort.signal });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) online(); }, { signal: abort.signal });
  // Scroll the xterm buffer rather than the fixed page on touch devices.
  let touch;
  surface.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch') return;
    touch = { id: event.pointerId, y: event.clientY, moved: false }; surface.setPointerCapture(event.pointerId);
  }, { signal: abort.signal });
  surface.addEventListener('pointermove', event => {
    if (touch?.id !== event.pointerId) return;
    const height = surface.querySelector('.xterm-screen')?.getBoundingClientRect().height / terminal.rows || 16;
    const lines = Math.trunc((touch.y - event.clientY) / Math.max(height, 1));
    if (lines) { event.preventDefault(); terminal.scrollLines(lines); touch.y -= lines * height; touch.moved = true; }
  }, { signal: abort.signal });
  for (const name of ['pointerup', 'pointercancel']) surface.addEventListener(name, event => {
    if (touch?.id === event.pointerId) { if (!touch.moved && name === 'pointerup') terminal.focus(); touch = null; }
  }, { signal: abort.signal });
  queueMicrotask(connect);
  return {
    id, title, kind: 'terminal', element,
    onActivate: () => { resize(); if (!matchMedia('(pointer:coarse),(max-width:760px)').matches) terminal.focus(); },
    onLayout: resize,
    onClose: () => {
      endSession(); disposed = true; generation++; abort.abort(); observer.disconnect(); onData.dispose(); menu.destroy(); terminal.dispose();
      clearTimeout(handshakeTimer); clearInterval(heartbeat);
    },
    api: { focus: () => terminal.focus(), sendInput, paste: text => { terminal.paste(String(text)); return true; }, clear: () => terminal.clear(), reconnect,
      getSelection: () => terminal.getSelection(), hasSelection: () => terminal.hasSelection(), selectAll: () => terminal.selectAll(), clearSelection: () => terminal.clearSelection(),
      end: endSession, restart, updateOptions: value => { for (const [name, option] of Object.entries(value)) terminal.options[name] = option; resize(); },
      getState: () => ({ connected: ready, ended: session.ended, pendingInput: session.input - session.ack }) },
  };
}
