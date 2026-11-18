# Proxy browser compatibility corpus

The P1 compatibility harness is `tests/browser-proxy-compatibility.cjs`, with deterministic sites in `tests/browser-proxy-corpus-fixture.cjs`. It loads the production panel source in an HTML or SVG client shell, preserves `sandbox="allow-scripts"`, and compares the same sites with ordinary native Chromium rendering. The reference is the real engine used by Browser, **not** Eya's remote Browser transport or screenshot pipeline. Server egress correctly rejects loopback destinations; a bounded Node fixture broker supplies local proxy requests without weakening that policy.

## Coverage

| Site class | Deterministic interaction | Deliberate boundary |
| --- | --- | --- |
| Static documentation | Render multilingual text and activate a document control | No claim of complete font shaping or accessibility coverage |
| Forms/login shape | Submit synthetic named fields via POST and render confirmation | No real credentials, OAuth, payment, authentication cookies or uncertain mutation retry |
| Module SPA | Resolve a two-module graph, change History API route and fetch API text | No import map, cycle, dynamic import or application framework matrix |
| WebSocket UI | Open a socket, send a ping, receive a text update and close | Small fixture echo; transport credit/backpressure tests remain separate |
| Streaming API | Read a response incrementally and assemble both chunks | No infinite stream, streaming upload or WAN experiment |
| Images/fonts/CSS | Decode SVG image and pinned WOFF2 font; resolve CSS import and computed style | Explicitly waits for a genuinely loaded FontFace rather than accepting fallback text |
| Large lists | Render 1,500 rows and filter to one result | No virtualization or CPU/memory stress claim |
| Media | Play a silent one-second PCM WAV through a user action | No video, codecs, DRM, adaptive streaming or synchronization claim |
| Third-party frames | Receive a child-frame readiness message | Proxy deliberately removes the frame; reports unsupported instead of widening sandbox permissions |

Every run records engine/version, mode, shell, actual logical viewport, coarse-pointer state, response statuses/methods, decoded response-body and upload bytes, console errors/page exceptions, explicit unsupported outcomes, observed direct client HTTP/WebSocket requests, first-content time, interaction result/time and streaming chunk count. Query strings and credentials are omitted from recorded URLs. Fixture report URLs use `fixture:/…`, keeping disposable ports out of the published results. Console and diagnostic collections are bounded.

The proxy broker enforces an 8 MiB response limit, five-second request deadline, at most 16 pending requests and 128 requests per fixture. Its streamed body uses pull requests and cancellation rather than prebuffering the entire response. Test sockets go through Node, while a browser-side network observer records unexpected direct connections. Covered direct HTTP requests are aborted so an accidental escape cannot make a fixture pass by bypassing the proxy.

A fixture's first-content time is the elapsed host time until its `DOMContentLoaded` + `requestAnimationFrame` message arrives. It is a practical content-ready marker, **not** a browser FCP performance entry or an input-to-pixel measurement. Interaction time starts at navigation and includes harness waits, font loading and Playwright input delivery. Body bytes exclude HTTP headers, WebSocket framing, Noise/TCP overhead, caches and server screenshot bandwidth. Do not use these single local samples as production performance comparisons.

## Recorded results

The checked-in [results](browser-proxy-compatibility-results.json) contain desktop, coarse-pointer emulation and missing-Navigation-API runs, including source hashes and explicit skips. Across all three runs there are **60 rows: 52 usable, 8 expected unsupported, zero failures, zero observed direct client requests and zero console exceptions**. The runs were collected concurrently, so their timing samples are not isolated performance comparisons. Both modes have a measured **1000 × 700 logical content viewport**. The proxy panel's outer size is adjusted for its toolbar and borders. The native and proxy share the same installed browser and host fonts, and the asset case explicitly supplies the same pinned font.

The desktop matrix covers nine site classes with native Chromium and both proxy shells. Eight proxy classes complete their intended interaction. The native reference completes all nine. Third-party frames remain unsupported in both proxy shells. Coarse-pointer emulation repeats the same corpus. The archived missing-Navigation-API run measured earlier behavior that refused internet pages. The current harness verifies that those clients render readable content in reader mode. `tests/browser-proxy-reader.cjs` exercises styles, section and chapter links, Back, and GET forms with a nonce-only script policy. Local HTML has its own regression suite.

Firefox and WebKit are selectable but their browser executables were absent in the recorded environment, so the report records skips rather than claiming coverage. These original P1 runs did not opt in to public requests. The later [real documentation-site assessment](browser-proxy-public-sites.md) uses generated client artifacts and the actual encrypted server proxy; it finds substantially narrower compatibility than these small fixtures. Emulated coarse input is evidence for browser touch/pointer behavior; it does not replace testing a physical phone, its keyboard, zoom, battery or network.

The corpus found two implementation defects that were corrected in this change:

