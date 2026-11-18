# Browser streaming compression: findings and implementation roadmap

Investigation date: 2026-11-16. Scope: the server Chromium browser, with low interaction latency and high useful throughput while preserving site behavior and readable text. The original investigation is retained below as the baseline. Version 2.5 implements negotiated lossless changed tiles with per-tile replacement/XOR selection, PNG fallback, reference recovery, and bounded frame writing. See the [candidate experiments](browser-compression-experiments.md) and [production implementation, protocol and measurements](browser-streaming-improvements.md). Scroll-copy and temporal video codecs remain future work.

## Recommendation

Keep Chromium as the compatibility renderer and retain independent JPEG/PNG as the universal fallback. First improve measurement, frame freshness and input scheduling. Then prototype native-resolution lossless changed rectangles/tiles, comparing replacement tiles against XOR residuals. Add scroll-copy only after reference correctness is established. Evaluate a negotiated low-delay video path for sustained animation separately; require readable text or a lossless refinement layer before making it the default.

XOR was absent in the investigated baseline; it is now an optional per-tile representation in `tiles-rgba-v1`. It can make sparse pixel changes much cheaper, but is only a reversible transform: compression comes from encoding the many zero bytes afterward. XOR of already-compressed JPEG/PNG bytes is generally the wrong foundation. The useful design compares canonical pixels, which creates capture/decode, memory and reference-state costs absent from today's image relay.

The priority order is:

| Stage | Change | Reason | Shipping condition |
| --- | --- | --- | --- |
| 1 | Measure input-to-presentation and queue age; fix capture/ACK freshness | Small compressed frames can still be stale | Lower p95 interaction latency without growing queues or losing final updates |
| 2 | Native-resolution lossless changed tiles with independent replacements | Sparse text/caret/selection updates should not resend the page | Exact reference reconstruction, bounded CPU/memory, lower bytes and end-to-end latency |
| 3 | Per-tile XOR residuals and verified scroll-copy | Further reduce sparse edits and scrolling | Better than replacement tiles after transform/encode/apply cost and recovery are counted |
| 4 | Low-delay video, optionally with text/idle refinement | Full-motion content needs temporal prediction | Capability-probed clients, bounded decoder queue, supported encoder host, acceptable small text |
| 5 | More ambitious capture integration or alternate transport | Avoid redundant image encode/decode or TCP head-of-line delay | Demonstrated benefit sufficient to justify deployment and security complexity |

## Investigated baseline (before 2.5)

The relevant source is [`browser_render.rs`](../eya-server/src/browser_render.rs), [`browser-transport.js`](../client/browser-transport.js) and `handleRemoteFrame` in [`browser-panel.js`](../client/browser-panel.js).

1. Chromium renders the website, including JavaScript, fonts, cross-origin frames, canvas and WebGL. Eya requests `Page.startScreencast` with JPEG or PNG, maximum dimensions, `everyNthFrame:1` and `maxFramesInFlight:1`. JPEG quality defaults to 80. Chromium's screencast method currently documents JPEG/PNG, frame ACKs and optional capture sizing. [CDP Page protocol](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast)
2. The CDP event contains a base64 image. Rust decodes that base64, identifies PNG by signature and otherwise treats the frame as JPEG, checks the selected format and 16 MiB encoded limit, and sends metadata plus 48 KiB image chunks over the independently authenticated Noise WebSocket.
3. The browser transport validates sequence, chunk index, chunk count and total size before delivering a complete encoded image. The client creates a Blob URL, decodes an off-screen `Image`, and replaces the visible image only after successful decoding. Failed decoding keeps the prior image.
4. The client sends the frame ACK after decoding, with an additional delay if needed for the chosen FPS ceiling. The delay is measured from complete frame receipt, so FPS is a ceiling on this stage rather than a guarantee of capture/presentation cadence. Rust then acknowledges the corresponding Chromium screencast frame. New extra CDP frames received while one frame is waiting are acknowledged and discarded.
5. Resize/stream settings are negotiated through `stream-settings-v1`. Missing selection retains the deployed JPEG baseline. Stream selection resets on detach/takeover; existing encoded-frame tags and ACK meanings remain unchanged.

