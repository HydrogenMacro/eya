// Source-level proxy compatibility matrix; local Node broker is a test transport,
// not the Noise/server-egress transport and not a streaming performance benchmark.
// See docs/browser-proxy-compatibility.md for options, interpretation and bounds.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { buildSync } = require('esbuild');
const playwright = require('playwright');
const { fixture } = require('./browser-proxy-corpus-fixture.cjs');
const TIMEOUT = 5000, MAX_BODY = 8 * 1024 * 1024;
const expectedInteraction = {'documentation':'documentation ok','forms':'post ok','module-spa':'module ok:api ok','websocket':'socket ok','streaming':'first:second','assets':'assets ok','large-list':'list ok','media':'media ok','third-party-frame':'frame ok'};
const csv = (value, fallback) => (value || fallback).split(',').map(value => value.trim()).filter(Boolean);
const engines = csv(process.env.EYA_PROXY_MATRIX_ENGINES, 'chromium');
const formats = csv(process.env.EYA_PROXY_MATRIX_FORMATS, 'html,svg');
const coarse = process.env.EYA_PROXY_MATRIX_COARSE === '1';
const absentNavigation = process.env.EYA_PROXY_MATRIX_NAVIGATION === 'absent';
for (const value of engines) assert.ok(['chromium','firefox','webkit'].includes(value), 'Unknown matrix engine');
for (const value of formats) assert.ok(['html','svg'].includes(value), 'Unknown matrix shell');
const report = { schema: 1, generatedAt: new Date().toISOString(), methodology: 'Production source panel, bounded Node fixture broker; native engine reference. Excludes Noise, server egress, remote capture, WAN, login and physical-device behavior.', configuration: { engines, formats, coarse, absentNavigation, viewport: { width: 1000, height: 700 } }, rows: [], skipped: [] };
function cleanUrl(value) { const url = new URL(value); url.search = ''; url.hash = ''; url.username = ''; url.password = ''; return url.href; }
async function main() {
  report.node = process.version; report.sourceSha256 = {}; for(const file of ['client/browser-panel.js','tests/browser-proxy-compatibility.cjs','tests/browser-proxy-corpus-fixture.cjs']) report.sourceSha256[file] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const local = await fixture();
  const bundle = buildSync({ entryPoints: ['client/browser-panel.js'], bundle: true, platform: 'browser', format: 'iife', globalName: 'EyaBrowser', write: false }).outputFiles[0].text;
  let publicSites = [];
  if (process.env.EYA_PROXY_PUBLIC_SITES) {
    const entries = JSON.parse(process.env.EYA_PROXY_PUBLIC_SITES); assert.ok(Array.isArray(entries) && entries.length <= 12, 'Public matrix must contain at most 12 site objects');
    publicSites = entries.map((entry, index) => {
      assert.equal(typeof entry.url, 'string'); const url = new URL(entry.url); assert.equal(url.protocol, 'https:'); assert.ok(!url.username && !url.password && !url.search && !url.hash, 'Use credential-free HTTPS URLs without queries/fragments');
      const allowedOrigins = [url.origin, ...(entry.allowedOrigins || [])].map(value => { const target = new URL(value); assert.equal(target.protocol, 'https:'); assert.ok(!target.username&&!target.password); assert.equal(target.href, target.origin + '/'); return target.origin; });
      assert.ok(allowedOrigins.length <= 16); return { id: `public-${index + 1}`, url: url.href, allowedOrigins: [...new Set(allowedOrigins)], public: true };
    });
  }
  const selectedCases = csv(process.env.EYA_PROXY_MATRIX_CASES, local.cases.join(',')); for(const id of selectedCases) assert.ok(local.cases.includes(id), 'Unknown corpus case');
  const cases = [...selectedCases.map(id => ({ id, url: local.origin + '/' + id, allowedOrigins: [local.origin, local.thirdParty] })), ...publicSites];
  try {
    for (const engine of engines) {
      let browser;
      try { browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? { executablePath: process.env.EYA_BROWSER_EXECUTABLE } : {}) }); }
      catch (error) { report.skipped.push({ engine, reason: String(error.message).split('\n')[0] }); continue; }
      try {
        for (const mode of ['native', 'proxy']) for (const format of mode === 'native' ? ['html'] : formats) for (const item of cases) {
          const row = { engine, mode, format, case: item.id, public: !!item.public, url: item.public ? cleanUrl(item.url) : `fixture:/${item.id}`, status: null, statuses: [], firstContentMs: null, interaction: null, interactionMs: null, firstContentMethod: item.public?'readable-body polling':'fixture DOMContentLoaded + requestAnimationFrame message', responseBodyBytes: 0, uploadedBodyBytes: 0, consoleExceptions: [], unsupportedCalls: [], directClientRequests: [], streamedChunks: 0, errors: [] };
          report.rows.push(row);
          const context = await browser.newContext({ viewport: mode === 'proxy' ? {width:1100,height:900} : report.configuration.viewport, hasTouch: coarse, ...(engine !== 'firefox' ? { isMobile: coarse } : {}) });
          const page = await context.newPage(); let started = 0, enabled = false;
          row.browserVersion = browser.version(); const pending = new Map(), sockets = new Map(), nativeBodies = []; let nextId = 0;
          const record = (kind, value) => {
            if (!enabled) return;
            if (kind === 'content' && row.firstContentMs === null) row.firstContentMs = Date.now() - started;
            if (kind === 'interaction') { row.interaction = String(value).slice(0, 256); row.interactionMs = Date.now() - started; }
            if (kind === 'exception' && row.consoleExceptions.length < 32) row.consoleExceptions.push(String(value).slice(0, 500));
            if (kind === 'unsupported' && row.unsupportedCalls.length < 32) row.unsupportedCalls.push(String(value).slice(0, 500));
            if (kind === 'stream-chunk') row.streamedChunks = Math.max(row.streamedChunks, Number(value) || 0);
          };
          page.on('pageerror', error => record('exception', error.message));
          page.on('console', message => { if (message.type() === 'error') record('exception', message.text()); });
          await page.exposeBinding('__corpusReport', (_, kind, value) => record(kind, value));
          await page.addInitScript(() => addEventListener('message', event => { if (event.data?.corpus === true) window.__corpusReport(event.data.kind, event.data.value); }));
          if (absentNavigation && mode === 'proxy') await page.addInitScript(() => { try { Object.defineProperty(window, 'navigation', { value: undefined, configurable: true }); } catch {} });
          const allow = value => item.allowedOrigins.includes(new URL(value).origin);
          page.on('request', request => { if (enabled && mode === 'proxy' && /^https?:/.test(request.url()) && row.directClientRequests.length < 32) row.directClientRequests.push(cleanUrl(request.url())); });
          if (mode === 'proxy') await page.route('**/*', route => { const target = route.request().url(); if (target === local.origin+'/shell.html' || target === local.origin+'/shell.svg') return route.continue(); return /^https?:/.test(target) ? route.abort('blockedbyclient') : route.continue(); });
          // Native public runs are restricted to exactly the user-listed origins too.
          else if (item.public) await page.route('**/*', route => allow(route.request().url()) && ['GET','HEAD','OPTIONS'].includes(route.request().method()) ? route.continue() : route.abort('blockedbyclient'));
          page.on('request', request => { if(enabled && mode==='native') row.uploadedBodyBytes += request.postDataBuffer()?.length || 0; });
          page.on('websocket', socket => { if (!enabled) return; if(mode==='proxy') row.directClientRequests.push(cleanUrl(socket.url())); else {socket.on('framereceived', frame=>{row.responseBodyBytes+=Buffer.byteLength(frame.payload)});socket.on('framesent',frame=>{row.uploadedBodyBytes+=Buffer.byteLength(frame.payload)});} });
          try {
            if (mode === 'proxy') {
              await page.exposeBinding('__corpusRequest', async (_, url, options) => {
                if (!allow(url)) throw Error('Corpus broker: origin not in explicit fixture/public allowlist');
                if (item.public && !['GET','HEAD','OPTIONS'].includes(options.method)) {record('unsupported','Public matrix blocks mutation requests');throw Error('Public matrix is read-only');}
                if(nextId>=128 || pending.size>=16) throw Error('Corpus request budget exceeded');
                const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), TIMEOUT);
                const id = ++nextId, body = options.body?.length ? Buffer.from(options.body) : undefined;
                row.uploadedBodyBytes += body?.length || 0;
                try {
                  const response = await fetch(url, { method: options.method, headers: options.headers, body, signal: controller.signal, redirect: 'manual' });
                  row.statuses.push({ status: response.status, method: options.method || 'GET', url: item.public ? cleanUrl(url) : new URL(url).pathname }); if (row.status === null) row.status = response.status;
                  if (response.status >= 300 && response.status < 400) { const target = new URL(response.headers.get('location'), url); if (!allow(target.href)) throw Error('Corpus broker: redirect origin is not allowed'); throw Error('Corpus broker: redirect not implemented; recorded without automatic follow'); }
                  const reader = response.body?.getReader(); pending.set(id, { controller, deadline, reader, bytes: 0 });
                  return { id, status: response.status, url: response.url, headers: [...response.headers], cookies: [] };
                } catch (error) { clearTimeout(deadline); throw error; }
              });
              await page.exposeBinding('__corpusPull', async (_, id, cancel) => {
                const entry = pending.get(id); if (!entry) return { done: true };
                if (cancel) { entry.controller.abort(); clearTimeout(entry.deadline); pending.delete(id); return { done: true }; }
                try {
                  const part = entry.reader ? await entry.reader.read() : { done: true };
                  if (part.done) { clearTimeout(entry.deadline); pending.delete(id); return { done: true }; }
                  entry.bytes += part.value.length; row.responseBodyBytes += part.value.length;
                  if (entry.bytes > MAX_BODY) throw Error('Corpus broker: response exceeds 8 MiB');
                  return { done: false, value: Buffer.from(part.value).toString('base64') };
                } catch (error) { entry.controller.abort(); clearTimeout(entry.deadline); pending.delete(id); throw error; }
              });
              await page.exposeBinding('__corpusSocketOpen', async (_, url, protocols, id) => {
                if(item.public){record('unsupported','Public matrix blocks page WebSockets');throw Error('Public matrix is read-only');} const target = new URL(url); target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:'; if (!allow(target.href)) throw Error('Corpus socket origin not allowed');
                const socket = new WebSocket(url, protocols); sockets.set(id, socket);
                const emit = value => page.evaluate(({ id, value }) => window.__corpusSocketEvent?.(id, value), { id, value }).catch(() => {});
                socket.addEventListener('message', async event => { const binary = typeof event.data !== 'string'; const data = binary ? new Uint8Array(await event.data.arrayBuffer()) : new TextEncoder().encode(event.data); row.responseBodyBytes += data.length; emit({ type: 'message', kind: binary ? 2 : 1, body: [...data] }); });
                socket.addEventListener('close', event => emit({ type: 'close', code: event.code, reason: event.reason, wasClean: event.wasClean }));
                await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once:true }); socket.addEventListener('error', reject, { once:true }); setTimeout(() => { if (socket.readyState === WebSocket.CONNECTING) { socket.close(); reject(Error('Corpus socket timeout')); } }, TIMEOUT).unref(); });
                row.statuses.push({ status: 101, method: 'WEBSOCKET' }); return { protocol: socket.protocol };
              });
              await page.exposeBinding('__corpusSocketSend', (_, id, bytes, kind) => { row.uploadedBodyBytes += bytes.length; sockets.get(id)?.send(kind === 2 ? new Uint8Array(bytes) : new TextDecoder().decode(new Uint8Array(bytes))); });
              await page.exposeBinding('__corpusSocketClose', (_, id, code, reason) => sockets.get(id)?.close(code, reason));
              await page.goto(`${local.origin}/shell.${format}`); await page.waitForFunction(() => !!document.body && !!document.head);
              await page.evaluate(code => { (0, eval)(code); }, bundle);
              row.readerMode = await page.evaluate(() => !EyaBrowser.proxyNavigationAvailable());
              await page.evaluate(() => {
                const handlers = new Map(); let socketId = 0;
                window.__corpusSocketEvent = (id, value) => { const handler = handlers.get(id); if (value.type === 'message') handler?.onMessage({ data: new Uint8Array(value.body), kind: value.kind }); else handler?.onClose(value); };
                window.panel = EyaBrowser.createBrowserPanel({ serverRenderedByDefault: false, request: async (url, options = {}) => {
                  const response = await __corpusRequest(String(url), { method: options.method || 'GET', headers: options.headers || {}, body: options.body ? [...options.body] : null });
                  const abort = () => { __corpusPull(response.id, true).catch(() => {}); }; options.signal?.addEventListener('abort', abort, { once: true });
                  const stream = new ReadableStream({ async pull(controller) { try { const part = await __corpusPull(response.id, false); if (part.done) { options.signal?.removeEventListener('abort', abort); controller.close(); } else controller.enqueue(Uint8Array.from(atob(part.value), char => char.charCodeAt(0))); } catch (error) { controller.error(error); } }, cancel: abort });
                  return { ...response, body: options.stream ? stream : new Uint8Array(await new Response(stream).arrayBuffer()) };
                }, openWebSocket: async (url, options) => { const id = ++socketId; handlers.set(id, options); const ready = await __corpusSocketOpen(url, options.protocols, id); return { ...ready, send: (bytes, kind) => __corpusSocketSend(id, [...bytes], kind), close: (code, reason) => __corpusSocketClose(id, code, reason) }; } });
                document.body.style.margin = '0'; document.body.append(panel.element); panel.element.style.cssText = 'width:1000px;height:700px'; const frame=panel.element.querySelector('.eya-browser-frame'); panel.element.style.width=(1000+1000-frame.clientWidth)+'px'; panel.element.style.height=(700+700-frame.clientHeight)+'px';
              });
              enabled = true; started = Date.now(); await page.evaluate(url => panel.api.navigate(url), item.url);
            } else {
              page.on('response', response => { if (!enabled) return; row.statuses.push({ status: response.status(), method: response.request().method() }); if (row.status === null) row.status = response.status(); nativeBodies.push(response.body().then(bytes => { row.responseBodyBytes += bytes.length; }).catch(() => {})); });
              enabled = true; started = Date.now(); await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
            }
            if (item.public && !row.readerMode) {
              // Passive, unauthenticated GET only: no site-specific clicks or forms.
              if(mode==='proxy') await page.waitForFunction(()=>!!panel.api.restorableUrl,null,{timeout:TIMEOUT});
              const target = mode === 'proxy' ? (page.frames().find(frame => frame.parentFrame() === page.mainFrame()) || await page.waitForEvent('frameattached', { timeout: TIMEOUT })) : page;
              if(row.status>=400)row.errors.push('Top-level public response was not successful');
              try { await target.locator('body').filter({ hasText: /\S/ }).waitFor({ timeout: TIMEOUT }); row.firstContentMs = Date.now() - started; row.interaction = 'passive content only'; }
              catch { row.errors.push('No readable content observed'); }
            } else if (row.readerMode) {
              await page.waitForFunction(() => !!panel.api.restorableUrl, null, { timeout: TIMEOUT });
              const target = page.frames().find(frame => frame.parentFrame() === page.mainFrame());
              await target.locator('body').filter({ hasText: /\S/ }).waitFor({ timeout: TIMEOUT });
              assert.match(await page.locator('.eya-browser-status').innerText(), /Reader mode/);
              row.firstContentMs = Date.now() - started;
              row.interaction = 'reader content only';
            } else {
              const target = mode === 'proxy' ? (page.frames().find(frame => frame.parentFrame() === page.mainFrame()) || await page.waitForEvent('frameattached', { timeout: TIMEOUT })) : page;
              await target.locator('#action').waitFor({ timeout: TIMEOUT });
              if (item.id === 'module-spa') await page.waitForTimeout(100);
              if (item.id === 'third-party-frame') await page.waitForTimeout(150);
              if (item.id === 'assets') { await target.locator('#asset-label').evaluate(el => new Promise((resolve, reject) => { const start=Date.now(), timer=setInterval(()=>{if(getComputedStyle(el).color==='rgb(12, 34, 56)'&&document.fonts.size){clearInterval(timer);resolve()}else if(Date.now()-start>4500){clearInterval(timer);reject(Error('Styles/font definition unavailable'))}},10)})); const fonts=await target.locator('#asset-label').evaluate(async()=>{const loaded=await document.fonts.load('16px Corpus');await document.fonts.ready;return loaded.map(font=>font.status)}); assert.ok(fonts.includes('loaded'),'Fixture font must actually decode'); }
              await target.locator('#action').click({ timeout: TIMEOUT, force: item.id === 'assets' });
                            const until = Date.now() + TIMEOUT;
              while (!row.interaction && !row.unsupportedCalls.length && Date.now() < until) await page.waitForTimeout(25);
              if (!row.interaction && !row.unsupportedCalls.length) row.errors.push('Interaction did not complete within 5 seconds');
              if(row.interaction && row.interaction!==expectedInteraction[item.id]) row.errors.push('Unexpected fixture interaction result');
            }
            const frame = mode === 'proxy' ? page.frames().find(frame => frame.parentFrame() === page.mainFrame()) : page.mainFrame();
            row.logicalViewport = await frame.evaluate(() => ({ width: innerWidth, height: innerHeight, coarse: matchMedia('(pointer: coarse)').matches }));
            if (mode === 'proxy') {
              assert.equal(await page.locator('.eya-browser-frame').getAttribute('sandbox'), 'allow-scripts', 'Matrix must preserve opaque-origin sandbox');
              row.panelStatus = (await page.locator('.eya-browser-status').textContent()).slice(0, 500);
            }
          } catch (error) { row.errors.push(String(error.message).split('\n')[0].slice(0, 500)); }
          finally {
            await Promise.race([Promise.allSettled(nativeBodies),new Promise(resolve=>setTimeout(resolve,250))]); enabled = false; for (const entry of pending.values()) { clearTimeout(entry.deadline); entry.controller.abort(); } for (const socket of sockets.values()) socket.close();
            if (mode === 'proxy') await page.evaluate(() => window.panel?.onClose()).catch(() => {});
            await context.close();
          }
          row.outcome = row.errors.length ? 'failed' : (item.public || row.interaction === 'reader content only') && row.interaction ? 'content-only' : row.interaction ? 'usable' : row.unsupportedCalls.length ? 'unsupported' : 'failed';
          console.log(`${engine}/${mode}/${format}/${item.id}: ${row.outcome}, ${row.responseBodyBytes}B, content ${row.firstContentMs ?? '-'}ms`);
        }
      } finally { await browser.close(); }
    }
  } finally { await local.close(); }
  if (!publicSites.length) report.skipped.push({ scope: 'public sites', reason: 'Opt-in EYA_PROXY_PUBLIC_SITES was not supplied; no public requests made.' });
  // A deterministic regression subset. Other failures stay visible in the report.
  const essential = ['documentation', 'forms', 'module-spa', 'websocket', 'streaming', 'assets', 'large-list'];
  const regressions = report.rows.filter(row => !row.public && essential.includes(row.case) && row.engine === 'chromium'
    && row.outcome !== (row.readerMode ? 'content-only' : 'usable'));
  const escapes = report.rows.filter(row => row.mode === 'proxy' && row.directClientRequests.length);
  report.summary = { total: report.rows.length, usable: report.rows.filter(row => row.outcome === 'usable').length, contentOnly: report.rows.filter(row => row.outcome === 'content-only').length, unsupported: report.rows.filter(row => row.outcome === 'unsupported').length, failed: report.rows.filter(row => row.outcome === 'failed').length, essentialRegressions: regressions.map(row => `${row.mode}/${row.format}/${row.case}`), directRequestRows: escapes.length };
  const destination = process.env.EYA_PROXY_MATRIX_REPORT || '/tmp/eya-proxy-compatibility.json'; await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n'); console.log(`Report: ${destination}`);
  assert.ok(report.rows.length, 'No browser engine could run');
  assert.deepEqual(report.summary.essentialRegressions, [], 'Essential Chromium fixture regressions');
  assert.equal(escapes.filter(row=>!row.public).length, 0, 'Covered corpus produced unexpected direct client HTTP requests; inspect report');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
