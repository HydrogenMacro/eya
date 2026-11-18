import theme from './file-icons-data.js';
import { icon } from './ui.js';
export function fileIcon(item) {
  if (item.kind === 'parent' || item.kind === 'symlink') return icon(item.kind === 'parent' ? 'CornerUpLeft' : 'Link');
  const name = item.name.toLowerCase();
  let id;
  if (item.kind === 'directory') id = theme.folderNames[name] || theme.folder;
  else {
    id = theme.fileNames[name];
    const parts = name.split('.');
    for (let i = 1; !id && i < parts.length; i++) id = theme.fileExtensions[parts.slice(i).join('.')];
    id ||= theme.file;
  }
  const image = document.createElement('img'); image.className = 'material-file-icon'; image.alt = ''; image.setAttribute('aria-hidden', 'true'); image.draggable = false; image.src = theme.images[id] || theme.images[theme.file];
  return image;
}
