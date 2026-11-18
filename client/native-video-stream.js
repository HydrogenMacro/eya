import { getKeybinds } from './keybinds.js';
// A controlled same-origin player asks the service worker for ranges. Its
// MessagePort is the only route from that player to the encrypted connection.
export function nativeVideoStream(frame, { url, size, mime, read, onError, resume, onState, preferences = {}, onSettingsChange, onGlobalShortcut }) {
  const base = new URL(url);
  base.protocol = base.protocol === 'wss:' ? 'https:' : 'http:';
  base.pathname = base.pathname.replace(/\/ws\/?$/, '').replace(/\/$/, '') + '/eya-media/player.html';
  base.search = ''; base.hash = '';
  const channel = new MessageChannel();
  let closed = false, connected = false, active = 0, subtitles = [], supportsSubtitles = false;
  const hideControls = event => { if (!closed && connected && event.target !== frame) channel.port1.postMessage({ type: 'hide-controls' }); };
  document.addEventListener('pointerdown', hideControls, { passive: true });
  const fail = message => { if (!closed) onError(Error(message)); };
  const timer = setTimeout(() => { if (!connected) fail('Video player could not start. HTTPS or localhost is required.'); }, 15000);
  const handler = event => {
    if (event.source !== frame.contentWindow || event.origin !== base.origin) return;
    if (event.data?.type === 'eya-media-error') { clearTimeout(timer); fail(event.data.error); return; }
    if (event.data?.type !== 'eya-media-ready') return;
    window.removeEventListener('message', handler);
    frame.contentWindow.postMessage({ type: 'eya-media-init', size, mime, resume, preferences, keybinds: getKeybinds() }, base.origin, [channel.port2]);
  };
  window.addEventListener('message', handler);
  channel.port1.onmessage = async ({ data }) => {
    if (closed) return;
    if (data?.type === 'connected') {
      connected = true; supportsSubtitles = data.capabilities?.includes('sidecar-subtitles-v1') === true; clearTimeout(timer);
      if (supportsSubtitles) channel.port1.postMessage({ type: 'subtitles', tracks: subtitles });
      else if (subtitles.length) fail('External subtitles require a server with sidecar-subtitles-v1 support.');
      return;
    }
    if (data?.type === 'settings-changed') { if (data.preferences && typeof data.preferences === 'object') onSettingsChange?.(data.preferences); return; }
    if (data?.type === 'global-shortcut') { if (typeof data.action === 'string' && data.action.startsWith('global.')) onGlobalShortcut?.(data.action); return; }
    if (data?.type === 'playback-state') {
      if (Number.isFinite(data.time) && data.time >= 0 && typeof data.paused === 'boolean') onState?.({ time: data.time, paused: data.paused });
      return;
    }
    if (data?.type !== 'read' || !Number.isSafeInteger(data.id) || !Number.isSafeInteger(data.offset) || !Number.isSafeInteger(data.length) || data.offset < 0 || data.length < 1 || data.length > 1024 * 1024 || data.offset + data.length > size) return;
    if (active >= 8) { channel.port1.postMessage({ type: 'result', id: data.id, generation: data.generation, error: 'Too many video reads' }); return; }
    active++;
    try {
      const result = await read(data.offset, data.length);
      if (!closed) {
        const bytes = result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength);
        channel.port1.postMessage({ type: 'result', id: data.id, generation: data.generation, bytes }, [bytes]);
      }
    } catch (error) { if (!closed) { channel.port1.postMessage({ type: 'result', id: data.id, generation: data.generation, error: error.message }); fail(error.message); } }
    finally { active--; }
  };
  channel.port1.start(); frame.src = base.href;
  return {
    updateSettings(value) { preferences = value; if (!closed && connected) channel.port1.postMessage({ type: 'settings', preferences, keybinds: getKeybinds() }); },
    openSettings() { if (!closed && connected) channel.port1.postMessage({ type: 'open-settings' }); },
    setSubtitles(tracks) { subtitles = tracks; if (!closed && connected) { if (supportsSubtitles) channel.port1.postMessage({ type: 'subtitles', tracks }); else if (tracks.length) fail('External subtitles require a server with sidecar-subtitles-v1 support.'); } },
    recover() { if (!closed && connected) channel.port1.postMessage({ type: 'recover' }); },
    dispose() { closed = true; clearTimeout(timer); window.removeEventListener('message', handler); document.removeEventListener('pointerdown', hideControls); if (connected) channel.port1.postMessage({ type: 'close' }); channel.port1.close(); frame.removeAttribute('src'); },
  };
}
