import { gzipSync } from 'fflate';

const el = id => document.getElementById(id);
const encoder = new TextEncoder();
const marker = '<script id="eya-config" type="application/json">{}</' + 'script>';
const xhtml = 'http://www.w3.org/1999/xhtml', svgNs = 'http://www.w3.org/2000/svg';
function endpoint(value) {
  const url = new URL(value.includes('://') ? value : 'https://' + value);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Enter an HTTP(S) or WS(S) URL without credentials, query, or fragment.');
  url.protocol = ({ 'http:': 'ws:', 'https:': 'wss:' })[url.protocol] || url.protocol;
  const path = url.pathname.replace(/\/+$/, ''); url.pathname = path.endsWith('/ws') ? path : path + '/ws';
  return url.href;
}
async function fontData(file) {
  if (!file) return '';
  if (file.size > 4 * 1024 * 1024) throw Error('Font must be 4 MiB or smaller.');
  if (!/\.(woff2?|ttf|otf)$/i.test(file.name)) throw Error('Choose a WOFF2, WOFF, TTF or OTF font.');
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(Error('Could not read the font.')); reader.readAsDataURL(file); });
}
function bytesBase64(bytes) { let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(binary); }
function appendProgram(output, root, program) {
  const script = output.createElementNS(svgNs, 'script');
  // A single SVG2 href executes consistently for large standalone programs.
  // Mirroring the same base64 into xlink:href used to double every program.
  script.setAttribute('href', 'data:application/javascript;base64,' + bytesBase64(encoder.encode(program)));
  root.append(script);
}
function svgDocument() {
  const output = document.implementation.createDocument(svgNs, 'svg'); const root = output.documentElement;
  root.setAttribute('width', '100%'); root.setAttribute('height', '100%');
  const title = output.createElementNS(svgNs, 'title'); title.textContent = 'Eya'; root.append(title);
  const foreignObject = output.createElementNS(svgNs, 'foreignObject');
  for (const [key, value] of Object.entries({ x: '0', y: '0', width: '100%', height: '100%' })) foreignObject.setAttribute(key, value);
  root.append(foreignObject); return { output, root, foreignObject };
}
function executable(script) { return !script.type || /^(application|text)\/(java|ecma)script$/i.test(script.type); }
function svgPrelude() {
  Object.defineProperties(document, {
    queryCommandSupported: { configurable: true, value: () => false },
    createElement: { configurable: true, value: (name, options) => document.createElementNS('http://www.w3.org/1999/xhtml', String(name).toLowerCase(), options) },
    head: { configurable: true, get: () => document.querySelector('foreignObject')?.querySelector('head') || null },
    body: { configurable: true, get: () => document.querySelector('foreignObject')?.querySelector('body') || null },
  });
}
function serialize(output) { return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(output); }
function svgClient(html) {
  const { output, root, foreignObject } = svgDocument(); const source = new DOMParser().parseFromString(html, 'text/html');
  const programs = [...source.scripts].filter(executable).map(script => script.textContent);
  for (const script of [...source.scripts]) if (executable(script)) script.remove();
  const client = output.importNode(source.documentElement, true); client.setAttribute('xmlns', xhtml); client.style.width = client.style.height = '100%'; foreignObject.append(client);
  appendProgram(output, root, `(${svgPrelude.toString()})();`);
  for (const program of programs) appendProgram(output, root, program);
  return serialize(output);
}
function packedPayload(html) {
  if (!globalThis.DecompressionStream) throw Error('This browser cannot open compressed clients. Choose standalone HTML or SVG.');
  return bytesBase64(gzipSync(encoder.encode(html), { level: 9, mtime: 0 }));
}
function unpackProgram(payload) {
  return unpackExpression(JSON.stringify(payload));
}
function unpackExpression(expression) { return `const b=Uint8Array.from(atob(${expression}),c=>c.charCodeAt(0)),h=await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).text();`; }
function compressedDocument(html) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eya</title><body style="background:#10151b;color:#e4edf2;font:16px system-ui">Loading Eya…<script>(async()=>{${unpackProgram(packedPayload(html))}document.open();document.write(h);document.close()})().catch(e=>document.body.textContent='Could not unpack Eya: '+e)</script>`;
}
function compressedSvgClient(html) {
  const { output, root, foreignObject } = svgDocument();
  const payload = output.createElementNS(svgNs, 'metadata'); payload.id = 'packed-client'; payload.textContent = packedPayload(html); root.append(payload);
  const status = output.createElementNS(xhtml, 'div'); status.id = 'unpack-status'; status.textContent = 'Loading Eya…'; status.style.cssText = 'background:#10151b;color:#e4edf2;width:100%;height:100%;font:16px system-ui'; foreignObject.append(status);
  const loader = `(async()=>{${unpackExpression("document.getElementById('packed-client').textContent")}
    const source=new DOMParser().parseFromString(h,'text/html'),executable=${executable.toString()},programs=[...source.scripts].filter(executable).map(script=>script.textContent);
    for(const script of [...source.scripts])if(executable(script))script.remove();
    const client=document.importNode(source.documentElement,true);client.style.width=client.style.height='100%';document.querySelector('foreignObject').replaceChildren(client);
    (${svgPrelude.toString()})();for(const program of programs)Function(program)();
  })().catch(e=>{const s=document.getElementById('unpack-status')||document.querySelector('foreignObject');s.textContent='Could not unpack Eya: '+e})`;
  appendProgram(output, root, loader); return serialize(output);
}
function dataUrl(html) {
  // These characters are legal in a data URL's payload (it is not a form), so
  // retaining them avoids percent-encoding the already-base64 gzip payload.
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(compressedDocument(html)).replace(/%2B/g, '+').replace(/%2F/g, '/').replace(/%3D/g, '=');
}
function download(content, filename, type) {
  const link = document.createElement('a'), url = URL.createObjectURL(new Blob([content], { type })); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
let templatePromise;
async function configuredHtml() {
  const key = el('key').value, defaultCommand = el('command').value, fontSize = Number(el('size').value), scrollback = Number(el('scrollback').value);
  if (!key) throw Error('Enter the shared password.');
  if (!Number.isInteger(fontSize) || fontSize < 8 || fontSize > 36 || !Number.isInteger(scrollback) || scrollback < 0 || scrollback > 50000) throw Error('Choose a valid font size and scrollback limit.');
  if (defaultCommand.length > 8192 || defaultCommand.includes('\0')) throw Error('Default command must be at most 8192 characters and cannot contain a NUL byte.');
  const fontFamilies = ['0xproto', 'jetbrains', 'firacode', 'cascadia', 'iosevka', 'inconsolata', 'sourcecodepro'];
  const choice = fontFamilies.includes(el('font-family').value) ? el('font-family').value : '0xproto';
  const custom = el('font').files[0];
  const response = custom ? null : await fetch(new URL('fonts/' + choice, location.href));
  if (response && !response.ok) throw Error('Could not download the selected font.');
  const selected = custom || new File([await response.blob()], choice + '.woff2', { type: 'font/woff2' });
  const config = { url: endpoint(el('server').value.trim()), key, defaultCommand, font: await fontData(selected), fontSize, scrollback, theme: el('theme').value, cursorBlink: el('cursor-blink').checked, cursorStyle: el('cursor-style').value, scrollOnUserInput: el('scroll-on-input').checked };
  templatePromise ||= fetch(new URL('client-template.html', location.href), { cache: 'no-store' }).then(response => { if (!response.ok) throw Error('Could not download the client template.'); return response.text(); }).catch(error => { templatePromise = undefined; throw error; });
  const html = await templatePromise; if (!html.includes(marker)) throw Error('The client template is incompatible with this generator.');
  return html.replace(marker, () => '<script id="eya-config" type="application/json">' + JSON.stringify(config).replace(/</g, '\\u003c') + '</' + 'script>');
}
document.querySelector('body>p').insertAdjacentHTML('afterend', '<nav class="launchers" aria-label="Hosted clients"><a href="client.html">Open HTML client</a><a href="client.svg">Open SVG client</a></nav>');
el('server').value = new URL('.', location.href).href;
el('format').insertAdjacentHTML('beforeend', '<option value="compressed-html">Compressed standalone HTML</option><option value="compressed-svg">Compressed standalone SVG</option><option value="data-url">Compressed HTML data URL</option>');
el('theme').insertAdjacentHTML('beforeend', '<option value="midnight">Midnight</option><option value="solarized">Solarized</option>');
el('form').insertAdjacentHTML('afterend', '<section id="data-url-result" class="data-url-result" hidden><strong>HTML data URL</strong><p>Contains your password. Long URLs may exceed browser limits.</p><textarea id="data-url" readonly spellcheck="false" aria-label="Generated HTML data URL"></textarea><div class="data-url-actions"><button id="copy-data-url" type="button">Copy data URL</button><a id="open-data-url" target="_blank" rel="noopener">Open data URL</a></div></section>');
el('form').onsubmit = async event => {
  event.preventDefault(); el('error').textContent = ''; const button = el('form').querySelector('button[type=submit]'); button.disabled = true;
  try {
    const html = await configuredHtml(), format = el('format').value;
    if (format === 'data-url') { const url = dataUrl(html); el('data-url').value = url; el('open-data-url').href = url; el('data-url-result').hidden = false; el('data-url').select(); }
    else if (format === 'svg') download(svgClient(html), 'eya-client.svg', 'image/svg+xml');
    else if (format === 'compressed-svg') download(compressedSvgClient(html), 'eya-client.compressed.svg', 'image/svg+xml');
    else if (format === 'compressed-html') download(compressedDocument(html), 'eya-client.compressed.html', 'text/html');
    else download(html, 'eya-client.html', 'text/html');
  } catch (error) { el('error').textContent = error.message || 'Could not generate client.'; }
  finally { button.disabled = false; }
};
el('copy-data-url').onclick = async () => { el('data-url').select(); try { await navigator.clipboard.writeText(el('data-url').value); } catch { document.execCommand('copy'); } };
// Pure artifact helpers are exposed for reproducible size and XML regression checks.
window.EyaGenerator = { svgClient, compressedDocument, compressedSvgClient, dataUrl };
