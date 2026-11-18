//! Resumable PTYs. Noise is fresh for every connection; terminal offsets survive it.
use super::*;
use flate2::{Compression, write::DeflateEncoder};
use futures_util::{FutureExt, Sink, future::BoxFuture};
use std::{
    collections::VecDeque,
    pin::Pin,
    sync::Mutex,
    task::{Context, Poll},
};
use tokio::time::Instant;

pub type Registry = Arc<Mutex<HashMap<String, mpsc::Sender<Command>>>>;
pub enum Command {
    Attach(Attachment),
    Inspect(tokio::sync::oneshot::Sender<serde_json::Value>),
    End,
}
pub struct Attachment {
    socket: WebSocket,
    noise: snow::TransportState,
    output: u64,
    client: Option<String>,
    fresh: bool,
    takeover: bool,
    compression: bool,
    extensions: bool,
}

pub async fn manage(
    app: &App,
    op: &str,
    request: &serde_json::Value,
) -> io::Result<serde_json::Value> {
    if op == "session.list" {
        let entries: Vec<_> = app
            .sessions
            .lock()
            .map_err(|_| io::Error::other("Sessions unavailable"))?
            .iter()
            .map(|(id, sender)| (id.clone(), sender.clone()))
            .collect();
        let mut sessions = Vec::new();
        for (id, sender) in entries {
            let (tx, rx) = tokio::sync::oneshot::channel();
            let requested = matches!(
                timeout(Duration::from_secs(1), sender.send(Command::Inspect(tx))).await,
                Ok(Ok(()))
            );
            let mut state = if requested {
                timeout(Duration::from_secs(1), rx)
                    .await
                    .ok()
                    .and_then(Result::ok)
            } else {
                None
            }
            .unwrap_or_else(
                || serde_json::json!({"status":if sender.is_closed(){"closing"}else{"busy"}}),
            );
            state["id"] = id.clone().into();
            state["kind"] = "terminal".into();
            state["workspace"] = app
                .workspaces
                .lock()
                .map_err(|_| io::Error::other("Workspace store unavailable"))?
                .owner(&id)
                .map(str::to_owned)
                .into();
            sessions.push(state);
        }
        let browsers = crate::browser_render::manage(app, op, request).await?;
        if let Some(items) = browsers["sessions"].as_array() {
            sessions.extend(items.iter().cloned());
        }
        return Ok(
            serde_json::json!({"sessions":sessions,"ttl":app.resume_limits.browser_ttl.as_secs(),"terminalTtl":null,"browserTtl":app.resume_limits.browser_ttl.as_secs()}),
        );
    }
    let id = request["session"]
        .as_str()
        .ok_or_else(|| invalid_config("Session ID is required"))?;
    if op == "session.end" {
        app.session_ends.end(id)?;
    }
    let sender = app
        .sessions
        .lock()
        .map_err(|_| io::Error::other("Sessions unavailable"))?
        .get(id)
        .cloned();
    match op {
        "session.end" => {
            if let Some(sender) = sender {
                let _ = timeout(Duration::from_secs(2), sender.send(Command::End))
                    .await
                    .map_err(io::Error::other)?;
            } else {
                return crate::browser_render::manage(app, op, request).await;
            }
            Ok(serde_json::json!({"ended":id}))
        }
        _ => Err(invalid_config("Unsupported session operation")),
    }
}

