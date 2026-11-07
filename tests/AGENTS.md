# Test guide

Tests are plain Node scripts. Browser suites use Playwright from `client/node_modules`; protocol sources are bundled with esbuild so browser WebSocket and crypto APIs are available.

## Select the narrow suite

- Connection/PTY: `browser.cjs`, `noise-client.js`, `reconnect.cjs`, `panel-factories.cjs`.
- Browser proxy runtime: `browser-proxy-runtime.cjs` (inert-HTML resource rewriting, private MessageChannel bridge, Ctrl+F and native-find text matching, iframe XHR/EventSource/sendBeacon, sandbox-safe form relay, link/new-tab/download and common scripted Location navigation rewriting, virtual SPA History API routes with popstate state restoration, non-cancelable navigation fallback frame clearing, classic/module Worker fetch and XHR, proxied page-module graphs, cancellation, sandboxed DevTools evaluation, Elements editing, and runtime isolation smoke tests).
- SVG browser panel: `browser-svg-panel.cjs` (hosted and standalone SVG document preludes and browser panel mounting).
- Browser Library imports: `browser-library-import.cjs` (versioned bookmark backup validation, URL filtering, deduplication, size bounds, and round-trip export).
- Browser Workers: `browser-workers.cjs` (classic/module worker bootstrap syntax, static import graph parsing and bounds, cycle and unsupported-import handling, same-origin/CSP boundaries, worker fetch and asynchronous XHR relay, response reconstruction, XHR ready-state/header behavior, and abort cancellation).
- Browser DevTools Console history: `browser-console-history.cjs` (bounded command history, duplicate coalescing, draft restore, and up/down navigation).
- Browser downloads: `browser-downloads.cjs` (RFC 5987 and ordinary filename parsing, path/control-character cleanup, URL fallback, and filename bounds).
- Browser Network export: `browser-har.cjs` (HAR 1.2 structure, approximate request timings, fragments, and credential/query-secret redaction).
- Browser Network bodies: `browser-network-bodies.cjs` (opt-in bounded response capture, shared memory limits, UTF-8 chunk assembly, JSON formatting, and binary handling).
- Browser Network in-flight UI: `browser-network-inflight.cjs` (requests appear before headers, update as streams transfer, and stay cleared after active requests complete).
- Local HTML viewer: `browser-html-viewer.cjs` (scripts disabled, relative links resolved through the file callback, history, and no direct network requests).
- Browser Noise WebSocket transport: `browser-transport.cjs` (Noise handshake, HTTP byte-range metadata/body forwarding, muxed upstream socket open/close, cache-bypass metadata, credited multi-frame HTTP uploads, large binary chunking, and bidirectional credit flow).
- Remote browser Noise WebSocket: `browser-render-transport.cjs` (distinct Noise prologue, frame metadata/chunk ordering and bounds, explicit frame acknowledgment, bounded page-target activate/close/navigation messages, navigation/input/resize/privacy messages, chunked userscript and unpacked-extension transfers, extension removal, capped remote-browser download transfers, bounded debugger command/event transport, selected-call-frame evaluation, URL-and-line breakpoint validation, bounded paused-scope/object inspection, bounded on-demand source listing/content chunks, capped selected Network response-body retrieval, current-origin cookie reads/site-data clearing, and server status events).
- Main-server browser endpoint: `browser-render-server-integration.cjs` (starts the built debug server on a temporary loopback port, authenticates using Noise, and checks an explicit Chromium startup error; run `cargo build --locked --manifest-path eya-server/Cargo.toml` first).
- Remote browser panel: `browser-remote-panel.cjs` (mode switching, lazy remote startup, hard resource-limit status, remote navigation/input/privacy updates, retained target activation without page reload, popup target adoption and page-closed tab cleanup, server-target closure with tab close, matching userscript setup, Network and blocked-request rendering, Console evaluation, Elements inspection/editing, Sources loading, remote Performance capture/recording, Storage inspection/clearing, bounded Full-browser download receipt/save/cancel, extension import/action/removal, and transport cleanup).
- Live Full-browser MV3 extension compatibility: `browser-extension-live.cjs` (opt-in real Chromium `Extensions.loadUnpacked`, content-script execution, action-popup target discovery, and uninstall smoke check; requires `EYA_BROWSER_EXTENSION_INTEGRATION=1` and `EYA_BROWSER_EXECUTABLE`).
- Browser EventSource parser: `browser-eventsource.cjs` (multiline events, IDs, event names, and reconnect delay bounds).
- Browser cookies: `browser-cookie-jar.cjs` (domain/path/expiry/secure scoping and HttpOnly visibility).
- Browser CORS: `browser-cors.cjs` (origin, credentials, preflight, exposed headers, and cache limits).
- Browser filtering: `browser-filter-list.cjs` (EasyList-style network rules, bounded cosmetic selectors, and hosts-file matching).
- Browser userscripts: `browser-userscripts.cjs` (metadata validation, URL matching/exclusions, supported `GM_*` grants including bounded `GM_xmlhttpRequest` authorization and `@resource` metadata/grants, bounded profile storage sanitization, and script-element escaping).
- Browser resource memory: `browser-resource-budget.cjs` (bounded concurrent asset materialization, render-critical priority, cancellation, and retained-blob accounting).
- Browser DevTools Sources: `browser-sources.cjs` (UTF-8-safe source truncation under per-source and panel memory limits, case-insensitive literal search with bounded UTF-16 match ranges).
- Browser virtual storage: `browser-storage.cjs` (UTF-8 quota accounting, untrusted snapshot cleanup, script-safe bootstrap serialization, and quota errors).
- Files/editor/viewers: `file-protocol.js`, `file-browser.cjs`, `file-browser-races.cjs`, `client-audit.cjs`, `viewer-regressions.cjs`.
- Workbench/UI/mobile: `panels.cjs`, `polish.cjs`, `mobile.cjs`, `mobile-edge-cases.cjs`, `workspace-v2.cjs`.
- Generator/artifacts: `generator.cjs`, `generator-compression.cjs`, `crypto-bundle.cjs`.
- CAD/charts: `cad.cjs`, `charts.cjs`.
- System/Docker: `task-manager.cjs`, `docker-advanced.cjs`, `system-panels.cjs`, `system-protocol.js`.

