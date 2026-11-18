const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { buildSync } = require('esbuild');
const { zipSync, strToU8 } = require('fflate');

const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
const triangle = '<object id="1" name="Test plate" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="2" y="0" z="0"/><vertex x="0" y="3" z="1"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>';
function archive({ unit = 'millimeter', objects = triangle, build = '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 4 5 6"/>', extra = {} } = {}) {
  const xml = `<model unit="${unit}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objects}</resources><build>${build}</build></model>`;
  return zipSync({ '_rels/.rels': strToU8(rels), '3D/3dmodel.model': strToU8(xml), ...extra });
}

(async () => {
  const bundle = buildSync({ stdin: { contents: "import {inspect3mf,parse3mf} from './cad-3mf.js'; import {Box3} from 'three'; window.cad3mf={inspect3mf,parse3mf,Box3};", resolveDir: path.resolve('client') }, bundle: true, write: false, format: 'iife' }).outputFiles[0].text;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage(); await page.addScriptTag({ content: bundle });
    const inspect = bytes => page.evaluate(async data => {
      const bytes = new Uint8Array(data);
      try {
        const info = cad3mf.inspect3mf(bytes), model = await cad3mf.parse3mf(bytes);
        model.updateMatrixWorld(true);
        const bounds = new cad3mf.Box3().setFromObject(model);
        const meshes = []; model.traverse(item => { if (item.isMesh) meshes.push(item.name); });
        return { ...info, min: bounds.min.toArray(), max: bounds.max.toArray(), meshes };
      } catch (error) { return { error: error.message }; }
    }, Array.from(bytes));
    for (const [unit, scale] of [['millimeter',1],['centimeter',10],['inch',25.4],['meter',1000],['foot',304.8],['micron',0.001]]) {
      const result = await inspect(archive({ unit }));
      assert.equal(result.error, undefined, JSON.stringify(result)); assert.equal(result.scale, scale);
      result.min.forEach((value, index) => assert.ok(Math.abs(value - [4,5,6][index] * scale) < scale * 1e-6));
      result.max.forEach((value, index) => assert.ok(Math.abs(value - [6,8,7][index] * scale) < scale * 1e-6));
      assert.deepEqual(result.meshes, ['Test plate']);
    }
    const relative = archive({extra:{'_rels/.rels':strToU8(rels.replace('/3D/3dmodel.model','3D/3dmodel.model'))}});
    assert.equal((await inspect(relative)).error,undefined);
    const external=archive({extra:{'_rels/.rels':strToU8(rels.replace('Target="/3D/3dmodel.model"','Target="https://example.invalid/model.model" TargetMode="External"'))}});
    assert.match((await inspect(external)).error,/External/);
    const component = '<object id="2" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></components></object>';
    assert.deepEqual((await inspect(archive({ objects: triangle + component, build: '<item objectid="2"/>' }))).min, [10,0,0]);
    assert.match((await inspect(archive({ unit: 'parsec' }))).error, /unit/);
    assert.match((await inspect(archive({ objects: '<object id="1"><components><component objectid="1"/></components></object>' }))).error, /Cyclic/);
    assert.match((await inspect(archive({ extra: { '../escape': strToU8('x') } }))).error, /path/);
    const prototypeArchive=Buffer.from(archive({extra:{extrafile:strToU8('x')}}));
    for(let offset=prototypeArchive.indexOf('extrafile');offset>=0;offset=prototypeArchive.indexOf('extrafile',offset+9))prototypeArchive.write('__proto__',offset);
    assert.match((await inspect(prototypeArchive)).error,/path/);
    assert.match((await inspect(archive({objects:triangle.replace('id="1"','id="__proto__"')}))).error,/resource ID/);
    const tooLarge = archive(); const view = new DataView(tooLarge.buffer);
    for (let offset = 0; offset < tooLarge.length - 28; offset++) if (view.getUint32(offset,true) === 0x02014b50) { view.setUint32(offset+24, 65*1024*1024,true); break; }
    assert.match((await inspect(tooLarge)).error, /limits/);
    const chain=triangle+Array.from({length:128},(_,i)=>`<object id="${i+2}"><components><component objectid="${i+1}"/></components></object>`).join('');
    assert.match((await inspect(archive({objects:chain,build:'<item objectid="129"/>'}))).error,/limits/);
    assert.match((await inspect(archive({objects:triangle.replace('v1="0"','v1="99"')}))).error,/index/);
    assert.match((await inspect(archive({objects:triangle.replace('x="2"','x="NaN"')}))).error,/vertex/);
    const doubling = triangle + Array.from({ length: 20 }, (_,i) => `<object id="${i+2}"><components><component objectid="${i+1}"/><component objectid="${i+1}"/></components></object>`).join('');
    assert.match((await inspect(archive({ objects: doubling, build: '<item objectid="21"/>' }))).error, /limits/);
    assert.ok((await inspect(new Uint8Array([1,2,3]))).error);
    console.log('3MF units, transforms, component assemblies, archive and scene limits passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
