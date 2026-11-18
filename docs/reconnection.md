# Disconnects, buffering, and session resumption

Current Eya clients use a terminal-independent workspace connection plus protocol-v4 terminal connections. See [workspaces.md](workspaces.md) for server-owned layouts and cross-client discovery. The server owns a terminal session independently of its WebSocket connection. A temporary network loss detaches the connection while leaving the PTY, foreground program, shell environment, current directory, and running jobs alive.

Terminal retries use jittered exponential backoff from 0.4–0.5 seconds up to 8–10 seconds; the independent workspace channel uses 0.5–10 seconds. Returning online or making the page visible accelerates a pending reconnect. A heartbeat detects connections that have stopped responding, including a silent network failure rather than a clean WebSocket close. The workspace dims and the status shows reconnecting; it is restored when the same session is attached again.

## Connection form

The client checks entered credentials after a 650 ms debounce using the existing Noise terminal-v1 handshake. The check closes before sending an application confirmation; it creates no PTY, workspace or retained session. Editing fields or dismissing the dialog aborts it. Checks have a 12-second deadline. Only verified credentials trigger a connection, and the dialog closes on workspace ready. Connecting to a different server from an existing connection still requires an explicit Connect action and the existing workspace-loss confirmation. The form never displays or logs the password except while the user selects Show.

## Buffering

- Unacknowledged terminal input stays in the page's memory, up to 256 KiB. Typing during an outage adds to that queue and the status reports its size. At the limit, additional input is rejected with a visible error rather than silently discarded. Queued input is transmitted when the session resumes, so text entered offline can execute on reconnection.
- The server retains terminal output until the client acknowledges accepting/rendering it. Attached terminals backpressure the producer around their delivery window: initially 8 KiB, adapting within 4–32 KiB from bulk delivery and recent small-flight ACK feedback latency rather than human typing pauses or bulk serialization time. A separate bounded writer prevents a blocked socket from stopping input or reattachment. Detached sessions retain up to 4 MiB by default. One existing ≤8 KiB chunk can cross a replay threshold, with two reader-queue chunks, a bounded carry/blocked-reader chunk and OS PTY buffers outside replay. Already queued PTY output coalesces into at most 8 KiB without waiting to fill a block. If that fills, it stops draining the PTY and lets operating-system backpressure pause the writer. It does not discard old output to make room or kill the session.
- Input is coalesced within the same microtask turn, sent in at most 4 KiB frames and paced to at most 16 KiB awaiting committed ACKs. Keys do not wait for a batching timer. Large pastes retain their byte order, including Ctrl-C; bytes that have not left the page are lost if that page is closed.
- Cumulative output ACKs follow xterm write completion, with an 8 ms tail deadline or 16 KiB threshold. Unchanged terminal sizes are not resent within an attachment.
- PTY input writes run on a separate blocking worker. If an application stops reading stdin, a blocked write does not block the session actor from accepting a reconnect or delivering output.
- Input and output use absolute byte offsets. Replayed input already submitted to the PTY is not written again; replayed output already accepted by the terminal renderer is not displayed again. A new Noise handshake is used for each connection. Encrypted frames and Noise nonces are never reused across connections.

The terminal display is retained on resume. The default connection command is queued once for a new session and is not run again when that session resumes. Automatic reconnect does not steal editor focus. Focusing a retained terminal which is in use by another client automatically takes over that same session, disconnecting its previous attachment. A taken-over notification waits for a new focus action before reclaiming ownership, so visible clients do not fight over the session. Takeover adopts the server input cursor and never replays another attachment’s pending input. Ended or unavailable sessions still require an explicit new-session action.

The working directory belongs to the retained shell, including after `cd` to a path with spaces or quotes. Network recovery, **Disconnect → Connect**, and opening its saved workspace from a new client all reattach that shell. They must not create a replacement terminal or replay a startup command that changes its directory. No browser storage, shell prompt parsing or injected `cd` command is needed. This retention ends when the process exits or the server stops; a new session is a new shell using the configured starting directory.

Output compression is negotiated inside Noise. New peers use independent raw-DEFLATE blocks only for output ≥256 bytes when the complete envelope saves at least 16 bytes; short prompts, input and incompressible output stay raw. Compression happens before encryption. The bundled decoder bounds every allocation/write to the declared length (≤8 KiB), rejects malformed/trailing data and preserves decoded-byte offsets. It is synchronous, so later raw/control messages cannot overtake it. Old peers continue to use raw output. Turn it off in the client generator or set `EYA_TERMINAL_COMPRESSION=off` on the server.

See [terminal-network-plan.md](terminal-network-plan.md) for implementation evidence, measurements and the separately evaluated Mosh-inspired options. Local speculative echo and terminal-state snapshots remain optional future work; authoritative terminal bytes stay lossless.

## Disconnect versus End session

