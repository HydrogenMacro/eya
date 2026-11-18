// This worker only serves streams belonging to the controlled player client.
// File bytes arrive over a MessagePort from the authenticated Eya client.
const clientsById = new Map();
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  if (!event.source?.id) return;
  if (event.data?.type === 'probe') {
    const state = clientsById.get(event.source.id);
    event.source.postMessage({ type: 'probe', token: event.data.token, present: !!state && state.token === event.data.token });
    return;
  }
  if (event.data?.type !== 'register' || !event.ports[0]) return;
  const clientId = event.source.id, port = event.ports[0];
  const old = clientsById.get(clientId);
  if (old) old.close();
  let finish;
  event.waitUntil(new Promise(resolve => { finish = resolve; }));
  const state = { port, token: event.data.token, size: event.data.size, mime: event.data.mime, pending: new Map(), next: 0, lastPing: Date.now() };
  const expiry = setInterval(() => { if (Date.now() - state.lastPing > 60000) state.close(); }, 15000);
  state.close = () => {
    clearInterval(expiry); if (clientsById.get(clientId) === state) clientsById.delete(clientId);
    for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(Error('Player closed')); }
    state.pending.clear(); port.close(); finish();
  };
  clientsById.set(clientId, state);
  port.onmessage = ({ data }) => {
    if (data?.type === 'close') { state.close(); return; }
    if (data?.type === 'ping') { state.lastPing = Date.now(); return; }
    const pending = state.pending.get(data?.id); if (!pending) return;
    state.pending.delete(data.id); clearTimeout(pending.timer);
    if (data.error) pending.reject(Error(data.error)); else pending.resolve(data.bytes);
  };
  port.start(); port.postMessage({ type: 'ready' });
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (!url.pathname.includes('/eya-media/stream/')) return;
  const state = clientsById.get(event.clientId);
  const token = url.pathname.split('/').at(-1);
  if (!state || token !== state.token || !Number.isSafeInteger(state.size) || state.size < 0) {
    event.respondWith(new Response('Stream not found', { status: 404 })); return;
  }
  const size = state.size, header = event.request.headers.get('range');
  let start = 0, end = size - 1;
  if (header) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header);
    if (!match || (!match[1] && !match[2])) { event.respondWith(new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })); return; }
    if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0, size - suffix); }
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { event.respondWith(new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })); return; }
  }
  const headers = { 'Content-Type': state.mime, 'Content-Length': String(Math.max(0, end - start + 1)), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (header) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  let offset = start, canceled = false;
  const body = new ReadableStream({
    async pull(controller) {
      if (canceled || offset > end) { controller.close(); return; }
      const length = Math.min(1024 * 1024, end - offset + 1), id = ++state.next;
      try {
        const bytes = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { state.pending.delete(id); reject(Error('Video read timed out')); }, 30000);
          state.pending.set(id, { resolve, reject, timer }); state.port.postMessage({ type: 'read', id, offset, length });
        });
        if (canceled) return;
        if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== length) throw Error('Invalid video range');
        offset += length; controller.enqueue(new Uint8Array(bytes));
      } catch (error) { if (!canceled) controller.error(error); }
    },
    cancel() { canceled = true; },
  });
  event.respondWith(new Response(body, { status: header ? 206 : 200, headers }));
});
