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

Native terminal sessions use `EYA_SHELL`, then the host user's `SHELL`, and finally `/bin/sh`. They start in `EYA_CWD`, then the host user's `HOME`, and otherwise the server's working directory. Docker host sessions use the shell and login environment configured for `EYA_HOST_USER` on the host. The server removes `EYA_KEY` from both kinds of terminal environment. A service manager can provide these variables through a protected environment file; treat that file as a secret.

For compatibility, an `EYA_KEY` that is exactly 64 hexadecimal characters continues to be used as the original raw 32-byte key. All other non-empty values are encoded as UTF-8 and hashed with SHA-256 before the Noise handshake. Use the exact same text in the generator and server, including leading or trailing whitespace.

Open the server's `/` page over **HTTPS** or on a trusted network. Enter the server URL and `EYA_KEY`, optionally choose a command to run after each connection and upload a monospaced WOFF2, WOFF, TTF or OTF font (up to 4 MiB), then choose standalone HTML, compressed HTML, an HTML data URL, or SVG output. Passwords may contain any non-empty text, including whitespace. The generator appends `/ws` to the URL and embeds the password, command and font in the result. Open it directly in a modern browser, then connect. Compressed HTML and data URLs use the browser's gzip streams to reduce the self-contained client substantially and require a modern browser with `CompressionStream` and `DecompressionStream`. Data-URL length limits vary by browser, so prefer the compressed HTML file when embedding a large font. The generator builds everything in your browser; it does not send the password or font elsewhere.

The server frontend also links directly to hosted clients at `/client.html` and `/client.svg`. Both open the same terminal and file workspace with the WebSocket URL and current `EYA_KEY` already filled in; the hosted SVG uses a responsive SVG `foreignObject` shell around the HTML client. Anyone able to load either hosted page receives the shared password, so serve the frontend only over HTTPS or a trusted network and keep network access restricted.

The generator can download either standalone HTML or an interactive standalone SVG. The SVG contains the complete HTML client in a responsive `foreignObject`, so open the SVG directly as a browser document. Browsers intentionally disable scripts and interaction when an SVG is used through an `<img>` element or CSS image, so that form is only a static image and cannot be a terminal.

The generated HTML contains the shared password and any default command in readable form: anyone with the file can access your terminal. Keep it private and delete old copies when rotating passwords. The client saves the URL and display preferences in browser storage, but does not separately save a password or default command there. Browser storage behavior for local files can vary. The server HTTP endpoint does not provide TLS itself; configure a reverse proxy for HTTPS/WSS, including WebSocket upgrade support.

**Do not open the generator or obtain the client over plain HTTP on an untrusted network.** An attacker who modifies the HTML could steal the password or control the terminal. The same applies to later client updates. The Noise layer protects the terminal session, not the initial client download, DNS metadata, server availability, or compromised client devices. Noise does not prevent traffic analysis or denial of service. Rotate a compromised password by replacing `EYA_KEY` and restarting the server.

The header keeps Connect available at all times, with connection details in a separate panel from terminal settings. The settings include font size, scrollback, theme, cursor style and blinking, whether typing returns to the bottom, and adaptive local echo. Adaptive echo waits for the measured network latency and only predicts printable one-cell ASCII input while viewing live output; it is off by default because it can still expose typed characters when an application is asking for a password. Disable it before entering secrets or using applications with custom input. The terminal is cleared before every new connection. Output flow control bounds buffering on slow clients and a latency indicator reports round-trip time; these do not provide mosh-style roaming or reconnect. Sessions still terminate on disconnect.

The **Files** button opens a tabbed file workspace next to or above the terminal. It supports parent-directory entries, directory history, direct path navigation, recursive name search, hidden files, folder creation, upload, per-file action menus, download, rename, recursive deletion, and automatic refresh. Opening a text file creates a CodeMirror editor tab with syntax support and `Ctrl`/`Cmd`+`S`; supported images, video, and audio use the browser's native viewers. Other formats receive a safe generic view with a download action. The panel visibility, side-by-side/stacked split, size, initial directory, refresh interval, hidden-file behavior, editor wrapping, line numbers, and delete confirmation are persisted in searchable settings. See [docs/file-manager.md](docs/file-manager.md) for the complete guide and extension notes.

File operations have the permissions of the native Eya server account. In Docker host mode, Eya reaches the host through `/proc/EYA_HOST_PID/root` while applying the UID, primary group, and supplementary groups resolved for `EYA_HOST_USER`, so terminal and file access share the same host identity. The privileged container must still be treated as full host control and exposed only to trusted users. `EYA_MAX_FILE_BYTES` sets the maximum size of one opened, uploaded, or downloaded file in bytes and defaults to 256 MiB.

On touch devices and narrow screens, a fixed non-scrolling bar sits above the software keyboard with Esc, Tab, sticky Ctrl, Paste, and a direction pad. Drag the pad toward an arrow to send it once; continue holding to repeat it. In the terminal, ordinary touch drags scroll, while a long press followed by a drag selects text. Releasing opens a Copy/Paste/Select-all/Clear menu; right-click opens the same menu on desktop. The file workspace uses the full available area on small screens and restores the terminal when closed. Inputs use a mobile-safe size so focusing path, search, settings, and editor controls does not trigger browser auto-zoom.

The shell runs directly on the host as the native Eya server user or the Docker `EYA_HOST_USER`. Anyone with the generated client and shared password can run terminal commands and use the file service, so use a strong unique password, restrict network access, and do not select root. Sessions end on disconnect; use the host's `tmux` for processes you want to reconnect to. A reverse proxy should use an idle timeout suitable for interactive sessions and file transfers.

## Development

Requirements: Node.js, npm, Rust, and Linux. From the project root:

```sh
npm ci --prefix client --ignore-scripts
node client/build.mjs
cargo run --manifest-path eya-server/Cargo.toml
```

Set `EYA_KEY` before starting the server. The build minifies the bundled JavaScript, combined CSS, and safe inter-tag HTML whitespace into `client.html`, and the server embeds that file at compile time. Rebuild the client **and then the server** after frontend changes. The server also embeds `client/generator.html` and the hosted SVG shell in `client/hosted.svg`. Update both the server and standalone client together: current clients use an updated output protocol, although the server continues to accept older clients. The server accepts up to eight concurrent connections, including unauthenticated handshakes, which time out after ten seconds.

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

Set `EYA_BROWSER_EXECUTABLE` to a Chromium-family browser and `NODE_PATH=client/node_modules` to run `tests/browser.cjs`, `tests/mobile.cjs`, and `tests/file-browser.cjs`. The file-browser test also needs `EYA_TEST_ROOT` pointing to the server's test working directory containing `seed.txt`. These cover the standalone client, responsive touch controls, mobile file layout and input sizing, CodeMirror saves, transfer actions, navigation, search, and searchable settings.