**Disconnect** pauses automatic retries and retains the session. Use **Connect** with the same URL and password to resume it at any later time while the server is running. Input already queued in the page remains queued. To terminate deliberately, use **End session** in that terminal's actions, close its tab, or close it from the Workspaces tab list. This stops the PTY, signals its foreground process group, and releases the session slot.

When a shell exits, a session is explicitly ended, or the server restarts, the client reports that the old session ended. It does not silently create another shell and execute queued input there. Choose **Start new session** explicitly to create a replacement.

Session IDs are discoverable through the authenticated workspace connection and retained in server-owned tab descriptors. Input queues remain in page memory. A new page starts in a fresh Anonymous workspace; select a previously saved workspace explicitly to attach its processes. Anonymous workspaces remain in server memory only for same-page reconnect recovery; explicitly save one before relying on later client restoration. Previously acknowledged terminal scrollback is not guaranteed on a new renderer. Use a host process manager such as `tmux` for processes that must survive an Eya server restart.

## Server configuration

| Variable | Default | Allowed values |
| --- | --- | --- |
| `EYA_SESSION_TTL_SECONDS` | `600` | 1–86,400 seconds; Browser runtimes only, never terminals |
| `EYA_SESSION_BUFFER_BYTES` | `4194304` | 65,536–67,108,864 bytes |
| `EYA_TERMINAL_COMPRESSION` | `auto` | `auto` or `off` |

Terminal sessions have no detached expiry: closing every client leaves their PTYs and bounded replay alive until explicit termination or server shutdown. The existing `EYA_SESSION_TTL_SECONDS` setting now applies only to Browser runtime retention. Anonymous workspace metadata still has its separate ten-minute renewable lease; expiry of that metadata does not terminate a terminal. Save a workspace before closing the page to retain its tab/session references for a new client. Unreferenced terminals remain discoverable and explicitly terminable via authenticated `session.list` / `session.end`.

Terminal clients use a 30–60 second no-authenticated-progress deadline based on smoothed RTT; the terminal server drops inactive attachments after 60 seconds. Authenticated output counts as progress even if a ping is queued behind it. Watchdogs check every five seconds. On timeout the client invalidates the old socket immediately and retries with fresh encryption; it does not wait for a native WebSocket close handshake. The same idempotent cleanup handles handshake deadlines and late close/message events. Workspace services also replace a silently closing transport without waiting for its close event. The independent workspace channel retains its own heartbeat. A silent failed link can take up to 60 seconds to detach first; background browser suspension may delay client timers. The heartbeat deadline replaces a failed connection without ending its terminal. Up to eight sessions can exist, including detached sessions, which keep occupying a slot until ended; reaching the limit rejects new terminals rather than evicting old ones. The buffer sizes apply to the server process and can be set in its `.env` file. Invalid values fail startup with a configuration error.

Restarting the server (including `just dev`) terminates in-memory sessions. Workspace definitions and tab/layout metadata survive in `EYA_STATE_DIR`; expired runtime references remain visible as unavailable.

## Files and CAD

File operations use the independent workspace connection but are not blindly replayed. Interrupted operations reject their pending promises with a reconnect message; retry uploads, downloads, or saves after resumption. An interrupted upload is canceled and its temporary file is removed. A write or rename whose response was lost may already have completed, so check the filesystem before retrying a mutation. Dirty editors and loaded previews remain in page memory. CAD polling resumes automatically after transport resumption.

## Wire protocol

Software releases use SemVer independently of these wire numbers. See [updates.md](updates.md) for the permanent client recovery/update channel, release standards, and opt-in frame-12 extension envelopes. Missing capability selection keeps the existing baseline wire format; reconnect renegotiates capabilities without changing session offsets.

After the Noise handshake, a v4 client confirms authentication with:

```text
eya-ready-v4:{"token":"<random 32-byte hex token>","output":0,"create":true}
```

The legacy field name `token` carries the stable session ID and is only sent through Noise encryption; an ID does not authenticate a connection. New clients also send `client`, `fresh`, and `takeover` as described in [workspaces.md](workspaces.md). A reconnect uses the same token, the client's accepted output offset, and `create:false` once the initial create confirmation has been sent, including when its reply was lost. A missing token cannot be used to create a replacement session on a resume request. Repeated initial requests for a token are atomically mapped to the same actor.

| Type | Direction | Payload |
| --- | --- | --- |
| `0` | client → server | 8-byte big-endian input offset, then UTF-8 input bytes |
| `1` | client → server | terminal columns/rows, unchanged from v3 |
| `2` | client → server | 8-byte absolute output acknowledgement |
| `3` | both | heartbeat/latency timestamp, unchanged from v3 |
| `4`–`6` | both | file messages, unchanged from v3 |
| `7` | server → client | JSON session state: ready, ended, expired, full, invalid, in-use, or taken-over |
| `8` | server → client | 8-byte output offset, then terminal bytes |
| `9` | server → client | 8-byte committed input acknowledgement |
| `10` | client → server | explicit session termination, no payload |
| `11` | server → client | 8-byte decoded output offset, 4-byte decoded length, one independent raw-DEFLATE block (negotiated only) |

