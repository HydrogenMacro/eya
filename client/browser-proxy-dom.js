// Runs inside the opaque frame. Capture DOM methods before page code and route
// resource assignment/insertion before the native loader sees an upstream URL.
// CSP remains the backstop; these hooks provide compatibility, not confinement.
export function installProxyDomResources({ load, loadModule, getUrl, report, onRoot }) {
  const get = Function.call.bind(Element.prototype.getAttribute);
  const set = Function.call.bind(Element.prototype.setAttribute);
  const remove = Function.call.bind(Element.prototype.removeAttribute);
  const query = Function.call.bind(Element.prototype.querySelectorAll);
  const listen = Function.call.bind(EventTarget.prototype.addEventListener);
  const dispatch = Function.call.bind(EventTarget.prototype.dispatchEvent);
  const state = new WeakMap();
  const nativeFailures = new WeakSet();
  const allowed = value => /^(?:data:|blob:|about:|#)/i.test(value);
  const absolute = value => new URL(value, getUrl()).href;
  const resource = (el, name) => {
    const tag = el.localName;
    if (name === 'src') return tag === 'script' ? 'script' : ['img','image','source'].includes(tag) ? 'image' : ['audio','video','track'].includes(tag) ? 'media' : null;
    if (name === 'poster' && tag === 'video') return 'image';
    if (name === 'href' && tag === 'link') {
      const rel = (get(el, 'rel') || '').toLowerCase().split(/\s+/);
      if (rel.includes('stylesheet')) return 'stylesheet';
      if (rel.includes('icon')) return 'image';
      if (rel.includes('preload')) return get(el, 'as') === 'font' ? 'font' : get(el,'as') === 'script' ? 'script' : 'image';
    }
    return null;
  };
  let serial = Promise.resolve(), count = 0;
  const fail = (el, error) => { report?.(String(error?.message || error)); if(!nativeFailures.has(error)) dispatch(el, new Event('error')); };
  const remember = (el, attr, raw) => {
    let entry = state.get(el);
    if (!entry) { entry = { versions: new Map(), attrs: new Map(), active: new Map() }; state.set(el, entry); }
    entry.attrs.set(attr, raw); entry.versions.set(attr,(entry.versions.get(attr)||0)+1); return entry;
  };
  const activate = el => {
    const entry = state.get(el);
    if (!entry || !el.isConnected) return;
    for (const [attr, raw] of entry.attrs) {
      const version = entry.versions.get(attr), key = raw;
      if (entry.active.get(attr) === key) continue;
      const kind = resource(el, attr); if (!kind) continue;
      entry.active.set(attr,key);
      if (++count > 2048) { fail(el, Error('Page exceeds the 2048 dynamic resource limit.')); continue; }
      const module = kind === 'script' && (get(el,'type') || '').toLowerCase() === 'module';
      const fetched = Promise.resolve().then(() => module ? loadModule(absolute(raw)) : load(absolute(raw), kind, { skipLocationRewrite: !!get(el, 'integrity') }));
      fetched.catch(()=>{});
      const apply = async () => {
        const result = await fetched;
        if (!el.isConnected || entry.versions.get(attr) !== version) { if(module) result.release?.(); return; }
        const url = module ? result.url : result;
        if (module) { listen(el,'error',result.release,{once:true}); }
        if (kind === 'script') {
          // Preserve the upstream identity for currentScript and chunk loaders.
          set(el, 'data-eya-original-src', absolute(raw));
        }
        await new Promise((resolve, reject) => {
          if (kind === 'script') {
            listen(el,'load',resolve,{once:true});
            listen(el,'error',()=>{const error=Error('Proxied script failed to execute.');nativeFailures.add(error);reject(error);},{once:true});
          }
          set(el, attr, url);
          if(kind !== 'script') resolve();
        });
      };
      if (kind === 'script' && el.async === false) { const next = serial.then(apply); serial = next.catch(()=>{}); next.catch(error=>fail(el,error)); }
      else apply().catch(error=>fail(el,error));
    }
  };
  const write = (el, name, value) => {
    name = String(name).toLowerCase(); const raw = String(value);
    if (!resource(el,name) || !raw || allowed(raw)) {
      if(state.has(el)){const entry=state.get(el);entry.attrs.delete(name);entry.active.delete(name);entry.versions.set(name,(entry.versions.get(name)||0)+1);}
      set(el,name,raw); return;
    }
    remember(el,name,raw);
    remove(el,name);
    activate(el);
  };
  const prepare = root => {
    if (!root || ![1,11].includes(root.nodeType)) return;
    const nodes = root.nodeType === 1 ? [root,...query(root,'script,link,img,source,audio,video,track')] : [...root.querySelectorAll('script,link,img,source,audio,video,track')];
    for (const el of nodes) {
      for (const attr of ['src','href','poster']) {
        const inert = get(el,'data-eya-'+attr);
        const raw = get(el,attr) || inert;
        if (!raw || !resource(el,attr)) continue;
        if (inert) remove(el,'data-eya-'+attr);
        if (!allowed(raw)) { remember(el,attr,raw); remove(el,attr); }
        else if (inert && get(el,attr) === null) set(el,attr,raw);
      }
    }
  };
  const activateTree = root => {
    if (!root || ![1,11].includes(root.nodeType)) return;
    if(root.nodeType===1) activate(root);
    for(const el of root.querySelectorAll('script,link,img,source,audio,video,track'))activate(el);
  };
  // Property assignment is the usual Webpack/mdBook loader path.
  for (const [type,attrs] of [[HTMLScriptElement,['src']],[HTMLLinkElement,['href']],[HTMLImageElement,['src']],[HTMLSourceElement,['src']],[HTMLMediaElement,['src']],[HTMLVideoElement,['poster']],[HTMLTrackElement,['src']]]) {
    for(const attr of attrs) {
      const descriptor = Object.getOwnPropertyDescriptor(type.prototype,attr);
      if(!descriptor?.get || !descriptor.set || !descriptor.configurable)continue;
      Object.defineProperty(type.prototype,attr,{...descriptor,get(){
        const original = state.get(this)?.attrs.get(attr) || (attr==='src'&&get(this,'data-eya-original-src'));
        return original ? absolute(original) : descriptor.get.call(this);
      },set(value){write(this,attr,value);}});
    }
  }
  const originalSet = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name,value) { if(resource(this,String(name).toLowerCase()))return write(this,name,value);return originalSet.call(this,name,value); };
  Element.prototype.removeAttribute=function(name){name=String(name).toLowerCase();const entry=state.get(this);if(entry&&resource(this,name)){entry.attrs.delete(name);entry.active.delete(name);entry.versions.set(name,(entry.versions.get(name)||0)+1);}if(name==='src')remove(this,'data-eya-original-src');return remove(this,name);};
  for(const [prototype,names] of [[Node.prototype,['appendChild','insertBefore','replaceChild']],[Element.prototype,['append','prepend','before','after','replaceWith']],[DocumentFragment.prototype,['append','prepend']],[Document.prototype,['append','prepend']]]) {
    for(const name of names) {
      const original=prototype[name]; if(typeof original!=='function')continue;
      prototype[name]=function(...args){const roots=name==='insertBefore'||name==='replaceChild'?[args[0]]:args;for(const root of roots)prepare(root);const descendants=roots.flatMap(root=>root?.nodeType===11?[...root.childNodes]:[root]);const result=original.apply(this,args);for(const root of descendants)activateTree(root);return result;};
    }
  }
  const adjacent=Element.prototype.insertAdjacentElement;
  Element.prototype.insertAdjacentElement=function(position,node){prepare(node);const result=adjacent.call(this,position,node);activateTree(node);return result;};
  const attach=Element.prototype.attachShadow;
  Element.prototype.attachShadow=function(options){const root=attach.call(this,options);observe(root);return root;};
  const observed = new WeakSet();
  const observe = root => {
    if(observed.has(root))return; observed.add(root);
    new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes){prepare(node);activateTree(node);if(node.nodeType===1){if(node.shadowRoot)observe(node.shadowRoot);for(const el of node.querySelectorAll('*'))if(el.shadowRoot)observe(el.shadowRoot);}}}).observe(root,{childList:true,subtree:true});
    if(root.nodeType===11){prepare(root);activateTree(root);queueMicrotask(()=>onRoot?.(root));}
  };
  observe(document);
  return { prepare, activate: activateTree };
}

