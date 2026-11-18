# Chromium streaming compression experiments

Measured on 2026-11-17 UTC (2026-11-16 local). This experiment extends the [compression analysis](browser-compression-roadmap.md) from screenshot-derived pixels to actual CDP screencast frames. The [raw results](browser-compression-candidates-results.json) include every sample, source SHA-256, browser/runtime versions, exact-reconstruction checks and timings.

## Decision

Use **64px lossless changed tiles with replacement or XOR chosen per tile**, negotiated separately from image frames. Keep independent PNG as the lossless fallback and JPEG as the existing default. Offer the tile path through an efficient lossless mode first. Native-resolution text remains exact relative to the captured PNG; a low-resolution JPEG preset remains useful when bandwidth matters more than fine text.

The measurements support sparse updates strongly. They do not support replacing JPEG with this tile path for every workload: its canonical keyframe is larger, PNG capture/decode adds work, and a changing textured image still needs more than twice the bytes of JPEG80. Scrolling must fall back before spending an entire frame's encode budget on poor deltas. A changed-area prepass and an encoded-size cutoff are useful bounds; their production implementation is validated separately from this candidate experiment.

## Method

Run from the repository root:

```sh
NODE_PATH=client/node_modules \
node tests/browser-compression-candidates.cjs docs/browser-compression-candidates-results.json
```

