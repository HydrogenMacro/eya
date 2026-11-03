import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
const result = await build({ entryPoints: ['client/app.js'], bundle: true, platform: 'browser', format: 'iife', write: false, minify: true });
const js = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
const css = await readFile('client/node_modules/@xterm/xterm/css/xterm.css', 'utf8');
const template = await readFile('client/template.html', 'utf8');
await writeFile(
  'client.html',
  template
    .replace('/* XTERM_CSS */', () => css)
    .replace('/* EYA_JS */', () => js),
);
