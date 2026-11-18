const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require('../client/node_modules/playwright');
const esbuild = require('../client/node_modules/esbuild');
(async () => {
  const bundle = await esbuild.build({ entryPoints: ['client/binary-viewer.js'], bundle: true, format: 'iife', globalName: 'binary', write: false });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 800 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const baseStyle=(await fs.readFile('client/template.html','utf8')).match(/<style>([\s\S]*?)<\/style>/)[1];
    await page.setContent(`<style>${baseStyle}\n#host{height:780px;width:100%;display:flex;flex-direction:column}</style><div id="host"></div>`);
    for (const file of ['client/components.css', 'client/radio-tabs.css', 'client/binary-viewer.css']) await page.addStyleTag({ content: await fs.readFile(file, 'utf8') });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    assert.deepEqual(await page.evaluate(() => {
      const bytes = new Uint8Array(8).fill(255), rejected = [];
      for (const [text, width, signed] of [['256',1,false], ['-129',1,true], ['9223372036854775808',8,true], ['-1',8,false], ['1.5',2,true]]) try { binary.binaryEncodeInteger(text,width,'little',signed); } catch { rejected.push(text); }
      return { u64: String(binary.binaryInteger(bytes,0,8)), i64:String(binary.binaryInteger(bytes,0,8,'big',true)), le:[...binary.binaryEncodeInteger('18446744073709551615',8)], be:[...binary.binaryEncodeInteger('258',2,'big')], min:[...binary.binaryEncodeInteger('-9223372036854775808',8,'big',true)], patterns:[[...binary.binarySearchPattern('DE AD be ef','hex')],[...binary.binarySearchPattern('01000001 11111111','binary')],[...binary.binarySearchPattern('é','text')]], rejected };
    }), { u64:'18446744073709551615',i64:'-1',le:Array(8).fill(255),be:[1,2],min:[128,0,0,0,0,0,0,0],patterns:[[222,173,190,239],[65,255],[195,169]],rejected:['256','-129','9223372036854775808','-1','1.5'] });
    await page.evaluate(() => {
      window.changes = []; window.prefs = [];
      const bytes = new Uint8Array(4096); for (let i=0;i<bytes.length;i++) bytes[i]=i%256;
      window.view = binary.createBinaryViewer({ bytes, onChange:value=>changes.push(value), onPreferencesChange:value=>prefs.push(value) }); document.querySelector('#host').append(view.element); view.resize();
    });
    const viewport=page.getByRole('grid',{name:'Binary data'}), mode=page.getByRole('combobox',{name:'Display',exact:true}), edit=page.getByRole('textbox',{name:'Edit selected value',exact:true});
    const rowAction=async name=>{ await page.getByRole('button',{name:'Row actions',exact:true}).click(); await page.getByRole('menuitem',{name,exact:true}).click(); };
    const goto=async offset=>{ await page.getByRole('button',{name:'Go to offset',exact:true}).click(); const input=page.getByRole('textbox',{name:'Go to offset',exact:true}); await input.fill(String(offset)); await input.press('Enter'); };
    assert.deepEqual(await mode.locator('option').allTextContents(),['Hex','Bin','Uint','Int']);
    assert.equal(await page.locator('.binary-toolbar input[type=checkbox]:visible').count(),0,'appearance toggles belong in settings');
    assert.equal(await page.locator('.binary-format-controls>.radio-tabs').count(),2,'width and byte order share the format group');
    assert.equal(await page.locator('.binary-toolbar').evaluate(el=>getComputedStyle(el).flexWrap),'nowrap');
    assert.equal(await page.locator('.binary-byte[data-offset="0"]').textContent(),'00');
    assert.equal(await page.locator('.binary-byte[data-offset="15"]').textContent(),'0F');
    assert((await page.locator('.binary-row').count())<45,'only visible rows mount');
    assert.equal(await page.locator('.binary-search').isVisible(),false,'find starts closed');
    await mode.selectOption('binary'); assert.equal(await page.locator('.binary-byte[data-offset="1"]').textContent(),'00000001');
    await mode.selectOption('signed'); await page.evaluate(()=>view.select(255)); assert.equal(await page.locator('.binary-byte[data-offset="255"]').textContent(),'-1');
    await mode.selectOption('unsigned'); assert.equal(await page.locator('.binary-byte[data-offset="255"]').textContent(),'255');
    await page.getByRole('radio',{name:'8 bytes',exact:true}).check(); await page.evaluate(()=>{view.overwrite(0,new Uint8Array(8).fill(255));view.select(0);});
    await page.getByRole('radio',{name:'Big endian',exact:true}).check();
    assert.equal(await page.locator('[data-value=unsigned]').textContent(),'18446744073709551615uint');
    assert.equal(await page.locator('[data-value=signed]').textContent(),'-1int');
    assert.match(await page.locator('.binary-info').textContent(),/^@0x0:0b[01]+0xFFFFFFFFFFFFFFFF18446744073709551615uint-1int$/);
    assert.doesNotMatch(await page.locator('.binary-info').textContent(),/selected| B/);
    await mode.selectOption('signed'); await edit.fill('-9223372036854775808'); await page.getByRole('button',{name:'Apply',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>[...view.getBytes().slice(0,8)]),[128,0,0,0,0,0,0,0]);
    await page.evaluate(()=>{window.saved=view.revision;view.insert(8,Uint8Array.of(99));view.markSaved(saved);});
    assert.equal(await page.evaluate(()=>view.dirty),true,'insert during upload stays dirty');
    await page.evaluate(()=>view.undo()); assert.equal(await page.evaluate(()=>view.dirty),false,'undoing insertion returns to saved revision');
    await page.evaluate(()=>view.redo()); assert.equal(await page.evaluate(()=>view.getBytes().length),4097);
    assert.equal(await page.evaluate(()=>{try{view.load(new Uint8Array());}catch(e){return e.message;}}),'Save or discard binary edits before reloading.');
    await page.evaluate(()=>view.undo());
    await page.getByRole('radio',{name:'1 byte',exact:true}).check(); await page.evaluate(()=>view.select(0));
    await edit.fill('128'); await page.getByRole('button',{name:'Apply',exact:true}).click(); assert.match(await page.getByRole('status').textContent(),/between -128 and 127/);
    await mode.selectOption('hex'); await edit.fill('41'); await page.getByRole('button',{name:'Apply',exact:true}).click(); assert.equal(await page.evaluate(()=>view.getBytes()[0]),65);
    await viewport.focus(); await page.keyboard.press('Control+z'); assert.equal(await page.evaluate(()=>view.getBytes()[0]),128);
    await page.keyboard.press('Control+Shift+z'); assert.equal(await page.evaluate(()=>view.getBytes()[0]),65);
    assert.equal(await viewport.evaluate(el=>{const clipboardData=new DataTransfer();el.dispatchEvent(new ClipboardEvent('copy',{clipboardData,bubbles:true,cancelable:true}));return clipboardData.getData('text/plain');}),'41');
    await viewport.evaluate(el=>{const clipboardData=new DataTransfer();clipboardData.setData('text/plain','DE AD');el.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}));});
    assert.deepEqual(await page.evaluate(()=>[...view.getBytes().slice(0,2)]),[222,173]);
    // Row actions mutate actual bytes and restore both data and saved revision through undo/redo.
    await page.evaluate(()=>{view.markSaved();view.load(Uint8Array.from([1,2,3,4,5,6,7,8]));view.applyPreferences({bytesPerRow:4});view.select(2);});
    await rowAction('Insert row'); assert.deepEqual(await page.evaluate(()=>[...view.getBytes()]),[1,2,0,0,0,0,3,4,5,6,7,8]);
    assert.equal(await page.locator('.binary-viewer').getAttribute('data-selection-length'),'4');
    await rowAction('Undo'); assert.deepEqual(await page.evaluate(()=>[...view.getBytes()]),[1,2,3,4,5,6,7,8]); assert.equal(await page.evaluate(()=>view.dirty),false);
    await rowAction('Redo'); await rowAction('Delete selection'); assert.deepEqual(await page.evaluate(()=>[...view.getBytes()]),[1,2,3,4,5,6,7,8]);
    await page.evaluate(()=>view.select(1,3)); await rowAction('Delete selection'); assert.deepEqual(await page.evaluate(()=>[...view.getBytes()]),[1,5,6,7,8]);
    await rowAction('Undo'); assert.deepEqual(await page.evaluate(()=>[...view.getBytes()]),[1,2,3,4,5,6,7,8]);
    await viewport.focus(); await page.keyboard.press('Control+a'); await page.keyboard.press('Delete'); assert.deepEqual(await page.evaluate(()=>[...view.getBytes()]),[]);
    assert.equal(await page.getByRole('gridcell',{name:'End of file',exact:true}).count(),1,'empty files retain an editable EOF');
    assert.equal(await page.getByRole('button',{name:'Apply',exact:true}).isEnabled(),true);
    await edit.fill('AB'); await page.getByRole('button',{name:'Apply',exact:true}).click(); assert.deepEqual(await page.evaluate(()=>[...view.getBytes()]),[171]);
    await edit.fill('CD'); await page.getByRole('button',{name:'Apply',exact:true}).click(); assert.deepEqual(await page.evaluate(()=>[...view.getBytes()]),[171,205],'editing EOF appends');
    await viewport.focus(); await page.keyboard.press('Control+z'); assert.deepEqual(await page.evaluate(()=>[...view.getBytes()]),[171]);
    await rowAction('Undo'); assert.deepEqual(await page.evaluate(()=>[...view.getBytes()]),[]);
    await rowAction('Undo'); assert.deepEqual(await page.evaluate(()=>[...view.getBytes()]),[1,2,3,4,5,6,7,8],'full deletion is undoable');
    await goto('0x8'); assert.equal(await page.locator('.binary-viewer').getAttribute('data-offset'),'8','goto accepts EOF');
    // Settings are comprehensive, live, preserve dirty bytes, and safely normalize untrusted preferences.
    await page.getByRole('button',{name:'Binary settings',exact:true}).click();
    await page.getByRole('checkbox',{name:'Text column',exact:true}).uncheck();
    assert.equal(await page.locator('.binary-text').count(),0);
    await page.getByRole('spinbutton',{name:'Font size',exact:true}).fill('18'); await page.getByRole('spinbutton',{name:'Font size',exact:true}).press('Tab');
    assert.equal(await viewport.evaluate(el=>getComputedStyle(el).fontSize),'18px');
    await page.keyboard.press('Escape');
    await page.evaluate(()=>view.applyPreferences({showText:true,offsets:false,lineNumbers:false,bytesPerRow:8,groupSize:2,groupGap:12,fontSize:14,rowHeight:30,uppercase:false,alternateRows:true,dimZeros:false,offsetFormat:'decimal',selectionColor:'#ff0000',matchColor:'#00ff00',textEncoding:'utf-8'}));
    assert.equal(await page.locator('.binary-offset').count(),0); assert.equal(await page.locator('.binary-line-number').count(),0);
    assert.equal(await page.locator('.binary-row').first().evaluate(el=>el.getBoundingClientRect().height),30);
    assert.equal(await page.locator('.binary-byte.group-start').first().evaluate(el=>getComputedStyle(el).marginLeft),'12px');
    assert.equal(await page.evaluate(()=>view.snapshot().bytesPerRow),8); assert.equal(await page.evaluate(()=>view.snapshot().fontSize),14);
    assert.equal(await page.evaluate(()=>{const next=binary.normalizeBinaryPreferences({fontSize:999,rowHeight:0,mode:'bad',width:3,selectionColor:'red'});return JSON.stringify([next.fontSize,next.rowHeight,next.mode,next.width,next.selectionColor]);}),'[24,18,"hex",1,"#71baff"]');
    // Text editing and searching honor the selected encoding.
    await page.evaluate(()=>{view.markSaved();view.load(new Uint8Array(128));view.select(0);});
    await page.getByRole('radio',{name:'Text',exact:true}).check(); await edit.fill('héllo'); await page.getByRole('button',{name:'Apply',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>[...view.getBytes().slice(0,6)]),[104,195,169,108,108,111]);
    await page.evaluate(()=>view.insert(32,new TextEncoder().encode('héllo'))); await page.evaluate(()=>view.select(0));
    assert.equal(await page.evaluate(()=>view.search('héllo','text')),true); assert.equal(await page.evaluate(()=>view.snapshot().offset),0);
    await page.evaluate(()=>view.findNext()); assert.equal(await page.evaluate(()=>view.snapshot().offset),32);
    await page.evaluate(()=>view.findNext()); assert.equal(await page.evaluate(()=>view.snapshot().offset),0); assert.match(await page.getByRole('status').textContent(),/Wrapped/);
    await page.evaluate(()=>view.findPrevious()); assert.equal(await page.evaluate(()=>view.snapshot().offset),32);
    assert.equal(await page.evaluate(()=>view.search('a'.repeat(1_000_000),'text')),false); assert.match(await page.getByRole('status').textContent(),/4,096 bytes/);
    assert.equal(await page.evaluate(()=>view.search('ABC','hex')),false); assert.match(await page.getByRole('status').textContent(),/complete pairs/);
    await viewport.focus(); await page.keyboard.press('Control+f'); assert.equal(await page.getByRole('searchbox',{name:'Search bytes'}).evaluate(el=>document.activeElement===el),true);
    await page.getByRole('searchbox',{name:'Search bytes'}).press('Escape');
    await page.evaluate(()=>{view.applyPreferences({textEncoding:'utf-16be'});view.select(64);}); await edit.fill('AΩ'); await page.getByRole('button',{name:'Apply',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>[...view.getBytes().slice(64,68)]),[0,65,3,169]); assert.equal(await page.evaluate(()=>view.search('AΩ','text')),true);
    assert.deepEqual(await page.evaluate(()=>[64,65,66,67].map(i=>document.querySelector('.binary-text [data-offset="'+i+'"]')?.textContent)),['A','','Ω','']);
    await page.evaluate(()=>{view.select(72);view.overwrite(72,Uint8Array.of(0xd8,0x3d,0xde,0x00));});
    assert.deepEqual(await page.evaluate(()=>[72,73,74,75].map(i=>document.querySelector('.binary-text [data-offset="'+i+'"]')?.textContent)),['😀','','','']);
    await page.evaluate(()=>{view.applyPreferences({textEncoding:'utf-16le'});view.select(80);}); await edit.fill('A😀'); await page.getByRole('button',{name:'Apply',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>[...view.getBytes().slice(80,86)]),[65,0,61,216,0,222]);
    assert.deepEqual(await page.evaluate(()=>[80,81,82,83,84,85].map(i=>document.querySelector('.binary-text [data-offset="'+i+'"]')?.textContent)),['A','','😀','','','']);
    // Bounded edits and growth never partially mutate the file; existing oversized files can shrink.
    assert.deepEqual(await page.evaluate(()=>{
      const limited=binary.createBinaryViewer({bytes:Uint8Array.from([1,2,3,4]),maxBytes:4}), errors=[];
      try{limited.insert(0,Uint8Array.of(9));}catch(e){errors.push(e.message);}
      const unchanged=[...limited.getBytes()];limited.overwrite(0,Uint8Array.of(8));limited.deleteRange(1,2);const shrunk=[...limited.getBytes()];limited.undo();const undo=[...limited.getBytes()];limited.dispose();
      const oversized=binary.createBinaryViewer({bytes:new Uint8Array(8),maxBytes:4});oversized.overwrite(0,Uint8Array.of(9));oversized.deleteRange(1,1);const size=oversized.getBytes().length;oversized.dispose();return {errors,unchanged,shrunk,undo,size};
    }),{errors:['File size is limited to 4 bytes.'],unchanged:[1,2,3,4],shrunk:[8,4],undo:[8,2,3,4],size:7});
    // Mouse dragging creates a real byte range; deleting it and undoing preserves exact data.
    await page.evaluate(()=>{view.markSaved();view.load(Uint8Array.from([1,2,3,4,5,6,7,8]));view.applyPreferences({width:1,bytesPerRow:8});view.select(0);});
    const from=await page.locator('.binary-byte[data-offset="1"]').boundingBox(), to=await page.locator('.binary-byte[data-offset="3"]').boundingBox();
    await page.mouse.move(from.x+from.width/2,from.y+from.height/2); await page.mouse.down(); await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:3}); await page.mouse.up();
    assert.equal(await page.locator('.binary-viewer').getAttribute('data-selection-length'),'3');
    await page.keyboard.press('Delete'); assert.deepEqual(await page.evaluate(()=>[...view.getBytes()]),[1,5,6,7,8]);
    await page.keyboard.press('Control+z'); assert.deepEqual(await page.evaluate(()=>[...view.getBytes()]),[1,2,3,4,5,6,7,8]);
    // Huge data uses a capped physical scrollbar and exact logical EOF.
    await page.evaluate(()=>{view.markSaved();view.load(new Uint8Array(16*1024*1024+7));view.applyPreferences({bytesPerRow:0,fontSize:13,rowHeight:24,textEncoding:'ascii',offsets:true,lineNumbers:true});view.select(16*1024*1024+7);});
    assert.equal(await page.locator('.binary-byte.active').getAttribute('data-offset'),String(16*1024*1024+7)); assert((await page.locator('.binary-row').count())<50);
    assert((await page.locator('.binary-spacer').evaluate(el=>parseFloat(el.style.height)))<=8_000_000);
    assert.deepEqual(await page.evaluate(async()=>{const old=view.search('00 00 00 00 00 01','hex'),next=view.search('00','hex');return Promise.all([old,next]);}),[false,true]);
    for(const width of [390,320]) {
      await page.setViewportSize({width,height:844}); await page.locator('#host').evaluate(el=>el.style.height='824px'); await page.evaluate(()=>view.resize());
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${width}px document does not overflow`);
      assert.equal(await page.locator('.binary-toolbar').evaluate(el=>el.scrollWidth<=el.clientWidth),true,`${width}px top controls fit one row`);
      assert.equal(await page.locator('.binary-edit').evaluate(el=>el.scrollWidth<=el.clientWidth),true,`${width}px edit controls fit one row`);
      assert.equal(await edit.evaluate(el=>getComputedStyle(el).fontSize),'16px');
      const heights=await page.locator('.binary-format-controls > select,.binary-format-controls > .radio-tabs,.binary-toolbar-actions button,.binary-edit > input,.binary-edit > .radio-tabs,.binary-edit > button,.binary-edit > .ui-menu-anchor > button').evaluateAll(nodes=>nodes.filter(node=>node.getBoundingClientRect().height>0).map(node=>node.getBoundingClientRect().height));
      assert(Math.max(...heights)-Math.min(...heights)<1,`${width}px control heights agree: ${heights}`);
      assert.equal(await page.locator('.binary-toolbar-actions button').evaluateAll(nodes=>nodes.every(node=>parseFloat(getComputedStyle(node).paddingLeft)>=6)),true,'action buttons retain padding');
      assert.equal(await page.locator('.binary-toolbar-divider').evaluate(node=>node.getBoundingClientRect().width),1,'visible divider separates format and actions');
      await page.getByRole('button',{name:'Find',exact:true}).click(); assert.equal(await page.getByRole('dialog',{name:'Find',exact:true}).evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),true);
      const searchHeights=await page.locator('.binary-search > input,.binary-search > select,.binary-search > button').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().height));
      assert(Math.max(...searchHeights)-Math.min(...searchHeights)<1&&Math.abs(searchHeights[0]-heights[0])<1,'search inputs and buttons match toolbar height');
      await page.screenshot({path:`/tmp/eya-binary-toolbar-${width}.png`});await page.keyboard.press('Escape');
    }
    await page.evaluate(()=>view.dispose()); assert.equal(await page.locator('.binary-viewer').count(),0); assert.equal(await page.locator('.binary-popover').count(),0); assert.deepEqual(errors,[]);
    console.log('Binary viewer: compact layout, numeric precision, settings, encodings, editable EOF, insertion/deletion undo, save revisions, search, bounds and 320px mobile passed');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
