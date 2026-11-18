// Native file prompts stay in the trusted client; page code never chooses server paths.
export function createBrowserFilePicker({ host, request, read, submit, cancel }) {
  const dialog = document.createElement('dialog'); dialog.className = 'eya-browser-local-dialog';
  dialog.setAttribute('aria-label', 'Choose files for web page');
  const form = document.createElement('form');
  const title = document.createElement('strong'); title.textContent = 'Choose files for web page';
  const device = document.createElement('input'); device.type = 'file'; device.hidden = true;
  const add = document.createElement('button'); add.type = 'button'; add.textContent = 'Add from device'; add.onclick = () => device.click();
  const path = document.createElement('input'); path.setAttribute('aria-label', 'Server directory'); path.value = '/';
  const browse = document.createElement('button'); browse.type = 'button'; browse.textContent = 'Browse server files'; browse.onclick = () => load(path.value);
  const entries = document.createElement('div'); entries.style.cssText = 'display:grid;gap:4px;max-height:25vh;overflow:auto';
  const selected = document.createElement('div'); selected.style.cssText = 'display:grid;gap:4px;max-height:20vh;overflow:auto';
  const status = document.createElement('div'); status.setAttribute('role', 'status');
  const actions = document.createElement('div'); actions.className = 'eya-browser-local-dialog-actions';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Cancel'; close.onclick = () => dismiss();
  const use = document.createElement('button'); use.type = 'submit'; use.textContent = 'Use selected files';
  actions.append(close, use); form.append(title, add, device, path, browse, entries, selected, status, actions); dialog.append(form); host.append(dialog);
  let chooser = null, files = [], generation = 0, listing = 0, busy = false;
  function valid(token) { return chooser && generation === token; }
  function render() {
    selected.replaceChildren();
    for (const item of files) {
      const remove = document.createElement('button'); remove.type = 'button';
      remove.textContent = `${item.source}: ${item.name} · Remove`; remove.disabled = busy;
      remove.onclick = () => { files = files.filter(other => other !== item); render(); };
      selected.append(remove);
    }
    use.disabled = busy || !files.length; add.disabled = browse.disabled = path.disabled = busy;
  }
  function addFile(item) {
    if (!chooser || busy) return;
    if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > 16 * 1024 * 1024) throw Error('Each file is limited to 16 MiB.');
    const next = chooser.multiple ? [...files, item] : [item];
    if (next.length > 8 || next.reduce((sum, file) => sum + file.size, 0) > 32 * 1024 * 1024) throw Error('Choose at most 8 files and 32 MiB total.');
    files = next; status.textContent = chooser.accept ? `Page accepts: ${chooser.accept}` : ''; render();
  }
  async function load(directory) {
    if (!request || busy) return;
    const token = generation, id = ++listing; status.textContent = 'Loading server files…';
    try {
      const response = await request('list', { path: directory, showHidden: false });
      if (!valid(token) || id !== listing) return;
      entries.replaceChildren(); path.value = response.path || directory;
      const parent = document.createElement('button'); parent.type = 'button'; parent.textContent = '↑ Parent directory';
      parent.onclick = () => load('/' + path.value.split('/').filter(Boolean).slice(0, -1).join('/')); entries.append(parent);
      for (const entry of response.entries || []) {
        if (!['file', 'directory'].includes(entry.kind)) continue;
        const button = document.createElement('button'); button.type = 'button'; button.style.textAlign = 'left';
        button.textContent = entry.kind === 'directory' ? `${entry.name}/` : `${entry.name} (${entry.size.toLocaleString()} bytes)`;
        button.onclick = () => {
          if (busy) return;
          if (entry.kind === 'directory') load(entry.path);
          else try { addFile({ source: 'Server', name: entry.name, path: entry.path, size: entry.size }); } catch (error) { status.textContent = error.message; }
        }; entries.append(button);
      }
      status.textContent = 'Choose server files or add files from your device.';
    } catch (error) { if (valid(token) && id === listing) status.textContent = error.message; }
  }
  device.onchange = () => {
    try { for (const file of device.files || []) addFile({ source: 'Device', name: file.name, size: file.size, file }); }
    catch (error) { status.textContent = error.message; }
    device.value = '';
  };
  function dismiss(notify = true) {
    const previous = chooser; chooser = null; generation++; files = []; busy = false; device.value = '';
    entries.replaceChildren(); selected.replaceChildren(); dialog.close(); if (notify && previous) cancel(previous);
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  form.onsubmit = async event => {
    event.preventDefault(); if (!chooser || busy || !files.length) return;
    const token = generation, current = chooser; busy = true; render();
    try {
      const uploads = [];
      for (const item of files) {
        status.textContent = `Preparing ${item.name}…`;
        if (!valid(token)) return;
        if (item.file) uploads.push(item.file);
        else {
          // Authenticate and validate through the ordinary bounded file API. Stat
          // again before reading, since the entry may have changed since listing.
          const meta = await request('stat', { path: item.path });
          if (!valid(token)) return;
          if (meta.size !== item.size) throw Error('Server file changed. Select it again.');
          const result = await read(item.path);
          if (!valid(token)) return;
          if (result.bytes.byteLength !== item.size || (meta.version && result.meta?.version && meta.version !== result.meta.version)) throw Error('Server file changed. Select it again.');
          uploads.push(new File([result.bytes], item.name));
        }
      }
      if (!valid(token)) return;
      await submit(current, uploads, (sent, total) => { if (valid(token)) status.textContent = `Uploading ${total ? Math.round(sent / total * 100) : 100}%…`; });
      if (valid(token)) dismiss(false);
    } catch (error) { if (valid(token)) { busy = false; status.textContent = error.message; render(); } }
  };
  return {
    open(value) {
      if (chooser !== value) { dismiss(false); chooser = value; files = []; entries.replaceChildren(); }
      device.multiple = value.multiple; device.accept = value.accept || ''; browse.hidden = path.hidden = !request || !read;
      render(); status.textContent = value.accept ? `Page accepts: ${value.accept}` : 'Choose files from your device or server.';
      if (!dialog.open) dialog.showModal();
    },
    close: () => dismiss(false),
    destroy() { dismiss(false); dialog.remove(); },
  };
}