Read a test's first setup block before running it. Do not scan generated `*.bundle.cjs`; edit the corresponding `.js` source.

## Prerequisites

- Rebuild `client.html` with `node client/build.mjs` after client-source changes.
- Browser tests need `NODE_PATH=client/node_modules`; set `EYA_BROWSER_EXECUTABLE` when Playwright does not manage Chromium.
- End-to-end tests expect an isolated server on `127.0.0.1:18765` with the fixed test key documented in the root README.
- Tests that set `EYA_TEST_ROOT` mutate files. Point it only at a disposable directory containing the needed fixture (usually `seed.txt`).
- `EYA_BROWSER_NO_SANDBOX=1` is for containerized Chromium, not the normal default.

## Protocol bundles

Rebuild only the source under test:

```sh
NODE_PATH=client/node_modules client/node_modules/.bin/esbuild tests/noise-client.js --bundle --platform=browser --format=iife --outfile=tests/noise-client.bundle.cjs
NODE_PATH=client/node_modules client/node_modules/.bin/esbuild tests/file-protocol.js --bundle --platform=browser --format=iife --outfile=tests/file-protocol.bundle.cjs
NODE_PATH=client/node_modules client/node_modules/.bin/esbuild tests/system-protocol.js --bundle --platform=browser --format=iife --outfile=tests/system-protocol.bundle.cjs
```

The bundles are generated and ignored. Prefer one relevant suite over the entire browser matrix, then expand coverage when a change crosses protocol, workspace, mobile, or security boundaries.
