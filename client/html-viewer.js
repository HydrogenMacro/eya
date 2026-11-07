const MIME = {
  css: 'text/css', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff',
  woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
};

export function localHtmlViewerCsp(scriptsEnabled) {
  return `default-src 'none'; script-src ${scriptsEnabled ? "'unsafe-inline' blob: data:" : "'none'"}; img-src data: blob:; style-src 'unsafe-inline' blob: data:; font-src data: blob:; media-src data: blob:; form-action 'none'; object-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; base-uri http://eya.invalid;`;
}

function ext(path) { return path.split(/[?#]/, 1)[0].split('.').at(-1)?.toLowerCase() || ''; }
export function localPath(reference, basePath) {
  if (!reference) return null;
  try {
    const base = new URL(`http://eya.invalid${basePath}`);
    const url = new URL(reference, base);
    if (url.origin !== base.origin) return null;
    const segments = [];
    for (const segment of decodeURIComponent(url.pathname).split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') segments.pop(); else segments.push(segment);
    }
    return { path: `/${segments.join('/')}`, search: url.search, hash: url.hash };
  } catch { return null; }
}

function parentDirectory(path) { const value = String(path || '').replace(/\\/g, '/'); return value.slice(0, value.lastIndexOf('/')) || '/'; }
export function pathIsWithin(path, root) { const base = root.replace(/\/$/, '') || '/'; return path === base || path.startsWith(base === '/' ? '/' : `${base}/`); }

export function neutralizeLocalHtmlSource(source) {
  const text = String(source ?? ''), output = [];
  const rawText = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noembed', 'noframes', 'plaintext']);
  let index = 0, rawTag = '';
  while (index < text.length) {
    if (rawTag) {
      const close = text.slice(index).search(new RegExp(`<\\/\\s*${rawTag}(?=[\\s/>])`, 'i'));
      if (close < 0) { output.push(text.slice(index)); break; }
      output.push(text.slice(index, index + close)); index += close; rawTag = '';
    }
    const start = text.indexOf('<', index);
    if (start < 0) { output.push(text.slice(index)); break; }
    output.push(text.slice(index, start));
    if (text.startsWith('<!--', start)) {
      const end = text.indexOf('-->', start + 4), next = end < 0 ? text.length : end + 3;
      output.push(text.slice(start, next)); index = next; continue;
    }
    let cursor = start + 1, closing = false;
    if (text[cursor] === '/') { closing = true; cursor++; }
    if (!/[A-Za-z]/.test(text[cursor] || '')) { output.push('<'); index = start + 1; continue; }
    const nameStart = cursor;
    while (/[A-Za-z0-9:-]/.test(text[cursor] || '')) cursor++;
    const name = text.slice(nameStart, cursor).toLowerCase();
    let quote = '';
    while (cursor < text.length) {
      const char = text[cursor++];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    const tag = text.slice(start, cursor); index = cursor;
    let drop = false;
    if (!closing && (name === 'meta' || name === 'link')) {
      const template = document.createElement('template'); template.innerHTML = tag;
      const node = template.content.firstElementChild;
      if (name === 'meta') drop = (node?.getAttribute('http-equiv') || '').trim().toLowerCase() === 'refresh';
      else {
        const rel = new Set((node?.getAttribute('rel') || '').toLowerCase().split(/\s+/));
        drop = ['preconnect', 'dns-prefetch', 'prefetch', 'prerender', 'modulepreload'].some(value => rel.has(value));
      }
    }
    if (!drop) output.push(tag);
    if (!closing && rawText.has(name) && name !== 'plaintext' && !/\/\s*>$/.test(tag)) rawTag = name;
    if (name === 'plaintext' && !closing) break;
  }
  return output.join('');
}

export function buildLocalViewerBridge(nonce, generation) {
  return `(()=>{const nonce=${JSON.stringify(nonce)},generation=${Number(generation)},pending=new Map(),append=Node.prototype.appendChild,insert=Node.prototype.insertBefore,nativeStop=typeof window.stop==='function'?window.stop.bind(window):()=>{},nativePreventDefault=Function.prototype.call.bind(Event.prototype.preventDefault);let sequence=0;const blockedHint=node=>node?.tagName==='META'&&String(node.httpEquiv||'').trim().toLowerCase()==='refresh'||node?.tagName==='LINK'&&/\\b(?:preconnect|dns-prefetch|prefetch|prerender|modulepreload)\\b/i.test(node.rel||'');const add=(container,node,method,reference)=>{if(blockedHint(node))return node;if(node?.tagName==='SCRIPT'&&node.hasAttribute('src')&&!node.dataset.eyaLocalLoaded){const id=++sequence;pending.set(id,{parent:container,node,method,reference});window.parent.postMessage({type:'eya-local-viewer-script',nonce,generation,id,href:node.src},'*');return node}return method.call(container,node,reference)};Node.prototype.appendChild=function(node){return add(this,node,append,arguments[1])};Node.prototype.insertBefore=function(node,reference){return add(this,node,insert,arguments[1])};addEventListener('click',event=>{const anchor=event.target.closest?.('a[href]');if(!anchor||anchor.getAttribute('href')?.startsWith('#'))return;nativePreventDefault(event);parent.postMessage({type:'eya-local-viewer-nav',nonce,generation,href:anchor.dataset.eyaPath?anchor.dataset.eyaPath+anchor.dataset.eyaHash:anchor.getAttribute('href')},'*')},true);try{const nav=window.navigation;if(!nav?.addEventListener)throw Error('Navigation API unavailable');nav.addEventListener('navigate',event=>{if(event.hashChange||event.downloadRequest!=null||event.destination?.sameDocument)return;let href;try{href=new URL(String(event.destination?.url||''),document.baseURI).href}catch{return}if(!event.cancelable){try{nativeStop()}catch{}try{document.documentElement?.replaceChildren()}catch{}parent.postMessage({type:'eya-local-viewer-nav-unhandled',nonce,generation,href},'*');return}nativePreventDefault(event);parent.postMessage({type:'eya-local-viewer-nav',nonce,generation,href,history:event.navigationType==='replace'?'replace':event.navigationType==='reload'?'reload':'push'},'*')},true);const proto=Location.prototype,wrap=(name,history)=>{const descriptor=Object.getOwnPropertyDescriptor(proto,name);if(!descriptor?.configurable||typeof descriptor.value!=='function')return;Object.defineProperty(proto,name,{...descriptor,value:function(value){let href;try{href=new URL(name==='reload'?document.baseURI:String(value),document.baseURI).href}catch{return}parent.postMessage({type:'eya-local-viewer-nav',nonce,generation,href,history},'*')}})};wrap('assign','push');wrap('replace','replace');wrap('reload','reload')}catch{try{nativeStop()}catch{}try{document.documentElement?.replaceChildren()}catch{}parent.postMessage({type:'eya-local-viewer-navigation-unsupported',nonce,generation},'*')}const cleanHints=root=>{if(blockedHint(root)){root.remove();return}root.querySelectorAll?.('meta[http-equiv="refresh" i],link[rel~="preconnect" i],link[rel~="dns-prefetch" i],link[rel~="prefetch" i],link[rel~="prerender" i],link[rel~="modulepreload" i]').forEach(node=>node.remove())};new MutationObserver(records=>{for(const record of records){if(record.type==='attributes')cleanHints(record.target);for(const node of record.addedNodes)if(node.nodeType===1)cleanHints(node)}}).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['http-equiv','rel']});addEventListener('submit',event=>nativePreventDefault(event),true);addEventListener('message',event=>{if(event.source!==parent||event.data?.nonce!==nonce||event.data?.generation!==generation)return;const message=event.data;if(message.type==='eya-local-viewer-script-result'){const item=pending.get(message.id);if(!item)return;pending.delete(message.id);if(!message.url){item.node.dispatchEvent(new Event('error'));return}item.node.dataset.eyaLocalLoaded='1';item.node.src=message.url;item.method.call(item.parent,item.node,item.reference)}else if(message.type==='eya-local-viewer-control'){document.documentElement.style.zoom=String(message.zoom||1);if(message.hash){let id=message.hash.slice(1);try{id=decodeURIComponent(id)}catch{}document.getElementById(id)?.scrollIntoView()}}});parent.postMessage({type:'eya-local-viewer-ready',nonce,generation},'*')})();`;
}

// The document runs without scripts in a sandbox. Local presentation assets are
// copied into data URLs so relative CSS/images work from the encrypted
// file API even when the Eya client itself is opened from file://.
export function createHtmlViewer(tab, { readResource, openFile, trustedRoot = parentDirectory(tab.path) }) {
  const root = document.createElement('div'); root.className = 'html-viewer';
  const toolbar = document.createElement('div'); toolbar.className = 'html-viewer-toolbar';
  const back = document.createElement('button'); back.type = 'button'; back.textContent = 'Back'; back.title = 'Back in HTML history';
  const forward = document.createElement('button'); forward.type = 'button'; forward.textContent = 'Forward'; forward.title = 'Forward in HTML history';
  const reload = document.createElement('button'); reload.type = 'button'; reload.textContent = 'Reload';
  const zoomOut = document.createElement('button'); zoomOut.type = 'button'; zoomOut.textContent = '−'; zoomOut.title = 'Zoom out';
  const zoomIn = document.createElement('button'); zoomIn.type = 'button'; zoomIn.textContent = '+'; zoomIn.title = 'Zoom in';
  const scriptsLabel = document.createElement('label'); scriptsLabel.className = 'html-viewer-scripts';
  const scriptsToggle = document.createElement('input'); scriptsToggle.type = 'checkbox'; scriptsToggle.setAttribute('aria-label', 'Run scripts from these local documents');
  scriptsToggle.disabled = true;
  const scriptsText = document.createElement('span'); scriptsText.textContent = 'Run local scripts';
  scriptsLabel.title = 'Unavailable until local script navigation can be confined to the WebSocket and approved root.';
  scriptsLabel.append(scriptsToggle, scriptsText);
  const rootInput = document.createElement('input'); rootInput.className = 'html-viewer-root'; rootInput.type = 'text'; rootInput.value = trustedRoot;
  rootInput.placeholder = 'Local document root'; rootInput.setAttribute('aria-label', 'Local document root');
  rootInput.title = 'Local document root'; rootInput.hidden = true;
  const address = document.createElement('span'); address.className = 'html-viewer-address'; address.title = tab.path; address.textContent = tab.path;
  const status = document.createElement('span'); status.className = 'html-viewer-status'; status.setAttribute('role', 'status');
  toolbar.append(back, forward, reload, zoomOut, zoomIn, address, status);
  const frame = document.createElement('iframe'); frame.className = 'html-viewer-frame';
  frame.title = `HTML document: ${tab.name}`;
  frame.setAttribute('sandbox', 'allow-same-origin');
  root.append(toolbar, frame);

  const localNonce = randomNonce();
  const history = [{ path: tab.path, hash: '' }]; let position = 0, zoom = 1, disposed = false, generation = 0, pendingHash = '', trustedScriptsEnabled = false, approvedRoot = trustedRoot, scriptBytes = 0;
  const MAX_SCRIPT_BYTES = 32 * 1024 * 1024, MAX_TOTAL_SCRIPT_BYTES = 64 * 1024 * 1024;
  function randomNonce() { const bytes = crypto.getRandomValues(new Uint8Array(16)); return [...bytes].map(value => value.toString(16).padStart(2, '0')).join(''); }
  const makeUrl = (bytes, type, expectedGeneration = generation) => {
    if (disposed || expectedGeneration !== generation) return '';
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const chunks = [];
    for (let offset = 0; offset < data.length; offset += 16384) chunks.push(String.fromCharCode(...data.subarray(offset, offset + 16384)));
    return `data:${type};base64,${btoa(chunks.join(''))}`;
  };
  async function assetUrl(path, depth = 0, expectedGeneration = generation) {
    if (depth > 3) throw Error('Stylesheet nesting is too deep');
    const result = await readResource(path);
    if (disposed || expectedGeneration !== generation) return '';
    if (ext(path) === 'css') return materializeCss(path, result.bytes, depth, expectedGeneration);
    return makeUrl(result.bytes, MIME[ext(path)] || 'application/octet-stream', expectedGeneration);
  }
  async function materializeCss(path, bytes, depth, expectedGeneration = generation) {
    let css = new TextDecoder().decode(bytes);
    const refs = [];
    css = css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_whole, _quote, raw) => {
      const value = raw.trim();
      if (/^(?:data:|blob:|#)/i.test(value)) return `url("${value}")`;
      const local = localPath(value, path);
      if (!local || trustedScriptsEnabled && !pathIsWithin(local.path, approvedRoot)) return 'url("about:blank")';
      const index = refs.push(local) - 1;
      return `url("__EYA_CSS_ASSET_${index}__")`;
    });
    for (let i = 0; i < refs.length; i++) {
      try {
        const ref = refs[i];
        if (trustedScriptsEnabled && !pathIsWithin(ref.path, approvedRoot)) throw Error('CSS asset outside approved root');
        const result = await readResource(ref.path);
        if (disposed || expectedGeneration !== generation) return '';
        const value = ext(ref.path) === 'css' && depth < 3
          ? await materializeCss(ref.path, result.bytes, depth + 1, expectedGeneration)
          : makeUrl(result.bytes, MIME[ext(ref.path)] || 'application/octet-stream', expectedGeneration);
        css = css.replaceAll(`__EYA_CSS_ASSET_${i}__`, value);
      } catch { css = css.replaceAll(`__EYA_CSS_ASSET_${i}__`, 'about:blank'); }
    }
    return makeUrl(new TextEncoder().encode(css), 'text/css', expectedGeneration);
  }

  async function render(path, bytes = null) {
    const id = ++generation; scriptBytes = 0; status.textContent = 'Loading…'; address.textContent = path; address.title = path;
    try {
      const source = bytes || (await readResource(path)).bytes;
      if (id !== generation || disposed) return;
      const policy = localHtmlViewerCsp(trustedScriptsEnabled);
      const input = neutralizeLocalHtmlSource(new TextDecoder().decode(source));
      const doc = new DOMParser().parseFromString(`<!doctype html><meta charset="utf-8"><meta http-equiv="x-dns-prefetch-control" content="off"><meta http-equiv="Content-Security-Policy" content="${policy}">${input}`, 'text/html');
      const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy" i]');
      doc.querySelectorAll('meta[http-equiv="Content-Security-Policy" i]').forEach(node => { if (node !== csp) node.remove(); });
      const scripts = [...doc.querySelectorAll('script')];
      if (!trustedScriptsEnabled) scripts.forEach(node => node.remove());
      else for (const script of scripts) {
        if ((script.getAttribute('type') || '').trim().toLowerCase() === 'module') { script.remove(); continue; }
        if (!script.hasAttribute('src')) continue;
        const ref = localPath(script.getAttribute('src'), path);
        if (!ref || !pathIsWithin(ref.path, approvedRoot)) { script.remove(); continue; }
        try {
          const result = await readResource(ref.path);
          if (id !== generation || disposed) return;
          if (result.bytes.byteLength > MAX_SCRIPT_BYTES || result.bytes.byteLength > MAX_TOTAL_SCRIPT_BYTES - scriptBytes) { script.remove(); continue; }
          scriptBytes += result.bytes.byteLength;
          script.src = makeUrl(result.bytes, 'text/javascript', id); script.dataset.eyaLocalLoaded = '1';
          script.removeAttribute('integrity'); script.removeAttribute('crossorigin'); script.removeAttribute('referrerpolicy');
        } catch { script.remove(); }
      }
      doc.querySelectorAll('iframe, frame, object, embed, portal').forEach(node => node.remove());
      doc.querySelectorAll('meta[http-equiv="refresh" i], base').forEach(node => node.remove());
      doc.querySelectorAll('*').forEach(node => [...node.attributes].forEach(attr => {
        if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      }));
      const styles = [...doc.querySelectorAll('link[rel~="stylesheet"][href]')];
      for (const link of styles) {
        const ref = localPath(link.getAttribute('href'), path);
        if (!ref || trustedScriptsEnabled && !pathIsWithin(ref.path, approvedRoot)) { link.remove(); continue; }
        try { link.href = await materializeCss(ref.path, (await readResource(ref.path)).bytes, 0, id); }
        catch { link.remove(); }
      }
      for (const node of doc.querySelectorAll('img[src], source[src]')) {
        const ref = localPath(node.getAttribute('src'), path);
        if (!ref || trustedScriptsEnabled && !pathIsWithin(ref.path, approvedRoot)) { if (!/^(?:data:|blob:)/i.test(node.getAttribute('src'))) node.removeAttribute('src'); continue; }
        try { node.src = await assetUrl(ref.path, 0, id); } catch { node.removeAttribute('src'); }
      }
      if (id !== generation || disposed) return;
      doc.head.prepend(csp);
      doc.querySelectorAll('a[href]').forEach(anchor => {
        const href = anchor.getAttribute('href');
        if (href.startsWith('#')) return;
        const ref = localPath(href, path);
        if (trustedScriptsEnabled && ref && !pathIsWithin(ref.path, approvedRoot)) { anchor.dataset.eyaExternal = 'true'; anchor.href = '#'; return; }
        if (ref) {
          if (ref.path === path && ref.hash) { anchor.href = ref.hash; return; }
          anchor.dataset.eyaPath = ref.path;
          anchor.dataset.eyaHash = ref.hash;
          anchor.href = '#';
        } else if (!href.startsWith('#')) {
          anchor.dataset.eyaExternal = 'true'; anchor.href = '#';
        }
      });
      if (trustedScriptsEnabled) {
        const base = doc.createElement('base'); base.href = `http://eya.invalid${parentDirectory(path).replace(/\/$/, '')}/`; doc.head.prepend(base);
        const bridge = doc.createElement('script');
        bridge.textContent = buildLocalViewerBridge(localNonce, id);
        doc.head.prepend(bridge);
      }
      frame.setAttribute('sandbox', trustedScriptsEnabled ? 'allow-scripts' : 'allow-same-origin');
      frame.srcdoc = '<!doctype html>\n' + doc.documentElement.outerHTML;
      status.textContent = `${path} · ${new TextDecoder().decode(source).length.toLocaleString()} characters`;
    } catch (error) { status.textContent = error?.message || 'Could not load HTML document'; }
    back.disabled = position <= 0; forward.disabled = position >= history.length - 1;
  }

  frame.addEventListener('load', () => {
    if (trustedScriptsEnabled) return;
    try {
      frame.contentDocument.addEventListener('click', event => {
        const anchor = event.target.closest('a'); if (!anchor) return;
        if (anchor.dataset.eyaExternal) { event.preventDefault(); status.textContent = 'External links are disabled in the local HTML viewer.'; return; }
        const target = anchor.dataset.eyaPath;
        if (target) { event.preventDefault(); navigate(target, anchor.dataset.eyaHash || ''); }
      });
      frame.contentDocument.documentElement.style.zoom = String(zoom);
      if (pendingHash) {
        let id = pendingHash.slice(1);
        try { id = decodeURIComponent(id); } catch { /* Keep a literal fragment if malformed. */ }
        frame.contentDocument.getElementById(id)?.scrollIntoView();
        pendingHash = '';
      }
    } catch { /* The sandbox keeps document access limited to this generated frame. */ }
  });
  async function onLocalMessage(event) {
    if (event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.nonce !== localNonce) return;
    if (event.data.generation !== undefined && event.data.generation !== generation) return;
    if (event.data.type === 'eya-local-viewer-ready') {
      frame.contentWindow.postMessage({ type: 'eya-local-viewer-control', nonce: localNonce, generation, zoom, hash: pendingHash }, '*');
      pendingHash = '';
    } else if (event.data.type === 'eya-local-viewer-nav' && typeof event.data.href === 'string') {
      const currentPath = history[position]?.path || tab.path;
      const ref = localPath(event.data.href, currentPath);
      if (!ref || trustedScriptsEnabled && !pathIsWithin(ref.path, approvedRoot)) { status.textContent = 'This link is outside the approved local documentation root.'; return; }
      if (ref.path === (history[position]?.path || tab.path) && ref.hash) {
        frame.contentWindow.postMessage({ type: 'eya-local-viewer-control', nonce: localNonce, generation, zoom, hash: ref.hash }, '*');
      } else navigate(ref.path, ref.hash, !['replace', 'reload'].includes(event.data.history));
    } else if (event.data.type === 'eya-local-viewer-nav-unhandled' || event.data.type === 'eya-local-viewer-navigation-unsupported') {
      trustedScriptsEnabled = false; scriptsToggle.checked = false; rootInput.hidden = true;
      status.textContent = 'A local script attempted navigation that this browser could not safely intercept. Scripts were disabled.';
      render(history[position]?.path || tab.path);
    } else if (event.data.type === 'eya-local-viewer-script' && Number.isSafeInteger(event.data.id) && typeof event.data.href === 'string') {
      const currentPath = history[position]?.path || tab.path;
      const ref = localPath(event.data.href, currentPath);
      if (!ref || !pathIsWithin(ref.path, approvedRoot)) { frame.contentWindow.postMessage({ type: 'eya-local-viewer-script-result', nonce: localNonce, generation, id: event.data.id, url: '' }, '*'); return; }
      try {
        const result = await readResource(ref.path);
        if (generation !== event.data.generation || disposed) return;
        if (result.bytes.byteLength > MAX_SCRIPT_BYTES || result.bytes.byteLength > MAX_TOTAL_SCRIPT_BYTES - scriptBytes) throw Error('Local documentation script limit reached.');
        scriptBytes += result.bytes.byteLength;
        const url = makeUrl(result.bytes, 'text/javascript', event.data.generation);
        frame.contentWindow.postMessage({ type: 'eya-local-viewer-script-result', nonce: localNonce, generation, id: event.data.id, url }, '*');
      } catch { frame.contentWindow.postMessage({ type: 'eya-local-viewer-script-result', nonce: localNonce, generation, id: event.data.id, url: '' }, '*'); }
    }
  }
  window.addEventListener('message', onLocalMessage);
  async function navigate(path, hash = '', add = true) {
    if (!path.toLowerCase().endsWith('.html') && !path.toLowerCase().endsWith('.htm')) { openFile(path); return; }
    if (add) { history.splice(position + 1); history.push({ path, hash }); position = history.length - 1; }
    pendingHash = hash;
    await render(path);
    back.disabled = position <= 0; forward.disabled = position >= history.length - 1;
  }
  back.onclick = () => { if (position > 0) { const entry = history[--position]; pendingHash = entry.hash; render(entry.path); } back.disabled = position <= 0; forward.disabled = false; };
  forward.onclick = () => { if (position < history.length - 1) { const entry = history[++position]; pendingHash = entry.hash; render(entry.path); } back.disabled = false; forward.disabled = position >= history.length - 1; };
  reload.onclick = () => render(history[position].path);
  zoomIn.onclick = () => { zoom = Math.min(2, zoom + .1); if (trustedScriptsEnabled) frame.contentWindow.postMessage({ type: 'eya-local-viewer-control', nonce: localNonce, generation, zoom }, '*'); else try { frame.contentDocument.documentElement.style.zoom = String(zoom); } catch {} };
  zoomOut.onclick = () => { zoom = Math.max(.6, zoom - .1); if (trustedScriptsEnabled) frame.contentWindow.postMessage({ type: 'eya-local-viewer-control', nonce: localNonce, generation, zoom }, '*'); else try { frame.contentDocument.documentElement.style.zoom = String(zoom); } catch {} };
  scriptsToggle.addEventListener('change', () => {
    trustedScriptsEnabled = scriptsToggle.checked;
    rootInput.hidden = !trustedScriptsEnabled;
    if (trustedScriptsEnabled) {
      const root = localPath(rootInput.value, tab.path);
      if (!root) { scriptsToggle.checked = false; trustedScriptsEnabled = false; status.textContent = 'Enter a local documentation root path.'; return; }
      approvedRoot = root.path;
    }
    scriptBytes = 0;
    status.textContent = trustedScriptsEnabled ? 'Trusted local scripts enabled; network and external resources remain blocked.' : 'Local scripts disabled.';
    render(history[position].path);
  });
  rootInput.addEventListener('change', () => {
    if (!trustedScriptsEnabled) return;
    const root = localPath(rootInput.value, history[position]?.path || tab.path);
    if (!root || !pathIsWithin(history[position]?.path || tab.path, root.path)) { status.textContent = 'The trusted root must contain the current documentation page.'; return; }
    approvedRoot = root.path; scriptBytes = 0; render(history[position].path);
  });
  render(tab.path, tab.bytes);
  return { element: root, dispose() { disposed = true; generation++; window.removeEventListener('message', onLocalMessage); frame.src = 'about:blank'; } };
}