- SVG clients could mount the proxy panel but could not parse ordinary HTML: template `innerHTML` inherited the outer XML parser. Parsing templates in an inert HTML document restores HTML behavior while preserving resource neutralization and the opaque iframe sandbox.
- A form child named `action` could replace the `form.action` property with an element, producing a POST to `/[object HTMLButtonElement]`. Captured native form getters now supply action, method, encoding and target, while retaining submitter overrides and form validation.

The corpus now exercises both paths. Zero direct requests observed in these fixtures is evidence for these mechanisms only; it does not establish strict network confinement for arbitrary pages.

## Running the matrix

From the repository root, after installing the existing client dependencies:

```sh
NODE_PATH=client/node_modules node tests/browser-proxy-compatibility.cjs
```

The default is Chromium, both HTML/SVG shells and all nine local classes. The script bundles source in memory, starts disposable loopback servers, uses fresh browser contexts per row, and writes `/tmp/eya-proxy-compatibility.json`. It does not require a running Eya server, modify browser profiles, restart user sessions or generate production client artifacts. Chromium must support its normal sandbox; the harness never adds `--no-sandbox`.

| Environment variable | Meaning |
| --- | --- |
| `EYA_PROXY_MATRIX_REPORT` | Destination JSON path |
| `EYA_PROXY_MATRIX_ENGINES` | Comma-separated `chromium,firefox,webkit`; missing executables become explicit skips |
| `EYA_PROXY_MATRIX_FORMATS` | `html`, `svg` or both |
| `EYA_PROXY_MATRIX_CASES` | Comma-separated corpus case IDs for a focused run |
| `EYA_PROXY_MATRIX_COARSE=1` | Touch/coarse-pointer emulation; Firefox lacks Playwright's mobile-layout emulation |
| `EYA_PROXY_MATRIX_NAVIGATION=absent` | Hide the Navigation API in proxy contexts and verify reader mode |
| `EYA_BROWSER_EXECUTABLE` | Override Chromium executable; preserve its sandbox |
| `EYA_PROXY_PUBLIC_SITES` | Explicit JSON list of public-site objects, described below |

The script exits unsuccessfully if all selected engines are unavailable, an essential Chromium fixture breaks, or a local proxy fixture attempts direct networking. Unsupported nested frames are an expected result. Other engine/media outcomes remain visible for characterization rather than being silently counted as passing compatibility. Timing is recorded, not used as a brittle CI threshold.

Examples:

```sh
NODE_PATH=client/node_modules EYA_PROXY_MATRIX_ENGINES=chromium,firefox,webkit node tests/browser-proxy-compatibility.cjs
NODE_PATH=client/node_modules EYA_PROXY_MATRIX_COARSE=1 node tests/browser-proxy-compatibility.cjs
NODE_PATH=client/node_modules EYA_PROXY_MATRIX_NAVIGATION=absent EYA_PROXY_MATRIX_CASES=documentation,module-spa node tests/browser-proxy-compatibility.cjs
```

## Opt-in public-site matrix

Supply at most twelve credential-free HTTPS URLs without query strings/fragments. Each site may list up to fifteen additional HTTPS origins required for assets. Only listed origins are permitted; redirects are recorded but are not automatically followed by the fixture broker. This intentional limitation makes redirect-dependent sites a visible harness limitation rather than silently broadening the network allowlist.

```sh
NODE_PATH=client/node_modules \
EYA_PROXY_PUBLIC_SITES='[{"url":"https://example.com/","allowedOrigins":[]}]' \
EYA_PROXY_MATRIX_REPORT=/tmp/public-proxy-matrix.json \
node tests/browser-proxy-compatibility.cjs
```

Public runs perform passive, unauthenticated browsing. They do not click forms, submit credentials, complete consent dialogs or replay an operation through another mode. Broker mutation requests and page WebSockets are blocked; native-reference mutation requests are blocked too. A public result is labeled `content-only`, not `usable`: seeing text does not establish that login, a framework, media or a site's main workflow works. Public content time uses readable-body polling after successful proxy load, which differs from the instrumented fixture marker. Do not compare those time columns as identical measurements.

External sites change and may require consent, cookies, authentication, third-party origins or unavailable APIs. Keep them out of mandatory hermetic CI. Review diagnostic output before publishing a report; even without query strings or credentials, public site console messages can contain site-specific data.

## Remaining characterization

Run Firefox/WebKit with installed binaries, physical touch clients, real Eya HTML/SVG artifacts and server Chromium end to end, representative authenticated sites using disposable accounts, redirects, workers/import maps, large media and changing pages. Add source hashes and separate outcomes for unsupported APIs and harness restrictions. Extend the local corpus before widening supported features, and keep existing transport, Local HTML, CORS, storage, cancellation and resource-budget suites as separate regression gates. The [proxy roadmap](browser-proxy-roadmap.md) remains the product/security inventory.
