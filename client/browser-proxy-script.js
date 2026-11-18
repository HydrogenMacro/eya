import { parser as javascriptParser } from '@lezer/javascript';

// This is a compatibility view of a URL, not a browser origin or permission.
// Keep this function self-contained: the panel serializes it into the opaque frame.
export function installProxyLocation(getUrl, navigate) {
  const NativeURL = URL;
  const define = Object.defineProperty;
  const read = () => new NativeURL(String(getUrl()));
  const view = Object.create(null);
  const route = (target, mode) => { navigate(target, mode); };
  for (const name of ['href', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin']) {
    define(view, name, {
      enumerable: true,
      get: () => read()[name],
      ...(name === 'origin' ? {} : { set(value) {
        if (name === 'href') { route(String(value), 'push'); return; }
        const url = read(), previous = url.href;
        url[name] = String(value);
        if (name !== 'hash' || url.href !== previous) route(url.href, 'push');
      } }),
    });
  }
  for (const [name, mode] of [['assign', 'push'], ['replace', 'replace']]) {
    define(view, name, { enumerable: true, value(...args) {
      if (!args.length) throw new TypeError(`Location.${name} requires an argument`);
      route(String(args[0]), mode);
    } });
  }
  define(view, 'reload', { enumerable: true, value: () => route(undefined, 'reload') });
  define(view, 'toString', { value: () => read().href });
  define(view, Symbol.toPrimitive, { value: () => read().href });
  define(view, Symbol.toStringTag, { value: 'Location' });
  Object.preventExtensions(view);
  define(globalThis, '__eyaLocation', { value: () => view, configurable: false, writable: false });
  return view;
}

// loadGraph returns a local {url, release} graph prepared by the authenticated
// parent broker. It already enforces shared source-byte/depth/script budgets.
// Keep graph URLs alive for delayed imports; disposal is tied to the page realm.
export function installProxyModuleImports(loadGraph, getBaseUrl, { maxModules = 64 } = {}) {
  if (!Number.isSafeInteger(maxModules) || maxModules < 1 || maxModules > 64) throw new RangeError('Invalid proxy module quota.');
  const NativeURL = URL;
  const cache = new Map(), graphs = new Set();
  let closed = false, attempts = 0;
  const dispose = () => {
    if (closed) return;
    closed = true; cache.clear();
    for (const graph of graphs) { try { graph.release?.(); } catch {} }
    graphs.clear();
  };
  const importModule = (value, referrer) => {
    let target;
    try {
      if (closed) throw new DOMException('Module loader is closed.', 'AbortError');
      const page = new NativeURL(String(getBaseUrl()));
      const base = new NativeURL(referrer == null ? page.href : String(referrer), page);
      target = new NativeURL(String(value), base);
      if (!['http:', 'https:'].includes(page.protocol) || base.origin !== page.origin || base.username || base.password || target.origin !== page.origin || target.username || target.password) throw new DOMException('Module imports must stay on the page origin.', 'SecurityError');
      if (cache.has(target.href)) return cache.get(target.href);
      if (attempts >= maxModules) throw new DOMException('Page module import limit reached.', 'QuotaExceededError');
      attempts++;
    } catch (error) { return Promise.reject(error); }
    const key = target.href;
    const pending = Promise.resolve().then(() => loadGraph(key)).then(graph => {
      if (!graph || typeof graph.url !== 'string' || !/^(?:blob:|data:)/.test(graph.url)) throw new TypeError('Invalid local module graph.');
      if (closed) { graph.release?.(); throw new DOMException('Module loader is closed.', 'AbortError'); }
      graphs.add(graph);
      return import(graph.url);
    }).catch(error => { if (cache.get(key) === pending) cache.delete(key); throw error; });
    cache.set(key, pending);
    return pending;
  };
  Object.defineProperty(globalThis, '__eyaImport', { value: importModule, configurable: false, writable: false });
  if (typeof addEventListener === 'function') addEventListener('pagehide', dispose, { once: true });
  return { importModule, dispose };
}

const children = node => {
  const result = [];
  for (let child = node?.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
};

function propertyParts(node, source) {
  if (node?.name !== 'MemberExpression') return null;
  const parts = children(node).filter(part => !['.', '?.', '[', ']'].includes(part.name));
  if (parts.length !== 2) return null;
  const property = parts[1];
  const raw = source.slice(property.from, property.to);
  if (property.name === 'PropertyName') return { object: parts[0], property: raw };
  // Computed string properties are useful, but never evaluate page source here.
  if (property.name === 'String' && /^(['"])[^\\\r\n]*\1$/.test(raw)) return { object: parts[0], property: raw.slice(1, -1) };
  return null;
}

function bindingNames(tree, source) {
  const names = new Set();
  tree.iterate({ enter(node) {
    if (node.name === 'VariableDefinition') names.add(source.slice(node.from, node.to));
  } });
  return names;
}

function isWriteTarget(node, source) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (['AssignmentExpression', 'UpdateExpression', 'PostfixExpression', 'PrefixExpression'].includes(parent.name)) {
      const parts = children(parent);
      const left = parts[0];
      if (parent.name !== 'AssignmentExpression' || (left && node.from >= left.from && node.to <= left.to)) return true;
    }
    if (parent.name === 'UnaryExpression' && /^delete\b/.test(source.slice(parent.from, parent.to))) return true;
    if (/Statement$/.test(parent.name) || parent.name === 'VariableDeclaration') break;
  }
  return false;
}

// Native Location is unforgeable in an iframe. Rewrite its common readable
// forms in fetched page scripts, leaving native assignment/navigation handling
// to rewriteLocationNavigations. Aliases of the returned facade also navigate.
export function rewriteProxyScriptReads(value, { maxBytes = 1024 * 1024 } = {}) {
  const source = String(value ?? '');
  if (source.length > maxBytes || !/\b(?:location|document)\b/.test(source)) return source;
  const tree = javascriptParser.parse(source);
  const bindings = bindingNames(tree, source);
  if (bindings.has('globalThis')) return source;
  const edits = [];
  const invalidRanges = [];
  tree.iterate({ enter(node) {
    if (node.name === '⚠') { let parent=node.node.parent; while(parent&&!/Expression$/.test(parent.name)&&!/Statement$/.test(parent.name))parent=parent.parent; invalidRanges.push(parent||node); return false; }
    if (isWriteTarget(node.node, source)) return;
    if (node.name === 'MemberExpression') {
      const parts = propertyParts(node.node, source);
      if (!parts || parts.object.name !== 'VariableName') return;
      const root = source.slice(parts.object.from, parts.object.to);
      if (bindings.has(root)) return;
      if (['window', 'self', 'globalThis', 'document'].includes(root) && parts.property === 'location') {
        edits.push({ from: node.from, to: node.to, text: 'globalThis.__eyaLocation()' });
        return false;
      }
      if (root === 'document' && ['URL', 'documentURI'].includes(parts.property)) {
        edits.push({ from: node.from, to: node.to, text: 'globalThis.__eyaLocation().href' });
        return false;
      }
    }
    if (node.name === 'VariableName' && source.slice(node.from, node.to) === 'location' && !bindings.has('location')) {
      edits.push({ from: node.from, to: node.to, text: 'globalThis.__eyaLocation()' });
    }
  } });
  let result = source;
  for (const edit of edits.filter(edit=>!invalidRanges.some(range=>edit.from>=range.from&&edit.to<=range.to)).sort((a, b) => b.from - a.from)) result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
  return result;
}

function decodeSpecifier(raw) {
  if (!/^(['"])[\s\S]*\1$/.test(raw)) throw Error('Module specifiers must be string literals.');
  let output = '';
  for (let index = 1; index < raw.length - 1; index++) {
    let character = raw[index];
    if (character !== '\\') { output += character; continue; }
    character = raw[++index];
    if (character === '\r' || character === '\n') {
      if (character === '\r' && raw[index + 1] === '\n') index++;
      continue;
    }
    if (character === 'x' || character === 'u') {
      const braced = character === 'u' && raw[index + 1] === '{';
      const start = index + (braced ? 2 : 1);
      const end = braced ? raw.indexOf('}', start) : start + (character === 'x' ? 2 : 4);
      const digits = raw.slice(start, end);
      if (!/^[\da-f]+$/i.test(digits) || (braced && digits.length > 6) || end < start) throw Error('Invalid module string escape.');
      const code = Number.parseInt(digits, 16);
      if (code > 0x10ffff) throw Error('Invalid module string escape.');
      output += String.fromCodePoint(code); index = end - (braced ? 0 : 1);
    } else {
      if (/\d/.test(character)) throw Error('Legacy numeric module string escapes are not supported.');
      output += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' })[character] ?? character;
    }
  }
  return output;
}

// Existing bounded graph loading can preload these literal dynamic imports.
// Their evaluation stays lazy: only the import's URL literal is replaced.
// `source` contains import.meta.url lowering, so callers must store it rather
// than the original text; imports' offsets refer to this returned source.
export function parseProxyModuleImports(value, baseUrl, { maxBytes = 4 * 1024 * 1024, maxImports = 256, allowComputedDynamicImports = false } = {}) {
  const original = String(value ?? '');
  const fail = error => ({ source: original, imports: [], error: String(error.message || error) });
  if (original.length > maxBytes) return fail('Module source exceeds its bounded parse limit.');
  let base;
  try { base = new URL(baseUrl); } catch { return fail('Module base URL is invalid.'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return fail('Module base must be a credential-free HTTP or HTTPS URL.');
  let source = original;
  let error = '';
  const metaEdits = [];
  javascriptParser.parse(source).iterate({ enter(node) {
    if (node.name === '⚠') { error = 'Module uses unsupported JavaScript syntax or import attributes.'; return false; }
    if (node.name !== 'ImportMeta') return;
    const member = node.node.parent;
    const parts = propertyParts(member, source);
    if (!parts || parts.object.from !== node.from || parts.property !== 'url') { error = 'Only import.meta.url is supported by the proxy module graph.'; return false; }
    metaEdits.push({ from: member.from, to: member.to });
  } });
  if (error) return fail(error);
  for (const edit of metaEdits.sort((a, b) => b.from - a.from)) source = source.slice(0, edit.from) + JSON.stringify(base.href) + source.slice(edit.to);
  if (allowComputedDynamicImports) {
    const tree = javascriptParser.parse(source);
    const bindings = bindingNames(tree, source);
    const edits = [];
    tree.iterate({ enter(node) {
      if (node.name !== 'DynamicImport') return;
      const parts = children(node.node).filter(part => !['LineComment', 'BlockComment'].includes(part.name));
      if (parts.length !== 4 || parts[1].name !== '(' || parts[3].name !== ')') { error = 'Module import options are unsupported.'; return false; }
      if (parts[2].name === 'String') return;
      if (bindings.has('globalThis')) { error = 'Computed module imports cannot shadow the global proxy binding.'; return false; }
      edits.push({ from: node.from, to: node.to, innerFrom: parts[2].from, innerTo: parts[2].to });
    } });
    if (error) return fail(error);
    const render = (from, to, candidates) => {
      let output = '', offset = from;
      for (const edit of candidates) {
        if (edit.from < offset || edit.to > to) continue;
        output += source.slice(offset, edit.from) + 'globalThis.__eyaImport((' + render(edit.innerFrom, edit.innerTo, candidates.filter(inner => inner !== edit && inner.from >= edit.innerFrom && inner.to <= edit.innerTo)) + '),' + JSON.stringify(base.href) + ')';
        offset = edit.to;
      }
      return output + source.slice(offset, to);
    };
    source = render(0, source.length, edits.sort((a, b) => a.from - b.from || b.to - a.to));
  }
  const imports = [];
  javascriptParser.parse(source).iterate({ enter(node) {
    if (error) return false;
    let literal;
    let dynamic = false;
    if (node.name === 'DynamicImport') {
      const parts = children(node.node).filter(part => !['LineComment', 'BlockComment'].includes(part.name));
      if (parts.length !== 4 || parts[2].name !== 'String') { error = 'Dynamic module imports require a literal URL; computed imports are unsupported.'; return false; }
      literal = parts[2]; dynamic = true;
    } else if (node.name === 'ImportDeclaration' || node.name === 'ExportDeclaration') literal = node.node.getChild('String');
    if (!literal) return;
    try {
      const specifier = decodeSpecifier(source.slice(literal.from, literal.to));
      if (!/^(?:\.{1,2}\/|\/|[a-z][a-z\d+.-]*:)/i.test(specifier)) throw Error('Bare module specifiers require an import map and are unsupported.');
      const url = new URL(specifier, base);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin || url.username || url.password) throw Error('Module imports must stay on the module origin.');
      if (imports.length >= maxImports) throw Error('Module source exceeds its bounded import count.');
      imports.push({ from: literal.from, to: literal.to, url: url.href, ...(dynamic ? { dynamic: true } : {}) });
    } catch (cause) { error = String(cause.message || cause); }
  } });
  return error ? fail(error) : { source, imports, error: '' };
}
