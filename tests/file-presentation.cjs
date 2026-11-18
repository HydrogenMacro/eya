const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const load = file => { const module = { exports: {} }; new Function('module', 'exports', buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text)(module, module.exports); return module.exports; };
const { sortFiles, modifiedDate } = load('client/file-presentation.js');
const { fileProgress, setFileProgressUnit } = load('client/file-progress.js');
const { subtitleCandidates, subtitleVtt, discoverSubtitles } = load('client/video-subtitles.js');
(async () => {
  const files = [{ name: 'file10.txt', size: 3, modified: 20 }, { name: 'file2.rs', size: 1, modified: 30 }, { name: 'alpha.txt', size: 2, modified: 10 }];
  assert.equal(sortFiles(files), files, 'No sort preserves server ordering');
  for (const [key, expected] of [['name', ['alpha.txt','file2.rs','file10.txt']], ['size',['file2.rs','alpha.txt','file10.txt']], ['modified',['alpha.txt','file10.txt','file2.rs']], ['type',['file2.rs','file10.txt','alpha.txt']]]) {
    assert.deepEqual(sortFiles(files, { key, direction: 'ascending' }).map(f => f.name), expected);
    assert.deepEqual(sortFiles(files, { key, direction: 'descending' }).map(f => f.name), key === 'type' ? ['file10.txt','alpha.txt','file2.rs'] : [...expected].reverse());
  }
  const now = new Date(2026, 0, 1, 13, 0);
  assert.match(modifiedDate(new Date(2026,0,1,8,1).getTime(), now), /^Today at /);
  assert.match(modifiedDate(new Date(2025,11,31,22,1).getTime(), now), /^Yesterday at /);
  assert.match(modifiedDate(new Date(2024,11,1).getTime(), now), /2024/);
  assert.equal(modifiedDate('invalid', now), '—');
  assert.equal(fileProgress(1024, 2048), '1,024 B / 2,048 B (50%)');
  setFileProgressUnit('auto'); assert.equal(fileProgress(1024, 1048576), '1 KiB / 1 MiB (0%)');
  setFileProgressUnit('mb'); assert.equal(fileProgress(1048576), '1 MiB received · total unknown');
  setFileProgressUnit('kb'); assert.equal(fileProgress(1048576,1048576), '1,024 KiB / 1,024 KiB (100%)');
  const entries = ['Film.srt','Film.en.forced.vtt','Film 2.en.srt','Filmish.srt','Film.ass','film.de.ssa','other.vtt'].map(name => ({ name, kind: 'file', path: '/'+name, size: 100 }));
  assert.deepEqual(subtitleCandidates('/Film.mkv', [...entries,{ name:'Film.huge.srt',kind:'file',size:3000000 }]).map(f => f.name).sort(), ['Film.ass','Film.en.forced.vtt','Film.srt','film.de.ssa'].sort());
  assert.match(subtitleVtt('\uFEFF1\r\n00:00:01,100 --> 00:00:03,200\r\nHello', 'srt'), /WEBVTT\n\n1\n00:00:01.100 --> 00:00:03.200\nHello/);
  assert.match(subtitleVtt('[Events]\nFormat: Layer, Start, End, Text\nDialogue: 0,0:00:01.10,0:00:03.00,{\\b1}Hi\\N<unsafe>, comma', 'ass'), /00:00:01.100 --> 00:00:03.000\nHi\n&lt;unsafe&gt;, comma/);
  const tracks = await discoverSubtitles('/Film.mp4', async () => ({ entries:[{...entries[0],size:new TextEncoder().encode('1\n00:00:00,000 --> 00:00:03,000\nTest').length}] }), async (_,offset,length) => ({ bytes:new TextEncoder().encode('1\n00:00:00,000 --> 00:00:03,000\nTest').slice(offset,offset+length),meta:{version:'v1'} }));
  assert.equal(tracks[0].label, 'Film.srt'); assert.match(tracks[0].vtt, /Test/);
  console.log('File sorting, relative dates, transfer units, subtitle matching, conversion and discovery passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
