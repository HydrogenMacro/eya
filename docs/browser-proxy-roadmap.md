# Client proxy browser: inventory and development report

Baseline assessment: 2026-11-16. P1 implementation shipped in v2.4.0; public-site testing and response-credit fix followed in v2.5.1. Delivery plan revised 2026-11-17 for v2.6.0. This report describes the source in this change set. It is an implementation audit and proposed roadmap, not a claim of compatibility with arbitrary public sites or a production performance benchmark.

## Product target and current delivery plan

Proxy browser should open documentation from an ordinary URL and support reading, chapter navigation, Back/Forward, selection, code presentation and site search without per-site switches, injected recipes or a manual change of browser mode. React, Swift, PixiJS, Rust, Python and MDN are the first acceptance set. Server Chromium remains available for capabilities that require a native upstream origin or an independent browsing context; its availability is not a substitute for fixing the proxy's ordinary document workflows.

The 2.5.1 [live assessment](browser-proxy-public-sites.md) is the baseline: none of its nine proxy rows completed the full workflow. It exposed shared loading defects rather than six independent unsupported sites. The 2.6 work therefore prioritizes the following pipeline repairs before adding UI controls:

| Workstream | Implementation in the current worktree | Acceptance check |
| --- | --- | --- |
| Compressed HTTP documents | Bounded gzip/deflate streaming in the server, including malformed input and decoded-size defenses | Canonical Swift document opens through real Noise/server egress; cache, range, cancellation and backpressure regressions pass |
| Initial and dynamic scripts | Parser-time static materialization, synchronous DOM resource interception, upstream script identity and ordered dynamic classic scripts | React remains readable after hydration; Rust search index loads; dependency order and page cancellation survive HTML/SVG artifacts |
| CSS fidelity | Shared token-aware CSS resource rewriting preserves escaped data SVG and import qualifiers | PixiJS retains its native font/layout and article text; no bogus stylesheet-relative SVG requests |
| Virtual document URL reads | Conservative JavaScript read rewriting plus a Location-like view that changes no browser origin privileges | Python search consumes its actual query and opens a result; React initializes the correct route |
| Modules and search application bootstraps | Bounded on-demand page imports, cyclic ESM and bundled classic worker startup | MDN/PixiJS search accepts input, returns query-specific results and opens a document; delayed imports retain their resources |
| Public workflow gate | `EYA_PROXY_PUBLIC_REQUIRE_USABLE=1` makes characterized failures fail the opt-in public test | All selected native and proxy workflows pass from fresh contexts; partial HTML cannot count as usable |

This table distinguishes implementation from acceptance. A helper's local fixture test is not evidence that a public site works, and the historical assessment must not be relabeled as a new passing run. Record fresh results with source and binary hashes, including unresolved cases. [Eya 2.6 documentation workflows](browser-proxy-26-sites.md) Keep changing public sites outside mandatory hermetic CI, and convert each shared defect into a deterministic regression.

Eya 2.6.0 passed the six HTML proxy workflows and the React, Swift and PixiJS SVG recheck. The report preserves the first SVG run's missed PixiJS search click and the runtime errors observed during otherwise successful workflows. [Live workflow results](browser-proxy-26-sites.md)

### Definition of done for the first documentation set

1. Enter the normal credential-free documentation URL in a fresh Proxy browser panel. No site-specific configuration, direct-network fallback or scripts-off substitution is needed.
2. Retain the expected article after scripts and styles load, with native-reference computed typography and legible text/code. Check images and screenshots separately; a nonzero stylesheet count is insufficient.
3. Follow a real chapter link, return with Back, select prose with the mouse, and exercise the site's search/filter. Search must yield query-specific results and open the chosen article, not merely display a modal or static shortcut links.
4. Repeat React, Swift and PixiJS through the SVG standalone artifact, keeping the same runtime policy. Confirm fresh native Chromium controls so a changed site selector cannot be mistaken for proxy failure.
5. Preserve bounded queues, graph/source sizes, cancellation, cache identity, mutation uncertainty and cleanup. No reconnect may replay a page operation merely because a framework failed.
6. Keep exactly `sandbox="allow-scripts"` and the restrictive resource CSP. Observe CSP-rejected requests separately from requests that reach the external network blocker. Finite passing cases do not establish arbitrary-page confinement.

### Embedding boundaries

