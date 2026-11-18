import { icon } from './ui.js';

let sequence = 0;

// Native radios provide tab/arrow navigation; labels supply the connected visual surface.
export function createRadioTabs({ label, options, value, onChange = () => {}, compact = false } = {}) {
  const element = document.createElement('div'); element.className = `radio-tabs${compact ? ' radio-tabs-compact' : ''}`;
  element.setAttribute('role', 'radiogroup'); element.setAttribute('aria-label', label || 'Options');
  const name = `radio-tabs-${++sequence}`, controls = new Map();
  for (const option of options || []) {
    const item = document.createElement('label'); item.className = 'radio-tab';
    const input = document.createElement('input'); input.type = 'radio'; input.name = name; input.value = String(option.value);
    input.setAttribute('aria-label', option.title || option.label || String(option.value));
    const face = document.createElement('span'); face.className = 'radio-tab-face';
    if (option.icon) face.append(icon(option.icon));
    if (option.label) face.append(document.createTextNode(option.label));
    if (option.title) item.title = option.title;
    item.append(input, face); element.append(item); controls.set(input.value, input);
    input.onchange = () => { if (input.checked) onChange(option.value); };
  }
  function setValue(next) {
    const selected = String(next); if (!controls.has(selected)) return false;
    for (const [key, input] of controls) input.checked = key === selected;
    return true;
  }
  setValue(value ?? options?.[0]?.value);
  return { element, setValue, get value() { return [...controls.values()].find(input => input.checked)?.value; },
    setDisabled(disabled) { for (const input of controls.values()) input.disabled = !!disabled; } };
}