export function createBrowserServerSave({ host, upload, onSaved }) {
  const dialog = document.createElement('dialog'); dialog.className = 'eya-browser-local-dialog'; dialog.setAttribute('aria-label', 'Save download to server');
  const form = document.createElement('form');
  const title = document.createElement('strong'); title.textContent = 'Save download to server';
  const path = document.createElement('input'); path.required = true; path.setAttribute('aria-label', 'Destination server file path');
  const status = document.createElement('div'); status.setAttribute('role', 'status');
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.onclick = () => dialog.close();
  const save = document.createElement('button'); save.textContent = 'Save'; save.type = 'submit';
  const actions = document.createElement('div'); actions.className = 'eya-browser-local-dialog-actions'; actions.append(cancel, save);
  form.append(title, path, status, actions); dialog.append(form); host.append(dialog);
  let item = null, busy = false, disposed = false;
  form.onsubmit = async event => {
    event.preventDefault(); if (busy || !item?.blob) return;
    const current = item, destination = path.value.trim(); busy = true; save.disabled = path.disabled = cancel.disabled = true; status.textContent = 'Saving…';
    try {
      await upload(destination, current.blob, false);
      if (disposed) return;
      onSaved(current, destination); dialog.close();
    } catch (error) { if (!disposed) status.textContent = error.message; }
    finally { busy = false; save.disabled = path.disabled = cancel.disabled = false; }
  };
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  return { open(value) { if (busy) return; item = value; path.value = '/' + value.filename; status.textContent = 'Enter a new file path. Existing files are never overwritten.'; dialog.showModal(); path.focus(); }, destroy() { disposed = true; dialog.close(); dialog.remove(); } };
}
