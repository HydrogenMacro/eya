import Noise from 'noise-handshake';
import Cipher from 'noise-handshake/cipher';
import { crypto_hash_sha256 } from 'sodium-javascript/crypto_hash_sha256.js';
import { svgClient } from './client-artifacts.js';
import { CLIENT_VERSION } from './version.js';
import { compareVersions } from './semver.mjs';
import { hostedClientUrl } from './connection-form.js';
export { compareVersions } from './semver.mjs';

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const marker = '<script id="eya-config" type="application/json">{}</' + 'script>';
const MAX_ARTIFACT = 32 * 1024 * 1024;
function sha256(bytes) { const hash = new Uint8Array(32); crypto_hash_sha256(hash, bytes, bytes.length); return hash; }
export function validateManifest(value) {
  compareVersions(value.client, CLIENT_VERSION); compareVersions(value.server, CLIENT_VERSION);
  if (value.v !== 1 || value.artifact !== 'html-template-v1' || value.config !== 'eya-config-v1' || !/^[a-f0-9]{64}$/.test(value.sha256)
      || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_ARTIFACT || value.chunk !== 32768) throw Error('Unsupported update manifest.');
  return value;
}
export function updateArtifact(template, config, format) {
  if (template.split(marker).length !== 2) throw Error('The update has no compatible configuration slot.');
  const configured = template.replace(marker, () => '<script id="eya-config" type="application/json">' + JSON.stringify(config).replace(/</g, '\\u003c') + '</' + 'script>');
  return format === 'svg' ? svgClient(configured) : configured;
}
export function updateEndpoint(value) {
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/ws')) throw Error('Updates require the server WebSocket URL ending in /ws.');
  url.pathname += '/update'; return url.href;
}

