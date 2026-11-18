const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {fixture,KEY}=require('./continuity-fixture.cjs');
(async()=>{
 const f=await fixture();
 try{
  const page=await f.client({connect:false});await page.goto(f.http);
  const template=await fs.readFile('client.html','utf8');
  assert.ok(Buffer.byteLength(template)<32*1024*1024);
  const config={url:f.url,key:KEY,startupPanel:'none'};
  const html=template.replace('<script id="eya-config" type="application/json">{}</script>',()=>'<script id="eya-config" type="application/json">'+JSON.stringify(config)+'</script>');
  const artifacts=await page.evaluate(html=>Object.fromEntries(Object.entries(EyaGenerator).map(([name,fn])=>[name,fn(html)])),html);
  artifacts.html=html;
  for(const [name,source]of Object.entries(artifacts)){
   if(name==='dataUrl'){assert.match(source,/^data:text\/html/);assert.ok(source.length>1000);console.log('dataUrl: packaging checked; runtime checked by generator suites; browser local-network policy blocks data-origin loopback WebSockets');continue;}
   let url=source;
   if(name!=='dataUrl'){const file=path.join(f.root,'icons-'+name+(name.toLowerCase().includes('svg')?'.svg':'.html'));await fs.writeFile(file,source);url=pathToFileURL(file).href;}
   await page.goto(url);await page.locator('#url').waitFor();assert.equal(await page.locator('#url').evaluate(el=>el.value),f.url,name+' keeps config');
   await page.locator('#start-connection').click();await page.waitForFunction(()=>EyaWorkspaces.getState().workspace);
   await page.evaluate(cwd=>EyaPanels.create('files',{cwd}),f.files);
   const image=page.locator('.file-instance img.material-file-icon').first();await image.waitFor();
   await image.evaluate(img=>img.decode());assert.match(await image.getAttribute('src'),/^data:image\/svg\+xml;base64,/);assert.ok(await image.evaluate(img=>img.naturalWidth)>0);
   await page.locator('.file-instance .file-sort').first().click();
   console.log(name+': standalone config, encrypted files, embedded Material SVG icons and sort controls passed');
  }
  assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
