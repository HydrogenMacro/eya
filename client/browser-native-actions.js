// Capability requests from remote pages are shown in the trusted client UI.
export function createBrowserNativeActions({ host, reply, isCurrent }) {
  const dialog = document.createElement('dialog'); dialog.className = 'eya-browser-local-dialog'; dialog.setAttribute('aria-label', 'Page native action');
  const form = document.createElement('form');
  const title = document.createElement('strong');
  const origin = document.createElement('div'); origin.style.overflowWrap = 'anywhere';
  const preview = document.createElement('pre'); preview.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:30vh;overflow:auto';
  const status = document.createElement('div'); status.setAttribute('role', 'status');
  const actions = document.createElement('div'); actions.className = 'eya-browser-local-dialog-actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
  const fallback = document.createElement('button'); fallback.type = 'button'; fallback.textContent = 'Copy instead';
  const accept = document.createElement('button'); accept.type = 'submit';
  actions.append(cancel, fallback, accept); form.append(title, origin, preview, status, actions); dialog.append(form); host.append(dialog);
  let pending = null, busy = false, timer = null, generation = 0;
  function finish(value = '', error = '', notify = true) {
    const entry = pending; pending = null; generation++; busy = false; clearTimeout(timer); timer = null; dialog.close();
    if (entry && notify) reply(entry, value, error);
  }
  function dismiss() { finish('', 'AbortError'); }
  cancel.onclick = dismiss;
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  function text(data) { return [data.title, data.text, data.url].filter(Boolean).join('\n'); }
  async function run(copy = false) {
    const entry = pending, token = generation;
    if (!entry || busy) return;
    if (!isCurrent(entry)) { dismiss(); return; }
    busy = true; accept.disabled = fallback.disabled = true; status.textContent = '';
    try {
      let result = '';
      if (entry.kind === 'clipboard-read') {
        if (!navigator.clipboard?.readText) throw new DOMException('Clipboard access is unavailable in this client.', 'NotAllowedError');
        result = await navigator.clipboard.readText();
        if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 12 * 1024) throw new DOMException('Clipboard text exceeds 12 KiB.', 'DataError');
      } else if (entry.kind === 'clipboard-write' || copy) {
        if (!navigator.clipboard?.writeText) throw new DOMException('Clipboard access is unavailable in this client.', 'NotAllowedError');
        await navigator.clipboard.writeText(copy ? text(entry.data) : entry.data.text);
      } else if (entry.kind === 'share') {
        if (typeof navigator.share !== 'function') throw new DOMException('Native sharing is unavailable. Choose Copy instead.', 'NotSupportedError');
        await navigator.share(entry.data);
      } else if (entry.kind === 'external') {
        const url = new URL(entry.data.url);
        if (!['mailto:', 'tel:'].includes(url.protocol) || /[\u0000-\u001f\u007f]/.test(url.href)) throw new TypeError('Unsupported app link.');
        // An actual client gesture is required to hand off to the operating system.
        const link = document.createElement('a'); link.href = url.href; link.rel = 'noopener noreferrer'; link.hidden = true; document.body.append(link); link.click(); link.remove();
      }
      if (pending !== entry || token !== generation) return;
      if (!isCurrent(entry)) { dismiss(); return; }
      finish(result);
    } catch (error) {
      if (pending !== entry || token !== generation) return;
      if (error.name === 'AbortError') { dismiss(); return; }
      busy = false; accept.disabled = fallback.disabled = false;
      status.textContent = String(error.message || error).slice(0, 240);
    }
  }
  form.onsubmit = event => { event.preventDefault(); run(); };
  fallback.onclick = () => run(true);
  return {
    open(entry) {
      if (!isCurrent(entry) || !['share', 'clipboard-read', 'clipboard-write', 'external'].includes(entry.kind)) { reply(entry, '', 'NotAllowedError'); return; }
      if (pending) { reply(entry, '', 'InvalidStateError'); return; }
      pending = entry; generation++; busy = false;
      origin.textContent = entry.origin;
      title.textContent = ({ share: 'Share from this page?', 'clipboard-read': 'Let this page read your clipboard?', 'clipboard-write': 'Copy this text to your clipboard?', external: 'Open an app on your device?' })[entry.kind];
      preview.textContent = entry.kind === 'clipboard-read' ? 'Only clipboard text will be sent to this page, once.' : entry.kind === 'clipboard-write' ? entry.data.text : entry.kind === 'external' ? entry.data.url : text(entry.data);
      accept.textContent = ({ share: 'Share', 'clipboard-read': 'Allow once', 'clipboard-write': 'Copy', external: 'Open app' })[entry.kind];
      fallback.hidden = entry.kind !== 'share';
      accept.hidden = entry.kind === 'share' && typeof navigator.share !== 'function';
      accept.disabled = fallback.disabled = false; status.textContent = '';
      dialog.showModal(); timer = setTimeout(dismiss, 55000);
    },
    cancel: dismiss,
    close(id) { if (pending?.id === id) finish('', 'AbortError', false); },
    destroy() { dismiss(); dialog.remove(); },
  };
}
