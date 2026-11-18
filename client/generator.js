import { gzipSync } from 'fflate';
import { bytesBase64, appendProgram, svgDocument, executable, svgPrelude, serialize, svgClient } from './client-artifacts.js';
import { preventPageZoom } from './mobile-zoom.js';
import { SETTINGS_GROUPS, SETTINGS_FIELDS, createSettingControl, readSettingsControls } from './settings-schema.js';
import { Plug, Palette, Terminal, Folder, FileCode, Globe, Image, Film, Music, Box, Activity, Container, Download, Settings, Eye, EyeOff, Keyboard, Hash } from 'lucide';
import { createKeybindSettings, getKeybinds } from './keybinds.js';
import { CLIENT_VERSION } from './version.js';
const icons = { Plug, Palette, Terminal, Folder, FileCode, Globe, Image, Film, Music, Box, Activity, Container, Download, Settings, Eye, EyeOff, Keyboard, Hash };

preventPageZoom();

const el = id => document.getElementById(id);
el('generator-version').textContent = `v${CLIENT_VERSION}`;
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
function packedPayload(html) {
  if (!globalThis.DecompressionStream) throw Error('This browser cannot open compressed clients. Choose standalone HTML or SVG.');
  return bytesBase64(gzipSync(encoder.encode(html), { level: 9, mtime: 0 }));
}
function unpackProgram(payload) {
  return unpackExpression(JSON.stringify(payload));
}
function unpackExpression(expression) { return `const b=Uint8Array.from(atob(${expression}),c=>c.charCodeAt(0)),h=await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).text();`; }
function compressedDocument(html) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>Eya</title><body style="background:#10151b;color:#e4edf2;font:16px system-ui">Loading Eya…<script>(async()=>{${unpackProgram(packedPayload(html))}document.open();document.write(h);document.close()})().catch(e=>document.body.textContent='Could not unpack Eya: '+e)</script>`;
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
  const settings = readSettingsControls(document, { generator: true });
  const key = el('key').value, defaultCommand = settings.defaultCommand, fontSize = settings.fontSize, scrollback = settings.scrollback;
  if (!key) throw Error('Enter the shared password.');
  if (!Number.isInteger(fontSize) || fontSize < 8 || fontSize > 36 || !Number.isInteger(scrollback) || scrollback < 0 || scrollback > 50000) throw Error('Choose a valid font size and scrollback limit.');
  if (defaultCommand.length > 8192 || defaultCommand.includes('\0')) throw Error('Default command must be at most 8192 characters and cannot contain a NUL byte.');
  const fontFamilies = ['0xproto', 'jetbrains', 'firacode', 'cascadia', 'iosevka', 'inconsolata', 'sourcecodepro'];
  const choice = fontFamilies.includes(el('font-family').value) ? el('font-family').value : '0xproto';
  const custom = el('font').files[0];
  const response = custom ? null : await fetch(new URL('fonts/' + choice, location.href));
  if (response && !response.ok) throw Error('Could not download the selected font.');
  const selected = custom || new File([await response.blob()], choice + '.woff2', { type: 'font/woff2' });
  const startupPanel = el('startup-panel').value;
  if (!['terminal', 'files', 'web-browser', 'proxy-browser', 'task-manager', 'docker', 'start', 'none'].includes(startupPanel)) throw Error('Choose a valid starting panel.');
  const config = { ...settings, keybinds: getKeybinds(), url: endpoint(el('server').value.trim()), key, startupPanel, font: await fontData(selected) };
  templatePromise ||= fetch(new URL('client-template.html', location.href), { cache: 'no-store' }).then(response => { if (!response.ok) throw Error('Could not download the client template.'); return response.text(); }).catch(error => { templatePromise = undefined; throw error; });
  const html = await templatePromise; if (!html.includes(marker)) throw Error('The client template is incompatible with this generator.');
  return html.replace(marker, () => '<script id="eya-config" type="application/json">' + JSON.stringify(config).replace(/</g, '\\u003c') + '</' + 'script>');
}
function glyph(name) {
  const node = document.createElementNS(svgNs, 'svg'); node.setAttribute('viewBox', '0 0 24 24'); node.setAttribute('class', 'generator-icon'); node.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of icons[name] || icons.Settings) { const child = document.createElementNS(svgNs, tag); for (const [key,value] of Object.entries(attrs)) child.setAttribute(key,value); node.append(child); }
  return node;
}
const groups = [{id:'connection',title:'Connection',icon:'Plug'}, ...SETTINGS_GROUPS, {id:'export',title:'Export',icon:'Download'}];
for (const group of SETTINGS_GROUPS) {
  const section = document.createElement('section'); section.className = 'generator-page'; section.dataset.page = group.id; section.hidden = true;
  const title = document.createElement('h2'); title.id = group.id + '-title'; title.textContent = group.title; section.setAttribute('aria-labelledby', title.id);
  const grid = document.createElement('div'); grid.className = 'generator-fields';
  for (const field of SETTINGS_FIELDS.filter(field => field.group === group.id)) grid.append(createSettingControl(field,{generator:true}));
  section.append(title,grid); el('generator-pages').insertBefore(section, document.querySelector('[data-page=export]'));
}
const fonts = document.createElement('div'); fonts.className = 'generator-font generator-fields';
fonts.innerHTML = '<label class="setting"><span>Terminal font</span><select id="font-family"><option value="0xproto">0xProto Nerd Font</option><option value="jetbrains">JetBrains Mono Nerd Font</option><option value="firacode">Fira Code Nerd Font</option><option value="cascadia">Caskaydia Cove Nerd Font</option><option value="iosevka">Iosevka Nerd Font</option><option value="inconsolata">Inconsolata Nerd Font</option><option value="sourcecodepro">SauceCodePro Nerd Font</option></select></label><label class="setting"><span>Custom font</span><input id="font" type="file" accept=".woff,.woff2,.ttf,.otf,font/*"><small>WOFF2, WOFF, TTF or OTF · up to 4 MiB</small></label>';
document.querySelector('[data-page=terminal] .generator-fields').prepend(fonts);
let currentPage = 'connection';
function showPage(id, focus = false) {
  currentPage = id; el('generator-search').value = '';
  for (const section of document.querySelectorAll('.generator-page')) { section.hidden = section.dataset.page !== id; for (const row of section.querySelectorAll('.setting')) row.hidden = false; }
  for (const button of el('generator-nav').querySelectorAll('button')) { const active = button.dataset.page === id; if(active) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); button.hidden = false; }
  el('generator-empty').hidden = true;
  if(focus) document.querySelector('.generator-page:not([hidden]) input,.generator-page:not([hidden]) select')?.focus();
}
for (const group of groups) {
  const button = document.createElement('button'); button.type = 'button'; button.dataset.page = group.id; button.append(glyph(group.icon), document.createTextNode(group.title)); button.onclick = () => showPage(group.id); el('generator-nav').append(button);
}
const keybindSettings = createKeybindSettings();
const keybindButton = document.createElement('button'); keybindButton.type = 'button'; keybindButton.append(glyph('Keyboard'),document.createTextNode('Keyboard shortcuts')); keybindButton.onclick = () => keybindSettings.open(); el('generator-nav').append(keybindButton);
showPage(currentPage);
el('generator-search').oninput = () => {
  const query = el('generator-search').value.trim().toLowerCase(); if(!query) { showPage(currentPage); return; }
  let visible = 0;
  for (const section of document.querySelectorAll('.generator-page')) {
    let found = 0;
    for (const row of section.querySelectorAll('.setting')) { row.hidden = ![row.querySelector('span')?.textContent || '', row.querySelector('input,select,textarea')?.id || '', section.querySelector('h2').textContent].join(' ').toLowerCase().includes(query); if(!row.hidden) found++; }
    section.hidden = !found; visible += found;
  }
  for (const button of el('generator-nav').querySelectorAll('button')) button.removeAttribute('aria-current');
  el('generator-empty').hidden = visible > 0;
};
el('show-key').append(glyph('Eye'));
el('show-key').onclick = () => { const show = el('key').type === 'password'; el('key').type = show ? 'text' : 'password'; el('show-key').setAttribute('aria-label',show?'Hide password':'Show password'); el('show-key').setAttribute('aria-pressed',String(show)); el('show-key').replaceChildren(glyph(show?'EyeOff':'Eye')); };
el('server').value = new URL('.', location.href).href;
el('form').insertAdjacentHTML('afterend', '<section id="data-url-result" class="data-url-result" hidden><strong>Client data URL</strong><p>Contains your password. Browser URL limits apply.</p><textarea id="data-url" readonly spellcheck="false" aria-label="Generated HTML data URL"></textarea><div class="data-url-actions"><button id="copy-data-url" type="button">Copy URL</button><a id="open-data-url" target="_blank" rel="noopener">Open client</a></div></section>');
el('form').onsubmit = async event => {
  event.preventDefault(); el('error').textContent = '';
  for (const input of el('form').querySelectorAll('input,select,textarea')) if(!input.checkValidity()) { showPage(input.closest('[data-page]').dataset.page); input.reportValidity(); return; }
  const button = el('form').querySelector('button[type=submit]'); button.disabled = true; button.setAttribute('aria-busy','true'); button.querySelector('.generating-spinner').hidden = false;
  try {
    const html = await configuredHtml(), format = el('format').value;
    if (format === 'data-url') { const url = dataUrl(html); el('data-url').value = url; el('open-data-url').href = url; el('data-url-result').hidden = false; el('data-url').select(); }
    else if (format === 'svg') download(svgClient(html), 'eya-client.svg', 'image/svg+xml');
    else if (format === 'compressed-svg') download(compressedSvgClient(html), 'eya-client.compressed.svg', 'image/svg+xml');
    else if (format === 'compressed-html') download(compressedDocument(html), 'eya-client.compressed.html', 'text/html');
    else download(html, 'eya-client.html', 'text/html');
  } catch (error) { el('error').textContent = error.message || 'Could not generate client.'; }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); button.querySelector('.generating-spinner').hidden = true; }
};
el('copy-data-url').onclick = async () => { el('data-url').select(); try { await navigator.clipboard.writeText(el('data-url').value); } catch { document.execCommand('copy'); } };
// Pure artifact helpers are exposed for reproducible size and XML regression checks.
window.EyaGenerator = { svgClient, compressedDocument, compressedSvgClient, dataUrl };
