import { build, transform } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
const result = await build({ entryPoints: ['client/app.js'], bundle: true, platform: 'browser', format: 'iife', write: false, minify: true, legalComments: 'none', charset: 'utf8' });
const js = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
const css = await readFile('client/node_modules/@xterm/xterm/css/xterm.css', 'utf8');
const template = await readFile('client/template.html', 'utf8');
let html = template.replace('/* XTERM_CSS */', () => css);
const style = html.match(/<style>([\s\S]*?)<\/style>/);
if (!style) throw Error('Client template has no style block.');
const minifiedCss = (await transform(style[1], { loader: 'css', minify: true, legalComments: 'none' })).code.trim();
html = html
  .replace(style[0], `<style>${minifiedCss}</style>`)
  .replace(/>\s+</g, '><')
  .replace('/* EYA_JS */', () => js);
await writeFile(
  'client.html',
  html,
);
