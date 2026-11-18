# Terminal responsiveness on unreliable networks

The scheduling/pacing and negotiated-compression stages below are implemented. Retained PTYs, offset-based input deduplication, explicit process creation, bounded replay and Noise authentication remain as described in [reconnection.md](reconnection.md). The original investigation is preserved below to explain the choices. Speculative local echo, terminal-state snapshots and datagram transports were explicitly optional extensions; their evaluation and prerequisites remain separate from the lossless WebSocket implementation.

## Implemented behavior and verification

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| Fair input/output/control scheduling | Fair actor selection; a 16-frame encrypted writer queue, four slots reserved from output; actor alone owns Noise state; bounded rejection jobs; TCP_NODELAY on accepted connections | `resume.rs` tests and `terminal-network-protocol.cjs`; real TCP timing experiment |
| Limit stale output before it reaches TCP | Delivery window starts at 8 KiB and adapts within 4–32 KiB using bulk ACK delivery rate and a bounded rolling minimum of recent small-flight feedback; human typing pauses do not lower the bulk estimator. Attached replay backpressures near that window; detached replay keeps configured retention. Reader queue has two chunks; opportunistic same-turn batching has no fill timer | Replay/batching Rust regressions, withheld-ACK protocol bounds, WAN Ctrl-C/bulk observations |
| Responsive, ordered input | Same-microtask batching, ≤4 KiB frames, ≤16 KiB awaiting committed ACKs; 256 KiB page queue; large pastes paced without reordering Ctrl-C | `terminal-network-client.cjs`, `reconnect.cjs`, `terminal-takeover-input.cjs` |
| Fewer small control messages | Output ACK deadline 8 ms or 16 KiB after xterm callbacks; coalesced committed input ACKs; duplicate input still reconciles; unchanged resize suppressed | Deterministic client tests and lost-ACK protocol replay tests |
| Feedback and recovery | Transient RTT/input age/renderer backlog/decode/reconnect metrics; authenticated session diagnostics for output window/ACKs/queue; jittered reconnect; 30–60 s progress-aware terminal heartbeat; timeout cleanup fences old sockets without waiting for a close event | Client clock-driven regressions; reconnect and local-client suspension tests |
| Bounded negotiated compression | Independent raw-DEFLATE before Noise; opcode 11; decoded offsets; ≤8192 decoded bytes; minimum 256-byte candidate and 16-byte savings; raw fallback; no shared dictionary | Rust compression tests; exact protocol byte comparisons; 380 codec cases plus malformed/mutation tests |
| Safe local HTML/SVG support | Bundled synchronous decoder, bounded before every write/allocation; no asynchronous decode ordering/cancellation race; no new JS runtime dependency | Real generated/local HTML/SVG clients, mobile CPU4x, opt-out and suspension tests |
| Compatibility and control | Old clients/servers remain raw; compression may change on reattach; generator checkbox and server `EYA_TERMINAL_COMPRESSION=auto|off` | Both partial-replay codec transitions, legacy/unsupported capability tests, real generator downloads |
| Silent/fatal transport failure | Idempotent cleanup immediately fences closing sockets, late events and packets after a fatal receive error; handshake/heartbeat deadlines retry retained sessions | `terminal-network-silent-outage.cjs`, hung-close and malformed-followup client regressions |
| Resource cost | Actual production encoder/decoder CPU measurements and real renderer/server process peak RSS under CPU4x terminal stress | `terminal-network-resources.cjs`, source-hashed resource artifact |
| Preserve privacy/correctness | No speculative echo, no transcript logging, no discarded ANSI updates; password/non-echo input remains hidden | Browser non-echo test, exact Unicode/ANSI/binary transcripts, code review |

Current source: `eya-server/src/resume.rs`, `client/terminal-panel.js`, `client/terminal-network.js`, `client/terminal-codec.js`; operator/wire details are in [reconnection.md](reconnection.md). The decoder and network-policy modules contribute approximately 2,297 and 306 minified bytes respectively according to esbuild input attribution; the complete standalone HTML is 2,504,165 bytes (728,067 gzip) at this checkpoint, including existing unrelated project features. This is module attribution, not a before/after bundle-size claim. Rust adds `flate2` with its Rust backend.

