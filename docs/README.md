# Documentation index

Use this page to open only the document relevant to a change. For a compact architecture and source map, start with [codebase-map.md](codebase-map.md).

| Area | Document | Use it for |
| --- | --- | --- |
| Architecture | [codebase-map.md](codebase-map.md) | Runtime flow, source ownership, generated boundaries, and feature routing |
| Client generator | [generator.md](generator.md) | Shared settings registry, configuration submenus, fonts and artifact formats |
| UI conventions | [interface.md](interface.md) | Toolbars, icons, menus, CAD controls, and shortcuts |
| Panel framework | [panels.md](panels.md) | Workbench layout, lifecycle, and public factory API |
| Browser panel | [browser.md](browser.md) | Web proxy panel, sandbox boundary, transport, and compatibility limits |
| Browser streaming | [browser-streaming.md](browser-streaming.md) | Capture settings, compatibility, design sources and measured bandwidth/latency tradeoffs |
| Browser compression experiments | [browser-compression-experiments.md](browser-compression-experiments.md) | Real CDP candidate comparisons, exact pixels and encode/decode costs |
| Browser streaming improvements | [browser-streaming-improvements.md](browser-streaming-improvements.md) | Negotiated tiles, frame freshness, recovery, protocol and production measurements |
| Browser compression roadmap | [browser-compression-roadmap.md](browser-compression-roadmap.md) | XOR, tiles, temporal codecs, text fidelity, latency and a staged implementation plan |
| Client proxy browser roadmap | [browser-proxy-roadmap.md](browser-proxy-roadmap.md) | Existing proxy implementation, panel behavior, compatibility gaps and remaining work |
| Proxy browser compatibility | [browser-proxy-compatibility.md](browser-proxy-compatibility.md) | Deterministic corpus, opt-in public-site matrix, measurements and supported test modes |
| Proxy documentation workflows | [browser-proxy-26-sites.md](browser-proxy-26-sites.md) | Public site results, client format and engine coverage, and test resource limits |
| Public documentation viability | [browser-proxy-public-sites.md](browser-proxy-public-sites.md) | Real React, Swift, PixiJS, Rust, Python and MDN tests through the generated client and actual server proxy |
| Proxy browser APIs | [browser-proxy-apis.md](browser-proxy-apis.md) | Origin/API inventory, honest unsupported behavior and sandbox limits |
| Browser API roadmap | [browser-api-roadmap.md](browser-api-roadmap.md) | Native browser capability gaps and improvements to existing bridges |
| Files/editors | [file-manager.md](file-manager.md) | File operations, transfers, viewers, permissions, and limits |
| Workspace continuity | [workspaces.md](workspaces.md) | Server-owned workspaces, explicit selection, durable layouts, session discovery and recovery |
| Reconnection | [reconnection.md](reconnection.md) | Protocol v4 offsets, buffering, indefinite terminal detach/resume, and Browser expiry |
| Releases and updates | [updates.md](updates.md) | SemVer, HTML/SVG client self-update, permanent recovery protocol and wire compatibility standards |
| Terminal network improvements | [terminal-network-plan.md](terminal-network-plan.md) | Output pacing, negotiated compression, measured latency and Mosh-inspired options |
| Machine APIs | [system-panels.md](system-panels.md) | Shared Task Manager/Docker transport, authentication, and server limits |
| Task Manager | [task-manager.md](task-manager.md) | Process/performance UI behavior |
| Docker | [docker.md](docker.md) | Container, Compose, logs, resources, and panel API |
| Charts | [charts.md](charts.md) | Accessible SVG chart API and behavior |
| CAD | [cad.md](cad.md) | build123d workflow, viewer controls, formats, and constraints |
| Client audit | [client-audit.md](client-audit.md) | Correctness/mobile hardening summary and regression coverage |
| Backend audit | [backend-audit.md](backend-audit.md) | Server hardening summary and deployment boundaries |
| Artifact size | [client-sizes.md](client-sizes.md) | Reproducible standalone-client size reporting |

The root `README.md` remains the operator-facing setup, deployment, security, and development guide. Keep details in the focused document above and link from the README when they are important to operators.
