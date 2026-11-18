// DOM-only menus keep settings inside the player, including mobile fullscreen.
// The same controls run in the standalone client and the streaming iframe.
export function createVideoSettings(video, captions, settings, { tracks, helpButton, note, preferences = {}, onSettingsChange = () => {} } = {}) {
  const defaults = {
    size: 'medium', font: 'sans', color: '#ffffff', background: '#000000',
    opacity: '60', outline: 'shadow', position: 'bottom', speed: '1', loop: false,
  };
  const choices = {
    speed: [['0.5', '0.5×'], ['0.75', '0.75×'], ['1', 'Normal'], ['1.25', '1.25×'], ['1.5', '1.5×'], ['2', '2×']],
    size: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['xlarge', 'Extra large']],
    font: [['sans', 'Sans serif'], ['serif', 'Serif'], ['mono', 'Monospace']],
    color: [['#ffffff', 'White'], ['#fff176', 'Yellow'], ['#80deea', 'Cyan'], ['#a5d6a7', 'Green'], ['#000000', 'Black']],
    background: [['#000000', 'Black'], ['#202b38', 'Slate'], ['#ffffff', 'White']],
    opacity: [['0', 'Transparent'], ['30', '30%'], ['60', '60%'], ['80', '80%'], ['100', 'Solid']],
    outline: [['none', 'None'], ['shadow', 'Shadow'], ['outline', 'Outline']],
    position: [['bottom', 'Bottom'], ['top', 'Top']],
  };
  let stored = preferences;

  const state = { ...defaults };
  for (const [key, options] of Object.entries(choices)) {
    const candidate = stored[key];
    if (typeof candidate !== 'string') continue;
    if (options.some(([value]) => value === candidate)) state[key] = candidate;
    else if ((key === 'color' || key === 'background') && /^#[0-9a-f]{6}$/i.test(candidate)) {
      // Keep appearance choices saved by older versions without opening native pickers.
      state[key] = candidate; options.push([candidate, 'Custom']);
    }
  }
  state.loop = typeof stored.loop === 'boolean' ? stored.loop : defaults.loop;
  let current = 'home';
  const parents = { playback: 'home', subtitles: 'home', appearance: 'home' };
  const titles = { home: 'Settings', playback: 'Playback', subtitles: 'Subtitles', appearance: 'Subtitle appearance' };
  const labels = { speed: 'Playback speed', size: 'Subtitle size', font: 'Subtitle font', color: 'Subtitle text color', background: 'Subtitle background color', opacity: 'Subtitle background opacity', outline: 'Subtitle outline', position: 'Subtitle position' };
  for (const key of Object.keys(choices)) { parents[key] = key === 'speed' ? 'playback' : 'appearance'; titles[key] = labels[key]; }
  settings.setAttribute('role', 'menu');

  function save() {
    onSettingsChange({ ...state });
  }
  function applyCaptionStyle() {
    const sizes = { small: 'clamp(14px, 2.2vw, 20px)', medium: 'clamp(18px, 3vw, 30px)', large: 'clamp(22px, 4vw, 40px)', xlarge: 'clamp(26px, 5vw, 52px)' };
    const fonts = { sans: 'system-ui, sans-serif', serif: 'Georgia, serif', mono: 'monospace' };
    const shadows = { none: 'none', shadow: '0 1px 3px #000, 0 2px 5px #000', outline: '-2px -2px 1px #000, 2px -2px 1px #000, -2px 2px 1px #000, 2px 2px 1px #000' };
    captions.style.fontSize = sizes[state.size];
    captions.style.fontFamily = fonts[state.font];
    captions.style.color = state.color;
    captions.style.textShadow = shadows[state.outline];
    captions.style.bottom = state.position === 'bottom' ? 'max(6%, var(--eya-video-caption-clearance, 0px))' : 'auto';
    captions.style.top = state.position === 'top' ? '6%' : 'auto';
    const hex = state.background.slice(1);
    const red = parseInt(hex.slice(0, 2), 16), green = parseInt(hex.slice(2, 4), 16), blue = parseInt(hex.slice(4, 6), 16);
    captions.style.setProperty('--eya-caption-background', `rgba(${red}, ${green}, ${blue}, ${Number(state.opacity) / 100})`);
  }
  function apply() {
    video.defaultPlaybackRate = Number(state.speed); video.playbackRate = Number(state.speed); video.loop = state.loop; applyCaptionStyle();
  }
  function nameFor(key) { return choices[key].find(([value]) => value === state[key])?.[1] || ''; }
  function row(label, action, { value = '', submenu = false, checked, color, role = 'menuitem' } = {}) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'eya-video-menu-row';
    button.setAttribute('role', role); button.setAttribute('aria-label', label);
    if (checked !== undefined) button.setAttribute('aria-checked', String(checked));
    if (submenu) button.setAttribute('aria-haspopup', 'menu');
    if (color) {
      const swatch = document.createElement('span'); swatch.className = 'eya-video-menu-swatch'; swatch.style.backgroundColor = color; swatch.setAttribute('aria-hidden', 'true'); button.append(swatch);
    }
    const text = document.createElement('span'); text.className = 'eya-video-menu-label'; text.textContent = label; button.append(text);
    if (value) { const summary = document.createElement('span'); summary.className = 'eya-video-menu-value'; summary.textContent = value; button.append(summary); }
    const marker = document.createElement('span'); marker.setAttribute('aria-hidden', 'true');
    marker.className = checked !== undefined ? 'eya-video-menu-check' : 'eya-video-menu-chevron';
    marker.textContent = checked !== undefined ? (checked ? '✓' : '') : (submenu ? '›' : ''); button.append(marker);
    button.addEventListener('click', action); return button;
  }
  function navigate(screen, focus = true) {
    current = screen; settings.replaceChildren(); settings.scrollTop = 0; settings.setAttribute('aria-label', titles[screen]);
    const header = document.createElement('div'); header.className = 'eya-video-menu-header';
    if (screen !== 'home') {
      const back = document.createElement('button'); back.type = 'button'; back.className = 'eya-video-menu-back'; back.setAttribute('aria-label', 'Back to ' + titles[parents[screen]]); back.textContent = '‹';
      back.addEventListener('click', () => navigate(parents[screen])); header.append(back);
    }
    const title = document.createElement('strong'); title.textContent = titles[screen]; header.append(title); settings.append(header);
    const body = document.createElement('div'); body.className = 'eya-video-settings-section'; settings.append(body);
    const category = (label, target, value = '') => body.append(row(label, () => navigate(target), { value, submenu: true }));
    if (screen === 'home') {
      category('Playback', 'playback', state.speed === '1' ? 'Normal' : nameFor('speed'));
      category('Subtitles', 'subtitles', tracks?.selectedOptions?.[0]?.textContent || 'Off');
      category('Subtitle appearance', 'appearance');
    } else if (screen === 'playback') {
      category('Playback speed', 'speed', nameFor('speed'));
      body.append(row('Loop video', () => { state.loop = !state.loop; video.loop = state.loop; save(); navigate('playback'); }, { checked: state.loop, role: 'menuitemcheckbox' }));
    } else if (screen === 'subtitles') {
      for (const option of Array.from(tracks?.options || [])) {
        body.append(row(option.textContent, () => { tracks.value = option.value; tracks.dispatchEvent(new Event('change')); navigate('subtitles'); }, { checked: tracks.value === option.value, role: 'menuitemradio' }));
      }
      if (!tracks?.options?.length) { const unavailable = document.createElement('p'); unavailable.textContent = 'No embedded subtitles available.'; body.append(unavailable); }
      if (note) body.append(note);
      if (helpButton) { helpButton.className = 'eya-video-menu-row'; helpButton.setAttribute('role', 'menuitem'); body.append(helpButton); }
    } else if (screen === 'appearance') {
      for (const key of ['size', 'font', 'color', 'background', 'opacity', 'outline', 'position']) category(labels[key], key, nameFor(key));
      body.append(row('Reset subtitle appearance', () => { for (const key of ['size', 'font', 'color', 'background', 'opacity', 'outline', 'position']) state[key] = defaults[key]; applyCaptionStyle(); save(); navigate('appearance'); }));
    } else if (choices[screen]) {
      for (const [value, label] of choices[screen]) {
        body.append(row(label, () => { state[screen] = value; apply(); save(); navigate(parents[screen]); }, { checked: state[screen] === value, role: 'menuitemradio', color: screen === 'color' || screen === 'background' ? value : undefined }));
      }
    }
    if (focus && !settings.hidden) (body.querySelector('[aria-checked="true"]') || body.querySelector('button') || header.querySelector('button'))?.focus({ preventScroll: true });
  }
  const keyboard = event => {
    const buttons = Array.from(settings.querySelectorAll('button:not(:disabled)'));
    const index = buttons.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      const next = buttons[target]; next?.focus({ preventScroll: true });
      if (next) {
        const item = next.getBoundingClientRect(), menu = settings.getBoundingClientRect();
        if (item.top < menu.top) settings.scrollTop += item.top - menu.top;
        else if (item.bottom > menu.bottom) settings.scrollTop += item.bottom - menu.bottom;
      }
    } else if ((event.key === 'Escape' || event.key === 'ArrowLeft') && current !== 'home') {
      event.preventDefault(); event.stopPropagation(); navigate(parents[current]);
    }
  };
  settings.addEventListener('keydown', keyboard);
  apply(); navigate('home', false);
  return {
    updateSettings(value = {}) {
      for (const [key, options] of Object.entries(choices)) if (options.some(([choice]) => choice === value[key]) || ((key === 'color' || key === 'background') && /^#[0-9a-f]{6}$/i.test(value[key] || ''))) state[key] = value[key];
      if (typeof value.loop === 'boolean') state.loop = value.loop; apply(); navigate(current, false);
    },
    getSettings: () => ({ ...state }),
    reset() { navigate('home', false); },
    refreshTracks() { if (current === 'home' || current === 'subtitles') navigate(current, false); },
    dispose() { settings.removeEventListener('keydown', keyboard); },
  };
}
