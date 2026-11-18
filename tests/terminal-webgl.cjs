const { build } = require('esbuild');
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const bundle = await build({ stdin: { contents: "import { createTerminalPanel } from './client/terminal-panel.js'; window.createTerminalPanel = createTerminalPanel;", resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', write: false });
  const browser = await chromium.launch({ headless: true, ...(process.env.EYA_BROWSER_EXECUTABLE ? { executablePath: process.env.EYA_BROWSER_EXECUTABLE } : {}), args: [...(process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : []), '--enable-unsafe-swiftshader'] });
  try {
    for (const disabled of [false, true]) {
      const page = await browser.newPage();
      await page.setContent(`<style>${fs.readFileSync('client/node_modules/@xterm/xterm/css/xterm.css', 'utf8')}</style>`);
      if (disabled) await page.evaluate(() => {
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) { return type === 'webgl2' ? null : getContext.call(this, type, ...args); };
      });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.evaluate(() => {
        window.panel = createTerminalPanel({ id: 'test', url: 'ws://localhost/', key: 'test', restoring: true });
        document.body.append(panel.element); panel.onLayout();
      });
      if (disabled) {
        if (!await page.locator('.xterm-rows').count()) throw Error('DOM renderer was not retained when WebGL was unavailable');
      } else {
        const canvas = page.locator('.xterm-screen canvas');
        if (!await canvas.count()) throw Error('WebGL renderer was not activated');
        await page.evaluate(() => {
          const gl = [...document.querySelectorAll('.xterm-screen canvas')].map(element => element.getContext('webgl2')).find(Boolean);
          if (!gl) throw Error('WebGL canvas has no context');
          gl.getExtension('WEBGL_lose_context').loseContext();
        });
        await page.locator('.xterm-rows').waitFor();
      }
      await page.evaluate(() => panel.onClose({ detach: true }));
      await page.close();
    }
    console.log('Terminal WebGL activation and DOM fallback passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
