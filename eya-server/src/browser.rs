//! Noise-authenticated, bounded upstream HTTP relay for the standalone browser panel.
//!
//! Browser pages never receive this transport key and never navigate an iframe to an
//! upstream URL. The client uses a separate WebSocket because proxy response bodies
//! can be long lived and must not stall the resumable terminal actor.
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures_util::{SinkExt, Stream, StreamExt};
use reqwest::{
    Client, Method, Url,
    header::{HeaderMap, HeaderName, HeaderValue},
};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    io::{self, BufRead, Read},
    net::{IpAddr, SocketAddr},
    pin::Pin,
    sync::Mutex,
    task::{Context, Poll},
    time::Instant,
};
use tokio::{
    net::TcpStream,
    sync::{OwnedSemaphorePermit, mpsc, watch},
    task::JoinSet,
};
use tokio_tungstenite::{
    Connector, client_async_tls_with_config,
    tungstenite::{
        client::IntoClientRequest,
        http::{HeaderName as WsHeaderName, HeaderValue as WsHeaderValue},
        protocol::{Message as UpstreamMessage, WebSocketConfig},
    },
};

const PROLOGUE: &[u8] = b"eya-browser-v1";
const READY: &[u8] = b"eya-browser-ready-v1";
const REQUEST: u8 = 1;
const RESPONSE_META: u8 = 2;
const RESPONSE_CHUNK: u8 = 3;
const CANCEL: u8 = 4;
const CREDIT: u8 = 5;
const WS_OPEN: u8 = 6;
const WS_OPEN_RESULT: u8 = 7;
const WS_SEND: u8 = 8;
const WS_RECV: u8 = 9;
const WS_CLOSE: u8 = 10;
const WS_CREDIT: u8 = 11;
const WS_SEND_CREDIT: u8 = 12;
const UPLOAD_CHUNK: u8 = 13;
const UPLOAD_CREDIT: u8 = 14;
const MAX_MESSAGE: usize = 65_535;
const CHUNK_BYTES: usize = 48 * 1024;
const MAX_WS_MESSAGE: usize = 1024 * 1024;
const MAX_WS_SOCKETS_PER_SESSION: usize = 8;
const WS_SEND_WINDOW: usize = 8;
const MAX_CREDIT_BYTES: usize = CHUNK_BYTES * 4;
const MAX_INLINE_REQUEST_BODY: usize = 40 * 1024;
const MAX_UPLOAD_BODY: usize = 4 * 1024 * 1024;
const UPLOAD_BUDGET_UNIT: usize = 64 * 1024;
const MAX_UPLOAD_BUDGET_UNITS: usize = 256;
const UPLOAD_WINDOW_CHUNKS: u32 = 4;
const MAX_RESPONSE_BODY: usize = 64 * 1024 * 1024;
// Bound gzip optional headers and streams spending input without producing
// output, independently of the encoded/decoded response limits.
const MAX_COMPRESSED_INPUT_WITHOUT_OUTPUT: usize = 128 * 1024;
const MAX_CACHE_ENTRY_BYTES: usize = 1024 * 1024;
const MAX_CACHE_ENTRY_OVERHEAD: usize = 32 * 1024;
const MAX_CACHE_BYTES: usize = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES: usize = 128;
const MAX_CACHE_AGE: Duration = Duration::from_secs(60 * 60);
const MAX_STALE_CACHE_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_REQUESTS: usize = 12;
const MAX_REDIRECTS: usize = 10;
const DNS_LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);
const DNS_PIN_TTL: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct Proxy {
    clients: Arc<Mutex<HashMap<(String, u16), PinnedClient>>>,
    response_cache: Arc<Mutex<ResponseCache>>,
    inflight_cacheable: Arc<Mutex<HashMap<String, Arc<InflightResponse>>>>,
    request_slots: Arc<Semaphore>,
    websocket_slots: Arc<Semaphore>,
    upload_memory: Arc<Semaphore>,
    local_addresses: HashSet<IpAddr>,
}

#[derive(Default)]
struct ResponseCache {
    entries: Vec<CachedResponse>,
    bytes: usize,
    stamp: u64,
}

#[derive(Clone)]
struct CachedResponse {
    url: String,
    vary: Vec<(String, String)>,
    status: u16,
    headers: serde_json::Map<String, serde_json::Value>,
    body: Arc<[u8]>,
    expires_at: Instant,
    stale_until: Instant,
    stamp: u64,
    weight: usize,
}

struct InflightResponse {
    result: watch::Sender<Option<Option<CachedResponse>>>,
}

struct InflightLeader {
    proxy: Arc<Proxy>,
    key: String,
    response: Arc<InflightResponse>,
    finished: bool,
}

impl InflightLeader {
    fn finish(mut self, result: Option<CachedResponse>) {
        self.response.result.send_replace(Some(result));
        if let Ok(mut inflight) = self.proxy.inflight_cacheable.lock()
            && inflight
                .get(&self.key)
                .is_some_and(|current| Arc::ptr_eq(current, &self.response))
        {
            inflight.remove(&self.key);
        }
        self.finished = true;
    }
}

impl Drop for InflightLeader {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        self.response.result.send_replace(Some(None));
        if let Ok(mut inflight) = self.proxy.inflight_cacheable.lock()
            && inflight
                .get(&self.key)
                .is_some_and(|current| Arc::ptr_eq(current, &self.response))
        {
            inflight.remove(&self.key);
        }
    }
}

struct PinnedClient {
    client: Client,
    addresses: Vec<SocketAddr>,
    resolved_at: Instant,
    used: Instant,
}

impl Proxy {
    pub fn new() -> io::Result<Self> {
        Ok(Self {
            clients: Arc::new(Mutex::new(HashMap::new())),
            response_cache: Arc::new(Mutex::new(ResponseCache::default())),
            inflight_cacheable: Arc::new(Mutex::new(HashMap::new())),
            request_slots: Arc::new(Semaphore::new(32)),
            websocket_slots: Arc::new(Semaphore::new(32)),
            upload_memory: Arc::new(Semaphore::new(MAX_UPLOAD_BUDGET_UNITS)),
            local_addresses: local_addresses()?,
        })
    }

    async fn client_for(&self, url: &Url) -> Result<(Client, OwnedSemaphorePermit), String> {
        let permit = self
            .request_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| "The upstream request limit is busy")?;
        let host = url.host_str().ok_or("URL must have a hostname")?;
        let port = url.port_or_known_default().ok_or("URL has no port")?;
        let key = (host.to_ascii_lowercase(), port);
        let now = Instant::now();
        if let Ok(mut clients) = self.clients.lock() {
            if let Some(entry) = clients.get_mut(&key) {
                if dns_pin_is_fresh(entry.resolved_at, now) {
                    entry.used = now;
                    return Ok((entry.client.clone(), permit));
                }
            }
        }

        let resolved =
            with_dns_timeout(DNS_LOOKUP_TIMEOUT, tokio::net::lookup_host((host, port))).await?;
        let addrs = resolved
            .map_err(|_| "Could not resolve the destination host")?
            .collect::<Vec<_>>();
        let pinned = validate_pinned_addresses(addrs, &self.local_addresses)?;
        let resolved_at = Instant::now();

        if let Ok(mut clients) = self.clients.lock() {
            if let Some(entry) = clients.get_mut(&key) {
                if entry.addresses == pinned {
                    entry.resolved_at = resolved_at;
                    entry.used = resolved_at;
                    let client = entry.client.clone();
                    return Ok((client, permit));
                }
            }
        }

        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(90))
            .pool_idle_timeout(Duration::from_secs(45))
            .pool_max_idle_per_host(4)
            .user_agent("Mozilla/5.0 (compatible; EyaBrowser/1.0)")
            .resolve_to_addrs(host, &pinned)
            .build()
            .map_err(|_| "Could not prepare an upstream connection")?;

        if let Ok(mut clients) = self.clients.lock() {
            if clients.len() >= 128 {
                if let Some(oldest) = clients
                    .iter()
                    .min_by_key(|(_, entry)| entry.used)
                    .map(|(key, _)| key.clone())
                {
                    clients.remove(&oldest);
                }
            }
            clients.insert(
                key,
                PinnedClient {
                    client: client.clone(),
                    addresses: pinned,
                    resolved_at,
                    used: resolved_at,
                },
            );
        }
        Ok((client, permit))
    }

    fn cached_response(&self, url: &Url, request_headers: &HeaderMap) -> Option<CachedResponse> {
        let mut cache = self.response_cache.lock().ok()?;
        let now = Instant::now();
        let url_text = url.as_str();
        let mut expired_bytes = 0usize;
        cache.entries.retain(|entry| {
            let has_validator =
                entry.headers.contains_key("etag") || entry.headers.contains_key("last-modified");
            let keep = entry.expires_at > now || (has_validator && entry.stale_until > now);
            if !keep {
                expired_bytes += entry.weight;
            }
            keep
        });
        cache.bytes = cache.bytes.saturating_sub(expired_bytes);
        let index = cache.entries.iter().position(|entry| {
            entry.url == url_text && cache_vary_matches(&entry.vary, request_headers)
        })?;
        cache.stamp = cache.stamp.wrapping_add(1).max(1);
        let stamp = cache.stamp;
        let entry = &mut cache.entries[index];
        entry.stamp = stamp;
        Some(entry.clone())
    }

    fn cache_response(&self, entry: CachedResponse) {
        if entry.body.is_empty() || entry.body.len() > MAX_CACHE_ENTRY_BYTES {
            return;
        }
        let overhead = entry.url.len()
            + serde_json::to_vec(&entry.headers).map_or(usize::MAX, |bytes| bytes.len())
            + entry
                .vary
                .iter()
                .map(|(name, value)| name.len() + value.len())
                .sum::<usize>();
        if overhead > MAX_CACHE_ENTRY_OVERHEAD {
            return;
        }
        let Ok(mut cache) = self.response_cache.lock() else {
            return;
        };
        if let Some(index) = cache
            .entries
            .iter()
            .position(|old| old.url == entry.url && old.vary == entry.vary)
        {
            let old = cache.entries.remove(index);
            cache.bytes = cache.bytes.saturating_sub(old.weight);
        }
        let mut entry = entry;
        entry.weight = entry.body.len() + overhead;
        while cache.entries.len() >= MAX_CACHE_ENTRIES
            || entry.weight > MAX_CACHE_BYTES.saturating_sub(cache.bytes)
        {
            let Some((index, _)) = cache
                .entries
                .iter()
                .enumerate()
                .min_by_key(|(_, old)| old.stamp)
            else {
                return;
            };
            let old = cache.entries.remove(index);
            cache.bytes = cache.bytes.saturating_sub(old.weight);
        }
        cache.stamp = cache.stamp.wrapping_add(1).max(1);
        entry.stamp = cache.stamp;
        cache.bytes += entry.weight;
        cache.entries.push(entry);
    }

    fn remove_cached_response(&self, url: &str, vary: &[(String, String)]) {
        let Ok(mut cache) = self.response_cache.lock() else {
            return;
        };
        if let Some(index) = cache
            .entries
            .iter()
            .position(|entry| entry.url == url && entry.vary == vary)
        {
            let entry = cache.entries.remove(index);
            cache.bytes = cache.bytes.saturating_sub(entry.weight);
        }
    }

    fn join_cacheable_request(
        self: &Arc<Self>,
        key: String,
    ) -> Result<(Arc<InflightResponse>, Option<InflightLeader>), ()> {
        let mut inflight = self.inflight_cacheable.lock().map_err(|_| ())?;
        if let Some(response) = inflight.get(&key) {
            return Ok((response.clone(), None));
        }
        let (result, _) = watch::channel(None);
        let response = Arc::new(InflightResponse { result });
        inflight.insert(key.clone(), response.clone());
        let leader = InflightLeader {
            proxy: self.clone(),
            key,
            response: response.clone(),
            finished: false,
        };
        Ok((response, Some(leader)))
    }

    pub(super) async fn websocket_targets(&self, url: &Url) -> Result<Vec<SocketAddr>, String> {
        let (client, permit) = self.client_for(url).await?;
        drop(client);
        let host = url.host_str().ok_or("URL must have a hostname")?;
        let port = url.port_or_known_default().ok_or("URL has no port")?;
        let key = (host.to_ascii_lowercase(), port);
        let addresses = self
            .clients
            .lock()
            .ok()
            .and_then(|clients| clients.get(&key).map(|entry| entry.addresses.clone()))
            .ok_or("Could not pin the destination address")?;
        if addresses.is_empty() {
            return Err("Could not pin the destination address".into());
        }
        drop(permit);
        Ok(addresses)
    }
}

async fn with_dns_timeout<F, T>(limit: Duration, lookup: F) -> Result<T, &'static str>
where
    F: Future<Output = T>,
{
    timeout(limit, lookup)
        .await
        .map_err(|_| "Destination DNS lookup timed out")
}

fn dns_pin_is_fresh(resolved_at: Instant, now: Instant) -> bool {
    now.saturating_duration_since(resolved_at) < DNS_PIN_TTL
}

fn validate_pinned_addresses(
    addrs: impl IntoIterator<Item = SocketAddr>,
    local_addresses: &HashSet<IpAddr>,
) -> Result<Vec<SocketAddr>, String> {
    let mut pinned = addrs.into_iter().collect::<Vec<_>>();
    if pinned.is_empty()
        || pinned
            .iter()
            .any(|addr| !is_public_ip(addr.ip()) || local_addresses.contains(&addr.ip()))
    {
        return Err("Private or reserved network destinations are blocked".into());
    }
    pinned.sort_unstable();
    pinned.dedup();
    Ok(pinned)
}

