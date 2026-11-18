import { crypto_hash_sha256 } from 'sodium-javascript/crypto_hash_sha256.js';
import Noise from 'noise-handshake';

// Authenticate without confirming an application session or creating a workspace.
export async function checkCredentials({ url, key, signal, timeout = 12000 }) {
  const encoder = new TextEncoder();
  const hash = value => { const result = new Uint8Array(32); crypto_hash_sha256(result, value, value.length); return result; };
  const psk = /^[0-9a-f]{64}$/i.test(key)
    ? Uint8Array.from(key.match(/../g), value => parseInt(value, 16))
    : hash(encoder.encode(key));
  if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
  return new Promise((resolve, reject) => {
    const handshake = new Noise('NNpsk0', true, null, { psk });
    handshake.initialise(encoder.encode('eya-terminal-v1'));
    const socket = new WebSocket(url); socket.binaryType = 'arraybuffer';
    let opened = false, settled = false;
    const abort = () => finish(new DOMException('Canceled', 'AbortError'));
    const timer = setTimeout(() => finish(opened ? Error('Connection timed out. Check the address and server.') : unreachableError('Connection timed out. Check the address and server.')), timeout);
    function finish(error) {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.close();
      if (error) reject(error); else resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
    socket.onopen = () => { opened = true; try { socket.send(handshake.send()); } catch { finish(Error('Could not start authentication.')); } };
    socket.onmessage = event => {
      try {
        handshake.recv(new Uint8Array(event.data));
        if (!handshake.complete) throw Error();
        finish();
      } catch { finish(Error('Incorrect password.')); }
    };
    socket.onerror = () => {
      const message = 'Cannot reach the server. Check the address, TLS certificate, and network.';
      finish(opened ? Error(message) : unreachableError(message));
    };
    socket.onclose = () => finish(opened ? Error('Password rejected or server unavailable.') : unreachableError('Cannot reach the server.'));
  });
}

function unreachableError(message) {
  return Object.assign(Error(message), { code: 'unreachable' });
}

export function normalizeConnectionUrl(value, pageProtocol = location.protocol) {
  const url = new URL(value);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Enter a server address without credentials, query, or fragment.');
  if (pageProtocol === 'https:' && url.protocol === 'ws:') throw Error('Use wss:// when this client is opened over HTTPS.');
  const path = url.pathname.replace(/\/$/, '');
  url.pathname = path.endsWith('/ws') ? path : path + '/ws';
  return url;
}

export function hostedClientUrl(value, pageProtocol) {
  const url = normalizeConnectionUrl(value, pageProtocol);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = url.pathname.replace(/\/ws$/, '/client.html');
  return url.href;
}
