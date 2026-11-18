import { buttonIcon } from './ui.js';

let navigatorSequence=0;
const clamp=value=>Math.max(0,Math.min(1,Number(value)));
const validPoint=value=>value&&Number.isFinite(value.x)&&Number.isFinite(value.y)?{x:clamp(value.x),y:clamp(value.y)}:{x:.95,y:.65};
export function mobileWorkspaceRectangles(layout,rect={x:0,y:0,width:1,height:1},depth=0){
  if(!layout||depth>32)return[];
  if(layout.type==='group')return[{id:layout.id,...rect}];
  if(layout.type!=='split')return[];
  const ratio=Number.isFinite(layout.ratio)?clamp(layout.ratio):.5;
  const first={...rect},second={...rect};
  if(layout.orientation==='vertical'){first.width*=ratio;second.x+=first.width;second.width*=1-ratio;}
  else{first.height*=ratio;second.y+=first.height;second.height*=1-ratio;}
  return[...mobileWorkspaceRectangles(layout.first,first,depth+1),...mobileWorkspaceRectangles(layout.second,second,depth+1)];
}

export function createMobileWorkspaceNavigator({workbench,onPositionChange=()=>{}}){
  const abort=new AbortController(),signal=abort.signal,mobile=matchMedia('(pointer:coarse),(max-width:760px)');
  const button=document.createElement('button');button.type='button';button.className='mobile-workspace-button';button.hidden=true;
  buttonIcon(button,'Columns2','Switch panel groups',true);button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-description','Drag to move. Arrow keys adjust position.');
  const dialog=document.createElement('dialog');dialog.className='mobile-workspace-dialog';dialog.id=`mobile-workspace-dialog-${++navigatorSequence}`;
  const heading=document.createElement('h2');heading.id=`${dialog.id}-title`;heading.textContent='Panel groups';dialog.setAttribute('aria-labelledby',heading.id);button.setAttribute('aria-controls',dialog.id);
  const header=document.createElement('header'),close=document.createElement('button');close.type='button';buttonIcon(close,'X','Close panel groups',true);close.onclick=()=>dialog.close();header.append(heading,close);
  const map=document.createElement('div');map.className='mobile-workspace-map';map.setAttribute('role','group');map.setAttribute('aria-label','Workspace split map');
  const list=document.createElement('div');list.className='mobile-workspace-group-list';list.setAttribute('role','group');list.setAttribute('aria-label','Panel group list');dialog.append(header,map,list);
  document.body.append(button,dialog);
  let enabled=false,position=validPoint(),drag,idleTimer,suppressClick=false,disposed=false;
  const viewport=()=>{const value=window.visualViewport;return value?{x:value.offsetLeft,y:value.offsetTop,width:value.width,height:value.height}:{x:0,y:0,width:innerWidth,height:innerHeight};};
  function bounds(){const view=viewport(),size=48;return{left:view.x+8,top:view.y+8,width:Math.max(0,view.width-size-16),height:Math.max(0,view.height-size-16)};}
  function place(){
    if(disposed)return;const rect=bounds(),view=viewport();button.style.left=`${rect.left+position.x*rect.width}px`;button.style.top=`${rect.top+position.y*rect.height}px`;
    dialog.style.left=`${view.x+Math.max(8,(view.width-Math.min(460,view.width-16))/2)}px`;dialog.style.top=`${view.y+8}px`;dialog.style.width=`${Math.max(0,Math.min(460,view.width-16))}px`;dialog.style.maxHeight=`${Math.max(0,view.height-16)}px`;map.style.height=`${Math.max(100,Math.min(420,view.height*.48))}px`;
  }
  function wake(){clearTimeout(idleTimer);button.dataset.idle='false';idleTimer=setTimeout(()=>{button.dataset.idle='true';},1800);}
  function visibility(){const visible=enabled&&mobile.matches;button.hidden=!visible;workbench.root.classList.toggle('mobile-floating-switcher-enabled',visible);if(!visible&&dialog.open)dialog.close();place();}
  function activate(group){if(group.active)workbench.activate(group.active);else{workbench.setActiveGroup(group);workbench.notifyLayout();}dialog.close();}
  function render(){
    const focused=dialog.contains(document.activeElement)?document.activeElement?.dataset.group:null;
    map.replaceChildren();list.replaceChildren();let rectangles=[];try{rectangles=mobileWorkspaceRectangles(workbench.serialize().layout);}catch{/* Layout can be transient while restoring. */}
    for(const rect of rectangles){
      const group=workbench.groups.get(rect.id);if(!group)continue;
      const active=workbench.panels.get(group.active),title=active?.title||'Empty group',count=group.panels.length;
      for(const host of [map,list]){
        const tile=document.createElement('button');tile.type='button';tile.dataset.group=group.id;tile.className=host===map?'mobile-workspace-tile':'mobile-workspace-group';tile.setAttribute('aria-label',`Switch to ${title} group`);tile.setAttribute('aria-pressed',String(workbench.activeGroup===group));
        const label=document.createElement('strong');label.textContent=title;const detail=document.createElement('small');detail.textContent=`${count} ${count===1?'tab':'tabs'}`;tile.append(label,detail);tile.onclick=()=>activate(group);
        if(host===map)Object.assign(tile.style,{left:`${rect.x*100}%`,top:`${rect.y*100}%`,width:`${rect.width*100}%`,height:`${rect.height*100}%`});host.append(tile);
      }
    }
    if(focused)map.querySelector(`[data-group="${CSS.escape(focused)}"]`)?.focus({preventScroll:true});
  }
  function openMap(){if(dialog.open)return;render();place();dialog.showModal();map.querySelector('[aria-pressed=true]')?.focus({preventScroll:true});wake();}
  button.onclick=event=>{if(suppressClick&&event.detail!==0){suppressClick=false;return;}openMap();};
  dialog.addEventListener('close',()=>{if(!button.hidden)button.focus({preventScroll:true});wake();},{signal});
  button.addEventListener('pointerdown',event=>{if(event.button!==0)return;suppressClick=false;wake();const rect=button.getBoundingClientRect();drag={id:event.pointerId,x:event.clientX,y:event.clientY,dx:event.clientX-rect.left,dy:event.clientY-rect.top,moved:false};button.setPointerCapture(event.pointerId);},{signal});
  button.addEventListener('pointermove',event=>{if(drag?.id!==event.pointerId)return;if(!drag.moved&&Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<6)return;drag.moved=true;const rect=bounds();position={x:rect.width?clamp((event.clientX-drag.dx-rect.left)/rect.width):0,y:rect.height?clamp((event.clientY-drag.dy-rect.top)/rect.height):0};place();wake();},{signal});
  const stop=event=>{if(drag?.id!==event.pointerId)return;const moved=drag.moved;drag=null;if(moved){suppressClick=true;onPositionChange({...position});setTimeout(()=>{suppressClick=false;},500);}else if(event.type==='pointerup'&&event.pointerType==='touch'){suppressClick=true;openMap();setTimeout(()=>{suppressClick=false;},500);}};
  for(const type of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(type,stop,{signal});
  button.addEventListener('keydown',event=>{const delta={ArrowLeft:[-.025,0],ArrowRight:[.025,0],ArrowUp:[0,-.025],ArrowDown:[0,.025]}[event.key];if(!delta)return;event.preventDefault();position={x:clamp(position.x+delta[0]),y:clamp(position.y+delta[1])};place();wake();onPositionChange({...position});},{signal});
  button.addEventListener('pointerenter',wake,{signal});button.addEventListener('focus',wake,{signal});
  workbench.root.addEventListener('eya-workbench-change',()=>{if(dialog.open)render();},{signal});
  window.addEventListener('resize',()=>{visibility();},{signal});window.visualViewport?.addEventListener('resize',place,{signal});window.visualViewport?.addEventListener('scroll',place,{signal});mobile.addEventListener('change',visibility,{signal});
  return{button,dialog,update(value={}){if(typeof value.enabled==='boolean')enabled=value.enabled;if(value.position!==undefined)position=validPoint(value.position);visibility();wake();},snapshot:()=>({...position}),destroy(){disposed=true;clearTimeout(idleTimer);abort.abort();workbench.root.classList.remove('mobile-floating-switcher-enabled');dialog.remove();button.remove();}};
}
