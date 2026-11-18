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

On shared hosts, run Chromium and Playwright suites one at a time through `bash scripts/run-browser-test.sh node tests/<suite>.cjs`. Coordinate the single browser test slot across agents and finish resource-intensive builds before starting it. See `tests/AGENTS.md` for memory limits and public-matrix usage.

## Interface writing

- Keep interface text concise and elegant. Use short labels such as “Click” and “Hover”.
- Do not add filler, promotional copy, redundant instructions, or explanatory paragraphs for obvious controls. Keep help only when it explains a necessary consequence, error, or security boundary.

## Change rules

- Preserve protocol compatibility unless the task explicitly changes it; coordinate client, server, protocol tests, and relevant docs when wire behavior changes.
- Never expose `EYA_KEY` to child processes or logs. Keep loopback defaults and host/Docker identity checks intact.
- Keep filesystem limits, path normalization, regular-file checks, bounded output, timeouts, and concurrency limits explicit.
- Add or update the narrowest regression test for behavior changes. Do not regenerate protocol bundles unless their source changed and the task needs them.
- Update the relevant focused doc when user-visible behavior, configuration, protocol behavior, or security boundaries change.
- Do not edit unrelated existing changes; this repository may have a dirty worktree.

## Feature additions and release versions

- Read and follow `docs/updates.md` before adding features or changing client/server APIs, configuration, artifacts, or wire behavior. Its release standards and permanent update-v1 contract are requirements.
- Every feature addition must include a SemVer increment in the same change set: MINOR for backwards-compatible additions (reset PATCH to zero), MAJOR for incompatible application API changes (reset MINOR and PATCH to zero). Compatible bug/security fixes increment PATCH. Documentation-only, test-only, and behavior-preserving refactors do not require a release increment. Use one coordinated increment for a cohesive change set, not another increment for each intermediate edit; do not count an unrelated existing worktree bump as the feature's increment.
- Keep `VERSION`, `client/version.js`, the package version in `eya-server/Cargo.toml`, and the `eya-server` entry in `eya-server/Cargo.lock` synchronized. Rebuild generated client artifacts with `node client/build.mjs` before building the server. Build metadata alone does not count as an increment because it cannot trigger a client update.
- New features must preserve deployed wire meanings and baseline behavior, use safe defaults for missing fields, and tolerate unknown optional fields. Negotiate new capabilities and encodings explicitly, select only offered capabilities, and provide a baseline fallback or a clear unsupported-feature result. Never infer feature support from release-number equality or silently reinterpret existing fields/opcodes.
- Every release, including a MAJOR release, must preserve the permanent update-v1 endpoint, authentication, artifact/config contract, size limits, and direct upgrades from every update-capable client version without intermediate installations. Preserve existing authentication/host identity boundaries, session offsets, replay accounting, and mutation safety; an update must not implicitly recreate sessions, rerun startup commands, or replay uncertain mutations.
- Update the focused feature documentation and add the narrowest meaningful regression coverage. Wire/API changes must cover old/new peers, absent/unknown capabilities and fields, and fallback/error behavior. Complete the applicable release gates in `docs/updates.md`, including client rebuild, Cargo fmt/check/test, and update, wire compatibility, terminal/reconnect, and artifact checks when those boundaries are affected. Report any checks that could not be run.