That baseline has no pixel-reference buffer or temporal residual. The current optional tile path adds canonical RGBA references and residuals; scroll-copy, inter-frame video, automatic bitrate control, WebRTC and UDP remain absent. Terminal DEFLATE is a different stream and does not compress browser images. CDP base64 is local-process overhead; Eya already transmits decoded image bytes, so removing base64 does not save a further 25% on the network between server and client.

PNG's filtering and DEFLATE exploit spatial redundancy inside one image. They do not establish temporal references between separate PNG frames. [PNG specification](https://www.w3.org/TR/png/#10Compression)

## Baseline measurements and their limits

The existing [production-path benchmark](browser-streaming.md) drives Chromium capture, real Noise transport and client decode for six changing synthetic-dashboard frames per preset. Its [raw results](browser-streaming-results.json) show:

| Preset | Mean image bytes | Capture + loopback receipt | Client decode |
| --- | ---: | ---: | ---: |
| 3840×2160 JPEG80 | 554,865 | 237.6 ms | 44.5 ms |
| 1920×1080 JPEG80 | 140,357 | 153.9 ms | 13.9 ms |
| 1280×720 JPEG60 | 44,355 | 111.8 ms | 15.5 ms |
| 960×540 JPEG40 | 19,099 | 95.3 ms | 12.1 ms |
| 1280×720 PNG | 340,014 | 192.4 ms | 25.7 ms |

These are prior controlled loopback measurements on software-rendered Linux arm64, not new WAN results, and the small sample does not establish p95 behavior. The scene has a textured image region; it is not representative of all text pages. The benchmark ACKs in its receive callback before separately decoding for measurement, unlike the production panel's decode-before-ACK policy. It also uses an evaluation-triggered update rather than an actual input-to-presented-pixel measurement. Its timings therefore cannot establish production interactive FPS.

Arithmetic still shows the size problem. A 555 kB frame requires about 2.22 seconds of payload serialization at 2 Mbit/s; a 44.4 kB frame about 178 ms. Thirty frames per second at those sizes would require approximately 133 Mbit/s and 10.7 Mbit/s respectively, before TCP/WebSocket overhead. These are calculations, not sustained-throughput observations. Reducing every frame to 540p is effective byte reduction but conflicts with legibility when small text was rendered at a much larger logical viewport.

### New offline XOR/tile experiment

[`scripts/browser-compression-analysis.cjs`](../scripts/browser-compression-analysis.cjs) is a reproducible feasibility experiment. It uses a fixed 1280×720 page containing dense 16px text and a deterministic textured image. It captures PNG and JPEG80 screenshots before and after unchanged content, a caret blink, typing, text selection, a 32px scroll and an image replacement. Three samples per case compare:

- Full PNG and JPEG80; an extra DEFLATE pass over JPEG80.
- XOR of consecutive JPEG byte arrays, then DEFLATE, with current encoded length retained.
- XOR of canonical screenshot RGBA bytes, then DEFLATE.
- Changed 64×64 tiles, each encoded either as replacement RGBA or as XOR RGBA, then DEFLATE; unchanged tiles are skipped.

Full XOR reconstruction is asserted byte-for-byte against current screenshot pixels. The assumed framing costs are 32 bytes per frame and 16 bytes per changed tile. These are comparison assumptions, not a wire proposal. The [raw results](browser-compression-results.json) record the browser/runtime and all measurements. Tile timings include both candidate encoders and the JavaScript scan; they must not be presented as optimized Rust encoder timings. PNG screenshots are decoded in a separate browser page so the captured page's scroll position and layout are unaffected; every sample resets the page scroll position.

Results on Linux arm64, Node 22.23.2 and Chromium 156.0.8078.4, in **bytes per update**:

