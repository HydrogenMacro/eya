import * as THREE from 'three';
const V = () => new THREE.Vector3();
const edgeKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
export function cadTopology(mesh) {
  const geometry = mesh.geometry, position = geometry.attributes.position;
  geometry.computeBoundingBox();
  const tolerance = Math.max(geometry.boundingBox.getSize(V()).length() * 1e-6, 1e-9);
  const welded = new Map(), vertices = [], sourceIds = new Map(), edges = new Map(), triangles = [];
  const vertexId = index => {
    if (sourceIds.has(index)) return sourceIds.get(index);
    const point = V().fromBufferAttribute(position, index);
    const key = point.toArray().map(value => Math.round(value / tolerance)).join(',');
    if (!welded.has(key)) { welded.set(key, vertices.length); vertices.push(point); }
    const id = welded.get(key); sourceIds.set(index, id); return id;
  };
  for (let i = 0, count = (geometry.index?.count || position.count) / 3; i < count; i++) {
    const ids = [0, 1, 2].map(offset => vertexId(geometry.index ? geometry.index.getX(i * 3 + offset) : i * 3 + offset));
    const points = ids.map(id => vertices[id]);
    const normal = points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).normalize();
    const keys = [];
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const key = edgeKey(ids[a], ids[b]); keys.push(key);
      if (!edges.has(key)) edges.set(key, { key, ids: [ids[a], ids[b]], faces: [] });
      edges.get(key).faces.push(i);
    }
    triangles.push({ ids, points, normal, edges: keys });
  }
  const adjacent = triangles.map(() => []), normalLimit = Math.cos(THREE.MathUtils.degToRad(2));
  for (const edge of edges.values()) {
    for (const face of edge.faces) for (const other of edge.faces) if (face !== other) adjacent[face].push(other);
    edge.feature = edge.faces.length !== 2 || triangles[edge.faces[0]].normal.dot(triangles[edge.faces[1]].normal) < normalLimit;
  }
  return { vertices, edges, triangles, adjacent, tolerance, normalLimit, closed: [...edges.values()].every(edge => edge.faces.length === 2) };
}
export function cadFaceRegion(data, faceIndex) {
  const seed = data.triangles[faceIndex]; if (!seed) return new Set();
  const region = new Set([faceIndex]), queue = [faceIndex], plane = new THREE.Plane().setFromNormalAndCoplanarPoint(seed.normal, seed.points[0]);
  for (let cursor = 0; cursor < queue.length; cursor++) for (const next of data.adjacent[queue[cursor]]) {
    if (region.has(next)) continue;
    const triangle = data.triangles[next];
    if (triangle.normal.dot(seed.normal) < data.normalLimit || triangle.points.some(point => Math.abs(plane.distanceToPoint(point)) > data.tolerance * 4)) continue;
    region.add(next); queue.push(next);
  }
  return region;
}
export function cadSegmentClosest(a, b, c, d) {
  const u = b.clone().sub(a), v = d.clone().sub(c), w = a.clone().sub(c);
  const aa = u.dot(u), bb = u.dot(v), cc = v.dot(v), dd = u.dot(w), ee = v.dot(w);
  const clamp = value => Math.max(0, Math.min(1, value));
  if (!cc) return [new THREE.Line3(a, b).closestPointToPoint(c, true, V()), c.clone()];
  let s = aa ? clamp((bb * ee - cc * dd) / (aa * cc - bb * bb || 1)) : 0;
  let t = cc ? (bb * s + ee) / cc : 0;
  if (t < 0) { t = 0; s = aa ? clamp(-dd / aa) : 0; }
  else if (t > 1) { t = 1; s = aa ? clamp((bb - dd) / aa) : 0; }
  return [a.clone().addScaledVector(u, s), c.clone().addScaledVector(v, t)];
}
function chooseClosest(candidates) {
  let best = candidates[0], distance = Infinity;
  for (const pair of candidates) { const next = pair[0].distanceToSquared(pair[1]); if (next < distance) { best = pair; distance = next; } }
  return best;
}
function segmentTriangle(segment, triangle) {
  const [a, b] = segment, tri = new THREE.Triangle(...triangle);
  const candidates = [[a.clone(), tri.closestPointToPoint(a, V())], [b.clone(), tri.closestPointToPoint(b, V())]];
  const direction = b.clone().sub(a), length = direction.length();
  if (length) {
    const hit = new THREE.Ray(a, direction.divideScalar(length)).intersectTriangle(...triangle, false, V());
    if (hit && a.distanceTo(hit) <= length) return [hit, hit.clone()];
  }
  for (let i = 0; i < 3; i++) candidates.push(cadSegmentClosest(a, b, triangle[i], triangle[(i + 1) % 3]));
  return chooseClosest(candidates);
}
export function cadPrimitiveClosest(a, b) {
  if (a.length > b.length) return cadPrimitiveClosest(b, a).reverse();
  if (a.length === 1) {
    if (b.length === 1) return [a[0].clone(), b[0].clone()];
    if (b.length === 2) return [a[0].clone(), new THREE.Line3(...b).closestPointToPoint(a[0], true, V())];
    return [a[0].clone(), new THREE.Triangle(...b).closestPointToPoint(a[0], V())];
  }
  if (a.length === 2) return b.length === 2 ? cadSegmentClosest(...a, ...b) : segmentTriangle(a, b);
  const candidates = [];
  for (let i = 0; i < 3; i++) {
    candidates.push(segmentTriangle([a[i], a[(i + 1) % 3]], b));
    candidates.push(segmentTriangle([b[i], b[(i + 1) % 3]], a).reverse());
  }
  return chooseClosest(candidates);
}
function primitiveTree(primitives) {
  const box = new THREE.Box3(); for (const primitive of primitives) for (const point of primitive) box.expandByPoint(point);
  if (primitives.length <= 8) return { box, primitives };
  const size = box.getSize(V()), axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
  primitives.sort((a, b) => a.reduce((sum, p) => sum + p[axis], 0) / a.length - b.reduce((sum, p) => sum + p[axis], 0) / b.length);
  const half = Math.floor(primitives.length / 2);
  return { box, children: [primitiveTree(primitives.slice(0, half)), primitiveTree(primitives.slice(half))] };
}
function boxDistance(a, b) {
  let sum = 0;
  for (const axis of ['x', 'y', 'z']) { const delta = Math.max(0, a.min[axis] - b.max[axis], b.min[axis] - a.max[axis]); sum += delta * delta; }
  return sum;
}
export function cadClosestGeometry(first, second) {
  if (!first.length || !second.length) return undefined;
  const a = primitiveTree(first.slice()), b = primitiveTree(second.slice());
  let best, distance = Infinity;
  const visit = (a, b) => {
    if (boxDistance(a.box, b.box) > distance) return;
    if (a.primitives && b.primitives) {
      for (const x of a.primitives) for (const y of b.primitives) {
        const pair = cadPrimitiveClosest(x, y), next = pair[0].distanceToSquared(pair[1]);
        if (next < distance) { best = pair; distance = next; if (distance < 1e-20) return; }
      }
      return;
    }
    const branches = a.children && (!b.children || a.box.getSize(V()).lengthSq() >= b.box.getSize(V()).lengthSq()) ? a.children.map(child => [child, b]) : b.children.map(child => [a, child]);
    branches.sort((x, y) => boxDistance(x[0].box, x[1].box) - boxDistance(y[0].box, y[1].box));
    for (const pair of branches) { visit(...pair); if (distance < 1e-20) break; }
  };
  visit(a, b); return best;
}
export function cadGeometryMetrics(triangles, closed = false) {
  let area = 0, volume = 0; const centroid = V();
  const origin = triangles[0]?.[0] || V();
  for (const [a, b, c] of triangles) {
    const weight = b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
    area += weight; centroid.add(a.clone().add(b).add(c).multiplyScalar(weight / 3));
    volume += a.clone().sub(origin).dot(b.clone().sub(origin).cross(c.clone().sub(origin))) / 6;
  }
  return { area, volume: closed ? Math.abs(volume) : undefined, centroid: area ? centroid.divideScalar(area) : centroid };
}