fn local_addresses() -> io::Result<HashSet<IpAddr>> {
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut head) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let mut addresses = HashSet::new();
    let mut current = head;
    while !current.is_null() {
        let entry = unsafe { &*current };
        if !entry.ifa_addr.is_null() {
            match unsafe { (*entry.ifa_addr).sa_family as i32 } {
                libc::AF_INET => {
                    let addr = unsafe { &*(entry.ifa_addr as *const libc::sockaddr_in) };
                    addresses.insert(IpAddr::V4(std::net::Ipv4Addr::from(
                        addr.sin_addr.s_addr.to_ne_bytes(),
                    )));
                }
                libc::AF_INET6 => {
                    let addr = unsafe { &*(entry.ifa_addr as *const libc::sockaddr_in6) };
                    addresses.insert(IpAddr::V6(std::net::Ipv6Addr::from(addr.sin6_addr.s6_addr)));
                }
                _ => {}
            }
        }
        current = entry.ifa_next;
    }
    unsafe { libc::freeifaddrs(head) };
    Ok(addresses)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserRequest {
    id: u32,
    url: String,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body_base64: Option<String>,
    #[serde(default)]
    body_size: Option<usize>,
    #[serde(default)]
    initial_credit: u32,
    #[serde(default)]
    bypass_cache: bool,
    #[serde(default = "default_follow_redirects")]
    follow_redirects: bool,
}

fn default_follow_redirects() -> bool {
    true
}

struct PendingUpload {
    request: BrowserRequest,
    body: Vec<u8>,
    expected: usize,
    next_chunk: u32,
    credits_remaining: u32,
    started_at: Instant,
    _memory_permit: OwnedSemaphorePermit,
}

fn accept_upload_chunk(
    upload: &mut PendingUpload,
    sequence: u32,
    final_chunk: bool,
    chunk: &[u8],
) -> Result<bool, &'static str> {
    if chunk.is_empty() || chunk.len() > CHUNK_BYTES {
        return Err("Invalid upload chunk size");
    }
    if upload.credits_remaining == 0 {
        return Err("Upload chunk exceeded the granted window");
    }
    if sequence != upload.next_chunk {
        return Err("Upload chunks arrived out of order");
    }
    if upload.body.len().saturating_add(chunk.len()) > upload.expected {
        return Err("Upload exceeded its declared size");
    }
    upload.credits_remaining -= 1;
    upload.body.extend_from_slice(chunk);
    upload.next_chunk = upload.next_chunk.wrapping_add(1);
    let complete = upload.body.len() == upload.expected;
    if final_chunk != complete {
        return Err("Upload final marker did not match its declared size");
    }
    Ok(complete)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserWebSocketOpen {
    id: u32,
    url: String,
    #[serde(default)]
    protocols: Vec<String>,
    #[serde(default)]
    origin: String,
    #[serde(default)]
    cookie: String,
}

enum BrowserWebSocketCommand {
    Send {
        message_id: u32,
        kind: u8,
        final_chunk: bool,
        bytes: Vec<u8>,
    },
    Close {
        code: u16,
        reason: String,
    },
    Credit,
}

fn default_method() -> String {
    "GET".into()
}

pub async fn upgrade(State(app): State<App>, ws: WebSocketUpgrade) -> impl IntoResponse {
    let proxy = app.browser.clone();
    let slots = app.browser_slots.clone();
    ws.max_message_size(MAX_MESSAGE)
        .max_frame_size(MAX_MESSAGE)
        .on_upgrade(move |socket| session(socket, app.key.clone(), proxy, slots))
}

