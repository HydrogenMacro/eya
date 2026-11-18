import { DockSidebar } from './docking.js';
import { matchesKeybind } from './keybinds-core.js';
import * as THREE from 'three';
import { createCadNavigation } from './cad-navigation.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { parse3mf } from './cad-3mf.js';
import { createCadSelection } from './cad-selection.js';
import { buttonIcon, createMenu, menuHeading } from './ui.js';

export const isCadFile = path => /\.(stl|glb|gltf|3mf)$/i.test(path);

function disposeObject(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root?.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  for (const texture of textures) { texture.source?.data?.close?.(); texture.dispose(); }
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}

export function cadResourcePath(modelPath, uri) {
  if (typeof uri !== 'string' || !uri || /^[a-z][a-z\d+.-]*:/i.test(uri) || uri.startsWith('/') || uri.includes('\\')) {
    throw Error('glTF resources must be relative file paths, not remote or absolute URLs.');
  }
  const base = 'https://eya.invalid' + modelPath.split('/').map(encodeURIComponent).join('/');
  const resolved = new URL(uri, base);
  if (resolved.origin !== 'https://eya.invalid' || resolved.search || resolved.hash) throw Error('glTF resource URLs cannot contain an origin, query, or fragment.');
  const path = decodeURIComponent(resolved.pathname);
  if (path.includes('\0')) throw Error('Invalid glTF resource path.');
  return path;
}

function validColor(value, fallback) {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : fallback;
}

function repairGeometryNormals(geometry, force = false) {
  const position = geometry.attributes.position;
  let normal = geometry.attributes.normal;
  let invalid = !normal || normal.count !== position?.count;
  if (!invalid && !force) {
    for (let index = 0; index < normal.count; index++) {
      const x = normal.getX(index), y = normal.getY(index), z = normal.getZ(index);
      if (!Number.isFinite(x + y + z) || x * x + y * y + z * z < 1e-12) { invalid = true; break; }
    }
  }
  if (force || invalid) { geometry.deleteAttribute('normal'); geometry.computeVertexNormals(); normal = geometry.attributes.normal; }
  geometry.normalizeNormals();
  if (normal) normal.needsUpdate = true;
}

async function parseModel(path, bytes, loadResource) {
  if (/\.3mf$/i.test(path)) return { model: await parse3mf(bytes), dependencies: new Map() };
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (/\.stl$/i.test(path)) {
    const geometry = new STLLoader().parse(data);
    if (!geometry.attributes.position?.count) { geometry.dispose(); throw Error('STL contains no triangles.'); }
    // Facet normals in exported STL files are frequently zero, stale, or non-unit. Rebuild
    // them from the triangle winding so side walls do not reach the shader as black faces.
    repairGeometryNormals(geometry, true);
    return { model: new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x80cfc1, side: THREE.DoubleSide, roughness: 0.65 })), dependencies: new Map() };
  }
  // Fetch sidecars through the encrypted file service, never through HTTP URLs.
  const objectUrls = new Set(), dependencies = new Map(), resources = new Map();
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => {
    if (!/^(data:|blob:)/i.test(url)) throw Error('A glTF resource was not loaded through the encrypted file service.');
    return url;
  });
  let json, jsonLength = 0;
  if (/\.gltf$/i.test(path)) json = JSON.parse(new TextDecoder().decode(bytes));
  else {
    const view = new DataView(data);
    if (data.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== data.byteLength) throw Error('Incomplete or invalid GLB file.');
    const length = view.getUint32(12, true);
    jsonLength = length;
    if (view.getUint32(16, true) !== 0x4e4f534a || length > data.byteLength - 20) throw Error('Invalid GLB JSON chunk.');
    json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, length)));
  }
  try {
    for (const resource of [...(json.buffers || []), ...(json.images || [])]) {
      if (!resource.uri || /^data:/i.test(resource.uri)) continue;
      const resourcePath = cadResourcePath(path, resource.uri);
      if (!loadResource) throw Error('Cannot load glTF sidecar files without a file connection.');
      let cached = resources.get(resourcePath);
      if (!cached) {
        const result = await loadResource(resourcePath);
        dependencies.set(resourcePath, result.meta.version);
        const type = resource.mimeType || ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' })[resourcePath.split('.').at(-1).toLowerCase()] || 'application/octet-stream';
        cached = URL.createObjectURL(new Blob([result.bytes], { type }));
        objectUrls.add(cached); resources.set(resourcePath, cached);
      }
      resource.uri = cached;
    }
    let source = data;
    if (/\.gltf$/i.test(path)) source = JSON.stringify(json);
    else if (resources.size) {
      // Keep binary chunks while replacing JSON URIs with authenticated blobs.
      const text = new TextEncoder().encode(JSON.stringify(json));
      const padded = Math.ceil(text.length / 4) * 4;
      const remainder = new Uint8Array(data, 20 + jsonLength);
      const rebuilt = new Uint8Array(20 + padded + remainder.length);
      const header = new DataView(rebuilt.buffer);
      header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, rebuilt.length, true);
      header.setUint32(12, padded, true); header.setUint32(16, 0x4e4f534a, true);
      rebuilt.fill(32, 20, 20 + padded); rebuilt.set(text, 20); rebuilt.set(remainder, 20 + padded);
      source = rebuilt.buffer;
    }
    const model = (await new GLTFLoader(manager).parseAsync(source, '')).scene;
    // glTF uses metres and Y-up; the CAD workspace uses millimetres and Z-up.
    const root = new THREE.Group(); root.rotation.x = Math.PI / 2; root.scale.setScalar(1000); root.add(model);
    return { model: root, dependencies };
  } finally {
    for (const url of objectUrls) URL.revokeObjectURL(url);
  }
}

