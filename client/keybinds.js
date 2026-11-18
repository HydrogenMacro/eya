import { buttonIcon, closeMenus, icon } from './ui.js';
import { KEYBIND_ACTIONS, getKeybinds, getActionKeybinds, setKeybinds, subscribeKeybinds, keybindFromEvent, pointerKeybindFromEvent, modifierKeybindFromEvent, formatKeybind, keybindConflict } from './keybinds-core.js';
export * from './keybinds-core.js';

export function createKeybindSettings({ onChange = () => {} } = {}) {
  const dialog = document.createElement('dialog'); dialog.id = 'keybinds-dialog'; dialog.setAttribute('aria-label','Keyboard shortcuts');
  const header = document.createElement('div'); header.className = 'keybinds-header';
  const title = document.createElement('h2'); title.textContent = 'Keyboard shortcuts';
  const close = document.createElement('button'); close.type = 'button'; buttonIcon(close,'X','Close keyboard shortcuts',true); close.onclick = () => dialog.close(); header.append(title,close);
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search actions or shortcuts'; search.setAttribute('aria-label','Search shortcuts');
  const layout = document.createElement('div'); layout.className = 'keybinds-layout';
  const navigation = document.createElement('nav'); navigation.className = 'keybinds-navigation'; navigation.setAttribute('aria-label','Shortcut categories');
  const list = document.createElement('div'); list.className = 'keybinds-list';
  const status = document.createElement('p'); status.className = 'keybinds-status'; status.setAttribute('role','status');
  const footer = document.createElement('div'); footer.className = 'keybinds-footer';
  const reset = document.createElement('button'); reset.type = 'button'; buttonIcon(reset,'RotateCcw','Reset all'); reset.onclick = () => { if (!Object.keys(getKeybinds()).length || confirm('Reset all keyboard shortcuts?')) { setKeybinds({}); onChange(getKeybinds()); render(); } }; footer.append(status,reset);
  layout.append(navigation,list); dialog.append(header,search,layout,footer); document.body.append(dialog);
  let group = 'Global', recording = null;
  const categoryIcons = {'All shortcuts':'Command',Global:'Command',Files:'Folder',Editor:'FileCode',Terminal:'Terminal',Browser:'Globe','3D viewer':'Box',Images:'Image',Video:'Play','Task Manager':'Cpu',Docker:'Container'};
  const groups = ['All shortcuts',...new Set(KEYBIND_ACTIONS.map(action=>action.group))];
  for (const name of groups) { const button=document.createElement('button');button.type='button';button.dataset.category=name;button.append(icon(categoryIcons[name]));const text=document.createElement('span');text.textContent=name;button.append(text);button.onclick=()=>{group=name;search.value='';render();};navigation.append(button); }
  function finish() { recording = null; status.textContent = ''; }
  function update(id,strokes) {
    const conflict = keybindConflict(id,strokes);
    if (conflict) { status.textContent = `Used by ${conflict.label} (${conflict.group}).`; return false; }
    const next = getKeybinds(); next[id] = strokes; setKeybinds(next); onChange(getKeybinds()); finish(); render(); return true;
  }
  function render() {
    recording = null;
    for (const button of navigation.children) button.setAttribute('aria-current',String(button.dataset.category===group));
    list.replaceChildren(); const query=search.value.trim().toLocaleLowerCase(); let previous='';
    for (const action of KEYBIND_ACTIONS) {
      const strokes = getActionKeybinds(action.id);
      if (query ? !`${action.label} ${action.group} ${action.id} ${strokes.map(formatKeybind).join(' ')}`.toLocaleLowerCase().includes(query) : group!=='All shortcuts' && action.group!==group) continue;
      if (previous!==action.group) { const heading=document.createElement('h3');heading.textContent=action.group;list.append(heading);previous=action.group; }
      const row=document.createElement('div');row.className='keybinds-row';row.dataset.action=action.id;
      const label=document.createElement('span');label.className='keybinds-action';label.textContent=action.label;
      const edit=document.createElement('button');edit.type='button';edit.className='keybinds-edit';edit.setAttribute('aria-label',`Change ${action.label} shortcut`);edit.textContent=strokes.length?strokes.map(formatKeybind).join(' / '):'Unassigned';
      edit.onclick=()=>{recording={action,button:edit};edit.textContent=action.kind==='mouse'?'Use mouse gesture…':action.kind==='modifier'?'Press modifier…':'Press shortcut…';edit.focus();status.textContent=action.kind==='mouse'?'Click a mouse button with modifiers. Escape cancels.':action.kind==='modifier'?'Press a modifier key. Escape cancels.':'Press a shortcut. Escape cancels.';};
      edit.addEventListener('keydown',event=>{
        if (recording?.button!==edit) return;
        event.preventDefault();event.stopImmediatePropagation();
        if (event.key==='Escape') {finish();render();return;}
        const stroke=action.kind==='modifier'?modifierKeybindFromEvent(event):action.kind==='mouse'?null:keybindFromEvent(event);if(stroke)update(action.id,[stroke]);
      });
      edit.addEventListener('pointerdown',event=>{
        if(recording?.button!==edit || action.kind!=='mouse')return;
        event.preventDefault();event.stopPropagation();const stroke=pointerKeybindFromEvent(event);if(stroke)update(action.id,[stroke]);
      });
      edit.addEventListener('contextmenu',event=>event.preventDefault());
      const restore=document.createElement('button');restore.type='button';buttonIcon(restore,'RotateCcw',`Reset ${action.label} shortcut`,true);restore.disabled=!Object.hasOwn(getKeybinds(),action.id);restore.onclick=()=>{const next=getKeybinds();delete next[action.id];setKeybinds(next);onChange(getKeybinds());finish();render();};
      const clear=document.createElement('button');clear.type='button';buttonIcon(clear,'X',`Clear ${action.label} shortcut`,true);clear.disabled=!strokes.length;clear.onclick=()=>update(action.id,[]);
      row.append(label,edit,clear,restore);list.append(row);
    }
    if (!list.children.length) {const empty=document.createElement('p');empty.textContent='No shortcuts found';list.append(empty);}
  }
  search.oninput=()=>{finish();render();};
  dialog.addEventListener('close',finish);
  const unsubscribe=subscribeKeybinds(()=>{if(dialog.open&&!recording)render();});
  const style=document.createElement('style');style.textContent=`
  #keybinds-dialog{width:min(900px,calc(100% - 24px));height:min(740px,88dvh);overflow:hidden;padding:18px}#keybinds-dialog[open]{display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;gap:12px}.keybinds-header{display:flex;align-items:center;gap:12px}.keybinds-header h2{flex:1;margin:0;font-size:19px}#keybinds-dialog>input{margin:0;width:100%}.keybinds-layout{display:grid;grid-template-columns:170px minmax(0,1fr);gap:18px;min-height:0}.keybinds-navigation,.keybinds-list{min-height:0;overflow:auto;overscroll-behavior:contain}.keybinds-navigation{display:flex;flex-direction:column;gap:3px}.keybinds-navigation button{justify-content:flex-start;border:0;background:transparent;padding:9px;font-size:13px}.keybinds-navigation button[aria-current=true]{background:var(--ui-control,#28434b);color:var(--ui-accent,#7fdbc5)}.keybinds-list h3{margin:4px 0 8px;font-size:12px;color:var(--ui-muted,#a6b8c3)}.keybinds-list h3:not(:first-child){margin-top:22px}.keybinds-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--ui-border,#344854)}.keybinds-action{flex:1;min-width:0;font-size:13px}.keybinds-edit{min-width:112px;max-width:55%;overflow-wrap:anywhere;font:12px ui-monospace,monospace;padding:7px 9px}.keybinds-footer{display:flex;align-items:center;gap:12px}.keybinds-status{flex:1;font-size:12px;margin:0;min-height:1.4em}.keybinds-footer>button{font-size:12px}@media(max-width:600px){#keybinds-dialog{padding:12px}.keybinds-layout{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);gap:10px}.keybinds-navigation{flex-direction:row;overflow:auto}.keybinds-navigation button{flex-shrink:0}.keybinds-row{gap:5px}.keybinds-edit{min-width:90px}}
  `;document.head.append(style);
  return {open(category){closeMenus();group=groups.includes(category)?category:'Global';search.value='';finish();render();if(!dialog.open)dialog.showModal();search.focus();},dialog,destroy(){unsubscribe();dialog.remove();style.remove();}};
}
