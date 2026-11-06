import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { icon, buttonIcon, createMenu, menuHeading } from './ui.js';

export const isCadFile = path => /\.(stl|glb|gltf)$/i.test(path);

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

function triangleIndices(geometry, faceIndex) {
  const index = geometry.index;
  const start = faceIndex * 3;
  return index ? [index.getX(start), index.getX(start + 1), index.getX(start + 2)] : [start, start + 1, start + 2];
}

function buildTopology(mesh) {
  const geometry = mesh.geometry, positions = geometry.attributes.position;
  geometry.computeBoundingBox();
  const diagonal = geometry.boundingBox.getSize(new THREE.Vector3()).length() || 1;
  const tolerance = Math.max(diagonal * 1e-6, 1e-9);
  const welded = new Map(), vertexIds = new Map(), edges = new Map(), triangles = [];
  const vertexId = index => {
    if (vertexIds.has(index)) return vertexIds.get(index);
    const point = new THREE.Vector3().fromBufferAttribute(positions, index);
    const key = `${Math.round(point.x / tolerance)},${Math.round(point.y / tolerance)},${Math.round(point.z / tolerance)}`;
    if (!welded.has(key)) welded.set(key, welded.size);
    const id = welded.get(key); vertexIds.set(index, id); return id;
  };
  const count = (geometry.index?.count || positions.count) / 3;
  for (let faceIndex = 0; faceIndex < count; faceIndex++) {
    const indices = triangleIndices(geometry, faceIndex);
    const vertices = indices.map(index => new THREE.Vector3().fromBufferAttribute(positions, index));
    const ids = indices.map(vertexId);
    const normal = vertices[1].clone().sub(vertices[0]).cross(vertices[2].clone().sub(vertices[0])).normalize();
    triangles.push({ indices, vertices, ids, normal });
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const key = ids[a] < ids[b] ? `${ids[a]}:${ids[b]}` : `${ids[b]}:${ids[a]}`;
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push(faceIndex);
    }
  }
  const adjacent = triangles.map(() => new Set());
  for (const faces of edges.values()) for (const face of faces) for (const other of faces) if (face !== other) adjacent[face].add(other);
  return { triangles, edges, adjacent, tolerance, closed: [...edges.values()].every(faces => faces.length === 2) };
}

