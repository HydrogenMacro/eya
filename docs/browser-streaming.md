# Browser streaming measurements

The implementation follows the useful controls in [Selkies settings](https://docs.selkies.io/latest/reference/settings/): resolution, JPEG quality and frame rate. Selkies also has inter-frame video encoders; [its component documentation](https://github.com/selkies-project/selkies/blob/main/docs/components/index.md) describes hardware/software codec paths. [Sunshine’s encoder configuration](https://docs.lizardbyte.dev/projects/sunshine/master/md_docs_2configuration.html) documents bitrate control and single-frame buffering for low latency. These projects support the decision to bound work and queued frames, and expose quality/bandwidth tradeoffs.

Eya uses Chromium's native screencast encoder and its existing Noise WebSocket. Scaling at capture avoids sending pixels the user does not need. JPEG quality controls reduce bytes further. Lossless PNG is available for pixel fidelity. Delaying frame ACKs caps presentation rate without introducing a second frame queue. Static pages rely on Chromium's damage-driven capture. The full logical viewport remains unchanged, so input mapping and layout survive resolution changes. Defaults preserve deployed JPEG80 behavior.

Temporal codecs such as H.264/AV1 could improve moving-page compression further but need an additional negotiated encoding, keyframe/recovery handling, decoder support and resource limits. The baseline retains independently decodable image frames and the existing encrypted transport. Version 2.5 adds opt-in lossless changed tiles and bounded scheduling/recovery; see [implemented streaming improvements](browser-streaming-improvements.md) and the [candidate experiments](browser-compression-experiments.md). WebRTC, UDP, hardware video encoding and automatic bitrate adaptation remain future work.

The [compression roadmap](browser-compression-roadmap.md) audits the current pipeline and compares XOR, dirty tiles, scroll reuse, adaptive pacing and temporal codecs, including text-fidelity requirements and a staged validation plan.

## Reproducing the measurement

Build the client/server, then run with a sandbox-capable headless Chromium:

```sh
NODE_PATH=client/node_modules \
EYA_BROWSER_EXECUTABLE=/path/to/chrome-headless-shell \
EYA_STREAM_REPORT=/tmp/eya-stream-results.json \
node tests/browser-stream-benchmark.cjs
```

The benchmark starts a disposable Eya server and drives production browser transport, encoder settings and frame chunking. It renders a 3840×2160 synthetic dashboard with dense text and a seeded, textured image region, changes it six times per preset and decodes each received image with Chromium. Software rendering is forced on the server. It measures encoded frame bytes, estimated Noise/framing overhead, capture-to-receipt time and client decode time. It requires no Internet page. [Raw results](browser-streaming-results.json) were collected on Linux arm64 with Chrome Headless Shell 157.0.8103.38.

| Capture preset | Mean bytes/frame | Reduction from native | Mean capture + loopback transfer | Mean decode |
| --- | ---: | ---: | ---: | ---: |
| Native 4K JPEG80 | 554,865 | — | 237.6 ms | 44.5 ms |
| 1080p JPEG80 | 140,357 | 74.7% | 153.9 ms | 13.9 ms |
| 720p JPEG60 | 44,355 | 92.0% | 111.8 ms | 15.5 ms |
| 540p JPEG40 | 19,099 | 96.6% | 95.3 ms | 12.1 ms |
| 720p PNG | 340,014 | 38.7% | 192.4 ms | 25.7 ms |

At a hypothetical 2 Mbit/s, those payloads plus estimated Noise/framing overhead take about 2221/562/178/77/1361 ms respectively to transfer. These are calculations, not measured WAN latencies; they exclude RTT, WebSocket/TCP overhead, contention and retransmission. Lower-resolution JPEG trades detail for speed, and the scene materially affects compression. Six samples and loopback CPU timings are a controlled comparison, not a production or video-streaming throughput claim. The frame-rate cap further reduces sustained traffic on changing pages; the benchmark does not measure that saving.

`browser-stream-live.cjs` separately covers actual PNG/JPEG negotiation, retained-tab capture, inline/blob image downloads, and an explicit unsupported-feature result before selection. `browser-stream-compatibility.cjs` covers old browser peers, absent/unknown offers and fields, and rejected encodings/operations. `browser-context-actions.cjs` covers menu override/dismissal, text selection actions, icons and stream controls.