The supported target is the document and application behavior that can run inside the existing opaque frame. It does not grant an upstream browser origin. Native service/shared workers, cross-origin embedded applications, OAuth/popups/passkeys, persistent upstream origin stores and privileged device APIs remain distinct capability projects. Embedded runnable examples that require a separate origin/context must fail honestly while the surrounding article remains usable. Do not fabricate a successful API result, widen sandbox/CSP, redirect traffic onto the device network or automatically replay an operation in Chromium to make a test pass.

Client rendering preserves native text rasterization, selection, accessibility semantics, scrolling and local hover without screenshot traffic. The panel continues to disclose **Experimental · Some requests may use this device’s network.** Navigation rewriting is not a general confinement guarantee; server-only egress and client-IP concealment still require a different trusted interception architecture.

## Previously shipped baseline

- Registered `proxy-browser` as its own searchable panel type, with a generator starting-panel choice. Existing `web-browser` descriptors retain their Chromium meaning. No browser wire meaning or authentication boundary changes for this panel addition.
- Moved **Local HTML** into Proxy browser options. Chromium offers its existing streaming and PDF controls; the proxy does not show those inapplicable settings.
- Made the existing Find, privacy controls, bookmarks/history and DevTools accessible in proxy options. The underlying implementations already existed but were disconnected from the simplified Chromium UI. Extension installation remains unavailable in the proxy.
- Added local proxy page zoom. The browser renders a larger or smaller logical iframe viewport and scales it to the panel; no screenshot resampling occurs.
- Fixed cancellation of an in-progress Local HTML open: a late file response no longer replaces the current page after Cancel or Escape.
- Initially persisted the active successful GET URL (up to 4096 characters) in workspace metadata; v2.4.0 extends this to bounded multi-tab state. Selecting that saved workspace performs a new GET, without attaching or creating a Chromium session. Loading, failed and POST destinations save a blank URL; request bodies and uncertain mutations are never restored. Longer URLs are omitted, not truncated into another destination.
- Added source-level interaction coverage and a built-client launcher/local-file/workspace regression. These exercise bounded fixtures, not a complete site compatibility matrix.

The [real documentation-site assessment](browser-proxy-public-sites.md) tests React, Swift, PixiJS, Rust, Python and MDN through the built client and actual server proxy. It fixes a completed-response credit race that interrupted unrelated resources, but still finds React hydration failure, unsupported Swift gzip, PixiJS presentation problems and documentation-search gaps. The deterministic fixtures alone do not establish public-site viability.

## What already exists

| Layer | Current implementation | Important constraints |
| --- | --- | --- |
| Authenticated transport | `client/browser-transport.js` and `eya-server/src/browser.rs`: separate Noise browser WebSocket, request IDs, response chunks, cancel and credits | Preserves the existing browser prologue; HTTP and upstream sockets share one authenticated channel |
| Server egress | Existing URL, address, DNS pinning and redirect validation | These apply to requests that reach the server proxy; they do not protect requests escaping from the client frame |
| Documents | `browser-panel.js` fetches HTML, neutralizes direct resources, injects runtime and supplies only `srcdoc` to `sandbox="allow-scripts"` iframe | Opaque origin; no `allow-same-origin`, native forms or popup permission |
| Resources | HTML/CSS rewriting, static asset materialization into object URLs, request deduplication, cache and retained-object budgets | Full-resource buffering for many assets; incomplete coverage of every modern HTML/CSS resource primitive |
| Runtime networking | Fetch, asynchronous XHR, EventSource, sendBeacon, WebSocket bridges | Reconstructed browser objects differ from native networking; beacon delivery is best effort |
| Navigation | Link/form bridge, common scripted Location rewrite, Navigation API fallback, virtual History API and popstate | Interactive mode uses the Navigation API. Without it, reader mode keeps links and GET forms with site scripts disabled. Self-navigation in interactive mode is only partly enforceable. |
| Scripts/workers | Classic scripts, bounded same-origin page and dedicated worker graphs, userscripts | Page graphs support cycles and computed imports. Workers support bounded static and literal module imports plus recognized classic bundle startup. Shared and service workers are separate. |
| Cookies/CORS | Virtual cookie jar and bounded preflights, credentials/header filtering | These are approximations of browser origin policy, not the native origin identity of the upstream site |
| Storage | Virtual local/session storage snapshots, quotas and same-panel cross-tab synchronization | Backed by a private in-memory map per panel, not persistent IndexedDB. Cookie jar is per panel. No full upstream IndexedDB/Cache Storage environment |
| Diagnostics | Console, Network, HAR export, optional bounded body capture, Elements, Sources, Storage and Performance | Instrumented JavaScript views rather than complete browser DevTools; remote-specific extension features are absent |
| Local HTML | `client/html-viewer.js`, authenticated file callbacks, relative documents/assets and viewer history | Scripts disabled, direct networking blocked by CSP, `.html`/`.htm` entry point; not a local application server |
| Workspace integration | Versioned, bounded GET tab URLs, active tab and zoom; inactive tabs load on selection | No live runtime retention, auth-cookie persistence, full tab history, selected local file, or in-page JavaScript state restoration |

