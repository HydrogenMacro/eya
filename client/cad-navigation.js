import * as THREE from 'three';
import { matchesKeybind, matchesPointerKeybind, matchesModifierKeybind, getActionKeybinds } from './keybinds-core.js';

const WORLD_UP = new THREE.Vector3(0, 0, 1);
const movementActions = ['forward', 'backward', 'left', 'right', 'down', 'up'];

// Use the current camera frame at a pole. A cross product with world-up alone
// loses its direction there and makes the next rotation jump by half a turn.
export function cadCameraFrame(camera) {
  return {
    forward: new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion),
    right: new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion),
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion),
  };
}

export function createCadNavigation({ camera, stage, getState, getRadius, getBounds, onError = () => {} }) {
  const control = new THREE.EventDispatcher();
  control.target = new THREE.Vector3();
  const abort = new AbortController(), signal = abort.signal;
  const pointers = new Map(), held = new Map();
  let frame = 0, lastTime = 0, azimuth = Math.atan2(camera.position.y, camera.position.x);
  let modifierEvent = {}, spacePanning = false, panCode, dragEnded, disposed = false;
  const changed = () => {
    const box=getBounds();
    if (box) {
      const far=Math.max(getRadius()*1000,camera.position.distanceTo(box.getCenter(new THREE.Vector3()))+getRadius()*10);
      if (Math.abs(far-camera.far)>.001) { camera.far=far;camera.updateProjectionMatrix(); }
    }
    camera.updateMatrixWorld(true); control.dispatchEvent({ type: 'change' });
  };
  function lookAtTarget() {
    const offset = camera.position.clone().sub(control.target);
    if (getState().orbitStyle !== 'free') {
      const horizontal = Math.hypot(offset.x, offset.y);
      if (horizontal > offset.length() * 1e-7) azimuth = Math.atan2(offset.y, offset.x);
      // A direction-dependent screen-up gives lookAt a stable frame at exactly
      // top/bottom while preserving the same heading during the first drag.
      if (horizontal < offset.length() * 1e-6) camera.up.set(-Math.cos(azimuth) * Math.sign(offset.z || 1), -Math.sin(azimuth) * Math.sign(offset.z || 1), 0);
      else camera.up.copy(WORLD_UP);
    }
    camera.lookAt(control.target); camera.updateMatrixWorld(true);
  }
  control.update = () => { lookAtTarget(); changed(); };
  function orbit(dx, dy) {
    const state = getState();
    if (state.orbitPivot === 'origin') control.target.set(0, 0, 0);
    else if (state.orbitPivot === 'model') getBounds()?.getCenter(control.target);
    const offset = camera.position.clone().sub(control.target), distance = Math.max(offset.length(), 1e-8);
    const scale = Math.PI * 2 * state.lookSpeed / Math.max(100, Math.min(stage.clientWidth, stage.clientHeight));
    if (state.orbitStyle === 'free') {
      const basis = cadCameraFrame(camera), rotation = new THREE.Quaternion().setFromAxisAngle(basis.up, -dx * scale);
      rotation.multiply(new THREE.Quaternion().setFromAxisAngle(basis.right, -dy * scale));
      offset.applyQuaternion(rotation); camera.up.copy(basis.up).applyQuaternion(rotation);
    } else {
      const horizontal = Math.hypot(offset.x, offset.y);
      if (horizontal > distance * 1e-7) azimuth = Math.atan2(offset.y, offset.x);
      azimuth -= dx * scale;
      const polar = THREE.MathUtils.clamp(Math.acos(THREE.MathUtils.clamp(offset.z / distance, -1, 1)) - dy * scale, 1e-5, Math.PI - 1e-5);
      offset.set(Math.sin(polar) * Math.cos(azimuth), Math.sin(polar) * Math.sin(azimuth), Math.cos(polar)).multiplyScalar(distance);
      camera.up.copy(WORLD_UP);
    }
    camera.position.copy(control.target).add(offset); lookAtTarget(); changed();
  }
  function pan(dx, dy) {
    const basis = cadCameraFrame(camera);
    const xScale = (camera.right - camera.left) / camera.zoom / Math.max(1, stage.clientWidth);
    const yScale = (camera.top - camera.bottom) / camera.zoom / Math.max(1, stage.clientHeight);
    const movement = basis.right.multiplyScalar(-dx * xScale).addScaledVector(basis.up, dy * yScale);
    camera.position.add(movement); control.target.add(movement); changed();
  }
  function look(dx, dy) {
    const state = getState(), distance = Math.max(camera.position.distanceTo(control.target), 1e-6), basis = cadCameraFrame(camera);
    const scale = .004 * state.lookSpeed;
    const forward = basis.forward;
    if (state.orbitStyle !== 'free') {
      const yaw=(Math.hypot(forward.x,forward.y)>1e-7?Math.atan2(forward.y,forward.x):azimuth+Math.PI)-dx*scale;
      const pitch=THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(forward.z,-1,1))-dy*scale*(state.invertLook?-1:1),-Math.PI/2+1e-5,Math.PI/2-1e-5);
      forward.set(Math.cos(pitch)*Math.cos(yaw),Math.cos(pitch)*Math.sin(yaw),Math.sin(pitch));
      camera.up.copy(WORLD_UP);
    } else {
      const rotation=new THREE.Quaternion().setFromAxisAngle(basis.up,-dx*scale);
      rotation.multiply(new THREE.Quaternion().setFromAxisAngle(basis.right,-dy*scale*(state.invertLook?-1:1)));
      forward.applyQuaternion(rotation);camera.up.copy(basis.up).applyQuaternion(rotation);
    }
    control.target.copy(camera.position).addScaledVector(forward, distance); lookAtTarget(); changed();
  }
  function dolly(amount) {
    // Orthographic translation alone is invisible. Couple the physical movement
    // with a scale change so W/S and wheel both visibly approach/recede.
    const before = camera.zoom, after = THREE.MathUtils.clamp(before * Math.exp(amount), 1e-4, 1e6);
    const movement = cadCameraFrame(camera).forward.multiplyScalar(getRadius() * 2 * (1 / before - 1 / after));
    camera.position.add(movement); control.target.add(movement); camera.zoom = after;
    camera.updateProjectionMatrix(); changed();
  }
  function speed() {
    const state = getState();
    return state.movementSpeed * (matchesModifierKeybind('cad.fast', modifierEvent) ? state.speedModifier : 1) / (matchesModifierKeybind('cad.slow', modifierEvent) ? state.speedModifier : 1);
  }
  function stop() { held.clear(); cancelAnimationFrame(frame); frame = 0; lastTime = 0; }
  function tick(time) {
    frame = 0;
    if (disposed || document.activeElement !== stage || !held.size) { stop(); return; }
    const elapsed = lastTime ? Math.min(.05, (time - lastTime) / 1000) : 1 / 60; lastTime = time;
    const actions = new Set(held.values()), factor = speed() * elapsed;
    const forward = Number(actions.has('forward')) - Number(actions.has('backward'));
    if (forward) dolly(forward * factor * 1.8);
    const basis = cadCameraFrame(camera), move = new THREE.Vector3();
    move.addScaledVector(basis.right, Number(actions.has('right')) - Number(actions.has('left')));
    move.z += Number(actions.has('up')) - Number(actions.has('down'));
    if (move.lengthSq()) { move.normalize().multiplyScalar(getRadius() * 1.8 * factor / Math.sqrt(camera.zoom)); camera.position.add(move); control.target.add(move); changed(); }
    frame = requestAnimationFrame(tick);
  }
  function endPan() {
    spacePanning = false;
    if (document.pointerLockElement === stage) document.exitPointerLock?.();
  }
  stage.addEventListener('keydown', event => {
    if (event.target !== stage) return;
    modifierEvent = event;
    if (matchesKeybind('cad.pointerPan', event)) {
      event.preventDefault(); if (event.repeat || spacePanning) return;
      spacePanning = true; panCode=event.code || event.key;
      try { const result = stage.requestPointerLock?.(); result?.catch?.(() => { spacePanning = false; onError('Pointer lock unavailable. Use the pan gesture.'); }); if (!stage.requestPointerLock) { spacePanning = false; onError('Pointer lock unavailable. Use the pan gesture.'); } }
      catch { spacePanning = false; onError('Pointer lock unavailable. Use the pan gesture.'); }
      return;
    }
    // Repeated keydown events often arrive defaultPrevented by another handler;
    // keep the original code->action entry until keyup, never restart its timer.
    const code = event.code || event.key?.toLowerCase();
    if (held.has(code)) { event.preventDefault(); return; }
    const stripped = { key:event.key, code:event.code, ctrlKey:event.ctrlKey,metaKey:event.metaKey,altKey:event.altKey,shiftKey:event.shiftKey };
    for (const key of ['ctrlKey','metaKey','altKey','shiftKey']) {
      const names={ctrlKey:['Ctrl','Mod'],metaKey:['Meta','Mod'],altKey:['Alt'],shiftKey:['Shift']}[key];
      if (event[key] && ['cad.fast','cad.slow'].some(id=>getActionKeybinds(id).some(value=>names.includes(value)))) stripped[key] = false;
    }
    const action = movementActions.find(name => matchesKeybind(`cad.${name}`, event) || matchesKeybind(`cad.${name}`, stripped));
    if (action) { event.preventDefault(); held.set(code, action); if (!frame) tick(performance.now()); }
  }, { signal });
  window.addEventListener('keydown', event => { modifierEvent = event; if (event.key === 'Escape') { stop(); endPan(); } }, { signal });
  window.addEventListener('keyup', event => { modifierEvent = event; held.delete(event.code || event.key?.toLowerCase()); if (!held.size) stop(); if (spacePanning && (event.code || event.key)===panCode) endPan(); }, { signal });
  stage.addEventListener('blur', () => { stop(); endPan(); }, { signal });
  window.addEventListener('blur', () => { stop(); endPan(); }, { signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); endPan(); } }, { signal });
  document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement !== stage) spacePanning = false; else if (!spacePanning || disposed) document.exitPointerLock?.(); }, { signal });
  document.addEventListener('pointerlockerror', () => { spacePanning = false; onError('Pointer lock unavailable. Use the pan gesture.'); }, { signal });
  stage.addEventListener('contextmenu', event => event.preventDefault(), { signal });
  stage.addEventListener('wheel', event => { event.preventDefault(); dolly(-event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1) * (event.ctrlKey ? .01 : .0015)); }, { passive:false, signal });
  stage.addEventListener('pointerdown', event => {
    if (event.target.closest?.('.cad-rotation-gizmo')) return;
    stage.focus({preventScroll:true});
    const action = event.pointerType === 'touch' ? 'orbit' : ['look','pan','orbit'].find(value => matchesPointerKeybind(`cad.${value}Mouse`,event));
    pointers.set(event.pointerId,{ x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,action,dragging:false,touch:event.pointerType==='touch' });
    if (action) stage.setPointerCapture?.(event.pointerId);
  }, { signal });
  stage.addEventListener('pointermove', event => {
    if (spacePanning && document.pointerLockElement === stage) { pan(event.movementX,event.movementY); return; }
    const pointer = pointers.get(event.pointerId); if (!pointer) return;
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
    pointer.dragging ||= Math.hypot(event.clientX-pointer.startX,event.clientY-pointer.startY)>3;
    const touches = [...pointers.values()].filter(item => item.touch);
    if (pointer.touch && touches.length === 2) {
      const before = Math.hypot(touches[0].x-touches[1].x,touches[0].y-touches[1].y);
      pointer.x=event.clientX;pointer.y=event.clientY;
      const after = Math.hypot(touches[0].x-touches[1].x,touches[0].y-touches[1].y);
      for (const touch of touches) touch.dragging=true;
      if (before>1 && after>1) dolly(Math.log(after/before)); pan(dx/2,dy/2); return;
    }
    pointer.x=event.clientX;pointer.y=event.clientY;
    if (!pointer.dragging) return;
    if (pointer.action==='orbit') orbit(dx,dy); else if (pointer.action==='pan') pan(dx,dy); else if (pointer.action==='look') look(dx,dy);
  }, { signal });
  const release = event => { const pointer=pointers.get(event.pointerId); dragEnded={id:event.pointerId,dragging:!!pointer?.dragging}; pointers.delete(event.pointerId); };
  stage.addEventListener('pointerup',release,{ signal });stage.addEventListener('pointercancel',release,{ signal });
  stage.addEventListener('lostpointercapture',event=>pointers.delete(event.pointerId),{signal});
  control.wasDragging = event => dragEnded?.id===event.pointerId && dragEnded.dragging;
  control.orbit = orbit; control.pan = pan; control.dolly = dolly;
  control.stop = stop;
  control.dispose = () => { disposed=true; stop(); endPan(); abort.abort(); pointers.clear(); };
  control.diagnostics = () => ({ up:camera.up.toArray(), quaternion:camera.quaternion.toArray(), pointerLocked:document.pointerLockElement===stage, movementKeys:held.size });
  lookAtTarget();
  return control;
}
