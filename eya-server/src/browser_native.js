// Runs in the remote page. Native device access always requires a client prompt.
(() => {
  if (globalThis.__eyaNativeInstalled) return;
  globalThis.__eyaNativeInstalled = true;
  const binding = globalThis.__eyaNativeRequest;
  const encoder = new TextEncoder();
  let sequence = 0, pending = null;
  const policyAllows = feature => !document.featurePolicy?.features().includes(feature) || document.featurePolicy.allowsFeature(feature);
  const fail = (message, name = 'NotAllowedError') => new DOMException(message, name);
  function request(kind, data) {
    if (window !== window.top || !navigator.userActivation.isActive) return Promise.reject(fail('Use a control in the active page to request this action.'));
    const feature = ({ share: 'web-share', 'clipboard-read': 'clipboard-read', 'clipboard-write': 'clipboard-write' })[kind];
    if (feature && !policyAllows(feature)) return Promise.reject(fail('This feature is not allowed by the page policy.'));
    if (pending) return Promise.reject(fail('Another native action is pending.', 'InvalidStateError'));
    const id = ++sequence;
    const payload = JSON.stringify({ id, kind, data });
    if (encoder.encode(payload).length > 16 * 1024) return Promise.reject(fail('Native action exceeds 16 KiB.', 'DataError'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (pending?.id === id) { pending = null; reject(fail('Native action expired.', 'AbortError')); } }, 60000);
      pending = { id, resolve, reject, timer };
      try { binding(payload); } catch (error) { clearTimeout(timer); pending = null; reject(error); }
    });
  }
  globalThis.__eyaNativeResolve = (id, value, error) => {
    if (pending?.id !== id) return;
    const entry = pending; pending = null; clearTimeout(entry.timer);
    if (error) entry.reject(fail('Native action was cancelled or unavailable.', error)); else entry.resolve(value);
  };
  function shareData(input) {
    if (!input || typeof input !== 'object' || (input.files !== undefined && (!Array.isArray(input.files) || input.files.length))) throw new TypeError('Only text and web links can be shared.');
    if (window !== window.top || !policyAllows('web-share')) throw fail('Sharing is not allowed in this document.');
    const result = {};
    for (const key of ['title', 'text', 'url']) if (input[key] !== undefined) result[key] = String(input[key]);
    if (!Object.keys(result).length) throw new TypeError('Provide a title, text, or URL.');
    if (result.url !== undefined) {
      const url = new URL(result.url, location.href);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Only HTTP and HTTPS links can be shared.');
      result.url = url.href;
    }
    if (encoder.encode(JSON.stringify(result)).length > 12 * 1024) throw new TypeError('Shared text exceeds 12 KiB.');
    return result;
  }
  if (isSecureContext) {
    Object.defineProperties(navigator, {
      canShare: { configurable: true, writable: true, value(input) { try { shareData(input); return true; } catch { return false; } } },
      share: { configurable: true, writable: true, async value(input) { const data = shareData(input); await request('share', data); } },
    });
    const clipboard = navigator.clipboard;
    if (clipboard) Object.defineProperties(clipboard, {
      readText: { configurable: true, writable: true, value: () => request('clipboard-read', {}) },
      writeText: { configurable: true, writable: true, async value(text) {
        text = String(text);
        if (encoder.encode(JSON.stringify(text)).length > 12 * 1024) throw fail('Clipboard text exceeds 12 KiB.', 'DataError');
        await request('clipboard-write', { text });
      } },
    });
  }
  window.addEventListener('click', event => {
    const link = event.composedPath().find(node => node instanceof HTMLAnchorElement && node.href);
    if (!link || event.defaultPrevented || event.button !== 0 || !/^(mailto:|tel:)/i.test(link.href)) return;
    event.preventDefault();
    if (link.href.length > 4096 || /[\u0000-\u001f\u007f]/.test(link.href)) return;
    request('external', { url: link.href }).catch(() => {});
  });
})();

// Cursor hints contain only CSS keywords; image cursor URLs never leave the page.
(() => {
  if (globalThis.__eyaCursorInstalled || typeof globalThis.__eyaCursor !== 'function') return;
  globalThis.__eyaCursorInstalled = true;
  const report = globalThis.__eyaCursor;
  let last = '', scheduled = false, point = null;
  function update() {
    scheduled = false;
    if (!point) return;
    const { x, y, target } = point;
    let element = document.elementFromPoint(x, y) || target;
    while (element?.shadowRoot?.elementFromPoint) {
      const inner = element.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === element) break;
      element = inner;
    }
    if (!(element instanceof Element)) return;
    const style = getComputedStyle(element);
    let cursor = style.cursor.split(',').at(-1).trim();
    if (cursor === 'auto') {
      cursor = 'default';
      const range = document.caretRangeFromPoint?.(x, y);
      if (range?.startContainer.nodeType === Node.TEXT_NODE && style.userSelect !== 'none') {
        const offset = range.startOffset, length = range.startContainer.length;
        range.setStart(range.startContainer, Math.max(0, offset - 1));
        range.setEnd(range.startContainer, Math.min(length, offset + 1));
        if ([...range.getClientRects()].some(rect => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)) cursor = style.writingMode.startsWith('vertical') ? 'vertical-text' : 'text';
      }
    }
    if (cursor !== last) { last = cursor; report(cursor); }
  }
  document.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return;
    point = { x: event.clientX, y: event.clientY, target: event.composedPath()[0] };
    if (!scheduled) { scheduled = true; requestAnimationFrame(update); }
  }, true);
  document.addEventListener('pointerout', event => {
    if (!event.relatedTarget) { point = null; last = ''; report('default'); }
  }, true);
})();
