# Chromium streaming improvements (2.5)

The [candidate experiments](browser-compression-experiments.md) and [optimized Rust encoder measurements](browser-compression-rust-results.json) support a negotiated **Efficient lossless** mode for text, caret, typing and selection updates. Existing JPEG80 remains the default: PNG capture is more expensive and full-motion textured content still compresses better with JPEG. Site execution remains in Chromium; page scripts, canvas, cross-origin frames and input routing use the existing renderer and egress boundaries.

## Implemented behavior

Browser options → Stream encoding → **Efficient lossless** selects PNG capture and `tiles-rgba-v1` after support is confirmed. The initial request uses JPEG, so older servers and clients without a canvas decoder retain the deployed baseline. JPEG and independent PNG remain explicit choices. Settings and the generator use the same encoding choices.

The server decodes bounded 8-bit screencast PNGs into canonical RGBA and scans 64×64 tiles with exact equality. It omits unchanged tiles and chooses the smaller raw-DEFLATE replacement or XOR residual for each changed tile. XOR applies to pixels, never JPEG/PNG compressed bytes. The first tile update establishes an exact, independent canonical reference. References are committed only after the client successfully presents that sequence; an ordinary image ACK cannot commit one.

When more than 60% of pixels belong to changed tiles, the encoder takes an early PNG fallback before compression. It also stops when tile output reaches the original PNG's size. This bounds wasted work on scrolling and avoids carrying old image noise through an XOR residual. Full PNG fallbacks leave the canonical reference intact on both peers. If the screen returns exactly to it, an empty delta explicitly presents that saved surface again. Ordinary unchanged frames are omitted only when that reference is already displayed.

A scene that remains different from the old reference must eventually establish a new one. After three PNG fallbacks, the next capture can rebase once at least two seconds have elapsed since the prior canonical keyframe. Navigation/load and tab changes also request fresh references. This trades occasional larger keyframes for avoiding permanent full-PNG transmission after a scroll. No extra full-size fallback reference is retained.

The client validates all metadata and tile records, reconstructs an entire update off-screen and swaps a completed canvas atomically. Failed decoding retains the displayed surface and requests reference reset. Large keyframes yield between bounded tile batches so input, tab changes and cancellation can run. A shared synchronous DEFLATE core uses fixed output buffers and exact input/output accounting; terminal callers retain their original 8KiB contract. Browser tiles do not depend on native `DecompressionStream`, WebCodecs, external assets or a new decoder download.

## Freshness and input scheduling

Activating a retained Chromium tab now explicitly brings its target to the foreground. Restarting screencast alone could send one image of a hidden target and then stop producing repaints. The live regression verifies visibility and continuing updates after switching away and back.

The server reads the launched Chromium's private, bounded `/json/protocol` schema and enables `sendLastFrame` only when advertised. Chromium then retains the latest produced frame while awaiting ACK rather than losing the final change. With older implementations, Eya retains at most one extra emitted screencast event; replacing it releases the old event's CDP credit. Input received while a frame is outstanding schedules a bounded screencast refresh after ACK when native latest-frame retention is unavailable.

One writer owns encrypted socket output. The main session queues display chunks incrementally through a two-message writer queue and accepts input between chunks, rather than awaiting the whole frame's send loop. Queue reservation happens before Noise encryption, including when optional debugger diagnostics are dropped, so discarded messages never consume cipher nonces. A partly transmitted frame is completed in sequence; a tab/setting change cannot interleave another frame's metadata with its chunks. Control messages can appear between chunks.

Each socket write has a five-second deadline. A display frame has a 30-second enqueue deadline. Fifteen seconds after the last chunk is queued without a matching ACK, the server resets its reference, releases CDP credit and refreshes capture. The ACK timeout includes any remaining writer/kernel buffering; it is not a timer starting at physical presentation. Three consecutive rejected or timed-out tile updates suspend tile encoding in favor of independent PNG. A new resize/settings request permits another attempt. Detach/takeover resets all encoding negotiation and references; partial transfers are never replayed. Explicit shutdown terminates Chromium and removes its private profile before waiting for final socket output. A bounded root `Browser.close` lets child/profile writers exit cleanly, with a kill/reap fallback and bounded filesystem cleanup retries; a slow peer cannot prolong the renderer's lifetime.

