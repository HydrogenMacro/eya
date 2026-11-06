# Eya repository guide

Eya is a single-user Linux terminal and file workspace. A self-contained browser client talks to a Rust server over one Noise-encrypted WebSocket transport. Treat changes to authentication, host execution, filesystem access, session resumption, and Docker controls as security-sensitive.

## Start here

- Read `docs/codebase-map.md` for architecture and feature-to-file routing.
- Read only the feature document linked from `docs/README.md`; do not scan every document.
- Prefer source files and focused `rg` queries. `.ignore` hides generated bundles and lockfiles from default searches.
- `client.html` and `client/generator.html` are generated. Edit `client/` sources, then run `node client/build.mjs`.
- The Rust binary embeds the generated client artifacts with `include_str!`; rebuild the client before compiling the server after frontend changes.

## Repository map

- `client/`: browser source, templates, styles, build script, and dependency manifest.
- `eya-server/src/`: Rust HTTP/WebSocket server, PTY, files, resumable sessions, and system/Docker operations.
- `tests/`: Node protocol tests and Playwright browser tests.
- `docs/`: focused behavior and design notes; `docs/README.md` is the index.
- `examples/`: optional build123d CAD examples.
- `client.html`: generated standalone client embedded by the server.

Directory-specific `AGENTS.md` files contain the details for `client/`, `eya-server/`, and `tests/`.

## Common commands

```sh
npm ci --prefix client --ignore-scripts
node client/build.mjs
cargo fmt --manifest-path eya-server/Cargo.toml --check
cargo check --locked --manifest-path eya-server/Cargo.toml
cargo test --locked --manifest-path eya-server/Cargo.toml
```

`just build` rebuilds browser artifacts. `just dev` also stops and restarts this checkout's native server, so do not use it when preserving an active session matters.

## Change rules

- Preserve protocol compatibility unless the task explicitly changes it; coordinate client, server, protocol tests, and relevant docs when wire behavior changes.
- Never expose `EYA_KEY` to child processes or logs. Keep loopback defaults and host/Docker identity checks intact.
- Keep filesystem limits, path normalization, regular-file checks, bounded output, timeouts, and concurrency limits explicit.
- Add or update the narrowest regression test for behavior changes. Do not regenerate protocol bundles unless their source changed and the task needs them.
- Update the relevant focused doc when user-visible behavior, configuration, protocol behavior, or security boundaries change.
- Do not edit unrelated existing changes; this repository may have a dirty worktree.
