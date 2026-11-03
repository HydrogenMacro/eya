use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::{Html, IntoResponse},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use sha2::{Digest, Sha256};
use std::{
    env,
    ffi::OsString,
    io::{self, Read, Write},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::{Semaphore, mpsc},
    time::timeout,
};

const PROTOCOL: &str = "Noise_NNpsk0_25519_ChaChaPoly_BLAKE2b";
const PROLOGUE: &[u8] = b"eya-terminal-v1";
const CLIENT: &str = include_str!("../../client.html");
const GENERATOR: &str = include_str!("../../client/generator.html");
#[derive(Clone)]
struct App {
    key: Arc<[u8; 32]>,
    slots: Arc<Semaphore>,
    terminal: Arc<CommandBuilder>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let key = env::var("EYA_KEY").map_err(|_| "EYA_KEY is required")?;
    if key.is_empty() {
        return Err("EYA_KEY must not be empty".into());
    }
    let key = derive_key(&key);
    let terminal = terminal_command()?;
    // A session has the privileges of this host process, so do not expose it to
    // the network unless the operator explicitly opts in with EYA_BIND.
    let bind = env::var("EYA_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let app = App {
        key: Arc::new(key),
        slots: Arc::new(Semaphore::new(8)),
        terminal: Arc::new(terminal),
    };
    let router = Router::new()
        .route("/", get(|| async { Html(GENERATOR) }))
        .route(
            "/client.html",
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
        .route("/ws", get(upgrade))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    eprintln!("Eya listening on {bind}");
    axum::serve(listener, router).await?;
    Ok(())
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
        handshake_and_run(socket, app.key.clone(), app.terminal.clone(), slot),
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
    slot: tokio::sync::OwnedSemaphorePermit,
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
    let flow_control = match &buf[..n] {
        b"eya-ready" => false,
        b"eya-ready-v2" => true,
        _ => return,
    };
    // The timeout applies to the handshake only, not the interactive session.
    tokio::spawn(async move {
        let _slot = slot;
        run_terminal(socket, noise, flow_control, terminal).await;
    });
}
async fn run_terminal(
    socket: WebSocket,
    mut noise: snow::TransportState,
    flow_control: bool,
    terminal: Arc<CommandBuilder>,
) {
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
    loop {
        tokio::select! {
            msg = receiver.next() => match msg {
                Some(Ok(Message::Binary(data))) => {
                    let Ok(n) = noise.read_message(&data, &mut plain) else { break };
                    if n == 0 { break }
                    match plain[0] {
                        0 => if writer.write_all(&plain[1..n]).is_err() { break },
                        1 if n == 5 => { let cols = u16::from_be_bytes([plain[1], plain[2]]); let rows = u16::from_be_bytes([plain[3], plain[4]]); if cols > 0 && rows > 0 && cols <= 1000 && rows <= 1000 { let _ = pair.master.resize(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 }); } },
                        2 if flow_control && n == 5 => { let ack = u32::from_be_bytes([plain[1], plain[2], plain[3], plain[4]]) as usize; if ack > outstanding { break; } outstanding -= ack; },
                        3 if flow_control && n == 9 => { let Ok(size) = noise.write_message(&plain[..n], &mut cipher) else { break }; if sender.send(Message::Binary(cipher[..size].to_vec().into())).await.is_err() { break; } },
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
    use super::{build_host_terminal_command, derive_key};
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
