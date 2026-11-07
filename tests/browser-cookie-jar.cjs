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

const { applyCookie, applySetCookies, cookieString } = loaded.exports;
const cookies = [];
const now = Date.UTC(2026, 10, 6);

assert.equal(applyCookie(cookies, 'sid=abc123; Path=/; HttpOnly; Secure; SameSite=Lax', 'https://shop.example.com/login', { fromServer: true, now }), true);
assert.equal(applyCookie(cookies, 'sid=script-overwrite', 'https://shop.example.com/login', { now }), false, 'page scripts cannot overwrite HttpOnly cookies');
assert.equal(applyCookie(cookies, 'sid=; Path=/; Max-Age=0', 'https://shop.example.com/login', { now }), false, 'page scripts cannot delete HttpOnly cookies');
assert.equal(cookieString(cookies, 'https://shop.example.com/account', { now }), 'sid=abc123', 'network requests include HttpOnly cookies');
assert.equal(cookieString(cookies, 'https://shop.example.com/account', { includeHttpOnly: false, now }), '', 'page JavaScript cannot read HttpOnly cookies');
assert.equal(cookieString(cookies, 'http://shop.example.com/account', { now }), '', 'Secure cookies are withheld over HTTP');

assert.equal(applyCookie(cookies, 'theme=dark; Path=/docs', 'https://shop.example.com/docs/start', { now }), true);
assert.equal(cookieString(cookies, 'https://shop.example.com/docs/api', { includeHttpOnly: false, now }), 'theme=dark', 'path-scoped cookies match descendants');
assert.equal(cookieString(cookies, 'https://shop.example.com/docset', { includeHttpOnly: false, now }), '', 'path matching observes segment boundaries');

assert.equal(applyCookie(cookies, 'shared=yes; Domain=.example.com; Path=/', 'https://shop.example.com/', { now }), true);
assert.equal(cookieString(cookies, 'https://cdn.example.com/asset', { includeHttpOnly: false, now }), '', 'Domain cookies stay host-only without a complete public suffix list');
assert.equal(applyCookie(cookies, 'bad=x; Domain=other.example; Path=/', 'https://shop.example.com/', { now }), false, 'cookies cannot be set for unrelated domains');
assert.equal(applyCookie(cookies, 'suffix=x; Domain=co.uk', 'https://foo.co.uk/', { now }), true, 'public-suffix Domain attributes degrade to host-only cookies');
assert.equal(cookieString(cookies, 'https://bar.co.uk/', { includeHttpOnly: false, now }), '', 'public-suffix cookies cannot cross registrable tenant hosts');
assert.equal(applyCookie(cookies, 'hosted=x; Domain=github.io', 'https://user.github.io/', { now }), true, 'private hosting suffix Domain attributes degrade to host-only cookies');
assert.equal(cookieString(cookies, 'https://evil.github.io/', { includeHttpOnly: false, now }), '', 'private hosting tenant cookies remain isolated');
assert.equal(applyCookie(cookies, 'render=x; Domain=onrender.com', 'https://tenant.onrender.com/', { now }), true, 'hosted tenant Domain attributes degrade to host-only cookies');
assert.equal(cookieString(cookies, 'https://other.onrender.com/', { includeHttpOnly: false, now }), '', 'hosted tenant cookies remain isolated');
assert.equal(applyCookie(cookies, 'insecure=x; SameSite=None', 'https://shop.example.com/', { now }), false, 'SameSite=None requires Secure');
assert.equal(applyCookie(cookies, '__Host-session=x; Secure; Path=/; Domain=example.com', 'https://shop.example.com/', { now }), false, '__Host cookies reject Domain attributes');
assert.equal(applyCookie(cookies, 'strict=only-here; SameSite=Strict', 'https://shop.example.com/', { now }), true);
assert.equal(applyCookie(cookies, 'lax=top-level-only; SameSite=Lax', 'https://shop.example.com/', { now }), true);
assert.equal(cookieString(cookies, 'https://shop.example.com/api', { pageUrl: 'https://shop.example.com/', now }).includes('strict=only-here'), true, 'same-host requests include Strict cookies');
assert.equal(cookieString(cookies, 'https://shop.example.com/api', { pageUrl: 'https://other.test/', now }).includes('strict=only-here'), false, 'cross-site requests omit Strict cookies');
assert.equal(cookieString(cookies, 'https://shop.example.com/api', { pageUrl: 'https://other.test/', now }).includes('lax=top-level-only'), false, 'cross-site subresources omit Lax cookies');
assert.equal(cookieString(cookies, 'https://shop.example.com/api', { pageUrl: 'https://other.test/', topLevel: true, method: 'GET', now }).includes('lax=top-level-only'), true, 'cross-site top-level safe navigations include Lax cookies');
assert.equal(cookieString(cookies, 'https://shop.example.com/api', { pageUrl: 'https://other.test/', topLevel: true, method: 'POST', now }).includes('lax=top-level-only'), false, 'cross-site POST navigations omit Lax cookies');
assert.equal(applyCookie(cookies, 'domain-strict=same-site; Domain=example.com; SameSite=Strict', 'https://shop.example.com/', { now }), true);
assert.equal(cookieString(cookies, 'https://cdn.example.com/api', { pageUrl: 'https://shop.example.com/', now }).includes('domain-strict=same-site'), false, 'same-site checks use exact hosts without a complete public suffix list');
assert.equal(cookieString(cookies, 'http://cdn.example.com/api', { pageUrl: 'https://shop.example.com/', now }).includes('domain-strict=same-site'), false, 'SameSite checks include the URL scheme');

assert.equal(applyCookie(cookies, 'theme=light; Path=/docs; Max-Age=0', 'https://shop.example.com/docs/start', { now }), true);
assert.equal(cookieString(cookies, 'https://shop.example.com/docs/api', { includeHttpOnly: false, now }), 'shared=yes; strict=only-here; lax=top-level-only; domain-strict=same-site', 'Max-Age=0 deletes only the matching cookie');
assert.equal(applyCookie(cookies, 'old=x; Expires=Wed, 01 Jan 2020 00:00:00 GMT', 'https://shop.example.com/', { now }), true);
assert.equal(cookieString(cookies, 'https://shop.example.com/', { includeHttpOnly: false, now }), 'shared=yes; strict=only-here; lax=top-level-only; domain-strict=same-site', 'expired cookies are not returned');

applySetCookies(cookies, ['server=one; Path=/; HttpOnly', 'client=two; Path=/'], 'https://shop.example.com/', now);
assert.equal(cookieString(cookies, 'https://shop.example.com/', { includeHttpOnly: false, now }), 'shared=yes; strict=only-here; lax=top-level-only; domain-strict=same-site; client=two', 'Set-Cookie arrays are applied without exposing HttpOnly values');
const redirectCookies = [];
applySetCookies(redirectCookies, [{ url: 'https://login.example.com/auth/start', values: ['flow=step1; Path=/auth; HttpOnly'] }], 'https://login.example.com/final', now);
assert.equal(cookieString(redirectCookies, 'https://login.example.com/auth/continue', { now }), 'flow=step1', 'redirect cookie events retain the URL scope that set them');
assert.equal(cookieString(redirectCookies, 'https://login.example.com/home', { now }), '', 'redirect cookie paths remain scoped');

console.log('Browser cookie-jar rules passed.');