async fn session(
    mut socket: WebSocket,
    key: Arc<[u8; 32]>,
    proxy: Arc<Proxy>,
    slots: Arc<crate::server_config::Slots>,
) {
    let Ok(_slot) = slots.try_acquire_owned() else {
        return;
    };
    let Ok(params) = PROTOCOL.parse() else { return };
    let Ok(mut noise) = snow::Builder::new(params)
        .psk(0, key.as_ref())
        .prologue(PROLOGUE)
        .build_responder()
    else {
        return;
    };
    let first = match timeout(Duration::from_secs(10), socket.recv()).await {
        Ok(Some(Ok(Message::Binary(first)))) => first,
        _ => return,
    };
    let mut plain = vec![0u8; MAX_MESSAGE];
    let mut cipher = vec![0u8; MAX_MESSAGE];
    if noise.read_message(&first, &mut plain).is_err() {
        return;
    }
    let Ok(size) = noise.write_message(&[], &mut cipher) else {
        return;
    };
    if socket
        .send(Message::Binary(cipher[..size].to_vec().into()))
        .await
        .is_err()
    {
        return;
    }
    let Ok(mut noise) = noise.into_transport_mode() else {
        return;
    };
    let confirm = match timeout(Duration::from_secs(10), socket.recv()).await {
        Ok(Some(Ok(Message::Binary(confirm)))) => confirm,
        _ => return,
    };
    let Ok(count) = noise.read_message(&confirm, &mut plain) else {
        return;
    };
    if &plain[..count] != READY {
        return;
    }
    let Ok(size) = noise.write_message(b"eya-browser-ready-v1", &mut cipher) else {
        return;
    };
    if socket
        .send(Message::Binary(cipher[..size].to_vec().into()))
        .await
        .is_err()
    {
        return;
    }
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(16);
    let mut tasks = JoinSet::new();
    let mut in_flight = HashSet::<u32>::new();
    let mut abort_handles = HashMap::new();
    let mut credit_senders = HashMap::<u32, mpsc::Sender<u32>>::new();
    let mut pending_uploads = HashMap::<u32, PendingUpload>::new();
    let mut websocket_senders = HashMap::<u32, mpsc::Sender<BrowserWebSocketCommand>>::new();
    let mut websocket_tasks = HashMap::<u32, tokio::task::AbortHandle>::new();
    let mut websocket_cleanup = tokio::time::interval(Duration::from_millis(100));
    let mut upload_cleanup = tokio::time::interval(Duration::from_secs(5));
    let mut outgoing = vec![0u8; MAX_MESSAGE];
    loop {
        tokio::select! {
            incoming = receiver.next() => match incoming {
                Some(Ok(Message::Binary(data))) => {
                    let Ok(count) = noise.read_message(&data, &mut plain) else { break };
                    if count == 0 { break; }
                    match plain[0] {
                        REQUEST => {
                            let Ok(request) = serde_json::from_slice::<BrowserRequest>(&plain[1..count]) else { break };
                            if request.id == 0 || in_flight.len() >= MAX_REQUESTS || !in_flight.insert(request.id) {
                                let error = event_meta(request.id, 429, "Too many active requests");
                                if tx.send(error).await.is_err() { break; }
                                continue;
                            }
                            if let Some(expected) = request.body_size {
                                if request.body_base64.is_some() || !(MAX_INLINE_REQUEST_BODY + 1..=MAX_UPLOAD_BODY).contains(&expected) {
                                    in_flight.remove(&request.id);
                                    if tx.send(event_meta(request.id, 413, "Invalid or oversized upload body")).await.is_err() { break; }
                                    continue;
                                }
                                let units = expected.div_ceil(UPLOAD_BUDGET_UNIT) as u32;
                                let Ok(memory_permit) = proxy.upload_memory.clone().try_acquire_many_owned(units) else {
                                    in_flight.remove(&request.id);
                                    if tx.send(event_meta(request.id, 429, "The browser upload memory budget is busy")).await.is_err() { break; }
                                    continue;
                                };
                                let mut body = Vec::new();
                                if body.try_reserve_exact(expected).is_err() {
                                    in_flight.remove(&request.id);
                                    drop(memory_permit);
                                    if tx.send(event_meta(request.id, 503, "Could not reserve upload memory")).await.is_err() { break; }
                                    continue;
                                }
                                let request_id = request.id;
                                pending_uploads.insert(request_id, PendingUpload { request, body, expected, next_chunk: 0, credits_remaining: UPLOAD_WINDOW_CHUNKS, started_at: Instant::now(), _memory_permit: memory_permit });
                                if tx.send(event_upload_credit(request_id, UPLOAD_WINDOW_CHUNKS)).await.is_err() { break; }
                                continue;
                            }
                            let proxy = proxy.clone();
                            let tx = tx.clone();
                            let request_id = request.id;
                            let (credit_tx, credit_rx) = mpsc::channel(4);
                            credit_senders.insert(request_id, credit_tx);
                            let handle = tasks.spawn(async move {
                                let id = request_id;
                                let result = fetch(request, None, proxy, tx.clone(), credit_rx).await;
                                if let Err(message) = result {
                                    let _ = tx.send(event_meta(id, 502, &message)).await;
                                    let _ = tx.send(event_chunk(id, true, &[])).await;
                                }
                                id
                            });
                            abort_handles.insert(request_id, handle);
                        }
                        CANCEL if count == 5 => {
                            let id = u32::from_be_bytes(plain[1..5].try_into().unwrap());
                            if let Some(handle) = abort_handles.remove(&id) { handle.abort(); }
                            pending_uploads.remove(&id);
                            credit_senders.remove(&id);
                            in_flight.remove(&id);
                        }
                        CREDIT if count == 9 => {
                            let id = u32::from_be_bytes(plain[1..5].try_into().unwrap());
                            let bytes = u32::from_be_bytes(plain[5..9].try_into().unwrap());
                            if accept_response_credit(&credit_senders, id, bytes).is_err() { break; }
                        }
                        UPLOAD_CHUNK if count >= 10 => {
                            let id = u32::from_be_bytes(plain[1..5].try_into().unwrap());
                            let sequence = u32::from_be_bytes(plain[5..9].try_into().unwrap());
                            if plain[9] > 1 { break; }
                            let final_chunk = plain[9] == 1;
                            let chunk = &plain[10..count];
                            let Some(upload) = pending_uploads.get_mut(&id) else { continue };
                            let complete = match accept_upload_chunk(upload, sequence, final_chunk, chunk) {
                                Ok(complete) => complete,
                                Err(_) => break,
                            };
                            if complete {
                                let Some(upload) = pending_uploads.remove(&id) else { break };
                                let request = upload.request;
                                let body = upload.body;
                                let memory_permit = upload._memory_permit;
                                let proxy = proxy.clone();
                                let tx = tx.clone();
                                let (credit_tx, credit_rx) = mpsc::channel(4);
                                credit_senders.insert(id, credit_tx);
                                let handle = tasks.spawn(async move {
                                    let _memory_permit = memory_permit;
                                    let result = fetch(request, Some(body), proxy, tx.clone(), credit_rx).await;
                                    if let Err(message) = result {
                                        let _ = tx.send(event_meta(id, 502, &message)).await;
                                        let _ = tx.send(event_chunk(id, true, &[])).await;
                                    }
                                    id
                                });
                                abort_handles.insert(id, handle);
                            } else {
                                upload.credits_remaining += 1;
                                if tx.send(event_upload_credit(id, 1)).await.is_err() { break; }
                            }
                        }
                        WS_OPEN => {
                            let Ok(open) = serde_json::from_slice::<BrowserWebSocketOpen>(&plain[1..count]) else { break };
                            if open.id == 0 || websocket_senders.contains_key(&open.id) || websocket_senders.len() >= MAX_WS_SOCKETS_PER_SESSION {
                                let _ = tx.send(websocket_open_result(open.id, false, "Too many active WebSockets", "")).await;
                                continue;
                            }
                            let Ok(_socket_permit) = proxy.websocket_slots.clone().try_acquire_owned() else {
                                let _ = tx.send(websocket_open_result(open.id, false, "The upstream WebSocket limit is busy", "")).await;
                                continue;
                            };
                            let (command_tx, command_rx) = mpsc::channel(WS_SEND_WINDOW);
                            let proxy = proxy.clone();
                            let tx = tx.clone();
                            let socket_id = open.id;
                            let handle = tokio::spawn(async move {
                                websocket_relay(open, proxy, _socket_permit, command_rx, tx).await;
                            });
                            websocket_senders.insert(socket_id, command_tx);
                            websocket_tasks.insert(socket_id, handle.abort_handle());
                        }
                        WS_SEND if count >= 11 => {
                            let id = u32::from_be_bytes(plain[1..5].try_into().unwrap());
                            let message_id = u32::from_be_bytes(plain[5..9].try_into().unwrap());
                            let kind = plain[9];
                            let final_chunk = plain[10] != 0;
                            if !matches!(kind, 1 | 2) || count - 11 > CHUNK_BYTES { break; }
                            let Some(sender) = websocket_senders.get(&id) else { continue };
                            if sender.try_send(BrowserWebSocketCommand::Send {
                                message_id, kind, final_chunk, bytes: plain[11..count].to_vec(),
                            }).is_err() {
                                let _ = tx.send(websocket_close_event(id, 1006, "Page WebSocket send queue is full")).await;
                                if let Some(handle) = websocket_tasks.remove(&id) { handle.abort(); }
                                websocket_senders.remove(&id);
                            }
                        }
                        WS_CLOSE if count >= 7 => {
                            let id = u32::from_be_bytes(plain[1..5].try_into().unwrap());
                            let code = u16::from_be_bytes(plain[5..7].try_into().unwrap());
                            let Ok(reason) = String::from_utf8(plain[7..count].to_vec()) else { break };
                            if let Some(sender) = websocket_senders.get(&id) {
                                if sender.try_send(BrowserWebSocketCommand::Close { code, reason }).is_err() {
                                    if let Some(handle) = websocket_tasks.remove(&id) { handle.abort(); }
                                    websocket_senders.remove(&id);
                                    let _ = tx.send(websocket_close_event(id, 1006, "WebSocket closed")).await;
                                }
                            }
                        }
                        WS_CREDIT if count == 5 => {
                            let id = u32::from_be_bytes(plain[1..5].try_into().unwrap());
                            if let Some(sender) = websocket_senders.get(&id) { let _ = sender.try_send(BrowserWebSocketCommand::Credit); }
                        }
                        _ => break,
                    }
                }
                Some(Ok(Message::Ping(data))) => if sender.send(Message::Pong(data)).await.is_err() { break },
                Some(Ok(Message::Pong(_))) => {},
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => break,
            },
            event = rx.recv() => match event {
                Some(event) => {
                    if event.first() == Some(&RESPONSE_CHUNK) && event.len() >= 6 && event[5] != 0 {
                        let id = u32::from_be_bytes(event[1..5].try_into().unwrap());
                        in_flight.remove(&id);
                        credit_senders.remove(&id);
                    }
                    let Ok(size) = noise.write_message(&event, &mut outgoing) else { break };
                    if !matches!(
                        timeout(
                            Duration::from_secs(5),
                            sender.send(Message::Binary(outgoing[..size].to_vec().into())),
                        )
                        .await,
                        Ok(Ok(()))
                    ) {
                        break;
                    }
                }
                None => break,
            },
            Some(result) = tasks.join_next(), if !tasks.is_empty() => {
                if let Ok(id) = result { abort_handles.remove(&id); }
            },
            _ = upload_cleanup.tick(), if !pending_uploads.is_empty() => {
                let expired = pending_uploads.iter()
                    .filter_map(|(id, upload)| (upload.started_at.elapsed() > Duration::from_secs(120)).then_some(*id))
                    .collect::<Vec<_>>();
                for id in expired {
                    pending_uploads.remove(&id);
                    in_flight.remove(&id);
                    let _ = tx.send(event_meta(id, 408, "Upload did not finish before the timeout")).await;
                }
            },
                _ = websocket_cleanup.tick(), if !websocket_tasks.is_empty() => {
                    websocket_tasks.retain(|_, handle| !handle.is_finished());
                    websocket_senders.retain(|id, _| websocket_tasks.contains_key(id));
                },
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    for (_, handle) in websocket_tasks {
        handle.abort();
    }
}

async fn fetch(
    request: BrowserRequest,
    uploaded_body: Option<Vec<u8>>,
    proxy: Arc<Proxy>,
    tx: mpsc::Sender<Vec<u8>>,
    mut credit_rx: mpsc::Receiver<u32>,
) -> Result<(), String> {
    if request.id == 0 {
        return Err("Invalid request id".into());
    }
    let mut url = Url::parse(&request.url).map_err(|_| "Invalid URL")?;
    if request.url.len() > 8192 {
        return Err("URL exceeds the browser proxy limit".into());
    }
    if !matches!(url.scheme(), "http" | "https") || url.username() != "" || url.password().is_some()
    {
        return Err("Only credential-free HTTP and HTTPS URLs are supported".into());
    }
    let mut method =
        Method::from_bytes(request.method.as_bytes()).map_err(|_| "Invalid HTTP method")?;
    if !matches!(
        method,
        Method::GET
            | Method::HEAD
            | Method::POST
            | Method::PUT
            | Method::PATCH
            | Method::DELETE
            | Method::OPTIONS
    ) {
        return Err("Unsupported HTTP method".into());
    }
    if request.headers.len() > 24 {
        return Err("Too many request headers".into());
    }
    if request
        .headers
        .iter()
        .map(|(name, value)| name.len() + value.len())
        .sum::<usize>()
        > 16 * 1024
    {
        return Err("Request headers exceed the browser proxy limit".into());
    }
    let mut headers = HeaderMap::new();
    for (name, value) in request.headers {
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| "Invalid request header")?;
        if !is_forwardable_browser_header(name.as_str()) {
            continue;
        }
        let value = HeaderValue::from_str(&value).map_err(|_| "Invalid request header value")?;
        if value.as_bytes().len() > 4096 {
            return Err("Request header is too large".into());
        }
        headers.insert(name, value);
    }
    let mut body = if let Some(body) = uploaded_body {
        if body.len() > MAX_UPLOAD_BODY {
            return Err("Request body exceeds the browser proxy limit".into());
        }
        Some(bytes::Bytes::from(body))
    } else {
        match request.body_base64 {
            Some(value) => {
                let body = BASE64
                    .decode(value)
                    .map_err(|_| "Invalid request body encoding")?;
                if body.len() > MAX_INLINE_REQUEST_BODY {
                    return Err("Request body exceeds the browser proxy limit".into());
                }
                Some(bytes::Bytes::from(body))
            }
            None => None,
        }
    };
    let mut available_credit = request.initial_credit as usize;
    if available_credit > CHUNK_BYTES {
        return Err("Invalid initial response credit".into());
    }

    let mut inflight_leader = None;
    if !request.bypass_cache && cache_request_allowed(&method, &headers, body.as_deref()) {
        // A completed response-cache lookup happens in the redirect loop below. Join
        // a single in-flight fill only after confirming there is no fresh or stale
        // entry to serve or revalidate.
        if proxy.cached_response(&url, &headers).is_none() {
            let key = cache_flight_key(&url, &headers);
            if let Ok((inflight, leader)) = proxy.join_cacheable_request(key) {
                if let Some(leader) = leader {
                    inflight_leader = Some(leader);
                } else {
                    let mut result = inflight.result.subscribe();
                    let shared = loop {
                        if let Some(value) = result.borrow().clone() {
                            break value;
                        }
                        if result.changed().await.is_err() {
                            break None;
                        }
                    };
                    if let Some(cached) = shared {
                        send_cached_response(
                            request.id,
                            cached.status,
                            cached.headers,
                            Vec::new(),
                            cached.url,
                            true,
                            &cached.body,
                            &tx,
                            &mut credit_rx,
                            &mut available_credit,
                        )
                        .await?;
                        return Ok(());
                    }
                }
            }
        }
    }

    let mut cookie_events = Vec::new();
    let mut cookie_event_count = 0usize;
    let mut cookie_event_bytes = 0usize;
    let cache_key_headers = headers.clone();
    let mut stale_cache = None;
    for redirect in 0..=MAX_REDIRECTS {
        if redirect == 0
            && !request.bypass_cache
            && cache_request_allowed(&method, &cache_key_headers, body.as_deref())
        {
            if let Some(cached) = proxy.cached_response(&url, &cache_key_headers) {
                if cached.expires_at > Instant::now() {
                    send_cached_response(
                        request.id,
                        cached.status,
                        cached.headers,
                        Vec::new(),
                        cached.url,
                        true,
                        &cached.body,
                        &tx,
                        &mut credit_rx,
                        &mut available_credit,
                    )
                    .await?;
                    return Ok(());
                }
                if let Some(etag) = cached.headers.get("etag").and_then(|value| value.as_str()) {
                    if let Ok(value) = HeaderValue::from_str(etag) {
                        headers.insert(reqwest::header::IF_NONE_MATCH, value);
                    }
                }
                if let Some(modified) = cached
                    .headers
                    .get("last-modified")
                    .and_then(|value| value.as_str())
                {
                    if let Ok(value) = HeaderValue::from_str(modified) {
                        headers.insert(reqwest::header::IF_MODIFIED_SINCE, value);
                    }
                }
                if headers.contains_key(reqwest::header::IF_NONE_MATCH)
                    || headers.contains_key(reqwest::header::IF_MODIFIED_SINCE)
                {
                    stale_cache = Some(cached);
                }
            }
        }
        let (client, _permit) = proxy.client_for(&url).await?;
        let mut builder = client
            .request(method.clone(), url.clone())
            .headers(headers.clone())
            // The client rebuilds browser Response objects from these bytes. Ask
            // upstreams for identity bytes, while tolerating servers that return
            // gzip/deflate anyway through the bounded decoder below.
            .header(reqwest::header::ACCEPT_ENCODING, "identity");
        if let Some(bytes) = body.clone() {
            builder = builder.body(bytes);
        }
        let response = builder
            .send()
            .await
            .map_err(|_| "The upstream request failed")?;
        if response.status() == reqwest::StatusCode::NOT_MODIFIED
            && redirect == 0
            && let Some(cached) = stale_cache.take()
        {
            let cookies = collect_set_cookies(response.headers());
            append_cookie_event(
                &mut cookie_events,
                &mut cookie_event_count,
                &mut cookie_event_bytes,
                &url,
                &cookies,
            );
            let mut response_headers = cached.headers.clone();
            for name in [
                "cache-control",
                "date",
                "age",
                "expires",
                "etag",
                "last-modified",
                "vary",
                "content-type",
            ] {
                if let Some(value) = response
                    .headers()
                    .get(name)
                    .and_then(|value| value.to_str().ok())
                {
                    response_headers.insert(name.into(), value.into());
                }
            }
            let merged_headers = cached_header_map(&response_headers);
            let refresh_policy = if response.headers().contains_key(reqwest::header::SET_COOKIE) {
                None
            } else {
                response_cache_policy(reqwest::StatusCode::OK, &cache_key_headers, &merged_headers)
            };
            if let Some((ttl, vary)) = refresh_policy {
                let expires_at = Instant::now() + ttl;
                proxy.remove_cached_response(&cached.url, &cached.vary);
                proxy.cache_response(CachedResponse {
                    url: cached.url.clone(),
                    vary,
                    status: cached.status,
                    headers: response_headers.clone(),
                    body: cached.body.clone(),
                    expires_at,
                    stale_until: cache_stale_deadline(expires_at, &response_headers),
                    stamp: 0,
                    weight: 0,
                });
            }
            send_cached_response(
                request.id,
                cached.status,
                response_headers,
                cookie_events,
                cached.url,
                true,
                &cached.body,
                &tx,
                &mut credit_rx,
                &mut available_credit,
            )
            .await?;
            return Ok(());
        }
        if response.status().is_redirection() {
            if !request.follow_redirects {
                return Err("This browser request is not allowed to follow redirects".into());
            }
            if redirect == MAX_REDIRECTS {
                return Err("Too many redirects".into());
            }
            let Some(location) = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
            else {
                return Err("Invalid redirect response".into());
            };
            let next = url.join(location).map_err(|_| "Invalid redirect target")?;
            if next.scheme() != "http" && next.scheme() != "https" {
                return Err("Redirect uses an unsupported scheme".into());
            }
            let redirect_cookies = collect_set_cookies(response.headers());
            append_cookie_event(
                &mut cookie_events,
                &mut cookie_event_count,
                &mut cookie_event_bytes,
                &url,
                &redirect_cookies,
            );
            apply_redirect_cookies(&mut headers, &redirect_cookies, &url, &next);
            let cross_origin = next.scheme() != url.scheme()
                || next.host_str() != url.host_str()
                || next.port_or_known_default() != url.port_or_known_default();
            if cross_origin {
                headers.remove(reqwest::header::COOKIE);
            }
            if response.status() == reqwest::StatusCode::SEE_OTHER
                || (matches!(
                    response.status(),
                    reqwest::StatusCode::MOVED_PERMANENTLY | reqwest::StatusCode::FOUND
                ) && method == Method::POST)
            {
                if method != Method::HEAD {
                    method = Method::GET;
                }
                body = None;
                headers.remove(reqwest::header::CONTENT_TYPE);
            }
            url = next;
            continue;
        }

        let status = response.status();
        let coding = response_coding(response.headers())?;
        let has_body = method != Method::HEAD && !matches!(status.as_u16(), 204 | 205 | 304);
        validate_decoded_range(coding, has_body, status, response.headers())?;
        let mut response_headers = serde_json::Map::new();
        for name in [
            "content-type",
            "content-disposition",
            "content-length",
            "content-encoding",
            "cache-control",
            "date",
            "age",
            "expires",
            "etag",
            "last-modified",
            "accept-ranges",
            "content-range",
            "access-control-allow-origin",
            "access-control-allow-credentials",
            "access-control-allow-methods",
            "access-control-allow-headers",
            "access-control-expose-headers",
            "access-control-max-age",
            "vary",
        ] {
            if let Some(value) = response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
            {
                response_headers.insert(name.into(), value.into());
            }
        }
        if coding != ResponseCoding::Identity {
            normalize_decoded_headers(&mut response_headers);
        }
        let set_cookies = collect_set_cookies(response.headers());
        let cache_policy = if redirect == 0
            && !request.bypass_cache
            && cache_request_allowed(&method, &cache_key_headers, body.as_deref())
        {
            response_cache_policy(status, &cache_key_headers, response.headers())
        } else {
            None
        };
        let cache_expires_at = cache_policy.as_ref().map(|(ttl, _)| Instant::now() + *ttl);
        let mut cache_body = cache_policy.as_ref().map(|_| {
            Vec::with_capacity(
                response
                    .content_length()
                    .unwrap_or(0)
                    .min(MAX_CACHE_ENTRY_BYTES as u64) as usize,
            )
        });
        append_cookie_event(
            &mut cookie_events,
            &mut cookie_event_count,
            &mut cookie_event_bytes,
            &url,
            &set_cookies,
        );
        let cache_headers = response_headers.clone();
        let meta = serde_json::json!({"id":request.id,"status":status.as_u16(),"headers":response_headers,"cookies":cookie_events,"url":url.as_str(),"ok":true,"cacheHit":false});
        tx.send(encode_meta(meta))
            .await
            .map_err(|_| "The browser connection closed")?;
        let stream: ResponseBodyStream = Box::pin(
            response
                .bytes_stream()
                .map(|part| part.map_err(|_| "The upstream response stream failed".to_owned())),
        );
        let mut stream = decode_response_stream(
            stream,
            if has_body {
                coding
            } else {
                ResponseCoding::Identity
            },
            MAX_RESPONSE_BODY,
        );
        let mut total = 0usize;
        let mut buffered = Vec::with_capacity(CHUNK_BYTES);
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            total = total.saturating_add(chunk.len());
            if total > MAX_RESPONSE_BODY {
                return Err("Upstream response exceeds the browser proxy limit".into());
            }
            if cache_body.as_ref().is_some_and(|cached| {
                cached.len().saturating_add(chunk.len()) > MAX_CACHE_ENTRY_BYTES
            }) {
                cache_body = None;
            }
            if let Some(cached) = cache_body.as_mut() {
                cached.extend_from_slice(&chunk);
            }
            let mut offset = 0;
            while offset < chunk.len() {
                let count = (CHUNK_BYTES - buffered.len()).min(chunk.len() - offset);
                buffered.extend_from_slice(&chunk[offset..offset + count]);
                offset += count;
                if buffered.len() == CHUNK_BYTES {
                    send_credited_chunk(
                        request.id,
                        &buffered,
                        &mut credit_rx,
                        &mut available_credit,
                        &tx,
                    )
                    .await?;
                    buffered.clear();
                }
            }
        }
        if !buffered.is_empty() {
            send_credited_chunk(
                request.id,
                &buffered,
                &mut credit_rx,
                &mut available_credit,
                &tx,
            )
            .await?;
        }
        tx.send(event_chunk(request.id, true, &[]))
            .await
            .map_err(|_| "The browser connection closed")?;
        if let (Some((_, vary)), Some(body)) = (cache_policy, cache_body) {
            let expires_at = cache_expires_at.unwrap_or_else(Instant::now);
            let stale_until = cache_stale_deadline(expires_at, &cache_headers);
            let cached = CachedResponse {
                url: url.as_str().to_owned(),
                vary,
                status: status.as_u16(),
                headers: cache_headers,
                body: body.into(),
                expires_at,
                stale_until,
                stamp: 0,
                weight: 0,
            };
            proxy.cache_response(cached.clone());
            if let Some(leader) = inflight_leader.take() {
                leader.finish(Some(cached));
            }
        } else if let Some(leader) = inflight_leader.take() {
            leader.finish(None);
        }
        return Ok(());
    }
    Err("Too many redirects".into())
}

