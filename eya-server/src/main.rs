mod browser;
mod browser_egress;
mod browser_render;
mod browser_tiles;
mod control;
mod files;
mod resume;
mod server_config;
mod session_ends;
mod system;
mod updates;
mod wire;
mod workspaces;

use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::{Html, IntoResponse},
    routing::get,
    serve::ListenerExt,
};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    io::{self, Read, Write},
    os::unix::fs::MetadataExt,
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt},
    sync::{Semaphore, mpsc},
    time::timeout,
};

const PROTOCOL: &str = "Noise_NNpsk0_25519_ChaChaPoly_BLAKE2b";
const PROLOGUE: &[u8] = b"eya-terminal-v1";
const CLIENT: &str = include_str!("../../client.html");
const SVG_CLIENT: &str = include_str!("../../client/hosted.svg");
const GENERATOR: &str = include_str!("../../client/generator.html");
const CLIENT_CONFIG_MARKER: &str = r#"<script id="eya-config" type="application/json">{}</script>"#;
#[derive(Clone)]
struct App {
    key: Arc<[u8; 32]>,
    client_key: Arc<str>,
    slots: Arc<server_config::Slots>,
    terminal: Arc<CommandBuilder>,
    files: Arc<files::FileManager>,
    sessions: resume::Registry,
    session_slots: Arc<server_config::Slots>,
    resume_limits: resume::Limits,
    server_config: Arc<server_config::Config>,
    machine_slots: Arc<server_config::Slots>,
    browser_slots: Arc<server_config::Slots>,
    browser_render_slots: Arc<server_config::Slots>,
    browser: Arc<browser::Proxy>,
    workspaces: Arc<std::sync::Mutex<workspaces::Store>>,
    control_slots: Arc<server_config::Slots>,
    update_slots: Arc<Semaphore>,
    browser_sessions: browser_render::Registry,
    shutdown: tokio::sync::watch::Sender<bool>,
    session_ends: Arc<session_ends::SessionEnds>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if browser_render::cgroup_exec_requested() {
        browser_render::exec_browser_in_cgroup_from_args().map_err(io::Error::other)?;
        return Ok(());
    }
    if let Err(error) = dotenvy::dotenv()
        && !error.not_found()
    {
        return Err(error.into());
    }
    let key = env::var("EYA_KEY").map_err(|_| "EYA_KEY is required")?;
    if key.is_empty() {
        return Err("EYA_KEY must not be empty".into());
    }
    let client_key: Arc<str> = key.clone().into();
    let key = derive_key(&key);
    let terminal = terminal_command()?;
    let files = files::FileManager::from_env()?;
    system::start_history(&files);
    // A session has the privileges of this host process, so do not expose it to
    // the network unless the operator explicitly opts in with EYA_BIND.
    let bind = env::var("EYA_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let (shutdown, _) = tokio::sync::watch::channel(false);
    let server_config = server_config::Config::from_env()?;
    let app = App {
        key: Arc::new(key),
        client_key,
        slots: server_config.slots("handshakeConnections"),
        terminal: Arc::new(terminal),
        files: Arc::new(files),
        sessions: Arc::new(std::sync::Mutex::new(HashMap::new())),
        session_slots: server_config.slots("terminalSessions"),
        resume_limits: resume::Limits::from_env()?,
        server_config: server_config.clone(),
        machine_slots: server_config.slots("machineJobs"),
        browser_slots: server_config.slots("basicBrowserConnections"),
        browser_render_slots: server_config.slots("fullBrowserRuntimes"),
        browser: Arc::new(browser::Proxy::new()?),
        workspaces: Arc::new(std::sync::Mutex::new(workspaces::Store::from_env()?)),
        control_slots: server_config.slots("workspaceConnections"),
        update_slots: Arc::new(Semaphore::new(4)),
        browser_sessions: Arc::new(std::sync::Mutex::new(HashMap::new())),
        shutdown,
        session_ends: Arc::new(session_ends::SessionEnds::default()),
    };
    let router = Router::new()
        .route("/", get(|| async { Html(GENERATOR) }))
        .route(
            "/fonts/{name}",
            get(
                |axum::extract::Path(name): axum::extract::Path<String>| async move {
                    let font: Option<&'static [u8]> = match name.as_str() {
                        "0xproto" => Some(include_bytes!("../../client/fonts/0xProto.woff2")),
                        "jetbrains" => {
                            Some(include_bytes!("../../client/fonts/JetBrainsMono.woff2"))
                        }
                        "firacode" => Some(include_bytes!("../../client/fonts/FiraCode.woff2")),
                        "cascadia" => Some(include_bytes!("../../client/fonts/CascadiaCove.woff2")),
                        "iosevka" => Some(include_bytes!("../../client/fonts/Iosevka.woff2")),
                        "inconsolata" => {
                            Some(include_bytes!("../../client/fonts/Inconsolata.woff2"))
                        }
                        "sourcecodepro" => {
                            Some(include_bytes!("../../client/fonts/SourceCodePro.woff2"))
                        }
                        _ => None,
                    };
                    font.map(|bytes| ([("content-type", "font/woff2")], bytes))
                        .ok_or(axum::http::StatusCode::NOT_FOUND)
                },
            ),
        )
        .route(
            "/eya-media/player.html",
            get(|| async {
                (
                    [
                        ("content-type", "text/html; charset=utf-8"),
                        ("cache-control", "no-store"),
                    ],
                    include_str!("../../client/media-player.html"),
                )
            }),
        )
        .route(
            "/eya-media/player.js",
            get(|| async {
                (
                    [
                        ("content-type", "text/javascript; charset=utf-8"),
                        ("cache-control", "no-store"),
                    ],
                    include_str!("../../client/media-player.js"),
                )
            }),
        )
        .route(
            "/eya-media/keybinds-core.js",
            get(|| async {
                (
                    [
                        ("content-type", "text/javascript; charset=utf-8"),
                        ("cache-control", "no-store"),
                    ],
                    include_str!("../../client/keybinds-core.js"),
                )
            }),
        )
        .route(
            "/eya-media/ids.js",
            get(|| async {
                (
                    [
                        ("content-type", "text/javascript; charset=utf-8"),
                        ("cache-control", "no-store"),
                    ],
                    include_str!("../../client/ids.js"),
                )
            }),
        )
        .route(
            "/eya-media/controls.js",
            get(|| async {
                (
                    [
                        ("content-type", "text/javascript; charset=utf-8"),
                        ("cache-control", "no-store"),
                    ],
                    include_str!("../../client/video-controls.js"),
                )
            }),
        )
        .route(
            "/eya-media/video-cues.js",
            get(|| async {
                (
                    [
                        ("content-type", "text/javascript; charset=utf-8"),
                        ("cache-control", "no-store"),
                    ],
                    include_str!("../../client/video-cues.js"),
                )
            }),
        )
        .route(
            "/eya-media/video-seek-preview.js",
            get(|| async {
                (
                    [
                        ("content-type", "text/javascript; charset=utf-8"),
                        ("cache-control", "no-store"),
                    ],
                    include_str!("../../client/video-seek-preview.js"),
                )
            }),
        )
        .route(
            "/eya-media/video-subtitle-settings.js",
            get(|| async {
                (
                    [
                        ("content-type", "text/javascript; charset=utf-8"),
                        ("cache-control", "no-store"),
                    ],
                    include_str!("../../client/video-subtitle-settings.js"),
                )
            }),
        )
        .route(
            "/eya-media/worker.js",
            get(|| async {
                (
                    [
                        ("content-type", "text/javascript; charset=utf-8"),
                        ("cache-control", "no-store"),
                    ],
                    include_str!("../../client/media-worker.js"),
                )
            }),
        )
        .route("/client.html", get(hosted_client))
        .route(
            "/client-template.html",
            get(|| async {
                (
                    [
                        ("content-type", "text/html; charset=utf-8"),
                        ("cache-control", "no-store"),
                    ],
                    CLIENT,
                )
            }),
        )
        .route(
            "/client.svg",
            get(|| async {
                (
                    [
                        ("content-type", "image/svg+xml; charset=utf-8"),
                        ("cache-control", "no-store"),
                    ],
                    SVG_CLIENT,
                )
            }),
        )
        .route("/ws", get(upgrade))
        .route("/ws/update", get(updates::upgrade))
        .route("/browser-ws", get(browser::upgrade))
        .route("/browser-render-ws", get(browser_render::upgrade))
        .with_state(app.clone());
    let listener = tokio::net::TcpListener::bind(&bind)
        .await?
        .tap_io(|socket| {
            // An input ACK and its terminal echo are independent small frames.
            // Nagle can otherwise hold the echo for another slow-link RTT while
            // the ACK's TCP acknowledgement is still travelling back.
            if let Err(error) = socket.set_nodelay(true) {
                eprintln!("Could not enable TCP_NODELAY: {error}");
            }
        });
    eprintln!("Eya listening on {bind}");
    tokio::select! {
        result = axum::serve(listener, router).into_future() => result?,
        _ = shutdown_signal() => {
            app.shutdown.send_replace(true);
            let terminals: Vec<_> = app.sessions.lock().map(|sessions| sessions.values().cloned().collect()).unwrap_or_default();
            let browsers: Vec<_> = app.browser_sessions.lock().map(|sessions| sessions.values().cloned().collect()).unwrap_or_default();
            let mut requests = tokio::task::JoinSet::new();
            for sender in terminals { requests.spawn(async move { let _ = timeout(Duration::from_millis(500), sender.send(resume::Command::End)).await; }); }
            for sender in browsers { requests.spawn(async move { let _ = timeout(Duration::from_millis(500), sender.send(browser_render::SessionCommand::End)).await; }); }
            while requests.join_next().await.is_some() {}
            let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
            loop {
                let terminals = app.sessions.lock().map(|sessions| sessions.is_empty()).unwrap_or(true) && app.session_slots.active() == 0;
                let browsers = app.browser_sessions.lock().map(|sessions| sessions.is_empty()).unwrap_or(true) && app.browser_render_slots.active() == 0;
                if terminals && browsers { break; }
                // A stuck host syscall must not hold shutdown forever. Closing
                // process fds releases PTYs; Chromium also has a parent-death signal.
                if tokio::time::Instant::now() >= deadline { std::process::exit(0); }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
    Ok(())
}

async fn shutdown_signal() {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("install SIGTERM handler");
    tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
}

async fn hosted_client(State(app): State<App>) -> impl IntoResponse {
    let configured = configured_client(app.client_key.as_ref());
    (
        [
            ("content-type", "text/html; charset=utf-8"),
            ("cache-control", "no-store"),
        ],
        configured,
    )
}

fn configured_client(client_key: &str) -> String {
    let config = serde_json::json!({ "key": client_key, "hosted": true })
        .to_string()
        .replace('<', "\\u003c");
    CLIENT.replacen(
        CLIENT_CONFIG_MARKER,
        &format!(r#"<script id="eya-config" type="application/json">{config}</script>"#),
        1,
    )
}

fn derive_key(secret: &str) -> [u8; 32] {
    // Retain compatibility with the original 32-byte hexadecimal key format.
    // Any other text is a valid password and is deterministically expanded for Noise.
    if secret.len() == 64
        && let Ok(key) = hex::decode(secret).and_then(|key| {
            key.try_into()
                .map_err(|_| hex::FromHexError::InvalidStringLength)
        })
    {
        return key;
    }
    Sha256::digest(secret.as_bytes()).into()
}
async fn upgrade(State(app): State<App>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.max_message_size(65535)
        .max_frame_size(65535)
        .on_upgrade(move |socket| session(socket, app))
}
async fn session(socket: WebSocket, app: App) {
    let Ok(slot) = app.slots.clone().try_acquire_owned() else {
        return;
    };
    if let Err(err) = timeout(
        Duration::from_secs(10),
        handshake_and_run(
            socket,
            app.key.clone(),
            app.terminal.clone(),
            app.files.clone(),
            slot,
            app.clone(),
        ),
    )
    .await
    {
        eprintln!("connection timed out: {err}");
    }
}
async fn handshake_and_run(
    mut socket: WebSocket,
    key: Arc<[u8; 32]>,
    terminal: Arc<CommandBuilder>,
    files: Arc<files::FileManager>,
    slot: server_config::Permit,
    app: App,
) {
    let Ok(params) = PROTOCOL.parse() else { return };
    let Ok(mut noise) = snow::Builder::new(params)
        .psk(0, key.as_ref())
        .prologue(PROLOGUE)
        .build_responder()
    else {
        return;
    };
    let Some(Ok(Message::Binary(first))) = socket.recv().await else {
        return;
    };
    let mut buf = vec![0u8; 65535];
    if noise.read_message(&first, &mut buf).is_err() {
        return;
    }
    let Ok(n) = noise.write_message(&[], &mut buf) else {
        return;
    };
    if socket
        .send(Message::Binary(buf[..n].to_vec().into()))
        .await
        .is_err()
    {
        return;
    }
    let Ok(mut noise) = noise.into_transport_mode() else {
        return;
    };
    // The first encrypted message proves the initiator completed the handshake before a shell is spawned.
    let Some(Ok(Message::Binary(confirm))) = socket.recv().await else {
        return;
    };
    let Ok(n) = noise.read_message(&confirm, &mut buf) else {
        return;
    };
    if *app.shutdown.borrow() {
        return;
    }
    if let Some(ready) = buf[..n].strip_prefix(b"eya-workspace-v1:") {
        let Ok(ready) = serde_json::from_slice::<serde_json::Value>(ready) else {
            return;
        };
        let Ok(permit) = app.control_slots.clone().try_acquire_owned() else {
            return;
        };
        drop(slot);
        tokio::spawn(async move {
            let _permit = permit;
            control::run(socket, noise, ready, app).await;
        });
        return;
    }
    if let Some(ready) = buf[..n].strip_prefix(b"eya-ready-v4:") {
        drop(slot);
        resume::attach(socket, noise, ready, app).await;
        return;
    }
    let flow_control = match &buf[..n] {
        b"eya-ready" => false,
        b"eya-ready-v2" | b"eya-ready-v3" => true,
        _ => return,
    };
    // The timeout applies to the handshake only, not the interactive session.
    let Ok(session_slot) = app.session_slots.try_acquire_owned() else {
        return;
    };
    tokio::spawn(async move {
        let _slot = slot;
        let _session_slot = session_slot;
        run_terminal(
            socket,
            noise,
            flow_control,
            terminal,
            files,
            app.shutdown.subscribe(),
        )
        .await;
    });
}
async fn run_terminal(
    socket: WebSocket,
    mut noise: snow::TransportState,
    flow_control: bool,
    terminal: Arc<CommandBuilder>,
    files: Arc<files::FileManager>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    if *shutdown.borrow() {
        return;
    }
    let pty = native_pty_system();
    let Ok(pair) = pty.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }) else {
        return;
    };
    let command = terminal.as_ref().clone();
    let Ok(mut child) = pair.slave.spawn_command(command) else {
        return;
    };
    drop(pair.slave);
    let Ok(mut reader) = pair.master.try_clone_reader() else {
        let _ = child.kill();
        return;
    };
    let Ok(mut writer) = pair.master.take_writer() else {
        let _ = child.kill();
        return;
    };
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(32);
    tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let (mut sender, mut receiver) = socket.split();
    let mut plain = vec![0u8; 65535];
    let mut cipher = vec![0u8; 65535];
    let mut outstanding = 0usize;
    let mut uploads = HashMap::<u32, files::Upload>::new();
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            msg = receiver.next() => match msg {
                Some(Ok(Message::Binary(data))) => {
                    let Ok(n) = noise.read_message(&data, &mut plain) else { break };
                    if n == 0 { break }
                    match plain[0] {
                        0 => if writer.write_all(&plain[1..n]).is_err() { break },
                        1 if n == 5 => { let cols = u16::from_be_bytes([plain[1], plain[2]]); let rows = u16::from_be_bytes([plain[3], plain[4]]); if cols > 0 && rows > 0 && cols <= 1000 && rows <= 1000 { let _ = pair.master.resize(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 }); } },
                        2 if flow_control && n == 5 => { let ack = u32::from_be_bytes([plain[1], plain[2], plain[3], plain[4]]) as usize; if ack > outstanding { break; } outstanding -= ack; },
                        3 if flow_control && n == 9 => { let Ok(size) = noise.write_message(&plain[..n], &mut cipher) else { break }; if sender.send(Message::Binary(cipher[..size].to_vec().into())).await.is_err() { break; } },
                        4 if flow_control => {
                            if handle_file_request(&plain[1..n], &files, &mut uploads, &mut sender, &mut noise, &mut cipher).await.is_err() { break; }
                        },
                        5 if flow_control && n >= 6 => {
                            let id = u32::from_be_bytes([plain[1], plain[2], plain[3], plain[4]]);
                            let final_chunk = plain[5] != 0;
                            let Some(mut upload) = uploads.remove(&id) else {
                                if send_file_error(id, "upload is not active", &mut sender, &mut noise, &mut cipher).await.is_err() { break; }
                                continue;
                            };
                            if let Err(err) = upload.write(&plain[6..n]).await {
                                upload.cancel().await;
                                if send_file_error(id, &err.to_string(), &mut sender, &mut noise, &mut cipher).await.is_err() { break; }
                            } else if final_chunk {
                                match upload.finish().await {
                                    Ok(()) => if send_file_json(serde_json::json!({"id": id, "ok": true, "op": "write", "done": true}), &mut sender, &mut noise, &mut cipher).await.is_err() { break; },
                                    Err(err) => if send_file_error(id, &err.to_string(), &mut sender, &mut noise, &mut cipher).await.is_err() { break; },
                                }
                            } else {
                                uploads.insert(id, upload);
                            }
                        },
                        _ => break,
                    }
                },
                Some(Ok(Message::Ping(data))) => if sender.send(Message::Pong(data)).await.is_err() { break },
                Some(Ok(Message::Pong(_))) => {},
                Some(Ok(Message::Close(_))) => { let _ = sender.flush().await; break },
                _ => break,
            },
            data = rx.recv(), if !flow_control || outstanding < 256 * 1024 => match data {
                Some(data) => {
                    let len = data.len();
                    let payload = if flow_control {
                        let mut framed = Vec::with_capacity(len + 1);
                        framed.push(0);
                        framed.extend_from_slice(&data);
                        framed
                    } else {
                        data
                    };
                    let Ok(n) = noise.write_message(&payload, &mut cipher) else { break };
                    if sender.send(Message::Binary(cipher[..n].to_vec().into())).await.is_err() {
                        break;
                    }
                    if flow_control {
                        outstanding += len;
                    }
                },
                None => break,
            }
        }
    }
    for (_, upload) in uploads {
        upload.cancel().await;
    }
    // Signal the PTY's foreground job as well as the shell. Detached tmux servers
    // have their own process group and can outlive this connection.
    if let Some(group) = pair.master.process_group_leader()
        && group > 1
    {
        unsafe {
            libc::kill(-group, libc::SIGHUP);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

async fn handle_file_request<S: futures_util::Sink<Message> + Unpin>(
    data: &[u8],
    files: &files::FileManager,
    uploads: &mut HashMap<u32, files::Upload>,
    sender: &mut S,
    noise: &mut snow::TransportState,
    cipher: &mut [u8],
) -> io::Result<()> {
    let request: serde_json::Value =
        serde_json::from_slice(data).map_err(|_| invalid_config("invalid file request"))?;
    let id = request
        .get("id")
        .and_then(|value| value.as_u64())
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| invalid_config("invalid file request id"))?;
    let op = request
        .get("op")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let path = request
        .get("path")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let result: io::Result<()> = async {
        match op {
            op if op.starts_with("system.") || op.starts_with("docker.") || op.starts_with("compose.") => {
                let mut response = system::handle(op, &request, files).await?;
                response["id"] = id.into(); response["ok"] = true.into(); response["op"] = op.into();
                send_file_json(response, sender, noise, cipher).await
            }
            "stat" => {
                let (path, metadata) = files.metadata(path).await?;
                send_file_json(serde_json::json!({"id": id, "ok": true, "op": op, "path": path, "size": metadata.len(), "version": file_version(&metadata)}), sender, noise, cipher).await
            }
            "list" => {
                let show_hidden = request.get("showHidden").and_then(|value| value.as_bool()).unwrap_or(false);
                let (path, entries) = files.list(path, show_hidden).await?;
                let entries: Vec<_> = entries.into_iter().map(files::Entry::into_json).collect();
                send_file_json(serde_json::json!({"id": id, "ok": true, "op": op, "path": path, "entries": entries, "initial": files.initial()}), sender, noise, cipher).await
            }
            "search" => {
                let query = request.get("query").and_then(|value| value.as_str()).unwrap_or("");
                let show_hidden = request.get("showHidden").and_then(|value| value.as_bool()).unwrap_or(false);
                let (path, entries) = files.search(path, query, show_hidden).await?;
                let entries: Vec<_> = entries.into_iter().map(files::Entry::into_json).collect();
                send_file_json(serde_json::json!({"id": id, "ok": true, "op": op, "path": path, "query": query, "entries": entries}), sender, noise, cipher).await
            }
            "mkdir" => {
                let path = files.mkdir(path).await?;
                send_file_json(serde_json::json!({"id": id, "ok": true, "op": op, "path": path}), sender, noise, cipher).await
            }
            "rename" => {
                let new_path = request.get("newPath").and_then(|value| value.as_str()).ok_or_else(|| invalid_config("newPath is required"))?;
                let path = files.rename(path, new_path).await?;
                send_file_json(serde_json::json!({"id": id, "ok": true, "op": op, "path": path}), sender, noise, cipher).await
            }
            "delete" => {
                let recursive = request.get("recursive").and_then(|value| value.as_bool()).unwrap_or(false);
                files.remove(path, recursive).await?;
                send_file_json(serde_json::json!({"id": id, "ok": true, "op": op}), sender, noise, cipher).await
            }
            "read" | "read_range" => {
                let (logical, initial_metadata) = files.metadata(path).await?;
                if !initial_metadata.is_file() { return Err(invalid_config("only regular files can be opened")); }
                let mut file = files.open(path).await?;
                let metadata = file.metadata().await?;
                if !metadata.is_file() { return Err(invalid_config("only regular files can be opened")); }
                let (offset, length) = if op == "read_range" {
                    let offset = request.get("offset").and_then(|v| v.as_u64()).ok_or_else(|| invalid_config("valid offset is required"))?;
                    let length = request.get("length").and_then(|v| v.as_u64()).filter(|v| *v > 0 && *v <= 1024 * 1024).ok_or_else(|| invalid_config("length must be between 1 and 1048576"))?;
                    if offset > metadata.len() { return Err(invalid_config("offset is beyond the end of the file")); }
                    if let Some(version) = request.get("version").and_then(|v| v.as_str()) {
                        if version != file_version(&metadata) { return Err(invalid_config("file changed since the previous read")); }
                    }
                    (offset, length.min(metadata.len() - offset))
                } else {
                    if metadata.len() > files.max_file_bytes { return Err(invalid_config("file exceeds the configured transfer limit")); }
                    (0, metadata.len())
                };
                file.seek(std::io::SeekFrom::Start(offset)).await?;
                send_file_json(serde_json::json!({"id": id, "ok": true, "op": op, "path": logical, "size": metadata.len(), "offset": offset, "length": length, "version": file_version(&metadata), "modified": metadata.modified().ok().and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok()).and_then(|value| u64::try_from(value.as_millis()).ok()).unwrap_or(0)}), sender, noise, cipher).await?;
                let mut buffer = vec![0u8; 60_000];
                if length == 0 { send_file_chunk(id, true, &[], sender, noise, cipher).await?; }
                let mut remaining = length;
                while remaining > 0 {
                    let limit = remaining.min(buffer.len() as u64) as usize;
                    let read = file.read(&mut buffer[..limit]).await?;
                    if read == 0 { return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "file changed while it was being read")); }
                    remaining -= read as u64;
                    send_file_chunk(id, remaining == 0, &buffer[..read], sender, noise, cipher).await?;
                }
                Ok(())
            }
            "write" => {
                let size = request.get("size").and_then(|value| value.as_u64()).ok_or_else(|| invalid_config("upload size is required"))?;
                let overwrite = request.get("overwrite").and_then(|value| value.as_bool()).unwrap_or(false);
                if uploads.contains_key(&id) { return Err(invalid_config("upload id is already active")); }
                if uploads.len() >= 8 { return Err(invalid_config("too many active uploads; finish or reconnect before starting more")); }
                let mut upload = files.begin_upload(id, path, size, overwrite).await?;
                if let Some(version) = request.get("version") {
                    let Some(version) = version.as_str().filter(|version| version.len() <= 256) else { upload.cancel().await; return Err(invalid_config("invalid expected file version")); };
                    upload.require_version(version.to_owned());
                }
                uploads.insert(id, upload);
                send_file_json(serde_json::json!({"id": id, "ok": true, "op": op, "ready": true}), sender, noise, cipher).await
            }
            _ => Err(invalid_config("unsupported file operation")),
        }
    }.await;
    if let Err(err) = result {
        send_file_error(id, &err.to_string(), sender, noise, cipher).await?;
    }
    Ok(())
}

