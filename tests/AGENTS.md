# Test guide

Tests are plain Node scripts. Browser suites use Playwright from `client/node_modules`; protocol sources are bundled with esbuild so browser WebSocket and crypto APIs are available.

## Select the narrow suite

- Connection/PTY: `browser.cjs`, `noise-client.js`, `reconnect.cjs`, `panel-factories.cjs`.
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