fn cache_stale_deadline(
    expires_at: Instant,
    headers: &serde_json::Map<String, serde_json::Value>,
) -> Instant {
    if headers.contains_key("etag") || headers.contains_key("last-modified") {
        expires_at + MAX_STALE_CACHE_AGE
    } else {
        expires_at
    }
}

fn cached_header_map(headers: &serde_json::Map<String, serde_json::Value>) -> HeaderMap {
    let mut output = HeaderMap::new();
    for (name, value) in headers {
        let (Ok(name), Some(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            value
                .as_str()
                .and_then(|value| HeaderValue::from_str(value).ok()),
        ) else {
            continue;
        };
        output.insert(name, value);
    }
    output
}

async fn send_cached_response(
    id: u32,
    status: u16,
    headers: serde_json::Map<String, serde_json::Value>,
    cookies: Vec<serde_json::Value>,
    url: String,
    cache_hit: bool,
    body: &[u8],
    tx: &mpsc::Sender<Vec<u8>>,
    credit_rx: &mut mpsc::Receiver<u32>,
    available_credit: &mut usize,
) -> Result<(), String> {
    let meta = serde_json::json!({"id":id,"status":status,"headers":headers,"cookies":cookies,"url":url,"ok":true,"cacheHit":cache_hit});
    tx.send(encode_meta(meta))
        .await
        .map_err(|_| "The browser connection closed")?;
    for chunk in body.chunks(CHUNK_BYTES) {
        send_credited_chunk(id, chunk, credit_rx, available_credit, tx).await?;
    }
    tx.send(event_chunk(id, true, &[]))
        .await
        .map_err(|_| "The browser connection closed".into())
}

fn websocket_open_result(id: u32, ok: bool, error: &str, protocol: &str) -> Vec<u8> {
    let mut event = vec![WS_OPEN_RESULT];
    event.extend_from_slice(
        &serde_json::to_vec(&serde_json::json!({
            "id": id, "ok": ok, "error": error, "protocol": protocol
        }))
        .unwrap_or_default(),
    );
    event
}

fn websocket_event_chunk(
    id: u32,
    message_id: u32,
    kind: u8,
    final_chunk: bool,
    bytes: &[u8],
) -> Vec<u8> {
    let mut event = Vec::with_capacity(11 + bytes.len());
    event.push(WS_RECV);
    event.extend_from_slice(&id.to_be_bytes());
    event.extend_from_slice(&message_id.to_be_bytes());
    event.push(kind);
    event.push(final_chunk as u8);
    event.extend_from_slice(bytes);
    event
}

fn websocket_send_credit_event(id: u32) -> Vec<u8> {
    let mut event = vec![WS_SEND_CREDIT];
    event.extend_from_slice(&id.to_be_bytes());
    event
}

fn websocket_close_event(id: u32, code: u16, reason: &str) -> Vec<u8> {
    let reason = truncate_utf8(reason, 123).into_bytes();
    let mut event = Vec::with_capacity(7 + reason.len());
    event.push(WS_CLOSE);
    event.extend_from_slice(&id.to_be_bytes());
    event.extend_from_slice(&code.to_be_bytes());
    event.extend_from_slice(&reason);
    event
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    let mut end = value.len().min(max_bytes);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn validate_websocket_protocols(protocols: &[String]) -> Result<(), String> {
    if protocols.len() > 16 {
        return Err("Too many WebSocket subprotocols".into());
    }
    let mut seen = HashSet::new();
    for protocol in protocols {
        if protocol.is_empty()
            || protocol.len() > 128
            || !protocol
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
            || !seen.insert(protocol)
        {
            return Err("Invalid WebSocket subprotocol".into());
        }
    }
    Ok(())
}

async fn forward_websocket_data(
    socket_id: u32,
    message: UpstreamMessage,
    message_id: &mut u32,
    tx: &mpsc::Sender<Vec<u8>>,
) -> bool {
    let (kind, bytes): (u8, tokio_tungstenite::tungstenite::Bytes) = match message {
        UpstreamMessage::Text(text) => {
            let bytes: &tokio_tungstenite::tungstenite::Bytes = text.as_ref();
            (1, bytes.clone())
        }
        UpstreamMessage::Binary(bytes) => (2, bytes),
        _ => return false,
    };
    if bytes.len() > MAX_WS_MESSAGE {
        return false;
    }
    *message_id = message_id.wrapping_add(1).max(1);
    let chunk_count = bytes.len().div_ceil(CHUNK_BYTES).max(1);
    for index in 0..chunk_count {
        let start = index * CHUNK_BYTES;
        let end = (start + CHUNK_BYTES).min(bytes.len());
        if tx
            .send(websocket_event_chunk(
                socket_id,
                *message_id,
                kind,
                index + 1 == chunk_count,
                &bytes[start..end],
            ))
            .await
            .is_err()
        {
            return false;
        }
    }
    true
}

async fn websocket_relay(
    open: BrowserWebSocketOpen,
    proxy: Arc<Proxy>,
    _socket_permit: OwnedSemaphorePermit,
    mut commands: mpsc::Receiver<BrowserWebSocketCommand>,
    tx: mpsc::Sender<Vec<u8>>,
) {
    let id = open.id;
    let result = websocket_handshake(&open, &proxy).await;
    let Ok((socket, protocol, cookies)) = result else {
        let message = result
            .err()
            .unwrap_or_else(|| "Upstream WebSocket failed".into());
        let _ = tx
            .send(websocket_open_result(id, false, &message, ""))
            .await;
        return;
    };
    if tx
        .send(websocket_open_success(id, &protocol, &cookies))
        .await
        .is_err()
    {
        return;
    }
    let (mut sink, mut stream) = socket.split();
    let mut message_id = 0u32;
    let mut assembly: Option<(u32, u8, Vec<u8>)> = None;
    let mut receive_credit = 1u8;
    let mut pending_upstream: Option<UpstreamMessage> = None;
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(BrowserWebSocketCommand::Send { message_id: incoming_id, kind, final_chunk, bytes }) => {
                    if bytes.len() > CHUNK_BYTES { break; }
                    if assembly.is_none() { assembly = Some((incoming_id, kind, Vec::new())); }
                    let Some((assembling_id, assembling_kind, body)) = assembly.as_mut() else { break };
                    if *assembling_id != incoming_id || *assembling_kind != kind || body.len().saturating_add(bytes.len()) > MAX_WS_MESSAGE { break; }
                    body.extend_from_slice(&bytes);
                    if final_chunk {
                        let Some((_, message_kind, body)) = assembly.take() else { break };
                        let message = if message_kind == 1 {
                            match String::from_utf8(body) { Ok(text) => UpstreamMessage::Text(text.into()), Err(_) => break }
                        } else { UpstreamMessage::Binary(body.into()) };
                        if sink.send(message).await.is_err() { break; }
                    }
                    if tx.send(websocket_send_credit_event(id)).await.is_err() { return; }
                }
                Some(BrowserWebSocketCommand::Close { code, reason }) => {
                    let code = if valid_websocket_close_code(code) { code } else { 1000 };
                    let frame = tokio_tungstenite::tungstenite::protocol::frame::CloseFrame {
                        code: code.into(), reason: reason.clone().into(),
                    };
                    let _ = sink.send(UpstreamMessage::Close(Some(frame))).await;
                    let _ = tx.send(websocket_close_event(id, code, &reason)).await;
                    return;
                }
                Some(BrowserWebSocketCommand::Credit) => {
                    if let Some(message) = pending_upstream.take() {
                        if !forward_websocket_data(id, message, &mut message_id, &tx).await {
                            let _ = tx.send(websocket_close_event(id, 1009, "WebSocket message exceeds the proxy limit")).await;
                            return;
                        }
                        receive_credit = 0;
                    } else {
                        receive_credit = 1;
                    }
                }
                None => break,
            },
            incoming = stream.next(), if pending_upstream.is_none() => match incoming {
                Some(Ok(message @ (UpstreamMessage::Text(_) | UpstreamMessage::Binary(_)))) => {
                    if receive_credit > 0 {
                        receive_credit -= 1;
                        if !forward_websocket_data(id, message, &mut message_id, &tx).await {
                            let _ = tx.send(websocket_close_event(id, 1009, "WebSocket message exceeds the proxy limit")).await;
                            return;
                        }
                    } else {
                        pending_upstream = Some(message);
                    }
                }
                Some(Ok(UpstreamMessage::Ping(payload))) => { if sink.send(UpstreamMessage::Pong(payload)).await.is_err() { break; } }
                Some(Ok(UpstreamMessage::Pong(_))) => {}
                Some(Ok(UpstreamMessage::Close(frame))) => {
                    let (code, reason) = frame.map(|frame| (u16::from(frame.code), frame.reason.to_string())).unwrap_or((1000, String::new()));
                    let _ = tx.send(websocket_close_event(id, code, &reason)).await;
                    let _ = sink.close().await;
                    return;
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break,
            }
        }
    }
    let _ = sink.send(UpstreamMessage::Close(None)).await;
    let _ = tx
        .send(websocket_close_event(
            id,
            1006,
            "WebSocket connection closed",
        ))
        .await;
}

async fn websocket_handshake(
    open: &BrowserWebSocketOpen,
    proxy: &Proxy,
) -> Result<
    (
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
        String,
        Vec<String>,
    ),
    String,
> {
    if open.url.len() > 8192 || open.cookie.len() > 16 * 1024 || open.origin.len() > 2048 {
        return Err("WebSocket request exceeds the browser proxy limit".into());
    }
    validate_websocket_protocols(&open.protocols)?;
    let mut url = Url::parse(&open.url).map_err(|_| "Invalid WebSocket URL")?;
    if !matches!(url.scheme(), "ws" | "wss")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only credential-free ws and wss URLs are supported".into());
    }
    url.set_fragment(None);
    let mut pin_url = url.clone();
    pin_url
        .set_scheme(if url.scheme() == "wss" {
            "https"
        } else {
            "http"
        })
        .map_err(|_| "Invalid WebSocket destination")?;
    pin_url.set_fragment(None);
    let addresses = proxy.websocket_targets(&pin_url).await?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| "Invalid WebSocket handshake")?;
    if !open.origin.is_empty() {
        let value =
            WsHeaderValue::from_str(&open.origin).map_err(|_| "Invalid WebSocket Origin")?;
        request
            .headers_mut()
            .insert(WsHeaderName::from_static("origin"), value);
    }
    if !open.cookie.is_empty() {
        let value =
            WsHeaderValue::from_str(&open.cookie).map_err(|_| "Invalid WebSocket cookie")?;
        request
            .headers_mut()
            .insert(WsHeaderName::from_static("cookie"), value);
    }
    if !open.protocols.is_empty() {
        let value = WsHeaderValue::from_str(&open.protocols.join(", "))
            .map_err(|_| "Invalid WebSocket subprotocol")?;
        request
            .headers_mut()
            .insert(WsHeaderName::from_static("sec-websocket-protocol"), value);
    }
    let connect_deadline = Instant::now() + Duration::from_secs(8);
    let mut connected = None;
    for address in addresses {
        let remaining = connect_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        if let Ok(Ok(stream)) = timeout(
            remaining.min(Duration::from_secs(2)),
            TcpStream::connect(address),
        )
        .await
        {
            connected = Some(stream);
            break;
        }
    }
    let tcp = connected.ok_or("Could not connect to the validated WebSocket destination")?;
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_WS_MESSAGE);
    config.max_frame_size = Some(MAX_WS_MESSAGE);
    config.write_buffer_size = 16 * 1024;
    config.max_write_buffer_size = 2 * MAX_WS_MESSAGE;
    let connector = Connector::Rustls(websocket_tls_config());
    let (socket, response) = timeout(
        Duration::from_secs(12),
        client_async_tls_with_config(request, tcp, Some(config), Some(connector)),
    )
    .await
    .map_err(|_| "Upstream WebSocket handshake timed out")?
    .map_err(|_| "The upstream rejected the WebSocket handshake")?;
    let protocol = response
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let cookies = collect_set_cookies(response.headers());
    if !protocol.is_empty() && !open.protocols.iter().any(|offered| offered == &protocol) {
        return Err("The upstream selected an unoffered WebSocket subprotocol".into());
    }
    // Keep the URL alive only through validation; its original hostname was
    // retained in the handshake request for TLS SNI and certificate checks.
    Ok((socket, protocol, cookies))
}

fn websocket_open_success(id: u32, protocol: &str, cookies: &[String]) -> Vec<u8> {
    let mut event = vec![WS_OPEN_RESULT];
    event.extend_from_slice(
        &serde_json::to_vec(&serde_json::json!({
            "id": id, "ok": true, "error": "", "protocol": protocol,
            "cookies": cookies, "sendCredit": WS_SEND_WINDOW
        }))
        .unwrap_or_default(),
    );
    event
}

fn websocket_tls_config() -> Arc<rustls::ClientConfig> {
    static CONFIG: std::sync::OnceLock<Arc<rustls::ClientConfig>> = std::sync::OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            Arc::new(
                rustls::ClientConfig::builder()
                    .with_root_certificates(roots)
                    .with_no_client_auth(),
            )
        })
        .clone()
}

fn valid_websocket_close_code(code: u16) -> bool {
    (1000..=1014).contains(&code) && !matches!(code, 1004 | 1005 | 1006)
        || (3000..=4999).contains(&code)
}

