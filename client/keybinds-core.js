// Action IDs and serialized strokes are shared by generated clients, workspace
// preferences, and panel handlers. Missing IDs keep their released defaults.
export const KEYBIND_ACTIONS = [
  ['global.settings','Settings','Global',['Mod+,']],
  ['global.keybinds','Keyboard shortcuts','Global',[]],
  ['global.workspaces','Manage workspaces','Global',[]],
  ['global.launcher','New panel','Global',['Mod+Shift+p']],
  ['global.terminal','New terminal','Global',['Mod+Shift+Backquote']],
  ['global.files','New file browser','Global',['Mod+Shift+e']],
  ['global.closePanel','Close panel','Global',[]],
  ['global.minimizePanel','Minimize panel','Global',[]],
  ['files.path','Focus path','Files',['Mod+l']],
  ['files.search','Search files','Files',['Mod+f']],
  ['files.refresh','Refresh directory','Files',['F5']],
  ['files.parent','Parent directory','Files',['Alt+ArrowUp']],
  ['files.open','Open entry','Files',['Enter']],
  ['files.rename','Rename entry','Files',['F2']],
  ['files.delete','Delete selected entries','Files',['Delete','Backspace']],
  ['files.selectAll','Select all entries','Files',['Mod+a']],
  ['files.copy','Copy selected files','Files',['Mod+c']],
  ['files.paste','Paste files','Files',['Mod+v']],
  ['editor.save','Save file','Editor',['Mod+s']],
  ['editor.undo','Undo','Editor',['Mod+z']],
  ['editor.redo','Redo','Editor',['Mod+Shift+z','Ctrl+y']],
  ['editor.find','Find text','Editor',['Mod+f']],
  ['terminal.clear','Clear terminal','Terminal',[]],
  ['terminal.text','View terminal text','Terminal',[]],
  ['browser.address','Focus address','Browser',['Mod+l']],
  ['browser.find','Find in page','Browser',['Mod+f']],
  ['browser.newTab','New browser tab','Browser',['Mod+t']],
  ['browser.closeTab','Close browser tab','Browser',['Mod+w']],
  ['browser.back','Back','Browser',['Alt+ArrowLeft']],
  ['browser.forward','Forward','Browser',['Alt+ArrowRight']],
  ['browser.reload','Reload page','Browser',['Mod+r']],
  ['browser.print','Print page','Browser',['Mod+p']],
  ['browser.tools','Developer tools','Browser',[]],
  ['cad.fit','Fit model','3D viewer',['f']],
  ['cad.pointerPan','Pointer-lock pan','3D viewer',['Space']],
  ['cad.orbitMouse','Orbit mouse gesture','3D viewer',['MouseLeft'],'mouse'],
  ['cad.panMouse','Pan mouse gesture','3D viewer',['MouseRight','MouseMiddle'],'mouse'],
  ['cad.lookMouse','Look mouse gesture','3D viewer',['Alt+MouseRight'],'mouse'],
  ['cad.fast','Fast movement modifier','3D viewer',['Shift'],'modifier'],
  ['cad.slow','Slow movement modifier','3D viewer',['Ctrl'],'modifier'],
  ['cad.forward','Move forward','3D viewer',['w']],
  ['cad.backward','Move backward','3D viewer',['s']],
  ['cad.left','Move left','3D viewer',['a']],
  ['cad.right','Move right','3D viewer',['d']],
  ['cad.down','Move down','3D viewer',['q']],
  ['cad.up','Move up','3D viewer',['e']],
  ['image.zoomIn','Zoom in','Images',['=','Shift+=']],
  ['image.zoomOut','Zoom out','Images',['-']],
  ['image.reset','Reset view','Images',['0']],
  ['image.left','Pan left','Images',['ArrowLeft']],
  ['image.right','Pan right','Images',['ArrowRight']],
  ['image.up','Pan up','Images',['ArrowUp']],
  ['image.down','Pan down','Images',['ArrowDown']],
  ['video.play','Play or pause','Video',['Space','k']],
  ['video.backward','Seek backward','Video',['ArrowLeft']],
  ['video.forward','Seek forward','Video',['ArrowRight']],
  ['video.fullscreen','Fullscreen','Video',['f']],
  ['video.mute','Mute','Video',['m']],
  ['video.settings','Video settings','Video',[]],
  ['task.search','Find process','Task Manager',['Mod+f']],
  ['task.details','Process details','Task Manager',['Enter']],
  ['task.terminate','Terminate process','Task Manager',['Delete','Backspace']],
  ['task.refresh','Refresh statistics','Task Manager',['F5']],
  ['docker.search','Find Docker item','Docker',['Mod+f']],
  ['docker.open','Open selection','Docker',['Enter']],
].map(([id,label,group,defaults,kind]) => Object.freeze({ id,label,group,kind,defaults:Object.freeze(defaults) }));
const definitions = new Map(KEYBIND_ACTIONS.map(action => [action.id,action]));
const listeners = new Set();
let overrides = Object.create(null);
const keyAliases = { ' ':'Space', Spacebar:'Space', Esc:'Escape', Del:'Delete', '+':'=', '`':'Backquote', '~':'Backquote', Plus:'=' };
function keyName(key) { const value = keyAliases[key] || key; return value.length === 1 ? value.toLowerCase() : value; }
export function normalizeKeybind(value) {
  if (typeof value !== 'string' || !value || value.length > 96) return null;
  if (['Mod','Ctrl','Meta','Alt','Shift'].includes(value)) return value;
  const parts = value.split('+'); const key = keyName(parts.pop() || '');
  if (!key || ['Control','Alt','Shift','Meta','Unidentified','Dead'].includes(key)) return null;
  if (!/^(?:[\x21-\x7e]|Arrow(?:Up|Down|Left|Right)|Page(?:Up|Down)|Backspace|Backquote|Delete|Enter|Escape|Tab|Space|Home|End|Insert|F(?:[1-9]|1[0-2])|Mouse(?:Left|Middle|Right))$/.test(key)) return null;
  const modifiers = new Set(parts.map(item => ({ Control:'Ctrl', Cmd:'Meta', Command:'Meta', Option:'Alt' })[item] || item));
  if ([...modifiers].some(item => !['Mod','Ctrl','Meta','Alt','Shift'].includes(item))) return null;
  return [...['Mod','Ctrl','Meta','Alt','Shift'].filter(item => modifiers.has(item)), key].join('+');
}
export function getKeybinds() { return Object.fromEntries(Object.entries(overrides).map(([id,strokes]) => [id,[...strokes]])); }
export function getActionKeybinds(id) { return Object.hasOwn(overrides,id) ? overrides[id] : definitions.get(id)?.defaults || []; }
export function setKeybinds(value = {}) {
  const next = Object.create(null);
  // Preserve bounded unknown IDs so an older client does not erase shortcuts
  // belonging to a newer panel when it saves workspace preferences.
  if (value && typeof value === 'object' && !Array.isArray(value)) for (const [id,supplied] of Object.entries(value).slice(0,128)) {
    if (!/^[a-z][a-zA-Z0-9.-]{0,79}$/.test(id) || !id.includes('.') || !Array.isArray(supplied) || supplied.length > 4) continue;
    const strokes = supplied.map(normalizeKeybind); if (strokes.some(item => !item)) continue;
    next[id] = [...new Set(strokes)];
  }
  overrides = next; for (const listener of listeners) listener(getKeybinds());
}
export function subscribeKeybinds(callback) { listeners.add(callback); return () => listeners.delete(callback); }
export function keybindFromEvent(event) {
  const key = keyName(event.code === 'Backquote' ? 'Backquote' : event.key || '');
  if (['Control','Alt','Shift','Meta'].includes(key) || !normalizeKeybind(key)) return null;
  return [...(event.ctrlKey ? ['Ctrl'] : []),...(event.metaKey ? ['Meta'] : []),...(event.altKey ? ['Alt'] : []),...(event.shiftKey ? ['Shift'] : []),key].join('+');
}
function strokeMatches(stroke,event) {
  const normalized = normalizeKeybind(stroke); if (!normalized) return false;
  const parts = normalized.split('+'), key = parts.pop();
  const actual = keyName(event.code === 'Backquote' ? 'Backquote' : event.key || '');
  if (actual !== key) return false;
  const mod = parts.includes('Mod'), ctrl = parts.includes('Ctrl'), meta = parts.includes('Meta');
  if (mod) { if (!(event.ctrlKey || event.metaKey)) return false; }
  else if (!!event.ctrlKey !== ctrl || !!event.metaKey !== meta) return false;
  return !!event.altKey === parts.includes('Alt') && !!event.shiftKey === parts.includes('Shift');
}
export function pointerKeybindFromEvent(event) {
  const key = ({0:'MouseLeft',1:'MouseMiddle',2:'MouseRight'})[event.button];
  return key ? keybindFromEvent({ ...event,key,ctrlKey:event.ctrlKey,metaKey:event.metaKey,altKey:event.altKey,shiftKey:event.shiftKey }) : null;
}
export function modifierKeybindFromEvent(event) { return ({Control:'Ctrl',Shift:'Shift',Alt:'Alt',Meta:'Meta'})[event.key] || null; }
export function matchesPointerKeybind(id,event) {
  const stroke=pointerKeybindFromEvent(event);
  return !!stroke && getActionKeybinds(id).some(value => strokeMatches(value,{ key:stroke.split('+').at(-1),ctrlKey:event.ctrlKey,metaKey:event.metaKey,altKey:event.altKey,shiftKey:event.shiftKey }));
}
export function matchesModifierKeybind(id,event) {
  return getActionKeybinds(id).some(value => value==='Mod' ? event.ctrlKey || event.metaKey : !!event[({Ctrl:'ctrlKey',Meta:'metaKey',Alt:'altKey',Shift:'shiftKey'})[value]]);
}
export function matchesKeybind(id,event) { return !event.isComposing && !event.defaultPrevented && getActionKeybinds(id).some(stroke => strokeMatches(stroke,event)); }
export function formatKeybind(stroke) { return stroke.replace(/Mod/g,'Ctrl/Cmd').replace(/Backquote/g,'`').replace(/ArrowLeft/g,'←').replace(/ArrowRight/g,'→').replace(/ArrowUp/g,'↑').replace(/ArrowDown/g,'↓'); }
function overlap(a,b) {
  for (const ctrlKey of [false,true]) for (const metaKey of [false,true]) for (const altKey of [false,true]) for (const shiftKey of [false,true]) {
    const key = a.split('+').at(-1);
    const event = {key:key==='Space'?' ':key,code:key,ctrlKey,metaKey,altKey,shiftKey};
    if (strokeMatches(a,event) && strokeMatches(b,event)) return true;
  }
  return false;
}
export function keybindConflict(id,strokes) {
  const target = definitions.get(id); if (!target) return null;
  return KEYBIND_ACTIONS.find(action => action.id !== id && action.kind === target.kind && (action.group === target.group || action.group === 'Global' || target.group === 'Global') && strokes.some(stroke => getActionKeybinds(action.id).some(other => overlap(stroke,other))));
}

