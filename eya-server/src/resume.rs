//! Resumable PTYs. Noise is fresh for every connection; terminal offsets survive it.
use super::*;
use std::{collections::VecDeque, sync::Mutex};
use tokio::time::Instant;

pub type Registry = Arc<Mutex<HashMap<String, mpsc::Sender<Attachment>>>>;
pub struct Attachment {
    socket: WebSocket,
    noise: snow::TransportState,
    output: u64,
}

#[derive(Clone)]
pub struct Limits {
    pub ttl: Duration,
    pub buffer: usize,
}
impl Limits {
    pub fn from_env() -> io::Result<Self> {
        fn number(name: &str, default: u64, min: u64, max: u64) -> io::Result<u64> {
            match env::var(name) {
                Ok(value) => value
                    .parse()
                    .ok()
                    .filter(|value| (min..=max).contains(value))
                    .ok_or_else(|| invalid_config(&format!("{name} must be {min}–{max}"))),
                Err(env::VarError::NotPresent) => Ok(default),
                Err(_) => Err(invalid_config(&format!("{name} must be valid text"))),
            }
        }
        Ok(Self {
            ttl: Duration::from_secs(number("EYA_SESSION_TTL_SECONDS", 600, 1, 86400)?),
            buffer: number(
                "EYA_SESSION_BUFFER_BYTES",
                4 * 1024 * 1024,
                65536,
                64 * 1024 * 1024,
            )? as usize,
        })
    }
}

pub async fn attach(socket: WebSocket, noise: snow::TransportState, ready: &[u8], app: App) {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(ready) else {
        return;
    };
    let Some(token) = value["token"]
        .as_str()
        .filter(|token| token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()))
    else {
        return;
    };
    let Some(output) = value["output"].as_u64() else {
        return;
    };
    let create = value["create"].as_bool().unwrap_or(false);
    let attachment = Attachment {
        socket,
        noise,
        output,
    };
    let existing = app
        .sessions
        .lock()
        .ok()
        .and_then(|sessions| sessions.get(token).cloned());
    if let Some(sender) = existing {
        // A slow file operation must not leave arbitrarily many reconnect
        // sockets waiting forever behind this session's bounded mailbox.
        let _ = timeout(Duration::from_secs(2), sender.send(attachment)).await;
        return;
    }
    if !create || output != 0 {
        reject(
            attachment,
            "expired",
            "The terminal session ended or expired. Start a new session explicitly.",
        )
        .await;
        return;
    }
    let Ok(permit) = app.session_slots.clone().try_acquire_owned() else {
        reject(attachment, "full", "All terminal session slots are in use.").await;
        return;
    };
    let (tx, rx) = mpsc::channel(4);
    // Atomically claim the token so simultaneous reconnects cannot create two shells.
    let raced = {
        let Ok(mut sessions) = app.sessions.lock() else {
            return;
        };
        if let Some(existing) = sessions.get(token) {
            Some(existing.clone())
        } else {
            sessions.insert(token.to_owned(), tx);
            None
        }
    };
    if let Some(sender) = raced {
        let _ = timeout(Duration::from_secs(2), sender.send(attachment)).await;
        return;
    }
    let token = token.to_owned();
    tokio::spawn(async move {
        run(attachment, rx, &token, &app).await;
        if let Ok(mut sessions) = app.sessions.lock() {
            sessions.remove(&token);
        }
        drop(permit);
    });
}

async fn reject(attachment: Attachment, state: &str, message: &str) {
    let (mut sender, _) = attachment.socket.split();
    let mut noise = attachment.noise;
    let mut cipher = vec![0; 65535];
    let _ = send_state(
        &mut sender,
        &mut noise,
        &mut cipher,
        serde_json::json!({"state": state, "message": message}),
    )
    .await;
    let _ = timeout(Duration::from_secs(2), sender.close()).await;
}

type SocketSender = futures_util::stream::SplitSink<WebSocket, Message>;
struct Transport {
    sender: SocketSender,
    receiver: futures_util::stream::SplitStream<WebSocket>,
    noise: snow::TransportState,
    sent: u64,
    activity: Instant,
}
async fn send_state(
    sender: &mut SocketSender,
    noise: &mut snow::TransportState,
    cipher: &mut [u8],
    value: serde_json::Value,
) -> io::Result<()> {
    let mut message = vec![7];
    message.extend_from_slice(&serde_json::to_vec(&value)?);
    send_encrypted(&message, sender, noise, cipher).await
}