fn file_version(metadata: &std::fs::Metadata) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}",
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec(),
        metadata.ctime(),
        metadata.ctime_nsec()
    )
}

async fn send_file_error<S: futures_util::Sink<Message> + Unpin>(
    id: u32,
    message: &str,
    sender: &mut S,
    noise: &mut snow::TransportState,
    cipher: &mut [u8],
) -> io::Result<()> {
    send_file_json(
        serde_json::json!({"id": id, "ok": false, "error": message}),
        sender,
        noise,
        cipher,
    )
    .await
}

async fn send_file_json<S: futures_util::Sink<Message> + Unpin>(
    value: serde_json::Value,
    sender: &mut S,
    noise: &mut snow::TransportState,
    cipher: &mut [u8],
) -> io::Result<()> {
    let data = serde_json::to_vec(&value)?;
    if data.len() > 60_000 {
        let id = value
            .get("id")
            .and_then(|value| value.as_u64())
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| invalid_config("chunked response has no request id"))?;
        let chunk_count = data.len().div_ceil(60_000);
        for (index, chunk) in data.chunks(60_000).enumerate() {
            let mut message = Vec::with_capacity(chunk.len() + 6);
            message.push(6);
            message.extend_from_slice(&id.to_be_bytes());
            message.push((index + 1 == chunk_count) as u8);
            message.extend_from_slice(chunk);
            send_encrypted(&message, sender, noise, cipher).await?;
        }
        return Ok(());
    }
    let mut message = Vec::with_capacity(data.len() + 1);
    message.push(4);
    message.extend_from_slice(&data);
    send_encrypted(&message, sender, noise, cipher).await
}

