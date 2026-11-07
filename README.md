# Eya

Eya is a single-user browser terminal and file workspace for a Linux host. The client is one self-contained HTML file. It connects over a WebSocket and uses the Noise `NNpsk0` handshake and encrypted transport with a shared password. The password authenticates both ends; terminal traffic, file operations, uploads, and downloads are encrypted even on `ws://`.

## Run with Docker and a host terminal

The Eya server can run in Docker while each terminal session runs on the Linux host. The container uses `nsenter` to join the host namespaces, switches to the host root and working directory, and then uses the host's `su --login` to start a login shell as `EYA_HOST_USER`. The shell therefore uses that host user's filesystem, tools, home, groups, PATH and shell configuration rather than the Alpine image.

This mode deliberately gives the Eya container control of the host. It is not a security boundary: a compromise of the server or image can become a root compromise of the host. Use a trusted image, a strong unique `EYA_KEY`, a non-root `EYA_HOST_USER`, and network restrictions.

Build the image:

```sh
docker build -t eya .
```

Start it on a native Linux Docker Engine. `EYA_CWD` is interpreted inside the host filesystem:

```sh
docker run -d --name eya \
  --restart unless-stopped \
  --privileged \
  --pid=host \
  --userns=host \
  -p 127.0.0.1:8080:8080 \
  -e EYA_KEY='your password' \
  -e EYA_HOST_USER="$(id -un)" \
  -e EYA_CWD="$HOME" \
  eya
```

`--pid=host` makes host PID 1 visible and `--privileged` permits entering its namespaces and root filesystem. `--userns=host` is required when Docker daemon user-namespace remapping is enabled. On Docker Desktop, "host" means the Docker Linux VM, not the macOS or Windows host.

The image sets `EYA_HOST_PID=1`, `EYA_NSENTER=/usr/bin/nsenter`, and `EYA_HOST_SU=/bin/su`. These can be overridden for unusual hosts. `EYA_HOST_USER` is required and is resolved through the host's `/etc/passwd`; the image will not start without it. Publish the port on a non-loopback address only if the surrounding network is trusted and protected.

## Run natively on the host

Eya can also run as a native host process. A terminal session then has the same user, filesystem access, tools, environment and permissions as the Eya server process. Run it under a dedicated host account if you want to limit that access.

Requirements: Rust and Linux. The checked-in `client.html` is embedded in the server, so Node.js is only needed when changing the client.

Build the server from the project root:

```sh
cargo build --release --locked --manifest-path eya-server/Cargo.toml
```

Then set `EYA_KEY` to a non-empty password and start it as the host user whose terminal you want to access:

```sh
EYA_KEY='your password' ./eya-server/target/release/eya-server
```

For local development, the server also loads an optional `.env` file from its working directory or a parent directory. Existing process environment variables take precedence. Keep `.env` private—it is ignored by this repository because it commonly contains `EYA_KEY`. A missing `.env` file is normal; malformed or unreadable files stop startup with an error.

Native Eya listens only on `127.0.0.1:8080` by default. Set `EYA_BIND` explicitly to listen elsewhere, for example `EYA_BIND=0.0.0.0:8080`. The Docker image listens inside its container on `0.0.0.0:8080`, while the example publishes it only on the host loopback interface. Prefer putting an HTTPS reverse proxy or private tunnel in front of it.

The Browser panel uses Linux Chromium on the server. Install Chromium with its normal sandbox support, or run `python3 scripts/install-chrome-headless-shell.py` to install Google's Stable headless shell for the current user; Eya discovers that cached installation automatically. You can also set `EYA_BROWSER_CHROMIUM` to an executable path. Eya launches it on demand with a private temporary profile and validated loopback SOCKS egress. `EYA_BROWSER_GPU_MODE=auto` enables Vulkan when a GPU device is exposed; `off` selects software rendering. See [Browser panel](docs/browser.md) for setup and limits.

