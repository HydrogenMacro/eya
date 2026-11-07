import Noise from 'noise-handshake';
import Cipher from 'noise-handshake/cipher';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const MAX_PENDING = 8, MAX_QUEUED = 64, MAX_RESPONSE_BYTES = 8 * 1024 * 1024, MAX_INLINE_REQUEST_BODY = 40 * 1024, MAX_REQUEST_BODY = 4 * 1024 * 1024, MAX_RETAINED_REQUEST_BYTES = 8 * 1024 * 1024, STREAM_CHUNK_BYTES = 48 * 1024, UPLOAD_WINDOW_CHUNKS = 4, MAX_WEBSOCKET_MESSAGE = 1024 * 1024, MAX_WEBSOCKET_SEND_WINDOW = 8;
const MAX_REMOTE_USERSCRIPT_BYTES = 512 * 1024, MAX_REMOTE_USERSCRIPT_COUNT = 16;
const MAX_REMOTE_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_TAB_ACTIVATIONS = 16;

async function deriveKey(secret) {
  if (/^[0-9a-f]{64}$/i.test(secret)) return Uint8Array.from(secret.match(/../g), hex => parseInt(hex, 16));
  if (!globalThis.crypto?.subtle) throw Error('Password authentication requires a secure browser context.');
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(secret)));
}