async fn send_file_chunk<S: futures_util::Sink<Message> + Unpin>(
    id: u32,
    final_chunk: bool,
    data: &[u8],
    sender: &mut S,
    noise: &mut snow::TransportState,
    cipher: &mut [u8],
) -> io::Result<()> {
    let mut message = Vec::with_capacity(data.len() + 6);
    message.push(5);
    message.extend_from_slice(&id.to_be_bytes());
    message.push(final_chunk as u8);
    message.extend_from_slice(data);
    send_encrypted(&message, sender, noise, cipher).await
}

async fn send_encrypted<S: futures_util::Sink<Message> + Unpin>(
    data: &[u8],
    sender: &mut S,
    noise: &mut snow::TransportState,
    cipher: &mut [u8],
) -> io::Result<()> {
    let size = noise
        .write_message(data, cipher)
        .map_err(|_| invalid_config("could not encrypt file response"))?;
    timeout(
        Duration::from_secs(5),
        sender.send(Message::Binary(cipher[..size].to_vec().into())),
    )
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "connection send timed out"))?
    .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "connection closed"))
}

fn terminal_command() -> io::Result<CommandBuilder> {
    if let Some(target) = env::var_os("EYA_HOST_PID") {
        return host_terminal_command(target);
    }

    // In native deployments this preserves the server user's host environment,
    // shell configuration and filesystem access. EYA_* overrides are useful for
    // service managers, which often start processes with a minimal environment.
    let shell = env::var_os("EYA_SHELL")
        .or_else(|| env::var_os("SHELL"))
        .unwrap_or_else(|| OsString::from("/bin/sh"));
    let cwd = env::var_os("EYA_CWD")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(PathBuf::from));

    let mut command = CommandBuilder::new(shell);
    if let Some(cwd) = cwd {
        command.cwd(cwd);
    }
    command.env("TERM", "xterm-256color");
    // The shell inherits the host environment, but the authentication secret is
    // server-only and must not leak to commands launched in a terminal session.
    command.env_remove("EYA_KEY");
    Ok(command)
}