Native terminal sessions use `EYA_SHELL`, then the host user's `SHELL`, and finally `/bin/sh`. They start in `EYA_CWD`, then the host user's `HOME`, and otherwise the server's working directory. Docker host sessions use the shell and login environment configured for `EYA_HOST_USER` on the host. The server removes `EYA_KEY` from both kinds of terminal environment. A service manager can provide these variables through a protected environment file; treat that file as a secret.

For compatibility, an `EYA_KEY` that is exactly 64 hexadecimal characters continues to be used as the original raw 32-byte key. All other non-empty values are encoded as UTF-8 and hashed with SHA-256 before the Noise handshake. Use the exact same text in the generator and server, including leading or trailing whitespace.

Open the server's `/` page over **HTTPS** or on a trusted network. Enter the server URL and `EYA_KEY`, optionally choose a command to run for each new session and a custom monospaced WOFF2, WOFF, TTF or OTF font (up to 4 MiB), then choose standalone HTML, compressed HTML, an HTML data URL, or SVG output. Choose one of seven Nerd Fonts in the generator; 0xProto is the default. A custom upload replaces that selection. Passwords may contain any non-empty text, including whitespace. The generator appends `/ws` to the URL and embeds the password, command and custom font in the result. Open it directly in a modern browser, then connect. Compressed HTML and data URLs use the browser's gzip streams to reduce the self-contained client substantially and require a modern browser with `CompressionStream` and `DecompressionStream`. Data-URL length limits vary by browser, so prefer the compressed HTML file when embedding a large font. The generator builds everything in your browser; it does not send the password or font elsewhere.

The server frontend also links directly to hosted clients at `/client.html` and `/client.svg`. Both open the same terminal and file workspace with the WebSocket URL and current `EYA_KEY` already filled in; the hosted SVG uses a responsive SVG `foreignObject` shell around the HTML client. Anyone able to load either hosted page receives the shared password, so serve the frontend only over HTTPS or a trusted network and keep network access restricted.

The generator can download either standalone HTML or an interactive standalone SVG. The SVG contains the complete HTML client in a responsive `foreignObject`, so open the SVG directly as a browser document. Browsers intentionally disable scripts and interaction when an SVG is used through an `<img>` element or CSS image, so that form is only a static image and cannot be a terminal.

The generated HTML contains the shared password and any default command in readable form: anyone with the file can access your terminal. Keep it private and delete old copies when rotating passwords. The client saves the URL and display preferences in browser storage, but does not separately save a password or default command there. Browser storage behavior for local files can vary. The server HTTP endpoint does not provide TLS itself; configure a reverse proxy for HTTPS/WSS, including WebSocket upgrade support.

**Do not open the generator or obtain the client over plain HTTP on an untrusted network.** An attacker who modifies the HTML could steal the password or control the terminal. The same applies to later client updates. The Noise layer protects the terminal session, not the initial client download, DNS metadata, server availability, or compromised client devices. Noise does not prevent traffic analysis or denial of service. Rotate a compromised password by replacing `EYA_KEY` and restarting the server.

The header keeps Connect available at all times, with connection details separate from searchable settings. Appearance settings include Dark, Light, Midnight, and Solarized themes, accent colors, density, corners, and reduced motion. Terminal settings control font size, scrollback, cursor, and scrolling; editor settings control font size, indentation width, wrapping, and line numbers. Temporary disconnects preserve the shell and terminal display, buffer input/output, and trigger automatic resumption with a fresh encrypted connection. A latency indicator reports round-trip time. See [docs/reconnection.md](docs/reconnection.md) for buffering, limits, and expiry.

