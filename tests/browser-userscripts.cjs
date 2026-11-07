const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');

const source = path.resolve(__dirname, '../client/browser-panel.js');
const bundle = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = new Module(source, module); loaded.filename = source; loaded.paths = Module._nodeModulePaths(path.dirname(source));
loaded._compile(bundle.outputFiles[0].text, source);
const { parseUserScript, userScriptMatches, userScriptConnectMatches, filterUserscriptResponseHeaders, serializeUserscriptElements, serializeUserscriptSources, sanitizeUserscriptStorage, updateUserscriptStorage } = loaded.exports;

const scriptSource = `// ==UserScript==
// @name Example helper
// @match https://*.example.test/docs/*
// @include https://portal.example.test/*
// @exclude https://private.example.test/*
// @grant none
// @run-at document-start
// ==/UserScript==
document.documentElement.dataset.helper = 'enabled';
`;
const script = parseUserScript(scriptSource);
assert.equal(script.name, 'Example helper');
assert.equal(userScriptMatches(script, 'https://example.test/docs/index.html'), true, 'wildcard host pattern must include its base host');
assert.equal(userScriptMatches(script, 'https://api.example.test/docs/type/Struct.html?mode=full'), true, 'wildcard subdomain and path patterns must match');
assert.equal(userScriptMatches(script, 'https://private.example.test/docs/index.html'), false, 'exclude patterns must take precedence');
assert.equal(userScriptMatches(script, 'http://example.test/docs/index.html'), false, 'scheme-specific matches must be enforced');
assert.equal(userScriptMatches(script, 'https://example.test/blog/index.html'), false, 'path patterns must be enforced');
assert.equal(userScriptMatches(script, 'file:///tmp/index.html'), false, 'userscripts must only run on proxied web pages');
assert.equal(userScriptMatches(script, 'https://portal.example.test/anything'), true, '@include glob patterns must be supported');
assert.equal(script.runAt, 'document-start', 'userscripts default to document-start');

