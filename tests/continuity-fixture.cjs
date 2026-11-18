const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const playwright = require('playwright');
const KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const PACKAGERS = { svg: 'svgClient', 'compressed-html': 'compressedDocument', 'compressed-svg': 'compressedSvgClient', 'data-url': 'dataUrl' };
const CLIENT_TYPES = ['html', ...Object.keys(PACKAGERS), 'hosted-html', 'hosted-svg'];

function relayDataSocket(route) {
  const socket = new WebSocket(route.url());
  socket.binaryType = 'arraybuffer';
  const pending = [];
  route.onMessage(message => {
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
    else if (socket.readyState === WebSocket.CONNECTING) pending.push(message);
  });
  socket.addEventListener('open', () => {
    for (const message of pending.splice(0)) socket.send(message);
  });
  socket.addEventListener('message', ({ data }) => route.send(typeof data === 'string' ? data : Buffer.from(data)));
  socket.addEventListener('close', () => { void route.close().catch(() => {}); });
  route.onClose(() => socket.close());
}

async function fixture(options = {}) {
  const engine = options.engine || 'chromium';
  if (!['chromium', 'firefox', 'webkit'].includes(engine)) throw Error(`Unknown fixture browser engine ${engine}`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eya-continuity-audit-'));
  const files = path.join(root, 'files'), state = path.join(root, 'state');
  await fs.mkdir(files); await fs.mkdir(path.join(files, 'folder')); await fs.writeFile(path.join(files, 'seed.txt'), 'initial fixture\n');
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const url = `ws://127.0.0.1:${port}/ws`, http = `http://127.0.0.1:${port}`;
  let server, browser;
  const artifacts = new Map();
  const errors = [];
  async function start() {
    server = spawn(path.resolve(options.binary || 'eya-server/target/debug/eya-server'), [], {
      cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, EYA_KEY: KEY, EYA_BIND: `127.0.0.1:${port}`, EYA_CWD: files, EYA_STATE_DIR: state, ...options.env }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error(`Server startup timed out: ${output}`)), 10000);
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(Error(`Server exited ${code}: ${output}`)); });
      server.stderr.on('data', data => { output += data; if (output.includes('Eya listening')) { clearTimeout(timer); resolve(); } });
    });
  }
  async function stop() {
    if (server && server.exitCode === null && server.signalCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
  }
  function getBrowser() {
    const chromiumOptions = { executablePath: process.env.EYA_BROWSER_EXECUTABLE, args: process.env.EYA_BROWSER_NO_SANDBOX ? ['--no-sandbox'] : [] };
    browser ||= playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? chromiumOptions : {}) });
    return browser;
  }
  // Most continuity suites arrange their own panels. Opt out of the production
  // startup terminal explicitly; startup tests pass terminal (or null for defaults).
  async function client({ type = 'html', storage = false, viewport = { width: 1440, height: 900 }, connect = true, startupPanel = 'none', webgl = true, terminalCompression = true, dataUrlLoopbackRelay = false, setupContext } = {}) {
    if (!CLIENT_TYPES.includes(type)) throw Error(`Unknown fixture client artifact ${type}`);
    const browser = await getBrowser();
    const config = startupPanel === null ? {} : { startupPanel };
    if (!terminalCompression) config.terminalCompression = false;
    const password = options.env?.EYA_KEY ?? KEY;
    if (type === 'data-url') Object.assign(config, { url, key: password });
    const key = `${type}:${JSON.stringify(config)}`;
    if (!artifacts.has(key)) {
      if (type.startsWith('hosted-')) {
        artifacts.set(key, `${http}/client.${type === 'hosted-svg' ? 'svg' : 'html'}`);
      } else {
        const html = (await fs.readFile('client.html', 'utf8')).replace('<script id="eya-config" type="application/json">{}</script>', () => `<script id="eya-config" type="application/json">${JSON.stringify(config).replace(/</g, '\\u003c')}</script>`);
        let output = html;
        if (PACKAGERS[type]) {
          const generator = await browser.newPage();
          try {
            await generator.goto(http);
            output = await generator.evaluate(({ name, html }) => EyaGenerator[name](html), { name: PACKAGERS[type], html });
          } finally { await generator.close(); }
        }
        if (type === 'data-url') artifacts.set(key, output);
        else {
          const filename = path.join(root, `client-${artifacts.size}.${type.endsWith('svg') ? 'svg' : 'html'}`);
          await fs.writeFile(filename, output); artifacts.set(key, pathToFileURL(filename).href);
        }
      }
    }
    const context = await browser.newContext({ viewport });
    try {
      if (type === 'data-url' && dataUrlLoopbackRelay) {
        // Exercise the client's opaque data origin without changing Chromium's
        // local-network policy. Only connections to the disposable Noise server
        // are intercepted, and their encrypted frames still reach that server.
        await context.routeWebSocket(new RegExp(`^ws://127\\.0\\.0\\.1:${port}/`), relayDataSocket);
      }
      await setupContext?.(context);
      await context.addInitScript(({ disable, webgl }) => {
        if (!webgl) {
          const getContext = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (type, ...args) { return type === 'webgl2' ? null : getContext.call(this, type, ...args); };
        }
        if (disable) {
          Object.defineProperty(window, 'localStorage', { get() { throw Error('Browser storage disabled'); } });
          Object.defineProperty(window, 'indexedDB', { get() { throw Error('Browser storage disabled'); } });
        }
        const Native = WebSocket; window.__sockets = [];
        window.WebSocket = class extends Native { constructor(...args) { super(...args); window.__sockets.push(this); } };
      }, { disable: !storage, webgl });
      const page = await context.newPage(); page.on('pageerror', error => { errors.push(error.message); console.error('Client error:', error.message); });
      page.on('dialog', dialog => page.__dialogHandler ? page.__dialogHandler(dialog) : dialog.accept());
      await page.goto(artifacts.get(key));
      if (connect) {
        if (type !== 'data-url' && !type.startsWith('hosted-')) {
          await page.locator('#url').fill(url);
          await page.locator('#key').fill(password);
          await page.evaluate(() => {
            const button = document.getElementById('start-connection');
            if (!window.EyaWorkspaces?.getState().workspace && button.closest('dialog').open && !button.disabled) button.click();
          });
        }
        await page.waitForFunction(() => window.EyaWorkspaces?.getState().workspace);
      }
      return page;
    } catch (error) {
      await context.close();
      throw error;
    }
  }
  async function saved(page) {
    await page.evaluate(() => EyaWorkspaces.save());
    await page.waitForFunction(() => { const state = EyaWorkspaces.getState(); return !state.pending && !state.conflict && state.workspace; });
  }
  async function manage(page) {
    const dialog = page.locator('#workspaces-dialog');
    if (!await dialog.isVisible()) {
      await page.locator('#workspaces').click();
      await page.getByRole('menuitem', { name: 'Manage workspaces', exact: true }).click();
    }
    await dialog.locator('[data-workspace-id]').first().waitFor();
    return dialog;
  }
  async function named(page, name = 'Test workspace') {
    if (await page.evaluate(() => !!EyaWorkspaces.getState().workspace?.name)) return;
    await saved(page);
    const previousHandler = page.__dialogHandler;
    page.__dialogHandler = dialog => dialog.type() === 'prompt' ? dialog.accept(name) : dialog.accept();
    const dialog = page.locator('#workspaces-dialog'), wasOpen = await dialog.isVisible();
    try {
      if (!wasOpen) await manage(page);
      const id = await page.evaluate(() => EyaWorkspaces.getState().workspace.id);
      await dialog.locator(`[data-workspace-id="${id}"]`).getByRole('button', { name: 'Save workspace', exact: true }).click();
      await page.waitForFunction(() => !!EyaWorkspaces.getState().workspace?.name);
      if (!wasOpen && await dialog.isVisible()) await dialog.getByRole('button', { name: 'Close workspaces', exact: true }).click();
    } finally { page.__dialogHandler = previousHandler; }
  }
  async function snapshot() {
    try { return JSON.parse(await fs.readFile(path.join(state, 'workspaces.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { schema: 1, workspaces: [] }; throw error; }
  }
  async function close() {
    try { await (await browser?.catch(() => null))?.close(); }
    finally { await stop(); await fs.rm(root, { recursive: true, force: true }); }
  }
  try { await start(); } catch (error) { await close(); throw error; }
  return { root, files, state, url, http, port, errors, client, getBrowser, saved, named, manage, snapshot, start, stop, close, get pid() { return server?.pid; } };
}
module.exports = { fixture, KEY, CLIENT_TYPES };
