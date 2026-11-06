# Client correctness and mobile audit

The mobile regression suite uses Chromium touch emulation, compositor-driven swipes, repeated/nested menu taps, rotation, 320 px layouts, and HTML/SVG documents. Physical iOS/Safari testing remains a manual check; these tests cannot prove behavior on every browser/device.

Performance dashboards now use a bounded scroll container and chart plot dimensions that match the SVG viewBox. The page scroll lock recognizes scrollable ancestors rather than a fixed list of panels. Manual terminal, CAD, sash, and arrow-key gestures retain their dedicated behavior. Shared popovers use explicit dismissal to avoid native light-dismiss racing the trigger click. Chrome disables double-tap zoom and incidental selection while text inputs, editors, logs, and detail values remain selectable.

Client review fixes also include coalesced concurrent file opens, stale-connection result guards, bounded pending/control requests, interrupted upload backpressure checks, and streamed local File uploads in 60 KB slices. Open editors follow file/folder renames without losing text or undo history, refuse destination-editor conflicts, and prevent concurrent saves during a rename. File menus re-anchor on scrolling while their row remains visible.

`tests/client-audit.cjs` checks streamed multi-chunk uploads without whole-file buffering, concurrent opens, undo across rename, and saving only to the renamed path. Existing file, panel, viewer, CAD, and reconnect suites cover related workflows. `tests/mobile-edge-cases.cjs` checks actual touch scrolling, graph geometry, repeated menu toggles, rotation, and selection/touch policies.

Backend fixes and deployment boundaries are recorded in [backend-audit.md](backend-audit.md). Client-size measurements and compressed-format compatibility are recorded in [client-sizes.md](client-sizes.md). No review or test suite establishes freedom from all edge cases; network filesystem latency, physical-browser behavior, and memory requirements of very large decoded media/models still depend on the host and browser.
