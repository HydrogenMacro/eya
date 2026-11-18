// Serialized into the sandboxed Basic-browser document. Keep this function
// self-contained: the private MessagePort is its only connection to the host.
export function installBrowserAuxiliary(consumed) {
  let modifiers = {};
  function perform(message) {
    if (message.type === 'aux-modifiers') { modifiers = message.modifiers || {}; return; }
    const target = document.activeElement || document.body;
    if (message.type === 'aux-paste') {
      const text = String(message.text || '');
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        if (target.readOnly || target.disabled) return;
        try { target.setRangeText(text, target.selectionStart, target.selectionEnd, 'end'); }
        catch { return; }
        target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
      } else if (target.isContentEditable) document.execCommand('insertText', false, text);
      return;
    }
    const { key, ...flags } = message.key;
    const event = new KeyboardEvent('keydown', { key, ...flags, bubbles: true, cancelable: true });
    if (target.dispatchEvent(event)) {
      if (key === 'Tab') {
        const items = [...document.querySelectorAll('a[href],button,input,textarea,select,[tabindex],[contenteditable=true]')].filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
        const index = items.indexOf(target), step = flags.shiftKey ? -1 : 1;
        items[(index + step + items.length) % items.length]?.focus();
      } else if ((flags.ctrlKey || flags.metaKey) && key.toLowerCase() === 'a' && target.select) target.select();
      else if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.selectionStart !== null) {
        let start = target.selectionStart, end = target.selectionEnd;
        if (key === 'Delete' && !target.readOnly && !target.disabled) {
          if (start === end) end += flags.ctrlKey || flags.altKey ? (target.value.slice(end).match(/^\s*\S+\s*/)?.[0].length || 1) : 1;
          target.setRangeText('', start, Math.min(end, target.value.length), 'end');
          target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentForward' }));
        } else if (['Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(key)) {
          let position = flags.shiftKey && target.selectionDirection === 'backward' ? start : end;
          if (key === 'Home') position = flags.ctrlKey ? 0 : target.value.lastIndexOf('\n', position - 1) + 1;
          else if (key === 'End') { const next = target.value.indexOf('\n', position); position = flags.ctrlKey || next < 0 ? target.value.length : next; }
          else if (key === 'ArrowLeft') position = !flags.shiftKey && start !== end ? start : Math.max(0, position - (flags.ctrlKey || flags.altKey ? (target.value.slice(0, position).match(/\S+\s*$/)?.[0].length || 1) : 1));
          else if (key === 'ArrowRight') position = !flags.shiftKey && start !== end ? end : Math.min(target.value.length, position + (flags.ctrlKey || flags.altKey ? (target.value.slice(position).match(/^\s*\S+\s*/)?.[0].length || 1) : 1));
          else {
            const lines = target.value.split('\n');
            const before = target.value.slice(0, position).split('\n');
            const row = before.length - 1, column = before.at(-1).length;
            const step = key.startsWith('Page') ? Math.max(1, Math.floor(target.clientHeight / (parseFloat(getComputedStyle(target).lineHeight) || 20))) : 1;
            const next = Math.max(0, Math.min(lines.length - 1, row + (key.endsWith('Up') ? -step : step)));
            position = lines.slice(0, next).reduce((sum, line) => sum + line.length + 1, 0) + Math.min(column, lines[next].length);
          }
          if (flags.shiftKey) {
            const anchor = target.selectionDirection === 'backward' ? end : start;
            target.setSelectionRange(Math.min(anchor, position), Math.max(anchor, position), position < anchor ? 'backward' : 'forward');
          } else target.setSelectionRange(position, position);
        }
      } else if (target.isContentEditable) {
        if (key === 'Delete') document.execCommand('forwardDelete');
        else {
          const direction = ['Home', 'ArrowLeft', 'ArrowUp', 'PageUp'].includes(key) ? 'backward' : 'forward';
          const unit = ({ Home: flags.ctrlKey ? 'documentboundary' : 'lineboundary', End: flags.ctrlKey ? 'documentboundary' : 'lineboundary', ArrowLeft: flags.ctrlKey || flags.altKey ? 'word' : 'character', ArrowRight: flags.ctrlKey || flags.altKey ? 'word' : 'character', ArrowUp: 'line', ArrowDown: 'line', PageUp: 'paragraph', PageDown: 'paragraph' })[key];
          if (unit) getSelection()?.modify?.(flags.shiftKey ? 'extend' : 'move', direction, unit);
        }
      }
      else {
        const amount = { ArrowDown: 40, ArrowUp: -40, PageDown: innerHeight * .8, PageUp: -innerHeight * .8 }[key];
        let scroller = target;
        while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
        scroller ||= document.scrollingElement;
        if (amount) scroller?.scrollBy(0, amount);
        if (key === 'Home') scroller?.scrollTo(0, 0);
        if (key === 'End') scroller?.scrollTo(0, scroller.scrollHeight);
      }
    }
    target.dispatchEvent(new KeyboardEvent('keyup', { key, ...flags, bubbles: true }));
  }
  document.addEventListener('keydown', event => {
    if (!event.isTrusted || !Object.values(modifiers).some(Boolean) || ['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
    const flags = modifiers; modifiers = {}; consumed();
    event.preventDefault(); event.stopImmediatePropagation();
    const key = flags.shiftKey && event.key.length === 1 ? event.key.toUpperCase() : event.key;
    perform({ key: { key, code: event.code, ctrlKey: event.ctrlKey || flags.ctrlKey, altKey: event.altKey || flags.altKey, shiftKey: event.shiftKey || flags.shiftKey, metaKey: event.metaKey } });
    if (key.length === 1 && !flags.ctrlKey && !flags.altKey) perform({ type: 'aux-paste', text: key });
  }, true);
  document.addEventListener('beforeinput', event => {
    if (event.isComposing || event.inputType !== 'insertText' || !event.data || !Object.values(modifiers).some(Boolean)) return;
    const flags = modifiers; modifiers = {}; consumed();
    event.preventDefault();
    if (flags.ctrlKey || flags.altKey) for (const key of event.data) perform({ key: { key, ...flags } });
    else perform({ type: 'aux-paste', text: flags.shiftKey ? event.data.toUpperCase() : event.data });
  }, true);
  return perform;
}