These changes improve scheduling without changing TCP's ordered delivery. Kernel send buffers, PNG capture, page work, a single presentation credit, and some existing synchronous control operations can still add latency. This does not implement adaptive bitrate, scroll-copy, H.264/AV1, WebRTC, UDP or a worker-based decoder.

## Protocol and resource bounds

All baseline Noise prologues, tags 130/131, image ACK opcode 5, JPEG defaults and permanent update-v1 remain unchanged. Optional resize fields are additive; release numbers do not prove support.

- Resize opcode 3 offers `tiles-rgba-v1` alongside `stream-settings-v1`. Only offered capabilities are selected in the existing `stream-settings` status. `stream.tiles` defaults to false. Tile output requires that selection, `tiles:true`, and PNG capture. Unknown offers/fields do not activate it.
- New opcode **147** carries JSON metadata: `seq`, `tabId`, logical `width/height`, `bytes`, `chunks`, `format:"rgba-tiles-v1"`, captured `pixelWidth/pixelHeight`, `base` and `tiles`. `base:0` is an independent keyframe; otherwise it identifies the successfully presented canonical tile sequence, even if independent PNGs were displayed afterward.
- New opcode **148** carries `sequence:u32BE`, `chunkIndex:u16BE` and up to 48KiB of payload, following the existing leading opcode. Chunks are consecutive and exact; encoded updates are at most 16MiB.
- New client opcode **39** is exactly six plaintext bytes: opcode, `sequence:u32BE`, and `presented:u8` (1 success, 0 reset). Wrong sequences, malformed statuses and baseline ACKs cannot advance tile references. The server never sends tile opcodes to an unnegotiated client.