Source routing: `client/browser-proxy-dom.js`, `browser-proxy-css.js`, `browser-proxy-script.js`, `client/browser-panel.js`, `browser-transport.js`, `html-viewer.js`, `browser-eventsource.js`, browser factory registrations in `client/app.js`, `eya-server/src/browser.rs` and `browser_egress.rs`.

## Explicit resource limits

These are the current relevant defaults/constants, not goals to increase indiscriminately:

| Resource | Bound |
| --- | --- |
| Open page tabs | 24 per panel |
| Buffered HTML/proxy response | 8 MiB client buffer |
| Streamed server response | 64 MiB |
| Request body | 4 MiB; 40 KiB inline threshold |
| Client transport active / queued requests | 8 / 64 |
| Upstream page WebSocket message / sockets | 1 MiB / 8 per server proxy session |
| Concurrent buffered static materializations | 2 |
| Initial document scripts / prepared markup | 64 scripts / 32 MiB characters |
| Dynamic resource materializations | 2,048 per document |
| Rewritten stylesheet | 8 MiB characters / 256 resource references |
| Retained static materialization budget | 256 MiB per panel budget |
| Server response cache | 16 MiB, 128 entries; 1 MiB body per entry |
| Virtual local storage | 1 MiB per origin; 8 MiB total |
| Virtual session storage | 1 MiB per area; 2 MiB per tab total |
| Dedicated workers | 4 per tab; 2 concurrent worker fetches |
| Worker graph | 4 MiB, 16 scripts, import depth 4 |
| Page module graphs | 64 graphs and 8 MiB source per document; computed page imports are same-origin and cached |
| DevTools sources | 512 KiB per source; 4 MiB shared source budget |
| Captured response bodies | 256 KiB per entry; 2 MiB shared capture budget |

The transport streams in 48 KiB chunks. Streaming avoids allocating an entire response in one transport buffer, but an image/font/media object often still needs materialization before use. A slow consumer must retain credit backpressure; dropping limits to pursue throughput would make the standalone client easier to exhaust.

## Architecture and remaining work

### P0: choose an enforceable egress architecture

Current protection combines inert parsing, resource rewriting, opaque-origin sandboxing, CSP and runtime interception. Capturing native event/channel methods helps survive page monkey-patching. It does not make writable page globals, incomplete language rewriting or browser navigation semantics a trusted network broker.

A sandbox restricts script privileges, origin access, popup/form behavior and ancestor navigation, but does not inherently force a frame's own navigation through an application bridge. The [HTML iframe specification](https://html.spec.whatwg.org/multipage/iframe-embed-object.html) defines those restrictions separately. Navigation interception has limits: the [Chrome Navigation API documentation](https://developer.chrome.com/docs/web-platform/navigation-api) states cross-origin navigations and cross-document traversals cannot be intercepted. This is why feature detection and finite escape tests do not establish a confinement guarantee.

Evaluate these concrete alternatives:

1. **Keep the experimental panel:** retain the permanent network disclosure and explicit unsupported-site errors. Keep Chromium the default. This is the least work and accurately describes the existing boundary.
2. **Restricted reader mode:** disable page scripts and all direct network sources; render sanitized HTML/CSS with authenticated, bounded resource loads. This gives a useful fast path for documentation/articles with a much smaller compatibility surface. It cannot run arbitrary applications.
3. **Controlled browser extension or dedicated local application:** enforce request routing in an environment with network interception authority and well-defined origin/profile isolation. This changes installation/deployment and permission requirements.
4. **Server-hosted origin-rewriting proxy:** requires controlled delivery origins, certificates/site isolation and careful policy translation; it breaks the current self-contained `file:`/`data:` client assumptions and still has difficult application compatibility/security consequences.
5. **Chromium-backed semantic/DOM projection:** keep the real browser responsible for site execution and egress, send a controlled render representation. This becomes a separate remote rendering engine and needs extensive input/layout/accessibility work; it is not a small extension to the current rewrite proxy.