// Parsing-time external scripts must keep native parser/defer/DOMContentLoaded
// ordering. Fetch them before mounting srcdoc; dynamic resources use the hooks.
export async function prepareProxyStaticResources(html, base, load, parseTag, scanTags) {
  const tags = scanTags(html).filter(tag=>!tag.closing && !tag.templateDepth && ['script','link'].includes(tag.name));
  const replacements=[]; let scripts=0, size=html.length;
  for(const tag of tags) {
    const element=parseTag(html,tag);
    const module=element.localName==='script' && (element.getAttribute('type')||'').toLowerCase()==='module';
    const attr=element.localName==='script'?'src':'href';
    const raw=element.getAttribute('data-eya-'+attr);
    const kind=element.localName==='script'?'script':(element.getAttribute('rel')||'').toLowerCase().split(/\s+/).includes('stylesheet')?'stylesheet':null;
    if(!raw||!kind||module)continue;
    if(kind==='script'&&++scripts>64)throw Error('Document exceeds the 64 initial script limit.');
    try {
      const url=await load(new URL(raw,base).href,kind,{skipLocationRewrite:element.hasAttribute('integrity')});
      element.setAttribute(attr,url); element.removeAttribute('data-eya-'+attr);
      if(kind==='script')element.setAttribute('data-eya-original-src',new URL(raw,base).href);
      const text=element.outerHTML.slice(0,element.outerHTML.indexOf('>')+1);
      size+=text.length-(tag.end-tag.start); if(size>32*1024*1024)throw Error('Prepared document exceeds the 32 MiB character limit.');
      replacements.push({start:tag.start,end:tag.end,text});
    } catch(error) {
      if(error?.name==='AbortError'||/limit/.test(String(error?.message)))throw error;
      // Keep an ordinary error event for a failed upstream asset rather than
      // replaying a page or silently executing a different script.
      element.removeAttribute('data-eya-'+attr);element.setAttribute(attr,'data:application/octet-stream,');
      replacements.push({start:tag.start,end:tag.end,text:element.outerHTML.slice(0,element.outerHTML.indexOf('>')+1)});
    }
  }
  for(const item of replacements.reverse())html=html.slice(0,item.start)+item.text+html.slice(item.end);
  return html;
}