The **Files** button opens the file browser in a generic panel workbench. It supports parent-directory entries, directory history, direct path navigation, recursive name search, hidden files, folder creation, upload, per-file action menus, download, rename, recursive deletion, and automatic refresh. Opening a text file creates an external CodeMirror editor panel with syntax support and `Ctrl`/`Cmd`+`S`; supported images, video, and audio use external browser-native viewer panels. Other formats receive a generic view with a download action. All panels share draggable tabs, direct split-right/down controls, and resizable sashes. The **+** button opens a starting panel with registered panel types; Terminal and File browser create independent instances. See [docs/file-manager.md](docs/file-manager.md) for file behavior and [docs/panels.md](docs/panels.md) for the factory API.

The starting panel also opens **Task Manager** and **Docker**, with live SVG resource graphs, detail inspectors, searchable/sortable tables, and saved display preferences. Task Manager includes per-core/network performance, process trees, configurable columns, identity-checked controls, and CSV export. Docker includes container/Compose controls, resource histories, filtered/live logs, process inspection, and image/network/volume inventories. Compose files and bind mounts open in the existing editor/file browser; container shells open terminal tabs. Both use the authenticated encrypted connection and the server's machine identity. Docker requires its CLI and daemon access on that machine. See [Task Manager](docs/task-manager.md), [Docker](docs/docker.md), and [machine API/limits](docs/system-panels.md).

The **Browser** panel provides an address bar, navigation, a compact tab menu, and a generic local HTML viewer. Internet pages run in server-side Chromium and are displayed through the authenticated WebSocket. Local HTML files and relative links use the file transport; scripts are disabled. See [Browser panel](docs/browser.md).

File operations have the permissions of the native Eya server account. In Docker host mode, Eya reaches the host through `/proc/EYA_HOST_PID/root` while applying the UID, primary group, and supplementary groups resolved for `EYA_HOST_USER`, so terminal and file access share the same host identity. The privileged container must still be treated as full host control and exposed only to trusted users. `EYA_MAX_FILE_BYTES` sets the maximum size of one opened, uploaded, or downloaded file in bytes and defaults to 256 MiB.

On touch devices and narrow screens, the active panel group fills the workspace and its tabs switch between the browser, previews, and terminal without squeezing them together. A fixed two-row icon key bar provides Esc, Tab, sticky Ctrl, Home/End, Page Up/Down, Copy/Paste, Ctrl+C, Ctrl+D, Backspace, Enter, and a normal-sized directional key. Swipe the directional key to send one arrow; keep the swipe held to transition into key repeat. Panel-boundary touch guards and root overscroll suppression prevent global page scrolling and pull-to-refresh while allowing nested Task Manager scrolling. In the terminal, ordinary touch drags scroll, while a long press followed by a drag selects text. Releasing opens a Copy/Paste/Select-all/Clear menu; right-click opens the same menu on desktop. Inputs and CodeMirror use a mobile-safe 16 px size, and editor focus does not rewrite the workbench height, avoiding automatic focus zoom and disruptive panel resizing.

The shell runs directly on the host as the native Eya server user or the Docker `EYA_HOST_USER`. Anyone with the generated client and shared password can run terminal commands and use the file service, so use a strong unique password, restrict network access, and do not select root. **Disconnect** detaches and retains the session for ten minutes by default; **End session** in the Connect dialog terminates it explicitly. The server buffers up to 4 MiB of output before applying PTY backpressure, and the client retains up to 256 KiB of unacknowledged input. `EYA_SESSION_TTL_SECONDS` and `EYA_SESSION_BUFFER_BYTES` configure server retention and output buffering. Browser reloads and server restarts do not restore page-memory resume state; use the host's `tmux` for longer-lived processes. A reverse proxy should use an idle timeout suitable for interactive sessions and file transfers.

## Development

The [interface guide](docs/interface.md) describes the compact toolbars, Lucide SVG icons, workspace/panel menus, CAD inspection controls, and keyboard shortcuts.

The [client/mobile audit](docs/client-audit.md), [backend audit](docs/backend-audit.md), and [artifact size report](docs/client-sizes.md) document hardening changes, regression coverage, deployment boundaries, and reproducible compression measurements. Generator sources are `client/generator.js` and `client/generator.template.html`; `client/generator.html` is generated by the build.