fn host_terminal_command(target: OsString) -> io::Result<CommandBuilder> {
    let target_text = target
        .to_str()
        .ok_or_else(|| invalid_config("EYA_HOST_PID must be a positive integer"))?;
    let target_pid = target_text
        .parse::<u32>()
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| invalid_config("EYA_HOST_PID must be a positive integer"))?;
    let user = env::var_os("EYA_HOST_USER")
        .filter(|user| !user.is_empty())
        .ok_or_else(|| invalid_config("EYA_HOST_USER is required in Docker host mode"))?;
    if user.to_string_lossy().starts_with('-') {
        return Err(invalid_config("EYA_HOST_USER cannot start with '-'"));
    }

    let nsenter = env::var_os("EYA_NSENTER").unwrap_or_else(|| "/usr/bin/nsenter".into());
    let su = env::var_os("EYA_HOST_SU").unwrap_or_else(|| "/bin/su".into());
    let cwd = env::var_os("EYA_CWD").unwrap_or_else(|| "/".into());
    Ok(build_host_terminal_command(
        nsenter, su, target_pid, user, cwd,
    ))
}

fn build_host_terminal_command(
    nsenter: OsString,
    su: OsString,
    target_pid: u32,
    user: OsString,
    cwd: OsString,
) -> CommandBuilder {
    let mut wd_arg = OsString::from("--wdns=");
    wd_arg.push(cwd);

    let mut command = CommandBuilder::new(nsenter);
    command.args([
        OsString::from("--target"),
        OsString::from(target_pid.to_string()),
        OsString::from("--mount"),
        OsString::from("--uts"),
        OsString::from("--ipc"),
        OsString::from("--net"),
        OsString::from("--pid"),
        OsString::from("--root"),
        wd_arg,
        OsString::from("--"),
        su,
        OsString::from("--login"),
        OsString::from("--"),
        user,
    ]);
    command.env("TERM", "xterm-256color");
    command.env_remove("EYA_KEY");
    command
}