fn cache_request_allowed(method: &Method, headers: &HeaderMap, body: Option<&[u8]>) -> bool {
    if *method != Method::GET
        || body.is_some_and(|bytes| !bytes.is_empty())
        || headers.contains_key("cache-control")
        || headers.contains_key("pragma")
        || [
            "range",
            "authorization",
            "cookie",
            "if-none-match",
            "if-modified-since",
        ]
        .iter()
        .any(|name| headers.contains_key(*name))
    {
        return false;
    }
    true
}

fn cache_flight_key(url: &Url, headers: &HeaderMap) -> String {
    let accept = headers
        .get(reqwest::header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let language = headers
        .get(reqwest::header::ACCEPT_LANGUAGE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    // These are the only request-controlled fields accepted by response_cache_policy's
    // Vary handling. Accept-Encoding is fixed to identity on every upstream request.
    format!(
        "{}:{}:{}:{}:{}:{}",
        url.as_str().len(),
        url.as_str(),
        accept.len(),
        accept,
        language.len(),
        language
    )
}

fn response_cache_policy(
    status: reqwest::StatusCode,
    request_headers: &HeaderMap,
    response_headers: &HeaderMap,
) -> Option<(Duration, Vec<(String, String)>)> {
    if status != reqwest::StatusCode::OK
        || response_headers.contains_key(reqwest::header::SET_COOKIE)
        || response_headers.contains_key(reqwest::header::CONTENT_RANGE)
    {
        return None;
    }
    let mut max_age = None;
    let mut shared_max_age = None;
    let mut no_cache = false;
    let mut private = false;
    let mut no_store = false;
    for value in response_headers.get_all(reqwest::header::CACHE_CONTROL) {
        let Ok(value) = value.to_str() else {
            return None;
        };
        for directive in value.split(',').map(str::trim) {
            let (name, value) = directive.split_once('=').unwrap_or((directive, ""));
            match name.trim().to_ascii_lowercase().as_str() {
                "no-cache" => no_cache = true,
                "private" => private = true,
                "no-store" => no_store = true,
                "s-maxage" => shared_max_age = value.trim().trim_matches('"').parse::<u64>().ok(),
                "max-age" if max_age.is_none() => {
                    max_age = value.trim().trim_matches('"').parse::<u64>().ok()
                }
                _ => {}
            }
        }
    }
    if no_cache || private || no_store {
        return None;
    }
    let freshness = shared_max_age.or(max_age).filter(|age| *age > 0)?;
    let header_age = match response_headers.get(reqwest::header::AGE) {
        Some(value) => value.to_str().ok()?.parse::<u64>().ok()?,
        None => 0,
    };
    let apparent_age = response_headers
        .get(reqwest::header::DATE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| httpdate::parse_http_date(value).ok())
        .and_then(|date| std::time::SystemTime::now().duration_since(date).ok())
        .map_or(0, |duration| duration.as_secs());
    let current_age = header_age.max(apparent_age);
    let remaining = freshness.saturating_sub(current_age);
    if remaining == 0 {
        return None;
    }
    let ttl = Duration::from_secs(remaining).min(MAX_CACHE_AGE);

    let mut vary_names = Vec::new();
    for value in response_headers.get_all(reqwest::header::VARY) {
        let Ok(value) = value.to_str() else {
            return None;
        };
        for name in value
            .split(',')
            .map(|name| name.trim().to_ascii_lowercase())
        {
            if name == "*" {
                return None;
            }
            if name.is_empty()
                || !["accept", "accept-language", "accept-encoding"].contains(&name.as_str())
            {
                return None;
            }
            if !vary_names.contains(&name) {
                vary_names.push(name);
            }
        }
    }
    vary_names.sort();
    let vary = vary_names
        .into_iter()
        .map(|name| {
            let value = if name == "accept-encoding" {
                "identity".to_owned()
            } else {
                request_headers
                    .get(&name)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("")
                    .to_owned()
            };
            (name, value)
        })
        .collect();
    Some((ttl, vary))
}

fn cache_vary_matches(vary: &[(String, String)], request_headers: &HeaderMap) -> bool {
    vary.iter().all(|(name, expected)| {
        let actual = if name == "accept-encoding" {
            "identity"
        } else {
            request_headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
        };
        actual == expected
    })
}

fn is_identity_encoding(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("identity")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ResponseCoding {
    Identity,
    Gzip,
    Deflate,
}

fn response_coding(headers: &HeaderMap) -> Result<ResponseCoding, String> {
    let values = headers.get_all(reqwest::header::CONTENT_ENCODING);
    let mut values = values.iter();
    let Some(value) = values.next() else {
        return Ok(ResponseCoding::Identity);
    };
    if values.next().is_some() {
        return Err("The upstream returned stacked content encodings".into());
    }
    let value = value
        .to_str()
        .map_err(|_| "The upstream returned an invalid content encoding")?
        .trim();
    if is_identity_encoding(value) {
        Ok(ResponseCoding::Identity)
    } else if value.eq_ignore_ascii_case("gzip") || value.eq_ignore_ascii_case("x-gzip") {
        Ok(ResponseCoding::Gzip)
    } else if value.eq_ignore_ascii_case("deflate") {
        Ok(ResponseCoding::Deflate)
    } else {
        Err("The upstream returned an unsupported content encoding".into())
    }
}

fn normalize_decoded_headers(headers: &mut serde_json::Map<String, serde_json::Value>) {
    // These describe the encoded representation. Freshness still applies to the
    // decoded cached bytes, but retaining encoded validators could make a 304
    // revalidation or a caller's range request describe the wrong representation.
    for name in [
        "content-encoding",
        "content-length",
        "content-range",
        "accept-ranges",
        "etag",
        "last-modified",
    ] {
        headers.remove(name);
    }
}

fn validate_decoded_range(
    coding: ResponseCoding,
    has_body: bool,
    status: reqwest::StatusCode,
    headers: &HeaderMap,
) -> Result<(), String> {
    if coding != ResponseCoding::Identity
        && has_body
        && (status == reqwest::StatusCode::PARTIAL_CONTENT
            || headers.contains_key(reqwest::header::CONTENT_RANGE))
    {
        return Err("The upstream returned compressed partial content".into());
    }
    Ok(())
}

type ResponseBodyStream =
    Pin<Box<dyn Stream<Item = Result<bytes::Bytes, String>> + Send + 'static>>;

struct DecodeInput {
    receiver: mpsc::Receiver<Result<bytes::Bytes, io::Error>>,
    current: bytes::Bytes,
    offset: usize,
    without_output: usize,
    eof: bool,
}

impl DecodeInput {
    fn new(receiver: mpsc::Receiver<Result<bytes::Bytes, io::Error>>) -> Self {
        Self {
            receiver,
            current: bytes::Bytes::new(),
            offset: 0,
            without_output: 0,
            eof: false,
        }
    }
}

impl Read for DecodeInput {
    fn read(&mut self, into: &mut [u8]) -> io::Result<usize> {
        let available = self.fill_buf()?;
        let count = into.len().min(available.len());
        into[..count].copy_from_slice(&available[..count]);
        self.consume(count);
        Ok(count)
    }
}

impl BufRead for DecodeInput {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        while self.offset == self.current.len() && !self.eof {
            match self.receiver.blocking_recv() {
                Some(Ok(bytes)) => {
                    self.current = bytes;
                    self.offset = 0;
                }
                Some(Err(error)) => return Err(error),
                None => self.eof = true,
            }
        }
        if self.eof {
            return Ok(&[]);
        }
        let remaining = MAX_COMPRESSED_INPUT_WITHOUT_OUTPUT.saturating_sub(self.without_output);
        if remaining == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Compressed response header or input-without-output limit exceeded",
            ));
        }
        let end = self.current.len().min(self.offset + remaining);
        Ok(&self.current[self.offset..end])
    }

    fn consume(&mut self, count: usize) {
        self.offset += count;
        self.without_output += count;
    }
}

enum DecodeReader {
    Gzip(flate2::bufread::MultiGzDecoder<DecodeInput>),
    Deflate(flate2::bufread::ZlibDecoder<DecodeInput>),
}

impl DecodeReader {
    fn input_mut(&mut self) -> &mut DecodeInput {
        match self {
            Self::Gzip(reader) => reader.get_mut(),
            Self::Deflate(reader) => reader.get_mut(),
        }
    }

    fn read(&mut self, into: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Gzip(reader) => reader.read(into),
            Self::Deflate(reader) => reader.read(into),
        }
    }
}

struct DecodedResponseStream {
    receiver: mpsc::Receiver<Result<bytes::Bytes, String>>,
    feeder: tokio::task::JoinHandle<()>,
    worker: tokio::task::JoinHandle<()>,
    worker_done: bool,
    finished: bool,
}

impl Stream for DecodedResponseStream {
    type Item = Result<bytes::Bytes, String>;

    fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let stream = self.get_mut();
        if stream.finished {
            return Poll::Ready(None);
        }
        match stream.receiver.poll_recv(context) {
            Poll::Ready(None) => {}
            event => return event,
        }
        if !stream.worker_done {
            match Pin::new(&mut stream.worker).poll(context) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Ok(())) => stream.worker_done = true,
                Poll::Ready(Err(_)) => {
                    stream.finished = true;
                    return Poll::Ready(Some(Err("The upstream response decoder failed".into())));
                }
            }
        }
        match Pin::new(&mut stream.feeder).poll(context) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(result) => {
                stream.finished = true;
                Poll::Ready(
                    result
                        .err()
                        .map(|_| Err("The upstream response feeder failed".into())),
                )
            }
        }
    }
}

impl Drop for DecodedResponseStream {
    fn drop(&mut self) {
        // Dropping the output receiver wakes blocking_send; aborting the feeder
        // closes its input channel and wakes blocking_recv. No worker waits on
        // an abandoned upstream/client after request cancellation or failure.
        self.feeder.abort();
        self.worker.abort();
    }
}

fn decode_response_stream(
    stream: ResponseBodyStream,
    coding: ResponseCoding,
    limit: usize,
) -> ResponseBodyStream {
    if coding == ResponseCoding::Identity {
        return stream;
    }
    let (input_tx, input_rx) = mpsc::channel(2);
    let (output_tx, output_rx) = mpsc::channel(2);
    let feeder = tokio::spawn(async move {
        let mut stream = stream;
        let mut total = 0usize;
        while let Some(part) = stream.next().await {
            let part = match part {
                Ok(part) if part.len() <= limit.saturating_sub(total) => part,
                Ok(_) => {
                    let _ = input_tx
                        .send(Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "Encoded upstream response exceeds the browser proxy limit",
                        )))
                        .await;
                    return;
                }
                Err(_) => {
                    let _ = input_tx
                        .send(Err(io::Error::other("The upstream response stream failed")))
                        .await;
                    return;
                }
            };
            total += part.len();
            for offset in (0..part.len()).step_by(CHUNK_BYTES) {
                let end = (offset + CHUNK_BYTES).min(part.len());
                if input_tx
                    .send(Ok(bytes::Bytes::copy_from_slice(&part[offset..end])))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
    });
    let worker = tokio::task::spawn_blocking(move || {
        let input = DecodeInput::new(input_rx);
        let mut reader = match coding {
            ResponseCoding::Gzip => DecodeReader::Gzip(flate2::bufread::MultiGzDecoder::new(input)),
            ResponseCoding::Deflate => {
                DecodeReader::Deflate(flate2::bufread::ZlibDecoder::new(input))
            }
            ResponseCoding::Identity => unreachable!(),
        };
        let mut total = 0usize;
        let result = loop {
            // One extra byte distinguishes exact-limit EOF from an inflated
            // body exceeding its limit without allocating an extra body buffer.
            let mut output =
                vec![0; CHUNK_BYTES.min(limit.saturating_sub(total).saturating_add(1))];
            match reader.read(&mut output) {
                Ok(0) => {
                    break reader.input_mut().fill_buf().and_then(|trailing| {
                        if trailing.is_empty() {
                            Ok(())
                        } else {
                            Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                "Trailing bytes after compressed response",
                            ))
                        }
                    });
                }
                Ok(count) if count <= limit.saturating_sub(total) => {
                    total += count;
                    reader.input_mut().without_output = 0;
                    output.truncate(count);
                    if output_tx.blocking_send(Ok(output.into())).is_err() {
                        return;
                    }
                }
                Ok(_) => {
                    break Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Decoded upstream response exceeds the browser proxy limit",
                    ));
                }
                Err(error) => break Err(error),
            }
        };
        if let Err(error) = result {
            let _ = output_tx.blocking_send(Err(format!(
                "Could not decode the upstream response: {error}"
            )));
        }
    });
    Box::pin(DecodedResponseStream {
        receiver: output_rx,
        feeder,
        worker,
        worker_done: false,
        finished: false,
    })
}

fn is_forwardable_browser_header(name: &str) -> bool {
    !matches!(
        name,
        "host"
            | "connection"
            | "content-length"
            | "transfer-encoding"
            | "upgrade"
            | "proxy-connection"
            | "proxy-authorization"
            | "proxy-authenticate"
            | "keep-alive"
            | "te"
            | "trailer"
            | "accept-encoding"
    ) && !name.starts_with("proxy-")
        && !name.starts_with("sec-")
}

fn collect_set_cookies(headers: &HeaderMap) -> Vec<String> {
    let mut cookies = Vec::new();
    let mut bytes = 0usize;
    for value in headers.get_all(reqwest::header::SET_COOKIE) {
        let Ok(value) = value.to_str() else { continue };
        if value.len() > 4096 || bytes.saturating_add(value.len()) > 16 * 1024 {
            continue;
        }
        bytes += value.len();
        cookies.push(value.to_owned());
        if cookies.len() >= 32 {
            break;
        }
    }
    cookies
}

fn append_cookie_event(
    events: &mut Vec<serde_json::Value>,
    total_count: &mut usize,
    total_bytes: &mut usize,
    url: &Url,
    values: &[String],
) {
    let mut accepted = Vec::new();
    for value in values {
        if *total_count >= 32
            || value.len() > 4096
            || total_bytes.saturating_add(value.len()) > 16 * 1024
        {
            continue;
        }
        *total_count += 1;
        *total_bytes += value.len();
        accepted.push(value.clone());
    }
    if !accepted.is_empty() {
        events.push(serde_json::json!({"url":url.as_str(),"values":accepted}));
    }
}