Do not claim a strict mode by adding `navigate-to` CSP: the code deliberately does not rely on that unsupported directive. Do not fix compatibility by adding `allow-same-origin`, opening `connect-src https:`, permitting arbitrary nested frames or making direct-network retries automatic.

Acceptance: a documented threat model; adversarial tests for scripts, timers, meta refresh, Location aliases/computed accesses, nested/blob/data documents, modules, workers, CSS/SVG/media/font hints and every navigation transition; real browser network observation; explicit failure behavior. Passing tests is evidence for covered mechanisms, not proof against all future web features.

### P1: maintain the compatibility and workflow corpus

Implemented the deterministic corpus and opt-in public matrix in v2.4.0; see [compatibility testing](browser-proxy-compatibility.md) for the harness, recorded results, measured scope and skips. This is a characterization tool, not a claim of arbitrary-site support.

Build a deterministic local corpus and an opt-in public-site matrix: static documentation; forms/login; a module SPA; WebSocket UI; streaming API; images/fonts/CSS; large lists; media; third-party frames. Record response status, console exceptions, unsupported API calls, direct client requests, time to first content, usable interaction and bytes.

Compare server Chromium and proxy at the same logical viewport and font availability. Include generated HTML, SVG, compressed HTML, compressed SVG and data URL, plus hosted HTML and SVG. Exercise reader mode with the Navigation API unavailable, and keep independent Firefox/WebKit and coarse-pointer coverage where possible. Public sites may require cookies, consent, authentication or change behavior; do not turn them into mandatory hermetic CI dependencies.

Fail with a concise reason and recommend Browser when an API cannot work. Provide a user-initiated **Open in Browser** handoff as a later improvement; never automatically replay POST, uploads, payments or partially completed requests across modes.

### P1: browsing continuity and reconnect

Workspace continuity shipped in 2.4.0. Automatic channel recovery follows in 2.7.0.

- The proxy panel reports automatic retry and obtains a fresh authenticated channel with bounded backoff. A future GET/HEAD with no body can wait for the next attempt. Recovery preserves the current document and never resumes a socket or retries an interrupted request. Disconnected mutations fail before send. Interrupted mutations report unknown completion. Abort and close cancel connection waits. An explicit disconnect pauses retries until Eya reconnects.
- `config.proxyState` has `v:1`, at most 24 `{url}` tabs, a bounded active index, and zoom 0.5–2. URLs are credential-free HTTP(S), at most 4096 characters each, with a conservative 7000-byte UTF-8 snapshot budget inside the existing 8192-byte config limit. Oversize/unsafe destinations become blank tabs without shifting indices. Unknown versions fall back to the legacy `initialUrl`; absent state defaults to one blank tab. New saves also include the legacy active GET URL when the combined descriptor fits.
- Selecting a workspace loads only the active saved GET; other saved GETs load on tab selection. POST results, failures and pending navigations save blank. No bodies, cookie/storage values, dirty fields, page execution state or local file path enter the descriptor. Local documents require explicit opening through the authenticated file APIs, avoiding implicit restoration across changed roots/identities.
- Preferences, imported filters/userscripts and site storage use a private panel-lifetime map. Cookies remain per-panel, local storage per virtual origin within that panel, and session storage per tab/origin. Closing the panel discards this state; opening another server/workspace/panel cannot inherit it. Existing byte quotas, cookie expiry/HttpOnly visibility and **Clear site data** remain in effect. No new durable secret storage was introduced.

Remaining persistence work: the proxy has no resumable Chromium profile, and a lost transport loses live requests and upstream sockets. Reopening a page performs a new GET and can invalidate application state. Restoring local paths would need explicit consent tied to server identity/root and the existing authenticated file APIs. POST results, dirty inputs, uploads and script state cannot be recovered safely from URLs alone and remain excluded.

The previous globally named preference/storage map has been replaced with panel-local memory. Durable sharing across different Eya servers, authenticated identities, workspaces and proxy panels still requires a separate partitioned design. Define clearing semantics and quotas, HttpOnly handling, cookie expiry, partitioning and origin identity. Do not serialize authentication cookies or secret storage into workspace metadata by default.

