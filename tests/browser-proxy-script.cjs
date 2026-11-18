const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { buildSync } = require('esbuild');

const filename = path.resolve(__dirname, '../client/browser-proxy-script.js');
const result = buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(result.outputFiles[0].text, filename);
const { installProxyLocation, rewriteProxyScriptReads, parseProxyModuleImports } = loaded.exports;

const navigations = [];
let current = 'https://docs.example/tutorial/?q=functions#intro';
const nativeLocation = Object.freeze({ href: 'about:srcdoc', origin: 'null', search: '', pathname: 'srcdoc' });
const frame = vm.createContext({ URL, URLSearchParams, window: { location: nativeLocation }, document: { location: nativeLocation, URL: 'about:srcdoc', documentURI: 'about:srcdoc' }, location: nativeLocation, getUrl: () => current, navigate: (...args) => navigations.push(args) });
vm.runInContext(`(${installProxyLocation.toString()})(getUrl,navigate)`, frame);
const run = source => vm.runInContext(rewriteProxyScriptReads(source), frame);
assert.equal(run('new URLSearchParams(window.location.search).get("q")'), 'functions', 'Sphinx search reads the virtual query');
assert.equal(run('new URL("../", window.location).href'), 'https://docs.example/', 'Sphinx URL base is absolute');
assert.equal(run('location.pathname'), '/tutorial/');
assert.equal(run('document.URL'), current);
assert.equal(run('document["documentURI"]'), current);
assert.equal(run('window["location"].host'), 'docs.example');
assert.equal(run('({x: document.location.origin}).x'), 'https://docs.example');
assert.equal(run('String(globalThis.location)'), current);
assert.equal(vm.runInContext('window.location.href', frame), 'about:srcdoc', 'Native origin/Location privileges remain opaque');
assert.equal(vm.runInContext('window.location.origin', frame), 'null');
current = 'https://docs.example/new/?q=closures';
assert.equal(run('location.search'), '?q=closures', 'SPA route reads stay live');
run('const savedLocation=window.location; savedLocation.assign("chapter.html"); savedLocation.search="?q=test"; savedLocation.replace("next"); savedLocation.reload();');
assert.deepEqual(navigations, [['chapter.html', 'push'], ['https://docs.example/new/?q=test', 'push'], ['next', 'replace'], [undefined, 'reload']]);
assert.throws(() => run('location.assign()'), /requires an argument/);
assert.equal(vm.runInContext('Object.getOwnPropertyDescriptor(globalThis,"__eyaLocation").writable', frame), false);
assert.equal(vm.runInContext('Object.getOwnPropertyDescriptor(globalThis,"__eyaLocation").configurable', frame), false);

for (const source of [
  'location = "/new";', 'window.location.href = "/new";', 'window.location += "x";',
  'delete window.location;', 'let location={pathname:"local"}; location.pathname;',
  'function demo(window){return window.location.href}',
  'function demo(globalThis){return window.location.href}',
  'const text="window.location.href"; /location.href/.test(text);',
  'const local={location}; local.location;', 'window.location[',
]) assert.equal(rewriteProxyScriptReads(source), source, `Preserve writes/shadowed/string/unsupported source: ${source}`);
assert.match(rewriteProxyScriptReads('window.location.href = location.pathname;'), /^window\.location\.href = globalThis\.__eyaLocation\(\)\.pathname;/);
assert.equal(rewriteProxyScriptReads('location.href', { maxBytes: 1 }), 'location.href');

const base = 'https://docs.example/assets/worker.js';
const source = 'import {a} from "./a.js"; export * from "./b.js"; const target = new URL("./data.json", import.meta.url); export const lazy = () => import("./lazy.js");';
const parsed = parseProxyModuleImports(source, base);
assert.equal(parsed.error, '');
assert.deepEqual(parsed.imports.map(edge => ({ url: edge.url, dynamic: edge.dynamic === true })), [
  { url: 'https://docs.example/assets/a.js', dynamic: false },
  { url: 'https://docs.example/assets/b.js', dynamic: false },
  { url: 'https://docs.example/assets/lazy.js', dynamic: true },
]);
assert.match(parsed.source, /new URL\("\.\/data.json", "https:\/\/docs.example\/assets\/worker.js"\)/);
for (const edge of parsed.imports) assert.match(parsed.source.slice(edge.from, edge.to), /^['"]/);
const escaped = parseProxyModuleImports('export const load=()=>import(".\\u002flazy.js");', base);
assert.equal(escaped.error, '');
assert.equal(escaped.imports[0].url, 'https://docs.example/assets/lazy.js');
const mixedQuotes = parseProxyModuleImports("import './other.js'; export const load=()=>import('./lazy.js');", base);
assert.equal(mixedQuotes.error, '');
assert.equal(mixedQuotes.imports.length, 2);
for (const [code, pattern] of [
  ['import(name)', /literal/], ['import(`./${name}.js`)', /literal/],
  ['import("https://other.example/a.js")', /origin/], ['import("data:text/javascript,export default 1")', /origin/],
  ['import("pkg")', /Bare/], ['console.log(import.meta.resolve("./x"))', /import.meta.url/],
  ['import("./x.json",{with:{type:"json"}})', /syntax|attributes/],
  ['import("https://name:secret@docs.example/a.js")', /origin/],
]) assert.match(parseProxyModuleImports(code, base).error, pattern, code);
assert.match(parseProxyModuleImports('import "./a.js"; import "./b.js";', base, { maxImports: 1 }).error, /import count/);
assert.match(parseProxyModuleImports('import "./a.js";', base, { maxBytes: 1 }).error, /parse limit/);
assert.match(parseProxyModuleImports('export default 1;', 'data:text/javascript,').error, /base/);
console.log('Proxy scripts: Sphinx URL/search compatibility, live virtual Location, preserved native opacity/writes/bindings, bounded literal dynamic imports and import.meta.url passed.');

const partiallyModern = 'const optional = obj?.[broken + ]; const url=window.location.href;';
assert.match(rewriteProxyScriptReads(partiallyModern), /const url=globalThis.__eyaLocation\(\).href/, 'Recoverable unsupported syntax elsewhere must not disable URL virtualization for a whole webpack bundle');
const computed = parseProxyModuleImports('export const load = value => import("./"+value);', base, {allowComputedDynamicImports:true});
assert.equal(computed.error, '');
assert.match(computed.source, /globalThis.__eyaImport/);
assert.match(computed.source, /https:\/\/docs.example\/assets\/worker.js/);