The assembled payload starts with ASCII `EYT1`, `edge:u16BE` and `count:u16BE`. Each record has `tileIndex:u16BE`, `mode:u8` (0 replacement, 1 XOR), `compressedBytes:u32BE`, and an independent [raw-DEFLATE block](https://www.rfc-editor.org/rfc/rfc1951). Indices are row-major; clipped edge geometry determines the exact RGBA decoded length. The server emits 64px edges; the decoder also accepts 128px under the same format. Duplicate indices, invalid modes, unexpected dimensions, base mismatches, truncated/extra payload, overexpansion and trailing compressed bytes fail the update. Keyframes cover every tile with replacements. A zero-record update is permitted only with a nonzero base.

Captured dimensions are at most 8192 per axis, at most **4,194,304 pixels**, and at most 1024 tiles. Larger captures retain independent PNG without allocating canonical pixels. A canonical surface is at most 16MiB RGBA; preparation/presentation can hold a reference and a staged surface, plus the bounded encoded image/payload and old/new canvas surfaces. Server PNG decoder working memory is separately capped at 32MiB. Per-tile inflation is at most 64KiB; the client never allocates output based only on an unbounded compressed declaration. PNGs with unsupported precision/animation fall back rather than silently quantizing an allegedly lossless reference.

Lossless means exact relative to decoded screencast PNG pixels. It does not prove equality to compositor internals or preserve details removed by a selected resolution cap. Keep Native resolution when small text matters; 4K captures above the tile pixel bound use full PNG.

## Recorded production comparison

The 1280×720 fixture combines multilingual text and a deterministic textured image. Each input changes a small text line and a color marker. These are twelve sequential inputs per row; p95 below is the observed maximum. The server uses an optimized build on Linux arm64.

| Connection | Encoding | Mean update bytes | Median input → canvas | Observed p95 |
| --- | --- | ---: | ---: | ---: |
| loopback | jpeg | 282,242 | 122 ms | 165 ms |
| loopback | png | 665,524 | 123 ms | 199 ms |
| loopback | tiles | 225 | 91 ms | 115 ms |
| 5mbit-50ms | jpeg | 282,242 | 599 ms | 622 ms |
| 5mbit-50ms | png | 665,524 | 1238 ms | 1300 ms |
| 5mbit-50ms | tiles | 225 | 163 ms | 188 ms |

The efficient mode's canonical bootstrap for this fixture is 626,222 bytes. The table measures subsequent updates. On the shaped connection it reduced observed p95 from about 622 ms for JPEG and 1300 ms for PNG to about 188 ms, while keeping the PNG pixel fidelity. This is a controlled synthetic result, not a guarantee for every site or network. Loopback measurements vary across runs; twelve short samples do not establish a universal latency improvement over JPEG, and PNG capture/processing still costs time. The separate moving-image and keyframe measurements explain why JPEG remains the default.

## Reproducing validation

Build generated artifacts before either server profile:

```sh
node client/build.mjs
cargo build --locked --manifest-path eya-server/Cargo.toml
cargo build --release --locked --manifest-path eya-server/Cargo.toml
NODE_PATH=client/node_modules node tests/browser-tiles.cjs
NODE_PATH=client/node_modules node tests/browser-tiles-transport.cjs
NODE_PATH=client/node_modules node tests/browser-tiles-panel.cjs
NODE_PATH=client/node_modules node tests/browser-tiles-live.cjs
```

Capture candidate fixtures and reproduce the optimized production encoder measurements:

```sh
NODE_PATH=client/node_modules \
EYA_CANDIDATE_CAPTURE_DIR=/tmp/eya-browser-captures \
node tests/browser-compression-candidates.cjs /tmp/eya-candidates.json
EYA_TILE_BENCH_DIR=/tmp/eya-browser-captures \
EYA_TILE_BENCH_REPORT=/tmp/eya-rust-tiles.json \
cargo test --release --locked --manifest-path eya-server/Cargo.toml \
  production_tile_measurements -- --ignored --nocapture
```

The candidate suite verifies 150 exact Node/browser reconstructions. The production Rust measurement verifies 40 keyframe/delta round trips. Live recovery tests cover input readback interleaved at chunk 46/148 of a large PNG under downstream backpressure, visible/repainting retained targets, offered-only negotiation, old/unknown capabilities, independent-image fallback, wrong/baseline/missing/rejected ACKs, repeated failure, pending mode changes, resize and retained-target changes. Client tests cover atomic presentation, reference mismatch, decompression bombs, cancellation, stale frames and fallback restoration. Existing input/frame, streaming, terminal decoder/reconnect, update/wire and generator artifact checks remain release gates.

The end-to-end benchmark uses production CDP capture, Rust encoding, Noise transport and client decoder with a canvas presentation harness. It records twelve real key inputs per mode; the reported p95 is the largest of those twelve samples, not a broad population estimate. It measures input dispatch from the harness to canvas commit, not physical input-to-photon or the complete panel's FPS pacing. Its bounded TCP shaper limits downstream bytes and adds nominal propagation delay; it does not emulate WAN packet loss, congestion or mobile CPU. Canonical bootstrap bytes are recorded separately and excluded from steady update latency. No public websites or account data are used.

```sh
NODE_PATH=client/node_modules \
EYA_STREAM_SERVER_BINARY=eya-server/target/release/eya-server \
EYA_STREAM_IMPROVEMENTS_REPORT=/tmp/eya-production-stream.json \
node tests/browser-stream-improvements.cjs
```

See [recorded production measurements](browser-stream-improvements-results.json). Use the reported binary/source hashes and optimized encoder timings when interpreting results; debug builds materially inflate PNG/tile preparation time. Photos, video, high-DPI displays, other browser engines and lossy real networks still need broader profiling before choosing a different default.

## Release checks recorded

Generated clients and both debug/release servers were rebuilt at 2.5.0. Cargo fmt/check/test passed: 108 tests, with the opt-in measurement test excluded from the ordinary run and its 40 reconstruction cases executed separately. The updater, wire compatibility, terminal reconnect/decoder, generator HTML/SVG/compressed artifacts, tile codec/transport/panel/live recovery, existing remote input/frame/transport, old-peer stream compatibility, JPEG/PNG streaming and real Chromium continuity/cleanup checks passed. Candidate and final production report hashes were verified against their measured sources/binary. Firefox/WebKit and real lossy WAN tests were not run.
