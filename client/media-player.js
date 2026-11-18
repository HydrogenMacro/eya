import { randomId } from './ids.js';
import { setKeybinds, KEYBIND_ACTIONS, matchesKeybind } from './keybinds-core.js';
import { createVideoControls } from './controls.js';
document.addEventListener('gesturestart', event => event.preventDefault(), { passive: false });
document.addEventListener('gesturechange', event => event.preventDefault(), { passive: false });
(async () => {
  const video = document.querySelector('video');
  let reportSettings = () => {};
  const player = createVideoControls(video, { onSettingsChange: value => reportSettings(value) }); document.body.append(player.element); document.getElementById('boot-status')?.remove();
  try {
    if (!navigator.serviceWorker) throw Error('Video streaming requires a secure server origin (HTTPS or localhost).');
    await navigator.serviceWorker.register('worker.js', { scope: './' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) { location.reload(); return; }
    window.parent.postMessage({ type: 'eya-media-ready' }, '*');
    function initialize(event) {
      if (event.source !== window.parent || event.data?.type !== 'eya-media-init' || !event.ports[0]) return;
      window.removeEventListener('message', initialize);
      const parent = event.ports[0];
      reportSettings = preferences => parent.postMessage({ type: 'settings-changed', preferences });
      const globalKeys = event => {
        if (!event.isTrusted || event.defaultPrevented || document.querySelector('dialog[open]')) return;
        for (const action of KEYBIND_ACTIONS) if (action.group === 'Global' && matchesKeybind(action.id, event)) { event.preventDefault(); event.stopPropagation(); parent.postMessage({ type: 'global-shortcut', action: action.id }); return; }
      };
      document.addEventListener('keydown', globalKeys, { capture: true });
      let worker, generation = 0, initialized = false, restoring = null, retries = 0, closed = false, wantPlay = false;
      const token = randomId();
      const settings = event.data;
      setKeybinds(settings.keybinds); player.updateSettings(settings.preferences);
      let lastState = 0;
      const publish = () => {
        if (closed || !Number.isFinite(video.currentTime)) return;
        parent.postMessage({ type: 'playback-state', time: video.currentTime, paused: video.paused }); lastState = Date.now();
      };
      video.addEventListener('timeupdate', () => { if (Date.now() - lastState >= 2000) publish(); });
      video.addEventListener('pause', publish); video.addEventListener('seeked', publish); video.addEventListener('playing', publish);
      if (Number.isFinite(settings.resume?.time) && settings.resume.time >= 0) {
        video.addEventListener('loadedmetadata', () => {
          video.currentTime = Math.min(settings.resume.time, Number.isFinite(video.duration) ? video.duration : settings.resume.time);
          if (settings.resume.paused === false) video.play().catch(() => {});
        }, { once: true });
      }
      function probe() { if (!closed) navigator.serviceWorker.controller?.postMessage({ type: 'probe', token }); }
      const heartbeat = setInterval(probe, 10000);
      function reloadVideo() {
        if (!restoring) return;
        const restore = restoring; restoring = null;
        video.addEventListener('loadedmetadata', () => { video.currentTime = Math.min(restore.time, video.duration || restore.time); if (restore.playing) video.play().catch(() => {}); }, { once: true });
        video.src = `stream/${token}`;
      }
      function register() {
        worker?.port1.close(); worker = new MessageChannel(); const current = ++generation;
        worker.port1.onmessage = ({ data }) => {
          if (data?.type === 'ready') {
            if (!initialized) { initialized = true; video.src = `stream/${token}`; parent.postMessage({ type: 'connected', capabilities: ['sidecar-subtitles-v1'] }); }
            else reloadVideo();
          } else if (data?.type === 'read') parent.postMessage({ ...data, generation: current });
        };
        worker.port1.start();
        navigator.serviceWorker.controller.postMessage({ type: 'register', token, size: settings.size, mime: settings.mime }, [worker.port2]);
      }
      const probeResponse = ({ data }) => {
        if (closed || data?.type !== 'probe' || data.token !== token) return;
        if (!data.present) { if (initialized && !restoring) restoring = { time: video.currentTime, playing: wantPlay }; register(); }
        else { worker?.port1.postMessage({ type: 'ping' }); reloadVideo(); }
      };
      navigator.serviceWorker.addEventListener('message', probeResponse);
      video.addEventListener('error', () => {
        if (!closed && video.error?.code === MediaError.MEDIA_ERR_NETWORK && retries++ < 2) {
          restoring = { time: video.currentTime, playing: wantPlay }; probe();
        }
      });
      video.addEventListener('playing', () => { wantPlay = true; retries = 0; });
      video.addEventListener('pause', () => { if (!video.error) wantPlay = false; });
      parent.onmessage = ({ data }) => {
        if (data?.type === 'settings') { setKeybinds(data.keybinds); player.updateSettings(data.preferences); }
        if (data?.type === 'open-settings') player.openSettings();
        if (data?.type === 'subtitles') player.addSubtitles(data.tracks);
        if (data?.type === 'recover' && video.error) { restoring = { time: video.currentTime, playing: wantPlay }; retries = 0; probe(); }
        if (data?.type === 'hide-controls') player.hideControls?.();
        if (data?.type === 'close') { closed = true; reportSettings = () => {}; document.removeEventListener('keydown', globalKeys, { capture: true }); clearInterval(heartbeat); navigator.serviceWorker.removeEventListener('message', probeResponse); worker?.port1.postMessage({ type: 'close' }); worker?.port1.close(); parent.close(); player.dispose(); video.removeAttribute('src'); video.load(); }
        if (data?.type === 'result' && data.generation === generation) worker.port1.postMessage(data, data.bytes ? [data.bytes] : []);

      };
      parent.start(); register();
    }
    window.addEventListener('message', initialize);
  } catch (error) { window.parent.postMessage({ type: 'eya-media-error', error: error.message }, '*'); }
})();