`EYA_CANDIDATE_CAPTURE_DIR=/tmp/eya-browser-captures` also writes the first PNG reference/current pair for each scene plus metadata, for the [production Rust benchmark](browser-streaming-improvements.md#reproducing-validation).

`EYA_BROWSER_EXECUTABLE` selects Chromium; `EYA_CANDIDATE_SAMPLES` bounds samples per scene to 1–10 (default 3). The test launches a separate software-rendered Chromium, filters `EYA_KEY` out of its environment, and uses a local synthetic page. No public site or account is needed.

The 1280×720 page contains dense document rows, colored 12px/14px text, an 18px editing line, multilingual characters and a seeded 460×260 textured canvas. Each case resets the page and scroll position, obtains a CDP PNG reference, applies one change, and obtains PNG and JPEG80 captures of the resulting state. Separate cases cover unchanged pixels, caret removal, typing, selection, 32px/256px scroll, a simplified image and one textured animation step. The animation case is one image change, not a continuous video throughput test.

Each pair is compared at 64px and 128px tile sizes using replacement-only, XOR-only, and the smaller of the two compressed representations. Node uses raw DEFLATE level 1. The browser uses pinned fflate 0.8.3 for this experiment; that is a candidate decoder, not a claim about the production bounded decoder's speed or validation. Every candidate reconstructs the exact captured PNG RGBA in Node and again in Chromium; SHA-256 checks the browser reconstruction. Six separately measured canonical keyframes also round-trip exactly. Total: **150 exact Node/browser reconstruction pairs** across 24 scene samples.

Tile payload counts use the proposed EYT1 eight-byte header and seven-byte tile records. Estimated encrypted bytes additionally count the JSON frame metadata, 16-byte Noise authentication per message, and seven-byte chunk prefix per 48KiB chunk. WebSocket/TCP/IP overhead and ACK traffic are excluded. Unchanged updates are omitted in the ideal steady-reference comparison; after an independent PNG was displayed, production may need an empty tile update to restore the retained canonical reference.

## Payload results

Mean bytes per update, three samples. Tile values are before the full-PNG fallback:

| Change | JPEG80 | PNG | 64px adaptive tiles | 128px adaptive tiles | Lossless selection |
| --- | ---: | ---: | ---: | ---: | --- |
| unchanged | 159,189 | 426,565 | 0 | 0 | Omit |
| caret | 159,046 | 426,534 | 137 | 372 | Tiles |
| typing | 161,332 | 430,195 | 7,408 | 9,523 | Tiles |
| selection | 159,691 | 426,777 | 8,899 | 8,036 | Tiles |
| scroll-32px | 162,679 | 428,812 | 509,751 | 474,261 | PNG |
| scroll-256px | 152,625 | 337,342 | 389,929 | 348,403 | PNG |
| image-simplification | 114,883 | 129,115 | 13,122 | 19,159 | Tiles |
| image-animation | 159,274 | 426,420 | 377,918 | 378,765 | Tiles |

A caret update needs one XOR tile. The typed sentence chooses eight replacement tiles; selection chooses eight XOR tiles. Simplifying the noisy image chooses replacement for all 40 changed tiles because XOR preserves the old noise. This directly rejects an unconditional XOR strategy.

64px tiles win for the caret, typing and the small image replacement; 128px tiles slightly improve selection and reduce full-frame overhead. The first implementation should favor the sparse interaction cases and use full PNG for broad changes, rather than committing every update to the larger tile size.

For the textured animation step, adaptive 64px tiles use 377,918 bytes versus 382,887 for replacement-only tiles: about 1.3% less, with roughly twice the Node encode work. Dense changes should not always pay for an exhaustive second compressor. A future encoder can use measured density/entropy heuristics, provided it retains exact reconstruction and tests the tradeoff.

### Keyframes and fallback costs

A canonical keyframe must establish the exact server/client RGBA reference; independently decoded JPEG pixels are unsuitable as that reference. The measured 64px replacement keyframe is **507,639 bytes**, versus 426,565 bytes for full PNG and 159,189 bytes for JPEG80. A 128px keyframe is 473,441 bytes. The initial reference has a real cost and should not be recreated after every ordinary PNG fallback.

At a hypothetical 2Mbit/s, the 64px keyframe payload alone takes about 2,031ms to serialize. A 137-byte caret tile payload takes about 0.55ms, or about 1.32ms after the experiment's estimated Noise/metadata framing. These are arithmetic, not WAN latency measurements. Capture, processing, RTT, browser presentation and retransmission remain additional costs. Sparse updates repay the bootstrap quickly relative to resending PNG, while animation may never repay it relative to JPEG.

## Processing costs

Mean milliseconds for the 64px adaptive candidate. Node time includes changed-tile scan, packing, and encoding both representations. Browser time includes copying the RGBA reference, inflate and apply; canvas commit is measured separately. Node exact-equality assertions and browser SHA-256 verification are outside the reported browser decode/apply timing.

| Change | Node scan + encode | Browser copy + decode + apply | Canvas commit |
| --- | ---: | ---: | ---: |
| unchanged | 2.95 | 1.37 | 1.30 |
| caret | 3.87 | 1.90 | 0.87 |
| typing | 4.19 | 3.30 | 0.87 |
| selection | 4.53 | 3.40 | 0.87 |
| scroll-32px | 53.49 | 55.50 | 0.77 |
| scroll-256px | 54.19 | 55.93 | 0.83 |
| image-simplification | 14.41 | 7.73 | 0.87 |
| image-animation | 22.79 | 13.47 | 0.80 |

The 64px canonical keyframe takes 27.13ms for Node scan/encode and 74.73ms for browser copy/inflate/apply; the 128px keyframe takes 20.90ms and 32.47ms respectively. These measurements explain why keyframe frequency matters. On the scroll cases, the rejected 64px candidate spends about 53–54ms in Node and 55–56ms in browser processing before fallback. A production encoder should detect the broad changed area before doing that work; it should send only the selected representation to the client.

These timings are feasibility measurements on one shared Linux arm64 host, not optimized Rust encoder timings, mobile-device CPU measurements, p95 interaction latency or independent CPU budgets. Runtime scheduling and other development work can affect short timing samples. Payload sizes and exact reconstruction are stronger evidence here than small differences in measured milliseconds. The raw per-sample values remain available to inspect that variability.

An extra DEFLATE pass over JPEG80 reduces bytes by roughly 11–17% in these scenes and takes about 2.4–4.3ms in Node. That is a smaller gain than tiles for sparse changes. It does not restore text detail and would need its own negotiated encoding and bounded decoder if shipped. It is not selected as the first compression improvement.

## Text fidelity

Every lossless candidate reconstructs all captured RGBA bytes exactly, including text, selection and image pixels. The same-state JPEG80 comparison changes colored small-text crops: the unchanged-scene 12px crop has RGB RMSE 7.59 and 55.13% differing RGB channels; the 14px crop has RMSE 8.07 and 66.21% differing channels. The editing-line crop has RMSE 6.50. These measurements confirm that the JPEG and lossless surfaces differ; they do **not** establish that JPEG text is unreadable, measure human reading accuracy, or replace crop inspection and task-level caret-placement testing. Font fallback is whatever this Chromium installation rendered.

The promise is exactness relative to decoded CDP PNG pixels. It does not prove original compositor/subpixel RGB identity across platforms or that downstream display scaling preserves every glyph. Keep capture resolution and logical viewport distinct, avoid repeatedly resampling text, and keep a valid visible frame until an entire update has decoded and passed validation.

## What this experiment does not establish

- It drives actual CDP capture but does not use Eya Noise transport, production Rust PNG decoding, production client decoding, or the panel's decode-before-ACK pacing.
- Capture timing includes screencast stop/start and cannot be interpreted as steady-state FPS. Full-PNG browser decode measurements include canvas readback, which ordinary image display does not require.
- No RTT, bandwidth shaper, packet loss, input-to-presented-pixel latency, stale-frame age, battery cost, hardware codec or sustained video workload is measured here.
- It does not compare H.264/VP9/AV1, scroll-copy, PNG-filtered raw tiles, Zstandard, GPU capture or another transport. Those require their own negotiated capability and reference/recovery design.

Use the production streaming suites and production codec benchmark to validate shipping behavior, bounds, compatibility, ACK failure recovery, resize/tab transitions and input scheduling. See [the streaming measurements](browser-streaming.md) and [compression roadmap](browser-compression-roadmap.md) for those acceptance criteria. Raw DEFLATE follows [RFC 1951](https://www.rfc-editor.org/rfc/rfc1951); screencast capture/ACK behavior belongs to [CDP Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/).