The in-flight window bounds bytes already sent, while attached replay and small reader queues backpressure generation earlier. Server feedback latency includes client parsing/ACK delay. Only fully drained flights of 1–255 decoded bytes enter an eight-sample history; its minimum avoids treating slow bulk serialization as propagation delay. Whole-flight accounting prevents a bulk flight’s final tiny ACK from becoming a latency sample. Recent small flights age out a former clean-link minimum after roaming; reattachment resets the estimator. Continuous bulk output without small drained flights retains the last conservative estimate. A window may shrink below previously sent bytes; the server waits for ACKs rather than retracting those bytes. A replay threshold can be crossed by one existing ≤8 KiB chunk. Reader/carry/blocked-reader chunks and OS PTY buffers are separately bounded. Terminal output remains ordered and lossless, so the observed result of Ctrl-C can still wait behind bytes produced before the interrupt, especially for incompressible streams. Input delivery itself must remain responsive.

Modern terminal output, ACKs, pings and state replies never await a stalled socket in the actor. The old file/machine-on-terminal compatibility helpers retain their existing bounded asynchronous behavior; current clients use the separate workspace transport for these operations. Accepted TCP sockets enable TCP_NODELAY so an input ACK cannot make a subsequent tiny echo wait for another RTT through Nagle's algorithm. Reverse proxies have their own upstream socket policies.

### Verification commands

Build the client and embedded server first. Browser/protocol tests need loopback sockets and Chromium. The full browser integration also uses `nano`, `top` and standard Linux shell tools; the WAN workload uses Python 3. Run in disposable roots only:

```sh
node client/build.mjs
cargo fmt --manifest-path eya-server/Cargo.toml --check
cargo check --locked --manifest-path eya-server/Cargo.toml
cargo test --locked --manifest-path eya-server/Cargo.toml
cargo build --locked --manifest-path eya-server/Cargo.toml
NODE_PATH=client/node_modules node tests/terminal-network-client.cjs
NODE_PATH=client/node_modules node tests/terminal-network-protocol.cjs
NODE_PATH=client/node_modules node tests/terminal-network-browser.cjs
NODE_PATH=client/node_modules node tests/terminal-network-silent-outage.cjs
NODE_PATH=client/node_modules EYA_RESOURCE_REPORT=/tmp/eya-terminal-resources.json node tests/terminal-network-resources.cjs
NODE_PATH=client/node_modules node tests/reconnect.cjs
NODE_PATH=client/node_modules node tests/terminal-takeover-input.cjs
NODE_PATH=client/node_modules node tests/terminal-webgl.cjs
NODE_PATH=client/node_modules node tests/workspace-continuity.cjs
NODE_PATH=client/node_modules node tests/panel-factories.cjs
NODE_PATH=client/node_modules EYA_WAN_REPORT=/tmp/eya-terminal-network.json node tests/terminal-network-wan.cjs
```

The WAN driver starts its own user/network namespace via `unshare`, verifies that its network namespace differs from the launching namespace, and applies `tc netem` only there. It uses separate rate/delay qdiscs for server-port upload/download traffic. It needs Linux user/network-namespace and netem support; do not replace it with host-wide qdisc changes. `EYA_WAN_QUICK=1` selects a smaller development matrix. The full matrix records both directions, 12 independent key samples per profile, actual encrypted WebSocket bytes/messages, CPU/resource samples, a real Unicode key, bulk log output, Ctrl-C during continuous output and reattachment. Echo timing uses in-page renderer mutations, not Playwright polling intervals. `EYA_WAN_PROFILE='{"rtt":600,"kbit":256}'` selects a targeted tuning case. Executed results and measurement limits are recorded below.

## Baseline investigated before implementation

`client/terminal-panel.js` sends input immediately and acknowledges output after xterm's write callback. It retains up to 256 KiB of unacknowledged input. `eya-server/src/resume.rs` reads PTY output in chunks of at most 8192 bytes, retains a bounded replay buffer, and allows roughly 256 KiB of output ahead of the client's acknowledgment. An 8192-byte chunk can cross that window threshold. Input is written by a separate blocking worker. Each terminal uses its own WebSocket, independently of workspace/file/browser traffic; all connections still compete for the same physical link.