#[derive(Clone)]
pub struct Limits {
    // Browser runtimes still expire; terminal actors have no detached lifetime.
    pub browser_ttl: Duration,
    pub buffer: usize,
    pub compression: bool,
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
            browser_ttl: Duration::from_secs(number("EYA_SESSION_TTL_SECONDS", 600, 1, 86400)?),
            buffer: number(
                "EYA_SESSION_BUFFER_BYTES",
                4 * 1024 * 1024,
                65536,
                64 * 1024 * 1024,
            )? as usize,
            compression: match env::var("EYA_TERMINAL_COMPRESSION") {
                Ok(value) if value == "off" => false,
                Ok(value) if value == "auto" => true,
                Err(env::VarError::NotPresent) => true,
                _ => {
                    return Err(invalid_config(
                        "EYA_TERMINAL_COMPRESSION must be auto or off",
                    ));
                }
            },
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
        client: value["client"]
            .as_str()
            .filter(|id| crate::workspaces::valid_id(id))
            .map(str::to_owned),
        fresh: value["fresh"].as_bool().unwrap_or(false),
        takeover: value["takeover"].as_bool().unwrap_or(false),
        compression: app.resume_limits.compression
            && value["compression"].as_str() == Some("deflate-raw"),
        extensions: wire::offered(&value),
    };
    let existing = app
        .sessions
        .lock()
        .ok()
        .and_then(|sessions| sessions.get(token).cloned());
    if let Some(sender) = existing {
        // A slow file operation must not leave arbitrarily many reconnect
        // sockets waiting forever behind this session's bounded mailbox.
        let _ = timeout(
            Duration::from_secs(2),
            sender.send(Command::Attach(attachment)),
        )
        .await;
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
    let raced = app
        .session_ends
        .claim(token, || {
            let mut sessions = app
                .sessions
                .lock()
                .map_err(|_| io::Error::other("Session registry unavailable"))?;
            if let Some(existing) = sessions.get(token) {
                Ok(Some(existing.clone()))
            } else {
                sessions.insert(token.to_owned(), tx);
                Ok(None)
            }
        })
        .and_then(|result: io::Result<_>| result);
    let raced = match raced {
        Ok(raced) => raced,
        Err(error) => {
            reject(attachment, "ended", &error.to_string()).await;
            return;
        }
    };
    if let Some(sender) = raced {
        let _ = timeout(
            Duration::from_secs(2),
            sender.send(Command::Attach(attachment)),
        )
        .await;
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

const OUTPUT_CHUNK: usize = 8192;
const PTY_READ_QUEUE: usize = 2;
const OUTPUT_QUEUE: usize = 16;
const CONTROL_RESERVE: usize = 4;
const MIN_WINDOW: usize = 4096;
const INITIAL_WINDOW: usize = 8192;
const MAX_WINDOW: usize = 32768;

// The session actor alone owns Noise and encryption order. The writer sees
// already encrypted frames, so an idle/blocked socket never stalls PTY reads,
// incoming input, or a fresh attachment. Its queue is bounded separately from
// the decoded-byte window; controls cannot build an unlimited hidden backlog.
struct QueuedSender {
    tx: Option<mpsc::Sender<Message>>,
    permit: Option<mpsc::OwnedPermit<Message>>,
    reserving:
        Option<BoxFuture<'static, Result<mpsc::OwnedPermit<Message>, mpsc::error::SendError<()>>>>,
}
impl QueuedSender {
    fn capacity(&self) -> usize {
        self.tx.as_ref().map_or(0, mpsc::Sender::capacity)
    }
}
impl Sink<Message> for QueuedSender {
    type Error = io::Error;
    fn poll_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        if self.permit.is_some() {
            return Poll::Ready(Ok(()));
        }
        if self.reserving.is_none() {
            let Some(tx) = &self.tx else {
                return Poll::Ready(Err(io::Error::other("terminal writer closed")));
            };
            self.reserving = Some(tx.clone().reserve_owned().boxed());
        }
        match self
            .reserving
            .as_mut()
            .expect("reserve exists")
            .as_mut()
            .poll(cx)
        {
            Poll::Ready(Ok(permit)) => {
                self.reserving = None;
                self.permit = Some(permit);
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Err(_)) => {
                self.reserving = None;
                Poll::Ready(Err(io::Error::other("terminal writer closed")))
            }
            Poll::Pending => Poll::Pending,
        }
    }
    fn start_send(mut self: Pin<&mut Self>, message: Message) -> Result<(), Self::Error> {
        let permit = self
            .permit
            .take()
            .ok_or_else(|| io::Error::other("terminal writer was not ready"))?;
        permit.send(message);
        Ok(())
    }
    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
    fn poll_close(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Result<(), Self::Error>> {
        self.tx = None;
        self.permit = None;
        self.reserving = None;
        Poll::Ready(Ok(()))
    }
}

struct OutputFlow {
    window: usize,
    last_ack: Instant,
    oldest: Option<Instant>,
    flight_bytes: usize,
    feedback_samples: VecDeque<f64>,
    last_bulk_ack: Option<Instant>,
    ack_rtt: Option<f64>,
    rate: f64,
    raw_bytes: u64,
    framed_bytes: u64,
    compressed_frames: u64,
    raw_frames: u64,
    input_acks: u64,
}
impl Default for OutputFlow {
    fn default() -> Self {
        Self {
            window: INITIAL_WINDOW,
            last_ack: Instant::now(),
            oldest: None,
            flight_bytes: 0,
            feedback_samples: VecDeque::with_capacity(8),
            last_bulk_ack: None,
            ack_rtt: None,
            rate: 0.0,
            raw_bytes: 0,
            framed_bytes: 0,
            compressed_frames: 0,
            raw_frames: 0,
            input_acks: 0,
        }
    }
}
impl OutputFlow {
    fn sent(&mut self, bytes: usize, at: Instant) {
        self.oldest.get_or_insert(at);
        self.flight_bytes = self.flight_bytes.saturating_add(bytes);
    }
    fn desired_window(&self) -> usize {
        // Cover feedback delay as well as a quarter-second of new delivery.
        // A fixed quarter-second target alone underfills high-RTT links,
        // especially when compression makes the decoded delivery rate high.
        MIN_WINDOW
            .saturating_add((self.rate * (self.ack_rtt.unwrap_or(0.0) + 0.25)) as usize)
            .clamp(MIN_WINDOW, MAX_WINDOW)
    }
    fn acknowledge(&mut self, bytes: u64, drained: bool) {
        self.acknowledge_at(bytes, drained, Instant::now());
    }
    fn acknowledge_at(&mut self, bytes: u64, drained: bool, now: Instant) {
        if bytes == 0 {
            return;
        }
        let mut sampled = false;
        if bytes >= 256 {
            // Ignore human typing pauses. The first bulk ACK is timed from
            // this flight's first output, subsequent ones from bulk progress;
            // tiny interactive ACKs must not become throughput samples.
            let start = self.last_bulk_ack.or(self.oldest).unwrap_or(now);
            let seconds = now.duration_since(start).as_secs_f64().max(0.001);
            let sample = bytes as f64 / seconds;
            self.rate = if self.rate == 0.0 {
                sample
            } else {
                self.rate * 0.75 + sample * 0.25
            };
            self.last_bulk_ack = Some(now);
            sampled = true;
        }
        if drained {
            if self.flight_bytes > 0 && self.flight_bytes < 256 {
                if let Some(start) = self.oldest {
                    // Only small, fully drained flights estimate the feedback
                    // path: bulk-flight latency includes serialization and
                    // queueing. Bound the history so fresh small probes replace
                    // a clean-link floor after the same attachment roams.
                    let sample = now.duration_since(start).as_secs_f64().clamp(0.001, 60.0);
                    if self.feedback_samples.len() == 8 {
                        self.feedback_samples.pop_front();
                    }
                    self.feedback_samples.push_back(sample);
                    let minimum = self
                        .feedback_samples
                        .iter()
                        .copied()
                        .reduce(f64::min)
                        .expect("sample exists");
                    sampled |= self.ack_rtt != Some(minimum);
                    self.ack_rtt = Some(minimum);
                }
            }
            self.flight_bytes = 0;
            self.oldest = None;
            self.last_bulk_ack = None;
        }
        if sampled && self.rate > 0.0 {
            self.window = self.desired_window();
        }
        self.last_ack = now;
    }
}

struct Transport {
    sender: QueuedSender,
    receiver: futures_util::stream::SplitStream<WebSocket>,
    writer: Option<tokio::task::JoinHandle<()>>,
    writer_failed: tokio::sync::oneshot::Receiver<()>,
    writer_progress: Arc<tokio::sync::Notify>,
    noise: snow::TransportState,
    sent: u64,
    activity: Instant,
    client: Option<String>,
    compression: bool,
    flow: OutputFlow,
    extensions: bool,
}
impl Transport {
    fn state(&mut self, state: serde_json::Value, cipher: &mut [u8]) -> io::Result<()> {
        let mut bytes = vec![7];
        bytes.extend_from_slice(&serde_json::to_vec(&state)?);
        self.queue(&bytes, cipher)
    }
    fn finish(&mut self) {
        // Best-effort final state delivery without making the session actor
        // wait for a slow peer. Ordinary detach aborts the old writer instead.
        self.sender.tx = None;
        self.sender.permit = None;
        self.sender.reserving = None;
        if let Some(mut writer) = self.writer.take() {
            tokio::spawn(async move {
                if timeout(Duration::from_secs(1), &mut writer).await.is_err() {
                    writer.abort();
                }
            });
        }
    }
    fn queue(&mut self, bytes: &[u8], cipher: &mut [u8]) -> io::Result<()> {
        let tx = self
            .sender
            .tx
            .as_ref()
            .ok_or_else(|| io::Error::other("terminal writer closed"))?;
        let permit = tx
            .try_reserve()
            .map_err(|_| io::Error::other("terminal writer queue is full"))?;
        let size = self
            .noise
            .write_message(bytes, cipher)
            .map_err(|_| io::Error::other("could not encrypt terminal output"))?;
        permit.send(Message::Binary(cipher[..size].to_vec().into()));
        Ok(())
    }
    async fn next(&mut self) -> Option<Result<Message, axum::Error>> {
        tokio::select! {
            incoming = self.receiver.next() => incoming,
            _ = &mut self.writer_failed => None,
        }
    }
}
impl Drop for Transport {
    fn drop(&mut self) {
        if let Some(writer) = &self.writer {
            writer.abort();
        }
    }
}

// Independent DEFLATE blocks never share a dictionary or carry state between
// connections. Retain raw framing for tiny/incompressible output.
fn output_frame(offset: u64, bytes: &[u8], compression: bool) -> io::Result<Vec<u8>> {
    if bytes.is_empty() || bytes.len() > OUTPUT_CHUNK {
        return Err(io::Error::other("invalid terminal output chunk"));
    }
    if compression && bytes.len() >= 256 {
        let mut encoder = DeflateEncoder::new(Vec::with_capacity(bytes.len()), Compression::fast());
        encoder.write_all(bytes)?;
        let zipped = encoder.finish()?;
        if zipped.len() + 4 + 16 <= bytes.len() {
            let mut frame = Vec::with_capacity(13 + zipped.len());
            frame.push(11);
            frame.extend_from_slice(&offset.to_be_bytes());
            frame.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            frame.extend_from_slice(&zipped);
            return Ok(frame);
        }
    }
    let mut frame = Vec::with_capacity(9 + bytes.len());
    frame.push(8);
    frame.extend_from_slice(&offset.to_be_bytes());
    frame.extend_from_slice(bytes);
    Ok(frame)
}

fn coalesce_output(
    mut bytes: Vec<u8>,
    output: &mut mpsc::Receiver<Vec<u8>>,
    carry: &mut Option<Vec<u8>>,
) -> Vec<u8> {
    // Only bytes already available are combined: never wait for a prompt or a
    // line to fill a block. Keep a split tail ahead of later queued chunks.
    debug_assert!(bytes.len() <= OUTPUT_CHUNK);
    debug_assert!(carry.is_none());
    while bytes.len() < OUTPUT_CHUNK {
        let Ok(mut next) = output.try_recv() else {
            break;
        };
        let available = OUTPUT_CHUNK - bytes.len();
        if next.len() > available {
            *carry = Some(next.split_off(available));
            bytes.extend_from_slice(&next);
            break;
        }
        bytes.extend_from_slice(&next);
    }
    bytes
}

async fn send_state<S: Sink<Message> + Unpin>(
    sender: &mut S,
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
    fn can_read(&self, attached_window: Option<usize>, retention_limit: usize) -> bool {
        // An attached renderer should backpressure the producer near its live
        // delivery window, rather than accumulating seconds of stale output
        // behind interactive responses. Detached sessions still retain output
        // up to the configured replay cap. One already-read PTY chunk may cross
        // either threshold; it must be retained intact, never discarded.
        let limit = attached_window.map_or(retention_limit, |window| window.min(retention_limit));
        self.end - self.acknowledged < limit as u64
    }
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
    submitted: u64,
    resumed: bool,
    cipher: &mut [u8],
) -> Option<Transport> {
    if !attachment.fresh
        && (attachment.output < replay.acknowledged || attachment.output > replay.end)
    {
        // The actor validates attachment cursors before install. Initial
        // creation always starts at zero. Never mutate replay on disagreement.
        return None;
    }
    let output = if attachment.fresh {
        replay.acknowledged
    } else {
        attachment.output
    };
    let (mut socket_sender, receiver) = attachment.socket.split();
    let (tx, mut rx) = mpsc::channel::<Message>(OUTPUT_QUEUE);
    let (failed, writer_failed) = tokio::sync::oneshot::channel();
    let writer_progress = Arc::new(tokio::sync::Notify::new());
    let notify = writer_progress.clone();
    let writer = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if !matches!(
                timeout(Duration::from_secs(30), socket_sender.send(message)).await,
                Ok(Ok(()))
            ) {
                break;
            }
            notify.notify_one();
        }
        let _ = failed.send(());
    });
    let mut connection = Transport {
        sender: QueuedSender {
            tx: Some(tx),
            permit: None,
            reserving: None,
        },
        receiver,
        writer: Some(writer),
        writer_failed,
        writer_progress,
        noise: attachment.noise,
        sent: output,
        activity: Instant::now(),
        client: attachment.client,
        compression: attachment.compression,
        extensions: attachment.extensions,
        flow: OutputFlow::default(),
    };
    if send_state(&mut connection.sender, &mut connection.noise, cipher,
        serde_json::json!({"state": "ready", "resumed": resumed, "input": input, "nextInput": submitted, "output": output,
            "capabilities":wire::selected(connection.extensions),"versions":wire::info(),
            "compression":if connection.compression {Some("deflate-raw")} else {None}, "outputWindow":INITIAL_WINDOW, "maxOutputChunk":OUTPUT_CHUNK}),
    ).await.is_err() { return None; }
    replay.acknowledge(output);
    Some(connection)
}

