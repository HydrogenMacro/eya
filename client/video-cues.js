// Reuse the browser's WebVTT cue parser, then copy only inert subtitle markup.
// No cue text, class name, or annotation is interpreted as HTML or CSS here.
const colors = { white: '#fff', lime: '#0f0', cyan: '#0ff', red: '#f00', yellow: '#ff0', magenta: '#f0f', blue: '#00f', black: '#000' };
const allowed = new Set(['b', 'i', 'u', 'ruby', 'rt', 'span']);
export function renderVideoCue(cue) {
  const line = document.createElement('span'); line.className = 'eya-video-cue';
  let fragment;
  try {
    if (typeof cue.getCueAsHTML === 'function') fragment = cue.getCueAsHTML();
    else if (typeof VTTCue === 'function') fragment = new VTTCue(0, 1, String(cue.text || '')).getCueAsHTML();
  } catch { /* Unknown native cue implementations can still display plain text. */ }
  if (!fragment) { line.textContent = cue.text || ''; return line; }
  let remaining = 4096;
  function copy(source, destination, depth = 0) {
    if (depth > 32 || remaining-- <= 0) return;
    if (source.nodeType === 3) { destination.append(document.createTextNode(source.textContent)); return; }
    // Ignore processing instructions (WebVTT timestamps) and arbitrary markup.
    if (source.nodeType !== 1 && source.nodeType !== 11) return;
    const tag = source.localName;
    let target = destination;
    if (allowed.has(tag)) {
      target = document.createElement(tag);
      if (tag === 'span') {
        // Native WebVTT parsing converts <v>, <lang>, and <c> into spans.
        if (source.lang) target.lang = source.lang.slice(0, 64);
        const voice = source.getAttribute('title');
        if (voice) target.dataset.voice = voice.slice(0, 128);
        for (const name of Array.from(source.classList).slice(0, 16)) {
          if (Object.hasOwn(colors, name)) target.style.color = colors[name];
          else if (name.startsWith('bg_') && Object.hasOwn(colors, name.slice(3))) target.style.backgroundColor = colors[name.slice(3)];
          // Retain bounded safe cue classes for trusted application styling only.
          if (/^[a-zA-Z][\w-]{0,63}$/.test(name)) target.classList.add(Object.hasOwn(colors, name) || (name.startsWith('bg_') && Object.hasOwn(colors, name.slice(3))) ? name : `vtt-${name}`);
        }
      }
      destination.append(target);
    }
    for (const child of source.childNodes) copy(child, target, depth + 1);
  }
  copy(fragment, line);
  return line;
}
