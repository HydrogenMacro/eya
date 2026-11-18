const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { fixture } = require('./continuity-fixture.cjs');
(async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.files,'file10.txt'),'10'); await fs.writeFile(path.join(f.files,'file2.txt'),'2');
    await fs.writeFile(path.join(f.files,'picture.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>');
    await execFile('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=160x96:r=10','-t','4','-c:v','libvpx-vp9','-an','-y',path.join(f.files,'film.webm')]);
    await fs.writeFile(path.join(f.files,'film.en.forced.srt'),'1\n00:00:00,000 --> 00:00:03,500\nSidecar <b>caption</b>\n');
    await fs.writeFile(path.join(f.files,'film2.en.srt'),'1\n00:00:00,000 --> 00:00:03,500\nWrong video\n');
    const page=await f.client();await f.named(page,'Presentation');
    await page.evaluate(cwd=>{EyaPanels.open('browser');return EyaPanels.call('browser','navigate',cwd);},f.files);
    const modern=await page.evaluate(cwd=>EyaPanels.create('files',{cwd}),f.files);
    for(const [root,id] of [['#file-panel','browser'],['.file-instance',modern]]){
      await page.evaluate(id=>EyaPanels.activate(id),id);
      const table=page.locator(root+' .file-list');
      const names=()=>table.locator('tbody tr').evaluateAll(rows=>rows.map(r=>r.querySelector('.entry-name>span').textContent).filter(n=>n!=='..'));
      const baseline=await names();
      await table.getByRole('button',{name:'Name',exact:true}).click();
      assert.ok((await names()).indexOf('file2.txt')<(await names()).indexOf('file10.txt'));
      assert.equal(await table.locator('th').first().getAttribute('aria-sort'),'ascending');
      await table.getByRole('button',{name:'Name',exact:true}).click();
      assert.ok((await names()).indexOf('file10.txt')<(await names()).indexOf('file2.txt'));
      await table.getByRole('button',{name:'Name',exact:true}).click();assert.deepEqual(await names(),baseline);
      await table.getByRole('button',{name:'Size',exact:true}).click();
      assert.equal(await table.locator('th.size').getAttribute('aria-sort'),'ascending');
      await table.getByRole('button',{name:'Modified',exact:true}).click();
      await table.getByRole('button',{name:'Type',exact:true}).click();
      await table.getByRole('button',{name:'Name',exact:true}).click();
      await table.locator('tbody tr').filter({hasText:'file2.txt'}).click();
      await table.locator('tbody tr').filter({hasText:'file10.txt'}).click({modifiers:['Shift']});
      assert.equal(await table.locator('tbody tr.selected').count(),2,'Range selection follows displayed natural sorting');
      const label=table.locator('.entry-name>span').filter({hasText:'file2.txt'});
      assert.equal(await label.evaluate(el=>getComputedStyle(el).userSelect),'text');
      assert.ok(await table.locator('img.material-file-icon').count()>3);
      assert.match(await table.locator('tbody .modified').filter({hasText:'Today'}).first().innerText(),/^Today at /);
    }
    await page.evaluate(()=>{const el=document.getElementById('transfer-unit');el.value='auto';el.dispatchEvent(new Event('change'));});
    await f.saved(page);assert.equal((await f.snapshot()).workspaces.find(w=>w.name==='Presentation').preferences.transferUnit,'auto');
    await page.evaluate(file=>EyaPanels.openFile(file),path.join(f.files,'picture.svg'));
    await page.locator('.image-viewer-body').click({button:'right'});
    const saving=page.waitForEvent('download');await page.getByRole('menuitem',{name:'Download image',exact:true}).click();
    assert.equal((await saving).suggestedFilename(),'picture.svg');
    await page.evaluate(()=>{const speed=document.querySelector('#video-speed');speed.value='1.5';speed.dispatchEvent(new Event('change'));});
    await page.evaluate(file=>EyaPanels.openFile(file),path.join(f.files,'film.webm'));
    const video=page.frameLocator('.native-video-frame').locator('video');await video.waitFor();
    let ready=false;
    for(let attempt=0;attempt<100&&!ready;attempt++) { try { ready=await video.evaluate(v=>v.readyState>=1); } catch(error) { if(!/context|navigation|frame/i.test(error.message))throw error; } if(!ready)await page.waitForTimeout(150); }
    assert.equal(ready,true,'Streamed video metadata loads after service-worker initialization');
    assert.equal(await video.evaluate(v=>v.playbackRate),1.5,'Streamed player receives generated/workspace playback defaults');
    await page.evaluate(()=>{const speed=document.querySelector('#video-speed');speed.value='0.75';speed.dispatchEvent(new Event('change'));});
    await video.evaluate(v=>new Promise((resolve,reject)=>{const check=()=>{if(v.playbackRate===0.75)return resolve();setTimeout(check,20);};check();setTimeout(()=>reject(Error('Live playback defaults not updated')),3000);}));
    await video.locator('track[label="en.forced"]').waitFor({state:'attached'});
    assert.equal(await video.locator('track').count(),1,'Only the matching sidecar belongs to this video');
    const frame=page.frameLocator('.native-video-frame');
    await frame.getByRole('button',{name:'Settings',exact:true}).click();await frame.getByRole('menuitem',{name:'Subtitles',exact:true}).click();
    await frame.getByRole('menuitemradio',{name:'en.forced',exact:true}).click();
    await video.evaluate(v=>{v.currentTime=1;v.pause();});
    await frame.locator('.eya-video-captions').filter({hasText:'Sidecar caption'}).waitFor();
    assert.deepEqual(f.errors,[]);
    console.log('Live file sorting in both browsers, Material icons, dates, text selection, saved units, image context download and streamed sidecar subtitles passed.');
  }finally{await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
