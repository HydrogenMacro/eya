import { build, transform } from 'esbuild';
import { minify } from 'terser';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function buildClient({ optimize = true, output = 'client.html', analyze = false } = {}) {
  const result = await build({
    entryPoints: ['client/app.js'], bundle: true, platform: 'browser', format: 'iife', write: false,
    minify: true, legalComments: 'none', charset: 'utf8', supported: { 'template-literal': false },
    ...(optimize ? { alias: { 'sodium-universal': './client/sodium-browser.js' } } : {}),
    metafile: analyze,
  });
  let program = result.outputFiles[0].text;
  if (optimize) {
    const compressed = await minify(program, {
      ecma: 2020, compress: { passes: 2 }, mangle: true,
      format: { comments: false, ascii_only: false, inline_script: true },
    });
    program = compressed.code;
  }
  const js = program.replaceAll('</script', '<\\/script');
  const css = await readFile('client/node_modules/@xterm/xterm/css/xterm.css', 'utf8');
  const template = await readFile('client/template.html', 'utf8');
  const extraCss = await Promise.all(['components', 'themes', 'charts', 'mobile'].map(name => readFile(`client/${name}.css`, 'utf8')));
  const notices = await Promise.all(['three', '@codemirror/lang-python', '@lezer/python', 'lucide'].map(async name => `${name}\n${await readFile(`client/node_modules/${name}/LICENSE`, 'utf8')}`));
  let html = template.replace('/* XTERM_CSS */', () => css).replace('</style>', () => `${extraCss.join('\n')}\n</style>`);
  const style = html.match(/<style>([\s\S]*?)<\/style>/);
  if (!style) throw Error('Client template has no style block.');
  const minifiedCss = (await transform(style[1], { loader: 'css', minify: true, legalComments: 'none' })).code.trim();
  html = html.replace(style[0], `<style>${minifiedCss}</style>`).replace(/>\s+</g, '><').replace('/* EYA_JS */', () => js);
  // XML comments cannot contain "--" when this document becomes a standalone SVG.
  const noticeText = notices.join('\n').replace(/-{2,}/g, separator => [...separator].join(' '));
  html = html.replace('</head>', () => `<!-- Bundled dependency notices\n${noticeText}\n-->\n</head>`);
  if (output) await writeFile(output, html);
  if (output === 'client.html') {
    const generator = await build({ entryPoints: ['client/generator.js'], bundle: true, platform: 'browser', format: 'iife', write: false, minify: true, legalComments: 'none', charset: 'utf8' });
    const generatorTemplate = await readFile('client/generator.template.html', 'utf8');
    const generatorNotice = (await readFile('client/node_modules/fflate/LICENSE', 'utf8')).replace(/-{2,}/g, separator => [...separator].join(' '));
    await writeFile('client/generator.html', generatorTemplate.replace('</head>', `<!-- fflate\n${generatorNotice}\n-->\n</head>`).replace('/* GENERATOR_JS */', () => generator.outputFiles[0].text.replaceAll('</script', '<\\/script')));
  }
  return { html, metafile: result.metafile };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2); const index = args.indexOf('--out');
  await buildClient({ optimize: !args.includes('--baseline'), output: index >= 0 ? args[index + 1] : 'client.html' });
}