### P1: JavaScript, origin and application APIs

Implemented the [detailed API inventory](browser-proxy-apis.md) and error handling in v2.4.0. Present unsupported native/device APIs reject using their asynchronous, synchronous or callback shape, with bounded first-use Console hints recommending Browser. Absent APIs remain absent; native opaque-origin storage errors stay errors. Shared workers, persistent origin stores, authentication/device bridges and nested applications have not been fabricated. XHR MIME overrides now report `NotSupportedError` instead of accepting an ineffective override. Working dedicated workers, network bridges and ordinary DOM behavior remain covered by their existing suites.

The opaque frame's real `location`, origin and storage privileges differ from the upstream site. Exposing a synthetic URL cannot fully emulate native origin checks. The inventory records supported behavior and remaining gaps for these areas:

- Module resolution: general upstream import maps, bare specifiers, import attributes and broader worker dependency patterns.
- Workers: shared/service workers, worker module semantics and cancellation; preserve bounded graphs for supported dedicated workers.
- Persistent storage: upstream IndexedDB, Cache Storage and storage events; any implementation needs per-origin quotas and partitioning.
- Authentication: OAuth redirects/popups, HTTP auth, client certificates, passkeys/WebAuthn and secure-context checks.
- Embedded applications: cross-origin iframes, postMessage target origin/source identity, nested frame isolation.
- Native integrations: clipboard, dialogs, printing, file inputs/downloads, notifications, geolocation, fullscreen, pointer lock and device APIs. Chromium bridges must not be assumed available in proxy mode.
- Networking: exact Fetch/XHR redirect, opaque response, streaming upload, credentials, abort, EventSource retry, WebSocket subprotocol/error/close behavior and CORS equivalence.

A browser origin cannot be safely fabricated by rewriting a few properties. Full compatibility is likely to need a different architecture; prioritize the site classes this panel is meant to serve.

### P2: rendering correctness and local documents

Audit non-UTF-8 HTML/CSS, content-type sniffing, BOM/meta charset, base URL interactions and streamed document parsing. Current top-level HTML is decoded as UTF-8 after buffering. Check SVG fragments, `srcset`/`picture`, stylesheet `@import`/fonts, CSS nesting and modern URL-valued constructs, lazy images, generated nodes and asset redirects. Preserve script execution order and never activate unneutralized markup in the outer client document.

Keep local HTML scripts disabled by default. A future trusted-docs script mode needs a separately reviewed permission model: logical-root scoping, percent-encoded path separators, external URLs, dynamic resource creation, workers, form/navigation behavior and explicit revocation. It should not become an internet proxy bypass. Add file combobox/path completion, a local reload control, visible failed-resource diagnostics and optional user-selected relative-root scope before broadening script support.

Local document viewing and proxy internet browsing share a panel container but remain different loaders and policies. A local page must not inherit internet cookies, userscript grants or proxy networking just because it is opened in the same panel.

## Throughput and latency work

Native client text already avoids repeated screenshot traffic, preserves text edges and makes local selection immediate. Optimize the remaining path in this order:

### Pre-render latency investigation

The client waits for the full decoded HTML body, sanitizes it, then fetches initial classic external scripts and linked stylesheets **one at a time** before assigning iframe `srcdoc`. The stylesheet rewrite also waits for its proxied imports, fonts and images. A slow CSS image or an `async` script can therefore delay the first visible text. The early preparation exists to preserve native script ordering and keep upstream resources behind the proxy.

A controlled Node run of `prepareProxyStaticResources` with fake DOM elements and eight delayed resource loaders reproduced the waterfall without starting Chromium. Seven simulated 100 ms assets and one 400 ms stylesheet took 1,117 ms. Each request began only after the preceding request finished. The same delays would take about 600 ms if a two-slot scheduler started requests in document order. That estimate excludes transfer contention, CSS expansion and browser rendering.

Previous live Chromium samples took 7.1 s for React HTML, 3.5 s for Swift compressed HTML, 20.1 s for PixiJS SVG and 11.1 s for PixiJS data URL in the reading check. Those single runs measured the wait for a visible heading after the navigation command and included host and site variability. They cannot attribute the delay to individual phases or establish a client-format comparison. [Live test coverage](browser-proxy-26-sites.md)