// Recognize closed planar boundary rings, with tolerances relative to their size.
// These are estimates on tessellation, never analytic BRep claims.
export function cadDetectPatterns(segments) {
  if (segments.length < 4 || segments.length > 20000) return [];
  const box = new THREE.Box3().setFromPoints(segments.flat()), extent = box.getSize(V()).length();
  if (!extent) return [];
  const tolerance = extent * 1e-6, vertices = [], nodes = new Map(), edges = [];
  const idFor = point => {
    const key = point.clone().sub(box.min).toArray().map(value=>Math.round(value/tolerance)).join(',');
    if (!nodes.has(key)) { nodes.set(key,vertices.length); vertices.push({ point, edges:[] }); } return nodes.get(key);
  };
  for (const [a,b] of segments) { const ids=[idFor(a),idFor(b)]; if(ids[0]===ids[1])continue;const index=edges.length;edges.push(ids);for(const id of ids)vertices[id].edges.push(index); }
  const used = new Set(), patterns=[];
  for(let seed=0;seed<edges.length && patterns.length<32;seed++) {
    if(used.has(seed))continue;
    const start=edges[seed][0], ring=[], component=[], pending=[start], seen=new Set();let valid=true;
    for(let cursor=0;cursor<pending.length;cursor++) { const id=pending[cursor];if(seen.has(id))continue;seen.add(id);component.push(id);if(vertices[id].edges.length!==2)valid=false;for(const edge of vertices[id].edges){used.add(edge);for(const next of edges[edge])if(!seen.has(next))pending.push(next);} }
    if(!valid)continue;
    let current=start,previous=-1;
    do { ring.push(vertices[current].point);const edge=vertices[current].edges.find(value=>value!==previous);previous=edge;current=edges[edge].find(value=>value!==current); } while(current!==start && ring.length<=component.length);
    if(current!==start || ring.length<4)continue;
    // Remove tessellator subdivisions on straight sides before rectangle checks.
    const corners=ring.filter((point,index)=>{
      const before=point.clone().sub(ring[(index+ring.length-1)%ring.length]),after=ring[(index+1)%ring.length].clone().sub(point);
      return before.clone().cross(after).length()>before.length()*after.length()*1e-4 || before.dot(after)<0;
    });
    if(corners.length===4) {
      const sides=corners.map((point,i)=>corners[(i+1)%4].clone().sub(point)),normal=sides[0].clone().cross(sides[1]).normalize();
      if(sides.every((side,i)=>Math.abs(side.clone().normalize().dot(sides[(i+1)%4].clone().normalize()))<.01) && corners.every(point=>Math.abs(point.clone().sub(corners[0]).dot(normal))<tolerance*4) && Math.abs(sides[0].length()-sides[2].length())<extent*.005 && Math.abs(sides[1].length()-sides[3].length())<extent*.005) {
        patterns.push({ kind:'rectangle', sides:[sides[0].length(),sides[1].length()], center:corners.reduce((sum,p)=>sum.add(p),V()).multiplyScalar(.25), corners });continue;
      }
    }
    if(ring.length<12)continue;
    const a=ring[0],u=ring[Math.floor(ring.length/3)].clone().sub(a),v=ring[Math.floor(ring.length*2/3)].clone().sub(a),n=u.clone().cross(v),denominator=2*n.lengthSq();
    if(denominator<extent**4*1e-12)continue;
    const center=a.clone().add(v.clone().cross(n).multiplyScalar(u.lengthSq()).add(n.clone().cross(u).multiplyScalar(v.lengthSq())).divideScalar(denominator)),radius=center.distanceTo(a),normal=n.normalize();
    if(!radius || ring.some(point=>Math.abs(point.distanceTo(center)-radius)>radius*.005 || Math.abs(point.clone().sub(center).dot(normal))>radius*.002))continue;
    const x=a.clone().sub(center).normalize(),y=normal.clone().cross(x);
    const angles=ring.map(point=>{const delta=point.clone().sub(center);return Math.atan2(delta.dot(y),delta.dot(x));});
    const turns=angles.map((angle,i)=>{const delta=angles[(i+1)%angles.length]-angle;return Math.atan2(Math.sin(delta),Math.cos(delta));});
    const winding=Math.sign(turns[0]);
    // Every chord must advance once around the ring; stars and retraced arcs
    // can have all vertices on a circle without having a circular boundary.
    if(turns.some(turn=>turn*winding<=0 || Math.abs(turn)>Math.PI/3) || Math.abs(turns.reduce((sum,turn)=>sum+turn,0)-winding*Math.PI*2)>.01)continue;
    patterns.push({kind:'circle',center,radius,normal,point:a});
  }
  return patterns;
}

