const FIELDS = [
  ['terminalSessions', 'Terminal sessions'],
  ['workspaceConnections', 'Workspace connections'],
  ['handshakeConnections', 'Handshake / legacy connections'],
  ['basicBrowserConnections', 'Basic browser connections'],
  ['fullBrowserSessions', 'Full browser sessions'],
  ['fullBrowserRuntimes', 'Full browser runtimes'],
  ['machineJobs', 'Machine jobs'],
];

export function createServerSettings({ request, capabilities = () => [] }) {
  const element = document.createElement('div'); element.className = 'server-settings';
  const note = document.createElement('p'); note.className = 'server-settings-note'; note.textContent = 'Applies until the server restarts. Existing sessions stay running.';
  const form = document.createElement('form'); form.setAttribute('aria-label', 'Server limits');
  const fields = new Map();
  for (const [key, title] of FIELDS) {
    const row = document.createElement('label'); row.className = 'server-settings-field';
    const name = document.createElement('span'); name.textContent = title;
    const input = document.createElement('input'); input.type = 'number'; input.step = '1'; input.min = '1'; input.required = true; input.setAttribute('aria-label', title); input.disabled = true;
    const usage = document.createElement('small'); usage.className = 'server-settings-usage';
    row.append(name, input, usage); form.append(row); fields.set(key, { input, usage });
  }
  const status = document.createElement('div'); status.className = 'server-settings-status'; status.setAttribute('role', 'status');
  const actions = document.createElement('div'); actions.className = 'server-settings-actions';
  const refreshButton = document.createElement('button'); refreshButton.type = 'button'; refreshButton.textContent = 'Refresh';
  const applyButton = document.createElement('button'); applyButton.type = 'submit'; applyButton.textContent = 'Apply'; applyButton.disabled = true;
  actions.append(refreshButton, applyButton); form.append(actions); element.append(note, form, status);
  let snapshot, disposed = false, busy = false, generation = 0;
  const supported = () => capabilities().includes('server-config-v1');
  function setBusy(value) {
    busy = value; refreshButton.disabled = value; applyButton.disabled = value || !snapshot || !supported();
    for (const { input } of fields.values()) input.disabled = value || !snapshot || !supported();
  }
  function show(value) {
    if (!value || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.scope !== 'process') throw Error('Unsupported server settings response.');
    for (const [key, { input, usage }] of fields) {
      const limit = value.settings?.[key], range = value.bounds?.[key], active = value.usage?.[key];
      if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(range?.min) || !Number.isSafeInteger(range?.max) || range.min < 1 || range.max < range.min || range.max > 100000 || limit < range.min || limit > range.max || !Number.isSafeInteger(active) || active < 0) throw Error('Invalid server limits.');
      input.min = String(range.min); input.max = String(range.max); input.value = String(limit);
      usage.textContent = `${active} active · max ${range.max}`; input.title = typeof range.env === 'string' ? range.env : '';
    }
    snapshot = value;
  }
  async function refresh() {
    if (disposed || busy) return;
    if (!supported()) { status.textContent = 'This server does not support live settings.'; snapshot = null; setBusy(false); return; }
    const attempt = ++generation; setBusy(true); status.textContent = 'Loading…';
    try { const value = await request('server.config.get', {}); if (!disposed && attempt === generation) { show(value); status.textContent = ''; } }
    catch (error) { if (!disposed && attempt === generation) { snapshot = null; status.textContent = error.message || String(error); } }
    finally { if (!disposed && attempt === generation) setBusy(false); }
  }
  form.onsubmit = async event => {
    event.preventDefault(); if (disposed || busy || !snapshot || !supported() || !form.reportValidity()) return;
    const settings = {};
    for (const [key, { input }] of fields) {
      const value = Number(input.value); if (!Number.isSafeInteger(value)) { input.reportValidity(); return; }
      if (value !== snapshot.settings[key]) settings[key] = value;
    }
    if (!Object.keys(settings).length) { status.textContent = 'No changes.'; return; }
    const attempt = ++generation; setBusy(true); status.textContent = 'Applying…';
    try { const value = await request('server.config.set', { revision:snapshot.revision, settings }); if (!disposed && attempt === generation) { show(value); status.textContent = 'Applied.'; } }
    catch (error) { if (!disposed && attempt === generation) status.textContent = `${error.message || error} Refresh to check the current limits.`; }
    finally { if (!disposed && attempt === generation) setBusy(false); }
  };
  refreshButton.onclick = refresh;
  return { element, refresh, dispose() { disposed = true; generation++; } };
}
