import Noise from 'noise-handshake';
import Cipher from 'noise-handshake/cipher';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const key = Uint8Array.from({ length: 32 }, (_, index) => index);
const noise = new Noise('NNpsk0', true, null, { psk: key });
noise.initialise(encoder.encode('eya-terminal-v1'));
const ws = new WebSocket('ws://127.0.0.1:18765/ws');
ws.binaryType = 'arraybuffer';
let outbound, inbound, requestId = 0;
const pending = new Map();
const connected = new Promise((resolve, reject) => {
  ws.onopen = () => ws.send(noise.send());
  ws.onerror = reject;
  ws.onclose = () => reject(Error('connection closed'));
  ws.onmessage = event => {
    try {
      const wire = new Uint8Array(event.data);
      if (!noise.complete) {
        noise.recv(wire);
        outbound = new Cipher(noise.tx);
        inbound = new Cipher(noise.rx);
        ws.send(outbound.encrypt(encoder.encode('eya-ready-v3')));
        resolve();
        return;
      }
      const message = inbound.decrypt(wire);
      if (message[0] === 4) handleJson(JSON.parse(decoder.decode(message.subarray(1))));
      else if (message[0] === 5) handleBytes(message);
      else if (message[0] === 6) handleJsonChunk(message);
    } catch (cause) { reject(cause); }
  };
});

function send(message) { ws.send(outbound.encrypt(message)); }
function control(id, op, values) {
  const data = encoder.encode(JSON.stringify({ id, op, ...values }));
  const message = new Uint8Array(data.length + 1); message[0] = 4; message.set(data, 1); send(message);
}
function request(op, values = {}) {
  const id = ++requestId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); control(id, op, values); });
}
function read(path) {
  const id = ++requestId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, chunks: [] }); control(id, 'read', { path }); });
}
function write(path, bytes) {
  const id = ++requestId;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, bytes }); control(id, 'write', { path, size: bytes.length, overwrite: false }); });
}
function handleJson(value) {
  const item = pending.get(value.id); if (!item) return;
  if (!value.ok) { pending.delete(value.id); item.reject(Error(value.error)); return; }
  if (item.chunks) { item.meta = value; return; }
  if (value.ready) {
    const message = new Uint8Array(item.bytes.length + 6); message[0] = 5; new DataView(message.buffer).setUint32(1, value.id); message[5] = 1; message.set(item.bytes, 6); send(message); return;
  }
  pending.delete(value.id); item.resolve(value);
}
function handleBytes(message) {
  const id = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(1);
  const item = pending.get(id); if (!item?.chunks) return;
  item.chunks.push(message.slice(6));
  if (message[5]) { pending.delete(id); const bytes = new Uint8Array(item.chunks.reduce((sum, chunk) => sum + chunk.length, 0)); let offset = 0; for (const chunk of item.chunks) { bytes.set(chunk, offset); offset += chunk.length; } item.resolve({ meta: item.meta, bytes }); }
}
function handleJsonChunk(message) {
  const id = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(1);
  const item = pending.get(id); if (!item) return;
  (item.json ||= []).push(message.slice(6));
  if (message[5]) { const bytes = new Uint8Array(item.json.reduce((sum, chunk) => sum + chunk.length, 0)); let offset = 0; for (const chunk of item.json) { bytes.set(chunk, offset); offset += chunk.length; } handleJson(JSON.parse(decoder.decode(bytes))); }
}

const timer = setTimeout(() => { console.error('File protocol test timed out'); process.exit(1); }, 10000);
(async () => {
  await connected;
  const listing = await request('list', { path: '', showHidden: false });
  if (!listing.entries.some(entry => entry.name === 'seed.txt')) throw Error('seed file not listed');
  const seed = await read(`${listing.path}/seed.txt`);
  if (decoder.decode(seed.bytes) !== 'seed contents\n') throw Error('seed file contents differed');
  await write(`${listing.path}/protocol.txt`, encoder.encode('protocol contents'));
  await request('rename', { path: `${listing.path}/protocol.txt`, newPath: 'renamed.txt' });
  const results = await request('search', { path: listing.path, query: 'renamed', showHidden: false });
  if (!results.entries.some(entry => entry.name === 'renamed.txt')) throw Error('renamed file not found by search');
  await request('delete', { path: `${listing.path}/renamed.txt`, recursive: false });
  clearTimeout(timer);
  console.log('Encrypted file list, read, upload, rename, search, and delete passed');
  ws.onclose = null; ws.close();
})().catch(cause => { console.error(cause); process.exit(1); });