A client may add `"compression":"deflate-raw"` to its encrypted confirmation. `ready.compression` is `"deflate-raw"` when both peers agree and `null` otherwise; missing also means raw for older servers. Unsupported capabilities are ignored by the server. `ready.outputWindow` and `ready.maxOutputChunk` report initial bounds; the decoded-byte window can adapt later. Replay re-encodes original bytes using the new attachment's negotiated mode and fresh Noise keys. There is no shared compression dictionary.

`ready` includes the committed `input` offset, the accepted-but-possibly-unwritten `nextInput` cursor, the accepted output offset, and whether this attachment resumed an existing session. A fresh renderer starts new input at `nextInput` and tracks acknowledgments from `input`; it does not replay the former page's queue. Input acknowledgements advance only after the PTY write completes. Input received again while its original write is queued is deduplicated using a separate submitted offset. The client acknowledges output after xterm's write callback; the accepted offset in a resume request also accounts for writes already queued in the surviving renderer.

Legacy v1–v3 clients remain supported with their original transport behavior: their sessions end when their connection closes. Rebuild both client and server to use resumable sessions.

## Verification

`tests/reconnect.cjs` exercises offline input, output produced during an outage, unchanged shell identity and working directory (including spaces/quotes), loss of input acknowledgements, output beyond the replay buffer, manual detach/resume beyond the Browser retention setting, and explicit termination. `tests/workspace-continuity.cjs` also verifies the shell's directory when reopening a saved workspace in a new client with browser storage disabled. These text assertions explicitly use the DOM renderer; `tests/terminal-webgl.cjs` covers WebGL and its fallback separately. The reconnect test starts its own disposable server and state directory, with a 64 KiB replay buffer and a three-second Browser expiry to prove it cannot expire terminals. Run:

```sh
NODE_PATH=client/node_modules EYA_TEST_SESSION_TTL=3 node tests/reconnect.cjs
```

`tests/terminal-detached-lifetime.cjs` closes every client connection, waits beyond a one-second Browser TTL, verifies that a background job ran and the same shell PID/cwd/environment resumes, then checks discovery and explicit end release the detached session. Run with `NODE_PATH=client/node_modules node tests/terminal-detached-lifetime.cjs`.

Process creation is sent once per explicit terminal action. After sending the authenticated create confirmation, reconnection uses `create:false` even if its reply was lost. An uncertain creation is reconciled by ID or reported unavailable; it never becomes an automatic replacement shell. Explicit ends are idempotent and fence late create confirmations with a bounded 30-second cancellation record (1024 maximum), exceeding the ten-second handshake deadline.

Terminal diagnostics are transient: `EyaPanels.call(id, "getState").network` reports RTT, pending input age, sent/unsent counts, renderer backlog, ACK progress, compression/decode counters and reconnects. Authenticated `session.list` entries expose `network` delivery-window, writer-queue, ACK-age and byte counters plus `replayBytes`; attachment counters reset on reattach. No transcript or input content is logged by these metrics. A shrinking window does not retract bytes already sent.

`session.list` includes `terminalTtl:null` (no expiry) and `browserTtl` in seconds. The legacy numeric `ttl` field remains as an alias for Browser retention; it no longer describes terminals. State `expired` remains the compatible response for a terminal ID absent after explicit end or server restart. Detached output remains lossless and bounded: a producer can block on PTY output when the replay buffer fills until a client drains it. Quiet/background work continues normally.

## Terminal pointer input and copying

Terminal text is not selected in place. Mouse buttons (including modified clicks) and wheel scrolling pass through xterm to applications which enable mouse tracking. Without mouse tracking, scrolling moves the normal terminal scrollback. Touch drags scroll that buffer, or send wheel input to mouse-tracking and alternate-screen applications. Legacy mouse-report bytes remain binary rather than being re-encoded as UTF-8.

Choose **Terminal actions → View terminal text**, or the same option in the context menu when application mouse tracking is off, to open a copyable text snapshot. Choose **Screen and scrollback** or **Visible screen**, select text normally, or use **Copy text**. **Refresh terminal text** captures newer output without modifying the terminal. Alternate-screen applications expose their active buffer. Soft-wrapped rows are joined, and the snapshot is bounded by the configured terminal scrollback.


Terminal HTTP(S) links open in Eya's Browser panel by default. **Settings → Terminal → Open links in** can instead choose a new browser tab. Ordinary URL text and OSC 8 links use the same destination; URL detection follows soft-wrapped rows and rejects executable/non-web schemes. Link handling leaves terminal mouse-tracking input intact.

**Terminal actions → Zoom in / Zoom out**, also available in the terminal context menu, change the terminal font size within 8–36 pixels and refit its rows and columns. The font preference is saved with workspace settings; zoom does not recreate the terminal session.
