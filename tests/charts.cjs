const { chromium } = require('playwright');
const { build } = require('../client/node_modules/esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const bundle = await build({stdin:{contents:"export {createChart} from './client/charts.js'",resolveDir:path.resolve('.')},bundle:true,write:false,format:'iife',globalName:'Charts',platform:'browser'});
  const css = await fs.readFile('client/charts.css', 'utf8');
  const browser = await chromium.launch({headless:true,executablePath:process.env.EYA_BROWSER_EXECUTABLE,args:process.env.EYA_BROWSER_NO_SANDBOX?['--no-sandbox']:[]});
  try {
    for (const svgDocument of [false, true]) {
      const page = await browser.newPage({viewport:{width:700,height:500}});
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      if (svgDocument) {
        await page.goto('data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><foreignObject width="100%" height="100%"><html xmlns="http://www.w3.org/1999/xhtml"><head/><body/></html></foreignObject></svg>'));
        await page.evaluate(() => Object.defineProperty(document,'createElement',{configurable:true,value:name=>document.createElementNS('http://www.w3.org/1999/xhtml',String(name).toLowerCase())}));
      } else await page.setContent('<html><head></head><body></body></html>');
      await page.evaluate(({css,js}) => { const style=document.createElement('style');style.textContent='body{margin:10px;background:#10151b;color:white}*{box-sizing:border-box}'+css;document.querySelector('head').append(style);window.eval(js); }, {css,js:bundle.outputFiles[0].text});
      await page.evaluate(() => {
        window.chart=Charts.createChart({label:'CPU history',series:[{key:'cpu',label:'CPU'},{key:'memory',label:'Memory'}],format:value=>`${value.toFixed(1)}%`,maxPoints:5,max:100});
        document.querySelector('body').append(chart.element);
        for(let i=0;i<8;i++)chart.push({time:1700000000000+i*1000,cpu:i===5?null:i*10,memory:i*8});
      });
      await page.locator('.live-chart-value').first().filter({hasText:'70.0%'}).waitFor();
      if(await page.locator('.live-chart-line').count()!==3)throw Error('Null samples failed to create a line gap');
      if(!(await page.locator('svg.live-chart-svg').getAttribute('aria-label')).includes('5 samples'))throw Error('History is not bounded');
      await page.locator('.live-chart-svg').focus();await page.keyboard.press('Home');
      await page.locator('.live-chart-tooltip').waitFor({state:'visible'});
      if(!(await page.locator('.live-chart-tooltip').innerText()).includes('30.0%'))throw Error('Keyboard did not inspect earliest retained sample');
      await page.keyboard.press('End');
      if(!(await page.locator('.live-chart-tooltip').innerText()).includes('70.0%'))throw Error('Keyboard did not inspect latest sample');
      await page.keyboard.press('Escape');await page.locator('.live-chart-tooltip').waitFor({state:'hidden'});
      await page.evaluate(()=>{chart.setOptions({style:'line',rangeMs:2000});});
      await page.waitForFunction(()=>document.querySelectorAll('.live-chart-area').length===0);
      if(!(await page.locator('.live-chart-svg').getAttribute('aria-label')).includes('3 samples'))throw Error('Visible history range was not applied');
      await page.evaluate(()=>chart.setOptions({paused:true}));await page.locator('.live-chart-state').filter({hasText:'Paused'}).waitFor();
      await page.evaluate(()=>chart.push({time:1700000008000,cpu:90,memory:80}));
      await page.setViewportSize({width:320,height:500});
      if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Chart overflows mobile viewport');
      if(!await page.locator('.live-chart-value').first().textContent().then(text=>text==='70.0%'))throw Error('Pause did not retain displayed sample across resize');
      await page.evaluate(()=>chart.setOptions({paused:false}));
      await page.locator('.live-chart-value').first().filter({hasText:'90.0%'}).waitFor();
      const bounds=await page.locator('.live-chart-svg').boundingBox();
      await page.mouse.move(bounds.x+bounds.width-15,bounds.y+bounds.height/2);
      await page.locator('.live-chart-tooltip').waitFor({state:'visible'});
      if(!(await page.locator('.live-chart-tooltip').innerText()).includes('90.0%'))throw Error('Pointer hover did not inspect latest sample');
      await page.locator('.live-chart-svg').dispatchEvent('pointerdown',{pointerType:'touch',clientX:bounds.x+bounds.width-15,clientY:bounds.y+40});
      await page.locator('.live-chart-tooltip').waitFor({state:'visible'});
      await page.evaluate(()=>{
        const root=document.documentElement;root.style.setProperty('--ui-bg','#fff');root.style.setProperty('--ui-fg','#182832');root.style.setProperty('--ui-muted','#526776');root.style.setProperty('--ui-border','#bbc7c8');
      });
      if(!await page.locator('.live-chart-axis').first().evaluate(element=>getComputedStyle(element).fill==='rgb(82, 103, 118)'))throw Error('Chart axes do not inherit light theme');
      await page.evaluate(()=>{chart.setOptions({paused:false});chart.clear();});
      await page.locator('.live-chart-empty').waitFor({state:'visible'});
      await page.evaluate(()=>chart.destroy());
      if(await page.locator('.live-chart').count())throw Error('Destroyed chart remains mounted');
      if(errors.length)throw Error(errors.join('; '));
      await page.close();
    }
    console.log('Chart history limits, null gaps, visible ranges, keyboard inspection, pause, mobile bounds, cleanup, and SVG/XHTML passed');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