#[derive(Default)]
struct Replay {
    chunks: VecDeque<(u64, Vec<u8>)>,
    acknowledged: u64,
    end: u64,
}
impl Replay {
    fn append(&mut self, bytes: Vec<u8>) {
        let start = self.end;
        self.end += bytes.len() as u64;
        self.chunks.push_back((start, bytes));
    }
    fn acknowledge(&mut self, offset: u64) -> bool {
        if offset < self.acknowledged || offset > self.end {
            return false;
        }
        self.acknowledged = offset;
        while self
            .chunks
            .front()
            .is_some_and(|(start, bytes)| *start + bytes.len() as u64 <= offset)
        {
            self.chunks.pop_front();
        }
        true
    }
    fn next(&self, offset: u64) -> Option<&[u8]> {
        self.chunks.iter().find_map(|(start, bytes)| {
            (*start <= offset && offset < *start + bytes.len() as u64)
                .then(|| &bytes[(offset - start) as usize..])
        })
    }
}

async fn install(
    attachment: Attachment,
    replay: &mut Replay,
    input: u64,
    resumed: bool,
    cipher: &mut [u8],
) -> Option<Transport> {
    if attachment.output < replay.acknowledged || attachment.output > replay.end {
        reject(
            attachment,
            "invalid",
            "The client and terminal replay offsets no longer agree.",
        )
        .await;
        return None;
    }
    let output = attachment.output;
    let (mut sender, receiver) = attachment.socket.split();
    let mut noise = attachment.noise;
    if send_state(
        &mut sender,
        &mut noise,
        cipher,
        serde_json::json!({"state": "ready", "resumed": resumed, "input": input, "output": output}),
    )
    .await
    .is_err()
    {
        return None;
    }
    replay.acknowledge(output);
    Some(Transport {
        sender,
        receiver,
        noise,
        sent: output,
        activity: Instant::now(),
    })
}

