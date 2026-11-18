import { parser, GFM } from '@lezer/markdown';
import { localPath } from './html-viewer.js';

const markdownParser = parser.configure(GFM);
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024, MAX_RENDER_NODES = 50000, MAX_RENDER_DEPTH = 128;
const tags = { Paragraph:'p', Emphasis:'em', StrongEmphasis:'strong', Strikethrough:'del', BulletList:'ul', OrderedList:'ol', ListItem:'li', Blockquote:'blockquote', Table:'table', TableHeader:'tr', TableRow:'tr', TableCell:'td', Task:'span' };
const marks = /^(?:HeaderMark|EmphasisMark|StrikethroughMark|ListMark|QuoteMark|CodeMark|CodeInfo|LinkMark|TableDelimiter|TaskMarker)$/;
export function createMarkdownViewer(tab, { readResource, openFile, openLink = url => window.open(url, '_blank', 'noopener,noreferrer') } = {}) {
  const element = document.createElement('article'); element.className = 'markdown-viewer'; element.tabIndex = 0; element.setAttribute('aria-label', 'Markdown preview');
  const source = new TextDecoder().decode(tab.bytes.subarray(0, MAX_PREVIEW_BYTES)), tree = markdownParser.parse(source), references = new Map(), urls = new Set();
  let disposed = false, resourceCount = 0, resourceBytes = 0, renderedNodes = 0;
  let resourceQueue = Promise.resolve();
  let renderDepth = 0, depthLimited = false;
  const headingIds = new Set();
  const text = node => source.slice(node.from, node.to);
  const decode = value => {
    const textarea = document.createElement('textarea'); textarea.innerHTML = value.replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return textarea.value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1');
  };
  const label = value => value.replace(/^\[|\]$/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
  tree.iterate({ enter(node) {
    if (node.name === 'LinkReference') {
      const key = node.node.getChild('LinkLabel'), url = node.node.getChild('URL');
      if (key && url) references.set(label(text(key)), decode(text(url).replace(/^<|>$/g, '')));
    }
  } });
  function destination(node) {
    const url = node.getChild('URL'); if (url) return decode(text(url).replace(/^<|>$/g, ''));
    const key = node.getChild('LinkLabel');
    const reference = label(key ? text(key) : '') || label(text(node).replace(/^!/, '').match(/^\[[\s\S]*?\]/)?.[0] || '');
    return references.get(reference) || '';
  }
  function external(reference) { try { const url = new URL(reference); return ['http:','https:'].includes(url.protocol) ? url.href : null; } catch { return null; } }
  function link(reference, target) {
    const remote = external(reference), local = localPath(reference, tab.path);
    if (remote) { target.href = remote; target.onclick = event => { event.preventDefault(); openLink(remote); }; }
    else if (reference.startsWith('#')) { target.href = reference; target.onclick = event => { event.preventDefault(); let id; try { id = decodeURIComponent(reference.slice(1)); } catch { return; } [...element.querySelectorAll('[id]')].find(node => node.id === id)?.scrollIntoView({ block:'start' }); }; }
    else if (local) { target.href = '#'; target.onclick = event => { event.preventDefault(); openFile?.(local.path); }; }
    return !!(remote || local || reference.startsWith('#'));
  }
  function image(reference, target) {
    const local = localPath(reference, tab.path);
    if (!local || !readResource || ++resourceCount > 64) { target.title = 'Image unavailable'; return; }
    const ext = local.path.split('.').at(-1).toLowerCase();
    const mime = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',avif:'image/avif',bmp:'image/bmp',ico:'image/x-icon'}[ext];
    if (!mime) { target.title = 'Image unavailable'; return; }
    resourceQueue = resourceQueue.then(async () => {
      if (disposed) return;
      const remaining = 16 * 1024 * 1024 - resourceBytes;
      if (remaining <= 0) throw Error('Image budget exceeded');
      const result = await readResource(local.path, remaining); if (disposed) return;
      if (result.bytes.length > remaining) throw Error('Image budget exceeded');
      resourceBytes += result.bytes.length;
      const url = URL.createObjectURL(new Blob([result.bytes], { type:mime })); urls.add(url); target.src = url;
    }).catch(() => { if (!disposed) target.title = 'Image unavailable'; });
  }
  function children(node, parent, inline = false, from = node.from, to = node.to) {
    let position = from;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (renderedNodes >= MAX_RENDER_NODES) return;
      if (child.to <= from || child.from >= to) continue;
      if (inline && child.from > position) parent.append(document.createTextNode(decode(source.slice(position, child.from))));
      render(child, parent); position = child.to;
    }
    if (inline && position < to) parent.append(document.createTextNode(decode(source.slice(position, to))));
  }
  function render(node, parent) {
    if (renderDepth >= MAX_RENDER_DEPTH) { depthLimited = true; return; }
    renderDepth++;
    try { renderNode(node, parent); } finally { renderDepth--; }
  }
  function renderNode(node, parent) {
    if (++renderedNodes > MAX_RENDER_NODES) return;
    const name = node.name;
    if (marks.test(name) || name === 'LinkReference') return;
    if (name === 'Escape' || name === 'Entity') { parent.append(document.createTextNode(decode(text(node)))); return; }
    if (name === 'HardBreak') { parent.append(document.createElement('br')); return; }
    if (name === 'HorizontalRule') { parent.append(document.createElement('hr')); return; }
    if (name === 'HTMLBlock' || name === 'HTMLTag' || name === 'CommentBlock' || name === 'ProcessingInstructionBlock') { parent.append(document.createTextNode(text(node))); return; }
    if (name === 'FencedCode' || name === 'CodeBlock' || name === 'InlineCode') {
      const code = document.createElement('code');
      const parts = []; for (let child = node.firstChild; child; child = child.nextSibling) if (child.name === 'CodeText') parts.push(text(child));
      code.textContent = parts.length ? parts.join('\n') : name === 'InlineCode' ? text(node).replace(/^`+|`+$/g,'').replace(/\n/g,' ') : '';
      if (name === 'InlineCode') parent.append(code); else { const pre = document.createElement('pre'); pre.append(code); parent.append(pre); } return;
    }
    if (name === 'Link' || name === 'Autolink' || name === 'URL' || name === 'Image') {
      const reference = name === 'Autolink' ? text(node).replace(/^<|>$/g,'') : name === 'URL' ? text(node) : destination(node);
      const title = node.getChild('LinkTitle');
      const value = text(node).match(/^!?\[([\s\S]*?)\]/)?.[1] || reference;
      if (name === 'Image') { const img = document.createElement('img'); img.alt = decode(value); img.loading = 'lazy'; if (title) img.title = decode(text(title).slice(1,-1)); parent.append(img); image(reference, img); return; }
      const anchor = document.createElement('a'); if (title) anchor.title = decode(text(title).slice(1,-1));
      if (name === 'Link') { const end = [...function*(){for(let c=node.firstChild;c;c=c.nextSibling)yield c;}()].find(c => c.name === 'LinkMark' && text(c) === ']'); children(node, anchor, true, node.from+1, end?.from ?? node.to); }
      else anchor.textContent = reference;
      if (link(reference, anchor)) parent.append(anchor); else parent.append(document.createTextNode(decode(value))); return;
    }
    const heading = name.match(/^(?:ATX|Setext)Heading([1-6])$/);
    const tag = heading ? `h${heading[1]}` : tags[name];
    if (!tag) { children(node, parent, name !== 'Document'); return; }
    const element = document.createElement(node.name === 'TableCell' && node.parent?.name === 'TableHeader' ? 'th' : tag);
    if (name === 'OrderedList') { const start = Number(text(node).match(/^\d+/)?.[0]); if (start > 1) element.start = start; }
    const inline = !!heading || ['Paragraph','Emphasis','StrongEmphasis','Strikethrough','TableCell','Task'].includes(name);
    if (name === 'Task') { const check = document.createElement('input'); check.type = 'checkbox'; check.disabled = true; check.checked = /\[[xX]\]/.test(text(node.getChild('TaskMarker'))); element.append(check); }
    children(node, element, inline);
    if (heading) { const id = element.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu,'').replace(/\s+/g,'-'); let unique=id, index=1; while (headingIds.has(unique)) unique=`${id}-${index++}`; headingIds.add(unique); element.id=unique; }
    parent.append(element);
  }
  render(tree.topNode, element);
  if (tab.bytes.length > MAX_PREVIEW_BYTES || renderedNodes >= MAX_RENDER_NODES || depthLimited) {
    const notice = document.createElement('p'); notice.setAttribute('role', 'status'); notice.textContent = 'Preview limit reached. Open as text or download the full file.'; element.append(notice);
  }
  return { element, dispose() { disposed = true; for (const url of urls) URL.revokeObjectURL(url); urls.clear(); } };
}
