import { deriveKey } from './noise-key.js';
import { matchesKeybind } from './keybinds-core.js';
import { terminalLinkUrl, terminalTextLinks } from './terminal-links.js';
import Noise from 'noise-handshake';
import Cipher from 'noise-handshake/cipher';
import { WIRE_CAPABILITIES, selectedCapabilities, receiveExtension } from './wire.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { buttonIcon, createMenu, menuAction } from './ui.js';
import { inflateTerminalBlock, MAX_TERMINAL_BLOCK } from './terminal-codec.js';
import { INPUT_FRAME_BYTES, INPUT_IN_FLIGHT_BYTES, OUTPUT_ACK_BYTES, OUTPUT_ACK_DELAY, MAX_RENDER_BACKLOG, reconnectDelay, heartbeatDeadline, inputInFlight } from './terminal-network.js';

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
// Every terminal owns an explicit session. The workspace connection needs no PTY.
export function createTerminalPanel({ id, title = 'Terminal', url, key, command = '', options = {}, compression = true, onStatus, transformInput, sessionId, restoring = false, takeover = false, client, onSession, endRemote, onContextMenu, openLink, onFontSize } = {}) {
  const endpoint = new URL(url);
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || !key) throw Error('Connect to a server before opening a terminal.');
  if (!document.getElementById('instance-terminal-style')) {
    const style = document.createElement('style'); style.id = 'instance-terminal-style';
    style.textContent = '.instance-terminal{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--ui-terminal-bg,#10151b)}.instance-terminal-bar{display:flex;align-items:center;gap:8px;min-height:36px;padding:2px 7px;border-bottom:1px solid var(--ui-border,#344854);font-size:12px}.instance-terminal-status{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ui-muted,#a9bdc6)}.instance-terminal-surface{flex:1;min-height:0;min-width:0;touch-action:none;overflow:hidden}.instance-terminal.offline .instance-terminal-surface{filter:grayscale(.8);opacity:.65}.instance-terminal-bar .icon-button{border-color:transparent;background:transparent}.instance-terminal-surface .xterm-helper-textarea{font-size:16px!important}.instance-terminal-surface,.instance-terminal-surface *{user-select:none;-webkit-user-select:none}.terminal-text-dialog{width:min(900px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:16px;border:1px solid var(--ui-border,#344854);border-radius:10px;background:var(--ui-bg,#17232c);color:var(--ui-text,#e4edf0)}.terminal-text-dialog::backdrop{background:#0008}.terminal-text-header,.terminal-text-controls{display:flex;align-items:center;gap:10px;margin-bottom:10px}.terminal-text-header h2{flex:1;margin:0;font-size:18px}.terminal-text-dialog textarea{display:block;box-sizing:border-box;width:100%;height:min(60dvh,600px);font:14px/1.4 monospace;white-space:pre;overflow:auto;resize:vertical;user-select:text;-webkit-user-select:text}.terminal-text-status{font-size:12px}';
    (document.head || document.querySelector('head')).append(style);
  }
  const element = document.createElement('section'); element.className = 'instance-terminal offline';
  const bar = document.createElement('div'); bar.className = 'instance-terminal-bar';
  const status = document.createElement('span'); status.className = 'instance-terminal-status'; status.setAttribute('role', 'status');
  const retry = document.createElement('button'); retry.type = 'button'; buttonIcon(retry, 'RefreshCw', 'Reconnect terminal', true);
  const takeoverButton = document.createElement('button'); takeoverButton.type = 'button'; takeoverButton.textContent = 'Take over'; takeoverButton.hidden = true;
  const menu = createMenu('Terminal actions');
  const clear = document.createElement('button'); clear.type = 'button'; clear.textContent = 'Clear'; menuAction(menu.panel, clear, 'X');
  const viewText = document.createElement('button'); viewText.type = 'button'; viewText.textContent = 'View terminal text'; menuAction(menu.panel, viewText, 'FileText');
  const zoomIn = document.createElement('button'); zoomIn.type='button';zoomIn.textContent='Zoom in';menuAction(menu.panel,zoomIn,'ZoomIn');
  const zoomOut = document.createElement('button'); zoomOut.type='button';zoomOut.textContent='Zoom out';menuAction(menu.panel,zoomOut,'ZoomOut');
  const end = document.createElement('button'); end.type = 'button'; end.textContent = 'End session'; menuAction(menu.panel, end, 'Unplug');
  const surface = document.createElement('div'); surface.className = 'instance-terminal-surface';
  bar.append(status, retry, takeoverButton, menu.element); element.append(bar, surface);
  const terminal = new Terminal({ fontSize: 15, scrollback: 5000, cursorBlink: true, ...options });
  const activateLink = (event, value) => {
    if(terminal.modes.mouseTrackingMode!=='none')return;
    const target=terminalLinkUrl(value);if(!target)return;
    event?.preventDefault();
    if(openLink)openLink(target);else window.open(target,'_blank','noopener,noreferrer');
  };
  terminal.options.linkHandler={activate:activateLink,allowNonHttpProtocols:false};
  const textLinks=terminal.registerLinkProvider({provideLinks:(line,callback)=>callback(terminalTextLinks(terminal,line,activateLink))});
  const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(surface);
  // Keep xterm's DOM renderer available when WebGL cannot be created or is lost.
  let webgl;
  try {
    webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    terminal.loadAddon(webgl);
  } catch {
    webgl?.dispose();
  }
  // xterm 6 has no public selection-disable option. Keep its mouse reporting
  // and wheel handlers intact: canceling DOM events would also swallow input
  // for terminal applications. This adapter is covered against the pinned
  // xterm version, including Shift-modified mouse reporting.
  const selectionService = terminal._core._selectionService;
  selectionService.handleMouseDown = () => {};
  selectionService.shouldForceSelection = () => false;
  const newToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  let token = sessionId || (restoring ? null : newToken());
  const session = { token, create: !restoring, output: 0, rendered: 0, input: 0, ack: 0, pending: [], ended: restoring && !sessionId };
  let fresh = !!sessionId, takeOver = takeover, rendererEpoch = 0, focusRequested = false;
  let socket, inbound, outbound, ready = false, disposed = false, attempts = 0, generation = 0, autoReconnect = true;
  let wireCapabilities = [];
  let reconnectTimer, handshakeTimer, heartbeat, flushTimer, ackTimer, flushQueued = false, lastResponse = performance.now(), commandQueued = restoring;
  let negotiatedCompression = null, lastSize = '', acknowledgedOutput = 0, outputAckAt = performance.now(), inputAckAt = performance.now(), pingSent = null;
  let rtt = 0, reconnects = 0, bytesReceived = 0, decodedOutputBytes = 0, compressedOutputBytes = 0, connectionLabel = 'Connected';
  let decodeMilliseconds = 0, maxOutputBacklog = 0, outputWireBytes = 0;
  const abort = new AbortController();
  function setStatus(text) { if (status.textContent !== text) { status.textContent = text; status.title = text; onStatus?.(text); } }
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
    if (offset > session.ack) inputAckAt = performance.now();
    session.ack = offset;
    while (session.pending[0] && session.pending[0].offset + session.pending[0].bytes.length <= offset) session.pending.shift();
    const partial = session.pending[0];
    if (partial && partial.offset < offset) { partial.bytes = partial.bytes.slice(offset - partial.offset); partial.offset = offset; }
  }
  function queueFlush() {
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => { flushQueued = false; flush(); });
  }
  function flush() {
    clearTimeout(flushTimer);
    if (!ready || disposed || session.ended) return;
    let inFlight = inputInFlight(session.pending, generation, session.ack);
    for (const entry of session.pending) {
      if (entry.sent === generation) continue;
      if (inFlight + entry.bytes.length > INPUT_IN_FLIGHT_BYTES) return;
      if (socket.bufferedAmount > 8192) { flushTimer = setTimeout(flush, 20); return; }
      const bytes = new Uint8Array(9 + entry.bytes.length); bytes.set(offsetMessage(0, entry.offset)); bytes.set(entry.bytes, 9);
      if (!send(bytes)) return; entry.sent = generation; inFlight += entry.bytes.length;
    }
  }
  function acknowledgeOutput() {
    clearTimeout(ackTimer); ackTimer = null;
    if (!ready || disposed || session.ended || session.rendered <= acknowledgedOutput) return;
    if (send(offsetMessage(2, session.rendered))) { acknowledgedOutput = session.rendered; outputAckAt = performance.now(); }
  }
  function queueOutputAcknowledgement() {
    if (session.rendered - acknowledgedOutput >= OUTPUT_ACK_BYTES) acknowledgeOutput();
    else if (!ackTimer && session.rendered > acknowledgedOutput) ackTimer = setTimeout(acknowledgeOutput, OUTPUT_ACK_DELAY);
  }
  function sendInput(text) { return queueInput(encoder.encode(String(text))); }
  function queueInput(bytes) {
    if (disposed || session.ended || !takeoverButton.hidden) return false;
    if (session.input - session.ack + bytes.length > MAX_INPUT) { setStatus('Input buffer full'); return false; }
    for (let i = 0; i < bytes.length;) {
      const tail = session.pending.at(-1);
      const merge = tail && tail.sent === -1 && tail.bytes.length < INPUT_FRAME_BYTES;
      const length = Math.min(bytes.length - i, INPUT_FRAME_BYTES - (merge ? tail.bytes.length : 0));
      const chunk = bytes.slice(i, i + length);
      if (merge) { const joined = new Uint8Array(tail.bytes.length + length); joined.set(tail.bytes); joined.set(chunk, tail.bytes.length); tail.bytes = joined; }
      else session.pending.push({ offset: session.input, bytes: chunk, sent: -1, queuedAt: performance.now() });
      session.input += length; i += length;
    }
    queueFlush();
    if (!ready) setStatus(`Reconnecting · ${session.input - session.ack} bytes buffered`);
    return true;
  }
  function resize() {
    if (disposed || !surface.clientWidth || !surface.clientHeight) return;
    try { fit.fit(); } catch { return; }
    const size = `${terminal.cols}:${terminal.rows}`;
    if (ready && size !== lastSize && send(Uint8Array.of(1, terminal.cols >> 8, terminal.cols & 255, terminal.rows >> 8, terminal.rows & 255))) lastSize = size;
  }
  function zoomFont(delta) {
    if(disposed)return Number(terminal.options.fontSize);
    const size=Math.max(8,Math.min(36,Number(terminal.options.fontSize)+delta));
    terminal.options.fontSize=size;resize();onFontSize?.(size);return size;
  }
  zoomIn.onclick=()=>zoomFont(1);zoomOut.onclick=()=>zoomFont(-1);
  function endSession() {
    autoReconnect = false; session.ended = true; session.pending = [];
    generation++; clearTimeout(reconnectTimer); clearTimeout(flushTimer); clearTimeout(ackTimer); clearTimeout(handshakeTimer); clearInterval(heartbeat);
    if (ready) send(Uint8Array.of(10));
    const previous = socket; socket = null; previous?.close(); inbound = outbound = null;
    // Closing the socket does not confirm that opcode 10 reached the actor.
    // The workspace request is idempotent and can reconcile that uncertain end.
    if (token) endRemote?.(token);
    ready = false; appearance(); setStatus('Session ended');
  }
  function reconnect() {
    if (disposed || session.ended) return;
    autoReconnect = true; clearTimeout(reconnectTimer); connect();
  }
  function restart() {
    if (disposed || !session.ended) return;
    rendererEpoch++;
    token = newToken(); Object.assign(session, { token, create: true, output: 0, rendered: 0, input: 0, ack: 0, pending: [], ended: false });
    fresh = false; takeOver = false; commandQueued = false; attempts = 0; terminal.reset(); onSession?.(token); reconnect();
  }
  function scheduleReconnect() {
    if (!autoReconnect || disposed || session.ended) return;
    setStatus(`Reconnecting${session.input > session.ack ? ` · ${session.input - session.ack} bytes buffered` : '…'}`);
    clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, reconnectDelay(attempts++));
  }
  async function connect() {
    if (disposed || session.ended || !autoReconnect) return;
    const attempt = ++generation;
    clearTimeout(reconnectTimer); clearTimeout(handshakeTimer); clearTimeout(flushTimer); clearTimeout(ackTimer); clearInterval(heartbeat);
    ackTimer = null; lastSize = ''; negotiatedCompression = null; pingSent = null;
    const previous = socket; socket = null; previous?.close(); inbound = outbound = null; ready = false; appearance();
    setStatus(session.create ? 'Connecting…' : 'Reconnecting…');
    let handshake, current;
    try {
      const psk = deriveKey(key); if (attempt !== generation || disposed || session.ended || !autoReconnect) return;
      handshake = new Noise('NNpsk0', true, null, { psk }); handshake.initialise(encoder.encode('eya-terminal-v1'));
      current = new WebSocket(endpoint.href);
    } catch (error) {
      if (attempt !== generation || disposed || session.ended) return;
      autoReconnect = false; setStatus(error.message || 'Connection failed'); return;
    }
    socket = current; current.binaryType = 'arraybuffer'; let awaiting = true; lastResponse = performance.now();
    handshakeTimer = setTimeout(() => { if (socket === current && !ready) { current.close(); transportClosed(); } }, 12000);
    current.onopen = () => { if (socket === current) { try { current.send(handshake.send()); } catch { current.close(); transportClosed(); } } };
    current.onmessage = event => {
      if (socket !== current || disposed || session.ended) return;
      try {
        const data = new Uint8Array(event.data);
        if (data.length > 65535) throw Error('Terminal frame too large');
        if (awaiting) {
          handshake.recv(data); if (!handshake.complete) throw Error('Incomplete authentication');
          outbound = new Cipher(handshake.tx); inbound = new Cipher(handshake.rx); awaiting = false;
          if (!send(encoder.encode('eya-ready-v4:' + JSON.stringify({ token, output: session.output, create: session.create, client, fresh, takeover: takeOver, capabilities: WIRE_CAPABILITIES, ...(compression ? { compression: 'deflate-raw' } : {}) })))) throw Error('Connection failed');
          // Creation is a mutation with an uncertain outcome once sent. Resume
          // by ID thereafter; never replay create into a replacement process.
          session.create = false;
          return;
        }
        if (inbound.nonce >= 0xffffffff) throw Error('Terminal message limit reached');
        const message = inbound.decrypt(data); lastResponse = performance.now(); bytesReceived += data.length;
        if (message[0] === 7) {
          const state = JSON.parse(decoder.decode(message.subarray(1)));
          if (state.state !== 'ready') {
            autoReconnect = false; session.ended = !['in-use', 'taken-over'].includes(state.state); session.pending = [];
            if (!session.ended) fresh = true;
            takeoverButton.hidden = session.ended; setStatus(state.message || 'Session ended'); current.close(); transportClosed();
            // Honor focus requested while the first attachment was opening.
            // A later taken-over notice must wait for a new focus action, so
            // two visible clients cannot repeatedly steal the same session.
            const claim = state.state === 'in-use' && focusRequested && surface.contains(document.activeElement);
            focusRequested = false;
            if (claim) queueMicrotask(claimSession);
            return;
          }
          if (!Number.isSafeInteger(state.output) || state.output < 0) throw Error('Invalid terminal output offset');
          if (fresh) {
            const next = state.nextInput ?? state.input;
            if (!Number.isSafeInteger(state.input) || !Number.isSafeInteger(next) || state.input < 0 || next < state.input || next - state.input > MAX_INPUT) throw Error('Invalid terminal input offsets');
            rendererEpoch++; session.output = session.rendered = state.output; session.input = next; session.ack = state.input; session.pending = []; fresh = false;
          }
          if (state.output !== session.output) throw Error('Terminal replay offsets differ');
          if (state.compression != null && (state.compression !== 'deflate-raw' || !compression)) throw Error('Unsupported terminal compression');
          negotiatedCompression = state.compression || null;
          wireCapabilities = selectedCapabilities(state);
          acknowledgedOutput = state.output; outputAckAt = inputAckAt = performance.now();
          if (state.resumed) reconnects++;
          acknowledge(state.input); session.create = false; ready = true; takeOver = false; focusRequested = false; takeoverButton.hidden = true; attempts = 0; clearTimeout(handshakeTimer); appearance(); connectionLabel = state.resumed ? 'Connected · session resumed' : 'Connected'; setStatus(connectionLabel); resize(); queueFlush(); onSession?.(token);
          if (!commandQueued) { commandQueued = true; if (command) sendInput(command.replace(/\r?\n/g, '\r') + (/[\r\n]$/.test(command) ? '' : '\r')); }
          heartbeat = setInterval(() => {
            const now = performance.now(), age = now - lastResponse;
            if (age > heartbeatDeadline(rtt)) { current.close(); transportClosed(); return; }
            const pending = session.input - session.ack;
            const oldest = pending ? now - (session.pending[0]?.queuedAt ?? now) : 0;
            setStatus(`${connectionLabel}${age > 10000 ? ' · waiting for network' : ''}${pending ? ` · ${pending} bytes queued${oldest > 1000 ? ` (${Math.floor(oldest / 1000)} s)` : ''}` : ''}`);
            // One outstanding RTT probe is enough. Progress from normal output
            // still keeps the connection alive if its echo waits behind a flood.
            if (pingSent === null || now - pingSent > heartbeatDeadline(rtt)) {
              const bytes = new Uint8Array(9); bytes[0] = 3; new DataView(bytes.buffer).setFloat64(1, now);
              if (send(bytes)) pingSent = now;
            }
          }, 5000);
        } else if (message[0] === 12 && ready) {
          receiveExtension(message, wireCapabilities);
        } else if ((message[0] === 8 || message[0] === 11) && message.length >= 9 && ready) {
          const offset = readOffset(message); if (offset > session.output) throw Error('Missing terminal output');
          let bytes;
          if (message[0] === 11) {
            if (negotiatedCompression !== 'deflate-raw' || message.length < 14) throw Error('Unexpected compressed terminal output');
            const decodeStarted = performance.now();
            bytes = inflateTerminalBlock(message.subarray(13), new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(9));
            decodeMilliseconds += performance.now() - decodeStarted;
            compressedOutputBytes += message.length - 13;
          } else bytes = message.subarray(9);
          if (bytes.length > (negotiatedCompression ? MAX_TERMINAL_BLOCK : 65510)) throw Error('Terminal output block too large');
          const skipped = Math.min(bytes.length, session.output - offset);
          // A partial replay must not pin an entire old block for a one-byte
          // suffix queued in xterm. Accounted bytes and retained backing data
          // should stay proportional while the renderer is catching up.
          const received = skipped ? bytes.slice(skipped) : bytes;
          if (!Number.isSafeInteger(session.output + received.length) || session.output + received.length - session.rendered > MAX_RENDER_BACKLOG) throw Error('Terminal renderer backlog exceeded');
          decodedOutputBytes += received.length; outputWireBytes += data.length;
          session.output += received.length; const accepted = session.output, epoch = rendererEpoch;
          maxOutputBacklog = Math.max(maxOutputBacklog, session.output - session.rendered);
          if (received.length) terminal.write(received, () => {
            if (disposed || epoch !== rendererEpoch) return;
            session.rendered = Math.max(session.rendered, accepted);
            if (ready) queueOutputAcknowledgement();
          });
          else queueOutputAcknowledgement();
        } else if (message[0] === 9 && message.length === 9 && ready) { acknowledge(readOffset(message)); queueFlush(); }
        else if (message[0] === 3 && message.length === 9 && ready) {
          const timestamp = new DataView(message.buffer, message.byteOffset, message.byteLength).getFloat64(1);
          if (timestamp === pingSent) { const sample = Math.max(0, performance.now() - timestamp); rtt = rtt ? rtt * 0.8 + sample * 0.2 : sample; pingSent = null; }
        } else throw Error('Unexpected terminal message');
      } catch (error) { autoReconnect = false; setStatus(awaiting ? 'Authentication failed' : error.message || 'Terminal connection failed'); current.close(); transportClosed(); }
    };
    function transportClosed() {
      if (socket !== current) return;
      // A failed link can leave native close() pending indefinitely. Fence the
      // old transport now; a later close/message cannot affect its replacement.
      socket = null;
      ready = false; inbound = outbound = null; clearInterval(heartbeat); clearTimeout(handshakeTimer); clearTimeout(flushTimer); clearTimeout(ackTimer); ackTimer = null; appearance();
      if (autoReconnect && !session.ended) scheduleReconnect();
    }
    current.onclose = transportClosed;
    current.onerror = () => {};
  }
  const observer = new ResizeObserver(resize); observer.observe(surface);
  const onData = terminal.onData(data => {
    // xterm already encoded physical modifiers in mouse reports. Auxiliary
    // keyboard modifiers must neither rewrite them nor consume an armed key.
    const mouseReport = terminal.modes.mouseTrackingMode !== 'none' && /^\x1b\[(?:<\d+;\d+;\d+[Mm]|\d+;\d+;\d+M)$/.test(data);
    const input = transformInput && !mouseReport ? transformInput(data) : data;
    if (typeof input === 'string' && input.length) sendInput(input);
  });
  // Legacy X10 mouse reports contain bytes outside UTF-8. xterm exposes
  // these separately; preserving their raw bytes keeps pointer input valid.
  const onBinary = terminal.onBinary(data => queueInput(Uint8Array.from(data, char => char.charCodeAt(0) & 255)));
  clear.onclick = () => terminal.clear(); end.onclick = endSession; retry.onclick = () => session.ended ? restart() : reconnect();
  function claimSession() {
    if (disposed || session.ended || takeoverButton.hidden) return;
    takeOver = true; fresh = true; session.pending = []; takeoverButton.hidden = true; reconnect();
  }
  function focus() {
    focusRequested = true;
    if (!takeoverButton.hidden) claimSession();
    terminal.focus();
  }
  takeoverButton.onclick = claimSession;
  surface.addEventListener('focusin', () => { focusRequested = true; if (!takeoverButton.hidden) claimSession(); }, { signal: abort.signal });
  let textDialog;
  function bufferText(scope = 'all') {
    const buffer = terminal.buffer.active;
    const start = scope === 'screen' ? buffer.viewportY : 0;
    const limit = Math.min(buffer.length, scope === 'screen' ? start + terminal.rows : buffer.baseY + terminal.rows);
    let text = '';
    for (let row = start; row < limit; row++) {
      const line = buffer.getLine(row), wrapped = row + 1 < limit && buffer.getLine(row + 1)?.isWrapped;
      text += (line?.translateToString(!wrapped) || '') + (wrapped || row + 1 === limit ? '' : '\n');
    }
    return text;
  }
  function showText() {
    if (textDialog) { textDialog.focus(); return; }
    const dialog = document.createElement('dialog'); dialog.className = 'terminal-text-dialog'; dialog.setAttribute('aria-label', 'Terminal text');
    const header = document.createElement('div'); header.className = 'terminal-text-header';
    const heading = document.createElement('h2'); heading.textContent = 'Terminal text';
    const close = document.createElement('button'); close.type = 'button'; buttonIcon(close, 'X', 'Close terminal text', true); close.onclick = () => dialog.close();
    header.append(heading, close);
    const controls = document.createElement('div'); controls.className = 'terminal-text-controls';
    const label = document.createElement('label'); label.textContent = 'Buffer ';
    const scope = document.createElement('select'); scope.setAttribute('aria-label', 'Terminal text buffer');
    for (const [value, text] of [['all', 'Screen and scrollback'], ['screen', 'Visible screen']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; scope.append(option); }
    label.append(scope);
    const area = document.createElement('textarea'); area.readOnly = true; area.wrap = 'off'; area.spellcheck = false; area.setAttribute('aria-label', 'Copyable terminal text');
    const message = document.createElement('span'); message.className = 'terminal-text-status'; message.setAttribute('role', 'status');
    const snapshot = () => { area.value = bufferText(scope.value); message.textContent = ''; };
    scope.onchange = snapshot;
    const refreshText = document.createElement('button'); refreshText.type = 'button'; buttonIcon(refreshText, 'RefreshCw', 'Refresh terminal text', true); refreshText.onclick = snapshot;
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy text';
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(area.value); message.textContent = 'Text copied'; }
      catch { area.focus(); area.select(); let copied = false; try { copied = document.execCommand('copy'); } catch { /* Leave the text selected for keyboard/native copy. */ } message.textContent = copied ? 'Text copied' : 'Press Ctrl+C or use the native Copy menu.'; }
    };
    controls.append(label, refreshText, copy); dialog.append(header, controls, area, message);
    (document.body || document.querySelector('body')).append(dialog); textDialog = dialog;
    dialog.addEventListener('close', () => { dialog.remove(); textDialog = null; if (!disposed) focus(); }, { once: true });
    snapshot(); dialog.showModal(); area.focus();
  }
  viewText.onclick = showText;
  surface.addEventListener('keydown', event => {
    if (matchesKeybind('terminal.clear', event)) { event.preventDefault(); event.stopPropagation(); terminal.clear(); }
    else if (matchesKeybind('terminal.text', event)) { event.preventDefault(); event.stopPropagation(); showText(); }
  }, { capture: true, signal: abort.signal });
  const online = () => { if (!ready && autoReconnect && !session.ended) reconnect(); };
  window.addEventListener('online', online, { signal: abort.signal });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) online(); }, { signal: abort.signal });
  // Touch drags scroll the normal buffer. Mouse-tracking and alternate-screen
  // applications receive xterm's wheel input instead of local selection.
  let touch;
  surface.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' || touch) return;
    touch = { id: event.pointerId, x: event.clientX, initialY: event.clientY, y: event.clientY, moved: false };
    surface.setPointerCapture(event.pointerId);
  }, { signal: abort.signal });
  surface.addEventListener('pointermove', event => {
    if (touch?.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - touch.x, event.clientY - touch.initialY) <= 8 && !touch.moved) return;
    touch.moved = true;
    const deltaY = touch.y - event.clientY;
    if (deltaY) {
      event.preventDefault();
      if (terminal.modes.mouseTrackingMode === 'none' && terminal.buffer.active.type === 'normal') {
        const height = (surface.querySelector('.xterm-screen')?.getBoundingClientRect().height || terminal.rows * 16) / terminal.rows;
        const lines = Math.trunc(deltaY / Math.max(height, 1));
        if (lines) { terminal.scrollLines(lines); touch.y -= lines * height; }
      } else {
        terminal.element.dispatchEvent(new WheelEvent('wheel', { deltaY, clientX: event.clientX, clientY: event.clientY, bubbles: true, cancelable: true }));
        touch.y = event.clientY;
      }
    }
  }, { signal: abort.signal });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) surface.addEventListener(name, event => {
    if (touch?.id !== event.pointerId) return;
    if (name === 'pointerup' && !touch.moved) focus();
    touch = null;
  }, { signal: abort.signal });
  function detach() {
    autoReconnect = false; generation++; ready = false;
    clearTimeout(reconnectTimer); clearTimeout(handshakeTimer); clearTimeout(flushTimer); clearTimeout(ackTimer); clearInterval(heartbeat);
    const previous = socket; socket = null; previous?.close(); inbound = outbound = null; appearance(); setStatus('Detached · session retained');
  }
  appearance();
  if (session.ended) setStatus('Session unavailable · start a new session explicitly');
  else queueMicrotask(connect);
  return {
    id, title, kind: 'terminal', element,
    serialize: () => ({ id, title, kind: 'terminal', session: token, config: {} }),
    onActivate: () => { resize(); if (!matchMedia('(pointer:coarse),(max-width:760px)').matches) focus(); },
    onLayout: resize,
    onClose: ({ detach: retain = false } = {}) => {
      if (retain) detach(); else endSession(); disposed = true; generation++; textDialog?.remove(); textDialog = null; abort.abort(); observer.disconnect(); onData.dispose(); onBinary.dispose(); textLinks.dispose(); menu.destroy(); terminal.dispose();
      clearTimeout(handshakeTimer); clearInterval(heartbeat);
    },
    api: { focus, zoomFont, viewText: showText, getText: bufferText, sendInput, paste: text => { terminal.paste(String(text)); return true; }, clear: () => terminal.clear(), reconnect,
      getSelection: () => '', hasSelection: () => false, selectAll: showText, clearSelection: () => terminal.clearSelection(),
      end: endSession, restart, detach, resume: () => { if (!ready && !takeoverButton.hidden) return; if (!ready) reconnect(); }, updateOptions: value => { for (const [name, option] of Object.entries(value)) terminal.options[name] = option; resize(); },
      getState: () => {
        const now = performance.now(), sent = inputInFlight(session.pending, generation, session.ack);
        return { connected: ready, fontSize:Number(terminal.options.fontSize), ended: session.ended, mouseTracking: terminal.modes.mouseTrackingMode, pendingInput: session.input - session.ack,
          network: { compression: negotiatedCompression, rtt: rtt || null, reconnects, bytesReceived, decodedOutputBytes, compressedOutputBytes, outputWireBytes, decodeMilliseconds, maxOutputBacklog,
            pendingInputAge: session.pending.length ? now - session.pending[0].queuedAt : 0,
            sentUnacknowledgedInput: sent, queuedUnsentInput: session.input - session.ack - sent,
            outputBacklog: session.output - session.rendered, outputAcknowledged: acknowledgedOutput,
            outputAckAge: now - outputAckAt, inputAckAge: now - inputAckAt, responseAge: now - lastResponse } };
      } },
  };
}