async fn run(
    initial: Attachment,
    mut attachments: mpsc::Receiver<Attachment>,
    _token: &str,
    app: &App,
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
    let Ok(mut child) = pair.slave.spawn_command(app.terminal.as_ref().clone()) else {
        return;
    };
    drop(pair.slave);
    let Ok(mut reader) = pair.master.try_clone_reader() else {
        let _ = child.kill();
        let _ = child.wait();
        return;
    };
    let Ok(mut writer) = pair.master.take_writer() else {
        let _ = child.kill();
        let _ = child.wait();
        return;
    };
    let (tx, mut output) = mpsc::channel::<Vec<u8>>(32);
    tokio::task::spawn_blocking(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if tx.blocking_send(buffer[..count].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    // A program may stop reading stdin for a long time. Keep blocked PTY writes
    // off the session actor so reconnects and output replay remain responsive.
    let (write_tx, mut write_rx) = mpsc::channel::<(u64, Vec<u8>)>(1);
    let (written_tx, mut written_rx) = mpsc::channel::<(u64, bool)>(1);
    tokio::task::spawn_blocking(move || {
        while let Some((end, bytes)) = write_rx.blocking_recv() {
            let ok = writer.write_all(&bytes).is_ok();
            if written_tx.blocking_send((end, ok)).is_err() || !ok {
                break;
            }
        }
    });
    let mut cipher = vec![0u8; 65535];
    let mut plain = vec![0u8; 65535];
    let mut replay = Replay::default();
    let mut input = 0u64;
    let mut submitted = 0u64;
    let mut input_queue = VecDeque::<(u64, Vec<u8>)>::new();
    let mut transport = install(initial, &mut replay, input, false, &mut cipher).await;
    let mut offline_since = Instant::now();
    let mut uploads = HashMap::<u32, files::Upload>::new();
    // Machine tools can wait on Docker or /proc without blocking PTY input,
    // acknowledgements, reconnects, or pings. Encrypt completions in this actor.
    let mut machine_jobs = futures_util::stream::FuturesUnordered::<
        std::pin::Pin<Box<dyn std::future::Future<Output = serde_json::Value> + Send>>,
    >::new();
    let mut ended = false;
    loop {
        if transport.is_none() {
            machine_jobs.clear();
            for (_, upload) in uploads.drain() {
                upload.cancel().await;
            }
        }
        if transport.is_none() && offline_since.elapsed() >= app.resume_limits.ttl {
            break;
        }
        if let Some(connection) = transport.as_mut() {
            if connection.activity.elapsed() > Duration::from_secs(30) {
                transport = None;
                offline_since = Instant::now();
                for (_, upload) in uploads.drain() {
                    upload.cancel().await;
                }
                continue;
            }
            if connection.sent < replay.end
                && connection.sent.saturating_sub(replay.acknowledged) < 256 * 1024
            {
                if let Some(bytes) = replay.next(connection.sent) {
                    let mut framed = vec![8];
                    framed.extend_from_slice(&connection.sent.to_be_bytes());
                    framed.extend_from_slice(bytes);
                    if send_encrypted(
                        &framed,
                        &mut connection.sender,
                        &mut connection.noise,
                        &mut cipher,
                    )
                    .await
                    .is_err()
                    {
                        transport = None;
                        offline_since = Instant::now();
                    } else {
                        connection.sent += bytes.len() as u64;
                    }
                }
                continue;
            }
            if ended && replay.acknowledged == replay.end {
                let _ = send_state(&mut connection.sender, &mut connection.noise, &mut cipher, serde_json::json!({"state": "ended", "message": "The terminal process exited."})).await;
                break;
            }
        }
        tokio::select! {
            permit = write_tx.reserve(), if !input_queue.is_empty() => {
                if let Ok(permit) = permit { permit.send(input_queue.pop_front().expect("queue is nonempty")); }
                else { break; }
            }
            Some((offset, ok)) = written_rx.recv() => {
                if !ok { break; }
                input = offset;
                if let Some(connection) = transport.as_mut() {
                    let mut ack = vec![9]; ack.extend_from_slice(&input.to_be_bytes());
                    if send_encrypted(&ack, &mut connection.sender, &mut connection.noise, &mut cipher).await.is_err() {
                        transport = None; offline_since = Instant::now();
                    }
                }
            }
            Some(attachment) = attachments.recv() => {
                if let Some(replacement) = install(attachment, &mut replay, input, true, &mut cipher).await {
                    machine_jobs.clear();
                    transport = Some(replacement);
                    for (_, upload) in uploads.drain() { upload.cancel().await; }
                }
            }
            incoming = async { match transport.as_mut() { Some(connection) => connection.receiver.next().await, None => std::future::pending().await } } => {
                let connection = transport.as_mut().expect("incoming requires an attached connection");
                let mut detach = false;
                match incoming {
                    Some(Ok(Message::Binary(bytes))) => {
                        connection.activity = Instant::now();
                        if let Ok(count) = connection.noise.read_message(&bytes, &mut plain) {
                            match plain.get(..count).unwrap_or(&[]) {
                                [0, rest @ ..] if rest.len() >= 8 => {
                                    let start = u64::from_be_bytes(rest[..8].try_into().unwrap());
                                    let bytes = &rest[8..];
                                    let end = start.checked_add(bytes.len() as u64);
                                    if let Some(end) = end.filter(|end| start <= submitted && end.saturating_sub(input) <= 256 * 1024) {
                                        let skip = submitted.saturating_sub(start).min(bytes.len() as u64) as usize;
                                        if skip < bytes.len() {
                                            input_queue.push_back((end, bytes[skip..].to_vec()));
                                            submitted = end;
                                        }
                                        let mut ack = vec![9]; ack.extend_from_slice(&input.to_be_bytes());
                                        detach = send_encrypted(&ack, &mut connection.sender, &mut connection.noise, &mut cipher).await.is_err();
                                    } else { detach = true; }
                                }
                                [1, a, b, c, d] => {
                                    let cols = u16::from_be_bytes([*a,*b]); let rows = u16::from_be_bytes([*c,*d]);
                                    if cols > 0 && rows > 0 && cols <= 1000 && rows <= 1000 { let _ = pair.master.resize(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 }); }
                                }
                                [2, rest @ ..] if rest.len() == 8 => {
                                    let offset = u64::from_be_bytes(rest.try_into().unwrap());
                                    if offset > connection.sent || !replay.acknowledge(offset) { detach = true; }
                                }
                                [3, rest @ ..] if rest.len() == 8 => detach = send_encrypted(&plain[..count], &mut connection.sender, &mut connection.noise, &mut cipher).await.is_err(),
                                [4, data @ ..] => {
                                    let request = serde_json::from_slice::<serde_json::Value>(data).ok();
                                    let machine = request.as_ref().and_then(|request| request["op"].as_str()).is_some_and(|op| op.starts_with("system.") || op.starts_with("docker.") || op.starts_with("compose."));
                                    if machine {
                                        let request = request.unwrap();
                                        if let Some(id) = request["id"].as_u64().and_then(|id| u32::try_from(id).ok()) {
                                            match app.machine_slots.clone().try_acquire_owned() {
                                                Ok(permit) if machine_jobs.len() < 4 => {
                                                    let files = app.files.clone();
                                                    machine_jobs.push(Box::pin(async move {
                                                        let _permit = permit;
                                                        let op = request["op"].as_str().unwrap();
                                                        match timeout(Duration::from_secs(20), system::handle(op, &request, &files)).await {
                                                            Ok(Ok(mut response)) => {response["id"] = id.into(); response["ok"] = true.into(); response["op"] = op.into(); response},
                                                            Ok(Err(error)) => serde_json::json!({"id":id,"ok":false,"error":error.to_string()}),
                                                            Err(_) => serde_json::json!({"id":id,"ok":false,"error":"machine operation timed out"}),
                                                        }
                                                    }));
                                                }
                                                _ => detach = send_file_error(id,"Machine tools are busy; retry shortly.",&mut connection.sender,&mut connection.noise,&mut cipher).await.is_err(),
                                            }
                                        } else {detach = true;}
                                    } else {
                                        detach = handle_file_request(data,&app.files,&mut uploads,&mut connection.sender,&mut connection.noise,&mut cipher).await.is_err();
                                    }
                                },
                                [5, data @ ..] if data.len() >= 5 => {
                                    let id = u32::from_be_bytes(data[..4].try_into().unwrap());
                                    if let Some(mut upload) = uploads.remove(&id) {
                                        let result = upload.write(&data[5..]).await;
                                        let result = if result.is_err() { upload.cancel().await; result }
                                            else if data[4] != 0 { upload.finish().await }
                                            else { uploads.insert(id, upload); Ok(()) };
                                        detach = match result {
                                            Err(error) => send_file_error(id, &error.to_string(), &mut connection.sender, &mut connection.noise, &mut cipher).await.is_err(),
                                            Ok(()) if data[4] != 0 => send_file_json(serde_json::json!({"id":id,"ok":true,"op":"write","done":true}), &mut connection.sender, &mut connection.noise, &mut cipher).await.is_err(),
                                            _ => false,
                                        };
                                    } else { detach = send_file_error(id, "upload is not active", &mut connection.sender, &mut connection.noise, &mut cipher).await.is_err(); }
                                }
                                [10] => {
                                    let _ = send_state(&mut connection.sender, &mut connection.noise, &mut cipher, serde_json::json!({"state":"ended","message":"The session was ended explicitly."})).await;
                                    break;
                                }
                                _ => detach = true,
                            }
                        } else { detach = true; }
                    }
                    Some(Ok(Message::Ping(bytes))) => detach = !matches!(timeout(Duration::from_secs(5), connection.sender.send(Message::Pong(bytes))).await, Ok(Ok(()))),
                    Some(Ok(Message::Pong(_))) => {},
                    _ => detach = true,
                }
                if detach {
                    transport = None; offline_since = Instant::now();
                    for (_, upload) in uploads.drain() { upload.cancel().await; }
                }
            }
            Some(response) = machine_jobs.next(), if !machine_jobs.is_empty() => {
                if let Some(connection) = transport.as_mut() {
                    if send_file_json(response,&mut connection.sender,&mut connection.noise,&mut cipher).await.is_err() {
                        transport = None; offline_since = Instant::now();
                    }
                }
            }
            bytes = output.recv(), if !ended && replay.end - replay.acknowledged < app.resume_limits.buffer as u64 => {
                match bytes { Some(bytes) => replay.append(bytes), None => ended = true }
            }
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
    }
    for (_, upload) in uploads {
        upload.cancel().await;
    }
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

#[cfg(test)]
mod tests {
    use super::Replay;
    #[test]
    fn replay_tracks_absolute_offsets_and_partial_acknowledgements() {
        let mut replay = Replay::default();
        replay.append(b"abc".to_vec());
        replay.append(b"def".to_vec());
        assert_eq!(replay.next(1), Some(&b"bc"[..]));
        assert!(!replay.acknowledge(7));
        assert!(replay.acknowledge(3));
        assert_eq!(replay.chunks.len(), 1);
        assert_eq!(replay.next(4), Some(&b"ef"[..]));
        assert!(!replay.acknowledge(2));
        assert!(replay.acknowledge(6));
        assert!(replay.chunks.is_empty());
    }
}
