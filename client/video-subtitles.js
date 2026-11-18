// Sidecar discovery follows basename[.language][.flags].extension naming.
export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;
export function subtitleCandidates(path, entries) {
  const filename = path.split('/').at(-1), stem = filename.replace(/\.[^.]+$/, '').toLocaleLowerCase();
  return entries.filter(item => {
    if (item.kind !== 'file' || item.size > MAX_SUBTITLE_BYTES) return false;
    const name = item.name.toLocaleLowerCase(), base = name.replace(/\.(srt|vtt|ass|ssa)$/i, '');
    return base !== name && (base === stem || base.startsWith(stem + '.'));
  }).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 16);
}
export function subtitleVtt(text, extension) {
  const source = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (extension === 'vtt') { if (!source.startsWith('WEBVTT')) throw Error('Invalid WebVTT subtitle'); return source; }
  if (extension === 'srt') return 'WEBVTT\n\n' + source.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  // ASS/SSA text is flattened; positioning, drawings, and animation are not rendered.
  const cues = []; let fields = [], events = false;
  const timestamp = value => { const match = value.trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{1,2})$/); return match ? `${match[1].padStart(2, '0')}:${match[2]}:${match[3]}.${match[4].padEnd(3, '0')}` : null; };
  for (const line of source.split('\n')) {
    if (/^\[/.test(line)) events = /^\[Events\]/i.test(line);
    if (!events) continue;
    if (/^Format:/i.test(line)) fields = line.slice(7).split(',').map(value => value.trim().toLowerCase());
    if (!/^Dialogue:/i.test(line) || fields.at(-1) !== 'text') continue;
    const parts = line.slice(9).split(','), count = fields.length;
    if (parts.length < count) continue;
    const start = timestamp(parts[fields.indexOf('start')] || ''), end = timestamp(parts[fields.indexOf('end')] || '');
    const raw = parts.slice(count - 1).join(',');
    if (!start || !end || /\\p[1-9]/i.test(raw)) continue;
    const body = raw.replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    cues.push(`${start} --> ${end}\n${body}`);
    if (cues.length >= 20000) break;
  }
  return 'WEBVTT\n\n' + cues.join('\n\n');
}
export async function discoverSubtitles(path, request, readRange, valid = () => true) {
  const directory = path.slice(0, path.lastIndexOf('/')) || '/';
  if (!valid()) return [];
  const response = await request('list', { path: directory, showHidden: false });
  const results = []; let total = 0;
  if (!valid()) return [];
  for (const entry of subtitleCandidates(path, response.entries)) {
    if (total + entry.size > 8 * 1024 * 1024) break;
    try {
      if (!valid()) return results;
      const chunks = []; let offset = 0, version;
      while (offset < entry.size) {
        if (!valid()) return results;
        const result = await readRange(entry.path, offset, Math.min(1048576, entry.size - offset), version);
        if (!result.bytes.length || result.bytes.length > Math.min(1048576, entry.size - offset) || result.meta.size !== undefined && result.meta.size !== entry.size) throw Error('Subtitle changed while reading');
        version = result.meta.version; chunks.push(result.bytes); offset += result.bytes.length;
      }
      const bytes = new Uint8Array(offset); let cursor = 0;
      for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.length; }
      const suffix = entry.name.replace(/\.[^.]+$/, '').slice(path.split('/').at(-1).replace(/\.[^.]+$/, '').length).replace(/^\./, '');
      results.push({ label: suffix || entry.name, language: suffix.split('.')[0] || '', vtt: subtitleVtt(new TextDecoder().decode(bytes), entry.name.split('.').at(-1).toLowerCase()) });
      total += offset;
    } catch { /* Unreadable or malformed sidecars do not hide other tracks. */ }
  }
  return results;
}
