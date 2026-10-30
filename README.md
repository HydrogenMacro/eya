# Eya

Eya is a single-user browser terminal for a Linux container. The client is one self-contained HTML file. It connects over a WebSocket and uses the Noise `NNpsk0` handshake and encrypted transport with a shared password. The password authenticates both ends; terminal input, output and resizing are encrypted even on `ws://`.

## Run with Docker

The image uses Alpine Linux and includes Bash, tmux and terminal definitions. Additional software can be added in a derived image using Alpine's `apk` package manager.

Build from the project root, then set `EYA_KEY` to any password text you want to use:

```sh
docker build -t eya .
```

Store that output securely as `EYA_KEY`, then start the server (replace the placeholder):

```sh
docker run -d --name eya -p 8080:8080 -e EYA_KEY='your password' eya
```

For a private key in a file, use an environment file with `EYA_KEY=...` and `docker run --env-file ...` instead. Treat Docker configuration and the environment file as secrets. `EYA_BIND` sets the listening address (default `0.0.0.0:8080`), and `EYA_SHELL` selects a shell executable (default `/bin/bash` in the container). Change the published port with Docker's `-p` option.

For compatibility, an `EYA_KEY` that is exactly 64 hexadecimal characters continues to be used as the original raw 32-byte key. All other values are encoded as UTF-8 and hashed with SHA-256 before the Noise handshake. Use the exact same text in the generator and server, including leading or trailing whitespace.

Open the server's `/` page over **HTTPS** or on a trusted network. Enter the server URL and `EYA_KEY`, optionally choose a command to run after each connection and upload a monospaced WOFF2, WOFF, TTF or OTF font (up to 4 MiB), then generate the client. Passwords may contain any text, including whitespace or be empty. The generator appends `/ws` to the URL and embeds the password, command and font in the resulting single HTML file. Open it in desktop Chrome using `file://`, then connect. The generator builds the file in your browser; it does not send the password or font to the server.

The generated HTML contains the shared password and any default command in readable form: anyone with the file can access your terminal. Keep it private and delete old copies when rotating passwords. The client saves the URL and display preferences in browser storage, but does not separately save a password or default command there. Browser storage behavior for local files can vary. The server HTTP endpoint does not provide TLS itself; configure a reverse proxy for HTTPS/WSS, including WebSocket upgrade support.

**Do not open the generator or obtain the client over plain HTTP on an untrusted network.** An attacker who modifies the HTML could steal the password or control the terminal. The same applies to later client updates. The Noise layer protects the terminal session, not the initial client download, DNS metadata, server availability, or compromised client devices. Noise does not prevent traffic analysis or denial of service. Rotate a compromised password by replacing `EYA_KEY` and restarting the container.

The header keeps Connect available at all times, with connection details in a separate panel from terminal settings. The settings include font size, scrollback, theme, cursor style and blinking, whether typing returns to the bottom, and adaptive local echo. Adaptive echo waits for the measured network latency and only predicts printable one-cell ASCII input while viewing live output; it is off by default because it can still expose typed characters when an application is asking for a password. Disable it before entering secrets or using applications with custom input. The terminal is cleared before every new connection. Output flow control bounds buffering on slow clients and a latency indicator reports round-trip time; these do not provide mosh-style roaming or reconnect. Sessions still terminate on disconnect.

The shell runs as the unprivileged `eya` user **inside the container**, not on the host. Container files disappear when the container is removed unless mounted as a volume. Sessions end on disconnect; use `tmux` for processes you want to reconnect to while the container remains running. A reverse proxy should use an idle timeout suitable for interactive sessions.

## Development

Requirements: Node.js, npm, Rust, and Linux. From the project root:

```sh
npm ci --prefix client --ignore-scripts
node client/build.mjs
cargo run --manifest-path eya-server/Cargo.toml
```

Set `EYA_KEY` before starting the server. The build embeds the terminal library, cryptography, CSS and application code into `client.html`, and the server embeds that file at compile time. Rebuild the client **and then the server** after frontend changes. The server embeds `client/generator.html` as well. Update both the server and standalone client together: current clients use an updated output protocol, although the server continues to accept older clients. The server accepts up to eight concurrent connections, including unauthenticated handshakes, which time out after ten seconds.

This is an MVP. Limit access at the network boundary where possible; it has not received an independent security audit. Test your exact browser and network configuration, particularly whether local files can open a `ws://` endpoint and whether local-network permissions are required.

For the integration checks, start the server on `127.0.0.1:18765` with the test key `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` (never use this key for a real server), then run:

```sh
NODE_PATH=client/node_modules client/node_modules/.bin/esbuild tests/noise-client.js --bundle --platform=browser --format=iife --outfile=tests/noise-client.bundle.cjs
node tests/noise-client.bundle.cjs
node tests/noise-client.bundle.cjs bad-key
node tests/noise-client.bundle.cjs tamper
```
