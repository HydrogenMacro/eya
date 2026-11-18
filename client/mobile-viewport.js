// The keyboard can shrink AND pan the visual viewport without resizing the
// layout viewport. One owner keeps every workspace panel in the visible area.
export function trackWorkspaceViewport(onLayout) {
  const abort = new AbortController(), { signal } = abort;
  let frame, previousHeight, previousTop, previousWidth, reveal = false;

  function revealInput(top, height) {
    const input = document.activeElement;
    if (!input?.matches?.('input,textarea,[contenteditable]:not([contenteditable=false])') ||
        input.closest('.cm-editor,.xterm')) return; // These editors own caret scrolling.
    // Scroll only bounded ancestors, never scrollIntoView(), which can pan the
    // document and make the keyboard compensation feed back into itself.
    for (let parent = input.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (!/(auto|scroll)/.test(getComputedStyle(parent).overflowY) || parent.scrollHeight <= parent.clientHeight) continue;
      const bounds = parent.getBoundingClientRect(), rect = input.getBoundingClientRect();
      const start = Math.max(top + 8, bounds.top + parent.clientTop);
      const end = Math.min(top + height - 8, bounds.top + parent.clientTop + parent.clientHeight);
      if (end <= start) continue;
      const delta = rect.top < start || rect.height > end - start ? rect.top - start : Math.max(0, rect.bottom - end);
      if (delta) parent.scrollTop += delta;
    }
  }

  function update() {
    frame = undefined;
    const viewport = window.visualViewport;
    // Page/accessibility zoom must retain the browser's native panning.
    if (viewport && Math.abs(viewport.scale - 1) > .01) return;
    const height = viewport?.height || window.innerHeight, top = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth;
    const changed = height !== previousHeight || top !== previousTop || width !== previousWidth;
    document.documentElement.style.setProperty('--eya-viewport-height', `${height}px`);
    document.documentElement.style.setProperty('--eya-viewport-top', `${top}px`);
    // Focus auto-scroll may arrive after focusin and after the first resize.
    // Correct only the document; preserve all panel/editor scroll positions.
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    if (changed || reveal) onLayout();
    if (reveal || (previousHeight !== undefined && height < previousHeight)) revealInput(top, height);
    reveal = false; previousHeight = height; previousTop = top; previousWidth = width;
  }
  function schedule() { if (frame === undefined) frame = requestAnimationFrame(update); }
  window.addEventListener('resize', schedule, { signal });
  window.addEventListener('scroll', schedule, { signal, passive: true });
  window.addEventListener('pageshow', schedule, { signal });
  window.visualViewport?.addEventListener('resize', schedule, { signal });
  window.visualViewport?.addEventListener('scroll', schedule, { signal, passive: true });
  document.addEventListener('focusin', () => { reveal = true; schedule(); }, { signal });
  document.addEventListener('focusout', schedule, { signal });
  schedule();
  return { schedule, destroy() { abort.abort(); cancelAnimationFrame(frame); } };
}
