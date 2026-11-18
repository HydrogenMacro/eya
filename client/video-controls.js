import { matchesKeybind } from './keybinds-core.js';
import { renderVideoCue } from './video-cues.js';
import { createVideoSettings } from './video-subtitle-settings.js';
import { createSeekPreview } from './video-seek-preview.js';

// Shared by the standalone viewer and the same-origin range streaming player.
export function createVideoControls(video, { preferences = {}, onSettingsChange } = {}) {
  let disposed = false, hideTimer = 0, seekTimer = 0, revealOnly = false, pointerInControls = false;
  const removers = [];
  function listen(target, name, callback, options) { target.addEventListener(name, callback, options); removers.push(() => target.removeEventListener(name, callback, options)); }
  const root = document.createElement('div'); root.className = 'eya-video-player';
  const style = document.createElement('style');
  style.textContent = `
  .eya-video-player{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:#0b0e12;color:#f5f7fa;--eya-video-caption-clearance:var(--eya-video-controls-height,64px);font:13px/1.35 system-ui,-apple-system,sans-serif;touch-action:pan-y}
  .eya-video-player *{box-sizing:border-box}.eya-video-player:fullscreen,.eya-video-player.eya-video-expanded{width:100%;height:100%;background:#080b0f}
  .eya-video-player.eya-video-expanded{position:fixed;inset:0;z-index:2147483647}
  .eya-video-stage{position:relative;flex:1;min-height:0;display:flex;justify-content:center;align-items:center;touch-action:pan-y}
  .eya-video-stage video{display:block;width:100%;height:100%;object-fit:contain}
  .eya-video-captions{position:absolute;bottom:6%;left:5%;right:5%;text-align:center;pointer-events:none;font-size:clamp(18px,3vw,32px);font-weight:700;text-shadow:-2px -2px 2px #000,2px 2px 2px #000}
  .eya-video-captions > .eya-video-cue{background:var(--eya-caption-background,#0009);white-space:pre-wrap}
  .eya-video-error{position:absolute;bottom:12px;left:12px;right:12px;padding:9px 12px;border-radius:8px;background:#432a2e;color:#fff;font-size:12px}.eya-video-error[hidden]{display:none}
  .eya-video-controls{display:flex;align-items:center;gap:4px;padding:10px 12px max(10px,env(safe-area-inset-bottom));background:linear-gradient(180deg,#161c25,#10141b);border:0;flex-wrap:wrap;touch-action:pan-y;position:absolute;bottom:0;left:0;right:0;z-index:3;transition:opacity .18s;background:linear-gradient(transparent,#080b0fe8);padding-top:24px}
  .eya-video-controls button{display:inline-flex;align-items:center;justify-content:center;flex:none;width:38px;height:38px;padding:8px;color:#e7edf5;background:transparent;border:0;border-radius:9px;cursor:pointer}
  .eya-video-controls button:hover,.eya-video-controls button:focus-visible{background:#ffffff1c;color:#fff;outline:none}.eya-video-controls button:focus-visible,.eya-video-controls input:focus-visible,.eya-video-settings :focus-visible{outline:2px solid #75d3d2;outline-offset:2px}
  .eya-video-controls button svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
  .eya-video-controls input[type=range]{min-width:48px;accent-color:#74d7cb;touch-action:pan-y;cursor:pointer}
  .eya-video-time{font-size:11px;color:#c2ced9;font-variant-numeric:tabular-nums;white-space:nowrap}
  .eya-video-settings{position:absolute;z-index:4;right:10px;bottom:calc(var(--eya-video-controls-height,64px) + 8px);width:min(248px,calc(100% - 20px));max-height:calc(100% - var(--eya-video-controls-height,64px) - 20px);overflow:auto;padding:6px;background:#15202be3;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);color:#eef4fa;border:1px solid #ffffff26;border-radius:14px;box-shadow:0 16px 44px #0008;scrollbar-width:thin}
  .eya-video-settings[hidden]{display:none}.eya-video-menu-header{display:flex;align-items:center;gap:10px;padding:8px 10px;font-weight:600;border-bottom:1px solid #ffffff16;margin-bottom:4px}
  .eya-video-settings button{font:inherit;color:inherit;border:0;cursor:pointer;background:transparent}.eya-video-menu-back{min-width:36px;min-height:36px;font-size:22px;border-radius:8px}
  .eya-video-menu-row{display:flex;align-items:center;gap:10px;width:100%;min-height:38px;text-align:left;padding:8px 10px;border-radius:8px}.eya-video-menu-row:hover,.eya-video-menu-row:focus-visible,.eya-video-menu-back:hover{background:#ffffff14}.eya-video-menu-label{flex:1}.eya-video-menu-value{color:#abbac9;font-size:12px}.eya-video-menu-chevron{color:#b1becb}.eya-video-menu-check{width:18px;color:#74d7cb}.eya-video-menu-swatch{width:18px;height:18px;border:1px solid #ffffff60;border-radius:50%}.eya-video-settings p{padding:0 12px;color:#b3c1cf;font-size:12px}
  .eya-video-center{position:absolute;z-index:2;left:50%;top:50%;transform:translate(-50%,-50%);width:68px;height:68px;display:grid;place-items:center;border:1px solid #ffffff30;border-radius:50%;background:#0a111a99;color:#fff;cursor:pointer;backdrop-filter:blur(8px);transition:opacity .18s,background .18s}.eya-video-center:hover{background:#243b4bc9}.eya-video-center svg{width:30px;height:30px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}.eya-video-center:focus-visible{outline:2px solid #74d7cb;outline-offset:4px}
  .eya-video-player.eya-video-ui-hidden .eya-video-controls,.eya-video-player.eya-video-ui-hidden .eya-video-center{opacity:0;visibility:hidden;pointer-events:none}.eya-video-player.eya-video-ui-hidden{cursor:none;--eya-video-caption-clearance:0px}
  .eya-video-loading{position:absolute;top:calc(50% + 48px);left:calc(50% - 19px);width:38px;height:38px;border:3px solid #ffffff35;border-top-color:#74d7cb;border-radius:50%;animation:eya-video-spin .8s linear infinite;pointer-events:none}.eya-video-loading[hidden]{display:none}@keyframes eya-video-spin{to{transform:rotate(360deg)}}
  @media(prefers-reduced-motion:reduce){.eya-video-controls,.eya-video-center{transition:none}.eya-video-loading{animation-duration:2s}}
  .eya-video-help{max-width:min(90vw,600px);max-height:80vh;overflow:auto;padding:22px;background:#1b2430;color:white;border:1px solid #ffffff2b;border-radius:14px}.eya-video-help::backdrop{background:#000a}.eya-video-help pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#10151c;padding:12px;border-radius:8px}.eya-video-help button{padding:8px 14px;background:#35545a;color:white;border:0;border-radius:7px}
  @media(max-width:600px){.eya-video-controls{padding:7px 8px max(7px,env(safe-area-inset-bottom));gap:1px}.eya-video-controls button{width:38px;height:40px}.eya-video-controls .eya-video-volume{display:none}.eya-video-time{font-size:10px}.eya-video-controls .eya-video-seek{order:-1;flex-basis:100%;height:26px}.eya-video-controls .eya-video-time{margin-right:auto}}

  `;
  root.append(style);
  const stage = document.createElement('div'); stage.className = 'eya-video-stage';
  video.controls = false; video.playsInline = true; video.setAttribute('playsinline', ''); video.preload = 'metadata';
  const captions = document.createElement('div'); captions.className = 'eya-video-captions'; captions.setAttribute('aria-live', 'off');
  const errorMessage = document.createElement('div'); errorMessage.className = 'eya-video-error'; errorMessage.setAttribute('role', 'status'); errorMessage.hidden = true;
  stage.append(video, captions, errorMessage); root.append(stage);
  const controls = document.createElement('div'); controls.className = 'eya-video-controls'; root.append(controls);
  const controlSize = new ResizeObserver(() => { root.style.setProperty('--eya-video-controls-height', `${Math.ceil(controls.getBoundingClientRect().height)}px`); if (typeof settingsButton !== 'undefined') positionSettings(); });
  controlSize.observe(controls);
  const paths = { play: 'M8 5v14l11-7z', pause: 'M8 5v14M16 5v14', back: 'M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5M10 10v4m3-4h2v4h-2z', forward: 'M21 12a9 9 0 1 1-3-6.7L21 8m0-5v5h-5M9 10v4m3-4h2v4h-2z', volume: 'M11 5 6 9H3v6h3l5 4zM15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12', mute: 'M11 5 6 9H3v6h3l5 4zM16 9l5 6m0-6-5 6', settings: 'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831 2.34 2.34 0 0 1 2.33-4.033 2.34 2.34 0 0 0 3.32-1.915 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0', fullscreen: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5' };
  function setIcon(button, name, label) {
    if (button.dataset.icon === name && button.getAttribute('aria-label') === label) return;
    button.dataset.icon = name;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[name]); svg.append(path); button.replaceChildren(svg); button.setAttribute('aria-label', label); button.title = label;
  }
  function button(label, action, iconName) { const b = document.createElement('button'); b.type = 'button'; setIcon(b, iconName, label); b.addEventListener('click', action); controls.append(b); return b; }
  const play = button('Play', () => { if (video.paused) video.play().catch(error => { if (disposed || error.name === 'AbortError') return; errorMessage.textContent = 'Unable to play this video. Check its format and try again.'; errorMessage.hidden = false; }); else video.pause(); }, 'play');
  const center = document.createElement('button'); center.type = 'button'; center.className = 'eya-video-center'; center.addEventListener('click', () => play.click()); stage.append(center);
  const loading = document.createElement('div'); loading.className = 'eya-video-loading'; loading.hidden = false; loading.setAttribute('role', 'status'); loading.setAttribute('aria-label', 'Buffering'); stage.append(loading);
  listen(stage, 'click', event => { if (event.target === video || event.target === stage) { if (revealOnly) showControls(); else hideControls(); } });
  for (const name of ['waiting', 'seeking']) listen(video, name, () => { loading.hidden = video.paused; center.style.visibility = loading.hidden ? '' : 'hidden'; });
  for (const name of ['loadeddata', 'canplay', 'playing', 'seeked', 'pause', 'error', 'ended']) listen(video, name, () => { loading.hidden = true; center.style.visibility = ''; });
  listen(video, 'playing', () => { errorMessage.hidden = true; });
  listen(video, 'error', () => { if (video.error) { errorMessage.textContent = 'Unable to load this video. Check its format and connection.'; errorMessage.hidden = false; } });
  button('Rewind 10 seconds', () => { if (Number.isFinite(video.duration)) video.currentTime = Math.max(0, video.currentTime - 10); }, 'back');
  button('Forward 10 seconds', () => { if (Number.isFinite(video.duration)) video.currentTime = Math.min(video.duration, video.currentTime + 10); }, 'forward');
  const seek = document.createElement('input'); seek.type = 'range'; seek.min = '0'; seek.max = '1000'; seek.value = '0'; seek.setAttribute('aria-label', 'Seek');
  const seekPreview = createSeekPreview(video, seek); controls.append(seekPreview.element);
  const time = document.createElement('span'); time.className = 'eya-video-time'; controls.append(time);
  const mute = button('Mute', () => { video.muted = !video.muted; }, 'volume');
  const volume = document.createElement('input'); volume.className = 'eya-video-volume'; volume.type = 'range'; volume.min = '0'; volume.max = '1'; volume.step = '0.05'; volume.value = '1'; volume.setAttribute('aria-label', 'Volume'); volume.style.flex = '0 1 64px'; controls.append(volume);
  const settings = document.createElement('div'); settings.className = 'eya-video-settings'; settings.hidden = true;
  settings.setAttribute('aria-label', 'Video settings'); settings.setAttribute('role', 'menu');
  const tracks = document.createElement('select'); tracks.setAttribute('aria-label', 'Subtitles');
  const note = document.createElement('p'); note.textContent = 'Subtitles include matching files beside the video and embedded tracks exposed by your browser.';
  const helpButton = document.createElement('button'); helpButton.type = 'button'; helpButton.textContent = 'How to embed subtitles'; helpButton.className = 'eya-video-menu-row';
  const settingsMenu = createVideoSettings(video, captions, settings, { tracks, helpButton, note, preferences, onSettingsChange });
  root.append(settings);
  const settingsButton = button('Settings', () => { const open = settings.hidden; settings.hidden = !open; settingsButton.setAttribute('aria-expanded', String(open)); if (open) { settingsMenu.reset(); positionSettings(); } showControls(); }, 'settings');
  function positionSettings() { const bounds = root.getBoundingClientRect(), anchor = settingsButton.getBoundingClientRect(); settings.style.right = `${Math.max(10, bounds.right - anchor.right)}px`; }
  settingsButton.setAttribute('aria-haspopup', 'menu'); settingsButton.setAttribute('aria-expanded', 'false');
  const fullscreen = button('Fullscreen', async () => {
    try {
      if (document.fullscreenElement === root) await document.exitFullscreen();
      else if (document.webkitFullscreenElement === root) document.webkitExitFullscreen();
      else if (root.classList.contains('eya-video-expanded')) root.classList.remove('eya-video-expanded');
      else if (root.requestFullscreen) await root.requestFullscreen();
      else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
      else root.classList.add('eya-video-expanded');
    } catch { if (!document.fullscreenElement && !document.webkitFullscreenElement) root.classList.toggle('eya-video-expanded'); }
    fullscreenChanged();
  }, 'fullscreen');
  function fullscreenChanged() { const expanded = document.fullscreenElement === root || document.webkitFullscreenElement === root || root.classList.contains('eya-video-expanded'); setIcon(fullscreen, 'fullscreen', expanded ? 'Exit fullscreen' : 'Fullscreen'); showControls(); }
  listen(document, 'fullscreenchange', fullscreenChanged); listen(document, 'webkitfullscreenchange', fullscreenChanged);
  const dialog = document.createElement('dialog'); dialog.className = 'eya-video-help';
  const heading = document.createElement('h2'); heading.textContent = 'Embedding subtitles with ffmpeg';
  const description = document.createElement('p'); description.textContent = 'Run this on your computer or server to create a new MP4 with an embedded text subtitle track. The source video is not modified. Your browser must support the video codec and expose the embedded track.';
  const example = document.createElement('pre'); example.textContent = 'ffmpeg -i input.mp4 -i subtitles.srt -map 0 -map 1:0 -c copy -c:s mov_text -metadata:s:s:0 language=eng output.mp4';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close'; close.onclick = () => { if (dialog.close) dialog.close(); else dialog.removeAttribute('open'); };
  dialog.append(heading, description, example, close); root.append(dialog);
  helpButton.onclick = () => { if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', ''); };
  function format(value) { if (!Number.isFinite(value)) return '0:00'; const seconds = Math.max(0, Math.floor(value)), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60; return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(seconds % 60).padStart(2, '0')}`; }
  function update() { setIcon(center, video.paused ? 'play' : 'pause', video.paused ? 'Play video' : 'Pause video'); setIcon(play, video.paused ? 'play' : 'pause', video.paused ? 'Play' : 'Pause'); setIcon(mute, video.muted ? 'mute' : 'volume', video.muted ? 'Unmute' : 'Mute'); volume.value = String(video.volume); time.textContent = `${format(video.currentTime)} / ${format(video.duration)}`; seek.disabled = !Number.isFinite(video.duration) || video.duration <= 0; if (!seekPreview.isDragging && Number.isFinite(video.duration) && video.duration > 0) seek.value = String(Math.round(video.currentTime / video.duration * 1000)); }
  function commitSeek() { clearTimeout(seekTimer); seekTimer = 0; if (Number.isFinite(video.duration)) video.currentTime = Number(seek.value) / 1000 * video.duration; }
  seek.addEventListener('input', () => { if (!seekTimer) seekTimer = setTimeout(commitSeek, 60); });
  seek.addEventListener('change', commitSeek);
  volume.addEventListener('input', () => { video.volume = Number(volume.value); video.muted = video.volume === 0; });
  for (const name of ['timeupdate', 'durationchange', 'play', 'pause', 'volumechange']) listen(video, name, update);
  function drawCues() {
    captions.replaceChildren();
    const track = video.textTracks[Number(tracks.value)];
    if (!track || tracks.value === '') return;
    for (const cue of Array.from(track.activeCues || [])) { const line = renderVideoCue(cue); captions.append(line, document.createElement('br')); }
  }
  function refreshTracks() {
    const previous = tracks.value; tracks.replaceChildren(new Option('Off', ''));
    for (let i = 0; i < video.textTracks.length; i++) {
      const track = video.textTracks[i];
      if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;
      tracks.add(new Option(track.label || track.language || `Track ${i + 1}`, String(i)));
    }
    tracks.value = [...tracks.options].some(option => option.value === previous) ? previous : '';
    applyTrack(); settingsMenu.refreshTracks();
  }
  function applyTrack() { for (let i = 0; i < video.textTracks.length; i++) { const t = video.textTracks[i]; if (t.kind === 'subtitles' || t.kind === 'captions') { t.mode = tracks.value === String(i) ? 'hidden' : 'disabled'; t.removeEventListener('cuechange', drawCues); t.addEventListener('cuechange', drawCues); } } drawCues(); }
  tracks.addEventListener('change', applyTrack); video.textTracks.addEventListener?.('addtrack', refreshTracks); video.textTracks.addEventListener?.('removetrack', refreshTracks); listen(video, 'loadedmetadata', refreshTracks);
  function hideControls() {
    clearTimeout(hideTimer); seekPreview.hide(); if (dialog.open) dialog.close?.(); settings.hidden = true; settingsButton.setAttribute('aria-expanded', 'false');
    root.classList.add('eya-video-ui-hidden');
  }
  function scheduleHide() {
    clearTimeout(hideTimer);
    if (!video.paused && settings.hidden && !pointerInControls && !(root.contains(document.activeElement) && document.activeElement?.matches(':focus-visible'))) hideTimer = setTimeout(hideControls, 2600);
  }
  function showControls() { if (disposed) return; root.classList.remove('eya-video-ui-hidden'); scheduleHide(); }
  listen(document, 'pointerdown', event => { if (!root.contains(event.target)) hideControls(); else { revealOnly = root.classList.contains('eya-video-ui-hidden'); if (!settings.hidden && !settings.contains(event.target) && !settingsButton.contains(event.target) && !dialog.contains(event.target)) { settings.hidden = true; settingsButton.setAttribute('aria-expanded', 'false'); } showControls(); } });
  listen(root, 'pointermove', event => { if (event.pointerType !== 'touch') showControls(); });
  listen(controls, 'pointerenter', event => { if (event.pointerType === 'mouse') { pointerInControls = true; clearTimeout(hideTimer); } });
  listen(controls, 'pointerleave', () => { pointerInControls = false; scheduleHide(); });
  listen(root, 'focusin', showControls); listen(root, 'focusout', () => { clearTimeout(hideTimer); hideTimer = setTimeout(scheduleHide, 0); });
  listen(video, 'play', showControls); listen(video, 'pause', showControls);
  listen(root, 'keydown', event => {
    if (event.key === 'Escape') { if (!settings.hidden) { settings.hidden = true; settingsButton.setAttribute('aria-expanded', 'false'); settingsButton.focus(); event.preventDefault(); } else if (root.classList.contains('eya-video-expanded')) { root.classList.remove('eya-video-expanded'); fullscreenChanged(); } return; }
    if (event.target.closest('input,select,button')) return;
    if (matchesKeybind('video.play', event)) { event.preventDefault(); play.click(); }
    else if (matchesKeybind('video.backward', event) || matchesKeybind('video.forward', event)) { const direction = matchesKeybind('video.forward', event) ? 5 : -5; event.preventDefault(); if (Number.isFinite(video.duration)) video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + direction)); }
    else if (matchesKeybind('video.fullscreen', event)) { event.preventDefault(); fullscreen.click(); }
    else if (matchesKeybind('video.mute', event)) { event.preventDefault(); mute.click(); }
    else if (matchesKeybind('video.settings', event)) { event.preventDefault(); openSettings(); }
    showControls();
  });
  function openSettings() { settings.hidden = false; settingsButton.setAttribute('aria-expanded', 'true'); settingsMenu.reset(); positionSettings(); showControls(); }
  root.tabIndex = 0; root.setAttribute('aria-label', 'Video player');
  refreshTracks(); update();
  const sidecars = [];
  function addSubtitles(tracks) {
    for (const item of sidecars.splice(0)) { item.node.remove(); URL.revokeObjectURL(item.url); }
    for (const item of (Array.isArray(tracks) ? tracks : []).slice(0, 16)) {
      if (typeof item.vtt !== 'string' || item.vtt.length > 4 * 1024 * 1024) continue;
      const node = document.createElement('track'); node.kind = 'subtitles'; node.label = String(item.label || 'External subtitles'); node.srclang = String(item.language || '');
      const url = URL.createObjectURL(new Blob([item.vtt], { type: 'text/vtt' })); node.src = url;
      node.addEventListener('load', () => { if (!disposed) { applyTrack(); drawCues(); } });
      sidecars.push({ node, url }); video.append(node);
    }
    refreshTracks();
  }
  return { element: root, updateSettings: settingsMenu.updateSettings, getSettings: settingsMenu.getSettings, hideControls, addSubtitles, openSettings, dispose() { disposed = true; for (const item of sidecars.splice(0)) { item.node.remove(); URL.revokeObjectURL(item.url); } clearTimeout(hideTimer); clearTimeout(seekTimer); for (const remove of removers) remove(); controlSize.disconnect(); seekPreview.dispose(); settingsMenu.dispose(); video.textTracks.removeEventListener?.('addtrack', refreshTracks); video.textTracks.removeEventListener?.('removetrack', refreshTracks); for (const track of video.textTracks) track.removeEventListener('cuechange', drawCues); dialog.close?.(); video.pause(); video.removeAttribute('src'); video.load(); root.remove(); } };
}