The transport adds a separate WAN bottleneck. A buffered document starts with 48 KiB of credit; each subsequent chunk waits for the client to send that credit back. Streaming resources start with zero credit and issue their first grant after headers. A 512 KiB decoded document requires ten extra credit cycles, roughly 1 s at 100 ms client–server RTT if upstream data is ready. The server requests identity encoding upstream and decodes gzip or deflate when returned anyway. The Noise hop carries the decoded data.

Start by timing headers, completed body, HTML preparation, iframe mount and visible heading separately. Then benchmark two bounded initial resource loads with replacement in original markup order, keeping parser, defer and integrity behavior intact. Check cookie-bearing resources for ordering effects. Next, test a negotiated larger credit window for bounded document and static-resource loads while keeping pull-based backpressure for API streams. Measure text compression separately on each network hop. Progressive HTML mounting and late cosmetic assets require broader compatibility testing because they can change first-paint styling and script timing.

### Remaining measurements

1. Instrument phases separately: queue delay, server DNS/connect/TLS, time to headers/first byte, proxy transfer, rewrite/parse, resource materialization and first usable paint. Report p50/p95 and interaction latency rather than only aggregate download speed.
2. Prioritize document/style/font/script dependencies over images and background work while retaining bounded concurrency and fairness. Two buffered static loads can hold up critical CSS behind slow assets; tune only from measurements.
3. Audit the server and panel caches together: freshness, Vary, credentials/cookies, revalidation, cancellation and shared in-flight failures. Do not cache personalized content as public, bypass no-store or reuse transformed blobs across different origin/policy contexts.
4. Reduce repeated source and buffer copies, and put expensive bounded parsing off the UI thread where worthwhile. Module graphs and string rewriting can dominate main-thread time even with little network traffic.
5. Preserve credited streams for API responses and sockets. Explore a bounded media/range path rather than whole-file materialization for large video/audio.
6. Measure compression of HTML/CSS/JS across the server-to-client hop. Determine whether origin compression is preserved or decoded before recommending another layer. Compress text before Noise encryption only with a separate negotiated encoding and explicit decoded-size bounds. Do not double-compress already compressed images/video, or silently alter the deployed body framing.
7. Keep diagnostics opt-in where costly. Response-body capture and full DOM/source inspection should not become baseline work on every frame or request.

Suggested experiment matrix: 0/80/250 ms RTT; 1/5/20 Mbit/s; repeated cached navigation and cold navigation; CPU-constrained standalone client; concurrent image/API/socket activity. Measure actual bytes at each boundary plus memory high-water marks. This audit does not yet provide those measurements and makes no numeric speedup claim.

## Test plan and release boundaries

`tests/browser-proxy-continuity.cjs` covers fresh-channel recovery, queue teardown, abort and mutation uncertainty; `browser-proxy-restoration.cjs` covers lazy multi-tab GET/active/zoom restoration and no POST/failure replay. `browser-proxy-sandbox.cjs` covers opaque origin, parent/frame isolation and per-panel cookie/storage isolation; `browser-proxy-apis.cjs` covers honest unsupported APIs. `tests/browser-proxy-panel.cjs` covers source-level proxy controls, fixture navigation/forms, safe restore URLs, zoom and scripts-off local HTML with cancellation. `tests/browser-proxy-workspace.cjs` covers the real launcher, authenticated local files, sessionless descriptor, SVG saved-workspace restoration and Chromium/local-action separation. Existing `browser-proxy-runtime.cjs`, `browser-transport.cjs`, `browser-html-viewer.cjs`, worker/CORS/cookie/storage/resource-budget suites cover their respective narrow boundaries.

Future wire encodings need additive negotiation, missing/unknown-field tests, old/new peer coverage, explicit encoded/decoded caps and baseline fallback. Keep the permanent update-v1 endpoint and artifact contract unchanged. For API additions, select only offered capabilities; software release equality is not support detection. Route browser panel additions through the workbench registry and keep old clients' unknown-kind placeholder recovery intact.

Release blockers for a future stable proxy: honest egress guarantees, clear unsupported-site behavior, bounded memory under slow/adversarial pages, mutation-safe reconnect, identity-partitioned state and a reproducible compatibility/performance corpus. A public workflow is complete only when its actual article and interactions pass the delivery gates above; general origin-dependent applications still require the native browser architecture.