assert.throws(() => parseUserScript('// ==UserScript==\n// @name Missing match\n// ==/UserScript=='), /@match or @include/);
assert.throws(() => parseUserScript(scriptSource.replace('// @grant none', '// @grant GM_xmlhttpRequest')), /requires at least one explicit @connect/);
const requestScript = parseUserScript(scriptSource.replace('// @grant none', '// @grant GM_xmlhttpRequest\n// @connect api.example.test\n// @connect *.assets.example.test'));
assert.deepEqual(requestScript.connects, ['api.example.test', '*.assets.example.test']);
assert.equal(userScriptConnectMatches(requestScript, 'https://api.example.test/data', 'https://site.example/'), true, 'an exact @connect host is allowed');
assert.equal(userScriptConnectMatches(requestScript, 'https://img.assets.example.test/data', 'https://site.example/'), true, 'a wildcard @connect allows subdomains');
assert.equal(userScriptConnectMatches(requestScript, 'https://assets.example.test/data', 'https://site.example/'), true, 'a wildcard @connect includes the base host');
assert.equal(userScriptConnectMatches(requestScript, 'https://other.example.test/data', 'https://site.example/'), false, 'unlisted hosts are denied');
assert.equal(userScriptConnectMatches(requestScript, 'file:///etc/passwd', 'https://site.example/'), false, 'non-web destinations are denied');
assert.throws(() => parseUserScript(scriptSource.replace('// @grant none', '// @grant GM_xmlhttpRequest\n// @connect https://api.example.test/path')), /Unsupported userscript @connect/);
assert.deepEqual(filterUserscriptResponseHeaders([['content-type', 'text/plain'], ['set-cookie', 'secret=1'], ['proxy-authenticate', 'secret'], ['x-demo', 'ok']]), [['content-type', 'text/plain'], ['x-demo', 'ok']], 'sensitive response headers are hidden');
const granted = parseUserScript(scriptSource.replace('// @grant none', '// @grant GM_getValue\n// @grant GM_setValue\n// @grant GM_deleteValue\n// @grant GM_listValues\n// @grant GM_addStyle\n// @grant GM_log'));
assert.deepEqual(granted.grants, ['GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues', 'GM_addStyle', 'GM_log']);
const documentEnd = parseUserScript(scriptSource.replace('// @run-at document-start', '// @run-at document-end'));
assert.equal(documentEnd.runAt, 'document-end', 'document-end timing is preserved from metadata');
const documentEndMarkup = serializeUserscriptElements([{ runAt: documentEnd.runAt, source: 'window.endRan = document.readyState;' }]);
assert.match(documentEndMarkup, /addEventListener\('DOMContentLoaded'/, 'document-end scripts wait until parsing completes');
assert.match(documentEndMarkup, /document\.currentScript\?\.remove\(\)/, 'deferred script elements are removed immediately after scheduling');
const documentIdle = parseUserScript(scriptSource.replace('// @run-at document-start', '// @run-at document-idle'));
assert.equal(documentIdle.runAt, 'document-idle', 'document-idle timing is preserved from metadata');
const documentIdleMarkup = serializeUserscriptElements([{ runAt: documentIdle.runAt, source: 'window.idleRan = true;' }]);
assert.match(documentIdleMarkup, /addEventListener\('load'/, 'document-idle scripts wait for the page load event');
assert.match(documentIdleMarkup, /window\.requestIdleCallback\(__eyaIdle,\{timeout:2000\}\)/, 'document-idle scripts use an idle callback with a bounded timeout');
assert.match(documentIdleMarkup, /setTimeout\(__eyaIdle,1\)/, 'document-idle scripts have a timer fallback');
assert.throws(() => parseUserScript(scriptSource.replace('// @run-at document-start', '// @run-at document-commit')), /document-start, document-end, and document-idle/);
assert.throws(() => parseUserScript(scriptSource.replace('// @match https://*.example.test/docs/*', '// @match ftp://example.test/*')), /pattern/);
assert.throws(() => parseUserScript(scriptSource.replace('// @grant none', '// @grant none\n// @require https://cdn.example.test/lib.js')), /@require/);
const resourceSource = scriptSource.replace('// @grant none', '// @grant GM_getResourceText\n// @grant GM_getResourceURL\n// @resource dictionary https://static.example.test/data.json');
const resourceScript = parseUserScript(resourceSource);
assert.deepEqual(resourceScript.resources, [{ name: 'dictionary', url: 'https://static.example.test/data.json' }]);
assert.throws(() => parseUserScript(scriptSource.replace('// @grant none', '// @grant GM_getResourceText')), /require at least one @resource/);
assert.throws(() => parseUserScript(resourceSource.replace('https://static.example.test/data.json', 'file:///etc/passwd')), /absolute HTTP\(S\)/);
assert.throws(() => parseUserScript(resourceSource.replace('// @resource dictionary https://static.example.test/data.json', '// @resource dictionary https://static.example.test/data.json\n// @resource dictionary https://static.example.test/other.json')), /unique/);

const markup = serializeUserscriptElements([{ source: `window.result = "</ScRiPt><script>escaped";` }]);
assert.ok(markup.includes('<\\/script>'), 'closing script tags must be escaped before embedding user code');
assert.equal((markup.match(/<\/script>/gi) || []).length, 1, 'user code must remain inside a single injected script element');
assert.match(serializeUserscriptSources([{ source: `window.remoteResult = "</ScRiPt>";` }])[0], /<\\\/script>/i, 'CDP script source must retain safe escaped terminators');
const grantedMarkup = serializeUserscriptElements([{ id: 'script-1', grants: granted.grants, source: 'window.stored = GM_getValue("answer", 0); GM_setValue("answer", 42);' }], { 'script-1': { answer: 21 } });
assert.match(grantedMarkup, /const GM_getValue=/, 'only explicitly granted APIs are installed');
assert.match(grantedMarkup, /const GM_setValue=/);
assert.match(grantedMarkup, /"answer":21/, 'the matching script receives its own initial values');
assert.match(grantedMarkup, /const __eyaStorage=__eyaStorageBridge/, 'the grant wrapper captures the bounded storage bridge before deferred execution');
const xmlRequestMarkup = serializeUserscriptElements([{ id: 'script-xml', grants: ['GM_xmlhttpRequest'], runAt: 'document-end', source: 'GM_xmlhttpRequest({url:"https://api.example.test/data"})' }]);
assert.match(xmlRequestMarkup, /const __eyaRequestBridge=window\.__eyaUserscriptRequest/, 'deferred scripts capture the temporary request bridge before page scripts execute');
assert.match(xmlRequestMarkup, /const __eyaRequest=__eyaRequestBridge/, 'GM_xmlhttpRequest uses the captured private bridge');
assert.match(xmlRequestMarkup, /document\.currentScript\?\.remove\(\)/, 'the imported script element is removed before the site can inspect it');
const xmlRequestWrapper = xmlRequestMarkup.match(/<script data-eya-userscript="">([\s\S]*?)<\/script>/)?.[1];
assert.ok(xmlRequestWrapper, 'document-end grant wrapper is emitted');
assert.doesNotThrow(() => new Function(xmlRequestWrapper), 'document-end grant wrapper must parse');
const resourceMarkup = serializeUserscriptElements([{ id: 'script-resource', grants: ['GM_getResourceText', 'GM_getResourceURL'], resources: { dictionary: { text: '{"ok":true}', url: 'data:application/json;base64,eyJvayI6dHJ1ZX0=' } }, source: 'window.resource = GM_getResourceText("dictionary");' }]);
assert.match(resourceMarkup, /const GM_getResourceText=/, 'the text accessor is installed only for an explicit grant');
assert.match(resourceMarkup, /const GM_getResourceURL=/, 'the URL accessor is installed only for an explicit grant');
assert.match(resourceMarkup, /data:application\/json;base64,eyJvayI6dHJ1ZX0=/, 'resource URLs are passed to the userscript as local data URLs');
const resourceWrapper = resourceMarkup.match(/<script data-eya-userscript="">([\s\S]*?)<\/script>/)?.[1];
assert.ok(resourceWrapper, 'resource grant wrapper is emitted');
assert.doesNotThrow(() => new Function(resourceWrapper), 'resource grant wrapper must parse');
const wrappedSource = grantedMarkup.match(/<script data-eya-userscript="">([\s\S]*?)<\/script>/)?.[1];
assert.ok(wrappedSource, 'granted userscript wrapper is emitted');
assert.doesNotThrow(() => new Function(wrappedSource), 'granted userscript wrapper must parse');
assert.doesNotMatch(serializeUserscriptElements([{ id: 'script-2', grants: ['GM_addStyle'], source: 'GM_setValue("secret", 1)' }]), /const GM_setValue=/,
  'ungranted APIs are not provided');
const rawStorage = JSON.parse('{"__proto__":{"polluted":true},"bad":null}');
rawStorage['script-1'] = { answer: 42, large: 'x'.repeat(70 * 1024) };
const storage = sanitizeUserscriptStorage(rawStorage);
assert.equal(storage['script-1'].answer, 42);
assert.equal(Object.hasOwn(storage['script-1'], 'large'), false, 'oversized values are dropped');
assert.equal(Object.getPrototypeOf(storage), null, 'sanitized storage uses a null prototype');
assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false, 'storage snapshots cannot pollute object prototypes');
const updatedStorage = updateUserscriptStorage(storage, { scriptId: 'script-1', action: 'set', key: 'next', value: { count: 2 } }, ['GM_setValue']);
assert.deepEqual(updatedStorage['script-1'].next, { count: 2 });
assert.equal(updateUserscriptStorage(storage, { scriptId: 'script-1', action: 'set', key: 'nope', value: true }, ['GM_getValue']), null,
  'the frame cannot write without the script-specific set grant');
assert.equal(updateUserscriptStorage(storage, { scriptId: 'script-1', action: 'set', key: 'huge', value: 'x'.repeat(70 * 1024) }, ['GM_setValue']), null,
  'oversized writes are rejected');
console.log('Browser userscript metadata, grants, storage bounds, matching, and script-element escaping passed.');