fn invalid_config(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::{build_host_terminal_command, configured_client, derive_key};
    use sha2::{Digest, Sha256};
    use std::ffi::{OsStr, OsString};

    #[test]
    fn accepts_an_arbitrary_password() {
        let password = "correct horse battery staple !";
        let expected: [u8; 32] = Sha256::digest(password.as_bytes()).into();
        assert_eq!(derive_key(password), expected);
    }

    #[test]
    fn retains_hex_key_compatibility() {
        let key = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        assert_eq!(derive_key(key), core::array::from_fn(|i| i as u8));
    }

    #[test]
    fn hosted_client_escapes_script_terminators_in_passwords() {
        let password = "</script><script>alert('unsafe')</script>";
        let client = configured_client(password);
        assert!(!client.contains(password));
        assert!(!client.contains("<script>alert('unsafe')</script>"));
        assert!(client.contains(r#"\u003c/script>\u003cscript>alert('unsafe')\u003c/script>"#));
        assert!(client.contains(r#""hosted":true"#));
    }

    #[test]
    fn builds_a_host_namespace_login_command() {
        let command = build_host_terminal_command(
            "/usr/bin/nsenter".into(),
            "/bin/su".into(),
            1,
            "host-user".into(),
            "/home/host-user".into(),
        );
        let expected: Vec<OsString> = [
            "/usr/bin/nsenter",
            "--target",
            "1",
            "--mount",
            "--uts",
            "--ipc",
            "--net",
            "--pid",
            "--root",
            "--wdns=/home/host-user",
            "--",
            "/bin/su",
            "--login",
            "--",
            "host-user",
        ]
        .map(OsString::from)
        .into();
        assert_eq!(command.get_argv(), &expected);
        assert_eq!(command.get_env("TERM"), Some(OsStr::new("xterm-256color")));
        assert_eq!(command.get_env("EYA_KEY"), None);
    }
}