fn apply_redirect_cookies(headers: &mut HeaderMap, cookies: &[String], source: &Url, next: &Url) {
    if source.scheme() != next.scheme()
        || source.host_str() != next.host_str()
        || source.port_or_known_default() != next.port_or_known_default()
    {
        return;
    }
    let request_path = next.path();
    let mut pairs: Vec<(String, String)> = headers
        .get(reqwest::header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(';')
        .filter_map(|pair| {
            let (name, value) = pair.trim().split_once('=')?;
            Some((name.trim().to_owned(), value.trim().to_owned()))
        })
        .collect();
    for cookie in cookies {
        let mut parts = cookie.split(';');
        let Some((name, value)) = parts.next().and_then(|part| part.trim().split_once('=')) else {
            continue;
        };
        let name = name.trim();
        let value = value.trim();
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
            || value
                .bytes()
                .any(|byte| byte.is_ascii_control() || byte == b';')
        {
            continue;
        }
        let mut path = default_cookie_path(source.path());
        let mut secure = false;
        let mut valid_domain = true;
        let mut delete = false;
        for attribute in parts {
            let (key, value) = attribute
                .trim()
                .split_once('=')
                .unwrap_or((attribute.trim(), ""));
            match key.trim().to_ascii_lowercase().as_str() {
                "path" if value.starts_with('/') => path = value.to_owned(),
                "secure" => secure = true,
                "domain" => {
                    let domain = value.trim().trim_start_matches('.').to_ascii_lowercase();
                    valid_domain = source
                        .host_str()
                        .is_some_and(|host| host.eq_ignore_ascii_case(&domain));
                }
                "max-age" if value.trim().parse::<i64>().is_ok_and(|age| age <= 0) => delete = true,
                _ => {}
            }
        }
        let path_matches = request_path == path
            || (request_path.starts_with(&path)
                && (path.ends_with('/') || request_path.as_bytes().get(path.len()) == Some(&b'/')));
        if !valid_domain || !path_matches || (secure && next.scheme() != "https") {
            continue;
        }
        pairs.retain(|(existing, _)| existing != name);
        if !delete {
            pairs.push((name.to_owned(), value.to_owned()));
        }
    }
    let value = pairs
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ");
    if value.len() <= 4096 {
        if let Ok(value) = HeaderValue::from_str(&value) {
            headers.insert(reqwest::header::COOKIE, value);
        }
    }
}

fn default_cookie_path(path: &str) -> String {
    if !path.starts_with('/') {
        return "/".into();
    }
    path.rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
        .unwrap_or("/")
        .to_owned()
}

fn accept_response_credit(
    credit_senders: &HashMap<u32, mpsc::Sender<u32>>,
    id: u32,
    bytes: u32,
) -> Result<(), ()> {
    if id == 0 || bytes == 0 || bytes as usize > CHUNK_BYTES {
        return Err(());
    }
    // Reading the last nonfinal chunk can return credit after the response's
    // final marker was queued or sent, or after cancellation. Such credit has
    // no remaining consumer and must not close unrelated multiplexed requests.
    let Some(sender) = credit_senders.get(&id) else {
        return Ok(());
    };
    match sender.try_send(bytes) {
        Ok(()) | Err(mpsc::error::TrySendError::Closed(_)) => Ok(()),
        Err(mpsc::error::TrySendError::Full(_)) => Err(()),
    }
}

async fn send_credited_chunk(
    id: u32,
    bytes: &[u8],
    credit_rx: &mut mpsc::Receiver<u32>,
    available_credit: &mut usize,
    tx: &mpsc::Sender<Vec<u8>>,
) -> Result<(), String> {
    while *available_credit < bytes.len() {
        let credit = timeout(Duration::from_secs(45), credit_rx.recv())
            .await
            .map_err(|_| "The browser stopped consuming the response")?
            .ok_or("The browser response stream was cancelled")? as usize;
        if credit == 0 || *available_credit + credit > MAX_CREDIT_BYTES {
            return Err("Invalid response stream credit".into());
        }
        *available_credit += credit;
    }
    *available_credit -= bytes.len();
    tx.send(event_chunk(id, false, bytes))
        .await
        .map_err(|_| "The browser connection closed".into())
}

fn encode_meta(value: serde_json::Value) -> Vec<u8> {
    let mut event = vec![RESPONSE_META];
    event.extend_from_slice(&serde_json::to_vec(&value).unwrap_or_default());
    event
}
fn event_meta(id: u32, status: u16, error: &str) -> Vec<u8> {
    encode_meta(serde_json::json!({"id":id,"status":status,"headers":{},"ok":false,"error":error}))
}
fn event_upload_credit(id: u32, chunks: u32) -> Vec<u8> {
    let mut event = Vec::with_capacity(9);
    event.push(UPLOAD_CREDIT);
    event.extend_from_slice(&id.to_be_bytes());
    event.extend_from_slice(&chunks.to_be_bytes());
    event
}
fn event_chunk(id: u32, final_chunk: bool, bytes: &[u8]) -> Vec<u8> {
    let mut event = Vec::with_capacity(6 + bytes.len());
    event.push(RESPONSE_CHUNK);
    event.extend_from_slice(&id.to_be_bytes());
    event.push(final_chunk as u8);
    event.extend_from_slice(bytes);
    event
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_broadcast()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && a != 0
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 192 && b == 0 && (c == 0 || c == 2))
                && !(a == 192 && b == 88 && c == 99)
                && !(a == 198 && (b == 18 || b == 19))
                && !(a == 198 && b == 51 && c == 100)
                && !(a == 203 && b == 0 && c == 113)
                && !(a >= 240)
        }
        IpAddr::V6(ip) => {
            if let Some(ip4) = ip.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(ip4));
            }
            let segments = ip.segments();
            // Only allow ordinary global-unicast destinations. The registry has
            // special-purpose allocations inside 2000::/3, so reject them here.
            segments[0] & 0xe000 == 0x2000
                && !(segments[0] == 0x2001 && segments[1] <= 0x01ff) // IETF assignments, including Teredo
                && !(segments[0] == 0x2001 && (segments[1] & 0xfff0) == 0x0020) // ORCHIDv2
                && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
                && segments[0] != 0x2002 // 6to4
                && !(segments[0] == 0x3fff && (segments[1] & 0xf000) == 0) // documentation
                && segments[0] != 0x5f00 // SRv6 service identifiers
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_proxy() -> Arc<Proxy> {
        Arc::new(Proxy {
            clients: Arc::new(Mutex::new(HashMap::new())),
            response_cache: Arc::new(Mutex::new(ResponseCache::default())),
            inflight_cacheable: Arc::new(Mutex::new(HashMap::new())),
            request_slots: Arc::new(Semaphore::new(1)),
            websocket_slots: Arc::new(Semaphore::new(1)),
            upload_memory: Arc::new(Semaphore::new(MAX_UPLOAD_BUDGET_UNITS)),
            local_addresses: HashSet::new(),
        })
    }

    #[test]
    fn cacheable_inflight_requests_share_only_matching_vary_inputs() {
        let url = Url::parse("https://example.test/assets/app.js").unwrap();
        let mut first = HeaderMap::new();
        first.insert(
            reqwest::header::ACCEPT,
            HeaderValue::from_static("text/javascript"),
        );
        first.insert(
            reqwest::header::ACCEPT_LANGUAGE,
            HeaderValue::from_static("en"),
        );
        let mut second = first.clone();
        assert_eq!(
            cache_flight_key(&url, &first),
            cache_flight_key(&url, &second)
        );
        second.insert(
            reqwest::header::ACCEPT_LANGUAGE,
            HeaderValue::from_static("fr"),
        );
        assert_ne!(
            cache_flight_key(&url, &first),
            cache_flight_key(&url, &second)
        );

        let proxy = test_proxy();
        let (leader_response, leader) = proxy
            .join_cacheable_request(cache_flight_key(&url, &first))
            .unwrap();
        assert!(leader.is_some());
        let (waiter_response, waiter_leader) = proxy
            .join_cacheable_request(cache_flight_key(&url, &first))
            .unwrap();
        assert!(waiter_leader.is_none());
        assert!(Arc::ptr_eq(&leader_response, &waiter_response));

        let shared = CachedResponse {
            url: url.to_string(),
            vary: vec![("accept-language".into(), "en".into())],
            status: 200,
            headers: serde_json::Map::new(),
            body: b"shared".to_vec().into(),
            expires_at: Instant::now() + Duration::from_secs(30),
            stale_until: Instant::now() + Duration::from_secs(30),
            stamp: 0,
            weight: 0,
        };
        leader.unwrap().finish(Some(shared));
        let result = waiter_response.result.borrow().clone();
        assert_eq!(result.flatten().unwrap().body.as_ref(), b"shared");

        let (_, next_leader) = proxy
            .join_cacheable_request(cache_flight_key(&url, &first))
            .unwrap();
        assert!(
            next_leader.is_some(),
            "completed flights must leave the map"
        );
    }

    #[test]
    fn dropping_cacheable_inflight_leader_releases_waiters() {
        let proxy = test_proxy();
        let (response, leader) = proxy.join_cacheable_request("test-flight".into()).unwrap();
        let receiver = response.result.subscribe();
        drop(leader);
        assert!(matches!(*receiver.borrow(), Some(None)));
        assert!(
            proxy
                .join_cacheable_request("test-flight".into())
                .unwrap()
                .1
                .is_some()
        );
    }

    #[test]
    fn dns_pin_cache_expires_after_short_ttl() {
        let resolved_at = Instant::now();
        assert!(dns_pin_is_fresh(
            resolved_at,
            resolved_at + DNS_PIN_TTL - Duration::from_millis(1)
        ));
        assert!(!dns_pin_is_fresh(resolved_at, resolved_at + DNS_PIN_TTL));
    }

    #[tokio::test]
    async fn dns_lookup_timeout_bounds_stalled_resolvers() {
        let result = with_dns_timeout(Duration::from_millis(5), std::future::pending::<()>()).await;
        assert_eq!(result, Err("Destination DNS lookup timed out"));
        assert_eq!(
            with_dns_timeout(Duration::from_secs(1), async { 42 }).await,
            Ok(42)
        );
    }

    #[test]
    fn pinned_dns_answers_are_sorted_deduplicated_and_public_only() {
        let local_addresses = HashSet::new();
        let answers = [
            "8.8.8.8:443".parse().unwrap(),
            "1.1.1.1:443".parse().unwrap(),
            "8.8.8.8:443".parse().unwrap(),
        ];
        let pinned = validate_pinned_addresses(answers, &local_addresses).unwrap();
        assert_eq!(pinned.len(), 2);
        assert!(pinned[0] < pinned[1]);
        assert!(
            validate_pinned_addresses(["127.0.0.1:443".parse().unwrap()], &local_addresses)
                .is_err()
        );
        assert!(
            validate_pinned_addresses(
                ["8.8.8.8:443".parse().unwrap()],
                &HashSet::from(["8.8.8.8".parse().unwrap()])
            )
            .is_err()
        );
    }

    #[test]
    fn ipv4_pinning_rejects_special_purpose_without_blocking_neighboring_public_space() {
        let local_addresses = HashSet::new();
        for address in ["192.0.0.1:443", "192.0.2.1:443", "192.88.99.1:443"] {
            assert!(
                validate_pinned_addresses([address.parse().unwrap()], &local_addresses).is_err(),
                "special-purpose IPv4 address {address} must be blocked"
            );
        }
        for address in ["192.0.1.1:443", "192.1.0.1:443", "192.88.98.1:443"] {
            assert!(
                validate_pinned_addresses([address.parse().unwrap()], &local_addresses).is_ok(),
                "public IPv4 address {address} should not be blocked by a neighboring reservation"
            );
        }
    }

    #[test]
    fn ipv6_pinning_rejects_special_purpose_and_allows_global_unicast() {
        let local_addresses = HashSet::new();
        for address in [
            "[2001::1]:443",     // Teredo / IETF protocol assignments
            "[2001:20::1]:443",  // ORCHIDv2
            "[2001:db8::1]:443", // documentation
            "[2002::1]:443",     // 6to4
            "[3fff::1]:443",     // documentation
            "[5f00::1]:443",     // SRv6 service identifiers
            "[fc00::1]:443",     // unique local
            "[fe80::1]:443",     // link local
        ] {
            assert!(
                validate_pinned_addresses([address.parse().unwrap()], &local_addresses).is_err(),
                "special-purpose IPv6 address {address} must be blocked"
            );
        }
        assert!(
            validate_pinned_addresses(
                ["[2606:4700:4700::1111]:443".parse().unwrap()],
                &local_addresses
            )
            .is_ok()
        );
        assert!(
            validate_pinned_addresses(["[2001:800::1]:443".parse().unwrap()], &local_addresses)
                .is_ok(),
            "ordinary RIPE global unicast should not be blocked as special-purpose"
        );
    }

    #[test]
    fn identity_encoding_check_rejects_encoded_body_headers() {
        assert!(is_identity_encoding("identity"));
        assert!(is_identity_encoding(" IDENTITY "));
        assert!(!is_identity_encoding("gzip"));
        assert!(!is_identity_encoding("br"));
        assert!(!is_identity_encoding("gzip, br"));
    }

    fn compressed_test_body(coding: ResponseCoding, body: &[u8]) -> Vec<u8> {
        use std::io::Write;
        match coding {
            ResponseCoding::Gzip => {
                let mut encoder =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
                encoder.write_all(body).unwrap();
                encoder.finish().unwrap()
            }
            ResponseCoding::Deflate => {
                let mut encoder =
                    flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
                encoder.write_all(body).unwrap();
                encoder.finish().unwrap()
            }
            ResponseCoding::Identity => body.to_vec(),
        }
    }

    async fn decode_test_body(
        coding: ResponseCoding,
        encoded: &[u8],
        split: usize,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        let chunks: Vec<_> = encoded
            .chunks(split)
            .map(|bytes| Ok(bytes::Bytes::copy_from_slice(bytes)))
            .collect();
        let mut stream =
            decode_response_stream(Box::pin(futures_util::stream::iter(chunks)), coding, limit);
        let mut body = Vec::new();
        while let Some(part) = stream.next().await {
            let part = part?;
            assert!(part.len() <= CHUNK_BYTES);
            body.extend_from_slice(&part);
        }
        Ok(body)
    }

    #[tokio::test]
    async fn compressed_responses_stream_exactly_across_headers_members_and_chunk_boundaries() {
        let body = "Swift π docs and ordinary binary bytes.\0"
            .repeat(8000)
            .into_bytes();
        for coding in [ResponseCoding::Gzip, ResponseCoding::Deflate] {
            let encoded = compressed_test_body(coding, &body);
            for split in [1, 11, CHUNK_BYTES] {
                assert_eq!(
                    decode_test_body(coding, &encoded, split, body.len())
                        .await
                        .unwrap(),
                    body
                );
            }
        }
        let first = compressed_test_body(ResponseCoding::Gzip, b"first member ");
        let second = compressed_test_body(ResponseCoding::Gzip, b"second member");
        assert_eq!(
            decode_test_body(
                ResponseCoding::Gzip,
                &[first, second].concat(),
                3,
                MAX_RESPONSE_BODY,
            )
            .await
            .unwrap(),
            b"first member second member"
        );
    }

    #[tokio::test]
    async fn compressed_response_integrity_truncation_and_both_size_limits_are_enforced() {
        let body = vec![b'x'; 4096];
        for coding in [ResponseCoding::Gzip, ResponseCoding::Deflate] {
            let encoded = compressed_test_body(coding, &body);
            for truncated in [1, encoded.len() - 1, encoded.len() - 4] {
                assert!(
                    decode_test_body(coding, &encoded[..truncated], 5, MAX_RESPONSE_BODY)
                        .await
                        .is_err()
                );
            }
            let mut corrupt = encoded.clone();
            let end = corrupt.len() - 1;
            corrupt[end] ^= 0x80;
            assert!(
                decode_test_body(coding, &corrupt, 17, MAX_RESPONSE_BODY)
                    .await
                    .is_err()
            );
            let mut trailing = encoded.clone();
            trailing.extend_from_slice(b"not a member");
            assert!(
                decode_test_body(coding, &trailing, CHUNK_BYTES, MAX_RESPONSE_BODY)
                    .await
                    .is_err()
            );
            let error = decode_test_body(coding, &encoded, CHUNK_BYTES, 1000)
                .await
                .unwrap_err();
            assert!(
                error.contains("Decoded upstream response exceeds"),
                "{error}"
            );
            let error = decode_test_body(coding, &encoded, CHUNK_BYTES, encoded.len() - 1)
                .await
                .unwrap_err();
            assert!(
                error.contains("Encoded upstream response exceeds"),
                "{error}"
            );
        }
        // A valid gzip prefix with an unterminated, oversized optional filename
        // must not make the header parser allocate up to the body-size limit.
        let mut header = vec![0x1f, 0x8b, 8, 8, 0, 0, 0, 0, 0, 255];
        header.extend(vec![b'n'; MAX_COMPRESSED_INPUT_WITHOUT_OUTPUT + 1]);
        let error = decode_test_body(
            ResponseCoding::Gzip,
            &header,
            CHUNK_BYTES,
            MAX_RESPONSE_BODY,
        )
        .await
        .unwrap_err();
        assert!(error.contains("header field too long"), "{error}");
        // Empty members produce no body bytes; bound work across their headers,
        // trailers and decoder resets instead of allowing millions of members.
        let empty = compressed_test_body(ResponseCoding::Gzip, b"");
        let empty_members = empty.repeat(MAX_COMPRESSED_INPUT_WITHOUT_OUTPUT / empty.len() + 2);
        let error = decode_test_body(
            ResponseCoding::Gzip,
            &empty_members,
            CHUNK_BYTES,
            MAX_RESPONSE_BODY,
        )
        .await
        .unwrap_err();
        assert!(error.contains("input-without-output limit"), "{error}");
    }

    #[tokio::test]
    async fn compressed_response_backpressure_and_cancellation_bound_the_feeder() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        struct ObservedStream {
            stream: ResponseBodyStream,
            dropped: Arc<AtomicBool>,
        }
        impl Stream for ObservedStream {
            type Item = Result<bytes::Bytes, String>;
            fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
                self.get_mut().stream.as_mut().poll_next(cx)
            }
        }
        impl Drop for ObservedStream {
            fn drop(&mut self) {
                self.dropped.store(true, Ordering::SeqCst);
            }
        }
        let mut seed = 0x3141_5926u32;
        let body: Vec<_> = (0..1024 * 1024)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                seed as u8
            })
            .collect();
        let encoded = compressed_test_body(ResponseCoding::Gzip, &body);
        assert!(encoded.len() > 512 * 1024);
        let chunks: Vec<_> = encoded
            .chunks(4096)
            .map(|part| Ok(bytes::Bytes::copy_from_slice(part)))
            .collect();
        let chunk_count = chunks.len();
        let polled = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicBool::new(false));
        let counter = polled.clone();
        let source = ObservedStream {
            stream: Box::pin(futures_util::stream::iter(chunks).inspect(move |_| {
                counter.fetch_add(1, Ordering::SeqCst);
            })),
            dropped: dropped.clone(),
        };
        let decoded =
            decode_response_stream(Box::pin(source), ResponseCoding::Gzip, MAX_RESPONSE_BODY);
        // The client consumes nothing. Decoding and upstream reads must stop
        // behind their bounded channels instead of buffering the complete body.
        timeout(Duration::from_secs(2), async {
            while polled.load(Ordering::SeqCst) < 3 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(polled.load(Ordering::SeqCst) < chunk_count);
        assert!(!dropped.load(Ordering::SeqCst));
        drop(decoded);
        timeout(Duration::from_secs(2), async {
            while !dropped.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[test]
    fn response_codings_and_transformed_representation_headers_are_explicit() {
        let mut headers = HeaderMap::new();
        assert!(matches!(
            response_coding(&headers),
            Ok(ResponseCoding::Identity)
        ));
        for (name, coding) in [
            ("identity", ResponseCoding::Identity),
            (" GZIP ", ResponseCoding::Gzip),
            ("x-gzip", ResponseCoding::Gzip),
            ("deflate", ResponseCoding::Deflate),
        ] {
            headers.insert(reqwest::header::CONTENT_ENCODING, name.parse().unwrap());
            assert!(response_coding(&headers).unwrap() == coding);
        }
        for unsupported in ["br", "gzip, br", "gzip, gzip", "", "garbage"] {
            headers.insert(
                reqwest::header::CONTENT_ENCODING,
                unsupported.parse().unwrap(),
            );
            assert!(response_coding(&headers).is_err());
        }
        headers.insert(reqwest::header::CONTENT_ENCODING, "gzip".parse().unwrap());
        headers.append(
            reqwest::header::CONTENT_ENCODING,
            "identity".parse().unwrap(),
        );
        assert!(response_coding(&headers).is_err());
        let mut decoded = serde_json::json!({
            "content-encoding":"gzip", "content-length":"72", "content-range":"bytes 0-71/100",
            "accept-ranges":"bytes", "etag":"\"encoded-tag\"", "last-modified":"Tue, 17 Nov 2026 00:00:00 GMT",
            "content-type":"text/html", "cache-control":"public, max-age=60", "vary":"Accept-Encoding"
        }).as_object().unwrap().clone();
        normalize_decoded_headers(&mut decoded);
        assert_eq!(decoded.len(), 3);
        assert_eq!(decoded["content-type"], "text/html");
        assert_eq!(decoded["cache-control"], "public, max-age=60");
        assert_eq!(decoded["vary"], "Accept-Encoding");
        let now = Instant::now();
        assert_eq!(cache_stale_deadline(now, &decoded), now);
        let range = HeaderMap::from_iter([(
            reqwest::header::CONTENT_RANGE,
            "bytes 0-71/100".parse().unwrap(),
        )]);
        assert!(
            validate_decoded_range(
                ResponseCoding::Gzip,
                true,
                reqwest::StatusCode::PARTIAL_CONTENT,
                &HeaderMap::new()
            )
            .is_err()
        );
        assert!(
            validate_decoded_range(
                ResponseCoding::Deflate,
                true,
                reqwest::StatusCode::OK,
                &range
            )
            .is_err()
        );
        assert!(
            validate_decoded_range(
                ResponseCoding::Identity,
                true,
                reqwest::StatusCode::PARTIAL_CONTENT,
                &range
            )
            .is_ok()
        );
        assert!(
            validate_decoded_range(
                ResponseCoding::Gzip,
                false,
                reqwest::StatusCode::PARTIAL_CONTENT,
                &range
            )
            .is_ok()
        );
    }

    #[test]
    fn response_cache_requires_explicit_public_freshness_and_supported_vary() {
        let mut request = HeaderMap::new();
        request.insert("accept", HeaderValue::from_static("image/avif,image/webp"));
        let mut response = HeaderMap::new();
        response.insert(
            "cache-control",
            HeaderValue::from_static("public, max-age=120"),
        );
        response.insert("vary", HeaderValue::from_static("Accept, Accept-Encoding"));
        let (ttl, vary) =
            response_cache_policy(reqwest::StatusCode::OK, &request, &response).unwrap();
        assert_eq!(ttl, Duration::from_secs(120));
        assert_eq!(
            vary,
            vec![
                ("accept".into(), "image/avif,image/webp".into()),
                ("accept-encoding".into(), "identity".into()),
            ]
        );
        assert!(cache_vary_matches(&vary, &request));
        request.insert("accept", HeaderValue::from_static("text/html"));
        assert!(!cache_vary_matches(&vary, &request));

        response.insert(
            "cache-control",
            HeaderValue::from_static("max-age=300, s-maxage=90"),
        );
        response.remove("vary");
        response.insert("age", HeaderValue::from_static("30"));
        assert_eq!(
            response_cache_policy(reqwest::StatusCode::OK, &request, &response)
                .unwrap()
                .0,
            Duration::from_secs(60),
            "shared freshness takes precedence and is reduced by upstream Age"
        );
        response.insert("age", HeaderValue::from_static("invalid"));
        assert!(response_cache_policy(reqwest::StatusCode::OK, &request, &response).is_none());

        for directive in ["no-store", "private", "no-cache", "max-age=0"] {
            response.insert("cache-control", HeaderValue::from_str(directive).unwrap());
            assert!(response_cache_policy(reqwest::StatusCode::OK, &request, &response).is_none());
        }
        response.insert(
            "cache-control",
            HeaderValue::from_static("public, max-age=120"),
        );
        response.remove("age");
        response.insert("vary", HeaderValue::from_static("*"));
        assert!(response_cache_policy(reqwest::StatusCode::OK, &request, &response).is_none());
        response.insert("vary", HeaderValue::from_static("Cookie"));
        assert!(response_cache_policy(reqwest::StatusCode::OK, &request, &response).is_none());
        response.remove("vary");
        response.insert("set-cookie", HeaderValue::from_static("sid=abc"));
        assert!(response_cache_policy(reqwest::StatusCode::OK, &request, &response).is_none());
        response.remove("set-cookie");
        assert!(
            response_cache_policy(reqwest::StatusCode::NOT_MODIFIED, &request, &response).is_none()
        );
        response.insert(
            "cache-control",
            HeaderValue::from_static("public, max-age=300"),
        );
        response.insert(
            "date",
            HeaderValue::from_str(&httpdate::fmt_http_date(
                std::time::SystemTime::now() - Duration::from_secs(200),
            ))
            .unwrap(),
        );
        let ttl = response_cache_policy(reqwest::StatusCode::OK, &request, &response)
            .unwrap()
            .0;
        assert!(ttl <= Duration::from_secs(100) && ttl >= Duration::from_secs(90));
    }

    #[test]
    fn response_cache_skips_sensitive_or_non_get_requests() {
        let mut headers = HeaderMap::new();
        assert!(cache_request_allowed(&Method::GET, &headers, None));
        assert!(!cache_request_allowed(&Method::POST, &headers, None));
        assert!(!cache_request_allowed(
            &Method::GET,
            &headers,
            Some(b"body")
        ));
        for name in ["range", "authorization", "cookie", "if-none-match"] {
            headers.insert(name, HeaderValue::from_static("x"));
            assert!(
                !cache_request_allowed(&Method::GET, &headers, None),
                "{name} bypasses cache"
            );
            headers.remove(name);
        }
        headers.insert("cache-control", HeaderValue::from_static("no-cache"));
        assert!(!cache_request_allowed(&Method::GET, &headers, None));
    }

    #[test]
    fn browser_request_cache_bypass_is_optional_and_camel_cased() {
        let base = serde_json::json!({"id":1,"url":"https://example.test/"});
        let default_request: BrowserRequest = serde_json::from_value(base.clone()).unwrap();
        assert!(!default_request.bypass_cache);
        let mut bypass_value = base;
        bypass_value["bypassCache"] = serde_json::Value::Bool(true);
        let bypass_request: BrowserRequest = serde_json::from_value(bypass_value).unwrap();
        assert!(bypass_request.bypass_cache);
    }

    #[test]
    fn browser_request_redirect_following_defaults_on_and_can_be_disabled() {
        let base = serde_json::json!({"id":1,"url":"https://example.test/"});
        let default_request: BrowserRequest = serde_json::from_value(base.clone()).unwrap();
        assert!(default_request.follow_redirects);
        let mut no_redirect_value = base;
        no_redirect_value["followRedirects"] = serde_json::Value::Bool(false);
        let no_redirect_request: BrowserRequest =
            serde_json::from_value(no_redirect_value).unwrap();
        assert!(!no_redirect_request.follow_redirects);
    }

    #[test]
    fn browser_upload_assembly_enforces_order_window_size_and_final_marker() {
        fn upload(expected: usize, credits: u32) -> PendingUpload {
            let memory = Arc::new(Semaphore::new(MAX_UPLOAD_BUDGET_UNITS));
            let permit = memory.try_acquire_many_owned(1).unwrap();
            PendingUpload {
                request: BrowserRequest {
                    id: 1,
                    url: "https://example.test/upload".into(),
                    method: "POST".into(),
                    headers: HashMap::new(),
                    body_base64: None,
                    body_size: Some(expected),
                    initial_credit: 0,
                    bypass_cache: false,
                    follow_redirects: true,
                },
                body: Vec::with_capacity(expected),
                expected,
                next_chunk: 0,
                credits_remaining: credits,
                started_at: Instant::now(),
                _memory_permit: permit,
            }
        }

        let mut valid = upload(3, 2);

        assert!(!accept_upload_chunk(&mut valid, 0, false, &[1, 2]).unwrap());
        valid.credits_remaining += 1;
        assert!(accept_upload_chunk(&mut valid, 1, true, &[3]).unwrap());
        assert_eq!(valid.body, [1, 2, 3]);

        assert!(accept_upload_chunk(&mut upload(3, 1), 1, false, &[1]).is_err());
        assert!(accept_upload_chunk(&mut upload(3, 1), 0, true, &[1]).is_err());
        assert!(accept_upload_chunk(&mut upload(2, 1), 0, false, &[1, 2, 3]).is_err());
        assert!(accept_upload_chunk(&mut upload(3, 0), 0, false, &[1]).is_err());
    }

    #[test]
    fn response_cache_hits_share_body_storage_without_copying_payloads() {
        let proxy = test_proxy();
        let url = Url::parse("https://static.example/app.js").unwrap();
        let body: Arc<[u8]> = vec![0x5a; MAX_CACHE_ENTRY_BYTES].into();
        proxy.cache_response(CachedResponse {
            url: url.to_string(),
            vary: Vec::new(),
            status: 200,
            headers: serde_json::Map::new(),
            body: body.clone(),
            expires_at: Instant::now() + Duration::from_secs(60),
            stale_until: Instant::now() + Duration::from_secs(60),
            stamp: 0,
            weight: 0,
        });

        let first = proxy.cached_response(&url, &HeaderMap::new()).unwrap();
        let second = proxy.cached_response(&url, &HeaderMap::new()).unwrap();
        assert!(Arc::ptr_eq(&first.body, &second.body));
        assert_eq!(first.body.len(), MAX_CACHE_ENTRY_BYTES);
    }

    #[test]
    fn response_cache_evicts_lru_entries_and_removes_expired_bodies() {
        let proxy = Proxy {
            clients: Arc::new(Mutex::new(HashMap::new())),
            response_cache: Arc::new(Mutex::new(ResponseCache::default())),
            inflight_cacheable: Arc::new(Mutex::new(HashMap::new())),
            request_slots: Arc::new(Semaphore::new(1)),
            websocket_slots: Arc::new(Semaphore::new(1)),
            upload_memory: Arc::new(Semaphore::new(MAX_UPLOAD_BUDGET_UNITS)),
            local_addresses: HashSet::new(),
        };
        let make_entry = |index: usize, expires_at: Instant| CachedResponse {
            url: format!("https://static.example/{index}"),
            vary: Vec::new(),
            status: 200,
            headers: serde_json::Map::new(),
            body: vec![index as u8].into(),
            expires_at,
            stale_until: expires_at + MAX_STALE_CACHE_AGE,
            stamp: 0,
            weight: 0,
        };
        let expires = Instant::now() + Duration::from_secs(60);
        for index in 0..MAX_CACHE_ENTRIES {
            proxy.cache_response(make_entry(index, expires));
        }
        let headers = HeaderMap::new();
        assert!(
            proxy
                .cached_response(&Url::parse("https://static.example/0").unwrap(), &headers)
                .is_some()
        );
        proxy.cache_response(make_entry(MAX_CACHE_ENTRIES, expires));
        assert!(
            proxy
                .cached_response(&Url::parse("https://static.example/0").unwrap(), &headers)
                .is_some(),
            "a cache hit refreshes the LRU stamp"
        );
        assert!(
            proxy
                .cached_response(&Url::parse("https://static.example/1").unwrap(), &headers)
                .is_none(),
            "the least recently used response is evicted"
        );
        assert_eq!(
            proxy.response_cache.lock().unwrap().entries.len(),
            MAX_CACHE_ENTRIES
        );

        proxy.cache_response(make_entry(
            MAX_CACHE_ENTRIES + 1,
            Instant::now() - Duration::from_secs(1),
        ));
        assert!(
            proxy
                .cached_response(
                    &Url::parse(&format!("https://static.example/{}", MAX_CACHE_ENTRIES + 1))
                        .unwrap(),
                    &headers
                )
                .is_none()
        );
    }

    #[test]
    fn response_cache_retains_expired_validated_entries_for_revalidation() {
        let proxy = Proxy {
            clients: Arc::new(Mutex::new(HashMap::new())),
            response_cache: Arc::new(Mutex::new(ResponseCache::default())),
            inflight_cacheable: Arc::new(Mutex::new(HashMap::new())),
            request_slots: Arc::new(Semaphore::new(1)),
            websocket_slots: Arc::new(Semaphore::new(1)),
            upload_memory: Arc::new(Semaphore::new(MAX_UPLOAD_BUDGET_UNITS)),
            local_addresses: HashSet::new(),
        };
        let url = Url::parse("https://static.example/app.js").unwrap();
        let mut headers = serde_json::Map::new();
        headers.insert("etag".into(), serde_json::json!("\"v1\""));
        let expired = Instant::now() - Duration::from_secs(1);
        proxy.cache_response(CachedResponse {
            url: url.to_string(),
            vary: Vec::new(),
            status: 200,
            headers,
            body: b"cached body".to_vec().into(),
            expires_at: expired,
            stale_until: Instant::now() + Duration::from_secs(60),
            stamp: 0,
            weight: 0,
        });

        let cached = proxy.cached_response(&url, &HeaderMap::new()).unwrap();
        assert_eq!(cached.body.as_ref(), b"cached body");

        let mut cache = proxy.response_cache.lock().unwrap();
        cache.entries[0].stale_until = Instant::now() - Duration::from_secs(1);
        drop(cache);
        assert!(proxy.cached_response(&url, &HeaderMap::new()).is_none());
    }

    #[test]
    fn websocket_subprotocols_are_token_checked_and_unique() {
        assert!(validate_websocket_protocols(&["chat.v2".into(), "binary".into()]).is_ok());
        assert!(validate_websocket_protocols(&["bad protocol".into()]).is_err());
        assert!(validate_websocket_protocols(&["chat".into(), "chat".into()]).is_err());
        assert!(validate_websocket_protocols(&vec!["x".into(); 17]).is_err());
        assert!(valid_websocket_close_code(1000));
        assert!(!valid_websocket_close_code(1005));
        assert!(valid_websocket_close_code(4000));
        assert_eq!(truncate_utf8("🙂x", 3), "");
        assert_eq!(truncate_utf8("🙂x", 4), "🙂");
        let event = websocket_event_chunk(7, 9, 2, true, &[1, 2, 3]);
        assert_eq!(event[0], WS_RECV);
        assert_eq!(u32::from_be_bytes(event[1..5].try_into().unwrap()), 7);
        assert_eq!(u32::from_be_bytes(event[5..9].try_into().unwrap()), 9);
        assert_eq!(&event[11..], &[1, 2, 3]);
    }

    #[tokio::test]
    async fn websocket_message_chunks_are_bounded_and_final_flagged() {
        let (tx, mut rx) = mpsc::channel(4);
        let mut next_id = 0;
        let bytes = vec![b'x'; CHUNK_BYTES + 3];
        assert!(
            forward_websocket_data(4, UpstreamMessage::Binary(bytes.into()), &mut next_id, &tx,)
                .await
        );
        let first = rx.recv().await.unwrap();
        let second = rx.recv().await.unwrap();
        assert_eq!(first.len(), 11 + CHUNK_BYTES);
        assert_eq!(first[0], WS_RECV);
        assert_eq!(first[10], 0);
        assert_eq!(second.len(), 14);
        assert_eq!(second[10], 1);
        assert_eq!(next_id, 1);
    }

    #[test]
    fn browser_request_headers_exclude_hop_by_hop_and_proxy_fields() {
        assert!(is_forwardable_browser_header("authorization"));
        assert!(is_forwardable_browser_header(
            "access-control-request-method"
        ));
        assert!(is_forwardable_browser_header("range"));
        assert!(!is_forwardable_browser_header("host"));
        assert!(!is_forwardable_browser_header("connection"));
        assert!(!is_forwardable_browser_header("proxy-authorization"));
        assert!(!is_forwardable_browser_header("sec-fetch-site"));
    }

    #[test]
    fn set_cookie_headers_are_preserved_separately_and_bounded() {
        let mut headers = HeaderMap::new();
        headers.append(
            reqwest::header::SET_COOKIE,
            HeaderValue::from_static("session=a; HttpOnly; Path=/"),
        );
        headers.append(
            reqwest::header::SET_COOKIE,
            HeaderValue::from_static("theme=dark; Path=/"),
        );
        let cookies = collect_set_cookies(&headers);
        assert_eq!(
            cookies,
            ["session=a; HttpOnly; Path=/", "theme=dark; Path=/"]
        );

        let mut too_large = HeaderMap::new();
        too_large.append(
            reqwest::header::SET_COOKIE,
            HeaderValue::from_bytes(&vec![b'x'; 4097]).unwrap(),
        );
        assert!(collect_set_cookies(&too_large).is_empty());
    }

    #[test]
    fn same_origin_redirects_apply_path_scoped_cookies_before_following() {
        let source = Url::parse("https://example.test/auth/start").unwrap();
        let next = Url::parse("https://example.test/auth/continue").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            reqwest::header::COOKIE,
            HeaderValue::from_static("old=gone; keep=yes"),
        );
        apply_redirect_cookies(
            &mut headers,
            &[
                "session=new; Path=/auth; HttpOnly".into(),
                "old=expired; Path=/auth; Max-Age=0".into(),
                "wrong=path; Path=/admin".into(),
            ],
            &source,
            &next,
        );
        assert_eq!(
            headers.get(reqwest::header::COOKIE).unwrap(),
            "keep=yes; session=new"
        );

        let cross_origin = Url::parse("https://other.test/auth/continue").unwrap();
        apply_redirect_cookies(
            &mut headers,
            &["leak=no; Path=/".into()],
            &source,
            &cross_origin,
        );
        assert_eq!(
            headers.get(reqwest::header::COOKIE).unwrap(),
            "keep=yes; session=new"
        );
    }

    #[tokio::test]
    async fn completed_response_credit_does_not_interrupt_other_requests() {
        let (completed_tx, mut completed_rx) = mpsc::channel(4);
        let (active_tx, mut active_rx) = mpsc::channel(4);
        let mut senders = HashMap::from([(71, completed_tx), (72, active_tx)]);
        let (event_tx, mut event_rx) = mpsc::channel(4);

        let mut available = CHUNK_BYTES;
        send_credited_chunk(
            71,
            b"last bytes",
            &mut completed_rx,
            &mut available,
            &event_tx,
        )
        .await
        .unwrap();
        event_tx.send(event_chunk(71, true, &[])).await.unwrap();
        drop(completed_rx);
        // The fetch future can finish before the session sends its final marker.
        assert_eq!(accept_response_credit(&senders, 71, 10), Ok(()));
        assert_eq!(
            event_rx.recv().await.unwrap(),
            event_chunk(71, false, b"last bytes")
        );
        assert_eq!(event_rx.recv().await.unwrap(), event_chunk(71, true, &[]));
        // The final marker removes the sender before the client's credit arrives.
        senders.remove(&71);
        assert_eq!(accept_response_credit(&senders, 71, 10), Ok(()));
        assert_eq!(accept_response_credit(&senders, 72, 7), Ok(()));
        let mut available = 0;
        send_credited_chunk(72, b"next ok", &mut active_rx, &mut available, &event_tx)
            .await
            .unwrap();
        assert_eq!(
            event_rx.recv().await.unwrap(),
            event_chunk(72, false, b"next ok")
        );
        assert_eq!(available, 0);
        assert!(
            event_rx.try_recv().is_err(),
            "Late credit must not replay a response"
        );
    }

    #[test]
    fn response_credit_bounds_still_apply_after_completion() {
        let (sender, mut receiver) = mpsc::channel(4);
        let senders = HashMap::from([(71, sender)]);
        for id in [71, 72] {
            assert_eq!(accept_response_credit(&senders, id, 0), Err(()));
            assert_eq!(
                accept_response_credit(&senders, id, CHUNK_BYTES as u32 + 1),
                Err(())
            );
        }
        assert_eq!(accept_response_credit(&senders, 0, 1), Err(()));
        for _ in 0..4 {
            assert_eq!(
                accept_response_credit(&senders, 71, CHUNK_BYTES as u32),
                Ok(())
            );
        }
        assert_eq!(accept_response_credit(&senders, 71, 1), Err(()));
        for _ in 0..4 {
            assert_eq!(receiver.try_recv(), Ok(CHUNK_BYTES as u32));
        }
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn response_chunks_wait_for_matching_credit() {
        let (credit_tx, mut credit_rx) = mpsc::channel(4);
        let (event_tx, mut event_rx) = mpsc::channel(1);
        let bytes = vec![0x5a; CHUNK_BYTES];
        let send = tokio::spawn(async move {
            let mut available = 0;
            send_credited_chunk(71, &bytes, &mut credit_rx, &mut available, &event_tx).await
        });

        assert!(
            timeout(Duration::from_millis(20), event_rx.recv())
                .await
                .is_err()
        );
        credit_tx.send(CHUNK_BYTES as u32 - 1).await.unwrap();
        assert!(
            timeout(Duration::from_millis(20), event_rx.recv())
                .await
                .is_err()
        );
        credit_tx.send(1).await.unwrap();
        let event = timeout(Duration::from_secs(1), event_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event[0], RESPONSE_CHUNK);
        assert_eq!(u32::from_be_bytes(event[1..5].try_into().unwrap()), 71);
        assert_eq!(event.len(), CHUNK_BYTES + 6);
        assert!(event[6..].iter().all(|byte| *byte == 0x5a));
        send.await.unwrap().unwrap();
    }
}
