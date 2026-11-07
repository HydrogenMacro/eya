import { parseEventSourceBlock } from './browser-eventsource.js';
import { createHtmlViewer } from './html-viewer.js';
import { parser as javascriptParser } from '@lezer/javascript';
export { parseEventSourceBlock } from './browser-eventsource.js';

const HISTORY_KEY = 'eya-browser-history-v1';
const BOOKMARK_KEY = 'eya-browser-bookmarks-v1';
const PREFS_KEY = 'eya-browser-preferences-v1';
const FILTER_LIST_KEY = 'eya-browser-filter-list-v1';
const USERSCRIPTS_KEY = 'eya-browser-userscripts-v1';
const MAX_HISTORY = 100;
const MAX_BOOKMARKS = 200;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_FILTER_LIST_BYTES = 1024 * 1024;
const MAX_USERSCRIPT_BYTES = 256 * 1024;
const MAX_USERSCRIPTS = 50;
const MAX_USERSCRIPTS_TOTAL_BYTES = 2 * 1024 * 1024;
const USERSCRIPT_STORAGE_KEY = 'eya-browser-userscript-storage-v1';
const MAX_USERSCRIPT_STORAGE_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_USERSCRIPT_STORAGE_PER_SCRIPT_BYTES = 256 * 1024;
const MAX_USERSCRIPT_VALUE_BYTES = 64 * 1024;
const MAX_USERSCRIPT_STORAGE_ITEMS = 128;
const MAX_USERSCRIPT_REQUESTS_PER_SCRIPT = 2;
const MAX_USERSCRIPT_REQUESTS_PER_PANEL = 8;
const MAX_USERSCRIPT_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_USERSCRIPT_RESOURCES = 16;
const MAX_USERSCRIPT_RESOURCE_BYTES = 1024 * 1024;
const MAX_USERSCRIPT_RESOURCES_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_RESOURCE_CACHE_ENTRIES = 512;
const MAX_RESOURCE_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_GENERIC_FILTERS = 512;
const MAX_FILTER_PATTERN_CHARS = 256;
const MAX_COSMETIC_FILTERS = 2000;
const MAX_COSMETIC_SELECTOR_CHARS = 512;
const MAX_COSMETIC_DOMAINS = 64;
const MAX_PAGE_COSMETIC_FILTERS = 512;
const MAX_PAGE_COSMETIC_CSS_BYTES = 128 * 1024;
const MAX_DEVTOOLS_SOURCE_BYTES = 512 * 1024;
const MAX_NAVIGATION_REWRITE_BYTES = 1024 * 1024;
const MAX_DEVTOOLS_TOTAL_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_DEVTOOLS_SOURCES_PER_TAB = 100;
const MAX_NETWORK_CAPTURE_ENTRY_BYTES = 256 * 1024;
const MAX_NETWORK_CAPTURE_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_REMOTE_NETWORK_BODY_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_NETWORK_BODY_PREVIEW_CHARS = 16 * 1024;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_DOWNLOADS = 50;
const MAX_ACTIVE_DOWNLOADS = 2;
const MAX_TAB_COOKIES = 300;
const MAX_COOKIE_BYTES = 32 * 1024;
const SITE_STORAGE_KEY = 'eya-browser-site-storage-v1';
const MAX_STORAGE_AREA_BYTES = 1024 * 1024;
const MAX_STORAGE_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_TAB_SESSION_STORAGE_BYTES = 2 * 1024 * 1024;
const MAX_STORAGE_ITEMS = 5000;
const MAX_BROWSER_TABS = 24;
const FRAME_MESSAGE_LIMITS = Object.freeze({ console: 120, network: 120, dom: 30, storage: 1000, cookie: 120, navigate: 120, 'navigation-unhandled': 4, history: 240, 'history-go': 120, 'open-tab': 120, download: 120, 'userscript-storage': 20, 'find-open': 10, 'find-result': 20 });
const MAX_BUFFERED_STATIC_LOADS = 2;
const MAX_RETAINED_STATIC_BYTES = 256 * 1024 * 1024;
const MAX_WORKER_SCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_WORKER_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_WORKER_FETCHES = 2;
const MAX_WORKERS_PER_TAB = 4;
const MAX_WORKER_GRAPH_BYTES = 4 * 1024 * 1024;
const MAX_WORKER_GRAPH_SCRIPTS = 16;
const MAX_WORKER_IMPORT_DEPTH = 4;
const MAX_PAGE_MODULE_GRAPH_BYTES = 8 * 1024 * 1024;
const MAX_PAGE_MODULE_GRAPHS = 16;

export function sanitizeBrowserBookmarkImport(input, limit = MAX_BOOKMARKS) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BOOKMARKS) throw new RangeError(`Bookmark import limit must be between 1 and ${MAX_BOOKMARKS}.`);
  let value = input;
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).byteLength > 1024 * 1024) throw new RangeError('Bookmark import exceeds the 1 MiB file limit.');
    try { value = JSON.parse(value); } catch { throw new TypeError('Bookmark file is not valid JSON.'); }
  }
  if (!value || typeof value !== 'object' || value.format !== 'eya-browser-bookmarks' || value.version !== 1 || !Array.isArray(value.bookmarks)) {
    throw new TypeError('Bookmark file format or version is not supported.');
  }
  const result = [], seen = new Set();
  for (const row of value.bookmarks) {
    if (!row || typeof row !== 'object' || typeof row.url !== 'string' || row.url.length > 4096) continue;
    let url;
    try { url = new URL(row.url); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
    seen.add(url.href);
    const title = typeof row.title === 'string' ? row.title.trim().slice(0, 256) : '';
    result.push({ url: url.href, title: title || url.hostname, at: Number.isFinite(row.at) && row.at > 0 ? Math.floor(row.at) : Date.now() });
    if (result.length >= limit) break;
  }
  return result;
}

export function createBrowserBookmarkExport(bookmarks, exportedAt = Date.now()) {
  if (!Array.isArray(bookmarks)) throw new TypeError('Bookmarks must be an array.');
  const clean = sanitizeBrowserBookmarkImport({
    format: 'eya-browser-bookmarks', version: 1,
    bookmarks: bookmarks.slice(0, MAX_BOOKMARKS).map(item => ({ url: item?.url, title: item?.title, at: item?.at })),
  });
  return { format: 'eya-browser-bookmarks', version: 1, exportedAt: Number.isFinite(exportedAt) ? Math.floor(exportedAt) : Date.now(), bookmarks: clean };
}

export function boundDevtoolsSource(text, maxBytes = MAX_DEVTOOLS_SOURCE_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Source byte limit must be a non-negative safe integer.');
  const source = String(text ?? '');
  let byteLength = 0, end = 0;
  for (const character of source) {
    const point = character.codePointAt(0);
    const bytes = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (byteLength + bytes > maxBytes) break;
    byteLength += bytes;
    end += character.length;
  }
  return { text: source.slice(0, end), bytes: byteLength, truncated: end < source.length };
}

export function findSourceMatchRanges(source, query, maxMatches = 1000) {
  const text = String(source ?? '');
  const needle = String(query ?? '').trim();
  if (!Number.isSafeInteger(maxMatches) || maxMatches < 1) throw new RangeError('Source match limit must be a positive safe integer.');
  if (!needle || needle.length > 256) return { matches: [], truncated: false };
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped, 'giu');
  const matches = [];
  let match;
  while ((match = pattern.exec(text))) {
    if (matches.length >= maxMatches) return { matches, truncated: true };
    matches.push({ from: match.index, to: match.index + match[0].length });
  }
  return { matches, truncated: false };
}

export function appendNetworkCaptureChunk(state, value, totalUsed, entryLimit = MAX_NETWORK_CAPTURE_ENTRY_BYTES, totalLimit = MAX_NETWORK_CAPTURE_TOTAL_BYTES) {
  if (!state || !Array.isArray(state.chunks) || !Number.isSafeInteger(state.bytes) || state.bytes < 0 || !Number.isSafeInteger(totalUsed) || totalUsed < 0) {
    throw new TypeError('Invalid Network capture state.');
  }
  const input = value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : null;
  if (!input) throw new TypeError('Network capture chunks must be bytes.');
  if (![entryLimit, totalLimit].every(limit => Number.isSafeInteger(limit) && limit >= 0)) throw new RangeError('Network capture limits must be non-negative safe integers.');
  const available = Math.max(0, Math.min(entryLimit - state.bytes, totalLimit - totalUsed));
  const size = Math.min(input.byteLength, available);
  if (size) { state.chunks.push(input.slice(0, size)); state.bytes += size; }
  if (size < input.byteLength) state.truncated = true;
  return totalUsed + size;
}

export function finishNetworkCapture(state, contentType = '', maxChars = MAX_NETWORK_BODY_PREVIEW_CHARS) {
  if (!state || !Array.isArray(state.chunks) || !Number.isSafeInteger(state.bytes) || state.bytes < 0) throw new TypeError('Invalid Network capture state.');
  const bytes = new Uint8Array(state.bytes); let offset = 0;
  for (const chunk of state.chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const type = String(contentType).split(';', 1)[0].trim().toLowerCase();
  const textLike = type.startsWith('text/') || /^(?:application\/(?:json|[^;]+\+json|xml|[^;]+\+xml|javascript|x-javascript|ecmascript|x-www-form-urlencoded)|image\/svg\+xml)$/.test(type);
  if (!textLike) return { bytes, text: '', textLike: false, truncated: state.truncated === true };
  const decoded = new TextDecoder().decode(bytes);
  let text = decoded;
  if (/json$/.test(type)) { try { text = JSON.stringify(JSON.parse(decoded), null, 2); } catch { /* Keep malformed JSON visible as received. */ } }
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… [preview truncated]`;
  return { bytes, text, textLike: true, truncated: state.truncated === true };
}

export function safeDownloadFilename(disposition, rawUrl, suggested = '') {
  let candidate = String(suggested || '').trim();
  if (!candidate) {
    const value = String(disposition || '');
    const extended = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    const plain = value.match(/filename\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/i);
    const encoded = extended?.[1]?.trim().replace(/^"|"$/g, '');
    try { candidate = encoded ? decodeURIComponent(encoded) : ''; } catch { candidate = ''; }
    candidate ||= plain?.[1] ?? plain?.[2] ?? plain?.[3] ?? '';
  }
  if (!candidate) {
    try { candidate = decodeURIComponent(new URL(rawUrl).pathname.split('/').filter(Boolean).at(-1) || 'download'); }
    catch { candidate = 'download'; }
  }
  candidate = candidate.split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim().replace(/^\.+$/, '');
  return [...candidate].slice(0, 180).join('') || 'download';
}

const HAR_SECRET_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie|.*(?:access[_-]?token|auth|api[_-]?key|credential|jwt|password|secret|session|signature|token).*)$/i;
const HAR_SECRET_QUERY = /(?:^|[_-])(?:access[_-]?token|api[_-]?key|auth|authorization|code|credential|jwt|key|password|secret|session(?:id)?|signature|sig|token)(?:$|[_-])/i;
export function buildHarLog(tab, now = Date.now()) {
  const entries = (Array.isArray(tab?.network) ? tab.network : []).map(row => {
    const duration = Number.isFinite(row.duration) ? Math.max(0, row.duration) : 0;
    const requestHeaders = (Array.isArray(row.requestHeaders) ? row.requestHeaders : []).map(([name, value]) => ({ name: String(name), value: HAR_SECRET_HEADER.test(String(name)) ? '[redacted]' : String(value) }));
    const responseHeaders = (Array.isArray(row.responseHeaders) ? row.responseHeaders : []).map(([name, value]) => ({ name: String(name), value: HAR_SECRET_HEADER.test(String(name)) ? '[redacted]' : String(value) }));
    let url = String(row.url || '');
    let queryString = [];
    try {
      const parsed = new URL(url); parsed.hash = '';
      queryString = [...parsed.searchParams.entries()].map(([name, value]) => ({ name, value: HAR_SECRET_QUERY.test(name) ? '[redacted]' : value }));
      for (const [name] of [...parsed.searchParams]) if (HAR_SECRET_QUERY.test(name)) parsed.searchParams.set(name, '[redacted]');
      url = parsed.href;
    } catch { /* The Network panel may contain a rejected malformed target. */ }
    const responseSize = Number.isFinite(row.bytes) ? Math.max(0, row.bytes) : 0;
    const responseType = responseHeaders.find(header => header.name.toLowerCase() === 'content-type')?.value || '';
    const status = Number.isInteger(row.status) ? row.status : 0;
    const started = Number.isFinite(row.startedAt) ? row.startedAt : now - duration;
    return {
      startedDateTime: new Date(started).toISOString(), time: duration,
      request: { method: String(row.method || 'GET'), url, httpVersion: '', cookies: [], headers: requestHeaders, queryString, headersSize: -1, bodySize: Number.isFinite(row.requestBytes) ? row.requestBytes : -1 },
      response: { status, statusText: '', httpVersion: '', cookies: [], headers: responseHeaders, content: { size: responseSize, mimeType: responseType }, redirectURL: '', headersSize: -1, bodySize: responseSize },
      cache: { beforeRequest: false, afterRequest: row.cacheHit === true, duringRequest: false },
      timings: { blocked: -1, dns: -1, connect: -1, send: 0, wait: duration, receive: 0, ssl: -1 },
      comment: row.blocked ? `Blocked: ${String(row.blocked).slice(0, 120)}` : '',
      _eya: { cacheHit: row.cacheHit === true, blocked: row.blocked || '', download: row.download === true, preflight: row.preflight === true, websocketState: row.websocketState || '' },
    };
  });
  return { log: { version: '1.2', creator: { name: 'Eya Browser', version: '1.0' }, pages: [], entries } };
}

const PERFORMANCE_NUMBER_FIELDS = ['startTime', 'duration', 'transferSize', 'encodedBodySize', 'decodedBodySize', 'domInteractive', 'domContentLoadedEventStart', 'domContentLoadedEventEnd', 'loadEventStart', 'loadEventEnd', 'responseStart', 'responseEnd', 'value'];
export function sanitizePerformanceEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const result = { entryType: String(entry.entryType || '').slice(0, 32), name: String(entry.name || '').slice(0, 512) };
  try { const url = new URL(result.name); if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) { url.username = ''; url.password = ''; url.search = ''; url.hash = ''; result.name = url.href; } } catch { /* Performance names may be marks rather than URLs. */ }
  for (const key of PERFORMANCE_NUMBER_FIELDS) if (Number.isFinite(entry[key])) result[key] = Math.max(0, entry[key]);
  for (const key of ['initiatorType', 'nextHopProtocol']) if (typeof entry[key] === 'string') result[key] = entry[key].slice(0, 64);
  if (typeof entry.hadRecentInput === 'boolean') result.hadRecentInput = entry.hadRecentInput;
  return result;
}
export function sanitizePerformanceMemory(memory) {
  if (!memory || typeof memory !== 'object') return null;
  const result = {};
  for (const key of ['usedJSHeapSize', 'totalJSHeapSize', 'jsHeapSizeLimit']) if (Number.isFinite(memory[key]) && memory[key] >= 0) result[key] = memory[key];
  return Object.keys(result).length ? result : null;
}

export function sanitizeStorageItems(items, maxBytes = MAX_STORAGE_AREA_BYTES) {
  if (!Array.isArray(items) || !Number.isSafeInteger(maxBytes) || maxBytes < 0) return [];
  const clean = new Map(); let total = 0;
  for (const row of items.slice(0, MAX_STORAGE_ITEMS)) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string') continue;
    const key = row[0], value = row[1];
    if (key.length > 4096 || value.length > MAX_STORAGE_AREA_BYTES) continue;
    const bytes = new TextEncoder().encode(key).byteLength + new TextEncoder().encode(value).byteLength;
    const previous = clean.has(key) ? new TextEncoder().encode(key).byteLength + new TextEncoder().encode(clean.get(key)).byteLength : 0;
    if (total - previous + bytes > maxBytes) continue;
    clean.set(key, value); total = total - previous + bytes;
  }
  return [...clean.entries()];
}

export function createConsoleCommandHistory(limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Console history limit must be a positive safe integer.');
  const commands = [];
  let cursor = 0, draft = '';
  return {
    add(value) {
      const command = String(value ?? '').trim();
      if (!command) return;
      if (commands.at(-1) !== command) commands.push(command);
      if (commands.length > limit) commands.splice(0, commands.length - limit);
      cursor = commands.length; draft = '';
    },
    move(direction, current = '') {
      if (direction !== -1 && direction !== 1) return String(current ?? '');
      if (direction < 0 && cursor === commands.length) draft = String(current ?? '');
      cursor = Math.max(0, Math.min(commands.length, cursor + direction));
      return cursor === commands.length ? draft : commands[cursor];
    },
    clear() { commands.length = 0; cursor = 0; draft = ''; },
    get size() { return commands.length; },
  };
}

function workerXmlHttpRequestSource() {
  return String.raw`class EyaWorkerXMLHttpRequest extends EventTarget {
    constructor(){super();this.readyState=0;this.status=0;this.statusText='';this.responseURL='';this.timeout=0;this.withCredentials=false;this.upload=new EventTarget();this._requestHeaders=new Headers();this._responseHeaders=new Headers();this._controller=null;this._sent=false;this._timedOut=false;this._generation=0;this._text='';this._response=null;this._method='GET';this._url='';this._responseType='';}
    get responseType(){return this._responseType}
    set responseType(value){if(this.readyState===3||this.readyState===4)throw new DOMException('Response type cannot change while loading.','InvalidStateError');const type=String(value);if(!['','text','json','arraybuffer','blob'].includes(type))throw new DOMException('Unsupported Worker XHR response type.','NotSupportedError');this._responseType=type}
    get response(){return this._response}
    get responseText(){if(this._responseType!==''&&this._responseType!=='text')throw new DOMException('responseText is unavailable for this response type.','InvalidStateError');return this._text}
    _emit(type,event=new Event(type)){this.dispatchEvent(event);if(typeof this['on'+type]==='function')this['on'+type](event)}
    _change(state){this.readyState=state;this._emit('readystatechange')}
    open(method,url,async=true){if(async===false)throw new DOMException('Synchronous XHR is not supported in proxied Workers.','NotSupportedError');if(this._controller&&!this._controller.signal.aborted)this._controller.abort();this._generation++;this._method=String(method).toUpperCase();this._url=new URL(String(url),base).href;this._requestHeaders=new Headers();this._responseHeaders=new Headers();this._sent=false;this._timedOut=false;this.status=0;this.statusText='';this.responseURL='';this._text='';this._response=null;this._change(1)}
    setRequestHeader(name,value){if(this.readyState!==1||this._sent)throw new DOMException('Invalid XHR state.','InvalidStateError');this._requestHeaders.append(name,value)}
    overrideMimeType(value){if(this._sent)throw new DOMException('Invalid XHR state.','InvalidStateError');this._mimeType=String(value)}
    getResponseHeader(name){return this.readyState<2?null:this._responseHeaders.get(String(name))}
    getAllResponseHeaders(){return this.readyState<2?'':[...this._responseHeaders].map(([name,value])=>name+': '+value+'\r\n').join('')}
    send(body=null){if(this.readyState!==1||this._sent)throw new DOMException('Invalid XHR state.','InvalidStateError');this._sent=true;this._timedOut=false;const generation=this._generation,controller=new AbortController();this._controller=controller;this._emit('loadstart');const timeout=Number(this.timeout),timer=Number.isFinite(timeout)&&timeout>0?setTimeout(()=>{if(generation===this._generation){this._timedOut=true;controller.abort(new DOMException('Worker XHR timed out.','TimeoutError'))}},Math.min(timeout,120000)):null;proxiedFetch(this._url,{method:this._method,headers:this._requestHeaders,body,signal:controller.signal,credentials:this.withCredentials?'include':'same-origin',mode:'cors'}).then(async response=>{if(generation!==this._generation)return;this.status=response.status;this.statusText=response.statusText;this.responseURL=response.url||this._url;this._responseHeaders=response.headers;this._change(2);this._change(3);const bytes=new Uint8Array(await response.arrayBuffer());if(generation!==this._generation)return;this._text=new TextDecoder().decode(bytes);const type=this._responseType;if(type==='arraybuffer')this._response=bytes.buffer;else if(type==='blob')this._response=new Blob([bytes],{type:response.headers.get('content-type')||''});else if(type==='json'){try{this._response=JSON.parse(this._text)}catch{this._response=null}}else this._response=this._text;this._change(4);this._emit('load');this._emit('loadend')}).catch(error=>{if(generation!==this._generation)return;this.status=0;this.statusText='';if(this._timedOut){this._change(4);this._emit('timeout')}else if(error?.name==='AbortError'){this._change(4);this._emit('abort')}else{this._change(4);this._emit('error')}this._emit('loadend')}).finally(()=>{if(timer!==null)clearTimeout(timer)})}
    abort(){if(!this._controller||this._controller.signal.aborted||this.readyState===0||this.readyState===4)return;this._generation++;this._timedOut=false;this._controller.abort();this.status=0;this.statusText='';this._text='';this._response=null;this._change(0);this._emit('abort');this._emit('loadend');this._sent=false}
  }
  EyaWorkerXMLHttpRequest.UNSENT=0;EyaWorkerXMLHttpRequest.OPENED=1;EyaWorkerXMLHttpRequest.HEADERS_RECEIVED=2;EyaWorkerXMLHttpRequest.LOADING=3;EyaWorkerXMLHttpRequest.DONE=4;
  for(const [name,value] of Object.entries({UNSENT:0,OPENED:1,HEADERS_RECEIVED:2,LOADING:3,DONE:4}))EyaWorkerXMLHttpRequest.prototype[name]=value;
  Object.defineProperty(self,'XMLHttpRequest',{configurable:true,writable:true,value:EyaWorkerXMLHttpRequest});`;
}

function workerBootstrapSource() {
  const xhrSource = workerXmlHttpRequestSource();
  return String.raw`(()=>{
    const stopImmediate=Function.prototype.call.bind(Event.prototype.stopImmediatePropagation);
    let bridge=null,base='',booting=true,initSeen=false,nextId=0,nativeImportScripts=null;
    const pending=new Map(),earlyMessages=[];let workerSources=new Map();
    const fail=(error)=>{self.postMessage({type:'eya-worker-error',error:String(error&&error.message||error).slice(0,1024)})};
    const readBody=async body=>{if(body==null)return new Uint8Array();const reader=new Response(body).body.getReader(),chunks=[];let size=0;for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>4*1024*1024){await reader.cancel();throw new TypeError('Worker request body exceeds the 4 MiB proxy limit.')}chunks.push(part.value)}const output=new Uint8Array(size);let offset=0;for(const part of chunks){output.set(part,offset);offset+=part.byteLength}return output};
    const proxiedFetch=async(input,init={})=>{
      if(!bridge)throw new TypeError('Worker proxy is not ready.');
      let target=input instanceof Request?input.url:String(input);target=new URL(target,base).href;
      const request=input instanceof Request?new Request(input,init):new Request(target,init);target=request.url;const body=await readBody(request.body),id=++nextId,signal=request.signal;
      return await new Promise((resolve,reject)=>{
        const cleanup=()=>{pending.delete(id);signal&&signal.removeEventListener('abort',abort)};
        const abort=()=>{if(!pending.has(id))return;cleanup();try{bridge.postMessage({type:'fetch-cancel',id})}catch{}reject(new DOMException('The operation was aborted.','AbortError'))};
        pending.set(id,{resolve,reject,cleanup,method:request.method});
        if(signal){if(signal.aborted){abort();return}signal.addEventListener('abort',abort,{once:true})}
        try{bridge.postMessage({type:'fetch',id,url:target,method:request.method,headers:[...request.headers],body:body.buffer,credentials:request.credentials,mode:request.mode},[body.buffer])}catch(error){cleanup();reject(error)}
      });
    };
    Object.defineProperty(self,'fetch',{configurable:true,writable:true,value:proxiedFetch});
    ${xhrSource}
    self.addEventListener('message',event=>{
      const message=event.data;
      if(message&&message.type==='eya-init'&&!initSeen){initSeen=true;base=String(message.base||'');bridge=event.ports[0]||null;if(!bridge){fail('Missing worker proxy channel');return}bridge.onmessage=bridgeEvent=>{const response=bridgeEvent.data;if(!response||response.type!=='fetch-response'||!Number.isSafeInteger(response.id))return;const entry=pending.get(response.id);if(!entry)return;entry.cleanup();if(response.error){entry.reject(new TypeError(String(response.error).slice(0,1024)));return}try{if(response.opaque){const opaque=new Response(null);Object.defineProperties(opaque,{type:{value:'opaque'},status:{value:0},ok:{value:false},headers:{value:new Headers()}});entry.resolve(opaque);return}const status=Number(response.status)||200,noBody=entry.method==='HEAD'||[204,205,304].includes(status),result=new Response(noBody?null:response.body?new Uint8Array(response.body):null,{status,statusText:String(response.statusText||''),headers:Array.isArray(response.headers)?response.headers:[]});if(typeof response.url==='string')Object.defineProperty(result,'url',{value:response.url});entry.resolve(result)}catch(error){entry.reject(error)}};bridge.start?.();stopImmediate(event);return}
      if(message&&message.type==='eya-source'&&initSeen&&booting){try{if(typeof message.source!=='string')throw Error('Invalid worker script');if(typeof message.base==='string')base=message.base;workerSources=new Map(Object.entries(message.sources||{}));workerSources.set(base,message.source);nativeImportScripts=self.importScripts.bind(self);self.importScripts=(...urls)=>{for(const specifier of urls){const resolved=new URL(String(specifier),base).href,source=workerSources.get(resolved);if(typeof source!=='string')throw new TypeError('Worker import was not preloaded through the proxy.');const dependency=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));try{nativeImportScripts(dependency)}finally{URL.revokeObjectURL(dependency)}}};const blob=URL.createObjectURL(new Blob([message.source],{type:'text/javascript'}));try{nativeImportScripts(blob)}finally{URL.revokeObjectURL(blob)}booting=false;self.postMessage({type:'eya-worker-ready'});for(const data of earlyMessages)self.dispatchEvent(new MessageEvent('message',{data}));earlyMessages.length=0}catch(error){fail(error)}stopImmediate(event);return}
      if(message&&message.type==='eya-source-error'&&booting){fail(message.error||'Worker script could not be loaded');stopImmediate(event);return}
      if(booting){earlyMessages.push(message);stopImmediate(event)}
    },true);
  })();`;
}

function moduleWorkerBootstrapSource() {
  const xhrSource = workerXmlHttpRequestSource();
  return String.raw`(()=>{
    const stopImmediate=Function.prototype.call.bind(Event.prototype.stopImmediatePropagation);
    let bridge=null,base='',booting=true,initSeen=false,nextId=0;
    const pending=new Map(),earlyMessages=[];
    const fail=(error)=>{self.postMessage({type:'eya-worker-error',error:String(error&&error.message||error).slice(0,1024)})};
    const readBody=async body=>{if(body==null)return new Uint8Array();const reader=new Response(body).body.getReader(),chunks=[];let size=0;for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>4*1024*1024){await reader.cancel();throw new TypeError('Worker request body exceeds the 4 MiB proxy limit.')}chunks.push(part.value)}const output=new Uint8Array(size);let offset=0;for(const part of chunks){output.set(part,offset);offset+=part.byteLength}return output};
    const proxiedFetch=async(input,init={})=>{
      if(!bridge)throw new TypeError('Worker proxy is not ready.');
      let target=input instanceof Request?input.url:String(input);target=new URL(target,base).href;
      const request=input instanceof Request?new Request(input,init):new Request(target,init);target=request.url;const body=await readBody(request.body),id=++nextId,signal=request.signal;
      return await new Promise((resolve,reject)=>{
        const cleanup=()=>{pending.delete(id);signal&&signal.removeEventListener('abort',abort)};
        const abort=()=>{if(!pending.has(id))return;cleanup();try{bridge.postMessage({type:'fetch-cancel',id})}catch{}reject(new DOMException('The operation was aborted.','AbortError'))};
        pending.set(id,{resolve,reject,cleanup,method:request.method});
        if(signal){if(signal.aborted){abort();return}signal.addEventListener('abort',abort,{once:true})}
        try{bridge.postMessage({type:'fetch',id,url:target,method:request.method,headers:[...request.headers],body:body.buffer,credentials:request.credentials,mode:request.mode},[body.buffer])}catch(error){cleanup();reject(error)}
      });
    };
    Object.defineProperty(self,'fetch',{configurable:true,writable:true,value:proxiedFetch});
    ${xhrSource}
    self.addEventListener('message',async event=>{
      const message=event.data;
      if(message&&message.type==='eya-init'&&!initSeen){initSeen=true;base=String(message.base||'');bridge=event.ports[0]||null;if(!bridge){fail('Missing worker proxy channel');return}bridge.onmessage=bridgeEvent=>{const response=bridgeEvent.data;if(!response||response.type!=='fetch-response'||!Number.isSafeInteger(response.id))return;const entry=pending.get(response.id);if(!entry)return;entry.cleanup();if(response.error){entry.reject(new TypeError(String(response.error).slice(0,1024)));return}try{if(response.opaque){const opaque=new Response(null);Object.defineProperties(opaque,{type:{value:'opaque'},status:{value:0},ok:{value:false},headers:{value:new Headers()}});entry.resolve(opaque);return}const status=Number(response.status)||200,noBody=entry.method==='HEAD'||[204,205,304].includes(status),result=new Response(noBody?null:response.body?new Uint8Array(response.body):null,{status,statusText:String(response.statusText||''),headers:Array.isArray(response.headers)?response.headers:[]});if(typeof response.url==='string')Object.defineProperty(result,'url',{value:response.url});entry.resolve(result)}catch(error){entry.reject(error)}};bridge.start?.();stopImmediate(event);return}
      if(message&&message.type==='eya-source'&&initSeen&&booting){const objectUrls=[];try{if(typeof message.source!=='string'||!Array.isArray(message.order)||!message.modules)throw Error('Invalid worker module graph');if(typeof message.base==='string')base=message.base;const urls=new Map();for(const moduleUrl of message.order){const record=message.modules[moduleUrl];if(!record||typeof record.source!=='string'||!Array.isArray(record.imports))throw Error('Invalid worker module record');let source=record.source;const replacements=record.imports.map(edge=>{const dependency=urls.get(edge.url);if(!dependency)throw Error('Worker module dependency order is invalid.');return{from:edge.from,to:edge.to,text:JSON.stringify(dependency)}});for(const replacement of replacements.sort((a,b)=>b.from-a.from))source=source.slice(0,replacement.from)+replacement.text+source.slice(replacement.to);const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));urls.set(moduleUrl,url);objectUrls.push(url)}await import(urls.get(base));booting=false;self.postMessage({type:'eya-worker-ready'});for(const data of earlyMessages)self.dispatchEvent(new MessageEvent('message',{data}));earlyMessages.length=0}catch(error){fail(error)}finally{for(const url of objectUrls)URL.revokeObjectURL(url)}stopImmediate(event);return}
      if(message&&message.type==='eya-source-error'&&booting){fail(message.error||'Worker module graph could not be loaded');stopImmediate(event);return}
      if(booting){earlyMessages.push(message);stopImmediate(event)}
    },true);
  })();`;
}

export function buildDedicatedWorkerRuntime() { return workerBootstrapSource(); }
export function buildModuleWorkerRuntime() { return moduleWorkerBootstrapSource(); }

export function browserFrameCsp() {
  return "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:; worker-src blob:; style-src 'unsafe-inline' blob: data:; img-src blob: data:; font-src blob: data:; media-src blob: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'";
}

export function proxyNavigationAvailable(browserWindow = globalThis.window) {
  return typeof browserWindow?.navigation?.addEventListener === 'function';
}

export function remoteViewportPoint(bounds, viewport, clientX, clientY) {
  if (!(bounds.width > 0 && bounds.height > 0 && viewport.width > 0 && viewport.height > 0)) return null;
  const scale = Math.min(bounds.width / viewport.width, bounds.height / viewport.height);
  const left = bounds.left + (bounds.width - viewport.width * scale) / 2;
  const top = bounds.top + (bounds.height - viewport.height * scale) / 2;
  const rawX = (clientX - left) / scale, rawY = (clientY - top) / scale;
  return { x: Math.max(0, Math.min(viewport.width, rawX)), y: Math.max(0, Math.min(viewport.height, rawY)), scale: 1 / scale,
    inside: rawX >= 0 && rawX <= viewport.width && rawY >= 0 && rawY <= viewport.height };
}

export function scanCssResourceMatches(css, expression) {
  const found = []; let cursor = 0, quote = '', comment = false;
  for (const match of css.matchAll(expression)) {
    while (cursor < match.index) {
      const char = css[cursor++], next = css[cursor];
      if (comment) { if (char === '*' && next === '/') { comment = false; cursor++; } }
      else if (quote) { if (char === '\\') cursor++; else if (char === quote) quote = ''; }
      else if (char === '/' && next === '*') { comment = true; cursor++; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '\\') cursor++;
    }
    if (comment || quote) continue;
    if (found.length >= 256) throw Error('Stylesheet has too many resource references.');
    found.push(match);
  }
  return found;
}

export function rewriteLocationNavigations(value) {
  const source = String(value ?? '');
  if (source.length > MAX_NAVIGATION_REWRITE_BYTES || !/\b(?:location|(?:window|self|globalThis|document)\s*\.\s*location)\s*(?:\.|=)/.test(source)) return source;
  const tree = javascriptParser.parse(source);
  const shadowed = new Set();
  const walk = visitor => {
    const cursor = tree.cursor();
    const visit = () => {
      visitor(cursor.node, cursor.name);
      if (cursor.firstChild()) {
        do { visit(); } while (cursor.nextSibling());
        cursor.parent();
      }
    };
    visit();
  };
  walk((node, name) => {
    if (name === 'VariableDefinition') {
      const binding = source.slice(node.from, node.to);
      if (['location', 'window', 'self', 'globalThis', 'document'].includes(binding)) shadowed.add(binding);
    }
  });
  // Generated calls use the global window binding. A local binding anywhere
  // makes that identifier unsafe without scope-aware rewriting.
  if (shadowed.has('window')) return source;
  const children = node => {
    const values = [];
    for (let child = node?.firstChild; child; child = child.nextSibling) values.push(child);
    return values;
  };
  const memberParts = node => {
    if (node?.name !== 'MemberExpression') return null;
    const parts = children(node).filter(child => child.name !== '.' && child.name !== '?.');
    return parts.length === 2 ? parts : null;
  };
  const globalLocation = node => {
    if (node?.name === 'VariableName') {
      const name = source.slice(node.from, node.to);
      return name === 'location' && !shadowed.has(name);
    }
    const parts = memberParts(node);
    if (!parts || source.slice(parts[1].from, parts[1].to) !== 'location' || parts[0].name !== 'VariableName') return false;
    const root = source.slice(parts[0].from, parts[0].to);
    return ['window', 'self', 'globalThis', 'document'].includes(root) && !shadowed.has(root);
  };
  const edits = [];
  walk(node => {
    if (node.name === 'AssignmentExpression') {
      const parts = children(node);
      if (parts.length < 3 || parts[1].name !== 'Equals') return;
      const left = parts[0];
      const right = parts.at(-1);
      const member = memberParts(left);
      const isLocationAssignment = globalLocation(left) || (member && source.slice(member[1].from, member[1].to) === 'href' && globalLocation(member[0]));
      if (isLocationAssignment) edits.push({ from: node.from, to: node.to, innerFrom: right.from, innerTo: right.to, prefix: `((v)=>(window.__eyaNavigate(v,'push'),v))((`, suffix: '))' });
    } else if (node.name === 'CallExpression') {
      const parts = children(node);
      const callee = parts[0], args = parts.find(part => part.name === 'ArgList'), member = memberParts(callee);
      if (!member || !globalLocation(member[0])) return;
      const method = source.slice(member[1].from, member[1].to);
      if (!['assign', 'replace', 'reload'].includes(method)) return;
      if (!args) return;
      const history = method === 'replace' ? 'replace' : method === 'reload' ? 'reload' : 'push';
      const target = method === 'reload' ? 'undefined' : 'a[0]';
      const required = method === 'reload' ? '' : `if(!a.length)throw new TypeError('Location.${method} requires an argument');`;
      edits.push({ from: node.from, to: node.to, innerFrom: args.from + 1, innerTo: args.to - 1, prefix: `((...a)=>{${required}window.__eyaNavigate(${target},'${history}')})(`, suffix: ')' });
    }
  });
  edits.sort((a, b) => a.from - b.from || b.to - a.to);
  const roots = [], stack = [];
  for (const edit of edits) {
    edit.children = [];
    while (stack.length && edit.from >= stack.at(-1).to) stack.pop();
    if (stack.length) stack.at(-1).children.push(edit); else roots.push(edit);
    stack.push(edit);
  }
  const render = (from, to, nodes) => {
    let result = '', offset = from;
    for (const node of nodes) {
      if (node.from < offset || node.to > to) continue;
      result += source.slice(offset, node.from) + node.prefix + render(node.innerFrom, node.innerTo, node.children) + node.suffix;
      offset = node.to;
    }
    return result + source.slice(offset, to);
  };
  return render(0, source.length, roots);
}

export function parseClassicWorkerImports(source, baseUrl) {
  const text = String(source ?? '');
  const base = new URL(baseUrl);
  const calls = [];
  let error = '';
  const tree = javascriptParser.parse(text);
  const cursor = tree.cursor();
  const visit = () => {
    if (error) return;
    if (cursor.name === 'CallExpression') {
      const node = cursor.node;
      const callee = node.firstChild;
      const member = node.getChild('MemberExpression');
      const isImportScripts = callee?.name === 'VariableName'
        ? text.slice(callee.from, callee.to) === 'importScripts'
        : member && /(?:^|\.)importScripts$/.test(text.slice(member.from, member.to));
      if (isImportScripts) {
        const args = node.getChild('ArgList');
        const values = [];
        for (let arg = args?.firstChild; arg; arg = arg.nextSibling) {
          if (['(', ')', ',', 'LineComment', 'BlockComment'].includes(arg.name)) continue;
          const raw = text.slice(arg.from, arg.to);
          if (arg.name !== 'String' || !/^(['"])[^\\\r\n]*\1$/.test(raw)) {
            error = 'Worker importScripts() requires static string URLs.';
            return;
          }
          const specifier = raw.slice(1, -1);
          let resolved;
          try { resolved = new URL(specifier, base); }
          catch { error = 'Worker importScripts() contains an invalid URL.'; return; }
          if (!['http:', 'https:'].includes(resolved.protocol) || resolved.origin !== base.origin || resolved.username || resolved.password) {
            error = 'Worker imports must stay on the worker origin.';
            return;
          }
          values.push(resolved.href);
        }
        if (values.length) calls.push({ from: args.from, to: args.to, urls: values });
      }
    }
    if (cursor.firstChild()) {
      do { visit(); } while (cursor.nextSibling());
      cursor.parent();
    }
  };
  visit();
  return { calls, error };
}

export function parseModuleWorkerImports(source, baseUrl) {
  const text = String(source ?? '');
  const base = new URL(baseUrl);
  const imports = [];
  let error = '';
  const tree = javascriptParser.parse(text);
  const cursor = tree.cursor();
  const visit = () => {
    if (error) return;
    if (cursor.name === '⚠') {
      error = 'Worker module uses unsupported JavaScript syntax or import attributes.';
      return;
    }
    if (cursor.name === 'ImportMeta') {
      error = 'Worker modules using import.meta are not supported by the blob proxy.';
      return;
    }
    if (cursor.name === 'DynamicImport') {
      error = 'Dynamic import() is not supported in proxied worker modules.';
      return;
    }
    if (cursor.name === 'ImportDeclaration' || cursor.name === 'ExportDeclaration') {
      const literal = cursor.node.getChild('String');
      if (literal) {
        const raw = text.slice(literal.from, literal.to);
        if (!/^(['"])[^\\\r\n]*\1$/.test(raw)) {
          error = 'Worker module specifiers must be plain string literals.';
          return;
        }
        const specifier = raw.slice(1, -1);
        if (!/^(?:\.{1,2}\/|\/|[a-z][a-z\d+.-]*:)/i.test(specifier)) {
          error = 'Bare worker module specifiers are not supported.';
          return;
        }
        let resolved;
        try { resolved = new URL(specifier, base); }
        catch { error = 'Worker module contains an invalid import URL.'; return; }
        if (!['http:', 'https:'].includes(resolved.protocol) || resolved.origin !== base.origin || resolved.username || resolved.password) {
          error = 'Worker module imports must stay on the worker origin.';
          return;
        }
        imports.push({ from: literal.from, to: literal.to, url: resolved.href });
      }
    }
    if (cursor.firstChild()) {
      do { visit(); } while (cursor.nextSibling());
      cursor.parent();
    }
  };
  visit();
  return { imports, error };
}

export function orderWorkerModuleGraph(modules, entryUrl) {
  const order = [], visited = new Set(), visiting = new Set();
  const visit = url => {
    if (visited.has(url)) return;
    if (visiting.has(url)) throw Error('Cyclic worker module imports are not supported.');
    const record = modules?.[url];
    if (!record || !Array.isArray(record.imports)) throw Error('Worker module import graph is incomplete.');
    visiting.add(url);
    for (const dependency of record.imports) visit(dependency.url);
    visiting.delete(url); visited.add(url); order.push(url);
  };
  visit(entryUrl);
  return order;
}

export function createResourceBudget({ maxConcurrent = MAX_BUFFERED_STATIC_LOADS, maxBytes = MAX_RETAINED_STATIC_BYTES } = {}) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Resource budget limits must be non-negative safe integers, with at least one concurrent slot.');
  let active = 0, activeLowPriority = 0, retained = 0, reserved = 0;
  const waiting = [];
  const lowPriorityLimit = maxConcurrent > 1 ? maxConcurrent - 1 : maxConcurrent;
  const canStart = priority => active < maxConcurrent && (priority || activeLowPriority < lowPriorityLimit);
  const drain = () => {
    while (waiting.length) {
      const index = waiting.findIndex(entry => canStart(entry.priority));
      if (index < 0) return;
      const entry = waiting.splice(index, 1)[0];
      entry.signal?.removeEventListener('abort', entry.abort);
      if (entry.signal?.aborted) { entry.reject(entry.signal.reason || Error('Resource load cancelled.')); continue; }
      active++; if (!entry.priority) activeLowPriority++;
      entry.resolve(makeSlotRelease(entry.priority));
    }
  };
  const makeSlotRelease = priority => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      if (!priority) activeLowPriority--;
      drain();
    };
  };
  return {
    acquire(signal, { priority = false } = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason || Error('Resource load cancelled.'));
      if (canStart(priority)) { active++; if (!priority) activeLowPriority++; return Promise.resolve(makeSlotRelease(priority)); }
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, signal, priority, abort: null };
        entry.abort = () => {
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
          reject(signal.reason || Error('Resource load cancelled.'));
        };
        signal?.addEventListener('abort', entry.abort, { once: true });
        const index = priority ? waiting.findIndex(item => !item.priority) : -1;
        if (index < 0) waiting.push(entry); else waiting.splice(index, 0, entry);
      });
    },
    retain(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes - retained - reserved) throw Error('This browser panel reached its static resource memory limit. Navigate or close a tab to release resources.');
      retained += bytes;
      let released = false;
      return () => { if (!released) { retained -= bytes; released = true; } };
    },
    reserve() {
      let bytes = 0, active = true;
      const release = () => {
        if (!active) return;
        reserved -= bytes; bytes = 0; active = false;
      };
      return {
        add(amount) {
          if (!active || !Number.isSafeInteger(amount) || amount < 0 || amount > maxBytes - retained - reserved) throw Error('This browser panel reached its static resource memory limit. Navigate or close a tab to release resources.');
          reserved += amount; bytes += amount;
        },
        release,
        commit(retainedBytes = bytes) {
          if (!active || !Number.isSafeInteger(retainedBytes) || retainedBytes < 0 || retainedBytes > bytes) throw Error('Resource reservation is no longer active or has an invalid retained size.');
          reserved -= bytes; retained += retainedBytes; active = false;
          let released = false;
          return () => { if (!released) { retained -= retainedBytes; released = true; } };
        },
      };
    },
    get active() { return active; },
    get retainedBytes() { return retained; },
    get reservedBytes() { return reserved; },
    get queued() { return waiting.length; },
  };
}

const FILTER_TYPES = new Set(['script', 'image', 'stylesheet', 'media', 'font', 'xmlhttprequest', 'object', 'subdocument', 'document', 'other', 'ping', 'websocket']);
function compileFilterPattern(pattern, matchCase = false, hostTail = false) {
  let text = pattern; let anchoredStart = hostTail; let anchoredEnd = false;
  if (!hostTail && text.startsWith('|')) { anchoredStart = true; text = text.slice(1); }
  if (text.endsWith('|')) { anchoredEnd = true; text = text.slice(0, -1); }
  const tokens = [];
  for (const char of text) {
    const token = char === '*' ? '*' : char === '^' ? '^' : matchCase ? char : char.toLowerCase();
    if (token !== '*' || tokens.at(-1) !== '*') tokens.push(token);
  }
  if (!anchoredStart) tokens.unshift('*');
  if (!anchoredEnd) tokens.push('*');
  const required = text.split(/[*^|]/).sort((a, b) => b.length - a.length)[0] || '';
  return { tokens, matchCase, required: matchCase ? required : required.toLowerCase() };
}

function matchesFilterPattern(pattern, value) {
  const text = pattern.matchCase ? value : value.toLowerCase();
  const tokens = pattern.tokens; let tokenIndex = 0, textIndex = 0, lastStar = -1, starTextIndex = 0;
  while (textIndex < text.length) {
    const token = tokens[tokenIndex]; const char = text[textIndex];
    if (token === '*' ) { lastStar = tokenIndex++; starTextIndex = textIndex; continue; }
    const matches = token === '^' ? !/[A-Za-z0-9_.%-]/.test(char) : token === char;
    if (matches) { tokenIndex++; textIndex++; continue; }
    if (lastStar >= 0) { tokenIndex = lastStar + 1; textIndex = ++starTextIndex; continue; }
    return false;
  }
  while (tokens[tokenIndex] === '^' || tokens[tokenIndex] === '*') {
    if (tokens[tokenIndex] === '^' && textIndex < text.length) return false;
    tokenIndex++;
  }
  return tokenIndex === tokens.length;
}

function parseFilterOptions(raw) {
  const options = { types: [], excludedTypes: [], domains: [], excludedDomains: [], thirdParty: null, matchCase: false, important: false };
  for (const optionRaw of raw.split(',')) {
    const option = optionRaw.trim().toLowerCase(); if (!option) continue;
    if (option.startsWith('domain=')) {
      let valid = 0;
      for (const domainRaw of option.slice(7).split('|')) {
        const excluded = domainRaw.startsWith('~'); const domain = domainRaw.replace(/^~/, '').replace(/^\.+|\.+$/g, '');
        if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) return null;
        (excluded ? options.excludedDomains : options.domains).push(domain);
        valid++;
      }
      if (!valid) return null;
    } else if (['3p', 'third-party'].includes(option)) options.thirdParty = true;
    else if (['~3p', '~third-party'].includes(option)) options.thirdParty = false;
    else if (option === 'match-case') options.matchCase = true;
    else if (option === 'important') options.important = true;
    else {
      const excluded = option.startsWith('~'); const type = option.replace(/^~/, '');
      if (!FILTER_TYPES.has(type)) return null;
      (excluded ? options.excludedTypes : options.types).push(type);
    }
  }
  return options;
}

export function compileFilterList(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_FILTER_LIST_BYTES) throw Error('Filter lists are limited to 1 MiB.');
  const block = [], allow = [], blockHosts = new Map(), allowHosts = new Map(), hosts = new Set(), cosmeticHide = [], cosmeticAllow = []; let accepted = 0, genericCount = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    if (accepted >= 30000) break;
    const line = rawLine.trim(); if (!line || line.startsWith('!') || line.startsWith('[')) continue;
    const cosmetic = line.match(/^(.*?)#(@?)#(.*)$/);
    if (cosmetic) {
      if (cosmetic[3].startsWith('?') || cosmetic[3].startsWith('+') || cosmetic[3].startsWith('$')) continue;
      const selector = cosmetic[3].trim();
      if (!selector || selector.length > MAX_COSMETIC_SELECTOR_CHARS || /[\u0000-\u001f\u007f{};<>]|\/\*/.test(selector) || selector.includes('*/')) continue;
      const domains = [], excludedDomains = [];
      const domainText = cosmetic[1].trim();
      let valid = true;
      if (domainText) {
        const parts = domainText.split(',');
        if (parts.length > MAX_COSMETIC_DOMAINS) continue;
        for (const partRaw of parts) {
          const part = partRaw.trim().toLowerCase();
          const excluded = part.startsWith('~'); const domain = excluded ? part.slice(1) : part;
          if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) { valid = false; break; }
          (excluded ? excludedDomains : domains).push(domain);
        }
      }
      if (!valid || cosmeticHide.length + cosmeticAllow.length >= MAX_COSMETIC_FILTERS) continue;
      (cosmetic[2] ? cosmeticAllow : cosmeticHide).push({ selector, domains, excludedDomains });
      accepted++;
      continue;
    }
    if (/#[@?#]/.test(line)) continue;
    const hostFile = line.match(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s+(.+)$/i);
    if (hostFile) {
      for (const hostRaw of hostFile[1].split(/\s+/)) {
        if (accepted >= 30000) break;
        const host = hostRaw.toLowerCase().replace(/^\.+|\.+$/g, '');
        if (/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(host)) { hosts.add(host); accepted++; }
      }
      continue;
    }
    const exception = line.startsWith('@@'); const ruleText = exception ? line.slice(2) : line;
    const optionIndex = ruleText.lastIndexOf('$');
    const pattern = optionIndex < 0 ? ruleText : ruleText.slice(0, optionIndex);
    const options = optionIndex < 0 ? parseFilterOptions('') : parseFilterOptions(ruleText.slice(optionIndex + 1));
    if (!pattern || !options || pattern.length > MAX_FILTER_PATTERN_CHARS || (pattern.startsWith('/') && pattern.endsWith('/'))) continue;
    const hostAnchor = pattern.match(/^\|\|([a-z0-9.-]+)(.*)$/i);
    const host = hostAnchor?.[1]?.toLowerCase() || '';
    const tail = hostAnchor?.[2] || '';
    let matcher = null;
    if (!host || (tail && tail !== '^')) {
      if ((pattern.match(/\*/g)?.length || 0) > 8) continue;
      matcher = compileFilterPattern(host ? tail : pattern, options.matchCase, !!host);
      if (!matcher) continue;
      if (!host && (matcher.required.length < 3 || ++genericCount > MAX_GENERIC_FILTERS)) continue;
    }
    const rule = { host, matcher, ...options };
    if (host) {
      const map = exception ? allowHosts : blockHosts;
      if (!map.has(host)) map.set(host, []);
      if (map.get(host).length >= 128) continue;
      map.get(host).push(rule);
    } else (exception ? allow : block).push(rule);
    accepted++;
  }
  return { block, allow, blockHosts, allowHosts, hosts, cosmeticHide, cosmeticAllow, count: accepted };
}

function domainMatches(host, domain) { return host === domain || host.endsWith(`.${domain}`); }
function cosmeticRuleApplies(rule, host) {
  return (!rule.domains.length || rule.domains.some(domain => domainMatches(host, domain)))
    && !rule.excludedDomains.some(domain => domainMatches(host, domain));
}
export function cosmeticCssForPage(filters, pageUrl) {
  let host;
  try { host = new URL(pageUrl).hostname.toLowerCase(); } catch { return ''; }
  const exceptions = new Set((filters?.cosmeticAllow || []).filter(rule => cosmeticRuleApplies(rule, host)).map(rule => rule.selector));
  const selectors = new Set();
  for (const rule of filters?.cosmeticHide || []) {
    if (selectors.size >= MAX_PAGE_COSMETIC_FILTERS) break;
    if (cosmeticRuleApplies(rule, host) && !exceptions.has(rule.selector)) selectors.add(rule.selector);
  }
  let css = '', cssBytes = 0;
  for (const selector of selectors) {
    const rule = `${selector}{display:none!important}`;
    const ruleBytes = new TextEncoder().encode(rule).byteLength;
    if (ruleBytes > MAX_PAGE_COSMETIC_CSS_BYTES - cssBytes) break;
    css += rule; cssBytes += ruleBytes;
  }
  return css;
}
function someHostRule(index, host, predicate) {
  const labels = host.toLowerCase().split('.');
  for (let i = 0; i < labels.length; i++) {
    for (const rule of index.get(labels.slice(i).join('.')) || []) if (predicate(rule)) return true;
  }
  return false;
}
function filterRuleMatches(rule, url, pageHost, resourceType, lowerHref) {
  if (rule.host && !domainMatches(url.hostname.toLowerCase(), rule.host)) return false;
  if (rule.matcher) {
    const value = rule.host ? `${url.host.slice(url.hostname.length)}${url.pathname}${url.search}${url.hash}` : url.href;
    const normalized = rule.matcher.matchCase ? value : (rule.host ? value.toLowerCase() : lowerHref);
    if (rule.matcher.required && !normalized.includes(rule.matcher.required)) return false;
    if (!matchesFilterPattern(rule.matcher, value)) return false;
  }
  if (rule.types.length && !rule.types.includes(resourceType)) return false;
  if (rule.excludedTypes.includes(resourceType)) return false;
  const thirdParty = !domainMatches(url.hostname.toLowerCase(), pageHost) && !domainMatches(pageHost, url.hostname.toLowerCase());
  if (rule.thirdParty !== null && rule.thirdParty !== thirdParty) return false;
  if (rule.domains.length && !rule.domains.some(domain => domainMatches(pageHost, domain))) return false;
  if (rule.excludedDomains.some(domain => domainMatches(pageHost, domain))) return false;
  return true;
}
export function matchFilterList(filters, rawUrl, pageUrl, resourceType = 'other') {
  if (!filters?.count) return null;
  let url, pageHost;
  try { url = new URL(rawUrl); pageHost = new URL(pageUrl).hostname.toLowerCase(); } catch { return null; }
  const host = url.hostname.toLowerCase(); const lowerHref = url.href.toLowerCase();
  if (someHostRule(filters.blockHosts, host, rule => rule.important && filterRuleMatches(rule, url, pageHost, resourceType, lowerHref))
    || filters.block.some(rule => rule.important && filterRuleMatches(rule, url, pageHost, resourceType, lowerHref))) return true;
  if (someHostRule(filters.allowHosts, host, rule => filterRuleMatches(rule, url, pageHost, resourceType, lowerHref))
    || filters.allow.some(rule => filterRuleMatches(rule, url, pageHost, resourceType, lowerHref))) return false;
  if (filters.hosts.has(url.hostname.toLowerCase())) return true;
  if (someHostRule(filters.blockHosts, host, rule => filterRuleMatches(rule, url, pageHost, resourceType, lowerHref))
    || filters.block.some(rule => filterRuleMatches(rule, url, pageHost, resourceType, lowerHref))) return true;
  return null;
}
export function shouldBlockByFilterList(filters, rawUrl, pageUrl, resourceType = 'other') { return matchFilterList(filters, rawUrl, pageUrl, resourceType) === true; }

export function remoteNetworkFilterSnapshot(filters) {
  const rules = [];
  const add = (rule, allow) => rules.push({
    host: rule.host || '', tokens: rule.matcher?.tokens.join('') || '', matchCase: rule.matchCase === true,
    important: rule.important === true, types: rule.types, excludedTypes: rule.excludedTypes,
    thirdParty: rule.thirdParty, domains: rule.domains, excludedDomains: rule.excludedDomains, allow,
  });
  for (const rule of filters?.block || []) add(rule, false);
  for (const rule of filters?.allow || []) add(rule, true);
  for (const entries of filters?.blockHosts?.values?.() || []) for (const rule of entries) add(rule, false);
  for (const entries of filters?.allowHosts?.values?.() || []) for (const rule of entries) add(rule, true);
  return { version: 1, hosts: [...(filters?.hosts || [])], rules };
}

export function parseUserScript(source) {
  if (typeof source !== 'string' || new TextEncoder().encode(source).byteLength > MAX_USERSCRIPT_BYTES) throw Error('Each userscript is limited to 256 KiB.');
  const block = source.match(/^\s*\/\/\s*==UserScript==\s*\r?\n([\s\S]*?)^\s*\/\/\s*==\/UserScript==/m);
  if (!block) throw Error('Userscript metadata block was not found.');
  const metadata = {};
  for (const line of block[1].split(/\r?\n/)) {
    const field = line.match(/^\s*\/\/\s*@([\w-]+)\s*(.*?)\s*$/);
    if (field) (metadata[field[1].toLowerCase()] ||= []).push(field[2]);
  }
  const name = metadata.name?.[0]?.trim();
  const matches = metadata.match || [];
  const includes = metadata.include || [];
  if (!name) throw Error('Userscript metadata must include @name.');
  if (!matches.length && !includes.length) throw Error('Userscript metadata must include at least one @match or @include URL.');
  if (metadata.require?.length) throw Error('External @require dependencies are not supported.');
  if ((metadata.resource || []).length > MAX_USERSCRIPT_RESOURCES) throw Error(`A userscript may declare at most ${MAX_USERSCRIPT_RESOURCES} @resource entries.`);
  const resources = (metadata.resource || []).map(value => {
    const match = value.trim().match(/^([\w.-]{1,64})\s+(https?:\/\/\S{1,2048})$/i);
    if (!match) throw Error('Each @resource must contain a name and an absolute HTTP(S) URL.');
    let url;
    try { url = new URL(match[2]); } catch { throw Error('Each @resource must contain a valid absolute HTTP(S) URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Each @resource must use HTTP(S) without embedded credentials.');
    return { name: match[1], url: url.href };
  });
  if (new Set(resources.map(resource => resource.name)).size !== resources.length) throw Error('Userscript @resource names must be unique.');
  const grants = [...new Set((metadata.grant || []).map(value => value.trim()).filter(value => value && value !== 'none'))];
  const supportedGrants = new Set(['GM_addStyle', 'GM_deleteValue', 'GM_getResourceText', 'GM_getResourceURL', 'GM_getValue', 'GM_listValues', 'GM_log', 'GM_setValue', 'GM_xmlhttpRequest']);
  const unsupportedGrant = grants.find(value => !supportedGrants.has(value));
  if (unsupportedGrant) throw Error(`Unsupported userscript grant: ${unsupportedGrant}.`);
  const runAt = metadata['run-at']?.at(-1)?.trim() || 'document-start';
  if (!['document-start', 'document-end', 'document-idle'].includes(runAt)) throw Error('Supported @run-at values are document-start, document-end, and document-idle.');
  for (const pattern of matches) if (!validUserScriptPattern(pattern, false)) throw Error(`Unsupported userscript URL pattern: ${pattern}`);
  for (const pattern of includes) if (!validUserScriptPattern(pattern, true)) throw Error(`Unsupported userscript @include pattern: ${pattern}`);
  for (const pattern of metadata.exclude || []) if (!validUserScriptPattern(pattern, true)) throw Error(`Unsupported userscript @exclude pattern: ${pattern}`);
  const connects = [...new Set((metadata.connect || []).map(normalizeUserScriptConnect))];
  if (grants.includes('GM_xmlhttpRequest') && !connects.length) throw Error('GM_xmlhttpRequest requires at least one explicit @connect host.');
  if ((grants.includes('GM_getResourceText') || grants.includes('GM_getResourceURL')) && !resources.length) throw Error('GM_getResourceText and GM_getResourceURL require at least one @resource.');
  return { name, matches, includes, excludes: metadata.exclude || [], connects, resources, grants, runAt, source };
}

function normalizeUserScriptConnect(value) {
  const source = String(value || '').trim().toLowerCase();
  if (source === '*' || source === 'self') return source;
  if (source.length > 256 || /[\s/@?#]/.test(source) || source.includes('://')) throw Error(`Unsupported userscript @connect host: ${source}`);
  const wildcard = source.startsWith('*.');
  const host = wildcard ? source.slice(2) : source;
  if (!host || host.includes('*')) throw Error(`Unsupported userscript @connect host: ${source}`);
  let parsed;
  try { parsed = new URL(`https://${host}`); } catch { throw Error(`Unsupported userscript @connect host: ${source}`); }
  if (parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.hostname !== host) throw Error(`Unsupported userscript @connect host: ${source}`);
  return `${wildcard ? '*.' : ''}${parsed.hostname}`;
}

export function userScriptConnectMatches(script, rawUrl, pageUrl) {
  let url, page;
  try { url = new URL(rawUrl); page = new URL(pageUrl); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  return (Array.isArray(script?.connects) ? script.connects : []).some(pattern => {
    if (pattern === '*') return true;
    if (pattern === 'self') return host === page.hostname.toLowerCase();
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2).toLowerCase();
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    return host === String(pattern).toLowerCase();
  });
}

export function filterUserscriptResponseHeaders(headers) {
  const blocked = new Set(['set-cookie', 'set-cookie2', 'www-authenticate', 'proxy-authenticate', 'authentication-info', 'proxy-authentication-info']);
  const entries = Array.isArray(headers) ? headers : Object.entries(headers || {});
  return entries.filter(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'
    && !blocked.has(entry[0].toLowerCase()) && !entry[0].toLowerCase().startsWith('proxy-'))
    .map(([name, value]) => [String(name).slice(0, 256), String(value).slice(0, 4096)]);
}

export function browserResourceCacheLifetime(headers) {
  const rows = Array.isArray(headers) ? headers : Object.entries(headers || {});
  const values = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string') continue;
    const name = row[0].toLowerCase();
    values.set(name, values.has(name) ? `${values.get(name)}, ${String(row[1])}` : String(row[1]));
  }
  if (values.has('set-cookie') || values.has('set-cookie2')) return 0;
  const directives = new Map((values.get('cache-control') || '').split(',').map(part => {
    const [name, ...rest] = part.trim().split('=');
    return [name.toLowerCase(), rest.join('=').replace(/^"|"$/g, '')];
  }).filter(([name]) => name));
  if (directives.has('no-store') || directives.has('no-cache')) return 0;
  const vary = (values.get('vary') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (vary.some(name => !['accept', 'accept-encoding', 'cookie'].includes(name))) return 0;
  if (vary.includes('*')) return 0;
  const maxAge = Number(directives.get('max-age'));
  if (!Number.isFinite(maxAge) || maxAge <= 0) return 0;
  const age = Math.max(0, Number(values.get('age')) || 0);
  return Math.max(0, Math.min(MAX_RESOURCE_CACHE_TTL_MS, maxAge * 1000 - age * 1000));
}

export function browserResourceCacheKey(url, resourceType, accept, cookie = '', context = '') {
  let normalized;
  try { normalized = new URL(url); } catch { return ''; }
  normalized.hash = '';
  return JSON.stringify([normalized.href, String(resourceType), String(accept), String(cookie), String(context)]);
}

export function waitForSharedResource(entry, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Resource load was cancelled.', 'AbortError'));
  entry.waiters = (entry.waiters || 0) + 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const release = () => {
      entry.waiters = Math.max(0, (entry.waiters || 1) - 1);
      signal?.removeEventListener('abort', abort);
      if (!entry.waiters && !entry.settled) entry.controller.abort();
    };
    const abort = () => {
      if (settled) return;
      settled = true; release();
      reject(signal.reason || new DOMException('Resource load was cancelled.', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    entry.promise.then(value => {
      if (settled) return;
      settled = true; release(); resolve(value);
    }, error => {
      if (settled) return;
      settled = true; release(); reject(error);
    });
  });
}

export function sanitizeUserscriptStorage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.create(null);
  const output = Object.create(null); let totalBytes = 0;
  for (const [scriptId, values] of Object.entries(value).slice(0, MAX_USERSCRIPTS)) {
    if (!/^[\w-]{1,128}$/.test(scriptId) || !values || typeof values !== 'object' || Array.isArray(values)) continue;
    const clean = Object.create(null); let scriptBytes = 0, count = 0;
    for (const [key, item] of Object.entries(values)) {
      if (count >= MAX_USERSCRIPT_STORAGE_ITEMS || key.length > 128) break;
      let encoded; try { encoded = JSON.stringify(item); } catch { continue; }
      if (typeof encoded !== 'string') continue;
      const bytes = new TextEncoder().encode(key).byteLength + new TextEncoder().encode(encoded).byteLength;
      if (bytes > MAX_USERSCRIPT_VALUE_BYTES || scriptBytes + bytes > MAX_USERSCRIPT_STORAGE_PER_SCRIPT_BYTES || totalBytes + bytes > MAX_USERSCRIPT_STORAGE_TOTAL_BYTES) continue;
      try { clean[key] = JSON.parse(encoded); } catch { continue; }
      scriptBytes += bytes; totalBytes += bytes; count++;
    }
    if (count) output[scriptId] = clean;
  }
  return output;
}

export function updateUserscriptStorage(current, message, grants) {
  if (!message || typeof message.scriptId !== 'string' || !/^[\w-]{1,128}$/.test(message.scriptId)
    || typeof message.key !== 'string' || message.key.length > 128) return null;
  const permissions = new Set(Array.isArray(grants) ? grants : []);
  if (message.action === 'set' && !permissions.has('GM_setValue')) return null;
  if (message.action === 'delete' && !permissions.has('GM_deleteValue')) return null;
  if (!['set', 'delete'].includes(message.action)) return null;
  const state = sanitizeUserscriptStorage(current);
  const next = Object.assign(Object.create(null), state);
  const values = Object.assign(Object.create(null), state[message.scriptId] || {});
  if (message.action === 'set') {
    let encoded; try { encoded = JSON.stringify(message.value); } catch { return null; }
    if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).byteLength > MAX_USERSCRIPT_VALUE_BYTES) return null;
    values[message.key] = JSON.parse(encoded);
  } else delete values[message.key];
  next[message.scriptId] = values;
  const clean = sanitizeUserscriptStorage(next);
  if (message.action === 'set' && (!Object.hasOwn(clean, message.scriptId) || !Object.hasOwn(clean[message.scriptId], message.key))) return null;
  return clean;
}

function validUserScriptPattern(pattern, allowGlob) {
  if (pattern === '<all_urls>') return true;
  const match = pattern.match(/^(https?|\*):\/\/([^/]+)(\/.*)$/i);
  if (match) {
    const host = match[2];
    return !!host && !/[?#\s]/.test(host) && !/[\s]/.test(pattern)
      && (!host.includes('*') || host === '*' || host.startsWith('*.'));
  }
  return allowGlob === true && !pattern.includes('://') && pattern.length <= 2048 && !/[\s]/.test(pattern) && pattern.includes('*');
}

function globMatches(pattern, value) {
  const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  try { return new RegExp(`^${escaped}$`, 'i').test(value); } catch { return false; }
}

export function userScriptMatches(script, rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const matchPattern = pattern => {
    if (pattern === '<all_urls>') return true;
    const parts = pattern.match(/^(https?|\*):\/\/([^/]+)(\/.*)$/i);
    if (!parts) return globMatches(pattern, url.href);
    const [, scheme, hostPattern, pathPattern] = parts;
    if (scheme !== '*' && `${scheme.toLowerCase()}:` !== url.protocol) return false;
    const host = hostPattern.toLowerCase(), actual = url.hostname.toLowerCase();
    if (host === '*') { /* Any public web host. */ }
    else if (host.startsWith('*.')) { if (!domainMatches(actual, host.slice(2))) return false; }
    else if (host.includes(':') ? url.host.toLowerCase() !== host : actual !== host) return false;
    return globMatches(pathPattern, `${url.pathname}${url.search}`);
  };
  if ((script.excludes || []).some(matchPattern)) return false;
  return (script.matches || []).some(matchPattern) || (script.includes || []).some(pattern => globMatches(pattern, url.href));
}

function defaultCookiePath(pathname) {
  if (!pathname || pathname[0] !== '/') return '/';
  const lastSlash = pathname.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
}

function cookiePathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

function schemefulSite(rawUrl) {
  // Without a bundled Public Suffix List, compare exact schemeful hosts. This
  // is conservative for sibling subdomains but cannot merge unrelated tenants.
  try { const url = new URL(rawUrl); return `${url.protocol}//${url.hostname.toLowerCase()}`; } catch { return ''; }
}

export function applyCookie(cookies, rawCookie, rawUrl, { fromServer = false, now = Date.now() } = {}) {
  if (!Array.isArray(cookies) || typeof rawCookie !== 'string' || rawCookie.length > 4096) return false;
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const parts = rawCookie.split(';'); const pair = parts.shift()?.trim() || ''; const equals = pair.indexOf('=');
  if (equals < 1) return false;
  const name = pair.slice(0, equals).trim(); const value = pair.slice(equals + 1).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\u0000-\u001f\u007f;]/.test(value)) return false;
  const host = url.hostname.toLowerCase(); const domain = host; const hostOnly = true; let hasDomainAttribute = false;
  let path = defaultCookiePath(url.pathname); let secure = false; let cookieHttpOnly = false; let sameSite = 'lax';
  let expiresAt = null; let maxAge = null;
  for (const rawAttribute of parts) {
    const attribute = rawAttribute.trim(); const separator = attribute.indexOf('=');
    const key = (separator < 0 ? attribute : attribute.slice(0, separator)).trim().toLowerCase();
    const attrValue = separator < 0 ? '' : attribute.slice(separator + 1).trim();
    if (key === 'domain') {
      const candidate = attrValue.replace(/^\.+/, '').toLowerCase();
      if (!candidate || !domainMatches(host, candidate)) return false;
      // Treat all Domain cookies as host-only. A complete PSL is not bundled,
      // so broad cookie scope could cross public-suffix tenant boundaries.
      hasDomainAttribute = true;
    } else if (key === 'path' && attrValue.startsWith('/')) path = attrValue;
    else if (key === 'secure') secure = true;
    else if (key === 'httponly') { if (fromServer) cookieHttpOnly = true; }
    else if (key === 'samesite' && /^(?:strict|lax|none)$/i.test(attrValue)) sameSite = attrValue.toLowerCase();
    else if (key === 'max-age' && /^-?\d+$/.test(attrValue)) maxAge = Number(attrValue);
    else if (key === 'expires') { const time = Date.parse(attrValue); if (Number.isFinite(time)) expiresAt = time; }
  }
  if (secure && url.protocol !== 'https:') return false;
  if (sameSite === 'none' && !secure) return false;
  if (name.startsWith('__Secure-') && (!secure || url.protocol !== 'https:')) return false;
  if (name.startsWith('__Host-') && (!secure || hasDomainAttribute || path !== '/' || url.protocol !== 'https:')) return false;
  if (maxAge !== null) expiresAt = maxAge <= 0 ? 0 : now + Math.min(maxAge, 400 * 24 * 60 * 60) * 1000;
  const key = cookie => cookie.name === name && cookie.domain === domain && cookie.path === path;
  const existing = cookies.findIndex(key);
  if (existing >= 0 && cookies[existing].httpOnly && !fromServer) return false;
  if (existing >= 0) cookies.splice(existing, 1);
  if (expiresAt !== null && expiresAt <= now) return true;
  const cookie = { name, value, domain, path, hostOnly, secure, httpOnly: cookieHttpOnly, sameSite, expiresAt, createdAt: now };
  cookies.push(cookie);
  while (cookies.length > MAX_TAB_COOKIES || cookies.reduce((sum, item) => sum + item.name.length + item.value.length + item.domain.length + item.path.length, 0) > MAX_COOKIE_BYTES) {
    const oldest = cookies.reduce((index, item, current) => item.createdAt < cookies[index].createdAt ? current : index, 0);
    cookies.splice(oldest, 1);
  }
  return true;
}

export function cookieString(cookies, rawUrl, { includeHttpOnly = true, pageUrl = '', topLevel = false, method = 'GET', now = Date.now() } = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { return ''; }
  const host = url.hostname.toLowerCase(); const pathname = url.pathname || '/';
  const pageSite = schemefulSite(pageUrl);
  const crossSite = !!pageSite && pageSite !== schemefulSite(url.href);
  const safeMethod = ['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(String(method).toUpperCase());
  for (let i = cookies.length - 1; i >= 0; i--) if (cookies[i].expiresAt !== null && cookies[i].expiresAt <= now) cookies.splice(i, 1);
  return cookies.filter(cookie => (includeHttpOnly || !cookie.httpOnly)
    && (cookie.hostOnly ? host === cookie.domain : domainMatches(host, cookie.domain))
    && cookiePathMatches(pathname, cookie.path)
    && (cookie.sameSite !== 'strict' || !crossSite)
    && (cookie.sameSite !== 'lax' || !crossSite || (topLevel && safeMethod))
    && (!cookie.secure || url.protocol === 'https:'))
    .sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt)
    .map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

export function applySetCookies(cookies, setCookies, rawUrl, now = Date.now()) {
  if (!Array.isArray(setCookies)) return;
  let count = 0;
  for (const event of setCookies) {
    const url = event && typeof event === 'object' && typeof event.url === 'string' ? event.url : rawUrl;
    const values = typeof event === 'string' ? [event] : Array.isArray(event?.values) ? event.values : [];
    for (const value of values) {
      if (count++ >= 32) return;
      applyCookie(cookies, value, url, { fromServer: true, now });
    }
  }
}

function commaTokens(value) { return String(value || '').split(',').map(token => token.trim().toLowerCase()).filter(Boolean); }
export function corsOriginAllowed(headers, origin, credentials = 'same-origin') {
  const allowed = header(headers, 'access-control-allow-origin').trim();
  if (credentials === 'include') return allowed === origin && header(headers, 'access-control-allow-credentials').trim().toLowerCase() === 'true';
  return allowed === '*' || allowed === origin;
}
export function corsPreflightAllowed(headers, origin, method, requestHeaders = [], credentials = 'same-origin') {
  if (!corsOriginAllowed(headers, origin, credentials)) return false;
  const methods = commaTokens(header(headers, 'access-control-allow-methods'));
  const methodAllowed = methods.includes(String(method).toLowerCase()) || (credentials !== 'include' && methods.includes('*'));
  if (!methodAllowed) return false;
  const allowedHeaders = commaTokens(header(headers, 'access-control-allow-headers'));
  return requestHeaders.every(name => allowedHeaders.includes(name.toLowerCase()) || (credentials !== 'include' && name.toLowerCase() !== 'authorization' && allowedHeaders.includes('*')));
}
export function corsMaxAge(headers, now = Date.now()) {
  const seconds = Number(header(headers, 'access-control-max-age'));
  return Number.isFinite(seconds) && seconds > 0 ? now + Math.min(seconds, 600) * 1000 : now;
}
export function corsSafelistedHeader(name, value) {
  const key = name.toLowerCase(); const text = String(value);
  const unsafeByte = char => {
    const code = char.charCodeAt(0);
    return code <= 8 || (code >= 10 && code <= 31) || code === 127 || '"():<>?@[\\]{}'.includes(char);
  };
  if (['accept', 'accept-language', 'content-language'].includes(key)) {
    if (text.length > 128 || [...text].some(unsafeByte)) return false;
    return key === 'accept' || /^[0-9A-Za-z *,.;=-]*$/.test(text);
  }
  if (key === 'content-type') return text.length <= 128 && ![...text].some(unsafeByte) && ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'].includes(text.split(';', 1)[0].trim().toLowerCase());
  if (key === 'range') return /^bytes=\d+-\d*$/.test(text);
  return false;
}
export function corsVisibleHeaders(headers, credentials = 'same-origin') {
  const safe = new Set(['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma']);
  const exposed = commaTokens(header(headers, 'access-control-expose-headers'));
  if (credentials !== 'include' && exposed.includes('*')) for (const [name] of normalizeHeaders(headers)) safe.add(String(name).toLowerCase());
  else for (const name of exposed) safe.add(name);
  return normalizeHeaders(headers).filter(([name]) => safe.has(String(name).toLowerCase()));
}

const readStore = (key, fallback) => {
  try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; }
  catch { return fallback; }
};
const writeStore = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* file:// storage is optional */ } };
function openBrowserStorageDb() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(Error('IndexedDB is unavailable.')); return; }
    const request = indexedDB.open('eya-browser-profile', 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('state')) request.result.createObjectStore('state'); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error || Error('Could not open browser storage.'));
  });
}
function readBrowserStorageDb(db, key) {
  return new Promise((resolve, reject) => {
    const request = db.transaction('state', 'readonly').objectStore('state').get(key);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error || Error('Could not read browser storage.'));
  });
}
function writeBrowserStorageDb(db, key, value) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('state', 'readwrite');
    transaction.objectStore('state').put(value, key);
    transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(transaction.error || Error('Could not save browser storage.'));
  });
}
const storageObject = items => Object.fromEntries(sanitizeStorageItems(items));
const storageObjectBytes = value => Object.entries(value || {}).reduce((sum, [key, item]) => sum + new TextEncoder().encode(key).byteLength + new TextEncoder().encode(String(item)).byteLength, 0);
const sanitizeSiteStorage = raw => {
  const result = {}; let total = 0;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [origin, values] of Object.entries(raw).slice(0, 256)) {
    try { const parsed = new URL(origin); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) continue; } catch { continue; }
    const entries = sanitizeStorageItems(Object.entries(values || {}));
    const bytes = entries.reduce((sum, [key, value]) => sum + new TextEncoder().encode(key).byteLength + new TextEncoder().encode(value).byteLength, 0);
    if (total + bytes > MAX_STORAGE_TOTAL_BYTES) break;
    result[origin] = Object.fromEntries(entries); total += bytes;
  }
  return result;
};
const readSiteStorage = () => sanitizeSiteStorage(readStore(SITE_STORAGE_KEY, {}));
const safeUrl = (raw, base) => {
  const value = String(raw || '').trim();
  if (!value) throw Error('Enter a web address or search query.');
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
  let url;
  try { url = new URL(candidate, base); } catch { throw Error('That address is not valid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw Error('Only HTTP and HTTPS addresses are supported.');
  }
  return url.href;
};
const searchUrl = query => `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
const button = (label, title, action, className = '') => {
  const node = document.createElement('button'); node.type = 'button'; node.textContent = label;
  node.title = title; node.setAttribute('aria-label', title); if (className) node.className = className;
  node.addEventListener('click', action); return node;
};
const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
};

function bootstrapSource(nonce, initialCookies = '', initialStorage = {}, initialUrl = 'https://example.test/') {
  // This code only runs inside the opaque-origin sandbox. The frame receives a
  // capability-limited MessagePort; it never receives Eya's Noise key/API.
  const token = JSON.stringify(nonce);
  const cookieSnapshot = JSON.stringify(initialCookies);
  const storageSnapshot = JSON.stringify(initialStorage).replaceAll('<', '\\u003c');
  const eventSourceParser = parseEventSourceBlock.toString();
  return `globalThis.__eyaProxyInitialUrl=${JSON.stringify(initialUrl)};` + String.raw`(()=>{const N=${token},S=${storageSnapshot},P=parent,nativeEval=window.eval,NativeWorker=window.Worker,nativeFind=typeof window.find==='function'?window.find.bind(window):null,nativeStop=typeof window.stop==='function'?window.stop.bind(window):()=>{},nativePreventDefault=Function.prototype.call.bind(Event.prototype.preventDefault),workerBootstrap=${JSON.stringify(workerBootstrapSource())},moduleWorkerBootstrap=${JSON.stringify(moduleWorkerBootstrapSource())},stopImmediate=Function.prototype.call.bind(Event.prototype.stopImmediatePropagation);let port=null,seq=0;const pending=new Map(),resources=new Map(),pageSockets=new Map(),responseUrls=new WeakMap(),workerPrivate=new WeakMap(),workerCount={value:0},queued=[],nodeIds=new WeakMap(),elementsById=new Map();let nextNodeId=0,highlightedElement=null,highlightStyle=null,performanceObservers=[],performanceRecording=false;` +
    `const parseEventSourceBlock=${eventSourceParser};const scanCssResourceMatches=${scanCssResourceMatches.toString()};` +
    String.raw`let documentCookie=${cookieSnapshot};try{Object.defineProperty(document,'cookie',{configurable:true,get(){return documentCookie},set(raw){raw=String(raw);const pair=raw.split(';',1)[0],at=pair.indexOf('=');if(at>0){const name=pair.slice(0,at).trim(),value=pair.slice(at+1).trim(),parts=documentCookie?documentCookie.split(/;\s*/).filter(item=>item.slice(0,item.indexOf('='))!==name):[],age=raw.match(/(?:^|;)\s*max-age\s*=\s*(-?\d+)/i),expires=raw.match(/(?:^|;)\s*expires\s*=\s*([^;]+)/i),remove=age?Number(age[1])<=0:expires&&Date.parse(expires[1])<=Date.now();if(!remove)parts.push(name+'='+value);documentCookie=parts.join('; ')}send({type:'cookie',value:raw})}})}catch{}` +
    String.raw`const send=(m,t=[])=>{if(port)port.postMessage(m,t);else queued.push([m,t])};let virtualHistory=[{url:String(globalThis.__eyaProxyInitialUrl||document.baseURI),state:null}],virtualHistoryIndex=0;try{delete globalThis.__eyaProxyInitialUrl}catch{};const virtualUrl=()=>virtualHistory[virtualHistoryIndex]?.url||document.baseURI;const updateVirtualBase=url=>{const base=document.querySelector('base[data-eya-proxy-base]');if(base)base.href=url};const cloneHistoryState=value=>{let clone;try{clone=structuredClone(value)}catch{throw new DOMException('History state cannot be cloned.','DataCloneError')}let size;try{size=new TextEncoder().encode(JSON.stringify(clone)??'null').byteLength}catch{throw new DOMException('History state must be serializable.','DataCloneError')}if(size>65536)throw new DOMException('History state exceeds the 64 KiB limit.','QuotaExceededError');return clone};const reportHistory=(action,index=virtualHistoryIndex)=>send({type:'history',action,url:virtualUrl(),index});const routeHistory=(action,state,url)=>{const current=new URL(virtualUrl()),target=url==null?current:new URL(String(url),current);if(!['http:','https:'].includes(target.protocol)||target.origin!==current.origin)throw new DOMException('History URL must remain same-origin.','SecurityError');const cloned=cloneHistoryState(state);if(action==='push'){virtualHistory=virtualHistory.slice(0,virtualHistoryIndex+1);virtualHistory.push({url:target.href,state:cloned});if(virtualHistory.length>50)virtualHistory.shift();virtualHistoryIndex=virtualHistory.length-1}else virtualHistory[virtualHistoryIndex]={url:target.href,state:cloned};updateVirtualBase(target.href);reportHistory(action);return undefined};const routePageNavigation=(raw,history='push')=>{let target;try{target=new URL(history==='reload'?virtualUrl():String(raw),virtualUrl())}catch{return ''}if(!['http:','https:'].includes(target.protocol)){send({type:'console',level:'error',args:['Blocked page navigation',target.href]});return ''}send({type:'navigate',url:target.href,history});return target.href};try{Object.defineProperty(window,'__eyaNavigate',{value:routePageNavigation,configurable:false,writable:false})}catch{};try{const historyObject=window.history;Object.defineProperty(historyObject,'pushState',{configurable:true,writable:true,value:(state,title,url)=>routeHistory('push',state,url)});Object.defineProperty(historyObject,'replaceState',{configurable:true,writable:true,value:(state,title,url)=>routeHistory('replace',state,url)});Object.defineProperty(historyObject,'state',{configurable:true,get:()=>cloneHistoryState(virtualHistory[virtualHistoryIndex]?.state??null)});Object.defineProperty(historyObject,'length',{configurable:true,get:()=>virtualHistory.length});Object.defineProperty(historyObject,'back',{configurable:true,writable:true,value:()=>send({type:'history-go',delta:-1})});Object.defineProperty(historyObject,'forward',{configurable:true,writable:true,value:()=>send({type:'history-go',delta:1})});Object.defineProperty(historyObject,'go',{configurable:true,writable:true,value:delta=>{delta=Number(delta??0);if(!Number.isFinite(delta))return;delta=Math.trunc(delta);if(delta===0)send({type:'navigate',url:virtualUrl(),history:'reload'});else send({type:'history-go',delta:Math.max(-50,Math.min(50,delta))})}})}catch{}` +
    String.raw`const perfEntry=e=>{let name=String(e.name||'');try{const u=new URL(name);if(['http:','https:','ws:','wss:'].includes(u.protocol)){u.username='';u.password='';u.search='';u.hash='';name=u.href}}catch{}const out={entryType:String(e.entryType||'').slice(0,32),name:name.slice(0,512)};for(const key of ['startTime','duration','transferSize','encodedBodySize','decodedBodySize','domInteractive','domContentLoadedEventStart','domContentLoadedEventEnd','loadEventStart','loadEventEnd','responseStart','responseEnd','value'])if(Number.isFinite(e[key]))out[key]=e[key];for(const key of ['initiatorType','nextHopProtocol'])if(typeof e[key]==='string')out[key]=e[key].slice(0,64);if(typeof e.hadRecentInput==='boolean')out.hadRecentInput=e.hadRecentInput;return out};` +
    String.raw`const perfSnapshot=()=>{let memory=null;try{const m=performance.memory;if(m)memory={usedJSHeapSize:m.usedJSHeapSize,totalJSHeapSize:m.totalJSHeapSize,jsHeapSizeLimit:m.jsHeapSizeLimit}}catch{}return{entries:performance.getEntries().slice(-500).map(perfEntry),memory}};` +
    String.raw`const stopPerformance=()=>{performanceRecording=false;for(const observer of performanceObservers)observer.disconnect();performanceObservers=[]};` +
    String.raw`const startPerformance=()=>{stopPerformance();performanceRecording=true;for(const type of PerformanceObserver.supportedEntryTypes||['navigation','paint','resource','longtask','layout-shift','mark','measure']){try{const observer=new PerformanceObserver(list=>{if(!performanceRecording)return;const entries=list.getEntries().map(perfEntry);if(entries.length)send({type:'performance-entries',entries})});observer.observe({type,buffered:true});performanceObservers.push(observer)}catch{}}};` +
    String.raw`const preview=(value,depth=0,seen=new WeakSet())=>{if(value===null||value===undefined||typeof value==='number'||typeof value==='boolean')return value;if(typeof value==='string')return value.length>4096?value.slice(0,4096)+'… [truncated]':value;if(typeof value==='bigint')return String(value)+'n';if(typeof value==='symbol')return String(value);if(typeof value==='function')return '[Function '+(value.name||'anonymous')+']';if(value instanceof Node)return '<'+(value.nodeName||'node').toLowerCase()+(value.id?'#'+value.id:'')+'>';if(depth>=3)return '[Object]';if(seen.has(value))return '[Circular]';seen.add(value);if(Array.isArray(value))return value.slice(0,50).map(item=>preview(item,depth+1,seen));const result={};for(const key of Object.keys(value).slice(0,50)){let descriptor;try{descriptor=Object.getOwnPropertyDescriptor(value,key)}catch{}result[key]=descriptor&&'value'in descriptor?preview(descriptor.value,depth+1,seen):'[Getter]'}return result};` +
    String.raw`const bytes=async b=>{if(b==null)return new Uint8Array();const reader=new Response(b).body.getReader(),chunks=[];let size=0;for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>4*1024*1024){await reader.cancel();throw new TypeError('Request body exceeds the 4 MiB WebSocket upload limit.')}chunks.push(part.value)}const out=new Uint8Array(size);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.byteLength}return out};` +
    String.raw`const proxyResource=(url,resourceType,options={})=>new Promise((resolve,reject)=>{const id=++seq;resources.set(id,{resolve,reject});send({type:'resource',id,url:new URL(url,document.baseURI).href,resourceType,skipLocationRewrite:options.skipLocationRewrite===true})});const proxyResourceSource=(url,moduleMode=false,pageModule=false)=>{const id=++seq;let rejectRequest;const promise=new Promise((resolve,reject)=>{rejectRequest=reject;resources.set(id,{resolve,reject})});send({type:'resource',id,url:new URL(url,document.baseURI).href,resourceType:'script',transferSource:true,moduleMode,pageModule});return{promise,cancel(){if(resources.delete(id)){send({type:'cancel',id});rejectRequest(new DOMException('Module load cancelled.','AbortError'))}}}};` +
    String.raw`const createModuleGraph=message=>{const urls=new Map(),created=[];try{if(!message||!Array.isArray(message.order)||!message.modules||typeof message.url!=='string')throw Error('Invalid module graph');for(const moduleUrl of message.order){const record=message.modules[moduleUrl];if(!record||typeof record.source!=='string'||!Array.isArray(record.imports))throw Error('Invalid module record');let source=record.source;const replacements=record.imports.map(edge=>{const dependency=urls.get(edge.url);if(!dependency||!Number.isSafeInteger(edge.from)||!Number.isSafeInteger(edge.to)||edge.from<0||edge.to<edge.from||edge.to>source.length)throw Error('Invalid module dependency graph');return{from:edge.from,to:edge.to,text:JSON.stringify(dependency)}});for(const replacement of replacements.sort((a,b)=>b.from-a.from))source=source.slice(0,replacement.from)+replacement.text+source.slice(replacement.to);const blob=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));urls.set(moduleUrl,blob);created.push(blob)}const entry=urls.get(message.url);if(!entry)throw Error('Module graph has no entry point');let released=false;return{url:entry,release(){if(released)return;released=true;for(const blob of created)URL.revokeObjectURL(blob)}}}catch(error){for(const blob of created)URL.revokeObjectURL(blob);throw error}};` +
    String.raw`const request=async(input,init={},userscriptId='',followRedirects=true)=>{const effective=new Request(input,init),u=effective.url;` +
    String.raw`const method=effective.method.toUpperCase();const headers=new Headers(effective.headers);` +
    String.raw`const body=await bytes(effective.body);const id=++seq;` +
    String.raw`const signal=effective.signal,credentials=effective.credentials,mode=effective.mode;return new Promise((resolve,reject)=>{const cancel=()=>{const p=pending.get(id);if(!p||!pending.delete(id))return;signal?.removeEventListener('abort',cancel);send({type:'cancel',id});const error=new DOMException('The operation was aborted.','AbortError');p.streamController?.error(error);reject(error)};pending.set(id,{resolve,reject,method,signal,cancel});if(signal){if(signal.aborted){cancel();return}signal.addEventListener('abort',cancel,{once:true})}send({type:'request',id,url:new URL(u,document.baseURI).href,method,headers:[...headers],body:body.buffer,credentials,mode,resourceType:init.resourceType||'xmlhttprequest',discardBody:init.discardBody===true,userscriptId:typeof userscriptId==='string'?userscriptId:undefined,followRedirects:followRedirects!==false},[body.buffer])});};` +
    String.raw`window.__eyaUserscriptRequest=(scriptId,options,signal)=>{if(!options||typeof options!=='object')return Promise.reject(new TypeError('GM_xmlhttpRequest options are required.'));const url=String(options.url||'');const method=String(options.method||'GET').toUpperCase();return request(url,{method,headers:options.headers||{},body:options.data,signal,credentials:'omit',mode:'cors',resourceType:'xmlhttprequest'},scriptId,false).then(response=>({response,finalUrl:responseUrls.get(response)||url}))};` +
    String.raw`if(NativeWorker){class EyaWorker extends NativeWorker{constructor(url,options={}){const target=new URL(url,document.baseURI);if(!/^https?:$/.test(target.protocol)||target.origin!==new URL(document.baseURI).origin)throw new DOMException('Worker scripts must be same-origin HTTP or HTTPS URLs.','SecurityError');if(workerCount.value>=${MAX_WORKERS_PER_TAB})throw new DOMException('This page reached the dedicated worker limit.','QuotaExceededError');const config=options&&typeof options==='object'?options:{};const moduleMode=config.type==='module';const bootUrl=URL.createObjectURL(new Blob([moduleMode?moduleWorkerBootstrap:workerBootstrap],{type:'text/javascript'}));super(bootUrl,{type:'classic',name:typeof config.name==='string'?config.name:''});let bootUrlRevoked=false;const revoke=()=>{if(bootUrlRevoked)return;bootUrlRevoked=true;URL.revokeObjectURL(bootUrl)};workerCount.value++;let released=false;const release=()=>{if(released)return;released=true;workerCount.value=Math.max(0,workerCount.value-1)};const channel=new MessageChannel();const sourceLoad=proxyResourceSource(target.href,moduleMode);const state={port:channel.port1,fetches:new Map(),revoke,release,sourceLoad};workerPrivate.set(this,state);state.port.start();this.addEventListener('error',()=>{revoke()},{once:true});this.addEventListener('message',event=>{if(event.data?.type==='eya-worker-ready'){stopImmediate(event);revoke()}else if(event.data?.type==='eya-worker-error'){stopImmediate(event);revoke();this.dispatchEvent(new ErrorEvent('error',{message:String(event.data.error||'Worker failed')}));this.terminate()}},{capture:true});super.postMessage({type:'eya-init',base:target.href},[channel.port2]);sourceLoad.promise.then(result=>{if(!bootUrlRevoked)super.postMessage({type:'eya-source',...result,base:result.url||target.href})}).catch(error=>{if(!bootUrlRevoked)super.postMessage({type:'eya-source-error',error:String(error.message||error).slice(0,1024)})});state.port.onmessage=event=>{const message=event.data;if(!message||!Number.isSafeInteger(message.id))return;if(message.type==='fetch-cancel'){state.fetches.get(message.id)?.abort();return}if(message.type!=='fetch')return;if(state.fetches.size>=${MAX_WORKER_FETCHES}){state.port.postMessage({type:'fetch-response',id:message.id,error:'Worker fetch limit reached'});return}const controller=new AbortController();state.fetches.set(message.id,controller);request(new URL(String(message.url||''),target.href).href,{method:message.method,headers:message.headers,body:message.body?.byteLength?new Uint8Array(message.body):undefined,credentials:message.credentials,mode:message.mode,signal:controller.signal,resourceType:'xmlhttprequest'}).then(async response=>{const reader=response.body?.getReader();const chunks=[];let size=0;if(reader){for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>${MAX_WORKER_RESPONSE_BYTES}){await reader.cancel();throw new TypeError('Worker response exceeds the bridge limit.')}chunks.push(part.value)}}const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength}state.port.postMessage({type:'fetch-response',id:message.id,status:response.status,statusText:response.statusText,headers:[...response.headers],url:responseUrls.get(response)||'',opaque:response.type==='opaque',body:bytes.buffer},[bytes.buffer])}).catch(error=>{try{state.port.postMessage({type:'fetch-response',id:message.id,error:String(error.message||error).slice(0,1024)})}catch{}}).finally(()=>state.fetches.delete(message.id))};state.port.onmessageerror=()=>{};}terminate(){const state=workerPrivate.get(this);if(state){for(const controller of state.fetches.values())controller.abort();state.fetches.clear();state.port.close();state.sourceLoad.cancel();state.revoke();state.release();workerPrivate.delete(this)}super.terminate()}}window.Worker=EyaWorker;}` +
    String.raw`window.__eyaUserscriptStorage=(scriptId,action,key,value)=>send({type:'userscript-storage',scriptId,action,key,value});window.fetch=(input,init)=>request(input,init);` +
    String.raw`class EyaEventSource extends EventTarget{constructor(url,options={}){super();this.url=new URL(url,document.baseURI).href;this.withCredentials=!!options.withCredentials;this.readyState=0;this.onopen=this.onmessage=this.onerror=null;this.lastEventId='';this._retry=3000;this._closed=false;this._controller=null;this._connect()}close(){this._closed=true;this.readyState=2;this._controller?.abort()}_emit(type,event){this.dispatchEvent(event);if(typeof this['on'+type]==='function')this['on'+type](event)}async _connect(){if(!/^https?:/i.test(this.url)){this.readyState=2;this._closed=true;this._emit('error',new Event('error'));return}while(!this._closed){const controller=new AbortController();this._controller=controller;try{const headers={accept:'text/event-stream'};if(this.lastEventId)headers['last-event-id']=this.lastEventId;const response=await request(this.url,{method:'GET',headers,signal:controller.signal,credentials:this.withCredentials?'include':'same-origin',resourceType:'xmlhttprequest'});if(response.status===204){this.close();return}if(response.status<200||response.status>=300||!/^text\/event-stream\b/i.test(response.headers.get('content-type')||'')){this._terminal=true;throw Error('EventSource response must be a successful text/event-stream response.')}this.readyState=1;this._emit('open',new Event('open'));const reader=response.body?.getReader();if(!reader)throw Error('EventSource response has no stream.');const decoder=new TextDecoder();let buffer='';while(!this._closed){const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true});if(buffer.length>1048576)throw Error('EventSource event exceeds the 1 MiB limit.');let boundary;while((boundary=/(?:\r\n\r\n|\n\n|\r\r)/.exec(buffer))){const block=buffer.slice(0,boundary.index);buffer=buffer.slice(boundary.index+boundary[0].length);this._dispatchBlock(block)}}if(!this._closed&&buffer)this._dispatchBlock(buffer)}catch(error){if(this._closed||error.name==='AbortError')return;if(this._terminal){this._closed=true;this.readyState=2;this._emit('error',new Event('error'));return}}finally{if(this._controller===controller)this._controller=null}if(!this._closed){this.readyState=0;this._emit('error',new Event('error'));await new Promise(resolve=>setTimeout(resolve,this._retry))}}}_dispatchBlock(block){const parsed=parseEventSourceBlock(block,this);if(parsed)this._emit(parsed.type,new MessageEvent(parsed.type,{data:parsed.data,lastEventId:parsed.lastEventId,origin:new URL(this.url).origin}))}}EyaEventSource.CONNECTING=0;EyaEventSource.OPEN=1;EyaEventSource.CLOSED=2;EyaEventSource.prototype.CONNECTING=0;EyaEventSource.prototype.OPEN=1;EyaEventSource.prototype.CLOSED=2;window.EventSource=EyaEventSource;` +
    String.raw`const installSendBeacon=()=>{try{Object.defineProperty(navigator,'sendBeacon',{configurable:true,value:(url,data=null)=>{let body=new Uint8Array(),headers={};if(data==null){}else if(typeof data==='string'){body=new TextEncoder().encode(data);headers['content-type']='text/plain;charset=UTF-8'}else if(data instanceof URLSearchParams){body=new TextEncoder().encode(data.toString());headers['content-type']='application/x-www-form-urlencoded;charset=UTF-8'}else if(data instanceof Blob){if(data.size>40960)return false;headers['content-type']=data.type||'application/octet-stream';data.arrayBuffer().then(value=>request(url,{method:'POST',headers,body:new Uint8Array(value),credentials:'same-origin',resourceType:'ping',discardBody:true}).catch(()=>{})).catch(()=>{});return true}else if(data instanceof ArrayBuffer)body=new Uint8Array(data);else if(ArrayBuffer.isView(data))body=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);else return false;if(body.byteLength>40960)return false;request(url,{method:'POST',headers,body,credentials:'same-origin',resourceType:'ping',discardBody:true}).catch(()=>{});return true}})}catch{}};installSendBeacon();` +
    String.raw`class EyaWebSocket extends EventTarget{
      constructor(url,protocols=[]){super();const parsed=new URL(url,document.baseURI);if(parsed.protocol==='http:')parsed.protocol='ws:';else if(parsed.protocol==='https:')parsed.protocol='wss:';if(!['ws:','wss:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new DOMException('Invalid WebSocket URL.','SyntaxError');if(typeof protocols==='string')protocols=[protocols];if(!Array.isArray(protocols)||protocols.length>16||protocols.some(value=>typeof value!=='string'||!value||!value.split('').every(char=>/[-!#$%&'*+.^_|~0-9A-Za-z]/.test(char)||char===String.fromCharCode(96)))||new Set(protocols).size!==protocols.length)throw new DOMException('Invalid WebSocket protocols.','SyntaxError');this.url=parsed.href;this.readyState=0;this.protocol='';this.extensions='';this.binaryType='blob';this.bufferedAmount=0;this.onopen=this.onmessage=this.onerror=this.onclose=null;this._id=++seq;this._sendChain=Promise.resolve();this._queuedBytes=0;pageSockets.set(this._id,this);send({type:'ws-open',id:this._id,url:this.url,protocols})}
      send(data){if(this.readyState!==1)throw new DOMException('WebSocket is not open.','InvalidStateError');let source,kind=2;if(typeof data==='string'){source=Promise.resolve(new TextEncoder().encode(data));kind=1}else if(data instanceof Blob){if(data.size>1048576)throw new TypeError('WebSocket message exceeds the 1 MiB proxy limit.');source=data.arrayBuffer().then(value=>new Uint8Array(value))}else if(data instanceof ArrayBuffer)source=Promise.resolve(new Uint8Array(data.slice(0)));else if(ArrayBuffer.isView(data))source=Promise.resolve(new Uint8Array(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)));else throw new TypeError('WebSocket data must be a string, Blob, ArrayBuffer, or typed array');const size=typeof data==='string'?new TextEncoder().encode(data).byteLength:data.size??data.byteLength;if(size>1048576||this._queuedBytes+size>1048576)throw new TypeError('WebSocket send queue exceeds the 1 MiB proxy limit.');this._queuedBytes+=size;this.bufferedAmount=this._queuedBytes;this._sendChain=this._sendChain.then(async()=>{const bytes=await source;if(this.readyState!==1)return;send({type:'ws-send',id:this._id,kind,body:bytes.buffer},[bytes.buffer])}).catch(()=>this._emit('error',new Event('error'))).finally(()=>{this._queuedBytes=Math.max(0,this._queuedBytes-size);this.bufferedAmount=this._queuedBytes})}
      close(code=1000,reason=''){if(this.readyState>=2)return;if(code!==1000&&(code<3000||code>4999))throw new DOMException('Invalid WebSocket close code.','InvalidAccessError');if(new TextEncoder().encode(reason).length>123)throw new DOMException('WebSocket close reason is too long.','SyntaxError');this.readyState=2;send({type:'ws-close',id:this._id,code,reason})}
      _emit(type,event){this.dispatchEvent(event);if(typeof this['on'+type]==='function')this['on'+type](event)}}
    EyaWebSocket.CONNECTING=0;EyaWebSocket.OPEN=1;EyaWebSocket.CLOSING=2;EyaWebSocket.CLOSED=3;EyaWebSocket.prototype.CONNECTING=0;EyaWebSocket.prototype.OPEN=1;EyaWebSocket.prototype.CLOSING=2;EyaWebSocket.prototype.CLOSED=3;window.WebSocket=EyaWebSocket;window.MozWebSocket=EyaWebSocket;` +
    String.raw`addEventListener('message',e=>{if(e.source!==P||e.data?.type!=='eya-connect'||e.data.nonce!==N||!e.ports[0])return;stopImmediate(e);` +
    String.raw`port=e.ports[0];for(const [m,t] of queued.splice(0))port.postMessage(m,t);port.onmessage=async ev=>{const m=ev.data;if(m.type==='find-in-page'){const id=m.id,query=typeof m.text==='string'?m.text.slice(0,256):'';let found=false;if(query&&nativeFind){try{if(m.reset===true)window.getSelection()?.removeAllRanges();found=nativeFind(query,false,m.backwards===true,true,false,false)===true}catch{}}send({type:'find-result',id,found});return}if(m.type==='performance-snapshot'){send({type:'performance-data',id:m.id,...perfSnapshot()});return}if(m.type==='performance-record-start'){startPerformance();send({type:'performance-data',id:m.id,memory:perfSnapshot().memory,entries:[]});return}if(m.type==='performance-record-stop'){stopPerformance();return}if(m.type==='cookie-snapshot'){documentCookie=String(m.value||'');return}if(m.type==='storage-sync'){const map=m.area==='local'?localStore:sessionStore,key=String(m.key||''),oldValue=map.get(key)??null;map.__eyaApply?.(m.action,key,m.value);try{if(m.notify!==false){const event=new Event('storage');for(const [name,value] of Object.entries({key:m.action==='clear'?null:key,oldValue:m.action==='clear'?null:oldValue,newValue:m.action==='set'?String(m.value):null,url:String(m.url||''),storageArea:m.area==='local'?window.localStorage:window.sessionStorage}))Object.defineProperty(event,name,{value});window.dispatchEvent(event)}}catch{}return}if(m.type==='ws-open-result'){const s=pageSockets.get(m.id);if(!s)return;if(m.ok){s.protocol=m.protocol||'';s.readyState=1;s._emit('open',new Event('open'))}else{s.readyState=3;pageSockets.delete(m.id);s._emit('error',new Event('error'));s._emit('close',new CloseEvent('close',{code:1006,reason:m.error||'',wasClean:false}))}return}if(m.type==='ws-message'){const s=pageSockets.get(m.id);if(!s||s.readyState!==1)return;const bytes=new Uint8Array(m.body);const data=m.kind===1?new TextDecoder().decode(bytes):s.binaryType==='arraybuffer'?bytes.buffer:new Blob([bytes]);try{s._emit('message',new MessageEvent('message',{data,origin:new URL(s.url).origin}))}finally{send({type:'ws-credit',id:m.id})}return}if(m.type==='ws-error'){const s=pageSockets.get(m.id);if(s)s._emit('error',new Event('error'));return}if(m.type==='ws-close'){const s=pageSockets.get(m.id);if(!s)return;pageSockets.delete(m.id);s.readyState=3;s._emit('close',new CloseEvent('close',{code:m.code||1006,reason:m.reason||'',wasClean:m.wasClean===true}));return}if(m.type==='highlight-node'){const node=elementsById.get(m.id);if(!node?.isConnected)return;if(highlightedElement===node){node.scrollIntoView?.({block:'nearest',inline:'nearest'});return}if(highlightedElement&&highlightStyle){if(highlightStyle.outline)highlightedElement.style.setProperty('outline',highlightStyle.outline,highlightStyle.outlinePriority);else highlightedElement.style.removeProperty('outline');if(highlightStyle.offset)highlightedElement.style.setProperty('outline-offset',highlightStyle.offset,highlightStyle.offsetPriority);else highlightedElement.style.removeProperty('outline-offset')}highlightedElement=node;highlightStyle={outline:node.style.getPropertyValue('outline'),outlinePriority:node.style.getPropertyPriority('outline'),offset:node.style.getPropertyValue('outline-offset'),offsetPriority:node.style.getPropertyPriority('outline-offset')};node.style.setProperty('outline','2px solid #13b8a6','important');node.style.setProperty('outline-offset','2px','important');node.scrollIntoView?.({block:'nearest',inline:'nearest'});return}if(m.type==='resource-url'||m.type==='resource-source'||m.type==='resource-error'){const r=resources.get(m.id);if(r){resources.delete(m.id);m.type==='resource-url'?r.resolve(m.url):m.type==='resource-source'?r.resolve({source:m.source,url:m.url,sources:m.sources,modules:m.modules,order:m.order}):r.reject(new TypeError(m.error||'Resource request failed'))}return}const p=pending.get(m.id);if(m.type==='response'){if(!p)return;` +
    String.raw`if(m.error){pending.delete(m.id);p.signal?.removeEventListener('abort',p.cancel);p.reject(new TypeError(m.error));return;}if(m.opaque){pending.delete(m.id);p.signal?.removeEventListener('abort',p.cancel);const opaque=new Response(null);try{Object.defineProperties(opaque,{type:{value:'opaque'},status:{value:0},ok:{value:false},headers:{value:new Headers()}})}catch{}p.resolve(opaque);return;}const status=m.status||200;const noBody=p.method==='HEAD'||[204,205,304].includes(status);let body=m.body?new Uint8Array(m.body):null;` +
    String.raw`if(m.stream&&!noBody)body=new ReadableStream({start(controller){p.streamController=controller},pull(){if(!p.creditWaiting){p.creditWaiting=true;send({type:'credit',id:m.id})}},cancel(){pending.delete(m.id);p.signal?.removeEventListener('abort',p.cancel);send({type:'cancel',id:m.id})}},{highWaterMark:0});` +
    String.raw`else{pending.delete(m.id);p.signal?.removeEventListener('abort',p.cancel)}const response=new Response(noBody?null:body,{status,statusText:m.statusText||'',headers:m.headers||[]});responseUrls.set(response,m.url||'');p.resolve(response);}` +
    String.raw`else if(m.type==='chunk'&&p?.streamController){p.creditWaiting=false;p.streamController.enqueue(new Uint8Array(m.body))}` +
    String.raw`else if(m.type==='response-end'&&p){pending.delete(m.id);p.signal?.removeEventListener('abort',p.cancel);p.streamController?.close()}` +
    String.raw`else if(m.type==='response-error'&&p){pending.delete(m.id);p.signal?.removeEventListener('abort',p.cancel);p.streamController?.error(new TypeError(m.error||'Proxied response stream failed'))}};const previousPortHandler=port.onmessage;port.onmessage=async ev=>{if(ev.data?.type==='evaluate'){const m=ev.data;try{const value=await nativeEval(String(m.code||''));send({type:'evaluate-result',id:m.id,value:preview(value)})}catch(error){send({type:'evaluate-result',id:m.id,error:String(error?.stack||error).slice(0,8192)})}return}if(ev.data?.type==='edit-node'){const m=ev.data,node=elementsById.get(m.id);let error='';if(!node?.isConnected)error='Node no longer exists';else if(m.kind==='text'){if(!['SCRIPT','STYLE'].includes(node.tagName)&&node.childElementCount===0&&typeof m.value==='string'&&m.value.length<=4096&&new TextEncoder().encode(m.value).byteLength<=4096)node.textContent=m.value;else error='Text editing requires a leaf element and at most 4 KiB UTF-8'}else if(m.kind==='attribute'){const name=String(m.property||'').trim().toLowerCase(),value=m.value,allowed=['id','class','title','role','alt','hidden','tabindex','dir','lang'],safeName=allowed.includes(name)||/^aria-[a-z][a-z0-9-]{0,57}$/.test(name);if(!safeName||typeof value!=='string'||new TextEncoder().encode(value).byteLength>512||/[\u0000-\u001f\u007f]/.test(value))error='Unsupported or unsafe attribute edit';else node.setAttribute(name,value)}else if(m.kind==='style'){const name=String(m.property||'').toLowerCase(),value=m.value;if(!['color','background-color','display','position','width','height','margin','padding','opacity','font-size','font-weight','text-align','border-color','line-height','z-index','flex','grid-template-columns'].includes(name)||typeof value!=='string'||value.length>512||/[\u0000-\u001f\u007f]/.test(value)||/(?:url\s*\(|@import|expression\s*\()/i.test(value))error='Unsupported or unsafe CSS edit';else node.style.setProperty(name,value)}else error='Unsupported edit';send({type:'edit-node-result',id:m.id,ok:!error,error});return}if(ev.data?.type==='inspect-node'){const m=ev.data,node=elementsById.get(m.id);if(!node?.isConnected){send({type:'inspect-node-result',id:m.id,error:'Node no longer exists'});return}const style=getComputedStyle(node),rect=node.getBoundingClientRect(),computed={},names=['display','position','boxSizing','width','height','color','backgroundColor','fontFamily','fontSize','fontWeight','lineHeight','textAlign','overflow','margin','padding','border','opacity','zIndex','flex','gridTemplateColumns'];for(const name of names)computed[name]=String(style[name]||'').slice(0,512);send({type:'inspect-node-result',id:m.id,computed,box:{x:rect.x,y:rect.y,width:rect.width,height:rect.height,top:rect.top,right:rect.right,bottom:rect.bottom,left:rect.left}});return}return previousPortHandler(ev)};port.addEventListener('message',ev=>{const m=ev.data;if(m?.type!=='history-traverse')return;ev.stopImmediatePropagation();if(!Number.isInteger(m.index)||m.index<0||m.index>=virtualHistory.length)return;const oldUrl=virtualUrl();virtualHistoryIndex=m.index;const nextUrl=virtualUrl();updateVirtualBase(nextUrl);reportHistory('traverse');try{window.dispatchEvent(new PopStateEvent('popstate',{state:cloneHistoryState(virtualHistory[virtualHistoryIndex].state)}));if(new URL(oldUrl).hash!==new URL(nextUrl).hash)window.dispatchEvent(new HashChangeEvent('hashchange',{oldURL:oldUrl,newURL:nextUrl}))}catch{}},true);port.start();scan(document);},true);` +
    String.raw`addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&String(e.key||'').toLowerCase()==='f'){nativePreventDefault(e);send({type:'find-open'})}},true);` +
    String.raw`P.postMessage({type:'eya-ready',nonce:N},'*');` +
    String.raw`class EyaXMLHttpRequest extends EventTarget {
      constructor(){super();this.readyState=0;this.status=0;this.statusText='';this.responseURL='';this.responseType='';this.timeout=0;this.withCredentials=false;this.upload=new EventTarget();this._headers=new Headers();this._responseHeaders=new Headers();this._controller=null;this._sent=false;this._timedOut=false;this._generation=0;this._text='';this._response=null;this._method='GET';this._url=''}
      open(method,url,async=true){if(async===false)throw new DOMException('Synchronous requests are not supported.','NotSupportedError');this._controller?.abort();this._generation++;this._method=String(method).toUpperCase();this._url=new URL(url,document.baseURI).href;this._headers=new Headers();this._responseHeaders=new Headers();this._sent=false;this._timedOut=false;this.status=0;this.statusText='';this.responseURL='';this._text='';this._response=null;this._change(1)}
      setRequestHeader(name,value){if(this.readyState!==1||this._sent)throw new DOMException('Invalid state.','InvalidStateError');this._headers.append(name,value)}overrideMimeType(){}
      send(body=null){if(this.readyState!==1||this._sent)throw new DOMException('Invalid state.','InvalidStateError');this._sent=true;this._timedOut=false;const generation=this._generation;this._controller=new AbortController();this._emit('loadstart');const timer=this.timeout>0?setTimeout(()=>{if(generation===this._generation){this._timedOut=true;this._controller.abort()}},this.timeout):null;
        request(this._url,{method:this._method,headers:this._headers,body,signal:this._controller.signal,credentials:this.withCredentials?'include':'same-origin',resourceType:'xmlhttprequest'}).then(async r=>{if(generation!==this._generation)return;this.status=r.status;this.statusText=r.statusText;this.responseURL=responseUrls.get(r)||this._url;this._responseHeaders=r.headers;this._change(2);const bytes=new Uint8Array(await r.arrayBuffer());if(generation!==this._generation)return;this._change(3);this._text=new TextDecoder().decode(bytes);const type=this.responseType;if(type==='arraybuffer')this._response=bytes.buffer;else if(type==='blob')this._response=new Blob([bytes],{type:r.headers.get('content-type')||''});else if(type==='json'){try{this._response=JSON.parse(this._text)}catch{this._response=null}}else if(type==='document')this._response=new DOMParser().parseFromString(this._text,'text/html');else this._response=this._text;this._change(4);this._emit('load');this._emit('loadend')}).catch(e=>{if(generation!==this._generation)return;if(this._timedOut){this.status=0;this._change(4);this._emit('timeout')}else if(e.name==='AbortError'){this._change(0);this._emit('abort')}else{this._change(4);this._emit('error')}this._emit('loadend')}).finally(()=>{if(timer!==null)clearTimeout(timer)})}
      abort(){if(this._controller&&!this._controller.signal.aborted){this._timedOut=false;this._controller.abort()}}
      get response(){return this._response}get responseText(){if(this.responseType&&this.responseType!=='text')throw new DOMException('responseText is unavailable for this responseType.','InvalidStateError');return this._text}getAllResponseHeaders(){return [...this._responseHeaders].map(([k,v])=>k+': '+v+String.fromCharCode(13,10)).join('')}getResponseHeader(name){return this._responseHeaders.get(name)}
      _emit(name){const event=new Event(name);this.dispatchEvent(event);if(typeof this['on'+name]==='function')this['on'+name](event)}_change(state){this.readyState=state;this._emit('readystatechange')}
    }` +
    `EyaXMLHttpRequest.UNSENT=0;EyaXMLHttpRequest.OPENED=1;EyaXMLHttpRequest.HEADERS_RECEIVED=2;EyaXMLHttpRequest.LOADING=3;EyaXMLHttpRequest.DONE=4;window.XMLHttpRequest=EyaXMLHttpRequest;` +
    `const emit=(level,args)=>send({type:'console',level,args:[...args].map(v=>{try{return typeof v==='string'?v:JSON.stringify(v)}catch{return String(v)}})});` +
    `const report=(type,data)=>send({type,...data});` +
    String.raw`const localStore=new Map(Object.entries(S.local||{})),sessionStore=new Map(Object.entries(S.session||{}));const storage=(map,area)=>{let used=[...map].reduce((sum,[key,value])=>sum+new TextEncoder().encode(key).byteLength+new TextEncoder().encode(value).byteLength,0);const quota=area==='local'?S.localQuota:S.sessionQuota;const limit=Number.isSafeInteger(quota)?Math.min(1048576,Math.max(used,quota)):1048576;const reportChange=(action,key,value)=>report('storage',{area,action,key,value});const apply=(action,key,value)=>{if(action==='clear'){map.clear();used=0;return}key=String(key);if(action==='remove'){const old=map.get(key);if(old!==undefined){map.delete(key);used-=new TextEncoder().encode(key).byteLength+new TextEncoder().encode(old).byteLength}return}value=String(value);const old=map.get(key),bytes=new TextEncoder().encode(key).byteLength+new TextEncoder().encode(value).byteLength,previous=old===undefined?0:new TextEncoder().encode(key).byteLength+new TextEncoder().encode(old).byteLength;if(used-previous+bytes<=limit&& (map.has(key)||map.size<5000)){map.set(key,value);used=used-previous+bytes}};map.__eyaApply=apply;const put=(key,value)=>{key=String(key);value=String(value);const old=map.get(key),bytes=new TextEncoder().encode(key).byteLength+new TextEncoder().encode(value).byteLength,previous=old===undefined?0:new TextEncoder().encode(key).byteLength+new TextEncoder().encode(old).byteLength;if(used-previous+bytes>limit||(!map.has(key)&&map.size>=5000))throw new DOMException('The storage quota has been exceeded.','QuotaExceededError');map.set(key,value);used=used-previous+bytes;reportChange('set',key,value)};const target={get length(){return map.size},key:i=>[...map.keys()][Number(i)]??null,getItem:k=>map.get(String(k))??null,setItem:put,removeItem(k){k=String(k);if(map.has(k)){apply('remove',k);reportChange('remove',k)}},clear(){if(map.size){apply('clear');reportChange('clear')}}};return new Proxy(target,{get:(o,k)=>k in o?o[k]:typeof k==='string'?(map.get(k)??null):undefined,set:(o,k,v)=>{if(typeof k==='string'){put(k,v);return true}return false},deleteProperty:(o,k)=>{k=String(k);if(map.has(k)){apply('remove',k);reportChange('remove',k)}return true},ownKeys:()=>[...map.keys()],getOwnPropertyDescriptor:(o,k)=>map.has(k)?{enumerable:true,configurable:true,value:map.get(k)}:undefined})};` +
    String.raw`try{Object.defineProperty(window,'localStorage',{configurable:true,value:storage(localStore,'local')});Object.defineProperty(window,'sessionStorage',{configurable:true,value:storage(sessionStore,'session')})}catch{};` +
    String.raw`report('storage',{area:'local',action:'snapshot',items:[...localStore]});report('storage',{area:'session',action:'snapshot',items:[...sessionStore]});` +
    `for(const level of ['log','info','warn','error','debug']){const old=console[level].bind(console);console[level]=(...a)=>{old(...a);emit(level,a)}};` +
    `addEventListener('error',e=>emit('error',[e.message,e.filename+':'+e.lineno]));` +
    `let domTimer;const snapshot=(node,depth=0,count={n:0})=>{if(count.n++>500)return null;let id=nodeIds.get(node);if(!id){id=++nextNodeId;nodeIds.set(node,id)}elementsById.set(id,node);const value={id,tag:node.nodeName?.toLowerCase?.()||'',attrs:node.nodeType===1?[...node.attributes].slice(0,16).map(a=>[a.name,a.value.slice(0,180)]):[],` +
    `text:node.nodeType===3?node.textContent.slice(0,240):node.children?.length?'':(node.textContent||'').slice(0,240),children:[]};if(depth<4&&node.children)for(const child of [...node.children].slice(0,80)){const result=snapshot(child,depth+1,count);if(result)value.children.push(result)}return value};` +
    `const reportDom=()=>{clearTimeout(domTimer);domTimer=setTimeout(()=>{elementsById.clear();report('dom',{tree:[...document.body.children].slice(0,80).map(node=>snapshot(node)).filter(Boolean)})},40)};` +
    `const removeNavigationMeta=root=>{const nodes=[];if(root.matches?.('meta[http-equiv]'))nodes.push(root);nodes.push(...(root.querySelectorAll?.('meta[http-equiv]')||[]));for(const meta of nodes)if(/^(?:refresh|content-security-policy)$/i.test(meta.getAttribute('http-equiv')||''))meta.remove()};` +
    String.raw`const rewriteCss=async(text,base,depth=0)=>{if(depth>3)return text;let css=text;const check=(items,lengths)=>{let size=css.length;for(let i=0;i<items.length;i++)size+=lengths[i]-items[i][0].length;if(size>8*1024*1024)throw Error('Rewritten stylesheet exceeds the 8 MiB character limit.')};` +
    String.raw`const imports=scanCssResourceMatches(css,/@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)|"([^"]*)"|'([^']*)'|([^\s;]+))([^;]*);/gi);` +
    String.raw`const imported=await Promise.all(imports.map(async m=>{const url=m.slice(1,7).find(v=>v!==undefined)||'';if(/^(?:data:|blob:)/i.test(url))return null;try{return await proxyResource(new URL(url,base).href,'stylesheet')}catch{return ''}}));check(imports,imported.map((url,i)=>url===null?imports[i][0].length:url?16+url.length+imports[i][7].length:0));for(let i=imports.length-1;i>=0;i--){const m=imports[i],url=imported[i];css=css.slice(0,m.index)+(url===null?m[0]:url?'@import url("'+url+'")'+m[7]+';':'')+css.slice(m.index+m[0].length)}` +
    String.raw`const urls=scanCssResourceMatches(css,/url\(\s*(?:["']([^"']*)["']|([^)]*?))\s*\)/gi);const rewritten=await Promise.all(urls.map(async m=>{const raw=(m[1]||m[2]||'').trim();` +
    `if(!raw||/^(?:data:|blob:|#|about:)/i.test(raw))return null;try{const u=new URL(raw,base).href;const fontStart=css.lastIndexOf('@font-face',m.index)>css.lastIndexOf('}',m.index);return await proxyResource(u,fontStart?'font':'image')}catch{return ''}}));` +
    String.raw`check(urls,rewritten.map((url,i)=>url===null?urls[i][0].length:url?url.length+7:16));for(let i=urls.length-1;i>=0;i--){const m=urls[i],blob=rewritten[i];if(blob===null)continue;css=css.slice(0,m.index)+(blob?'url("'+blob+'")':'url(about:blank)')+css.slice(m.index+m[0].length)}return css};` +
    String.raw`const scan=root=>{const selector='[data-eya-src],[data-eya-href],[data-eya-srcset],[data-eya-imagesrcset],[data-eya-module]',nodes=[];if(root.matches?.(selector))nodes.push(root);nodes.push(...(root.querySelectorAll?.(selector)||[]));` +
    String.raw`for(const el of nodes){if(el.__eyaPending)continue;el.__eyaPending=true;const dataAttr=el.hasAttribute('data-eya-href')?'data-eya-href':el.hasAttribute('data-eya-imagesrcset')?'data-eya-imagesrcset':el.hasAttribute('data-eya-srcset')?'data-eya-srcset':'data-eya-src',attr=dataAttr==='data-eya-href'?'href':dataAttr==='data-eya-imagesrcset'?'imagesrcset':dataAttr==='data-eya-srcset'?'srcset':'src';` +
    String.raw`const raw=el.getAttribute(dataAttr);if(!raw)continue;if(attr==='srcset'||attr==='imagesrcset'){const entries=[...raw.matchAll(/(data:[^,\s]+,[^,\s]+|[^,\s]+)(?:\s+(\d+(?:\.\d+)?[wx]))?/gi)].map(match=>({url:match[1],descriptor:match[2]||''}));` +
    String.raw`Promise.all(entries.map(async entry=>{if(/^(?:data:|blob:)/i.test(entry.url))return entry.url;try{return await proxyResource(new URL(entry.url,document.baseURI).href,'image')}catch{return ''}})).then(urls=>{if(el.isConnected){el.setAttribute(attr,entries.map((entry,index)=>urls[index]+(entry.descriptor?' '+entry.descriptor:'')).filter(entry=>entry.trim()).join(', '));el.removeAttribute(dataAttr)}el.__eyaPending=false}).catch(error=>{el.__eyaPending=false;emit('error',[String(error)])});continue}let url;try{url=new URL(raw,document.baseURI).href}catch{el.__eyaPending=false;continue};` +
    `const kind=el.localName==='script'?'script':el.localName==='img'||el.localName==='image'||(el.localName==='source'&&!['video','audio'].includes(el.parentElement?.localName))?'image':el.matches('link[rel~="stylesheet"]')?'stylesheet':el.matches('link[rel~="icon"]')?'image':el.matches('link[as="font"]')?'font':el.localName==='video'||el.localName==='audio'||el.localName==='track'?'media':el.localName==='object'?'object':'other';const moduleScript=el.localName==='script'&&el.hasAttribute('data-eya-module');const loading=moduleScript?proxyResourceSource(url,true,true).promise.then(createModuleGraph):proxyResource(url,kind,{skipLocationRewrite:el.localName==='script'&&el.hasAttribute('integrity')});loading.then(resource=>{const blobUrl=moduleScript?resource.url:resource;if(el.isConnected){if(moduleScript){el.addEventListener('load',resource.release,{once:true});el.addEventListener('error',resource.release,{once:true})}el.setAttribute(attr,blobUrl);el.removeAttribute(dataAttr);el.removeAttribute('data-eya-module')}else if(moduleScript)resource.release();el.__eyaPending=false}).catch(error=>{el.__eyaPending=false;emit('error',[String(error)])});}};` +
    String.raw`const styleWork=root=>{const styles=[];if(root.matches?.('style'))styles.push(root);styles.push(...(root.querySelectorAll?.('style')||[]));` +
    String.raw`for(const el of styles){const source=el.textContent;if(el.__eyaCssText===source||!/(?:url\s*\(|@import\s)/i.test(source))continue;el.__eyaCssText=source;` +
    `rewriteCss(source,document.baseURI).then(css=>{if(el.isConnected&&el.textContent===source){el.textContent=css;el.__eyaCssText=css}}).catch(error=>emit('error',[String(error)]))}` +
    String.raw`const inline=[];if(root.nodeType===1&&root.hasAttribute?.('style'))inline.push(root);inline.push(...(root.querySelectorAll?.('[style]')||[]));for(const el of inline){const value=el.getAttribute('style')||'';` +
    String.raw`if(el.__eyaCssAttribute===value||!/(?:url\s*\(|@import\s)/i.test(value))continue;el.__eyaCssAttribute=value;rewriteCss(value,document.baseURI).then(css=>{` +
    `if(el.isConnected&&el.getAttribute('style')===value){el.setAttribute('style',css);el.__eyaCssAttribute=css}}).catch(error=>emit('error',[String(error)]))}};` +
    `styleWork(document);new MutationObserver(records=>{for(const record of records){if(record.type==='attributes'){const el=record.target,name=record.attributeName;` +
    `if(el.localName==='meta'&&(name==='http-equiv'||name==='content'))removeNavigationMeta(el);` +
    `if(['src','poster','srcset','imagesrcset','background','data'].includes(name)){const raw=el.getAttribute(name);if(raw&&!/^(?:blob:|data:|about:)/i.test(raw)){el.setAttribute(name==='srcset'?'data-eya-srcset':name==='imagesrcset'?'data-eya-imagesrcset':'data-eya-src',raw);el.removeAttribute(name);el.__eyaPending=false;scan(el)}}` +
    `else if((name==='href'||name==='xlink:href')&&!['a','area','base'].includes(el.localName)){const raw=el.getAttribute(name);if(raw&&!/^(?:blob:|data:|about:)/i.test(raw)){el.setAttribute('data-eya-href',raw);el.removeAttribute(name);el.__eyaPending=false;scan(el)}}else if(name==='style')styleWork(el)}` +
    `for(const node of record.addedNodes)if(node.nodeType===1){removeNavigationMeta(node);scan(node);styleWork(node)}if(record.target?.localName==='style')styleWork(record.target)}reportDom()}).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['src','href','xlink:href','poster','srcset','imagesrcset','background','data','style','http-equiv','content']});` +
    `reportDom();report('storage',{items:[]});` +
    `document.addEventListener('click',e=>{const a=e.target.closest?.('a[href],area[href]');if(!a)return;let u;try{u=new URL(a.href,document.baseURI)}catch{e.preventDefault();return}` +
    `e.preventDefault();if(!['http:','https:'].includes(u.protocol))return;if(a.hasAttribute('download'))send({type:'download',url:u.href,filename:a.getAttribute('download')||''});else if(a.target==='_blank')send({type:'open-tab',url:u.href});else send({type:'navigate',url:u.href})},true);` +
    String.raw`try{const nav=window.navigation;if(nav?.addEventListener)nav.addEventListener('navigate',event=>{if(event.hashChange||event.downloadRequest!=null||event.destination?.sameDocument)return;let url;try{url=new URL(String(event.destination?.url||''))}catch{return}if(!event.cancelable){try{nativeStop()}catch{}try{document.documentElement?.replaceChildren()}catch{}send({type:'navigation-unhandled',url:url.href});return}nativePreventDefault(event);if(!['http:','https:'].includes(url.protocol)){emit('error',['Blocked page navigation',url.href]);return}const history=event.navigationType==='replace'?'replace':event.navigationType==='reload'?'reload':'push',formData=event.formData;if(!formData){send({type:'navigate',url:url.href,history});return}(async()=>{try{const req=new Request(url.href,{method:'POST',body:formData}),body=await bytes(req.clone().body);send({type:'navigate',url:url.href,method:'POST',headers:[...req.headers],body,history},body?[body.buffer]:[])}catch(error){emit('error',['Page navigation failed:',String(error)])}})()},true)}catch{}` +
    String.raw`try{const proto=Location.prototype,replaceMethod=(name,history)=>{const descriptor=Object.getOwnPropertyDescriptor(proto,name);if(!descriptor?.configurable||typeof descriptor.value!=='function')return;Object.defineProperty(proto,name,{...descriptor,value:function(value){let url;try{url=new URL(name==='reload'?document.baseURI:String(value),document.baseURI)}catch{return}if(['http:','https:'].includes(url.protocol))send({type:'navigate',url:url.href,history})}})};replaceMethod('assign','push');replaceMethod('replace','replace');replaceMethod('reload','reload')}catch{}` +
    `window.open=(url)=>{try{const u=new URL(url,document.baseURI);if(['http:','https:'].includes(u.protocol))send({type:'open-tab',url:u.href})}catch{}return null};` +
    String.raw`for(const name of ['RTCPeerConnection','webkitRTCPeerConnection'])try{Object.defineProperty(window,name,{configurable:false,writable:false,value:undefined})}catch{try{window[name]=undefined}catch{}}` +
    String.raw`window.addEventListener('submit',async e=>{const form=e.target;if(!(form instanceof HTMLFormElement))return;const submitter=e.submitter,formValue=(attr,property,fallback)=>submitter?.hasAttribute(attr)?submitter[property]:fallback;if(String(formValue('formmethod','formMethod',form.method)).toLowerCase()==='dialog')return;e.preventDefault();` +
    String.raw`try{const method=String(formValue('formmethod','formMethod',form.method)||'get').toUpperCase();if(!['GET','POST'].includes(method))throw Error('Only GET and POST form submissions are supported.');` +
    String.raw`const url=new URL(formValue('formaction','formAction',form.action)||document.baseURI,document.baseURI),data=new FormData(form,submitter);let body=null,headers=[];` +
    String.raw`if(method==='GET'){for(const [k,v] of data)url.searchParams.append(k,typeof v==='string'?v:v.name)}` +
    String.raw`else{const enctype=String(formValue('formenctype','formEnctype',form.enctype)||'application/x-www-form-urlencoded').toLowerCase();` +
    String.raw`if(enctype==='application/x-www-form-urlencoded'){body=new TextEncoder().encode(new URLSearchParams([...data].map(([k,v])=>[k,typeof v==='string'?v:v.name])).toString());headers=[['content-type','application/x-www-form-urlencoded;charset=UTF-8']]}` +
    String.raw`else if(enctype==='text/plain'){body=new TextEncoder().encode([...data].map(([k,v])=>k+'='+(typeof v==='string'?v:v.name)+'\r\n').join(''));headers=[['content-type','text/plain;charset=UTF-8']]}` +
    String.raw`else{const req=new Request(url.href,{method,body:data});body=await bytes(req.clone().body);headers=[...req.headers]}}` +
    String.raw`const message={type:'navigate',url:url.href,method,headers,body};const target=String(formValue('formtarget','formTarget',form.target)||'').toLowerCase();if(target&&target!=='_self')message.type='open-tab';send(message,body?[body.buffer]:[])}catch(error){emit('error',['Form submission failed:',String(error)])}},true);` +
    String.raw`const dispatchSubmit=(form,submitter=null)=>{let event;try{event=new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter})}catch{event=new Event('submit',{bubbles:true,cancelable:true});try{Object.defineProperty(event,'submitter',{value:submitter})}catch{}}form.dispatchEvent(event)};` +
    String.raw`HTMLFormElement.prototype.requestSubmit=function(submitter=null){if(submitter!==null&&(!(submitter instanceof HTMLElement)||submitter.form!==this||!['BUTTON','INPUT'].includes(submitter.tagName)||!['submit','image'].includes(String(submitter.type).toLowerCase())))throw new TypeError('Invalid form submitter.');if(submitter?.disabled||!this.reportValidity())return;dispatchSubmit(this,submitter)};` +
    String.raw`HTMLFormElement.prototype.submit=function(){dispatchSubmit(this,null)};` +
    String.raw`document.addEventListener('click',e=>{const submitter=e.target.closest?.('button,input');if(!submitter||!['submit','image'].includes(String(submitter.type).toLowerCase())||submitter.disabled||!submitter.form)return;e.preventDefault();if(submitter.form.reportValidity())dispatchSubmit(submitter.form,submitter)},true);` +
    `})();`;
}

export function buildIframeRuntime(nonce, initialCookies = '', initialStorage = {}, initialUrl = 'https://example.test/') { return bootstrapSource(nonce, initialCookies, initialStorage, initialUrl); }

export function serializeCosmeticStyleScript(css) {
  if (typeof css !== 'string' || !css || new TextEncoder().encode(css).byteLength > MAX_PAGE_COSMETIC_CSS_BYTES) return '';
  const source = `(()=>{const s=document.createElement('style');s.setAttribute('data-eya-cosmetic','');s.textContent=${JSON.stringify(css)};(document.head||document.documentElement).append(s)})()`;
  return `<script>${escapeScriptElement(source)}</script>`;
}

function injectBootstrap(html, nonce, baseUrl, initialCookies = '', userscripts = [], cosmeticCss = '', initialStorage = {}, userscriptStorage = {}) {
  html = neutralizeDirectResources(html);
  const base = String(baseUrl).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const policy = `<meta http-equiv="Content-Security-Policy" content="${browserFrameCsp()}">`;
  const scripts = serializeUserscriptElements(userscripts, userscriptStorage);
  const cosmetic = serializeCosmeticStyleScript(cosmeticCss);
  const head = `${policy}<base data-eya-proxy-base href="${base}"><script>${bootstrapSource(nonce, initialCookies, initialStorage, baseUrl)}</script>${cosmetic}${scripts}<script>delete window.__eyaUserscriptStorage;delete window.__eyaUserscriptRequest</script>`;
  const lower = html.toLowerCase();
  const start = lower.indexOf('<head');
  if (start >= 0) {
    const end = html.indexOf('>', start);
    if (end >= 0) return `${html.slice(0, end + 1)}${head}${html.slice(end + 1)}`;
  }
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

function escapeScriptElement(source) { return String(source).replace(/<\/script/gi, '<\\/script'); }
export function serializeUserscriptElements(userscripts, storage = {}) {
  const scripts = (Array.isArray(userscripts) ? userscripts : []).map(script => {
    const id = /^[\w-]{1,128}$/.test(String(script.id || '')) ? script.id : '';
    const grants = new Set(Array.isArray(script.grants) ? script.grants : []);
    const runAt = ['document-end', 'document-idle'].includes(script.runAt) ? script.runAt : 'document-start';
    const wrap = source => `(()=>{const __eyaRequestBridge=window.__eyaUserscriptRequest;const __eyaStorageBridge=window.__eyaUserscriptStorage;` + (runAt === 'document-end'
      ? `const __eyaRun=()=>{try{${source}\n}catch(error){console.error(error)}};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',__eyaRun,{once:true});else queueMicrotask(__eyaRun);document.currentScript?.remove()`
      : runAt === 'document-idle'
        ? `const __eyaRun=()=>{const __eyaIdle=()=>{try{${source}\n}catch(error){console.error(error)}};if(typeof window.requestIdleCallback==='function')window.requestIdleCallback(__eyaIdle,{timeout:2000});else setTimeout(__eyaIdle,1)};if(document.readyState==='complete')__eyaRun();else addEventListener('load',__eyaRun,{once:true});document.currentScript?.remove()`
        : `try{\n${source}\n}finally{document.currentScript?.remove()}`) + `})()`;
    if (!id || !grants.size) return `<script data-eya-userscript="">${escapeScriptElement(wrap(script.source))}</script>`;
    const initial = JSON.stringify(storage[id] && typeof storage[id] === 'object' ? storage[id] : Object.create(null));
    const api = [];
    if (grants.has('GM_getValue')) api.push('const GM_getValue=(key,fallback)=>Object.hasOwn(__eyaValues,String(key))?__eyaClone(__eyaValues[String(key)]):fallback;');
    if (grants.has('GM_setValue')) api.push(`const GM_setValue=(key,value)=>{key=String(key);if(key.length>128)throw new RangeError('Userscript storage key is too long.');const clean=__eyaClone(value);__eyaValues[key]=clean;__eyaStorage?.(${JSON.stringify(id)},'set',key,clean);};`);
    if (grants.has('GM_deleteValue')) api.push(`const GM_deleteValue=key=>{key=String(key);delete __eyaValues[key];__eyaStorage?.(${JSON.stringify(id)},'delete',key);};`);
    if (grants.has('GM_listValues')) api.push('const GM_listValues=()=>Object.keys(__eyaValues);');
    if (grants.has('GM_addStyle')) api.push("const GM_addStyle=css=>{css=String(css);if(new TextEncoder().encode(css).length>65536)throw new RangeError('Userscript style exceeds 64 KiB.');const style=document.createElement('style');style.textContent=css;(document.head||document.documentElement).append(style);return style;};");
    if (grants.has('GM_log')) api.push('const GM_log=(...args)=>console.log(...args);');
    if (grants.has('GM_getResourceText') || grants.has('GM_getResourceURL')) {
      const resources = Object.create(null);
      for (const [name, value] of Object.entries(script.resources || {})) {
        if (!/^[\w.-]{1,64}$/.test(name) || !value || typeof value.text !== 'string') continue;
        resources[name] = { text: value.text, url: typeof value.url === 'string' && /^(?:blob:|data:)/.test(value.url) ? value.url : '' };
      }
      api.push(`const __eyaResources=${JSON.stringify(resources)};`);
      if (grants.has('GM_getResourceText')) api.push(`const GM_getResourceText=name=>__eyaResources[String(name)]?.text;`);
      if (grants.has('GM_getResourceURL')) api.push(`const GM_getResourceURL=name=>__eyaResources[String(name)]?.url||undefined;`);
    }
    if (grants.has('GM_xmlhttpRequest')) api.push(`const __eyaRequest=__eyaRequestBridge;const GM_xmlhttpRequest=options=>{if(typeof __eyaRequest!=='function')throw new Error('The userscript request bridge is unavailable.');if(!options||typeof options!=='object')throw new TypeError('GM_xmlhttpRequest options are required.');const controller=new AbortController();let settled=false,timedOut=false,timer=null;const finish=()=>{settled=true;if(timer!==null)clearTimeout(timer)};const timeout=Number(options.timeout);if(Number.isFinite(timeout)&&timeout>0)timer=setTimeout(()=>{timedOut=true;controller.abort(new DOMException('The request timed out.','TimeoutError'))},Math.min(120000,timeout));const handle={abort:()=>{if(!settled)controller.abort()}};__eyaRequest(${JSON.stringify(id)},options,controller.signal).then(async result=>{const response=result.response;const bytes=new Uint8Array(await response.arrayBuffer());let text='';try{text=new TextDecoder().decode(bytes)}catch{}const type=String(options.responseType||'text').toLowerCase();let value=text;if(type==='json'){try{value=JSON.parse(text)}catch{value=null}}else if(type==='arraybuffer'){value=bytes.buffer}else if(type==='blob'){value=new Blob([bytes],{type:response.headers.get('content-type')||''})}else if(type!=='text'){throw new TypeError('Supported GM_xmlhttpRequest response types are text, json, arraybuffer, and blob.')}finish();const event={status:response.status,statusText:response.statusText,response:value,responseText:text,responseType:type,finalUrl:result.finalUrl,responseHeaders:[...response.headers].map(([name,value])=>name+': '+value).join('\\r\\n'),readyState:4};if(typeof options.onload==='function'){try{options.onload(event)}catch{}}}).catch(error=>{finish();if(controller.signal.aborted){const event={status:0,error:String(error&&error.message||'Request aborted.')};const callback=timedOut?options.ontimeout:options.onabort;if(typeof callback==='function')callback(event)}else if(typeof options.onerror==='function')options.onerror({status:0,error:String(error&&error.message||error)})});return handle;};`);
    const source = `(()=>{const __eyaValues=${initial};const __eyaStorage=__eyaStorageBridge;const __eyaClone=value=>{const encoded=JSON.stringify(value);if(typeof encoded!=='string'||new TextEncoder().encode(encoded).length>65536)throw new RangeError('Userscript value exceeds 64 KiB or is not serializable.');return JSON.parse(encoded)};${api.join('')}\n${script.source}\n})()`;
    return `<script data-eya-userscript="">${escapeScriptElement(wrap(source))}</script>`;
  }).join('');
  return scripts;
}

export function serializeUserscriptSources(userscripts, storage = {}) {
  const markup = serializeUserscriptElements(userscripts, storage);
  return [...markup.matchAll(/<script data-eya-userscript="">([\s\S]*?)<\/script>/g)].map(match => match[1]);
}

export function scanHtmlTagTokens(source) {
  const tags = [];
  const rawText = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
  let index = 0, rawTag = '', templateDepth = 0;
  while (index < source.length) {
    if (rawTag) {
      const close = source.slice(index).search(new RegExp(`<\\/\\s*${rawTag}(?=[\\s/>])`, 'i'));
      if (close < 0) break;
      index += close; rawTag = '';
    }
    const start = source.indexOf('<', index);
    if (start < 0) break;
    if (source.startsWith('<!--', start)) {
      const end = source.indexOf('-->', start + 4);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    let cursor = start + 1;
    let closing = false;
    if (source[cursor] === '/') { closing = true; cursor++; }
    if (!/[A-Za-z]/.test(source[cursor] || '')) { index = start + 1; continue; }
    const nameStart = cursor;
    while (/[A-Za-z0-9:-]/.test(source[cursor] || '')) cursor++;
    const name = source.slice(nameStart, cursor).toLowerCase();
    let quote = '';
    while (cursor < source.length) {
      const char = source[cursor++];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    const token = { start, end: cursor, name, closing, nameEnd: nameStart + name.length, templateDepth };
    tags.push(token); index = cursor;
    if (name === 'template') templateDepth = closing ? Math.max(0, templateDepth - 1) : templateDepth + 1;
    if (!closing && rawText.has(name) && name !== 'plaintext' && !/\/\s*>$/.test(source.slice(start, cursor))) rawTag = name;
    if (name === 'plaintext' && !closing) break;
  }
  return tags;
}

export function parsedTagAttributes(tagSource, tag) {
  const template = document.createElement('template');
  template.innerHTML = `<div${tagSource.slice(tag.nameEnd, tag.end - 1)}></div>`;
  return [...(template.content.firstElementChild?.attributes || [])].map(attribute => `${attribute.name}="${escapeHtml(attribute.value)}"`).join(' ');
}

export function sanitizeHtmlFragment(source) {
  const template = document.createElement('template');
  template.innerHTML = source;
  const root = template.content;
  sanitizeHtmlFragmentContent(root);
  return template.innerHTML;
}

export function sanitizeHtmlFragmentContent(root) {
  for (const node of [...root.querySelectorAll('template')]) sanitizeHtmlFragmentContent(node.content);
  for (const meta of root.querySelectorAll('meta[http-equiv]')) {
    if (/^(?:content-security-policy|refresh)$/i.test(meta.getAttribute('http-equiv') || '')) meta.remove();
  }
  root.querySelectorAll('base,iframe,frame,object,embed,link[rel~="modulepreload"],link[rel~="preconnect"],link[rel~="dns-prefetch"],link[rel~="prerender"]').forEach(node => node.remove());
  for (const element of root.querySelectorAll('*')) {
    const name = element.localName;
    if (name === 'script' && !element.hasAttribute('src')) {
      const type = (element.getAttribute('type') || '').trim().toLowerCase();
      if (!type || type === 'text/javascript' || type === 'application/javascript' || type === 'module') {
        element.textContent = rewriteLocationNavigations(element.textContent || '');
      }
    }
    if (name === 'script' && element.getAttribute('type')?.trim().toLowerCase() === 'module' && element.hasAttribute('src')) element.setAttribute('data-eya-module', '');
    const rel = new Set((element.getAttribute('rel') || '').toLowerCase().split(/\s+/));
    for (const attribute of [...element.attributes]) {
      const key = attribute.name.toLowerCase();
      if (key === 'style') continue;
      if ((name === 'a' || name === 'area') && key === 'href') continue;
      if (key === 'href' || key === 'xlink:href') {
        const value = attribute.value.trim();
        const metadataLink = name === 'link' && !['stylesheet', 'icon', 'preload', 'prefetch', 'manifest', 'mask-icon', 'apple-touch-icon'].some(value => rel.has(value));
        if (metadataLink || value.startsWith('#')) continue;
        element.setAttribute('data-eya-href', attribute.value);
        element.removeAttribute(attribute.name);
      } else if (key === 'srcset' || key === 'imagesrcset') {
        element.setAttribute(key === 'imagesrcset' ? 'data-eya-imagesrcset' : 'data-eya-srcset', attribute.value);
        element.removeAttribute(attribute.name);
      } else if (['src', 'poster', 'data', 'background'].includes(key)) {
        element.setAttribute('data-eya-src', attribute.value);
        element.removeAttribute(attribute.name);
      }
    }
  }
  for (const style of root.querySelectorAll('style')) style.setAttribute('__eya-style', '');
}

export function neutralizeDirectResources(html) {
  const source = String(html);
  const tags = scanHtmlTagTokens(source);
  const documentTags = tags.filter(tag => tag.templateDepth === 0);
  const htmlOpen = documentTags.find(tag => tag.name === 'html' && !tag.closing);
  const headOpen = documentTags.find(tag => tag.name === 'head' && !tag.closing);
  const headClose = headOpen && documentTags.find(tag => tag.name === 'head' && tag.closing && tag.start >= headOpen.end);
  const bodyOpen = documentTags.find(tag => tag.name === 'body' && !tag.closing);
  const bodyClose = bodyOpen && documentTags.find(tag => tag.name === 'body' && tag.closing && tag.start >= bodyOpen.end);
  const htmlClose = htmlOpen && documentTags.find(tag => tag.name === 'html' && tag.closing && tag.start >= htmlOpen.end);
  const htmlEnd = htmlClose?.start ?? source.length;
  let headSource = '', bodySource = '';
  if (headOpen) {
    const headEnd = headClose?.start ?? bodyOpen?.start ?? htmlEnd;
    headSource = source.slice(headOpen.end, headEnd);
    const bodyStart = bodyOpen?.end ?? (headClose?.end ?? headEnd);
    bodySource = source.slice(bodyStart, bodyClose?.start ?? htmlEnd);
  } else if (bodyOpen) {
    headSource = source.slice(htmlOpen?.end ?? 0, bodyOpen.start);
    bodySource = source.slice(bodyOpen.end, bodyClose?.start ?? htmlEnd);
  } else {
    bodySource = source.slice(htmlOpen?.end ?? 0, htmlEnd);
  }
  const htmlAttributes = htmlOpen ? parsedTagAttributes(source, htmlOpen) : '';
  const headAttributes = headOpen ? parsedTagAttributes(source, headOpen) : '';
  const bodyAttributes = bodyOpen ? parsedTagAttributes(source, bodyOpen) : '';
  const head = sanitizeHtmlFragment(headSource);
  const body = sanitizeHtmlFragment(bodySource);
  const doctype = /^\s*<!doctype\s+html\b/i.test(source) ? '<!doctype html>' : '';
  return `${doctype}<html${htmlAttributes ? ` ${htmlAttributes}` : ''}><head${headAttributes ? ` ${headAttributes}` : ''}>${head}</head><body${bodyAttributes ? ` ${bodyAttributes}` : ''}>${body}</body></html>`;
}

function appendStyles() {
  if (document.getElementById('eya-browser-panel-styles')) return;
  const style = document.createElement('style'); style.id = 'eya-browser-panel-styles';
  style.textContent = `
  .eya-web-browser{position:relative;display:flex;flex:1;min-width:0;min-height:0;flex-direction:column;background:var(--ui-bg,#10151b);color:var(--ui-fg,#e4edf2);font:13px system-ui}
  .eya-web-browser *{box-sizing:border-box}.eya-web-browser button,.eya-web-browser input,.eya-web-browser select{font:inherit}
  .eya-browser-toolbar,.eya-browser-bookmarks,.eya-browser-tabs,.eya-devtools-toolbar{display:flex;align-items:center;gap:5px;padding:5px;border-bottom:1px solid var(--ui-border,#344854);flex:0 0 auto}
  .eya-browser-toolbar button,.eya-browser-bookmarks button,.eya-browser-tabs button,.eya-devtools-toolbar button{min-height:30px;padding:4px 8px;border:1px solid var(--ui-border,#465b68);border-radius:5px;background:var(--ui-surface,#1d2933);color:inherit;cursor:pointer}
  .eya-browser-local-dialog{width:min(460px,calc(100% - 24px));max-width:none;padding:16px;border:1px solid var(--ui-border,#465b68);border-radius:9px;background:var(--ui-surface,#1d2933);color:var(--ui-fg,#e4edf2);box-shadow:0 16px 48px #000b}.eya-browser-local-dialog::backdrop{background:#0009}.eya-browser-local-dialog form{display:grid;gap:10px}.eya-browser-local-dialog input{min-width:0;padding:8px;border:1px solid var(--ui-border,#465b68);border-radius:5px;background:var(--ui-bg,#10151b);color:inherit;font:12px ui-monospace,monospace}.eya-browser-local-dialog-status{min-height:1.2em;color:var(--ui-muted,#aebfc7);font-size:11px}.eya-browser-local-dialog-actions{display:flex;justify-content:flex-end;gap:6px}
  .eya-browser-page-dialog{width:min(460px,calc(100% - 24px));max-width:none;padding:16px;border:1px solid var(--ui-border,#465b68);border-radius:9px;background:var(--ui-surface,#1d2933);color:var(--ui-fg,#e4edf2);box-shadow:0 16px 48px #000b}.eya-browser-page-dialog::backdrop{background:#0009}.eya-browser-page-dialog form{display:grid;gap:10px}.eya-browser-page-dialog-message{max-height:35vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}.eya-browser-page-dialog input{min-width:0;padding:8px;border:1px solid var(--ui-border,#465b68);border-radius:5px;background:var(--ui-bg,#10151b);color:inherit}.eya-browser-page-dialog-status{min-height:1.2em;color:var(--ui-muted,#aebfc7);font-size:11px}.eya-browser-page-dialog-actions{display:flex;justify-content:flex-end;gap:6px}
  .eya-browser-toolbar button:disabled{opacity:.45;cursor:default}.eya-browser-toolbar .eya-address{flex:1;min-width:80px;padding:7px 10px;border:1px solid var(--ui-border,#465b68);border-radius:6px;background:var(--ui-bg,#10151b);color:inherit}
  .eya-browser-bookmarks{min-height:34px;overflow:auto}.eya-browser-tabs{padding-bottom:0;overflow-x:auto}.eya-browser-tab{max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.eya-browser-tab[aria-selected=true]{border-bottom-color:var(--ui-accent,#54d7bd)}
  .eya-browser-tab-menu{position:relative;flex:none}.eya-browser-tab-menu summary{cursor:pointer;list-style:none;white-space:nowrap;padding:7px;border:1px solid var(--ui-border,#465b68);border-radius:5px}.eya-browser-tab-menu summary::-webkit-details-marker{display:none}.eya-browser-tab-menu .eya-browser-tabs{position:absolute;right:0;top:100%;z-index:20;display:flex;flex-direction:column;align-items:stretch;gap:4px;width:min(300px,80vw);max-height:min(60vh,420px);overflow:auto;padding:6px;background:var(--ui-surface,#1d2933);border:1px solid var(--ui-border,#465b68);border-radius:6px;box-shadow:0 8px 24px #0008}.eya-browser-tab-menu .eya-browser-tabs>div{min-width:0}.eya-browser-tab-menu .eya-browser-tab{flex:1;max-width:none;text-align:left}.eya-browser-tab-menu .eya-browser-tabs>button{width:100%;text-align:center}
  .eya-browser-status{display:flex;align-items:center;gap:6px;padding:3px 8px;color:var(--ui-muted,#aebfc7);font-size:11px;border-bottom:1px solid var(--ui-border,#344854)}
  .eya-browser-find{display:flex;align-items:center;gap:5px;padding:4px 6px;border-bottom:1px solid var(--ui-border,#344854);background:var(--ui-surface,#1d2933);flex:0 0 auto}.eya-browser-find[hidden]{display:none}.eya-browser-find input{flex:1;min-width:70px;padding:5px 7px;border:1px solid var(--ui-border,#465b68);border-radius:5px;background:var(--ui-bg,#10151b);color:inherit}.eya-browser-find button{min-height:28px;padding:3px 7px;border:1px solid var(--ui-border,#465b68);border-radius:5px;background:var(--ui-bg,#10151b);color:inherit;cursor:pointer}.eya-browser-find-status{min-width:90px;color:var(--ui-muted,#aebfc7);font-size:11px;white-space:nowrap}
  .eya-browser-library{position:absolute;z-index:7;inset:8px;display:flex;flex-direction:column;min-width:0;min-height:0;padding:10px;border:1px solid var(--ui-border,#465b68);border-radius:9px;background:var(--ui-surface,#1d2933);box-shadow:0 12px 32px #000a}.eya-browser-library[hidden]{display:none}.eya-browser-library-head,.eya-browser-library-tabs,.eya-browser-library-row{display:flex;align-items:center;gap:7px}.eya-browser-library-head{padding-bottom:8px}.eya-browser-library-head strong{flex:1}.eya-browser-library-search{width:min(360px,50%);padding:6px 8px;border:1px solid var(--ui-border,#465b68);border-radius:5px;background:var(--ui-bg,#10151b);color:inherit}.eya-browser-library button{min-height:30px;padding:4px 8px;border:1px solid var(--ui-border,#465b68);border-radius:5px;background:var(--ui-bg,#10151b);color:inherit;cursor:pointer}.eya-browser-library-tabs{padding-bottom:7px;border-bottom:1px solid var(--ui-border,#465b68)}.eya-browser-library-tabs button[aria-pressed=true]{border-color:var(--ui-accent,#54d7bd)}.eya-browser-library-list{flex:1;min-height:0;overflow:auto}.eya-browser-library-row{align-items:flex-start;padding:8px 2px;border-bottom:1px solid color-mix(in srgb,var(--ui-border,#465b68) 65%,transparent)}.eya-browser-library-row-main{flex:1;min-width:0}.eya-browser-library-row-title{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.eya-browser-library-row-url,.eya-browser-library-row-time{display:block;margin-top:3px;color:var(--ui-muted,#aebfc7);font-size:11px;overflow-wrap:anywhere}.eya-browser-library-title-input{width:min(250px,35%);min-width:70px;padding:4px 6px;border:1px solid var(--ui-border,#465b68);border-radius:4px;background:var(--ui-bg,#10151b);color:inherit}.eya-browser-library-status{min-height:18px;padding-top:6px;color:var(--ui-muted,#aebfc7);font-size:11px}
  .eya-browser-status[data-state=error]{color:#ff9d8f}.eya-browser-status[data-state=warning]{color:#ffd27d}.eya-browser-status .spacer{flex:1}.eya-browser-content{position:relative;display:flex;flex:1;min-height:0;background:#fff}.eya-browser-frame{width:100%;height:100%;flex:1;border:0;background:white}.eya-browser-frame[hidden]{display:none}.eya-browser-remote-view{width:100%;height:100%;object-fit:contain;background:#111;touch-action:none;outline:none}.eya-browser-remote-view[hidden]{display:none}.eya-browser-text-surface{position:absolute;inset:0;z-index:1;overflow:hidden;outline:none;opacity:0;white-space:pre-wrap;overflow-wrap:anywhere;caret-color:transparent;user-select:none;-webkit-user-select:none;touch-action:none}.eya-browser-text-surface[hidden]{display:none}.eya-browser-empty{position:absolute;inset:0;display:grid;place-content:center;text-align:center;color:#53616a;background:#fff;pointer-events:none}.eya-browser-empty[hidden]{display:none}
  .eya-devtools{display:flex;flex:0 0 230px;min-height:120px;max-height:50%;flex-direction:column;background:var(--ui-bg,#10151b);border-top:1px solid var(--ui-border,#526774)}.eya-devtools[hidden]{display:none}.eya-devtools-toolbar{display:flex;align-items:center;gap:5px;padding:3px 6px}.eya-devtools-toolbar button[aria-selected=true]{border-color:var(--ui-accent,#54d7bd)}.eya-devtools-search{min-width:50px;max-width:220px;flex:1;padding:5px 7px;border:1px solid var(--ui-border,#465b68);border-radius:5px;background:var(--ui-bg,#10151b);color:inherit}.eya-devtools-output{flex:1;min-height:0;overflow:auto;padding:6px;font:12px ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.eya-devtools-performance-summary{padding:5px 8px;color:var(--ui-muted,#aebfc7);font-size:11px;overflow-wrap:anywhere;border-bottom:1px solid var(--ui-border,#344854)}.eya-devtools-performance-summary[hidden]{display:none}.eya-network-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(70px,24%);align-items:center;gap:8px;cursor:pointer}.eya-network-row[aria-selected=true]{background:color-mix(in srgb,var(--ui-accent,#54d7bd) 16%,transparent)}.eya-network-row-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.eya-network-waterfall-track{position:relative;display:block;height:9px;overflow:hidden;border-radius:4px;background:color-mix(in srgb,var(--ui-border,#465b68) 50%,transparent)}.eya-network-waterfall-bar{position:absolute;top:1px;bottom:1px;min-width:2px;border-radius:3px;background:var(--ui-accent,#54d7bd)}.eya-network-waterfall-bar[data-state=blocked]{background:#ff7c72}.eya-network-waterfall-bar[data-state=cache]{background:#72b7ff}.eya-devtools-row{padding:3px 5px;border-bottom:1px solid color-mix(in srgb,var(--ui-border,#344854) 65%,transparent)}.eya-devtools-row[data-level=error]{color:#ff9d8f}.eya-devtools-row[data-level=warn]{color:#ffd27d}.eya-devtools-download-row{display:flex;align-items:center;gap:5px;padding:4px 2px;border-bottom:1px solid color-mix(in srgb,var(--ui-border,#344854) 65%,transparent)}.eya-devtools-download-row span{min-width:0;flex:1;overflow-wrap:anywhere}.eya-browser-settings{position:absolute;z-index:5;right:8px;top:40px;width:min(290px,calc(100% - 16px));padding:10px;border:1px solid var(--ui-border,#465b68);border-radius:8px;background:var(--ui-surface,#1d2933);box-shadow:0 8px 24px #0008}.eya-browser-settings[hidden]{display:none}.eya-browser-settings label{display:flex;gap:8px;align-items:center;padding:6px}
  .eya-devtools-console{display:flex;gap:5px;padding:5px;border-top:1px solid var(--ui-border,#344854)}.eya-devtools-console[hidden]{display:none}.eya-devtools-console textarea{flex:1;min-width:0;resize:vertical;max-height:100px;padding:6px 8px;border:1px solid var(--ui-border,#465b68);border-radius:5px;background:var(--ui-bg,#10151b);color:var(--ui-fg,#e4edf2);font:12px ui-monospace,monospace}
  .eya-userscript-list{display:grid;gap:4px;margin:6px 0}.eya-userscript-row{display:flex;align-items:center;gap:6px;min-width:0;padding:4px;border:1px solid var(--ui-border,#344854);border-radius:5px}.eya-userscript-row span{flex:1;min-width:0;overflow-wrap:anywhere;font-size:11px}.eya-userscript-row button{padding:3px 6px}
  .eya-devtools-tabs{display:flex;align-items:center;gap:4px}.eya-devtools-cache-toggle{display:flex;align-items:center;gap:4px;white-space:nowrap;font-size:11px}.eya-devtools-cache-toggle[hidden]{display:none}.eya-devtools-sources{display:flex;flex:1;min-height:0;overflow:hidden}.eya-devtools-sources[hidden]{display:none}.eya-devtools-source-list{display:flex;flex:0 0 min(36%,220px);min-width:105px;flex-direction:column;gap:2px;overflow:auto;padding:4px;border-right:1px solid var(--ui-border,#344854)}.eya-devtools-source-item{flex:0 0 auto;width:100%;padding:4px 5px;border:0;border-radius:3px;background:transparent;color:inherit;text-align:left;font:10px ui-monospace,monospace;overflow-wrap:anywhere;cursor:pointer}.eya-devtools-source-item[aria-selected=true]{background:color-mix(in srgb,var(--ui-accent,#54d7bd) 22%,transparent)}.eya-devtools-source-pane{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column}.eya-devtools-source-nav{display:flex;align-items:center;gap:5px;min-height:28px;padding:3px 6px;border-bottom:1px solid var(--ui-border,#344854)}.eya-devtools-source-nav button{padding:2px 6px}.eya-devtools-source-match-status{flex:1;color:var(--ui-muted,#aebfc7);font-size:10px;text-align:right}.eya-devtools-source-text{flex:1;min-width:0;min-height:0;overflow:auto;margin:0;padding:6px;font:10px/1.35 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.eya-devtools-details{flex:0 0 34%;max-height:34%;overflow:auto;margin:0;padding:6px;border-top:1px solid var(--ui-border,#344854);font:11px ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.eya-devtools-details:empty{display:none}.eya-devtools-element-editor{display:grid;gap:4px;padding:4px 6px;border-top:1px solid var(--ui-border,#344854)}.eya-devtools-element-editor[hidden]{display:none}.eya-devtools-edit-form{display:flex;gap:4px}.eya-devtools-edit-form textarea,.eya-devtools-edit-form input{flex:1;min-width:0;padding:4px 6px;border:1px solid var(--ui-border,#465b68);border-radius:4px;background:var(--ui-bg,#10151b);color:inherit;font:11px ui-monospace,monospace}.eya-devtools-edit-form button{padding:3px 6px}.eya-devtools-edit-status{font-size:10px;color:var(--ui-muted,#aebfc7)}.eya-element-row{display:flex;align-items:center;min-height:24px;white-space:nowrap}.eya-element-row button{min-height:22px;border:0;background:transparent;color:inherit;text-align:left;font:12px ui-monospace,monospace}.eya-element-toggle{width:22px;padding:0;text-align:center!important;color:var(--ui-muted,#aebfc7)!important}.eya-element-select{flex:1;overflow:hidden;text-overflow:ellipsis}.eya-element-select[aria-pressed=true]{background:color-mix(in srgb,var(--ui-accent,#54d7bd) 22%,transparent);color:var(--ui-fg,#e4edf2)}.eya-element-group{padding-left:14px}.eya-filter-info{padding:5px 7px;color:var(--ui-muted,#aebfc7);font-size:11px;overflow-wrap:anywhere}
  .eya-devtools-source-nav input{width:62px;min-width:48px;padding:3px 5px;border:1px solid var(--ui-border,#465b68);border-radius:4px;background:var(--ui-bg,#10151b);color:inherit;font:11px ui-monospace,monospace}
  .eya-devtools-debugger-stack{display:flex;max-height:72px;gap:2px;overflow:auto;padding:3px 6px;border-bottom:1px solid var(--ui-border,#344854)}.eya-devtools-debugger-stack[hidden]{display:none}.eya-devtools-debugger-stack button{flex:0 0 auto;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 5px;border:1px solid var(--ui-border,#465b68);border-radius:3px;background:var(--ui-surface,#1d2933);color:inherit;font:10px ui-monospace,monospace;text-align:left}
  .eya-devtools-object-inspector{display:flex;max-height:42%;min-height:64px;flex-direction:column;border-top:1px solid var(--ui-border,#344854)}.eya-devtools-object-inspector[hidden]{display:none}.eya-devtools-object-inspector-header{display:flex;align-items:center;gap:6px;padding:3px 7px}.eya-devtools-object-inspector-header strong{flex:1;font-size:11px}.eya-devtools-object-inspector-header button{padding:2px 6px}.eya-devtools-object-tree{min-height:0;overflow:auto;padding:2px 6px;font:11px ui-monospace,monospace}.eya-devtools-object-row{display:flex;align-items:flex-start;gap:4px;min-height:20px;padding-left:calc(var(--depth,0)*12px);overflow-wrap:anywhere}.eya-devtools-object-row button{flex:0 0 auto;border:0;background:transparent;color:var(--ui-accent,#54d7bd);font:inherit;text-align:left;cursor:pointer}.eya-devtools-object-value{min-width:0;overflow-wrap:anywhere;color:var(--ui-muted,#aebfc7)}
  .eya-devtools-object-result{display:flex;align-items:flex-start;gap:6px}.eya-devtools-object-result span{min-width:0;flex:1;overflow-wrap:anywhere}.eya-devtools-object-result button{flex:0 0 auto;padding:1px 5px;font-size:10px}
  @media(max-width:600px){.eya-browser-toolbar{gap:3px;padding:4px;flex-wrap:wrap}.eya-browser-toolbar button{min-width:38px;min-height:40px;padding:4px}.eya-browser-toolbar .eya-address{font-size:16px;flex:1 1 45%;min-width:120px}.eya-browser-tab-menu summary{min-height:40px;display:flex;align-items:center}.eya-devtools{flex-basis:185px}.eya-devtools-search{max-width:120px}.eya-devtools-source-nav{flex-wrap:wrap}.eya-devtools-source-nav .eya-devtools-source-match-status{min-width:70px}}
  `;
  document.head.append(style);
}

export function createBrowserPanel({ request, openWebSocket, openRemoteBrowser, readLocalFile, openLocalFile, preferences = {}, serverRenderedByDefault = true }) {
  if (typeof request !== 'function') throw new TypeError('Browser panel requires a proxy request function.');
  appendStyles();
  const element = document.createElement('section'); element.className = 'eya-web-browser';
  const toolbar = document.createElement('div'); toolbar.className = 'eya-browser-toolbar';
  const back = button('←', 'Back', () => navigateHistory(-1));
  const forward = button('→', 'Forward', () => navigateHistory(1));
  const reload = button('↻', 'Reload', () => navigate(active.url, false));
  const address = document.createElement('input'); address.className = 'eya-address'; address.type = 'text'; address.placeholder = 'Search or enter address'; address.setAttribute('aria-label', 'Address or search'); address.autocomplete = 'url';
  const go = button('Go', 'Navigate', () => navigateAddress());
  const bookmark = button('☆', 'Bookmark this page', toggleBookmark);
  const findButton = button('Find', 'Find text in the current page (Ctrl+F)', openFind);
  const privacy = button('◉', 'Privacy and site settings', () => { settings.hidden = !settings.hidden; });
  const localDocs = button('Local HTML', 'Open a local HTML file', openLocalDialog);
  const remoteToggle = button('Fast proxy', 'Switch to client-rendered Proxy mode. It is faster, but page self-navigation is only best-effort confined to the WebSocket.', toggleRemoteMode);
  const pageUploadPicker = document.createElement('input'); pageUploadPicker.type = 'file'; pageUploadPicker.hidden = true;
  const uploadPageFiles = button('Choose files', 'Select local files requested by the remote page', () => {
    if (!pendingRemoteFileChooser) return;
    pageUploadPicker.multiple = pendingRemoteFileChooser.multiple;
    pageUploadPicker.click();
  }); uploadPageFiles.hidden = true;
  const openTools = button('DevTools', 'Toggle developer tools', () => toggleTools());
  toolbar.append(back, forward, reload, address, go, localDocs, uploadPageFiles, pageUploadPicker);
  const localDialog = document.createElement('dialog'); localDialog.className = 'eya-browser-local-dialog';
  const localForm = document.createElement('form'); localForm.method = 'dialog';
  const localTitle = document.createElement('strong'); localTitle.textContent = 'Open local HTML';
  const localPathInput = document.createElement('input'); localPathInput.type = 'text'; localPathInput.autocomplete = 'off'; localPathInput.spellcheck = false;
  localPathInput.placeholder = '/path/to/index.html'; localPathInput.setAttribute('aria-label', 'Path to local HTML file under the Eya file root');
  const localDialogStatus = document.createElement('span'); localDialogStatus.className = 'eya-browser-local-dialog-status'; localDialogStatus.setAttribute('role', 'status');
  const localActions = document.createElement('div'); localActions.className = 'eya-browser-local-dialog-actions';
  const localCancel = button('Cancel', 'Cancel opening a local document', () => localDialog.close());
  const localOpen = button('Open', 'Open the selected local HTML file', () => openLocalPath());
  localActions.append(localCancel, localOpen); localForm.append(localTitle, localPathInput, localDialogStatus, localActions); localDialog.append(localForm);
  const pageDialog = document.createElement('dialog'); pageDialog.className = 'eya-browser-page-dialog';
  const pageDialogForm = document.createElement('form'); pageDialogForm.method = 'dialog';
  const pageDialogTitle = document.createElement('strong');
  const pageDialogMessage = document.createElement('div'); pageDialogMessage.className = 'eya-browser-page-dialog-message';
  const pageDialogPrompt = document.createElement('input'); pageDialogPrompt.type = 'text'; pageDialogPrompt.maxLength = 1024; pageDialogPrompt.autocomplete = 'off'; pageDialogPrompt.hidden = true; pageDialogPrompt.setAttribute('aria-label', 'Response to the web page prompt');
  const pageDialogStatus = document.createElement('span'); pageDialogStatus.className = 'eya-browser-page-dialog-status'; pageDialogStatus.setAttribute('role', 'status');
  const pageDialogActions = document.createElement('div'); pageDialogActions.className = 'eya-browser-page-dialog-actions';
  const pageDialogCancel = button('Cancel', 'Dismiss the web page dialog', () => resolveRemoteDialog(false));
  const pageDialogAccept = button('OK', 'Accept the web page dialog', () => resolveRemoteDialog(true));
  pageDialogActions.append(pageDialogCancel, pageDialogAccept);
  pageDialogForm.append(pageDialogTitle, pageDialogMessage, pageDialogPrompt, pageDialogStatus, pageDialogActions); pageDialog.append(pageDialogForm);
  pageDialogForm.addEventListener('submit', event => { event.preventDefault(); resolveRemoteDialog(true); });
  pageDialog.addEventListener('cancel', event => { event.preventDefault(); resolveRemoteDialog(false); });
  const bookmarkBar = document.createElement('div'); bookmarkBar.className = 'eya-browser-bookmarks'; bookmarkBar.setAttribute('aria-label', 'Bookmarks');
  const tabBar = document.createElement('div'); tabBar.className = 'eya-browser-tabs'; tabBar.setAttribute('role', 'tablist');
  const tabMenu = document.createElement('details'); tabMenu.className = 'eya-browser-tab-menu';
  const tabSummary = document.createElement('summary'); tabSummary.setAttribute('aria-label', 'Browser tabs'); tabSummary.textContent = 'Tabs';
  tabMenu.append(tabSummary, tabBar); toolbar.append(tabMenu);
  const status = document.createElement('div'); status.className = 'eya-browser-status'; status.setAttribute('role', 'status');
  const statusText = document.createElement('span'); statusText.textContent = 'Ready';
  const blockedCount = document.createElement('span'); blockedCount.textContent = '0 blocked';
  const statusSpacer = document.createElement('span'); statusSpacer.className = 'spacer';
  const newTab = button('+', 'New tab', () => createTab(''));
  status.append(statusText, statusSpacer);
  const findBar = document.createElement('div'); findBar.className = 'eya-browser-find'; findBar.setAttribute('role', 'search'); findBar.setAttribute('aria-label', 'Find in page'); findBar.hidden = true;
  const findInput = document.createElement('input'); findInput.type = 'search'; findInput.placeholder = 'Find in page'; findInput.setAttribute('aria-label', 'Find text in the current page'); findInput.maxLength = 256;
  const findPrevious = button('↑', 'Find previous match (Shift+Enter)', () => searchInPage(true));
  const findNext = button('↓', 'Find next match (Enter)', () => searchInPage(false));
  const findStatus = document.createElement('span'); findStatus.className = 'eya-browser-find-status'; findStatus.setAttribute('role', 'status'); findStatus.setAttribute('aria-live', 'polite');
  const findClose = button('×', 'Close Find and return to page', closeFind);
  findBar.append(findInput, findPrevious, findNext, findStatus, findClose);
  const page = document.createElement('div'); page.className = 'eya-browser-content';
  const empty = document.createElement('div'); empty.className = 'eya-browser-empty'; empty.innerHTML = '<div><strong>Eya Browser</strong><p>Open a web page in server Chromium, or choose Fast proxy for local rendering.</p></div>';
  page.append(empty);
  const settings = document.createElement('div'); settings.className = 'eya-browser-settings'; settings.hidden = true;
  settings.innerHTML = '<strong>Privacy controls</strong><label><input type="checkbox" data-pref="blockTrackers" /> Block ads and trackers</label><label><input type="checkbox" data-pref="blockThirdParty" /> Block third-party requests</label><label><input type="checkbox" data-pref="stripTracking" /> Remove common tracking parameters</label><p>Built-in privacy controls apply in both modes. Imported network rules apply in Proxy and Full-browser modes; cosmetic selectors apply in Proxy mode only.</p><hr /><strong>Page scripts and extensions</strong><p>Import trusted userscripts. They run in the page world on matching sites at document start by default, or at document end or idle when specified. Proxy mode supports limited GM_addStyle, GM_log, opt-in GM_* value storage, GM_getResourceText, GM_getResourceURL, and GM_xmlhttpRequest grants. Full browser supports @grant none, GM_addStyle, and GM_log with a bounded per-page upload. The Full browser Extensions panel can load unpacked Manifest V3 extension folders into its temporary Chromium profile; declared actions can be triggered on the active page, and popup page targets open as Eya tabs. Extension code is executable and extensions are removed when Full browser closes. In Proxy mode, declared @resource files are fetched without page cookies, capped at 1 MiB each and 2 MiB per page. GM_xmlhttpRequest requires explicit @connect hosts, omits credentials, rejects redirects, and caps responses at 2 MiB. Page scripts and the site share a JavaScript world, so userscript state is not secret from that page. External @require code is not supported.</p>';
  const filterFile = document.createElement('input'); filterFile.type = 'file'; filterFile.accept = '.txt,.list,text/plain'; filterFile.hidden = true;
  const importFilters = button('Import filter list', 'Choose a local EasyList or hosts filter file', () => filterFile.click());
  const clearFilters = button('Remove filter list', 'Remove the imported filter list', () => {
    filterListText = ''; filters = compileFilterList('');
    try { localStorage.removeItem(FILTER_LIST_KEY); filterInfo.textContent = 'No imported rules.'; }
    catch { filterInfo.textContent = 'No imported rules for this panel.'; }
    clearFilters.disabled = true;
    if (remoteMode && remoteTransport?.ready) syncRemoteFilters().catch(error => { filterInfo.textContent = String(error.message || error); });
  });
  const filterInfo = document.createElement('div'); filterInfo.className = 'eya-filter-info'; filterInfo.setAttribute('role', 'status');
  settings.append(importFilters, clearFilters, filterFile, filterInfo);
  const remoteView = document.createElement('img'); remoteView.className = 'eya-browser-remote-view'; remoteView.alt = 'Remote browser page'; remoteView.tabIndex = 0; remoteView.draggable = false; remoteView.hidden = true;
  const remoteTextSurface = document.createElement('div'); remoteTextSurface.className = 'eya-browser-text-surface'; remoteTextSurface.contentEditable = 'true'; remoteTextSurface.setAttribute('role', 'textbox'); remoteTextSurface.setAttribute('aria-label', 'Remote page text input; paste and composed text are sent to the remote browser'); remoteTextSurface.spellcheck = false; remoteTextSurface.autocapitalize = 'off'; remoteTextSurface.hidden = true;
  page.append(remoteView, remoteTextSurface);
  const userscriptFile = document.createElement('input'); userscriptFile.type = 'file'; userscriptFile.accept = '.user.js,.js,application/javascript,text/javascript'; userscriptFile.hidden = true;
  const importUserscript = button('Import userscript', 'Import a local JavaScript userscript for matching websites', () => userscriptFile.click());
  const userscriptList = document.createElement('div'); userscriptList.className = 'eya-userscript-list'; userscriptList.setAttribute('aria-label', 'Imported userscripts');
  const userscriptInfo = document.createElement('div'); userscriptInfo.className = 'eya-filter-info'; userscriptInfo.setAttribute('role', 'status');
  settings.append(importUserscript, userscriptFile, userscriptList, userscriptInfo);
  page.append(settings);
  const library = document.createElement('section'); library.className = 'eya-browser-library'; library.hidden = true; library.setAttribute('role', 'dialog'); library.setAttribute('aria-modal', 'true'); library.setAttribute('aria-label', 'Bookmarks and browsing history');
  const libraryHead = document.createElement('div'); libraryHead.className = 'eya-browser-library-head';
  const libraryTitle = document.createElement('strong'); libraryTitle.textContent = 'Library';
  const librarySearch = document.createElement('input'); librarySearch.className = 'eya-browser-library-search'; librarySearch.type = 'search'; librarySearch.placeholder = 'Search titles and addresses'; librarySearch.setAttribute('aria-label', 'Search bookmarks and history');
  const libraryClose = button('Close', 'Close bookmarks and history', closeLibrary);
  libraryHead.append(libraryTitle, librarySearch, libraryClose);
  const libraryTabs = document.createElement('div'); libraryTabs.className = 'eya-browser-library-tabs'; libraryTabs.setAttribute('role', 'group'); libraryTabs.setAttribute('aria-label', 'Library section');
  const libraryBookmarksButton = button('Bookmarks', 'Show bookmarks', () => setLibraryMode('bookmarks'));
  const libraryHistoryButton = button('History', 'Show browsing history', () => setLibraryMode('history'));
  const importBookmarkFile = document.createElement('input'); importBookmarkFile.type = 'file'; importBookmarkFile.accept = '.json,application/json'; importBookmarkFile.hidden = true;
  const importBookmarksButton = button('Import', 'Import bookmarks from an Eya JSON backup', () => importBookmarkFile.click());
  const exportBookmarksButton = button('Export', 'Download bookmarks as an Eya JSON backup', exportBookmarks);
  const clearLibraryHistory = button('Clear history', 'Clear all saved browsing history', clearHistory); clearLibraryHistory.hidden = true;
  libraryTabs.append(libraryBookmarksButton, libraryHistoryButton, importBookmarksButton, exportBookmarksButton, importBookmarkFile, clearLibraryHistory);
  const libraryList = document.createElement('div'); libraryList.className = 'eya-browser-library-list'; libraryList.setAttribute('role', 'list');
  const libraryStatus = document.createElement('div'); libraryStatus.className = 'eya-browser-library-status'; libraryStatus.setAttribute('role', 'status');
  library.append(libraryHead, libraryTabs, libraryList, libraryStatus);
  const devtools = document.createElement('section'); devtools.className = 'eya-devtools'; devtools.hidden = preferences.devtoolsOpen !== true;
  const devToolbar = document.createElement('div'); devToolbar.className = 'eya-devtools-toolbar'; devToolbar.setAttribute('role', 'toolbar');
  const devTabList = document.createElement('div'); devTabList.className = 'eya-devtools-tabs'; devTabList.setAttribute('role', 'tablist');
  const devSearch = document.createElement('input'); devSearch.className = 'eya-devtools-search'; devSearch.type = 'search'; devSearch.placeholder = 'Filter'; devSearch.setAttribute('aria-label', 'Filter DevTools output');
  const disableCacheLabel = document.createElement('label'); disableCacheLabel.className = 'eya-devtools-cache-toggle';
  const disableCache = document.createElement('input'); disableCache.type = 'checkbox'; disableCache.setAttribute('aria-label', 'Disable proxy cache');
  disableCacheLabel.append(disableCache, document.createTextNode('Disable cache'));
  const captureBodiesLabel = document.createElement('label'); captureBodiesLabel.className = 'eya-devtools-cache-toggle';
  const captureBodies = document.createElement('input'); captureBodies.type = 'checkbox'; captureBodies.setAttribute('aria-label', 'Capture streamed page API response bodies in Network');
  captureBodiesLabel.title = 'Opt in to retaining up to 256 KiB per text response and 2 MiB total for this panel. Captured bodies can contain private data.';
  captureBodiesLabel.append(captureBodies, document.createTextNode('Capture API bodies (private)'));
  const exportHarButton = button('Export HAR', 'Export Network requests as a privacy-scrubbed HAR 1.2 file', exportNetworkHar); exportHarButton.hidden = true;
  const performanceCaptureButton = button('Capture', 'Capture the current page Performance API snapshot', requestPerformanceSnapshot); performanceCaptureButton.hidden = true;
  const performanceRecordButton = button('Record', 'Start recording page performance entries', togglePerformanceRecording); performanceRecordButton.hidden = true;
  const clearDev = button('Clear', 'Clear current DevTools output', () => {
    if (!active) return;
    if (remoteMode && devTab === 'Elements') { requestRemoteDomSnapshot(active); return; }
    if (remoteMode && devTab === 'Sources') { requestRemoteSources(active); return; }
    if (devTab === 'Console') { active.console = []; active.selectedRemoteObject = null; active.remoteObjectProperties?.clear(); active.remoteObjectExpanded?.clear(); }
    else if (devTab === 'Network') {
      for (const row of active.network) releaseCapturedNetworkRow(row);
      for (const relay of active.requestControllers.values()) {
        if (relay.networkRow) { releaseRelayCapture(relay); relay.networkRow = null; }
      }
      active.network = []; active.selectedRequest = null;
    }
    else if (devTab === 'Elements') { active.dom = null; active.selectedNodeId = null; active.collapsedNodes?.clear(); }
    else if (devTab === 'Sources') clearTabSources(active);
    else if (devTab === 'Downloads') clearDownloads();
    else if (devTab === 'Performance') {
      active.performance = []; active.performanceMemory = null; active.selectedPerformance = null;
      if (remoteMode) stopRemotePerformanceRecording(active); else active.port?.postMessage({ type: 'performance-record-stop' });
    }
    else if (devTab === 'Storage') active.storage = [];
    renderDevtools();
  });
  const clearSiteDataButton = button('Clear site data', 'Clear stored data and cookies for the current origin', clearSiteData);
  clearSiteDataButton.hidden = true;
  const devOutput = document.createElement('div'); devOutput.className = 'eya-devtools-output'; devOutput.setAttribute('role', 'log');
  const devPerformanceSummary = document.createElement('div'); devPerformanceSummary.className = 'eya-devtools-performance-summary'; devPerformanceSummary.hidden = true;
  const devSourceView = document.createElement('section'); devSourceView.className = 'eya-devtools-sources'; devSourceView.hidden = true;
  const devSourceList = document.createElement('div'); devSourceList.className = 'eya-devtools-source-list'; devSourceList.setAttribute('role', 'listbox'); devSourceList.setAttribute('aria-label', 'Loaded page sources');
  const devSourceText = document.createElement('pre'); devSourceText.className = 'eya-devtools-source-text'; devSourceText.setAttribute('aria-label', 'Selected source text');
  const devSourcePane = document.createElement('div'); devSourcePane.className = 'eya-devtools-source-pane';
  const devSourceNav = document.createElement('div'); devSourceNav.className = 'eya-devtools-source-nav'; devSourceNav.setAttribute('role', 'toolbar'); devSourceNav.setAttribute('aria-label', 'Source search navigation');
  const prevSourceMatch = button('Previous', 'Select the previous source-text match', () => moveSourceMatch(-1));
  const nextSourceMatch = button('Next', 'Select the next source-text match', () => moveSourceMatch(1));
  const sourceMatchStatus = document.createElement('span'); sourceMatchStatus.className = 'eya-devtools-source-match-status'; sourceMatchStatus.setAttribute('role', 'status');
  const sourceBreakpointLine = document.createElement('input'); sourceBreakpointLine.type = 'number'; sourceBreakpointLine.min = '1'; sourceBreakpointLine.max = '1000000'; sourceBreakpointLine.value = '1'; sourceBreakpointLine.placeholder = 'Line'; sourceBreakpointLine.title = 'One-based source line for a Full-browser breakpoint'; sourceBreakpointLine.setAttribute('aria-label', 'Breakpoint line number');
  const sourceBreakpointToggle = button('Set breakpoint', 'Set or remove a breakpoint in the selected Full-browser source', toggleSourceBreakpoint);
  devSourceNav.append(prevSourceMatch, nextSourceMatch, sourceMatchStatus, sourceBreakpointLine, sourceBreakpointToggle);
  const debuggerToolbar = document.createElement('div'); debuggerToolbar.className = 'eya-devtools-source-nav'; debuggerToolbar.setAttribute('role', 'toolbar'); debuggerToolbar.setAttribute('aria-label', 'JavaScript debugger controls');
  const debuggerPause = button('Pause', 'Pause JavaScript in the remote page', () => runRemoteDebugger('pause'));
  const debuggerResume = button('Resume', 'Resume JavaScript in the remote page', () => runRemoteDebugger('resume'));
  const debuggerStepOver = button('Step over', 'Step over the current JavaScript statement', () => runRemoteDebugger('stepOver'));
  const debuggerStepInto = button('Step into', 'Step into the current JavaScript call', () => runRemoteDebugger('stepInto'));
  const debuggerStepOut = button('Step out', 'Step out of the current JavaScript function', () => runRemoteDebugger('stepOut'));
  const debuggerStatus = document.createElement('span'); debuggerStatus.className = 'eya-devtools-source-match-status'; debuggerStatus.setAttribute('role', 'status');
  debuggerToolbar.append(debuggerPause, debuggerResume, debuggerStepOver, debuggerStepInto, debuggerStepOut, debuggerStatus);
  const debuggerCallStack = document.createElement('div'); debuggerCallStack.className = 'eya-devtools-debugger-stack'; debuggerCallStack.setAttribute('role', 'list'); debuggerCallStack.setAttribute('aria-label', 'JavaScript call stack'); debuggerCallStack.hidden = true;
  const debuggerScopes = document.createElement('div'); debuggerScopes.className = 'eya-devtools-debugger-stack'; debuggerScopes.setAttribute('role', 'list'); debuggerScopes.setAttribute('aria-label', 'Paused call frame scopes'); debuggerScopes.hidden = true;
  devSourcePane.append(debuggerToolbar, debuggerCallStack, debuggerScopes, devSourceNav, devSourceText);
  devSourceView.append(devSourceList, devSourcePane);
  const devConsole = document.createElement('form'); devConsole.className = 'eya-devtools-console';
  const consoleInput = document.createElement('textarea'); consoleInput.rows = 1; consoleInput.placeholder = 'Evaluate JavaScript (↑/↓ command history)'; consoleInput.setAttribute('aria-label', 'JavaScript console input; use Up and Down arrows for command history');
  const consoleRun = button('Run', 'Evaluate console input', () => {}); consoleRun.type = 'submit';
  devConsole.append(consoleInput, consoleRun);
  const consoleCommandHistory = createConsoleCommandHistory();
  const loadNetworkBodyButton = button('Load body', 'Fetch a bounded response body from the Full browser session', () => loadRemoteNetworkBody(active, active?.selectedRequest)); loadNetworkBodyButton.hidden = true;
  const devDetails = document.createElement('pre'); devDetails.className = 'eya-devtools-details'; devDetails.setAttribute('aria-label', 'Selected DevTools item details');
  const devObjectInspector = document.createElement('section'); devObjectInspector.className = 'eya-devtools-object-inspector'; devObjectInspector.hidden = true; devObjectInspector.setAttribute('aria-label', 'Remote JavaScript object inspector');
  const devObjectInspectorHeader = document.createElement('div'); devObjectInspectorHeader.className = 'eya-devtools-object-inspector-header';
  const devObjectInspectorTitle = document.createElement('strong'); devObjectInspectorTitle.textContent = 'Object inspector';
  const devObjectInspectorClose = button('Close', 'Close the JavaScript object inspector', () => { if (active) { active.selectedRemoteObject = null; active.remoteObjectProperties?.clear(); active.remoteObjectExpanded?.clear(); } renderDevtools(); });
  devObjectInspectorHeader.append(devObjectInspectorTitle, devObjectInspectorClose);
  const devObjectInspectorTree = document.createElement('div'); devObjectInspectorTree.className = 'eya-devtools-object-tree'; devObjectInspectorTree.setAttribute('role', 'tree');
  devObjectInspector.append(devObjectInspectorHeader, devObjectInspectorTree);
  const devElementEditor = document.createElement('section'); devElementEditor.className = 'eya-devtools-element-editor'; devElementEditor.hidden = true;
  const textEditForm = document.createElement('form'); textEditForm.className = 'eya-devtools-edit-form';
  const textEdit = document.createElement('textarea'); textEdit.rows = 1; textEdit.maxLength = 4096; textEdit.placeholder = 'Leaf text (up to 4 KiB)'; textEdit.setAttribute('aria-label', 'Edit selected element text');
  const applyTextEdit = button('Set text', 'Set selected leaf element text', () => {}); applyTextEdit.type = 'submit'; textEditForm.append(textEdit, applyTextEdit);
  const attributeEditForm = document.createElement('form'); attributeEditForm.className = 'eya-devtools-edit-form';
  const attributeName = document.createElement('input'); attributeName.type = 'text'; attributeName.maxLength = 64; attributeName.placeholder = 'aria-label'; attributeName.setAttribute('aria-label', 'Attribute name');
  const attributeValue = document.createElement('input'); attributeValue.type = 'text'; attributeValue.maxLength = 512; attributeValue.placeholder = 'Attribute value'; attributeValue.setAttribute('aria-label', 'Attribute value');
  const applyAttributeEdit = button('Set attribute', 'Set a safe selected element attribute', () => {}); applyAttributeEdit.type = 'submit'; attributeEditForm.append(attributeName, attributeValue, applyAttributeEdit);
  const styleEditForm = document.createElement('form'); styleEditForm.className = 'eya-devtools-edit-form';
  const styleProperty = document.createElement('input'); styleProperty.type = 'text'; styleProperty.maxLength = 32; styleProperty.value = 'color'; styleProperty.setAttribute('aria-label', 'CSS property'); styleProperty.placeholder = 'color';
  const styleValue = document.createElement('input'); styleValue.type = 'text'; styleValue.maxLength = 512; styleValue.setAttribute('aria-label', 'CSS value'); styleValue.placeholder = 'CSS value';
  const applyStyleEdit = button('Set style', 'Set an allowed inline CSS property', () => {}); applyStyleEdit.type = 'submit'; styleEditForm.append(styleProperty, styleValue, applyStyleEdit);
  const devEditStatus = document.createElement('span'); devEditStatus.className = 'eya-devtools-edit-status'; devEditStatus.setAttribute('role', 'status');
  devElementEditor.append(textEditForm, attributeEditForm, styleEditForm, devEditStatus);
  const devExtensions = document.createElement('section'); devExtensions.className = 'eya-devtools-extensions'; devExtensions.hidden = true;
  const extensionPicker = document.createElement('input'); extensionPicker.type = 'file'; extensionPicker.multiple = true; extensionPicker.hidden = true; extensionPicker.setAttribute('webkitdirectory', ''); extensionPicker.setAttribute('directory', '');
  const extensionImport = button('Load unpacked extension', 'Load a trusted extension directory into the temporary Full browser profile', () => extensionPicker.click()); extensionImport.disabled = true;
  const extensionStatus = document.createElement('p'); extensionStatus.setAttribute('role', 'status'); extensionStatus.textContent = 'Extensions run executable code in the remote browser profile; page privacy filters may not cover extension background requests. Extensions are removed when Full browser closes.';
  const extensionList = document.createElement('div'); extensionList.className = 'eya-devtools-extension-list';
  devExtensions.append(extensionImport, extensionPicker, extensionStatus, extensionList);
  let remoteExtensions = [];
  let remoteBreakpoints = new Map();
  let remoteDebuggerPaused = null;
  const devTabs = ['Console', 'Network', 'Performance', 'Elements', 'Sources', 'Downloads', 'Storage', 'Extensions']; let devTab = 'Console';
  const devTabButtons = new Map();
  for (const name of devTabs) {
    const item = button(name, `${name} panel`, () => { devTab = name; renderDevtools(); if (name === 'Performance') requestPerformanceSnapshot(); else if (name === 'Elements' && remoteMode) requestRemoteDomSnapshot(); else if (name === 'Sources' && remoteMode) requestRemoteSources(); else if (name === 'Storage' && remoteMode) requestRemoteStorageSnapshot(); });
    item.setAttribute('role', 'tab'); devTabButtons.set(name, item); devTabList.append(item);
  }
  devToolbar.append(devTabList, devSearch, disableCacheLabel, captureBodiesLabel, exportHarButton, performanceCaptureButton, performanceRecordButton, clearSiteDataButton, clearDev);
  devtools.append(devToolbar, loadNetworkBodyButton, devPerformanceSummary, devOutput, devSourceView, devConsole, devElementEditor, devExtensions, devObjectInspector, devDetails);
  element.append(toolbar, status, findBar, page, localDialog, pageDialog);

  let storedHistory = [];
  if (!Array.isArray(storedHistory)) storedHistory = [];
  let bookmarks = [];
  if (!Array.isArray(bookmarks)) bookmarks = [];
  let siteStorage = readSiteStorage();
  let siteStorageBytes = Object.values(siteStorage).reduce((sum, values) => sum + storageObjectBytes(values), 0);
  let siteStorageByteCounts = Object.fromEntries(Object.entries(siteStorage).map(([origin, values]) => [origin, storageObjectBytes(values)]));
  let siteStorageDb = null; let siteStorageWriteChain = Promise.resolve();
  const siteStorageReady = (async () => {
    try {
      const database = await openBrowserStorageDb();
      if (disposed) { database.close(); return; }
      siteStorageDb = database;
      const saved = await readBrowserStorageDb(siteStorageDb, SITE_STORAGE_KEY);
      if (saved && typeof saved === 'object') siteStorage = sanitizeSiteStorage(saved);
      else await writeBrowserStorageDb(siteStorageDb, SITE_STORAGE_KEY, siteStorage);
    } catch { siteStorageDb = null; }
    siteStorageBytes = Object.values(siteStorage).reduce((sum, values) => sum + storageObjectBytes(values), 0);
    siteStorageByteCounts = Object.fromEntries(Object.entries(siteStorage).map(([origin, values]) => [origin, storageObjectBytes(values)]));
  })();
  let siteStoragePersistTimer = null;
  function persistSiteStorageSoon() {
    if (siteStoragePersistTimer) return;
    siteStoragePersistTimer = setTimeout(() => {
      siteStoragePersistTimer = null;
      const snapshot = sanitizeSiteStorage(siteStorage);
      siteStorageWriteChain = siteStorageWriteChain.then(async () => {
        if (siteStorageDb) await writeBrowserStorageDb(siteStorageDb, SITE_STORAGE_KEY, snapshot);
        else writeStore(SITE_STORAGE_KEY, snapshot);
      }).catch(() => writeStore(SITE_STORAGE_KEY, snapshot));
    }, 200);
  }
  let libraryMode = 'bookmarks';
  let libraryReturnFocus = null;
  let prefs = { ...readStore(PREFS_KEY, {}), ...preferences, blockTrackers: false, blockThirdParty: false, stripTracking: false, disableCache: false, devtoolsOpen: false };
  disableCache.checked = prefs.disableCache === true;
  function browserRequest(url, options = {}) {
    return request(url, { ...options, bypassCache: prefs.disableCache === true || options.bypassCache === true });
  }
  let filterListText = readStore(FILTER_LIST_KEY, ''); if (typeof filterListText !== 'string') filterListText = '';
  let filters, filterListError = '';
  try { filters = compileFilterList(filterListText); }
  catch (error) { filterListText = ''; filters = compileFilterList(''); filterListError = String(error.message || error); }
  clearFilters.disabled = !filterListText;
  filterInfo.textContent = filterListError || (filters.count ? `${filters.count.toLocaleString()} imported rules loaded.` : 'No imported rules.');
  let userscriptStorage = sanitizeUserscriptStorage(readStore(USERSCRIPT_STORAGE_KEY, {}));
  let userscripts = [], userscriptStored = readStore(USERSCRIPTS_KEY, []), userscriptBytes = 0;
  if (Array.isArray(userscriptStored)) for (const item of userscriptStored.slice(0, MAX_USERSCRIPTS)) {
    if (!item || typeof item.source !== 'string') continue;
    try {
      const parsed = parseUserScript(item.source), size = new TextEncoder().encode(parsed.source).byteLength;
      if (userscriptBytes + size > MAX_USERSCRIPTS_TOTAL_BYTES) break;
      const id = typeof item.id === 'string' && !userscripts.some(script => script.id === item.id) ? item.id : randomToken();
      userscripts.push({ id, enabled: item.enabled !== false, ...parsed }); userscriptBytes += size;
    } catch { /* Ignore invalid or unsupported entries from old local storage. */ }
  }
  const tabs = []; const downloads = []; const cookieJar = []; const corsPreflightCache = new Map(); const resourceBudget = createResourceBudget(); const userscriptRequestCounts = new Map(); let activeUserscriptRequests = 0; let active = null; let disposed = false; let requestSequence = 0; let sourceBytes = 0, findTimer = null; let captureNetworkBodies = false, networkCaptureBytes = 0; const controllers = new Set();
  let remoteMode = false, remoteTransport = null, remoteOpening = null, remoteGeneration = 0, remoteObjectUrl = '', remoteFramePending = null, remotePointerEvent = null, remotePointerFrame = 0, remoteTouchActive = false, remoteFilterSync = null, pendingRemoteFileChooser = null;
  const remoteTouchContacts = new Map();
  const remoteTouchMoveEvents = new Map();
  const pendingRemoteDialogs = new Map();
  let localViewer = null, localViewerRequest = 0, localViewerUiState = null;
  const remoteViewport = { width: 1280, height: 720 };
  const remoteMousePointers = new Set();
  const onMessage = event => {
    const tab = tabs.find(value => value.iframe?.contentWindow === event.source);
    if (!tab || event.origin !== 'null') return;
    const message = event.data;
    if (!message || message.nonce !== tab.nonce) return;
    if (message.type === 'eya-ready') {
      if (tab.port) return;
      const channel = new MessageChannel(); tab.port = channel.port1;
      const frameNonce = tab.nonce; const framePort = channel.port1;
      tab.port.onmessage = value => handleFrameMessage(tab, value.data, framePort, frameNonce);
      tab.port.start(); tab.iframe.contentWindow.postMessage({ type: 'eya-connect', nonce: tab.nonce }, '*', [channel.port2]);
      tab.port.postMessage({ type: 'cookie-snapshot', value: cookieString(cookieJar, tab.url, { includeHttpOnly: false }) });
    }
  };
  window.addEventListener('message', onMessage);

  function releaseCapturedNetworkRow(row) {
    if (!row) return;
    if (Number.isSafeInteger(row.captureBytes) && row.captureBytes > 0) networkCaptureBytes = Math.max(0, networkCaptureBytes - row.captureBytes);
    if (Number.isSafeInteger(row.remoteBodyBytes) && row.remoteBodyBytes > 0) networkCaptureBytes = Math.max(0, networkCaptureBytes - row.remoteBodyBytes);
    delete row.captureBytes; delete row.responseBody; delete row.responseBodyText; delete row.responseBodyTextLike; delete row.responseBodyTruncated;
    delete row.responseBodyCaptured; delete row.remoteBodyBytes; delete row.remoteBodyLoading; delete row.remoteBodyError;
  }
  function releaseRelayCapture(relay) {
    if (!relay) return;
    if (Number.isSafeInteger(relay.captureBytes) && relay.captureBytes > 0) networkCaptureBytes = Math.max(0, networkCaptureBytes - relay.captureBytes);
    relay.captureBytes = 0; relay.captureChunks = []; relay.captureDisabled = true;
  }
  function trim(list) {
    if (list.length > 500) {
      const removed = list.splice(0, list.length - 500);
      for (const row of removed) releaseCapturedNetworkRow(row);
    }
  }
  function queueNetworkRender(tab) {
    if (tab !== active || devTab !== 'Network' || tab.networkRenderPending) return;
    tab.networkRenderPending = true;
    requestAnimationFrame(() => {
      tab.networkRenderPending = false;
      if (tab === active && devTab === 'Network' && !disposed) renderDevtools();
    });
  }
  function clearTabSources(tab) {
    sourceBytes = Math.max(0, sourceBytes - (tab.sources || []).reduce((sum, source) => sum + source.bytes, 0));
    tab.sources = []; tab.selectedSource = null; tab.remoteSourcesLoading = false; tab.remoteSourcesError = '';
  }
  function moveSourceMatch(delta) {
    const source = (active?.sources || []).find(item => item.key === active.selectedSource);
    if (!active || !source) return;
    const matches = findSourceMatchRanges(source.text, devSearch.value.trim()).matches;
    if (!matches.length) return;
    const current = Number.isSafeInteger(active.sourceMatchIndex) ? active.sourceMatchIndex : 0;
    active.sourceMatchIndex = (current + delta + matches.length) % matches.length;
    renderDevtools();
    const match = matches[active.sourceMatchIndex];
    const textNode = devSourceText.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return;
    const range = document.createRange();
    range.setStart(textNode, match.from); range.setEnd(textNode, match.to);
    const selection = window.getSelection();
    selection?.removeAllRanges(); selection?.addRange(range);
    const matchRect = range.getBoundingClientRect(); const paneRect = devSourceText.getBoundingClientRect();
    if (matchRect.top < paneRect.top) devSourceText.scrollTop += matchRect.top - paneRect.top;
    else if (matchRect.bottom > paneRect.bottom) devSourceText.scrollTop += matchRect.bottom - paneRect.bottom;
  }
  function releaseDownloadMemory(item) {
    if (item.releaseMemory) { item.releaseMemory(); item.releaseMemory = null; }
    item.blob = null;
  }
  function removeDownload(item) {
    if (item.status === 'downloading' && item.cancel) item.cancel();
    else item.controller?.abort();
    if (item.revokeTimer) clearTimeout(item.revokeTimer);
    if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
    item.objectUrl = '';
    releaseDownloadMemory(item);
    const index = downloads.indexOf(item); if (index >= 0) downloads.splice(index, 1);
    if (devTab === 'Downloads') renderDevtools();
  }
  function clearDownloads() { for (const item of [...downloads]) removeDownload(item); }
  function clearSiteData() {
    if (!active?.url) return;
    let url; try { url = new URL(active.url); } catch { return; }
    const tab = active, origin = url.origin, oldLocalBytes = siteStorageByteCounts[origin] || 0;
    if (remoteMode) {
      if (!remoteTransport?.ready) { statusText.textContent = 'Remote browser is disconnected.'; return; }
      const nonce = tab.nonce, generation = remoteGeneration;
      remoteTransport.clearSiteData(tab.id, origin).then(() => {
        if (disposed || generation !== remoteGeneration || nonce !== tab.nonce || !tabs.includes(tab)) return;
        tab.storage = []; tab.remoteStorageTruncated = false;
        if (tab === active) statusText.textContent = `Cleared remote site data for ${url.hostname}`;
        if (tab === active) renderDevtools(); requestRemoteStorageSnapshot(tab);
      }).catch(error => {
        if (nonce === tab.nonce && generation === remoteGeneration && tabs.includes(tab) && tab === active) {
          statusText.textContent = `Could not clear remote site data: ${String(error.message || error).slice(0, 256)}`;
        }
      });
      return;
    }
    delete siteStorage[origin]; delete siteStorageByteCounts[origin]; siteStorageBytes = Math.max(0, siteStorageBytes - oldLocalBytes);
    persistSiteStorageSoon();
    for (const other of tabs) {
      if (!other.port || !other.url) continue;
      try { if (new URL(other.url).origin === origin) other.port.postMessage({ type: 'storage-sync', area: 'local', action: 'clear', url: tab.url, notify: other !== tab }); }
      catch { /* Ignore tabs that have already navigated away. */ }
    }
    const sessionBytes = tab.sessionStorageByteCounts[origin] || 0;
    delete tab.sessionStorageByOrigin[origin]; delete tab.sessionStorageByteCounts[origin];
    tab.sessionStorageBytes = Math.max(0, tab.sessionStorageBytes - sessionBytes);
    tab.port?.postMessage({ type: 'storage-sync', area: 'session', action: 'clear', url: tab.url, notify: false });
    for (let index = cookieJar.length - 1; index >= 0; index--) {
      const cookie = cookieJar[index];
      if (cookie.hostOnly ? cookie.domain === url.hostname : domainMatches(url.hostname, cookie.domain)) cookieJar.splice(index, 1);
    }
    tab.storage = [];
    syncCookies();
    statusText.textContent = `Cleared site data for ${url.hostname}`;
    if (tab === active) renderDevtools();
  }
  function saveDownload(item) {
    if (!item.blob || item.status !== 'ready') return;
    try {
      item.objectUrl = URL.createObjectURL(item.blob);
      const anchor = document.createElement('a'); anchor.href = item.objectUrl; anchor.download = item.filename; anchor.hidden = true;
      document.body.append(anchor); anchor.click(); anchor.remove();
      item.status = 'saved'; item.blob = null;
      item.revokeTimer = setTimeout(() => {
        if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
        item.objectUrl = ''; item.revokeTimer = null;
        if (item.releaseMemory) { item.releaseMemory(); item.releaseMemory = null; }
      }, 30_000);
    } catch (error) { item.status = 'ready'; item.error = String(error.message || error); }
    renderDevtools();
  }
  async function startDownload(tab, rawUrl, suggestedName) {
    let url;
    try { url = safeUrl(rawUrl, tab.url); }
    catch (error) { tab.console.push({ level: 'error', args: [String(error.message || error)], time: Date.now() }); renderDevtools(); return; }
    if (downloads.filter(item => item.status === 'downloading').length >= MAX_ACTIVE_DOWNLOADS) {
      tab.console.push({ level: 'warn', args: [`At most ${MAX_ACTIVE_DOWNLOADS} downloads can run at once.`], time: Date.now() }); renderDevtools(); return;
    }
    while (downloads.length >= MAX_DOWNLOADS) {
      const oldest = downloads.find(item => item.status !== 'downloading');
      if (!oldest) return;
      removeDownload(oldest);
    }
    const item = { filename: safeDownloadFilename('', url, suggestedName), status: 'downloading', bytes: 0, error: '', blob: null, controller: new AbortController(), releaseMemory: null, objectUrl: '', revokeTimer: null };
    const controller = item.controller;
    downloads.unshift(item); controllers.add(controller); renderDevtools();
    const chunks = [], releases = [];
    const started = performance.now(), startedAt = Date.now();
    try {
      const blocked = resourceBlockReason(tab, url, 'document');
      if (blocked) throw Error(`Download blocked by ${blocked}.`);
      const headers = { accept: '*/*' };
      const cookies = cookieString(cookieJar, url, { pageUrl: tab.url, topLevel: true, method: 'GET' });
      if (cookies) headers.cookie = cookies;
      const response = await browserRequest(url, { method: 'GET', headers, signal: item.controller.signal, stream: true });
      applySetCookies(cookieJar, response.cookies, response.url || url); syncCookies();
      item.filename = safeDownloadFilename(header(response.headers, 'content-disposition'), response.url || url, suggestedName);
      const type = header(response.headers, 'content-type') || 'application/octet-stream';
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
            if (bytes.byteLength > MAX_DOWNLOAD_BYTES - item.bytes) { await reader.cancel(); throw Error('Download exceeds the 64 MiB client limit.'); }
            releases.push(resourceBudget.retain(bytes.byteLength));
            chunks.push(bytes.slice()); item.bytes += bytes.byteLength;
            if (devTab === 'Downloads' && (item.bytes % (256 * 1024) < bytes.byteLength)) renderDevtools();
          }
        } finally { reader.releaseLock(); }
      }
      item.blob = new Blob(chunks, { type });
      item.releaseMemory = () => { for (const release of releases.splice(0)) release(); };
      item.status = 'ready'; item.controller = null;
      tab.network.push({ startedAt, method: 'GET', status: response.status, url: response.url || url, duration: Math.round(performance.now() - started), bytes: item.bytes, cacheHit: response.cacheHit === true, download: true, requestHeaders: Object.entries(headers), responseHeaders: normalizeHeaders(response.headers) });
      trim(tab.network);
    } catch (error) {
      for (const release of releases.splice(0)) release();
      item.controller = null;
      item.status = error?.name === 'AbortError' ? 'cancelled' : 'failed';
      item.error = String(error?.message || error).slice(0, 512);
      if (item.status === 'failed') tab.console.push({ level: 'error', args: [`Download failed: ${item.error}`], time: Date.now() });
    } finally {
      controllers.delete(controller);
      renderDevtools();
    }
  }
  function rememberSource(tab, url, kind, text) {
    if (!tabs.includes(tab) || typeof text !== 'string') return;
    const key = `${kind}:${url}`;
    const existing = tab.sources.findIndex(source => source.key === key);
    const oldBytes = existing >= 0 ? tab.sources[existing].bytes : 0;
    if (existing < 0 && tab.sources.length >= MAX_DEVTOOLS_SOURCES_PER_TAB) return;
    const available = MAX_DEVTOOLS_TOTAL_SOURCE_BYTES - sourceBytes + oldBytes;
    if (available <= 0) return;
    const bounded = boundDevtoolsSource(text, Math.min(MAX_DEVTOOLS_SOURCE_BYTES, available));
    if (!bounded.bytes) return;
    if (existing >= 0) tab.sources.splice(existing, 1);
    sourceBytes = sourceBytes - oldBytes + bounded.bytes;
    tab.sources.push({ key, url, kind, text: bounded.text, bytes: bounded.bytes, truncated: bounded.truncated });
    if (tab === active && devTab === 'Sources') renderDevtools();
  }
  function syncCookies() {
    for (const tab of tabs) if (tab.port && tab.url) tab.port.postMessage({ type: 'cookie-snapshot', value: cookieString(cookieJar, tab.url, { includeHttpOnly: false }) });
    if (active) renderDevtools();
  }
  function activeFrame() { return active?.iframe; }
  function savePrefs() { writeStore(PREFS_KEY, { ...prefs }); }
  function persistUserscripts() {
    try { localStorage.setItem(USERSCRIPTS_KEY, JSON.stringify(userscripts)); return true; }
    catch { userscriptInfo.textContent = 'Could not save userscripts in this browser profile.'; return false; }
  }
  function renderUserscripts() {
    userscriptList.replaceChildren();
    userscripts.forEach(script => {
      const row = document.createElement('div'); row.className = 'eya-userscript-row';
      const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = script.enabled; toggle.setAttribute('aria-label', `Enable ${script.name}`);
      toggle.addEventListener('change', () => {
        const previous = script.enabled; script.enabled = toggle.checked;
        if (!persistUserscripts()) { script.enabled = previous; toggle.checked = previous; return; }
        userscriptInfo.textContent = 'Changes apply the next time a matching page loads.';
      });
      const label = document.createElement('span'); label.textContent = `${script.name} · ${(script.matches.length + script.includes.length).toString()} URL pattern(s)`;
      const remove = button('Remove', `Remove userscript ${script.name}`, () => {
        const index = userscripts.indexOf(script); if (index < 0) return;
        userscripts.splice(index, 1); userscriptBytes = userscripts.reduce((sum, item) => sum + new TextEncoder().encode(item.source).byteLength, 0);
        if (!persistUserscripts()) { userscripts.splice(index, 0, script); userscriptBytes += new TextEncoder().encode(script.source).byteLength; renderUserscripts(); return; }
        delete userscriptStorage[script.id]; writeStore(USERSCRIPT_STORAGE_KEY, userscriptStorage);
        renderUserscripts(); userscriptInfo.textContent = 'Removed. A page already running this script must be reloaded.';
      });
      row.append(toggle, label, remove); userscriptList.append(row);
    });
    if (!userscripts.length) userscriptList.textContent = 'No userscripts imported.';
  }
  function matchingUserscripts(url) { return userscripts.filter(script => script.enabled && userScriptMatches(script, url)); }
  function remoteUserscriptSources(url) {
    const matching = matchingUserscripts(url);
    const supportedGrants = new Set(['GM_addStyle', 'GM_log']);
    const sources = []; let skipped = 0;
    for (const script of matching) {
      if (script.resources?.length || script.grants.some(grant => !supportedGrants.has(grant))) { skipped++; continue; }
      const source = serializeUserscriptSources([script])[0];
      if (!source || sources.length >= 16 || new TextEncoder().encode(JSON.stringify([...sources, source])).byteLength > 512 * 1024) { skipped++; continue; }
      sources.push(source);
    }
    userscriptInfo.textContent = skipped
      ? `${sources.length} matching userscript(s) applied in Full browser; ${skipped} skipped (unsupported grants/resources or remote size limit).`
      : sources.length ? `${sources.length} matching userscript(s) applied in Full browser.` : 'No compatible imported userscripts match this page.';
    return sources;
  }
  async function loadUserscriptResources(tab, scripts, signal) {
    const byUrl = new Map();
    let totalBytes = 0;
    const result = [];
    for (const script of scripts) {
      const resources = Object.create(null);
      if (!script.grants.includes('GM_getResourceText') && !script.grants.includes('GM_getResourceURL')) {
        result.push({ ...script, resources });
        continue;
      }
      for (const declared of script.resources || []) {
        if (signal?.aborted) throw signal.reason || new DOMException('Navigation cancelled.', 'AbortError');
        let loaded = byUrl.get(declared.url);
        if (!loaded && totalBytes < MAX_USERSCRIPT_RESOURCES_TOTAL_BYTES) {
          let target;
          try { target = safeUrl(declared.url, tab.url); } catch { continue; }
          const blocked = resourceBlockReason(tab, target, 'other');
          if (blocked) { recordBlockedResource(tab, target, 'other', blocked); continue; }
          const started = performance.now(), startedAt = Date.now();
          const releaseBuffer = await resourceBudget.acquire(signal, { priority: true });
          try {
            const response = await browserRequest(target, { method: 'GET', headers: { accept: '*/*' }, signal, stream: true });
            if (response.status < 200 || response.status >= 300) {
              response.body?.cancel?.().catch?.(() => {});
              tab.network.push({ startedAt, method: 'GET', status: response.status, url: response.url || target, duration: Math.round(performance.now() - started), bytes: 0, requestHeaders: [['accept', '*/*']], responseHeaders: normalizeHeaders(response.headers) });
              trim(tab.network);
              continue;
            }
            const type = header(response.headers, 'content-type') || 'application/octet-stream';
            const { blob, release: releaseBytes } = await readBlob(response, Math.min(MAX_USERSCRIPT_RESOURCE_BYTES, MAX_USERSCRIPT_RESOURCES_TOTAL_BYTES - totalBytes), type);
            if (totalBytes + blob.size > MAX_USERSCRIPT_RESOURCES_TOTAL_BYTES) { releaseBytes(); continue; }
            let url, text, releaseEncoded, releaseText;
            try {
              releaseEncoded = resourceBudget.retain(Math.ceil(blob.size / 3) * 8 + type.length * 2 + 128);
              releaseText = resourceBudget.retain(blob.size * 2);
              url = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(reader.error || Error('Could not encode userscript resource.'));
                reader.readAsDataURL(blob);
              });
              text = await blob.text();
              if (signal?.aborted) throw signal.reason || new DOMException('Navigation cancelled.', 'AbortError');
            } catch (error) { releaseText?.(); releaseEncoded?.(); releaseBytes(); throw error; }
            releaseBytes();
            const previousRelease = tab.blobs.get(url);
            tab.blobs.set(url, () => { previousRelease?.(); releaseText(); releaseEncoded(); });
            loaded = { url, text };
            byUrl.set(declared.url, loaded);
            totalBytes += blob.size;
            tab.network.push({ startedAt, method: 'GET', status: response.status, url: response.url || target, duration: Math.round(performance.now() - started), bytes: blob.size, cacheHit: response.cacheHit === true, requestHeaders: [['accept', '*/*']], responseHeaders: normalizeHeaders(response.headers) });
            trim(tab.network);
            if (tab === active) renderDevtools();
          } catch (error) {
            if (signal?.aborted) throw error;
            tab.console.push({ level: 'warn', args: [`Userscript resource ${declared.name} could not be loaded: ${String(error?.message || error).slice(0, 180)}`], time: Date.now() });
          } finally { releaseBuffer(); }
        }
        if (loaded) resources[declared.name] = loaded;
      }
      result.push({ ...script, resources });
    }
    return result;
  }
  function userscriptStorageSnapshot(scripts) {
    const snapshot = Object.create(null);
    for (const script of scripts) {
      if (script.grants.some(grant => grant === 'GM_getValue' || grant === 'GM_listValues')) snapshot[script.id] = userscriptStorage[script.id] || Object.create(null);
    }
    return snapshot;
  }
  function storeUserscriptValue(tab, message) {
    const script = userscripts.find(item => item.id === message.scriptId && item.enabled && userScriptMatches(item, tab.url));
    if (!script) return;
    const clean = updateUserscriptStorage(userscriptStorage, message, script.grants);
    if (!clean) return;
    userscriptStorage = clean;
    writeStore(USERSCRIPT_STORAGE_KEY, userscriptStorage);
  }
  function renderBookmarks() {
    bookmarkBar.replaceChildren();
    for (const item of bookmarks.slice(0, MAX_BOOKMARKS)) {
      const node = button(item.title || item.url, `Open ${item.title || item.url}`, () => navigate(item.url, true));
      node.classList.add('eya-bookmark'); node.title = item.url; bookmarkBar.append(node);
    }
    const manage = button('Edit', 'Manage bookmarks', showBookmarks);
    bookmarkBar.append(manage);
  }
  function setLibraryMode(mode) {
    libraryMode = mode === 'history' ? 'history' : 'bookmarks';
    libraryBookmarksButton.setAttribute('aria-pressed', String(libraryMode === 'bookmarks'));
    libraryHistoryButton.setAttribute('aria-pressed', String(libraryMode === 'history'));
    importBookmarksButton.hidden = exportBookmarksButton.hidden = libraryMode !== 'bookmarks';
    clearLibraryHistory.hidden = libraryMode !== 'history';
    librarySearch.value = '';
    renderLibrary();
  }
  function renderLibrary() {
    libraryList.replaceChildren();
    const query = librarySearch.value.trim().toLocaleLowerCase();
    const source = libraryMode === 'bookmarks' ? bookmarks : storedHistory;
    const rows = source.filter(item => `${item.title || ''} ${item.url || ''}`.toLocaleLowerCase().includes(query));
    libraryTitle.textContent = libraryMode === 'bookmarks' ? `Bookmarks (${bookmarks.length})` : `History (${storedHistory.length})`;
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.textContent = query ? 'No matching pages.' : libraryMode === 'bookmarks' ? 'No bookmarks yet. Use the star button to save a page.' : 'No browsing history yet.';
      libraryList.append(empty); libraryStatus.textContent = ''; return;
    }
    for (const item of rows) {
      const row = document.createElement('div'); row.className = 'eya-browser-library-row'; row.setAttribute('role', 'listitem');
      const main = document.createElement('div'); main.className = 'eya-browser-library-row-main';
      const open = button('Open', `Open ${item.title || item.url}`, () => { closeLibrary(); navigate(item.url, true); });
      if (libraryMode === 'bookmarks') {
        const title = document.createElement('input'); title.className = 'eya-browser-library-title-input'; title.type = 'text'; title.maxLength = 256; title.value = String(item.title || item.url || ''); title.setAttribute('aria-label', `Bookmark title for ${item.url}`);
        const url = document.createElement('span'); url.className = 'eya-browser-library-row-url'; url.textContent = item.url;
        main.append(title, url);
        const save = button('Save title', `Save bookmark title for ${item.url}`, () => {
          const target = bookmarks.find(entry => entry.url === item.url); if (!target) return;
          target.title = title.value.trim().slice(0, 256) || target.url;
          writeStore(BOOKMARK_KEY, bookmarks); renderBookmarks(); renderLibrary(); libraryStatus.textContent = 'Bookmark title saved.'; librarySearch.focus();
        });
        title.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); save.click(); } });
        const remove = button('Remove', `Remove bookmark ${item.title || item.url}`, () => {
          bookmarks = bookmarks.filter(entry => entry.url !== item.url); writeStore(BOOKMARK_KEY, bookmarks); renderBookmarks(); renderLibrary(); libraryStatus.textContent = 'Bookmark removed.'; librarySearch.focus();
        });
        row.append(main, save, open, remove);
      } else {
        const title = document.createElement('span'); title.className = 'eya-browser-library-row-title'; title.textContent = item.title || item.url;
        const url = document.createElement('span'); url.className = 'eya-browser-library-row-url'; url.textContent = item.url;
        const at = document.createElement('span'); at.className = 'eya-browser-library-row-time'; at.textContent = Number.isFinite(item.at) ? new Date(item.at).toLocaleString() : '';
        main.append(title, url, at);
        const remove = button('Remove', `Remove ${item.title || item.url} from history`, () => {
          storedHistory = storedHistory.filter(entry => entry !== item);  renderLibrary(); libraryStatus.textContent = 'History entry removed.'; librarySearch.focus();
        });
        row.append(main, open, remove);
      }
      libraryList.append(row);
    }
    const rowLabel = libraryMode === 'bookmarks' ? (rows.length === 1 ? 'bookmark' : 'bookmarks') : (rows.length === 1 ? 'history entry' : 'history entries');
    libraryStatus.textContent = `${rows.length} ${rowLabel}.`;
  }
  function openLibrary(mode = 'bookmarks') {
    libraryReturnFocus = document.activeElement; setLibraryMode(mode); library.hidden = false; libraryStatus.textContent = '';
    for (const node of [toolbar, bookmarkBar, tabBar, status, page, devtools]) node.inert = true;
    librarySearch.focus();
  }
  function closeLibrary() {
    library.hidden = true; librarySearch.value = '';
    for (const node of [toolbar, bookmarkBar, tabBar, status, page, devtools]) node.inert = false;
    if (libraryReturnFocus?.isConnected) libraryReturnFocus.focus(); else address.focus();
  }
  function clearHistory() {
    storedHistory = [];  renderLibrary(); libraryStatus.textContent = 'Browsing history cleared.';
  }
  function exportBookmarks() {
    if (!bookmarks.length) { libraryStatus.textContent = 'There are no bookmarks to export.'; return; }
    let objectUrl = '';
    try {
      const data = JSON.stringify(createBrowserBookmarkExport(bookmarks), null, 2);
      objectUrl = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = objectUrl;
      anchor.download = `eya-bookmarks-${new Date().toISOString().slice(0, 10)}.json`; anchor.hidden = true;
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
      libraryStatus.textContent = `Exported ${bookmarks.length} bookmarks.`;
    } catch (error) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      libraryStatus.textContent = `Could not export bookmarks: ${String(error.message || error).slice(0, 256)}`;
    }
  }
  async function importBookmarks() {
    const file = importBookmarkFile.files?.[0]; if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw Error('Bookmark backups are limited to 1 MiB.');
      const imported = sanitizeBrowserBookmarkImport(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()));
      const merged = new Map(imported.map(item => [item.url, item]));
      for (const item of bookmarks) if (!merged.has(item.url)) merged.set(item.url, item);
      bookmarks = [...merged.values()].slice(0, MAX_BOOKMARKS);
      writeStore(BOOKMARK_KEY, bookmarks); renderBookmarks(); renderLibrary();
      libraryStatus.textContent = `Imported ${imported.length} bookmarks; ${bookmarks.length} saved after merging duplicates.`;
    } catch (error) { libraryStatus.textContent = `Could not import bookmarks: ${String(error.message || error).slice(0, 256)}`; }
    finally { importBookmarkFile.value = ''; }
  }
  function renderTabs() {
    tabBar.replaceChildren();
    tabSummary.textContent = `Tabs (${tabs.length})`;
    newTab.disabled = tabs.length >= MAX_BROWSER_TABS;
    for (const tab of tabs) {
      const wrapper = document.createElement('div'); wrapper.style.display = 'flex'; wrapper.style.alignItems = 'center';
      const select = button(tab.title || (tab.url ? new URL(tab.url).hostname : 'New tab'), 'Switch tab', () => { activateTab(tab); tabMenu.open = false; });
      select.className = 'eya-browser-tab'; select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(tab === active));
      const close = button('×', 'Close tab', () => closeTab(tab)); close.className = 'eya-browser-tab-close'; wrapper.append(select, close); tabBar.append(wrapper);
    }
    tabBar.append(newTab);
  }
  function renderDevtools() {
    for (const [name, item] of devTabButtons) item.setAttribute('aria-selected', String(name === devTab));
    devOutput.replaceChildren();
    devDetails.textContent = '';
    const tab = active;
    if (!tab) return;
    devSearch.hidden = !['Console', 'Network', 'Performance', 'Sources', 'Downloads', 'Storage'].includes(devTab);
    clearSiteDataButton.hidden = devTab !== 'Storage'; clearSiteDataButton.disabled = !tab.url;
    disableCacheLabel.hidden = devTab !== 'Network';
    captureBodiesLabel.hidden = devTab !== 'Network';
    captureBodies.checked = captureNetworkBodies;
    exportHarButton.hidden = devTab !== 'Network';
    const selectedNetworkRequest = devTab === 'Network' ? tab.selectedRequest : null;
    loadNetworkBodyButton.hidden = !remoteMode || !selectedNetworkRequest || !selectedNetworkRequest.remoteRequestId || !selectedNetworkRequest.loadingComplete || selectedNetworkRequest.responseBodyCaptured;
    loadNetworkBodyButton.disabled = selectedNetworkRequest?.remoteBodyLoading === true || networkCaptureBytes >= MAX_REMOTE_NETWORK_BODY_TOTAL_BYTES;
    loadNetworkBodyButton.textContent = selectedNetworkRequest?.remoteBodyLoading ? 'Loading…' : 'Load body';
    exportHarButton.disabled = !(tab.network || []).length;
    performanceCaptureButton.hidden = devTab !== 'Performance';
    performanceRecordButton.hidden = devTab !== 'Performance';
    performanceCaptureButton.disabled = !tab.port && !(remoteMode && remoteTransport?.ready);
    performanceRecordButton.disabled = !tab.port && !(remoteMode && remoteTransport?.ready);
    performanceRecordButton.textContent = tab.performanceRecording ? 'Stop' : 'Record';
    performanceRecordButton.title = tab.performanceRecording ? 'Stop recording page performance entries' : 'Start recording page performance entries';
    performanceRecordButton.setAttribute('aria-label', performanceRecordButton.title);
    performanceRecordButton.setAttribute('aria-pressed', String(tab.performanceRecording === true));
    const callFrameSelected = remoteMode && !!remoteDebuggerPaused?.callFrameId;
    consoleInput.placeholder = callFrameSelected ? 'Evaluate JavaScript in selected paused frame' : 'Evaluate JavaScript (↑/↓ command history)';
    consoleInput.setAttribute('aria-label', callFrameSelected ? 'JavaScript console input evaluated in the selected paused call frame' : 'JavaScript console input; use Up and Down arrows for command history');
    disableCache.checked = prefs.disableCache === true;
    devOutput.hidden = devTab === 'Sources' || devTab === 'Extensions';
    devPerformanceSummary.hidden = devTab !== 'Performance';
    devSourceView.hidden = devTab !== 'Sources';
    devExtensions.hidden = devTab !== 'Extensions';
    devDetails.hidden = devTab === 'Sources' || devTab === 'Extensions';
    devObjectInspector.hidden = devTab !== 'Console' || !tab.selectedRemoteObject;
    devConsole.hidden = devTab !== 'Console';
    devElementEditor.hidden = true;
    devSearch.placeholder = devTab === 'Network' ? 'Filter requests' : devTab === 'Sources' ? 'Filter files; find text in selected source' : devTab === 'Downloads' ? 'Filter downloads' : devTab === 'Storage' ? 'Filter keys' : devTab === 'Performance' ? 'Filter entries' : 'Filter console';
    const selectedDebugSource = (tab.sources || []).find(source => source.key === tab.selectedSource);
    const debugSourceSupported = !!selectedDebugSource && ['Document', 'Script'].includes(selectedDebugSource.kind);
    const debugLine = Number(sourceBreakpointLine.value);
    const debugKey = selectedDebugSource && Number.isSafeInteger(debugLine) ? `${selectedDebugSource.url}\n${debugLine}` : '';
    const selectedBreakpoint = debugKey ? remoteBreakpoints.get(debugKey) : null;
    sourceBreakpointLine.hidden = sourceBreakpointToggle.hidden = debuggerPause.hidden = debuggerResume.hidden = debuggerStepOver.hidden = debuggerStepInto.hidden = debuggerStepOut.hidden = debuggerStatus.hidden = devTab !== 'Sources';
    sourceBreakpointLine.disabled = !remoteMode || !selectedDebugSource;
    sourceBreakpointToggle.disabled = !remoteMode || !debugSourceSupported || !Number.isSafeInteger(debugLine) || debugLine < 1 || debugLine > 1_000_000;
    sourceBreakpointToggle.textContent = selectedBreakpoint ? 'Remove breakpoint' : 'Set breakpoint';
    debuggerPause.disabled = !remoteMode || !!remoteDebuggerPaused;
    debuggerResume.disabled = !remoteMode || !remoteDebuggerPaused;
    debuggerStepOver.disabled = debuggerStepInto.disabled = debuggerStepOut.disabled = !remoteMode || !remoteDebuggerPaused;
    debuggerStatus.textContent = remoteDebuggerPaused ? `Paused · ${remoteDebuggerPaused.selectedFrameLabel || remoteDebuggerPaused.location}${remoteDebuggerPaused.reason ? ` · ${remoteDebuggerPaused.reason}` : ''}` : (remoteMode ? 'Running' : 'Full browser debugger');
    clearDev.hidden = devTab === 'Extensions' || (devTab === 'Elements' && !tab.dom && !remoteMode) || (devTab === 'Sources' && !(tab.sources || []).length && !remoteMode) || (devTab === 'Downloads' && !downloads.length);
    extensionImport.disabled = !remoteMode;
    if (devTab === 'Extensions') {
      extensionList.replaceChildren();
      for (const extension of remoteExtensions) {
        const row = document.createElement('div'); row.className = 'eya-devtools-row';
        const details = document.createElement('div');
        const name = document.createElement('strong'); name.textContent = `${extension.name} · ${extension.id}`;
        const permissionSummary = (values, label) => {
          const line = document.createElement('div');
          const shown = Array.isArray(values) ? values.slice(0, 16).map(value => String(value).slice(0, 128)) : [];
          line.textContent = `${label}: ${shown.length ? shown.join(', ') + (values.length > shown.length ? ` (+${values.length - shown.length} more)` : '') : 'none declared'}`;
          details.append(line);
        };
        details.append(name);
        permissionSummary(extension.permissions, 'Permissions');
        permissionSummary(extension.hostPermissions, 'Host access');
        const runAction = button('Run action', `Run ${extension.name}'s action on the active page`, async () => {
          const target = active;
          runAction.disabled = true;
          try {
            await remoteTransport.triggerExtensionAction(extension.id, target?.id);
            extensionStatus.textContent = `Triggered “${extension.name}” on the active page. Its action popup opens in a new Eya tab when Chromium exposes it as a page target.`;
          } catch (error) { extensionStatus.textContent = String(error.message || error).slice(0, 512); }
          finally { renderDevtools(); }
        });
        runAction.disabled = true;
        runAction.title = 'Unavailable: extension actions require Chromium tab target mapping.';
        runAction.setAttribute('aria-label', runAction.title);
        const remove = button('Remove', `Remove extension ${extension.name}`, async () => {
          remove.disabled = true;
          try { await remoteTransport.removeExtension(extension.id); remoteExtensions = remoteExtensions.filter(item => item.id !== extension.id); extensionStatus.textContent = `Removed ${extension.name}.`; renderDevtools(); }
          catch (error) { extensionStatus.textContent = String(error.message || error); remove.disabled = false; }
        });
        row.append(details, runAction, remove); extensionList.append(row);
      }
      if (!remoteExtensions.length) extensionList.textContent = remoteMode ? 'No extensions loaded in this Full browser session.' : 'Extensions require Full browser mode.';
      return;
    }
    clearDev.textContent = remoteMode && ['Elements', 'Sources'].includes(devTab) ? 'Refresh' : 'Clear';
    clearDev.title = remoteMode && devTab === 'Elements' ? 'Refresh the remote page DOM snapshot' : remoteMode && devTab === 'Sources' ? 'Refresh remote page sources' : 'Clear current DevTools output';
    const filter = devSearch.value.trim().toLowerCase();
    if (devTab === 'Performance') {
      const entries = Array.isArray(tab.performance) ? tab.performance : [];
      const nav = entries.find(entry => entry.entryType === 'navigation');
      const paint = entries.filter(entry => entry.entryType === 'paint');
      const metrics = [];
      if (nav) { metrics.push(`DOM interactive ${Math.round(nav.domInteractive || 0)} ms`, `DOM content loaded ${Math.round(nav.domContentLoadedEventEnd || 0)} ms`, `Page load ${Math.round(nav.loadEventEnd || 0)} ms`); }
      for (const item of paint) metrics.push(`${item.name} ${Math.round(item.startTime || 0)} ms`);
      if (tab.performanceMemory) metrics.push(`JS heap ${(tab.performanceMemory.usedJSHeapSize / 1048576).toFixed(1)} / ${(tab.performanceMemory.totalJSHeapSize / 1048576).toFixed(1)} MiB`);
      devPerformanceSummary.textContent = metrics.length ? metrics.join(' · ') : (tab.performanceCapturedAt ? 'No timing or heap metrics reported.' : 'Capture page timing or start recording.');
      devOutput.setAttribute('role', 'log');
      const visible = entries.filter(entry => !filter || entry.entryType.toLowerCase().includes(filter) || entry.name.toLowerCase().includes(filter));
      for (const entry of visible) {
        const line = document.createElement('div'); line.className = 'eya-devtools-row';
        const duration = Number.isFinite(entry.duration) ? ` · ${entry.duration.toFixed(2)} ms` : '';
        line.textContent = `${entry.entryType} · ${entry.name}${duration}`;
        line.tabIndex = 0;
        line.addEventListener('click', () => { tab.selectedPerformance = entry; devDetails.textContent = JSON.stringify(entry, null, 2); });
        devOutput.append(line);
      }
      if (!visible.length) devOutput.textContent = entries.length ? 'No matching performance entries.' : 'No performance entries captured.';
      if (tab.selectedPerformance && entries.includes(tab.selectedPerformance)) devDetails.textContent = JSON.stringify(tab.selectedPerformance, null, 2);
      return;
    }
    if (devTab === 'Downloads') {
      devOutput.setAttribute('role', 'list');
      const visible = downloads.filter(item => !filter || item.filename.toLowerCase().includes(filter) || item.status.toLowerCase().includes(filter));
      for (const item of visible) {
        const row = document.createElement('div'); row.className = 'eya-devtools-download-row';
        const progress = item.status === 'downloading' && item.remoteDownloadId ? ` · ${item.receivedBytes.toLocaleString()}${item.totalBytes ? ` / ${item.totalBytes.toLocaleString()}` : ''} bytes` : '';
        const label = document.createElement('span'); label.textContent = `${item.filename} · ${item.transferring ? 'receiving' : item.status}${progress || (item.bytes ? ` · ${item.bytes.toLocaleString()} bytes` : '')}${item.error ? ` · ${item.error}` : ''}`;
        row.append(label);
        if (item.status === 'ready' && item.blob) row.append(button('Save', `Save ${item.filename}`, () => saveDownload(item)));
        if (item.status === 'downloading' && !item.transferring) row.append(button('Cancel', `Cancel ${item.filename}`, () => item.cancel ? item.cancel() : item.controller?.abort()));
        if (item.status !== 'downloading') row.append(button('Remove', `Remove ${item.filename} from downloads`, () => removeDownload(item)));
        devOutput.append(row);
      }
      if (!visible.length) devOutput.textContent = downloads.length ? 'No matching downloads.' : 'No downloads yet.';
      return;
    }
    if (devTab === 'Sources') {
      devSourceList.replaceChildren();
      const sources = (tab.sources || []).filter(source => !filter || source.url.toLowerCase().includes(filter) || source.kind.toLowerCase().includes(filter) || (source.key === tab.selectedSource && findSourceMatchRanges(source.text, filter).matches.length > 0));
      for (const source of sources) {
        const item = button(`${source.kind} · ${source.url}`, `Open ${source.kind} source ${source.url}`, () => {
          tab.selectedSource = source.key; tab.sourceMatchIndex = 0; renderDevtools();
          if (remoteMode && source.remote && !source.loaded) loadRemoteSource(tab, source);
        }, 'eya-devtools-source-item');
        item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(tab.selectedSource === source.key));
        item.title = source.url; devSourceList.append(item);
      }
      const selectedSource = (tab.sources || []).find(source => source.key === tab.selectedSource);
      const callFrames = Array.isArray(tab.debuggerCallFrames) ? tab.debuggerCallFrames : [];
      debuggerCallStack.replaceChildren(); debuggerCallStack.hidden = !remoteMode || !remoteDebuggerPaused || !callFrames.length;
      if (!debuggerCallStack.hidden) for (const [index, frame] of callFrames.entries()) {
        const label = `${frame.functionName || '(anonymous)'} · ${frame.url || 'script'}:${frame.line}:${frame.column}`;
        const item = button(label, `Show source for call frame ${label}`, () => {
          remoteDebuggerPaused.callFrameId = frame.callFrameId;
          remoteDebuggerPaused.selectedFrameLabel = label;
          const source = (tab.sources || []).find(value => value.url === frame.url && ['Document', 'Script'].includes(value.kind));
          if (source) { tab.selectedSource = source.key; sourceBreakpointLine.value = String(frame.line); if (source.remote && !source.loaded) loadRemoteSource(tab, source); }
          renderDevtools();
        });
        item.setAttribute('role', 'listitem'); item.setAttribute('aria-current', String(frame.callFrameId === remoteDebuggerPaused.callFrameId)); debuggerCallStack.append(item);
      }
      const selectedFrame = callFrames.find(frame => frame.callFrameId === remoteDebuggerPaused?.callFrameId);
      debuggerScopes.replaceChildren(); debuggerScopes.hidden = !remoteMode || !selectedFrame;
      if (selectedFrame) {
        if (!selectedFrame.scopes && !selectedFrame.scopesLoading && !selectedFrame.scopesError) requestRemoteDebuggerScopes(tab, selectedFrame);
        const heading = document.createElement('span'); heading.textContent = selectedFrame.scopesLoading ? 'Loading scopes…' : selectedFrame.scopesError || 'Scopes:'; heading.className = 'eya-devtools-source-match-status'; debuggerScopes.append(heading);
        for (const scope of selectedFrame.scopes || []) {
          const label = `${scope.type}${scope.name ? ` · ${scope.name}` : ''}`;
          const inspect = button(`Inspect ${label}`, `Inspect ${label} variables`, () => {
            tab.selectedRemoteObject = scope.object; tab.remoteObjectProperties ||= new Map(); tab.remoteObjectExpanded ||= new Set();
            tab.remoteObjectExpanded.add(scope.object.objectId); devTab = 'Console'; renderDevtools(); loadRemoteObjectProperties(tab, scope.object.objectId);
          });
          inspect.setAttribute('role', 'listitem'); debuggerScopes.append(inspect);
        }
      }
      const selectedLine = Number(sourceBreakpointLine.value);
      const breakpoint = selectedSource && Number.isSafeInteger(selectedLine) ? remoteBreakpoints.get(`${selectedSource.url}\n${selectedLine}`) : null;
      sourceBreakpointToggle.textContent = breakpoint ? 'Remove breakpoint' : 'Set breakpoint';
      const sourceText = selectedSource
        ? selectedSource.remote && !selectedSource.loaded ? (selectedSource.error || (selectedSource.loading ? 'Loading remote source…' : 'Select to load source text.'))
          : `${selectedSource.text}${selectedSource.truncated ? '\n\n[Source truncated by the memory limit.]' : ''}`
        : sources.length ? 'Select a source to inspect it.' : 'No matching source files are loaded.';
      devSourceText.textContent = !sources.length && remoteMode ? (tab.remoteSourcesLoading ? 'Enumerating remote sources…' : tab.remoteSourcesError || 'No remote sources listed. Refresh to retry.') : sourceText;
      const matches = selectedSource ? findSourceMatchRanges(selectedSource.text, filter) : { matches: [], truncated: false };
      if (matches.matches.length) {
        tab.sourceMatchIndex = Math.max(0, Math.min(Number.isSafeInteger(tab.sourceMatchIndex) ? tab.sourceMatchIndex : 0, matches.matches.length - 1));
        sourceMatchStatus.textContent = `${tab.sourceMatchIndex + 1} / ${matches.matches.length}${matches.truncated ? '+' : ''} matches`;
      } else {
        tab.sourceMatchIndex = 0;
        sourceMatchStatus.textContent = selectedSource ? (filter ? 'No matches in selected source' : 'Enter text to search this source') : 'Select a source to search its text';
      }
      prevSourceMatch.disabled = nextSourceMatch.disabled = matches.matches.length === 0;
      return;
    }
    if (devTab === 'Elements') {
      devOutput.setAttribute('role', 'tree');
      if (!Array.isArray(tab.dom)) devOutput.textContent = remoteMode ? 'Remote DOM snapshot is loading…' : 'DOM inspection is waiting for the page runtime bridge.';
      else {
        const renderNodes = (nodes, parent, depth = 0) => {
          for (const node of nodes) {
            const row = document.createElement('div'); row.className = 'eya-element-row'; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(depth + 1));
            const children = Array.isArray(node.children) ? node.children : [];
            const collapsed = tab.collapsedNodes?.has(node.id) === true;
            const needsMore = remoteMode && node.childrenLoaded === false;
            const toggle = button(needsMore ? '…' : children.length ? (collapsed ? '▸' : '▾') : '', needsMore ? `Load more children of ${node.tag}` : children.length ? `${collapsed ? 'Expand' : 'Collapse'} ${node.tag}` : 'No child elements', () => {
              if (needsMore) { loadRemoteDomChildren(tab, node); return; }
              if (!tab.collapsedNodes) tab.collapsedNodes = new Set();
              if (tab.collapsedNodes.has(node.id)) tab.collapsedNodes.delete(node.id); else tab.collapsedNodes.add(node.id);
              renderDevtools();
            }, 'eya-element-toggle');
            toggle.disabled = !children.length && !needsMore && !node.hasChildren; toggle.setAttribute('aria-expanded', String(children.length > 0 && !collapsed));
            const idAttr = node.attrs?.find(([name]) => name === 'id')?.[1];
            const classAttr = node.attrs?.find(([name]) => name === 'class')?.[1];
            const label = `<${node.tag || '?'}${idAttr ? `#${idAttr}` : ''}${classAttr ? `.${classAttr.trim().split(/\s+/).slice(0, 3).join('.')}` : ''}>`;
            const select = button(label, `Inspect ${label}`, () => {
              tab.selectedNodeId = node.id;
              tab.inspectedNode = null;
              if (remoteMode) { highlightRemoteNode(tab, node.id); inspectRemoteNode(tab, node.id); }
              else {
                tab.port?.postMessage({ type: 'highlight-node', id: node.id });
                tab.port?.postMessage({ type: 'inspect-node', id: node.id });
              }
              devDetails.textContent = JSON.stringify({ id: node.id, tag: node.tag, attributes: node.attrs, text: node.text }, null, 2);
              renderDevtools();
            }, 'eya-element-select');
            select.setAttribute('aria-pressed', String(tab.selectedNodeId === node.id));
            row.append(toggle, select); parent.append(row);
            if (children.length && !collapsed) { const group = document.createElement('div'); group.className = 'eya-element-group'; group.setAttribute('role', 'group'); parent.append(group); renderNodes(children, group, depth + 1); }
          }
        };
        if (!tab.collapsedNodes) tab.collapsedNodes = new Set();
        renderNodes(tab.dom, devOutput);
        const findSelected = (nodes, id) => { for (const node of nodes) { if (node.id === id) return node; const found = findSelected(node.children || [], id); if (found) return found; } return null; };
        const selected = findSelected(tab.dom, tab.selectedNodeId);
        if (selected) {
          devElementEditor.hidden = false;
          if (document.activeElement !== textEdit) textEdit.value = selected.text || '';
          const inspection = tab.inspectedNode?.id === selected.id ? tab.inspectedNode : null;
          devDetails.textContent = JSON.stringify({ id: selected.id, tag: selected.tag, attributes: selected.attrs, text: selected.text,
            box: inspection?.box || 'Loading layout…', computed: inspection?.computed || (inspection?.error || 'Loading computed styles…') }, null, 2);
        }
        else if (tab.selectedNodeId != null) tab.selectedNodeId = null;
        if (!tab.dom.length) devOutput.textContent = 'The page has no inspectable elements.';
      }
      devOutput.scrollTop = devOutput.scrollHeight;
      return;
    }
    devOutput.setAttribute('role', 'log');
    let lines = [];
    if (devTab === 'Console') lines = tab.console.filter(row => !filter || row.args.join(' ').toLowerCase().includes(filter)).map(row => ({ level: row.level, text: `${new Date(row.time).toLocaleTimeString()} ${row.level === 'command' ? '> ' : ''}${row.args.join(' ')}`, remoteObject: row.remoteObject }));
    if (devTab === 'Network') lines = tab.network.filter(row => !filter || row.url?.toLowerCase().includes(filter) || row.method?.toLowerCase().includes(filter)).map(row => ({ request: row, text: `${row.blocked ? 'BLOCKED  ' : ''}${row.cacheHit ? `CACHE${row.cacheSource === 'panel' ? ' (panel)' : row.cacheSource === 'in-flight' ? ' (shared)' : ''}  ` : ''}${row.method || 'GET'}  ${row.status || '…'}  ${row.url || ''}  ${row.duration ? `${row.duration} ms` : ''}` }));
    if (devTab === 'Storage') {
      const storageRows = Array.isArray(tab.storage) ? tab.storage.map(row => ({ key: `${row.area || 'localStorage'} ${row.key}`, text: `${row.area === 'cookie' ? 'Cookie' : row.area || 'localStorage'} ${row.key}: ${row.value}${row.httpOnly ? ' [HttpOnly]' : ''}${row.secure ? ' [Secure]' : ''}` })) : [];
      const cookieHeader = !remoteMode && tab.url ? cookieString(cookieJar, tab.url) : '';
      const cookieRows = cookieHeader ? cookieHeader.split(/; (?=[^;]+=)/).map(pair => {
        const at = pair.indexOf('='); const name = pair.slice(0, at);
        const cookie = cookieJar.find(item => item.name === name && item.httpOnly);
        return { key: `cookie ${name}`, text: `Cookie ${name}: ${pair.slice(at + 1)}${cookie ? ' [HttpOnly]' : ''}` };
      }) : [];
      lines = [...storageRows, ...cookieRows].filter(row => !filter || row.key.toLowerCase().includes(filter));
    }
    const waterfallRequests = devTab === 'Network' ? lines.map(value => value.request).filter(Boolean) : [];
    const waterfallIndex = new Map(waterfallRequests.map((request, index) => [request, index]));
    const waterfallStarts = waterfallRequests.map(request => Number.isFinite(request.startedAt) ? request.startedAt : Date.now() - Math.max(0, Number(request.duration) || 0));
    const waterfallFirst = waterfallStarts.length ? Math.min(...waterfallStarts) : 0;
    const waterfallLast = waterfallRequests.length ? Math.max(...waterfallRequests.map((request, index) => waterfallStarts[index] + Math.max(1, Number(request.duration) || 0))) : waterfallFirst;
    const waterfallSpan = Math.max(100, waterfallLast - waterfallFirst);
    for (const row of lines) {
      const line = document.createElement('div'); line.className = 'eya-devtools-row'; if (row.level) line.dataset.level = row.level; line.textContent = row.text;
      if (row.request) {
        line.classList.add('eya-network-row'); line.replaceChildren(); line.tabIndex = 0;
        line.setAttribute('aria-selected', String(tab.selectedRequest === row.request));
        const label = document.createElement('span'); label.className = 'eya-network-row-label'; label.textContent = row.text; label.title = row.request.url || '';
        const track = document.createElement('span'); track.className = 'eya-network-waterfall-track';
        const bar = document.createElement('span'); bar.className = 'eya-network-waterfall-bar';
        const requestIndex = waterfallIndex.get(row.request);
        const start = waterfallStarts[requestIndex] ?? waterfallFirst;
        bar.style.left = `${Math.max(0, Math.min(100, ((start - waterfallFirst) / waterfallSpan) * 100))}%`;
        bar.style.width = `${Math.max(1, Math.min(100, ((Number(row.request.duration) || 1) / waterfallSpan) * 100))}%`;
        if (row.request.blocked) bar.dataset.state = 'blocked'; else if (row.request.cacheHit) bar.dataset.state = 'cache';
        track.setAttribute('role', 'img'); track.setAttribute('aria-label', `Request took ${Math.max(0, Number(row.request.duration) || 0)} milliseconds`); track.append(bar); line.append(label, track);
        const selectRequest = () => { tab.selectedRequest = row.request; renderDevtools(); };
        line.addEventListener('click', selectRequest);
        line.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectRequest(); } });
      } else if (row.remoteObject?.objectId) {
        line.replaceChildren(); line.classList.add('eya-devtools-object-result');
        const text = document.createElement('span'); text.textContent = row.text;
        const inspect = button('Inspect', `Inspect ${row.remoteObject.description || 'JavaScript object'}`, () => {
          tab.selectedRemoteObject = row.remoteObject;
          tab.remoteObjectProperties ||= new Map();
          tab.remoteObjectExpanded ||= new Set();
          tab.remoteObjectExpanded.add(row.remoteObject.objectId);
          renderDevtools(); loadRemoteObjectProperties(tab, row.remoteObject.objectId);
        });
        line.append(text, inspect);
      }
      devOutput.append(line);
    }
    if (devTab === 'Network' && tab.selectedRequest) {
      devDetails.textContent = formatNetworkDetails(tab.selectedRequest);
      if (tab.selectedRequest.remoteBodyError) devDetails.textContent += `\n\nBody load error: ${tab.selectedRequest.remoteBodyError}`;
      if (remoteMode && !tab.selectedRequest.responseBodyCaptured) devDetails.textContent += '\n\nFull-browser body previews are opt-in and bounded to 256 KiB per request and 2 MiB per panel.';
    }
    if (!lines.length) devOutput.textContent = devTab === 'Console' ? 'Console is clear.' : devTab === 'Storage' ? (tab.remoteStorageLoading ? 'Reading remote site data…' : tab.remoteStorageError || (tab.remoteStorageTruncated ? 'No matching entries. The remote storage snapshot is bounded.' : 'No storage entries captured.')) : 'No requests yet.';
    if (devTab === 'Console') renderRemoteObjectInspector(tab);
    devOutput.scrollTop = devOutput.scrollHeight;
  }
  async function loadRemoteNetworkBody(tab, row) {
    if (!remoteMode || !remoteTransport?.ready || !tab || !row?.remoteRequestId || row.remoteBodyLoading || row.responseBodyCaptured) return;
    row.remoteBodyLoading = true; row.remoteBodyError = ''; renderDevtools();
    const generation = remoteGeneration;
    try {
      const result = await remoteTransport.networkBody(row.remoteRequestId, tab.id);
      if (disposed || generation !== remoteGeneration || !tabs.includes(tab) || !tab.network.includes(row)) return;
      const bytes = new TextEncoder().encode(String(result.text || '')).byteLength;
      if (bytes > MAX_NETWORK_CAPTURE_ENTRY_BYTES || networkCaptureBytes + bytes > MAX_REMOTE_NETWORK_BODY_TOTAL_BYTES) throw Error('The response body exceeds the available DevTools memory budget.');
      networkCaptureBytes += bytes;
      row.remoteBodyBytes = bytes; row.responseBodyText = String(result.text || ''); row.responseBodyTextLike = true;
      row.responseBodyTruncated = result.truncated === true; row.responseBodyCaptured = true;
    } catch (error) {
      if (generation === remoteGeneration && tabs.includes(tab)) row.remoteBodyError = String(error?.message || error).slice(0, 256);
    } finally {
      row.remoteBodyLoading = false;
      if (generation === remoteGeneration && tab === active) renderDevtools();
    }
  }
  async function loadRemoteObjectProperties(tab, objectId) {
    if (!remoteMode || !remoteTransport?.ready || typeof objectId !== 'string' || !objectId || objectId.length > 512) return;
    tab.remoteObjectProperties ||= new Map();
    if (tab.remoteObjectProperties.has(objectId)) return;
    const entry = { loading: true, properties: [] };
    tab.remoteObjectProperties.set(objectId, entry);
    if (tab === active && devTab === 'Console') renderRemoteObjectInspector(tab);
    const nonce = tab.nonce, generation = remoteGeneration;
    try {
      const result = await remoteTransport.debugger(tab.id, 'getProperties', { objectId });
      if (disposed || generation !== remoteGeneration || nonce !== tab.nonce || !tabs.includes(tab)) return;
      tab.remoteObjectProperties.set(objectId, { loading: false, properties: result.properties || [] });
    } catch (error) {
      if (generation !== remoteGeneration || nonce !== tab.nonce || !tabs.includes(tab)) return;
      tab.remoteObjectProperties.set(objectId, { loading: false, properties: [], error: String(error.message || error).slice(0, 256) });
    }
    if (tab === active && devTab === 'Console') renderRemoteObjectInspector(tab);
  }
  function renderRemoteObjectInspector(tab) {
    devObjectInspectorTree.replaceChildren();
    const root = tab.selectedRemoteObject;
    if (!root?.objectId) { devObjectInspector.hidden = true; return; }
    devObjectInspector.hidden = devTab !== 'Console';
    devObjectInspectorTitle.textContent = String(root.description || root.className || root.type || 'JavaScript object').slice(0, 180);
    tab.remoteObjectProperties ||= new Map(); tab.remoteObjectExpanded ||= new Set([root.objectId]);
    let rendered = 0;
    const propertyValue = value => {
      if (!value || typeof value !== 'object') return 'undefined';
      if (Object.hasOwn(value, 'value')) {
        if (typeof value.value === 'string') return JSON.stringify(value.value);
        if (value.value === null) return 'null';
        return String(value.value);
      }
      return String(value.description || (value.subtype === 'null' ? 'null' : value.className || value.type || 'Object')).slice(0, 512);
    };
    const renderObject = (value, label, depth, ancestors) => {
      if (++rendered > 300) return;
      const id = value?.objectId;
      const row = document.createElement('div'); row.className = 'eya-devtools-object-row'; row.style.setProperty('--depth', String(depth)); row.setAttribute('role', 'treeitem');
      if (!id || depth >= 6 || ancestors.has(id)) {
        const text = document.createElement('span'); text.className = 'eya-devtools-object-value'; text.textContent = `${label}: ${ancestors.has(id) ? '[Circular]' : propertyValue(value)}`; row.append(text); devObjectInspectorTree.append(row); return;
      }
      const expanded = tab.remoteObjectExpanded.has(id);
      const toggle = button(expanded ? '▾' : '▸', `${expanded ? 'Collapse' : 'Expand'} ${label}`, () => {
        if (tab.remoteObjectExpanded.has(id)) { tab.remoteObjectExpanded.delete(id); renderRemoteObjectInspector(tab); }
        else { tab.remoteObjectExpanded.add(id); if (!tab.remoteObjectProperties.has(id)) loadRemoteObjectProperties(tab, id); else renderRemoteObjectInspector(tab); }
      });
      toggle.setAttribute('aria-expanded', String(expanded));
      const name = document.createElement('span'); name.textContent = `${label}:`;
      const preview = document.createElement('span'); preview.className = 'eya-devtools-object-value'; preview.textContent = propertyValue(value);
      row.append(toggle, name, preview); devObjectInspectorTree.append(row);
      if (!expanded) return;
      const state = tab.remoteObjectProperties.get(id);
      if (!state || state.loading) { const loading = document.createElement('div'); loading.className = 'eya-devtools-object-row'; loading.style.setProperty('--depth', String(depth + 1)); loading.textContent = 'Loading properties…'; devObjectInspectorTree.append(loading); return; }
      if (state.error) { const error = document.createElement('div'); error.className = 'eya-devtools-object-row'; error.style.setProperty('--depth', String(depth + 1)); error.textContent = state.error; devObjectInspectorTree.append(error); return; }
      const nextAncestors = new Set(ancestors); nextAncestors.add(id);
      for (const property of state.properties || []) {
        if (rendered >= 300) break;
        if (property.accessor) {
          const item = document.createElement('div'); item.className = 'eya-devtools-object-row'; item.style.setProperty('--depth', String(depth + 1));
          const text = document.createElement('span'); text.className = 'eya-devtools-object-value'; text.textContent = `${property.name}: [Getter/Setter not invoked]`; item.append(text); devObjectInspectorTree.append(item);
        } else renderObject(property.value, property.name || '(unnamed)', depth + 1, nextAncestors);
      }
      if ((state.properties || []).length >= 100 || rendered >= 300) { const limit = document.createElement('div'); limit.className = 'eya-devtools-object-row'; limit.style.setProperty('--depth', String(depth + 1)); limit.textContent = 'Property display limit reached.'; devObjectInspectorTree.append(limit); }
    };
    renderObject(root, 'result', 0, new Set());
  }
  function formatNetworkDetails(row) {
    const headers = values => Array.isArray(values) && values.length ? values.map(([name, value]) => `${String(name)}: ${String(value)}`).join('\n') : '(none)';
    const status = typeof row.status === 'string' ? row.status : (row.status ?? 'Pending');
    return [
      'General', `Request URL: ${row.url || ''}`, `Request Method: ${row.method || 'GET'}`, `Status: ${status}`,
      row.responseStatus ? `HTTP response status: ${row.responseStatus}` : '', row.error ? `Error: ${row.error}` : '',
      `Duration: ${Math.max(0, Number(row.duration) || 0)} ms`, `Transferred: ${Math.max(0, Number(row.bytes) || 0).toLocaleString()} bytes`,
      `Request body: ${Math.max(0, Number(row.requestBytes) || 0).toLocaleString()} bytes`, `Cache: ${row.cacheHit ? (row.cacheSource === 'panel' ? 'panel memory hit' : row.cacheSource === 'in-flight' ? 'shared in-flight request' : 'server hit') : 'miss'}`,
      `Blocked: ${row.blocked || 'no'}`, row.websocketState ? `WebSocket: ${row.websocketState}` : '',
      '', 'Response Body', row.responseBodyCaptured
        ? `${row.responseBodyTextLike ? row.responseBodyText || '(empty text response)' : '[Binary response captured; text preview unavailable.]'}${row.responseBodyTruncated ? '\n… [capture limit reached]' : ''}`
        : (row.remoteRequestId ? 'Select Load body to retrieve a bounded preview from Full browser.' : captureNetworkBodies ? 'No text API response body was captured for this request.' : 'Body capture is off. Enable “Capture API bodies” to retain bounded text responses.'),
      '', 'Request Headers', headers(row.requestHeaders), '', 'Response Headers', headers(row.responseHeaders),
    ].filter(Boolean).join('\n');
  }
  function exportNetworkHar() {
    if (!active || !active.network.length) return;
    let objectUrl = '';
    try {
      const json = JSON.stringify(buildHarLog(active), null, 2);
      objectUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = objectUrl;
      anchor.download = `eya-network-${new Date().toISOString().replace(/[:.]/g, '-')}.har`; anchor.hidden = true;
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    } catch (error) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      active.console.push({ level: 'error', args: [`Could not export HAR: ${String(error?.message || error).slice(0, 256)}`], time: Date.now() });
      trim(active.console); renderDevtools();
    }
  }
  function requestPerformanceSnapshot() {
    if (remoteMode) { requestRemotePerformanceSnapshot(active); return; }
    if (!active?.port) return;
    const id = ++requestSequence;
    active.performanceRequestId = id;
    active.port.postMessage({ type: 'performance-snapshot', id });
  }
  async function togglePerformanceRecording() {
    if (remoteMode) {
      if (!active || !remoteTransport?.ready) return;
      if (active.performanceRecording) { stopRemotePerformanceRecording(active); return; }
      const tab = active, nonce = tab.nonce, generation = remoteGeneration;
      tab.performance = []; tab.performanceRecording = true; tab.remotePerformanceFailures = 0; renderDevtools();
      try {
        await evaluateRemoteDom(tab, remotePerformanceStartExpression());
        if (!remoteMode || generation !== remoteGeneration || nonce !== tab.nonce || tab !== active || !tab.performanceRecording) return;
        pollRemotePerformance(tab, nonce, generation);
      } catch (error) {
        if (nonce !== tab.nonce || generation !== remoteGeneration || tab !== active) return;
        tab.performanceRecording = false;
        tab.console.push({ level: 'error', args: [`Could not start remote performance recording: ${String(error.message || error).slice(0, 256)}`], time: Date.now() });
        trim(tab.console); renderDevtools();
      }
      return;
    }
    if (!active?.port) return;
    if (active.performanceRecording) {
      active.performanceRecording = false;
      active.port.postMessage({ type: 'performance-record-stop' });
    } else {
      active.performance = [];
      active.performanceRecording = true;
      const id = ++requestSequence;
      active.performanceRequestId = id;
      active.port.postMessage({ type: 'performance-record-start', id });
    }
    renderDevtools();
  }
  async function requestRemotePerformanceSnapshot(tab) {
    if (!tab || !remoteMode || !remoteTransport?.ready || tab !== active) return;
    const nonce = tab.nonce, generation = remoteGeneration, id = ++requestSequence;
    tab.performanceRequestId = id;
    try {
      const result = await evaluateRemoteDom(tab, remotePerformanceSnapshotExpression());
      if (!result || tab !== active || nonce !== tab.nonce || generation !== remoteGeneration || tab.performanceRequestId !== id) return;
      tab.performance = Array.isArray(result.entries) ? result.entries.slice(-500).map(sanitizePerformanceEntry).filter(Boolean) : [];
      tab.performanceMemory = sanitizePerformanceMemory(result.memory); tab.performanceCapturedAt = Date.now();
      renderDevtools();
    } catch (error) {
      if (tab === active && nonce === tab.nonce && generation === remoteGeneration) {
        tab.console.push({ level: 'error', args: [`Could not capture remote performance: ${String(error.message || error).slice(0, 256)}`], time: Date.now() });
        trim(tab.console); renderDevtools();
      }
    }
  }
  function stopRemotePerformanceRecording(tab) {
    if (!tab) return;
    tab.performanceRecording = false;
    if (tab.remotePerformanceTimer) { clearTimeout(tab.remotePerformanceTimer); tab.remotePerformanceTimer = null; }
    if (remoteMode && remoteTransport?.ready) evaluateRemoteDom(tab, remotePerformanceStopExpression()).catch(() => {});
    if (tab === active) renderDevtools();
  }
  async function pollRemotePerformance(tab, nonce, generation) {
    if (!tab.performanceRecording || tab !== active || nonce !== tab.nonce || generation !== remoteGeneration || !remoteMode) return;
    if (!remoteTransport?.ready) { tab.performanceRecording = false; tab.remotePerformanceTimer = null; if (tab === active) renderDevtools(); return; }
    try {
      const result = await evaluateRemoteDom(tab, remotePerformanceDrainExpression());
      if (!tab.performanceRecording || tab !== active || nonce !== tab.nonce || generation !== remoteGeneration) return;
      if (!result || !Array.isArray(result.entries)) throw Error('Remote performance sample was unavailable.');
      tab.remotePerformanceFailures = 0;
      for (const entry of (Array.isArray(result.entries) ? result.entries : []).slice(0, 120)) {
        const clean = sanitizePerformanceEntry(entry); if (clean) tab.performance.push(clean);
      }
      if (tab.performance.length > 500) tab.performance.splice(0, tab.performance.length - 500);
      tab.performanceMemory = sanitizePerformanceMemory(result.memory); tab.performanceCapturedAt = Date.now();
      if (devTab === 'Performance') renderDevtools();
    } catch (error) {
      if (tab === active && nonce === tab.nonce && generation === remoteGeneration) {
        tab.remotePerformanceFailures = (tab.remotePerformanceFailures || 0) + 1;
        if (tab.remotePerformanceFailures === 1) {
          tab.console.push({ level: 'error', args: [`Remote performance recording error: ${String(error.message || error).slice(0, 256)}`], time: Date.now() });
          trim(tab.console);
        }
        if (tab.remotePerformanceFailures >= 3 || !remoteTransport?.ready) {
          tab.performanceRecording = false; tab.remotePerformanceTimer = null;
          if (devTab === 'Performance') renderDevtools();
          return;
        }
      }
    }
    if (tab.performanceRecording && tab === active && nonce === tab.nonce && generation === remoteGeneration && remoteTransport?.ready) {
      tab.remotePerformanceTimer = setTimeout(() => pollRemotePerformance(tab, nonce, generation), 1000);
    }
  }
  function updateNav() {
    back.disabled = !active || (remoteMode ? active.remoteCanGoBack !== true : active.historyIndex <= 0);
    forward.disabled = !active || (remoteMode ? active.remoteCanGoForward !== true : active.historyIndex >= active.history.length - 1);
    address.value = active?.url || '';
    bookmark.textContent = active && bookmarks.some(item => item.url === active.url) ? '★' : '☆';
    bookmark.title = active && bookmarks.some(item => item.url === active.url) ? 'Remove bookmark' : 'Bookmark this page';
    statusText.textContent = active?.loading ? 'Loading…' : active?.url || 'Ready';
    empty.hidden = !!active?.url;
    renderTabs(); renderDevtools();
  }
  function updateRemoteHistoryUi(tab) {
    if (tab !== active) { renderTabs(); return; }
    back.disabled = tab.remoteCanGoBack !== true;
    forward.disabled = tab.remoteCanGoForward !== true;
    address.value = tab.url || '';
    bookmark.textContent = bookmarks.some(item => item.url === tab.url) ? '★' : '☆';
    bookmark.title = bookmarks.some(item => item.url === tab.url) ? 'Remove bookmark' : 'Bookmark this page';
    if (!status.dataset.state || status.dataset.state !== 'error') statusText.textContent = tab.loading ? 'Loading…' : tab.url || 'Ready';
    empty.hidden = !!tab.url;
    renderTabs();
    if (!library.hidden) renderLibrary();
  }
  function setLocalViewerActive(activeViewer) {
    if (activeViewer && !localViewerUiState) localViewerUiState = {
      toolbar: toolbar.hidden, bookmarkBar: bookmarkBar.hidden, tabBar: tabBar.hidden,
      status: status.hidden, findBar: findBar.hidden, settings: settings.hidden, library: library.hidden,
    };
    toolbar.hidden = activeViewer || !!localViewerUiState?.toolbar;
    bookmarkBar.hidden = activeViewer || !!localViewerUiState?.bookmarkBar;
    tabBar.hidden = activeViewer || !!localViewerUiState?.tabBar;
    status.hidden = activeViewer || !!localViewerUiState?.status;
    findBar.hidden = activeViewer || !!localViewerUiState?.findBar;
    settings.hidden = activeViewer || !!localViewerUiState?.settings;
    library.hidden = activeViewer || !!localViewerUiState?.library;
    devtools.hidden = activeViewer || !prefs.devtoolsOpen;
    for (const tab of tabs) if (tab.iframe) tab.iframe.hidden = activeViewer || remoteMode || tab !== active;
    remoteView.hidden = activeViewer || !remoteMode || !active?.url;
    empty.hidden = activeViewer || !!active?.url;
    if (!activeViewer) localViewerUiState = null;
  }
  function openLocalDialog() {
    if (typeof readLocalFile !== 'function') { remoteStatus('Local files are unavailable in this browser context.', 'error'); return; }
    localDialogStatus.textContent = '';
    if (typeof localDialog.showModal === 'function') localDialog.showModal(); else localDialog.setAttribute('open', '');
    localPathInput.focus(); localPathInput.select();
  }
  async function openLocalPath() {
    let path = localPathInput.value.trim();
    if (!path) { localDialogStatus.textContent = 'Enter a path under the Eya file root.'; return; }
    if (!path.startsWith('/')) path = `/${path}`;
    if (!/\.html?$/i.test(path.split(/[?#]/, 1)[0])) { localDialogStatus.textContent = 'Open an .html or .htm document.'; return; }
    const request = ++localViewerRequest; localOpen.disabled = true; localDialogStatus.textContent = 'Loading local document…';
    try {
      const result = await readLocalFile(path);
      if (disposed || request !== localViewerRequest) return;
      const documentPath = typeof result?.meta?.path === 'string' ? result.meta.path : path;
      if (!result?.bytes || !/\.html?$/i.test(documentPath.split(/[?#]/, 1)[0])) throw Error('The selected file is not an HTML document.');
      localViewer?.dispose(); localViewer?.element.remove();
      const name = documentPath.split('/').at(-1) || documentPath;
      localViewer = createHtmlViewer({ path: documentPath, name, bytes: result.bytes }, {
        async readResource(resourcePath) { const resource = await readLocalFile(resourcePath); return { bytes: resource.bytes }; },
        openFile: typeof openLocalFile === 'function' ? openLocalFile : () => {},
      });
      localViewer.element.style.cssText = 'position:absolute;inset:0;z-index:6';
      const exit = button('Web browser', 'Return to web browsing', closeLocalViewer);
      localViewer.element.querySelector('.html-viewer-toolbar')?.prepend(exit);
      page.append(localViewer.element);
      localDialog.close?.(); localDialog.removeAttribute('open'); localDialogStatus.textContent = '';
      if (remoteMode) { clearRemoteFileChooser(false); clearRemoteDialogs(); remoteGeneration++; remoteTransport?.close(); remoteTransport = null; remoteOpening = null; remoteFramePending = null; }
      setLocalViewerActive(true);
    } catch (error) {
      if (!disposed && request === localViewerRequest) localDialogStatus.textContent = String(error?.message || error).slice(0, 240);
    } finally { if (request === localViewerRequest) localOpen.disabled = false; }
  }
  function closeLocalViewer() {
    localViewerRequest++;
    localViewer?.dispose(); localViewer?.element.remove(); localViewer = null;
    setLocalViewerActive(false); updateNav();
    if (remoteMode && active?.url) navigateRemote(active.url, false, active);
  }
  localForm.addEventListener('submit', event => { event.preventDefault(); openLocalPath(); });
  function remoteStatus(message, state = '') {
    statusText.textContent = String(message || '').slice(0, 160) || 'Remote browser';
    status.dataset.state = state;
  }
  function clearRemoteFileChooser(cancel = false) {
    const chooser = pendingRemoteFileChooser;
    pendingRemoteFileChooser = null;
    uploadPageFiles.hidden = true; uploadPageFiles.disabled = false;
    pageUploadPicker.value = '';
    if (cancel && chooser) {
      try { remoteTransport?.cancelPageFileChooser(chooser.tabId, chooser.id); } catch { /* The remote session may already be closing. */ }
    }
  }
  function showRemoteDialogForActive() {
    const entry = pendingRemoteDialogs.get(active?.id);
    if (!entry || !remoteMode) {
      pageDialog.close?.(); pageDialog.removeAttribute('open');
      return;
    }
    pageDialogTitle.textContent = entry.dialogType === 'beforeunload' ? 'Leave this page?' : `Message from ${new URL(active.url || 'https://example.invalid').hostname}`;
    pageDialogMessage.textContent = entry.message;
    pageDialogPrompt.hidden = entry.dialogType !== 'prompt';
    pageDialogPrompt.value = entry.promptText ?? entry.defaultPrompt;
    pageDialogStatus.textContent = entry.error || '';
    pageDialogCancel.hidden = entry.dialogType === 'alert';
    pageDialogCancel.textContent = entry.dialogType === 'beforeunload' ? 'Stay' : 'Cancel';
    pageDialogAccept.textContent = entry.dialogType === 'beforeunload' ? 'Leave' : 'OK';
    pageDialogCancel.disabled = pageDialogAccept.disabled = entry.submitting === true;
    if (!pageDialog.open && typeof pageDialog.showModal === 'function') pageDialog.showModal();
    else if (!pageDialog.open) pageDialog.setAttribute('open', '');
    if (entry.dialogType === 'prompt' && !entry.submitting) pageDialogPrompt.focus();
    else pageDialogAccept.focus();
  }
  function clearRemoteDialogs() {
    pendingRemoteDialogs.clear();
    pageDialog.close?.(); pageDialog.removeAttribute('open');
  }
  function resolveRemoteDialog(accept) {
    const entry = pendingRemoteDialogs.get(active?.id);
    if (!entry || entry.submitting || !remoteTransport?.ready) return;
    entry.submitting = true; entry.error = '';
    entry.promptText = pageDialogPrompt.value;
    pageDialogCancel.disabled = pageDialogAccept.disabled = true;
    pageDialogStatus.textContent = 'Waiting for the remote page…';
    try { remoteTransport.respondToJavaScriptDialog(entry.tabId, entry.id, accept, accept ? pageDialogPrompt.value : ''); }
    catch (error) {
      entry.submitting = false; entry.error = String(error.message || error).slice(0, 240);
      showRemoteDialogForActive();
    }
  }
  function remotePrivacySettings() {
    return { blockTrackers: prefs.blockTrackers === true, blockThirdParty: prefs.blockThirdParty === true, stripTracking: prefs.stripTracking === true };
  }
  async function evaluateRemoteDom(tab, expression) {
    if (!remoteMode || !remoteTransport?.ready || tab !== active || !tabs.includes(tab)) throw Error('The remote page is not available.');
    const nonce = tab.nonce, generation = remoteGeneration;
    const response = await remoteTransport.evaluate(tab.id, expression);
    if (disposed || generation !== remoteGeneration || nonce !== tab.nonce || !tabs.includes(tab)) return undefined;
    if (response.exception) throw Error(String(response.exception).slice(0, 2048));
    if (response.result?.exceptionDetails) throw Error(String(response.result.exceptionDetails.text || 'Remote DOM evaluation failed.').slice(0, 2048));
    return response.result;
  }
  function remoteStorageSnapshotExpression() {
    return `/*eya-storage-snapshot*/(()=>{const enc=new TextEncoder(),clip=(v,n)=>{let out='',bytes=0;for(const c of String(v)){const size=enc.encode(c).length;if(bytes+size>n)break;bytes+=size;out+=c}return out},take=storage=>{const rows=[],limit=Math.min(Number(storage.length)||0,40);for(let i=0;i<limit;i++){try{const k=clip(storage.key(i)||'',128),v=clip(storage.getItem(storage.key(i))||'',256);rows.push([k,v])}catch{}}return{rows,truncated:(Number(storage.length)||0)>limit}};let local={rows:[],truncated:false},session={rows:[],truncated:false},error='';try{local=take(localStorage);session=take(sessionStorage)}catch(e){error=String(e?.message||e).slice(0,128)}return{local:local.rows,session:session.rows,truncated:local.truncated||session.truncated,error}})()`;
  }
  async function requestRemoteStorageSnapshot(tab = active) {
    if (!tab || !remoteMode || !remoteTransport?.ready || tab !== active || !tab.url || tab.remoteStorageLoading) return;
    let origin; try { origin = new URL(tab.url).origin; } catch { return; }
    tab.remoteStorageLoading = true;
    if (devTab === 'Storage') renderDevtools();
    const nonce = tab.nonce, generation = remoteGeneration;
    try {
      const [snapshot, cookieResult] = await Promise.all([
        evaluateRemoteDom(tab, remoteStorageSnapshotExpression()), remoteTransport.cookies(tab.id, origin),
      ]);
      if (!snapshot || disposed || generation !== remoteGeneration || nonce !== tab.nonce || !tabs.includes(tab)) return;
      const local = sanitizeStorageItems(snapshot.local), session = sanitizeStorageItems(snapshot.session);
      tab.storage = [
        ...local.map(([key, value]) => ({ area: 'localStorage', key, value })),
        ...session.map(([key, value]) => ({ area: 'sessionStorage', key, value })),
        ...(cookieResult.cookies || []).map(cookie => ({ area: 'cookie', key: cookie.name, value: cookie.value, httpOnly: cookie.httpOnly, secure: cookie.secure, domain: cookie.domain, path: cookie.path, sameSite: cookie.sameSite })),
      ];
      tab.remoteStorageLoading = false; tab.remoteStorageTruncated = snapshot.truncated === true; tab.remoteStorageError = '';
      if (tab === active && devTab === 'Storage') renderDevtools();
    } catch (error) {
      if (nonce !== tab.nonce || generation !== remoteGeneration || !tabs.includes(tab)) return;
      tab.remoteStorageLoading = false; tab.remoteStorageError = `Could not read remote site data: ${String(error.message || error).slice(0, 256)}`;
      if (tab === active && devTab === 'Storage') { renderDevtools(); devOutput.textContent = tab.remoteStorageError; }
    }
  }
  function remotePerformanceEntryMapper() {
    return `e=>{const o={entryType:String(e.entryType||'').slice(0,32),name:String(e.name||'').slice(0,256)};for(const k of ['startTime','duration','transferSize','encodedBodySize','decodedBodySize','domInteractive','domContentLoadedEventStart','domContentLoadedEventEnd','loadEventStart','loadEventEnd','responseStart','responseEnd','value'])if(Number.isFinite(e[k]))o[k]=Math.max(0,e[k]);for(const k of ['initiatorType','nextHopProtocol'])if(typeof e[k]==='string')o[k]=e[k].slice(0,64);if(typeof e.hadRecentInput==='boolean')o.hadRecentInput=e.hadRecentInput;return o}`;
  }
  function remotePerformanceSnapshotExpression() {
    return `/*eya-performance-snapshot*/(()=>{const map=${remotePerformanceEntryMapper()},entries=performance.getEntries().slice(-80).map(map);const m=performance.memory;return{entries,memory:m?{usedJSHeapSize:m.usedJSHeapSize,totalJSHeapSize:m.totalJSHeapSize,jsHeapSizeLimit:m.jsHeapSizeLimit}:null}})()`;
  }
  function remotePerformanceStartExpression() {
    return `/*eya-performance-start*/(()=>{const k='__eyaPerformanceState';globalThis[k]?.observers?.forEach(o=>o.disconnect());const s={items:new Array(500),head:0,count:0,observers:[]};globalThis[k]=s;const map=${remotePerformanceEntryMapper()},types=PerformanceObserver.supportedEntryTypes||['navigation','paint','resource','longtask','layout-shift','mark','measure'];for(const type of types){try{const o=new PerformanceObserver(list=>{for(const e of list.getEntries()){s.items[(s.head+s.count)%500]=map(e);if(s.count<500)s.count++;else s.head=(s.head+1)%500}});o.observe({type,buffered:true});s.observers.push(o)}catch{}}return true})()`;
  }
  function remotePerformanceDrainExpression() {
    return `/*eya-performance-drain*/(()=>{const s=globalThis.__eyaPerformanceState,m=performance.memory,entries=[];if(s){const n=Math.min(64,s.count);for(let i=0;i<n;i++)entries.push(s.items[(s.head+i)%500]);s.head=(s.head+n)%500;s.count-=n}return{entries,memory:m?{usedJSHeapSize:m.usedJSHeapSize,totalJSHeapSize:m.totalJSHeapSize,jsHeapSizeLimit:m.jsHeapSizeLimit}:null}})()`;
  }
  function remotePerformanceStopExpression() {
    return `/*eya-performance-stop*/(()=>{const s=globalThis.__eyaPerformanceState;s?.observers?.forEach(o=>o.disconnect());globalThis.__eyaPerformanceState=null;return true})()`;
  }
  async function requestRemoteSources(tab = active) {
    if (!tab || !remoteMode || !remoteTransport?.ready || tab !== active || tab.remoteSourcesLoading) return;
    tab.remoteSourcesLoading = true; tab.remoteSourcesError = '';
    if (tab === active && devTab === 'Sources') renderDevtools();
    const nonce = tab.nonce, generation = remoteGeneration;
    try {
      const result = await remoteTransport.sources(tab.id);
      if (disposed || generation !== remoteGeneration || nonce !== tab.nonce || !tabs.includes(tab)) return;
      clearTabSources(tab);
      tab.sources = result.sources.map(source => ({
        key: `${source.kind}:${source.url}`, url: source.url, kind: source.kind, mimeType: source.mimeType,
        text: '', bytes: 0, truncated: false, remote: true, loaded: false,
      }));
      tab.remoteSourcesLoading = false;
      if (!tab.sources.some(source => source.key === tab.selectedSource)) tab.selectedSource = null;
      if (tab === active && devTab === 'Sources') renderDevtools();
    } catch (error) {
      if (nonce !== tab.nonce || generation !== remoteGeneration || !tabs.includes(tab)) return;
      tab.remoteSourcesLoading = false; tab.remoteSourcesError = `Could not list remote sources: ${String(error.message || error).slice(0, 256)}`;
      if (tab === active && devTab === 'Sources') renderDevtools();
    }
  }
  async function loadRemoteSource(tab, source) {
    if (!remoteMode || !remoteTransport?.ready || tab !== active || !source?.remote || source.loading || source.loaded) return;
    source.loading = true; source.error = ''; renderDevtools();
    const nonce = tab.nonce, generation = remoteGeneration, key = source.key;
    try {
      const result = await remoteTransport.sourceContent(tab.id, source.url);
      if (disposed || generation !== remoteGeneration || nonce !== tab.nonce || !tabs.includes(tab)) return;
      rememberSource(tab, source.url, source.kind, result.text);
      const loaded = tab.sources.find(item => item.key === key);
      if (loaded) { loaded.remote = true; loaded.loaded = true; loaded.truncated ||= result.truncated; }
      if (tab === active && devTab === 'Sources') renderDevtools();
    } catch (error) {
      if (nonce !== tab.nonce || generation !== remoteGeneration || !tabs.includes(tab)) return;
      source.loading = false; source.error = `Could not load source: ${String(error.message || error).slice(0, 256)}`;
      if (tab === active && devTab === 'Sources') renderDevtools();
    }
  }
  async function toggleSourceBreakpoint() {
    const tab = active;
    const source = (tab?.sources || []).find(item => item.key === tab.selectedSource);
    const line = Number(sourceBreakpointLine.value);
    if (!remoteMode || !remoteTransport?.ready || !source || !Number.isSafeInteger(line) || line < 1 || line > 1_000_000) return;
    const breakpoints = tab.remoteBreakpoints || (tab.remoteBreakpoints = new Map());
    const key = `${source.url}\n${line}`;
    const existing = breakpoints.get(key);
    sourceBreakpointToggle.disabled = true;
    try {
      if (existing) {
        await remoteTransport.debugger(tab.id, 'removeBreakpoint', { breakpointId: existing.id });
        breakpoints.delete(key);
        debuggerStatus.textContent = `Removed breakpoint · ${source.url}:${line}`;
      } else {
        const result = await remoteTransport.debugger(tab.id, 'setBreakpoint', { url: source.url, line });
        if (!result.breakpointId) throw Error('Chromium did not return a breakpoint id.');
        breakpoints.set(key, { id: result.breakpointId, url: source.url, line });
        debuggerStatus.textContent = `Breakpoint set · ${source.url}:${line}`;
      }
    } catch (error) {
      if (tab === active) debuggerStatus.textContent = `Debugger error: ${String(error.message || error).slice(0, 200)}`;
    } finally { renderDevtools(); }
  }
  async function runRemoteDebugger(action) {
    if (!remoteMode || !remoteTransport?.ready) return;
    const tab = active;
    if (!tab) return;
    try {
      await remoteTransport.debugger(tab.id, action);
      if (tab !== active) return;
      if (action === 'pause') debuggerStatus.textContent = 'Pause requested…';
      else if (action === 'resume') debuggerStatus.textContent = 'Resume requested…';
    } catch (error) {
      if (tab === active) debuggerStatus.textContent = `Debugger error: ${String(error.message || error).slice(0, 200)}`;
    }
  }
  async function requestRemoteDebuggerScopes(tab, frame) {
    if (!remoteMode || !remoteTransport?.ready || !frame?.callFrameId || frame.scopesLoading || frame.scopes) return;
    frame.scopesLoading = true;
    const nonce = tab.nonce, generation = remoteGeneration;
    try {
      const result = await remoteTransport.debugger(tab.id, 'getScopes', { callFrameId: frame.callFrameId });
      if (disposed || generation !== remoteGeneration || nonce !== tab.nonce || !tabs.includes(tab) || !tab.debuggerCallFrames?.includes(frame)) return;
      frame.scopes = result.scopes || [];
    } catch (error) {
      if (generation !== remoteGeneration || nonce !== tab.nonce || !tabs.includes(tab)) return;
      frame.scopesError = `Could not read scopes: ${String(error.message || error).slice(0, 180)}`;
    } finally {
      frame.scopesLoading = false;
      if (tab === active && devTab === 'Sources') renderDevtools();
    }
  }
  function remoteDomSnapshotExpression() {
    return `(()=>{const k='__eyaDevtoolsState';let s=globalThis[k];if(!s||!(s.nodes instanceof Map)){s={nodes:new Map(),ids:new WeakMap(),nextId:1,childOffsets:new Map(),highlighted:null};globalThis[k]=s}if(s.highlighted){const h=s.highlighted,n=h.node;if(n?.style){if(h.outline)n.style.setProperty('outline',h.outline,h.outlinePriority);else n.style.removeProperty('outline');if(h.offset)n.style.setProperty('outline-offset',h.offset,h.offsetPriority);else n.style.removeProperty('outline-offset')}}s.highlighted=null;s.nodes.clear();s.childOffsets.clear();let budget=60;const walk=(n,d)=>{if(!n||n.nodeType!==1||budget<=0)return null;budget--;let id=s.ids.get(n);if(!id){id=s.nextId++;s.ids.set(n,id)}s.nodes.set(id,n);const all=[...n.children],take=d<3?all.slice(0,Math.min(20,budget)):[],children=[];for(const child of take){const v=walk(child,d+1);if(v)children.push(v)}s.childOffsets.set(id,children.length);return{id,tag:String(n.localName||n.nodeName||'').toLowerCase().slice(0,64),attrs:[...n.attributes].slice(0,5).map(a=>[String(a.name).slice(0,64),String(a.value).slice(0,64)]),text:all.length?'':[...n.childNodes].filter(c=>c.nodeType===3).map(c=>c.nodeValue||'').join('').slice(0,180),children,hasChildren:all.length>0,childrenLoaded:children.length>=all.length}};const roots=[...(document.body?.children||[])],tree=[];for(const n of roots.slice(0,40)){const v=walk(n,0);if(v)tree.push(v)}return{tree,hasMore:roots.length>tree.length}})()`;
  }
  function remoteDomChildrenExpression(nodeId) {
    const id = JSON.stringify(Number(nodeId));
    return `(()=>{const s=globalThis.__eyaDevtoolsState,id=${id},p=s?.nodes.get(id);if(!p?.isConnected)return{error:'Node no longer exists'};let budget=60;const walk=(n,d)=>{if(!n||n.nodeType!==1||budget<=0)return null;budget--;let key=s.ids.get(n);if(!key){key=s.nextId++;s.ids.set(n,key)}s.nodes.set(key,n);const all=[...n.children],take=d<2?all.slice(0,Math.min(20,budget)):[],children=[];for(const child of take){const v=walk(child,d+1);if(v)children.push(v)}s.childOffsets.set(key,children.length);return{id:key,tag:String(n.localName||n.nodeName||'').toLowerCase().slice(0,64),attrs:[...n.attributes].slice(0,5).map(a=>[String(a.name).slice(0,64),String(a.value).slice(0,64)]),text:all.length?'':[...n.childNodes].filter(c=>c.nodeType===3).map(c=>c.nodeValue||'').join('').slice(0,180),children,hasChildren:all.length>0,childrenLoaded:children.length>=all.length}};const all=[...p.children],offset=s.childOffsets.get(id)||0,children=[];for(const n of all.slice(offset,offset+20)){const v=walk(n,0);if(v)children.push(v)}const next=offset+children.length;s.childOffsets.set(id,next);return{id,offset,children,childrenLoaded:next>=all.length}})()`;
  }
  function remoteDomInspectExpression(nodeId) {
    const id = JSON.stringify(Number(nodeId));
    return `(()=>{const n=globalThis.__eyaDevtoolsState?.nodes.get(${id});if(!n?.isConnected)return{id:${id},error:'Node no longer exists'};const r=n.getBoundingClientRect(),s=getComputedStyle(n),computed={},keys=['display','position','boxSizing','width','height','color','backgroundColor','fontFamily','fontSize','fontWeight','lineHeight','textAlign','overflow','margin','padding','border','opacity','zIndex','flex','gridTemplateColumns'];for(const k of keys)computed[k]=String(s[k]||'').slice(0,512);return{id:${id},computed,box:{x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,right:r.right,bottom:r.bottom,left:r.left}}})()`;
  }
  function remoteDomHighlightExpression(nodeId) {
    const id = JSON.stringify(Number(nodeId));
    return `(()=>{const s=globalThis.__eyaDevtoolsState,n=s?.nodes.get(${id});if(!n?.isConnected)return false;const h=s.highlighted;if(h?.node){if(h.outline)h.node.style.setProperty('outline',h.outline,h.outlinePriority);else h.node.style.removeProperty('outline');if(h.offset)h.node.style.setProperty('outline-offset',h.offset,h.offsetPriority);else h.node.style.removeProperty('outline-offset')}s.highlighted={node:n,outline:n.style.getPropertyValue('outline'),outlinePriority:n.style.getPropertyPriority('outline'),offset:n.style.getPropertyValue('outline-offset'),offsetPriority:n.style.getPropertyPriority('outline-offset')};n.style.setProperty('outline','2px solid #13b8a6','important');n.style.setProperty('outline-offset','2px','important');n.scrollIntoView?.({block:'nearest',inline:'nearest'});return true})()`;
  }
  async function requestRemoteDomSnapshot(tab = active) {
    if (!tab || !remoteMode || !remoteTransport?.ready || tab !== active || tab.domLoading) return;
    tab.domLoading = true;
    if (tab === active && devTab === 'Elements') renderDevtools();
    try {
      const snapshot = await evaluateRemoteDom(tab, remoteDomSnapshotExpression());
      if (!snapshot || !Array.isArray(snapshot.tree)) return;
      tab.dom = snapshot.tree; tab.domLoading = false;
      if (snapshot.hasMore) devEditStatus.textContent = 'Showing a bounded DOM snapshot; expand branches to load more nodes.';
      if (tab.selectedNodeId != null && !remoteDomFind(tab.dom, tab.selectedNodeId)) tab.selectedNodeId = null;
      if (tab === active && devTab === 'Elements') renderDevtools();
      if (tab.selectedNodeId != null) inspectRemoteNode(tab, tab.selectedNodeId);
    } catch (error) {
      tab.domLoading = false; devEditStatus.textContent = `Could not inspect remote DOM: ${String(error.message || error).slice(0, 256)}`;
      if (tab === active && devTab === 'Elements') renderDevtools();
    }
  }
  function remoteDomFind(nodes, id) {
    for (const node of nodes || []) { if (node.id === id) return node; const found = remoteDomFind(node.children, id); if (found) return found; }
    return null;
  }
  async function loadRemoteDomChildren(tab, node) {
    if (!remoteMode || tab !== active || !node || !Number.isSafeInteger(node.id)) return;
    try {
      const result = await evaluateRemoteDom(tab, remoteDomChildrenExpression(node.id));
      if (!result || result.error) throw Error(result?.error || 'The page changed during inspection.');
      const current = remoteDomFind(tab.dom, node.id);
      if (!current || result.offset !== current.children.length) return;
      current.children.push(...result.children); current.childrenLoaded = result.childrenLoaded;
      current.hasChildren = current.children.length > 0 || current.hasChildren;
      if (tab === active) renderDevtools();
    } catch (error) { devEditStatus.textContent = `Could not expand remote DOM: ${String(error.message || error).slice(0, 256)}`; }
  }
  async function inspectRemoteNode(tab, nodeId) {
    try {
      const result = await evaluateRemoteDom(tab, remoteDomInspectExpression(nodeId));
      if (!result || result.id !== tab.selectedNodeId || tab !== active) return;
      tab.inspectedNode = { id: result.id, box: result.box, computed: result.computed, error: result.error };
      if (tab === active) renderDevtools();
    } catch (error) { devEditStatus.textContent = `Could not inspect node: ${String(error.message || error).slice(0, 256)}`; }
  }
  async function highlightRemoteNode(tab, nodeId) {
    try { await evaluateRemoteDom(tab, remoteDomHighlightExpression(nodeId)); }
    catch (error) { devEditStatus.textContent = `Could not highlight node: ${String(error.message || error).slice(0, 256)}`; }
  }
  async function editRemoteNode(tab, nodeId, kind, property, value) {
    if (!Number.isSafeInteger(nodeId) || nodeId < 1 || typeof value !== 'string') return;
    let expression;
    if (kind === 'text') {
      if (new TextEncoder().encode(value).byteLength > 4096) { devEditStatus.textContent = 'Text edit exceeds 4 KiB UTF-8.'; return; }
      expression = `(()=>{const n=globalThis.__eyaDevtoolsState?.nodes.get(${JSON.stringify(nodeId)}),v=${JSON.stringify(value)};if(!n?.isConnected)return{ok:false,error:'Node no longer exists'};if(n.nodeType!==1||n.childElementCount||['SCRIPT','STYLE'].includes(n.tagName)||new TextEncoder().encode(v).byteLength>4096)return{ok:false,error:'Text editing requires a leaf element and at most 4 KiB UTF-8'};n.textContent=v;return{ok:true}})()`;
    } else if (kind === 'attribute') {
      const name = String(property || '').trim().toLowerCase();
      if (new TextEncoder().encode(name).byteLength > 64 || new TextEncoder().encode(value).byteLength > 512 || /[\u0000-\u001f\u007f]/.test(value)) { devEditStatus.textContent = 'Attribute name or value is invalid or exceeds its byte limit.'; return; }
      expression = `(()=>{const n=globalThis.__eyaDevtoolsState?.nodes.get(${JSON.stringify(nodeId)}),k=${JSON.stringify(name)},v=${JSON.stringify(value)},safe=['id','class','title','role','alt','hidden','tabindex','dir','lang'].includes(k)||/^aria-[a-z][a-z0-9-]{0,57}$/.test(k);if(!n?.isConnected)return{ok:false,error:'Node no longer exists'};if(n.nodeType!==1||!safe||new TextEncoder().encode(v).byteLength>512||/[\\u0000-\\u001f\\u007f]/.test(v))return{ok:false,error:'Unsupported or unsafe attribute edit'};n.setAttribute(k,v);return{ok:true}})()`;
    } else if (kind === 'style') {
      const name = String(property || '').toLowerCase();
      if (new TextEncoder().encode(name).byteLength > 32 || new TextEncoder().encode(value).byteLength > 512 || /[\u0000-\u001f\u007f]/.test(value) || /(?:url\s*\(|@import|expression\s*\()/i.test(value)) { devEditStatus.textContent = 'Style value is invalid or exceeds its byte limit.'; return; }
      expression = `(()=>{const n=globalThis.__eyaDevtoolsState?.nodes.get(${JSON.stringify(nodeId)}),k=${JSON.stringify(name)},v=${JSON.stringify(value)},safe=['color','background-color','display','position','width','height','margin','padding','opacity','font-size','font-weight','text-align','border-color','line-height','z-index','flex','grid-template-columns'].includes(k);if(!n?.isConnected)return{ok:false,error:'Node no longer exists'};if(n.nodeType!==1||!safe||new TextEncoder().encode(v).byteLength>512||/[\\u0000-\\u001f\\u007f]/.test(v)||/(?:url\\s*\\(|@import|expression\\s*\\()/i.test(v))return{ok:false,error:'Unsupported or unsafe CSS edit'};n.style.setProperty(k,v);return{ok:true}})()`;
    } else return;
    devEditStatus.textContent = 'Applying edit in server Chromium…';
    try {
      const result = await evaluateRemoteDom(tab, expression);
      if (!result?.ok) { devEditStatus.textContent = String(result?.error || 'The page changed during the edit.'); return; }
      devEditStatus.textContent = 'Applied in the current page.'; tab.inspectedNode = null;
      await requestRemoteDomSnapshot(tab);
      if (tab.selectedNodeId != null) { highlightRemoteNode(tab, tab.selectedNodeId); inspectRemoteNode(tab, tab.selectedNodeId); }
    } catch (error) { devEditStatus.textContent = `Edit failed: ${String(error.message || error).slice(0, 256)}`; }
  }
  function handleRemoteEvent(value, channel = 'status') {
    if (channel === 'status') {
      if (value.type === 'ready') {
        const limits = value.resourceLimits;
        if (limits?.enforced === true && Number.isInteger(limits.memoryMb) && Number.isInteger(limits.cpuPercent) && Number.isInteger(limits.processes)) {
          const downloads = value.downloadsEnabled === false ? '; downloads unavailable' : '';
          remoteStatus(`Server browser ready · ${limits.memoryMb} MiB, ${limits.cpuPercent}% CPU, ${limits.processes} processes capped${downloads}`);
        } else {
          remoteStatus(value.downloadsEnabled === false ? 'Server browser ready; hard CPU/memory limits are not configured and downloads are unavailable' : 'Server browser ready; hard CPU/memory limits are not configured', 'warning');
        }
      }
      else if (value.type === 'tab-info' && typeof value.tabId === 'string') {
        const tab = tabs.find(item => item.id === value.tabId);
        if (!remoteMode || !tab) return;
        if (typeof value.title === 'string' && value.title) tab.title = value.title.slice(0, 256);
        const extensionUrl = tab.extensionPopup && tab.extensionId && typeof value.url === 'string' && value.url.startsWith(`chrome-extension://${tab.extensionId}/`);
        if (typeof value.url === 'string' && (value.url === 'about:blank' || /^https?:\/\//i.test(value.url) || extensionUrl)) {
          try {
            tab.url = value.url === 'about:blank' ? value.url : safeUrl(value.url);
            if (tab.historyIndex >= 0 && tab.historyIndex < tab.history.length) tab.history[tab.historyIndex] = tab.url;
            else { tab.history = [tab.url]; tab.historyIndex = 0; tab.historyDocuments = [null]; tab.historyFrameIndices = [-1]; }
          } catch { /* Ignore unsupported target URLs from Chromium. */ }
        }
        if (tab === active) updateNav(); else renderTabs();
      }
      else if (value.type === 'popup-open' && typeof value.tabId === 'string' && typeof value.url === 'string') {
        if (!remoteMode || tabs.some(tab => tab.id === value.tabId)) return;
        const extensionPopup = value.extensionPopup === true;
        const extensionId = typeof value.extensionId === 'string' && /^[a-p]{32}$/.test(value.extensionId) ? value.extensionId : '';
        if (extensionPopup && (!extensionId || !value.url.startsWith(`chrome-extension://${extensionId}/`))) {
          try { remoteTransport?.closeTab(value.tabId); } catch { /* Reject an invalid extension popup target. */ }
          return;
        }
        const tab = createTab('', { id: value.tabId, url: value.url, title: value.title || (extensionPopup ? 'Extension action' : ''), remoteReady: true, extensionPopup, extensionId });
        if (!tab) {
          try { remoteTransport?.closeTab(value.tabId); } catch { /* The remote target may already be gone. */ }
          remoteStatus('Popup closed because the browser tab limit was reached.', 'error');
          return;
        }
        if (tab === active) remoteStatus(extensionPopup ? 'Extension action opened in a new tab' : 'Popup opened in a new tab');
      }
      else if (value.type === 'popup-blocked') remoteStatus(String(value.message || 'Popup was blocked').slice(0, 256), 'error');
      else if (value.type === 'tab-closed' && typeof value.tabId === 'string') {
        const tab = tabs.find(item => item.id === value.tabId);
        if (tab && remoteMode) closeTab(tab, false);
      }
      else if (value.type === 'history') {
        const tab = tabs.find(item => item.id === value.tabId);
        const entries = Array.isArray(value.entries) ? value.entries.slice(0, 50) : null;
        const index = Number(value.currentIndex);
        if (!remoteMode || !tab || !entries || !Number.isSafeInteger(index) || (entries.length && (index < 0 || index >= entries.length))) return;
        const normalized = entries.map(entry => {
          if (!entry || !Number.isSafeInteger(entry.id) || typeof entry.url !== 'string' || entry.url.length > 8192) return null;
          return { id: entry.id, url: entry.url, title: String(entry.title || entry.url).slice(0, 256) };
        });
        if (normalized.some(entry => !entry)) return;
        tab.history = normalized.map(entry => entry.url);
        tab.historyIndex = index;
        tab.historyDocuments = normalized.map(() => null);
        tab.historyFrameIndices = normalized.map(() => -1);
        tab.remoteHistoryEntryIds = normalized.map(entry => entry.id);
        tab.remoteCanGoBack = entries.length > 0 && value.canGoBack === true;
        tab.remoteCanGoForward = entries.length > 0 && value.canGoForward === true;
        if (entries.length) {
          tab.url = normalized[index].url;
          tab.title = normalized[index].title || tab.title;
        }
        tab.loading = false;
        updateRemoteHistoryUi(tab);
      }
      else if (value.type === 'history-error') {
        const tab = tabs.find(item => item.id === value.tabId);
        if (tab) tab.loading = false;
        if (tab === active) { updateRemoteHistoryUi(tab); remoteStatus(String(value.message || 'Remote history navigation failed').slice(0, 512), 'error'); }
      }
      else if (value.type === 'tab-activated' && typeof value.tabId === 'string') {
        const tab = tabs.find(item => item.id === value.tabId);
        if (tab) {
          tab.remoteReady = true;
          if (typeof value.url === 'string' && /^https?:\/\//i.test(value.url)) {
            try {
              tab.url = safeUrl(value.url);
              if (tab.historyIndex >= 0 && tab.historyIndex < tab.history.length) tab.history[tab.historyIndex] = tab.url;
              else { tab.history = [tab.url]; tab.historyIndex = 0; tab.historyDocuments = [null]; tab.historyFrameIndices = [-1]; }
            } catch { /* Keep the current safe address if Chromium reports an unsupported target URL. */ }
          }
        }
        if (tab === active) { showRemoteDialogForActive(); updateNav(); }
      }
      else if (value.type === 'tab-error' && typeof value.tabId === 'string') {
        const tab = tabs.find(item => item.id === value.tabId);
        if (tab) tab.remoteReady = false;
        if (tab === active) remoteStatus(String(value.message || 'Full-browser tab could not be activated').slice(0, 512), 'error');
      }
      else if (value.type === 'file-chooser') {
        if (!remoteMode || value.tabId !== active?.id || !Number.isSafeInteger(value.id) || value.id < 1) return;
        pendingRemoteFileChooser = { id: value.id, tabId: value.tabId, multiple: value.multiple === true };
        pageUploadPicker.multiple = pendingRemoteFileChooser.multiple;
        uploadPageFiles.hidden = false; uploadPageFiles.disabled = false;
        remoteStatus(pendingRemoteFileChooser.multiple ? 'Page asks you to choose files' : 'Page asks you to choose a file');
      }
      else if (value.type === 'javascript-dialog') {
        if (!remoteMode || typeof value.tabId !== 'string' || !tabs.some(tab => tab.id === value.tabId) || !Number.isSafeInteger(value.id) || value.id < 1 || !['alert', 'confirm', 'prompt', 'beforeunload'].includes(value.dialogType)) return;
        pendingRemoteDialogs.set(value.tabId, {
          id: value.id,
          tabId: value.tabId,
          dialogType: value.dialogType,
          message: String(value.message || '').slice(0, 4096),
          defaultPrompt: String(value.defaultPrompt || '').slice(0, 1024),
          submitting: false,
          error: '',
        });
        if (value.tabId === active?.id) showRemoteDialogForActive();
      }
      else if (value.type === 'javascript-dialog-closed') {
        const entry = pendingRemoteDialogs.get(value.tabId);
        if (entry?.id === value.id) pendingRemoteDialogs.delete(value.tabId);
        if (value.tabId === active?.id) showRemoteDialogForActive();
      }
      else if (value.type === 'javascript-dialog-result') {
        const entry = pendingRemoteDialogs.get(value.tabId);
        if (entry?.id === value.id) {
          if (value.ok) pendingRemoteDialogs.delete(value.tabId);
          else { entry.submitting = false; entry.error = String(value.message || 'Chromium could not close the page dialog').slice(0, 240); }
          if (value.tabId === active?.id) showRemoteDialogForActive();
        }
      }
      else if (typeof value.tabId === 'string' && value.tabId !== active?.id) return;
      else if (value.type === 'navigating') { clearRemoteFileChooser(false); remoteStatus('Loading in server browser…'); }
      else if (value.type === 'title' && active) {
        active.title = String(value.title || new URL(active.url || 'https://example.invalid').hostname).slice(0, 256);
        if (value.url) active.url = String(value.url).slice(0, 8192);
        if (active.historyIndex >= 0 && active.historyIndex < active.history.length) active.history[active.historyIndex] = active.url;
        active.loading = false;
        updateNav();
      } else if (value.type === 'download-start') {
        if (!Number.isSafeInteger(value.id) || value.id < 1 || downloads.some(item => item.remoteDownloadId === value.id)) return;
        if (downloads.filter(item => item.status === 'downloading').length >= MAX_ACTIVE_DOWNLOADS || downloads.length >= MAX_DOWNLOADS) {
          try { remoteTransport?.cancelDownload(value.id); } catch { /* The remote session may already be closing. */ }
          return;
        }
        const filename = safeDownloadFilename('', String(value.url || active?.url || ''), String(value.filename || 'download'));
        const item = { remoteDownloadId: value.id, filename, status: 'downloading', bytes: 0, receivedBytes: 0, totalBytes: 0, error: '', blob: null, releaseMemory: null, objectUrl: '', revokeTimer: null, cancel: () => remoteTransport?.cancelDownload(value.id) };
        downloads.unshift(item);
        if (devTab === 'Downloads') renderDevtools();
      } else if (value.type === 'download-progress') {
        const item = downloads.find(download => download.remoteDownloadId === value.id);
        if (item) { item.receivedBytes = Math.max(0, Number(value.receivedBytes) || 0); item.totalBytes = Math.max(0, Number(value.totalBytes) || 0); if (devTab === 'Downloads') renderDevtools(); }
      } else if (value.type === 'download-transfer') {
        const item = downloads.find(download => download.remoteDownloadId === value.id);
        if (item) { item.transferring = true; if (devTab === 'Downloads') renderDevtools(); }
      } else if (value.type === 'download-failed' || value.type === 'download-cancelled') {
        const item = downloads.find(download => download.remoteDownloadId === value.id);
        if (item) { item.status = value.type === 'download-cancelled' ? 'cancelled' : 'failed'; item.error = String(value.message || '').slice(0, 256); item.cancel = null; if (devTab === 'Downloads') renderDevtools(); }
      } else if (value.type === 'error') remoteStatus(value.message || 'Remote browser error', 'error');
      return;
    }
    const eventTab = typeof value?.tabId === 'string' ? tabs.find(tab => tab.id === value.tabId) : active;
    if (!eventTab) return;
    const eventIsActive = eventTab === active;
    const params = value?.params || {};
    if (value?.method === 'Debugger.paused') {
      const frame = Array.isArray(params.callFrames) ? params.callFrames[0] : null;
      const location = frame?.location || {};
      eventTab.remoteDebuggerPaused = {
        callFrameId: typeof frame?.callFrameId === 'string' ? frame.callFrameId.slice(0, 256) : '',
        location: `${String(frame?.url || eventTab.url || 'script').slice(0, 180)}:${Math.max(0, Number(location.lineNumber) || 0) + 1}:${Math.max(0, Number(location.columnNumber) || 0) + 1}`,
        reason: String(params.reason || '').slice(0, 64),
      };
      eventTab.debuggerCallFrames = (params.callFrames || []).slice(0, 32).map(item => ({ callFrameId: String(item.callFrameId || '').slice(0, 256), functionName: String(item.functionName || '(anonymous)').slice(0, 256), url: String(item.url || '').slice(0, 2048), line: Math.max(0, Number(item.location?.lineNumber) || 0) + 1, column: Math.max(0, Number(item.location?.columnNumber) || 0) + 1 }));
      if (eventIsActive) remoteDebuggerPaused = eventTab.remoteDebuggerPaused;
      if (!eventIsActive) return;
    } else if (value?.method === 'Debugger.resumed') {
      eventTab.remoteDebuggerPaused = null;
      eventTab.debuggerCallFrames = [];
      if (eventIsActive) remoteDebuggerPaused = null;
      if (!eventIsActive) return;
    } else if (!eventIsActive) return;
    if (value?.method === 'Page.loadEventFired' && active) {
      active.loading = false; updateNav();
      if (remoteMode && devTab === 'Elements') requestRemoteDomSnapshot(active);
      else if (remoteMode && devTab === 'Sources') requestRemoteSources(active);
      else if (remoteMode && devTab === 'Performance') requestRemotePerformanceSnapshot(active);
      else if (remoteMode && devTab === 'Storage') requestRemoteStorageSnapshot(active);
    } else if (value?.method === 'Page.frameNavigated' && params.frame?.parentId == null && active) {
      clearRemoteFileChooser(false);
      remoteDebuggerPaused = null; active.debuggerCallFrames = [];
      active.remoteDebuggerPaused = null;
      if (/^https?:/i.test(params.frame.url || '')) {
        const committedUrl = params.frame.url.slice(0, 8192);
        const requestedUrl = active.url;
        active.url = committedUrl;
        // Page.navigate records its requested URL before Chromium finishes
        // redirects. Keep the current entry and the persisted library aligned
        // with the URL Chromium actually committed.
        if (active.historyIndex >= 0 && active.historyIndex < active.history.length) {
          active.history[active.historyIndex] = committedUrl;
          const oldStored = storedHistory.find(item => item.url === requestedUrl);
          storedHistory = [{ url: committedUrl, title: active.title || oldStored?.title || '', at: Date.now() },
            ...storedHistory.filter(item => item.url !== committedUrl && item.url !== requestedUrl)].slice(0, MAX_HISTORY);
          
          if (!library.hidden) renderLibrary();
        }
        updateNav();
      }
    } else if (value?.method === 'Runtime.consoleAPICalled') {
      const args = Array.isArray(params.args) ? params.args.slice(0, 32).map(item => item?.value ?? item?.description ?? item?.type ?? '') : [];
      (active?.console || []).push({ level: String(params.type || 'log').slice(0, 16), args, time: Date.now() });
      if (active) trim(active.console);
    } else if (value?.method === 'Runtime.exceptionThrown') {
      const detail = params.exceptionDetails || {};
      active?.console.push({ level: 'error', args: [String(detail.text || detail.exception?.description || 'Page exception').slice(0, 2048)], time: Date.now() });
      if (active) trim(active.console);
    } else if (value?.method === 'Network.requestWillBeSent' && active) {
      const request = params.request || {}, row = { url: String(request.url || '').slice(0, 8192), method: String(request.method || 'GET').slice(0, 32), status: 'Pending', startedAt: Date.now(), requestBytes: Number(request.postData?.length) || 0, bytes: 0, duration: 0, requestHeaders: Object.entries(request.headers || {}).slice(0, 64), responseHeaders: [], remoteRequestId: params.requestId };
      active.remoteRequests ||= new Map(); active.remoteRequests.set(params.requestId, row); active.network.push(row); trim(active.network);
    } else if (value?.method === 'Network.responseReceived' && active) {
      const row = active.remoteRequests?.get(params.requestId), response = params.response || {};
      if (row) { row.status = Number(response.status) || 'Received'; row.responseStatus = Number(response.status) || 0; row.mimeType = String(response.mimeType || '').slice(0, 128); row.responseHeaders = Object.entries(response.headers || {}).slice(0, 64); }
    } else if (value?.method === 'Network.loadingFinished' && active) {
      const row = active.remoteRequests?.get(params.requestId);
      if (row) { row.status = row.responseStatus || 'Complete'; row.bytes = Number(params.encodedDataLength) || 0; row.duration = Math.max(0, Date.now() - row.startedAt); row.loadingComplete = true; active.remoteRequests.delete(params.requestId); }
    } else if (value?.method === 'Network.loadingFailed' && active) {
      const row = active.remoteRequests?.get(params.requestId);
      if (row) { row.status = 'Failed'; row.error = String(params.errorText || 'Request failed').slice(0, 256); row.duration = Math.max(0, Date.now() - row.startedAt); active.remoteRequests.delete(params.requestId); }
    } else if (value?.method === 'Eya.requestBlocked' && active) {
      const id = params.requestId == null ? '' : String(params.requestId);
      const row = active.remoteRequests?.get(id) || active.network.find(item => item.url === params.url && item.status === 'Pending');
      if (row) {
        row.status = 'Blocked'; row.blocked = String(params.reason || 'policy').slice(0, 32);
        row.duration = Math.max(0, Date.now() - row.startedAt);
        if (id) active.remoteRequests?.delete(id);
      }
      blockedCount.textContent = `${Number.parseInt(blockedCount.textContent, 10) + 1} blocked`;
    }
    if (active) { trim(active.network); queueNetworkRender(active); if (devTab !== 'Network') renderDevtools(); }
  }
  function handleRemoteDownload(bytes, metadata) {
    const item = downloads.find(download => download.remoteDownloadId === metadata.id);
    if (!item || item.status !== 'downloading') return;
    let release;
    try {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_DOWNLOAD_BYTES) throw Error('Download exceeds the 64 MiB client limit.');
      release = resourceBudget.retain(bytes.byteLength);
      item.blob = new Blob([bytes], { type: 'application/octet-stream' });
      item.releaseMemory = release; item.bytes = bytes.byteLength; item.receivedBytes = bytes.byteLength;
      item.status = 'ready'; item.cancel = null;
    } catch (error) {
      release?.();
      item.status = 'failed'; item.error = String(error?.message || error).slice(0, 256); item.cancel = null;
    }
    if (devTab === 'Downloads') renderDevtools();
  }
  function handleRemoteFrame(bytes, metadata) {
    if (metadata.tabId !== active?.id) {
      try { remoteTransport?.ack(metadata.seq); } catch { /* Drop stale-tab frames during a switch. */ }
      return;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    if (remoteObjectUrl) URL.revokeObjectURL(remoteObjectUrl);
    const acknowledge = () => {
      if (remoteFramePending !== metadata.seq) return;
      remoteFramePending = null;
      try { remoteTransport?.ack(metadata.seq); } catch (error) { remoteStatus(String(error.message || error), 'error'); }
    };
    remoteObjectUrl = url; remoteFramePending = metadata.seq;
    remoteView.onload = () => {
      const decoded = remoteView.decode?.();
      if (decoded) decoded.catch(() => {}).finally(acknowledge); else acknowledge();
    };
    remoteView.onerror = acknowledge;
    remoteView.src = url;
  }
  async function ensureRemoteTransport() {
    if (remoteOpening) return remoteOpening;
    if (remoteTransport?.ready) return remoteTransport;
    if (typeof openRemoteBrowser !== 'function') throw Error('Server-side Chromium is not configured for this Eya server.');
    const generation = remoteGeneration;
    const opening = openRemoteBrowser({ onState: (state, error) => {
      if (generation !== remoteGeneration || !remoteMode) return;
      if (state === 'error') { clearRemoteDialogs(); remoteStatus(error?.message || 'Remote browser error', 'error'); }
      else if (state === 'ready') renderDevtools();
      else if (state === 'closed') {
        clearRemoteFileChooser(false);
        remoteExtensions = [];
        remoteBreakpoints.clear(); remoteDebuggerPaused = null;
        for (const item of downloads) if (item.remoteDownloadId && item.status === 'downloading') { item.status = 'cancelled'; item.error = 'Full browser session ended.'; item.cancel = null; }
        for (const tab of tabs) {
          tab.remoteReady = false;
          tab.remoteBreakpoints?.clear(); tab.remoteDebuggerPaused = null; tab.debuggerCallFrames = [];
          tab.selectedRemoteObject = null; tab.remoteObjectProperties?.clear(); tab.remoteObjectExpanded?.clear();
          if (tab.remotePerformanceTimer) { clearTimeout(tab.remotePerformanceTimer); tab.remotePerformanceTimer = null; }
          tab.performanceRecording = false;
        }
        if (status.dataset.state !== 'error') remoteStatus('Remote browser disconnected', 'error');
        if (devTab === 'Performance' || devTab === 'Extensions' || devTab === 'Sources' || devTab === 'Downloads') renderDevtools();
      }
    }, onEvent: handleRemoteEvent, onFrame: handleRemoteFrame, onDownload: handleRemoteDownload }).then(async transport => {
      if (disposed || !remoteMode || generation !== remoteGeneration) { transport.close(); return null; }
      remoteTransport = transport;
      try { await transport.start(); }
      catch (error) { if (remoteTransport === transport) remoteTransport = null; transport.close(); throw error; }
      if (disposed || !remoteMode || generation !== remoteGeneration) { transport.close(); return null; }
      transport.privacy(remotePrivacySettings()); sendRemoteResize(); return transport;
    });
    remoteOpening = opening;
    opening.then(() => { if (remoteOpening === opening) remoteOpening = null; }, () => { if (remoteOpening === opening) remoteOpening = null; });
    return opening;
  }
  function syncRemoteFilters(transport = remoteTransport) {
    if (!transport?.ready) return Promise.resolve();
    const previous = remoteFilterSync;
    const current = (async () => {
      if (previous) await previous.catch(() => {});
      if (remoteMode && transport === remoteTransport) await transport.filters(remoteNetworkFilterSnapshot(filters));
    })();
    remoteFilterSync = current;
    return current;
  }
  function sendRemoteResize() {
    if (!remoteMode || !remoteTransport?.ready) return;
    const bounds = page.getBoundingClientRect();
    const width = Math.max(320, Math.min(1920, Math.round(bounds.width))), height = Math.max(240, Math.min(1200, Math.round(bounds.height)));
    if (width < 160 || height < 120) return;
    remoteViewport.width = width; remoteViewport.height = height;
    try { remoteTransport.resize(width, height, active?.id); } catch { /* Resize is best effort during teardown. */ }
  }
  async function navigateRemote(url, record, targetTab) {
    const generation = remoteGeneration;
    tabReset(targetTab);
    const navigationNonce = targetTab.nonce;
    targetTab.loading = true; targetTab.url = url;
    if (targetTab === active) { remoteView.hidden = false; remoteTextSurface.hidden = false; remoteTextSurface.focus(); empty.hidden = true; updateNav(); }
    try {
      const transport = await ensureRemoteTransport();
      if (!transport || !remoteMode || generation !== remoteGeneration || disposed || !tabs.includes(targetTab) || targetTab.nonce !== navigationNonce) return false;
      if (!remoteMode || generation !== remoteGeneration || disposed || !tabs.includes(targetTab) || targetTab.nonce !== navigationNonce) return false;
      if (targetTab !== active) return true;
      const activated = await transport.activateTab(targetTab.id);
      if (!remoteMode || generation !== remoteGeneration || disposed || !tabs.includes(targetTab) || targetTab.nonce !== navigationNonce) {
        if (tabs.includes(targetTab) && targetTab.nonce === navigationNonce) targetTab.loading = false;
        return false;
      }
      targetTab.remoteReady = true;
      if (targetTab !== active) {
        if (tabs.includes(targetTab) && targetTab.nonce === navigationNonce) {
          targetTab.loading = false;
          if (typeof activated?.url === 'string') targetTab.url = activated.url;
          renderTabs();
        }
        return false;
      }
      if (!remoteMode || generation !== remoteGeneration || disposed || !tabs.includes(targetTab) || targetTab.nonce !== navigationNonce || targetTab !== active) {
        if (tabs.includes(targetTab) && targetTab.nonce === navigationNonce) {
          targetTab.loading = false;
          if (remoteMode && generation === remoteGeneration && typeof activated?.url === 'string') targetTab.url = activated.url;
          renderTabs();
        }
        return false;
      }
      remoteStatus('Loading in server browser…');
      transport.navigate(url, targetTab.id);
      targetTab.remoteReady = true;
      if (record) {
        targetTab.history = targetTab.history.slice(0, targetTab.historyIndex + 1);
        targetTab.historyDocuments = targetTab.historyDocuments.slice(0, targetTab.historyIndex + 1); targetTab.historyFrameIndices = targetTab.historyFrameIndices.slice(0, targetTab.historyIndex + 1);
        targetTab.history.push(url); targetTab.historyDocuments.push(null); targetTab.historyFrameIndices.push(-1);
        if (targetTab.history.length > 50) { targetTab.history.shift(); targetTab.historyDocuments.shift(); targetTab.historyFrameIndices.shift(); } targetTab.historyIndex = targetTab.history.length - 1;
        storedHistory = [{ url, title: targetTab.title, at: Date.now() }, ...storedHistory.filter(item => item.url !== url)].slice(0, MAX_HISTORY);
        
      } else if (targetTab.historyIndex >= 0) { targetTab.history[targetTab.historyIndex] = url; targetTab.historyDocuments[targetTab.historyIndex] = null; targetTab.historyFrameIndices[targetTab.historyIndex] = -1; }
      targetTab.loading = false;
      if (targetTab === active) updateNav(); else renderTabs();
      return true;
    } catch (error) {
      targetTab.loading = false;
      if (remoteMode && generation === remoteGeneration) remoteStatus(String(error.message || error), 'error');
      return false;
    }
  }
  async function toggleRemoteMode() {
    if (disposed || typeof openRemoteBrowser !== 'function') return;
    if (remoteMode) { cancelRemoteTouch(); clearRemoteFileChooser(true); }
    remoteMode = !remoteMode;
    const generation = ++remoteGeneration;
    if (!remoteMode) for (const tab of tabs) {
      if (tab.remotePerformanceTimer) { clearTimeout(tab.remotePerformanceTimer); tab.remotePerformanceTimer = null; }
      tab.performanceRecording = false;
      tab.remoteReady = false;
      tab.remoteBreakpoints?.clear(); tab.remoteDebuggerPaused = null; tab.debuggerCallFrames = [];
    }
    if (!remoteMode) clearRemoteDialogs();
    else for (const tab of tabs) if (tab.performanceRecording) {
      tab.performanceRecording = false; tab.port?.postMessage({ type: 'performance-record-stop' });
    }
    remoteToggle.textContent = remoteMode ? 'Fast proxy' : 'Server browser';
    remoteToggle.title = 'Fast proxy is unavailable until all page navigation can be kept on the WebSocket.';
    remoteToggle.setAttribute('aria-label', remoteToggle.title);
    remoteToggle.setAttribute('aria-pressed', String(remoteMode));
    findButton.disabled = false;
    for (const [name, tabButton] of devTabButtons) {
      tabButton.disabled = remoteMode && !['Console', 'Network', 'Performance', 'Elements', 'Sources', 'Downloads', 'Storage', 'Extensions'].includes(name);
      tabButton.title = remoteMode && tabButton.disabled ? `${name} is only available in Proxy mode.` : `Open ${name} DevTools`;
    }
    disableCacheLabel.hidden = captureBodiesLabel.hidden = remoteMode;
    if (remoteMode && !['Console', 'Network', 'Performance', 'Elements', 'Sources', 'Downloads', 'Storage', 'Extensions'].includes(devTab)) { devTab = 'Console'; renderDevtools(); }
    remoteView.hidden = !remoteMode || !active?.url;
    remoteTextSurface.hidden = !remoteMode || !active?.url;
    for (const tab of tabs) if (tab.iframe) tab.iframe.hidden = remoteMode || tab !== active;
    empty.hidden = !!active?.url;
    if (remoteMode) {
      try {
        if (!active?.url) { remoteStatus('Server browser ready; Chromium starts when you open a web page.'); return; }
        await ensureRemoteTransport();
        if (!remoteMode || generation !== remoteGeneration) return;
        sendRemoteResize();
        if (active?.url) await navigateRemote(active.url, false, active);
        remoteTextSurface.focus();
      } catch (error) { if (remoteMode && generation === remoteGeneration) remoteStatus(String(error.message || error), 'error'); }
    } else {
      remoteStatus('Fast proxy mode: page JavaScript runs in the client browser; WebSocket-only egress is best-effort.', 'warning');
      findButton.disabled = false;
      for (const [name, tabButton] of devTabButtons) { tabButton.disabled = false; tabButton.title = `Open ${name} DevTools`; }
      disableCacheLabel.hidden = captureBodiesLabel.hidden = false;
      remoteTransport?.close(); remoteTransport = null; remoteOpening = null; remoteFramePending = null;
      remoteExtensions = [];
      remoteBreakpoints.clear(); remoteDebuggerPaused = null;
      for (const tab of tabs) { tab.remoteBreakpoints?.clear(); tab.remoteDebuggerPaused = null; tab.debuggerCallFrames = []; tab.selectedRemoteObject = null; tab.remoteObjectProperties?.clear(); tab.remoteObjectExpanded?.clear(); }
      if (remoteObjectUrl) { URL.revokeObjectURL(remoteObjectUrl); remoteObjectUrl = ''; }
      remoteView.removeAttribute('src');
      remoteTextSurface.hidden = true; remoteTextSurface.replaceChildren();
      if (active?.url) await navigate(active.url, false, active);
    }
    renderDevtools();
  }
  function remoteInput(event, deferTouchMove = false) {
    if (!remoteMode || !remoteTransport?.ready) return;
    const bounds = remoteView.getBoundingClientRect();
    const point = remoteViewportPoint(bounds, remoteViewport, event.clientX, event.clientY);
    if (!point || (event.type === 'pointerdown' && !point.inside)) return;
    const { x, y } = point, scaleX = point.scale, scaleY = point.scale;
    if (event.pointerType === 'touch') {
      const pointerId = Math.max(0, Math.min(0x7fff_ffff, Math.floor(Number(event.pointerId) || 0)));
      if (event.type === 'pointerdown') {
        if (remoteTouchContacts.has(pointerId) || remoteTouchContacts.size >= 10) return;
      } else if (!remoteTouchContacts.has(pointerId)) return;
      const radiusX = Math.max(1, Math.min(128, (Number(event.width) || 2) * scaleX / 2));
      const radiusY = Math.max(1, Math.min(128, (Number(event.height) || 2) * scaleY / 2));
      const pressure = Number.isFinite(Number(event.pressure)) ? Math.max(0.01, Math.min(1, Number(event.pressure))) : 0.5;
      if (event.type === 'pointerdown') {
        const forwarded = remoteTouchActive || remoteTouchContacts.size === 0;
        remoteTouchContacts.set(pointerId, { forwarded, point: { id: pointerId, x, y, force: pressure, radiusX, radiusY } });
        if (forwarded) { remoteTouchActive = true; sendRemoteTouch('touchStart'); }
      } else if (event.type === 'pointermove') {
        const contact = remoteTouchContacts.get(pointerId);
        if (!contact.forwarded) return;
        contact.point = { id: pointerId, x, y, force: pressure, radiusX, radiusY };
        if (!deferTouchMove) sendRemoteTouch('touchMove');
        else return true;
      } else if (event.type === 'pointerup' || event.type === 'pointercancel') {
        remoteTouchMoveEvents.delete(pointerId);
        const contact = remoteTouchContacts.get(pointerId);
        remoteTouchContacts.delete(pointerId);
        if (contact?.forwarded && remoteTouchActive) {
          sendRemoteTouch(event.type === 'pointerup' ? 'touchEnd' : 'touchCancel');
          remoteTouchActive = false;
          for (const other of remoteTouchContacts.values()) other.forwarded = false;
        }
      }
      return;
    }
    if (event.type === 'pointerdown') remoteMousePointers.add(event.pointerId);
    else if (event.type === 'pointerup' || event.type === 'pointercancel') {
      if (!remoteMousePointers.delete(event.pointerId)) return;
    }
    const buttonName = event.button >= 0 ? (['left', 'middle', 'right'][event.button] || '') : '';
    try {
      remoteTransport.input({ type: 'mouse', action: event.type === 'pointerdown' ? 'mousePressed' : event.type === 'pointerup' || event.type === 'pointercancel' ? 'mouseReleased' : 'mouseMoved', x, y, button: buttonName, buttons: event.buttons || 0, clickCount: event.type === 'pointerdown' ? 1 : 0 }, active?.id);
    } catch { /* A stale input event must not break the panel. */ }
  }
  function scheduleRemotePointer(event) {
    if (!remoteMode || !remoteTransport?.ready) return;
    if (event.pointerType === 'touch') remoteTouchMoveEvents.set(event.pointerId, event);
    else remotePointerEvent = event;
    if (remotePointerFrame) return;
    remotePointerFrame = requestAnimationFrame(() => {
      remotePointerFrame = 0;
      let touchMoved = false;
      for (const touchEvent of remoteTouchMoveEvents.values()) {
        if (remoteInput(touchEvent, true)) touchMoved = true;
      }
      remoteTouchMoveEvents.clear();
      if (touchMoved) sendRemoteTouch('touchMove');
      if (remotePointerEvent) remoteInput(remotePointerEvent);
      remotePointerEvent = null;
    });
  }
  function sendRemoteTouch(action) {
    if (!remoteMode || !remoteTransport?.ready || !active) return;
    const touchPoints = action === 'touchEnd' || action === 'touchCancel'
      ? []
      : [...remoteTouchContacts.values()].filter(contact => contact.forwarded).map(contact => contact.point);
    try { remoteTransport.input({ type: 'touch', action, touchPoints }, active.id); }
    catch { /* A stale touch event must not break the panel. */ }
  }
  function remoteKey(event, action) {
    if (!remoteMode || !remoteTransport?.ready) return;
    if (event.isComposing || event.key === 'Dead' || (Array.from(event.key).length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)) return;
    const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
    try { remoteTransport.input({ type: 'key', action, key: event.key, code: event.code, keyCode: event.keyCode || 0, modifiers, text: action === 'keyDown' && event.key.length === 1 ? event.key : '', unmodifiedText: action === 'keyDown' && event.key.length === 1 ? event.key : '' }, active?.id); }
    catch { /* A stale input event must not break the panel. */ }
  }
  let remoteComposing = false;
  function sendRemoteText(text) {
    if (!remoteMode || !remoteTransport?.ready || !active || !text) return;
    try { remoteTransport.insertText(text, active.id); }
    catch (error) { remoteStatus(String(error.message || error), 'error'); }
  }
  function cancelRemoteTouch() {
    if (remoteTouchActive) sendRemoteTouch('touchCancel');
    remoteTouchActive = false;
    remoteTouchContacts.clear(); remoteTouchMoveEvents.clear();
  }
  function createTab(url = '', options = {}) {
    if (disposed || tabs.length >= MAX_BROWSER_TABS) return null;
    const suppliedId = typeof options.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(options.id) && !tabs.some(tab => tab.id === options.id) ? options.id : '';
    if (options.id && !suppliedId) return null;
    const initialUrl = typeof options.url === 'string' ? options.url.slice(0, 8192) : '';
    const tab = { id: suppliedId || `eya-browser-${++requestSequence}`, url: initialUrl, title: String(options.title || (initialUrl ? initialUrl : 'New tab')).slice(0, 256), history: initialUrl ? [initialUrl] : [], historyIndex: initialUrl ? 0 : -1, iframe: null, port: null, nonce: randomToken(), console: [], network: [], performance: [], performanceMemory: null, performanceRecording: false, sources: [], selectedSource: null, remoteBreakpoints: new Map(), remoteDebuggerPaused: null, dom: null, storage: null, findText: '', findStatus: '', findRequestId: 0, sessionStorageByOrigin: Object.create(null), sessionStorageByteCounts: Object.create(null), sessionStorageBytes: 0, pageModuleBytes: 0, pageModuleGraphs: 0, blobs: new Map(), resourceCache: new Map(), resourceLoads: new Map(), controllers: new Set(), requestControllers: new Map(), webSockets: new Map(), webSocketOpenings: new Map(), loading: false, remoteReady: options.remoteReady === true, extensionPopup: options.extensionPopup === true, extensionId: typeof options.extensionId === 'string' && /^[a-p]{32}$/.test(options.extensionId) ? options.extensionId : '' };
    tab.historyDocuments = []; tab.historyFrameIndices = [];
    if (initialUrl) { tab.historyDocuments.push(null); tab.historyFrameIndices.push(-1); }
    const iframe = document.createElement('iframe'); iframe.className = 'eya-browser-frame'; iframe.title = 'Web page';
    iframe.setAttribute('sandbox', 'allow-scripts'); iframe.setAttribute('referrerpolicy', 'no-referrer');
    // Never assign iframe.src. The frame receives only a generated srcdoc document.
    iframe.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;color:#586771;margin:2em}</style></head><body>Enter an address to begin.</body></html>';
    tab.iframe = iframe; tabs.push(tab); page.insertBefore(iframe, settings); activateTab(tab); if (url && !tab.remoteReady) navigate(url, true, tab); else updateNav(); return tab;
  }
  function activateTab(tab) {
    if (active !== tab) cancelRemoteTouch();
    if (pendingRemoteFileChooser && pendingRemoteFileChooser.tabId !== tab.id) clearRemoteFileChooser(true);
    if (active) {
      active.remoteBreakpoints = remoteBreakpoints;
      active.remoteDebuggerPaused = remoteDebuggerPaused;
    }
    active = tab;
    showRemoteDialogForActive();
    remoteBreakpoints = tab.remoteBreakpoints || (tab.remoteBreakpoints = new Map());
    remoteDebuggerPaused = tab.remoteDebuggerPaused || null;
    for (const value of tabs) if (value.iframe) value.iframe.hidden = remoteMode || value !== tab;
    remoteView.hidden = !remoteMode || !tab.url;
    remoteTextSurface.hidden = !remoteMode || !tab.url;
    if (remoteMode && tab.url) remoteTextSurface.focus();
    if (findTimer) { clearTimeout(findTimer); findTimer = null; }
    if (!findBar.hidden) { findInput.value = tab.findText || ''; findStatus.textContent = tab.findStatus || ''; }
    updateNav();
    if (remoteMode) {
      if (tab.remoteReady) remoteTransport?.activateTab(tab.id).catch(error => { if (tab === active) remoteStatus(String(error.message || error), 'error'); });
      else if (tab.url) navigateRemote(tab.url, false, tab);
      else if (remoteTransport?.ready) remoteTransport.activateTab(tab.id).catch(error => { if (tab === active) remoteStatus(String(error.message || error), 'error'); });
    }
  }
  function closeTab(tab, closeRemote = true) {
    pendingRemoteDialogs.delete(tab.id);
    if (tab === active) showRemoteDialogForActive();
    tab.remoteBreakpoints = tab === active ? remoteBreakpoints : tab.remoteBreakpoints || new Map();
    tab.remoteDebuggerPaused = tab === active ? remoteDebuggerPaused : tab.remoteDebuggerPaused || null;
    if (closeRemote && remoteMode && tab.remoteReady) { try { remoteTransport?.closeTab(tab.id); } catch { /* Session teardown closes remaining targets. */ } }
    tabReset(tab);
    for (const row of tab.network) releaseCapturedNetworkRow(row);
    if (tab.port) { tab.port.close(); tab.port = null; }
    tab.iframe?.remove(); tabs.splice(tabs.indexOf(tab), 1);
    const wasActive = active === tab;
    if (wasActive) {
      active = tabs[Math.max(0, tabs.length - 1)] || null;
      remoteBreakpoints = active?.remoteBreakpoints || new Map();
      remoteDebuggerPaused = active?.remoteDebuggerPaused || null;
    }
    if (!findBar.hidden) { findInput.value = active?.findText || ''; findStatus.textContent = active?.findStatus || ''; }
    if (!tabs.length) {
      if (remoteMode) { remoteTransport?.close(); remoteTransport = null; remoteView.hidden = true; }
      createTab('');
    } else {
      updateNav();
      if (wasActive && remoteMode && active?.remoteReady) {
        const nextTab = active;
        remoteTransport?.activateTab(nextTab.id).catch(error => { if (active === nextTab) remoteStatus(String(error.message || error), 'error'); });
      }
      else if (wasActive && remoteMode && active?.url) navigateRemote(active.url, false, active);
      else if (wasActive && remoteMode) { remoteTransport?.close(); remoteTransport = null; remoteView.hidden = true; }
    }
  }
  async function navigateAddress() {
    let raw = address.value.trim(); if (!raw) return;
    if (!/^(?:https?:\/\/|[^\s.]+\.[^\s]+|localhost(?::\d+)?)(?:[/?#]|$)/i.test(raw)) raw = searchUrl(raw);
    try { await navigate(safeUrl(raw, active?.url || undefined), true); } catch (error) { showError(error); }
  }
  async function navigateHistory(delta, targetTab = active) {
    if (!targetTab) return;
    if (remoteMode) {
      if (!remoteTransport?.ready || targetTab !== active || (delta < 0 ? !targetTab.remoteCanGoBack : !targetTab.remoteCanGoForward)) return;
      try {
        remoteTransport.historyGo(targetTab.id, delta);
        targetTab.loading = true; updateNav(); remoteStatus('Loading history entry…');
      } catch (error) { remoteStatus(String(error.message || error).slice(0, 512), 'error'); }
      return;
    }
    const next = targetTab.historyIndex + delta;
    if (next < 0 || next >= targetTab.history.length) return;
    const target = targetTab.history[next];
    if (!remoteMode && targetTab.port && targetTab.historyDocuments?.[next] === targetTab.nonce && Number.isInteger(targetTab.historyFrameIndices?.[next])) {
      targetTab.historyIndex = next; targetTab.url = target;
      targetTab.port.postMessage({ type: 'history-traverse', index: targetTab.historyFrameIndices[next] }); if (targetTab === active) updateNav(); else renderTabs(); return;
    }
    targetTab.historyIndex = next; await navigate(target, false, targetTab);
  }
  async function navigate(raw, record = true, targetTab = active, requestOptions = {}) {
    if (!targetTab || disposed) return false;
    await siteStorageReady;
    if (disposed || !tabs.includes(targetTab)) return false;
    let url;
    try { url = safeUrl(raw, targetTab.url || undefined); } catch (error) { showError(error); return false; }
    if (prefs.stripTracking) url = stripTracking(url);
    if (remoteMode) return navigateRemote(url, record, targetTab);
    if (!proxyNavigationAvailable(window)) {
      targetTab.url = url; tabReset(targetTab);
      showError(new Error('Proxy mode requires the browser Navigation API to keep page navigation inside the WebSocket proxy. Use Full browser in this browser.'), targetTab);
      return false;
    }
    const previousUrl = targetTab.url;
    tabReset(targetTab);
    const navigationNonce = targetTab.nonce;
    targetTab.loading = true; targetTab.url = url; if (targetTab === active) updateNav();
    const controller = new AbortController(); controllers.add(controller); targetTab.controllers.add(controller);
    const started = performance.now(), startedAt = Date.now();
    try {
      const method = requestOptions.method || 'GET';
      const headers = { accept: 'text/html,application/xhtml+xml', ...(requestOptions.headers || {}) };
      const navigationCookies = cookieString(cookieJar, url, { pageUrl: previousUrl, topLevel: true, method });
      if (navigationCookies && !Object.keys(headers).some(name => name.toLowerCase() === 'cookie')) headers.cookie = navigationCookies;
      const response = await browserRequest(url, { method, headers, body: requestOptions.body, signal: controller.signal });
      if (disposed || !tabs.includes(targetTab) || targetTab.nonce !== navigationNonce) return false;
      const body = response.body instanceof Uint8Array ? response.body : new Uint8Array(response.body || []);
      if (body.byteLength > MAX_BODY_BYTES) throw Error('Page is larger than the 8 MiB document limit.');
      const contentType = header(response.headers, 'content-type');
      if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) throw Error(`This page returned ${contentType}, not HTML.`);
      const decoder = new TextDecoder('utf-8'); let html = decoder.decode(body);
      const finalUrl = response.url || url;
      rememberSource(targetTab, finalUrl, 'Document', html);
      applySetCookies(cookieJar, response.cookies, finalUrl);
      syncCookies();
      const origin = new URL(finalUrl).origin;
      const localValues = siteStorage[origin] || Object.create(null);
      const sessionValues = targetTab.sessionStorageByOrigin[origin] || Object.create(null);
      const localQuota = Math.min(MAX_STORAGE_AREA_BYTES, Math.max(storageObjectBytes(localValues), MAX_STORAGE_TOTAL_BYTES - (siteStorageBytes - (siteStorageByteCounts[origin] || 0))));
      const sessionQuota = Math.min(MAX_STORAGE_AREA_BYTES, Math.max(storageObjectBytes(sessionValues), MAX_TAB_SESSION_STORAGE_BYTES - (targetTab.sessionStorageBytes - (targetTab.sessionStorageByteCounts[origin] || 0))));
      const storageSnapshot = { local: localValues, session: sessionValues, localQuota, sessionQuota };
      const pageUserscripts = await loadUserscriptResources(targetTab, matchingUserscripts(finalUrl), controller.signal);
      html = injectBootstrap(html, targetTab.nonce, finalUrl, cookieString(cookieJar, finalUrl, { includeHttpOnly: false }), pageUserscripts, cosmeticCssForPage(filters, finalUrl), storageSnapshot, userscriptStorageSnapshot(pageUserscripts));
      targetTab.iframe.srcdoc = html;
      targetTab.url = finalUrl;
      targetTab.title = titleFromHtml(html) || new URL(finalUrl).hostname;
      targetTab.loading = false;
      targetTab.network.push({ startedAt, method, status: response.status, url: finalUrl, requestBytes: requestOptions.body?.byteLength || 0, duration: Math.round(performance.now() - started), bytes: body.length, cacheHit: response.cacheHit === true, requestHeaders: Object.entries(headers), responseHeaders: normalizeHeaders(response.headers) }); trim(targetTab.network);
      if (record) {
        targetTab.history = targetTab.history.slice(0, targetTab.historyIndex + 1);
        targetTab.historyDocuments = targetTab.historyDocuments.slice(0, targetTab.historyIndex + 1); targetTab.historyFrameIndices = targetTab.historyFrameIndices.slice(0, targetTab.historyIndex + 1);
        targetTab.history.push(finalUrl); targetTab.historyDocuments.push(targetTab.nonce); targetTab.historyFrameIndices.push(0);
        if (targetTab.history.length > 50) { targetTab.history.shift(); targetTab.historyDocuments.shift(); targetTab.historyFrameIndices.shift(); } targetTab.historyIndex = targetTab.history.length - 1;
        storedHistory = [{ url: finalUrl, title: targetTab.title, at: Date.now() }, ...storedHistory.filter(item => item.url !== finalUrl)].slice(0, MAX_HISTORY);
        
        if (!library.hidden) renderLibrary();
      } else if (targetTab.historyIndex >= 0) { targetTab.history[targetTab.historyIndex] = finalUrl; targetTab.historyDocuments[targetTab.historyIndex] = targetTab.nonce; targetTab.historyFrameIndices[targetTab.historyIndex] = 0; }
      if (targetTab === active) updateNav(); else renderTabs();
      return true;
    } catch (error) {
      if (targetTab.nonce === navigationNonce) {
        targetTab.loading = false;
        if (error.name !== 'AbortError') showError(error, targetTab);
      }
      return false;
    } finally { controllers.delete(controller); targetTab.controllers.delete(controller); }
  }
  function tabReset(tab) {
    tab.selectedRemoteObject = null;
    tab.remoteObjectProperties?.clear();
    tab.remoteObjectExpanded?.clear();
    tab.debuggerCallFrames = [];
    tab.remoteDebuggerPaused = null;
    if (tab === active) remoteDebuggerPaused = null;
    tab.dom = null; tab.domLoading = false; tab.selectedNodeId = null; tab.inspectedNode = null;
    tab.remoteStorageLoading = false; tab.remoteStorageError = ''; tab.remoteStorageTruncated = false;
    if (tab.remotePerformanceTimer) { clearTimeout(tab.remotePerformanceTimer); tab.remotePerformanceTimer = null; }
    if (tab.performanceRecording) tab.port?.postMessage({ type: 'performance-record-stop' });
    tab.performanceRecording = false; tab.performance = []; tab.performanceMemory = null; tab.selectedPerformance = null;
    tab.pageModuleBytes = 0; tab.pageModuleGraphs = 0;
    tab.findText = ''; tab.findStatus = ''; tab.findRequestId++;
    if (tab === active) { if (findTimer) { clearTimeout(findTimer); findTimer = null; } findInput.value = ''; findStatus.textContent = ''; }
    clearTabSources(tab);
    for (const relay of tab.requestControllers.values()) releaseRelayCapture(relay);
    for (const controller of tab.controllers) controller.abort();
    tab.controllers.clear();
    tab.requestControllers.clear();
    for (const opening of tab.webSocketOpenings.values()) { opening.closeRequested = true; opening.closeCode = 1001; opening.closeReason = 'Page navigated'; }
    for (const socket of tab.webSockets.values()) { try { socket.close(1001, 'Page navigated'); } catch { /* Closing a stale page socket is best effort. */ } }
    tab.webSockets.clear();
    tab.webSocketOpenings.clear();
    tab.port?.close(); tab.port = null; tab.nonce = randomToken();
    tab.resourceCache.clear();
    tab.resourceLoads.clear();
    for (const [blob, releaseBytes] of tab.blobs) { URL.revokeObjectURL(blob); releaseBytes(); }
    tab.blobs.clear();
  }
  async function requestPageResource(tab, target, method, headers, body, signal, credentials, mode) {
    const pageOrigin = new URL(tab.url).origin; const targetOrigin = new URL(target).origin;
    const crossOrigin = pageOrigin !== targetOrigin;
    const noCors = crossOrigin && mode === 'no-cors';
    if (crossOrigin && mode === 'same-origin') throw TypeError('The request mode forbids cross-origin access.');
    const requestHeaders = { ...headers };
    delete requestHeaders.cookie; delete requestHeaders.Cookie; delete requestHeaders.origin; delete requestHeaders.Origin;
    if (crossOrigin) requestHeaders.origin = pageOrigin;
    const sendCookies = credentials === 'include' || (!crossOrigin && credentials === 'same-origin');
    if (sendCookies) {
      const cookie = cookieString(cookieJar, target, { pageUrl: tab.url, method });
      if (cookie) requestHeaders.cookie = cookie;
    }
    if (noCors) {
      const methodIsSimple = ['GET', 'HEAD', 'POST'].includes(method.toUpperCase());
      if (!methodIsSimple || Object.entries(headers).some(([name, value]) => !corsSafelistedHeader(name, value))) throw TypeError('The request is not allowed in no-cors mode.');
    }
    if (crossOrigin && !noCors) {
      const upperMethod = method.toUpperCase();
      const methodIsSimple = ['GET', 'HEAD', 'POST'].includes(upperMethod);
      const unsafeHeaders = Object.entries(headers).filter(([name, value]) => !corsSafelistedHeader(name, value)).map(([name]) => name.toLowerCase()).sort();
      if (!methodIsSimple || unsafeHeaders.length) {
        const cacheKey = JSON.stringify([pageOrigin, new URL(target).href, upperMethod, unsafeHeaders, credentials === 'include']);
        const cachedUntil = corsPreflightCache.get(cacheKey) || 0;
        if (cachedUntil <= Date.now()) {
          const preflightHeaders = { origin: pageOrigin, 'access-control-request-method': upperMethod };
          if (unsafeHeaders.length) preflightHeaders['access-control-request-headers'] = unsafeHeaders.join(', ');
          const started = performance.now(), startedAt = Date.now();
          const preflight = await browserRequest(target, { method: 'OPTIONS', headers: preflightHeaders, signal });
          const preflightOk = preflight.status >= 200 && preflight.status < 300
            && corsPreflightAllowed(preflight.headers, pageOrigin, upperMethod, unsafeHeaders, credentials);
          tab.network.push({ startedAt, method: 'OPTIONS', status: preflight.status, url: target, duration: Math.round(performance.now() - started), bytes: 0, preflight: true, requestHeaders: Object.entries(preflightHeaders), responseHeaders: normalizeHeaders(preflight.headers) });
          trim(tab.network); if (tab === active) renderDevtools();
          if (!preflightOk) throw TypeError('Cross-origin request failed its CORS preflight.');
          const expiry = corsMaxAge(preflight.headers);
          if (expiry > Date.now()) {
            corsPreflightCache.set(cacheKey, expiry);
            if (corsPreflightCache.size > 128) corsPreflightCache.delete(corsPreflightCache.keys().next().value);
          }
        }
      }
    }
    const response = await browserRequest(target, { method, headers: requestHeaders, body, signal, stream: true });
    if (noCors) {
      if (credentials === 'include') applySetCookies(cookieJar, response.cookies, response.url || target);
      response.body?.cancel?.().catch?.(() => {}); syncCookies();
      return { status: 0, headers: [], cookies: [], url: '', body: null, opaque: true };
    }
    const responseCrossOrigin = pageOrigin !== new URL(response.url || target).origin;
    if ((crossOrigin || responseCrossOrigin) && !noCors) {
      if (!corsOriginAllowed(response.headers, pageOrigin, credentials)) {
        response.body?.cancel?.().catch?.(() => {});
        throw TypeError('Cross-origin response did not allow this page origin.');
      }
      response.headers = corsVisibleHeaders(response.headers, credentials);
    }
    if (credentials !== 'omit' && ((!crossOrigin && !responseCrossOrigin) || credentials === 'include')) applySetCookies(cookieJar, response.cookies, response.url || target);
    syncCookies();
    return response;
  }
  function resourceBlockReason(tab, target, resourceType) {
    if (prefs.blockThirdParty && schemefulSite(tab.url) !== schemefulSite(target)) return 'third-party';
    if (prefs.blockTrackers) {
      const decision = matchFilterList(filters, target, tab.url, resourceType);
      if (decision === true) return 'filter-list';
      if (decision === null && looksLikeTracker(target)) return 'built-in';
    }
    return '';
  }
  function recordBlockedResource(tab, target, resourceType, reason) {
    tab.network.push({ startedAt: Date.now(), method: 'GET', status: 204, url: target, duration: 0, bytes: 0, blocked: reason, requestHeaders: [], responseHeaders: [] });
    trim(tab.network);
    if (tab === active) renderDevtools();
    blockedCount.textContent = `${Number.parseInt(blockedCount.textContent, 10) + 1} blocked`;
    return resourceType;
  }
  async function readBlob(response, limit, type) {
    const reservation = resourceBudget.reserve();
    if (!response.body?.getReader) return { blob: new Blob([], { type }), release: reservation.commit() };
    const reader = response.body.getReader(); const chunks = []; let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += chunk.byteLength;
        if (total > limit) { await reader.cancel(); throw Error('Resource exceeds its client memory limit.'); }
        reservation.add(chunk.byteLength);
        chunks.push(chunk);
      }
      reservation.add(total);
      const blob = new Blob(chunks, { type });
      return { blob, release: reservation.commit(total) };
    } catch (error) {
      try { await reader.cancel(error); } catch { /* The stream may already be closed. */ }
      reservation.release();
      throw error;
    } finally { reader.releaseLock(); }
  }
  async function rewriteProxyCss(tab, source, base, signal, depth) {
    if (depth > 3) return source;
    let css = source;
    const maxCssChars = 8 * 1024 * 1024;
    const matches = expression => scanCssResourceMatches(css, expression);
    const ensureSize = (items, lengths) => {
      let size = css.length;
      for (let i = 0; i < items.length; i++) size += lengths[i] - items[i][0].length;
      if (size > maxCssChars) throw Error('Rewritten stylesheet exceeds the 8 MiB character limit.');
    };
    const imports = matches(/@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)|"([^"]*)"|'([^']*)'|([^\s;]+))([^;]*);/gi);
    const imported = await Promise.all(imports.map(async match => {
      const url = match.slice(1, 7).find(value => value !== undefined) || '';
      if (/^(?:data:|blob:)/i.test(url)) return null;
      try { return await fetchResourceBlob(tab, new URL(url, base).href, 'stylesheet', signal, depth + 1); }
      catch { return ''; }
    }));
    ensureSize(imports, imported.map((url, i) => url === null ? imports[i][0].length : url ? 16 + url.length + imports[i][7].length : 0));
    const importReplacements = imported.map((url, i) => url === null ? imports[i][0] : url ? `@import url("${url}")${imports[i][7]};` : '');
    for (let i = imports.length - 1; i >= 0; i--) {
      const match = imports[i];
      css = css.slice(0, match.index) + importReplacements[i] + css.slice(match.index + match[0].length);
    }
    const urls = matches(/url\(\s*(?:["']([^"']*)["']|([^)]*?))\s*\)/gi);
    const rewritten = await Promise.all(urls.map(async match => {
      const raw = (match[1] || match[2] || '').trim();
      if (!raw || /^(?:data:|blob:|#|about:)/i.test(raw)) return null;
      try {
        const url = new URL(raw, base).href;
        const font = css.lastIndexOf('@font-face', match.index) > css.lastIndexOf('}', match.index);
        return await fetchResourceBlob(tab, url, font ? 'font' : 'image', signal, depth + 1);
      } catch { return ''; }
    }));
    ensureSize(urls, rewritten.map((url, i) => url === null ? urls[i][0].length : url ? url.length + 7 : 16));
    const urlReplacements = rewritten.map((url, i) => url === null ? urls[i][0] : url ? `url("${url}")` : 'url(about:blank)');
    for (let i = urls.length - 1; i >= 0; i--) {
      const match = urls[i];
      css = css.slice(0, match.index) + urlReplacements[i] + css.slice(match.index + match[0].length);
    }
    return css;
  }
async function fetchResourceBlob(tab, rawUrl, resourceType, signal, depth = 0, transferSource = false, skipShared = false, skipLocationRewrite = false) {
    if (depth > 3) throw Error('Stylesheet import depth exceeded.');
    const target = safeUrl(rawUrl, tab.url);
    const blocked = resourceBlockReason(tab, target, resourceType);
    if (blocked) { recordBlockedResource(tab, target, resourceType, blocked); throw Error(`Blocked ${resourceType} request.`); }
    const resourceNonce = tab.nonce;
    const started = performance.now(), startedAt = Date.now();
    const headers = { accept: resourceType === 'stylesheet' ? 'text/css,*/*;q=0.1' : '*/*' };
    const sameOrigin = new URL(target).origin === new URL(tab.url).origin;
    if (sameOrigin) {
      const cookie = cookieString(cookieJar, target, { pageUrl: tab.url, method: 'GET' });
      if (cookie) headers.cookie = cookie;
    }
    const cacheContext = resourceType === 'stylesheet' ? `depth:${depth}` : resourceType === 'script' && skipLocationRewrite ? 'skip-location-rewrite' : '';
    const cacheKey = browserResourceCacheKey(target, resourceType, headers.accept, headers.cookie || '', cacheContext);
    if (!skipShared && !transferSource && !prefs.disableCache && cacheKey) {
      const cached = tab.resourceCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now() && tab.blobs.has(cached.url)) {
        tab.resourceCache.delete(cacheKey); tab.resourceCache.set(cacheKey, cached);
        tab.network.push({ startedAt, method: 'GET', status: cached.status, url: target, duration: 0, bytes: 0, cacheHit: true, cacheSource: 'panel', requestHeaders: Object.entries(headers), responseHeaders: cached.headers });
        trim(tab.network); if (tab === active) renderDevtools();
        return cached.url;
      }
      if (cached) tab.resourceCache.delete(cacheKey);
      const pending = tab.resourceLoads.get(cacheKey);
      if (pending) {
        const joined = pending.waiters > 0;
        const blobUrl = await waitForSharedResource(pending, signal);
        if (joined) {
          tab.network.push({ startedAt, method: 'GET', status: pending.status || 200, url: target, duration: 0, bytes: 0, cacheHit: true, cacheSource: 'in-flight', requestHeaders: Object.entries(headers), responseHeaders: pending.headers || [] });
          trim(tab.network); if (tab === active) renderDevtools();
        }
        return blobUrl;
      }
      if (signal?.aborted) throw signal.reason || new DOMException('Resource load was cancelled.', 'AbortError');
      const controller = new AbortController();
      controllers.add(controller); tab.controllers.add(controller);
      const entry = { controller, waiters: 0, settled: false, promise: null, status: 0, headers: [] };
      tab.resourceLoads.set(cacheKey, entry);
      entry.promise = fetchResourceBlob(tab, target, resourceType, controller.signal, depth, false, true, skipLocationRewrite).finally(() => {
        entry.settled = true; controllers.delete(controller); tab.controllers.delete(controller);
        if (tab.resourceLoads.get(cacheKey) === entry) tab.resourceLoads.delete(cacheKey);
      });
      return waitForSharedResource(entry, signal);
    }
    const releaseBuffer = await resourceBudget.acquire(signal, { priority: ['script', 'stylesheet', 'font'].includes(resourceType) });
    let releaseBlobMemory = null;
    try {
    if (signal?.aborted || tab.nonce !== resourceNonce) throw signal?.reason || new DOMException('Resource load was cancelled.', 'AbortError');
    const response = await browserRequest(target, { method: 'GET', headers, signal, stream: true });
    if (skipShared) {
      const pending = tab.resourceLoads.get(cacheKey);
      if (pending) { pending.status = response.status; pending.headers = normalizeHeaders(response.headers); }
    }
    const type = header(response.headers, 'content-type') || (resourceType === 'stylesheet' ? 'text/css' : resourceType === 'script' ? 'text/javascript' : 'application/octet-stream');
    if (!response.status || response.status < 200 || response.status >= 300) {
      response.body?.cancel?.().catch?.(() => {});
      tab.network.push({ startedAt, method: 'GET', status: response.status, url: response.url || target, duration: Math.round(performance.now() - started), bytes: 0, requestHeaders: Object.entries(headers), responseHeaders: normalizeHeaders(response.headers) }); trim(tab.network);
      throw Error(`Resource returned ${response.status}.`);
    }
    if (sameOrigin) applySetCookies(cookieJar, response.cookies, response.url || target);
    syncCookies();
    let blob;
    if (resourceType === 'stylesheet') {
      const result = await readBlob(response, 8 * 1024 * 1024, type);
      let rawBlob = result.blob;
      releaseBuffer();
      let sourceText;
      try { sourceText = await rawBlob.text(); rawBlob = null; }
      finally { result.release(); }
      rememberSource(tab, response.url || target, 'Stylesheet', sourceText);
      const releaseCssWork = resourceBudget.retain(16 * 1024 * 1024);
      try {
        const css = await rewriteProxyCss(tab, sourceText, response.url || target, signal, depth);
        blob = new Blob([css], { type: 'text/css' });
      } finally { releaseCssWork(); }
    } else {
      const result = await readBlob(response, transferSource ? MAX_WORKER_SCRIPT_BYTES : 64 * 1024 * 1024, type);
      blob = result.blob;
      if (transferSource) {
        try { return { source: await blob.text(), url: response.url || target }; }
        finally { result.release(); }
      }
      if (resourceType === 'script' && blob.size <= MAX_NAVIGATION_REWRITE_BYTES) {
        const sourceText = await blob.text();
        if (sourceText.length <= MAX_DEVTOOLS_SOURCE_BYTES) rememberSource(tab, response.url || target, 'Script', sourceText);
        const rewritten = skipLocationRewrite ? sourceText : rewriteLocationNavigations(sourceText);
        if (rewritten !== sourceText) {
          result.release();
          blob = new Blob([rewritten], { type });
          releaseBlobMemory = resourceBudget.retain(blob.size);
        } else releaseBlobMemory = result.release;
      } else {
        releaseBlobMemory = result.release;
        if (resourceType === 'script' && blob.size <= MAX_DEVTOOLS_SOURCE_BYTES) rememberSource(tab, response.url || target, 'Script', await blob.text());
      }
    }
    if (signal?.aborted || tab.nonce !== resourceNonce) throw signal?.reason || new DOMException('Resource load was cancelled.', 'AbortError');
    const releaseBytes = releaseBlobMemory || resourceBudget.retain(blob.size);
    let blobUrl, releaseEncoded;
    try {
      // Opaque file-based clients cannot share parent-created blob URLs with
      // opaque sandbox frames. Account for the UTF-16 data URL before encoding.
      releaseEncoded = resourceBudget.retain(Math.ceil(blob.size / 3) * 8 + type.length * 2 + 128);
      blobUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || Error('Could not encode resource.'));
        reader.readAsDataURL(blob);
      });
      if (signal?.aborted || tab.nonce !== resourceNonce) throw signal?.reason || new DOMException('Resource load was cancelled.', 'AbortError');
    } catch (error) { releaseEncoded?.(); releaseBytes(); releaseBlobMemory = null; throw error; }
    releaseBytes();
    if (tab.blobs.has(blobUrl)) releaseEncoded();
    else tab.blobs.set(blobUrl, releaseEncoded);
    releaseBlobMemory = null;
    const responseUrl = response.url || target;
    let sameFinalUrl = false;
    try {
      const finalUrl = new URL(responseUrl), requestUrl = new URL(target);
      finalUrl.hash = ''; requestUrl.hash = '';
      sameFinalUrl = finalUrl.href === requestUrl.href;
    } catch { /* Do not cache malformed final URLs. */ }
    const cacheLifetime = response.status === 200 && sameFinalUrl && !response.cookies?.length
      ? browserResourceCacheLifetime(response.headers) : 0;
    if (!transferSource && !prefs.disableCache && cacheKey && cacheLifetime > 0) {
      const cachedHeaders = normalizeHeaders(response.headers);
      tab.resourceCache.set(cacheKey, { url: blobUrl, status: response.status, headers: cachedHeaders, expiresAt: Date.now() + cacheLifetime });
      while (tab.resourceCache.size > MAX_RESOURCE_CACHE_ENTRIES) tab.resourceCache.delete(tab.resourceCache.keys().next().value);
    }
      tab.network.push({ startedAt, method: 'GET', status: response.status, url: response.url || target, duration: Math.round(performance.now() - started), bytes: blob.size, cacheHit: response.cacheHit === true, requestHeaders: Object.entries(headers), responseHeaders: normalizeHeaders(response.headers) });
    trim(tab.network); if (tab === active) renderDevtools();
    return blobUrl;
    } finally { releaseBlobMemory?.(); releaseBuffer?.(); }
  }
  async function fetchWorkerScriptGraph(tab, rawUrl, signal) {
    const pageOrigin = new URL(tab.url).origin;
    const sources = new Map(), requested = new Map(), records = new Map(), scheduled = new Set();
    let sourceBytes = 0;
    const mainUrl = safeUrl(rawUrl, tab.url);
    let pending = [{ url: mainUrl, depth: 0 }];
    scheduled.add(mainUrl);
    while (pending.length) {
      const batch = pending;
      pending = [];
      const fetchedBatch = await Promise.all(batch.map(async entry => {
        const fetched = await fetchResourceBlob(tab, entry.url, 'script', signal, 0, true);
        const finalUrl = safeUrl(fetched.url || entry.url, entry.url);
        if (new URL(finalUrl).origin !== pageOrigin) throw Error('Worker redirects must stay on the page origin.');
        return { ...entry, fetched, finalUrl };
      }));
      for (const entry of fetchedBatch) {
        requested.set(entry.url, entry.finalUrl); requested.set(entry.finalUrl, entry.finalUrl);
        if (sources.has(entry.finalUrl)) continue;
        sourceBytes += new TextEncoder().encode(entry.fetched.source).byteLength;
        if (sourceBytes > MAX_WORKER_GRAPH_BYTES) throw Error('Worker import graph exceeds the 4 MiB source limit.');
        const parsed = parseClassicWorkerImports(entry.fetched.source, entry.finalUrl);
        if (parsed.error) throw Error(parsed.error);
        records.set(entry.finalUrl, { source: entry.fetched.source, calls: parsed.calls });
        sources.set(entry.finalUrl, entry.fetched.source);
        for (const call of parsed.calls) {
          for (const url of call.urls) {
            if (requested.has(url) || scheduled.has(url)) continue;
            if (entry.depth >= MAX_WORKER_IMPORT_DEPTH) throw Error('Worker import depth exceeded.');
            if (scheduled.size >= MAX_WORKER_GRAPH_SCRIPTS) throw Error('Worker import graph exceeds the script limit.');
            scheduled.add(url); pending.push({ url, depth: entry.depth + 1 });
          }
        }
      }
    }
    for (const [url, record] of records) {
      const replacements = record.calls.map(call => ({
        from: call.from,
        to: call.to,
        text: `(${call.urls.map(value => JSON.stringify(requested.get(value) || value)).join(',')})`,
      }));
      let source = record.source;
      for (const replacement of replacements.sort((a, b) => b.from - a.from)) {
        source = source.slice(0, replacement.from) + replacement.text + source.slice(replacement.to);
      }
      sources.set(url, source);
    }
    const url = requested.get(mainUrl) || mainUrl;
    return { source: sources.get(url), url, sources: Object.fromEntries(sources) };
  }
  async function fetchWorkerModuleGraph(tab, rawUrl, signal) {
    const pageOrigin = new URL(tab.url).origin;
    const sources = new Map(), requested = new Map(), records = new Map(), scheduled = new Set();
    let sourceBytes = 0;
    const mainUrl = safeUrl(rawUrl, tab.url);
    let pending = [{ url: mainUrl, depth: 0 }];
    scheduled.add(mainUrl);
    while (pending.length) {
      const batch = pending;
      pending = [];
      const fetchedBatch = await Promise.all(batch.map(async entry => {
        const fetched = await fetchResourceBlob(tab, entry.url, 'script', signal, 0, true);
        const finalUrl = safeUrl(fetched.url || entry.url, entry.url);
        if (new URL(finalUrl).origin !== pageOrigin) throw Error('Worker module redirects must stay on the page origin.');
        return { ...entry, fetched, finalUrl };
      }));
      for (const entry of fetchedBatch) {
        requested.set(entry.url, entry.finalUrl); requested.set(entry.finalUrl, entry.finalUrl);
        if (records.has(entry.finalUrl)) continue;
        sourceBytes += new TextEncoder().encode(entry.fetched.source).byteLength;
        if (sourceBytes > MAX_WORKER_GRAPH_BYTES) throw Error('Worker module graph exceeds the 4 MiB source limit.');
        const parsed = parseModuleWorkerImports(entry.fetched.source, entry.finalUrl);
        if (parsed.error) throw Error(parsed.error);
        records.set(entry.finalUrl, { source: entry.fetched.source, imports: parsed.imports });
        sources.set(entry.finalUrl, entry.fetched.source);
        for (const dependency of parsed.imports) {
          if (requested.has(dependency.url) || scheduled.has(dependency.url)) continue;
          if (entry.depth >= MAX_WORKER_IMPORT_DEPTH) throw Error('Worker module import depth exceeded.');
          if (scheduled.size >= MAX_WORKER_GRAPH_SCRIPTS) throw Error('Worker module graph exceeds the script limit.');
          scheduled.add(dependency.url); pending.push({ url: dependency.url, depth: entry.depth + 1 });
        }
      }
    }
    for (const record of records.values()) {
      for (const dependency of record.imports) dependency.url = requested.get(dependency.url) || dependency.url;
    }
    const url = requested.get(mainUrl) || mainUrl;
    const moduleMap = Object.fromEntries(records);
    const order = orderWorkerModuleGraph(moduleMap, url);
    return { source: sources.get(url), url, modules: moduleMap, order };
  }
  function handleFrameMessage(tab, message, framePort, frameNonce) {
    if (tab.port !== framePort || tab.nonce !== frameNonce || !tabs.includes(tab)) return;
    if (!message || typeof message !== 'object') return;
    const type = message.type;
    if (['console', 'network', 'dom', 'storage', 'cookie', 'navigate', 'navigation-unhandled', 'history', 'history-go', 'open-tab', 'download', 'userscript-storage'].includes(type)) {
      let size;
      try { size = new TextEncoder().encode(JSON.stringify(message)).byteLength; } catch { return; }
      const now = Date.now();
      if (!tab.frameMessageBudget || now - tab.frameMessageBudget.at >= 1000) tab.frameMessageBudget = { at: now, counts: Object.create(null) };
      if ((tab.frameMessageBudget.counts[type] = (tab.frameMessageBudget.counts[type] || 0) + 1) > FRAME_MESSAGE_LIMITS[type] || size > (type === 'dom' ? 256 * 1024 : type === 'storage' ? 2 * 1024 * 1024 : type === 'userscript-storage' ? 128 * 1024 : 32 * 1024)) return;
    }
    if (type === 'find-open') { openFind(); return; }
    if (type === 'find-result') {
      if (message.id !== tab.findRequestId || typeof message.found !== 'boolean') return;
      tab.findStatus = message.found ? 'Match found.' : 'No more matches.';
      if (tab === active) findStatus.textContent = tab.findStatus;
      return;
    }
    if (type === 'userscript-storage') { storeUserscriptValue(tab, message); return; }
    if (type === 'history-go') {
      if (Number.isInteger(message.delta) && Math.abs(message.delta) <= 50) navigateHistory(message.delta, tab);
      return;
    }
    if (type === 'history') {
      if (!['push', 'replace', 'traverse'].includes(message.action) || typeof message.url !== 'string' || message.url.length > 8192 || !Number.isInteger(message.index) || message.index < 0 || message.index > 49) return;
      let url;
      try { url = safeUrl(message.url, tab.url); if (new URL(url).origin !== new URL(tab.url).origin) return; } catch { return; }
      if (message.action === 'push') {
        tab.history = tab.history.slice(0, tab.historyIndex + 1);
        tab.historyDocuments = tab.historyDocuments.slice(0, tab.historyIndex + 1);
        tab.historyFrameIndices = tab.historyFrameIndices.slice(0, tab.historyIndex + 1);
        tab.history.push(url); tab.historyDocuments.push(tab.nonce); tab.historyFrameIndices.push(message.index);
        if (tab.history.length > 50) { tab.history.shift(); tab.historyDocuments.shift(); tab.historyFrameIndices.shift(); }
        tab.historyIndex = tab.history.length - 1;
        storedHistory = [{ url, title: tab.title, at: Date.now() }, ...storedHistory.filter(item => item.url !== url)].slice(0, MAX_HISTORY);
        
        if (!library.hidden) renderLibrary();
      } else if (message.action === 'replace') {
        if (tab.historyIndex < 0) { tab.history.push(url); tab.historyDocuments.push(tab.nonce); tab.historyFrameIndices.push(message.index); tab.historyIndex = 0; }
        else { tab.history[tab.historyIndex] = url; tab.historyDocuments[tab.historyIndex] = tab.nonce; tab.historyFrameIndices[tab.historyIndex] = message.index; }
      } else {
        const index = tab.historyDocuments.findIndex((documentId, position) => documentId === tab.nonce && tab.historyFrameIndices[position] === message.index);
        if (index < 0) return;
        tab.historyIndex = index;
      }
      tab.url = url;
      if (tab === active) updateNav(); else renderTabs();
      return;
    }
    if (type === 'navigation-unhandled' && typeof message.url === 'string' && message.url.length <= 8192) {
      try { tab.url = safeUrl(message.url, tab.url); } catch { /* Preserve the last valid address while shutting down the frame. */ }
      tabReset(tab);
      showError(new Error('This browser could not cancel a page navigation. The frame was stopped; use Full browser to continue this page.'), tab);
      return;
    }
    if (type === 'cookie' && typeof message.value === 'string' && message.value.length <= 4096) {
      applyCookie(cookieJar, message.value, tab.url); syncCookies(); return;
    }
    if (type === 'console' && Array.isArray(message.args)) {
      tab.console.push({ level: ['log', 'info', 'warn', 'error', 'debug'].includes(message.level) ? message.level : 'log', args: message.args.slice(0, 50).map(value => typeof value === 'string' ? value.slice(0, 4096) : String(value).slice(0, 4096)), time: Date.now() });
      trim(tab.console); if (tab === active) renderDevtools(); return;
    }
    if (type === 'network' && message.row && typeof message.row === 'object' && !Array.isArray(message.row)) {
      tab.network.push({ ...message.row, startedAt: Number.isFinite(message.row.startedAt) ? message.row.startedAt : Date.now() - Math.max(0, Number(message.row.duration) || 0) });
      trim(tab.network); if (tab === active) renderDevtools(); return;
    }
    if (type === 'dom' && Array.isArray(message.tree)) { tab.dom = message.tree; if (tab === active) renderDevtools(); return; }
    if (type === 'storage' && ['local', 'session'].includes(message.area)) {
      let origin; try { origin = new URL(tab.url).origin; } catch { return; }
      if (message.action === 'snapshot' && Array.isArray(message.items)) {
        // Snapshots are informational; parent state remains authoritative across tabs.
        const rows = sanitizeStorageItems(message.items);
        if (message.area === 'local' && !siteStorage[origin] && rows.length) return;
        if (message.area === 'session' && !tab.sessionStorageByOrigin[origin] && rows.length) return;
        tab.storage = [
          ...Object.entries(siteStorage[origin] || {}).map(([key, value]) => ({ area: 'localStorage', key, value })),
          ...Object.entries(tab.sessionStorageByOrigin[origin] || {}).map(([key, value]) => ({ area: 'sessionStorage', key, value })),
        ];
        if (tab === active) renderDevtools(); return;
      }
      let area, areaBytes;
      {
        area = message.area === 'local' ? (siteStorage[origin] || Object.create(null)) : (tab.sessionStorageByOrigin[origin] || Object.create(null));
        areaBytes = message.area === 'local' ? (siteStorageByteCounts[origin] || 0) : (tab.sessionStorageByteCounts[origin] || 0);
        if (message.action === 'set' && typeof message.key === 'string' && typeof message.value === 'string' && message.key.length <= 4096 && message.value.length <= MAX_STORAGE_AREA_BYTES) {
          const keyBytes = new TextEncoder().encode(message.key).byteLength, valueBytes = new TextEncoder().encode(message.value).byteLength;
          const old = Object.hasOwn(area, message.key) ? area[message.key] : null;
          const nextBytes = areaBytes - (old === null ? 0 : keyBytes + new TextEncoder().encode(old).byteLength) + keyBytes + valueBytes;
          if (nextBytes > MAX_STORAGE_AREA_BYTES || (!Object.hasOwn(area, message.key) && Object.keys(area).length >= MAX_STORAGE_ITEMS)) return;
          area[message.key] = message.value; areaBytes = nextBytes;
        } else if (message.action === 'remove' && typeof message.key === 'string') {
          if (Object.hasOwn(area, message.key)) { areaBytes -= new TextEncoder().encode(message.key).byteLength + new TextEncoder().encode(area[message.key]).byteLength; delete area[message.key]; }
        } else if (message.action === 'clear') { area = Object.create(null); areaBytes = 0; }
        else return;
      }
      if (areaBytes > MAX_STORAGE_AREA_BYTES) return;
      if (message.area === 'local') {
        const oldBytes = siteStorageByteCounts[origin] || 0;
        const total = siteStorageBytes - oldBytes + areaBytes;
        if (total > MAX_STORAGE_TOTAL_BYTES || (areaBytes > 0 && !Object.hasOwn(siteStorage, origin) && Object.keys(siteStorage).length >= 256)) return;
        if (areaBytes) { siteStorage[origin] = area; siteStorageByteCounts[origin] = areaBytes; }
        else { delete siteStorage[origin]; delete siteStorageByteCounts[origin]; }
        siteStorageBytes = total;
        persistSiteStorageSoon();
        for (const other of tabs) {
          if (other === tab || !other.port || !other.url) continue;
          try { if (new URL(other.url).origin === origin) other.port.postMessage({ type: 'storage-sync', area: 'local', action: message.action, key: message.key, value: message.value, url: tab.url }); }
          catch { /* Ignore tabs that have already navigated away. */ }
        }
      } else {
        const oldBytes = tab.sessionStorageByteCounts[origin] || 0;
        const total = tab.sessionStorageBytes - oldBytes + areaBytes;
        if (total > MAX_TAB_SESSION_STORAGE_BYTES || (areaBytes > 0 && !Object.hasOwn(tab.sessionStorageByOrigin, origin) && Object.keys(tab.sessionStorageByOrigin).length >= 64)) return;
        if (areaBytes) { tab.sessionStorageByOrigin[origin] = area; tab.sessionStorageByteCounts[origin] = areaBytes; }
        else { delete tab.sessionStorageByOrigin[origin]; delete tab.sessionStorageByteCounts[origin]; }
        tab.sessionStorageBytes = total;
      }
      tab.storage = [
        ...Object.entries(siteStorage[origin] || {}).map(([key, value]) => ({ area: 'localStorage', key, value })),
        ...Object.entries(tab.sessionStorageByOrigin[origin] || {}).map(([key, value]) => ({ area: 'sessionStorage', key, value })),
      ];
      if (tab === active) renderDevtools(); return;
    }
    if ((type === 'navigate' || type === 'open-tab') && typeof message.url === 'string' && message.url.length <= 8192) {
      const method = ['GET', 'POST'].includes(String(message.method || 'GET').toUpperCase()) ? String(message.method || 'GET').toUpperCase() : 'GET';
      const headers = Object.fromEntries(Array.isArray(message.headers) ? message.headers.filter(row => Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && typeof row[1] === 'string' && row[0].toLowerCase() === 'content-type').slice(0, 1) : []);
      const body = message.body instanceof Uint8Array ? message.body : message.body instanceof ArrayBuffer ? new Uint8Array(message.body) : undefined;
      if (body && body.byteLength > 4 * 1024 * 1024) return;
      const target = type === 'open-tab' ? createTab() : tab;
      const record = !['replace', 'reload'].includes(message.history);
      if (target) navigate(message.url, record, target, { method, headers, body });
      return;
    }
    if (type === 'download' && typeof message.url === 'string' && message.url.length <= 8192) {
      startDownload(tab, message.url, typeof message.filename === 'string' ? message.filename.slice(0, 512) : ''); return;
    }
    if (message.type === 'performance-data' && message.id === tab.performanceRequestId) {
      tab.performance = Array.isArray(message.entries) ? message.entries.slice(-500).map(sanitizePerformanceEntry).filter(Boolean) : [];
      tab.performanceMemory = sanitizePerformanceMemory(message.memory); tab.performanceCapturedAt = Date.now(); renderDevtools();
      return;
    }
    if (message.type === 'performance-entries' && Array.isArray(message.entries) && tab.performanceRecording) {
      for (const entry of message.entries.slice(-500)) { const clean = sanitizePerformanceEntry(entry); if (clean) tab.performance.push(clean); }
      if (tab.performance.length > 500) tab.performance.splice(0, tab.performance.length - 500);
      renderDevtools();
      return;
    }
    if (message.type === 'cancel' && Number.isSafeInteger(message.id)) {
      const relay = tab.requestControllers.get(message.id);
      relay?.controller.abort(); relay?.reader?.cancel().catch(() => {});
      return;
    }
    if (message.type === 'ws-open' && Number.isSafeInteger(message.id) && typeof message.url === 'string') {
      if (typeof openWebSocket !== 'function' || tab.webSockets.has(message.id)) {
        framePort.postMessage({ type: 'ws-open-result', id: message.id, ok: false, error: 'Page WebSockets are unavailable.' }); return;
      }
      let target;
      try {
        target = new URL(message.url, tab.url);
        if (target.protocol === 'http:') target.protocol = 'ws:';
        else if (target.protocol === 'https:') target.protocol = 'wss:';
        if (!['ws:', 'wss:'].includes(target.protocol) || target.username || target.password) throw Error('Only credential-free WebSocket URLs are supported.');
      } catch (error) { framePort.postMessage({ type: 'ws-open-result', id: message.id, ok: false, error: error.message }); return; }
      const reason = resourceBlockReason(tab, target, 'websocket');
      if (reason) {
        recordBlockedResource(tab, target, 'websocket', reason);
        framePort.postMessage({ type: 'ws-open-result', id: message.id, ok: false, error: 'WebSocket blocked by privacy settings.' }); return;
      }
      const started = performance.now(), startedAt = Date.now();
      const protocols = Array.isArray(message.protocols) ? message.protocols.slice(0, 16) : [];
      const networkRow = { startedAt, method: 'WEBSOCKET', status: 'CONNECTING', websocketState: 'CONNECTING', url: target.href, duration: 0, bytes: 0,
        requestHeaders: [['origin', new URL(tab.url).origin], ...(protocols.length ? [['sec-websocket-protocol', protocols.join(', ')]] : [])], responseHeaders: [] };
      tab.network.push(networkRow); trim(tab.network); if (tab === active) renderDevtools();
      const cookies = cookieString(cookieJar, target, { pageUrl: tab.url });
      const opening = { socket: null, closeRequested: false, closeCode: 1001, closeReason: 'Page navigated' }; tab.webSocketOpenings.set(message.id, opening);
      openWebSocket(target.href, {
        protocols,
        origin: new URL(tab.url).origin,
        cookie: cookies,
        onMessage: event => {
          if (tab.port !== framePort || tab.nonce !== frameNonce || !tabs.includes(tab)) return;
          networkRow.bytes += event.data.byteLength;
          const body = event.data.slice();
          framePort.postMessage({ type: 'ws-message', id: message.id, kind: event.kind, body: body.buffer }, [body.buffer]);
        },
        onClose: event => {
          if (tab.port !== framePort || tab.nonce !== frameNonce || !tabs.includes(tab)) return;
          framePort.postMessage({ type: 'ws-close', id: message.id, code: event.code, reason: event.reason, wasClean: event.wasClean });
          tab.webSockets.delete(message.id);
          tab.webSocketOpenings.delete(message.id);
          networkRow.websocketState = 'CLOSED'; networkRow.closeCode = event.code; networkRow.closeReason = event.reason;
          networkRow.duration = Math.round(performance.now() - started);
          trim(tab.network); if (tab === active) renderDevtools();
        },
      }).then(socket => {
        if (tab.port !== framePort || tab.nonce !== frameNonce || !tabs.includes(tab)) { socket.close(1001, 'Page navigated'); return; }
        opening.socket = socket;
        if (opening.closeRequested) { socket.close(opening.closeCode, opening.closeReason); tab.webSocketOpenings.delete(message.id); return; }
        tab.webSocketOpenings.delete(message.id);
        tab.webSockets.set(message.id, socket);
        networkRow.status = 101; networkRow.websocketState = 'OPEN'; networkRow.protocol = socket.protocol;
        networkRow.duration = Math.round(performance.now() - started);
        networkRow.responseHeaders = socket.protocol ? [['sec-websocket-protocol', socket.protocol]] : [];
        if (socket.cookies?.length) { applySetCookies(cookieJar, [{ url: target.href, values: socket.cookies }], target.href); syncCookies(); }
        framePort.postMessage({ type: 'ws-open-result', id: message.id, ok: true, protocol: socket.protocol });
        if (tab === active) renderDevtools();
      }).catch(error => {
        tab.webSocketOpenings.delete(message.id);
        networkRow.status = 'ERR'; networkRow.websocketState = 'FAILED'; networkRow.error = String(error.message || error);
        networkRow.duration = Math.round(performance.now() - started);
        if (tab === active) renderDevtools();
        if (tab.port === framePort && tab.nonce === frameNonce) framePort.postMessage({ type: 'ws-open-result', id: message.id, ok: false, error: String(error.message || error) });
      });
      return;
    }
    if (message.type === 'ws-send' && Number.isSafeInteger(message.id)) {
      const socket = tab.webSockets.get(message.id);
      if (!socket || !(message.body instanceof ArrayBuffer)) return;
      try {
        socket.send(new Uint8Array(message.body), message.kind === 1 ? 1 : 2);
        const row = [...tab.network].reverse().find(item => item.method === 'WEBSOCKET' && item.websocketState === 'OPEN' && item.url === socket.url);
        if (row) row.bytes += message.body.byteLength;
      }
      catch (error) { framePort.postMessage({ type: 'ws-error', id: message.id, error: String(error.message || error) }); }
      return;
    }
    if (message.type === 'ws-close' && Number.isSafeInteger(message.id)) {
      const socket = tab.webSockets.get(message.id);
      if (socket) { socket.close(message.code, message.reason); tab.webSockets.delete(message.id); }
      const opening = tab.webSocketOpenings.get(message.id);
      if (opening) { opening.closeRequested = true; opening.closeCode = message.code; opening.closeReason = message.reason; }
      return;
    }
    if (message.type === 'ws-credit' && Number.isSafeInteger(message.id)) {
      // The transport serializes WebSocket message events, so one credit means
      // the page has accepted one complete bounded upstream message.
      tab.webSockets.get(message.id)?.credit?.();
      return;
    }
    if (message.type === 'credit' && Number.isSafeInteger(message.id)) {
      const relay = tab.requestControllers.get(message.id);
      if (!relay?.reader || relay.reading || relay.finished) return;
      relay.reading = true;
      relay.reader.read().then(({ done, value }) => {
        if (tab.port !== framePort || tab.nonce !== frameNonce || relay.finished) return;
        if (done) {
          framePort.postMessage({ type: 'response-end', id: message.id }); relay.finish(); return;
        }
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        relay.bytes += chunk.byteLength;
        if (relay.networkRow) {
          relay.networkRow.bytes = relay.bytes;
          relay.networkRow.duration = Math.round(performance.now() - relay.started);
          queueNetworkRender(tab);
        }
        if (relay.bytes > relay.maxBytes) throw Error(relay.userscriptId ? 'GM_xmlhttpRequest response exceeds the 2 MiB limit.' : 'Response exceeds the 64 MiB server stream limit.');
        if (captureNetworkBodies && relay.captureStarted && relay.captureText && !relay.captureDisabled) {
          const state = { chunks: relay.captureChunks, bytes: relay.captureBytes, truncated: relay.captureTruncated };
          networkCaptureBytes = appendNetworkCaptureChunk(state, chunk, networkCaptureBytes);
          relay.captureBytes = state.bytes; relay.captureTruncated = state.truncated;
        }
        const copy = chunk.slice();
        framePort.postMessage({ type: 'chunk', id: message.id, body: copy.buffer }, [copy.buffer]);
      }).catch(error => {
        relay.error = String(error?.message || error).slice(0, 1024);
        if (tab.port === framePort && tab.nonce === frameNonce) framePort.postMessage({ type: 'response-error', id: message.id, error: error.message });
        controller.abort(error);
        relay.reader?.cancel().catch(() => {});
        relay.finish();
      }).finally(() => { relay.reading = false; });
      return;
    }
    if (message.type === 'resource' && Number.isSafeInteger(message.id) && typeof message.url === 'string') {
      if (tab.requestControllers.has(message.id)) { framePort.postMessage({ type: 'resource-error', id: message.id, error: 'Duplicate resource request id.' }); return; }
      let target;
      try { target = safeUrl(message.url, tab.url); } catch (error) { framePort.postMessage({ type: 'resource-error', id: message.id, error: error.message }); return; }
      const resourceType = FILTER_TYPES.has(message.resourceType) ? message.resourceType : 'other';
      if (message.transferSource === true && resourceType !== 'script') { framePort.postMessage({ type: 'resource-error', id: message.id, error: 'Only worker script resources may transfer source text.' }); return; }
      const controller = new AbortController(); controllers.add(controller); tab.controllers.add(controller);
      const relay = { controller, finished: false, finish() { if (this.finished) return; this.finished = true; controllers.delete(controller); tab.controllers.delete(controller); if (tab.requestControllers.get(message.id) === this) tab.requestControllers.delete(message.id); } };
      tab.requestControllers.set(message.id, relay);
      (message.transferSource === true
        ? (message.moduleMode === true ? fetchWorkerModuleGraph(tab, target, controller.signal) : fetchWorkerScriptGraph(tab, target, controller.signal))
        : fetchResourceBlob(tab, target, resourceType, controller.signal, 0, false, false, message.skipLocationRewrite === true)).then(result => {
        if (message.pageModule === true) {
          const graphBytes = Object.values(result.modules || {}).reduce((sum, record) => sum + new TextEncoder().encode(record.source || '').byteLength, 0);
          if (tab.pageModuleGraphs >= MAX_PAGE_MODULE_GRAPHS || tab.pageModuleBytes + graphBytes > MAX_PAGE_MODULE_GRAPH_BYTES) throw Error('Page module graphs exceeded the 16-graph or 8 MiB document limit.');
          tab.pageModuleGraphs++; tab.pageModuleBytes += graphBytes;
        }
        if (tab.port === framePort && tab.nonce === frameNonce && tabs.includes(tab)) {
          if (message.transferSource === true) framePort.postMessage({ type: 'resource-source', id: message.id, ...result });
          else framePort.postMessage({ type: 'resource-url', id: message.id, url: result });
        }
      }).catch(error => {
        if (tab.port === framePort && tab.nonce === frameNonce && tabs.includes(tab)) framePort.postMessage({ type: 'resource-error', id: message.id, error: String(error.message || error) });
      }).finally(() => relay.finish());
      return;
    }
    if (message.type === 'request' && Number.isSafeInteger(message.id) && typeof message.url === 'string') {
      const started = performance.now(), startedAt = Date.now(); const method = String(message.method || 'GET').toUpperCase();
      const headerRows = Array.isArray(message.headers) ? message.headers : [];
      const headerBytes = headerRows.reduce((total, row) => total + (Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && typeof row[1] === 'string' ? row[0].length + row[1].length : 16 * 1024 + 1), 0);
      if (message.url.length > 8192 || headerRows.length > 24 || headerBytes > 16 * 1024) { framePort.postMessage({ type: 'response', id: message.id, error: 'Request URL or headers exceed the browser proxy limits.' }); return; }
      const headers = Object.fromEntries(headerRows.filter(row => Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && typeof row[1] === 'string' && !['cookie', 'origin', 'host', 'content-length', 'accept-encoding'].includes(row[0].toLowerCase()) && !row[0].toLowerCase().startsWith('sec-') && !row[0].toLowerCase().startsWith('proxy-')));
      const body = message.body instanceof Uint8Array ? message.body : new Uint8Array(message.body || []);
      if (body.byteLength > 4 * 1024 * 1024) { framePort.postMessage({ type: 'response', id: message.id, error: 'Request body exceeds the 4 MiB WebSocket upload limit.' }); return; }
      let target;
      try { target = safeUrl(message.url, tab.url); } catch (error) { framePort.postMessage({ type: 'response', id: message.id, error: error.message }); return; }
      if (prefs.stripTracking) target = stripTracking(target);
      const userscriptId = typeof message.userscriptId === 'string' ? message.userscriptId : '';
      const userScript = userscriptId ? userscripts.find(script => script.id === userscriptId && script.enabled && userScriptMatches(script, tab.url)) : null;
      if (userscriptId && (!userScript || !userScript.grants.includes('GM_xmlhttpRequest') || !userScriptConnectMatches(userScript, target, tab.url))) {
        framePort.postMessage({ type: 'response', id: message.id, error: 'The userscript request is not authorized for this host.' }); return;
      }
      if (userscriptId && !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) {
        framePort.postMessage({ type: 'response', id: message.id, error: 'Unsupported GM_xmlhttpRequest method.' }); return;
      }
      const reportBlocked = reason => {
        framePort.postMessage({ type: 'response', id: message.id, status: 204, headers: [], body: null });
        tab.network.push({ startedAt, method, status: 204, url: target, duration: 0, bytes: 0, blocked: reason, requestHeaders: Object.entries(headers), responseHeaders: [] });
        trim(tab.network); if (tab === active) renderDevtools();
        blockedCount.textContent = `${Number.parseInt(blockedCount.textContent, 10) + 1} blocked`;
      };
      if (prefs.blockThirdParty) {
        if (schemefulSite(target) !== schemefulSite(tab.url)) {
          reportBlocked('third-party'); return;
        }
      }
      const resourceType = userscriptId ? 'xmlhttprequest' : FILTER_TYPES.has(message.resourceType) ? message.resourceType : 'other';
      const filterDecision = prefs.blockTrackers ? matchFilterList(filters, target, tab.url, resourceType) : null;
      if (prefs.blockTrackers && (filterDecision === true || (filterDecision === null && looksLikeTracker(target)))) {
        reportBlocked(filterDecision === true ? 'filter-list' : 'built-in'); return;
      }
      if (userscriptId) {
        const count = userscriptRequestCounts.get(userscriptId) || 0;
        if (count >= MAX_USERSCRIPT_REQUESTS_PER_SCRIPT || activeUserscriptRequests >= MAX_USERSCRIPT_REQUESTS_PER_PANEL) {
          framePort.postMessage({ type: 'response', id: message.id, error: 'The userscript request concurrency limit was reached.' }); return;
        }
        userscriptRequestCounts.set(userscriptId, count + 1); activeUserscriptRequests++;
      }
      const credentials = ['omit', 'same-origin', 'include'].includes(message.credentials) ? message.credentials : 'same-origin';
      const mode = ['cors', 'no-cors', 'same-origin'].includes(message.mode) ? message.mode : 'cors';
      const controller = new AbortController(); controllers.add(controller); tab.controllers.add(controller);
      const networkRow = { startedAt, method, status: 'Pending', url: target, resourceType, requestBytes: body.byteLength, duration: 0, bytes: 0, cacheHit: false, requestHeaders: Object.entries(headers), responseHeaders: [] };
      const relay = { controller, reader: null, reading: false, bytes: 0, maxBytes: userscriptId ? MAX_USERSCRIPT_RESPONSE_BYTES : 64 * 1024 * 1024, requestBytes: body.byteLength, finished: false, status: 0, url: target, headers: [], cacheHit: false, requestHeaders: Object.entries(headers), captureChunks: [], captureBytes: 0, captureTruncated: false, captureStarted: false, captureDisabled: false, captureText: false, captureMime: '', userscriptId, networkRow, startedAt: started };
      relay.finish = () => {
        if (relay.finished) return;
        relay.finished = true; controllers.delete(controller); tab.controllers.delete(controller);
        if (relay.userscriptId) {
          const remaining = Math.max(0, (userscriptRequestCounts.get(relay.userscriptId) || 1) - 1);
          if (remaining) userscriptRequestCounts.set(relay.userscriptId, remaining); else userscriptRequestCounts.delete(relay.userscriptId);
          activeUserscriptRequests = Math.max(0, activeUserscriptRequests - 1);
        }
        if (tab.requestControllers.get(message.id) === relay) tab.requestControllers.delete(message.id);
        const row = relay.networkRow;
        if (row) {
          row.status = controller.signal.aborted ? 'Canceled' : (relay.status || 'ERR');
          row.responseStatus = Number.isInteger(relay.status) ? relay.status : 0;
          row.url = relay.url; row.duration = Math.round(performance.now() - started); row.bytes = relay.bytes;
          row.cacheHit = relay.cacheHit; row.requestHeaders = relay.requestHeaders; row.responseHeaders = relay.headers;
          if (relay.error) row.error = relay.error;
          if (tab.network.includes(row) && relay.captureStarted && !relay.captureDisabled) {
            const captured = finishNetworkCapture({ chunks: relay.captureChunks, bytes: relay.captureBytes, truncated: relay.captureTruncated }, relay.captureMime);
            row.responseBodyCaptured = true; row.responseBody = captured.bytes; row.responseBodyText = captured.text;
            row.responseBodyTextLike = captured.textLike; row.responseBodyTruncated = captured.truncated; row.captureBytes = relay.captureBytes;
            relay.captureBytes = 0; relay.captureChunks = [];
          } else releaseRelayCapture(relay);
          if (tab.network.includes(row)) { trim(tab.network); queueNetworkRender(tab); }
        } else releaseRelayCapture(relay);
      };
      tab.requestControllers.set(message.id, relay);
      tab.network.push(networkRow); trim(tab.network); queueNetworkRender(tab);
      const requestPromise = userscriptId
        ? browserRequest(target, { method, headers, body: body.length ? body : undefined, signal: controller.signal, stream: true, followRedirects: false }).then(response => {
          if (!userScriptConnectMatches(userScript, response.url || target, tab.url)) { response.body?.cancel?.().catch?.(() => {}); throw Error('The userscript request redirected to a host outside @connect.'); }
          response.headers = Object.fromEntries(filterUserscriptResponseHeaders(response.headers)); response.cookies = [];
          return response;
        })
        : requestPageResource(tab, target, method, headers, body.length ? body : undefined, controller.signal, credentials, mode);
      requestPromise.then(response => {
        relay.status = response.opaque ? 'opaque' : response.status; relay.url = response.url || target; relay.headers = userscriptId ? filterUserscriptResponseHeaders(response.headers) : normalizeHeaders(response.headers); relay.cacheHit = response.cacheHit === true;
        networkRow.status = response.opaque ? 'opaque' : response.status; networkRow.url = relay.url; networkRow.responseHeaders = relay.headers; networkRow.cacheHit = relay.cacheHit;
        networkRow.duration = Math.round(performance.now() - started); queueNetworkRender(tab);
        relay.captureMime = header(response.headers, 'content-type') || '';
        relay.captureText = /^(?:text\/|application\/(?:json|[^;]+\+json|xml|[^;]+\+xml|javascript|x-javascript|ecmascript|x-www-form-urlencoded)|image\/svg\+xml)/i.test(relay.captureMime.split(';', 1)[0].trim());
        relay.captureStarted = captureNetworkBodies && relay.captureText;
        if (response.opaque) {
          if (tab.port === framePort && tab.nonce === frameNonce) framePort.postMessage({ type: 'response', id: message.id, opaque: true });
          relay.finish(); return;
        }
        if (message.discardBody === true) {
          relay.captureStarted = false;
          response.body?.cancel?.().catch?.(() => {});
          if (tab.port === framePort && tab.nonce === frameNonce) framePort.postMessage({ type: 'response', id: message.id, status: response.status, statusText: '', headers: relay.headers, url: relay.url, body: null });
          relay.finish(); return;
        }
        if (response.body?.getReader) {
          relay.reader = response.body.getReader();
          if (tab.port === framePort && tab.nonce === frameNonce) framePort.postMessage({ type: 'response', id: message.id, status: response.status, statusText: '', headers: relay.headers, url: relay.url, stream: true });
        } else {
          if (tab.port === framePort && tab.nonce === frameNonce) framePort.postMessage({ type: 'response', id: message.id, status: response.status, statusText: '', headers: relay.headers, url: relay.url, body: null });
          relay.finish();
        }
      }).catch(error => {
        relay.error = String(error?.message || error).slice(0, 1024);
        if (tab.port === framePort && tab.nonce === frameNonce) framePort.postMessage({ type: 'response', id: message.id, error: error.message });
        relay.finish();
      });
      return;
    }
    if (message.type === 'evaluate-result') {
      const error = typeof message.error === 'string' ? message.error : null;
      tab.console.push({ level: error ? 'error' : 'result', args: [error || formatConsoleValue(message.value)], time: Date.now() }); trim(tab.console);
      if (tab === active) renderDevtools();
      return;
    }
    if (message.type === 'inspect-node-result') {
      if (message.id !== tab.selectedNodeId) return;
      tab.inspectedNode = { id: message.id, box: message.box, computed: message.computed, error: message.error };
      if (tab === active) renderDevtools();
      return;
    }
    if (message.type === 'edit-node-result') {
      if (message.id !== tab.selectedNodeId) return;
      devEditStatus.textContent = message.ok ? 'Applied in the current page.' : String(message.error || 'Edit was rejected.');
      if (message.ok) { tab.inspectedNode = null; tab.port?.postMessage({ type: 'inspect-node', id: message.id }); }
      return;
    }
    if (message.type === 'console') { tab.console.push({ level: message.level, args: message.args || [], time: Date.now() }); trim(tab.console); if (tab === active) renderDevtools(); }
  }
  function showError(error, tab = active) {
    if (!tab) return;
    tab.loading = false;
    const text = String(error?.message || error);
    tab.iframe.srcdoc = `<!doctype html><meta charset="utf-8"><title>Page unavailable</title><style>body{font:16px system-ui;margin:3em;color:#28343c}main{max-width:650px;margin:auto}code{overflow-wrap:anywhere}</style><main><h1>Page unavailable</h1><p>${escapeHtml(text)}</p><p><code>${escapeHtml(tab.url)}</code></p></main>`;
    tab.console.push({ level: 'error', args: [text], time: Date.now() });
    if (tab === active) { status.dataset.state = 'error'; statusText.textContent = text; updateNav(); }
  }
  function toggleBookmark() {
    if (!active?.url) return;
    const index = bookmarks.findIndex(item => item.url === active.url);
    if (index >= 0) bookmarks.splice(index, 1);
    else bookmarks.unshift({ url: active.url, title: active.title, at: Date.now() });
    bookmarks = bookmarks.slice(0, MAX_BOOKMARKS); writeStore(BOOKMARK_KEY, bookmarks); renderBookmarks(); if (!library.hidden) renderLibrary(); updateNav();
  }
  function showBookmarks() { openLibrary('bookmarks'); }
  function showHistory() { openLibrary('history'); }
  function toggleTools() { devtools.hidden = !devtools.hidden; prefs.devtoolsOpen = !devtools.hidden; savePrefs(); }
  function searchInPage(backwards = false, reset = false) {
    const tab = active, query = findInput.value.trim();
    if (!tab) { findStatus.textContent = 'No active page.'; return; }
    if (Array.from(query).length > 256) { findStatus.textContent = 'Search is limited to 256 characters.'; return; }
    if (!query) { tab.findText = ''; tab.findStatus = 'Enter text to search.'; findStatus.textContent = tab.findStatus; return; }
    if (query !== tab.findText) reset = true;
    tab.findText = query; tab.findStatus = 'Searching…'; findStatus.textContent = tab.findStatus;
    if (remoteMode) {
      if (!remoteTransport?.ready || !tab.remoteReady) { tab.findStatus = 'Remote page is still loading.'; findStatus.textContent = tab.findStatus; return; }
      const id = ++requestSequence; tab.findRequestId = id;
      const expression = `(()=>{const q=${JSON.stringify(query)},s=window.getSelection?.();if(${reset})s?.removeAllRanges();return typeof window.find==='function'&&window.find(q,false,${backwards === true},true,false,true)})()`;
      evaluateRemoteDom(tab, expression).then(found => {
        if (disposed || tab !== active || tab.findRequestId !== id || typeof found !== 'boolean') return;
        tab.findStatus = found ? 'Match found.' : 'No more matches.';
        findStatus.textContent = tab.findStatus;
      }).catch(error => {
        if (disposed || tab !== active || tab.findRequestId !== id) return;
        tab.findStatus = String(error.message || error).slice(0, 240);
        findStatus.textContent = tab.findStatus;
      });
      return;
    }
    if (!tab.port) { tab.findStatus = 'Page is still loading.'; findStatus.textContent = tab.findStatus; return; }
    const id = ++requestSequence; tab.findRequestId = id;
    tab.port.postMessage({ type: 'find-in-page', id, text: query, backwards: backwards === true, reset: reset === true });
  }
  function openFind() {
    findBar.hidden = false;
    findInput.value = active?.findText || '';
    findStatus.textContent = active?.findStatus || '';
    findInput.focus(); findInput.select();
    if (findInput.value) searchInPage(false, true);
  }
  function closeFind() {
    if (findTimer) { clearTimeout(findTimer); findTimer = null; }
    findBar.hidden = true;
    if (remoteMode) remoteTextSurface.focus(); else active?.iframe?.focus();
  }
  function navigateHistoryMenu() { showHistory(); }
  function onPrefChange(event) {
    const input = event.target.closest('[data-pref]'); if (!input) return;
    prefs[input.dataset.pref] = input.checked; savePrefs();
    if (remoteMode && remoteTransport?.ready) remoteTransport.privacy(remotePrivacySettings());
  }
  filterFile.addEventListener('change', async () => {
    const file = filterFile.files?.[0]; if (!file) return;
    try {
      if (file.size > MAX_FILTER_LIST_BYTES) throw Error('Filter lists are limited to 1 MiB.');
      const text = await file.text(); const compiled = compileFilterList(text);
      filterListText = text; filters = compiled; clearFilters.disabled = !text;
      try { localStorage.setItem(FILTER_LIST_KEY, JSON.stringify(text)); filterInfo.textContent = `${compiled.count.toLocaleString()} rules imported and saved.`; }
      catch { filterInfo.textContent = `${compiled.count.toLocaleString()} rules loaded for this panel; browser storage is unavailable.`; }
      if (remoteMode && remoteTransport?.ready) await syncRemoteFilters();
    } catch (error) { filterInfo.textContent = String(error.message || error); }
    finally { filterFile.value = ''; }
  });
  userscriptFile.addEventListener('change', async () => {
    const file = userscriptFile.files?.[0]; if (!file) return;
    try {
      if (file.size > MAX_USERSCRIPT_BYTES) throw Error('Each userscript is limited to 256 KiB.');
      const source = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      const parsed = parseUserScript(source); new Function(parsed.source);
      if (userscripts.some(item => item.source === source)) throw Error('This userscript is already imported.');
      if (userscripts.length >= MAX_USERSCRIPTS) throw Error(`A maximum of ${MAX_USERSCRIPTS} userscripts can be stored.`);
      const size = new TextEncoder().encode(source).byteLength;
      if (userscriptBytes + size > MAX_USERSCRIPTS_TOTAL_BYTES) throw Error('Userscripts are limited to 2 MiB total.');
      const entry = { id: randomToken(), enabled: true, ...parsed };
      userscripts.push(entry); userscriptBytes += size;
      if (!persistUserscripts()) { userscripts.pop(); userscriptBytes -= size; throw Error('Could not save userscripts in this browser profile.'); }
      renderUserscripts(); userscriptInfo.textContent = `Imported “${parsed.name}”. It will run on matching pages loaded from now on.`;
    } catch (error) { userscriptInfo.textContent = String(error.message || error); }
    finally { userscriptFile.value = ''; }
  });
  pageUploadPicker.addEventListener('change', async () => {
    const chooser = pendingRemoteFileChooser, files = Array.from(pageUploadPicker.files || []);
    pageUploadPicker.value = '';
    if (!chooser) return;
    if (!files?.length) { clearRemoteFileChooser(true); remoteStatus('File selection cancelled'); return; }
    uploadPageFiles.disabled = true;
    try {
      if (!remoteTransport?.ready) throw Error('Remote browser is disconnected.');
      await remoteTransport.uploadPageFiles(chooser.tabId, chooser.id, files);
      if (pendingRemoteFileChooser === chooser) clearRemoteFileChooser(false);
      remoteStatus('Selected files assigned to the page');
    } catch (error) {
      if (pendingRemoteFileChooser === chooser) clearRemoteFileChooser(true);
      remoteStatus(String(error.message || error), 'error');
    }
  });
  pageUploadPicker.addEventListener('cancel', () => {
    if (!pendingRemoteFileChooser) return;
    clearRemoteFileChooser(true); remoteStatus('File selection cancelled');
  });
  extensionPicker.addEventListener('change', async () => {
    const files = extensionPicker.files;
    if (!files?.length) return;
    extensionImport.disabled = true;
    extensionStatus.textContent = `Uploading ${files.length} extension files…`;
    try {
      const transport = await ensureRemoteTransport();
      if (!transport || !remoteMode || disposed) throw Error('Full browser is not available.');
      const selectedFiles = Array.from(files);
      const manifestFile = selectedFiles.find(file => String(file.webkitRelativePath || '').split('/').slice(1).join('/') === 'manifest.json');
      if (!manifestFile) throw Error('The selected folder must contain a root manifest.json.');
      if (manifestFile.size > 128 * 1024) throw Error('The extension manifest is limited to 128 KiB.');
      const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await manifestFile.arrayBuffer()));
      const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 128).map(item => item.slice(0, 128)) : [];
      const extension = await transport.installExtension(files);
      extension.permissions = [...new Set([...strings(manifest.permissions), ...strings(manifest.optional_permissions)])];
      extension.hostPermissions = [...new Set([...strings(manifest.host_permissions), ...strings(manifest.optional_host_permissions)])];
      remoteExtensions = [...remoteExtensions.filter(item => item.id !== extension.id), extension];
      extensionStatus.textContent = `Loaded “${extension.name}”. Content scripts and background code can run; declared actions can be triggered on the active page. Background requests may not inherit page privacy filters.`;
      renderDevtools();
    } catch (error) { extensionStatus.textContent = String(error.message || error).slice(0, 512); }
    finally { extensionPicker.value = ''; extensionImport.disabled = !remoteMode; }
  });
  function onKeydown(event) {
    if (event.key === 'Escape' && !library.hidden) { event.preventDefault(); closeLibrary(); }
    else if (event.key === 'Escape' && !findBar.hidden) { event.preventDefault(); closeFind(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); openFind(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); address.focus(); address.select(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 't') { event.preventDefault(); createTab(''); address.focus(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w') { event.preventDefault(); if (active) closeTab(active); }
    else if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); navigateHistory(-1); }
    else if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); navigateHistory(1); }
  }
  function onAddressKey(event) { if (event.key === 'Enter') { event.preventDefault(); navigateAddress(); } }
  function stripTracking(raw) {
    const url = new URL(raw); for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid|dclid|mc_cid|mc_eid|ref_src)$/i.test(key)) url.searchParams.delete(key); return url.href;
  }
  function looksLikeTracker(raw) {
    try { const host = new URL(raw).hostname.toLowerCase(); return /(^|\.)(doubleclick\.net|googlesyndication\.com|google-analytics\.com|googletagmanager\.com|facebook\.net|connect\.facebook\.net|hotjar\.com|segment\.io|mixpanel\.com)$/.test(host); } catch { return false; }
  }
  settings.addEventListener('change', onPrefChange); element.addEventListener('keydown', onKeydown); address.addEventListener('keydown', onAddressKey);
  remoteToggle.disabled = true;
  remoteToggle.title = 'Fast proxy is unavailable until all page navigation can be kept on the WebSocket.';
  remoteToggle.setAttribute('aria-label', remoteToggle.title);
  remoteTextSurface.addEventListener('pointerdown', event => {
    if (!remoteMode) return;
    event.preventDefault(); remoteTextSurface.focus();
    try { remoteTextSurface.setPointerCapture(event.pointerId); } catch { /* Optional capture. */ }
    remoteInput(event);
  });
  remoteTextSurface.addEventListener('pointermove', event => { if (remoteMode) scheduleRemotePointer(event); });
  remoteTextSurface.addEventListener('pointerup', event => { if (remoteMode) { event.preventDefault(); remoteInput(event); } });
  remoteTextSurface.addEventListener('pointercancel', event => { if (remoteMode) remoteInput(event); });
  remoteTextSurface.addEventListener('wheel', event => {
    if (!remoteMode || !remoteTransport?.ready) return;
    event.preventDefault();
    const point = remoteViewportPoint(remoteView.getBoundingClientRect(), remoteViewport, event.clientX, event.clientY);
    if (!point?.inside) return;
    try { remoteTransport.input({ type: 'mouse', action: 'mouseWheel', x: point.x, y: point.y, deltaX: event.deltaX, deltaY: event.deltaY }, active?.id); } catch { /* A stale wheel event is ignored. */ }
  }, { passive: false });
  remoteTextSurface.addEventListener('keydown', event => {
    if (!remoteMode) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && ['f', 'l', 't', 'w'].includes(key)) return;
    if (event.altKey && ['arrowleft', 'arrowright'].includes(key)) return;
    if ((event.ctrlKey || event.metaKey) && key === 'v') return;
    const textKey = !event.ctrlKey && !event.metaKey && !event.altKey && (event.isComposing || event.key === 'Dead' || Array.from(event.key).length === 1);
    if (textKey) { event.stopPropagation(); return; }
    remoteKey(event, 'keyDown'); event.preventDefault(); event.stopPropagation();
  });
  remoteTextSurface.addEventListener('keyup', event => {
    if (!remoteMode) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
    const textKey = !event.ctrlKey && !event.metaKey && !event.altKey && (event.isComposing || event.key === 'Dead' || Array.from(event.key).length === 1);
    if (textKey) { event.stopPropagation(); return; }
    remoteKey(event, 'keyUp'); event.preventDefault(); event.stopPropagation();
  });
  remoteTextSurface.addEventListener('beforeinput', event => {
    if (!remoteMode) return;
    if (remoteComposing || event.isComposing) return;
    if (event.inputType === 'insertText' && !remoteComposing && typeof event.data === 'string') sendRemoteText(event.data);
    event.preventDefault();
  });
  remoteTextSurface.addEventListener('paste', event => {
    if (!remoteMode) return;
    event.preventDefault();
    sendRemoteText(event.clipboardData?.getData('text/plain') || '');
    remoteTextSurface.replaceChildren();
  });
  remoteTextSurface.addEventListener('compositionstart', () => { remoteComposing = true; });
  remoteTextSurface.addEventListener('compositionend', event => {
    remoteComposing = false;
    const text = event.data || remoteTextSurface.textContent || '';
    sendRemoteText(text);
    remoteTextSurface.replaceChildren();
  });
  librarySearch.addEventListener('input', renderLibrary);
  importBookmarkFile.addEventListener('change', importBookmarks);
  library.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const focusable = [...library.querySelectorAll('button:not([hidden]),input:not([hidden])')].filter(node => !node.disabled);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  devSearch.addEventListener('input', () => { if (devTab === 'Sources' && active) active.sourceMatchIndex = 0; renderDevtools(); });
  sourceBreakpointLine.addEventListener('input', renderDevtools);
  devSearch.addEventListener('keydown', event => {
    if (devTab !== 'Sources' || event.key !== 'Enter') return;
    event.preventDefault(); moveSourceMatch(event.shiftKey ? -1 : 1);
  });
  findInput.addEventListener('input', () => {
    if (findTimer) clearTimeout(findTimer);
    if (!findInput.value.trim()) { searchInPage(); return; }
    findTimer = setTimeout(() => { findTimer = null; searchInPage(false); }, 120);
  });
  findInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); searchInPage(event.shiftKey); }
    else if (event.key === 'Escape') { event.preventDefault(); closeFind(); }
  });
  disableCache.addEventListener('change', () => {
    prefs.disableCache = disableCache.checked;
    if (prefs.disableCache) for (const tab of tabs) { tab.resourceCache.clear(); tab.resourceLoads.clear(); }
    savePrefs();
  });
  captureBodies.addEventListener('change', () => {
    captureNetworkBodies = captureBodies.checked;
    if (!captureNetworkBodies) {
      for (const tab of tabs) {
        for (const row of tab.network) releaseCapturedNetworkRow(row);
        for (const relay of tab.requestControllers.values()) releaseRelayCapture(relay);
      }
    }
    renderDevtools();
  });
  textEditForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!active || active.selectedNodeId == null) return;
    if (new TextEncoder().encode(textEdit.value).byteLength > 4096) { devEditStatus.textContent = 'Text edit exceeds 4 KiB UTF-8.'; return; }
    if (remoteMode) { editRemoteNode(active, active.selectedNodeId, 'text', '', textEdit.value); return; }
    if (!active.port) return;
    devEditStatus.textContent = 'Applying text edit…';
    active.port.postMessage({ type: 'edit-node', id: active.selectedNodeId, kind: 'text', value: textEdit.value });
  });
  styleEditForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!active || active.selectedNodeId == null) return;
    if (remoteMode) { editRemoteNode(active, active.selectedNodeId, 'style', styleProperty.value, styleValue.value); return; }
    if (!active.port) return;
    devEditStatus.textContent = 'Applying style edit…';
    active.port.postMessage({ type: 'edit-node', id: active.selectedNodeId, kind: 'style', property: styleProperty.value, value: styleValue.value });
  });
  attributeEditForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!active || active.selectedNodeId == null) return;
    if (new TextEncoder().encode(attributeName.value).byteLength > 64 || new TextEncoder().encode(attributeValue.value).byteLength > 512) { devEditStatus.textContent = 'Attribute name or value exceeds its byte limit.'; return; }
    if (remoteMode) { editRemoteNode(active, active.selectedNodeId, 'attribute', attributeName.value, attributeValue.value); return; }
    if (!active.port) return;
    devEditStatus.textContent = 'Applying attribute edit…';
    active.port.postMessage({ type: 'edit-node', id: active.selectedNodeId, kind: 'attribute', property: attributeName.value, value: attributeValue.value });
  });
  consoleInput.addEventListener('keydown', event => {
    if ((event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || consoleInput.value.includes('\n')) return;
    const atBoundary = event.key === 'ArrowUp' ? consoleInput.selectionStart === 0 && consoleInput.selectionEnd === 0 : consoleInput.selectionStart === consoleInput.value.length && consoleInput.selectionEnd === consoleInput.value.length;
    if (!atBoundary) return;
    event.preventDefault();
    consoleInput.value = consoleCommandHistory.move(event.key === 'ArrowUp' ? -1 : 1, consoleInput.value);
    consoleInput.setSelectionRange(consoleInput.value.length, consoleInput.value.length);
  });
  devConsole.addEventListener('submit', event => {
    event.preventDefault();
    const code = consoleInput.value.trim(); if (!code || !active) return;
    if (code.length > 16 * 1024) { active.console.push({ level: 'error', args: ['Console input is limited to 16 KiB.'], time: Date.now() }); trim(active.console); renderDevtools(); return; }
    const tab = active; const id = ++requestSequence;
    consoleCommandHistory.add(code);
    tab.console.push({ level: 'command', args: [code], time: Date.now() }); trim(tab.console);
    if (tab.port) tab.port.postMessage({ type: 'evaluate', id, code });
    else if (remoteMode && remoteTransport?.ready) remoteTransport.evaluate(tab.id, code, remoteDebuggerPaused?.callFrameId || '').then(result => {
      if (!tabs.includes(tab)) return;
      const exception = result.exception || result.result?.exceptionDetails;
      const remoteValue = result.result?.result || result.result;
      const value = exception ? String(exception.text || exception.exception?.description || 'Evaluation failed') : formatConsoleValue(remoteValue?.value ?? remoteValue?.description ?? remoteValue?.type ?? remoteValue);
      tab.console.push({ level: exception ? 'error' : 'result', args: [value], time: Date.now(), remoteObject: exception ? null : result.remoteObject || null }); trim(tab.console);
      if (tab === active) renderDevtools();
    }).catch(error => {
      if (!tabs.includes(tab)) return;
      tab.console.push({ level: 'error', args: [String(error.message || error).slice(0, 512)], time: Date.now() }); trim(tab.console);
      if (tab === active) renderDevtools();
    });
    else tab.console.push({ level: 'error', args: ['The page runtime is not connected.'], time: Date.now() });
    consoleInput.value = ''; renderDevtools(); consoleInput.focus();
  });
  renderBookmarks();
  if (prefs.blockTrackers) settings.querySelector('[data-pref=blockTrackers]').checked = true;
  if (prefs.blockThirdParty) settings.querySelector('[data-pref=blockThirdParty]').checked = true;
  if (prefs.stripTracking) settings.querySelector('[data-pref=stripTracking]').checked = true;
  renderUserscripts();
  createTab('');
  if (serverRenderedByDefault && typeof openRemoteBrowser === 'function') toggleRemoteMode();

  function cleanup() {
    if (disposed) return; disposed = true; remoteGeneration++; window.removeEventListener('message', onMessage); settings.removeEventListener('change', onPrefChange);
    localViewerRequest++; localViewer?.dispose(); localViewer?.element.remove(); localViewer = null;
    localDialog.close?.(); localDialog.removeAttribute('open');
    clearRemoteDialogs();
    if (findTimer) { clearTimeout(findTimer); findTimer = null; }
    if (siteStoragePersistTimer) { clearTimeout(siteStoragePersistTimer); siteStoragePersistTimer = null; }
    const finalStorage = sanitizeSiteStorage(siteStorage);
    siteStorageWriteChain = siteStorageWriteChain.then(async () => {
      if (siteStorageDb) await writeBrowserStorageDb(siteStorageDb, SITE_STORAGE_KEY, finalStorage);
      else writeStore(SITE_STORAGE_KEY, finalStorage);
    }).catch(() => writeStore(SITE_STORAGE_KEY, finalStorage)).finally(() => siteStorageDb?.close());
    element.removeEventListener('keydown', onKeydown); address.removeEventListener('keydown', onAddressKey);
    for (const controller of controllers) controller.abort(); controllers.clear();
    remoteTransport?.close(); remoteTransport = null;
    if (remoteObjectUrl) URL.revokeObjectURL(remoteObjectUrl);
    if (remotePointerFrame) cancelAnimationFrame(remotePointerFrame);
    clearDownloads();
    for (const tab of tabs) { tabReset(tab); for (const row of tab.network) releaseCapturedNetworkRow(row); tab.iframe?.remove(); }
    tabs.length = 0;
  }
  return {
    id: 'browser', title: 'Browser', kind: 'web-browser', element,
    onClose: cleanup,
    onLayout() { for (const tab of tabs) if (tab.iframe?.contentWindow) tab.iframe.contentWindow.dispatchEvent(new Event('resize')); sendRemoteResize(); },
    api: { navigate, back: () => navigateHistory(-1), forward: () => navigateHistory(1), reload: () => navigate(active?.url, false),
      newTab: createTab, closeTab, get url() { return active?.url || ''; }, get tabs() { return tabs.map(tab => ({ id: tab.id, url: tab.url, title: tab.title })); },
      showHistory, showBookmarks, toggleDevtools: toggleTools, focus: () => address.focus(), dispose: cleanup },
  };
}

function header(headers, name) {
  if (headers instanceof Headers) return headers.get(name) || '';
  if (Array.isArray(headers)) return headers.find(row => String(row[0]).toLowerCase() === name)?.[1] || '';
  if (headers && typeof headers === 'object') return headers[name] || headers[Object.keys(headers).find(key => key.toLowerCase() === name)] || '';
  return '';
}
function normalizeHeaders(headers) {
  if (headers instanceof Headers) return [...headers.entries()];
  if (Array.isArray(headers)) return headers;
  if (headers && typeof headers === 'object') return Object.entries(headers);
  return [];
}
function formatConsoleValue(value) {
  if (typeof value === 'string') return value;
  try { const text = JSON.stringify(value); return text === undefined ? String(value) : text; }
  catch { return String(value); }
}
function titleFromHtml(html) { return html.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]?.replace(/<[^>]+>/g, '').trim().slice(0, 180) || ''; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
