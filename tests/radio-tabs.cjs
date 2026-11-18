const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const esbuild = require('esbuild');
const {chromium} = require('playwright');
(async()=>{
 const bundle=await esbuild.build({entryPoints:['client/radio-tabs.js'],bundle:true,format:'iife',globalName:'Radios',write:false});
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:320,height:640}});
  await page.setContent('<style>label{display:block;margin:14px 0}input:not([type=checkbox]){display:block;width:100%;margin-top:5px}body{margin:8px;color:#ddd;background:#10151b}</style>');
  await page.addStyleTag({content:await fs.readFile('client/radio-tabs.css','utf8')});await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.evaluate(()=>{
   window.changes=[];window.group=Radios.createRadioTabs({label:'Value width',options:[1,2,4,8].map(value=>({value,label:String(value)})),value:1,onChange:value=>changes.push(value),compact:true});
   window.order=Radios.createRadioTabs({label:'Byte order',options:[{value:'little',label:'LE'},{value:'big',label:'BE'}],value:'little',compact:true});document.body.append(group.element,order.element);
  });
  await page.getByRole('radio',{name:'1',exact:true}).focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('radio',{name:'2',exact:true}).isChecked(),true);assert.deepEqual(await page.evaluate(()=>changes),[2]);
  assert.equal(await page.getByRole('radio',{name:'LE',exact:true}).isChecked(),true);
  await page.evaluate(()=>group.setValue(8));assert.equal(await page.getByRole('radio',{name:'8',exact:true}).isChecked(),true);assert.deepEqual(await page.evaluate(()=>changes),[2]);
  const bounds=await page.getByRole('radiogroup',{name:'Value width'}).boundingBox();assert(bounds.width<120);assert(bounds.height>=32);
  const tabs=await page.locator('.radio-tabs').first().locator('label').evaluateAll(labels=>labels.map(label=>({left:label.getBoundingClientRect().left,right:label.getBoundingClientRect().right,height:label.getBoundingClientRect().height})));
  assert(Math.abs(tabs[0].right-tabs[1].left)<2);assert(tabs.every(tab=>tab.height>=32));
  await page.evaluate(()=>group.setDisabled(true));assert.equal(await page.getByRole('radio',{name:'4',exact:true}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  console.log('Connected native radio tabs: arrow navigation, independent groups, programmatic sync, disabled state and narrow layout passed');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
