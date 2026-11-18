# Proxy browser documentation workflows

Eya 2.6.0 targets ordinary documentation browsing from a URL in the Proxy browser address bar. The acceptance set covers React, Swift, PixiJS, Rust, Python and MDN. The suite compares the built client and authenticated server proxy with fresh native Chromium controls. It checks that an article survives script startup, then exercises typography, text selection, chapter navigation, Back and site search. Search checks require query-specific results and open a result article where the site provides one. Swift uses the DocC navigator filter.

The previous assessment found zero complete proxy workflows. It remains the baseline for comparing failure causes and outcomes. [Eya 2.5.1 assessment](browser-proxy-public-sites.md)

## Live results

All six native controls and all six HTML proxy workflows passed the strict gate on November 17, 2026. The test entered each URL in the actual address box. Every HTML proxy row completed through the encrypted browser channel without a channel closure or a direct request reaching the browser test's network blocker.

| Site | Chapter opened | Search or filter checked |
| --- | --- | --- |
| React | Thinking in React | Opened the `useState` reference from search |
| Swift | A Swift Tour | Found Functions with the DocC navigator filter |
| PixiJS | Quick Start | Opened Sprite from the local search results |
| Rust | Installation | Opened the ownership chapter at its matching heading |
| Python | Using the Python Interpreter | Opened the module API result from Sphinx search |
| MDN | Introduction | Opened Closures from the search suggestions |

React, Swift and PixiJS also passed in the generated SVG client on recheck. The first SVG run reached the PixiJS article and returned with Back, but the Search click landed before the dialog was ready. The recheck allows one additional click if the dialog stays closed. PixiJS opened it on the first click in that run. Both SVG runs are preserved. [Results and source hashes](browser-proxy-26-results.json)

React and MDN still report hydration errors during the tests. React's analytics calls and Swift's `defaultView` access can also report errors. The measured reading, navigation and search workflows recover. The report includes these diagnostics and CSP-rejected resource attempts.

## Compatibility changes

- The server decodes gzip and zlib-deflate before sending the existing response frames. Encoded and decoded bytes have separate limits. The decoder propagates cancellation and backpressure, rejects corrupt responses and avoids reusing compressed range or validator metadata for decoded bodies.
- Initial classic scripts and stylesheets are fetched before mounting the document. This lets the iframe's parser preserve classic, deferred and inline script order. The runtime intercepts common dynamic resource assignments and loads them through the same proxy, including resources inside shadow roots.
- CSS rewriting follows tokens so escaped quotes, inline SVG, URL fragments and import qualifiers survive. Virtual URL reads give routers and search code the upstream URL. Native origin and storage privileges still come from the opaque iframe.
- Page modules load through bounded, same-origin graphs. Local import maps support cycles and shared module identity. The loader supports computed page imports and keeps their dependencies available until page disposal. Worker graphs retain separate bounds. The classic worker loader can preload a recognized Webpack or Rspack startup chunk from constant filenames and literal chunk IDs. Dedicated workers use the virtual upstream URL when resolving requests.

Section links scroll within the current document and participate in virtual Back and Forward history.

The proxy retains `sandbox="allow-scripts"` and its resource CSP. Separate browsing contexts, embedded runnable examples, native upstream storage and origin-dependent authentication remain outside the verified workflows. [Proxy roadmap](browser-proxy-roadmap.md)

## Regression checks

The full Rust suite passed 114 tests, with one opt-in benchmark ignored. The deterministic browser corpus recorded 25 usable rows and two expected unsupported embedded-frame cases. Focused tests covered decoded response bounds, CSS token fidelity, classic script order and errors, fragment history, cyclic modules, worker startup and opaque sandbox isolation. Workspace, wire compatibility, update, terminal reconnect and generated artifact checks passed. Debug and release binaries were built.

## Reproduce

Build the standalone client and server, then run the opt-in public matrix.