async function parseModel(path, bytes, loadResource) {
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
  const parts = document.createElement('details'); parts.className = 'cad-parts';
  const summary = document.createElement('summary'); summary.textContent = 'Parts';
  summary.prepend(icon('Layers'));
  summary.append(icon('ChevronDown'));
  const partList = document.createElement('div'); parts.append(summary, partList);
  const stats = document.createElement('div'); stats.className = 'cad-stats';
  const measurement = document.createElement('div'); measurement.className = 'cad-measurement'; measurement.setAttribute('role', 'status');
  const status = document.createElement('div'); status.className = 'cad-status'; status.setAttribute('role', 'status');
  layout.append(stage, parts); root.append(toolbar, layout, stats, measurement, status);
  let renderer, model, meshes = [], edgeLines = [], bounds, radius = 1, disposed = false, initialized = false, generation = 0;
  let dependencies = new Map();
  let points = [], measureObjects = [], selectionObjects = [], hoverObject, hoveredMesh, down, measurementResult = '', selectionResult = '', viewProjection = { min: 0, max: 1 };
  const topology = new WeakMap();
  const hiddenParts = new Set();
  const state = {
    mode: ['shaded', 'edges', 'wireframe'].includes(preferences.mode) ? preferences.mode : 'edges',
    unit: ['mm', 'cm', 'in'].includes(preferences.unit) ? preferences.unit : 'mm',
    live: preferences.live !== false,
    interval: [500, 1000, 2000, 5000].includes(preferences.interval) ? preferences.interval : 1000,
    grid: preferences.grid !== false,
    gridPlanes: ['off', 'xy', 'all'].includes(preferences.gridPlanes) ? preferences.gridPlanes : preferences.grid === false ? 'off' : 'all',
    axisCoordinates: preferences.axisCoordinates !== false,
    sectionGizmos: preferences.sectionGizmos !== false,
    rotationGizmo: preferences.rotationGizmo !== false,
    navigationMode: ['orbit', 'firstPerson'].includes(preferences.navigationMode) ? preferences.navigationMode : 'orbit',
    orbitStyle: ['turntable', 'free'].includes(preferences.orbitStyle) ? preferences.orbitStyle : 'turntable',
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
    viewSection: false,
    viewSectionPosition: 0.5,
    viewSectionFlip: false,
    snap: preferences.snap !== false,
    stlUnit: ['mm', 'cm', 'm', 'in'].includes(preferences.stlUnit) ? preferences.stlUnit : 'mm',
  };
  for (const axis of ['x', 'y', 'z']) {
    state.sectionAxes[axis] = preferences.sectionAxes?.[axis] === true;
    const saved = preferences.sectionRanges?.[axis];
    if (Array.isArray(saved) && saved.length === 2 && saved.every(value => Number.isFinite(value))) state.sectionRanges[axis] = [Math.max(0, Math.min(1, saved[0])), Math.max(0, Math.min(1, saved[1]))].sort((a, b) => a - b);
  }
  state.viewSection = preferences.viewSection === true;
  state.viewSectionPosition = Number.isFinite(preferences.viewSectionPosition) ? Math.max(0, Math.min(1, preferences.viewSectionPosition)) : 0.5;
  state.viewSectionFlip = preferences.viewSectionFlip === true;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x101820);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x78909c, 2.2));
  const light = new THREE.DirectionalLight(0xffffff, 2.7); light.position.set(1, -2, 4); scene.add(light);
  const fill = new THREE.DirectionalLight(0xb9dfff, 1.4); fill.position.set(-3, 1, 1.5); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1d2, 0.8); rim.position.set(1, 3, -2); scene.add(rim);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 100000);
  camera.up.set(0, 0, 1); camera.position.set(2, -3, 2);
  const controls = new OrbitControls(camera, stage); controls.enableDamping = false;
  const raycaster = new THREE.Raycaster();
  const gridGroup = new THREE.Group();
  const gridXY = new THREE.GridHelper(2, 10, 0x607c8a, 0x29424f); gridXY.rotation.x = Math.PI / 2;
  const gridXZ = new THREE.GridHelper(2, 10, 0x607c8a, 0x29424f);
  const gridYZ = new THREE.GridHelper(2, 10, 0x607c8a, 0x29424f); gridYZ.rotation.z = Math.PI / 2;
  gridGroup.add(gridXY, gridXZ, gridYZ); scene.add(gridGroup);
  const axes = new THREE.AxesHelper(1); scene.add(axes);
  const coordinateLabels = new THREE.Group(); scene.add(coordinateLabels);
  const sectionGizmo = new THREE.Group(); scene.add(sectionGizmo);
  const sectionPlanes = [];
  const rotationGizmo = document.createElement('div'); rotationGizmo.className = 'cad-rotation-gizmo'; rotationGizmo.setAttribute('aria-label', 'View axes');
  const rotationCenter = document.createElement('span'); rotationCenter.className = 'cad-axis-center'; rotationGizmo.append(rotationCenter);
  for (const [axis, view] of [['x', 'right'], ['y', 'back'], ['z', 'top']]) {
    const arm = document.createElement('span'); arm.className = `cad-axis-arm cad-axis-${axis}`; rotationGizmo.append(arm);
    const axisButton = document.createElement('button'); axisButton.type = 'button'; axisButton.className = `cad-axis-button cad-axis-${axis}`;
    axisButton.textContent = axis.toUpperCase(); axisButton.title = `Look along ${axis.toUpperCase()}`; axisButton.onclick = () => orient(view);
    rotationGizmo.append(axisButton);
  }
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
    const input = document.createElement('input'); input.type = 'number'; input.value = value; input.step = step;
    if (min !== undefined) input.min = min; if (max !== undefined) input.max = max;
    input.addEventListener('input', () => action(input.value));
    input.addEventListener('wheel', event => { if (document.activeElement !== input) return; event.preventDefault(); event.deltaY < 0 ? input.stepUp() : input.stepDown(); input.dispatchEvent(new Event('input')); }, { passive: false });
    wrapper.append(title, input); controlHost.append(wrapper); return input;
  }
  function colorField(label, value, action) {
    const wrapper = document.createElement('label'); wrapper.className = 'ui-field';
    const title = document.createElement('span'); title.textContent = label;
    const input = document.createElement('input'); input.type = 'color'; input.value = value; input.addEventListener('input', () => action(input.value));
    wrapper.append(title, input); controlHost.append(wrapper); return input;
  }
  const viewSelect = select('CAD view', [['iso', 'Isometric'], ['front', 'Front'], ['back', 'Back'], ['top', 'Top'], ['bottom', 'Bottom'], ['right', 'Right'], ['left', 'Left']], 'iso', value => orient(value));
  const displaySelect = select('CAD display mode', [['shaded', 'Shaded'], ['edges', 'Shaded + edges'], ['wireframe', 'Wireframe']], state.mode, value => { state.mode = value; applyStyle(); persist(); });
  const activeSectionAxes = ['x', 'y', 'z'].filter(axis => state.sectionAxes[axis]);
  const section = select('Section plane', [['off', 'No section'], ['x', 'Section X'], ['y', 'Section Y'], ['z', 'Section Z'], ['view', 'View section']], state.viewSection ? 'view' : activeSectionAxes.length === 1 ? activeSectionAxes[0] : 'off', value => {
    for (const axis of ['x', 'y', 'z']) state.sectionAxes[axis] = value === axis;
    if (['x', 'y', 'z'].includes(value) && state.sectionRanges[value][0] === 0 && state.sectionRanges[value][1] === 1) state.sectionRanges[value] = [0.5, 1];
    state.viewSection = value === 'view'; syncSectionControls(); applySection(); persist();
  });
  button('Fit', () => fit());
  const measureMenu = createMenu('Measure', { iconName: 'Ruler', role: 'dialog', onOpen: () => {
    if (measureMode.value === 'off') { measureMode.value = 'distance'; selectionMode.value = 'off'; clearSelection(); clearMeasurement(); updateNavigation(); }
  } });
  menus.push(measureMenu); toolbar.append(measureMenu.element);
  controlHost = measureMenu.panel;
  menuHeading(controlHost, 'Measure');
  const measureMode = select('CAD measurement', [['off', 'Orbit'], ['distance', 'Distance'], ['angle', 'Angle'], ['area', 'Face area'], ['volume', 'Mesh volume']], 'off', value => {
    if (value !== 'off') { selectionMode.value = 'off'; clearSelection(); }
    clearMeasurement(); updateNavigation();
  });
  checkbox('Snap vertices', state.snap, value => { state.snap = value; persist(); });
  button('Clear', () => clearMeasurement(), 'Clear measurement');

  const selectionMenu = createMenu('Select', { iconName: 'Move', role: 'dialog', onOpen: () => {
    if (selectionMode.value === 'off') { selectionMode.value = state.selectionMode; measureMode.value = 'off'; clearMeasurement(); selectionMenu.trigger.classList.add('tool-active'); updateNavigation(); }
  } });
  menus.push(selectionMenu); toolbar.append(selectionMenu.element);
  controlHost = selectionMenu.panel;
  menuHeading(controlHost, 'Selection');
  const selectionMode = select('CAD selection', [['off', 'Orbit'], ['part', 'Part'], ['face', 'Face'], ['loop', 'Face loop']], 'off', value => {
    state.selectionMode = value === 'off' ? state.selectionMode : value;
    if (value !== 'off') { measureMode.value = 'off'; clearMeasurement(); }
    clearSelection(); selectionMenu.trigger.classList.toggle('tool-active', value !== 'off'); updateNavigation(); if (value !== 'off') persist();
  });
  button('Clear', () => clearSelection(), 'Clear selection');
  small('Face selects a coplanar tessellated region. Loop selects its boundary; Shift adds another selection.');

  const sectionMenu = createMenu('Sections', { iconName: 'Box', role: 'dialog' });
  menus.push(sectionMenu); toolbar.append(sectionMenu.element);
  controlHost = sectionMenu.panel;
  menuHeading(controlHost, 'Axis sections');
  const sectionControls = {};
  for (const axis of ['x', 'y', 'z']) {
    const row = document.createElement('div'); row.className = `cad-section-row cad-section-${axis}`;
    const enabledLabel = document.createElement('label'); enabledLabel.className = 'ui-check';
    const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.setAttribute('aria-label', `Section ${axis.toUpperCase()}`);
    enabledLabel.append(enabled, document.createTextNode(` ${axis.toUpperCase()}`)); row.append(enabledLabel);
    const ranges = document.createElement('div'); ranges.className = 'cad-dual-range';
    const low = document.createElement('input'), high = document.createElement('input');
    for (const input of [low, high]) { input.type = 'range'; input.min = '0'; input.max = '1000'; input.step = '1'; ranges.append(input); }
    low.setAttribute('aria-label', `${axis.toUpperCase()} section minimum`); high.setAttribute('aria-label', `${axis.toUpperCase()} section maximum`);
    row.append(ranges);
    const numbers = document.createElement('div'); numbers.className = 'cad-section-numbers';
    const lowNumber = document.createElement('input'), highNumber = document.createElement('input');
    for (const input of [lowNumber, highNumber]) { input.type = 'number'; input.step = 'any'; numbers.append(input); }
    lowNumber.setAttribute('aria-label', `${axis.toUpperCase()} section minimum coordinate`); highNumber.setAttribute('aria-label', `${axis.toUpperCase()} section maximum coordinate`);
    row.append(numbers); controlHost.append(row);
    sectionControls[axis] = { enabled, low, high, lowNumber, highNumber };
    enabled.onchange = () => { state.sectionAxes[axis] = enabled.checked; section.value = enabled.checked ? axis : section.value === axis ? 'off' : section.value; applySection(); persist(); };
    low.oninput = () => setSectionRange(axis, 0, Number(low.value) / 1000);
    high.oninput = () => setSectionRange(axis, 1, Number(high.value) / 1000);
    lowNumber.oninput = () => setSectionCoordinate(axis, 0, Number(lowNumber.value));
    highNumber.oninput = () => setSectionCoordinate(axis, 1, Number(highNumber.value));
    for (const input of [lowNumber, highNumber]) input.addEventListener('wheel', event => { if (document.activeElement !== input) return; event.preventDefault(); event.deltaY < 0 ? input.stepUp() : input.stepDown(); input.dispatchEvent(new Event('input')); }, { passive: false });
  }
  menuHeading(controlHost, 'View plane');
  const viewSectionToggle = checkbox('Perpendicular to view', state.viewSection, value => { state.viewSection = value; section.value = value ? 'view' : section.value === 'view' ? 'off' : section.value; applySection(); persist(); });
  const viewSectionRange = document.createElement('input'); viewSectionRange.type = 'range'; viewSectionRange.min = '0'; viewSectionRange.max = '1000'; viewSectionRange.value = '500'; viewSectionRange.setAttribute('aria-label', 'View section position');
  viewSectionRange.oninput = () => { state.viewSectionPosition = Number(viewSectionRange.value) / 1000; applySection(); persist(); };
  controlHost.append(viewSectionRange);
  const viewSectionNumber = numberField('View coordinate', '0', { step: 'any' }, value => setViewSectionCoordinate(Number(value)));
  const viewSectionFlip = checkbox('Flip view section', state.viewSectionFlip, value => { state.viewSectionFlip = value; applySection(); persist(); });
  button('Reset', () => { for (const axis of ['x', 'y', 'z']) state.sectionRanges[axis] = [0, 1]; state.viewSectionPosition = 0.5; syncSectionControls(); applySection(); persist(); }, 'Reset sections');
  small('Each colored axis has independent minimum and maximum handles. Number fields support arrow keys and mouse-wheel stepping.');

  const optionsMenu = createMenu('CAD options', { iconName: 'SlidersHorizontal', role: 'dialog' });
  menus.push(optionsMenu); toolbar.append(optionsMenu.element);
  controlHost = optionsMenu.panel;
  menuHeading(controlHost, 'Appearance');
  const gridSelect = select('Grid planes', [['off', 'Grid: off'], ['xy', 'Grid: XY'], ['all', 'Grid: XY / XZ / YZ']], state.gridPlanes, value => { state.gridPlanes = value; state.grid = value !== 'off'; gridToggle.checked = state.grid; updateHelpers(); persist(); });
  const gridToggle = checkbox('Grid', state.gridPlanes !== 'off', value => { state.gridPlanes = value ? (gridSelect.value === 'off' ? 'all' : gridSelect.value) : 'off'; state.grid = value; gridSelect.value = state.gridPlanes; updateHelpers(); persist(); });
  const axisCoordinatesToggle = checkbox('Axis coordinates', state.axisCoordinates, value => { state.axisCoordinates = value; updateHelpers(); persist(); });
  const sectionGizmoToggle = checkbox('Section gizmos', state.sectionGizmos, value => { state.sectionGizmos = value; updateSectionGizmo(); persist(); });
  const rotationGizmoToggle = checkbox('Rotation gizmo', state.rotationGizmo, value => { state.rotationGizmo = value; updateRotationGizmo(); persist(); });
  const hoverToggle = checkbox('Hover highlights', state.hoverHighlights, value => { state.hoverHighlights = value; if (!value) clearHover(); persist(); });
  menuHeading(controlHost, 'Camera');
  const navigationSelect = select('Navigation mode', [['orbit', 'Orbit'], ['firstPerson', 'First person (WASD/QE)']], state.navigationMode, value => { state.navigationMode = value; updateNavigation(); persist(); });
  const orbitSelect = select('Orbit style', [['turntable', 'Turntable'], ['free', 'Free orbit']], state.orbitStyle, value => { state.orbitStyle = value; updateNavigation(); persist(); });
  const movementSpeedInput = numberField('Movement speed', state.movementSpeed, { min: 0.25, max: 4, step: 0.25 }, value => { state.movementSpeed = Math.min(4, Math.max(0.25, Number(value) || 1)); persist(); });
  const lookSpeedInput = numberField('Look sensitivity', state.lookSpeed, { min: 0.25, max: 3, step: 0.25 }, value => { state.lookSpeed = Math.min(3, Math.max(0.25, Number(value) || 1)); persist(); });
  const invertLookToggle = checkbox('Invert first-person look', state.invertLook, value => { state.invertLook = value; persist(); });
  small('First person: click the canvas, use WASD to move, Q/E vertically, and drag to look.');
  menuHeading(controlHost, 'Units');
  select('Measurement units', [['mm', 'mm'], ['cm', 'cm'], ['in', 'in']], state.unit, value => { state.unit = value; updateStats(); updateHelpers(); syncSectionControls(); showMeasurement(); persist(); });
  if (/\.stl$/i.test(path)) select('STL source units', [['mm', 'STL: mm'], ['cm', 'STL: cm'], ['m', 'STL: m'], ['in', 'STL: in']], state.stlUnit, value => {
    state.stlUnit = value;
    if (model) { model.scale.setScalar({ mm: 1, cm: 10, m: 1000, in: 25.4 }[value]); updateBounds(); fit(); clearMeasurement(); }
    persist();
  });
  menuHeading(controlHost, 'Annotations');
  const measurementColor = colorField('Measurement color', state.measurementColor, value => { state.measurementColor = value; refreshAnnotationStyle(); persist(); });
  const measurementPointSize = numberField('Measurement point size', state.measurementPointSize, { min: 0.5, max: 3, step: 0.1 }, value => { state.measurementPointSize = Math.min(3, Math.max(0.5, Number(value) || 1.5)); refreshAnnotationStyle(); persist(); });
  const selectionColor = colorField('Selection color', state.selectionColor, value => { state.selectionColor = value; refreshAnnotationStyle(); persist(); });
  menuHeading(controlHost, 'Live preview');
  checkbox('Live reload', state.live, value => { state.live = value; updateLiveIndicator(); persist(); });
  select('CAD reload interval', [['500', '0.5 s'], ['1000', '1 s'], ['2000', '2 s'], ['5000', '5 s']], String(state.interval), value => { state.interval = Number(value); persist(); });
  button('Reload', () => reload());
  controlHost = toolbar;
  function updateLiveIndicator() {
    optionsMenu.trigger.classList.toggle('live-enabled', state.live);
    optionsMenu.trigger.title = `CAD options · live reload ${state.live ? 'on' : 'paused'}`;
  }
  updateLiveIndicator();
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') { measureMode.value = 'off'; selectionMode.value = 'off'; clearMeasurement(); clearSelection(); updateNavigation(); }
    if (event.target === stage && event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey) fit();
    if (event.target === stage && state.navigationMode === 'firstPerson' && !event.ctrlKey && !event.metaKey && moveFirstPerson(event.key.toLowerCase())) event.preventDefault();
  });
  function render() {
    if (disposed || !renderer || !stage.clientWidth || !stage.clientHeight) return;
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
  function orient(direction) {
    const directions = { iso: [2, -3, 2], front: [0, -1, 0], back: [0, 1, 0], top: [0, -0.00001, 1], bottom: [0, -0.00001, -1], right: [1, 0, 0], left: [-1, 0, 0] };
    camera.position.copy(controls.target).add(new THREE.Vector3(...directions[direction]).normalize().multiplyScalar(radius * 3));
    viewSelect.value = direction;
    controls.update(); resize();
  }
  function updateBounds() {
    model.updateMatrixWorld(true);
    bounds = new THREE.Box3().setFromObject(model);
    if (bounds.isEmpty() || !Number.isFinite(bounds.min.length() + bounds.max.length())) throw Error('Model has no finite geometry.');
    const size = bounds.getSize(new THREE.Vector3()).length() || 1;
    const center = bounds.getCenter(new THREE.Vector3());
    gridXY.scale.setScalar(size); gridXY.position.set(center.x, center.y, bounds.min.z);
    gridXZ.scale.setScalar(size); gridXZ.position.set(center.x, bounds.min.y, center.z);
    gridYZ.scale.setScalar(size); gridYZ.position.set(bounds.min.x, center.y, center.z);
    axes.scale.setScalar(size * 0.3); axes.position.copy(bounds.min);
    updateHelpers(); updateStats(); syncSectionControls(); applySection();
  }
  function number(value) { return Number(value.toFixed(4)).toLocaleString(undefined, { maximumFractionDigits: 4 }); }
  function unitScale() { return { mm: 1, cm: 10, in: 25.4 }[state.unit]; }
  function updateStats() {
    if (!bounds) return;
    const size = bounds.getSize(new THREE.Vector3()).divideScalar(unitScale());
    const triangles = meshes.reduce((total, mesh) => total + (mesh.geometry.index?.count || mesh.geometry.attributes.position.count) / 3, 0);
    stats.textContent = `Bounds X ${number(size.x)} × Y ${number(size.y)} × Z ${number(size.z)} ${state.unit} · ${meshes.length} meshes · ${number(triangles)} triangles`;
  }
  function applyStyle() {
    for (const mesh of meshes) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.wireframe = state.mode === 'wireframe';
    for (const line of edgeLines) line.visible = state.mode === 'edges';
    render();
  }
  function clearGroup(group) {
    for (const child of [...group.children]) { group.remove(child); disposeObject(child); }
  }
  function labelSprite(text, color) {
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 64;
    const context = canvas.getContext('2d'); context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = '600 30px system-ui, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
    context.lineWidth = 8; context.strokeStyle = '#101820'; context.strokeText(text, 128, 32); context.fillStyle = color; context.fillText(text, 128, 32);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false }));
    const helperRadius = bounds ? Math.max(bounds.getSize(new THREE.Vector3()).length() * 0.65, 0.01) : radius;
    sprite.scale.set(helperRadius * 0.42, helperRadius * 0.105, 1); sprite.renderOrder = 20; return sprite;
  }
  function updateHelpers() {
    gridXY.visible = state.gridPlanes === 'xy' || state.gridPlanes === 'all';
    gridXZ.visible = gridYZ.visible = state.gridPlanes === 'all';
    axes.visible = state.axisCoordinates;
    clearGroup(coordinateLabels);
    if (bounds && state.axisCoordinates) {
      const center = bounds.getCenter(new THREE.Vector3());
      for (const [axis, color] of [['x', '#ff6b6b'], ['y', '#63e690'], ['z', '#68a9ff']]) {
        for (const end of ['min', 'max']) {
          const position = center.clone(); position[axis] = bounds[end][axis];
          const label = labelSprite(`${axis.toUpperCase()} ${number(bounds[end][axis] / unitScale())} ${state.unit}`, color);
          label.position.copy(position); coordinateLabels.add(label);
        }
      }
    }
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
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) corners.push(normal.dot(new THREE.Vector3(x, y, z)));
    viewProjection = { min: Math.min(...corners), max: Math.max(...corners) };
  }
  function setViewSectionCoordinate(displayValue) {
    if (!Number.isFinite(displayValue)) return;
    updateViewProjection();
    const span = viewProjection.max - viewProjection.min;
    state.viewSectionPosition = Math.max(0, Math.min(1, span ? (displayValue * unitScale() - viewProjection.min) / span : 0));
    syncSectionControls(); applySection(); persist();
  }
  function syncSectionControls() {
    for (const axis of ['x', 'y', 'z']) {
      const controlsForAxis = sectionControls[axis], values = state.sectionRanges[axis];
      controlsForAxis.enabled.checked = state.sectionAxes[axis];
      controlsForAxis.low.value = String(Math.round(values[0] * 1000)); controlsForAxis.high.value = String(Math.round(values[1] * 1000));
      const step = bounds ? Math.max((bounds.max[axis] - bounds.min[axis]) / unitScale() / 1000, 0.0001) : 0.01;
      controlsForAxis.lowNumber.step = controlsForAxis.highNumber.step = String(step);
      controlsForAxis.lowNumber.value = number(axisCoordinate(axis, values[0]) / unitScale());
      controlsForAxis.highNumber.value = number(axisCoordinate(axis, values[1]) / unitScale());
    }
    viewSectionToggle.checked = state.viewSection; viewSectionFlip.checked = state.viewSectionFlip;
    viewSectionRange.value = String(Math.round(state.viewSectionPosition * 1000));
    updateViewProjection();
    viewSectionNumber.step = String(Math.max((viewProjection.max - viewProjection.min) / unitScale() / 1000, 0.0001));
    viewSectionNumber.value = number((viewProjection.min + (viewProjection.max - viewProjection.min) * state.viewSectionPosition) / unitScale());
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
    sectionPlanes.length = 0;
    if (bounds) {
      for (const axis of ['x', 'y', 'z']) if (state.sectionAxes[axis]) {
        const vector = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
        const low = axisCoordinate(axis, state.sectionRanges[axis][0]), high = axisCoordinate(axis, state.sectionRanges[axis][1]);
        sectionPlanes.push(new THREE.Plane(vector.clone(), -low), new THREE.Plane(vector.clone().negate(), high));
      }
      if (state.viewSection) {
        updateViewProjection();
        const value = viewProjection.min + (viewProjection.max - viewProjection.min) * state.viewSectionPosition;
        const normal = viewNormal(); if (state.viewSectionFlip) normal.negate();
        sectionPlanes.push(new THREE.Plane(normal, state.viewSectionFlip ? value : -value));
      }
    }
    if (renderer) renderer.clippingPlanes = sectionPlanes;
    syncSectionControls(); updateSectionGizmo();
    sectionMenu.trigger.classList.toggle('tool-active', sectionPlanes.length > 0);
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
      visible.onchange = () => { mesh.visible = visible.checked; if (visible.checked) hiddenParts.delete(index); else hiddenParts.add(index); clearHover(); rebuildParts(); render(); };
      row.append(visible, document.createTextNode(` ${mesh.name || `Part ${index + 1}`}`)); partList.append(row);
    }
  }
  function clearMeasurement() {
    points = []; measurementResult = '';
    for (const object of measureObjects) { object.removeFromParent(); disposeObject(object); }
    measureObjects = [];
    showMeasurement(); render();
  }
  function clearSelection() {
    selectionResult = '';
    for (const object of selectionObjects) { object.removeFromParent(); disposeObject(object); }
    selectionObjects = []; selectionMenu.trigger.classList.remove('tool-active'); showMeasurement(); render();
  }
  function clearHover() {
    if (hoverObject) { hoverObject.removeFromParent(); disposeObject(hoverObject); }
    hoverObject = hoveredMesh = null; root.dataset.hoveredPart = ''; render();
  }
  function topologyFor(mesh) { if (!topology.has(mesh)) topology.set(mesh, buildTopology(mesh)); return topology.get(mesh); }
  function faceRegion(mesh, faceIndex) {
    const data = topologyFor(mesh), seed = data.triangles[faceIndex];
    if (!seed) return new Set();
    const region = new Set([faceIndex]), queue = [faceIndex], plane = new THREE.Plane().setFromNormalAndCoplanarPoint(seed.normal, seed.vertices[0]);
    const normalLimit = Math.cos(THREE.MathUtils.degToRad(2));
    while (queue.length) for (const next of data.adjacent[queue.shift()]) {
      if (region.has(next)) continue;
      const triangle = data.triangles[next];
      if (triangle.normal.dot(seed.normal) < normalLimit || triangle.vertices.some(point => Math.abs(plane.distanceToPoint(point)) > data.tolerance * 4)) continue;
      region.add(next); queue.push(next);
    }
    return region;
  }
  function triangleOverlay(mesh, faceIndices, color, opacity = 0.34) {
    const data = topologyFor(mesh), values = [];
    for (const faceIndex of faceIndices) for (const point of data.triangles[faceIndex].vertices) values.push(point.x, point.y, point.z);
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(values, 3));
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
    const overlay = new THREE.Mesh(geometry, material); overlay.renderOrder = 10; overlay.userData.annotation = 'selection'; mesh.add(overlay); return overlay;
  }
  function boundaryOverlay(mesh, region, color) {
    const data = topologyFor(mesh), values = [];
    for (const [key, faces] of data.edges) {
      const included = faces.filter(face => region.has(face)); if (included.length !== 1) continue;
      const triangle = data.triangles[included[0]], [a, b] = key.split(':').map(Number);
      const first = triangle.ids.indexOf(a), second = triangle.ids.indexOf(b);
      if (first < 0 || second < 0) continue;
      for (const point of [triangle.vertices[first], triangle.vertices[second]]) values.push(point.x, point.y, point.z);
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(values, 3));
    const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, depthTest: false }));
    line.renderOrder = 12; line.userData.annotation = 'selection'; mesh.add(line); return line;
  }
  function wholeMeshOverlay(mesh, color, opacity = 0.18) {
    const overlay = new THREE.Mesh(mesh.geometry.clone(), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 }));
    overlay.renderOrder = 9; overlay.userData.annotation = 'selection'; mesh.add(overlay); return overlay;
  }
  function selectHit(hit, append = false) {
    if (!append) clearSelection();
    const mode = selectionMode.value, color = state.selectionColor;
    if (mode === 'part') {
      selectionObjects.push(wholeMeshOverlay(hit.object, color, 0.24)); selectionResult = `Selected part · ${hit.object.name || `Part ${meshes.indexOf(hit.object) + 1}`}`;
    } else {
      const region = faceRegion(hit.object, hit.faceIndex);
      if (mode === 'face') selectionObjects.push(triangleOverlay(hit.object, region, color));
      else selectionObjects.push(boundaryOverlay(hit.object, region, color));
      selectionResult = `Selected ${mode === 'face' ? 'face' : 'face loop'} · ${region.size} triangle${region.size === 1 ? '' : 's'}`;
    }
    selectionMenu.trigger.classList.add('tool-active'); showMeasurement(); render();
  }
  function measureArea(hit) {
    const region = faceRegion(hit.object, hit.faceIndex), data = topologyFor(hit.object); let area = 0;
    for (const index of region) {
      const [a, b, c] = data.triangles[index].vertices.map(point => point.clone().applyMatrix4(hit.object.matrixWorld));
      area += b.sub(a).cross(c.sub(a)).length() / 2;
    }
    const overlay = triangleOverlay(hit.object, region, state.measurementColor, 0.28); overlay.userData.annotation = 'measurement'; measureObjects.push(overlay);
    measurementResult = `≈ ${number(area / unitScale() ** 2)} ${state.unit}² · tessellated face area · ${region.size} triangles`;
  }
  function measureVolume(hit) {
    const data = topologyFor(hit.object);
    if (!data.closed) { measurementResult = 'Volume unavailable: the selected mesh is open or non-manifold.'; return; }
    let volume = 0;
    for (const triangle of data.triangles) {
      const [a, b, c] = triangle.vertices.map(point => point.clone().applyMatrix4(hit.object.matrixWorld));
      volume += a.dot(b.cross(c)) / 6;
    }
    const overlay = wholeMeshOverlay(hit.object, state.measurementColor, 0.18); overlay.userData.annotation = 'measurement'; measureObjects.push(overlay);
    measurementResult = `≈ ${number(Math.abs(volume) / unitScale() ** 3)} ${state.unit}³ · tessellated closed-mesh volume`;
  }
  function refreshAnnotationStyle() {
    for (const object of [...measureObjects, ...selectionObjects]) {
      const color = object.userData.annotation === 'measurement' ? state.measurementColor : state.selectionColor;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) material?.color?.set(color);
      if (object.userData.measureMarker) object.scale.setScalar(state.measurementPointSize / object.userData.pointSize);
    }
    render();
  }
  function showMeasurement() {
    measurement.hidden = measureMode.value === 'off' && !points.length && !measurementResult && !selectionResult;
    measureMenu.trigger.classList.toggle('tool-active', measureMode.value !== 'off');
    measureMenu.trigger.setAttribute('aria-pressed', String(measureMode.value !== 'off'));
    if (measurementResult) measurement.textContent = measurementResult;
    else if (selectionResult) measurement.textContent = selectionResult;
    else if (points.length === 2) {
      const delta = points[1].clone().sub(points[0]).divideScalar(unitScale());
      measurement.textContent = `≈ ${number(delta.length())} ${state.unit} · ΔX ${number(delta.x)}, ΔY ${number(delta.y)}, ΔZ ${number(delta.z)} ${state.unit}`;
    } else if (points.length === 3) {
      const a = points[0].clone().sub(points[1]), b = points[2].clone().sub(points[1]);
      measurement.textContent = `≈ ${number(THREE.MathUtils.radToDeg(a.angleTo(b)))}°`;
    } else if (measureMode.value === 'area') measurement.textContent = 'Pick a face to measure its tessellated area';
    else if (measureMode.value === 'volume') measurement.textContent = 'Pick a closed mesh to measure its tessellated volume';
    else measurement.textContent = measureMode.value === 'off' ? '' : `Pick ${measureMode.value === 'angle' ? '3' : '2'} points`;
  }
  function pick(event) {
    if (!model) return undefined;
    const rect = stage.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
    return raycaster.intersectObjects(meshes, false).find(hit => hit.object.visible && sectionPlanes.every(plane => plane.distanceToPoint(hit.point) >= -1e-7));
  }
  function updateHover(event) {
    if (!state.hoverHighlights || down?.dragging) return;
    const hit = pick(event); if (hit?.object === hoveredMesh) return;
    clearHover(); if (!hit) return;
    hoveredMesh = hit.object; hoverObject = wholeMeshOverlay(hoveredMesh, state.selectionColor, 0.12); hoverObject.userData.annotation = 'hover';
    root.dataset.hoveredPart = String(meshes.indexOf(hoveredMesh)); render();
  }
  function updateNavigation() {
    const toolActive = measureMode.value !== 'off' || selectionMode.value !== 'off';
    controls.enabled = state.navigationMode === 'orbit' && !toolActive;
    controls.minPolarAngle = state.orbitStyle === 'turntable' ? 0.001 : 0;
    controls.maxPolarAngle = state.orbitStyle === 'turntable' ? Math.PI - 0.001 : Math.PI;
    stage.setAttribute('aria-label', state.navigationMode === 'firstPerson' ? '3D model: drag to look, WASD to move, Q and E to move vertically' : '3D model: drag to orbit, right-drag to pan, pinch or wheel to zoom');
  }
  function moveFirstPerson(key) {
    const direction = controls.target.clone().sub(camera.position).normalize(), right = direction.clone().cross(camera.up).normalize();
    const movement = new THREE.Vector3(), amount = radius * 0.08 * state.movementSpeed;
    if (key === 'w') movement.add(direction); else if (key === 's') movement.sub(direction); else if (key === 'a') movement.sub(right); else if (key === 'd') movement.add(right); else if (key === 'q') movement.z -= 1; else if (key === 'e') movement.z += 1; else return false;
    movement.normalize().multiplyScalar(amount); camera.position.add(movement); controls.target.add(movement); applySection(); return true;
  }
  function updateRotationGizmo() {
    rotationGizmo.hidden = !state.rotationGizmo;
    if (!state.rotationGizmo) return;
    const inverse = camera.quaternion.clone().invert();
    for (const [axis, vector] of [['x', new THREE.Vector3(1, 0, 0)], ['y', new THREE.Vector3(0, 1, 0)], ['z', new THREE.Vector3(0, 0, 1)]]) {
      vector.applyQuaternion(inverse); const x = vector.x * 28, y = -vector.y * 28;
      const buttonForAxis = rotationGizmo.querySelector(`button.cad-axis-${axis}`), arm = rotationGizmo.querySelector(`span.cad-axis-${axis}`);
      buttonForAxis.style.transform = `translate(calc(-50% + ${x}px),calc(-50% + ${y}px))`; buttonForAxis.style.zIndex = String(Math.round((vector.z + 1) * 10));
      arm.style.width = `${Math.hypot(x, y)}px`; arm.style.transform = `rotate(${Math.atan2(y, x)}rad)`;
    }
  }
  stage.addEventListener('pointerdown', event => {
    stage.focus({ preventScroll: true }); down = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, id: event.pointerId, dragging: false };
    if (state.navigationMode === 'firstPerson' && measureMode.value === 'off' && selectionMode.value === 'off' && event.button === 0) stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', event => {
    if (down?.id === event.pointerId && state.navigationMode === 'firstPerson' && measureMode.value === 'off' && selectionMode.value === 'off' && (event.buttons & 1)) {
      const dx = event.clientX - down.lastX, dy = event.clientY - down.lastY; down.lastX = event.clientX; down.lastY = event.clientY; down.dragging ||= Math.hypot(event.clientX - down.x, event.clientY - down.y) > 3;
      const direction = controls.target.clone().sub(camera.position), distance = direction.length();
      direction.applyAxisAngle(camera.up, -dx * 0.006 * state.lookSpeed); const right = direction.clone().cross(camera.up).normalize();
      direction.applyAxisAngle(right, -dy * 0.006 * state.lookSpeed * (state.invertLook ? -1 : 1)).setLength(distance);
      controls.target.copy(camera.position).add(direction); camera.lookAt(controls.target); applySection(); return;
    }
    updateHover(event);
  });
  stage.addEventListener('pointerleave', () => { if (!down) clearHover(); });
  stage.addEventListener('pointercancel', event => { if (down?.id === event.pointerId) down = undefined; clearHover(); });
  stage.addEventListener('pointerup', event => {
    const start = down; down = undefined;
    if (!model || !start || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5 || event.button !== 0) return;
    const hit = pick(event);
    if (!hit) return;
    if (selectionMode.value !== 'off') { selectHit(hit, event.shiftKey); return; }
    if (measureMode.value === 'off') return;
    if (measureMode.value === 'area' || measureMode.value === 'volume') {
      clearMeasurement(); measureMode.value === 'area' ? measureArea(hit) : measureVolume(hit); showMeasurement(); render(); return;
    }
    let point = hit.point.clone();
    if (state.snap && hit.face) {
      const positions = hit.object.geometry.attributes.position;
      const vertices = [hit.face.a, hit.face.b, hit.face.c].map(index => new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(hit.object.matrixWorld));
      point = vertices.sort((a, b) => a.distanceToSquared(hit.point) - b.distanceToSquared(hit.point))[0];
    }
    if (points.length >= (measureMode.value === 'angle' ? 3 : 2)) clearMeasurement();
    if (points.some(previous => previous.distanceToSquared(point) < 1e-16)) {
      measurement.textContent = 'Choose distinct points to measure.';
      return;
    }
    points.push(point);
    const marker = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.016 * state.measurementPointSize, 16, 12), new THREE.MeshBasicMaterial({ color: state.measurementColor, depthTest: false }));
    marker.userData.annotation = 'measurement'; marker.userData.measureMarker = true; marker.userData.pointSize = state.measurementPointSize;
    marker.position.copy(point); marker.renderOrder = 5; scene.add(marker); measureObjects.push(marker);
    if (points.length > 1) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: state.measurementColor, depthTest: false }));
      line.userData.annotation = 'measurement';
      line.renderOrder = 5; scene.add(line); measureObjects.push(line);
    }
    showMeasurement(); render();
  });
  const settingsAbort = new AbortController();
  window.addEventListener('eya-cad-settings', event => {
    const next = event.detail || {};
    if (['shaded', 'edges', 'wireframe'].includes(next.mode)) { state.mode = next.mode; displaySelect.value = next.mode; }
    if (['off', 'xy', 'all'].includes(next.gridPlanes)) { state.gridPlanes = next.gridPlanes; state.grid = next.gridPlanes !== 'off'; gridSelect.value = next.gridPlanes; gridToggle.checked = state.grid; }
    if (typeof next.axisCoordinates === 'boolean') { state.axisCoordinates = next.axisCoordinates; axisCoordinatesToggle.checked = next.axisCoordinates; }
    if (typeof next.sectionGizmos === 'boolean') { state.sectionGizmos = next.sectionGizmos; sectionGizmoToggle.checked = next.sectionGizmos; }
    if (typeof next.rotationGizmo === 'boolean') { state.rotationGizmo = next.rotationGizmo; rotationGizmoToggle.checked = next.rotationGizmo; }
    if (['orbit', 'firstPerson'].includes(next.navigationMode)) { state.navigationMode = next.navigationMode; navigationSelect.value = next.navigationMode; }
    if (['turntable', 'free'].includes(next.orbitStyle)) { state.orbitStyle = next.orbitStyle; orbitSelect.value = next.orbitStyle; }
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
        const replacementEdges = [];
        for (const [index, mesh] of replacementMeshes.entries()) {
          for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) { material.side = THREE.DoubleSide; material.needsUpdate = true; }
          const line = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25), new THREE.LineBasicMaterial({ color: 0x163d47 }));
          mesh.add(line); replacementEdges.push(line); mesh.visible = !hiddenParts.has(index);
        }
        const previous = model;
        model = replacement; meshes = replacementMeshes; edgeLines = replacementEdges;
        dependencies = parsed.dependencies;
        clearHover(); clearMeasurement(); clearSelection();
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
      navigationMode: state.navigationMode, orbitStyle: state.orbitStyle, gridPlanes: state.gridPlanes,
      axisCoordinates: state.axisCoordinates, sectionPlanes: sectionPlanes.length, hoveredPart: root.dataset.hoveredPart || null,
    }),
    dispose() {
      for (const menu of menus) menu.destroy();
      disposed = true; generation++; settingsAbort.abort(); observer.disconnect(); controls.dispose(); clearHover(); clearMeasurement(); clearSelection();
      disposeObject(model); disposeObject(gridGroup); disposeObject(axes); disposeObject(coordinateLabels); disposeObject(sectionGizmo);
      rotationGizmo.remove(); renderer?.dispose(); renderer?.forceContextLoss();
    },
  };
}