// Frozen bootstrap v1: independent of workspace/terminal versions and capabilities.
export async function openUpdateChannel({ url, key }) {
  if (!key) throw Error('Enter the server URL and password in Connect first.');
  const endpoint = updateEndpoint(url);
  const psk = /^[a-f0-9]{64}$/i.test(key) ? Uint8Array.from(key.match(/../g), value => parseInt(value, 16))
    : sha256(encoder.encode(key));
  const handshake = new Noise('NNpsk0', true, null, { psk }); handshake.initialise(encoder.encode('eya-update-v1'));
  const socket = new WebSocket(endpoint); socket.binaryType = 'arraybuffer';
  let inbound, outbound, pending, nextId = 0, closed = false;
  const close = () => { closed = true; socket.close(); pending?.reject(Error('Update connection closed.')); pending = null; };
  const connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(Error('Update authentication timed out.')); close(); }, 12000);
    socket.onopen = () => { try { socket.send(handshake.send()); } catch (cause) { reject(cause); close(); } };
    socket.onerror = () => { clearTimeout(timer); reject(Error('Update service unavailable. The server may predate client updates.')); close(); };
    socket.onclose = () => { clearTimeout(timer); reject(Error('Update authentication failed or service unavailable.')); close(); };
    socket.onmessage = event => {
      try {
        const bytes = new Uint8Array(event.data);
        if (bytes.length > 65535) throw Error('Update frame too large.');
        if (!inbound) {
          handshake.recv(bytes); if (!handshake.complete) throw Error('Incomplete update handshake.');
          inbound = new Cipher(handshake.rx); outbound = new Cipher(handshake.tx); clearTimeout(timer); resolve();
        } else {
          if (inbound.nonce >= 0xffffffff) throw Error('Update message limit reached.');
          const response = JSON.parse(decoder.decode(inbound.decrypt(bytes)));
          if (!pending || response.id !== pending.id) throw Error('Unexpected update response.');
          const request = pending; pending = null;
          if (response.ok !== true) request.reject(Error(`Update service: ${response.error?.code || 'invalid_response'}`));
          else request.resolve(response);
        }
      } catch (cause) { clearTimeout(timer); reject(cause); pending?.reject(cause); close(); }
    };
  });
  await connected;
  return {
    close,
    request(op, fields = {}) {
      if (closed || pending) return Promise.reject(Error('Update channel is unavailable or busy.'));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { reject(Error('Update download timed out.')); close(); }, 15000);
        pending = { id, resolve: value => { clearTimeout(timer); resolve(value); }, reject: cause => { clearTimeout(timer); reject(cause); } };
        try {
          if (outbound.nonce >= 0xffffffff) throw Error('Update message limit reached.');
          socket.send(outbound.encrypt(encoder.encode(JSON.stringify({ ...fields, v: 1, id, op }))));
        } catch (cause) { pending.reject(cause); pending = null; close(); }
      });
    },
  };
}
export async function downloadTemplate(channel, manifest, progress = () => {}) {
  validateManifest(manifest);
  const bytes = new Uint8Array(manifest.bytes);
  for (let offset = 0; offset < bytes.length;) {
    const value = await channel.request('read', { sha256: manifest.sha256, offset });
    if (value.v !== 1 || value.offset !== offset || typeof value.data !== 'string' || value.data.length > 43692) throw Error('Invalid update chunk.');
    const chunk = Uint8Array.from(atob(value.data), c => c.charCodeAt(0));
    if (chunk.length !== Math.min(manifest.chunk, bytes.length - offset)) throw Error('Invalid update chunk length.');
    bytes.set(chunk, offset); offset += chunk.length; progress(offset / bytes.length);
  }
  const hash = [...sha256(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== manifest.sha256) throw Error('Update integrity check failed.');
  return decoder.decode(bytes);
}

export function setupClientUpdates({ getConnection, config, notify }) {
  const el = id => document.getElementById(id), status = el('client-update-status');
  const indicator = el('client-update-indicator');
  if (indicator) indicator.hidden = true;
  const data = location.protocol === 'data:', hosted = !!config.hosted && /^https?:$/.test(location.protocol);
  const format = !data && document.documentElement.namespaceURI === 'http://www.w3.org/2000/svg' ? 'svg' : 'html';
  let manifest, checkedConnection, busy = false, lastCheck = 0, lastConnection;
  el('client-version').textContent = CLIENT_VERSION;
  el('client-update-note').textContent = data ? 'Data URLs cannot be replaced in place.' : '';
  el('client-update-save').hidden = data || hosted || typeof window.showSaveFilePicker !== 'function';
  el('client-update-reload').hidden = !hosted;
  el('client-update-open').hidden = !data;
  function connection() { const value = getConnection(); updateEndpoint(value.url); return value; }
  async function check(automatic = false) {
    if (busy) return;
    let channel; busy = true;
    try {
      const value = connection();
      if (automatic && value.url === lastConnection?.url && value.key === lastConnection?.key && Date.now() - lastCheck < 3600000) return;
      lastConnection = value; lastCheck = Date.now();
      status.textContent = 'Checking for updates…';
      channel = await openUpdateChannel(value);
      manifest = validateManifest(await channel.request('manifest')); checkedConnection = value;
      el('server-version').textContent = manifest.server;
      const newer = compareVersions(manifest.client, CLIENT_VERSION) > 0;
      status.textContent = newer ? `Client ${manifest.client} is available.` : compareVersions(manifest.client, CLIENT_VERSION) < 0 ? `Server offers older client ${manifest.client}. Your client is ${CLIENT_VERSION}.` : 'Your client is up to date.';
      if (indicator) { indicator.hidden = !newer; indicator.title = indicator.ariaLabel = `Download client ${manifest.client}`; }
      el('client-update-download').disabled = !newer; el('client-update-save').disabled = !newer;
      if (newer && automatic) notify(`Client ${manifest.client} is available. Use the update button at the top right to save it.`);
    } catch (cause) { if (indicator) indicator.hidden = true; manifest = null; el('client-update-download').disabled = el('client-update-save').disabled = true; status.textContent = data ? `Could not check from this data URL. Open the server client or use a saved HTML copy. ${cause.message}` : cause.message; }
    finally { channel?.close(); busy = false; }
  }
  async function install(save) {
    if (busy || !manifest) return;
    let channel, handle; busy = true;
    const release = manifest;
    if (indicator) indicator.disabled = true;
    try {
      const current = connection();
      if (current.url !== checkedConnection.url || current.key !== checkedConnection.key) throw Error('The connection changed. Check for updates again.');
      // Obtain the file choice while this click still has user activation; do not write until verified.
      const filename = `eya-client.${format}`;
      if (save) handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: `Eya ${format.toUpperCase()} client`, accept: { [format === 'svg' ? 'image/svg+xml' : 'text/html']: [`.${format}`] } }] });
      channel = await openUpdateChannel(current);
      const template = await downloadTemplate(channel, release, value => { status.textContent = `Downloading client ${release.client}: ${Math.round(value * 100)}%`; });
      // Preserve unknown embedded configuration fields for future releases, including custom fonts.
      const nextConfig = { ...config, url: current.url, key: current.key, hosted: false };
      const artifact = updateArtifact(template, nextConfig, format);
      const blob = new Blob([artifact], { type: format === 'svg' ? 'image/svg+xml' : 'text/html' });
      if (handle) {
        const writable = await handle.createWritable();
        try { await writable.write(blob); await writable.close(); } catch (cause) { await writable.abort().catch(() => {}); throw cause; }
      } else {
        const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      status.textContent = `Client ${release.client} ${handle ? 'saved' : 'downloaded'}. Save your edits, then open the updated file. Your current page is still running ${CLIENT_VERSION}.`;
    } catch (cause) { status.textContent = cause.name === 'AbortError' ? 'Update save canceled.' : cause.message; }
    finally { channel?.close(); busy = false; if (indicator) { indicator.disabled = false; indicator.title = status.textContent; } notify(status.textContent); }
  }
  if (indicator) indicator.onclick = () => install(!data && typeof window.showSaveFilePicker === 'function');
  el('client-update-check').onclick = () => check();
  el('client-update-download').onclick = () => install(false);
  el('client-update-save').onclick = () => install(true);
  el('client-update-reload').onclick = () => { if (confirm('Reload the hosted client? Save editor changes and save your workspace first.')) location.reload(); };
  el('client-update-open').onclick = () => {
    try { window.open(hostedClientUrl(connection().url), '_blank', 'noopener'); }
    catch (cause) { status.textContent = cause.message; }
  };
  // Check even when a future application protocol can no longer connect.
  return { check, connected: () => check(true) };
}