```sh
node client/build.mjs
CARGO_BUILD_JOBS=2 cargo build --locked --manifest-path eya-server/Cargo.toml
EYA_PROXY_PUBLIC=1 EYA_PROXY_PUBLIC_REQUIRE_USABLE=1 bash scripts/run-browser-test.sh node tests/browser-proxy-public.cjs
EYA_PROXY_PUBLIC=1 EYA_PROXY_PUBLIC_REQUIRE_USABLE=1 EYA_PROXY_PUBLIC_CASES=react,swift,pixijs EYA_PROXY_PUBLIC_MODES=proxy EYA_PROXY_PUBLIC_FORMAT=svg bash scripts/run-browser-test.sh node tests/browser-proxy-public.cjs
```

The public harness blocks direct HTTP requests that reach Playwright routing and records attempts rejected earlier by CSP separately. It uses a disposable Eya server and actual Noise connections. Public site updates can change the results, so the strict gate is opt-in. [Public test harness](../tests/browser-proxy-public.cjs)

## Eya 2.7 client formats

The deterministic test passed generated HTML, SVG, compressed HTML/SVG and data URL, plus hosted HTML and SVG in Chromium, Firefox 157 and WebKit 27.2. Each of the 21 rows verifies password authentication, styled reading, selection, script-based search, chapter navigation, Back, and a fresh request on an automatically recovered channel. The open page survives the relay drop. The data URL remains opaque and uses a test-only transport relay to reach the disposable Rust server. A separate native-policy test verifies the hosted fallback when Chromium blocks loopback from a data URL.

Reader mode keeps styled content, section links, chapter navigation, Back, Find and GET forms on clients without the Navigation API. It keeps the opaque sandbox and uses a nonce-only script policy for the trusted bootstrap.

The 2.7.1 public sample used Chromium 156 and ran each row in its own memory-capped scope. Every row below passed styled reading, selection, chapter navigation, Back, and site search or filtering. No direct client HTTP requests reached the test interceptor. The data URL row relayed its encrypted WebSocket only for the disposable loopback server.

| Client format | Live site | Scope peak |
| --- | --- | ---: |
| Generated HTML | React | 1,169 MiB |
| Generated SVG | PixiJS | 2,128 MiB |
| Compressed HTML | Swift | 439 MiB |
| Compressed SVG | Swift | 441 MiB |
| Data URL | PixiJS | 661 MiB |
| Hosted HTML | Swift | 537 MiB |
| Hosted SVG | PixiJS | 605 MiB |

The table samples each format across the named sites. React in generated SVG rendered and navigated in three other attempts. The search control timed out once, opening a search result timed out once, and the search input failed to appear after a click in the final recheck. React continued to report hydration errors. The final recheck peaked at 2.09 GiB with no OOM events.

```sh
bash scripts/run-browser-test.sh node tests/browser-proxy-artifacts.cjs
EYA_PROXY_ARTIFACT_ENGINE=firefox bash scripts/run-browser-test.sh node tests/browser-proxy-artifacts.cjs
EYA_PROXY_ARTIFACT_ENGINE=webkit bash scripts/run-browser-test.sh node tests/browser-proxy-artifacts.cjs
bash scripts/run-browser-test.sh node tests/browser-proxy-reader.cjs
EYA_PROXY_PUBLIC=1 EYA_PROXY_PUBLIC_REQUIRE_USABLE=1 EYA_PROXY_PUBLIC_CASES=react,swift,pixijs EYA_PROXY_PUBLIC_MODES=proxy EYA_PROXY_PUBLIC_FORMATS=all bash scripts/run-browser-test.sh node tests/browser-proxy-public.cjs
```

## Shared-host testing

A shared host rebooted during an earlier parallel browser matrix. The previous boot journal was unavailable, so the cause could not be verified. The public harness reuses one browser process for native and proxy rows, closes the context after each row, and writes intermediate results as it goes. The deterministic proxy suite and four follow-up browser checks peaked at 779 MiB with no OOM events. A stalled live React SVG row reached 2.1 GiB under the memory cap and was stopped. Use separate bounded invocations for problematic live rows. Screenshots and full DevTools extraction are opt-in via `EYA_PROXY_PUBLIC_CAPTURES` and `EYA_PROXY_PUBLIC_DEVTOOLS=1`. [Test resource limits](../tests/AGENTS.md#shared-host-resource-limits)