function browserEndpoint(value, route = 'browser-ws') {
  const endpoint = new URL(value);
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw Error('Invalid browser proxy endpoint.');
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '').replace(/\/ws$/, '')}/${route}`;
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint.href;
}

function validRemoteTabId(tabId) {
  return typeof tabId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(tabId);
}

// Full-browser sessions render remotely, but retain the standalone client's
// existing Noise WebSocket as the only page-data connection.
export async function createBrowserRenderTransport({ url, key, onState, onEvent, onFrame, onDownload } = {}) {
  if (!url || !key) throw Error('Connect to Eya before opening the remote browser.');
  const socket = new WebSocket(browserEndpoint(url, 'browser-render-ws'));
  socket.binaryType = 'arraybuffer';
  let outbound = null, inbound = null, ready = false, closed = false, frame = null, nextEvaluationId = 0, nextUserscriptUploadId = 0, nextFilterUploadId = 0;
  let browserStarted = false, startPending = null;
  function finishStart(error) {
    const pending = startPending;
    if (!pending) return;
    startPending = null; clearTimeout(pending.timer);
    if (error) pending.reject(error); else { browserStarted = true; pending.resolve(); }
  }
  let rejectHandshake = null, handshakeTimer = null, nextSiteDataId = 0, nextExtensionId = 0, nextDebuggerId = 0, nextNetworkBodyId = 0, nextPageFileUploadId = 0;
  const evaluations = new Map();
  const userscriptUploads = new Map();
  const filterUploads = new Map();
  const sourceRequests = new Map();
  const siteDataRequests = new Map();
  const extensionRequests = new Map();
  const debuggerRequests = new Map();
  const networkBodyRequests = new Map();
  const pageFileUploads = new Map();
  const tabActivations = new Map();
  const remoteDownloadTransfers = new Map();
  let extensionUploading = false;
  const openPromise = new Promise((resolve, reject) => {
    rejectHandshake = reject;
    let handshake;
    handshakeTimer = setTimeout(() => { socket.close(); reject(Error('Remote browser handshake timed out.')); }, 12000);
    socket.onopen = async () => {
      try {
        handshake = new Noise('NNpsk0', true, null, { psk: await deriveKey(key) });
        handshake.initialise(encoder.encode('eya-browser-render-v1'));
        socket.send(handshake.send());
      } catch (error) { clearTimeout(handshakeTimer); reject(error); socket.close(); }
    };
    socket.onmessage = event => {
      try {
        const data = new Uint8Array(event.data);
        if (!outbound) {
          handshake.recv(data);
          if (!handshake.complete) throw Error('Incomplete remote browser handshake.');
          outbound = new Cipher(handshake.tx); inbound = new Cipher(handshake.rx);
          socket.send(outbound.encrypt(encoder.encode('eya-browser-render-ready-v1')));
          return;
        }
        const message = inbound.decrypt(data);
        if (!ready) {
          if (decoder.decode(message) !== 'eya-browser-render-ready-v1') throw Error('The remote browser rejected the connection.');
          ready = true; clearTimeout(handshakeTimer); onState?.('ready'); resolve(); return;
        }
        receive(message);
      } catch (error) { fail(error); }
    };
    socket.onerror = () => { if (!ready) { clearTimeout(handshakeTimer); reject(Error('Could not connect to the remote browser.')); } };
    socket.onclose = () => {
      closed = true; ready = false; frame = null; clearTimeout(handshakeTimer); onState?.('closed');
      finishStart(Error('Remote browser connection closed during startup.'));
      for (const pending of evaluations.values()) { clearTimeout(pending.timer); pending.reject(Error('Remote browser connection closed.')); }
      evaluations.clear();
      for (const pending of userscriptUploads.values()) { clearTimeout(pending.timer); pending.reject(Error('Remote browser connection closed.')); }
      userscriptUploads.clear();
      for (const pending of filterUploads.values()) { clearTimeout(pending.timer); pending.reject(Error('Remote browser connection closed.')); }
      filterUploads.clear();
      for (const pending of sourceRequests.values()) { clearTimeout(pending.timer); pending.reject(Error('Remote browser connection closed.')); }
      sourceRequests.clear();
      for (const pending of siteDataRequests.values()) { clearTimeout(pending.timer); pending.reject(Error('Remote browser connection closed.')); }
      siteDataRequests.clear();
      for (const pending of extensionRequests.values()) { clearTimeout(pending.timer); pending.reject(Error('Remote browser connection closed.')); }
      extensionRequests.clear();
      for (const pending of debuggerRequests.values()) { clearTimeout(pending.timer); pending.reject(Error('Remote browser connection closed.')); }
      debuggerRequests.clear();
      for (const pending of networkBodyRequests.values()) { clearTimeout(pending.timer); pending.reject(Error('Remote browser connection closed.')); }
      networkBodyRequests.clear();
      for (const pending of pageFileUploads.values()) { clearTimeout(pending.timer); pending.readyReject(Error('Remote browser connection closed.')); pending.doneReject(Error('Remote browser connection closed.')); }
      pageFileUploads.clear();
      for (const pendingList of tabActivations.values()) for (const pending of pendingList) {
        clearTimeout(pending.timer);
        if (!pending.settled) { pending.settled = true; pending.reject(Error('Remote browser connection closed.')); }
      }
      tabActivations.clear();
      if (!ready) rejectHandshake?.(Error('Remote browser connection closed.'));
    };
  });

  function send(message) {
    if (!ready || closed || socket.readyState !== WebSocket.OPEN) throw Error('Remote browser is disconnected.');
    if (outbound.nonce >= 0xffffffff || socket.bufferedAmount > 768 * 1024) throw Error('Remote browser transport is busy.');
    socket.send(outbound.encrypt(message));
  }
  function jsonMessage(opcode, value, maxBytes = 8192) {
    const payload = encoder.encode(JSON.stringify(value));
    if (payload.length > maxBytes) throw Error('Remote browser command exceeds the transport limit.');
    const message = new Uint8Array(payload.length + 1); message[0] = opcode; message.set(payload, 1); send(message);
  }
  function receive(message) {
    if (!message.length) throw Error('Empty remote browser message.');
    if (message[0] === 129 || message[0] === 132 || message[0] === 133) {
      let value;
      try { value = JSON.parse(decoder.decode(message.subarray(1))); }
      catch { throw Error('Invalid remote browser event.'); }
      if (message[0] === 133) {
        const error = Error(String(value.message || 'Remote browser failed.').slice(0, 512));
        finishStart(error);
        // Generic server errors have no operation id. In particular, TAB_ACTIVATE
        // can fail before the browser has a target-specific status to send, so
        // reject outstanding activations instead of leaving them to time out.
        for (const pendingList of tabActivations.values()) for (const pending of pendingList) {
          clearTimeout(pending.timer);
          if (!pending.settled) { pending.settled = true; pending.reject(error); }
        }
        tabActivations.clear();
        onState?.('error', error);
      }
      else {
        if (message[0] === 129 && value.type === 'ready') finishStart();
        if (message[0] === 129 && value.type === 'error') finishStart(Error(String(value.message || 'Remote browser failed to start.').slice(0, 512)));
        if (message[0] === 129 && ['download-failed', 'download-cancelled'].includes(value.type)) remoteDownloadTransfers.delete(value.id);
        if (message[0] === 129 && ['tab-activated', 'tab-error'].includes(value.type) && typeof value.tabId === 'string') {
          const pendingList = tabActivations.get(value.tabId);
          // The server processes activation commands in WebSocket order, so
          // same-tab acknowledgements correspond to this FIFO queue. Do not
          // coalesce a repeated activation: A → B → A must leave the server on A.
          const pending = pendingList?.shift();
          if (pending) {
            if (!pendingList.length) tabActivations.delete(value.tabId);
            clearTimeout(pending.timer);
            if (!pending.settled) {
              pending.settled = true;
              value.type === 'tab-activated' ? pending.resolve(value) : pending.reject(Error(String(value.message || 'Remote tab activation failed.').slice(0, 512)));
            }
          }
        }
        onEvent?.(value, message[0] === 132 ? 'cdp' : 'status');
      }
      return;
    }
    if (message[0] === 134) {
      let value;
      try { value = JSON.parse(decoder.decode(message.subarray(1))); }
      catch { throw Error('Invalid remote browser evaluation result.'); }
      const pending = evaluations.get(value.id);
      if (pending) {
        evaluations.delete(value.id); clearTimeout(pending.timer);
        value.tabId === pending.tabId ? pending.resolve(value) : pending.reject(Error('Remote evaluation returned for a different tab.'));
      }
      return;
    }
    if (message[0] === 135) {
      let value;
      try { value = JSON.parse(decoder.decode(message.subarray(1))); }
      catch { throw Error('Invalid remote userscript acknowledgment.'); }
      const pending = userscriptUploads.get(value.id);
      if (pending) { userscriptUploads.delete(value.id); clearTimeout(pending.timer); value.ok ? pending.resolve(value) : pending.reject(Error(String(value.error || 'Remote userscript setup failed.').slice(0, 512))); }
      return;
    }
    if (message[0] === 145) {
      let value;
      try { value = JSON.parse(decoder.decode(message.subarray(1))); } catch { throw Error('Invalid remote filter-list response.'); }
      const pending = filterUploads.get(value.id);
      if (pending) { filterUploads.delete(value.id); clearTimeout(pending.timer); value.ok ? pending.resolve(value) : pending.reject(Error(String(value.error || 'Remote filter-list setup failed.').slice(0, 512))); }
      return;
    }
    if (message[0] === 146) {
      let value;
      try { value = JSON.parse(decoder.decode(message.subarray(1))); }
      catch { throw Error('Invalid remote page-upload response.'); }
      const pending = pageFileUploads.get(value.id);
      if (!pending) return;
      if (!value.ok) {
        pageFileUploads.delete(value.id); clearTimeout(pending.timer);
        const error = Error(String(value.error || 'Remote page upload failed.').slice(0, 512));
        pending.readyReject(error); pending.doneReject(error); return;
      }
      if (value.phase === 'ready') { pending.readyResolve(); return; }
      if (value.phase === 'complete') {
        pageFileUploads.delete(value.id); clearTimeout(pending.timer); pending.doneResolve(); return;
      }
      throw Error('Invalid remote page-upload phase.');
    }
    if (message[0] === 136) {
      let value;
      try { value = JSON.parse(decoder.decode(message.subarray(1))); }
      catch { throw Error('Invalid remote source response.'); }
      const pending = sourceRequests.get(value.id);
      if (!pending) return;
      if (value.tabId !== pending.tabId) {
        sourceRequests.delete(value.id); clearTimeout(pending.timer);
        pending.reject(Error('Remote source response returned for a different tab.')); return;
      }
      if (value.error) {
        sourceRequests.delete(value.id); clearTimeout(pending.timer);
        pending.reject(Error(String(value.error).slice(0, 512))); return;
      }
      if (pending.kind === 'list' && Array.isArray(value.sources) && value.sources.length <= 100) {
        sourceRequests.delete(value.id); clearTimeout(pending.timer);
        pending.resolve({ sources: value.sources.filter(source => source && typeof source.url === 'string' && source.url.length <= 2048 && ['Document', 'Script', 'Stylesheet'].includes(source.kind)).map(source => ({ url: source.url, kind: source.kind, mimeType: String(source.mimeType || '').slice(0, 128) })) });
        return;
      }
      const bytes = Number(value.contentBytes), chunks = Number(value.chunks);
      if (pending.kind !== 'content' || value.kind !== 'content' || value.url !== pending.url || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > 512 * 1024 || !Number.isSafeInteger(chunks) || chunks < 0 || chunks > 11 || chunks !== Math.ceil(bytes / STREAM_CHUNK_BYTES)) throw Error('Remote source response exceeds its limits.');
      pending.bytes = new Uint8Array(bytes); pending.chunks = chunks; pending.nextChunk = 0; pending.truncated = value.truncated === true; pending.started = true;
      if (!chunks) { sourceRequests.delete(value.id); clearTimeout(pending.timer); pending.resolve({ url: pending.url, text: '', truncated: pending.truncated }); }
      return;
    }
    if (message[0] === 137) {
      if (message.byteLength < 7) throw Error('Invalid remote source chunk.');
      const view = new DataView(message.buffer, message.byteOffset, message.byteLength), id = view.getUint32(1), index = view.getUint16(5), part = message.subarray(7), pending = sourceRequests.get(id);
      if (!pending?.started || pending.kind !== 'content' || index !== pending.nextChunk || index >= pending.chunks || !part.byteLength || part.byteLength > STREAM_CHUNK_BYTES) throw Error('Invalid remote source chunk sequence.');
      const offset = index * STREAM_CHUNK_BYTES;
      if (offset + part.byteLength > pending.bytes.byteLength || (index < pending.chunks - 1 && part.byteLength !== STREAM_CHUNK_BYTES) || (index === pending.chunks - 1 && offset + part.byteLength !== pending.bytes.byteLength)) throw Error('Invalid remote source chunk size.');
      pending.bytes.set(part, offset); pending.nextChunk++;
      if (pending.nextChunk === pending.chunks) {
        sourceRequests.delete(id); clearTimeout(pending.timer);
        pending.resolve({ url: pending.url, text: decoder.decode(pending.bytes), truncated: pending.truncated });
      }
      return;
    }
    if (message[0] === 138) {
      let value;
      try { value = JSON.parse(decoder.decode(message.subarray(1))); }
      catch { throw Error('Invalid remote site-data response.'); }
      const pending = siteDataRequests.get(value.id);
      if (!pending) return;
      siteDataRequests.delete(value.id); clearTimeout(pending.timer);
      if (value.tabId !== pending.tabId) { pending.reject(Error('Remote site-data response returned for a different tab.')); return; }
      if (value.error) { pending.reject(Error(String(value.error).slice(0, 512))); return; }
      if (pending.kind === 'cookies') {
        if (!Array.isArray(value.cookies) || value.cookies.length > 100) { pending.reject(Error('Remote cookie response exceeds its limits.')); return; }
        value.cookies = value.cookies.filter(cookie => cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string')
          .map(cookie => ({ name: cookie.name.slice(0, 256), value: cookie.value.slice(0, 512), domain: String(cookie.domain || '').slice(0, 256), path: String(cookie.path || '/').slice(0, 512), httpOnly: cookie.httpOnly === true, secure: cookie.secure === true, sameSite: String(cookie.sameSite || 'Unspecified').slice(0, 32) }));
      }
      pending.resolve(value); return;
    }
    if (message[0] === 139) {
      let value;
      try { value = JSON.parse(decoder.decode(message.subarray(1))); }
      catch { throw Error('Invalid remote extension response.'); }
      const pending = extensionRequests.get(value.id);
      if (!pending) return;
      extensionRequests.delete(value.id); clearTimeout(pending.timer);
      if (!value.ok) { pending.reject(Error(String(value.error || 'Remote extension operation failed.').slice(0, 512))); return; }
      pending.resolve(value); return;
    }
    if (message[0] === 140) {
      let value;
      try { value = JSON.parse(decoder.decode(message.subarray(1))); }
      catch { throw Error('Invalid remote debugger response.'); }
      const pending = debuggerRequests.get(value.id);
      if (!pending) return;
      debuggerRequests.delete(value.id); clearTimeout(pending.timer);
      if (value.tabId !== pending.tabId) { pending.reject(Error('Remote debugger response returned for a different tab.')); return; }
      if (!value.ok) { pending.reject(Error(String(value.error || 'Remote debugger command failed.').slice(0, 512))); return; }
      const properties = Array.isArray(value.properties) ? value.properties.slice(0, 100).map(property => ({
        name: String(property?.name || '').slice(0, 256),
        value: property?.value && typeof property.value === 'object' ? {
          type: String(property.value.type || 'undefined').slice(0, 32),
          subtype: String(property.value.subtype || '').slice(0, 32),
          className: String(property.value.className || '').slice(0, 128),
          description: String(property.value.description || '').slice(0, 512),
          objectId: typeof property.value.objectId === 'string' ? property.value.objectId.slice(0, 512) : '',
          ...(Object.hasOwn(property.value, 'value') ? { value: property.value.value } : {}),
        } : null,
        enumerable: property?.enumerable === true, writable: property?.writable === true,
        configurable: property?.configurable === true, accessor: property?.accessor === true,
      })) : [];
      const scopes = Array.isArray(value.scopeChain) ? value.scopeChain.slice(0, 8).filter(scope => scope && scope.object && typeof scope.object.objectId === 'string').map(scope => ({
        type: String(scope.type || 'local').slice(0, 32), name: String(scope.name || '').slice(0, 128),
        object: { objectId: scope.object.objectId.slice(0, 512), type: String(scope.object.type || 'object').slice(0, 32), subtype: String(scope.object.subtype || '').slice(0, 32), className: String(scope.object.className || '').slice(0, 128), description: String(scope.object.description || 'Scope').slice(0, 256) },
      })) : [];
      pending.resolve({ breakpointId: typeof value.breakpointId === 'string' ? value.breakpointId.slice(0, 512) : '', properties, scopes }); return;
    }
    if (message[0] === 141) {
      let value;
      try { value = JSON.parse(decoder.decode(message.subarray(1))); }
      catch { throw Error('Invalid remote response-body metadata.'); }
      const pending = networkBodyRequests.get(value.id);
      if (!pending) return;
      if (value.tabId !== pending.tabId) {
        networkBodyRequests.delete(value.id); clearTimeout(pending.timer);
        pending.reject(Error('Remote response-body metadata returned for a different tab.')); return;
      }
      if (value.error) {
        networkBodyRequests.delete(value.id); clearTimeout(pending.timer);
        pending.reject(Error(String(value.error).slice(0, 512))); return;
      }
      const bytes = Number(value.contentBytes), chunks = Number(value.chunks);
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 256 * 1024 || !Number.isSafeInteger(chunks) || chunks < 0 || chunks > 6 || chunks !== Math.ceil(bytes / STREAM_CHUNK_BYTES)) throw Error('Remote response body exceeds its limits.');
      pending.bytes = new Uint8Array(bytes); pending.chunks = chunks; pending.nextChunk = 0; pending.truncated = value.truncated === true; pending.started = true;
      if (!chunks) {
        networkBodyRequests.delete(value.id); clearTimeout(pending.timer);
        pending.resolve({ text: '', truncated: pending.truncated });
      }
      return;
    }
    if (message[0] === 142) {
      if (message.byteLength < 7) throw Error('Invalid remote response-body chunk.');
      const view = new DataView(message.buffer, message.byteOffset, message.byteLength), id = view.getUint32(1), index = view.getUint16(5), part = message.subarray(7), pending = networkBodyRequests.get(id);
      if (!pending?.started || index !== pending.nextChunk || index >= pending.chunks || !part.byteLength || part.byteLength > STREAM_CHUNK_BYTES) throw Error('Invalid remote response-body chunk sequence.');
      const offset = index * STREAM_CHUNK_BYTES;
      if (offset + part.byteLength > pending.bytes.byteLength || (index < pending.chunks - 1 && part.byteLength !== STREAM_CHUNK_BYTES) || (index === pending.chunks - 1 && offset + part.byteLength !== pending.bytes.byteLength)) throw Error('Invalid remote response-body chunk size.');
      pending.bytes.set(part, offset); pending.nextChunk++;
      if (pending.nextChunk === pending.chunks) {
        networkBodyRequests.delete(id); clearTimeout(pending.timer);
        pending.resolve({ text: decoder.decode(pending.bytes), truncated: pending.truncated });
      }
      return;
    }
    if (message[0] === 143) {
      let value;
      try { value = JSON.parse(decoder.decode(message.subarray(1))); }
      catch { throw Error('Invalid remote download metadata.'); }
      const bytes = Number(value.bytes), chunks = Number(value.chunks), id = Number(value.id);
      if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > 64 * 1024 * 1024 || !Number.isSafeInteger(chunks) || chunks < 0 || chunks > 1366 || chunks !== Math.ceil(bytes / STREAM_CHUNK_BYTES) || typeof value.filename !== 'string' || value.filename.length > 512 || remoteDownloadTransfers.has(id) || remoteDownloadTransfers.size >= 2) throw Error('Remote download exceeds its limits.');
      const pending = { id, filename: value.filename, bytes: new Uint8Array(bytes), chunks, nextChunk: 0 };
      remoteDownloadTransfers.set(id, pending);
      if (!chunks) { remoteDownloadTransfers.delete(id); onDownload?.(pending.bytes, { id, filename: pending.filename }); }
      return;
    }
    if (message[0] === 144) {
      if (message.byteLength < 7) throw Error('Invalid remote download chunk.');
      const view = new DataView(message.buffer, message.byteOffset, message.byteLength), id = view.getUint32(1), index = view.getUint16(5), part = message.subarray(7), pending = remoteDownloadTransfers.get(id);
      if (!pending || index !== pending.nextChunk || index >= pending.chunks || !part.byteLength || part.byteLength > STREAM_CHUNK_BYTES) throw Error('Invalid remote download chunk sequence.');
      const offset = index * STREAM_CHUNK_BYTES;
      if (offset + part.byteLength > pending.bytes.byteLength || (index < pending.chunks - 1 && part.byteLength !== STREAM_CHUNK_BYTES) || (index === pending.chunks - 1 && offset + part.byteLength !== pending.bytes.byteLength)) throw Error('Invalid remote download chunk size.');
      pending.bytes.set(part, offset); pending.nextChunk++;
      if (pending.nextChunk === pending.chunks) {
        remoteDownloadTransfers.delete(id);
        onDownload?.(pending.bytes, { id, filename: pending.filename });
      }
      return;
    }
    if (message[0] === 130) {
      if (frame) throw Error('Remote browser sent overlapping frames.');
      let meta;
      try { meta = JSON.parse(decoder.decode(message.subarray(1))); }
      catch { throw Error('Invalid remote browser frame metadata.'); }
      const bytes = Number(meta.bytes), chunks = Number(meta.chunks), seq = Number(meta.seq);
      if (!Number.isSafeInteger(seq) || seq < 0 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_REMOTE_FRAME_BYTES || !Number.isSafeInteger(chunks) || chunks < 1 || chunks > 256 || chunks !== Math.ceil(bytes / STREAM_CHUNK_BYTES)) throw Error('Remote browser frame exceeds its limits.');
      frame = { seq, meta, bytes: new Uint8Array(bytes), chunks, seen: 0, nextChunk: 0 };
      return;
    }
    if (message[0] === 131) {
      if (!frame || message.byteLength < 8) throw Error('Unexpected remote browser frame chunk.');
      const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
      const seq = view.getUint32(1), index = view.getUint16(5), part = message.subarray(7);
      if (seq !== frame.seq || index !== frame.nextChunk || index >= frame.chunks || part.byteLength === 0 || part.byteLength > STREAM_CHUNK_BYTES) throw Error('Invalid remote browser frame sequence.');
      const offset = index * STREAM_CHUNK_BYTES;
      if (offset + part.byteLength > frame.bytes.byteLength || (index < frame.chunks - 1 && part.byteLength !== STREAM_CHUNK_BYTES) || (index === frame.chunks - 1 && offset + part.byteLength !== frame.bytes.byteLength)) throw Error('Invalid remote browser frame size.');
      frame.bytes.set(part, offset); frame.nextChunk++; frame.seen++;
      if (frame.seen === frame.chunks) {
        const complete = frame; frame = null;
        onFrame?.(complete.bytes, { ...complete.meta, seq: complete.seq });
      }
      return;
    }
    throw Error('Unknown remote browser message.');
  }
  function fail(error) {
    const cause = error instanceof Error ? error : Error(String(error));
    if (!ready) { clearTimeout(handshakeTimer); rejectHandshake?.(cause); }
    onState?.('error', cause); socket.close();
  }

  await openPromise;
  return {
    start() {
      if (browserStarted) return Promise.resolve();
      if (startPending) return startPending.promise;
      let resolve, reject;
      const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
      startPending = { promise, resolve, reject, timer: setTimeout(() => finishStart(Error('Remote browser startup timed out.')), 90000) };
      try { send(Uint8Array.of(1)); } catch (error) { finishStart(error); }
      return promise;
    },
    navigate(address, tabId) { jsonMessage(2, { tabId: String(tabId || '').slice(0, 64), url: new URL(address).href }, 8192); },
    historyGo(tabId, delta) {
      if (!validRemoteTabId(tabId) || !Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 50) throw Error('Remote history movement is invalid.');
      jsonMessage(34, { tabId, delta }, 1024);
    },
    activateTab(tabId) {
      if (typeof tabId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(tabId)) return Promise.reject(Error('Remote tab id is invalid.'));
      let pendingCount = 0;
      for (const pendingList of tabActivations.values()) pendingCount += pendingList.length;
      if (pendingCount >= MAX_TAB_ACTIVATIONS) return Promise.reject(Error('Remote tab activation queue is busy.'));
      let resolve, reject;
      const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
      const pendingList = tabActivations.get(tabId) || [];
      const pending = { promise, resolve, reject, timer: null, settled: false };
      pending.timer = setTimeout(() => {
        if (!pending.settled) { pending.settled = true; reject(Error('Remote tab activation timed out.')); }
      }, 10_000);
      pendingList.push(pending);
      tabActivations.set(tabId, pendingList);
      try { jsonMessage(27, { tabId }, 1024); }
      catch (error) {
        const index = pendingList.indexOf(pending);
        if (index >= 0) pendingList.splice(index, 1);
        if (!pendingList.length) tabActivations.delete(tabId);
        clearTimeout(pending.timer); reject(error);
      }
      return promise;
    },
    closeTab(tabId) { jsonMessage(28, { tabId: String(tabId || '').slice(0, 64) }, 1024); },
    resize(width, height, tabId) {
      if (!validRemoteTabId(tabId)) throw Error('Remote tab id is invalid.');
      jsonMessage(3, { tabId, width: Math.max(320, Math.min(1920, Math.round(width))), height: Math.max(240, Math.min(1200, Math.round(height))) });
    },
    input(event, tabId) {
      if (!validRemoteTabId(tabId)) throw Error('Remote tab id is invalid.');
      jsonMessage(4, { ...event, tabId }, 2048);
    },
    insertText(text, tabId) {
      if (!validRemoteTabId(tabId) || typeof text !== 'string' || !text.length || encoder.encode(text).byteLength > 8 * 1024) throw Error('Remote text input exceeds its limit.');
      jsonMessage(4, { type: 'text', action: 'insertText', text, tabId }, 60 * 1024);
    },
    async uploadPageFiles(tabId, chooserId, fileList) {
      if (!validRemoteTabId(tabId) || !Number.isSafeInteger(chooserId) || chooserId < 1 || chooserId > 0xffffffff) throw Error('Remote page file chooser is invalid.');
      if (!fileList || typeof fileList[Symbol.iterator] !== 'function') throw Error('Choose files for the remote page.');
      const files = Array.from(fileList);
      if (!files.length || files.length > 8) throw Error('Choose between 1 and 8 files.');
      let totalBytes = 0;
      const manifest = files.map(file => {
        const name = String(file?.name || '');
        if (!name || encoder.encode(name).byteLength > 255 || name === '.' || name === '..' || /[\/\\\0:]/.test(name) || /[\u0000-\u001f\u007f]/.test(name)) throw Error('A selected file has an invalid filename.');
        if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 16 * 1024 * 1024) throw Error('Each file is limited to 16 MiB.');
        totalBytes += file.size;
        if (totalBytes > 32 * 1024 * 1024) throw Error('Page uploads are limited to 32 MiB total.');
        return { file, name, size: file.size };
      });
      if (pageFileUploads.size) throw Error('A remote page upload is already in progress.');
      const id = (++nextPageFileUploadId >>> 0) || ++nextPageFileUploadId;
      let readyResolve, readyReject, doneResolve, doneReject;
      const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const donePromise = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
      readyPromise.catch(() => {}); donePromise.catch(() => {});
      const pending = { readyResolve, readyReject, doneResolve, doneReject, timer: setTimeout(() => {
        pageFileUploads.delete(id); const error = Error('Remote page upload timed out.'); pending.readyReject(error); pending.doneReject(error);
      }, 180_000) };
      pageFileUploads.set(id, pending);
      try {
        jsonMessage(29, { id, tabId, chooserId, files: manifest.map(({ name, size }) => ({ name, size })) }, 16 * 1024);
        await readyPromise;
        for (let fileIndex = 0; fileIndex < manifest.length; fileIndex++) {
          const { file, size } = manifest[fileIndex];
          for (let offset = 0; offset < size; offset += STREAM_CHUNK_BYTES) {
            while (socket.bufferedAmount > 384 * 1024) await new Promise(resolve => setTimeout(resolve, 4));
            if (closed || !ready || pageFileUploads.get(id) !== pending) throw Error('Remote browser connection closed or page upload cancelled.');
            const part = new Uint8Array(await file.slice(offset, Math.min(size, offset + STREAM_CHUNK_BYTES)).arrayBuffer());
            if (pageFileUploads.get(id) !== pending) throw Error('Remote page upload was cancelled.');
            const message = new Uint8Array(11 + part.byteLength); message[0] = 30;
            const view = new DataView(message.buffer); view.setUint32(1, id); view.setUint16(5, fileIndex); view.setUint32(7, offset); message.set(part, 11); send(message);
          }
        }
        const commit = new Uint8Array(5); commit[0] = 31; new DataView(commit.buffer).setUint32(1, id); send(commit);
        await donePromise;
      } catch (error) {
        pageFileUploads.delete(id); clearTimeout(pending.timer);
        try { jsonMessage(32, { id, tabId, chooserId }, 1024); } catch { /* Session teardown discards the private profile. */ }
        throw error;
      } finally {
        if (pageFileUploads.get(id) === pending) { pageFileUploads.delete(id); clearTimeout(pending.timer); }
      }
    },
    cancelPageFileChooser(tabId, chooserId) {
      if (!validRemoteTabId(tabId) || !Number.isSafeInteger(chooserId) || chooserId < 1 || chooserId > 0xffffffff) return;
      jsonMessage(32, { id: 0, tabId, chooserId }, 1024);
    },
    respondToJavaScriptDialog(tabId, id, accept, promptText = '') {
      if (!validRemoteTabId(tabId) || !Number.isSafeInteger(id) || id < 1 || id > 0xffffffff || typeof accept !== 'boolean' || typeof promptText !== 'string' || encoder.encode(promptText).byteLength > 4096) throw Error('Remote page dialog response is invalid.');
      jsonMessage(33, { tabId, id, accept, promptText }, 8192);
    },
    privacy(settings) {
      jsonMessage(8, {
        blockTrackers: settings?.blockTrackers === true,
        blockThirdParty: settings?.blockThirdParty === true,
        stripTracking: settings?.stripTracking === true,
      }, 1024);
    },
    userscripts(sources) {
      if (!Array.isArray(sources) || sources.length > MAX_REMOTE_USERSCRIPT_COUNT || sources.some(source => typeof source !== 'string')) return Promise.reject(Error('Remote userscript set is invalid.'));
      const bytes = encoder.encode(JSON.stringify(sources));
      if (bytes.byteLength > MAX_REMOTE_USERSCRIPT_BYTES) return Promise.reject(Error('Remote userscripts exceed the 512 KiB session limit.'));
      const id = (++nextUserscriptUploadId >>> 0) || ++nextUserscriptUploadId;
      const chunks = Math.ceil(bytes.byteLength / STREAM_CHUNK_BYTES);
      return new Promise((resolve, reject) => {
        const pending = { resolve, reject, timer: setTimeout(() => { userscriptUploads.delete(id); reject(Error('Remote userscript setup timed out.')); }, 15_000) };
        userscriptUploads.set(id, pending);
        try {
          jsonMessage(9, { id, totalBytes: bytes.byteLength, chunks }, 1024);
          for (let index = 0; index < chunks; index++) {
            const part = bytes.subarray(index * STREAM_CHUNK_BYTES, Math.min(bytes.byteLength, (index + 1) * STREAM_CHUNK_BYTES));
            const message = new Uint8Array(7 + part.byteLength);
            message[0] = 10;
            const view = new DataView(message.buffer);
            view.setUint32(1, id); view.setUint16(5, index); message.set(part, 7);
            send(message);
          }
          const commit = new Uint8Array(5); commit[0] = 11; new DataView(commit.buffer).setUint32(1, id); send(commit);
        } catch (error) { userscriptUploads.delete(id); clearTimeout(pending.timer); reject(error); }
      });
    },
    filters(snapshot) {
      if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.hosts) || !Array.isArray(snapshot.rules) || snapshot.hosts.length + snapshot.rules.length > 30000) return Promise.reject(Error('Compiled network filters are invalid.'));
      const bytes = encoder.encode(JSON.stringify(snapshot));
      if (bytes.byteLength > 8 * 1024 * 1024) return Promise.reject(Error('Compiled network filters exceed the 8 MiB Full-browser limit.'));
      const id = (++nextFilterUploadId >>> 0) || ++nextFilterUploadId;
      const chunks = Math.ceil(bytes.byteLength / STREAM_CHUNK_BYTES);
      return new Promise((resolve, reject) => {
        const pending = { resolve, reject, timer: setTimeout(() => { filterUploads.delete(id); reject(Error('Remote filter-list setup timed out.')); }, 30_000) };
        filterUploads.set(id, pending);
        (async () => {
          try {
            jsonMessage(24, { id, totalBytes: bytes.byteLength, chunks, version: 1, hostCount: snapshot.hosts.length, ruleCount: snapshot.rules.length }, 1024);
            for (let index = 0; index < chunks; index++) {
              while (socket.bufferedAmount > 384 * 1024) await new Promise(r => setTimeout(r, 4));
              const part = bytes.subarray(index * STREAM_CHUNK_BYTES, Math.min(bytes.byteLength, (index + 1) * STREAM_CHUNK_BYTES));
              const message = new Uint8Array(7 + part.byteLength); message[0] = 25;
              const view = new DataView(message.buffer); view.setUint32(1, id); view.setUint16(5, index); message.set(part, 7); send(message);
            }
            jsonMessage(26, { id }, 128);
          } catch (error) { filterUploads.delete(id); clearTimeout(pending.timer); reject(error); }
        })();
      });
    },
    sources(tabId) {
      return sourceRequest('list', null, tabId);
    },
    sourceContent(tabId, url) {
      if (typeof url !== 'string' || url.length > 2048) return Promise.reject(Error('Remote source address is invalid.'));
      return sourceRequest('content', url, tabId);
    },
    cookies(tabId, origin) {
      return siteDataRequest('cookies', origin, tabId);
    },
    clearSiteData(tabId, origin) {
      return siteDataRequest('clear', origin, tabId);
    },
    installExtension(fileList) {
      return uploadExtension(fileList);
    },
    removeExtension(extensionId) {
      if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)) return Promise.reject(Error('Extension id is invalid.'));
      const id = nextExtensionRequestId();
      return extensionCommand(id, 19, { requestId: id, id: extensionId }, 2048);
    },
    triggerExtensionAction(extensionId, tabId) {
      if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId) || !validRemoteTabId(tabId)) return Promise.reject(Error('Extension action target is invalid.'));
      const id = nextExtensionRequestId();
      return extensionCommand(id, 35, { requestId: id, extensionId, tabId }, 2048);
    },
    debugger(tabId, action, options = {}) {
      if (!validRemoteTabId(tabId)) return Promise.reject(Error('Remote tab id is invalid.'));
      if (!['pause', 'resume', 'stepOver', 'stepInto', 'stepOut', 'setBreakpoint', 'removeBreakpoint', 'getProperties', 'getScopes'].includes(action)) return Promise.reject(Error('Unsupported debugger command.'));
      const id = (++nextDebuggerId >>> 0) || ++nextDebuggerId;
      const request = { id, tabId, action };
      if (action === 'setBreakpoint') {
        if (typeof options.url !== 'string' || options.url.length > 2048 || !Number.isSafeInteger(options.line) || options.line < 1 || options.line > 1_000_000) return Promise.reject(Error('Breakpoint source or line is invalid.'));
        request.url = options.url; request.line = options.line;
      }
      if (action === 'removeBreakpoint') {
        if (typeof options.breakpointId !== 'string' || options.breakpointId.length > 512) return Promise.reject(Error('Breakpoint id is invalid.'));
        request.breakpointId = options.breakpointId;
      }
      if (action === 'getProperties') {
        if (typeof options.objectId !== 'string' || !options.objectId.length || options.objectId.length > 512) return Promise.reject(Error('Remote object id is invalid.'));
        request.objectId = options.objectId;
      }
      if (action === 'getScopes') {
        if (typeof options.callFrameId !== 'string' || !options.callFrameId.length || options.callFrameId.length > 256) return Promise.reject(Error('Debugger call frame is invalid.'));
        request.callFrameId = options.callFrameId;
      }
      if (debuggerRequests.size >= 8) return Promise.reject(Error('Remote debugger command limit reached.'));
      return new Promise((resolve, reject) => {
        const pending = { tabId, resolve, reject, timer: setTimeout(() => { debuggerRequests.delete(id); reject(Error('Remote debugger command timed out.')); }, 10_000) };
        debuggerRequests.set(id, pending);
        try { jsonMessage(21, request, 4096); }
        catch (error) { debuggerRequests.delete(id); clearTimeout(pending.timer); reject(error); }
      });
    },
    networkBody(requestId, tabId) {
      if (typeof requestId !== 'string' || !requestId.length || requestId.length > 256 || !validRemoteTabId(tabId)) return Promise.reject(Error('Remote request id or tab id is invalid.'));
      if (networkBodyRequests.size >= 4) return Promise.reject(Error('Remote response-body request limit reached.'));
      const id = (++nextNetworkBodyId >>> 0) || ++nextNetworkBodyId;
      return new Promise((resolve, reject) => {
        const pending = { tabId, resolve, reject, timer: setTimeout(() => { networkBodyRequests.delete(id); reject(Error('Remote response-body request timed out.')); }, 15_000) };
        networkBodyRequests.set(id, pending);
        try { jsonMessage(22, { id, requestId, tabId }, 1024); }
        catch (error) { networkBodyRequests.delete(id); clearTimeout(pending.timer); reject(error); }
      });
    },
    cancelDownload(id) {
      if (!Number.isSafeInteger(id) || id < 1 || id > 0xffffffff) throw Error('Remote download id is invalid.');
      const message = new Uint8Array(5); message[0] = 23; new DataView(message.buffer).setUint32(1, id); send(message);
    },
    evaluate(tabId, expression, callFrameId = '') {
      if (!validRemoteTabId(tabId)) return Promise.reject(Error('Remote tab id is invalid.'));
      if (typeof expression !== 'string' || expression.length > 16 * 1024) return Promise.reject(Error('Console input is limited to 16 KiB.'));
      if (callFrameId !== '' && (typeof callFrameId !== 'string' || callFrameId.length > 256)) return Promise.reject(Error('Selected debugger call frame is invalid.'));
      if (evaluations.size >= 8) return Promise.reject(Error('Remote console evaluation limit reached.'));
      const id = (++nextEvaluationId >>> 0) || ++nextEvaluationId;
      return new Promise((resolve, reject) => {
        const pending = { tabId, resolve, reject, timer: setTimeout(() => { evaluations.delete(id); reject(Error('Remote console evaluation timed out.')); }, 10_000) };
        evaluations.set(id, pending);
        try { jsonMessage(7, { id, tabId, expression, ...(callFrameId ? { callFrameId } : {}) }, 18 * 1024); }
        catch (error) { evaluations.delete(id); clearTimeout(pending.timer); reject(error); }
      });
    },
    ack(sequence) { const message = new Uint8Array(5); message[0] = 5; new DataView(message.buffer).setUint32(1, sequence); send(message); },
    close() { if (ready && !closed) { try { send(Uint8Array.of(6)); } catch { /* closing */ } } closed = true; socket.close(); },
    get ready() { return ready && !closed; },
  };

  function sourceRequest(kind, url, tabId) {
    if (!validRemoteTabId(tabId)) return Promise.reject(Error('Remote tab id is invalid.'));
    if (sourceRequests.size >= 8) return Promise.reject(Error('Remote source request limit reached.'));
    const id = (++nextEvaluationId >>> 0) || ++nextEvaluationId;
    return new Promise((resolve, reject) => {
      const pending = { kind, url, tabId, resolve, reject, started: false, timer: setTimeout(() => { sourceRequests.delete(id); reject(Error('Remote source request timed out.')); }, 15_000) };
      sourceRequests.set(id, pending);
      try { jsonMessage(kind === 'list' ? 12 : 13, kind === 'list' ? { id, tabId } : { id, tabId, url }, 4096); }
      catch (error) { sourceRequests.delete(id); clearTimeout(pending.timer); reject(error); }
    });
  }
  function siteDataRequest(kind, origin, tabId) {
    if (!validRemoteTabId(tabId)) return Promise.reject(Error('Remote tab id is invalid.'));
    let parsed;
    try { parsed = new URL(origin); } catch { return Promise.reject(Error('Remote site origin is invalid.')); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return Promise.reject(Error('Remote site origin is invalid.'));
    if (siteDataRequests.size >= 8) return Promise.reject(Error('Remote site-data request limit reached.'));
    const id = (++nextSiteDataId >>> 0) || ++nextSiteDataId;
    return new Promise((resolve, reject) => {
      const pending = { kind, tabId, resolve, reject, timer: setTimeout(() => { siteDataRequests.delete(id); reject(Error('Remote site-data request timed out.')); }, 15_000) };
      siteDataRequests.set(id, pending);
      try { jsonMessage(kind === 'cookies' ? 14 : 15, { id, tabId, origin }, 2048); }
      catch (error) { siteDataRequests.delete(id); clearTimeout(pending.timer); reject(error); }
    });
  }
  function nextExtensionRequestId() { return (++nextExtensionId >>> 0) || ++nextExtensionId; }
  function extensionCommand(id, opcode, payload, maxBytes = 40 * 1024) {
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: setTimeout(() => { extensionRequests.delete(id); reject(Error('Remote extension operation timed out.')); }, 30_000) };
      extensionRequests.set(id, pending);
      try { if (opcode === 17 || opcode === 18 || opcode === 20) send(payload); else jsonMessage(opcode, payload, maxBytes); }
      catch (error) { extensionRequests.delete(id); clearTimeout(pending.timer); reject(error); }
    });
  }
  async function uploadExtension(fileList) {
    if (extensionUploading) throw Error('An extension upload is already in progress.');
    if (!fileList || typeof fileList[Symbol.iterator] !== 'function') throw Error('Choose an unpacked extension directory.');
    const files = Array.from(fileList);
    if (!files.length || files.length > 128) throw Error('An extension must contain between 1 and 128 files.');
    let totalBytes = 0;
    const rootName = String(files[0].webkitRelativePath || '').split('/')[0];
    const manifest = [];
    for (const file of files) {
      const relative = String(file.webkitRelativePath || '');
      const parts = relative.split('/');
      if (!rootName || parts.length < 2 || parts[0] !== rootName) throw Error('Select one unpacked extension folder.');
      const path = parts.slice(1).join('/');
      if (!path || path.length > 256 || path.split('/').some(part => !part || part === '.' || part === '..') || /[\\\0:]/.test(path)) throw Error('Extension contains an unsafe relative path.');
      if (!Number.isSafeInteger(file.size) || file.size > 2 * 1024 * 1024) throw Error('Each extension file is limited to 2 MiB.');
      totalBytes += file.size;
      if (totalBytes > 16 * 1024 * 1024) throw Error('Extensions are limited to 16 MiB total.');
      manifest.push({ file, path, size: file.size });
    }
    if (!manifest.some(file => file.path === 'manifest.json')) throw Error('The selected folder must contain a root manifest.json.');
    extensionUploading = true;
    const id = nextExtensionRequestId();
    try {
      await extensionCommand(id, 16, { id, files: manifest.map(({ path, size }) => ({ path, size })) });
      for (let fileIndex = 0; fileIndex < manifest.length; fileIndex++) {
        const entry = manifest[fileIndex];
        const bytes = new Uint8Array(await entry.file.arrayBuffer());
        if (bytes.byteLength !== entry.size) throw Error('An extension file changed while it was being read.');
        for (let offset = 0; offset < bytes.byteLength; offset += STREAM_CHUNK_BYTES) {
          const part = bytes.subarray(offset, Math.min(bytes.byteLength, offset + STREAM_CHUNK_BYTES));
          const message = new Uint8Array(11 + part.byteLength); message[0] = 17;
          const view = new DataView(message.buffer);
          view.setUint32(1, id); view.setUint16(5, fileIndex); view.setUint32(7, offset); message.set(part, 11);
          await extensionCommand(id, 17, message);
        }
      }
      const commit = new Uint8Array(5); commit[0] = 18; new DataView(commit.buffer).setUint32(1, id);
      const result = await extensionCommand(id, 18, commit);
      if (!result.extension || typeof result.extension.id !== 'string' || typeof result.extension.name !== 'string') throw Error('Chromium returned invalid extension details.');
      return { id: result.extension.id.slice(0, 128), name: result.extension.name.slice(0, 128), hasAction: result.extension.hasAction === true };
    } catch (error) {
      const abort = new Uint8Array(5); abort[0] = 20; new DataView(abort.buffer).setUint32(1, id);
      try { await extensionCommand(id, 20, abort); } catch { /* connection loss or server already discarded the upload */ }
      throw error;
    } finally { extensionUploading = false; }
  }
}

function asBytes(body) {
  if (body == null) return new Uint8Array();
  if (typeof body === 'string') return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw Error('Browser proxy request bodies must be text or bytes.');
}

function encodeBase64(bytes) {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
  }
  return btoa(text);
}

// A panel-local Noise session keeps browser resource traffic independent from
// the resumable terminal's nonce sequence and request mailbox.
export async function createBrowserTransport({ url, key, onState } = {}) {
  if (!url || !key) throw Error('Connect to Eya before opening the browser.');
  const socket = new WebSocket(browserEndpoint(url));
  socket.binaryType = 'arraybuffer';
  let outbound = null, inbound = null, ready = false, closed = false, nextId = 0;
  const pending = new Map();
  const pageSockets = new Map();
  let active = 0, retainedRequestBytes = 0;
  const queue = [];
  const openPromise = new Promise((resolve, reject) => {
    let handshake;
    const timeout = setTimeout(() => { socket.close(); reject(Error('Browser proxy handshake timed out.')); }, 12000);
    socket.onopen = async () => {
      try {
        handshake = new Noise('NNpsk0', true, null, { psk: await deriveKey(key) });
        handshake.initialise(encoder.encode('eya-browser-v1'));
        socket.send(handshake.send());
      } catch (cause) { clearTimeout(timeout); reject(cause); socket.close(); }
    };
    socket.onmessage = event => {
      try {
        const data = new Uint8Array(event.data);
        if (!outbound) {
          handshake.recv(data);
          if (!handshake.complete) throw Error('Incomplete browser proxy handshake.');
          outbound = new Cipher(handshake.tx); inbound = new Cipher(handshake.rx);
          socket.send(outbound.encrypt(encoder.encode('eya-browser-ready-v1')));
          return;
        }
        const message = inbound.decrypt(data);
        if (!ready) {
          if (decoder.decode(message) !== 'eya-browser-ready-v1') throw Error('The browser proxy rejected the connection.');
          ready = true; clearTimeout(timeout); onState?.('ready'); resolve(); return;
        }
        receive(message);
      } catch (cause) { fail(cause); }
    };
    socket.onerror = () => { if (!ready) { clearTimeout(timeout); reject(Error('Could not connect to the browser proxy.')); } };
    socket.onclose = () => {
      closed = true; ready = false; clearTimeout(timeout); onState?.('closed');
      for (const entry of pending.values()) {
        entry.cleanup?.(); releaseEntry(entry);
        const error = Error('Browser proxy connection closed.');
        if (entry.streamController) entry.streamController.error(error); else entry.reject(error);
      }
      pending.clear();
      for (const entry of pageSockets.values()) {
        entry.closed = true;
        entry.reject?.(Error('Browser proxy connection closed.'));
        entry.onClose?.({ code: 1006, reason: 'Browser proxy connection closed.', wasClean: false });
      }
      pageSockets.clear();
      for (const waiter of queue.splice(0)) { waiter.signal?.removeEventListener('abort', waiter.abort); waiter.reject(Error('Browser proxy connection closed.')); }
      if (!outbound) reject(Error('Browser proxy connection closed.'));
    };
  });

  function send(bytes) {
    if (!ready || socket.readyState !== WebSocket.OPEN) throw Error('Browser proxy is disconnected.');
    if (outbound.nonce >= 0xffffffff || socket.bufferedAmount > 768 * 1024) throw Error('Browser proxy transport is busy.');
    socket.send(outbound.encrypt(bytes));
  }
  function acquire(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason || Error('Request cancelled.'));
    if (active < MAX_PENDING) { active++; return Promise.resolve(makeRelease()); }
    if (queue.length >= MAX_QUEUED) return Promise.reject(Error('Browser request queue is full.'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: null };
      waiter.abort = () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        reject(signal.reason || Error('Request cancelled.'));
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      queue.push(waiter);
    });
  }
  function makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (queue.length) {
        const waiter = queue.shift();
        waiter.signal?.removeEventListener('abort', waiter.abort);
        if (waiter.signal?.aborted) { waiter.reject(waiter.signal.reason || Error('Request cancelled.')); continue; }
        waiter.resolve(makeRelease());
        return;
      }
      active--;
    };
  }
  function receive(message) {
    if (message[0] === 14 && message.length === 9) {
      const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
      const id = view.getUint32(1), credits = view.getUint32(5), entry = pending.get(id);
      if (!entry?.upload || entry.upload.finalSent) return;
      if (credits === 0 || entry.upload.credits + credits > UPLOAD_WINDOW_CHUNKS) throw Error('Invalid browser upload credit.');
      entry.upload.credits += credits;
      pumpUpload(entry);
      return;
    }
    if (message[0] === 7) {
      const meta = JSON.parse(decoder.decode(message.subarray(1)));
      const entry = pageSockets.get(meta.id);
      if (!entry) return;
      if (!meta.ok) { pageSockets.delete(meta.id); entry.reject(Error(meta.error || 'Upstream WebSocket handshake failed.')); return; }
      entry.open = true;
      entry.sendCredits = Math.min(MAX_WEBSOCKET_SEND_WINDOW, meta.sendCredit || MAX_WEBSOCKET_SEND_WINDOW);
      entry.resolve(makePageSocket(meta.id, entry, meta.protocol || '', Array.isArray(meta.cookies) ? meta.cookies : []));
      return;
    }
    if (message[0] === 12 && message.length === 5) {
      const id = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(1);
      const entry = pageSockets.get(id);
      if (entry && !entry.closed) {
        entry.sendCredits = Math.min(MAX_WEBSOCKET_SEND_WINDOW, entry.sendCredits + 1);
        pumpPageSocket(id, entry);
      }
      return;
    }
    if (message[0] === 9 && message.length >= 11) {
      const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
      const id = view.getUint32(1), messageId = view.getUint32(5), kind = message[9], finalChunk = message[10] !== 0;
      const entry = pageSockets.get(id);
      if (!entry || ![1, 2].includes(kind)) return;
      if (entry.inboundId === null) { entry.inboundId = messageId; entry.inboundKind = kind; entry.inboundChunks = []; entry.inboundBytes = 0; }
      if (entry.inboundId !== messageId || entry.inboundKind !== kind) { closePageSocket(id, entry, 1002, 'Invalid proxy WebSocket framing'); return; }
      const part = message.subarray(11).slice();
      entry.inboundBytes += part.byteLength;
      if (entry.inboundBytes > MAX_WEBSOCKET_MESSAGE) { closePageSocket(id, entry, 1009, 'WebSocket message exceeds the proxy limit'); return; }
      entry.inboundChunks.push(part);
      if (finalChunk) {
        const bytes = new Uint8Array(entry.inboundBytes); let offset = 0;
        for (const chunk of entry.inboundChunks) { bytes.set(chunk, offset); offset += chunk.length; }
        entry.inboundId = null; entry.inboundChunks = []; entry.inboundBytes = 0;
        try { entry.onMessage?.({ data: bytes, kind }); } catch { /* A page callback cannot tear down the shared proxy session. */ }
      }
      return;
    }
    if (message[0] === 10 && message.length >= 7) {
      const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
      const id = view.getUint32(1), code = view.getUint16(5), reason = decoder.decode(message.subarray(7));
      const entry = pageSockets.get(id);
      if (entry) { pageSockets.delete(id); entry.onClose?.({ code, reason, wasClean: code !== 1006 }); entry.closed = true; }
      return;
    }
    if (message[0] === 2) {
      const meta = JSON.parse(decoder.decode(message.subarray(1)));
      const entry = pending.get(meta.id);
      if (!entry) return;
      entry.meta = meta;
      if (!meta.ok) {
        pending.delete(meta.id); entry.cleanup?.(); releaseEntry(entry);
        const error = Error(meta.error || `Upstream request failed (${meta.status}).`);
        if (entry.streamController) entry.streamController.error(error); else entry.reject(error);
        return;
      }
      if (entry.streaming && !entry.streamResolved) {
        const status = meta.status || 200;
        const noBody = entry.method === 'HEAD' || [204, 205, 304].includes(status);
        const body = noBody ? null : new ReadableStream({
          start(controller) { entry.streamController = controller; },
          pull() {
            if (entry.done || entry.awaitingChunk) return;
            entry.awaitingChunk = true;
            const credit = entry.lastChunkBytes || STREAM_CHUNK_BYTES;
            entry.lastChunkBytes = 0;
            const grant = new Uint8Array(9); grant[0] = 5;
            const view = new DataView(grant.buffer); view.setUint32(1, entry.id); view.setUint32(5, credit);
            try { send(grant); } catch (cause) { failStream(entry, cause); }
          },
          cancel(reason) { cancelEntry(entry, reason || Error('Response stream cancelled.'), false); },
        }, { highWaterMark: 0 });
        entry.streamResolved = true;
        entry.resolve({ status, headers: meta.headers || {}, cookies: Array.isArray(meta.cookies) ? meta.cookies : [], url: meta.url || entry.url, cacheHit: meta.cacheHit === true, body });
      }
      return;
    }
    if (message[0] !== 3 || message.length < 6) throw Error('Invalid browser proxy response.');
    const id = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(1);
    const entry = pending.get(id);
    if (!entry) return;
    const part = message.subarray(6);
    if (entry.streaming) {
      if (part.length) {
        if (!entry.streamController) { cancelEntry(entry, Error('Received response bytes before stream setup.')); return; }
        entry.awaitingChunk = false;
        entry.lastChunkBytes = part.byteLength;
        entry.streamController.enqueue(part);
      }
      if (message[5] !== 0) {
        entry.done = true; pending.delete(id); entry.cleanup?.(); releaseEntry(entry);
        entry.streamController?.close();
      }
      return;
    }
    entry.bytes += part.byteLength;
    if (entry.bytes > MAX_RESPONSE_BYTES) {
      pending.delete(id); entry.cleanup?.(); releaseEntry(entry); entry.reject(Error('Page resource exceeds the client memory limit.'));
      const cancel = new Uint8Array(5); cancel[0] = 4; new DataView(cancel.buffer).setUint32(1, id);
      try { send(cancel); } catch { /* The connection may already be closed. */ }
      return;
    }
    if (part.length) entry.chunks.push(part.slice());
    if (message[5] !== 0) {
      pending.delete(id);
      entry.cleanup?.();
      releaseEntry(entry);
      const body = new Uint8Array(entry.bytes); let offset = 0;
      for (const chunk of entry.chunks) { body.set(chunk, offset); offset += chunk.length; }
      entry.resolve({ status: entry.meta?.status || 200, headers: entry.meta?.headers || {}, cookies: Array.isArray(entry.meta?.cookies) ? entry.meta.cookies : [], url: entry.meta?.url || entry.url, body });
    } else if (part.length) {
      const grant = new Uint8Array(9); grant[0] = 5;
      const view = new DataView(grant.buffer); view.setUint32(1, id); view.setUint32(5, part.byteLength);
      try { send(grant); } catch (cause) { fail(cause); }
    }
  }
  function releaseEntry(entry) {
    entry.upload = null;
    if (!entry.release) return;
    const release = entry.release; entry.release = null; release();
  }
  function cancelEntry(entry, cause, errorStream = true) {
    if (!pending.delete(entry.id)) return;
    entry.done = true; entry.upload = null; entry.cleanup?.(); releaseEntry(entry);
    const cancel = new Uint8Array(5); cancel[0] = 4; new DataView(cancel.buffer).setUint32(1, entry.id);
    try { send(cancel); } catch { /* The connection may already be closed. */ }
    if (entry.streamController && errorStream) { try { entry.streamController.error(cause instanceof Error ? cause : Error('Response stream cancelled.')); } catch { /* The consumer may already have cancelled the stream. */ } }
    else entry.reject(cause instanceof Error ? cause : Error('Request cancelled.'));
  }
  function failStream(entry, cause) {
    entry.done = true; pending.delete(entry.id); entry.cleanup?.(); releaseEntry(entry);
    entry.streamController?.error(cause instanceof Error ? cause : Error('Browser proxy stream failed.'));
  }
  function pumpUpload(entry) {
    if (!entry.upload || entry.upload.pumping || entry.done) return;
    entry.upload.pumping = true;
    const step = () => {
      const upload = entry.upload;
      if (!upload || upload.finalSent || entry.done) { if (upload) upload.pumping = false; return; }
      if (upload.credits <= 0) { upload.pumping = false; return; }
      if (socket.bufferedAmount > 512 * 1024) { setTimeout(step, 4); return; }
      const part = upload.bytes.subarray(upload.offset, Math.min(upload.bytes.length, upload.offset + STREAM_CHUNK_BYTES));
      const finalChunk = upload.offset + part.length === upload.bytes.length;
      const frame = new Uint8Array(10 + part.length), view = new DataView(frame.buffer);
      frame[0] = 13; view.setUint32(1, entry.id); view.setUint32(5, upload.sequence); frame[9] = finalChunk ? 1 : 0; frame.set(part, 10);
      try { send(frame); }
      catch (cause) {
        if (!closed && socket.readyState === WebSocket.OPEN && socket.bufferedAmount > 512 * 1024) { setTimeout(step, 4); return; }
        upload.pumping = false; cancelEntry(entry, cause); return;
      }
      upload.credits--; upload.offset += part.length; upload.sequence++;
      if (finalChunk) { upload.finalSent = true; upload.bytes = null; upload.pumping = false; return; }
      setTimeout(step, 0);
    };
    step();
  }
  function fail(cause) {
    socket.close();
    for (const entry of pending.values()) {
      entry.cleanup?.(); releaseEntry(entry);
      const error = cause instanceof Error ? cause : Error('Browser proxy protocol failed.');
      if (entry.streamController) entry.streamController.error(error); else entry.reject(error);
    }
    pending.clear();
    for (const entry of pageSockets.values()) { entry.reject?.(cause); entry.onClose?.({ code: 1006, reason: 'Browser proxy connection closed.', wasClean: false }); }
    pageSockets.clear();
  }

  function makePageSocket(id, entry, protocol, cookies) {
    const handle = {
      protocol,
      cookies,
      get bufferedAmount() { return entry.queuedBytes; },
      send(data, kind = 1) {
        if (entry.closed || !entry.open) throw Error('WebSocket is not open.');
        const bytes = asBytes(data).slice();
        if (bytes.byteLength > MAX_WEBSOCKET_MESSAGE || entry.queuedBytes + bytes.byteLength > MAX_WEBSOCKET_MESSAGE) throw Error('Browser WebSocket send queue is full.');
        entry.queuedBytes += bytes.byteLength;
        entry.outbound.push({ bytes, kind, offset: 0, messageId: (++entry.outboundId >>> 0) || ++entry.outboundId });
        pumpPageSocket(id, entry);
      },
      close(code = 1000, reason = '') { closePageSocket(id, entry, code, reason); },
      credit() {
        if (entry.closed) return;
        const frame = new Uint8Array(5); frame[0] = 11; new DataView(frame.buffer).setUint32(1, id);
        try { send(frame); } catch { /* Teardown closes the upstream socket. */ }
      },
    };
    entry.handle = handle;
    return handle;
  }

  function pumpPageSocket(id, entry) {
    if (entry.pumping || entry.closed || !entry.open) return;
    entry.pumping = true;
    const step = () => {
      if (entry.closed) { entry.pumping = false; return; }
      if (socket.bufferedAmount > 256 * 1024) { setTimeout(step, 4); return; }
      const item = entry.outbound[0];
      if (!item) { entry.pumping = false; return; }
      if (entry.sendCredits <= 0) { entry.pumping = false; return; }
      const part = item.bytes.subarray(item.offset, Math.min(item.bytes.length, item.offset + STREAM_CHUNK_BYTES));
      const frame = new Uint8Array(11 + part.length); const view = new DataView(frame.buffer);
      frame[0] = 8; view.setUint32(1, id); view.setUint32(5, item.messageId); frame[9] = item.kind;
      const finalChunk = item.offset + part.length >= item.bytes.length;
      frame[10] = finalChunk ? 1 : 0; frame.set(part, 11);
      try { send(frame); } catch (cause) { entry.closed = true; pageSockets.delete(id); entry.onClose?.({ code: 1006, reason: cause.message, wasClean: false }); entry.pumping = false; return; }
      entry.sendCredits--;
      item.offset += part.length;
      if (finalChunk) { entry.outbound.shift(); entry.queuedBytes -= item.bytes.length; }
      setTimeout(step, 0);
    };
    step();
  }

  function closePageSocket(id, entry, code, reason) {
    if (entry.closed) return;
    entry.closed = true;
    let safeReason = '';
    for (const char of String(reason || '')) {
      if (encoder.encode(safeReason + char).byteLength > 123) break;
      safeReason += char;
    }
    const reasonBytes = encoder.encode(safeReason);
    const frame = new Uint8Array(7 + reasonBytes.length); const view = new DataView(frame.buffer);
    frame[0] = 10; view.setUint32(1, id); view.setUint16(5, code); frame.set(reasonBytes, 7);
    try { send(frame); } catch { /* Closing the outer transport also closes upstream sockets. */ }
    entry.outbound.length = 0; entry.queuedBytes = 0;
    setTimeout(() => { if (pageSockets.get(id) === entry) pageSockets.delete(id); }, 5000);
  }

  await openPromise;
  return {
    async request(url, { method = 'GET', headers = {}, body, signal, stream = false, bypassCache = false, followRedirects = true } = {}) {
      if (closed) throw Error('Browser proxy connection is closed.');
      const bytes = asBytes(body);
      if (bytes.length > MAX_REQUEST_BODY) throw Error('Browser proxy request bodies are limited to 4 MiB.');
      const absolute = new URL(url).href;
      if (retainedRequestBytes + bytes.length > MAX_RETAINED_REQUEST_BYTES) throw Error('Browser request upload memory budget is busy.');
      retainedRequestBytes += bytes.length;
      const id = (++nextId >>> 0) || ++nextId;
      let release;
      try { release = await acquire(signal); }
      catch (cause) { retainedRequestBytes -= bytes.length; throw cause; }
      try { return await new Promise((resolve, reject) => {
        const entry = { id, url: absolute, method: String(method).toUpperCase(), streaming: stream, chunks: [], bytes: 0, resolve, reject, upload: bytes.length > MAX_INLINE_REQUEST_BODY ? { bytes, offset: 0, sequence: 0, credits: 0, pumping: false } : null, release: () => { release(); retainedRequestBytes = Math.max(0, retainedRequestBytes - bytes.length); } };
        pending.set(id, entry);
        if (signal) {
          const abort = () => {
            cancelEntry(entry, signal.reason || Error('Request cancelled.'));
          };
          if (signal.aborted) { abort(); return; }
          signal.addEventListener('abort', abort, { once: true });
          entry.cleanup = () => signal.removeEventListener('abort', abort);
        }
        try {
          const normalizedHeaders = Array.isArray(headers) ? Object.fromEntries(headers) : Object.fromEntries(new Headers(headers).entries());
          const request = { id, url: absolute, method: entry.method, headers: normalizedHeaders, bodyBase64: bytes.length && bytes.length <= MAX_INLINE_REQUEST_BODY ? encodeBase64(bytes) : undefined, bodySize: bytes.length > MAX_INLINE_REQUEST_BODY ? bytes.length : undefined, initialCredit: stream ? 0 : STREAM_CHUNK_BYTES, bypassCache: bypassCache === true, followRedirects: followRedirects !== false };
          const payload = encoder.encode(JSON.stringify(request));
          if (payload.length > 60000) throw Error('Browser proxy request headers are too large.');
          const message = new Uint8Array(payload.length + 1); message[0] = 1; message.set(payload, 1);
          send(message);
        } catch (cause) {
          pending.delete(id); entry.cleanup?.(); releaseEntry(entry); reject(cause);
        }
      }); } catch (cause) { release(); throw cause; }
    },
    openWebSocket(url, { protocols = [], origin = '', cookie = '', onMessage, onClose } = {}) {
      if (closed || !ready) return Promise.reject(Error('Browser proxy connection is closed.'));
      const id = (++nextId >>> 0) || ++nextId;
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, onMessage, onClose, open: false, closed: false, outbound: [], outboundId: 0, queuedBytes: 0, pumping: false, inboundId: null, inboundKind: 0, inboundChunks: [], inboundBytes: 0 };
        pageSockets.set(id, entry);
        const payload = encoder.encode(JSON.stringify({ id, url: new URL(url).href, protocols, origin, cookie }));
        if (payload.length > 60000) { pageSockets.delete(id); reject(Error('Browser WebSocket handshake is too large.')); return; }
        const frame = new Uint8Array(1 + payload.length); frame[0] = 6; frame.set(payload, 1);
        try { send(frame); } catch (cause) { pageSockets.delete(id); reject(cause); }
      });
    },
    close() { closed = true; socket.close(); },
    get ready() { return ready; },
  };
}