| Change | Full JPEG80 | Full PNG | Full RGBA XOR + DEFLATE | Changed replacement tiles | Changed XOR tiles |
| --- | ---: | ---: | ---: | ---: | ---: |
| Unchanged | 153,396 | 357,976 | 16,124 | 32 | 32 |
| Caret blink | 153,188 | 357,958 | 16,194 | 322 | 170 |
| Typed sentence | 155,556 | 360,998 | 23,688 | 7,090 | 8,924 |
| Text selection | 153,755 | 358,191 | 20,718 | 15,224 | 8,651 |
| Scroll 32px | 156,691 | 360,011 | 607,130 | 493,299 | 602,698 |
| Replace textured image | 108,971 | 88,547 | 410,379 | 13,348 | 386,928 |

An unchanged update should actually be omitted; 32 bytes is just the experiment's assumed empty-update header. The sample shows why the design needs adaptive **representation**, not unconditional XOR: a caret changes one tile and selection benefits from XOR, but ordinary typing benefits more from replacement tiles. Scrolling moves most pixels and needs scroll-copy or a full-frame fallback. Replacing a noisy image with a simple image is particularly bad for XOR because the residual retains the old noise, while replacement encodes the new simple content efficiently. These are scene-specific observations, not universal compression ratios.

XOR of JPEG bytes compressed to 140,028 bytes for the caret and 151,756 bytes for typing: much larger than the pixel-tile candidates. Plain DEFLATE over JPEG produced 135,503 and 137,811 bytes, respectively. Across the changing cases, the extra DEFLATE pass saved roughly 11–18% over JPEG80 in this synthetic page, so it is not necessarily useless; its benefit is much smaller than sparse pixel updates and would still require codec negotiation, bounded decoding and a CPU cost comparison. It did not beat pixel tiles on sparse edits, and JPEG-byte XOR did not beat plain JPEG DEFLATE in the changing cases. This does not measure photograph-heavy JPEG recompression or a streaming dictionary.

The JavaScript full-XOR round trip took about 22–51 ms, **including** residual construction, DEFLATE, inflate, reconstruction and exact equality checking. Scanning and encoding both tile alternatives took about 22–70 ms. Capture, PNG decode, transfer to the analysis process and presentation are excluded from those numbers. The experiment proves potential payload reduction and correct full-XOR reconstruction; it does not prove lower end-to-end latency. At 2 Mbit/s, the 170-byte caret payload itself serializes in under 1 ms, but its initial reference, processing and RTT remain necessary.

Run from the repository root:

```sh
NODE_PATH=client/node_modules \
node scripts/browser-compression-analysis.cjs docs/browser-compression-results.json
```

This experiment does not exercise production screencast timing, Noise, WAN behavior, PNG tile encoders, Zstandard, WebCodecs or hardware encoding. A screenshot-derived lossless result is exact relative to that screenshot's decoded pixels; it does not prove that all Chromium capture paths preserve original compositor RGB/subpixel text. Real screencast pixels must be checked separately.

## Latency: compressing bytes is only part of the problem

A useful decomposition is:

```text
input upload + input dispatch + page work + wait for capture
+ capture/encode + server queue + network serialization/propagation
+ client decode + presentation wait
```

Measure each component before choosing an encoder. Reducing a 1 KiB delta to 500 bytes cannot fix 100 ms waiting for a capture slot. Increasing FPS cannot fix a 2-second serialization backlog.

### ACK pacing and final-frame freshness

With one frame outstanding, each new capture opportunity depends on returning an ACK across the connection. A rough saturated-path cycle is capture/encode + serialization + client decode/pacing + RTT, subject to Chromium's capture scheduling. At 100 ms RTT even tiny images and fast codecs cannot produce 60 fresh round trips per second under this stop-and-wait policy. This is an architectural bound, not a measured FPS forecast.

The production policy is defensible: it bounds stale work and does not replace a valid frame with an undecodable one. Simply ACKing on receipt can shift the backlog into decoder work or JS tasks. Simply allowing several frames in flight can improve link utilization but also accumulate obsolete images. Any change should retain an explicit maximum for queued encoded bytes, pending decodes and unpresented frame age.

