import { readFile, writeFile } from 'node:fs/promises';
// Keep npm assets embedded: standalone HTML/SVG clients never fetch icon files.
export async function buildMaterialIcons() {
  const base = 'client/node_modules/material-icon-theme/';
  const manifest = JSON.parse(await readFile(base + 'dist/material-icons.json', 'utf8'));
  const { file, folder, fileExtensions, fileNames, folderNames } = manifest;
  const names = new Set([file, folder, ...Object.values(fileExtensions), ...Object.values(fileNames), ...Object.values(folderNames)]);
  const images = Object.fromEntries(await Promise.all([...names].map(async name => [name, 'data:image/svg+xml;base64,' + (await readFile(base + 'dist/' + manifest.iconDefinitions[name].iconPath)).toString('base64')])));
  const source = '// Generated from material-icon-theme by material-icons.mjs. MIT; see bundled notices.\nexport default ' + JSON.stringify({ file, folder, fileExtensions, fileNames, folderNames, images }) + ';\n';
  const target = 'client/file-icons-data.js';
  if (await readFile(target, 'utf8').catch(() => '') !== source) await writeFile(target, source);
}