For code-based 3D modeling, open build123d GLB or STL exports in a CAD panel. It provides orthographic orbit/pan/zoom, shaded/edge/wireframe modes, part visibility, section planes, dimensions, approximate point-distance/angle measurements, and camera-preserving live reload. GLB is recommended for names, colors, and assemblies. See [docs/cad.md](docs/cad.md) for the `ocp_vscode` integration assessment, export workflow, controls, and limitations; runnable examples are in [examples/cad_model.py](examples/cad_model.py) and [examples/watch_cad.py](examples/watch_cad.py).

Requirements: Node.js, npm, Rust, and Linux. From the project root:

```sh
npm ci --prefix client --ignore-scripts
node client/build.mjs
cargo run --manifest-path eya-server/Cargo.toml
```

With [`just`](https://github.com/casey/just) installed, run `just` (or `just dev`) to rebuild the client, stop native server instances from this checkout, and launch `cargo run --locked` in the background. It runs from `eya-server/` so `eya-server/.env` is loaded, and waits for the listening message before reporting success. Logs are in `eya-server/target/dev-server.log`; `just stop` stops the server and `just build` only rebuilds the client. Restarting closes any active terminal sessions.

Set `EYA_KEY` before starting the server. The build minifies the bundled JavaScript, combined CSS, and safe inter-tag HTML whitespace into `client.html`, and the server embeds that file at compile time. Rebuild the client **and then the server** after frontend changes. The server also embeds `client/generator.html` and the hosted SVG shell in `client/hosted.svg`. Update both the server and standalone client together: current clients use resumable protocol v4, although the server continues to accept older clients. The server permits eight terminal sessions, including detached sessions, and separately limits concurrent handshakes to eight. Handshakes time out after ten seconds.

This is an MVP. Limit access at the network boundary where possible; it has not received an independent security audit. Test your exact browser and network configuration, particularly whether local files can open a `ws://` endpoint and whether local-network permissions are required.

For the integration checks, start the server on `127.0.0.1:18765` with the test key `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` (never use this key for a real server), then run:

```sh
NODE_PATH=client/node_modules client/node_modules/.bin/esbuild tests/noise-client.js --bundle --platform=browser --format=iife --outfile=tests/noise-client.bundle.cjs
node tests/noise-client.bundle.cjs
node tests/noise-client.bundle.cjs bad-key
node tests/noise-client.bundle.cjs tamper
NODE_PATH=client/node_modules client/node_modules/.bin/esbuild tests/file-protocol.js --bundle --platform=browser --format=iife --outfile=tests/file-protocol.bundle.cjs
node tests/file-protocol.bundle.cjs
```

Set `EYA_BROWSER_EXECUTABLE` to a Chromium-family browser and `NODE_PATH=client/node_modules` to run `tests/browser.cjs`, `tests/mobile.cjs`, `tests/file-browser.cjs`, `tests/panels.cjs`, and `tests/polish.cjs`. The file-browser test also needs `EYA_TEST_ROOT` pointing to the server's test working directory containing `seed.txt`. These cover the standalone client, responsive touch controls, mobile file layout and input sizing, CodeMirror saves, transfer actions, navigation, search, searchable settings, nested split resizing, keyboard sashes, tab moves, mobile switching across groups, compact toolbars, menu focus/dismissal, and the Settings shortcut.

`tests/panel-factories.cjs` verifies independent terminal sessions, launcher factories, reconnect/restart, and cleanup. `tests/workspace-v2.cjs` checks independent file browsers, upload/deletion, appearance, shortcuts, and live Task Manager data; set `EYA_TEST_DOCUMENT=http://127.0.0.1:18765/client.svg` to run it in the SVG client. `tests/file-browser-races.cjs` uses deferred responses to check navigation/refresh races and focus/menu retention. Machine UI and authenticated protocol tests are documented in [docs/system-panels.md](docs/system-panels.md).
