// Workspace metadata retains destinations only. It never contains cookies,
// form data, request bodies, script state, or local/server-file identities.
export const MAX_PROXY_TABS = 24;
// Workspace tab.config has an 8192-byte bound; leave room for its envelope.
const MAX_URL_LENGTH = 4096, MAX_STATE_BYTES = 7000;
const encoder = new TextEncoder();

export function proxyRestoreUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= MAX_URL_LENGTH ? url.href : '';
  } catch { return ''; }
}

export function sanitizeProxyState(value, initialUrl = '') {
  const fallback = { v: 1, tabs: [{ url: proxyRestoreUrl(initialUrl) }], active: 0, zoom: 1 };
  if (!value || typeof value !== 'object' || value.v !== 1 || !Array.isArray(value.tabs) || !value.tabs.length) return fallback;
  // Bound bytes as well as tab/URL counts. Replace over-budget destinations with
  // blank tabs so active-tab indexing cannot accidentally select another page.
  let budget = MAX_STATE_BYTES - 1024;
  const tabs = value.tabs.slice(0, MAX_PROXY_TABS).map(tab => {
    const url = proxyRestoreUrl(tab?.url), bytes = encoder.encode(JSON.stringify(url)).length + 16;
    if (bytes > budget) return { url: '' };
    budget -= bytes;
    return { url };
  });
  const active = Number.isInteger(value.active) && value.active >= 0 && value.active < tabs.length ? value.active : 0;
  const zoom = typeof value.zoom === 'number' && Number.isFinite(value.zoom) ? Math.min(2, Math.max(0.5, Math.round(value.zoom * 10) / 10)) : 1;
  return { v: 1, tabs, active, zoom };
}
