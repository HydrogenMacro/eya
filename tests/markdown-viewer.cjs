const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const esbuild = require('esbuild');
(async()=>{
  const result = await esbuild.build({entryPoints:['client/markdown-viewer.js','client/file-openers.js'],bundle:true,format:'iife',outdir:'/tmp/eya-markdown-test',write:false,globalName:'feature'});
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage(); const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<main></main>');
    await page.addScriptTag({content:result.outputFiles.find(f=>f.path.endsWith('markdown-viewer.js')).text});
    await page.evaluate(()=>{window.markdown=feature;});
    await page.addScriptTag({content:result.outputFiles.find(f=>f.path.endsWith('file-openers.js')).text});
    assert.deepEqual(await page.evaluate(()=>{
      const valid=new Uint8Array(65538).fill(65);valid.set([0xe2,0x82,0xac],65535);
      const invalid=valid.slice();invalid[65537]=0xff;
      return [feature.isBinaryContent(valid),feature.isBinaryContent(invalid),feature.isBinaryContent(Uint8Array.of(1,2,3)),feature.isBinaryContent(new Uint8Array())];
    }),[false,true,true,false]);
    await page.evaluate(()=>{
      const content='# Heading\n\n[Foo][] [label][foo] [foo]\n\n[foo]: next\\(copy\\).md\n\n![alt][]\n\n[alt]: pic.svg\n\n![unsupported](huge.bin)\n![next](second.svg)\n\n<script>window.executed=true</script>\n';
      window.active=0;window.peak=0;window.calls=[];window.opened=[];
      window.view=markdown.createMarkdownViewer({path:'/docs/readme.md',bytes:new TextEncoder().encode(content)},{openFile:path=>opened.push(path),readResource:async(path,budget)=>{
        active++;peak=Math.max(peak,active);calls.push({path,budget});await new Promise(resolve=>setTimeout(resolve,20));active--;
        return {bytes:new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')};
      }});document.querySelector('main').append(view.element);
    });
    await page.waitForFunction(()=>calls.length===2&&active===0);
    const calls=await page.evaluate(()=>({peak,calls,links:[...document.querySelectorAll('a')].map(a=>a.textContent)}));
    assert.equal(calls.peak,1);assert.equal(calls.calls[0].path,'/docs/pic.svg');assert.equal(calls.calls[1].path,'/docs/second.svg');assert(calls.calls[1].budget<calls.calls[0].budget);assert.deepEqual(calls.links,['Foo','label','foo']);
    await page.getByRole('link',{name:'Foo',exact:true}).click();assert.deepEqual(await page.evaluate(()=>opened),['/docs/next(copy).md']);
    assert.equal(await page.evaluate(()=>window.executed),undefined);
    await page.evaluate(()=>{view.dispose();document.querySelector('main').replaceChildren();window.view=markdown.createMarkdownViewer({path:'/large.md',bytes:new TextEncoder().encode('# First\n'+'a'.repeat(2*1024*1024)+'\n# Hidden')});document.querySelector('main').append(view.element);});
    await page.getByRole('status').filter({hasText:'Preview limit reached'}).waitFor();assert.equal(await page.getByRole('heading',{name:'Hidden'}).count(),0);
    await page.evaluate(()=>{view.dispose();document.querySelector('main').replaceChildren();window.view=markdown.createMarkdownViewer({path:'/nested.md',bytes:new TextEncoder().encode('> '.repeat(3000)+'text')});document.querySelector('main').append(view.element);});
    await page.getByRole('status').filter({hasText:'Preview limit reached'}).waitFor();
    await page.evaluate(()=>{view.dispose();document.querySelector('main').replaceChildren();window.control=feature.createFileOpenerControl();document.querySelector('main').append(control);control.setValue({md:'markdown',txt:'text'});});
    await page.getByRole('button',{name:'Add extension'}).click();
    const last=page.locator('tbody tr').last();await last.locator('input').fill('MD');await last.locator('select').selectOption('binary');
    assert.deepEqual(await page.evaluate(()=>control.getValue()),{md:'markdown',txt:'text'});
    assert.equal(await last.locator('input').evaluate(input=>input.validity.valid),false);
    await last.locator('input').fill('new');assert.deepEqual(await page.evaluate(()=>control.getValue()),{md:'markdown',txt:'text',new:'binary'});
    await page.evaluate(()=>{window.events=0;control.addEventListener('input',()=>events++);});await page.getByRole('searchbox',{name:'Search file extensions'}).fill('new');assert.equal(await page.evaluate(()=>events),0);
    assert.deepEqual(errors,[]);console.log('Markdown: collapsed/shortcut references, escapes, safe HTML, queued typed/budgeted resources, preview limit; extension table validation and UTF-8 boundary sniffing passed');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
