# Disconnects, buffering, and session resumption

Current Eya clients use protocol v4. The server owns a terminal session independently of its WebSocket connection. A temporary network loss detaches the connection while leaving the PTY, foreground program, shell environment, current directory, and running jobs alive.

The client retries with exponential backoff from 0.5 to 10 seconds. Returning online or making the page visible accelerates a pending reconnect. A heartbeat detects connections that have stopped responding, including a silent network failure rather than a clean WebSocket close. The workspace dims and the status shows reconnecting; it is restored when the same session is attached again.

## Buffering

- Unacknowledged terminal input stays in the page's memory, up to 256 KiB. Typing during an outage adds to that queue and the status reports its size. At the limit, additional input is rejected with a visible error rather than silently discarded. Queued input is transmitted when the session resumes, so text entered offline can execute on reconnection.
- The server retains terminal output until the client acknowledges accepting/rendering it. It buffers up to 4 MiB by default, plus bounded PTY/reader buffers. If that fills, it stops draining the PTY and lets operating-system backpressure pause the writer. It does not discard old output to make room or kill the session.
- PTY input writes run on a separate blocking worker. If an application stops reading stdin, a blocked write does not block the session actor from accepting a reconnect or delivering output.
- Input and output use absolute byte offsets. Replayed input already submitted to the PTY is not written again; replayed output already accepted by the terminal renderer is not displayed again. A new Noise handshake is used for each connection. Encrypted frames and Noise nonces are never reused across connections.

The terminal display is retained on resume. The default connection command is queued once for a new session and is not run again when that session resumes. Automatic reconnect does not steal editor focus.

## Disconnect versus End session

**Disconnect** pauses automatic retries and retains the session. Use **Connect** with the same URL and password to resume it before its retention window expires. Input already queued in the page remains queued. To terminate deliberately, open the Connect dialog while connected and choose **End session**. This stops the PTY, signals its foreground process group, and releases the session slot.

When a shell exits, a session expires, or the server restarts, the client reports that the old session ended. It does not silently create another shell and execute queued input there. Choose **Start new session** explicitly to create a replacement.

Session credentials and input queues are kept in page memory only. Network reconnects are supported; reloading/closing the page or restarting the browser does not restore the old terminal display or its resume token. A session left behind by a closed page expires automatically. Use `tmux` or another host process manager when you also need persistence across browser reloads or server restarts.

## Server configuration

| Variable | Default | Allowed values |
| --- | --- | --- |
| `EYA_SESSION_TTL_SECONDS` | `600` | 1–86,400 seconds |
| `EYA_SESSION_BUFFER_BYTES` | `4194304` | 65,536–67,108,864 bytes |

The retention timer starts when a transport detaches. A silent failed link can take up to 30 seconds to be detected first. Attached sessions do not expire from this timer. Up to eight sessions can exist, including detached sessions, so unexpired sessions still occupy a slot. The timeout and buffer sizes apply to the server process and can be set in its `.env` file. Invalid values fail startup with a configuration error.

Restarting the server (including `just dev`) terminates its in-memory sessions. Retention is not storage on disk.

## Files and CAD

File operations share the connection but are not blindly replayed. Interrupted operations reject their pending promises with a reconnect message; retry uploads, downloads, or saves after resumption. An interrupted upload is canceled and its temporary file is removed. A write or rename whose response was lost may already have completed, so check the filesystem before retrying a mutation. Dirty editors and loaded previews remain in page memory. CAD polling resumes automatically after transport resumption.

## Wire protocol

After the Noise handshake, a v4 client confirms authentication with:

```text
eya-ready-v4:{"token":"<random 32-byte hex token>","output":0,"create":true}
```

The token is generated using browser cryptographic randomness and is only sent through Noise encryption. A reconnect uses the same token, the client's accepted output offset, and `create:false` after the first successful attachment. A missing token cannot be used to create a replacement session on a resume request. Repeated initial requests for a token are atomically mapped to the same actor.

| Type | Direction | Payload |
| --- | --- | --- |
| `0` | client → server | 8-byte big-endian input offset, then UTF-8 input bytes |
| `1` | client → server | terminal columns/rows, unchanged from v3 |
| `2` | client → server | 8-byte absolute output acknowledgement |
| `3` | both | heartbeat/latency timestamp, unchanged from v3 |
| `4`–`6` | both | file messages, unchanged from v3 |
| `7` | server → client | JSON session state: ready, ended, expired, full, or invalid |
| `8` | server → client | 8-byte output offset, then terminal bytes |
| `9` | server → client | 8-byte committed input acknowledgement |
| `10` | client → server | explicit session termination, no payload |

`ready` includes the committed input offset, accepted output offset, and whether this attachment resumed an existing session. Input acknowledgements advance only after the PTY write completes. Input received again while its original write is queued is deduplicated using a separate submitted offset. The client acknowledges output after xterm's write callback; the accepted offset in a resume request also accounts for writes already queued in the surviving renderer.

Legacy v1–v3 clients remain supported with their original transport behavior: their sessions end when their connection closes. Rebuild both client and server to use resumable sessions.

## Verification

`tests/reconnect.cjs` exercises offline input, output produced during an outage, unchanged shell identity, loss of input acknowledgements, output beyond the replay buffer, manual detach/resume, expiration without silently spawning another shell, and explicit termination. For the strongest buffer/expiry checks, start the disposable test server with `EYA_SESSION_BUFFER_BYTES=65536` and `EYA_SESSION_TTL_SECONDS=10`, then run:

```sh
NODE_PATH=client/node_modules EYA_TEST_SESSION_TTL=10 node tests/reconnect.cjs
```
