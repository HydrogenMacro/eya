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
    io::{Read, Write},
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
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let key = env::var("EYA_KEY").map_err(|_| "EYA_KEY is required")?;
    let key = derive_key(&key);
    let bind = env::var("EYA_BIND").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let app = App {
        key: Arc::new(key),
        slots: Arc::new(Semaphore::new(8)),
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
    if secret.len() == 64 {
        if let Ok(key) = hex::decode(secret).and_then(|key| {
            key.try_into()
                .map_err(|_| hex::FromHexError::InvalidStringLength)
        }) {
            return key;
        }
    }
    Sha256::digest(secret.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::derive_key;
    use sha2::{Digest, Sha256};

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
        handshake_and_run(socket, app.key.clone(), slot),
    )
    .await
    {
        eprintln!("connection timed out: {err}");
    }
}
async fn handshake_and_run(
    mut socket: WebSocket,
    key: Arc<[u8; 32]>,
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
        run_terminal(socket, noise, flow_control).await;
    });
}
async fn run_terminal(socket: WebSocket, mut noise: snow::TransportState, flow_control: bool) {
    let pty = native_pty_system();
    let Ok(pair) = pty.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }) else {
        return;
    };
    let shell = env::var("EYA_SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let mut command = CommandBuilder::new(shell);
    command.env("TERM", "xterm-256color");
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
                Some(data) => { let len = data.len(); let payload = if flow_control { let mut framed = Vec::with_capacity(len + 1); framed.push(0); framed.extend_from_slice(&data); framed } else { data }; let Ok(n) = noise.write_message(&payload, &mut cipher) else { break }; if sender.send(Message::Binary(cipher[..n].to_vec().into())).await.is_err() { break } if flow_control { outstanding += len; } },
                None => break,
            }
        }
    }
    // Signal the PTY's foreground job as well as the shell. Detached tmux servers
    // have their own process group and can outlive this connection.
    if let Some(group) = pair.master.process_group_leader() {
        if group > 1 {
            unsafe {
                libc::kill(-group, libc::SIGHUP);
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}
