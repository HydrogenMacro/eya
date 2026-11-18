// A second, short-lived decoder provides thumbnails without moving playback.
// It stays in the player document so range requests retain the same worker client.
export function createSeekPreview(video, seek) {
  const element = document.createElement('div');
  element.className = 'eya-video-seek';
  const style = document.createElement('style');
  style.textContent = `
    .eya-video-seek{position:relative;display:flex;align-items:center;flex:1 1 100px;min-width:0;height:38px}
    .eya-video-seek-track{position:absolute;left:0;right:0;top:50%;height:3px;transform:translateY(-50%);overflow:hidden;border-radius:3px;background:#ffffff35;pointer-events:none;transition:height .12s}
    .eya-video-seek:hover .eya-video-seek-track,.eya-video-seek:focus-within .eya-video-seek-track,.eya-video-seek.is-dragging .eya-video-seek-track{height:5px}
    .eya-video-seek-buffer{position:absolute;top:0;bottom:0;background:#ffffff70}
    .eya-video-seek-played{position:absolute;top:0;bottom:0;left:0;background:var(--eya-video-accent,#70e1c0)}
    .eya-video-seek input[type=range]{position:relative;z-index:1;width:100%;min-width:0;height:28px;margin:0;padding:0;border:0;outline-offset:0;appearance:none;-webkit-appearance:none;border-radius:0;background:transparent;touch-action:pan-y}
    .eya-video-seek input[type=range]::-webkit-slider-runnable-track{height:3px;border:0;background:transparent}
    .eya-video-seek input[type=range]::-moz-range-track{height:3px;border:0;background:transparent}
    .eya-video-seek input[type=range]::-moz-range-progress{background:transparent}
    .eya-video-seek input[type=range]::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:12px;height:12px;margin-top:-4.5px;border:0;border-radius:50%;background:var(--eya-video-accent,#70e1c0);box-shadow:0 1px 4px #0005;transition:transform .12s}
    .eya-video-seek input[type=range]::-moz-range-thumb{width:12px;height:12px;border:0;border-radius:50%;background:var(--eya-video-accent,#70e1c0);box-shadow:0 1px 4px #0005}
    .eya-video-seek input[type=range]:active::-webkit-slider-thumb{transform:scale(1.25)}
    .eya-video-seek input[type=range]:disabled{opacity:.4}
    .eya-video-seek-preview{position:absolute;z-index:10;bottom:calc(100% + 6px);width:min(160px,80vw);transform:translateX(-50%);padding:4px;border:1px solid #ffffff40;border-radius:7px;background:#171a1f;color:#fff;box-shadow:0 5px 20px #000a;text-align:center;pointer-events:none;font:12px system-ui}
    .eya-video-seek-preview[hidden],.eya-video-seek-preview canvas[hidden]{display:none}
    .eya-video-seek-preview canvas{display:block;width:100%;height:90px;object-fit:contain;border-radius:4px;background:#000}
    .eya-video-seek-preview span{display:block;padding:3px 0 1px;font-variant-numeric:tabular-nums}
  `;
  const track = document.createElement('div'); track.className = 'eya-video-seek-track'; track.setAttribute('aria-hidden', 'true');
  const ranges = document.createElement('div');
  const played = document.createElement('div'); played.className = 'eya-video-seek-played';
  track.append(ranges, played);
  const preview = document.createElement('div'); preview.className = 'eya-video-seek-preview'; preview.hidden = true; preview.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90; canvas.hidden = true;
  const time = document.createElement('span'); preview.append(canvas, time);
  element.append(style, track, seek, preview);

  let thumbnail = null, timer = 0, pending = null, visible = false, dragging = false, disposed = false;
  const listeners = [];
  function listen(target, name, callback, options) {
    target.addEventListener(name, callback, options);
    listeners.push(() => target.removeEventListener(name, callback, options));
  }
  function format(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
    return (hours ? `${hours}:${String(minutes).padStart(2, '0')}` : String(minutes)) + `:${String(seconds % 60).padStart(2, '0')}`;
  }
  function duration() { return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0; }
  function updateBuffer() {
    ranges.replaceChildren();
    const total = duration();
    if (!total) return;
    try {
      for (let i = 0; i < Math.min(video.buffered.length, 64); i++) {
        const start = Math.max(0, Math.min(1, video.buffered.start(i) / total));
        const end = Math.max(start, Math.min(1, video.buffered.end(i) / total));
        const bar = document.createElement('span'); bar.className = 'eya-video-seek-buffer';
        bar.style.left = `${start * 100}%`; bar.style.width = `${(end - start) * 100}%`; ranges.append(bar);
      }
    } catch { /* Buffered ranges can change while the media is loading. */ }
  }
  function updatePlayed() {
    const min = Number(seek.min) || 0, max = Number(seek.max) || 1000;
    const fraction = Math.max(0, Math.min(1, (Number(seek.value) - min) / (max - min || 1)));
    played.style.width = `${fraction * 100}%`;
  }
  function releaseThumbnail() {
    clearTimeout(timer); timer = 0; pending = null;
    if (thumbnail) { thumbnail.pause(); thumbnail.removeAttribute('src'); thumbnail.load(); thumbnail.remove(); thumbnail = null; }
    canvas.hidden = true;
  }
  function hide() { visible = false; preview.hidden = true; releaseThumbnail(); }
  function draw() {
    if (!thumbnail || !visible || thumbnail.readyState < 2 || pending == null || thumbnail.seeking) return;
    try {
      const w = thumbnail.videoWidth, h = thumbnail.videoHeight;
      if (!w || !h) return;
      canvas.width = Math.max(1, Math.round(Math.min(160 / w, 100 / h) * w));
      canvas.height = Math.max(1, Math.round(Math.min(160 / w, 100 / h) * h));
      canvas.getContext('2d').drawImage(thumbnail, 0, 0, canvas.width, canvas.height);
      canvas.hidden = false;
    } catch { canvas.hidden = true; }
  }
  function runSeek() {
    timer = 0;
    if (!thumbnail || !visible || pending == null || thumbnail.readyState < 1 || thumbnail.seeking) return;
    try {
      if (Math.abs(thumbnail.currentTime - pending) < 0.05) draw();
      else thumbnail.currentTime = pending;
    } catch { canvas.hidden = true; }
  }
  function queueSeek() {
    if (!timer) timer = setTimeout(runSeek, 90);
  }
  function createThumbnail() {
    const src = video.currentSrc || video.src;
    if (!src || thumbnail) return;
    const frame = document.createElement('video');
    thumbnail = frame; frame.muted = true; frame.playsInline = true; frame.setAttribute('playsinline', ''); frame.preload = 'metadata';
    frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    frame.addEventListener('loadedmetadata', () => { if (thumbnail === frame) runSeek(); });
    frame.addEventListener('loadeddata', () => { if (thumbnail === frame) { draw(); if (pending != null && Math.abs(frame.currentTime - pending) >= 0.05) queueSeek(); } });
    frame.addEventListener('seeked', () => { if (thumbnail === frame) { draw(); if (pending != null && Math.abs(frame.currentTime - pending) >= 0.05) queueSeek(); } });
    frame.addEventListener('error', () => { if (thumbnail === frame) canvas.hidden = true; });
    element.append(frame); frame.src = src;
  }
  function showFraction(fraction) {
    const total = duration();
    if (!total || disposed) return;
    fraction = Math.max(0, Math.min(1, fraction));
    pending = Math.max(0, Math.min(Math.max(0, total - 0.05), fraction * total));
    time.textContent = format(fraction * total);
    preview.hidden = false; visible = true;
    const rect = element.getBoundingClientRect(), previewWidth = preview.getBoundingClientRect().width;
    const viewport = window.innerWidth || document.documentElement.clientWidth;
    const minimum = Math.min(previewWidth / 2, Math.max(0, viewport - rect.left));
    const maximum = Math.max(minimum, Math.min(rect.width - previewWidth / 2, viewport - rect.left - previewWidth / 2));
    preview.style.left = `${Math.max(minimum, Math.min(maximum, fraction * rect.width))}px`;
    createThumbnail(); queueSeek();
  }
  function fromPointer(event) {
    const rect = seek.getBoundingClientRect();
    if (rect.width > 0) showFraction((event.clientX - rect.left) / rect.width);
  }
  listen(seek, 'pointerdown', event => { if (seek.disabled) return; dragging = true; element.classList.add('is-dragging'); fromPointer(event); });
  listen(seek, 'pointermove', event => { if (event.pointerType !== 'touch' || dragging) fromPointer(event); });
  listen(seek, 'pointerup', event => { dragging = false; element.classList.remove('is-dragging'); if (event.pointerType === 'touch') hide(); });
  listen(seek, 'pointercancel', () => { dragging = false; element.classList.remove('is-dragging'); hide(); });
  listen(window, 'pointerup', event => { if (dragging && event.target !== seek) { dragging = false; element.classList.remove('is-dragging'); hide(); } });
  listen(window, 'pointercancel', () => { if (dragging) { dragging = false; element.classList.remove('is-dragging'); hide(); } });
  listen(seek, 'pointerleave', () => { if (!dragging) hide(); });
  listen(seek, 'blur', () => { dragging = false; element.classList.remove('is-dragging'); hide(); });
  listen(seek, 'input', () => { updatePlayed(); if (visible) { const min = Number(seek.min) || 0, max = Number(seek.max) || 1000; showFraction((Number(seek.value) - min) / (max - min || 1)); } });
  for (const name of ['progress', 'loadedmetadata', 'durationchange', 'emptied']) listen(video, name, updateBuffer);
  listen(video, 'timeupdate', updatePlayed);
  listen(video, 'emptied', hide);
  updateBuffer(); updatePlayed();
  return { element, hide, get isDragging() { return dragging; }, dispose() { if (disposed) return; disposed = true; hide(); for (const remove of listeners) remove(); } };
}