The server currently drains the available output window before returning to its `select!` input/attachment loop. Each awaited WebSocket send can take up to five seconds. This creates a scheduling risk during bulk output: keyboard input, committed-input notifications, pings and reconnect requests can wait behind sends even though the PTY writer itself is isolated. Test and fix this before increasing buffer sizes.

The current window is a memory bound, not a latency target. Sending 256 KiB over a 64 kbit/s bottleneck takes approximately 33 seconds before framing and retransmission costs. Those bytes may sit in network/OS queues ahead of useful screen updates. A smaller window can improve responsiveness, while a window below the bandwidth-delay product limits throughput. Measure both effects.

## Measurements: how much compression can help

Run `node tests/terminal-compression-benchmark.cjs`. It uses Node zlib raw DEFLATE level 1, independent blocks, one actual repository source file, generated varying logs/redraws, and deterministic high-entropy bytes. These are local payload estimates, not a captured user session, packet capture, CPU benchmark or measured WAN speedup. Real PTY chunk sizes can be much smaller than these bulk chunks; small interactive output will save less.

Results on Node v22.23.2 / zlib 1.3.1-e00f703:

| Workload | Block size | Payload reduction if compressed | Estimated terminal-frame reduction with fallback |
| --- | ---: | ---: | ---: |
| One echoed key | 1 byte | −200.0% | 0% |
| Colored shell prompt | 29 bytes | −6.9% | 0% |
| Actual Rust source | 1 KiB | 55.6% | 53.6% |
| Actual Rust source | 8 KiB | 67.5% | 67.2% |
| Synthetic varying logs | 1 KiB | 82.7% | 80.0% |
| Synthetic varying logs | 8 KiB | 90.1% | 89.7% |
| Synthetic full-screen redraws | 1 KiB | 71.1% | 68.8% |
| Synthetic full-screen redraws | 8 KiB | 88.8% | 88.4% |
| High-entropy bytes | 1 / 8 KiB | −0.5% / −0.1% | 0% |