let selectionPanelSequence = 0;
export function createCadSelection({ scene, camera, stage, root, results, getMeshes, getState, getRadius, getSectionPlanes, render, focusSelection }) {
  const topology = new WeakMap(), raycaster = new THREE.Raycaster();
  let selected = [], objects = [], hovered, hoverObjects = [], lastPointer, activeTab = 'overview', pickingMode = 'auto';
  const radioName = 'cad-measurements-' + (++selectionPanelSequence);
  const secondColor = '#c66a20';
  const number = value => {
    const digits = getState().decimalPlaces === undefined ? 3 : Math.max(0, Math.min(10, Math.round(Number(getState().decimalPlaces) || 0)));
    if (!Number.isFinite(value)) return '—';
    const rounded = Number(value.toFixed(digits));
    return (Object.is(rounded, -0) ? 0 : rounded).toLocaleString('en-US', { maximumFractionDigits: digits });
  };
  const error = document.createElement('div'); error.className = 'cad-selection-error'; error.setAttribute('role','status'); error.setAttribute('aria-live','polite'); error.hidden = true; stage.append(error);
  function setError(message = '') { error.textContent = message; error.hidden = !message; }

  const scale = () => ({ mm: 1, cm: 10, in: 25.4 })[getState().unit] || 1;
  const unit = () => getState().unit;
  const distanceText = value => `${number(value / scale())} ${unit()}`;
  const dataFor = mesh => { if (!topology.has(mesh)) topology.set(mesh, cadTopology(mesh)); return topology.get(mesh); };
  const world = (mesh, point) => point.clone().applyMatrix4(mesh.matrixWorld);
  function dispose(list) {
    for (const object of list) { object.removeFromParent(); object.geometry?.dispose(); object.material?.map?.dispose(); object.material?.dispose(); }
    list.length = 0;
  }
  function line(points, color, list, opacity = 1) {
    const object = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color, clippingPlanes:getSectionPlanes(), depthTest: false, depthWrite: false, transparent: opacity < 1, opacity }));
    object.renderOrder = 20; object.userData.annotation = 'selection'; scene.add(object); list.push(object);
  }
  function overlay(entity, color, list, hover = false) {
    if (entity.kind === 'vertex') {
      const marker = new THREE.Mesh(new THREE.SphereGeometry(getRadius() * .009 * getState().measurementPointSize, 12, 8), new THREE.MeshBasicMaterial({ color, clippingPlanes:getSectionPlanes(), depthTest: false, depthWrite: false }));
      marker.position.copy(entity.primitives[0][0]); marker.renderOrder = 21; scene.add(marker); list.push(marker);
    } else if (['edge', 'loop'].includes(entity.kind)) line(entity.primitives.flat(), color, list);
    else {
      const geometry = new THREE.BufferGeometry().setFromPoints(entity.primitives.flat());
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: hover ? .14 : .34, clippingPlanes:getSectionPlanes(), depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
      mesh.renderOrder = 10; scene.add(mesh); list.push(mesh); line(entity.boundary.flat(), color, list, .85);
    }
  }
  function entity(mesh, kind, indices) {
    const data = dataFor(mesh); mesh.updateWorldMatrix(true, false);
    const result = { mesh, kind, indices, key: `${mesh.uuid}:${kind}:${[...indices].sort().join(',')}` };
    if (kind === 'vertex') result.primitives = [[world(mesh, data.vertices[indices[0]])]];
    else if (kind === 'edge' || kind === 'loop') result.primitives = indices.map(key => data.edges.get(key).ids.map(id => world(mesh, data.vertices[id])));
    else {
      const faces = new Set(indices); result.primitives = indices.map(index => data.triangles[index].points.map(point => world(mesh, point)));
      result.boundary = [...data.edges.values()].filter(edge => kind === 'part' ? edge.feature : edge.faces.filter(face => faces.has(face)).length === 1).map(edge => edge.ids.map(id => world(mesh, data.vertices[id])));
      result.metrics = cadGeometryMetrics(result.primitives, kind === 'part' && data.closed);
    }
    return result;
  }
  function pick(event) {
    const meshes = getMeshes(); if (!meshes.length) return;
    const rect = stage.getBoundingClientRect(), pointer = new THREE.Vector2(event.clientX - rect.left, event.clientY - rect.top);
    if (!rect.width || !rect.height) return;
    raycaster.setFromCamera(new THREE.Vector2(pointer.x / rect.width * 2 - 1, -pointer.y / rect.height * 2 + 1), camera);
    let hit = raycaster.intersectObjects(meshes.filter(mesh => mesh.visible), false).find(hit => getSectionPlanes().every(plane => plane.distanceToPoint(hit.point) >= -1e-7));
    // Keep silhouette edges and their endpoints pickable within the same pixel
    // tolerance on either side of the outline, including just outside a face.
    if (!hit) {
      let best = 9, bestDepth = Infinity;
      for (const mesh of meshes.filter(mesh => mesh.visible)) {
        const data = dataFor(mesh);
        for (const edge of data.edges.values()) {
          if (!edge.feature) continue;
          const points = edge.ids.map(id => world(mesh, data.vertices[id]));
          const projected = points.map(point => point.clone().project(camera));
          if (projected.some(point => point.z < -1 || point.z > 1)) continue;
          const [a, b] = projected.map(point => new THREE.Vector2((point.x + 1) * rect.width / 2, (1 - point.y) * rect.height / 2));
          const direction = b.clone().sub(a), t = direction.lengthSq() < 1e-10 ? (projected[0].z <= projected[1].z ? 0 : 1) : THREE.MathUtils.clamp(pointer.clone().sub(a).dot(direction) / direction.lengthSq(), 0, 1);
          const closest = points[0].clone().lerp(points[1], t);
          if (getSectionPlanes().some(plane => plane.distanceToPoint(closest) < -1e-7)) continue;
          const distance = a.addScaledVector(direction, t).distanceTo(pointer);
          const depth = closest.clone().project(camera).z;
          if (distance < best - 0.1 || distance <= best + 0.1 && distance < 9 && depth < bestDepth) { best = distance; bestDepth = depth; hit = { object: mesh, faceIndex: edge.faces[0], edgeKey:edge.key }; }
        }
      }
    }
    if (!hit) return;
    const mesh = hit.object, data = dataFor(mesh), triangle = data.triangles[hit.faceIndex];
    if (pickingMode === 'part') return entity(mesh, 'part', data.triangles.map((_, index) => index));
    const project = point => { const p = world(mesh, point).project(camera); return new THREE.Vector2((p.x + 1) * rect.width / 2, (1 - p.y) * rect.height / 2); };
    // Preserve the edge found outside the silhouette. Its arbitrary first face
    // can also contain a rear endpoint at the same screen coordinate.
    const candidateEdges = hit.edgeKey ? [hit.edgeKey] : triangle.edges;
    const candidateVertices = hit.edgeKey ? data.edges.get(hit.edgeKey).ids : triangle.ids;
    let vertex, vertexDistance = 9, vertexDepth = Infinity;
    for (const id of candidateVertices) {
      const point=world(mesh,data.vertices[id]),projected=point.clone().project(camera);
      if(projected.z < -1 || projected.z > 1 || getSectionPlanes().some(plane=>plane.distanceToPoint(point)<-1e-7))continue;
      const distance = new THREE.Vector2((projected.x+1)*rect.width/2,(1-projected.y)*rect.height/2).distanceTo(pointer);
      if(distance<9 && (distance<vertexDistance-.1 || distance<=vertexDistance+.1 && projected.z<vertexDepth)) {vertexDistance=distance;vertexDepth=projected.z;vertex=id;}
    }
    let edge, edgeDistance = 7, edgeDepth = Infinity;
    for (const key of candidateEdges) {
      const candidate = data.edges.get(key); if (!candidate.feature) continue;
      const points=candidate.ids.map(id=>world(mesh,data.vertices[id])),projected=points.map(point=>point.clone().project(camera));
      if(projected.some(point=>point.z < -1 || point.z > 1))continue;
      const [a,b]=projected.map(point=>new THREE.Vector2((point.x+1)*rect.width/2,(1-point.y)*rect.height/2));
      const direction=b.clone().sub(a),t=direction.lengthSq()<1e-10?(projected[0].z<=projected[1].z?0:1):THREE.MathUtils.clamp(pointer.clone().sub(a).dot(direction)/direction.lengthSq(),0,1);
      const closest=points[0].clone().lerp(points[1],t);
      if(getSectionPlanes().some(plane=>plane.distanceToPoint(closest)<-1e-7))continue;
      const distance=a.addScaledVector(direction,t).distanceTo(pointer),depth=closest.project(camera).z;
      if(distance<7 && (distance<edgeDistance-.1 || distance<=edgeDistance+.1 && depth<edgeDepth)){edgeDistance=distance;edgeDepth=depth;edge=key;}
    }
    if (pickingMode === 'auto' && vertex !== undefined) return entity(mesh, 'vertex', [vertex]);
    if (pickingMode === 'auto' && edge) return entity(mesh, 'edge', [edge]);
    const region = cadFaceRegion(data, hit.faceIndex);
    if (pickingMode !== 'loop') return entity(mesh, 'face', [...region]);
    const boundary = [...data.edges.values()].filter(candidate => candidate.faces.filter(face => region.has(face)).length === 1);
    const nearest = edge && boundary.find(candidate => candidate.key === edge) || boundary.reduce((best, candidate) => {
      const [a, b] = candidate.ids.map(id => project(data.vertices[id])); const distance = a.clone().add(b).multiplyScalar(.5).distanceTo(pointer);
      return !best || distance < best.distance ? { edge: candidate, distance } : best;
    }, undefined)?.edge;
    if (!nearest) return entity(mesh, 'face', [...region]);
    const ids = new Set(nearest.ids), keys = new Set([nearest.key]);
    let changed = true;
    while (changed) { changed = false; for (const candidate of boundary) if (!keys.has(candidate.key) && candidate.ids.some(id => ids.has(id))) { keys.add(candidate.key); candidate.ids.forEach(id => ids.add(id)); changed = true; } }
    return entity(mesh, 'loop', [...keys]);
  }
  function table(host, title, rows, className = '') {
    const section = document.createElement('section'); section.className = className;
    const table = document.createElement('table'); table.setAttribute('aria-label', title);
    for (const [key, value] of rows) {
      const row = document.createElement('tr'), name = document.createElement('th'), cell = document.createElement('td'); name.scope = 'row';
      if (key === 'Selection 2' || key.startsWith('2 · ')) row.dataset.selection = '2';
      for (const [container, text] of [[name, key], [cell, value]]) {
        const scroll = document.createElement('div'); scroll.className = 'cad-cell-scroll'; scroll.tabIndex = 0; scroll.textContent = container === cell ? ' ' + text : text; container.append(scroll);
      }
      row.append(name, cell); table.append(row);
    }
    section.append(table); host.append(section); return section;
  }
  const vectorText = point => ['x','y','z'].map(axis => number(point[axis] / scale())).join(', ') + ' ' + unit();
  function marker(point,color) {
    const object=new THREE.Mesh(new THREE.SphereGeometry(getRadius()*.007*getState().measurementPointSize,12,8),new THREE.MeshBasicMaterial({color,depthTest:false,depthWrite:false}));
    object.position.copy(point);object.renderOrder=22;object.userData.annotation='measurement';scene.add(object);objects.push(object);
  }
  function guide(points) { line(points,getState().measurementColor,objects);objects.at(-1).userData.annotation='measurement';objects.at(-1).material.clippingPlanes=[];root.dataset.measurementGuides=String(Number(root.dataset.measurementGuides)+1); }
  const titleFor = item => item.kind[0].toUpperCase()+item.kind.slice(1);
  function rowsFor(item, detail) {
    const rows = [], box = new THREE.Box3().setFromPoints(item.primitives.flat());
    if (detail) {
      rows.push(['Type', titleFor(item)]);
      if (item.mesh.name) rows.push(['Part', item.mesh.name]);
    }
    if (item.kind === 'vertex') rows.push(['X, Y, Z', vectorText(item.primitives[0][0])]);
    else if (item.kind === 'edge' || item.kind === 'loop') {
      rows.push(['Length', distanceText(item.primitives.reduce((sum,[a,b])=>sum+a.distanceTo(b),0))]);
      if (detail && item.kind === 'edge') {
        const [a,b] = item.primitives[0]; rows.push(['Start X, Y, Z', vectorText(a)], ['End X, Y, Z', vectorText(b)], ['ΔX, Y, Z', vectorText(b.clone().sub(a))]);
      }
      if (detail && item.kind === 'loop') rows.push(['Segments', number(item.primitives.length)]);
    } else {
      const {area,volume,centroid} = item.metrics;
      rows.push([item.kind === 'part' ? 'Surface area' : 'Area', '≈ ' + number(area/scale()**2) + ' ' + unit() + '²']);
      if (item.kind === 'face') rows.push(['Perimeter', distanceText(item.boundary.reduce((sum,[a,b])=>sum+a.distanceTo(b),0))]);
      if (item.kind === 'part') rows.push(['Volume', volume === undefined ? 'Unavailable: open mesh' : '≈ ' + number(volume/scale()**3) + ' ' + unit() + '³']);
      if (detail) {
        rows.push(['Centroid X, Y, Z', vectorText(centroid)], ['Triangles', number(item.primitives.length)]);
        if (item.kind === 'face') rows.push(['Normal X, Y, Z', new THREE.Triangle(...item.primitives[0]).getNormal(V()).toArray().map(number).join(', ')]);
      }
    }
    if (detail && item.kind !== 'vertex') rows.push(['Bounds X, Y, Z', vectorText(box.getSize(V()))], ['Minimum X, Y, Z', vectorText(box.min)], ['Maximum X, Y, Z', vectorText(box.max)]);
    for (const [patternIndex,pattern] of item.patterns.entries()) {
      const suffix=item.patterns.length>1?' ' + (patternIndex+1):'';
      rows.push(['Pattern'+suffix, pattern.kind === 'circle' ? 'Circle ≈' : 'Rectangle ≈']);
      if (pattern.kind === 'circle') {
        rows.push(['Radius'+suffix, '≈ ' + distanceText(pattern.radius)], ['Diameter'+suffix, '≈ ' + distanceText(pattern.radius*2)]);
        if (detail) rows.push(['Center'+suffix+' X, Y, Z', vectorText(pattern.center)]);
      } else rows.push(['Side A'+suffix, distanceText(pattern.sides[0])], ['Side B'+suffix, distanceText(pattern.sides[1])]);
    }
    return rows;
  }
  function pairRows() {
    if (selected.length !== 2) return [];
    const [first,second]=selected,pair=cadClosestGeometry(first.primitives,second.primitives);
    if (!pair) return [];
    const delta=pair[1].clone().sub(pair[0]),distance=delta.length(),rows=[['Closest distance','≈ '+distanceText(distance)],['ΔX, Y, Z',vectorText(delta)]];
    if(first.kind==='edge' && second.kind==='edge') {
      const angle=first.primitives[0][1].clone().sub(first.primitives[0][0]).angleTo(second.primitives[0][1].clone().sub(second.primitives[0][0]));
      rows.push(['Angle',number(THREE.MathUtils.radToDeg(Math.min(angle,Math.PI-angle)))+'°']);
    } else if(first.kind==='face' && second.kind==='face') {
      const normals=[first,second].map(item=>new THREE.Triangle(...item.primitives[0]).getNormal(V()));
      rows.push(['Angle',number(THREE.MathUtils.radToDeg(Math.acos(Math.min(1,Math.abs(normals[0].dot(normals[1]))))))+'°']);
    } else if ([first.kind,second.kind].includes('face') && [first.kind,second.kind].includes('edge')) {
      const face=first.kind==='face'?first:second,edge=first.kind==='edge'?first:second;
      const normal=new THREE.Triangle(...face.primitives[0]).getNormal(V()),direction=edge.primitives[0][1].clone().sub(edge.primitives[0][0]).normalize();
      rows.push(['Angle',number(THREE.MathUtils.radToDeg(Math.asin(Math.min(1,Math.abs(normal.dot(direction))))))+'°']);
    }
    guide(pair);for(const point of pair)marker(point,getState().measurementColor);
    for(const [item,foot,other] of [[first,pair[0],pair[1]],[second,pair[1],pair[0]]]) if(item.kind==='edge' && distance>1e-10) {
      const [a,b]=item.primitives[0],edge=b.clone().sub(a).normalize(),normal=other.clone().sub(foot).normalize(),size=Math.min(getRadius()*.035,distance*.2,a.distanceTo(b)*.15);
      if(Math.abs(edge.dot(normal))<.01 && size>0) {const side=foot.clone().addScaledVector(edge,foot.distanceTo(a)<foot.distanceTo(b)?size:-size);guide([side,side.clone().addScaledVector(normal,size),side.clone().addScaledVector(normal,size),foot.clone().addScaledVector(normal,size)]);}
    }
    return rows;
  }
  function refresh() {
    dispose(objects); results.replaceChildren(); root.dataset.measurementGuides='0';
    const tabs=document.createElement('div');tabs.className='cad-measurement-tabs';tabs.setAttribute('role','radiogroup');tabs.setAttribute('aria-label','Measurement details');
    const panes=new Map(),inputs=new Map();
    if(activeTab!=='overview' && !selected[Number(activeTab)-1])activeTab='overview';
    const chooseTab = value => {activeTab=value;for(const [key,pane] of panes)pane.hidden=key!==value;for(const [key,input] of inputs)input.checked=key===value;};
    for(const [value,title] of [['overview','Overview'],['1','Selection 1'],['2','Selection 2']]) {
      const label=document.createElement('label'),input=document.createElement('input');input.type='radio';input.name=radioName;input.value=value;input.checked=value===activeTab;input.disabled=value!=='overview' && !selected[Number(value)-1];input.setAttribute('aria-label',title);input.onchange=()=>chooseTab(value);
      const text=document.createElement('span');text.textContent=title;label.append(input,text);tabs.append(label);inputs.set(value,input);
      const pane=document.createElement('div');pane.className='cad-measurement-pane';pane.dataset.selectionTab=value;pane.hidden=value!==activeTab;panes.set(value,pane);
    }
    results.append(tabs);
    const pickControl=document.createElement('label');pickControl.className='cad-pick-control';pickControl.append('Pick');
    const picker=document.createElement('select');picker.setAttribute('aria-label','Pick geometry');
    for(const [value,title] of [['auto','Auto'],['face','Face'],['part','Part'],['loop','Boundary']]) {const option=document.createElement('option');option.value=value;option.textContent=title;picker.append(option);}
    picker.value=pickingMode;picker.onchange=()=>{pickingMode=picker.value;clearHover();};pickControl.append(picker);results.append(pickControl,...panes.values());
    const overview=panes.get('overview'),overviewRows=[];
    for(const [index,item] of selected.entries()) {
      overlay(item,index===1?secondColor:getState().selectionColor,objects);
      item.patterns ??= cadDetectPatterns(item.boundary || (item.kind==='loop'?item.primitives:[]));
      const prefix=(index+1)+' · ';
      overviewRows.push(['Selection '+(index+1),titleFor(item)],...rowsFor(item,false).map(([key,value])=>[prefix+key,value]));
      for(const pattern of item.patterns)if(pattern.kind==='circle'){guide([pattern.center,pattern.point]);marker(pattern.center,getState().measurementColor);}
      const pane=panes.get(String(index+1));pane.dataset.selectionIndex=String(index+1);
      table(pane,'Selection '+(index+1)+' measurements',rowsFor(item,true),'cad-selection-result');
      const buttons=document.createElement('div');buttons.className='cad-selection-actions';
      const zoom=document.createElement('button');zoom.type='button';zoom.textContent='Zoom to selection';zoom.setAttribute('aria-label','Zoom to selection '+(index+1));zoom.disabled=typeof focusSelection!=='function';zoom.onclick=()=>focusSelection?.(new THREE.Box3().setFromPoints(item.primitives.flat()));
      const deselect=document.createElement('button');deselect.type='button';deselect.textContent='Deselect';deselect.setAttribute('aria-label','Deselect selection '+(index+1));deselect.onclick=()=>{selected.splice(index,1);setError();refresh();};
      buttons.append(zoom,deselect);pane.append(buttons);
    }
    if(selected.length) {
      const measurements=pairRows();
      table(overview,'Measurements overview',[...overviewRows,...measurements],measurements.length?'cad-selection-distance':'cad-selection-overview');
    } else {const empty=document.createElement('p');empty.className='cad-selection-empty';empty.textContent='Select a point, edge, face, or part.';overview.append(empty);}
    results.hidden=false;root.dataset.selectionCount=String(selected.length);root.dataset.selectionKind=selected.at(-1)?.kind||'';render();
  }
  function clearHover() { dispose(hoverObjects); hovered = undefined; root.dataset.hoveredPart = ''; root.dataset.hoveredKind = ''; render(); }
  return {
    pick,
    stats:()=>({labels:objects.filter(object=>object.isSprite).length,guides:objects.filter(object=>object.isLine && object.userData.annotation==='measurement').length}),
    select(event) {
      const item=pick(event); if (!item) return;
      const index=selected.findIndex(previous=>previous.key===item.key);
      if(index>=0) selected.splice(index,1);
      else if(selected.length>=2) {setError('Select up to 2 items.');return;}
      else selected.push(item);
      setError();refresh();
    },
    hover(event) {
      lastPointer = { clientX:event.clientX, clientY:event.clientY };
      if (!getState().hoverHighlights) return clearHover();
      const item = pick(event); if (item?.key === hovered?.key) return;
      clearHover(); if (!item) return;
      hovered = item; root.dataset.hoveredPart = String(getMeshes().indexOf(item.mesh)); root.dataset.hoveredKind = item.kind;
      overlay(item, selected[1]?.key === item.key ? secondColor : getState().selectionColor, hoverObjects, true); render();
    },
    modifiers() {},
    clear() { selected = []; setError(); refresh(); }, clearHover() { lastPointer = undefined; clearHover(); }, refresh,
    dispose() { selected = []; dispose(objects); dispose(hoverObjects); error.remove(); },
  };
}
