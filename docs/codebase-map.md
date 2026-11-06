# Codebase map

This is the shortest path from a feature request to its implementation and tests. It describes ownership, not every implementation detail.

## Runtime shape

1. `client/build.mjs` bundles `client/app.js` and its imports into the generated, self-contained `client.html`. It separately bundles `client/generator.js` into generated `client/generator.html`.
2. `eya-server/src/main.rs` embeds those artifacts plus `client/hosted.svg` at compile time and serves the generator, hosted clients, and `/ws`.
3. A client authenticates with the shared key through a Noise `NNpsk0` handshake. Terminal bytes, file requests, and machine requests then share the encrypted WebSocket protocol.
4. Protocol-v4 terminal sessions live in `resume.rs`; fresh connections can reattach by token and byte offset while the server retains the PTY and bounded replay data.
5. File operations pass through `files.rs`. Machine statistics and validated process/Docker operations pass through `system.rs`.

The client is intentionally deployable as one file. There is no runtime asset server or client framework.

## Source versus output

| Output | Source of truth | Rebuild |
| --- | --- | --- |
| `client.html` | `client/app.js`, imported JS modules, `client/template.html`, and client CSS | `node client/build.mjs` |
| `client/generator.html` | `client/generator.js` and `client/generator.template.html` | `node client/build.mjs` |
| `tests/*.bundle.cjs` | matching protocol `.js` source | esbuild command in `tests/AGENTS.md` |
| Rust binary | `eya-server/src/*.rs` plus embedded client outputs | build client, then Cargo |

Never diagnose source behavior from minified generated output unless the issue is specifically in bundling or embedding.

## Feature routing

| Feature | Primary implementation | Focused docs/tests |
| --- | --- | --- |
| Connection, encryption, primary terminal | `client/app.js`, `eya-server/src/main.rs` | `reconnection.md`; `browser.cjs`, `noise-client.js` |
| Independent terminal panels | `client/terminal-panel.js`, `client/app.js` | `panels.md`; `panel-factories.cjs` |
| Resume/replay/backpressure | `client/app.js`, `client/terminal-panel.js`, `eya-server/src/resume.rs` | `reconnection.md`; `reconnect.cjs` |
| File protocol and host identity | `client/app.js`, `eya-server/src/main.rs`, `eya-server/src/files.rs` | `file-manager.md`; `file-protocol.js` |
| File browser/editor/viewers | `client/file-browser.js`, viewer/editor sections of `client/app.js` | `file-manager.md`; file/viewer suites |
| Tabs, splits, panel factories | `client/panels.js`, registrations in `client/app.js` | `panels.md`; `panels.cjs`, `panel-factories.cjs` |
| Shared controls and themes | `client/ui.js`, `components.css`, `themes.css`, `mobile.css` | `interface.md`; `polish.cjs`, mobile suites |
| Task Manager | `client/task-manager.js`, `eya-server/src/system.rs` | `task-manager.md`, `system-panels.md`; `task-manager.cjs` |
| Docker/Compose | `client/docker-panel.js`, `eya-server/src/system.rs` | `docker.md`, `system-panels.md`; Docker suites |
| Charts | `client/charts.js`, `client/charts.css` | `charts.md`; `charts.cjs` |
| CAD | `client/cad.js`, viewer integration in `client/app.js` | `cad.md`; `cad.cjs`, `viewer-regressions.cjs` |
| Standalone generator | `client/generator.js`, generator template, server routes | root README; generator suites |

## Security and deployment boundaries

- Anyone with the shared key has terminal-level authority. Network restriction and HTTPS/WSS for client delivery remain part of the security model.
- Native mode acts as the server account. Docker host mode enters the selected host namespaces and consistently applies `EYA_HOST_USER` identity for terminal, file, and machine work.
- The server deliberately bounds handshakes, sessions, file sizes, directory/search work, machine jobs, external command output, runtime, and replay memory.
- The server is the authority for validation. Client checks improve UX but must not replace server-side path, identifier, size, or permission checks.

## Efficient change loop

1. Use the routing table to read one implementation slice and one focused document.
2. Make the smallest source change; do not edit generated artifacts.
3. Rebuild the client only when browser sources changed.
4. Run the narrow test listed in `tests/AGENTS.md`, then broader checks only when the change crosses a boundary.
5. Update the focused doc when behavior, configuration, protocol, or security assumptions changed.
