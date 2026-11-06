# Client artifacts and size checks

The client remains self-contained and works offline after download. No features or languages were removed. The build uses esbuild plus a conservative Terser pass, and exposes only the pinned sodium primitives used by Noise rather than bundling the forwarding module's unrelated algorithms. `tests/crypto-bundle.cjs` compares seeded keys, X25519, BLAKE2b, AEAD boundary cases, and tamper rejection against the full pinned provider.

Generated SVGs use one SVG2 script reference per program. The previous generator repeated each complete base64 program in both `href` and `xlink:href`. Inline CDATA was evaluated and rejected because it did not execute consistently in Chromium. Compressed HTML/SVG use gzip and require browser `DecompressionStream` support; ordinary HTML/SVG remain available. Fonts and configuration add to the sizes below.

These measurements compare the previous esbuild-only pipeline with the optimized pipeline using **identical current features and CSS**, without a custom font or embedded configuration:

| Artifact | Previous bytes | Current bytes | Reduction |
| --- | ---: | ---: | ---: |
| Standalone HTML | 1,905,462 | 1,814,877 | 4.8% |
| HTML, gzip level 9 | 556,917 | 515,986 | 7.3% |
| HTML, Brotli quality 11 | 455,695 | 420,552 | 7.7% |
| Standalone SVG | 4,998,708 | 2,403,975 | 51.9% |
| Compressed HTML | 739,314 | 710,822 | 3.9% |
| Compressed SVG | — | 712,350 | New format |
| HTML data URL | 786,683 | 710,983 | 9.6% |

Reproduce from the repository root after `node client/build.mjs`:

```sh
node client/size-report.mjs --json /tmp/eya-size-report.json
```

Set `EYA_BROWSER_EXECUTABLE` if Chromium is not managed by Playwright. The report builds both variants in memory and exercises the generator's actual format helpers. It does not rewrite `client.html`. `tests/generator-compression.cjs` opens each format, connects through Noise, edits newlines in CodeMirror, and verifies saved bytes.

Generator sources are `client/generator.template.html` and `client/generator.js`; the build writes the embedded `client/generator.html`. Edit the sources, then rebuild the server as well as the client.
