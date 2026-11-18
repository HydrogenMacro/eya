import { LoadingManager } from 'three';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { unzipSync, zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const UNIT_MM = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

// Check every central-directory size before the loader inflates any archive entry.
// Archives remain entirely in memory; no archive path becomes a filesystem path.
function analyze3mf(bytes) {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw Error('3MF archive exceeds 128 MiB.');
  let count = 0, total = 0;
  const names = new Set();
  unzipSync(bytes, { filter(entry) {
    if (++count > 4096 || entry.originalSize > MAX_ENTRY_BYTES || (total += entry.originalSize) > MAX_ARCHIVE_BYTES) throw Error('3MF expanded archive exceeds its limits.');
    if (entry.name === '__proto__' || names.has(entry.name) || /(^|\/)\.\.(\/|$)|\\|\0/.test(entry.name)) throw Error('Invalid 3MF archive path.');
    names.add(entry.name);
    return false;
  } });
  if (!count) throw Error('Empty or invalid 3MF archive.');
  const xmlFiles = unzipSync(bytes, { filter: entry => /\.model$|\.rels$/i.test(entry.name) });
  const models = new Map(), rewritten = new Map();
  let resourceNodes = 0, resourceTriangles = 0;
  for (const [name, data] of Object.entries(xmlFiles)) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw Error('3MF XML declarations are unsupported.');
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.querySelector('parsererror')) throw Error('Invalid 3MF XML.');
    if (/\.rels$/i.test(name)) {
      let changed = false;
      const part = name.replace(/(^|\/)\_rels\//, '$1').replace(/\.rels$/, '');
      for (const rel of xml.querySelectorAll('Relationship')) {
        if (rel.getAttribute('TargetMode')?.toLowerCase() === 'external') throw Error('External 3MF resources are unsupported.');
        const target = rel.getAttribute('Target');
        const resolved = new URL(target, `https://eya.invalid/${part}`);
        if (!target || resolved.origin !== 'https://eya.invalid' || resolved.search || resolved.hash) throw Error('Invalid embedded 3MF relationship.');
        const absolute = decodeURIComponent(resolved.pathname);
        if (absolute !== target) { rel.setAttribute('Target', absolute); changed = true; }
      }
      if (changed) rewritten.set(name, new XMLSerializer().serializeToString(xml));
    } else {
      const unit = xml.documentElement.getAttribute('unit') || 'millimeter';
      if (!Object.hasOwn(UNIT_MM, unit)) throw Error('Unsupported 3MF unit.');
      for (const resource of xml.querySelectorAll('resources > [id]')) {
        const id = resource.getAttribute('id');
        if (!/^\d+$/.test(id) || Number(id) > 0xffffffff) throw Error('Invalid 3MF resource ID.');
      }
      for (const mesh of xml.querySelectorAll('mesh')) {
        const vertices = mesh.querySelectorAll('vertices > vertex');
        for (const vertex of vertices) for (const axis of ['x','y','z']) {
          const value = vertex.getAttribute(axis);
          if (value === null || !Number.isFinite(Number(value))) throw Error('Invalid 3MF vertex.');
        }
        for (const triangle of mesh.querySelectorAll('triangles > triangle')) for (const key of ['v1','v2','v3']) {
          const value = triangle.getAttribute(key), index = Number(value);
          if (value === null || !Number.isInteger(index) || index < 0 || index >= vertices.length) throw Error('Invalid 3MF triangle index.');
        }
      }
      for (const item of xml.querySelectorAll('[transform]')) {
        const values = item.getAttribute('transform').trim().split(/\s+/).map(Number);
        if (values.length !== 12 || !values.every(Number.isFinite)) throw Error('Invalid 3MF transform.');
      }
      // Reject component cycles before the recursive scene builder runs.
      const objectNodes = [...xml.querySelectorAll('resources > object')];
      const objects = new Map(objectNodes.map(object => [object.getAttribute('id'), object]));
      if (objects.size !== objectNodes.length || objects.has(null)) throw Error('Invalid 3MF object IDs.');
      const complete = new Map(), active = new Set();
      const visit = (id, depth = 0) => {
        if (active.has(id) || depth > 128) throw Error('Cyclic or excessively nested 3MF components.');
        if (complete.has(id)) return complete.get(id);
        const object = objects.get(id);
        if (!object) throw Error('Missing 3MF component.');
        active.add(id);
        const size = { nodes: 1, depth: 1, triangles: object.querySelectorAll('mesh > triangles > triangle').length };
        for (const component of object.querySelectorAll('components > component')) {
          const child = visit(component.getAttribute('objectid'), depth + 1);
          size.nodes += child.nodes; size.triangles += child.triangles;
          size.depth = Math.max(size.depth, child.depth + 1);
          if (size.depth > 128 || size.nodes > 100000 || size.triangles > 2000000) throw Error('3MF expanded scene exceeds its limits.');
        }
        active.delete(id); complete.set(id, size); return size;
      };
      for (const id of objects.keys()) visit(id);
      for (const size of complete.values()) { resourceNodes += size.nodes; resourceTriangles += size.triangles; }
      if (resourceNodes > 100000 || resourceTriangles > 2000000) throw Error('3MF expanded resources exceed their limits.');
      let nodes = 0, triangles = 0;
      for (const item of xml.querySelectorAll('build > item')) {
        const size = visit(item.getAttribute('objectid'));
        nodes += size.nodes; triangles += size.triangles;
      }
      if (nodes > 100000 || triangles > 2000000) throw Error('3MF expanded scene exceeds its limits.');
      models.set(name, { unit, xml });
    }
  }
  const rels = xmlFiles['_rels/.rels'];
  if (!rels) throw Error('Missing 3MF root relationships.');
  const xml = new DOMParser().parseFromString(rewritten.get('_rels/.rels') || new TextDecoder().decode(rels), 'application/xml');
  const root = [...xml.querySelectorAll('Relationship')].find(rel => /\/3dmodel$/i.test(rel.getAttribute('Type') || ''));
  const name = root?.getAttribute('Target')?.replace(/^\//, '');
  const model = models.get(name);
  if (!model) throw Error('Missing 3MF root model.');
  for (const item of models.values()) if (item.unit !== model.unit) throw Error('Mixed-unit 3MF submodels are unsupported.');
  return { scale: UNIT_MM[model.unit], entries: count, expandedBytes: total, rewritten };
}

export function inspect3mf(bytes) { const { rewritten, ...info } = analyze3mf(bytes); return info; }

export async function parse3mf(bytes) {
  const info = analyze3mf(bytes);
  if (info.rewritten.size) {
    // The upstream loader expects absolute package targets, while OPC permits
    // relative relationships. Normalize those URIs in an in-memory archive.
    const files = unzipSync(bytes);
    for (const [name, text] of info.rewritten) files[name] = strToU8(text);
    bytes = zipSync(files, { level: 0 });
  }
  const manager = new LoadingManager();
  const urls = new Set();
  manager.setURLModifier(url => {
    if (!url.startsWith('blob:')) throw Error('3MF resources must be embedded in the archive.');
    urls.add(url);
    return url;
  });
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  let pending = false, failed = false, timer, model;
  let finish;
  const loaded = new Promise(resolve => { finish = resolve; });
  manager.onStart = () => { pending = true; };
  manager.onLoad = () => finish(true);
  manager.onError = () => { failed = true; };
  try {
    model = new ThreeMFLoader(manager).parse(data);
    if (pending) {
      timer = setTimeout(() => finish(false), 15000);
      if (!await loaded || failed) throw Error('Cannot decode embedded 3MF textures.');
    }
    model.scale.setScalar(info.scale);
    return model;
  } catch (error) {
    const geometries = new Set(), materials = new Set(), textures = new Set();
    model?.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) if (material) {
        materials.add(material); for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      }
    });
    for (const texture of textures) texture.dispose();
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
    throw error;
  } finally {
    clearTimeout(timer); for (const url of urls) URL.revokeObjectURL(url);
  }
}
