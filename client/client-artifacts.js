// Stable html-template-v1 packaging shared by generation and self-update.
const encoder = new TextEncoder();
const xhtml = 'http://www.w3.org/1999/xhtml', svgNs = 'http://www.w3.org/2000/svg';
function bytesBase64(bytes) { let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(binary); }
function appendProgram(output, root, program) {
  const script = output.createElementNS(svgNs, 'script');
  // A single SVG2 href executes consistently for large standalone programs.
  // Mirroring the same base64 into xlink:href used to double every program.
  script.setAttribute('href', 'data:application/javascript;base64,' + bytesBase64(encoder.encode(program)));
  root.append(script);
}
function svgDocument() {
  const output = document.implementation.createDocument(svgNs, 'svg'); const root = output.documentElement;
  root.setAttribute('width', '100%'); root.setAttribute('height', '100%');
  const title = output.createElementNS(svgNs, 'title'); title.textContent = 'Eya'; root.append(title);
  const foreignObject = output.createElementNS(svgNs, 'foreignObject');
  for (const [key, value] of Object.entries({ x: '0', y: '0', width: '100%', height: '100%' })) foreignObject.setAttribute(key, value);
  root.append(foreignObject); return { output, root, foreignObject };
}
function executable(script) { return !script.type || /^(application|text)\/(java|ecma)script$/i.test(script.type); }
function svgPrelude() {
  Object.defineProperties(document, {
    queryCommandSupported: { configurable: true, value: () => false },
    createElement: { configurable: true, value: (name, options) => document.createElementNS('http://www.w3.org/1999/xhtml', String(name).toLowerCase(), options) },
    head: { configurable: true, get: () => document.querySelector('foreignObject')?.querySelector('head') || null },
    body: { configurable: true, get: () => document.querySelector('foreignObject')?.querySelector('body') || null },
  });
}
function serialize(output) { return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(output); }
function svgClient(html) {
  const { output, root, foreignObject } = svgDocument(); const source = new DOMParser().parseFromString(html, 'text/html');
  const programs = [...source.scripts].filter(executable).map(script => script.textContent);
  for (const script of [...source.scripts]) if (executable(script)) script.remove();
  const client = output.importNode(source.documentElement, true); client.setAttribute('xmlns', xhtml); client.style.width = client.style.height = '100%'; foreignObject.append(client);
  appendProgram(output, root, `(${svgPrelude.toString()})();`);
  for (const program of programs) appendProgram(output, root, program);
  return serialize(output);
}

export { bytesBase64, appendProgram, svgDocument, executable, svgPrelude, serialize, svgClient };
