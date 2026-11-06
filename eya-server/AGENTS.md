# Rust server guide

The server is Linux-specific and embeds the generated browser artifacts at compile time.

## Source map

- `src/main.rs`: configuration, HTTP routes, Noise handshake, PTY lifecycle, legacy/current transport dispatch, file-message framing, and native/host terminal commands.
- `src/files.rs`: logical-to-physical path mapping, host identity switching, bounded listing/search, safe regular-file I/O, uploads, rename, and deletion.
- `src/resume.rs`: protocol-v4 session registry, PTY replay buffers, input/output offsets, detach/reattach, expiry, and per-session machine jobs.
- `src/system.rs`: `/proc` statistics plus validated, bounded process and Docker/Compose operations.

Behavioral details live in `../docs/reconnection.md`, `../docs/file-manager.md`, and `../docs/system-panels.md`.

## Invariants

- `EYA_KEY` authenticates the Noise `NNpsk0` transport and must not reach shells, machine commands, or logs.
- Native mode defaults to `127.0.0.1`; broader exposure must remain an explicit `EYA_BIND` choice.
- Docker host mode must consistently use the configured host PID/user identity across terminals, files, and system commands.
- Do not weaken path normalization, regular-file checks, atomic upload replacement, identifier validation, output caps, deadlines, semaphore limits, or session-buffer bounds.
- Avoid blocking Tokio workers. Filesystem identity work belongs in the existing blocking boundary; external processes need bounded output and timeouts.
- Wire changes must stay synchronized with `client/app.js`, `client/terminal-panel.js`, `tests/*protocol.js`, and `docs/reconnection.md` as applicable.

## Checks

Run from any directory:

```sh
cargo fmt --manifest-path eya-server/Cargo.toml --check
cargo check --locked --manifest-path eya-server/Cargo.toml
cargo test --locked --manifest-path eya-server/Cargo.toml
```

Set `EYA_TEST_DOCKER=1` only when intentionally running the real read-only Docker integration test. Frontend changes must run `node client/build.mjs` before a server build because `main.rs` uses `include_str!`.