export function createCadViewer({ path, preferences = {}, savePreferences = () => {}, reload = () => {}, loadResource }) {
  const root = document.createElement('div'); root.className = 'cad-viewer';
  const toolbar = document.createElement('div'); toolbar.className = 'cad-toolbar';
  const layout = document.createElement('div'); layout.className = 'cad-layout';
  const stage = document.createElement('div'); stage.className = 'cad-stage'; stage.tabIndex = 0;
  stage.setAttribute('aria-label', '3D model: drag to orbit, right-drag to pan, pinch or wheel to zoom');
  const parts = document.createElement('div'); parts.className = 'cad-parts';
  const partList = document.createElement('div'); parts.append(partList);
  const sections = document.createElement('div'); sections.className = 'cad-sections';
  const selectionPanel = document.createElement('div'); selectionPanel.className = 'cad-selection-panel';
  const stats = document.createElement('div'); stats.className = 'cad-stats';
  const measurement = document.createElement('div'); measurement.className = 'cad-measurement'; measurement.setAttribute('role', 'status');
  selectionPanel.append(measurement);
  const status = document.createElement('div'); status.className = 'cad-status'; status.setAttribute('role', 'status');
  root.append(toolbar, layout, stats, status);
  let renderer, model, meshes = [], edgeLines = [], pointClouds = [], bounds, radius = 1, disposed = false, initialized = false, generation = 0;
  let dependencies = new Map();
  let down, viewProjection = { min: 0, max: 1 };
  const hiddenParts = new Set();
  const partKey = mesh => mesh.userData.cadPartKey;
  const state = {
    mode: ['flat', 'zebra', 'shaded', 'edges', 'wireframe'].includes(preferences.mode) ? preferences.mode : 'shaded',
    opacity: Number.isFinite(preferences.opacity) ? Math.max(0.05, Math.min(1, preferences.opacity)) : 1,
    showEdges: preferences.showEdges ?? preferences.mode !== 'shaded',
    showPoints: preferences.showPoints === true,
    gizmoSize: Number.isFinite(preferences.gizmoSize) ? Math.max(64, Math.min(180, preferences.gizmoSize)) : 96,
    speedModifier: Number.isFinite(preferences.speedModifier) ? Math.max(1, Math.min(20, preferences.speedModifier)) : 4,
    unit: ['mm', 'cm', 'in'].includes(preferences.unit) ? preferences.unit : 'mm',
    live: preferences.live !== false,
    interval: [500, 1000, 2000, 5000].includes(preferences.interval) ? preferences.interval : 1000,
    grid: preferences.grid !== false,
    gridPlanes: ['off', 'xy', 'all'].includes(preferences.gridPlanes) ? preferences.gridPlanes : preferences.grid === false ? 'off' : 'all',
    axisCoordinates: preferences.axisCoordinates !== false,
    infiniteGrid: preferences.infiniteGrid === true,
    gridLines: preferences.gridLines !== false,
    gridFill: preferences.gridFill === true,
    decimalPlaces: Number.isInteger(preferences.decimalPlaces) ? Math.max(0, Math.min(10, preferences.decimalPlaces)) : 3,
    sectionGizmos: preferences.sectionGizmos !== false,
    rotationGizmo: preferences.rotationGizmo !== false,
    orbitStyle: ['turntable', 'free'].includes(preferences.orbitStyle) ? preferences.orbitStyle : 'turntable',
    orbitPivot: ['target','origin','model'].includes(preferences.orbitPivot) ? preferences.orbitPivot : 'target',
    movementSpeed: Number.isFinite(Number(preferences.movementSpeed)) ? Math.min(4, Math.max(0.25, Number(preferences.movementSpeed))) : 1,
    lookSpeed: Number.isFinite(Number(preferences.lookSpeed)) ? Math.min(3, Math.max(0.25, Number(preferences.lookSpeed))) : 1,
    invertLook: preferences.invertLook === true,
    hoverHighlights: preferences.hoverHighlights !== false,
    measurementColor: validColor(preferences.measurementColor, '#ff4f9a'),
    measurementPointSize: Number.isFinite(Number(preferences.measurementPointSize)) ? Math.min(3, Math.max(0.5, Number(preferences.measurementPointSize))) : 1.5,
    selectionColor: validColor(preferences.selectionColor, '#66ff99'),
    selectionMode: ['part', 'face', 'loop'].includes(preferences.selectionMode) ? preferences.selectionMode : 'face',
    sectionAxes: { x: false, y: false, z: false },
    sectionRanges: { x: [0, 1], y: [0, 1], z: [0, 1] },
    viewSection: true,
    viewSectionPosition: preferences.viewSectionPosition ?? 0.5,
    viewSectionDistance: Math.max(0, Number(preferences.viewSectionDistance) || 0),
    viewSectionFlip: false,
    snap: preferences.snap !== false,
    stlUnit: ['mm', 'cm', 'm', 'in'].includes(preferences.stlUnit) ? preferences.stlUnit : 'mm',
  };
  for (const axis of ['x', 'y', 'z']) {
    state.sectionAxes[axis] = preferences.sectionAxes?.[axis] === true;
    const saved = preferences.sectionRanges?.[axis];
    if (Array.isArray(saved) && saved.length === 2 && saved.every(value => Number.isFinite(value))) state.sectionRanges[axis] = [Math.max(0, Math.min(1, saved[0])), Math.max(0, Math.min(1, saved[1]))].sort((a, b) => a - b);
  }
  state.viewSection = true;
  state.viewSectionPosition = Number.isFinite(preferences.viewSectionPosition) ? Math.max(0, Math.min(1, preferences.viewSectionPosition)) : 0.5;
  state.viewSectionFlip = preferences.viewSectionFlip === true;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x101820);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x78909c, 2.2));
  const light = new THREE.DirectionalLight(0xffffff, 2.7); light.position.set(1, -2, 4); scene.add(light);
  const fill = new THREE.DirectionalLight(0xb9dfff, 1.4); fill.position.set(-3, 1, 1.5); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1d2, 0.8); rim.position.set(1, 3, -2); scene.add(rim);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 100000);
  camera.up.set(0, 0, 1); camera.position.set(2, -3, 2);
  const controls = createCadNavigation({ camera, stage, getState:()=>state, getRadius:()=>radius, getBounds:()=>bounds, onError:message=>{ status.textContent=message; } });
  const gridGroup = new THREE.Group();
  function gridPlane(color) {
    return new THREE.Mesh(new THREE.PlaneGeometry(2,2),new THREE.ShaderMaterial({
      transparent:true,depthWrite:false,side:THREE.DoubleSide,
      uniforms:{color:{value:new THREE.Color(color)},step:{value:1},span:{value:1},center:{value:new THREE.Vector2()},fade:{value:false},lines:{value:state.gridLines},fill:{value:state.gridFill}},
      // Orthographic reference planes continue across the near/far boundaries.
      // Clamp depth only: world-space coordinates and line spacing stay intact.
      vertexShader:`varying vec2 gridPoint;varying float gridDepth; void main(){ gridPoint=position.xy; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); gridDepth=gl_Position.z/gl_Position.w; gl_Position.z=clamp(gl_Position.z,-gl_Position.w*0.99999,gl_Position.w*0.99999); }`,
      fragmentShader:`uniform vec3 color;uniform float step;uniform float span;uniform vec2 center;uniform bool fade;uniform bool lines;uniform bool fill;varying vec2 gridPoint;varying float gridDepth;
        void main(){vec2 cell=(gridPoint*span+center)/step;vec2 width=max(fwidth(cell),vec2(0.00001));vec2 edge=abs(fract(cell-0.5)-0.5)/width;
        float line=1.0-min(min(edge.x,edge.y),1.0);float alpha=lines?line*0.22*(1.0-smoothstep(0.5,2.0,max(width.x,width.y))):0.0;
        if(fill)alpha=max(alpha,0.035);
        if(fade)alpha*=1.0-smoothstep(0.22,0.48,length(gridPoint));if(alpha<0.004)discard;gl_FragDepth=clamp(gridDepth*0.5+0.5,0.00001,0.99999);gl_FragColor=vec4(color,alpha);}`,
    }));
  }
  const gridXY=gridPlane(0x5b94ff),gridXZ=gridPlane(0x54e681),gridYZ=gridPlane(0xff5b5b);
  gridXZ.rotation.x=Math.PI/2;gridYZ.rotation.y=Math.PI/2;
  gridGroup.add(gridXY, gridXZ, gridYZ); scene.add(gridGroup);
  const axes = new THREE.AxesHelper(1); scene.add(axes);
  const coordinateLabels = new THREE.Group(); scene.add(coordinateLabels);
  const tickOcclusion = new THREE.Raycaster();
  const sectionGizmo = new THREE.Group(); scene.add(sectionGizmo);
  const sectionPlanes = [];
  const rotationGizmo = document.createElement('div'); rotationGizmo.className = 'cad-rotation-gizmo'; rotationGizmo.setAttribute('aria-label', 'View axes');
  const rotationCenter = document.createElement('span'); rotationCenter.className = 'cad-axis-center'; rotationGizmo.append(rotationCenter);
  for (const [axis, positive, negative] of [['x', 'right', 'left'], ['y', 'back', 'front'], ['z', 'top', 'bottom']]) {
    for (const [sign, view] of [[1, positive], [-1, negative]]) {
      const arm = document.createElement('span'); arm.className = `cad-axis-arm cad-axis-${axis}`; arm.dataset.sign = sign; rotationGizmo.append(arm);
      const axisButton = document.createElement('button'); axisButton.type = 'button'; axisButton.className = `cad-axis-button cad-axis-${axis}`; axisButton.dataset.sign = sign;
      axisButton.textContent = `${sign < 0 ? '−' : ''}${axis.toUpperCase()}`; axisButton.title = `${view[0].toUpperCase() + view.slice(1)} view`; axisButton.setAttribute('aria-label', axisButton.title);
      axisButton.onclick = event => { event.stopPropagation(); if (!gizmoDragMoved) orient(view); };
      rotationGizmo.append(axisButton);
    }
  }
  let gizmoDrag, gizmoDragMoved = false;
  rotationGizmo.addEventListener('pointerdown', event => { event.stopPropagation(); gizmoDrag = { id:event.pointerId, x:event.clientX, y:event.clientY }; gizmoDragMoved = false; rotationGizmo.setPointerCapture(event.pointerId); });
  rotationGizmo.addEventListener('pointermove', event => {
    if (!gizmoDrag || gizmoDrag.id !== event.pointerId) return;
    const dx = event.clientX - gizmoDrag.x, dy = event.clientY - gizmoDrag.y;
    if (!gizmoDragMoved && Math.hypot(dx, dy) < 3) return;
    gizmoDragMoved = true; gizmoDrag.x = event.clientX; gizmoDrag.y = event.clientY;
    controls.orbit(dx,dy);
  });
  rotationGizmo.addEventListener('pointerup', event => {
    if (gizmoDrag?.id !== event.pointerId) return;
    if (!gizmoDragMoved) {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.cad-axis-button');
      if (target) { const axis = ['x','y','z'].find(value => target.classList.contains(`cad-axis-${value}`)); const sign = Number(target.dataset.sign); orient(({x:sign > 0 ? 'right':'left', y:sign > 0 ? 'back':'front',z:sign > 0 ? 'top':'bottom'})[axis]); }
    }
    gizmoDrag = undefined;
  });
  rotationGizmo.addEventListener('pointercancel', () => { gizmoDrag = undefined; });
  stage.append(rotationGizmo);
  let controlHost = toolbar;
  const menus = [];
  function persist() { savePreferences({ ...state }); }
  function button(text, action, title = text) {
    const value = document.createElement('button'); value.type = 'button'; value.title = title;
    buttonIcon(value, ({ Fit: 'Maximize', Clear: 'X', Reload: 'RefreshCw', 'Show all': 'Layers' })[text] || 'Settings', text, controlHost === toolbar);
    value.addEventListener('click', action); controlHost.append(value); return value;
  }
  function select(label, options, value, action) {
    const element = document.createElement('select'); element.setAttribute('aria-label', label);
    for (const [key, title] of options) { const option = document.createElement('option'); option.value = key; option.textContent = title; element.append(option); }
    if (label === 'CAD display mode') for (const [key,title] of [['edges','Shaded + edges'],['wireframe','Wireframe']]) { const option = document.createElement('option'); option.value = key; option.textContent = title; option.hidden = true; element.append(option); }
    element.value = value; element.addEventListener('change', () => action(element.value));
    if (controlHost === toolbar) controlHost.append(element);
    else {
      const wrapper = document.createElement('label'); wrapper.className = 'ui-field';
      const title = document.createElement('span'); title.textContent = label.replace(/^CAD /, '');
      wrapper.append(title, element); controlHost.append(wrapper);
    }
    return element;
  }
  function checkbox(label, checked, action) {
    const wrapper = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox'; input.setAttribute('aria-label', label); input.checked = checked; input.addEventListener('change', () => action(input.checked));
    wrapper.className = 'ui-check'; wrapper.append(input, document.createTextNode(` ${label}`)); controlHost.append(wrapper); return input;
  }
  function small(text) { const value = document.createElement('small'); value.textContent = text; controlHost.append(value); return value; }
  function numberField(label, value, { min, max, step = 'any' } = {}, action) {
    const wrapper = document.createElement('label'); wrapper.className = 'ui-field';
    const title = document.createElement('span'); title.textContent = label;
    const input = document.createElement('input'); input.type = 'number'; input.value = String(rounded(value)); input.step = step;
    if (min !== undefined) input.min = min; if (max !== undefined) input.max = max;
    input.addEventListener('input', () => { if (input.value !== '' && !input.validity.badInput) action(input.value); });
    input.addEventListener('wheel', event => { if (document.activeElement !== input) return; event.preventDefault(); event.deltaY < 0 ? input.stepUp() : input.stepDown(); input.dispatchEvent(new Event('input')); }, { passive: false });
    wrapper.append(title, input); controlHost.append(wrapper); return input;
  }
  function colorField(label, value, action) {
    const wrapper = document.createElement('label'); wrapper.className = 'ui-field';
    const title = document.createElement('span'); title.textContent = label;
    const input = document.createElement('input'); input.type = 'color'; input.value = value; input.addEventListener('input', () => action(input.value));
    wrapper.append(title, input); controlHost.append(wrapper); return input;
  }
  button('Fit', () => fit());
  const displayMenu = createMenu('Display', { iconName: 'Box', role: 'dialog' });
  menus.push(displayMenu); toolbar.append(displayMenu.element); controlHost = displayMenu.panel;
  const displaySelect = select('CAD display mode', [['flat', 'Flat'], ['zebra', 'Zebra'], ['shaded', 'Shaded']], state.mode, value => { state.mode = value; applyStyle(); persist(); });
  const opacityInput = document.createElement('input'); opacityInput.type = 'range'; opacityInput.min = '5'; opacityInput.max = '100'; opacityInput.value = String(state.opacity * 100); opacityInput.setAttribute('aria-label', 'Model opacity');
  const opacityLabel = document.createElement('label'); opacityLabel.className = 'ui-field'; opacityLabel.append(document.createTextNode('Opacity'), opacityInput); controlHost.append(opacityLabel);
  opacityInput.oninput = () => { state.opacity = Number(opacityInput.value) / 100; applyStyle(); persist(); };
  const edgesToggle = checkbox('Edges', state.showEdges, value => { state.showEdges = value; applyStyle(); persist(); });
  const pointsToggle = checkbox('Points', state.showPoints, value => { state.showPoints = value; applyStyle(); persist(); });
  controlHost = sections;
  menuHeading(controlHost, 'Axis sections');
  const sectionControls = {};
  for (const axis of ['x', 'y', 'z']) {
    const row = document.createElement('div'); row.className = `cad-section-row cad-section-${axis}`;
    const axisLabel = document.createElement('span'); axisLabel.className = 'cad-section-axis'; axisLabel.textContent = axis.toUpperCase(); row.append(axisLabel);
    const ranges = document.createElement('div'); ranges.className = 'cad-dual-range';
    const low = document.createElement('input'), high = document.createElement('input');
    for (const input of [low, high]) { input.type = 'range'; input.min = '0'; input.max = '1000'; input.step = '1'; ranges.append(input); }
    low.setAttribute('aria-label', `${axis.toUpperCase()} section minimum`); high.setAttribute('aria-label', `${axis.toUpperCase()} section maximum`);

    const lowNumber = document.createElement('input'), highNumber = document.createElement('input');
    for (const input of [lowNumber, highNumber]) { input.type = 'number'; input.step = 'any'; }
    lowNumber.setAttribute('aria-label', `${axis.toUpperCase()} section minimum coordinate`); highNumber.setAttribute('aria-label', `${axis.toUpperCase()} section maximum coordinate`);
    row.append(lowNumber, ranges, highNumber); controlHost.append(row);
    sectionControls[axis] = { low, high, lowNumber, highNumber };
    low.oninput = () => setSectionRange(axis, 0, Number(low.value) / 1000);
    high.oninput = () => setSectionRange(axis, 1, Number(high.value) / 1000);
    let rangeDrag;
    const largeRange = () => matchMedia('(pointer:coarse),(max-width:760px)').matches;
    const fractionAt = event => { const rect = ranges.getBoundingClientRect(), inset = largeRange() ? 13 : 6.5; return Math.max(0,Math.min(1,(event.clientX-rect.left-inset)/Math.max(1,rect.width-inset*2))); };
    ranges.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen' && !largeRange()) return;
      event.preventDefault(); const fraction = fractionAt(event), values = state.sectionRanges[axis];
      rangeDrag = { id:event.pointerId, start:fraction, end:Math.abs(values[1]-values[0])<0.03 && Math.abs(fraction-values[0])<0.06 ? null : Math.abs(fraction-values[0]) < Math.abs(fraction-values[1]) ? 0 : 1 };
      ranges.setPointerCapture(event.pointerId);
      if(rangeDrag.end!==null) { (rangeDrag.end===0?low:high).focus({preventScroll:true}); setSectionRange(axis,rangeDrag.end,fraction); }
    });
    ranges.addEventListener('pointermove', event => { if (rangeDrag?.id === event.pointerId) { event.preventDefault(); const fraction=fractionAt(event);if(rangeDrag.end===null)rangeDrag.end=fraction<rangeDrag.start?0:1;setSectionRange(axis,rangeDrag.end,fraction); } });
    const stopRange = () => { rangeDrag = null; }; ranges.addEventListener('pointerup',stopRange); ranges.addEventListener('pointercancel',stopRange); ranges.addEventListener('lostpointercapture',stopRange);

    lowNumber.oninput = () => { if(lowNumber.value !== '' && !lowNumber.validity.badInput) setSectionCoordinate(axis,0,Number(lowNumber.value)); };
    highNumber.oninput = () => { if(highNumber.value !== '' && !highNumber.validity.badInput) setSectionCoordinate(axis,1,Number(highNumber.value)); };
    lowNumber.onblur = highNumber.onblur = () => syncSectionControls();
    for (const input of [lowNumber, highNumber]) input.addEventListener('wheel', event => { if (document.activeElement !== input) return; event.preventDefault(); event.deltaY < 0 ? input.stepUp() : input.stepDown(); input.dispatchEvent(new Event('input')); }, { passive: false });
  }
  menuHeading(controlHost, 'View plane');
  const viewSectionRow = document.createElement('div'); viewSectionRow.className = 'cad-view-section-row';
  const viewSectionNumber = document.createElement('input'); viewSectionNumber.type = 'number'; viewSectionNumber.step = 'any'; viewSectionNumber.setAttribute('aria-label','Distance from camera');
  viewSectionNumber.oninput = () => { if(viewSectionNumber.value !== '' && !viewSectionNumber.validity.badInput) setViewSectionCoordinate(Number(viewSectionNumber.value)); };
  viewSectionNumber.onblur = () => syncSectionControls();
  viewSectionNumber.addEventListener('wheel',event => { if(document.activeElement !== viewSectionNumber) return; event.preventDefault(); event.deltaY < 0 ? viewSectionNumber.stepUp() : viewSectionNumber.stepDown(); viewSectionNumber.dispatchEvent(new Event('input')); },{passive:false});
  const viewSectionRange = document.createElement('input'); viewSectionRange.type = 'range'; viewSectionRange.min = '0'; viewSectionRange.max = '1000'; viewSectionRange.value = '0'; viewSectionRange.setAttribute('aria-label', 'View section position');
  viewSectionRange.oninput = () => { state.viewSectionDistance = minimumViewDistance() + Number(viewSectionRange.value) / 1000 * (viewProjection.max - minimumViewDistance()); applySection(); persist(); };
  const viewSectionEnd = document.createElement('span'); viewSectionEnd.className = 'cad-view-section-end'; viewSectionEnd.setAttribute('aria-hidden','true');
  viewSectionRow.append(viewSectionNumber,viewSectionRange,viewSectionEnd); controlHost.append(viewSectionRow);
  const viewSectionFlip = checkbox('Flip view section', state.viewSectionFlip, value => { state.viewSectionFlip = value; applySection(); persist(); });
  button('Reset', () => { for (const axis of ['x', 'y', 'z']) state.sectionRanges[axis] = [0, 1]; state.viewSectionDistance = minimumViewDistance(); state.viewSectionFlip = false; syncSectionControls(); applySection(); persist(); }, 'Reset sections');


  const sidebar = new DockSidebar(layout, { content: stage, tabs: [{ id:'sections', title:'Sections', element:sections }, { id:'parts', title:'Parts', element:parts }, { id:'selection', title:'Selection', element:selectionPanel }], side:preferences.sidebar?.side || 'right', size:preferences.sidebar?.size || 280, collapsed:preferences.sidebar?.collapsed === true, layout:preferences.sidebar?.layout, onChange: value => { state.sidebar = value; persist(); resize(); } });
  state.sidebar = sidebar.snapshot();
  const sidebarHandle = document.createElement('button'); sidebarHandle.type = 'button'; sidebarHandle.className = 'cad-sidebar-handle';
  function syncSidebarHandle() { sidebarHandle.setAttribute('aria-label',sidebar.collapsed ? 'Open sidebar' : 'Close sidebar'); sidebarHandle.setAttribute('aria-expanded',String(!sidebar.collapsed)); sidebarHandle.textContent = sidebar.collapsed ? '‹' : '›'; }
  sidebarHandle.onpointerdown = event => event.stopPropagation();
  sidebarHandle.onclick = event => { event.stopPropagation(); sidebar.setCollapsed(!sidebar.collapsed); syncSidebarHandle(); }; syncSidebarHandle(); stage.append(sidebarHandle);

  const optionsMenu = createMenu('CAD options', { iconName: 'SlidersHorizontal', role: 'dialog' });
  menus.push(optionsMenu); toolbar.append(optionsMenu.element);
  controlHost = optionsMenu.panel;
  menuHeading(controlHost, 'Appearance');
  const gridSelect = select('Grid planes', [['off', 'Grid: off'], ['xy', 'Grid: XY'], ['all', 'Grid: XY / XZ / YZ']], state.gridPlanes, value => { state.gridPlanes = value; state.grid = value !== 'off'; gridToggle.checked = state.grid; updateHelpers(); persist(); });
  const gridToggle = checkbox('Grid', state.gridPlanes !== 'off', value => { state.gridPlanes = value ? (gridSelect.value === 'off' ? 'all' : gridSelect.value) : 'off'; state.grid = value; gridSelect.value = state.gridPlanes; updateHelpers(); persist(); });
  const gridLinesToggle = checkbox('Grid lines', state.gridLines, value => { state.gridLines = value; updateHelpers(); persist(); });
  const gridFillToggle = checkbox('Grid fill', state.gridFill, value => { state.gridFill = value; updateHelpers(); persist(); });
  const axisCoordinatesToggle = checkbox('Grid tick marks', state.axisCoordinates, value => { state.axisCoordinates = value; updateHelpers(); persist(); });
  const infiniteGridToggle = checkbox('Infinite grids', state.infiniteGrid, value => { state.infiniteGrid = value; updateHelpers(); persist(); });
  const sectionGizmoToggle = checkbox('Section gizmos', state.sectionGizmos, value => { state.sectionGizmos = value; updateSectionGizmo(); persist(); });
  const rotationGizmoToggle = checkbox('Rotation gizmo', state.rotationGizmo, value => { state.rotationGizmo = value; updateRotationGizmo(); persist(); });
  const gizmoSizeInput = numberField('Gizmo size', state.gizmoSize, { min:64, max:180, step:4 }, value => { state.gizmoSize = Math.max(64,Math.min(180,Number(value)||96)); updateRotationGizmo(); persist(); });
  const sidebarSide = select('Sidebar side', [['left','Left'],['right','Right'],['top','Top'],['bottom','Bottom']], state.sidebar.side, value => sidebar.setSide(value));
  const hoverToggle = checkbox('Hover highlights', state.hoverHighlights, value => { state.hoverHighlights = value; if (!value) clearHover(); persist(); });
  menuHeading(controlHost, 'Camera');
  const orbitSelect = select('Orbit style', [['turntable', 'Turntable'], ['free', 'Free orbit']], state.orbitStyle, value => { state.orbitStyle = value; updateNavigation(); persist(); });
  const orbitPivotSelect = select('Orbit center', [['target','View center'],['origin','Origin'],['model','Model center']], state.orbitPivot, value => { state.orbitPivot=value; persist(); });
  const movementSpeedInput = numberField('Movement speed', state.movementSpeed, { min: 0.25, max: 4, step: 0.25 }, value => { state.movementSpeed = Math.min(4, Math.max(0.25, Number(value) || 1)); persist(); });
  const speedModifierInput = numberField('Speed factor', state.speedModifier, { min:1, max:20, step:1 }, value => { state.speedModifier = Math.max(1,Math.min(20,Number(value)||4)); persist(); });
  const lookSpeedInput = numberField('Look sensitivity', state.lookSpeed, { min: 0.25, max: 3, step: 0.25 }, value => { state.lookSpeed = Math.min(3, Math.max(0.25, Number(value) || 1)); persist(); });
  const invertLookToggle = checkbox('Invert look', state.invertLook, value => { state.invertLook = value; persist(); });
  menuHeading(controlHost, 'Units');
  const decimalPlacesInput = numberField('Decimal places',state.decimalPlaces ?? 3,{min:0,max:10,step:1},value => { state.decimalPlaces = Math.max(0,Math.min(10,Math.round(Number(value)||0))); updateStats(); updateHelpers(); syncSectionControls(); showMeasurement(); persist(); });
  const unitSelect = select('Measurement units', [['mm', 'mm'], ['cm', 'cm'], ['in', 'in']], state.unit, value => { state.unit = value; updateStats(); updateHelpers(); syncSectionControls(); showMeasurement(); persist(); });
  const stlUnitSelect = /\.stl$/i.test(path) ? select('STL source units', [['mm', 'STL: mm'], ['cm', 'STL: cm'], ['m', 'STL: m'], ['in', 'STL: in']], state.stlUnit, value => {
    state.stlUnit = value;
    if (model) { clearHover(); clearSelection(); model.scale.setScalar({ mm: 1, cm: 10, m: 1000, in: 25.4 }[value]); updateBounds(); fit(); }
    persist();
  }) : null;
  menuHeading(controlHost, 'Annotations');
  const measurementColor = colorField('Measurement color', state.measurementColor, value => { state.measurementColor = value; refreshAnnotationStyle(); persist(); });
  const measurementPointSize = numberField('Measurement point size', state.measurementPointSize, { min: 0.5, max: 3, step: 0.1 }, value => { state.measurementPointSize = Math.min(3, Math.max(0.5, Number(value) || 1.5)); refreshAnnotationStyle(); persist(); });
  const selectionColor = colorField('Selection color', state.selectionColor, value => { state.selectionColor = value; refreshAnnotationStyle(); persist(); });
  menuHeading(controlHost, 'Live preview');
  const liveToggle = checkbox('Live reload', state.live, value => { state.live = value; updateLiveIndicator(); persist(); });
  const reloadIntervalSelect = select('CAD reload interval', [['500', '0.5 s'], ['1000', '1 s'], ['2000', '2 s'], ['5000', '5 s']], String(state.interval), value => { state.interval = Number(value); persist(); });
  button('Reload', () => reload());
  controlHost = toolbar;
  function updateLiveIndicator() {
    optionsMenu.trigger.classList.toggle('live-enabled', state.live);
    optionsMenu.trigger.title = `CAD options · live reload ${state.live ? 'on' : 'paused'}`;
  }
  updateLiveIndicator();
  const selection = createCadSelection({ scene, camera, stage, root, results:measurement, getMeshes:()=>meshes, getState:()=>state, getRadius:()=>radius, getSectionPlanes:()=>sectionPlanes, focusSelection:fitBounds, render });
  function stopMovement() { controls.stop(); }
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') { clearSelection(); stopMovement(); }
    if (event.target === stage && matchesKeybind('cad.fit', event)) { event.preventDefault(); fit(); }
  });
  function render() {
    if (disposed || !renderer || !stage.clientWidth || !stage.clientHeight) return;
    updateAxisTicks();
    if (bounds && coordinateLabels.visible) {
      // Keep labels outside the projected model even with a translucent model.
      // A conservative box test avoids raycasting every triangle on mobile.
      const right = new THREE.Vector3(1,0,0).applyQuaternion(camera.quaternion), up = new THREE.Vector3(0,1,0).applyQuaternion(camera.quaternion);
      for (const label of coordinateLabels.children.filter(object=>object.isSprite)) label.visible = ![[0,0],[-.5,-.5],[-.5,.5],[.5,-.5],[.5,.5]].some(([x,y])=>{
        const point=label.position.clone().addScaledVector(right,x*label.scale.x).addScaledVector(up,y*label.scale.y).project(camera);
        tickOcclusion.setFromCamera(new THREE.Vector2(point.x,point.y),camera);return !!tickOcclusion.ray.intersectBox(bounds,new THREE.Vector3());
      });
    }
    renderer.render(scene, camera);
    updateRotationGizmo();
  }
  function resize() {
    if (!renderer || disposed) return;
    const width = stage.clientWidth, height = stage.clientHeight;
    if (!width || !height) return;
    const aspect = width / height;
    camera.left = -radius * aspect; camera.right = radius * aspect; camera.top = radius; camera.bottom = -radius;
    camera.updateProjectionMatrix(); renderer.setSize(width, height, false); render();
  }
  controls.addEventListener('change', () => { if (state.viewSection) applySection(); else render(); });
  function fit() {
    if (!bounds) return;
    const center = bounds.getCenter(new THREE.Vector3());
    const direction = camera.position.clone().sub(controls.target).normalize();
    const extent = bounds.getSize(new THREE.Vector3()).length();
    radius = Math.max(extent * 0.65, 0.01);
    camera.position.copy(center).addScaledVector(direction, radius * 3);
    camera.zoom = Math.min(1, stage.clientWidth / Math.max(1, stage.clientHeight));
    camera.near = Math.max(radius / 10000, 0.000001); camera.far = radius * 1000;
    controls.target.copy(center); controls.update(); resize();
  }
  function fitBounds(box) {
    if (!box || box.isEmpty()) return;
    const center=box.getCenter(new THREE.Vector3()), size=box.getSize(new THREE.Vector3());
    const direction=camera.position.clone().sub(controls.target).normalize();
    const extent=Math.max(size.length(), radius*.04, .001);
    controls.target.copy(center); camera.position.copy(center).addScaledVector(direction, Math.max(extent*2, radius*.25));
    const aspect=Math.max(.1,stage.clientWidth/Math.max(1,stage.clientHeight));
    camera.zoom=Math.min(1e6, Math.min(1,aspect)*radius/(extent*.65));
    camera.updateProjectionMatrix(); controls.update(); resize();
  }
  function orient(direction) {
    const directions = { iso: [2, -3, 2], front: [0, -1, 0], back: [0, 1, 0], top: [0, 0, 1], bottom: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0] };
    camera.up.set(0,0,1);
    if(direction==='top')camera.up.set(0,1,0);else if(direction==='bottom')camera.up.set(0,-1,0);
    camera.position.copy(controls.target).add(new THREE.Vector3(...directions[direction]).normalize().multiplyScalar(radius * 3));
    controls.update(); resize();
  }
  function updateBounds() {
    model.updateMatrixWorld(true);
    bounds = new THREE.Box3().setFromObject(model);
    if (bounds.isEmpty() || !Number.isFinite(bounds.min.length() + bounds.max.length())) throw Error('Model has no finite geometry.');
    const size = bounds.getSize(new THREE.Vector3()).length() || 1;
    axes.scale.setScalar(size * 0.3); axes.position.copy(bounds.min);
    updateHelpers(); updateStats(); syncSectionControls(); applySection();
  }
  function rounded(value) { return Number(Number(value).toFixed(state.decimalPlaces ?? 3)) || 0; }
  function positiveDistanceInput(value) { const display = rounded(value); return display > 0 ? String(display) : value.toExponential(state.decimalPlaces ?? 3).replace(/\.?0+e/, 'e'); }
  function number(value) { return rounded(value).toLocaleString(undefined, { maximumFractionDigits: state.decimalPlaces ?? 3 }); }
  function unitScale() { return { mm: 1, cm: 10, in: 25.4 }[state.unit]; }
  function updateStats() {
    if (!bounds) return;
    const size = bounds.getSize(new THREE.Vector3()).divideScalar(unitScale());
    const triangles = meshes.reduce((total, mesh) => total + (mesh.geometry.index?.count || mesh.geometry.attributes.position.count) / 3, 0);
    stats.textContent = `Bounds X ${number(size.x)} × Y ${number(size.y)} × Z ${number(size.z)} ${state.unit} · ${meshes.length} meshes · ${number(triangles)} triangles`;
  }
  function applyStyle() {
    for (const mesh of meshes) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      material.userData.cadBaseOpacity ??= material.opacity;
      material.userData.cadBaseTransparent ??= material.transparent;
      material.wireframe = state.mode === 'wireframe'; material.flatShading = state.mode === 'flat';
      material.opacity = state.opacity * material.userData.cadBaseOpacity;
      material.transparent = material.userData.cadBaseTransparent || material.opacity < 1;
      material.depthWrite = material.opacity >= 1;
      material.onBeforeCompile = shader => {
        if (state.mode !== 'zebra') return;
        let normal = 'normal';
        // Unlit glTF materials have no fragment normal. Supply one from the
        // repaired geometry so zebra inspection also works on those models.
        if (material.isMeshBasicMaterial) {
          normal = 'vCadNormal';
          shader.vertexShader = `varying vec3 vCadNormal;\n${shader.vertexShader}`.replace('#include <begin_vertex>', '#include <begin_vertex>\nvCadNormal = normalMatrix * normal;');
          shader.fragmentShader = `varying vec3 vCadNormal;\n${shader.fragmentShader}`;
        }
        shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
          float stripe = smoothstep(0.42, 0.58, sin(dot(normalize(${normal}), normalize(vec3(0.3,0.8,0.5))) * 55.0) * 0.5 + 0.5);
          outgoingLight = mix(vec3(0.035), vec3(0.95), stripe);
          #include <opaque_fragment>`);
      };
      material.customProgramCacheKey = () => `cad-${state.mode}`;
      material.needsUpdate = true;
    }
    for (const line of edgeLines) line.visible = state.showEdges;
    for (const points of pointClouds) points.visible = state.showPoints;
    render();
  }
  function clearGroup(group) {
    for (const child of [...group.children]) { group.remove(child); disposeObject(child); }
  }
  function labelSprite(text, color) {
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 64;
    const context = canvas.getContext('2d'); context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = '400 48px system-ui, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
    context.fillStyle = color; context.fillText(text, 128, 32);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: true, depthWrite: false, transparent:true, opacity:0.48 }));
    const helperRadius = bounds ? Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.65, 0.01) : radius;
    sprite.scale.set(helperRadius * 0.42, helperRadius * 0.105, 1); sprite.renderOrder = 0; return sprite;
  }
  let tickKey = '';
  function updateAxisTicks() {
    if (!bounds || !stage.clientHeight || !stage.clientWidth) return;
    const pixel = radius * 2 / camera.zoom / stage.clientHeight;
    // Density follows the shorter screen dimension, including portrait phones.
    const shortSide = Math.min(stage.clientWidth,stage.clientHeight);
    const spacing = Math.max(42,Math.min(90,shortSide / 5));
    const ideal = Math.max(pixel * spacing / unitScale(),1e-12), magnitude = 10 ** Math.floor(Math.log10(ideal));
    const step = [1,2,5,10].find(value => value*magnitude >= ideal) * magnitude * unitScale();
    const span = Math.max(stage.clientWidth,stage.clientHeight)*pixel;
    const extent = state.infiniteGrid ? span*2 : Math.max(bounds.getSize(new THREE.Vector3()).length(),step*2);
    const center = state.infiniteGrid ? controls.target : bounds.getCenter(new THREE.Vector3());
    const key = [step,pixel.toPrecision(3),state.unit,state.decimalPlaces,state.infiniteGrid,extent,...center.toArray(),...camera.quaternion.toArray()].join(':');
    if (key === tickKey) return;
    tickKey = key; clearGroup(coordinateLabels);
    coordinateLabels.userData.step = step/unitScale(); coordinateLabels.userData.tickCount = 0;
    gridGroup.userData.step = step/unitScale(); gridGroup.userData.extent = extent;
    const right = new THREE.Vector3(1,0,0).applyQuaternion(camera.quaternion), up = new THREE.Vector3(0,1,0).applyQuaternion(camera.quaternion), forward = viewNormal();
    for (const [grid,a,b,normal] of [[gridXY,'x','y','z'],[gridXZ,'x','z','y'],[gridYZ,'z','y','x']]) {
      // Intersect the orthographic viewport with each plane. A fixed multiple
      // of screen width truncates the grid when viewed at a grazing angle.
      const planeCenter=center.clone();planeCenter[normal]=bounds.min[normal];
      let planeSpan=extent;
      if(state.infiniteGrid && Math.abs(forward[normal])>1e-7) {
        const footprint=new THREE.Box3();
        for(const x of [camera.left,camera.right])for(const y of [camera.bottom,camera.top]) {
          const origin=camera.position.clone().addScaledVector(right,x/camera.zoom).addScaledVector(up,y/camera.zoom);
          footprint.expandByPoint(origin.addScaledVector(forward,(bounds.min[normal]-origin[normal])/forward[normal]));
        }
        footprint.getCenter(planeCenter);planeCenter[normal]=bounds.min[normal];
        planeSpan=Math.max(footprint.max[a]-footprint.min[a],footprint.max[b]-footprint.min[b],step*2)*2;
      } else if(state.infiniteGrid) planeSpan=span*16;
      grid.scale.setScalar(planeSpan);grid.position.copy(planeCenter);
      const uniforms=grid.material.uniforms;uniforms.step.value=step;uniforms.span.value=planeSpan;
      uniforms.center.value.set(planeCenter[a]*(grid===gridYZ?-1:1),planeCenter[b]);uniforms.fade.value=state.infiniteGrid;
    }
    if (!state.axisCoordinates || state.gridPlanes === 'off') return;
    const fontSize = Math.max(10,Math.min(13,shortSide/32)), origin = bounds.min.clone();
    // Tick labels sit along the outer model corner and obey the model depth buffer.
    origin.addScalar(-pixel*12);
    for (const [axis,color] of [['x','#ff6b6b'],['y','#63e690'],['z','#68a9ff']]) {
      if (state.gridPlanes === 'xy' && axis === 'z') continue;
      const vertices = [], min = state.infiniteGrid ? controls.target[axis]-span*.55 : bounds.min[axis], max = state.infiniteGrid ? controls.target[axis]+span*.55 : bounds.max[axis];
      const first=Math.ceil(min/step),last=Math.floor(max/step),stride=Math.max(1,Math.ceil((last-first+1)/32));
      for(let tick=first;tick<=last;tick+=stride) {
        coordinateLabels.userData.tickCount++;
        const position=origin.clone();position[axis]=tick*step;
        const offset=new THREE.Vector3(axis==='x'?0:1,axis==='x'?1:0,0);
        vertices.push(position.clone().addScaledVector(offset,-pixel*2),position.clone().addScaledVector(offset,pixel*2));
        const value=tick*step/unitScale(),label=labelSprite(number(value),color);
        label.scale.set(pixel*fontSize*16/3,pixel*fontSize*4/3,1);label.position.copy(position).addScaledVector(offset,-pixel*10);coordinateLabels.add(label);
      }
      const line=new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(vertices),new THREE.LineBasicMaterial({color,transparent:true,opacity:.35,depthWrite:false}));coordinateLabels.add(line);
    }
  }
  function updateHelpers() {
    gridXY.visible = state.gridPlanes === 'xy' || state.gridPlanes === 'all';
    gridXZ.visible = gridYZ.visible = state.gridPlanes === 'all';
    axes.visible = state.gridPlanes !== 'off';
    for (const grid of [gridXY,gridXZ,gridYZ]) { grid.material.uniforms.lines.value = state.gridLines; grid.material.uniforms.fill.value = state.gridFill; }
    coordinateLabels.visible = state.axisCoordinates; tickKey = ''; clearGroup(coordinateLabels);
    updateSectionGizmo(); render();
  }
  function axisCoordinate(axis, fraction) { return bounds ? bounds.min[axis] + (bounds.max[axis] - bounds.min[axis]) * fraction : 0; }
  function setSectionRange(axis, end, fraction) {
    if (!Number.isFinite(fraction)) return;
    const values = state.sectionRanges[axis];
    values[end] = Math.max(0, Math.min(1, fraction));
    if (end === 0 && values[0] > values[1]) values[1] = values[0];
    if (end === 1 && values[1] < values[0]) values[0] = values[1];
    syncSectionControls(); applySection(); persist();
  }
  function setSectionCoordinate(axis, end, displayValue) {
    if (!bounds || !Number.isFinite(displayValue)) return;
    const value = displayValue * unitScale(), span = bounds.max[axis] - bounds.min[axis];
    setSectionRange(axis, end, span ? (value - bounds.min[axis]) / span : 0);
  }
  function viewNormal() { return controls.target.clone().sub(camera.position).normalize(); }
  function updateViewProjection() {
    if (!bounds) return;
    const normal = viewNormal(), corners = [];
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) corners.push(normal.dot(new THREE.Vector3(x, y, z).sub(camera.position)));
    viewProjection = { min: 0, max: Math.max(0.001, ...corners) };
  }
  function minimumViewDistance() { return Math.max(camera.near * 2, bounds ? bounds.getSize(new THREE.Vector3()).length() * 0.001 : 0.01); }
  function setViewSectionCoordinate(displayValue) {
    if (!Number.isFinite(displayValue)) return;
    state.viewSectionDistance = Math.max(minimumViewDistance(), displayValue * unitScale());
    syncSectionControls(); applySection(); persist();
  }
  function syncSectionControls() {
    for (const axis of ['x', 'y', 'z']) {
      const controlsForAxis = sectionControls[axis], values = state.sectionRanges[axis];
      state.sectionAxes[axis] = values[0] > 0 || values[1] < 1;
      controlsForAxis.low.value = String(Math.round(values[0] * 1000)); controlsForAxis.high.value = String(Math.round(values[1] * 1000));
      const step = 10 ** -(state.decimalPlaces ?? 3);
      controlsForAxis.lowNumber.step = controlsForAxis.highNumber.step = String(step);
      if(document.activeElement !== controlsForAxis.lowNumber) controlsForAxis.lowNumber.value = String(rounded(axisCoordinate(axis, values[0]) / unitScale()));
      if(document.activeElement !== controlsForAxis.highNumber) controlsForAxis.highNumber.value = String(rounded(axisCoordinate(axis, values[1]) / unitScale()));
    }
    viewSectionFlip.checked = state.viewSectionFlip;
    updateViewProjection();
    const minimum = minimumViewDistance(); state.viewSectionDistance = Math.max(minimum,state.viewSectionDistance);
    const inputStep = Math.min(10 ** -(state.decimalPlaces ?? 3),10 ** Math.floor(Math.log10(minimum / unitScale())));
    viewSectionNumber.step = String(inputStep);
    viewSectionNumber.min = String(Math.max(inputStep,Math.floor(minimum / unitScale() / inputStep) * inputStep));
    viewSectionEnd.textContent = number(viewProjection.max / unitScale());
    viewSectionEnd.title = `${number(viewProjection.max / unitScale())} ${state.unit}`;
    viewSectionRange.value = String(Math.round(Math.max(0,Math.min(1,(state.viewSectionDistance - minimum) / Math.max(minimum,viewProjection.max - minimum))) * 1000));
    // Keep the automatic near-camera plane positive even below fixed precision.
    if(document.activeElement !== viewSectionNumber) viewSectionNumber.value = positiveDistanceInput(state.viewSectionDistance / unitScale());
  }
  function updateSectionGizmo() {
    clearGroup(sectionGizmo);
    sectionGizmo.visible = !!bounds && state.sectionGizmos && Object.values(state.sectionAxes).some(Boolean);
    if (!sectionGizmo.visible) return;
    const center = bounds.getCenter(new THREE.Vector3()), helperRadius = Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.65, 0.01), colors = { x: 0xff5b5b, y: 0x54e681, z: 0x5b94ff };
    for (const axis of ['x', 'y', 'z']) {
      if (!state.sectionAxes[axis]) continue;
      const positions = state.sectionRanges[axis].map(fraction => { const point = center.clone(); point[axis] = axisCoordinate(axis, fraction); return point; });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(positions), new THREE.LineBasicMaterial({ color: colors[axis], depthTest: false, transparent: true, opacity: 0.95 }));
      line.renderOrder = 15; sectionGizmo.add(line);
      for (const position of positions) {
        const handle = new THREE.Mesh(new THREE.SphereGeometry(helperRadius * 0.018, 16, 10), new THREE.MeshBasicMaterial({ color: colors[axis], depthTest: false }));
        handle.position.copy(position); handle.renderOrder = 16; sectionGizmo.add(handle);
      }
    }
  }
  function applySection(shouldRender = true) {
    for (const axis of ['x','y','z']) state.sectionAxes[axis] = state.sectionRanges[axis][0] > 0 || state.sectionRanges[axis][1] < 1;
    state.viewSection = true; state.viewSectionDistance = Math.max(minimumViewDistance(),state.viewSectionDistance);
    sectionPlanes.length = 0;
    if (bounds) {
      for (const axis of ['x', 'y', 'z']) if (state.sectionAxes[axis]) {
        const vector = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
        const low = axisCoordinate(axis, state.sectionRanges[axis][0]), high = axisCoordinate(axis, state.sectionRanges[axis][1]);
        sectionPlanes.push(new THREE.Plane(vector.clone(), -low), new THREE.Plane(vector.clone().negate(), high));
      }
      if (state.viewSection) {
        updateViewProjection();
        const value = viewNormal().dot(camera.position) + state.viewSectionDistance;
        const normal = viewNormal(); if (state.viewSectionFlip) normal.negate();
        sectionPlanes.push(new THREE.Plane(normal, state.viewSectionFlip ? value : -value));
      }
    }
    // Local material clipping keeps the reference grids, axes and gizmos intact.
    for (const mesh of meshes) mesh.traverse(object => { for (const material of object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : []) { material.clippingPlanes = sectionPlanes; } });
    syncSectionControls(); updateSectionGizmo();
    sections.dataset.active = String(sectionPlanes.length > 0);
    if (shouldRender) render();
  }
  function rebuildParts() {
    partList.replaceChildren();
    const showAll = document.createElement('button'); showAll.type = 'button'; showAll.className = 'cad-show-all';
    buttonIcon(showAll, 'Layers', 'Show all'); showAll.disabled = hiddenParts.size === 0;
    showAll.onclick = () => { hiddenParts.clear(); for (const mesh of meshes) mesh.visible = true; clearHover(); rebuildParts(); applyStyle(); };
    partList.append(showAll);
    for (const [index, mesh] of meshes.entries()) {
      const row = document.createElement('label'); const visible = document.createElement('input'); visible.type = 'checkbox'; visible.checked = mesh.visible;
      visible.onchange = () => { mesh.visible = visible.checked; if (visible.checked) hiddenParts.delete(partKey(mesh)); else hiddenParts.add(partKey(mesh)); clearSelection(); clearHover(); rebuildParts(); render(); };
      row.append(visible, document.createTextNode(` ${mesh.name || `Part ${index + 1}`}`)); partList.append(row);
    }
  }
  function clearSelection() { selection.clear(); }
  function clearHover() { selection.clearHover(); }
  function refreshAnnotationStyle() { selection.clearHover(); selection.refresh(); }
  function showMeasurement() { selection.refresh(); }
  function updateHover(event) { if (!down?.dragging) selection.hover(event); }
  function updateNavigation() {
    stage.setAttribute('aria-label', '3D model: drag to orbit, right-drag to pan, WASD to move, Q/E vertically, hold Space to pan with the pointer, wheel to zoom');
    controls.update();
  }
  function updateRotationGizmo() {
    rotationGizmo.hidden = !state.rotationGizmo;
    if (!state.rotationGizmo) return;
    rotationGizmo.style.width = rotationGizmo.style.height = `${state.gizmoSize}px`;
    const inverse = camera.quaternion.clone().invert();
    for (const [axis, vector] of [['x', new THREE.Vector3(1, 0, 0)], ['y', new THREE.Vector3(0, 1, 0)], ['z', new THREE.Vector3(0, 0, 1)]]) {
      vector.applyQuaternion(inverse);
      for (const sign of [1,-1]) {
        const diameter = Math.min(24, Math.max(16, state.gizmoSize * 0.25));
        const axial = 1-THREE.MathUtils.smoothstep(Math.hypot(vector.x, vector.y), .02, .35);
        const x = (vector.x * (state.gizmoSize * 0.35) + axial * diameter * 0.6) * sign;
        const y = (-vector.y * (state.gizmoSize * 0.35) + axial * diameter * 0.6) * sign;
        const buttonForAxis = rotationGizmo.querySelector(`button.cad-axis-${axis}[data-sign="${sign}"]`), arm = rotationGizmo.querySelector(`span.cad-axis-${axis}[data-sign="${sign}"]`);
        buttonForAxis.style.width = buttonForAxis.style.height = `${diameter}px`;
        buttonForAxis.style.transform = `translate(calc(-50% + ${x}px),calc(-50% + ${y}px))`; buttonForAxis.style.zIndex = String(Math.round((vector.z * sign + 1) * 10));
        buttonForAxis.style.opacity = String(0.65 + (vector.z * sign + 1) * 0.175);
        arm.style.width = `${Math.hypot(x, y)}px`; arm.style.transform = `rotate(${Math.atan2(y, x)}rad)`;
      }
    }
  }
  stage.addEventListener('pointerdown', event => {
    stage.focus({ preventScroll: true }); down = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, id: event.pointerId, dragging: false };
  });
  stage.addEventListener('pointermove', event => {
    if (down?.id === event.pointerId) down.dragging ||= Math.hypot(event.clientX-down.x,event.clientY-down.y)>3;
    updateHover(event);
  });
  stage.addEventListener('pointerleave', () => { if (!down) clearHover(); });
  stage.addEventListener('pointercancel', event => { if (down?.id === event.pointerId) down = undefined; clearHover(); });
  stage.addEventListener('pointerup', event => {
    const start = down; down = undefined;
    if (!model || !start || start.dragging || controls.wasDragging(event) || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5 || event.button !== 0) return;
    selection.select(event);
  });
  const settingsAbort = new AbortController();
  window.addEventListener('eya-cad-settings', event => {
    const next = event.detail || {};
    if (Number.isFinite(next.decimalPlaces)) { state.decimalPlaces = Math.max(0,Math.min(10,Math.round(next.decimalPlaces))); decimalPlacesInput.value = state.decimalPlaces; updateStats(); updateHelpers(); showMeasurement(); }
    if (['mm','cm','in'].includes(next.unit)) { state.unit = next.unit; unitSelect.value = next.unit; updateStats(); showMeasurement(); }
    if (['mm','cm','m','in'].includes(next.stlUnit) && state.stlUnit !== next.stlUnit) { state.stlUnit = next.stlUnit; if (stlUnitSelect) { stlUnitSelect.value = next.stlUnit; if (model) { clearHover(); clearSelection(); model.scale.setScalar({mm:1,cm:10,m:1000,in:25.4}[next.stlUnit]); updateBounds(); fit(); } } }
    if (typeof next.snap === 'boolean') state.snap = next.snap;
    if (typeof next.live === 'boolean') { state.live = next.live; liveToggle.checked = next.live; updateLiveIndicator(); }
    if ([500,1000,2000,5000].includes(next.interval)) { state.interval = next.interval; reloadIntervalSelect.value = next.interval; }
    for (const axis of ['x','y','z']) {
      if (typeof next.sectionAxes?.[axis] === 'boolean') state.sectionAxes[axis] = next.sectionAxes[axis];
      const range = next.sectionRanges?.[axis]; if (Array.isArray(range) && range.length === 2 && range.every(Number.isFinite)) state.sectionRanges[axis] = range.map(value => Math.max(0,Math.min(1,value))).sort((a,b)=>a-b);
    }
    if (Number.isFinite(next.viewSectionDistance)) state.viewSectionDistance = Math.max(0,next.viewSectionDistance);
    if (typeof next.viewSectionFlip === 'boolean') state.viewSectionFlip = next.viewSectionFlip;
    if (Number.isFinite(next.viewSectionPosition)) state.viewSectionPosition = Math.max(0,Math.min(1,next.viewSectionPosition));
    syncSectionControls();
    if (['shaded', 'flat', 'zebra', 'edges', 'wireframe'].includes(next.mode)) { state.mode = next.mode; displaySelect.value = next.mode; }
    if (Number.isFinite(next.opacity)) { state.opacity = Math.max(0.05,Math.min(1,next.opacity)); opacityInput.value = state.opacity*100; }
    if (typeof next.showEdges === 'boolean') { state.showEdges = next.showEdges; edgesToggle.checked = next.showEdges; }
    if (typeof next.showPoints === 'boolean') { state.showPoints = next.showPoints; pointsToggle.checked = next.showPoints; }
    if (Number.isFinite(next.gizmoSize)) { state.gizmoSize = Math.max(64,Math.min(180,next.gizmoSize)); gizmoSizeInput.value = state.gizmoSize; }
    if (Number.isFinite(next.speedModifier)) { state.speedModifier = Math.max(1,Math.min(20,next.speedModifier)); speedModifierInput.value = state.speedModifier; }
    if (next.sidebar?.side) { sidebar.setSide(next.sidebar.side); sidebarSide.value = state.sidebar.side; }
    if (typeof next.sidebar?.collapsed === 'boolean') { sidebar.setCollapsed(next.sidebar.collapsed); syncSidebarHandle(); }
    if (['off', 'xy', 'all'].includes(next.gridPlanes)) { state.gridPlanes = next.gridPlanes; state.grid = next.gridPlanes !== 'off'; gridSelect.value = next.gridPlanes; gridToggle.checked = state.grid; }
    if (typeof next.infiniteGrid === 'boolean') { state.infiniteGrid = next.infiniteGrid; infiniteGridToggle.checked = next.infiniteGrid; }
    if (typeof next.gridLines === 'boolean') { state.gridLines = next.gridLines; gridLinesToggle.checked = next.gridLines; }
    if (typeof next.gridFill === 'boolean') { state.gridFill = next.gridFill; gridFillToggle.checked = next.gridFill; }
    if (typeof next.axisCoordinates === 'boolean') { state.axisCoordinates = next.axisCoordinates; axisCoordinatesToggle.checked = next.axisCoordinates; }
    if (typeof next.sectionGizmos === 'boolean') { state.sectionGizmos = next.sectionGizmos; sectionGizmoToggle.checked = next.sectionGizmos; }
    if (typeof next.rotationGizmo === 'boolean') { state.rotationGizmo = next.rotationGizmo; rotationGizmoToggle.checked = next.rotationGizmo; }
    if (['turntable', 'free'].includes(next.orbitStyle)) { state.orbitStyle = next.orbitStyle; orbitSelect.value = next.orbitStyle; }
    if (['target','origin','model'].includes(next.orbitPivot)) { state.orbitPivot=next.orbitPivot; orbitPivotSelect.value=next.orbitPivot; }
    if (Number.isFinite(Number(next.movementSpeed))) { state.movementSpeed = Math.min(4, Math.max(0.25, Number(next.movementSpeed))); movementSpeedInput.value = state.movementSpeed; }
    if (Number.isFinite(Number(next.lookSpeed))) { state.lookSpeed = Math.min(3, Math.max(0.25, Number(next.lookSpeed))); lookSpeedInput.value = state.lookSpeed; }
    if (typeof next.invertLook === 'boolean') { state.invertLook = next.invertLook; invertLookToggle.checked = next.invertLook; }
    if (typeof next.hoverHighlights === 'boolean') { state.hoverHighlights = next.hoverHighlights; hoverToggle.checked = next.hoverHighlights; if (!next.hoverHighlights) clearHover(); }
    if (validColor(next.measurementColor, '') !== '') { state.measurementColor = next.measurementColor; measurementColor.value = next.measurementColor; }
    if (Number.isFinite(Number(next.measurementPointSize))) { state.measurementPointSize = Math.min(3, Math.max(0.5, Number(next.measurementPointSize))); measurementPointSize.value = state.measurementPointSize; }
    if (validColor(next.selectionColor, '') !== '') { state.selectionColor = next.selectionColor; selectionColor.value = next.selectionColor; }
    if (['part', 'face', 'loop'].includes(next.selectionMode)) state.selectionMode = next.selectionMode;
    applyStyle(); updateHelpers(); updateNavigation(); refreshAnnotationStyle(); applySection();
  }, { signal: settingsAbort.signal });
  const observer = new ResizeObserver(resize); observer.observe(stage);
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.localClippingEnabled = true;
    renderer.domElement.setAttribute('aria-label', 'CAD model canvas');
    stage.append(renderer.domElement);
    renderer.domElement.addEventListener('webglcontextlost', event => { event.preventDefault(); status.textContent = 'Graphics context lost. Close and reopen this model.'; });
  } catch { status.textContent = 'WebGL is unavailable. Enable browser hardware acceleration or download the model.'; }
  updateNavigation(); updateRotationGizmo(); syncSectionControls(); showMeasurement();
  return {
    element: root, state,
    get dependencies() { return new Map(dependencies); },
    async load(bytes) {
      const attempt = ++generation;
      let replacement;
      try {
        const parsed = await parseModel(path, bytes, loadResource);
        replacement = parsed.model;
        if (disposed || attempt !== generation) { disposeObject(replacement); return false; }
        if (/\.stl$/i.test(path)) replacement.scale.setScalar({ mm: 1, cm: 10, m: 1000, in: 25.4 }[state.stlUnit]);
        replacement.traverse(object => {
          if (!object.isMesh) return;
          repairGeometryNormals(object.geometry, /\.stl$/i.test(path));
          object.geometry.computeBoundingBox();
        });
        replacement.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(replacement);
        if (box.isEmpty() || !Number.isFinite(box.min.length() + box.max.length())) throw Error('Model has no finite geometry.');
        const replacementMeshes = [];
        replacement.traverse(object => { if (object.isMesh) replacementMeshes.push(object); });
        if (!replacementMeshes.length) throw Error('Model contains no mesh geometry.');
        const assignPartKeys = (object, prefix = '') => {
          const siblings = object.parent?.children || [object];
          const identity = object.name || object.type;
          const occurrence = siblings.filter(sibling => (sibling.name || sibling.type) === identity).indexOf(object);
          const key = `${prefix}/${encodeURIComponent(identity)}:${occurrence}`;
          if (object.isMesh) object.userData.cadPartKey = key;
          for (const child of object.children) assignPartKeys(child, key);
        };
        assignPartKeys(replacement);
        const replacementEdges = [], replacementPoints = [];
        for (const [index, mesh] of replacementMeshes.entries()) {
          for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) { material.side = THREE.DoubleSide; material.needsUpdate = true; }
          const line = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25), new THREE.LineBasicMaterial({ color: 0x163d47 }));
          mesh.add(line); replacementEdges.push(line);
          const points = new THREE.Points(mesh.geometry, new THREE.PointsMaterial({ color:0xc7f7ef, size:4, sizeAttenuation:false }));
          mesh.add(points); replacementPoints.push(points); mesh.visible = !hiddenParts.has(partKey(mesh));
        }
        const previous = model;
        model = replacement; meshes = replacementMeshes; edgeLines = replacementEdges; pointClouds = replacementPoints;
        dependencies = parsed.dependencies;
        clearHover(); clearSelection();
        if (previous) { scene.remove(previous); disposeObject(previous); }
        scene.add(model); updateBounds(); rebuildParts(); applyStyle();
        if (!initialized) { fit(); initialized = true; } else resize();
        if (renderer) status.textContent = '';
        root.dataset.revision = String(Number(root.dataset.revision || 0) + 1);
        return true;
      } catch (error) {
        if (replacement && replacement !== model) disposeObject(replacement);
        if (!disposed) status.textContent = `${initialized ? 'Keeping previous model. ' : ''}${error.message || error}`;
        return false;
      }
    },
    setStatus: text => { if (!disposed) status.textContent = text; },
    resize, fit,
    snapshot: () => ({
      position: camera.position.toArray(), target: controls.target.toArray(), zoom: camera.zoom, revision: Number(root.dataset.revision || 0),
      mode:state.mode, decimalPlaces:state.decimalPlaces, gridLines:state.gridLines, gridFill:state.gridFill, gridAxes:axes.visible, infiniteGrid:state.infiniteGrid, gridStep:gridGroup.userData.step, gridExtent:gridGroup.userData.extent, helperClipPlanes:renderer?.clippingPlanes.length || 0, annotationLabels:selection.stats().labels, measurementGuides:selection.stats().guides, axisTickCount:coordinateLabels.userData.tickCount || 0, axisTickStep:coordinateLabels.userData.step || 0, visibleParts:meshes.map((mesh,index)=>({ index,name:mesh.name,key:partKey(mesh),visible:mesh.visible })), displayMode:state.mode, opacity:state.opacity, showEdges:state.showEdges, showPoints:state.showPoints, sidebar:sidebar.snapshot(), gizmoSize:state.gizmoSize, viewSectionDistance:state.viewSectionDistance, hiddenParts:[...hiddenParts],
      orbitStyle: state.orbitStyle, orbitPivot:state.orbitPivot, navigation:controls.diagnostics(), gridPlanes: state.gridPlanes,
      axisCoordinates: state.axisCoordinates, sectionPlanes: sectionPlanes.length, hoveredPart: root.dataset.hoveredPart || null, hoveredKind:root.dataset.hoveredKind || null, selectionCount:Number(root.dataset.selectionCount || 0), selectionKind:root.dataset.selectionKind || null,
    }),
    dispose() {
      sidebar.destroy(); stopMovement();
      for (const menu of menus) menu.destroy();
      disposed = true; generation++; settingsAbort.abort(); observer.disconnect(); controls.dispose(); selection.dispose();
      disposeObject(model); disposeObject(gridGroup); disposeObject(axes); disposeObject(coordinateLabels); disposeObject(sectionGizmo);
      rotationGizmo.remove(); renderer?.dispose(); renderer?.forceContextLoss();
    },
  };
}
