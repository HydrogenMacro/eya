// Mobile browsers do not consistently synthesize dblclick after two taps.
// Track completed taps explicitly, without canceling native scroll gestures.
let tapSequence = 0, lastTouch = -Infinity;
export function bindFileEntryInteractions(row, select, activate) {
  let pointer, previousTap;
  const isAction = target => target.closest('button,input,a,[role=menu],.ui-menu');
  row.style.touchAction = 'manipulation';
  row.addEventListener('click', event => { if (!isAction(event.target) && (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || !window.getSelection()?.toString())) select(event); });
  row.addEventListener('dblclick', event => {
    if (!isAction(event.target) && performance.now() - lastTouch > 800 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) activate();
  });
  row.addEventListener('pointerdown', event => {
    const sequence = ++tapSequence;
    if (event.pointerType === 'mouse') { if (!isAction(event.target) && (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)) { event.preventDefault(); window.getSelection()?.removeAllRanges(); } pointer = previousTap = undefined; lastTouch = -Infinity; return; }
    lastTouch = performance.now();
    if (isAction(event.target)) { pointer = previousTap = undefined; return; }
    if (!event.isPrimary) { pointer = previousTap = undefined; return; }
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now(), sequence };
  });
  row.addEventListener('pointermove', event => {
    if (pointer && pointer.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 12) pointer = previousTap = undefined;
  });
  row.addEventListener('pointerup', event => {
    if (!pointer || event.pointerId !== pointer.id) return;
    const start = pointer; pointer = undefined;
    const now = performance.now(); lastTouch = now;
    if (isAction(event.target) || now - start.time > 600 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) { previousTap = undefined; return; }
    select();
    if (previousTap && start.sequence === previousTap.sequence + 1 && now - previousTap.time < 500 && Math.hypot(event.clientX - previousTap.x, event.clientY - previousTap.y) < 24) {
      previousTap = undefined; activate();
    } else previousTap = { x: event.clientX, y: event.clientY, time: now, sequence: start.sequence };
  });
  row.addEventListener('pointercancel', () => { pointer = previousTap = undefined; });
}
