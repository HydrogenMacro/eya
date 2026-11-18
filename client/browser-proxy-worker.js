// Recognize the synchronous chunk handler emitted by Webpack/Rspack when
// publicPath and chunkFilename are constants and the startup IDs are literals.
// The host only fetches these deduced URLs. Worker importScripts still consults
// the bounded local source map and cannot fetch arbitrary computed URLs.
export function findClassicWorkerChunks(source, tree) {
  const identifier = '[A-Za-z_$][\\w$]*';
  const atom = `(?:"[\\w./:-]*"|'[\\w./:-]*')`;
  const handler = new RegExp(`^(${identifier})\\.f\\.i\\s*=\\s*\\(\\s*(${identifier})\\s*,\\s*${identifier}\\s*\\)\\s*=>\\s*\\{\\s*${identifier}\\[\\s*\\2\\s*\\]\\s*\\|\\|\\s*(importScripts\\(\\s*\\1\\.p\\s*\\+\\s*\\1\\.u\\(\\s*\\2\\s*\\)\\s*\\))\\s*;?\\s*\\}$`);
  const assignments = new Map(), chunkIds = new Map(), handlers = [];
  tree.iterate({ enter(node) {
    if (node.to - node.from > 1024) return;
    if (node.name === 'AssignmentExpression') {
      const expression = source.slice(node.from, node.to);
      const assignment = expression.match(/^([\w$]+)\.(p|u)\s*=(?!=|>)([\s\S]*)$/);
      if (assignment) {
        const key = `${assignment[1]}.${assignment[2]}`;
        assignments.set(key, assignments.has(key) ? null : assignment[3].trim());
      }
      const match = expression.match(handler);
      if (match) handlers.push({ runtime: match[1], from: node.from + expression.indexOf(match[3]) });
    } else if (node.name === 'CallExpression') {
      const expression = source.slice(node.from, node.to);
      const match = expression.match(/^([\w$]+)\.e\(\s*(?:"([\w-]+)"|'([\w-]+)'|(\d+))\s*\)$/);
      if (!match) return;
      const ids = chunkIds.get(match[1]) || new Set();
      if (ids.size < 17) ids.add(match[2] || match[3] || match[4]);
      chunkIds.set(match[1], ids);
    }
  } });
  const computed = new Map();
  const publicPath = new RegExp(`^(${atom})$`);
  const chunkFilename = new RegExp(`^(${identifier})\\s*=>\\s*(${atom})\\s*\\+\\s*\\1\\s*\\+\\s*(${atom})$`);
  for (const { runtime, from } of handlers) {
    const path = assignments.get(`${runtime}.p`)?.match(publicPath);
    const filename = assignments.get(`${runtime}.u`)?.match(chunkFilename);
    const ids = chunkIds.get(runtime);
    if (path && filename && ids?.size && ids.size <= 16) {
      computed.set(from, [...ids].map(id => path[1].slice(1, -1) + filename[2].slice(1, -1) + id + filename[3].slice(1, -1)));
    }
  }
  return computed;
}