async fn run(
    initial: Attachment,
    mut attachments: mpsc::Receiver<Command>,
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
    // Keep the reader ahead by only two chunks. A large channel would hide a
    // second output backlog even when the actor's replay window is bounded.
    let (tx, mut output) = mpsc::channel::<Vec<u8>>(PTY_READ_QUEUE);
    let mut output_carry = None;
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
    let mut transport = install(initial, &mut replay, input, submitted, false, &mut cipher).await;
    let mut uploads = HashMap::<u32, files::Upload>::new();
    // Machine tools can wait on Docker or /proc without blocking PTY input,
    // acknowledgements, reconnects, or pings. Encrypt completions in this actor.
    let mut machine_jobs = futures_util::stream::FuturesUnordered::<
        std::pin::Pin<Box<dyn std::future::Future<Output = serde_json::Value> + Send>>,
    >::new();
    // Rejecting another socket must not stall this terminal's authenticated
    // attachment. Keep at most two tiny rejection tasks pending per session.
    let mut rejections = futures_util::stream::FuturesUnordered::<BoxFuture<'static, ()>>::new();
    let mut ended = false;
    let mut input_ack_pending = false;
    loop {
        if transport.is_none() {
            machine_jobs.clear();
            for (_, upload) in uploads.drain() {
                upload.cancel().await;
            }
        }
        // Detaching only releases transport resources. Keep the PTY, cwd,
        // input offsets and bounded replay until explicit end or server shutdown.
        if let Some(connection) = transport.as_mut() {
            if connection.activity.elapsed() > Duration::from_secs(60) {
                transport = None;
                for (_, upload) in uploads.drain() {
                    upload.cancel().await;
                }
                continue;
            }
            if ended && replay.acknowledged == replay.end {
                let _ = connection.state(serde_json::json!({"state": "ended", "message": "The terminal process exited."}), &mut cipher);
                connection.finish();
                break;
            }
        }
        let can_send = transport
            .as_ref()
            .is_some_and(|connection| connection.sender.capacity() > CONTROL_RESERVE);
        let can_output = can_send
            && transport.as_ref().is_some_and(|connection| {
                connection.sent < replay.end
                    && connection.sent.saturating_sub(replay.acknowledged)
                        < connection.flow.window as u64
            });
        let writer_progress = transport
            .as_ref()
            .map(|connection| connection.writer_progress.clone());
        tokio::select! {
            Some(()) = rejections.next() => {}
            _ = async {}, if can_output => {
                let connection = transport.as_mut().expect("output requires connection");
                let available = connection.flow.window.saturating_sub(connection.sent.saturating_sub(replay.acknowledged) as usize);
                if let Some(bytes) = replay.next(connection.sent) {
                    let bytes = &bytes[..bytes.len().min(OUTPUT_CHUNK).min(available)];
                    let length = bytes.len();
                    let result = output_frame(connection.sent, bytes, connection.compression).and_then(|frame| {
                        let zipped = frame[0] == 11; let framed = frame.len();
                        connection.queue(&frame, &mut cipher)?;
                        connection.flow.raw_bytes += length as u64; connection.flow.framed_bytes += framed as u64;
                        if zipped { connection.flow.compressed_frames += 1; } else { connection.flow.raw_frames += 1; }
                        Ok(())
                    });
                    if result.is_err() { transport = None; }
                    else {
                        connection.flow.sent(length, Instant::now());
                        connection.sent += length as u64;
                    }
                }
            }
            _ = async {}, if input_ack_pending && transport.as_ref().is_some_and(|connection| connection.sender.capacity() > 0) => {
                let connection = transport.as_mut().expect("ack requires connection");
                let mut ack = vec![9]; ack.extend_from_slice(&input.to_be_bytes());
                if connection.queue(&ack, &mut cipher).is_err() { transport = None; }
                else { connection.flow.input_acks += 1; input_ack_pending = false; }
            }
            _ = async { match &writer_progress { Some(progress) => progress.notified().await, None => std::future::pending().await } } => {}
            permit = write_tx.reserve(), if !input_queue.is_empty() => {
                if let Ok(permit) = permit { permit.send(input_queue.pop_front().expect("queue is nonempty")); }
                else { break; }
            }
            Some((offset, ok)) = written_rx.recv() => {
                if !ok { break; }
                input = offset;
                input_ack_pending = true;
            }
            Some(command) = attachments.recv() => {
                match command {
                    Command::Inspect(reply) => {
                        let mut state = serde_json::json!({"status":if ended {"exited"} else if transport.is_some() {"attached"} else {"detached"},"client":transport.as_ref().and_then(|connection| connection.client.as_ref()),"input":input,"queuedInput":submitted - input,"output":replay.end,"replayBytes":replay.end - replay.acknowledged});
                        if let Some(connection) = transport.as_ref() {
                            state["network"] = serde_json::json!({"outputInFlight":connection.sent.saturating_sub(replay.acknowledged),
                                "outputWindow":connection.flow.window,"outputAckAgeMs":connection.flow.last_ack.elapsed().as_millis(),
                                "outputOldestAgeMs":connection.flow.oldest.map(|at|at.elapsed().as_millis()),
                                "outputRateBytesPerSecond":connection.flow.rate.round(),"outputAckRttMs":connection.flow.ack_rtt.map(|seconds| (seconds * 1000.0).round()),"outputRawBytes":connection.flow.raw_bytes,
                                "outputFramedBytes":connection.flow.framed_bytes,"compressedFrames":connection.flow.compressed_frames,
                                "rawFrames":connection.flow.raw_frames,"inputAcks":connection.flow.input_acks,
                                "writerQueued":OUTPUT_QUEUE - connection.sender.capacity(),"compression":connection.compression});
                        }
                        let _ = reply.send(state);
                    }
                    Command::End => {
                        if let Some(connection) = transport.as_mut() {
                            let _ = connection.state(serde_json::json!({"state":"ended","message":"The session was ended explicitly."}), &mut cipher);
                            connection.finish();
                        }
                        break;
                    }
                    Command::Attach(attachment) => {
                        if transport.as_ref().is_some_and(|connection| attachment.client.is_some() && connection.client != attachment.client) && !attachment.takeover {
                            if rejections.len() < 2 { rejections.push(reject(attachment, "in-use", "This terminal is attached to another client. Use Take over explicitly.").boxed()); }
                            continue;
                        }
                        if !attachment.fresh && (attachment.output < replay.acknowledged || attachment.output > replay.end) {
                            if rejections.len() < 2 { rejections.push(reject(attachment, "invalid", "The client and terminal replay offsets no longer agree.").boxed()); }
                            continue;
                        }
                        if let Some(replacement) = install(attachment, &mut replay, input, submitted, true, &mut cipher).await {
                            if let Some(connection) = transport.as_mut() {
                                let _ = connection.state(serde_json::json!({"state":"taken-over","message":"This terminal was attached by another connection."}), &mut cipher);
                                connection.finish();
                            }
                            machine_jobs.clear();
                            transport = Some(replacement);
                            for (_, upload) in uploads.drain() { upload.cancel().await; }
                        }
                    }
                }
            }
            incoming = async { match transport.as_mut() { Some(connection) => connection.next().await, None => std::future::pending().await } } => {
                let connection = transport.as_mut().expect("incoming requires an attached connection");
                let mut detach = false;
                match incoming {
                    Some(Ok(Message::Binary(bytes))) => {
                        connection.activity = Instant::now();
                        if let Ok(count) = connection.noise.read_message(&bytes, &mut plain) {
                            match plain.get(..count).unwrap_or(&[]) {
                                [12, data @ ..] if connection.extensions => {
                                    detach = match wire::extension(data) {
                                        Ok(Some(response)) => connection.queue(&response, &mut cipher).is_err(),
                                        Ok(None) => false,
                                        Err(_) => true,
                                    };
                                }
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
                                        // A new input gets its ACK on PTY commit. Only duplicates
                                        // need immediate reconciliation of the existing cursor.
                                        if skip == bytes.len() { input_ack_pending = true; }
                                    } else { detach = true; }
                                }
                                [1, a, b, c, d] => {
                                    let cols = u16::from_be_bytes([*a,*b]); let rows = u16::from_be_bytes([*c,*d]);
                                    if cols > 0 && rows > 0 && cols <= 1000 && rows <= 1000 { let _ = pair.master.resize(PtySize { cols, rows, pixel_width: 0, pixel_height: 0 }); }
                                }
                                [2, rest @ ..] if rest.len() == 8 => {
                                    let offset = u64::from_be_bytes(rest.try_into().unwrap());
                                    let previous = replay.acknowledged;
                                    if offset > connection.sent || !replay.acknowledge(offset) { detach = true; }
                                    else { connection.flow.acknowledge(offset - previous, offset == connection.sent); }
                                }
                                [3, rest @ ..] if rest.len() == 8 => detach = connection.queue(&plain[..count], &mut cipher).is_err(),
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
                                    let _ = connection.state(serde_json::json!({"state":"ended","message":"The session was ended explicitly."}), &mut cipher);
                            connection.finish();
                                    break;
                                }
                                _ => detach = true,
                            }
                        } else { detach = true; }
                    }
                    Some(Ok(Message::Ping(bytes))) => {
                        detach = connection.sender.tx.as_ref().is_none_or(|tx| tx.try_send(Message::Pong(bytes)).is_err());
                    },
                    Some(Ok(Message::Pong(_))) => {},
                    _ => detach = true,
                }
                if detach {
                    transport = None;
                    for (_, upload) in uploads.drain() { upload.cancel().await; }
                }
            }
            Some(response) = machine_jobs.next(), if !machine_jobs.is_empty() => {
                if let Some(connection) = transport.as_mut() {
                    if send_file_json(response,&mut connection.sender,&mut connection.noise,&mut cipher).await.is_err() {
                        transport = None;
                    }
                }
            }
            bytes = async { if output_carry.is_some() { output_carry.take() } else { output.recv().await } }, if !ended && replay.can_read(transport.as_ref().map(|connection| connection.flow.window), app.resume_limits.buffer) => {
                match bytes {
                    Some(bytes) => {
                        // Give an already-running reader one scheduler turn to
                        // deliver its burst, without a batching timer or RTT wait.
                        tokio::task::yield_now().await;
                        replay.append(coalesce_output(bytes, &mut output, &mut output_carry));
                    },
                    None => ended = true,
                }
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
    use super::*;
    use flate2::read::DeflateDecoder;
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

    #[test]
    fn live_reader_backpressure_uses_window_and_detached_reader_uses_retention() {
        let retention = 64 * 1024;
        let mut replay = Replay::default();
        replay.append(vec![b'a'; 1024]);
        assert!(replay.can_read(Some(INITIAL_WINDOW), retention));
        replay.append(vec![b'b'; OUTPUT_CHUNK]);
        assert!(!replay.can_read(Some(INITIAL_WINDOW), retention));
        assert!(replay.end - replay.acknowledged < (INITIAL_WINDOW + OUTPUT_CHUNK) as u64);
        assert!(replay.can_read(None, retention));
        assert!(replay.acknowledge(1025));
        assert!(replay.can_read(Some(INITIAL_WINDOW), retention));

        while replay.can_read(None, retention) {
            replay.append(vec![b'c'; OUTPUT_CHUNK]);
        }
        assert!(replay.end - replay.acknowledged >= retention as u64);
        assert!(replay.end - replay.acknowledged < (retention + OUTPUT_CHUNK) as u64);
        assert!(!replay.can_read(None, retention));
        // Reattaching does not discard retained bytes or reopen the producer
        // until the renderer drains the larger detached backlog.
        assert!(!replay.can_read(Some(INITIAL_WINDOW), retention));
        assert!(replay.next(1025).is_some());
        assert!(replay.acknowledge(replay.end));
        assert!(replay.can_read(Some(INITIAL_WINDOW), retention));
        // A configured retention bound remains authoritative even if it is
        // smaller than a future live window.
        replay.append(vec![b'd'; 1024]);
        assert!(!replay.can_read(Some(MAX_WINDOW), 1024));
    }

    #[tokio::test]
    async fn output_coalescing_keeps_chunk_bounds_split_tails_and_eof_order() {
        let (tx, mut rx) = mpsc::channel(PTY_READ_QUEUE);
        tx.send(vec![b'b'; OUTPUT_CHUNK - 1]).await.unwrap();
        tx.send(b"last".to_vec()).await.unwrap();
        drop(tx);
        let mut carry = None;
        let first = coalesce_output(b"abc".to_vec(), &mut rx, &mut carry);
        assert_eq!(first.len(), OUTPUT_CHUNK);
        assert_eq!(&first[..3], b"abc");
        assert!(first[3..].iter().all(|byte| *byte == b'b'));
        assert_eq!(carry.as_ref().unwrap(), b"bb");
        let tail = carry.take().unwrap();
        let second = coalesce_output(tail, &mut rx, &mut carry);
        assert_eq!(second, b"bblast");
        assert!(carry.is_none());
        assert!(rx.recv().await.is_none());
        assert_eq!(first.len() + second.len(), 3 + OUTPUT_CHUNK - 1 + 4);

        // A lone prompt is returned immediately while its producer is still
        // open, and an empty queue must never become a fill/wait condition.
        let (_tx, mut rx) = mpsc::channel(PTY_READ_QUEUE);
        assert_eq!(coalesce_output(b"$ ".to_vec(), &mut rx, &mut carry), b"$ ");
    }

    #[test]
    fn compressed_output_is_an_independent_bounded_block_with_decoded_offsets() {
        let bytes = b"\x1b[32mrepeated terminal output\x1b[0m\r\n".repeat(180);
        let offset = 9_000_000_001;
        let frame = output_frame(offset, &bytes, true).unwrap();
        assert_eq!(frame[0], 11);
        assert_eq!(u64::from_be_bytes(frame[1..9].try_into().unwrap()), offset);
        assert_eq!(
            u32::from_be_bytes(frame[9..13].try_into().unwrap()) as usize,
            bytes.len()
        );
        let mut decoded = Vec::new();
        DeflateDecoder::new(&frame[13..])
            .read_to_end(&mut decoded)
            .unwrap();
        assert_eq!(decoded, bytes);
        assert!(frame.len() + 16 <= bytes.len() + 9);
        // A partial replay is newly encoded, not a suffix of old ciphertext or
        // an old compressed dictionary. It must decode without the old block.
        let replay = output_frame(offset + 17, &bytes[17..], true).unwrap();
        let mut decoded = Vec::new();
        DeflateDecoder::new(&replay[13..])
            .read_to_end(&mut decoded)
            .unwrap();
        assert_eq!(decoded, bytes[17..]);
        assert_eq!(
            u64::from_be_bytes(replay[1..9].try_into().unwrap()),
            offset + 17
        );
    }

    #[test]
    fn compression_falls_back_without_inflating_short_or_entropy_output() {
        for bytes in [&b"x"[..], &b"\x1b[32muser@host$ "[..]] {
            let frame = output_frame(5, bytes, true).unwrap();
            assert_eq!(frame[0], 8);
            assert_eq!(&frame[9..], bytes);
        }
        let mut entropy = Vec::new();
        for index in 0u32..256 {
            entropy.extend_from_slice(&sha2::Sha256::digest(index.to_be_bytes()));
        }
        let frame = output_frame(0, &entropy, true).unwrap();
        assert_eq!(frame[0], 8);
        assert_eq!(&frame[9..], entropy);
        let raw = output_frame(0, &vec![b'x'; OUTPUT_CHUNK], false).unwrap();
        assert_eq!(raw[0], 8);
        assert_eq!(raw.len(), OUTPUT_CHUNK + 9);
        assert!(output_frame(0, &[], true).is_err());
        assert!(output_frame(0, &vec![0; OUTPUT_CHUNK + 1], true).is_err());
    }

    #[test]
    fn adaptive_window_accounts_for_feedback_rtt_and_ignores_idle_typing() {
        let now = Instant::now();
        let mut flow = OutputFlow::default();
        let before_idle = now - Duration::from_secs(3600);
        flow.sent(1, before_idle - Duration::from_millis(600));
        flow.acknowledge_at(1, true, before_idle);
        assert_eq!(flow.ack_rtt, Some(0.6));
        assert_eq!(flow.rate, 0.0);
        flow.sent(8192, now - Duration::from_millis(600));
        flow.acknowledge_at(8192, true, now);
        assert!((flow.rate - 8192.0 / 0.6).abs() < 0.01);
        assert_eq!(flow.ack_rtt, Some(0.6));
        assert!(flow.window > INITIAL_WINDOW);
        assert!((MIN_WINDOW..=MAX_WINDOW).contains(&flow.window));
        assert!(flow.oldest.is_none());

        let before = (flow.window, flow.last_ack, flow.rate, flow.ack_rtt);
        flow.acknowledge_at(0, false, now + Duration::from_secs(1));
        assert_eq!(
            before,
            (flow.window, flow.last_ack, flow.rate, flow.ack_rtt)
        );

        let (window, rate, rtt) = (flow.window, flow.rate, flow.ack_rtt);
        flow.sent(1, now + Duration::from_secs(9));
        flow.acknowledge_at(1, true, now + Duration::from_secs(10));
        assert_eq!((window, rate, rtt), (flow.window, flow.rate, flow.ack_rtt));
        assert_eq!(flow.last_ack, now + Duration::from_secs(10));
        flow.sent(257, now + Duration::from_secs(19));
        flow.acknowledge_at(128, false, now + Duration::from_secs(20));
        flow.acknowledge_at(128, false, now + Duration::from_secs(21));
        flow.acknowledge_at(1, true, now + Duration::from_secs(22));
        assert_eq!((window, rate, rtt), (flow.window, flow.rate, flow.ack_rtt));

        let later = now + Duration::from_secs(3600);
        flow.sent(8192, later - Duration::from_millis(600));
        flow.acknowledge_at(8192, true, later);
        assert!((flow.rate - rate).abs() < 0.01);
        assert_eq!(flow.window, window);
        assert_eq!(flow.ack_rtt, rtt);

        // At the same bulk delivery rate, a long feedback path needs a larger
        // window than a short one; neither may exceed the hard decoded cap.
        flow.rate = 32_000.0;
        flow.ack_rtt = Some(0.01);
        let short = flow.desired_window();
        flow.ack_rtt = Some(0.6);
        assert!(flow.desired_window() > short);
        flow.rate = 1_000_000.0;
        assert_eq!(flow.desired_window(), MAX_WINDOW);
    }

    #[test]
    fn recent_small_flights_follow_roaming_without_bulk_queue_contamination() {
        let now = Instant::now();
        let mut flow = OutputFlow::default();
        flow.sent(1, now - Duration::from_millis(10));
        flow.acknowledge_at(1, true, now);
        assert_eq!(flow.ack_rtt, Some(0.01));
        assert_eq!(flow.rate, 0.0);
        assert_eq!(flow.window, INITIAL_WINDOW);

        let later = now + Duration::from_secs(10);
        flow.sent(8192, later - Duration::from_secs(3));
        flow.acknowledge_at(8192, true, later);
        assert_eq!(flow.ack_rtt, Some(0.01));
        assert!(flow.window < INITIAL_WINDOW);
        assert!((MIN_WINDOW..=MAX_WINDOW).contains(&flow.window));

        let (rate, clean_window) = (flow.rate, flow.window);
        for index in 0..8 {
            let probe = later + Duration::from_secs(index + 1);
            flow.sent(1, probe - Duration::from_millis(600));
            flow.acknowledge_at(1, true, probe);
            assert_eq!(flow.rate, rate);
            assert!(flow.feedback_samples.len() <= 8);
            if index < 7 {
                assert_eq!(flow.ack_rtt, Some(0.01));
            }
        }
        assert_eq!(flow.ack_rtt, Some(0.6));
        assert!(flow.window > clean_window);
        assert_eq!(flow.feedback_samples.len(), 8);

        // Classify by the whole flight, never by its final tiny ACK delta.
        let later = later + Duration::from_secs(20);
        flow.sent(8192, later - Duration::from_secs(3));
        flow.acknowledge_at(8191, false, later - Duration::from_millis(1));
        flow.acknowledge_at(1, true, later);
        assert_eq!(flow.ack_rtt, Some(0.6));
        assert_eq!(flow.feedback_samples.len(), 8);
        assert!(flow.feedback_samples.iter().all(|sample| *sample == 0.6));

        let (rate, window) = (flow.rate, flow.window);
        let later = later + Duration::from_secs(1);
        flow.sent(1, later - Duration::from_millis(5));
        flow.acknowledge_at(1, true, later);
        assert_eq!(flow.ack_rtt, Some(0.005));
        assert_eq!(flow.rate, rate);
        assert!(flow.window <= window);
        assert_eq!(flow.feedback_samples.len(), 8);
    }

    #[tokio::test]
    async fn queued_sink_applies_bounded_backpressure_without_dropping_frames() {
        let (tx, mut rx) = mpsc::channel::<Message>(OUTPUT_QUEUE);
        let mut sink = QueuedSender {
            tx: Some(tx),
            permit: None,
            reserving: None,
        };
        for index in 0..OUTPUT_QUEUE {
            sink.send(Message::Binary(vec![index as u8].into()))
                .await
                .unwrap();
        }
        assert_eq!(sink.capacity(), 0);
        assert!(
            timeout(
                Duration::from_millis(5),
                sink.send(Message::Binary(vec![99].into()))
            )
            .await
            .is_err()
        );
        assert_eq!(rx.recv().await.unwrap(), Message::Binary(vec![0].into()));
        sink.send(Message::Binary(vec![99].into())).await.unwrap();
        for index in 1..OUTPUT_QUEUE {
            assert_eq!(
                rx.recv().await.unwrap(),
                Message::Binary(vec![index as u8].into())
            );
        }
        assert_eq!(rx.recv().await.unwrap(), Message::Binary(vec![99].into()));
        sink.close().await.unwrap();
        assert!(rx.recv().await.is_none());
    }
}