The actual source is `eya-server/src/system.rs`, 29,124 bytes, SHA-256 `a7504d5b8faf0530a0a655f16f6bc98b261dde62685e3c52556ffed8a5160103`. Source edits may change its results. Each block starts a fresh compressor. The estimate includes existing nine-byte terminal framing, the sixteen-byte authentication tag specified by [Noise](https://noiseprotocol.org/noise.html#message-format), and the server WebSocket frame header. Proposed compressed framing adds a four-byte decoded-length field. It sends raw bytes for blocks below 256 bytes or savings below sixteen bytes. It excludes TCP/IP, TLS, network ACKs, application ACKs and retransmissions; WebSocket messages do not map one-to-one to network packets.

For a bandwidth-bound source/log/redraw stream these results justify testing compression. They do not imply faster first-key echo on a high-latency link: compressing one character expands it. For small messages, reduce unnecessary protocol messages instead. A one-byte input currently needs 32 bytes of client WebSocket/Noise/offset framing before TCP/IP or TLS. The server also sends a committed-input ACK after writing, an immediate current-input ACK on reception, an echo frame, and receives a render ACK. Counting these tiny messages matters more than compressing their payload.

## Scheduling, feedback and pacing requirements

1. Service inbound input, committed-input completions, attachment/end requests and heartbeat deadlines fairly between bounded output sends. A reader/writer task split can avoid blocking reads on a stalled send, but must have bounded queues and a single owner for outbound Noise state; cancellation must never reuse a consumed nonce. Merely moving the same unbounded backlog to another task does not solve latency.
2. Keep keystrokes immediate. Coalesce only already queued input on the same event-loop turn, with a small byte cap; do not wait a network RTT or an arbitrary batching timer for ordinary typing. Preserve exact UTF-8 bytes, bracketed paste, offsets and deduplication. Pace large pastes rather than pushing a megabyte of transport backlog. Ctrl-C must retain normal byte ordering; never jump past earlier accepted input silently.
3. Coalesce cumulative output ACKs using both a short deadline and byte threshold, for example 8–16 ms or 16 KiB initially. Flush at the tail so short output cannot stall. ACK only bytes whose xterm callback has completed; surviving-renderer received offsets remain distinct from parsed offsets. Remove or coalesce redundant unchanged input ACKs while retaining immediate reconciliation of duplicates and committed-input acknowledgments. Reconnect and takeover must remain correct if any ACK is lost.
4. Add transient RTT, oldest unacknowledged-input age, output-in-flight, ACK progress and reconnect metrics; no transcript or typed-input logging. Start with a conservative bounded output window and evaluate an adaptive window against measured throughput/RTT. Keep the replay retention cap separate. On a slow link, prioritize bounded backlog rather than maximizing throughput. Window reduction must not retract bytes already sent.
5. Review the fixed fifteen-second client heartbeat timeout. A heavily delayed ordered stream can be alive while its heartbeat waits behind output. Avoid repeatedly tearing down a slow connection; use progress-aware deadlines, smoothed RTT and bounded reconnect backoff with jitter. Keep a hard no-progress bound so truly dead connections still recover. Validate browser background timer throttling separately.

Use xterm's asynchronous write completion for flow accounting, without treating it as proof that pixels have already painted. Its own [flow-control guide](https://xtermjs.org/docs/guides/flowcontrol/) recommends watermarks and bounded callback pressure. Eya already has the essential end-to-end ACK mechanism; tune and test it rather than adding a second incompatible accounting system. The distinction between parsing and painting is documented in [xterm parser hooks](https://xtermjs.org/docs/guides/hooks/).

## Negotiated output compression requirements

Compress terminal output **before** Noise encryption, and decompress **after** authenticated decryption. WebSocket [per-message compression](https://www.rfc-editor.org/rfc/rfc7692) acts on the WebSocket payload; for Eya that payload is already ciphertext. Enabling it at a reverse proxy cannot recover the terminal's text redundancy. This conclusion follows from Eya's layering, not a measured proxy benchmark.

Negotiate an explicit capability in the encrypted terminal confirmation and ready response. Old peers continue with existing type-8 raw output; do not send a new compressed opcode without mutual agreement. Define a distinct output opcode carrying absolute decoded-byte offset, declared decoded length and one independent raw-DEFLATE block. Maintain all replay and ACK offsets in original terminal bytes. Re-encode replay as needed with the new connection's negotiated codec and fresh Noise state; never save/replay ciphertext.

Begin with server-to-client output only. Leave keys, control messages and ACKs raw. Try compression only for existing bulk chunks of at least 256 bytes; retain raw if it does not save at least sixteen framed bytes. Do not delay prompts waiting to fill 8 KiB. Avoid a cross-message dictionary initially: independent blocks make reconnect, fallback and validation simpler, with no previous compressed state to restore. Compare level 1 against a faster codec only after measuring CPU and total standalone-client size; gzip's wrapper is unnecessary for this envelope.

Keep decoded output at most 8192 bytes per message initially, exact decoded-length validation, no trailing compressed input, existing encrypted-frame limits, bounded decode work and a cap on total decoded-but-unparsed bytes. Reject malformed blocks; do not continue with corrupt terminal state. Guard bounds during decompression, before building an arbitrarily large output buffer. Preserve raw fallback if a browser lacks the chosen decoder. The [Compression Streams standard](https://compression.spec.whatwg.org/) exposes deflate-raw, but feature-test the actual supported format. Its streaming API has no public sync-flush control; independent completed blocks avoid waiting indefinitely on an open compressor stream. Local HTML and SVG clients must be included in compatibility tests.

A bundled decoder gives more predictable support and output limits at a bundle-size cost. A native stream implementation avoids that dependency but adds asynchronous decode ordering and cancellation work; checking a stream chunk's length cannot prevent an oversized allocation inside the decoder. Choose a decoder that can enforce the required resource bound, then test on target browsers. If decoding is asynchronous, serialize decrypt/decode/delivery explicitly; later raw/control frames must not overtake prior compressed output. Account decoded bytes, not compressed bytes, against all flow-control limits. Do not share dictionaries between terminals or mix secret input into an output compressor. Independent blocks reduce cross-message length coupling but do not eliminate compression length side channels within a block; retain an off option.

## What to borrow from Mosh

Mosh synchronizes terminal state over UDP and predicts local echo, rather than delivering every obsolete screen update as a byte stream. Its [project explanation](https://mosh.org/) and [design paper](https://mosh.org/mosh-paper-draft.pdf) describe these as distinct mechanisms. Adopt them separately:

- **Low-risk now:** reconnect retained sessions, bound output backlog, pace work, expose stale/queued status and distinguish authoritative output from pending input. Eya already retains the PTY and deduplicates input.
- **Optional next:** speculative local echo in a separate presentation layer that can be corrected by authoritative output. Never write guessed characters into the canonical xterm byte stream or advance replay offsets. Default off until correctness is demonstrated. Require evidence of echoed input; suspend prediction on control keys, escape sequences, alternate-screen transitions, uncertain modes, IME composition and password/non-echo input. A guessed prompt regex is insufficient. Blind local echo can display passwords, duplicate text and corrupt TUIs. Prefer a deliberately separate opt-in local command composer if reliable prediction cannot be established; describe its different history/completion behavior honestly.
- **Larger future option:** server-side terminal emulation, numbered snapshots/deltas and an independently bounded scrollback archive. This can fast-forward to the current screen after outages and avoid transmitting obsolete TUI redraws. It changes Eya's current lossless replay contract: dropping arbitrary ANSI bytes is never safe. Design cursor/modes, alternate screen, colors, Unicode width, terminal queries, OSC effects, resize and scrollback semantics before implementing it. A server emulator must stay compatible with the client emulator.

State snapshots over the existing ordered WebSocket can shorten application catch-up, but cannot bypass bytes already blocked in that TCP stream. A plain local HTML/SVG page cannot open arbitrary UDP sockets through the [WebSocket API](https://websockets.spec.whatwg.org/). [WebTransport](https://www.w3.org/TR/webtransport/) datagrams are a possible separate experiment, requiring an HTTP/3 endpoint, certificate/origin compatibility and target-browser/local-file testing. WebRTC data channels add signaling and deployment complexity. Neither is a drop-in replacement: current ordered Noise counters cannot simply be reused for reordered/lost datagrams; authentication, replay protection and sequencing require a deliberate protocol design. Keep WebSocket as the supported fallback and postpone this transport expansion until measurements justify it.

## Acceptance and experiments

Use a disposable server and isolated proxy/network namespace. Do not change the developer's host network or interrupt retained sessions. Test RTT 0/80/250/600 ms, constrained 32/64/256 kbit/s throughput, jitter, short outages and competing bulk transfers. TCP packet loss/reordering requires real link emulation such as `tc netem`; a WebSocket relay that delays whole messages is useful for deterministic scheduling tests but does not reproduce TCP loss recovery. Record the emulation method and both direction limits.

Measure p50/p95/p99 key-to-authoritative-echo latency, first output latency, Ctrl-C-to-observed-stop, reconnect-to-usable-screen, bytes and messages per workload, decode/encode CPU, renderer backlog and peak memory. Use interactive shell, Unicode/IME, large paste, `yes` plus Ctrl-C, colored logs, full-screen editor, process monitor, password prompt and resize-under-load. Run with raw output and proposed compression under identical conditions. Assess mobile CPU/battery and bundle growth before setting defaults.

Regression gates: exact decoded-byte transcript and offsets, no repeated command/input across dropped ACKs, partial compressed replay boundaries, duplicate frames, malformed/truncated/oversized compressed messages, unsupported capability fallback, codec changes on reconnect, cancellation during async decode, independent terminals, takeover with a blocked PTY writer, background/minimized terminal progress, page suspension and server expiry. Keep authentication and explicit-new-session invariants unchanged. Compression ratios alone are not a responsiveness acceptance criterion.

## Executed WAN results

[Machine-readable measurements](terminal-network-results.json) pin the exact runtime and harness source hashes. The final matrix completed all **30 profiles / 360 key samples** with the published source: 0/80/250/600 ms RTT × 32/64/256 kbit/s × raw/compressed, plus jitter/loss/reordering, a severe 600 ms/32 kbit/s lossy link and competing raw terminal output. Connections remained usable, replay remained bounded and all cases reattached successfully.

| Nominal RTT / kbit/s | Variation | Echo median raw → compressed (ms) | Bulk raw → compressed (s) | Bulk framed bytes saved | Ctrl-C observed raw → compressed (s) |
| --- | --- | ---: | ---: | ---: | ---: |
| 0 ms / 32 | none | 126 → 128 | 8.69 → 1.04 | 92.5% | 7.11 → 0.68 |
| 0 ms / 64 | none | 63 → 58 | 4.55 → 0.47 | 93.6% | 3.36 → 0.29 |
| 0 ms / 256 | none | 27 → 26 | 1.12 → 0.16 | 94.7% | 1.01 → 0.08 |
| 80 ms / 32 | none | 196 → 208 | 8.50 → 1.15 | 93.7% | 10.50 → 0.63 |
| 80 ms / 64 | none | 143 → 145 | 4.54 → 1.05 | 92.4% | 3.86 → 0.43 |
| 80 ms / 256 | none | 112 → 109 | 1.69 → 0.34 | 92.0% | 0.99 → 0.18 |
| 250 ms / 32 | none | 378 → 376 | 9.37 → 1.71 | 93.2% | 6.21 → 1.03 |
| 250 ms / 64 | none | 312 → 311 | 4.64 → 1.24 | 93.5% | 3.59 → 0.42 |
| 250 ms / 256 | none | 277 → 276 | 1.93 → 1.16 | 94.4% | 1.23 → 0.63 |
| 600 ms / 32 | none | 725 → 725 | 10.07 → 2.59 | 93.2% | 8.05 → 1.27 |
| 600 ms / 64 | none | 660 → 661 | 5.61 → 2.56 | 94.3% | 3.78 → 1.33 |
| 600 ms / 256 | none | 626 → 626 | 3.25 → 1.99 | 93.4% | 1.53 → 1.13 |
| 250 ms / 64 | jitter/loss/reorder | 327 → 329 | 6.70 → 1.20 | 94.0% | 5.06 → 0.89 |
| 600 ms / 32 | jitter/loss | 723 → 728 | 10.26 → 3.14 | 93.3% | 9.63 → 2.05 |
| 250 ms / 64 | competing output | 940 → 996 | 7.30 → 2.13 | 91.6% | 5.99 → 1.22 |

These are controlled local Linux/Chromium experiments, not a captured production session. Netem shares the configured physical-direction budget across the separate terminal/workspace TCP connections. The fixed bulk generator emits the same 400 varying log lines in each case. Framed byte totals include Noise/WebSocket and control traffic but exclude IP/TCP/TLS headers and retransmissions; they are not packet captures. Echo and first-output timestamps use in-page renderer mutations. Bulk/reconnect wall time includes automation dispatch and polling overhead. Full p95/p99, reconnect, message-count, CPU and memory details are in the JSON.

The competing-output case deliberately saturates the shared link; its long tail shows that independent sockets and compression cannot remove congestion already present in the network. The output stream remains lossless, so Ctrl-C can be delivered promptly while its visible stop marker is still behind earlier bytes. The protocol regression verifies PTY input commitment during withheld output ACKs separately from this visual catch-up measurement.

Compression decode elapsed time across each complete profile was 5.5–15.8 ms for these workloads. Observed server lifetime high-water RSS was approximately 17.3 MiB; the largest approximate end-profile JS heap sample was 22.0 MiB. These are observed values rather than universal memory limits; replay byte limits, bounded queues and decoder checks enforce the resource invariants.

CPU/battery assessment: the synchronous decoder adds a small amount of measured work and substantially reduces transmitted bytes for bulk text. Real local HTML/SVG clients also passed with mobile sizing and 4× CPU slowdown. CPU timings, memory snapshots and reduced network bytes support the default `auto` setting, with raw fallback and both opt-outs retained. No physical-device battery lifetime or Safari/iOS suspension claim is made. Reassess energy use on target hardware if sustained terminal throughput becomes a primary workload.

A real 100% packet-loss test verified that terminal and workspace transports abandon native closing sockets on deadline. It left the dead terminal at 34.8 s (five-second watchdog sampling), then restored the same shell, queued input and workspace in 139 ms after the link returned. The deterministic client test also proves that malformed output fences later queued packets immediately while native close is pending.

All 94 Rust tests passed, including eight focused resume/network regressions. Client decoder/transport, real protocol, real local-client/IME/TUI/paste, reconnect/cwd, blocked-input takeover, WebGL fallback, workspace continuity, factory lifecycle and workspace protocol suites passed. The decoder suite includes 380 valid vectors, 1,000 mutation differentials and malformed/truncated/trailing/oversized/bomb cases. Physical mobile device and other-browser testing remain deployment-specific validation; no additional browser APIs are required for the bundled synchronous codec.

The optional Mosh extensions were evaluated rather than silently approximated: blind echo cannot safely infer password/non-echo modes, an independent command composer changes shell editing/history/completion semantics, and dropping old ANSI bytes requires a complete server terminal model. They remain explicit future projects. This execution ships the scheduling, pacing, feedback and bounded compression requirements while preserving authoritative lossless terminal behavior.

## Codec CPU and process peak memory

[Resource measurements](terminal-network-resources.json) use the production Rust `output_frame` function extracted verbatim into an isolated release build with the same flate2 Rust backend. Linux thread CPU time excludes compilation and file I/O. The decoder benchmark imports the actual JS module into Node V8; its CPU measurement includes allocations and GC. Each figure is the mean over 2,000 independent 8 KiB blocks after warmup on the recorded Linux/ARM64 host.

| Payload | Encoder CPU with auto (µs/block) | JS decoder CPU (µs/block) | Result |
| --- | ---: | ---: | --- |
| source | 141.8 | 249.2 | compressed |
| logs | 118.5 | 54.6 | compressed |
| entropy | 168.3 | — | raw fallback |

Incompressible bulk still pays the bounded encode attempt before falling back; keystrokes and short prompts skip it entirely. These are codec costs measured on this host.

A separate real-browser stress streams 672,908 source bytes of colored Unicode output through each mode with mobile sizing, DOM rendering and 4× CPU slowdown. Linux `VmHWM` records actual process-lifetime RSS peaks, including browser engine, DOM, startup and terminal history; it is distinct from the approximate end-profile JS heap sample in the WAN results.

| Mode | Maximum active-renderer process peak RSS (MiB) | Server process peak RSS (MiB) | Maximum decoded renderer backlog (KiB) |
| --- | ---: | ---: | ---: |
| raw | 192.1 | 15.8 | 32.0 |
| auto | 199.0 | 17.5 | 31.9 |

Renderer processes differ between runs and RSS includes allocator/engine behavior, so their difference is not an isolated codec-memory estimate. Both completed without backlog growth or input loss. Decoder bounds, in-flight windows and queues remain the enforceable limits; observed RSS is workload-specific. Physical-device battery testing remains a deployment assessment.

### Decoder candidate decision

[Native decoder comparison](terminal-network-native-decoder.json) exercised Chromium's `DecompressionStream('deflate-raw')` in actual local HTML and SVG clients. Both decoded the valid 6,000-byte sample correctly. A raw-DEFLATE encoding of 1 MiB of repeated `x` returned a **65,536-byte first output chunk** in both formats, before application code could check its size. That exceeds the terminal's 8,192-byte budget and confirms why post-read length checks cannot enforce the required pre-allocation bound. The bundled decoder is selected because it validates the declared output length before allocating and checks every write.

Measured encoder/decoder CPU and bundle attribution support retaining the standard level-1 codec. Additional codec complexity is reserved for a measured CPU bottleneck; current latency gains come from scheduling, bounded queues, TCP_NODELAY and avoiding network bytes.
