// Keep the factory self-contained: its source is also installed in opaque frames.
// CSS Syntax 3 strings/escapes/url tokens; imports retain their layer/supports/media
// suffix verbatim rather than rebuilding an @import rule from regular expressions.
export function createProxyCssTools() {
  const defaultChars = 8 * 1024 * 1024, defaultResources = 256;
  const space = char => char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
  const newline = char => char === '\n' || char === '\r' || char === '\f';
  const name = char => !!char && (/[a-z0-9_-]/i.test(char) || char.charCodeAt(0) >= 128);
  const hex = char => !!char && /[0-9a-f]/i.test(char);

  function escape(source, start) {
    let end = start + 1;
    if (end >= source.length) return { end, value: '\ufffd', newline: false };
    if (newline(source[end])) {
      const cr = source[end++] === '\r';
      if (cr && source[end] === '\n') end++;
      return { end, value: '', newline: true };
    }
    if (hex(source[end])) {
      const from = end;
      while (end < from + 6 && hex(source[end])) end++;
      const code = parseInt(source.slice(from, end), 16);
      if (space(source[end])) {
        const cr = source[end++] === '\r';
        if (cr && source[end] === '\n') end++;
      }
      return { end, value: !code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\ufffd' : String.fromCodePoint(code), newline: false };
    }
    return { end: end + 1, value: source[end] === '\0' ? '\ufffd' : source[end], newline: false };
  }

  function string(source, start) {
    const quote = source[start]; let end = start + 1, value = '';
    while (end < source.length) {
      const char = source[end];
      if (char === quote) return { end: end + 1, value, valid: true };
      if (newline(char)) return { end, value, valid: false };
      if (char === '\\') { const escaped = escape(source, end); value += escaped.value; end = escaped.end; }
      else { value += char === '\0' ? '\ufffd' : char; end++; }
    }
    return { end, value, valid: false };
  }

  function identifier(source, start) {
    let end = start, value = '';
    while (end < source.length) {
      if (name(source[end])) { value += source[end++]; continue; }
      if (source[end] !== '\\' || newline(source[end + 1])) break;
      const escaped = escape(source, end); value += escaped.value; end = escaped.end;
    }
    return { end, value: value.toLowerCase() };
  }

  function trivia(source, start) {
    let end = start;
    while (end < source.length) {
      if (space(source[end])) { end++; continue; }
      if (source[end] !== '/' || source[end + 1] !== '*') break;
      const close = source.indexOf('*/', end + 2);
      end = close === -1 ? source.length : close + 2;
    }
    return end;
  }

  function badUrlEnd(source, start) {
    let end = start;
    while (end < source.length) {
      if (source[end] === ')') return end + 1;
      if (source[end] === '\\') end = escape(source, end).end;
      else end++;
    }
    return end;
  }

  function url(source, start, open) {
    let end = trivia(source, open + 1), value = '';
    if (source[end] === '"' || source[end] === "'") {
      const quoted = string(source, end);
      end = trivia(source, quoted.end);
      if (quoted.valid && source[end] === ')') return { start, end: end + 1, url: quoted.value, syntax: 'url', valid: true };
      return { end: badUrlEnd(source, end), valid: false };
    }
    while (end < source.length) {
      const char = source[end];
      if (char === ')') return { start, end: end + 1, url: value, syntax: 'url', valid: true };
      if (space(char)) {
        end = trivia(source, end);
        if (source[end] === ')') return { start, end: end + 1, url: value, syntax: 'url', valid: true };
        return { end: badUrlEnd(source, end), valid: false };
      }
      if (char === '"' || char === "'" || char === '(' || char.charCodeAt(0) <= 8 || (char.charCodeAt(0) >= 14 && char.charCodeAt(0) <= 31) || char.charCodeAt(0) === 127) return { end: badUrlEnd(source, end), valid: false };
      if (char === '\\') {
        const escaped = escape(source, end);
        if (escaped.newline) return { end: badUrlEnd(source, escaped.end), valid: false };
        value += escaped.value; end = escaped.end;
      } else { value += char === '\0' ? '\ufffd' : char; end++; }
    }
    return { end, valid: false };
  }

  function scan(value, { maxChars = defaultChars, maxResources = defaultResources } = {}) {
    const source = String(value ?? '');
    if (!Number.isSafeInteger(maxChars) || maxChars < 0 || maxChars > defaultChars || source.length > maxChars) throw Error('Stylesheet exceeds the 8 MiB character limit.');
    if (!Number.isSafeInteger(maxResources) || maxResources < 0 || maxResources > defaultResources) throw Error('Invalid stylesheet resource limit.');
    const tokens = [], blocks = []; let cursor = 0, font = false, pendingFont = false;
    const add = (token, kind) => {
      if (!token.valid) return;
      if (tokens.length >= maxResources) throw Error('Stylesheet has too many resource references.');
      tokens.push({ start: token.start, end: token.end, url: token.url, syntax: token.syntax, kind });
    };
    while (cursor < source.length) {
      const char = source[cursor];
      if (space(char) || (char === '/' && source[cursor + 1] === '*')) { cursor = trivia(source, cursor); continue; }
      if (char === '"' || char === "'") { cursor = string(source, cursor).end; continue; }
      if (char === '@') {
        const rule = identifier(source, cursor + 1); cursor = rule.end;
        pendingFont = rule.value === 'font-face';
        if (rule.value !== 'import') continue;
        const start = trivia(source, cursor);
        if (source[start] === '"' || source[start] === "'") {
          const quoted = string(source, start);
          add({ start, end: quoted.end, url: quoted.value, syntax: 'string', valid: quoted.valid }, 'stylesheet');
          cursor = quoted.end;
        } else {
          const fn = identifier(source, start);
          if (fn.value === 'url' && source[fn.end] === '(') {
            const token = url(source, start, fn.end); add(token, 'stylesheet'); cursor = token.end;
          }
        }
        continue;
      }
      if (char === '{') { if (blocks.length >= 1024) throw Error('Stylesheet nesting exceeds its limit.'); blocks.push(font); font = font || pendingFont; pendingFont = false; cursor++; continue; }
      if (char === '}') { font = blocks.pop() || false; pendingFont = false; cursor++; continue; }
      if (char === ';') { pendingFont = false; cursor++; continue; }
      if (name(char) || char === '\\') {
        const fn = identifier(source, cursor);
        if (fn.value === 'url' && source[fn.end] === '(') {
          const token = url(source, cursor, fn.end); add(token, font ? 'font' : 'image'); cursor = token.end;
        } else cursor = Math.max(cursor + 1, fn.end);
      } else cursor++;
    }
    return tokens;
  }

  function quote(value) {
    return '"' + String(value).replace(/["\\\0-\x1f\x7f]/g, char => char === '"' || char === '\\' ? '\\' + char : '\\' + char.charCodeAt(0).toString(16) + ' ') + '"';
  }

  async function rewrite(value, base, load, limits = {}) {
    const source = String(value ?? ''), tokens = scan(source, limits);
    const maxChars = limits.maxChars ?? defaultChars;
    const replacements = await Promise.all(tokens.map(async token => {
      // Decode CSS escapes before checking schemes, but preserve the original
      // token byte-for-byte for embedded/local resources.
      if (!token.url || /^(?:data:|blob:|about:|#)/i.test(token.url.trim())) return source.slice(token.start, token.end);
      let replacement = '';
      try { replacement = await load(new URL(token.url, base).href, token.kind); } catch { /* Omit a failed import; other values become inert. */ }
      if (!replacement) return token.syntax === 'string' ? quote('data:text/css,') : 'url(about:blank)';
      const quoted = quote(replacement);
      return token.syntax === 'string' ? quoted : 'url(' + quoted + ')';
    }));
    let length = source.length;
    for (let index = 0; index < tokens.length; index++) length += replacements[index].length - (tokens[index].end - tokens[index].start);
    if (length > maxChars) throw Error('Rewritten stylesheet exceeds the 8 MiB character limit.');
    const parts = []; let cursor = 0;
    for (let index = 0; index < tokens.length; index++) { parts.push(source.slice(cursor, tokens[index].start), replacements[index]); cursor = tokens[index].end; }
    parts.push(source.slice(cursor));
    return parts.join('');
  }
  return { scan, rewrite };
}
