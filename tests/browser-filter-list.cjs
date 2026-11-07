const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');

const source = path.resolve(__dirname, '../client/browser-panel.js');
const bundle = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false });
const loaded = new Module(source, module);
loaded.filename = source;
loaded.paths = Module._nodeModulePaths(path.dirname(source));
loaded._compile(bundle.outputFiles[0].text, source);

const { compileFilterList, matchFilterList, shouldBlockByFilterList, cosmeticCssForPage, serializeCosmeticStyleScript, remoteNetworkFilterSnapshot, proxyNavigationAvailable } = loaded.exports;
assert.equal(proxyNavigationAvailable({ navigation: { addEventListener() {} } }), true);
assert.equal(proxyNavigationAvailable({}), false, 'Proxy mode must fail closed on engines without cancellable navigation events');
const filters = compileFilterList([
  '! basic EasyList-style test rules',
  '||ads.example^',
  '@@||ads.example/allowed^',
  '||tracking.example^$third-party,script',
  '||cdn.example/pixel^$image,domain=docs.example|~private.docs.example',
  '||wild.example/ads/*$script',
  '@@||wild.example/ads/safe.js^$script',
  '||important.example^$important',
  '@@||important.example^',
  '||socketbad.example^$websocket',
  '||unsupported.example^$redirect=stub',
  '0.0.0.0 hosts.bad',
  '::1 ipv6-hosts.bad',
].join('\n'));

assert.equal(filters.count, 11);
assert.equal(shouldBlockByFilterList(filters, 'https://ads.example/banner', 'https://docs.example/', 'image'), true);
assert.equal(shouldBlockByFilterList(filters, 'https://sub.ads.example/banner', 'https://docs.example/', 'image'), true);
assert.equal(matchFilterList(filters, 'https://ads.example/allowed', 'https://docs.example/', 'image'), false, 'exceptions allow matching URLs');
assert.equal(shouldBlockByFilterList(filters, 'https://tracking.example/pixel', 'https://docs.example/', 'script'), true);
assert.equal(shouldBlockByFilterList(filters, 'https://tracking.example/pixel', 'https://docs.example/', 'image'), false, 'resource type options are honored');
assert.equal(shouldBlockByFilterList(filters, 'https://tracking.example/pixel', 'https://sub.tracking.example/', 'script'), false, 'third-party options are honored');
assert.equal(shouldBlockByFilterList(filters, 'https://cdn.example/pixel?format=png', 'https://docs.example/', 'image'), true);
assert.equal(shouldBlockByFilterList(filters, 'https://cdn.example/pixel?format=png', 'https://private.docs.example/', 'image'), false, 'domain exclusions are honored');
assert.equal(shouldBlockByFilterList(filters, 'https://wild.example/ads/banner.js', 'https://docs.example/', 'script'), true, 'wildcards are supported');
assert.equal(matchFilterList(filters, 'https://wild.example/ads/safe.js', 'https://docs.example/', 'script'), false, 'typed exceptions are supported');
assert.equal(shouldBlockByFilterList(filters, 'https://important.example/banner', 'https://docs.example/', 'image'), true, 'important blocks override exceptions');
assert.equal(shouldBlockByFilterList(filters, 'https://hosts.bad/ad', 'https://docs.example/', 'other'), true);
assert.equal(shouldBlockByFilterList(filters, 'https://ipv6-hosts.bad/ad', 'https://docs.example/', 'other'), true);
assert.equal(shouldBlockByFilterList(filters, 'https://unsupported.example/ad', 'https://docs.example/', 'script'), false, 'unsupported transformation options are skipped');
assert.equal(shouldBlockByFilterList(filters, 'wss://socketbad.example/live', 'https://docs.example/', 'websocket'), true, 'WebSocket resource rules are honored');
const remoteFilters = remoteNetworkFilterSnapshot(filters);
assert.equal(remoteFilters.version, 1);
assert.equal(remoteFilters.hosts.includes('hosts.bad'), true);
assert.equal(remoteFilters.rules.some(rule => rule.host === 'tracking.example' && rule.types.includes('script') && rule.thirdParty === true), true);
assert.equal(remoteFilters.rules.some(rule => rule.host === 'important.example' && rule.important && !rule.allow), true);
assert.equal(remoteFilters.rules.every(rule => Array.isArray(rule.domains) && Array.isArray(rule.excludedDomains)), true);
assert.equal(shouldBlockByFilterList(filters, 'https://ads.example/', 'invalid-page-url', 'image'), false, 'invalid URLs do not match');
assert.throws(() => compileFilterList('x'.repeat(1024 * 1024 + 1)), /1 MiB/);
const broadList = Array.from({ length: 600 }, (_, index) => `service.example/rule${index}`).join('\n');
assert.equal(compileFilterList(broadList).count, 512, 'generic patterns are capped to bound per-request matching work');
const cosmetics = compileFilterList([
  '##.global-ad',
  'example.com##.ad',
  'a.example.com,~mobile.a.example.com##.sponsor',
  'example.com#@#.ad',
  'other.example##.ad',
  'example.com#?#.procedural',
  'bad..example##.invalid-domain',
  'example.com##.bad{display:block}',
  `example.com##.${'x'.repeat(512)}`,
  'example.com##',
].join('\n'));
assert.equal(cosmetics.cosmeticHide.length, 4, 'ordinary cosmetic rules are retained while unsupported or malformed rules are skipped');
assert.equal(cosmetics.cosmeticAllow.length, 1);
const exampleCss = cosmeticCssForPage(cosmetics, 'https://docs.a.example.com/');
assert.match(exampleCss, /\.global-ad\{display:none!important\}/, 'generic cosmetic rules apply to all pages');
assert.doesNotMatch(exampleCss, /\.ad\{/, 'a scoped exception suppresses the same selector on matching domains');
assert.match(exampleCss, /\.sponsor\{/, 'included subdomains match cosmetic rules');
assert.doesNotMatch(cosmeticCssForPage(cosmetics, 'https://mobile.a.example.com/'), /\.sponsor\{/,
  'a matching excluded subdomain suppresses the rule');
assert.match(cosmeticCssForPage(cosmetics, 'https://other.example/'), /\.ad\{/, 'exceptions apply only to their matching domains');
assert.doesNotMatch(cosmeticCssForPage(cosmetics, 'https://notexample.com/'), /\.ad\{/,
  'domain matching respects hostname label boundaries');
const cosmeticCap = compileFilterList(Array.from({ length: 2100 }, (_, index) => `##.hide${index}`).join('\n'));
assert.equal(cosmeticCap.cosmeticHide.length, 2000, 'cosmetic records have an explicit global cap');
const styleScript = serializeCosmeticStyleScript('.ad{display:none!important}');
assert.match(styleScript, /textContent=/, 'cosmetic CSS is assigned as text inside the frame');
assert.doesNotMatch(serializeCosmeticStyleScript('</script><script>alert(1)</script>'), /<\/script><script>alert/,
  'inline style payload cannot escape its script element');
console.log('Browser filter-list rules passed.');
