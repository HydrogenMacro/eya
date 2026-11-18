// Deterministic, synthetic site classes. No credentials or external resources.
const http = require('node:http');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const CASES = ['documentation', 'forms', 'module-spa', 'websocket', 'streaming', 'assets', 'large-list', 'media', 'third-party-frame'];
const eventScript = `<script>
const report=(kind,value)=>parent.postMessage({corpus:true,kind,value},'*');
const done=value=>{document.querySelector('#result').textContent=value;report('interaction',value)};
addEventListener('error',event=>report('exception',String(event.message||'Resource error').slice(0,500)));
addEventListener('unhandledrejection',event=>report('exception',String(event.reason).slice(0,500)));
addEventListener('DOMContentLoaded',()=>requestAnimationFrame(()=>report('content',document.querySelector('h1')?.textContent||'')),{once:true});
</script>`;
function documentHtml(name, content, script = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title>${eventScript}<style>body{font:16px system-ui;margin:20px}button,input{font:inherit}#result{white-space:pre-wrap}</style></head><body><h1>${name}</h1>${content}<p id="result">Ready</p>${script ? `<script>${script}</script>` : ''}</body></html>`;
}
function wav() {
  const samples = 8000, bytes = Buffer.alloc(44 + samples * 2); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40); return bytes;
}
async function fixture() {
  let origin, thirdParty;
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://fixture.test').pathname;
    const send = (type, body, status = 200) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    if (pathname === '/shell.html') return send('text/html', '<!doctype html><html><head></head><body></body></html>');
    if (pathname === '/shell.svg') { const prelude = fs.readFileSync('client/client-artifacts.js', 'utf8').match(/function svgPrelude\(\) \{[\s\S]*?\n\}/)?.[0]; return send('image/svg+xml', `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><foreignObject width="100%" height="100%"><html xmlns="http://www.w3.org/1999/xhtml"><head/><body/></html></foreignObject><script><![CDATA[(${prelude})();]]></script></svg>`); }
    if (pathname === '/style.css') return send('text/css', '@import url("/base.css");@font-face{font-family:Corpus;src:url("/font.woff2")}#asset-label{font-family:Corpus;color:rgb(12,34,56)}');
    if (pathname === '/base.css') return send('text/css', 'body{background:rgb(250,250,250)}');
    if (pathname === '/font.woff2') return send('font/woff2', fs.readFileSync('client/fonts/0xProto.woff2'));
    if (pathname === '/image.svg') return send('image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="teal"/></svg>');
    if (pathname === '/audio.wav') return send('audio/wav', wav());
    if (pathname === '/dependency.js') return send('text/javascript', 'export const value="module ok";');
    if (pathname === '/app.js') return send('text/javascript', `import{value}from './dependency.js';document.querySelector('#action').onclick=async()=>{history.pushState({page:2},'', '/module-route');done(value+':'+await(await fetch('/api')).text())};`);
    if (pathname === '/api') return send('text/plain', 'api ok');
    if (pathname === '/stream') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('first:'); setTimeout(() => res.end('second'), 35); return; }
    if (pathname === '/submitted') { let body = ''; for await (const chunk of req) body += chunk; return send('text/html', documentHtml('Submitted', '<p id="submitted">Synthetic form accepted</p>', `report('interaction',${JSON.stringify(req.method === 'POST' ? 'post ok' : 'wrong method')});`)); }
    if (pathname === '/child') return send('text/html', `<script>parent.postMessage({childReady:true},'*')</script><p>Third-party child</p>`);
    let html;
    switch (pathname) {
      case '/documentation': html = documentHtml('Documentation', '<p>Readable café العربية 漢字 á text.</p><a href="#section">Jump</a><h2 id="section">Section</h2><button id="action">Select section</button>', `document.querySelector('#action').onclick=()=>done('documentation ok')`); break;
      case '/forms': html = documentHtml('Forms', '<form method="post" action="/submitted"><label>Name <input name="name" value="synthetic-user"></label><button id="action">Submit fixture</button></form>'); break;
      case '/module-spa': html = documentHtml('Module SPA', '<button id="action">Load route</button><script type="module" src="/app.js"></script>'); break;
      case '/websocket': html = documentHtml('WebSocket UI', '<button id="action">Send ping</button>', `document.querySelector('#action').onclick=()=>{const socket=new WebSocket(${JSON.stringify(origin.replace('http:', 'ws:') + '/socket')});socket.onopen=()=>socket.send('ping');socket.onmessage=event=>{done(event.data);socket.close()};socket.onerror=()=>report('unsupported','WebSocket connection failed')}`); break;
      case '/streaming': html = documentHtml('Streaming API', '<button id="action">Read stream</button>', `document.querySelector('#action').onclick=async()=>{const reader=(await fetch('/stream')).body.getReader();let value='',chunks=0;while(true){const part=await reader.read();if(part.done)break;chunks++;value+=new TextDecoder().decode(part.value);report('stream-chunk',chunks)}done(value)}`); break;
      case '/assets': html = documentHtml('Assets', '<link rel="stylesheet" href="/style.css"><p id="asset-label">Font and CSS</p><img id="asset" src="/image.svg"><button id="action">Check assets</button>', `document.querySelector('#action').onclick=async()=>{await document.fonts.ready;const image=document.querySelector('#asset');await image.decode();done(getComputedStyle(document.querySelector('#asset-label')).color==='rgb(12, 34, 56)'&&image.naturalWidth===40?'assets ok':'assets mismatch')}`); break;
      case '/large-list': html = documentHtml('Large list', '<button id="action">Filter list</button><ul>' + Array.from({ length: 1500 }, (_, i) => `<li>Fixture row ${i}</li>`).join('') + '</ul>', `document.querySelector('#action').onclick=()=>{for(const item of document.querySelectorAll('li'))item.hidden=!item.textContent.endsWith('1499');done('list ok')}`); break;
      case '/media': html = documentHtml('Media', '<audio id="audio" controls src="/audio.wav"></audio><button id="action">Play silent audio</button>', `document.querySelector('#action').onclick=async()=>{try{await document.querySelector('#audio').play();done('media ok')}catch(error){report('unsupported','media: '+error.name)}}`); break;
      case '/third-party-frame': html = documentHtml('Third-party frame', `<iframe title="Child" src="${thirdParty}/child"></iframe><button id="action">Check child</button>`, `let child=false;addEventListener('message',event=>{if(event.data?.childReady)child=true});document.querySelector('#action').onclick=()=>{if(child)done('frame ok');else report('unsupported','Nested third-party frames are unavailable')}`); break;
      default: return send('text/plain', 'Not found', 404);
    }
    send('text/html', html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  const child = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<script>parent.postMessage({childReady:true},'*')</script><p>Third-party child</p>`); });
  await new Promise(resolve => child.listen(0, '127.0.0.1', resolve)); thirdParty = `http://127.0.0.1:${child.address().port}`;
  // Minimal bounded RFC6455 echo fixture; protocol coverage belongs to browser-transport.cjs.
  const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    if (req.url !== '/socket' || !req.headers['sec-websocket-key']) return socket.destroy();
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let buffered = Buffer.alloc(0);
    socket.on('data', bytes => {
      buffered = Buffer.concat([buffered, bytes]); if (buffered.length > 1024) return socket.destroy();
      if (buffered.length < 6) return;
      const opcode = buffered[0] & 15, length = buffered[1] & 127;
      if (!(buffered[1] & 128) || length > 125) return socket.destroy();
      if (buffered.length < 6 + length) return;
      buffered = buffered.subarray(6 + length);
      if (opcode === 8) { socket.end(Buffer.from([0x88,0])); return; }
      const answer = Buffer.from('socket ok'); socket.write(Buffer.concat([Buffer.from([0x81, answer.length]), answer]));
    });
  });
  return { origin, thirdParty, cases: CASES, close: async () => { for (const socket of sockets) socket.destroy(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => child.close(resolve))]); } };
}
module.exports = { fixture, CASES };
