import { matchesKeybind } from './keybinds-core.js';
import { createMenu, menuAction, notify } from './ui.js';
let backgroundSequence = 0;

async function imagePNG(image) {
  await image.decode();
  const width = image.naturalWidth, height = image.naturalHeight;
  if (!width || !height || width * height > 32 * 1024 * 1024) throw Error('Image is too large to copy');
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw Error('Could not prepare image for copying');
  context.drawImage(image, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(Error('Could not encode image for copying')), 'image/png'));
}

export function createImageViewer(body, image, { background = {}, onBackgroundChange = () => {}, download = () => { const link = document.createElement('a'); link.href = image.src; link.download = image.alt || 'image'; link.click(); } } = {}) {
  const color = (value, fallback) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  const defaults = { checkerboard: true, color1: '#d8d8d8', color2: '#a8a8a8' };
  let colors = { checkerboard: background?.checkerboard !== false, color1: color(background?.color1, defaults.color1), color2: color(background?.color2, defaults.color2) };
  let mode = ['checkerboard', 'white', 'plain'].includes(background?.mode) ? background.mode : colors.checkerboard ? 'checkerboard' : 'plain';
  const explicitMode = ['checkerboard', 'white', 'plain'].includes(background?.mode);
  const backgroundControl = document.createElement('div'); backgroundControl.className = 'image-background-choices';
  backgroundControl.setAttribute('role', 'radiogroup'); backgroundControl.setAttribute('aria-label', 'Image background');
  const groupName = `image-background-${++backgroundSequence}`;
  const applyBackground = (changed = true) => {
    // Existing workspace colors retain their appearance until a preset is chosen.
    const usePreset = changed || explicitMode;
    body.style.backgroundColor = usePreset ? mode === 'white' ? '#ffffff' : mode === 'plain' ? 'var(--ui-bg, #10171c)' : defaults.color1 : colors.color1;
    body.style.backgroundImage = mode === 'checkerboard' ? `conic-gradient(${colors.color1} 25%, ${colors.color2} 0 50%, ${colors.color1} 0 75%, ${colors.color2} 0)` : 'none';
    body.style.backgroundSize = '24px 24px'; body.dataset.checkerboard = String(mode === 'checkerboard'); body.dataset.imageBackground = mode;
    if (changed) onBackgroundChange({ mode, ...colors });
  };
  for (const [value, label] of [['checkerboard', 'Checkerboard background'], ['white', 'White background'], ['plain', 'Plain background']]) {
    const choice = document.createElement('label'); choice.className = 'image-background-choice'; choice.title = label;
    const input = document.createElement('input'); input.type = 'radio'; input.name = groupName; input.value = value; input.checked = value === mode; input.setAttribute('aria-label', label);
    const preview = document.createElement('span'); preview.className = `image-background-preview image-background-${value}`; preview.setAttribute('aria-hidden', 'true');
    input.onchange = () => {
      if (!input.checked) return;
      mode = value;
      colors = { checkerboard: mode === 'checkerboard', color1: mode === 'white' ? '#ffffff' : mode === 'plain' ? '#10171c' : defaults.color1, color2: defaults.color2 };
      applyBackground();
    };
    choice.append(input, preview); backgroundControl.append(choice);
  }
  applyBackground(false);
  body.classList.add('image-viewer-body');
  body.tabIndex = 0;
  body.setAttribute('aria-label', 'Image viewer: drag or use arrow keys to pan; scroll or use plus and minus to zoom');
  image.draggable = false;
  body.append(image);
  let scale = 1, x = 0, y = 0, drag = null;
  const render = () => { image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; };
  const zoom = (factor, clientX, clientY) => {
    const next = Math.max(0.1, Math.min(20, scale * factor));
    const rect = body.getBoundingClientRect();
    const px = (clientX ?? rect.left + rect.width / 2) - (rect.left + rect.width / 2);
    const py = (clientY ?? rect.top + rect.height / 2) - (rect.top + rect.height / 2);
    const ratio = next / scale;
    x = px - (px - x) * ratio; y = py - (py - y) * ratio; scale = next; render();
  };
  body.addEventListener('wheel', event => {
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? body.clientHeight : 1);
    zoom(Math.exp(-Math.max(-500, Math.min(500, delta)) * 0.002), event.clientX, event.clientY);
  }, { passive: false });
  body.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag || event.target.closest('button,input,.ui-menu')) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    body.setPointerCapture(event.pointerId); body.classList.add('dragging');
  });
  body.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    x += event.clientX - drag.x; y += event.clientY - drag.y;
    drag.x = event.clientX; drag.y = event.clientY; render();
  });
  const endDrag = event => { if (drag?.id === event.pointerId) { drag = null; body.classList.remove('dragging'); } };
  body.addEventListener('pointerup', endDrag);
  body.addEventListener('pointercancel', endDrag);
  body.addEventListener('lostpointercapture', endDrag);
  const reset = () => { scale = 1; x = 0; y = 0; render(); };
  body.addEventListener('keydown', event => {
    if (event.target.closest('button,input,.ui-menu')) return;
    if (matchesKeybind('image.zoomIn', event)) zoom(1.2);
    else if (matchesKeybind('image.zoomOut', event)) zoom(1 / 1.2);
    else if (matchesKeybind('image.reset', event)) reset();
    else if (matchesKeybind('image.left', event)) { x -= 20; render(); }
    else if (matchesKeybind('image.right', event)) { x += 20; render(); }
    else if (matchesKeybind('image.up', event)) { y -= 20; render(); }
    else if (matchesKeybind('image.down', event)) { y += 20; render(); }
    else return;
    event.preventDefault();
  });
  const copyImage = () => {
    if (!navigator.clipboard?.write || typeof ClipboardItem !== 'function') return Promise.reject(Error('Image copying is unavailable in this browser'));
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': imagePNG(image) })]);
  };
  const menu = createMenu('Image actions', { consumeDismiss: true }); menu.trigger.hidden = true; body.append(menu.element);
  for (const [label, glyph, action] of [['Download image', 'Download', download], ['Copy image', 'Copy', copyImage]]) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.onclick = () => { try { Promise.resolve(action()).catch(error => notify(error.message)); } catch (error) { notify(error.message); } }; menuAction(menu.panel, button, glyph);
  }
  const context = event => { event.preventDefault(); menu.open(true); const rect = menu.panel.getBoundingClientRect(); menu.panel.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - rect.width - 8))}px`; menu.panel.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - rect.height - 8))}px`; };
  body.addEventListener('contextmenu', context);
  return {
    zoomIn: () => zoom(1.2), zoomOut: () => zoom(1 / 1.2), reset, backgroundControl,
    copyImage,
    updateSettings(value = {}) {
      if (['checkerboard','white','plain'].includes(value.mode)) mode = value.mode;
      colors = { checkerboard: mode === 'checkerboard', color1: color(value.color1, colors.color1), color2: color(value.color2, colors.color2) };
      for (const input of backgroundControl.querySelectorAll('input')) input.checked = input.value === mode;
      applyBackground(false);
    },
    dispose: () => { body.removeEventListener('contextmenu', context); menu.destroy(); backgroundControl.remove(); },
  };
}