There is a concrete CDP option to investigate first. Current tip-of-tree `startScreencast` documents `sendLastFrame:true`: Chromium retains the latest produced frame while waiting for an ACK and can send it after the ACK instead of waiting only for the next produced update. The pre-2.5 implementation did not request it; 2.5 probes the launched Chromium schema and requests it when advertised. The current Chromium implementation and browser test explicitly cover a repaint produced while the preceding frame is outstanding. Probe the installed protocol and test supported versions; do not infer support from Eya release numbers. This option may improve final-update reliability and freshness without increasing network frames in flight, but needs CPU/memory testing. Tip-of-tree CDP is not a stable cross-version guarantee. [Chromium implementation](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/page_handler.cc), [Chromium regression test](https://chromium.googlesource.com/chromium/src/+/HEAD/content/browser/devtools/protocol/devtools_protocol_browsertest.cc), [CDP compatibility guidance](https://chromedevtools.github.io/devtools-protocol/)

If that option is unavailable, explicitly test and design a final-refresh mechanism; a page must not remain visually stale after one input changes it while capture is backpressured. Avoid unbounded polling screenshots.

For a later pipelined image mode, compare a bounded policy of one transmitting image, one replaceable latest captured image and one decode task. New independent images may replace unsent independent images. They cannot safely replace arbitrary reference-dependent deltas. Measure whether 1–2 frames of credit improves bandwidth-delay-product utilization enough to offset added age. Keep the current single-frame path as fallback.

### Input must not wait behind frame production

The pre-2.5 Rust handler awaited the entire chunk-send loop within the browser session event handler. Version 2.5 sends display chunks incrementally through a bounded writer; the following analysis motivated that change. Under socket backpressure this can delay servicing incoming input and control messages until frame writes finish. The browser connection is separate from terminal/workspace traffic, but its own display and input still share that handler. Profile this explicitly on a constrained link.

A candidate design separates reading/dispatch from one ordered encrypted writer, with bounded queues and control priority between image chunks. Keep Noise encryption and socket output ordering owned by one writer; do not encrypt from competing tasks or drop a partly transmitted frame without defined cancellation. Smaller chunks only help scheduling when the handler actually yields to input; they do not bypass TCP bytes already in the send buffer. Bound socket buffering and whole-frame send time, and make downloads/debugger output unable to starve page input. This refactor can preserve baseline framing and still requires transport and reconnect regressions.

## XOR: what to implement and what to avoid

For byte-aligned canonical pixels `P` and acknowledged reference `R`:

```text
D = P XOR R
payload = compress(D)
P = decompress(payload) XOR R
```

Equal pixels produce zero residual bytes; sparse caret/selection changes can compress well. XOR alone has exactly the same byte count as `P`. A bytewise subtract residual is another candidate; compare on the same scene rather than assuming XOR wins every time. Unchanged frames should be omitted entirely.

JPEG is already compressed and small edits can change variable-length coding and byte alignment far beyond the edited pixels. PNG likewise applies filtering and a compressed stream. A compressed-byte XOR therefore lacks dependable locality; unchanged encoded frames are better handled by equality/duplicate detection. More DEFLATE over an already-compressed image can spend CPU for little reduction. The new experiment includes these options to quantify that caveat rather than treating it as an absolute mathematical impossibility.

### Capture and reference correctness are the difficult parts

Eya receives compressed CDP images, not raw frame buffers or damage rectangles. Pixel deltas require either decoding captured PNGs on the server, accepting extra decode/encode work, or adding a different capture integration. Decoding JPEG and then compressing a lossless residual preserves the decoded JPEG's artifacts; it does not recover original text. Repeated JPEG captures can also introduce pixel changes outside the actual dirty region, reducing delta efficiency.

Never XOR server-original pixels against a client reference reconstructed through a lossy image decoder unless the server stores the **same reconstructed reference**. Otherwise residuals apply to different values and silently corrupt pixels. Even JPEG decoders can differ in rounding; using client-specific lossy reconstruction as a supposedly bit-exact reference is unsafe. The first implementation should use lossless canonical RGBA references, fixed alpha handling, dimensions and color-space semantics. A lossy preview should use a separate layer/epoch and must not become the exact XOR base accidentally.

## Lossless changed tiles are the preferred first compression prototype

Start with 64×64 or 128×128 tiles and compare several sizes. For each canonical frame: find changed tiles, retain or verify per-tile pixels, omit unchanged tiles, and choose a lossless replacement encoding. Exact equality after a fast hash prevents hash collisions becoming image corruption. Tile headers and scan cost matter; 16px tiles can spend more on metadata and dispatch than they save. Large contiguous changes should merge into rectangles or switch to an independent full frame when cheaper.

Candidate tile encodings are PNG, raw+DEFLATE, and later Zstandard with a bounded decoder. PNG replacement tiles use existing browser image decoders and preserve pixels but introduce image-object, Blob and decode overhead per tile. Raw+DEFLATE can reuse dependency-light byte-decoding machinery after auditing its limits; reconstruct into a canvas in a worker where supported. PNG's spatial filters may outperform raw DEFLATE on text, so the raw-tile experiment is a feasibility bound, not a PNG-versus-XOR verdict. Zstandard is another compressor candidate with explicit frame/window requirements; adopting it also requires shipping or detecting a compatible client decoder. [Zstandard format](https://www.rfc-editor.org/rfc/rfc8878.html)

Only then compare XOR residual tiles against replacement tiles. Choose the smallest acceptable encoded representation per tile, subject to encode-time budgets; do not run every expensive codec for every tile in production. Replacement tiles are simpler to recover, have no dependency on previous tile pixels, and should remain available even after XOR ships. A changing photograph might prefer JPEG preview while a text region remains lossless, but mixed modes require explicit reference/layer definitions.

The client should decode a complete update off-screen, verify dimensions and bounds, then commit it atomically. Showing half an update can display inconsistent forms, stale controls or a partly moved selection. Keep a valid displayed surface on decode failure. The first prototype should favor a single canvas update over many absolutely positioned tile elements.

### Memory is part of the codec budget

RGBA requires four bytes per pixel: 3.52 MiB at 1280×720, 7.91 MiB at 1920×1080 and 31.64 MiB at 3840×2160. Two reference/current buffers plus one residual are about 95 MiB at 4K, before decoder, canvas, encoded-frame and Chromium allocations. At Eya's 8192×8192 viewport maximum one RGBA surface alone is 256 MiB; the existing 16 MiB **encoded** cap does not make that safe to allocate repeatedly.

Define a negotiated decoded-pixel budget and independent server/client allocation bounds before decoding. Check width×height×channels with overflow-safe arithmetic; validate dimensions from the decoder rather than trusting metadata alone. Limit changed-tile count, total decoded bytes, decompressor work/window, surface count and retention time. Avoid allocation-per-pixel and release references on navigation, resize, close and detach. Use bounded blocking workers for expensive image processing so the Tokio runtime and input dispatch remain responsive.

## Scroll-copy: promising, but correctness comes first

Scrolling a text document moves many existing pixels. A verified integer translation can copy a rectangle of the acknowledged surface and send only newly exposed strips plus changed overlays. This preserves full-resolution glyphs with little payload. The longstanding RFB `CopyRect` encoding uses this same framebuffer-reuse principle. [RFB specification](https://datatracker.ietf.org/doc/html/rfc6143#section-7.7.2)

Do not infer an exact pixel copy from a wheel delta or `window.scrollY`. Pages can have sticky headers, nested scrollers, fractional transforms, fixed video, scroll-linked animation, cross-origin frames and lazy loading. Find/verify matching pixel regions; exclude changed regions; encode the residual. Reads must use the pre-update reference (or well-defined overlap-safe copy semantics), not partially updated pixels. Fall back to tiles/full frames when matching is ambiguous or expensive. Lossless source pixels also avoid repeatedly moving blurred JPEG edges.

## Inter-frame video: a separate path for motion

Temporal video codecs can compress scrolling, charts, animation and page video more effectively than independent still images. They keep the website in real Chromium, unlike rebuilding the website DOM in a client proxy. However, a video encoder needs a viable raw-frame/capture path. Decoding every CDP JPEG, then feeding another lossy encoder, adds cost and loses fidelity before temporal encoding begins. CDP screencast's `format` does not accept H.264/AV1; changing that field is not an implementation.

Prototype low-delay H.264 or VP9 according to actual host/client availability, then compare AV1 only where fast software or hardware support exists. Codec choice is empirical; no throughput or universal compatibility claim follows from the codec name. Avoid B-frame/reorder queues and multi-frame lookahead for the interactive path; configure a short rate-control buffer, controlled keyframe recovery and an encoder budget that includes concurrent browser sessions. FFmpeg documents encoder-specific low-delay and pixel-format controls; their availability depends on the selected encoder and host. [FFmpeg codec options](https://ffmpeg.org/ffmpeg-codecs.html)

WebCodecs offers low-level client decoding without pretending the stream is an ordinary URL-loaded movie. It requires a secure context and configuration probing; the standard does not require every codec. Probe the actual codec/profile/level/dimensions and handle asynchronous decode failure and resource exhaustion. File, SVG and data-origin clients need explicit testing. Keep image fallback when the API, origin or codec configuration is unsupported. Encoder realtime settings favor latency; they are not a text-quality guarantee. [WebCodecs specification](https://www.w3.org/TR/webcodecs/)

### Preserve text before chasing higher motion FPS

Common 4:2:0 video paths reduce chroma resolution. Colored 12–16px text, thin table rules and dark-theme syntax highlighting are essential tests, not incidental visual details. RGB/4:4:4 or lossless modes may preserve them better, but are not guaranteed to have the same hardware/client support or bitrate. Test actual output. Prefer full spatial resolution with fewer fresh frames for reading; use lower resolution temporarily for fast motion only if it is restored promptly.

A useful hybrid candidate sends a low-delay motion preview and then a lossless full-resolution correction when content settles. Another keeps lossless text/UI tiles above video regions. Both require clear compositing order, clipping, scale and reference epochs. A stale refinement arriving after a new page frame must never overwrite newer content. Prioritize selected text, caret, focused controls and text-heavy regions, but avoid DOM-based heuristics becoming prerequisites for correctness. The stream must remain usable for canvas editors and cross-origin frames where semantic hints are absent.

Newer CDP also exposes experimental screen-recording APIs. Their existence does not establish low-latency incremental elementary-stream delivery, compatible codecs or a stable contract on deployed Chromium. Probe and benchmark actual chunk arrival, buffering, stop/finalization requirements and decoder framing before treating recording as an interactive encoder.

## Adaptive behavior and sensible defaults

Expose an optional **Text** policy that retains spatial resolution and lossless text, and an optional **Motion** policy that prioritizes fresh frames at an allowed quality floor. Preserve existing defaults until measurements support changing them. Users must be able to select PNG/full-quality behavior explicitly.

Estimate capacity from encoded bytes, send durations, ACK turnaround and client decode time; do not interpret ACK turnaround alone as bandwidth because it includes decode and the configured FPS delay. Use smoothed estimates with hysteresis. First stop spending on stale frames and reduce update rate, then adapt image quality or motion resolution within explicit limits. Restore quality/resolution after settling, and measure whether the restoration itself causes a large serialization stall. Do not let the controller oscillate settings and repeatedly restart screencast on every sample.

Keep input mapping tied to the frame's logical viewport and displayed geometry, independently of encoded resolution. Cursor shape should be small control metadata rather than burned into every frame or predicted page content. Local pointer movement may stay responsive without speculatively applying page mutations. Never replay uncertain clicks, typed input, form submits or other mutations to improve apparent latency.

WebSocket/TCP remains a practical deployable fallback through existing proxies and authentication. It can still deliver old frame bytes before newer bytes after congestion/loss. A later QUIC/WebTransport/WebRTC design would need its own deployment, authentication, congestion control, packetization and keyframe/recovery work. It should follow measured TCP limitations, not replace working transport before a viable codec/capture path exists. Audio and synchronization are separate unimplemented concerns, not automatic benefits of video compression.

## Protocol and recovery contract for any future delta/video mode

Follow [`updates.md`](updates.md); existing frame tags, payloads, ACK meanings and Noise prologues stay immutable. A proposed capability such as `pixel-tiles-v1` is only a design name until implemented. The server must select only capabilities actually offered by the client; old/missing/unknown offers keep independent baseline images.

A negotiated design must specify:

1. **Reference identity:** stream epoch, active tab, dimensions, pixel/color format, reference sequence and current sequence; ACK advances only the precisely defined committed reference. Current ACKs also occur on failed image decode, so their deployed meaning must not be silently reinterpreted as successful exact reconstruction.
2. **Operations and bounds:** immutable operation IDs, byte order, coordinate units, rectangle/tile limits, encoded and decoded lengths, codec identifier, maximum decompressor window and exact output size. Reject overlapping/overflowing/invalid geometry before allocation or mutation.
3. **Transactional commit:** complete update validation and off-screen reconstruction before presentation and reference commitment. Bound temporary buffers and decoder work. A malformed update leaves the prior valid surface intact.
4. **Recovery:** explicit request for an independent lossless reset/keyframe on base mismatch or decode failure, with a bounded retry policy and image fallback. A new transport attachment renegotiates; reconnect, tab switch, resize, pixel-format change and takeover invalidate references. Do not persist these references as authoritative server sessions.
5. **Dropping policy:** only drop work that is not needed by a later delta/video reference. A latest-frame queue must rebase on the last acknowledged reference or send a new independent frame. TCP reliability does not remove application-level resets, cancellation races or decoder failure.
6. **Video details:** codec configuration/description, timestamps/timebase, keyframe flag, decoder reset, maximum queue depth/age and resource cleanup. No dependent chunks before a compatible keyframe/configuration.
7. **Privacy and execution:** clear pixel/reference caches across session/profile boundaries; never mix dictionaries between users/origins merely to increase ratios. Keep `EYA_KEY` out of encoder/Chromium child environments, preserve validated egress, sandbox, deadlines and hard resource limits. Codecs cannot weaken these boundaries.

## Validation and release gates

The next implementation should extend the existing production benchmark instead of replacing it with codec-only sizes. Add at least these scenes: static documentation, multilingual small text/dark code, caret/typing/selection, smooth and jump scrolling, nested scrolling/sticky headers, canvas/WebGL, dashboard animation, full-window page video, responsive resize/DPR changes and tab switches. Include malicious/corrupt metadata and decode failures.

Run representative client origins and browsers, ARM64/x86 servers, software/GPU capture and concurrent browser sessions. Shape 2/10/50 Mbit/s links with 10/50/150 ms RTT, jitter and packet loss. Record p50/p95 input-to-presented-pixel latency, age of displayed frames, effective fresh FPS, actual encrypted bytes, queue length/bytes, server/client CPU, memory, energy where available, capture/encode/decode time and recovery duration. Report dropped/duplicated/stale frames, not only averages.

For text fidelity, compare same-resolution screenshot crops and exact lossless reconstruction; inspect 12/14/16px glyphs, colored syntax, Arabic/CJK/combining marks, thin strokes and selection contrast. Whole-image PSNR/SSIM alone can hide unreadable small text. Include task-level reading and caret-placement checks. For hybrid modes, assert that stale refinements cannot overwrite later content and that idle images recover the promised quality.

Required compatibility coverage includes old client/new server, new client/old server, absent/unknown capability and fields, only offered encoding selection, unsupported decoder fallback, dropped ACKs, reference mismatch, bad tile geometry, decompression bombs, mid-frame disconnect, resize during decode, tab switch, takeover and repeated keyframe failure. Maintain permanent update-v1 and baseline browser/terminal behavior. Rebuild generated clients before Rust, run Cargo fmt/check/test, updater/wire/terminal/reconnect/artifact checks, and the existing browser frame/transport/stream suites. A report-only experiment is not a substitute for those release gates when the encoder is implemented.
