# Proxy browser: real documentation-site viability

This is the Eya 2.5.1 baseline. The follow-up covers Eya 2.6 changes and the expanded workflow tests. [Eya 2.6 documentation workflows](browser-proxy-26-sites.md)

Tested 2026-11-17 with Eya **2.5.1**, using the generated standalone client, its actual Noise connection and the Rust HTTP proxy. These are live-site results, separate from the small deterministic [compatibility corpus](browser-proxy-compatibility.md). Machine-readable observations and source/binary hashes are in [browser-proxy-public-results.json](browser-proxy-public-results.json).

The proxy is **not yet a dependable replacement for Browser for documentation work**. Static article reading and links work on several sites, but search is a consistent gap. React loses its article during hydration; Swift cannot load its entry document. The existing opaque iframe sandbox remains exactly `allow-scripts` throughout.

## Site results

| Documentation site | Reading and presentation through the proxy | Document links / Back | Site search | Assessment |
| --- | --- | --- | --- | --- |
| [React Quick Start](https://react.dev/learn) | Initial HTML appears, then the article disappears after a Next.js chunk error | Not rated once content disappears | Not rated once content disappears | Unusable for this workflow |
| [Swift programming-language book](https://docs.swift.org/latest/documentation/the-swift-programming-language/) | Entry request fails: unsupported content encoding | Blocked by entry failure | Blocked by entry failure | Unusable |
| [PixiJS introduction](https://pixijs.com/8.x/guides/getting-started/intro) | Text and images available; normal layout/font fail despite a downloaded stylesheet | Quick Start and Back work | Search does not become editable; lazy chunk fails | Partial reader, poor presentation |
| [Rust book](https://doc.rust-lang.org/book/) | Styled, readable article; text can be selected | Installation and Back work | Search index fails to load; no results | Useful reader; search and some JS helpers incomplete |
| [Python tutorial](https://docs.python.org/3/tutorial/) | Styled, readable article; text can be selected | Interpreter chapter and Back work | GET reaches the search page, but no result list appears | Useful reader; search incomplete |
| [MDN JavaScript Guide](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide) | Styled, readable article; text can be selected | Introduction and Back work | Search UI fails to expose an editable input | Useful reader; search incomplete |

The final matrix contains **15 rows: six usable native controls, five partial proxy rows and four unreadable proxy rows**. None of the nine proxy rows completes the full workflow. No proxy-channel closure occurred during these final rows. The test network blocker handled zero direct HTTP requests; **CSP rejected resource attempts are recorded separately**. This is evidence for these pages, not a general confinement guarantee.

Ordinary Chromium controls exercise the same articles, chapter links, Back, text selection and searches. Swift's control is its DocC **navigator filter**, not a claim of full-text search. MDN's control follows the search suggestion to the Closures article with Enter. The native controls work; the limitations above should not be inferred merely from the presence of HTML or a search button.

React, Swift and PixiJS are also exercised through a generated SVG standalone client. Results are characterized separately in the raw report. No account, sign-in, authentication flow, editor, upload, payment or interactive embedded React example is rated here. Removed nested iframes remain unsupported.

## How the test works

`tests/browser-proxy-public.cjs` starts a disposable server using `continuity-fixture.cjs`, opens the built HTML/SVG artifact, authenticates normally and creates the actual `proxy-browser` panel through `EyaPanels`. It uses no Node resource broker and no replacement Fetch/XHR implementation. Browser page scripts and resources use the production proxy mechanisms. The native reference uses fresh ordinary Chromium contexts on the same host.

Each row has a fresh browser context/panel. Viewport is 1440 × 1000; the proxy's toolbar occupies part of that viewport, so these are functional comparisons, not matched-layout screenshot benchmarks. The test waits up to 40 seconds for the article heading, allows initial script execution, checks that article content survives, and tests actual mouse drag selection in prose. Offscreen accessibility navigation text is excluded from selection targets. Each search must produce results or its specified document destination; opening a modal is insufficient.

Presentation checks require a loaded stylesheet **and the expected computed body font**, using the current native control where available. A nonzero stylesheet count alone produced a false positive on PixiJS. Screenshots supplement these checks; neither computed fonts nor screenshots establish pixel equivalence, complete CSS support or accessibility conformance.

Diagnostics include bounded browser errors, the panel's own Console and Network output, per-step outcomes, retained text/headings, computed fonts, image counts, connection closures, actual encrypted browser-channel payload bytes, and source/binary hashes. Data-script contents are omitted from exception URLs. Timing includes fixture startup, deliberate waits and Playwright polling; byte totals include Noise messages and multiple interactions. Neither is a latency or compression benchmark.

The harness aborts any direct client HTTP request that reaches its Playwright routing handler. It records these separately from `requestfailed` events rejected by the iframe's CSP. For example, React chunk failures and Rust's search-index failure report `csp`; they do **not** establish that a direct network request escaped. Covered requests may never reach the routing handler. The test does not enable direct-network fallback to make a site pass, and finite coverage does not establish confinement for arbitrary pages. The product's experimental network disclosure remains warranted.

## Defect fixed while testing

The original real-site runs repeatedly disconnected the shared proxy channel while loading resources. The server removes a response's credit sender after the final marker. A client consuming the preceding nonfinal body chunk can return its credit after that removal, or after the Fetch task drops its receiver. Previously either ordering closed the entire Noise session, interrupting unrelated CSS/script/image requests. Subsequent independent GETs could open fresh channels, producing a reconnect storm without replaying interrupted operations.

In 2.5.1, correctly framed, bounded credit for a completed/cancelled response or a closed receiver is ignored. Credit for a live response still enters its existing bounded queue. ID zero, zero/oversized credit, malformed framing and a full live queue remain rejected. The existing opcodes, payload meanings, limits, authentication, egress validation and mutation-replay behavior are preserved.

Two Rust regressions exercise both completion orderings, survival of an unrelated credited response, absence of response replay, and retained queue/byte bounds. Real-site reruns then distinguish the remaining page/runtime failures from connection loss. Rebuilds are complete; no production Eya server was restarted for this assessment.

## Remaining causes and next work

1. **Bounded upstream decompression.** Swift's current canonical book URL returns HTTP 200 with `Content-Encoding: gzip` even when sent the proxy's exact user agent and `Accept-Encoding: identity`. A separate curl probe captured a 1,713-byte gzip body with magic `1f8b`. The proxy currently rejects non-identity bodies intentionally. Add a streamed decoder with explicit encoded and decoded limits, cancellation/backpressure, malformed/truncated/bomb tests, and correct cache/header/range behavior. Increasing limits or handing compressed HTML to the renderer would not solve this.
2. **Dynamic classic script loading.** React's Next.js chunks, PixiJS's Docusaurus lazy chunk and Rust's dynamically inserted search-index script fail under the current CSP/resource rewriting. CSP rejection is observed; the exact insertion/rewrite race needs a small deterministic regression before implementation. Resource interception must happen before the native loader acts and preserve dependency order, load/error completion, cancellation and integrity behavior. Keep CSP and the opaque sandbox intact.
3. **Real URL assumptions.** Python's Sphinx scripts throw `Failed to construct 'URL': Invalid URL` from rewritten data-script execution. The GET form relay itself reaches `search.html?q=functions`, and the proxy fetches `searchindex.js`, but the results never populate. Isolate `location`, base URL and `document.currentScript.src` assumptions in local fixtures; do not infer a missing index from an empty result list.
4. **CSS token fidelity.** PixiJS's stylesheet is present but the body retains Times New Roman instead of native Roboto and loses the intended layout. Network diagnostics include bogus stylesheet-relative URLs derived from quoted/escaped inline SVG `data:` values. That is evidence of CSS rewriting problems, not an upstream asset outage. Add escaped strings, quoted parentheses, data URLs, comments and layers to the deterministic corpus before changing the tokenizer/rewriter.
5. **Modern component/worker runtime.** MDN uses shadow-DOM controls, and proxy Console reports unsupported dynamic imports in worker modules. The native Search control reaches the Closures article; the proxy's modal cannot provide an editable field. Test shadow-root resource handling and the worker graph independently before attributing the entire failure to either mechanism.
6. **Preserve readable content on application failure.** React's transient server-rendered article must not be counted as successful reading. A deliberate scripts-off reader mode could preserve useful content, but should be a separate explicit mode with its own tests. Do not automatically reload, change execution modes, widen sandbox permissions or replay page operations after a runtime failure.

Use server Chromium for React, Swift, embedded examples and documentation search until these gaps are addressed. The [proxy roadmap](browser-proxy-roadmap.md) retains the broader architecture and API inventory.

## Validation

The patch passed Cargo formatting, check and the full Rust suite (**110 passed, one unrelated opt-in compression benchmark ignored**). The new response-credit regressions and existing credit/backpressure test pass. The deterministic compatibility matrix completes 27 rows: 25 usable and two expected unsupported nested-frame cases. Browser transport, proxy continuity/API/sandbox/workspace, wire compatibility, updater, terminal reconnect and HTML/SVG/compressed generator checks also pass. Generator data-URL cases explicitly check the recoverable local-network-policy error where Chromium blocks loopback WebSockets.

Public outcomes remain limitations, not passing compatibility claims. Native controls and harness execution are checked independently of those outcomes.

## Reproduction

Build the current client and server, then opt in to public requests:

```sh
node client/build.mjs
CARGO_BUILD_JOBS=2 cargo build --locked --manifest-path eya-server/Cargo.toml
NODE_PATH=client/node_modules EYA_PROXY_PUBLIC=1 node tests/browser-proxy-public.cjs
```

Options:

| Variable | Default / purpose |
| --- | --- |
| `EYA_PROXY_PUBLIC=1` | Required explicit opt-in; otherwise exits before starting fixtures |
| `EYA_PROXY_PUBLIC_CASES` | `react,swift,pixijs,rust,python,mdn`; select a comma-separated subset |
| `EYA_PROXY_PUBLIC_MODES` | `native,proxy`; native is ordinary Chromium, proxy uses actual Eya |
| `EYA_PROXY_PUBLIC_FORMAT` | `html`; `svg` selects the generated SVG artifact for proxy rows |
| `EYA_PROXY_PUBLIC_REPORT` | `/tmp/eya-proxy-public.json` |
| `EYA_PROXY_PUBLIC_CAPTURES` | `/tmp/eya-proxy-public-captures` |
| `EYA_PROXY_PUBLIC_BINARY` | `eya-server/target/debug/eya-server` |
| `EYA_BROWSER_EXECUTABLE` | Optional installed sandbox-capable Chromium path |

The test writes its report incrementally and preserves characterized site failures as data. Harness errors fail the command. Public failures are not mandatory CI regressions; site structure, browser versions and upstream behavior change. No Firefox, WebKit, physical phone, authenticated website or real WAN claim is made. Screenshots are local artifacts under the configured captures directory.
