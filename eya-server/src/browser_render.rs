//! Optional server-rendered compatibility browser over the standalone client's
//! Noise WebSocket. Upstream pages execute only in an isolated headless
//! Chromium process; the client receives screencast frames and sends input.

use crate::{App, PROTOCOL, browser::Proxy, browser_egress};
use axum::{
    extract::{State, ws::WebSocketUpgrade},
    response::IntoResponse,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    env, fs, io,
    net::SocketAddr,
    os::unix::process::CommandExt as StdCommandExt,
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    net::TcpStream,
    process::{Child, Command},
    sync::{Mutex, mpsc, oneshot},
    task::JoinHandle,
    time::{sleep, timeout},
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Message as CdpMessage, protocol::WebSocketConfig},
};

const PROLOGUE: &[u8] = b"eya-browser-render-v1";
const READY: &[u8] = b"eya-browser-render-ready-v1";
const MAX_WS_MESSAGE: usize = 65_535;
const MAX_CHUNK_BYTES: usize = 48 * 1024;
const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
const MAX_INPUT_BYTES: usize = 60 * 1024;
const MAX_REMOTE_TEXT_BYTES: usize = 8 * 1024;
const MAX_CONSOLE_EXPRESSION_BYTES: usize = 16 * 1024;
const MAX_CONSOLE_RESULT_BYTES: usize = 64 * 1024;
const MAX_CLIENT_EVENT_BYTES: usize = 48 * 1024;
const MAX_REMOTE_USERSCRIPT_BYTES: usize = 512 * 1024;
const MAX_REMOTE_USERSCRIPT_COUNT: usize = 16;
const MAX_EXTENSION_FILES: usize = 128;
const MAX_EXTENSION_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_EXTENSION_TOTAL_BYTES: usize = 16 * 1024 * 1024;
const MAX_LOADED_EXTENSIONS: usize = 4;
const MAX_LOADED_EXTENSION_BYTES: usize = 64 * 1024 * 1024;
const MAX_EXTENSION_PATH_BYTES: usize = 256;
const MAX_EXTENSION_MANIFEST_BYTES: usize = 128 * 1024;
const MAX_REMOTE_FILE_UPLOADS: usize = 8;
const MAX_REMOTE_FILE_BYTES: usize = 16 * 1024 * 1024;
const MAX_REMOTE_FILE_UPLOAD_BYTES: usize = 32 * 1024 * 1024;
const MAX_REMOTE_STAGED_UPLOAD_BYTES: usize = 64 * 1024 * 1024;
const MAX_REMOTE_UPLOAD_FILENAME_BYTES: usize = 255;
const DEFAULT_WIDTH: u32 = 1280;
const DEFAULT_HEIGHT: u32 = 720;
const MAX_WIDTH: u32 = 1920;
const MAX_HEIGHT: u32 = 1200;
const CGROUP_EXEC_FLAG: &str = "--eya-browser-cgroup-exec";

// Client -> server opcodes.
const START: u8 = 1;
const NAVIGATE: u8 = 2;
const RESIZE: u8 = 3;
const INPUT: u8 = 4;
const FRAME_ACK: u8 = 5;
const STOP: u8 = 6;
const EVALUATE: u8 = 7;
const PRIVACY: u8 = 8;
const USERSCRIPTS_BEGIN: u8 = 9;
const USERSCRIPTS_CHUNK: u8 = 10;
const USERSCRIPTS_COMMIT: u8 = 11;
const SOURCES_LIST: u8 = 12;
const SOURCE_CONTENT: u8 = 13;
const SITE_DATA_COOKIES: u8 = 14;
const SITE_DATA_CLEAR: u8 = 15;
const EXTENSION_UPLOAD_BEGIN: u8 = 16;
const EXTENSION_UPLOAD_CHUNK: u8 = 17;
const EXTENSION_UPLOAD_COMMIT: u8 = 18;
const EXTENSION_REMOVE: u8 = 19;
const EXTENSION_UPLOAD_ABORT: u8 = 20;
const DEBUGGER_COMMAND: u8 = 21;
const NETWORK_BODY: u8 = 22;
const DOWNLOAD_CANCEL: u8 = 23;
const FILTERS_BEGIN: u8 = 24;
const FILTERS_CHUNK: u8 = 25;
const FILTERS_COMMIT: u8 = 26;
const TAB_ACTIVATE: u8 = 27;
const TAB_CLOSE: u8 = 28;
const FILE_UPLOAD_BEGIN: u8 = 29;
const FILE_UPLOAD_CHUNK: u8 = 30;
const FILE_UPLOAD_COMMIT: u8 = 31;
const FILE_UPLOAD_CANCEL: u8 = 32;
const JAVASCRIPT_DIALOG_REPLY: u8 = 33;
const HISTORY_GO: u8 = 34;
const EXTENSION_ACTION: u8 = 35;

// Server -> client opcodes.
const STATUS: u8 = 129;
const FRAME_START: u8 = 130;
const FRAME_CHUNK: u8 = 131;
const CDP_EVENT: u8 = 132;
const ERROR: u8 = 133;
const EVALUATE_RESULT: u8 = 134;
const USERSCRIPTS_ACK: u8 = 135;
const SOURCES_RESULT: u8 = 136;
const SOURCE_CHUNK: u8 = 137;
const SITE_DATA_RESULT: u8 = 138;
const EXTENSION_RESULT: u8 = 139;
const DEBUGGER_RESULT: u8 = 140;
const NETWORK_BODY_RESULT: u8 = 141;
const NETWORK_BODY_CHUNK: u8 = 142;
const DOWNLOAD_FILE_START: u8 = 143;
const DOWNLOAD_FILE_CHUNK: u8 = 144;
const FILTERS_ACK: u8 = 145;
const FILE_UPLOAD_RESULT: u8 = 146;
const MAX_REMOTE_FILTER_BYTES: usize = 8 * 1024 * 1024;
const MAX_REMOTE_FILTER_RULES: usize = 30_000;
const MAX_REMOTE_SOURCES: usize = 100;
const MAX_REMOTE_SOURCE_BYTES: usize = 512 * 1024;
const MAX_REMOTE_NETWORK_BODY_BYTES: usize = 256 * 1024;
const MAX_REMOTE_NETWORK_REQUESTS: usize = 256;
const MAX_REMOTE_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;
const MAX_REMOTE_DOWNLOADS: usize = 2;
const MAX_REMOTE_TABS: usize = 3;
const MAX_REMOTE_TOUCH_POINTS: usize = 10;
const MAX_REMOTE_DIALOG_MESSAGE_BYTES: usize = 4096;

type CdpSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type CdpSink = futures_util::stream::SplitSink<CdpSocket, CdpMessage>;

pub async fn upgrade(State(app): State<App>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.max_message_size(MAX_WS_MESSAGE)
        .max_frame_size(MAX_WS_MESSAGE)
        .on_upgrade(move |socket| session(socket, app))
}

async fn session(mut socket: axum::extract::ws::WebSocket, app: App) {
    let Ok(params) = PROTOCOL.parse() else { return };
    let Ok(mut noise) = snow::Builder::new(params)
        .psk(0, app.key.as_ref())
        .prologue(PROLOGUE)
        .build_responder()
    else {
        return;
    };
    let mut plain = vec![0u8; MAX_WS_MESSAGE];
    let mut cipher = vec![0u8; MAX_WS_MESSAGE];
    let first = match timeout(Duration::from_secs(10), socket.recv()).await {
        Ok(Some(Ok(axum::extract::ws::Message::Binary(frame)))) => frame,
        _ => return,
    };
    if noise.read_message(&first, &mut plain).is_err() {
        return;
    }
    let Ok(size) = noise.write_message(&[], &mut cipher) else {
        return;
    };
    if socket
        .send(axum::extract::ws::Message::Binary(
            cipher[..size].to_vec().into(),
        ))
        .await
        .is_err()
    {
        return;
    }
    let Ok(mut noise) = noise.into_transport_mode() else {
        return;
    };
    let confirm = match timeout(Duration::from_secs(10), socket.recv()).await {
        Ok(Some(Ok(axum::extract::ws::Message::Binary(frame)))) => frame,
        _ => return,
    };
    let Ok(count) = noise.read_message(&confirm, &mut plain) else {
        return;
    };
    if &plain[..count] != READY {
        return;
    }
    let Ok(size) = noise.write_message(READY, &mut cipher) else {
        return;
    };
    if socket
        .send(axum::extract::ws::Message::Binary(
            cipher[..size].to_vec().into(),
        ))
        .await
        .is_err()
    {
        return;
    }

    enum SessionEvent {
        Client(
            Result<
                Option<Result<axum::extract::ws::Message, axum::Error>>,
                tokio::time::error::Elapsed,
            >,
        ),
        Cdp(Option<Value>),
    }
    let mut remote: Option<RemoteBrowser> = None;
    let mut remote_events: Option<mpsc::Receiver<Value>> = None;
    let mut frame_waiting: Option<(u32, u32)> = None;
    let mut pending_evaluations = std::collections::HashMap::<u32, PendingEvaluation>::new();
    let mut pending_sources = std::collections::HashMap::<u32, PendingSourceRequest>::new();
    let mut page_devtools = std::collections::HashMap::<String, RemotePageDevtoolsState>::new();
    let mut allowed_sources = std::collections::HashMap::<String, String>::new();
    let mut pending_site_data = std::collections::HashMap::<u32, PendingSiteDataRequest>::new();
    let mut pending_network_bodies = std::collections::HashMap::<u32, PendingNetworkBody>::new();
    let mut remote_network_requests =
        std::collections::HashMap::<String, std::collections::VecDeque<String>>::new();
    let mut remote_downloads = std::collections::HashMap::<u32, RemoteDownload>::new();
    let mut remote_download_ids = std::collections::HashMap::<String, u32>::new();
    let mut next_remote_download_id = 0u32;
    let mut debugger_breakpoints = std::collections::HashSet::<String>::new();
    let mut debugger_call_frames = std::collections::HashSet::<String>::new();
    let mut debugger_remote_objects = std::collections::HashSet::<String>::new();
    let mut debugger_scopes = std::collections::HashMap::<String, Vec<Value>>::new();
    let mut debugger_paused_event: Option<Value> = None;
    let mut userscript_upload: Option<UserScriptUpload> = None;
    let mut filter_upload: Option<FilterUpload> = None;
    let mut extension_upload: Option<ExtensionUpload> = None;
    let mut page_file_upload: Option<PageFileUpload> = None;
    let mut pending_file_chooser: Option<PendingPageFileChooser> = None;
    let mut next_file_chooser_id = 0u32;
    let mut pending_javascript_dialogs =
        std::collections::HashMap::<String, PendingJavascriptDialog>::new();
    let mut next_javascript_dialog_id = 0u32;
    let mut next_frame_sequence = 0u32;
    let mut current_remote_url = String::new();
    let mut current_main_frame_id = String::new();
    loop {
        let next = tokio::select! {
            client = timeout(Duration::from_secs(180), socket.recv()) => SessionEvent::Client(client),
            event = async {
                if let Some(events) = remote_events.as_mut() {
                    events.recv().await
                } else {
                    std::future::pending::<Option<Value>>().await
                }
            } => SessionEvent::Cdp(event),
        };
        match next {
            SessionEvent::Client(Ok(Some(Ok(axum::extract::ws::Message::Binary(incoming))))) => {
                let Ok(count) = noise.read_message(&incoming, &mut plain) else {
                    break;
                };
                if count == 0 {
                    break;
                }
                match plain[0] {
                    START if count == 1 && remote.is_none() => {
                        let Ok(slot) = app.browser_render_slots.clone().try_acquire_owned() else {
                            send_json(&mut socket, &mut noise, STATUS, &json!({
                                "type":"error", "message":"The remote browser session limit is busy"
                            })).await;
                            continue;
                        };
                        match RemoteBrowser::start(app.browser.clone(), slot).await {
                            Ok(mut browser) => {
                                remote_events = Some(browser.take_events());
                                let resource_limits = browser_resource_limits_status(
                                    browser
                                        .cgroup
                                        .as_ref()
                                        .map(|_| configured_browser_cgroup_limits()),
                                );
                                send_json(&mut socket, &mut noise, STATUS, &json!({
                                    "type":"ready", "width":DEFAULT_WIDTH, "height":DEFAULT_HEIGHT,
                                    "downloadsEnabled":browser.downloads_enabled,
                                    "resourceLimits":resource_limits
                                })).await;
                                remote = Some(browser);
                            }
                            Err(error) => {
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    STATUS,
                                    &json!({"type":"error", "message":error}),
                                )
                                .await
                            }
                        }
                    }
                    NAVIGATE if count > 1 && count <= 8192 => {
                        let Ok(request) = serde_json::from_slice::<Navigate>(&plain[1..count])
                        else {
                            send_error(&mut socket, &mut noise, "Invalid navigation request").await;
                            continue;
                        };
                        let Some(browser) = remote.as_mut() else {
                            send_error(&mut socket, &mut noise, "Start the remote browser first")
                                .await;
                            continue;
                        };
                        if !valid_remote_tab_id(&request.tab_id) {
                            send_error(&mut socket, &mut noise, "Remote tab id is invalid").await;
                            continue;
                        }
                        if pending_file_chooser
                            .as_ref()
                            .is_some_and(|chooser| chooser.tab_id == request.tab_id)
                        {
                            pending_file_chooser = None;
                        }
                        if page_file_upload
                            .as_ref()
                            .is_some_and(|upload| upload.tab_id == request.tab_id)
                            && let Some(upload) = page_file_upload.take()
                        {
                            let _ = tokio::fs::remove_dir_all(upload.root).await;
                            send_json(&mut socket, &mut noise, FILE_UPLOAD_RESULT, &json!({"id":upload.id,"ok":false,"error":"Page navigated during file upload"})).await;
                        }
                        if let Some(dialog) = pending_javascript_dialogs.remove(&request.tab_id) {
                            let _ = browser
                                .handle_javascript_dialog_for_tab(&request.tab_id, false, "")
                                .await;
                            send_json(
                                &mut socket,
                                &mut noise,
                                STATUS,
                                &json!({"type":"javascript-dialog-closed","id":dialog.id,"tabId":dialog.tab_id}),
                            )
                            .await;
                        }
                        if let Some((_, cdp_frame)) = frame_waiting.take() {
                            browser.ack_frame(cdp_frame).await;
                        }
                        match browser.navigate(&request.tab_id, &request.url).await {
                            Ok(()) => {
                                current_remote_url = request.url.clone();
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    STATUS,
                                    &json!({"type":"navigating", "tabId":request.tab_id, "url":request.url}),
                                )
                                .await
                            }
                            Err(error) => {
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    STATUS,
                                    &json!({
                                        "type":"tab-error", "tabId":request.tab_id, "message":error
                                    }),
                                )
                                .await;
                            }
                        }
                    }
                    HISTORY_GO if count > 1 && count <= 1024 => {
                        let Ok(request) =
                            serde_json::from_slice::<RemoteHistoryRequest>(&plain[1..count])
                        else {
                            send_error(&mut socket, &mut noise, "Invalid remote history request")
                                .await;
                            continue;
                        };
                        if !valid_remote_tab_id(&request.tab_id)
                            || request.delta == 0
                            || request.delta.unsigned_abs() > 50
                            || remote.as_ref().is_none_or(|browser| {
                                browser.active_tab_id() != Some(request.tab_id.as_str())
                            })
                        {
                            send_json(
                                &mut socket,
                                &mut noise,
                                STATUS,
                                &json!({"type":"history-error","tabId":request.tab_id,"message":"The remote history request is invalid or its tab changed"}),
                            )
                            .await;
                            continue;
                        }
                        let result = if let Some(browser) = remote.as_mut() {
                            browser
                                .navigate_history(&request.tab_id, request.delta)
                                .await
                        } else {
                            Err("Remote browser is not started".to_owned())
                        };
                        if let Err(message) = result {
                            send_json(
                                &mut socket,
                                &mut noise,
                                STATUS,
                                &json!({"type":"history-error","tabId":request.tab_id,"message":message}),
                            )
                            .await;
                        }
                    }
                    TAB_ACTIVATE if count > 1 && count <= 1024 => {
                        let Ok(request) =
                            serde_json::from_slice::<RemoteTabRequest>(&plain[1..count])
                        else {
                            send_error(&mut socket, &mut noise, "Invalid remote tab request").await;
                            continue;
                        };
                        if !valid_remote_tab_id(&request.tab_id) {
                            send_error(&mut socket, &mut noise, "Remote tab id is invalid").await;
                            continue;
                        }
                        if pending_file_chooser
                            .as_ref()
                            .is_some_and(|chooser| chooser.tab_id != request.tab_id)
                        {
                            pending_file_chooser = None;
                        }
                        if page_file_upload
                            .as_ref()
                            .is_some_and(|upload| upload.tab_id != request.tab_id)
                            && let Some(upload) = page_file_upload.take()
                        {
                            let _ = tokio::fs::remove_dir_all(upload.root).await;
                            send_json(&mut socket, &mut noise, FILE_UPLOAD_RESULT, &json!({"id":upload.id,"ok":false,"error":"Page tab changed during file upload"})).await;
                        }
                        let Some(browser) = remote.as_mut() else {
                            send_error(&mut socket, &mut noise, "Start the remote browser first")
                                .await;
                            continue;
                        };
                        if let Some((_, cdp_frame)) = frame_waiting.take() {
                            browser.ack_frame(cdp_frame).await;
                        }
                        let previous_tab_id = browser.active_tab_id().map(str::to_owned);
                        match browser.activate_tab(&request.tab_id).await {
                            Ok((url, frame_id)) => {
                                let activated_tab_id = browser
                                    .active_tab_id()
                                    .unwrap_or(&request.tab_id)
                                    .to_owned();
                                if previous_tab_id.as_deref() != Some(activated_tab_id.as_str()) {
                                    if let Some(previous_tab_id) = previous_tab_id {
                                        page_devtools.insert(
                                            previous_tab_id,
                                            RemotePageDevtoolsState {
                                                allowed_sources: std::mem::take(
                                                    &mut allowed_sources,
                                                ),
                                                breakpoints: std::mem::take(
                                                    &mut debugger_breakpoints,
                                                ),
                                                call_frames: std::mem::take(
                                                    &mut debugger_call_frames,
                                                ),
                                                remote_objects: std::mem::take(
                                                    &mut debugger_remote_objects,
                                                ),
                                                scopes: std::mem::take(&mut debugger_scopes),
                                                paused_event: debugger_paused_event.take(),
                                            },
                                        );
                                    }
                                    let restored =
                                        page_devtools.remove(&activated_tab_id).unwrap_or_default();
                                    allowed_sources = restored.allowed_sources;
                                    debugger_breakpoints = restored.breakpoints;
                                    debugger_call_frames = restored.call_frames;
                                    debugger_remote_objects = restored.remote_objects;
                                    debugger_scopes = restored.scopes;
                                    debugger_paused_event = restored.paused_event;
                                }
                                current_remote_url = url.clone();
                                current_main_frame_id = frame_id;
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    STATUS,
                                    &json!({
                                        "type":"tab-activated", "tabId":request.tab_id, "url":url
                                    }),
                                )
                                .await;
                                if let Some(browser) = remote.as_mut()
                                    && let Ok(mut history) =
                                        browser.navigation_history_for_tab(&request.tab_id).await
                                {
                                    history["type"] = json!("history");
                                    history["tabId"] = json!(request.tab_id);
                                    send_json(&mut socket, &mut noise, STATUS, &history).await;
                                }
                                let mut debugger_event =
                                    debugger_paused_event.clone().unwrap_or_else(
                                        || json!({"method":"Debugger.resumed","params":{}}),
                                    );
                                debugger_event["tabId"] = json!(activated_tab_id);
                                send_json(&mut socket, &mut noise, CDP_EVENT, &debugger_event)
                                    .await;
                            }
                            Err(error) => {
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    STATUS,
                                    &json!({
                                        "type":"tab-error",
                                        "tabId":request.tab_id,
                                        "message":error
                                    }),
                                )
                                .await;
                            }
                        }
                    }
                    TAB_CLOSE if count > 1 && count <= 1024 => {
                        let Ok(request) =
                            serde_json::from_slice::<RemoteTabRequest>(&plain[1..count])
                        else {
                            send_error(&mut socket, &mut noise, "Invalid remote tab request").await;
                            continue;
                        };
                        if !valid_remote_tab_id(&request.tab_id) {
                            send_error(&mut socket, &mut noise, "Remote tab id is invalid").await;
                            continue;
                        }
                        if pending_file_chooser
                            .as_ref()
                            .is_some_and(|chooser| chooser.tab_id == request.tab_id)
                        {
                            pending_file_chooser = None;
                        }
                        if page_file_upload
                            .as_ref()
                            .is_some_and(|upload| upload.tab_id == request.tab_id)
                            && let Some(upload) = page_file_upload.take()
                        {
                            let _ = tokio::fs::remove_dir_all(upload.root).await;
                            send_json(&mut socket, &mut noise, FILE_UPLOAD_RESULT, &json!({"id":upload.id,"ok":false,"error":"Page tab closed during file upload"})).await;
                        }
                        if let Some(browser) = remote.as_mut() {
                            if let Some(dialog) = pending_javascript_dialogs.remove(&request.tab_id)
                            {
                                let _ = browser
                                    .handle_javascript_dialog_for_tab(&request.tab_id, false, "")
                                    .await;
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    STATUS,
                                    &json!({"type":"javascript-dialog-closed","id":dialog.id,"tabId":dialog.tab_id}),
                                )
                                .await;
                            }
                            let was_active =
                                browser.active_tab_id() == Some(request.tab_id.as_str());
                            if was_active {
                                if let Some((_, cdp_frame)) = frame_waiting.take() {
                                    browser.ack_frame(cdp_frame).await;
                                }
                                current_remote_url.clear();
                                current_main_frame_id.clear();
                                allowed_sources.clear();
                                debugger_breakpoints.clear();
                                debugger_call_frames.clear();
                                debugger_remote_objects.clear();
                                debugger_scopes.clear();
                                debugger_paused_event = None;
                            }
                            page_devtools.remove(&request.tab_id);
                            remote_network_requests.remove(&request.tab_id);
                            if let Err(error) = browser.close_tab(&request.tab_id).await {
                                send_error(&mut socket, &mut noise, &error).await;
                            }
                        }
                    }
                    RESIZE if count > 1 && count <= 1024 => {
                        let Ok(resize) = serde_json::from_slice::<Resize>(&plain[1..count]) else {
                            send_error(&mut socket, &mut noise, "Invalid viewport size").await;
                            continue;
                        };
                        if !valid_remote_tab_id(&resize.tab_id)
                            || remote.as_ref().and_then(RemoteBrowser::active_tab_id)
                                != Some(resize.tab_id.as_str())
                        {
                            continue;
                        }
                        if let Some(browser) = remote.as_mut()
                            && let Err(error) = browser.resize(resize.width, resize.height).await
                        {
                            send_error(&mut socket, &mut noise, &error).await;
                        }
                    }
                    INPUT if count > 1 && count <= MAX_INPUT_BYTES => {
                        let Ok(input) = serde_json::from_slice::<Input>(&plain[1..count]) else {
                            continue;
                        };
                        if !valid_remote_tab_id(&input.tab_id)
                            || remote.as_ref().and_then(RemoteBrowser::active_tab_id)
                                != Some(input.tab_id.as_str())
                        {
                            continue;
                        }
                        if let Some(browser) = remote.as_mut()
                            && let Err(error) = browser.input(input).await
                        {
                            send_error(&mut socket, &mut noise, &error).await;
                        }
                    }
                    EVALUATE if count > 1 && count <= MAX_CONSOLE_EXPRESSION_BYTES + 1024 => {
                        let Ok(eval) = serde_json::from_slice::<Evaluate>(&plain[1..count]) else {
                            continue;
                        };
                        if eval.id == 0
                            || eval.expression.len() > MAX_CONSOLE_EXPRESSION_BYTES
                            || pending_evaluations.len() >= 16
                        {
                            send_json(&mut socket, &mut noise, EVALUATE_RESULT, &json!({
                                "id":eval.id,"tabId":eval.tab_id,"result":null,"exception":"Evaluation request is invalid or busy"
                            })).await;
                            continue;
                        }
                        let Some(browser) = remote.as_mut() else {
                            send_json(&mut socket, &mut noise, EVALUATE_RESULT, &json!({
                                "id":eval.id,"tabId":eval.tab_id,"result":null,"exception":"Remote browser is not started"
                            })).await;
                            continue;
                        };
                        if !valid_remote_tab_id(&eval.tab_id)
                            || browser.active_tab_id() != Some(eval.tab_id.as_str())
                        {
                            send_json(&mut socket, &mut noise, EVALUATE_RESULT, &json!({
                                "id":eval.id,"tabId":eval.tab_id,"result":null,"exception":"The remote tab changed before evaluation"
                            })).await;
                            continue;
                        }
                        let frame_id = match validate_call_frame(
                            eval.call_frame_id.as_deref(),
                            &debugger_call_frames,
                        ) {
                            Ok(value) => value,
                            Err(error) => {
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    EVALUATE_RESULT,
                                    &json!({"id":eval.id,"tabId":eval.tab_id,"result":null,"exception":error}),
                                )
                                .await;
                                continue;
                            }
                        };
                        let command = match frame_id {
                            Some(call_frame_id) => {
                                browser
                                    .evaluate_on_call_frame(&eval.expression, call_frame_id)
                                    .await
                            }
                            None => browser.evaluate(&eval.expression).await,
                        };
                        match command {
                            Ok(command_id) => {
                                pending_evaluations.insert(
                                    command_id,
                                    PendingEvaluation {
                                        request_id: eval.id,
                                        tab_id: eval.tab_id,
                                    },
                                );
                            }
                            Err(error) => send_json(
                                &mut socket,
                                &mut noise,
                                EVALUATE_RESULT,
                                &json!({
                                    "id":eval.id,"tabId":eval.tab_id,"result":null,"exception":error
                                }),
                            )
                            .await,
                        }
                    }
                    DEBUGGER_COMMAND if count > 1 && count <= 4096 => {
                        let Ok(request) =
                            serde_json::from_slice::<DebuggerCommand>(&plain[1..count])
                        else {
                            send_json(
                                &mut socket,
                                &mut noise,
                                DEBUGGER_RESULT,
                                &json!({"id":0,"ok":false,"error":"Invalid debugger command"}),
                            )
                            .await;
                            continue;
                        };
                        let Some(browser) = remote.as_mut() else {
                            send_json(&mut socket, &mut noise, DEBUGGER_RESULT, &json!({"id":request.id,"tabId":request.tab_id,"ok":false,"error":"Remote browser is not started"})).await;
                            continue;
                        };
                        if request.id == 0 {
                            send_json(&mut socket, &mut noise, DEBUGGER_RESULT, &json!({"id":request.id,"tabId":request.tab_id,"ok":false,"error":"Debugger request id is invalid"})).await;
                            continue;
                        }
                        if !valid_remote_tab_id(&request.tab_id)
                            || browser.active_tab_id() != Some(request.tab_id.as_str())
                        {
                            send_json(&mut socket, &mut noise, DEBUGGER_RESULT, &json!({"id":request.id,"tabId":request.tab_id,"ok":false,"error":"The remote tab changed before the debugger command"})).await;
                            continue;
                        }
                        let result = match request.action.as_str() {
                            "pause" => {
                                browser
                                    .debugger_command(
                                        "pause",
                                        Value::Null,
                                        &debugger_breakpoints,
                                        &allowed_sources,
                                    )
                                    .await
                            }
                            "resume" => {
                                browser
                                    .debugger_command(
                                        "resume",
                                        Value::Null,
                                        &debugger_breakpoints,
                                        &allowed_sources,
                                    )
                                    .await
                            }
                            "stepOver" => {
                                browser
                                    .debugger_command(
                                        "stepOver",
                                        Value::Null,
                                        &debugger_breakpoints,
                                        &allowed_sources,
                                    )
                                    .await
                            }
                            "stepInto" => {
                                browser
                                    .debugger_command(
                                        "stepInto",
                                        Value::Null,
                                        &debugger_breakpoints,
                                        &allowed_sources,
                                    )
                                    .await
                            }
                            "stepOut" => {
                                browser
                                    .debugger_command(
                                        "stepOut",
                                        Value::Null,
                                        &debugger_breakpoints,
                                        &allowed_sources,
                                    )
                                    .await
                            }
                            "setBreakpoint" => {
                                let url = request.url.as_deref().unwrap_or("");
                                let line = request.line.unwrap_or(0);
                                if line == 0
                                    || line > 1_000_000
                                    || !allowed_sources.contains_key(url)
                                {
                                    Err("Breakpoint source or line is invalid".to_string())
                                } else {
                                    browser
                                        .debugger_command(
                                            "setBreakpoint",
                                            json!({"url":url,"line":line - 1}),
                                            &debugger_breakpoints,
                                            &allowed_sources,
                                        )
                                        .await
                                }
                            }
                            "removeBreakpoint" => {
                                let breakpoint_id = request.breakpoint_id.as_deref().unwrap_or("");
                                browser
                                    .debugger_command(
                                        "removeBreakpoint",
                                        json!({"breakpointId":breakpoint_id}),
                                        &debugger_breakpoints,
                                        &allowed_sources,
                                    )
                                    .await
                            }
                            "getProperties" => {
                                let object_id = request.object_id.as_deref().unwrap_or("");
                                if object_id.is_empty()
                                    || !debugger_remote_objects.contains(object_id)
                                {
                                    Err("Remote object is not available in this browser session"
                                        .to_string())
                                } else {
                                    browser.get_object_properties(object_id).await
                                }
                            }
                            "getScopes" => {
                                let frame_id = request.call_frame_id.as_deref().unwrap_or("");
                                if frame_id.is_empty() || !debugger_call_frames.contains(frame_id) {
                                    Err("Debugger call frame is no longer paused".to_string())
                                } else if let Some(scopes) = debugger_scopes.get(frame_id) {
                                    for scope in scopes {
                                        if let Some(id) = scope
                                            .pointer("/object/objectId")
                                            .and_then(Value::as_str)
                                            && debugger_remote_objects.len() < 256
                                        {
                                            debugger_remote_objects.insert(id.to_owned());
                                        }
                                    }
                                    Ok(json!({"scopeChain":scopes}))
                                } else {
                                    Err("Scope data is no longer available".to_string())
                                }
                            }
                            _ => Err("Unsupported debugger command".to_string()),
                        };
                        match result {
                            Ok(value) => {
                                let mut properties = Vec::new();
                                let mut scopes = Vec::new();
                                if request.action == "getProperties" {
                                    properties = remote_object_properties(&value);
                                    for property in &properties {
                                        if let Some(id) = property
                                            .pointer("/value/objectId")
                                            .and_then(Value::as_str)
                                            && id.len() <= 512
                                            && debugger_remote_objects.len() < 256
                                        {
                                            debugger_remote_objects.insert(id.to_owned());
                                        }
                                    }
                                }
                                if request.action == "getScopes" {
                                    scopes = value
                                        .get("scopeChain")
                                        .and_then(Value::as_array)
                                        .cloned()
                                        .unwrap_or_default();
                                }
                                let error = value
                                    .get("error")
                                    .and_then(|item| item.get("message"))
                                    .and_then(Value::as_str)
                                    .map(|message| message.chars().take(256).collect::<String>());
                                if let Some(error) = error {
                                    send_json(
                                        &mut socket,
                                        &mut noise,
                                        DEBUGGER_RESULT,
                                        &json!({"id":request.id,"tabId":request.tab_id,"ok":false,"error":error}),
                                    )
                                    .await;
                                    continue;
                                }
                                let breakpoint_id = value
                                    .pointer("/result/breakpointId")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned);
                                if let Some(id) = breakpoint_id.as_ref() {
                                    debugger_breakpoints.insert(id.clone());
                                }
                                if request.action == "removeBreakpoint"
                                    && let Some(id) = request.breakpoint_id.as_deref()
                                {
                                    debugger_breakpoints.remove(id);
                                }
                                send_json(&mut socket, &mut noise, DEBUGGER_RESULT, &json!({"id":request.id,"tabId":request.tab_id,"ok":true,"breakpointId":breakpoint_id,"properties":properties,"scopeChain":scopes})).await;
                            }
                            Err(error) => {
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    DEBUGGER_RESULT,
                                    &json!({"id":request.id,"tabId":request.tab_id,"ok":false,"error":error}),
                                )
                                .await
                            }
                        }
                    }
                    USERSCRIPTS_BEGIN if count > 1 && count <= 1024 => {
                        let Ok(begin) = serde_json::from_slice::<UserscriptBegin>(&plain[1..count])
                        else {
                            send_error(&mut socket, &mut noise, "Invalid userscript upload header")
                                .await;
                            userscript_upload = None;
                            continue;
                        };
                        let expected_chunks = begin.total_bytes.div_ceil(MAX_CHUNK_BYTES);
                        if begin.id == 0
                            || begin.total_bytes == 0
                            || begin.total_bytes > MAX_REMOTE_USERSCRIPT_BYTES
                            || begin.chunks as usize != expected_chunks
                            || expected_chunks == 0
                        {
                            send_error(
                                &mut socket,
                                &mut noise,
                                "Userscript upload exceeds its limits",
                            )
                            .await;
                            userscript_upload = None;
                            continue;
                        }
                        userscript_upload = Some(UserScriptUpload {
                            id: begin.id,
                            total_bytes: begin.total_bytes,
                            chunks: begin.chunks,
                            next_chunk: 0,
                            bytes: Vec::with_capacity(begin.total_bytes),
                        });
                    }
                    USERSCRIPTS_CHUNK if count > 7 && count <= MAX_CHUNK_BYTES + 7 => {
                        let id = u32::from_be_bytes(plain[1..5].try_into().unwrap());
                        let index = u16::from_be_bytes(plain[5..7].try_into().unwrap());
                        let Some(upload) = userscript_upload.as_mut() else {
                            send_error(&mut socket, &mut noise, "No userscript upload is active")
                                .await;
                            continue;
                        };
                        let expected_size =
                            (upload.total_bytes - upload.bytes.len()).min(MAX_CHUNK_BYTES);
                        if upload.id != id
                            || upload.next_chunk != index
                            || count - 7 != expected_size
                        {
                            userscript_upload = None;
                            send_error(
                                &mut socket,
                                &mut noise,
                                "Userscript chunk order or size is invalid",
                            )
                            .await;
                            continue;
                        }
                        upload.bytes.extend_from_slice(&plain[7..count]);
                        upload.next_chunk += 1;
                    }
                    USERSCRIPTS_COMMIT if count == 5 => {
                        let id = u32::from_be_bytes(plain[1..5].try_into().unwrap());
                        let upload = userscript_upload.take();
                        let Some(upload) = upload.filter(|upload| {
                            upload.id == id
                                && upload.next_chunk == upload.chunks
                                && upload.bytes.len() == upload.total_bytes
                        }) else {
                            send_json(&mut socket, &mut noise, USERSCRIPTS_ACK, &json!({"id":id,"ok":false,"error":"Userscript upload is incomplete"})).await;
                            continue;
                        };
                        let result = serde_json::from_slice::<Vec<String>>(&upload.bytes)
                            .map_err(|_| "Userscript payload is invalid")
                            .and_then(|sources| {
                                if sources.len() > MAX_REMOTE_USERSCRIPT_COUNT
                                    || sources.iter().any(|source| {
                                        source.is_empty()
                                            || source.len() > MAX_REMOTE_USERSCRIPT_BYTES
                                    })
                                {
                                    Err("Userscript payload exceeds its limits")
                                } else {
                                    Ok(sources)
                                }
                            });
                        let result = match (result, remote.as_mut()) {
                            (Ok(sources), Some(browser)) => browser
                                .replace_userscripts(sources)
                                .await
                                .map_err(|_| "Could not install remote userscripts"),
                            (Ok(_), None) => Err("Remote browser is not started"),
                            (Err(error), _) => Err(error),
                        };
                        match result {
                            Ok(()) => {
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    USERSCRIPTS_ACK,
                                    &json!({"id":id,"ok":true}),
                                )
                                .await
                            }
                            Err(error) => {
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    USERSCRIPTS_ACK,
                                    &json!({"id":id,"ok":false,"error":error}),
                                )
                                .await
                            }
                        }
                    }
                    FILTERS_BEGIN if count > 1 && count <= 1024 => {
                        let Ok(begin) =
                            serde_json::from_slice::<FilterUploadBegin>(&plain[1..count])
                        else {
                            send_error(
                                &mut socket,
                                &mut noise,
                                "Invalid filter-list upload header",
                            )
                            .await;
                            filter_upload = None;
                            continue;
                        };
                        let expected_chunks = begin.total_bytes.div_ceil(MAX_CHUNK_BYTES);
                        if begin.id == 0
                            || begin.version != 1
                            || begin.total_bytes == 0
                            || begin.total_bytes > MAX_REMOTE_FILTER_BYTES
                            || begin.chunks as usize != expected_chunks
                            || begin.host_count > MAX_REMOTE_FILTER_RULES
                            || begin.rule_count > MAX_REMOTE_FILTER_RULES
                            || begin.host_count.saturating_add(begin.rule_count)
                                > MAX_REMOTE_FILTER_RULES
                        {
                            send_json(&mut socket, &mut noise, FILTERS_ACK, &json!({"id":begin.id,"ok":false,"error":"Filter-list upload exceeds its limits"})).await;
                            filter_upload = None;
                            continue;
                        }
                        filter_upload = Some(FilterUpload {
                            id: begin.id,
                            total_bytes: begin.total_bytes,
                            chunks: begin.chunks,
                            next_chunk: 0,
                            rule_count: begin.rule_count,
                            host_count: begin.host_count,
                            bytes: Vec::with_capacity(begin.total_bytes),
                        });
                    }
                    FILTERS_CHUNK if count > 7 && count <= MAX_CHUNK_BYTES + 7 => {
                        let id = u32::from_be_bytes(plain[1..5].try_into().unwrap());
                        let index = u16::from_be_bytes(plain[5..7].try_into().unwrap());
                        let Some(upload) = filter_upload.as_mut() else {
                            send_error(&mut socket, &mut noise, "No filter-list upload is active")
                                .await;
                            continue;
                        };
                        let expected_size =
                            (upload.total_bytes - upload.bytes.len()).min(MAX_CHUNK_BYTES);
                        if upload.id != id
                            || upload.next_chunk != index
                            || count - 7 != expected_size
                        {
                            filter_upload = None;
                            send_error(
                                &mut socket,
                                &mut noise,
                                "Filter-list chunk order or size is invalid",
                            )
                            .await;
                            continue;
                        }
                        upload.bytes.extend_from_slice(&plain[7..count]);
                        upload.next_chunk += 1;
                    }
                    FILTERS_COMMIT if count > 1 && count <= 128 => {
                        let Ok(commit) =
                            serde_json::from_slice::<FilterUploadCommit>(&plain[1..count])
                        else {
                            send_error(&mut socket, &mut noise, "Invalid filter-list commit").await;
                            continue;
                        };
                        let upload = filter_upload.take();
                        let result = upload
                            .filter(|upload| {
                                upload.id == commit.id
                                    && upload.next_chunk == upload.chunks
                                    && upload.bytes.len() == upload.total_bytes
                            })
                            .ok_or("Filter-list upload is incomplete")
                            .and_then(|upload| {
                                serde_json::from_slice::<RemoteFilterSet>(&upload.bytes)
                                    .map_err(|_| "Filter-list payload is invalid")
                                    .and_then(|filters| {
                                        validate_remote_filters(
                                            filters,
                                            upload.rule_count,
                                            upload.host_count,
                                        )
                                    })
                            });
                        match (result, remote.as_mut()) {
                            (Ok(filters), Some(browser)) => { browser.filters = filters; send_json(&mut socket, &mut noise, FILTERS_ACK, &json!({"id":commit.id,"ok":true})).await; }
                            (Ok(_), None) => send_json(&mut socket, &mut noise, FILTERS_ACK, &json!({"id":commit.id,"ok":false,"error":"Remote browser is not started"})).await,
                            (Err(error), _) => send_json(&mut socket, &mut noise, FILTERS_ACK, &json!({"id":commit.id,"ok":false,"error":error})).await,
                        }
                    }
                    EXTENSION_UPLOAD_BEGIN if count > 1 && count <= 40 * 1024 => {
                        let Ok(request) =
                            serde_json::from_slice::<ExtensionUploadBegin>(&plain[1..count])
                        else {
                            send_json(&mut socket, &mut noise, EXTENSION_RESULT, &json!({"id":0,"ok":false,"error":"Invalid extension upload manifest"})).await;
                            continue;
                        };
                        let Some(browser) = remote.as_ref() else {
                            send_json(&mut socket, &mut noise, EXTENSION_RESULT, &json!({"id":request.id,"ok":false,"error":"Start the remote browser first"})).await;
                            continue;
                        };
                        if request.id == 0 || extension_upload.is_some() {
                            send_json(&mut socket, &mut noise, EXTENSION_RESULT, &json!({"id":request.id,"ok":false,"error":"An extension upload is already active or the request id is invalid"})).await;
                            continue;
                        }
                        let validated = validate_extension_files(&request.files);
                        let upload = match validated {
                            Ok(total_bytes) => match validate_extension_capacity(
                                browser.extensions.len(),
                                browser
                                    .extensions
                                    .iter()
                                    .map(|extension| extension.bytes)
                                    .sum(),
                                total_bytes,
                            ) {
                                Ok(()) => {
                                    create_extension_upload(
                                        request.id,
                                        request.files,
                                        total_bytes,
                                        &browser._profile,
                                    )
                                    .await
                                }
                                Err(error) => Err(error),
                            },
                            Err(error) => Err(error),
                        };
                        match upload {
                            Ok(upload) => {
                                extension_upload = Some(upload);
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    EXTENSION_RESULT,
                                    &json!({"id":request.id,"ok":true,"phase":"ready"}),
                                )
                                .await;
                            }
                            Err(error) => {
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    EXTENSION_RESULT,
                                    &json!({"id":request.id,"ok":false,"error":error}),
                                )
                                .await
                            }
                        }
                    }
                    EXTENSION_UPLOAD_CHUNK if count > 11 && count <= 11 + MAX_CHUNK_BYTES => {
                        let id = u32::from_be_bytes(plain[1..5].try_into().unwrap());
                        let file_index =
                            u16::from_be_bytes(plain[5..7].try_into().unwrap()) as usize;
                        let offset = u32::from_be_bytes(plain[7..11].try_into().unwrap()) as usize;
                        let result = if let Some(upload) =
                            extension_upload.as_mut().filter(|upload| upload.id == id)
                        {
                            write_extension_chunk(upload, file_index, offset, &plain[11..count])
                                .await
                        } else {
                            Err("No matching extension upload is active")
                        };
                        match result {
                            Ok((next_file, next_offset)) => send_json(&mut socket, &mut noise, EXTENSION_RESULT, &json!({"id":id,"ok":true,"phase":"chunk","fileIndex":next_file,"offset":next_offset})).await,
                            Err(error) => {
                                if extension_upload.as_ref().is_some_and(|upload| upload.id == id)
                                    && let Some(upload) = extension_upload.take()
                                {
                                    let _ = tokio::fs::remove_dir_all(upload.root).await;
                                }
                                send_json(&mut socket, &mut noise, EXTENSION_RESULT, &json!({"id":id,"ok":false,"error":error})).await;
                            }
                        }
                    }
                    EXTENSION_UPLOAD_CHUNK => {
                        let id = if count >= 5 {
                            u32::from_be_bytes(plain[1..5].try_into().unwrap())
                        } else {
                            0
                        };
                        if extension_upload
                            .as_ref()
                            .is_some_and(|upload| upload.id == id)
                            && let Some(upload) = extension_upload.take()
                        {
                            let _ = tokio::fs::remove_dir_all(upload.root).await;
                        }
                        send_json(
                            &mut socket,
                            &mut noise,
                            EXTENSION_RESULT,
                            &json!({"id":id,"ok":false,"error":"Extension chunk size is invalid"}),
                        )
                        .await;
                    }
                    EXTENSION_UPLOAD_COMMIT if count == 5 => {
                        let id = u32::from_be_bytes(plain[1..5].try_into().unwrap());
                        let Some(upload) = extension_upload.take() else {
                            send_json(&mut socket, &mut noise, EXTENSION_RESULT, &json!({"id":id,"ok":false,"error":"Extension upload is incomplete"})).await;
                            continue;
                        };
                        let complete = upload.id == id
                            && upload.next_file == upload.files.len()
                            && upload.total_bytes
                                == upload.files.iter().map(|file| file.size).sum::<usize>();
                        if !complete {
                            let _ = tokio::fs::remove_dir_all(upload.root).await;
                            send_json(&mut socket, &mut noise, EXTENSION_RESULT, &json!({"id":id,"ok":false,"error":"Extension upload is incomplete"})).await;
                            continue;
                        }
                        let result = match remote.as_mut() {
                            Some(browser) => browser.install_extension(upload).await,
                            None => {
                                let _ = tokio::fs::remove_dir_all(upload.root).await;
                                Err("Remote browser is not started")
                            }
                        };
                        match result {
                            Ok(extension) => send_json(&mut socket, &mut noise, EXTENSION_RESULT, &json!({"id":id,"ok":true,"phase":"installed","extension":{"id":extension.id,"name":extension.name,"hasAction":extension.has_action}})).await,
                            Err(error) => send_json(&mut socket, &mut noise, EXTENSION_RESULT, &json!({"id":id,"ok":false,"error":error})).await,
                        }
                    }
                    EXTENSION_UPLOAD_ABORT if count == 5 => {
                        let id = u32::from_be_bytes(plain[1..5].try_into().unwrap());
                        let aborted = if extension_upload
                            .as_ref()
                            .is_some_and(|upload| upload.id == id)
                        {
                            let upload = extension_upload.take().unwrap();
                            let _ = tokio::fs::remove_dir_all(upload.root).await;
                            true
                        } else {
                            false
                        };
                        send_json(
                            &mut socket,
                            &mut noise,
                            EXTENSION_RESULT,
                            &json!({"id":id,"ok":aborted,"phase":"aborted","error":if aborted { "" } else { "No matching extension upload is active" }}),
                        ).await;
                    }
                    FILE_UPLOAD_BEGIN if count > 1 && count <= 16 * 1024 => {
                        let Ok(request) =
                            serde_json::from_slice::<PageFileUploadBegin>(&plain[1..count])
                        else {
                            send_json(
                                &mut socket,
                                &mut noise,
                                FILE_UPLOAD_RESULT,
                                &json!({"id":0,"ok":false,"error":"Invalid page upload manifest"}),
                            )
                            .await;
                            continue;
                        };
                        let chooser_matches =
                            pending_file_chooser.as_ref().is_some_and(|chooser| {
                                chooser.id == request.chooser_id
                                    && chooser.tab_id == request.tab_id
                                    && (chooser.multiple || request.files.len() == 1)
                            });
                        let Some(browser) = remote.as_ref() else {
                            send_json(&mut socket, &mut noise, FILE_UPLOAD_RESULT, &json!({"id":request.id,"ok":false,"error":"Start the remote browser first"})).await;
                            continue;
                        };
                        if request.id == 0
                            || !valid_remote_tab_id(&request.tab_id)
                            || browser.active_tab_id() != Some(request.tab_id.as_str())
                            || !chooser_matches
                            || page_file_upload.is_some()
                        {
                            send_json(&mut socket, &mut noise, FILE_UPLOAD_RESULT, &json!({"id":request.id,"ok":false,"error":"The page file chooser is no longer active"})).await;
                            continue;
                        }
                        let total_bytes = match validate_page_file_upload(&request.files) {
                            Ok(total_bytes) => total_bytes,
                            Err(error) => {
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    FILE_UPLOAD_RESULT,
                                    &json!({"id":request.id,"ok":false,"error":error}),
                                )
                                .await;
                                continue;
                            }
                        };
                        let staged_bytes =
                            browser.staged_upload_bytes.values().copied().sum::<usize>();
                        if staged_bytes
                            .checked_add(total_bytes)
                            .is_none_or(|size| size > MAX_REMOTE_STAGED_UPLOAD_BYTES)
                        {
                            send_json(&mut socket, &mut noise, FILE_UPLOAD_RESULT, &json!({"id":request.id,"ok":false,"error":"Remote page uploads are limited to 64 MiB per browser session"})).await;
                            continue;
                        }
                        match create_page_file_upload(
                            request.id,
                            request.tab_id,
                            request.chooser_id,
                            request.files,
                            total_bytes,
                            &browser._profile,
                        )
                        .await
                        {
                            Ok(upload) => {
                                page_file_upload = Some(upload);
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    FILE_UPLOAD_RESULT,
                                    &json!({"id":request.id,"ok":true,"phase":"ready"}),
                                )
                                .await;
                            }
                            Err(error) => {
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    FILE_UPLOAD_RESULT,
                                    &json!({"id":request.id,"ok":false,"error":error}),
                                )
                                .await
                            }
                        }
                    }
                    FILE_UPLOAD_CHUNK if count > 11 && count <= 11 + MAX_CHUNK_BYTES => {
                        let id = u32::from_be_bytes(plain[1..5].try_into().unwrap());
                        let file_index =
                            u16::from_be_bytes(plain[5..7].try_into().unwrap()) as usize;
                        let offset = u32::from_be_bytes(plain[7..11].try_into().unwrap()) as usize;
                        let Some(upload) =
                            page_file_upload.as_mut().filter(|upload| upload.id == id)
                        else {
                            continue;
                        };
                        let result =
                            write_page_file_chunk(upload, file_index, offset, &plain[11..count])
                                .await;
                        if let Err(error) = result {
                            if page_file_upload
                                .as_ref()
                                .is_some_and(|upload| upload.id == id)
                                && let Some(upload) = page_file_upload.take()
                            {
                                let _ = tokio::fs::remove_dir_all(upload.root).await;
                            }
                            send_json(
                                &mut socket,
                                &mut noise,
                                FILE_UPLOAD_RESULT,
                                &json!({"id":id,"ok":false,"error":error}),
                            )
                            .await;
                        }
                    }
                    FILE_UPLOAD_CHUNK => {
                        let id = if count >= 5 {
                            u32::from_be_bytes(plain[1..5].try_into().unwrap())
                        } else {
                            0
                        };
                        if page_file_upload
                            .as_ref()
                            .is_some_and(|upload| upload.id == id)
                            && let Some(upload) = page_file_upload.take()
                        {
                            let _ = tokio::fs::remove_dir_all(upload.root).await;
                            send_json(&mut socket, &mut noise, FILE_UPLOAD_RESULT, &json!({"id":id,"ok":false,"error":"Page upload chunk size is invalid"})).await;
                        }
                    }
                    FILE_UPLOAD_COMMIT if count == 5 => {
                        let id = u32::from_be_bytes(plain[1..5].try_into().unwrap());
                        let Some(upload) = page_file_upload.take() else {
                            send_json(
                                &mut socket,
                                &mut noise,
                                FILE_UPLOAD_RESULT,
                                &json!({"id":id,"ok":false,"error":"Page upload is incomplete"}),
                            )
                            .await;
                            continue;
                        };
                        let chooser = pending_file_chooser.as_ref();
                        let complete = upload.id == id
                            && upload.next_file == upload.files.len()
                            && upload.total_bytes
                                == upload.files.iter().map(|file| file.size).sum::<usize>()
                            && chooser.is_some_and(|chooser| {
                                chooser.id == upload.chooser_id && chooser.tab_id == upload.tab_id
                            });
                        if !complete {
                            let _ = tokio::fs::remove_dir_all(&upload.root).await;
                            send_json(&mut socket, &mut noise, FILE_UPLOAD_RESULT, &json!({"id":id,"ok":false,"error":"Page upload is incomplete or its chooser expired"})).await;
                            continue;
                        }
                        let tab_id = upload.tab_id.clone();
                        let backend_node_id = chooser.unwrap().backend_node_id;
                        let result = if let Some(browser) = remote.as_mut() {
                            browser
                                .set_page_file_input(&tab_id, backend_node_id, upload)
                                .await
                        } else {
                            let _ = tokio::fs::remove_dir_all(&upload.root).await;
                            Err("Remote browser is not started".to_owned())
                        };
                        match result {
                            Ok(()) => {
                                pending_file_chooser = None;
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    FILE_UPLOAD_RESULT,
                                    &json!({"id":id,"ok":true,"phase":"complete"}),
                                )
                                .await;
                            }
                            Err(error) => {
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    FILE_UPLOAD_RESULT,
                                    &json!({"id":id,"ok":false,"error":error}),
                                )
                                .await
                            }
                        }
                    }
                    FILE_UPLOAD_CANCEL if count > 1 && count <= 1024 => {
                        let Ok(request) =
                            serde_json::from_slice::<PageFileUploadCancel>(&plain[1..count])
                        else {
                            send_error(&mut socket, &mut noise, "Invalid page upload cancellation")
                                .await;
                            continue;
                        };
                        if page_file_upload.as_ref().is_some_and(|upload| {
                            (request.id == 0 || upload.id == request.id)
                                && upload.chooser_id == request.chooser_id
                                && upload.tab_id == request.tab_id
                        }) && let Some(upload) = page_file_upload.take()
                        {
                            let upload_id = upload.id;
                            let _ = tokio::fs::remove_dir_all(upload.root).await;
                            send_json(&mut socket, &mut noise, FILE_UPLOAD_RESULT, &json!({"id":upload_id,"ok":false,"error":"Page file selection was cancelled"})).await;
                        }
                        let cancelled = pending_file_chooser.as_ref().is_some_and(|chooser| {
                            chooser.id == request.chooser_id && chooser.tab_id == request.tab_id
                        });
                        if cancelled {
                            pending_file_chooser = None;
                            if let Some(browser) = remote.as_mut()
                                && browser.active_tab_id() == Some(request.tab_id.as_str())
                            {
                                let _ = browser
                                    .send_and_wait(
                                        "Page.setInterceptFileChooserDialog",
                                        json!({"enabled":true,"cancel":true}),
                                    )
                                    .await;
                            }
                        }
                    }
                    JAVASCRIPT_DIALOG_REPLY if count > 1 && count <= 8192 => {
                        let Ok(request) =
                            serde_json::from_slice::<JavascriptDialogReply>(&plain[1..count])
                        else {
                            send_error(&mut socket, &mut noise, "Invalid page dialog response")
                                .await;
                            continue;
                        };
                        let dialog_matches = pending_javascript_dialogs
                            .get(&request.tab_id)
                            .is_some_and(|dialog| dialog.id == request.id);
                        if request.id == 0
                            || !valid_remote_tab_id(&request.tab_id)
                            || request.prompt_text.len() > MAX_REMOTE_DIALOG_MESSAGE_BYTES
                            || request.prompt_text.contains('\0')
                            || !dialog_matches
                        {
                            send_json(
                                &mut socket,
                                &mut noise,
                                STATUS,
                                &json!({"type":"javascript-dialog-result","id":request.id,"tabId":request.tab_id,"ok":false,"message":"The page dialog is no longer active or the response is invalid"}),
                            )
                            .await;
                            continue;
                        }
                        let result = match remote.as_mut() {
                            Some(browser) => {
                                browser
                                    .handle_javascript_dialog_for_tab(
                                        &request.tab_id,
                                        request.accept,
                                        &request.prompt_text,
                                    )
                                    .await
                            }
                            None => Err("Remote browser is not started".to_owned()),
                        };
                        match result {
                            Ok(()) => {
                                pending_javascript_dialogs.remove(&request.tab_id);
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    STATUS,
                                    &json!({"type":"javascript-dialog-result","id":request.id,"tabId":request.tab_id,"ok":true}),
                                )
                                .await;
                            }
                            Err(error) => send_json(
                                &mut socket,
                                &mut noise,
                                STATUS,
                                &json!({"type":"javascript-dialog-result","id":request.id,"tabId":request.tab_id,"ok":false,"message":error}),
                            )
                            .await,
                        }
                    }
                    EXTENSION_REMOVE if count > 1 && count <= 2048 => {
                        let Ok(request) =
                            serde_json::from_slice::<ExtensionRemoveRequest>(&plain[1..count])
                        else {
                            send_json(&mut socket, &mut noise, EXTENSION_RESULT, &json!({"id":0,"ok":false,"error":"Invalid extension removal request"})).await;
                            continue;
                        };
                        let result = match remote.as_mut() {
                            Some(browser) => browser.remove_extension(&request.id).await,
                            None => Err("Remote browser is not started"),
                        };
                        match result {
                            Ok(()) => send_json(&mut socket, &mut noise, EXTENSION_RESULT, &json!({"id":request.request_id,"ok":true,"phase":"removed","extensionId":request.id})).await,
                            Err(error) => send_json(&mut socket, &mut noise, EXTENSION_RESULT, &json!({"id":request.request_id,"ok":false,"error":error})).await,
                        }
                    }
                    EXTENSION_ACTION if count > 1 && count <= 2048 => {
                        let Ok(request) =
                            serde_json::from_slice::<ExtensionActionRequest>(&plain[1..count])
                        else {
                            send_json(&mut socket, &mut noise, EXTENSION_RESULT, &json!({"id":0,"ok":false,"error":"Invalid extension action request"})).await;
                            continue;
                        };
                        let result = match remote.as_mut() {
                            Some(browser)
                                if request.request_id != 0
                                    && browser.active_tab_id() == Some(request.tab_id.as_str()) =>
                            {
                                browser
                                    .trigger_extension_action(
                                        &request.extension_id,
                                        &request.tab_id,
                                    )
                                    .await
                            }
                            Some(_) => Err("The selected remote page is no longer active"),
                            None => Err("Start the remote browser first"),
                        };
                        match result {
                            Ok(()) => send_json(&mut socket, &mut noise, EXTENSION_RESULT, &json!({"id":request.request_id,"ok":true,"phase":"action-triggered","extensionId":request.extension_id,"tabId":request.tab_id})).await,
                            Err(error) => send_json(&mut socket, &mut noise, EXTENSION_RESULT, &json!({"id":request.request_id,"ok":false,"error":error})).await,
                        }
                    }
                    SOURCES_LIST if count > 1 && count <= 1024 => {
                        let Ok(request) = serde_json::from_slice::<SourcesList>(&plain[1..count])
                        else {
                            send_json(
                                &mut socket,
                                &mut noise,
                                SOURCES_RESULT,
                                &json!({"id":0,"error":"Invalid source-list request"}),
                            )
                            .await;
                            continue;
                        };
                        let Some(browser) = remote.as_mut() else {
                            send_json(
                                &mut socket,
                                &mut noise,
                                SOURCES_RESULT,
                                &json!({"id":request.id,"tabId":request.tab_id,"error":"Remote browser is not started"}),
                            )
                            .await;
                            continue;
                        };
                        if request.id == 0
                            || !valid_remote_tab_id(&request.tab_id)
                            || browser.active_tab_id() != Some(request.tab_id.as_str())
                            || current_main_frame_id.is_empty()
                            || pending_sources.len() >= 8
                        {
                            send_json(&mut socket, &mut noise, SOURCES_RESULT, &json!({"id":request.id,"tabId":request.tab_id,"error":"Source request is invalid, stale, or busy"})).await;
                            continue;
                        }
                        match browser.send("Page.getResourceTree", json!({})).await {
                            Ok(command_id) => {
                                pending_sources.insert(
                                    command_id,
                                    PendingSourceRequest::List {
                                        request_id: request.id,
                                        tab_id: request.tab_id,
                                        frame_id: current_main_frame_id.clone(),
                                    },
                                );
                            }
                            Err(error) => {
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    SOURCES_RESULT,
                                    &json!({"id":request.id,"tabId":request.tab_id,"error":error}),
                                )
                                .await
                            }
                        }
                    }
                    SOURCE_CONTENT if count > 1 && count <= 4096 => {
                        let Ok(request) = serde_json::from_slice::<SourceContent>(&plain[1..count])
                        else {
                            send_json(
                                &mut socket,
                                &mut noise,
                                SOURCES_RESULT,
                                &json!({"id":0,"error":"Invalid source-content request"}),
                            )
                            .await;
                            continue;
                        };
                        let Some(browser) = remote.as_mut() else {
                            send_json(
                                &mut socket,
                                &mut noise,
                                SOURCES_RESULT,
                                &json!({"id":request.id,"tabId":request.tab_id,"error":"Remote browser is not started"}),
                            )
                            .await;
                            continue;
                        };
                        if !valid_remote_tab_id(&request.tab_id)
                            || browser.active_tab_id() != Some(request.tab_id.as_str())
                        {
                            send_json(&mut socket, &mut noise, SOURCES_RESULT, &json!({"id":request.id,"tabId":request.tab_id,"error":"The remote tab changed before source retrieval"})).await;
                            continue;
                        }
                        let Some(frame_id) = allowed_sources
                            .get(&request.url)
                            .filter(|frame| *frame == &current_main_frame_id)
                            .cloned()
                        else {
                            send_json(&mut socket, &mut noise, SOURCES_RESULT, &json!({"id":request.id,"tabId":request.tab_id,"error":"The requested source is not in the current page"})).await;
                            continue;
                        };
                        if request.id == 0 || request.url.len() > 2048 || pending_sources.len() >= 8
                        {
                            send_json(&mut socket, &mut noise, SOURCES_RESULT, &json!({"id":request.id,"tabId":request.tab_id,"error":"Source request is invalid or busy"})).await;
                            continue;
                        }
                        match browser
                            .send(
                                "Page.getResourceContent",
                                json!({"frameId":frame_id,"url":request.url}),
                            )
                            .await
                        {
                            Ok(command_id) => {
                                pending_sources.insert(
                                    command_id,
                                    PendingSourceRequest::Content {
                                        request_id: request.id,
                                        tab_id: request.tab_id,
                                        url: request.url,
                                        frame_id,
                                    },
                                );
                            }
                            Err(error) => {
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    SOURCES_RESULT,
                                    &json!({"id":request.id,"tabId":request.tab_id,"error":error}),
                                )
                                .await
                            }
                        }
                    }
                    NETWORK_BODY if count > 1 && count <= 1024 => {
                        let Ok(request) =
                            serde_json::from_slice::<NetworkBodyRequest>(&plain[1..count])
                        else {
                            send_json(
                                &mut socket,
                                &mut noise,
                                NETWORK_BODY_RESULT,
                                &json!({"id":0,"error":"Invalid response-body request"}),
                            )
                            .await;
                            continue;
                        };
                        if request.id == 0
                            || request.request_id.is_empty()
                            || request.request_id.len() > 256
                            || !valid_remote_tab_id(&request.tab_id)
                            || pending_network_bodies.len() >= 4
                            || remote_network_requests
                                .get(&request.tab_id)
                                .is_none_or(|requests| !requests.contains(&request.request_id))
                            || remote.as_ref().is_none_or(|browser| {
                                browser.active_tab_id() != Some(request.tab_id.as_str())
                            })
                        {
                            send_json(&mut socket, &mut noise, NETWORK_BODY_RESULT, &json!({"id":request.id,"tabId":request.tab_id,"error":"Request is not available in this browser session"})).await;
                            continue;
                        }
                        let Some(browser) = remote.as_mut() else {
                            send_json(
                                &mut socket,
                                &mut noise,
                                NETWORK_BODY_RESULT,
                                &json!({"id":request.id,"tabId":request.tab_id,"error":"Remote browser is not started"}),
                            )
                            .await;
                            continue;
                        };
                        match browser
                            .send(
                                "Network.getResponseBody",
                                json!({"requestId":request.request_id}),
                            )
                            .await
                        {
                            Ok(command_id) => {
                                pending_network_bodies.insert(
                                    command_id,
                                    PendingNetworkBody {
                                        request_id: request.id,
                                        tab_id: request.tab_id,
                                    },
                                );
                            }
                            Err(error) => {
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    NETWORK_BODY_RESULT,
                                    &json!({"id":request.id,"tabId":request.tab_id,"error":error}),
                                )
                                .await
                            }
                        }
                    }
                    SITE_DATA_COOKIES | SITE_DATA_CLEAR if count > 1 && count <= 2048 => {
                        let operation = plain[0];
                        let Ok(request) =
                            serde_json::from_slice::<SiteDataRequest>(&plain[1..count])
                        else {
                            send_json(
                                &mut socket,
                                &mut noise,
                                SITE_DATA_RESULT,
                                &json!({"id":0,"error":"Invalid site-data request"}),
                            )
                            .await;
                            continue;
                        };
                        let Some(browser) = remote.as_mut() else {
                            send_json(
                                &mut socket,
                                &mut noise,
                                SITE_DATA_RESULT,
                                &json!({"id":request.id,"tabId":request.tab_id,"error":"Remote browser is not started"}),
                            )
                            .await;
                            continue;
                        };
                        if request.id == 0
                            || pending_site_data.len() >= 8
                            || !valid_remote_tab_id(&request.tab_id)
                            || browser.active_tab_id() != Some(request.tab_id.as_str())
                            || request.origin.len() > 512
                            || browser
                                .page_url_for_tab(&request.tab_id)
                                .and_then(|url| validated_origin(url))
                                .as_deref()
                                != Some(request.origin.as_str())
                        {
                            send_json(&mut socket, &mut noise, SITE_DATA_RESULT, &json!({"id":request.id,"tabId":request.tab_id,"error":"Site-data operation is invalid, stale, or outside the tab origin"})).await;
                            continue;
                        }
                        let (method, params, pending) = if operation == SITE_DATA_COOKIES {
                            (
                                "Network.getCookies",
                                json!({"urls":[browser.page_url_for_tab(&request.tab_id).unwrap_or_default()]}),
                                PendingSiteDataRequest::Cookies {
                                    request_id: request.id,
                                    tab_id: request.tab_id.clone(),
                                },
                            )
                        } else {
                            (
                                "Storage.clearDataForOrigin",
                                json!({"origin":request.origin,"storageTypes":"all"}),
                                PendingSiteDataRequest::Clear {
                                    request_id: request.id,
                                    tab_id: request.tab_id.clone(),
                                },
                            )
                        };
                        match browser.send(method, params).await {
                            Ok(command_id) => {
                                pending_site_data.insert(command_id, pending);
                            }
                            Err(error) => {
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    SITE_DATA_RESULT,
                                    &json!({"id":request.id,"tabId":request.tab_id,"error":error}),
                                )
                                .await
                            }
                        }
                    }
                    PRIVACY if count > 1 && count <= 1024 => {
                        let Ok(settings) =
                            serde_json::from_slice::<PrivacySettings>(&plain[1..count])
                        else {
                            send_error(&mut socket, &mut noise, "Invalid browser privacy settings")
                                .await;
                            continue;
                        };
                        if let Some(browser) = remote.as_mut() {
                            browser.privacy = settings.into();
                        }
                    }
                    FRAME_ACK if count == 5 => {
                        let sequence = u32::from_be_bytes(plain[1..5].try_into().unwrap());
                        if let (Some(browser), Some((waiting, cdp_frame))) =
                            (remote.as_mut(), frame_waiting.take())
                        {
                            if sequence == waiting {
                                browser.ack_frame(cdp_frame).await;
                            } else {
                                frame_waiting = Some((waiting, cdp_frame));
                            }
                        }
                    }
                    DOWNLOAD_CANCEL if count == 5 => {
                        let id = u32::from_be_bytes(plain[1..5].try_into().unwrap());
                        let guid = remote_downloads
                            .get(&id)
                            .map(|download| download.guid.clone());
                        if let (Some(guid), Some(browser)) = (guid, remote.as_mut()) {
                            if let Err(error) = browser.cancel_download(&guid).await {
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    STATUS,
                                    &json!({"type":"download-failed","id":id,"message":error}),
                                )
                                .await;
                                cleanup_download_files(&browser.download_dir, &guid).await;
                                remote_downloads.remove(&id);
                                remote_download_ids.remove(&guid);
                            } else {
                                cleanup_download_files(&browser.download_dir, &guid).await;
                            }
                        }
                    }
                    STOP if count == 1 => break,
                    _ => {
                        send_error(&mut socket, &mut noise, "Unknown remote browser message").await
                    }
                }
            }
            SessionEvent::Client(_) => break,
            SessionEvent::Cdp(Some(event)) => {
                let event_session_id = event.get("sessionId").and_then(Value::as_str);
                let method = event.get("method").and_then(Value::as_str).unwrap_or("");
                if method == "Target.targetCreated" {
                    let info = &event["params"]["targetInfo"];
                    let target_id = info.get("targetId").and_then(Value::as_str).unwrap_or("");
                    let opener_id = info.get("openerId").and_then(Value::as_str).unwrap_or("");
                    let target_type = info.get("type").and_then(Value::as_str).unwrap_or("");
                    let already_tracked = remote.as_ref().is_some_and(|browser| {
                        target_id == browser.initial_target_id
                            || browser.tab_id_for_target(target_id).is_some()
                    });
                    let url = info.get("url").and_then(Value::as_str).unwrap_or("");
                    let extension_popup_id = (target_type == "page")
                        .then(|| {
                            remote
                                .as_mut()
                                .and_then(|browser| browser.consume_extension_popup_target(url))
                        })
                        .flatten();
                    let opened_by_page = remote
                        .as_ref()
                        .is_some_and(|browser| browser.tab_id_for_target(opener_id).is_some());
                    if !already_tracked
                        && target_type == "page"
                        && !opened_by_page
                        && extension_popup_id.is_none()
                    {
                        if let Some(browser) = remote.as_mut() {
                            let _ = browser
                                .send_root_and_wait(
                                    "Target.closeTarget",
                                    json!({"targetId":target_id}),
                                )
                                .await;
                        }
                        continue;
                    }
                    if !already_tracked
                        && target_type == "page"
                        && (opened_by_page || extension_popup_id.is_some())
                    {
                        let url = if url.is_empty() { "about:blank" } else { url };
                        let result = if let Some(browser) = remote.as_mut() {
                            if let Some(extension_id) = extension_popup_id.as_deref() {
                                browser
                                    .attach_extension_popup(target_id, url, extension_id)
                                    .await
                            } else {
                                browser.attach_popup(target_id, url).await
                            }
                        } else {
                            Err("Full browser session is not available".into())
                        };
                        match result {
                            Ok((tab_id, url)) => {
                                let title = info
                                    .get("title")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .chars()
                                    .take(256)
                                    .collect::<String>();
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    STATUS,
                                    &json!({"type":"popup-open","tabId":tab_id,"url":url,"title":title,"extensionPopup":extension_popup_id.is_some(),"extensionId":extension_popup_id}),
                                )
                                .await;
                            }
                            Err(message) => {
                                if let Some(browser) = remote.as_mut() {
                                    let _ = browser
                                        .send_root_and_wait(
                                            "Target.closeTarget",
                                            json!({"targetId":target_id}),
                                        )
                                        .await;
                                }
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    STATUS,
                                    &json!({"type":"popup-blocked","message":message}),
                                )
                                .await;
                            }
                        }
                    }
                    continue;
                }
                if method == "Target.targetDestroyed" {
                    let target_id = event
                        .pointer("/params/targetId")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if let Some(browser) = remote.as_mut()
                        && let Some((tab_id, was_active)) =
                            browser.remove_destroyed_target(target_id)
                    {
                        browser.clear_staged_uploads(&tab_id).await;
                        page_devtools.remove(&tab_id);
                        remote_network_requests.remove(&tab_id);
                        if was_active {
                            frame_waiting = None;
                            current_remote_url.clear();
                            current_main_frame_id.clear();
                            allowed_sources.clear();
                            debugger_breakpoints.clear();
                            debugger_call_frames.clear();
                            debugger_remote_objects.clear();
                            debugger_scopes.clear();
                            debugger_paused_event = None;
                        }
                        if pending_file_chooser
                            .as_ref()
                            .is_some_and(|value| value.tab_id == tab_id)
                        {
                            pending_file_chooser = None;
                        }
                        if page_file_upload
                            .as_ref()
                            .is_some_and(|value| value.tab_id == tab_id)
                            && let Some(upload) = page_file_upload.take()
                        {
                            let _ = tokio::fs::remove_dir_all(upload.root).await;
                        }
                        if let Some(dialog) = pending_javascript_dialogs.remove(&tab_id) {
                            send_json(
                                &mut socket,
                                &mut noise,
                                STATUS,
                                &json!({"type":"javascript-dialog-closed","id":dialog.id,"tabId":dialog.tab_id}),
                            )
                            .await;
                        }
                        send_json(
                            &mut socket,
                            &mut noise,
                            STATUS,
                            &json!({"type":"tab-closed","tabId":tab_id}),
                        )
                        .await;
                    }
                    continue;
                }
                if method == "Target.targetInfoChanged" {
                    let info = &event["params"]["targetInfo"];
                    let target_id = info.get("targetId").and_then(Value::as_str).unwrap_or("");
                    if let Some(tab_id) = remote
                        .as_ref()
                        .and_then(|browser| browser.tab_id_for_target(target_id))
                    {
                        let title = info
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .chars()
                            .take(256)
                            .collect::<String>();
                        let url = info
                            .get("url")
                            .and_then(Value::as_str)
                            .and_then(|raw| validated_popup_url(raw).ok());
                        send_json(
                            &mut socket,
                            &mut noise,
                            STATUS,
                            &json!({"type":"tab-info","tabId":tab_id,"title":title,"url":url}),
                        )
                        .await;
                    }
                    continue;
                }
                let active_tab_id = remote.as_ref().map_or_else(String::new, |browser| {
                    event_session_id
                        .and_then(|session_id| browser.tab_id_for_session(session_id))
                        .or_else(|| browser.active_tab_id())
                        .unwrap_or("")
                        .to_owned()
                });
                if let Some(command_id) =
                    event.get("id").and_then(Value::as_u64).map(|id| id as u32)
                {
                    if let Some(pending) = pending_network_bodies.remove(&command_id) {
                        match remote_network_body(&event) {
                            Ok((text, truncated)) => {
                                send_network_body_chunks(
                                    &mut socket,
                                    &mut noise,
                                    pending.request_id,
                                    &pending.tab_id,
                                    &text,
                                    truncated,
                                )
                                .await
                            }
                            Err(error) => {
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    NETWORK_BODY_RESULT,
                                    &json!({"id":pending.request_id,"tabId":pending.tab_id,"error":error}),
                                )
                                .await
                            }
                        }
                        continue;
                    }
                    if let Some(pending) = pending_site_data.remove(&command_id) {
                        match pending {
                            PendingSiteDataRequest::Cookies { request_id, tab_id } => {
                                match remote_cookies(&event) {
                                    Ok(cookies) => send_json(
                                        &mut socket,
                                        &mut noise,
                                        SITE_DATA_RESULT,
                                        &json!({"id":request_id,"tabId":tab_id,"cookies":cookies}),
                                    )
                                    .await,
                                    Err(error) => {
                                        send_json(
                                            &mut socket,
                                            &mut noise,
                                            SITE_DATA_RESULT,
                                            &json!({"id":request_id,"tabId":tab_id,"error":error}),
                                        )
                                        .await
                                    }
                                }
                            }
                            PendingSiteDataRequest::Clear { request_id, tab_id } => {
                                if event.get("error").is_some() {
                                    send_json(
                                        &mut socket,
                                        &mut noise,
                                        SITE_DATA_RESULT,
                                        &json!({"id":request_id,"tabId":tab_id,"error":"Chromium could not clear site data"}),
                                    )
                                    .await;
                                } else {
                                    send_json(
                                        &mut socket,
                                        &mut noise,
                                        SITE_DATA_RESULT,
                                        &json!({"id":request_id,"tabId":tab_id,"ok":true}),
                                    )
                                    .await;
                                }
                            }
                        }
                        continue;
                    }
                    if let Some(pending) = pending_sources.remove(&command_id) {
                        match pending {
                            PendingSourceRequest::List {
                                request_id,
                                tab_id,
                                frame_id,
                            } => {
                                let current_frame = remote
                                    .as_ref()
                                    .and_then(|browser| browser.main_frame_id_for_tab(&tab_id));
                                if current_frame != Some(frame_id.as_str()) {
                                    send_json(&mut socket, &mut noise, SOURCES_RESULT, &json!({"id":request_id,"tabId":tab_id,"error":"The page navigated during source enumeration"})).await;
                                } else {
                                    match remote_source_list(&event, &frame_id) {
                                        Ok((sources, allowed)) => {
                                            if remote
                                                .as_ref()
                                                .and_then(RemoteBrowser::active_tab_id)
                                                == Some(tab_id.as_str())
                                            {
                                                allowed_sources = allowed;
                                            } else {
                                                page_devtools
                                                    .entry(tab_id.clone())
                                                    .or_default()
                                                    .allowed_sources = allowed;
                                            }
                                            send_json(
                                                &mut socket,
                                                &mut noise,
                                                SOURCES_RESULT,
                                                &json!({"id":request_id,"tabId":tab_id,"sources":sources}),
                                            )
                                            .await;
                                        }
                                        Err(error) => send_json(
                                            &mut socket,
                                            &mut noise,
                                            SOURCES_RESULT,
                                            &json!({"id":request_id,"tabId":tab_id,"error":error}),
                                        )
                                        .await,
                                    }
                                }
                            }
                            PendingSourceRequest::Content {
                                request_id,
                                tab_id,
                                url,
                                frame_id,
                            } => {
                                let current_frame = remote
                                    .as_ref()
                                    .and_then(|browser| browser.main_frame_id_for_tab(&tab_id));
                                let allowed_frame =
                                    if remote.as_ref().and_then(RemoteBrowser::active_tab_id)
                                        == Some(tab_id.as_str())
                                    {
                                        allowed_sources.get(&url)
                                    } else {
                                        page_devtools
                                            .get(&tab_id)
                                            .and_then(|state| state.allowed_sources.get(&url))
                                    };
                                if current_frame != Some(frame_id.as_str())
                                    || allowed_frame != Some(&frame_id)
                                {
                                    send_json(&mut socket, &mut noise, SOURCES_RESULT, &json!({"id":request_id,"tabId":tab_id,"error":"The page navigated during source retrieval"})).await;
                                } else {
                                    match remote_source_content(&event) {
                                        Ok((text, truncated)) => {
                                            send_source_chunks(
                                                &mut socket,
                                                &mut noise,
                                                request_id,
                                                &tab_id,
                                                &url,
                                                &text,
                                                truncated,
                                            )
                                            .await
                                        }
                                        Err(error) => send_json(
                                            &mut socket,
                                            &mut noise,
                                            SOURCES_RESULT,
                                            &json!({"id":request_id,"tabId":tab_id,"error":error}),
                                        )
                                        .await,
                                    }
                                }
                            }
                        }
                        continue;
                    }
                    if let Some(pending) = pending_evaluations.remove(&command_id) {
                        let (result, exception) = evaluation_result(&event);
                        let remote_object = evaluation_remote_object(&event);
                        let is_active_tab = remote.as_ref().and_then(RemoteBrowser::active_tab_id)
                            == Some(pending.tab_id.as_str());
                        if let Some(object_id) = remote_object
                            .as_ref()
                            .and_then(|value| value.get("objectId"))
                            .and_then(Value::as_str)
                            && object_id.len() <= 512
                        {
                            if is_active_tab {
                                if debugger_remote_objects.len() < 256 {
                                    debugger_remote_objects.insert(object_id.to_owned());
                                }
                            } else {
                                let state =
                                    page_devtools.entry(pending.tab_id.clone()).or_default();
                                if state.remote_objects.len() < 256 {
                                    state.remote_objects.insert(object_id.to_owned());
                                }
                            }
                        }
                        if pending.request_id == 0 {
                            let page_url = remote
                                .as_ref()
                                .and_then(|browser| browser.page_url_for_tab(&pending.tab_id))
                                .unwrap_or("");
                            send_json(
                                &mut socket,
                                &mut noise,
                                STATUS,
                                &json!({
                                    "type":"title",
                                    "tabId":pending.tab_id,
                                    "title":result.as_str().unwrap_or(""),
                                    "url":page_url
                                }),
                            )
                            .await;
                        } else {
                            send_json(
                                &mut socket,
                                &mut noise,
                                EVALUATE_RESULT,
                                &json!({
                                    "id":pending.request_id,"tabId":pending.tab_id,"result":result,"exception":exception,"remoteObject":remote_object
                                }),
                            )
                            .await;
                        }
                    }
                    continue;
                }
                let is_active_page_event = remote.as_ref().is_some_and(|browser| {
                    event_session_id.is_some_and(|session_id| {
                        browser.active_tab_id() == browser.tab_id_for_session(session_id)
                    })
                });
                if method == "Page.javascriptDialogOpening" {
                    let Some(tab_id) = remote.as_ref().and_then(|browser| {
                        event_session_id.and_then(|id| browser.tab_id_for_session(id))
                    }) else {
                        continue;
                    };
                    let dialog_type = event
                        .pointer("/params/type")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if !matches!(dialog_type, "alert" | "confirm" | "prompt" | "beforeunload") {
                        continue;
                    }
                    next_javascript_dialog_id = next_javascript_dialog_id.wrapping_add(1).max(1);
                    let id = next_javascript_dialog_id;
                    let message = event
                        .pointer("/params/message")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .chars()
                        .take(1024)
                        .collect::<String>();
                    let default_prompt = event
                        .pointer("/params/defaultPrompt")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .chars()
                        .take(1024)
                        .collect::<String>();
                    pending_javascript_dialogs.insert(
                        tab_id.to_owned(),
                        PendingJavascriptDialog {
                            id,
                            tab_id: tab_id.to_owned(),
                        },
                    );
                    send_json(
                        &mut socket,
                        &mut noise,
                        STATUS,
                        &json!({"type":"javascript-dialog","id":id,"tabId":tab_id,"dialogType":dialog_type,"message":message,"defaultPrompt":default_prompt}),
                    )
                    .await;
                    continue;
                }
                if method == "Page.javascriptDialogClosed" {
                    if let Some(tab_id) = remote.as_ref().and_then(|browser| {
                        event_session_id.and_then(|id| browser.tab_id_for_session(id))
                    }) {
                        let dialog = pending_javascript_dialogs.remove(tab_id);
                        if let Some(dialog) = dialog {
                            send_json(
                                &mut socket,
                                &mut noise,
                                STATUS,
                                &json!({"type":"javascript-dialog-closed","id":dialog.id,"tabId":dialog.tab_id}),
                            )
                            .await;
                        }
                    }
                    continue;
                }
                if method == "Page.navigatedWithinDocument" {
                    let frame_id = event
                        .pointer("/params/frameId")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let url = event
                        .pointer("/params/url")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let is_main_frame = remote
                        .as_ref()
                        .and_then(|browser| browser.main_frame_id_for_tab(&active_tab_id))
                        == Some(frame_id);
                    if is_main_frame && let Some(browser) = remote.as_mut() {
                        browser.record_url_for_tab(&active_tab_id, url);
                        match browser.navigation_history_for_tab(&active_tab_id).await {
                            Ok(mut history) => {
                                history["type"] = json!("history");
                                history["tabId"] = json!(active_tab_id);
                                send_json(&mut socket, &mut noise, STATUS, &history).await;
                            }
                            Err(message) => send_json(
                                &mut socket,
                                &mut noise,
                                STATUS,
                                &json!({"type":"history-error","tabId":active_tab_id,"message":message}),
                            )
                            .await,
                        }
                    }
                    continue;
                }
                if method == "Fetch.requestPaused" {
                    let Some(session_id) = event_session_id else {
                        continue;
                    };
                    let Some((tab_id, page_url, main_frame_id)) = remote
                        .as_ref()
                        .and_then(|browser| browser.page_context_for_session(session_id))
                    else {
                        if let Some(browser) = remote.as_mut() {
                            browser
                                .fail_paused_request_for_session(session_id, &event)
                                .await;
                        }
                        continue;
                    };
                    let blocked = if let Some(browser) = remote.as_mut() {
                        let previous_session =
                            std::mem::replace(&mut browser.session_id, session_id.to_owned());
                        let result = browser
                            .continue_or_reject_request(&event, &page_url, &main_frame_id)
                            .await;
                        browser.session_id = previous_session;
                        result
                    } else {
                        None
                    };
                    if let Some((network_id, url, reason)) = blocked {
                        send_json(
                            &mut socket,
                            &mut noise,
                            CDP_EVENT,
                            &json!({
                                "tabId":tab_id,
                                "method":"Eya.requestBlocked",
                                "params":{"requestId":network_id,"url":url,"reason":reason}
                            }),
                        )
                        .await;
                    }
                    continue;
                }
                if method == "Page.frameNavigated"
                    && let Some(session_id) = event_session_id
                    && event.pointer("/params/frame/parentId").is_none()
                {
                    let frame = &event["params"]["frame"];
                    let url = frame.get("url").and_then(Value::as_str).unwrap_or("");
                    let frame_id = frame.get("id").and_then(Value::as_str).unwrap_or("");
                    if let Some(dialog) = pending_javascript_dialogs.remove(&active_tab_id) {
                        send_json(
                            &mut socket,
                            &mut noise,
                            STATUS,
                            &json!({"type":"javascript-dialog-closed","id":dialog.id,"tabId":dialog.tab_id}),
                        )
                        .await;
                    }
                    if pending_file_chooser
                        .as_ref()
                        .is_some_and(|chooser| chooser.tab_id == active_tab_id)
                    {
                        pending_file_chooser = None;
                    }
                    if page_file_upload
                        .as_ref()
                        .is_some_and(|upload| upload.tab_id == active_tab_id)
                        && let Some(upload) = page_file_upload.take()
                    {
                        let _ = tokio::fs::remove_dir_all(upload.root).await;
                        send_json(&mut socket, &mut noise, FILE_UPLOAD_RESULT, &json!({"id":upload.id,"ok":false,"error":"Page navigated during file upload"})).await;
                    }
                    if let Some(browser) = remote.as_mut() {
                        browser.clear_staged_uploads(&active_tab_id).await;
                        browser.record_frame_for_session(session_id, url, frame_id);
                    }
                    if !is_active_page_event {
                        if let Some(state) = page_devtools.get_mut(&active_tab_id) {
                            state.allowed_sources.clear();
                            state.call_frames.clear();
                            state.remote_objects.clear();
                            state.scopes.clear();
                            state.paused_event = None;
                        }
                        continue;
                    }
                }
                if method == "Page.screencastFrame" && !is_active_page_event {
                    if let (Some(session_id), Some(frame_id), Some(browser)) = (
                        event_session_id,
                        event
                            .pointer("/params/sessionId")
                            .and_then(Value::as_u64)
                            .map(|value| value as u32),
                        remote.as_mut(),
                    ) {
                        browser.ack_frame_for_session(session_id, frame_id).await;
                    }
                    continue;
                }
                if event_session_id.is_some() && !is_active_page_event {
                    if let Some(state) = page_devtools.get_mut(&active_tab_id) {
                        if method == "Debugger.paused" || method == "Debugger.resumed" {
                            update_remote_page_debugger_event(state, &event);
                        }
                    }
                    continue;
                }
                if method == "Page.fileChooserOpened" {
                    let Some(browser) = remote.as_ref() else {
                        continue;
                    };
                    let Some(backend_node_id) = event
                        .pointer("/params/backendNodeId")
                        .and_then(Value::as_i64)
                        .filter(|id| *id > 0)
                    else {
                        continue;
                    };
                    let mode = event
                        .pointer("/params/mode")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if !matches!(mode, "selectSingle" | "selectMultiple")
                        || browser.active_tab_id() != Some(active_tab_id.as_str())
                    {
                        continue;
                    }
                    next_file_chooser_id = next_file_chooser_id.wrapping_add(1).max(1);
                    let chooser = PendingPageFileChooser {
                        id: next_file_chooser_id,
                        tab_id: active_tab_id.clone(),
                        backend_node_id,
                        multiple: mode == "selectMultiple",
                    };
                    send_json(
                        &mut socket,
                        &mut noise,
                        STATUS,
                        &json!({"type":"file-chooser","id":chooser.id,"tabId":chooser.tab_id,"multiple":chooser.multiple}),
                    )
                    .await;
                    pending_file_chooser = Some(chooser);
                    continue;
                }
                if method == "Browser.downloadWillBegin" {
                    let params = &event["params"];
                    let Some(guid) = params.get("guid").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(url) = params.get("url").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(browser) = remote.as_mut() else {
                        continue;
                    };
                    if !browser.downloads_enabled || !valid_download_guid(guid) || url.len() > 8192
                    {
                        let _ = browser.cancel_download(guid).await;
                        continue;
                    }
                    if remote_downloads.len() >= MAX_REMOTE_DOWNLOADS {
                        let _ = browser.cancel_download(guid).await;
                        continue;
                    }
                    next_remote_download_id = next_remote_download_id.wrapping_add(1).max(1);
                    let id = next_remote_download_id;
                    let filename = params
                        .get("suggestedFilename")
                        .and_then(Value::as_str)
                        .unwrap_or("download");
                    let filename: String = filename.chars().take(180).collect();
                    remote_downloads.insert(
                        id,
                        RemoteDownload {
                            guid: guid.to_owned(),
                            filename: filename.clone(),
                        },
                    );
                    remote_download_ids.insert(guid.to_owned(), id);
                    send_json(
                        &mut socket,
                        &mut noise,
                        STATUS,
                        &json!({
                            "type":"download-start","id":id,"url":url,"filename":filename
                        }),
                    )
                    .await;
                    continue;
                }
                if method == "Browser.downloadProgress" {
                    let params = &event["params"];
                    let Some(guid) = params.get("guid").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(id) = remote_download_ids.get(guid).copied() else {
                        continue;
                    };
                    let received = params
                        .get("receivedBytes")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    let total = params
                        .get("totalBytes")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    if received > MAX_REMOTE_DOWNLOAD_BYTES || total > MAX_REMOTE_DOWNLOAD_BYTES {
                        if let Some(browser) = remote.as_mut() {
                            let _ = browser.cancel_download(guid).await;
                            cleanup_download_files(&browser.download_dir, guid).await;
                        }
                        send_json(&mut socket, &mut noise, STATUS, &json!({"type":"download-failed","id":id,"message":"Download exceeds the 64 MiB limit"})).await;
                        remote_downloads.remove(&id);
                        remote_download_ids.remove(guid);
                        continue;
                    }
                    let state = params.get("state").and_then(Value::as_str).unwrap_or("");
                    if state == "inProgress" {
                        send_json(&mut socket, &mut noise, STATUS, &json!({"type":"download-progress","id":id,"receivedBytes":received,"totalBytes":total})).await;
                    } else if state == "canceled" {
                        send_json(
                            &mut socket,
                            &mut noise,
                            STATUS,
                            &json!({"type":"download-cancelled","id":id}),
                        )
                        .await;
                        if let Some(browser) = remote.as_ref() {
                            cleanup_download_files(&browser.download_dir, guid).await;
                        }
                        remote_downloads.remove(&id);
                        remote_download_ids.remove(guid);
                    } else if state == "completed" {
                        let Some(browser) = remote.as_ref() else {
                            continue;
                        };
                        send_json(
                            &mut socket,
                            &mut noise,
                            STATUS,
                            &json!({"type":"download-transfer","id":id}),
                        )
                        .await;
                        let path = browser.download_dir.join(guid);
                        let filename = remote_downloads
                            .get(&id)
                            .map(|download| download.filename.clone())
                            .unwrap_or_else(|| "download".into());
                        match send_download_file(&mut socket, &mut noise, id, &filename, &path)
                            .await
                        {
                            Ok(()) => {}
                            Err(error) => {
                                send_json(
                                    &mut socket,
                                    &mut noise,
                                    STATUS,
                                    &json!({"type":"download-failed","id":id,"message":error}),
                                )
                                .await
                            }
                        }
                        let _ = tokio::fs::remove_file(path).await;
                        remote_downloads.remove(&id);
                        remote_download_ids.remove(guid);
                    }
                    continue;
                }
                if method == "Network.requestWillBeSent"
                    && let Some(request_id) =
                        event.pointer("/params/requestId").and_then(Value::as_str)
                    && !request_id.is_empty()
                    && request_id.len() <= 256
                {
                    let requests = remote_network_requests
                        .entry(active_tab_id.clone())
                        .or_default();
                    requests.retain(|existing| existing != request_id);
                    requests.push_back(request_id.to_owned());
                    while requests.len() > MAX_REMOTE_NETWORK_REQUESTS {
                        requests.pop_front();
                    }
                }
                if method == "Debugger.paused" {
                    debugger_paused_event = Some(event.clone());
                    debugger_call_frames.clear();
                    debugger_scopes.clear();
                    if let Some(frames) = event
                        .pointer("/params/callFrames")
                        .and_then(Value::as_array)
                    {
                        debugger_call_frames.extend(
                            frames
                                .iter()
                                .filter_map(|frame| {
                                    frame.get("callFrameId").and_then(Value::as_str)
                                })
                                .filter(|id| !id.is_empty() && id.len() <= 256)
                                .map(str::to_owned),
                        );
                        for frame in frames.iter().take(32) {
                            let Some(frame_id) = frame.get("callFrameId").and_then(Value::as_str)
                            else {
                                continue;
                            };
                            if !debugger_call_frames.contains(frame_id) {
                                continue;
                            }
                            debugger_scopes
                                .insert(frame_id.to_owned(), compact_debugger_scopes(frame));
                        }
                    }
                } else if method == "Debugger.resumed" || method == "Page.frameNavigated" {
                    if method == "Debugger.resumed"
                        || event.pointer("/params/frame/parentId").is_none()
                    {
                        if method == "Debugger.resumed" {
                            debugger_paused_event = None;
                        }
                        debugger_call_frames.clear();
                        debugger_scopes.clear();
                        if method == "Page.frameNavigated" {
                            debugger_remote_objects.clear();
                        }
                    }
                }
                if method == "Page.screencastFrame" {
                    if frame_waiting.is_some() {
                        continue;
                    }
                    let params = &event["params"];
                    let Some(encoded) = params.get("data").and_then(Value::as_str) else {
                        continue;
                    };
                    let Ok(frame) = BASE64.decode(encoded) else {
                        continue;
                    };
                    if frame.is_empty() || frame.len() > MAX_FRAME_BYTES {
                        send_error(
                            &mut socket,
                            &mut noise,
                            "Remote browser frame exceeded the size limit",
                        )
                        .await;
                        continue;
                    }
                    let cdp_frame =
                        params.get("sessionId").and_then(Value::as_u64).unwrap_or(0) as u32;
                    let metadata = &params["metadata"];
                    let width = metadata
                        .get("deviceWidth")
                        .and_then(Value::as_u64)
                        .unwrap_or(DEFAULT_WIDTH as u64) as u32;
                    let height = metadata
                        .get("deviceHeight")
                        .and_then(Value::as_u64)
                        .unwrap_or(DEFAULT_HEIGHT as u64) as u32;
                    next_frame_sequence = next_frame_sequence.wrapping_add(1).max(1);
                    let chunks = frame.len().div_ceil(MAX_CHUNK_BYTES);
                    send_json(
                        &mut socket,
                        &mut noise,
                        FRAME_START,
                        &json!({
                            "seq":next_frame_sequence, "tabId":active_tab_id, "width":width, "height":height,
                            "bytes":frame.len(), "chunks":chunks
                        }),
                    )
                    .await;
                    let mut sent_all = true;
                    for (index, part) in frame.chunks(MAX_CHUNK_BYTES).enumerate() {
                        let mut message = Vec::with_capacity(7 + part.len());
                        message.push(FRAME_CHUNK);
                        message.extend_from_slice(&next_frame_sequence.to_be_bytes());
                        message.extend_from_slice(&(index as u16).to_be_bytes());
                        message.extend_from_slice(part);
                        if !send_encrypted(&mut socket, &mut noise, &message).await {
                            sent_all = false;
                            break;
                        }
                    }
                    if !sent_all {
                        break;
                    }
                    frame_waiting = Some((next_frame_sequence, cdp_frame));
                } else {
                    if method == "Page.frameNavigated" {
                        let frame = &event["params"]["frame"];
                        if frame.get("parentId").is_none()
                            && let Some(url) = frame.get("url").and_then(Value::as_str)
                        {
                            current_remote_url = url.to_owned();
                            current_main_frame_id = frame
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned();
                            if let Some(browser) = remote.as_mut() {
                                browser
                                    .record_main_frame(&current_remote_url, &current_main_frame_id);
                            }
                            allowed_sources.clear();
                            debugger_call_frames.clear();
                            debugger_remote_objects.clear();
                            debugger_scopes.clear();
                            debugger_paused_event = None;
                            send_json(
                                &mut socket,
                                &mut noise,
                                STATUS,
                                &json!({"type":"navigating", "tabId":active_tab_id, "url":url}),
                            )
                            .await;
                        }
                    }
                    if method == "Page.frameNavigated"
                        && let Some(browser) = remote.as_mut()
                        && let Ok(mut history) =
                            browser.navigation_history_for_tab(&active_tab_id).await
                    {
                        history["type"] = json!("history");
                        history["tabId"] = json!(active_tab_id);
                        send_json(&mut socket, &mut noise, STATUS, &history).await;
                    }
                    if method == "Page.loadEventFired"
                        && let Some(browser) = remote.as_mut()
                        && let Ok(command_id) = browser.evaluate("document.title").await
                    {
                        pending_evaluations.insert(
                            command_id,
                            PendingEvaluation {
                                request_id: 0,
                                tab_id: active_tab_id.clone(),
                            },
                        );
                    }
                    if is_debug_event(&event) {
                        send_json(
                            &mut socket,
                            &mut noise,
                            CDP_EVENT,
                            &json!({
                                "tabId":active_tab_id,
                                "method":method,
                                "params":event.get("params").cloned().unwrap_or(Value::Null)
                            }),
                        )
                        .await;
                    }
                }
            }
            SessionEvent::Cdp(None) => break,
        }
    }
    if let Some(browser) = remote {
        browser.stop().await;
    }
}

fn remote_source_list(
    response: &Value,
    expected_frame_id: &str,
) -> Result<(Vec<RemoteSource>, std::collections::HashMap<String, String>), String> {
    if response.get("error").is_some() {
        return Err("Chromium could not enumerate page sources".into());
    }
    let tree = response
        .pointer("/result/frameTree")
        .ok_or("Chromium returned no page resource tree")?;
    let frame_id = tree
        .pointer("/frame/id")
        .and_then(Value::as_str)
        .ok_or("Chromium returned no main frame")?;
    if frame_id != expected_frame_id {
        return Err("The page navigated during source enumeration".into());
    }
    let mut sources = Vec::new();
    let mut allowed = std::collections::HashMap::new();
    if let Some(resources) = tree.get("resources").and_then(Value::as_array) {
        for resource in resources {
            let Some(url) = resource.get("url").and_then(Value::as_str) else {
                continue;
            };
            let kind = resource.get("type").and_then(Value::as_str).unwrap_or("");
            if !matches!(kind, "Document" | "Script" | "Stylesheet") || url.len() > 2048 {
                continue;
            }
            if resource
                .get("contentSize")
                .and_then(Value::as_f64)
                .is_some_and(|bytes| bytes > MAX_REMOTE_SOURCE_BYTES as f64)
            {
                continue;
            }
            let Ok(parsed) = reqwest::Url::parse(url) else {
                continue;
            };
            if !matches!(parsed.scheme(), "http" | "https")
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || allowed.contains_key(url)
            {
                continue;
            }
            let source = RemoteSource {
                url: url.to_owned(),
                kind: kind.to_owned(),
                mime_type: resource
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .chars()
                    .take(128)
                    .collect(),
            };
            allowed.insert(url.to_owned(), frame_id.to_owned());
            sources.push(source);
            if sources.len() >= MAX_REMOTE_SOURCES {
                break;
            }
        }
    }
    while serde_json::to_vec(&sources)
        .map_or(true, |bytes| bytes.len() > MAX_CLIENT_EVENT_BYTES - 1024)
    {
        let Some(removed) = sources.pop() else { break };
        allowed.remove(&removed.url);
    }
    Ok((sources, allowed))
}

fn remote_source_content(response: &Value) -> Result<(String, bool), String> {
    if response.get("error").is_some() {
        return Err("Chromium could not retrieve this page source".into());
    }
    let content = response
        .pointer("/result/result/content")
        .and_then(Value::as_str)
        .ok_or("Chromium returned no source text")?;
    let bytes = if response
        .pointer("/result/result/base64Encoded")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        BASE64
            .decode(content)
            .map_err(|_| "Chromium returned invalid encoded source")?
    } else {
        content.as_bytes().to_vec()
    };
    let decoded = String::from_utf8_lossy(&bytes);
    let mut end = decoded.len().min(MAX_REMOTE_SOURCE_BYTES);
    while !decoded.is_char_boundary(end) {
        end -= 1;
    }
    Ok((decoded[..end].to_owned(), end < decoded.len()))
}

fn bounded_cookie_text(value: &str, max_bytes: usize) -> String {
    let mut end = 0;
    for character in value.chars() {
        if end + character.len_utf8() > max_bytes {
            break;
        }
        end += character.len_utf8();
    }
    value[..end].to_owned()
}

fn remote_cookies(response: &Value) -> Result<Vec<RemoteCookie>, String> {
    if response.get("error").is_some() {
        return Err("Chromium could not read cookies for this page".into());
    }
    let cookies = response
        .pointer("/result/cookies")
        .and_then(Value::as_array)
        .ok_or("Chromium returned no cookie list")?;
    let mut result = Vec::new();
    for cookie in cookies {
        let Some(name) = cookie.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(value) = cookie.get("value").and_then(Value::as_str) else {
            continue;
        };
        result.push(RemoteCookie {
            name: bounded_cookie_text(name, 256),
            value: bounded_cookie_text(value, 512),
            domain: bounded_cookie_text(
                cookie.get("domain").and_then(Value::as_str).unwrap_or(""),
                256,
            ),
            path: bounded_cookie_text(
                cookie.get("path").and_then(Value::as_str).unwrap_or("/"),
                512,
            ),
            http_only: cookie
                .get("httpOnly")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            secure: cookie
                .get("secure")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            same_site: cookie
                .get("sameSite")
                .and_then(Value::as_str)
                .unwrap_or("Unspecified")
                .chars()
                .take(32)
                .collect(),
        });
        if result.len() >= 100 {
            break;
        }
    }
    while serde_json::to_vec(&result).map_or(true, |bytes| bytes.len() > 40 * 1024) {
        if result.pop().is_none() {
            break;
        }
    }
    Ok(result)
}

fn validated_origin(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

async fn send_source_chunks(
    socket: &mut axum::extract::ws::WebSocket,
    noise: &mut snow::TransportState,
    request_id: u32,
    tab_id: &str,
    url: &str,
    text: &str,
    truncated: bool,
) {
    let bytes = text.as_bytes();
    let chunks = bytes.len().div_ceil(MAX_CHUNK_BYTES);
    send_json(
        socket,
        noise,
        SOURCES_RESULT,
        &json!({"id":request_id,"tabId":tab_id,"kind":"content","url":url,"contentBytes":bytes.len(),"chunks":chunks,"truncated":truncated}),
    )
    .await;
    for (index, part) in bytes.chunks(MAX_CHUNK_BYTES).enumerate() {
        let mut message = Vec::with_capacity(7 + part.len());
        message.push(SOURCE_CHUNK);
        message.extend_from_slice(&request_id.to_be_bytes());
        message.extend_from_slice(&(index as u16).to_be_bytes());
        message.extend_from_slice(part);
        if !send_encrypted(socket, noise, &message).await {
            break;
        }
    }
}

async fn send_network_body_chunks(
    socket: &mut axum::extract::ws::WebSocket,
    noise: &mut snow::TransportState,
    request_id: u32,
    tab_id: &str,
    text: &str,
    truncated: bool,
) {
    let bytes = text.as_bytes();
    let chunks = bytes.len().div_ceil(MAX_CHUNK_BYTES);
    send_json(
        socket,
        noise,
        NETWORK_BODY_RESULT,
        &json!({"id":request_id,"tabId":tab_id,"contentBytes":bytes.len(),"chunks":chunks,"truncated":truncated}),
    )
    .await;
    for (index, part) in bytes.chunks(MAX_CHUNK_BYTES).enumerate() {
        let mut message = Vec::with_capacity(7 + part.len());
        message.push(NETWORK_BODY_CHUNK);
        message.extend_from_slice(&request_id.to_be_bytes());
        message.extend_from_slice(&(index as u16).to_be_bytes());
        message.extend_from_slice(part);
        if !send_encrypted(socket, noise, &message).await {
            break;
        }
    }
}

async fn send_download_file(
    socket: &mut axum::extract::ws::WebSocket,
    noise: &mut snow::TransportState,
    id: u32,
    filename: &str,
    path: &Path,
) -> Result<(), String> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| "Chromium did not create the completed download")?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_REMOTE_DOWNLOAD_BYTES {
        return Err("Download is not a regular file or exceeds the 64 MiB limit".into());
    }
    let bytes = metadata.len();
    let chunks = bytes.div_ceil(MAX_CHUNK_BYTES as u64) as usize;
    send_json(
        socket,
        noise,
        DOWNLOAD_FILE_START,
        &json!({"id":id,"filename":filename,"bytes":bytes,"chunks":chunks}),
    )
    .await;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| "Could not open the completed download")?;
    let mut buffer = vec![0u8; MAX_CHUNK_BYTES];
    for index in 0..chunks {
        let expected = (bytes as usize - index * MAX_CHUNK_BYTES).min(MAX_CHUNK_BYTES);
        file.read_exact(&mut buffer[..expected])
            .await
            .map_err(|_| "Completed download changed while transferring")?;
        let mut message = Vec::with_capacity(7 + expected);
        message.push(DOWNLOAD_FILE_CHUNK);
        message.extend_from_slice(&id.to_be_bytes());
        message.extend_from_slice(&(index as u16).to_be_bytes());
        message.extend_from_slice(&buffer[..expected]);
        if !send_encrypted(socket, noise, &message).await {
            return Err("Download transfer was interrupted".into());
        }
    }
    Ok(())
}

async fn cleanup_download_files(directory: &Path, guid: &str) {
    if !valid_download_guid(guid) {
        return;
    }
    let _ = tokio::fs::remove_file(directory.join(guid)).await;
    let _ = tokio::fs::remove_file(directory.join(format!("{guid}.crdownload"))).await;
}

fn valid_download_guid(value: &str) -> bool {
    (16..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

fn valid_remote_tab_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn remote_network_body(response: &Value) -> Result<(String, bool), String> {
    if response.get("error").is_some() {
        return Err("Chromium could not retrieve this response body".into());
    }
    let body = response
        .pointer("/result/body")
        .and_then(Value::as_str)
        .ok_or("Chromium returned no response body")?;
    let (bytes, truncated) = if response
        .pointer("/result/base64Encoded")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let encoded_limit = MAX_REMOTE_NETWORK_BODY_BYTES.div_ceil(3) * 4;
        let end = body.len().min(encoded_limit);
        let end = end - end % 4;
        let decoded = BASE64
            .decode(&body.as_bytes()[..end])
            .map_err(|_| "Chromium returned an invalid encoded response body")?;
        (decoded, body.len() > end)
    } else {
        let mut end = body.len().min(MAX_REMOTE_NETWORK_BODY_BYTES);
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        (body.as_bytes()[..end].to_vec(), end < body.len())
    };
    let mut truncated = truncated || bytes.len() > MAX_REMOTE_NETWORK_BODY_BYTES;
    let bytes = &bytes[..bytes.len().min(MAX_REMOTE_NETWORK_BODY_BYTES)];
    let decoded = String::from_utf8_lossy(bytes);
    let mut end = decoded.len().min(MAX_REMOTE_NETWORK_BODY_BYTES);
    while !decoded.is_char_boundary(end) {
        end -= 1;
    }
    truncated |= end < decoded.len();
    Ok((decoded[..end].to_owned(), truncated))
}

fn compact_navigation_history(response: &Value) -> Result<Value, String> {
    const MAX_ENTRIES: usize = 50;
    const MAX_URL_BYTES: usize = 512;
    const MAX_TITLE_BYTES: usize = 128;
    let entries = response
        .pointer("/result/entries")
        .and_then(Value::as_array)
        .ok_or("Chromium returned no navigation history")?;
    if entries.is_empty() {
        return Ok(json!({"entries":[],"currentIndex":-1,"canGoBack":false,"canGoForward":false}));
    }
    let current = response
        .pointer("/result/currentIndex")
        .and_then(Value::as_i64)
        .and_then(|index| usize::try_from(index).ok())
        .unwrap_or(0)
        .min(entries.len() - 1);
    let start = current.saturating_sub(MAX_ENTRIES - 1);
    let end = (start + MAX_ENTRIES).min(entries.len());
    let compact = entries[start..end]
        .iter()
        .map(|entry| {
            let id = entry
                .get("id")
                .and_then(Value::as_i64)
                .ok_or("Chromium returned an invalid history entry id")?;
            let url = entry
                .get("url")
                .and_then(Value::as_str)
                .ok_or("Chromium returned an invalid history URL")?;
            let title = entry.get("title").and_then(Value::as_str).unwrap_or("");
            Ok(json!({
                "id":id,
                "url":truncate_utf8(url, MAX_URL_BYTES),
                "title":truncate_utf8(title, MAX_TITLE_BYTES),
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let current_index = current.saturating_sub(start);
    Ok(json!({
        "entries":compact,
        "currentIndex":current_index,
        "canGoBack":current > 0,
        "canGoForward":current + 1 < entries.len(),
    }))
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    let mut end = 0;
    for character in value.chars() {
        let next = end + character.len_utf8();
        if next > max_bytes {
            break;
        }
        end = next;
    }
    value[..end].to_owned()
}

async fn send_error(
    socket: &mut axum::extract::ws::WebSocket,
    noise: &mut snow::TransportState,
    message: &str,
) {
    send_json(socket, noise, ERROR, &json!({"message":message})).await;
}

async fn send_json(
    socket: &mut axum::extract::ws::WebSocket,
    noise: &mut snow::TransportState,
    op: u8,
    value: &Value,
) {
    let mut message = vec![op];
    message.extend_from_slice(&serde_json::to_vec(value).unwrap_or_default());
    let _ = send_encrypted(socket, noise, &message).await;
}

async fn send_encrypted(
    socket: &mut axum::extract::ws::WebSocket,
    noise: &mut snow::TransportState,
    message: &[u8],
) -> bool {
    if message.len() > MAX_WS_MESSAGE {
        return false;
    }
    let mut encrypted = vec![0u8; MAX_WS_MESSAGE];
    let Ok(size) = noise.write_message(message, &mut encrypted) else {
        return false;
    };
    socket
        .send(axum::extract::ws::Message::Binary(
            encrypted[..size].to_vec().into(),
        ))
        .await
        .is_ok()
}

fn is_debug_event(event: &Value) -> bool {
    matches!(
        event.get("method").and_then(Value::as_str),
        Some("Runtime.consoleAPICalled")
            | Some("Runtime.exceptionThrown")
            | Some("Network.requestWillBeSent")
            | Some("Network.responseReceived")
            | Some("Network.loadingFinished")
            | Some("Network.loadingFailed")
            | Some("Page.frameNavigated")
            | Some("Page.domContentEventFired")
            | Some("Page.loadEventFired")
            | Some("Debugger.paused")
            | Some("Debugger.resumed")
            | Some("Debugger.breakpointResolved")
    )
}

fn client_debug_event(event: &Value) -> Option<Value> {
    if !is_debug_event(event) {
        return None;
    }
    let method = event.get("method")?.as_str()?;
    let mut compact = if method == "Debugger.paused" {
        let params = event.get("params")?;
        let call_frames = params
            .get("callFrames")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(32)
            .map(|frame| {
                json!({
                    "callFrameId":frame.get("callFrameId").and_then(Value::as_str).unwrap_or("").chars().take(256).collect::<String>(),
                    "functionName":frame.get("functionName").and_then(Value::as_str).unwrap_or("").chars().take(256).collect::<String>(),
                    "url":frame.get("url").and_then(Value::as_str).unwrap_or("").chars().take(2048).collect::<String>(),
                    "location":{
                        "scriptId":frame.pointer("/location/scriptId").and_then(Value::as_str).unwrap_or("").chars().take(128).collect::<String>(),
                        "lineNumber":frame.pointer("/location/lineNumber").and_then(Value::as_u64).unwrap_or(0),
                        "columnNumber":frame.pointer("/location/columnNumber").and_then(Value::as_u64).unwrap_or(0)
                    }
                })
            })
            .collect::<Vec<_>>();
        json!({"method":method,"params":{"reason":params.get("reason").and_then(Value::as_str).unwrap_or("other").chars().take(64).collect::<String>(),"callFrames":call_frames}})
    } else {
        event.clone()
    };
    if let Some(session_id) = event.get("sessionId") {
        compact["sessionId"] = session_id.clone();
    }
    serde_json::to_vec(&compact)
        .is_ok_and(|bytes| bytes.len() <= MAX_CLIENT_EVENT_BYTES)
        .then_some(compact)
}

fn debugger_cdp_command(
    action: &str,
    request: &Value,
    breakpoints: &std::collections::HashSet<String>,
    allowed_sources: &std::collections::HashMap<String, String>,
) -> Result<(&'static str, Value), String> {
    match action {
        "pause" => Ok(("Debugger.pause", json!({}))),
        "resume" => Ok(("Debugger.resume", json!({}))),
        "stepOver" => Ok(("Debugger.stepOver", json!({}))),
        "stepInto" => Ok(("Debugger.stepInto", json!({}))),
        "stepOut" => Ok(("Debugger.stepOut", json!({}))),
        "setBreakpoint" => {
            let url = request.get("url").and_then(Value::as_str).unwrap_or("");
            let line = request
                .get("line")
                .and_then(Value::as_u64)
                .unwrap_or(u64::MAX);
            if !allowed_sources.contains_key(url) || line > 999_999 {
                return Err("Breakpoint source or line is invalid".into());
            }
            Ok((
                "Debugger.setBreakpointByUrl",
                json!({"url":url,"lineNumber":line}),
            ))
        }
        "removeBreakpoint" => {
            let id = request
                .get("breakpointId")
                .and_then(Value::as_str)
                .unwrap_or("");
            if id.is_empty() || !breakpoints.contains(id) {
                return Err("Breakpoint is not active in this browser session".into());
            }
            Ok(("Debugger.removeBreakpoint", json!({"breakpointId":id})))
        }
        _ => Err("Unsupported debugger command".into()),
    }
}

fn validate_call_frame<'a>(
    requested: Option<&'a str>,
    active_frames: &std::collections::HashSet<String>,
) -> Result<Option<&'a str>, &'static str> {
    match requested {
        None => Ok(None),
        Some(id) if id.len() <= 256 && active_frames.contains(id) => Ok(Some(id)),
        Some(_) => Err("The selected debugger call frame is no longer paused"),
    }
}

#[derive(Deserialize)]
struct Navigate {
    #[serde(rename = "tabId")]
    tab_id: String,
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTabRequest {
    tab_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteHistoryRequest {
    tab_id: String,
    delta: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Resize {
    tab_id: String,
    width: u32,
    height: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Evaluate {
    id: u32,
    tab_id: String,
    expression: String,
    #[serde(default)]
    call_frame_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DebuggerCommand {
    id: u32,
    tab_id: String,
    action: String,
    url: Option<String>,
    line: Option<u32>,
    breakpoint_id: Option<String>,
    object_id: Option<String>,
    call_frame_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourcesList {
    id: u32,
    tab_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceContent {
    id: u32,
    tab_id: String,
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SiteDataRequest {
    id: u32,
    tab_id: String,
    origin: String,
}

struct PendingEvaluation {
    request_id: u32,
    tab_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSource {
    url: String,
    kind: String,
    mime_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    http_only: bool,
    secure: bool,
    same_site: String,
}

enum PendingSourceRequest {
    List {
        request_id: u32,
        tab_id: String,
        frame_id: String,
    },
    Content {
        request_id: u32,
        tab_id: String,
        url: String,
        frame_id: String,
    },
}

enum PendingSiteDataRequest {
    Cookies { request_id: u32, tab_id: String },
    Clear { request_id: u32, tab_id: String },
}

struct RemoteDownload {
    guid: String,
    filename: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetworkBodyRequest {
    id: u32,
    tab_id: String,
    request_id: String,
}

struct PendingNetworkBody {
    request_id: u32,
    tab_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserscriptBegin {
    id: u32,
    total_bytes: usize,
    chunks: u16,
}

struct UserScriptUpload {
    id: u32,
    total_bytes: usize,
    chunks: u16,
    next_chunk: u16,
    bytes: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilterUploadBegin {
    id: u32,
    total_bytes: usize,
    chunks: u16,
    version: u8,
    rule_count: usize,
    host_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilterUploadCommit {
    id: u32,
}

struct FilterUpload {
    id: u32,
    total_bytes: usize,
    chunks: u16,
    next_chunk: u16,
    rule_count: usize,
    host_count: usize,
    bytes: Vec<u8>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteFilterSet {
    version: u8,
    hosts: Vec<String>,
    rules: Vec<RemoteFilterRule>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteFilterRule {
    host: String,
    tokens: String,
    match_case: bool,
    important: bool,
    types: Vec<String>,
    excluded_types: Vec<String>,
    third_party: Option<bool>,
    domains: Vec<String>,
    excluded_domains: Vec<String>,
    allow: bool,
}

fn validate_remote_filters(
    filters: RemoteFilterSet,
    rules: usize,
    hosts: usize,
) -> Result<RemoteFilterSet, &'static str> {
    const TYPES: &[&str] = &[
        "script",
        "image",
        "stylesheet",
        "media",
        "font",
        "xmlhttprequest",
        "object",
        "subdocument",
        "document",
        "other",
        "ping",
        "websocket",
    ];
    if filters.version != 1
        || filters.rules.len() != rules
        || filters.hosts.len() != hosts
        || rules.saturating_add(hosts) > MAX_REMOTE_FILTER_RULES
    {
        return Err("Filter-list version or rule count is invalid");
    }
    let valid_domain = |domain: &str| {
        !domain.is_empty()
            && domain.len() <= 253
            && domain.is_ascii()
            && domain.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && label.as_bytes()[0].is_ascii_alphanumeric()
                    && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                    && label
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-')
            })
    };
    if filters.hosts.iter().any(|host| !valid_domain(host)) {
        return Err("Filter-list host entry is invalid");
    }
    for rule in &filters.rules {
        if (!rule.host.is_empty() && !valid_domain(&rule.host))
            || rule.tokens.len() > 258
            || rule.types.len() > 12
            || rule.excluded_types.len() > 12
            || rule
                .types
                .iter()
                .chain(&rule.excluded_types)
                .any(|kind| !TYPES.contains(&kind.as_str()))
            || rule.domains.len() > 64
            || rule.excluded_domains.len() > 64
            || rule
                .domains
                .iter()
                .chain(&rule.excluded_domains)
                .any(|domain| !valid_domain(domain))
            || rule.tokens.chars().any(|c| c.is_control())
        {
            return Err("Filter-list rule exceeds its limits or contains invalid fields");
        }
    }
    Ok(filters)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionUploadBegin {
    id: u32,
    files: Vec<ExtensionFileMeta>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionFileMeta {
    path: String,
    size: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionRemoveRequest {
    request_id: u32,
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionActionRequest {
    request_id: u32,
    extension_id: String,
    tab_id: String,
}

struct ExtensionUpload {
    id: u32,
    root: PathBuf,
    files: Vec<ExtensionFileMeta>,
    next_file: usize,
    offset: usize,
    total_bytes: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageFileUploadBegin {
    id: u32,
    tab_id: String,
    chooser_id: u32,
    files: Vec<PageFileMeta>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageFileMeta {
    name: String,
    size: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageFileUploadCancel {
    id: u32,
    tab_id: String,
    chooser_id: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JavascriptDialogReply {
    id: u32,
    tab_id: String,
    accept: bool,
    #[serde(default)]
    prompt_text: String,
}

struct PendingJavascriptDialog {
    id: u32,
    tab_id: String,
}

struct PendingPageFileChooser {
    id: u32,
    tab_id: String,
    backend_node_id: i64,
    multiple: bool,
}

struct PageFileUpload {
    id: u32,
    tab_id: String,
    chooser_id: u32,
    root: PathBuf,
    files: Vec<PageFileMeta>,
    writers: Vec<tokio::fs::File>,
    next_file: usize,
    offset: usize,
    total_bytes: usize,
}

#[derive(Clone)]
struct LoadedExtension {
    id: String,
    name: String,
    has_action: bool,
    directory: PathBuf,
    bytes: usize,
}

struct ExtensionManifestInfo {
    name: String,
    has_action: bool,
}

fn validate_extension_capacity(
    loaded_count: usize,
    loaded_bytes: usize,
    incoming_bytes: usize,
) -> Result<(), &'static str> {
    if loaded_count >= MAX_LOADED_EXTENSIONS {
        return Err("A maximum of 4 extensions can be loaded in one browser session");
    }
    if loaded_bytes
        .checked_add(incoming_bytes)
        .is_none_or(|total| total > MAX_LOADED_EXTENSION_BYTES)
    {
        return Err("Loaded extensions are limited to 64 MiB per browser session");
    }
    Ok(())
}

fn validate_extension_files(files: &[ExtensionFileMeta]) -> Result<usize, &'static str> {
    if files.is_empty() || files.len() > MAX_EXTENSION_FILES {
        return Err("An extension must contain between 1 and 128 files");
    }
    let mut seen = std::collections::HashSet::new();
    let mut total = 0usize;
    for file in files {
        if file.path.is_empty()
            || file.path.len() > MAX_EXTENSION_PATH_BYTES
            || file.path.starts_with('/')
            || file.path.contains(['\\', '\0', ':'])
            || file.path.chars().any(char::is_control)
            || file
                .path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err("Extension paths must be safe relative paths");
        }
        let path = Path::new(&file.path);
        if path
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err("Extension paths must be safe relative paths");
        }
        if !seen.insert(file.path.to_ascii_lowercase()) {
            return Err("Extension files contain a duplicate path");
        }
        if file.size > MAX_EXTENSION_FILE_BYTES {
            return Err("An extension file exceeds the 2 MiB limit");
        }
        total = total
            .checked_add(file.size)
            .ok_or("Extension size overflow")?;
        if total > MAX_EXTENSION_TOTAL_BYTES {
            return Err("Extensions are limited to 16 MiB total");
        }
    }
    for path in &seen {
        // Reject a file used as another file's parent (case-insensitive for portability).
        let components = path.split('/').collect::<Vec<_>>();
        for end in 1..components.len() {
            if seen.contains(&components[..end].join("/")) {
                return Err("Extension paths contain a file/directory conflict");
            }
        }
    }
    if !files.iter().any(|file| file.path == "manifest.json") {
        return Err("The extension root must contain manifest.json");
    }
    Ok(total)
}

fn validate_page_file_upload(files: &[PageFileMeta]) -> Result<usize, &'static str> {
    if files.is_empty() || files.len() > MAX_REMOTE_FILE_UPLOADS {
        return Err("Choose between 1 and 8 files for the remote page");
    }
    let mut total = 0usize;
    for file in files {
        if file.name.is_empty()
            || file.name.len() > MAX_REMOTE_UPLOAD_FILENAME_BYTES
            || file.name == "."
            || file.name == ".."
            || file.name.contains(['/', '\\', '\0', ':'])
            || file.name.chars().any(char::is_control)
        {
            return Err("A selected file has an invalid filename");
        }
        if file.size > MAX_REMOTE_FILE_BYTES {
            return Err("Each remote page upload is limited to 16 MiB");
        }
        total = total
            .checked_add(file.size)
            .ok_or("Remote page upload size overflow")?;
        if total > MAX_REMOTE_FILE_UPLOAD_BYTES {
            return Err("Remote page uploads are limited to 32 MiB total");
        }
    }
    Ok(total)
}

async fn create_page_file_upload(
    id: u32,
    tab_id: String,
    chooser_id: u32,
    files: Vec<PageFileMeta>,
    total_bytes: usize,
    profile: &Profile,
) -> Result<PageFileUpload, &'static str> {
    static NEXT_UPLOAD_DIR: AtomicU64 = AtomicU64::new(1);
    let directory_id = NEXT_UPLOAD_DIR.fetch_add(1, Ordering::Relaxed);
    let root = profile
        .0
        .join("page-file-uploads")
        .join(format!("upload-{directory_id}"));
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|_| "Could not create the remote upload staging directory")?;
    let mut writers = Vec::with_capacity(files.len());
    for (index, file) in files.iter().enumerate() {
        let directory = root.join(index.to_string());
        if tokio::fs::create_dir(&directory).await.is_err() {
            let _ = tokio::fs::remove_dir_all(&root).await;
            return Err("Could not create a remote upload directory");
        }
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join(&file.name))
            .await
        {
            Ok(writer) => writers.push(writer),
            Err(_) => {
                let _ = tokio::fs::remove_dir_all(&root).await;
                return Err("Could not create a remote upload file");
            }
        }
    }
    let next_file = files
        .iter()
        .position(|file| file.size > 0)
        .unwrap_or(files.len());
    Ok(PageFileUpload {
        id,
        tab_id,
        chooser_id,
        root,
        files,
        writers,
        next_file,
        offset: 0,
        total_bytes,
    })
}

async fn write_page_file_chunk(
    upload: &mut PageFileUpload,
    file_index: usize,
    offset: usize,
    bytes: &[u8],
) -> Result<(), &'static str> {
    if bytes.is_empty()
        || bytes.len() > MAX_CHUNK_BYTES
        || file_index != upload.next_file
        || offset != upload.offset
    {
        return Err("Remote upload chunk order or size is invalid");
    }
    let Some(file) = upload.files.get(file_index) else {
        return Err("Remote upload references an unknown file");
    };
    let expected = (file.size - upload.offset).min(MAX_CHUNK_BYTES);
    if bytes.len() != expected {
        return Err("Remote upload chunk length does not match its manifest");
    }
    use tokio::io::AsyncWriteExt;
    upload.writers[file_index]
        .write_all(bytes)
        .await
        .map_err(|_| "Could not write a remote upload file")?;
    upload.offset += bytes.len();
    if upload.offset == file.size {
        upload.next_file += 1;
        while upload
            .files
            .get(upload.next_file)
            .is_some_and(|next| next.size == 0)
        {
            upload.next_file += 1;
        }
        upload.offset = 0;
    }
    Ok(())
}

async fn create_extension_upload(
    id: u32,
    files: Vec<ExtensionFileMeta>,
    total_bytes: usize,
    profile: &Profile,
) -> Result<ExtensionUpload, &'static str> {
    static NEXT_EXTENSION_DIR: AtomicU64 = AtomicU64::new(1);
    let directory_id = NEXT_EXTENSION_DIR.fetch_add(1, Ordering::Relaxed);
    let root = profile
        .0
        .join("extensions")
        .join(format!("upload-{directory_id}"));
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|_| "Could not create extension staging directory")?;
    for file in &files {
        let path = root.join(&file.path);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|_| "Could not create extension directory")?;
        }
        tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .await
            .map_err(|_| "Could not create extension file")?;
    }
    let next_file = files
        .iter()
        .position(|file| file.size > 0)
        .unwrap_or(files.len());
    Ok(ExtensionUpload {
        id,
        root,
        files,
        next_file,
        offset: 0,
        total_bytes,
    })
}

async fn write_extension_chunk(
    upload: &mut ExtensionUpload,
    file_index: usize,
    offset: usize,
    bytes: &[u8],
) -> Result<(usize, usize), &'static str> {
    if bytes.is_empty()
        || bytes.len() > MAX_CHUNK_BYTES
        || file_index != upload.next_file
        || offset != upload.offset
    {
        return Err("Extension chunk order or size is invalid");
    }
    let Some(file) = upload.files.get(file_index) else {
        return Err("Extension chunk references an unknown file");
    };
    let expected = (file.size - upload.offset).min(MAX_CHUNK_BYTES);
    if bytes.len() != expected {
        return Err("Extension chunk length does not match the file manifest");
    }
    let path = upload.root.join(&file.path);
    let mut output = tokio::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .await
        .map_err(|_| "Could not write extension file")?;
    use tokio::io::{AsyncSeekExt, AsyncWriteExt};
    output
        .seek(std::io::SeekFrom::Start(upload.offset as u64))
        .await
        .map_err(|_| "Could not seek extension file")?;
    output
        .write_all(bytes)
        .await
        .map_err(|_| "Could not write extension file")?;
    upload.offset += bytes.len();
    if upload.offset == file.size {
        upload.next_file += 1;
        while upload.next_file < upload.files.len() && upload.files[upload.next_file].size == 0 {
            upload.next_file += 1;
        }
        upload.offset = 0;
    }
    Ok((upload.next_file, upload.offset))
}

fn validate_extension_manifest(bytes: &[u8]) -> Result<ExtensionManifestInfo, &'static str> {
    if bytes.len() > MAX_EXTENSION_MANIFEST_BYTES {
        return Err("Extension manifest exceeds the 128 KiB limit");
    }
    let manifest: Value =
        serde_json::from_slice(bytes).map_err(|_| "Extension manifest is invalid JSON")?;
    if manifest.get("manifest_version").and_then(Value::as_u64) != Some(3) {
        return Err("Only Manifest V3 extensions are supported");
    }
    let name = manifest
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty() && name.len() <= 128)
        .ok_or("Extension name is missing or too long")?;
    let version = manifest
        .get("version")
        .and_then(Value::as_str)
        .filter(|version| !version.is_empty() && version.len() <= 64)
        .ok_or("Extension version is missing or too long")?;
    let _ = version;
    for permission_field in ["permissions", "optional_permissions"] {
        let Some(permissions) = manifest.get(permission_field) else {
            continue;
        };
        let Some(permissions) = permissions.as_array() else {
            return Err("Extension permissions must be an array");
        };
        if permissions.len() > 128 {
            return Err("Extension declares too many permissions");
        }
        for permission in permissions.iter().filter_map(Value::as_str) {
            if matches!(permission, "proxy" | "nativeMessaging" | "debugger") {
                return Err(
                    "Extensions requesting proxy, nativeMessaging, or debugger permissions are not supported",
                );
            }
        }
        if permissions.iter().any(|permission| !permission.is_string()) {
            return Err("Extension permissions must be strings");
        }
    }
    let has_action = match manifest.get("action") {
        Some(action) if action.is_object() => true,
        Some(_) => return Err("Extension action must be an object"),
        None => false,
    };
    Ok(ExtensionManifestInfo {
        name: name.to_owned(),
        has_action,
    })
}

fn extension_id_from_url(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw).ok()?;
    if url.scheme() != "chrome-extension"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    let id = url.host_str()?;
    (id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte))).then(|| id.to_owned())
}

fn validated_extension_popup_url(raw: &str, extension_id: &str) -> Result<String, String> {
    if extension_id_from_url(raw).as_deref() != Some(extension_id) {
        return Err("Extension popup target is outside its loaded extension origin".into());
    }
    Ok(raw.to_owned())
}

fn evaluation_result(response: &Value) -> (Value, Value) {
    if let Some(error) = response.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Evaluation failed");
        return (
            Value::Null,
            Value::String(message.chars().take(4096).collect()),
        );
    }
    let details = response
        .pointer("/result/result")
        .cloned()
        .unwrap_or(Value::Null);
    if let Some(exception) = response.pointer("/result/exceptionDetails") {
        let text = exception
            .pointer("/exception/description")
            .and_then(Value::as_str)
            .or_else(|| exception.get("text").and_then(Value::as_str))
            .unwrap_or("Evaluation failed");
        return (
            Value::Null,
            Value::String(text.chars().take(4096).collect()),
        );
    }
    let value = details
        .get("value")
        .cloned()
        .or_else(|| {
            details
                .get("unserializableValue")
                .and_then(Value::as_str)
                .map(|value| Value::String(value.to_owned()))
        })
        .unwrap_or(Value::Null);
    if serde_json::to_vec(&value).map_or(true, |bytes| bytes.len() > MAX_CONSOLE_RESULT_BYTES) {
        return (
            Value::String("[Console result omitted: exceeds 64 KiB]".into()),
            Value::Null,
        );
    }
    (value, Value::Null)
}

fn evaluation_remote_object(response: &Value) -> Option<Value> {
    let value = response.pointer("/result/result")?;
    let object_id = value.get("objectId")?.as_str()?;
    if object_id.is_empty() || object_id.len() > 512 {
        return None;
    }
    Some(json!({
        "objectId":object_id,
        "type":value.get("type").and_then(Value::as_str).unwrap_or("object").chars().take(32).collect::<String>(),
        "subtype":value.get("subtype").and_then(Value::as_str).unwrap_or("").chars().take(32).collect::<String>(),
        "className":value.get("className").and_then(Value::as_str).unwrap_or("").chars().take(128).collect::<String>(),
        "description":value.get("description").and_then(Value::as_str).unwrap_or("Object").chars().take(512).collect::<String>()
    }))
}

fn compact_remote_value(value: &Value) -> Value {
    let mut compact = json!({
        "type":value.get("type").and_then(Value::as_str).unwrap_or("undefined").chars().take(32).collect::<String>(),
        "subtype":value.get("subtype").and_then(Value::as_str).unwrap_or("").chars().take(32).collect::<String>(),
        "className":value.get("className").and_then(Value::as_str).unwrap_or("").chars().take(128).collect::<String>(),
        "description":value.get("description").and_then(Value::as_str).unwrap_or("").chars().take(512).collect::<String>()
    });
    if let Some(object_id) = value.get("objectId").and_then(Value::as_str)
        && !object_id.is_empty()
        && object_id.len() <= 512
    {
        compact["objectId"] = Value::String(object_id.to_owned());
    }
    if let Some(primitive) = value.get("value")
        && serde_json::to_vec(primitive).is_ok_and(|bytes| bytes.len() <= 4096)
    {
        compact["value"] = primitive.clone();
    }
    compact
}

fn remote_object_properties(response: &Value) -> Vec<Value> {
    let Some(descriptors) = response.pointer("/result/result").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut properties = descriptors
        .iter()
        .take(100)
        .filter_map(|descriptor| {
            let name = descriptor.get("name")?.as_str()?;
            let value = descriptor.get("value").map(compact_remote_value);
            Some(json!({
                "name":name.chars().take(256).collect::<String>(),
                "value":value.unwrap_or(Value::Null),
                "enumerable":descriptor.get("enumerable").and_then(Value::as_bool).unwrap_or(false),
                "writable":descriptor.get("writable").and_then(Value::as_bool).unwrap_or(false),
                "configurable":descriptor.get("configurable").and_then(Value::as_bool).unwrap_or(false),
                "accessor":descriptor.get("get").is_some() || descriptor.get("set").is_some()
            }))
        })
        .collect::<Vec<_>>();
    while serde_json::to_vec(&properties).map_or(true, |bytes| bytes.len() > 40 * 1024) {
        if properties.pop().is_none() {
            break;
        }
    }
    properties
}

fn compact_debugger_scopes(frame: &Value) -> Vec<Value> {
    frame.pointer("/scopeChain")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(8)
        .filter_map(|scope| {
            let object = scope.get("object")?;
            let object_id = object.get("objectId")?.as_str()?;
            if object_id.is_empty() || object_id.len() > 512 { return None; }
            Some(json!({
                "type":scope.get("type").and_then(Value::as_str).unwrap_or("local").chars().take(32).collect::<String>(),
                "name":scope.get("name").and_then(Value::as_str).unwrap_or("").chars().take(128).collect::<String>(),
                "object":{
                    "objectId":object_id,
                    "type":object.get("type").and_then(Value::as_str).unwrap_or("object").chars().take(32).collect::<String>(),
                    "subtype":object.get("subtype").and_then(Value::as_str).unwrap_or("").chars().take(32).collect::<String>(),
                    "className":object.get("className").and_then(Value::as_str).unwrap_or("").chars().take(128).collect::<String>(),
                    "description":object.get("description").and_then(Value::as_str).unwrap_or("Scope").chars().take(256).collect::<String>()
                }
            }))
        })
        .collect()
}

fn cdp_command_payload(id: u32, method: &str, params: Value, session_id: Option<&str>) -> Value {
    let mut command = json!({"id":id,"method":method,"params":params});
    if let Some(session_id) = session_id {
        command["sessionId"] = json!(session_id);
    }
    command
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    tab_id: String,
    #[serde(rename = "type")]
    group: String,
    #[serde(default)]
    action: String,
    #[serde(default)]
    x: f64,
    #[serde(default)]
    y: f64,
    #[serde(default)]
    button: String,
    #[serde(default)]
    click_count: u8,
    #[serde(default)]
    buttons: u8,
    #[serde(default)]
    delta_x: f64,
    #[serde(default)]
    delta_y: f64,
    #[serde(default)]
    key: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    unmodified_text: String,
    #[serde(default)]
    modifiers: u8,
    #[serde(default)]
    key_code: i32,
    #[serde(default)]
    touch_points: Vec<RemoteTouchPoint>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTouchPoint {
    id: u32,
    x: f64,
    y: f64,
    #[serde(default = "default_touch_force")]
    force: f64,
    #[serde(default = "default_touch_radius")]
    radius_x: f64,
    #[serde(default = "default_touch_radius")]
    radius_y: f64,
}

fn default_touch_force() -> f64 {
    1.0
}

fn default_touch_radius() -> f64 {
    1.0
}

impl Input {
    fn validate(&self) -> Result<(), String> {
        const MOUSE: &[&str] = &["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"];
        const KEY: &[&str] = &["keyDown", "keyUp", "char"];
        const TEXT: &[&str] = &["insertText"];
        const TOUCH: &[&str] = &["touchStart", "touchMove", "touchEnd", "touchCancel"];
        if (self.group == "mouse" && !MOUSE.contains(&self.action.as_str()))
            || (self.group == "key" && !KEY.contains(&self.action.as_str()))
            || (self.group == "text" && !TEXT.contains(&self.action.as_str()))
            || (self.group == "touch" && !TOUCH.contains(&self.action.as_str()))
            || !["mouse", "key", "text", "touch"].contains(&self.group.as_str())
        {
            return Err("Unsupported input event".into());
        }
        if !self.x.is_finite()
            || !self.y.is_finite()
            || !self.delta_x.is_finite()
            || !self.delta_y.is_finite()
        {
            return Err("Input coordinates must be finite".into());
        }
        if self.modifiers > 15
            || self.key.len() > 64
            || self.code.len() > 64
            || self.text.len()
                > if self.group == "text" {
                    MAX_REMOTE_TEXT_BYTES
                } else {
                    32
                }
            || self.unmodified_text.len() > 32
        {
            return Err("Input event exceeds its limit".into());
        }
        if !self.button.is_empty()
            && !["left", "middle", "right", "back", "forward"].contains(&self.button.as_str())
        {
            return Err("Unsupported mouse button".into());
        }
        if self.group == "touch" {
            let valid_touch_count = match self.action.as_str() {
                "touchStart" | "touchMove" => {
                    !self.touch_points.is_empty()
                        && self.touch_points.len() <= MAX_REMOTE_TOUCH_POINTS
                }
                "touchEnd" | "touchCancel" => self.touch_points.is_empty(),
                _ => false,
            };
            if !valid_touch_count {
                return Err(
                    "Touch input must contain up to 10 active points for start/move and none for end/cancel".into(),
                );
            }
            let mut touch_ids = std::collections::HashSet::new();
            if self.touch_points.iter().any(|point| {
                point.id > 0x7fff_ffff
                    || !touch_ids.insert(point.id)
                    || !point.x.is_finite()
                    || !point.y.is_finite()
                    || !point.force.is_finite()
                    || !(0.0..=1.0).contains(&point.force)
                    || !point.radius_x.is_finite()
                    || !(0.0..=128.0).contains(&point.radius_x)
                    || !point.radius_y.is_finite()
                    || !(0.0..=128.0).contains(&point.radius_y)
            }) {
                return Err("Touch point exceeds its limits".into());
            }
        }
        Ok(())
    }
}

struct Profile(PathBuf);

impl Profile {
    fn create() -> io::Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        for _ in 0..8 {
            let path = env::temp_dir().join(format!(
                "eya-render-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&path) {
                Ok(()) => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        if let Err(error) =
                            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                        {
                            let _ = fs::remove_dir_all(&path);
                            return Err(error);
                        }
                    }
                    return Ok(Self(path));
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not create browser profile",
        ))
    }
}

impl Drop for Profile {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn schemeful_site(url: &reqwest::Url) -> String {
    format!(
        "{}://{}",
        url.scheme(),
        url.host_str().unwrap_or_default().to_ascii_lowercase()
    )
}

fn privacy_block_reason(
    privacy: RemotePrivacy,
    target: &reqwest::Url,
    page: Option<&reqwest::Url>,
    is_main_document: bool,
    filters: &RemoteFilterSet,
    resource_type: &str,
) -> Option<&'static str> {
    if privacy.block_trackers && is_builtin_tracker(target.host_str().unwrap_or("")) {
        Some("built-in")
    } else if privacy.block_trackers && remote_filter_blocks(filters, target, page, resource_type) {
        Some("filter-list")
    } else if privacy.block_third_party
        && !is_main_document
        && page.is_some_and(|page| schemeful_site(page) != schemeful_site(target))
    {
        Some("third-party")
    } else {
        None
    }
}

fn remote_filter_blocks(
    filters: &RemoteFilterSet,
    target: &reqwest::Url,
    page: Option<&reqwest::Url>,
    resource_type: &str,
) -> bool {
    if filters.rules.is_empty() && filters.hosts.is_empty() {
        return false;
    }
    let host = target
        .host_str()
        .unwrap_or_default()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let page_host = page
        .and_then(reqwest::Url::host_str)
        .unwrap_or_default()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let third_party = !page_host.is_empty()
        && !domain_matches(&host, &page_host)
        && !domain_matches(&page_host, &host);
    let applies = |rule: &RemoteFilterRule| {
        if !rule.host.is_empty() && !domain_matches(&host, &rule.host) {
            return false;
        }
        if !rule.tokens.is_empty() {
            let value = if rule.host.is_empty() {
                target.as_str().to_owned()
            } else {
                let port = target
                    .port()
                    .map(|port| format!(":{port}"))
                    .unwrap_or_default();
                format!(
                    "{port}{}{}{}",
                    target.path(),
                    target.query().map(|q| format!("?{q}")).unwrap_or_default(),
                    target
                        .fragment()
                        .map(|f| format!("#{f}"))
                        .unwrap_or_default()
                )
            };
            if !remote_pattern_matches(&rule.tokens, &value, rule.match_case) {
                return false;
            }
        }
        if !rule.types.is_empty() && !rule.types.iter().any(|kind| kind == resource_type) {
            return false;
        }
        if rule.excluded_types.iter().any(|kind| kind == resource_type) {
            return false;
        }
        if rule
            .third_party
            .is_some_and(|expected| expected != third_party)
        {
            return false;
        }
        if !rule.domains.is_empty()
            && !rule
                .domains
                .iter()
                .any(|domain| domain_matches(&page_host, domain))
        {
            return false;
        }
        !rule
            .excluded_domains
            .iter()
            .any(|domain| domain_matches(&page_host, domain))
    };
    let important = filters
        .rules
        .iter()
        .any(|rule| !rule.allow && rule.important && applies(rule));
    if important {
        return true;
    }
    if filters.rules.iter().any(|rule| rule.allow && applies(rule)) {
        return false;
    }
    if filters.hosts.iter().any(|blocked| blocked == &host) {
        return true;
    }
    filters
        .rules
        .iter()
        .any(|rule| !rule.allow && applies(rule))
}

fn domain_matches(host: &str, domain: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

fn remote_pattern_matches(tokens: &str, raw_value: &str, match_case: bool) -> bool {
    let lower = |value: &str| {
        if match_case {
            value.to_owned()
        } else {
            value.chars().flat_map(char::to_lowercase).collect()
        }
    };
    let tokens = lower(tokens).chars().collect::<Vec<_>>();
    let bytes = lower(raw_value).chars().collect::<Vec<_>>();
    let (mut ti, mut vi, mut star, mut star_vi) = (0usize, 0usize, None, 0usize);
    while vi < bytes.len() {
        match tokens.get(ti).copied() {
            Some('*') => {
                star = Some(ti);
                ti += 1;
                star_vi = vi;
            }
            Some('^') if !bytes[vi].is_alphanumeric() && !"_.%-".contains(bytes[vi]) => {
                ti += 1;
                vi += 1;
            }
            Some(token) if token == bytes[vi] => {
                ti += 1;
                vi += 1;
            }
            _ if star.is_some() => {
                ti = star.unwrap() + 1;
                star_vi += 1;
                vi = star_vi;
            }
            _ => return false,
        }
    }
    while matches!(tokens.get(ti), Some('^' | '*')) {
        if tokens[ti] == '^' && vi < bytes.len() {
            return false;
        }
        ti += 1;
    }
    ti == tokens.len()
}

fn is_builtin_tracker(host: &str) -> bool {
    const DOMAINS: &[&str] = &[
        "doubleclick.net",
        "googlesyndication.com",
        "google-analytics.com",
        "googletagmanager.com",
        "facebook.net",
        "connect.facebook.net",
        "hotjar.com",
        "segment.io",
        "mixpanel.com",
    ];
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    DOMAINS
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

fn strip_tracking_parameters(url: &mut reqwest::Url) -> bool {
    if url.query().is_none() {
        return false;
    }
    let pairs = url.query_pairs().collect::<Vec<_>>();
    let kept = pairs
        .iter()
        .filter(|(key, _)| !is_tracking_parameter(key))
        .map(|(key, value)| (key.as_ref().to_owned(), value.as_ref().to_owned()))
        .collect::<Vec<_>>();
    if kept.len() == pairs.len() {
        return false;
    }
    url.set_query(None);
    if !kept.is_empty() {
        url.query_pairs_mut().extend_pairs(kept);
    }
    true
}

fn is_tracking_parameter(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    (key.starts_with("utm_") && key.len() > 4)
        || matches!(
            key.as_str(),
            "fbclid" | "gclid" | "dclid" | "mc_cid" | "mc_eid" | "ref_src"
        )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct BrowserCgroupLimits {
    memory_bytes: u64,
    cpu_quota_us: u64,
    pids_max: u32,
}

fn browser_resource_limits_status(limits: Option<BrowserCgroupLimits>) -> Value {
    let Some(limits) = limits else {
        return json!({"enforced": false});
    };
    json!({
        "enforced": true,
        "memoryMb": limits.memory_bytes / (1024 * 1024),
        "cpuPercent": limits.cpu_quota_us / 1000,
        "processes": limits.pids_max
    })
}

struct BrowserCgroup {
    path: PathBuf,
    cleaned: bool,
}

impl BrowserCgroup {
    fn create_from_env() -> Result<Option<Self>, String> {
        let Some(root) = env::var_os("EYA_BROWSER_CGROUP_ROOT") else {
            return Ok(None);
        };
        let root = PathBuf::from(root);
        let root = root.canonicalize().map_err(
            |_| "EYA_BROWSER_CGROUP_ROOT must name an existing delegated cgroup v2 directory",
        )?;
        if !root.is_dir()
            || !root.join("cgroup.procs").is_file()
            || !root.join("cgroup.controllers").is_file()
            || !root.join("cgroup.subtree_control").is_file()
        {
            return Err("EYA_BROWSER_CGROUP_ROOT is not a delegated cgroup v2 directory".into());
        }
        let available = fs::read_to_string(root.join("cgroup.controllers"))
            .map_err(|_| "Could not read delegated cgroup controllers")?;
        for required in ["cpu", "memory", "pids"] {
            if !available
                .split_ascii_whitespace()
                .any(|value| value == required)
            {
                return Err(format!(
                    "Delegated cgroup v2 subtree does not expose the {required} controller"
                ));
            }
        }
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let path = root.join(format!(
            "eya-browser-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).map_err(|_| "Could not create a per-session browser cgroup")?;
        let scope = Self {
            path,
            cleaned: false,
        };
        if let Err(error) = scope.configure(configured_browser_cgroup_limits()) {
            let _ = fs::remove_dir(&scope.path);
            return Err(error);
        }
        Ok(Some(scope))
    }

    fn configure(&self, limits: BrowserCgroupLimits) -> Result<(), String> {
        for required in [
            "memory.max",
            "memory.oom.group",
            "cpu.max",
            "pids.max",
            "cgroup.procs",
            "cgroup.kill",
            "cgroup.events",
        ] {
            if !self.path.join(required).is_file() {
                return Err("The cgroup does not expose cpu, memory, pids, and group-kill controls; enable them in the delegated parent".into());
            }
        }
        write_cgroup_limits(&self.path, limits)
    }

    fn procs_path(&self) -> PathBuf {
        self.path.join("cgroup.procs")
    }

    async fn stop(&mut self) {
        if self.cleaned {
            return;
        }
        let _ = fs::write(self.path.join("cgroup.kill"), b"1");
        for _ in 0..40 {
            if fs::read_to_string(self.path.join("cgroup.events"))
                .ok()
                .is_some_and(|events| events.lines().any(|line| line.trim() == "populated 0"))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let _ = fs::remove_dir(&self.path);
        self.cleaned = true;
    }
}

impl Drop for BrowserCgroup {
    fn drop(&mut self) {
        if !self.cleaned {
            let _ = fs::write(self.path.join("cgroup.kill"), b"1");
            let path = self.path.clone();
            if std::thread::Builder::new()
                .name("eya-browser-cgroup-cleanup".into())
                .spawn(move || {
                    for _ in 0..80 {
                        if fs::read_to_string(path.join("cgroup.events"))
                            .ok()
                            .is_some_and(|events| {
                                events.lines().any(|line| line.trim() == "populated 0")
                            })
                        {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    let _ = fs::remove_dir(path);
                })
                .is_err()
            {
                let _ = fs::remove_dir(&self.path);
            }
        }
    }
}

fn write_cgroup_value(path: &Path, name: &str, value: &str) -> Result<(), String> {
    fs::write(path.join(name), value)
        .map_err(|_| format!("Could not configure browser cgroup {name}"))
}

fn write_cgroup_limits(path: &Path, limits: BrowserCgroupLimits) -> Result<(), String> {
    write_cgroup_value(path, "memory.max", &limits.memory_bytes.to_string())?;
    write_cgroup_value(path, "memory.oom.group", "1")?;
    write_cgroup_value(path, "cpu.max", &format!("{} 100000", limits.cpu_quota_us))?;
    write_cgroup_value(path, "pids.max", &limits.pids_max.to_string())?;
    Ok(())
}

fn browser_cgroup_limits(memory_mb: u32, cpu_percent: u32, pids_max: u32) -> BrowserCgroupLimits {
    BrowserCgroupLimits {
        memory_bytes: u64::from(memory_mb) * 1024 * 1024,
        cpu_quota_us: u64::from(cpu_percent) * 1000,
        pids_max,
    }
}

fn configured_browser_cgroup_limits() -> BrowserCgroupLimits {
    let memory_mb = configured_browser_limit("EYA_BROWSER_CGROUP_MEMORY_MB", 2048, 512, 8192);
    let cpu_percent = configured_browser_limit("EYA_BROWSER_CGROUP_CPU_PERCENT", 300, 50, 800);
    let pids_max = configured_browser_limit("EYA_BROWSER_CGROUP_PIDS", 128, 32, 512);
    browser_cgroup_limits(memory_mb, cpu_percent, pids_max)
}

/// Re-exec the browser from the helper child after moving that child into the
/// configured cgroup. Chromium then starts with every descendant in the scope.
pub fn cgroup_exec_requested() -> bool {
    env::args_os()
        .nth(1)
        .is_some_and(|arg| arg.as_os_str() == std::ffi::OsStr::new(CGROUP_EXEC_FLAG))
}

pub fn exec_browser_in_cgroup_from_args() -> Result<(), String> {
    let mut args = env::args_os().skip(2);
    let procs_path = PathBuf::from(args.next().ok_or("Missing browser cgroup.procs path")?);
    let error_path = PathBuf::from(
        args.next()
            .ok_or("Missing browser cgroup startup error path")?,
    );
    let executable = args.next().ok_or("Missing Chromium executable")?;
    if let Err(error) = fs::write(&procs_path, format!("{}\n", std::process::id())) {
        let message = format!("Could not move Chromium into its cgroup before startup: {error}");
        let _ = fs::write(error_path, &message);
        return Err(message);
    }
    let mut command = StdCommand::new(executable);
    command.args(args).env_clear();
    for name in ["HOME", "TMPDIR", "LANG", "PATH"] {
        if let Some(value) = env::var_os(name) {
            command.env(name, value);
        }
    }
    let error = command.exec();
    let message = format!("Could not exec Chromium inside its cgroup: {error}");
    let _ = fs::write(error_path, &message);
    Err(message)
}

struct RemoteBrowser {
    child: Child,
    _render_slot: tokio::sync::OwnedSemaphorePermit,
    _profile: Profile,
    cgroup: Option<BrowserCgroup>,
    download_dir: PathBuf,
    downloads_enabled: bool,
    proxy: Arc<Proxy>,
    egress: Option<browser_egress::Egress>,
    sink: CdpSink,
    session_id: String,
    initial_target_id: String,
    pages: std::collections::HashMap<String, RemotePage>,
    active_tab_id: Option<String>,
    events: Option<mpsc::Receiver<Value>>,
    reader: JoinHandle<()>,
    pending_commands: Arc<Mutex<std::collections::HashMap<u32, oneshot::Sender<Value>>>>,
    user_script_ids: Vec<String>,
    page_user_script_ids: std::collections::HashMap<String, Vec<String>>,
    extensions: Vec<LoadedExtension>,
    pending_extension_actions: std::collections::HashMap<String, tokio::time::Instant>,
    staged_upload_dirs: std::collections::HashMap<String, Vec<PathBuf>>,
    staged_upload_bytes: std::collections::HashMap<String, usize>,
    width: u32,
    height: u32,
    next_command_id: u32,
    privacy: RemotePrivacy,
    filters: RemoteFilterSet,
    debugger_enabled: bool,
    next_popup_id: u64,
}

struct RemotePage {
    target_id: String,
    session_id: String,
    url: String,
    main_frame_id: String,
}

#[derive(Default)]
struct RemotePageDevtoolsState {
    allowed_sources: std::collections::HashMap<String, String>,
    breakpoints: std::collections::HashSet<String>,
    call_frames: std::collections::HashSet<String>,
    remote_objects: std::collections::HashSet<String>,
    scopes: std::collections::HashMap<String, Vec<Value>>,
    paused_event: Option<Value>,
}

fn update_remote_page_debugger_event(state: &mut RemotePageDevtoolsState, event: &Value) {
    let method = event.get("method").and_then(Value::as_str).unwrap_or("");
    if method == "Debugger.paused" {
        state.paused_event = Some(event.clone());
        state.call_frames.clear();
        state.scopes.clear();
        if let Some(frames) = event
            .pointer("/params/callFrames")
            .and_then(Value::as_array)
        {
            state.call_frames.extend(
                frames
                    .iter()
                    .filter_map(|frame| frame.get("callFrameId").and_then(Value::as_str))
                    .filter(|id| !id.is_empty() && id.len() <= 256)
                    .map(str::to_owned),
            );
            for frame in frames.iter().take(32) {
                let Some(frame_id) = frame.get("callFrameId").and_then(Value::as_str) else {
                    continue;
                };
                if state.call_frames.contains(frame_id) {
                    state
                        .scopes
                        .insert(frame_id.to_owned(), compact_debugger_scopes(frame));
                }
            }
        }
    } else if method == "Debugger.resumed" {
        state.paused_event = None;
        state.call_frames.clear();
        state.scopes.clear();
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemotePrivacy {
    block_trackers: bool,
    block_third_party: bool,
    strip_tracking: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrivacySettings {
    #[serde(default)]
    block_trackers: bool,
    #[serde(default)]
    block_third_party: bool,
    #[serde(default)]
    strip_tracking: bool,
}

impl From<PrivacySettings> for RemotePrivacy {
    fn from(settings: PrivacySettings) -> Self {
        Self {
            block_trackers: settings.block_trackers,
            block_third_party: settings.block_third_party,
            strip_tracking: settings.strip_tracking,
        }
    }
}

impl RemoteBrowser {
    async fn start(
        proxy: Arc<Proxy>,
        render_slot: tokio::sync::OwnedSemaphorePermit,
    ) -> Result<Self, String> {
        let profile =
            Profile::create().map_err(|_| "Could not create an isolated browser profile")?;
        let cgroup = BrowserCgroup::create_from_env()?;
        let mut egress = browser_egress::start(proxy.clone())
            .await
            .map_err(|_| "Could not start the validated browser egress listener")?;
        let executable = chromium_executable()?;
        let headless_shell = is_chrome_headless_shell(&executable);
        let mut command = if let Some(cgroup) = &cgroup {
            let current_exe = env::current_exe().map_err(
                |_| "Could not locate the Eya server executable for browser cgroup startup",
            )?;
            let mut helper = Command::new(current_exe);
            helper
                .arg(CGROUP_EXEC_FLAG)
                .arg(cgroup.procs_path())
                .arg(profile.0.join("cgroup-start-error"))
                .arg(executable);
            helper
        } else {
            Command::new(executable)
        };
        if !headless_shell {
            command.arg("--headless=new");
        }
        command
            .arg("--remote-debugging-port=0")
            .arg(format!("--user-data-dir={}", profile.0.display()))
            .args(chromium_network_args(egress.address))
            .arg("--disable-quic")
            .arg("--force-webrtc-ip-handling-policy=disable_non_proxied_udp")
            .args(configured_chromium_graphics_args())
            .args(configured_chromium_resource_args())
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--disable-background-networking")
            .arg("--disable-component-update")
            .arg("--disable-sync")
            .arg("--metrics-recording-only")
            .arg("about:blank")
            .current_dir(&profile.0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .env_clear()
            .env("HOME", &profile.0)
            .env("TMPDIR", &profile.0)
            .env("LANG", "C.UTF-8");
        if let Some(path) = env::var_os("PATH") {
            command.env("PATH", path);
        }
        let mut child = command
            .spawn()
            .map_err(|_| "Could not launch Chromium; configure EYA_BROWSER_CHROMIUM")?;
        let active_port = match wait_for_devtools_port(&profile.0, &mut child).await {
            Ok(value) => value,
            Err(error) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                egress.stop().await;
                return Err(error);
            }
        };
        let ws_url = format!(
            "ws://127.0.0.1:{}/{}",
            active_port.0,
            active_port.1.trim_start_matches('/')
        );
        let mut cdp_config = WebSocketConfig::default();
        cdp_config.max_message_size = Some(MAX_FRAME_BYTES * 2);
        cdp_config.max_frame_size = Some(MAX_FRAME_BYTES * 2);
        let (mut cdp, _) = timeout(
            Duration::from_secs(8),
            connect_async_with_config(&ws_url, Some(cdp_config), false),
        )
        .await
        .map_err(|_| "Timed out connecting to Chromium DevTools")?
        .map_err(|_| "Could not connect to Chromium DevTools")?;
        let target = cdp_command(
            &mut cdp,
            None,
            1,
            "Target.createTarget",
            json!({"url":"about:blank"}),
        )
        .await?;
        let target_id = target
            .pointer("/result/targetId")
            .and_then(Value::as_str)
            .ok_or("Chromium did not create a page")?
            .to_owned();
        let attached = cdp_command(
            &mut cdp,
            None,
            2,
            "Target.attachToTarget",
            json!({"targetId":target_id.clone(),"flatten":true}),
        )
        .await?;
        let session_id = attached
            .pointer("/result/sessionId")
            .and_then(Value::as_str)
            .ok_or("Chromium did not attach a page")?
            .to_owned();
        let download_dir = profile.0.join("downloads");
        tokio::fs::create_dir(&download_dir)
            .await
            .map_err(|_| "Could not create the private browser download directory")?;
        let downloads_enabled = cdp_command(
            &mut cdp,
            None,
            3,
            "Browser.setDownloadBehavior",
            json!({"behavior":"allowAndName","downloadPath":download_dir,"eventsEnabled":true}),
        )
        .await
        .is_ok();
        let mut id = 4;
        for (method, params) in [
            ("Page.enable", json!({"enableFileChooserOpenedEvent":true})),
            ("Runtime.enable", json!({})),
            ("Network.enable", json!({})),
            (
                "Fetch.enable",
                json!({"patterns":[{"urlPattern":"*","requestStage":"Request"}]}),
            ),
            (
                "Emulation.setDeviceMetricsOverride",
                json!({"width":DEFAULT_WIDTH,"height":DEFAULT_HEIGHT,"deviceScaleFactor":1,"mobile":false}),
            ),
        ] {
            cdp_command(&mut cdp, Some(&session_id), id, method, params).await?;
            id += 1;
        }
        cdp_command(
            &mut cdp,
            Some(&session_id),
            id,
            "Page.setInterceptFileChooserDialog",
            json!({"enabled":true}),
        )
        .await?;
        id += 1;
        if !downloads_enabled {
            cdp_command(
                &mut cdp,
                Some(&session_id),
                id,
                "Page.setDownloadBehavior",
                json!({"behavior":"deny"}),
            )
            .await?;
            id += 1;
        }
        cdp_command(
            &mut cdp,
            None,
            id,
            "Target.setDiscoverTargets",
            json!({"discover":true}),
        )
        .await?;
        id += 1;
        let (sink, mut stream) = cdp.split();
        let (event_tx, events) = mpsc::channel(128);
        let pending_commands = Arc::new(Mutex::new(std::collections::HashMap::<
            u32,
            oneshot::Sender<Value>,
        >::new()));
        let pending_responses = pending_commands.clone();
        let reader = tokio::spawn(async move {
            while let Some(message) = stream.next().await {
                let Ok(message) = message else { break };
                match message {
                    CdpMessage::Text(text) => {
                        if let Ok(event) = serde_json::from_str::<Value>(&text) {
                            let method = event.get("method").and_then(Value::as_str).unwrap_or("");
                            if let Some(id) = event.get("id").and_then(Value::as_u64) {
                                if let Some(sender) =
                                    pending_responses.lock().await.remove(&(id as u32))
                                {
                                    let _ = sender.send(event);
                                    continue;
                                }
                            }
                            let is_frame = method == "Page.screencastFrame";
                            let is_control = event.get("id").is_some()
                                || method == "Fetch.requestPaused"
                                || method == "Browser.downloadWillBegin"
                                || method == "Browser.downloadProgress"
                                || method == "Page.fileChooserOpened"
                                || method == "Target.targetCreated"
                                || method == "Target.targetInfoChanged"
                                || method == "Target.targetDestroyed";
                            let debug_event = is_debug_event(&event)
                                .then(|| client_debug_event(&event))
                                .flatten();
                            if is_frame || is_control {
                                if event_tx.send(event).await.is_err() {
                                    break;
                                }
                            } else if let Some(debug_event) = debug_event {
                                let _ = event_tx.try_send(debug_event);
                            }
                        }
                    }
                    CdpMessage::Ping(_) => {}
                    CdpMessage::Close(_) => break,
                    _ => {}
                }
            }
        });
        let mut browser = Self {
            child,
            _render_slot: render_slot,
            _profile: profile,
            cgroup,
            download_dir,
            downloads_enabled,
            proxy,
            egress: Some(egress),
            sink,
            session_id,
            initial_target_id: target_id,
            pages: std::collections::HashMap::new(),
            active_tab_id: None,
            events: Some(events),
            reader,
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            next_command_id: id,
            pending_commands,
            user_script_ids: Vec::new(),
            page_user_script_ids: std::collections::HashMap::new(),
            extensions: Vec::new(),
            pending_extension_actions: std::collections::HashMap::new(),
            staged_upload_dirs: std::collections::HashMap::new(),
            staged_upload_bytes: std::collections::HashMap::new(),
            privacy: RemotePrivacy {
                block_trackers: true,
                block_third_party: false,
                strip_tracking: true,
            },
            filters: RemoteFilterSet::default(),
            debugger_enabled: false,
            next_popup_id: 0,
        };
        browser
            .send(
                "Page.startScreencast",
                json!({
                    "format":"jpeg","quality":60,
                    "maxWidth":DEFAULT_WIDTH,"maxHeight":DEFAULT_HEIGHT,
                    "everyNthFrame":1,"maxFramesInFlight":1
                }),
            )
            .await?;
        Ok(browser)
    }

    fn take_events(&mut self) -> mpsc::Receiver<Value> {
        self.events
            .take()
            .expect("remote browser events already taken")
    }

    async fn activate_tab(&mut self, tab_id: &str) -> Result<(String, String), String> {
        if !valid_remote_tab_id(tab_id) {
            return Err("Remote tab id is invalid".into());
        }
        if self.active_tab_id.as_deref() == Some(tab_id) {
            let page = self
                .pages
                .get(tab_id)
                .expect("active remote page is present");
            return Ok((page.url.clone(), page.main_frame_id.clone()));
        }
        if self.pages.is_empty() && !self.initial_target_id.is_empty() {
            self.pages.insert(
                tab_id.to_owned(),
                RemotePage {
                    target_id: self.initial_target_id.clone(),
                    session_id: self.session_id.clone(),
                    url: String::new(),
                    main_frame_id: String::new(),
                },
            );
            self.active_tab_id = Some(tab_id.to_owned());
            self.ensure_active_main_frame_id().await;
            let page = self.pages.get(tab_id).expect("activated page is present");
            return Ok((page.url.clone(), page.main_frame_id.clone()));
        }
        if !self.pages.contains_key(tab_id) && self.pages.len() >= MAX_REMOTE_TABS {
            return Err(format!(
                "Full browser is limited to {MAX_REMOTE_TABS} live tabs"
            ));
        }

        if let Some(current_id) = self.active_tab_id.take() {
            let _ = self.send_and_wait("Page.stopScreencast", json!({})).await;
            self.page_user_script_ids
                .insert(current_id, std::mem::take(&mut self.user_script_ids));
        }

        let (session_id, created) = if let Some(page) = self.pages.get(tab_id) {
            (page.session_id.clone(), false)
        } else {
            let response = self
                .send_root_and_wait("Target.createTarget", json!({"url":"about:blank"}))
                .await?;
            let target_id = response
                .pointer("/result/targetId")
                .and_then(Value::as_str)
                .ok_or("Chromium did not create a page target")?
                .to_owned();
            let response = self
                .send_root_and_wait(
                    "Target.attachToTarget",
                    json!({"targetId":target_id,"flatten":true}),
                )
                .await?;
            let session_id = response
                .pointer("/result/sessionId")
                .and_then(Value::as_str)
                .ok_or("Chromium did not attach the browser tab")?
                .to_owned();
            self.pages.insert(
                tab_id.to_owned(),
                RemotePage {
                    target_id: target_id.clone(),
                    session_id: session_id.clone(),
                    url: String::new(),
                    main_frame_id: String::new(),
                },
            );
            (session_id, true)
        };
        self.session_id = session_id;
        self.active_tab_id = Some(tab_id.to_owned());
        self.user_script_ids = self.page_user_script_ids.remove(tab_id).unwrap_or_default();
        self.debugger_enabled = false;
        if created {
            for (method, params) in [
                ("Page.enable", json!({"enableFileChooserOpenedEvent":true})),
                ("Runtime.enable", json!({})),
                ("Network.enable", json!({})),
                (
                    "Fetch.enable",
                    json!({"patterns":[{"urlPattern":"*","requestStage":"Request"}]}),
                ),
            ] {
                self.send_and_wait(method, params).await?;
            }
            self.send_and_wait(
                "Page.setInterceptFileChooserDialog",
                json!({"enabled":true}),
            )
            .await?;
        }
        self.send_and_wait(
            "Emulation.setDeviceMetricsOverride",
            json!({"width":self.width,"height":self.height,"deviceScaleFactor":1,"mobile":false}),
        )
        .await?;
        if !self.downloads_enabled {
            let _ = self
                .send_and_wait("Page.setDownloadBehavior", json!({"behavior":"deny"}))
                .await;
        }
        self.ensure_active_main_frame_id().await;
        self.send_and_wait(
            "Page.startScreencast",
            json!({
                "format":"jpeg","quality":60,
                "maxWidth":self.width,"maxHeight":self.height,
                "everyNthFrame":1,"maxFramesInFlight":1
            }),
        )
        .await?;
        let page = self.pages.get(tab_id).expect("activated page is present");
        Ok((page.url.clone(), page.main_frame_id.clone()))
    }

    async fn close_tab(&mut self, tab_id: &str) -> Result<(), String> {
        if !valid_remote_tab_id(tab_id) {
            return Err("Remote tab id is invalid".into());
        }
        let Some(page) = self.pages.remove(tab_id) else {
            return Ok(());
        };
        self.clear_staged_uploads(tab_id).await;
        if page.target_id == self.initial_target_id {
            self.initial_target_id.clear();
        }
        self.page_user_script_ids.remove(tab_id);
        if self.active_tab_id.as_deref() == Some(tab_id) {
            let _ = self.send_and_wait("Page.stopScreencast", json!({})).await;
            self.active_tab_id = None;
            self.user_script_ids.clear();
        }
        self.send_root_and_wait("Target.closeTarget", json!({"targetId":page.target_id}))
            .await
            .map(|_| ())
    }

    fn active_tab_id(&self) -> Option<&str> {
        self.active_tab_id.as_deref()
    }

    fn tab_id_for_session(&self, session_id: &str) -> Option<&str> {
        self.pages
            .iter()
            .find_map(|(tab_id, page)| (page.session_id == session_id).then_some(tab_id.as_str()))
    }

    fn tab_id_for_target(&self, target_id: &str) -> Option<&str> {
        self.pages
            .iter()
            .find_map(|(tab_id, page)| (page.target_id == target_id).then_some(tab_id.as_str()))
    }

    fn remove_destroyed_target(&mut self, target_id: &str) -> Option<(String, bool)> {
        let tab_id = self.tab_id_for_target(target_id)?.to_owned();
        self.pages.remove(&tab_id)?;
        let was_active = self.active_tab_id.as_deref() == Some(tab_id.as_str());
        if was_active {
            self.active_tab_id = None;
            self.user_script_ids.clear();
        }
        self.page_user_script_ids.remove(&tab_id);
        Some((tab_id, was_active))
    }

    async fn attach_popup(
        &mut self,
        target_id: &str,
        raw_url: &str,
    ) -> Result<(String, String), String> {
        let url = validated_popup_url(raw_url)?;
        self.attach_popup_target(target_id, url).await
    }

    async fn attach_extension_popup(
        &mut self,
        target_id: &str,
        raw_url: &str,
        extension_id: &str,
    ) -> Result<(String, String), String> {
        let url = validated_extension_popup_url(raw_url, extension_id)?;
        self.attach_popup_target(target_id, url).await
    }

    async fn attach_popup_target(
        &mut self,
        target_id: &str,
        url: String,
    ) -> Result<(String, String), String> {
        if self.pages.len() >= MAX_REMOTE_TABS {
            return Err(format!(
                "Full browser is limited to {MAX_REMOTE_TABS} live tabs"
            ));
        }
        let attached = self
            .send_root_and_wait(
                "Target.attachToTarget",
                json!({"targetId":target_id,"flatten":true}),
            )
            .await?;
        let session_id = attached
            .pointer("/result/sessionId")
            .and_then(Value::as_str)
            .ok_or("Chromium did not attach the popup target")?
            .to_owned();
        self.next_popup_id = self.next_popup_id.wrapping_add(1).max(1);
        let tab_id = format!("eya-popup-{}", self.next_popup_id);
        self.pages.insert(
            tab_id.clone(),
            RemotePage {
                target_id: target_id.to_owned(),
                session_id: session_id.clone(),
                url: url.clone(),
                main_frame_id: String::new(),
            },
        );
        let previous_session = std::mem::replace(&mut self.session_id, session_id);
        let configured = async {
            for (method, params) in [
                ("Page.enable", json!({"enableFileChooserOpenedEvent":true})),
                ("Runtime.enable", json!({})),
                ("Network.enable", json!({})),
                (
                    "Fetch.enable",
                    json!({"patterns":[{"urlPattern":"*","requestStage":"Request"}]}),
                ),
                (
                    "Emulation.setDeviceMetricsOverride",
                    json!({"width":self.width,"height":self.height,"deviceScaleFactor":1,"mobile":false}),
                ),
            ] {
                self.send_and_wait(method, params).await?;
            }
            self.send_and_wait("Page.setInterceptFileChooserDialog", json!({"enabled":true}))
                .await?;
            if !self.downloads_enabled {
                let _ = self
                    .send_and_wait("Page.setDownloadBehavior", json!({"behavior":"deny"}))
                    .await;
            }
            let frame_tree = self.send_and_wait("Page.getFrameTree", json!({})).await?;
            let frame_id = frame_tree
                .pointer("/result/frameTree/frame/id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            if let Some(page) = self.pages.get_mut(&tab_id) {
                page.main_frame_id = frame_id;
            }
            Ok::<(), String>(())
        }
        .await;
        self.session_id = previous_session;
        if let Err(error) = configured {
            self.pages.remove(&tab_id);
            let _ = self
                .send_root_and_wait("Target.closeTarget", json!({"targetId":target_id}))
                .await;
            return Err(error);
        }
        Ok((tab_id, url))
    }

    fn page_context_for_session(&self, session_id: &str) -> Option<(String, String, String)> {
        self.pages.iter().find_map(|(tab_id, page)| {
            (page.session_id == session_id)
                .then(|| (tab_id.clone(), page.url.clone(), page.main_frame_id.clone()))
        })
    }

    fn main_frame_id_for_tab(&self, tab_id: &str) -> Option<&str> {
        self.pages
            .get(tab_id)
            .map(|page| page.main_frame_id.as_str())
    }

    fn page_url_for_tab(&self, tab_id: &str) -> Option<&str> {
        self.pages.get(tab_id).map(|page| page.url.as_str())
    }

    fn record_frame_for_session(&mut self, session_id: &str, url: &str, frame_id: &str) {
        if let Some(page) = self
            .pages
            .values_mut()
            .find(|page| page.session_id == session_id)
        {
            page.url = url.to_owned();
            page.main_frame_id = frame_id.to_owned();
        }
    }

    async fn ensure_active_main_frame_id(&mut self) {
        let needs_frame_id = self
            .active_tab_id
            .as_deref()
            .and_then(|id| self.pages.get(id))
            .is_some_and(|page| page.main_frame_id.is_empty());
        if !needs_frame_id {
            return;
        }
        let frame_id = self
            .send_and_wait("Page.getFrameTree", json!({}))
            .await
            .ok()
            .and_then(|response| {
                response
                    .pointer("/result/frameTree/frame/id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        if let (Some(tab_id), Some(frame_id)) = (self.active_tab_id.clone(), frame_id)
            && let Some(page) = self.pages.get_mut(&tab_id)
        {
            page.main_frame_id = frame_id;
        }
    }

    fn record_main_frame(&mut self, url: &str, frame_id: &str) {
        if let Some(page) = self
            .active_tab_id
            .as_deref()
            .and_then(|id| self.pages.get_mut(id))
        {
            page.url = url.to_owned();
            page.main_frame_id = frame_id.to_owned();
        }
    }

    fn record_url_for_tab(&mut self, tab_id: &str, url: &str) {
        if let Some(page) = self.pages.get_mut(tab_id) {
            page.url = url.to_owned();
        }
    }

    async fn navigation_history_for_tab(&mut self, tab_id: &str) -> Result<Value, String> {
        let Some(page) = self.pages.get(tab_id) else {
            return Err("Remote browser tab is no longer open".into());
        };
        let page_session = page.session_id.clone();
        let previous_session = std::mem::replace(&mut self.session_id, page_session);
        let result = self
            .send_and_wait("Page.getNavigationHistory", json!({}))
            .await;
        self.session_id = previous_session;
        compact_navigation_history(&result?)
    }

    async fn navigate_history(&mut self, tab_id: &str, delta: i32) -> Result<(), String> {
        let Some(page) = self.pages.get(tab_id) else {
            return Err("Remote browser tab is no longer open".into());
        };
        let page_session = page.session_id.clone();
        let previous_session = std::mem::replace(&mut self.session_id, page_session);
        let result = async {
            let history = self
                .send_and_wait("Page.getNavigationHistory", json!({}))
                .await?;
            let entries = history
                .pointer("/result/entries")
                .and_then(Value::as_array)
                .ok_or("Chromium returned no navigation history")?;
            let current = history
                .pointer("/result/currentIndex")
                .and_then(Value::as_i64)
                .ok_or("Chromium returned an invalid history position")?;
            let target = current.saturating_add(i64::from(delta));
            if target < 0 || target >= entries.len() as i64 {
                return Err("There is no earlier or later page in this tab".into());
            }
            let entry_id = entries[target as usize]
                .get("id")
                .and_then(Value::as_i64)
                .ok_or("Chromium returned an invalid history entry")?;
            self.send_and_wait("Page.navigateToHistoryEntry", json!({"entryId":entry_id}))
                .await?;
            Ok(())
        }
        .await;
        self.session_id = previous_session;
        result
    }

    async fn navigate(&mut self, tab_id: &str, raw: &str) -> Result<(), String> {
        self.activate_tab(tab_id).await?;
        let url = validated_navigation_url(raw)?;
        self.clear_staged_uploads(tab_id).await;
        if let Some(page) = self.pages.get_mut(tab_id) {
            page.url = url.as_str().to_owned();
        }
        self.send("Page.navigate", json!({"url":url.as_str()}))
            .await
            .map(|_| ())
    }

    async fn clear_staged_uploads(&mut self, tab_id: &str) {
        if let Some(directories) = self.staged_upload_dirs.remove(tab_id) {
            for directory in directories {
                let _ = tokio::fs::remove_dir_all(directory).await;
            }
        }
        self.staged_upload_bytes.remove(tab_id);
    }

    async fn set_page_file_input(
        &mut self,
        tab_id: &str,
        backend_node_id: i64,
        upload: PageFileUpload,
    ) -> Result<(), String> {
        if self.active_tab_id.as_deref() != Some(tab_id) || backend_node_id <= 0 {
            let _ = tokio::fs::remove_dir_all(&upload.root).await;
            return Err("The page file chooser is no longer active".into());
        }
        let files = upload
            .files
            .iter()
            .enumerate()
            .map(|(index, file)| upload.root.join(index.to_string()).join(&file.name))
            .collect::<Vec<_>>();
        use tokio::io::AsyncWriteExt;
        let mut upload = upload;
        for writer in &mut upload.writers {
            if writer.flush().await.is_err() {
                let _ = tokio::fs::remove_dir_all(&upload.root).await;
                return Err("Could not finish writing the selected files".into());
            }
        }
        let result = self
            .send_and_wait(
                "DOM.setFileInputFiles",
                json!({"files":files,"backendNodeId":backend_node_id}),
            )
            .await;
        match result {
            Ok(_) => {
                self.staged_upload_bytes
                    .entry(tab_id.to_owned())
                    .and_modify(|bytes| *bytes = bytes.saturating_add(upload.total_bytes))
                    .or_insert(upload.total_bytes);
                self.staged_upload_dirs
                    .entry(tab_id.to_owned())
                    .or_default()
                    .push(upload.root);
                Ok(())
            }
            Err(_) => {
                let _ = tokio::fs::remove_dir_all(&upload.root).await;
                Err("Chromium could not assign the selected files to the page".into())
            }
        }
    }

    async fn resize(&mut self, width: u32, height: u32) -> Result<(), String> {
        self.width = width.clamp(320, MAX_WIDTH);
        self.height = height.clamp(240, MAX_HEIGHT);
        self.send(
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width":self.width,"height":self.height,"deviceScaleFactor":1,"mobile":false
            }),
        )
        .await
        .map(|_| ())
    }

    async fn input(&mut self, input: Input) -> Result<(), String> {
        input.validate()?;
        if input.group == "text" {
            return self
                .send("Input.insertText", json!({"text":input.text}))
                .await
                .map(|_| ());
        }
        if input.group == "touch" {
            let points = input
                .touch_points
                .iter()
                .map(|point| {
                    json!({
                        "id":point.id,
                        "x":point.x.clamp(0.0, self.width as f64),
                        "y":point.y.clamp(0.0, self.height as f64),
                        "force":point.force,
                        "radiusX":point.radius_x,
                        "radiusY":point.radius_y,
                    })
                })
                .collect::<Vec<_>>();
            return self
                .send(
                    "Input.dispatchTouchEvent",
                    json!({"type":input.action,"touchPoints":points,"modifiers":input.modifiers}),
                )
                .await
                .map(|_| ());
        }
        match input.action.as_str() {
            "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel" => {
                let mut params = json!({
                    "type":input.action,
                    "x":input.x.clamp(0.0, self.width as f64),
                    "y":input.y.clamp(0.0, self.height as f64),
                    "modifiers":input.modifiers,
                });
                if !input.button.is_empty() {
                    params["button"] = json!(input.button);
                }
                params["buttons"] = json!(input.buttons);
                if input.click_count > 0 {
                    params["clickCount"] = json!(input.click_count.clamp(1, 2));
                }
                if input.action == "mouseWheel" {
                    params["deltaX"] = json!(input.delta_x.clamp(-2000.0, 2000.0));
                    params["deltaY"] = json!(input.delta_y.clamp(-2000.0, 2000.0));
                }
                self.send("Input.dispatchMouseEvent", params)
                    .await
                    .map(|_| ())
            }
            "keyDown" | "keyUp" | "char" => {
                let mut params = json!({"type":input.action,"modifiers":input.modifiers});
                if !input.key.is_empty() {
                    params["key"] = json!(input.key);
                }
                if !input.code.is_empty() {
                    params["code"] = json!(input.code);
                }
                if !input.text.is_empty() {
                    params["text"] = json!(input.text);
                }
                if !input.unmodified_text.is_empty() {
                    params["unmodifiedText"] = json!(input.unmodified_text);
                }
                if input.key_code != 0 {
                    params["windowsVirtualKeyCode"] = json!(input.key_code.clamp(0, 0xffff));
                }
                self.send("Input.dispatchKeyEvent", params)
                    .await
                    .map(|_| ())
            }
            _ => Err("Unsupported input event".into()),
        }
    }

    async fn ack_frame(&mut self, cdp_frame: u32) {
        let _ = self
            .send("Page.screencastFrameAck", json!({"sessionId":cdp_frame}))
            .await;
    }

    async fn ack_frame_for_session(&mut self, page_session: &str, cdp_frame: u32) {
        let previous_session = std::mem::replace(&mut self.session_id, page_session.to_owned());
        self.ack_frame(cdp_frame).await;
        self.session_id = previous_session;
    }

    async fn evaluate(&mut self, expression: &str) -> Result<u32, String> {
        if expression.is_empty() || expression.len() > MAX_CONSOLE_EXPRESSION_BYTES {
            return Err("Console expression is empty or exceeds 16 KiB".into());
        }
        self.send(
            "Runtime.evaluate",
            json!({
                "expression":expression,
                "returnByValue":false,
                "awaitPromise":true,
                "userGesture":false,
                "timeout":5000
            }),
        )
        .await
    }

    async fn evaluate_on_call_frame(
        &mut self,
        expression: &str,
        call_frame_id: &str,
    ) -> Result<u32, String> {
        if expression.is_empty()
            || expression.len() > MAX_CONSOLE_EXPRESSION_BYTES
            || call_frame_id.is_empty()
            || call_frame_id.len() > 256
        {
            return Err("Console expression or selected call frame is invalid".into());
        }
        self.send(
            "Debugger.evaluateOnCallFrame",
            json!({
                "callFrameId":call_frame_id,
                "expression":expression,
                "returnByValue":false,
                "awaitPromise":true,
                "silent":false,
                "throwOnSideEffect":false
            }),
        )
        .await
    }

    async fn get_object_properties(&mut self, object_id: &str) -> Result<Value, String> {
        if object_id.is_empty() || object_id.len() > 512 {
            return Err("Remote object id is invalid".into());
        }
        self.send_and_wait(
            "Runtime.getProperties",
            json!({
                "objectId":object_id,
                "ownProperties":true,
                "accessorPropertiesOnly":false,
                "generatePreview":false,
                "nonIndexedPropertiesOnly":false
            }),
        )
        .await
    }

    async fn debugger_command(
        &mut self,
        action: &str,
        request: Value,
        breakpoints: &std::collections::HashSet<String>,
        allowed_sources: &std::collections::HashMap<String, String>,
    ) -> Result<Value, String> {
        if !self.debugger_enabled {
            self.send_and_wait("Debugger.enable", json!({"maxScriptsCacheSize":4_194_304}))
                .await?;
            self.debugger_enabled = true;
        }
        let (method, params) =
            debugger_cdp_command(action, &request, breakpoints, allowed_sources)?;
        self.send_and_wait(method, params).await
    }

    async fn continue_or_reject_request(
        &mut self,
        event: &Value,
        page_url: &str,
        main_frame_id: &str,
    ) -> Option<(Option<String>, String, String)> {
        let params = &event["params"];
        let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
            return None;
        };
        let raw_url = params
            .get("request")
            .and_then(|v| v.get("url"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let Some(mut url) = reqwest::Url::parse(raw_url).ok() else {
            self.fail_request(request_id).await;
            return Some((
                params
                    .get("networkId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                raw_url.to_owned(),
                "invalid-url".into(),
            ));
        };
        let request_scheme = url.scheme().to_owned();
        if request_scheme == "chrome-extension" {
            if self.extensions.iter().any(|extension| {
                extension_id_from_url(raw_url).as_deref() == Some(extension.id.as_str())
            }) {
                let _ = self.continue_request(request_id, None).await;
                return None;
            }
            self.fail_request(request_id).await;
            return Some((
                params
                    .get("networkId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                raw_url.to_owned(),
                "extension-origin".into(),
            ));
        }
        match url.scheme() {
            "http" | "https" => {}
            "ws" => {
                let _ = url.set_scheme("http");
            }
            "wss" => {
                let _ = url.set_scheme("https");
            }
            "data" | "blob" => {
                let _ = self.continue_request(request_id, None).await;
                return None;
            }
            "about" if matches!(url.as_str(), "about:blank" | "about:srcdoc") => {
                let _ = self.continue_request(request_id, None).await;
                return None;
            }
            _ => {
                self.fail_request(request_id).await;
                return Some((
                    params
                        .get("networkId")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    raw_url.to_owned(),
                    "scheme".into(),
                ));
            }
        }
        let page = reqwest::Url::parse(page_url).ok();
        let is_main_document = params["resourceType"] == "Document"
            && !main_frame_id.is_empty()
            && params["frameId"].as_str() == Some(main_frame_id);
        let resource_type = match params["resourceType"].as_str().unwrap_or("Other") {
            "Script" => "script",
            "Image" => "image",
            "Stylesheet" => "stylesheet",
            "Media" => "media",
            "Font" => "font",
            "XHR" | "Fetch" => "xmlhttprequest",
            "Object" => "object",
            "Document" if !is_main_document => "subdocument",
            "Document" => "document",
            "Ping" => "ping",
            "WebSocket" => "websocket",
            _ => "other",
        };
        let reason = privacy_block_reason(
            self.privacy,
            &url,
            page.as_ref(),
            is_main_document,
            &self.filters,
            resource_type,
        );
        if let Some(reason) = reason {
            self.fail_request(request_id).await;
            return Some((
                params
                    .get("networkId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                raw_url.to_owned(),
                reason.to_owned(),
            ));
        }
        let mut rewrite_url = None;
        if self.privacy.strip_tracking && strip_tracking_parameters(&mut url) {
            let mut rewritten = url.clone();
            match request_scheme.as_str() {
                "ws" => {
                    let _ = rewritten.set_scheme("ws");
                }
                "wss" => {
                    let _ = rewritten.set_scheme("wss");
                }
                _ => {}
            }
            rewrite_url = Some(rewritten.as_str().to_owned());
        }
        if !matches!(url.port_or_known_default(), Some(80 | 443))
            || self.proxy.websocket_targets(&url).await.is_err()
        {
            self.fail_request(request_id).await;
            return Some((
                params
                    .get("networkId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                raw_url.to_owned(),
                "server-policy".into(),
            ));
        }
        let _ = self
            .continue_request(request_id, rewrite_url.as_deref())
            .await;
        None
    }

    async fn continue_request(
        &mut self,
        request_id: &str,
        url: Option<&str>,
    ) -> Result<(), String> {
        let mut params = json!({"requestId":request_id});
        if let Some(url) = url {
            params["url"] = json!(url);
        }
        self.send("Fetch.continueRequest", params).await.map(|_| ())
    }

    async fn fail_request(&mut self, request_id: &str) {
        let _ = self
            .send(
                "Fetch.failRequest",
                json!({"requestId":request_id,"errorReason":"BlockedByClient"}),
            )
            .await;
    }

    async fn fail_paused_request_for_session(&mut self, session_id: &str, event: &Value) {
        let Some(request_id) = event.pointer("/params/requestId").and_then(Value::as_str) else {
            return;
        };
        let previous_session = std::mem::replace(&mut self.session_id, session_id.to_owned());
        self.fail_request(request_id).await;
        self.session_id = previous_session;
    }

    async fn install_extension(
        &mut self,
        upload: ExtensionUpload,
    ) -> Result<LoadedExtension, &'static str> {
        if let Err(error) = validate_extension_capacity(
            self.extensions.len(),
            self.extensions
                .iter()
                .map(|extension| extension.bytes)
                .sum(),
            upload.total_bytes,
        ) {
            let _ = tokio::fs::remove_dir_all(&upload.root).await;
            return Err(error);
        }
        let manifest_path = upload.root.join("manifest.json");
        let manifest = match tokio::fs::read(&manifest_path).await {
            Ok(bytes) => bytes,
            Err(_) => {
                let _ = tokio::fs::remove_dir_all(&upload.root).await;
                return Err("Could not read extension manifest");
            }
        };
        let manifest = match validate_extension_manifest(&manifest) {
            Ok(manifest) => manifest,
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&upload.root).await;
                return Err(error);
            }
        };
        let extension_path = upload.root.to_string_lossy().into_owned();
        let response = match self
            .send_root_and_wait("Extensions.loadUnpacked", json!({"path":extension_path}))
            .await
        {
            Ok(response) => response,
            Err(_) => {
                let _ = tokio::fs::remove_dir_all(&upload.root).await;
                return Err(
                    "Chromium could not load this unpacked extension (the Extensions CDP API may be unavailable)",
                );
            }
        };
        let Some(id) = response
            .pointer("/result/id")
            .and_then(Value::as_str)
            .filter(|id| id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte)))
        else {
            let _ = tokio::fs::remove_dir_all(&upload.root).await;
            return Err("Chromium loaded the extension without returning a valid extension id");
        };
        let extension = LoadedExtension {
            id: id.to_owned(),
            name: manifest.name,
            has_action: manifest.has_action,
            directory: upload.root,
            bytes: upload.total_bytes,
        };
        self.extensions.push(extension.clone());
        Ok(extension)
    }

    async fn remove_extension(&mut self, extension_id: &str) -> Result<(), &'static str> {
        let Some(index) = self
            .extensions
            .iter()
            .position(|extension| extension.id == extension_id)
        else {
            return Err("Extension is not installed in this browser session");
        };
        self.send_root_and_wait("Extensions.uninstall", json!({"id":extension_id}))
            .await
            .map_err(|_| "Chromium could not uninstall this extension")?;
        let extension = self.extensions.remove(index);
        let _ = tokio::fs::remove_dir_all(extension.directory).await;
        Ok(())
    }

    async fn trigger_extension_action(
        &mut self,
        extension_id: &str,
        tab_id: &str,
    ) -> Result<(), &'static str> {
        if !valid_remote_tab_id(tab_id) {
            return Err("Remote tab id is invalid");
        }
        let extension = self
            .extensions
            .iter()
            .find(|extension| extension.id == extension_id)
            .ok_or("Extension is not installed in this browser session")?;
        if !extension.has_action {
            return Err("This extension does not declare an action");
        }
        let target_id = self
            .pages
            .get(tab_id)
            .filter(|page| {
                reqwest::Url::parse(&page.url)
                    .is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
            })
            .map(|page| page.target_id.clone())
            .ok_or("Open an HTTP(S) page before triggering an extension action")?;
        self.pending_extension_actions.insert(
            extension_id.to_owned(),
            tokio::time::Instant::now() + Duration::from_secs(10),
        );
        if self
            .send_root_and_wait(
                "Extensions.triggerAction",
                json!({"id":extension_id,"targetId":target_id}),
            )
            .await
            .is_err()
        {
            self.pending_extension_actions.remove(extension_id);
            return Err("Chromium could not trigger this extension action".into());
        }
        Ok(())
    }

    fn consume_extension_popup_target(&mut self, raw_url: &str) -> Option<String> {
        let extension_id = extension_id_from_url(raw_url)?;
        let now = tokio::time::Instant::now();
        self.pending_extension_actions
            .retain(|_, deadline| *deadline > now);
        let extension_is_loaded = self
            .extensions
            .iter()
            .any(|extension| extension.id == extension_id);
        if extension_is_loaded
            && self
                .pending_extension_actions
                .remove(&extension_id)
                .is_some()
        {
            Some(extension_id)
        } else {
            None
        }
    }

    async fn replace_userscripts(&mut self, sources: Vec<String>) -> Result<(), String> {
        let total_bytes = sources.iter().map(String::len).sum::<usize>();
        if sources.len() > MAX_REMOTE_USERSCRIPT_COUNT
            || total_bytes > MAX_REMOTE_USERSCRIPT_BYTES
            || sources.iter().any(String::is_empty)
        {
            return Err("Remote userscripts exceed their limits".into());
        }
        for identifier in self.user_script_ids.drain(..).collect::<Vec<_>>() {
            self.send_and_wait(
                "Page.removeScriptToEvaluateOnNewDocument",
                json!({"identifier":identifier}),
            )
            .await?;
        }
        if !sources.is_empty() {
            let source = sources.join("\n;");
            let result = self
                .send_and_wait(
                    "Page.addScriptToEvaluateOnNewDocument",
                    json!({"source":source}),
                )
                .await?;
            let identifier = result
                .pointer("/result/identifier")
                .and_then(Value::as_str)
                .ok_or_else(|| "Chromium did not register a userscript".to_string())?;
            self.user_script_ids.push(identifier.to_owned());
        }
        Ok(())
    }

    async fn send_and_wait(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.send_wait(method, params, true).await
    }

    async fn send_root_and_wait(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.send_wait(method, params, false).await
    }

    async fn handle_javascript_dialog_for_tab(
        &mut self,
        tab_id: &str,
        accept: bool,
        prompt_text: &str,
    ) -> Result<(), String> {
        let Some(page) = self.pages.get(tab_id) else {
            return Err("Remote browser tab is no longer open".into());
        };
        let page_session = page.session_id.clone();
        let previous_session = std::mem::replace(&mut self.session_id, page_session);
        let result = self
            .send_and_wait(
                "Page.handleJavaScriptDialog",
                json!({"accept":accept,"promptText":prompt_text}),
            )
            .await;
        self.session_id = previous_session;
        result.map(|_| ())
    }

    async fn cancel_download(&mut self, guid: &str) -> Result<(), String> {
        if !valid_download_guid(guid) {
            return Err("Download id is invalid".into());
        }
        self.send_root_and_wait("Browser.cancelDownload", json!({"guid":guid}))
            .await
            .map(|_| ())
    }

    async fn send_wait(
        &mut self,
        method: &str,
        params: Value,
        page_session: bool,
    ) -> Result<Value, String> {
        let id = self.next_command_id;
        self.next_command_id = self.next_command_id.wrapping_add(1).max(1);
        let (sender, receiver) = oneshot::channel();
        self.pending_commands.lock().await.insert(id, sender);
        let message = cdp_command_payload(
            id,
            method,
            params,
            page_session.then_some(self.session_id.as_str()),
        );
        if self
            .sink
            .send(CdpMessage::Text(message.to_string().into()))
            .await
            .is_err()
        {
            self.pending_commands.lock().await.remove(&id);
            return Err("Chromium command channel closed".into());
        }
        let response = match timeout(Duration::from_secs(8), receiver).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => {
                self.pending_commands.lock().await.remove(&id);
                return Err("Chromium command channel closed".into());
            }
            Err(_) => {
                self.pending_commands.lock().await.remove(&id);
                return Err("Chromium setup command timed out".into());
            }
        };
        if let Some(error) = response.get("error") {
            return Err(error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Chromium rejected the debugger command")
                .chars()
                .take(256)
                .collect());
        }
        Ok(response)
    }

    async fn send(&mut self, method: &str, params: Value) -> Result<u32, String> {
        let id = self.next_command_id;
        self.next_command_id = self.next_command_id.wrapping_add(1).max(1);
        let message = json!({"id":id,"method":method,"params":params,"sessionId":self.session_id});
        self.sink
            .send(CdpMessage::Text(message.to_string().into()))
            .await
            .map_err(|_| "Chromium command channel closed".to_string())?;
        Ok(id)
    }

    async fn stop(mut self) {
        self.reader.abort();
        let _ = self.sink.send(CdpMessage::Close(None)).await;
        let _ = self.child.start_kill();
        let _ = timeout(Duration::from_secs(3), self.child.wait()).await;
        if let Some(mut cgroup) = self.cgroup.take() {
            cgroup.stop().await;
        }
        if let Some(mut egress) = self.egress.take() {
            egress.stop().await;
        }
    }
}

fn chromium_executable() -> Result<PathBuf, String> {
    if let Some(configured) = env::var_os("EYA_BROWSER_CHROMIUM") {
        let path = PathBuf::from(configured);
        if path.components().count() > 1 && !path.is_file() {
            return Err("EYA_BROWSER_CHROMIUM does not point to a file".into());
        }
        return Ok(path);
    }
    for candidate in [
        "chrome-headless-shell",
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
    ] {
        if let Some(path) = find_executable(candidate) {
            return Ok(path);
        }
    }
    if let Some(path) = cached_headless_shell() {
        return Ok(path);
    }
    Err("Chromium is unavailable; install it or configure EYA_BROWSER_CHROMIUM".into())
}

fn cached_headless_shell() -> Option<PathBuf> {
    let cache_root = env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))?;
    let path = cache_root
        .join("eya/chrome-for-testing/current")
        .join("chrome-headless-shell");
    path.is_file().then_some(path)
}

fn is_chrome_headless_shell(executable: &Path) -> bool {
    executable
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "chrome-headless-shell")
}

fn chromium_network_args(proxy_address: SocketAddr) -> [String; 4] {
    [
        format!("--proxy-server=socks5://{proxy_address}"),
        "--proxy-bypass-list=<-loopback>".into(),
        "--dns-prefetch-disable".into(),
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1".into(),
    ]
}

fn configured_chromium_graphics_args() -> Vec<&'static str> {
    let mode = env::var("EYA_BROWSER_GPU_MODE").unwrap_or_else(|_| "auto".into());
    let hardware_visible = Path::new("/dev/nvidia0").exists()
        || Path::new("/dev/dri").read_dir().is_ok_and(|entries| {
            entries.flatten().any(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with("renderD") || name.starts_with("card")
            })
        });
    chromium_graphics_args(&mode, hardware_visible)
}

fn configured_chromium_resource_args() -> [String; 2] {
    let renderer_limit = configured_browser_limit("EYA_BROWSER_RENDERER_LIMIT", 4, 1, 16);
    let heap_limit_mb = configured_browser_limit("EYA_BROWSER_JS_HEAP_LIMIT_MB", 512, 128, 4096);
    chromium_resource_args(renderer_limit, heap_limit_mb)
}

fn configured_browser_limit(name: &str, default: u32, minimum: u32, maximum: u32) -> u32 {
    let value = env::var(name).ok();
    parsed_browser_limit(value.as_deref(), default, minimum, maximum)
}

fn parsed_browser_limit(value: Option<&str>, default: u32, minimum: u32, maximum: u32) -> u32 {
    value
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| (minimum..=maximum).contains(value))
        .unwrap_or(default)
}

fn chromium_resource_args(renderer_limit: u32, heap_limit_mb: u32) -> [String; 2] {
    [
        format!("--renderer-process-limit={renderer_limit}"),
        format!("--js-flags=--max_old_space_size={heap_limit_mb}"),
    ]
}

fn chromium_graphics_args(mode: &str, hardware_visible: bool) -> Vec<&'static str> {
    match mode.trim().to_ascii_lowercase().as_str() {
        "off" => vec!["--disable-gpu"],
        "vulkan" => vec![
            "--enable-gpu",
            "--use-angle=vulkan",
            "--enable-features=Vulkan",
            "--disable-vulkan-surface",
        ],
        // Headless Linux commonly disables GPU acceleration by default. Use
        // Vulkan when the host exposes a GPU device; avoid driver probing on
        // CPU-only containers unless the operator explicitly requests it.
        "auto" | "" if hardware_visible => vec![
            "--enable-gpu",
            "--use-angle=vulkan",
            "--enable-features=Vulkan",
            "--disable-vulkan-surface",
        ],
        _ => vec!["--disable-gpu"],
    }
}

fn find_executable(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}

async fn wait_for_devtools_port(
    profile: &Path,
    child: &mut Child,
) -> Result<(u16, String), String> {
    let path = profile.join("DevToolsActivePort");
    let cgroup_error_path = profile.join("cgroup-start-error");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(error) = fs::read_to_string(&cgroup_error_path) {
            return Err(error.chars().take(512).collect());
        }
        if let Ok(contents) = fs::read_to_string(&path) {
            let mut lines = contents.lines();
            if let (Some(port), Some(browser_path)) = (lines.next(), lines.next())
                && let Ok(port) = port.parse::<u16>()
                && port != 0
                && browser_path.starts_with("/devtools/browser/")
            {
                return Ok((port, browser_path.to_owned()));
            }
        }
        if child.try_wait().ok().flatten().is_some() {
            // SAFETY: geteuid has no arguments and does not modify process state.
            if unsafe { libc::geteuid() } == 0 {
                return Err("Chromium exited during startup. Chromium requires a non-root account with a working sandbox; the Eya server is running as root.".into());
            }
            return Err("Chromium exited during startup. Check its installed dependencies and that the host permits Chromium's sandbox.".into());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("Timed out waiting for Chromium DevTools".into());
        }
        sleep(Duration::from_millis(25)).await;
    }
}

async fn cdp_command(
    socket: &mut CdpSocket,
    session_id: Option<&str>,
    id: u32,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let mut command = json!({"id":id,"method":method,"params":params});
    if let Some(session_id) = session_id {
        command["sessionId"] = json!(session_id);
    }
    socket
        .send(CdpMessage::Text(command.to_string().into()))
        .await
        .map_err(|_| "Could not send Chromium command")?;
    loop {
        let message = timeout(Duration::from_secs(8), socket.next())
            .await
            .map_err(|_| "Chromium command timed out")?
            .ok_or("Chromium DevTools closed")?
            .map_err(|_| "Chromium DevTools failed")?;
        match message {
            CdpMessage::Text(text) => {
                let value: Value =
                    serde_json::from_str(&text).map_err(|_| "Invalid Chromium response")?;
                if value.get("id").and_then(Value::as_u64) == Some(id as u64) {
                    if value.get("error").is_some() {
                        return Err("Chromium rejected a browser setup command".into());
                    }
                    return Ok(value);
                }
            }
            CdpMessage::Ping(payload) => {
                socket
                    .send(CdpMessage::Pong(payload))
                    .await
                    .map_err(|_| "Chromium DevTools failed")?;
            }
            CdpMessage::Close(_) => return Err("Chromium DevTools closed".into()),
            _ => {}
        }
    }
}

fn validated_navigation_url(raw: &str) -> Result<reqwest::Url, String> {
    if raw.len() > 8192 {
        return Err("URL is too long".into());
    }
    let mut url = reqwest::Url::parse(raw).map_err(|_| "Invalid URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Remote browser only supports credential-free HTTP(S) URLs".into());
    }
    url.set_fragment(None);
    Ok(url)
}

fn validated_popup_url(raw: &str) -> Result<String, String> {
    if raw == "about:blank" {
        return Ok(raw.to_owned());
    }
    validated_navigation_url(raw).map(|url| url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_accepts_only_credential_free_http_urls() {
        assert_eq!(
            validated_navigation_url("https://example.test/path#fragment")
                .unwrap()
                .as_str(),
            "https://example.test/path"
        );
        assert!(validated_navigation_url("file:///etc/passwd").is_err());
        assert!(validated_navigation_url("javascript:alert(1)").is_err());
        assert!(validated_navigation_url("https://user:pass@example.test/").is_err());
    }

    #[test]
    fn popup_targets_accept_only_blank_or_credential_free_http_urls() {
        assert_eq!(validated_popup_url("about:blank").unwrap(), "about:blank");
        assert_eq!(
            validated_popup_url("https://example.test/popup#fragment").unwrap(),
            "https://example.test/popup"
        );
        assert!(validated_popup_url("javascript:alert(1)").is_err());
        assert!(validated_popup_url("data:text/html,hello").is_err());
        assert!(validated_popup_url("file:///etc/passwd").is_err());
        assert!(validated_popup_url("https://user:pass@example.test/").is_err());
    }

    #[test]
    fn extension_action_popups_are_confined_to_the_loaded_extension_origin() {
        let extension_id = "abcdefghijklmnopabcdefghijklmnop";
        let url = format!("chrome-extension://{extension_id}/popup.html");
        assert_eq!(extension_id_from_url(&url).as_deref(), Some(extension_id));
        assert_eq!(
            validated_extension_popup_url(&url, extension_id),
            Ok(url.clone())
        );
        assert!(
            validated_extension_popup_url(
                "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/popup.html",
                extension_id
            )
            .is_err()
        );
        assert!(
            extension_id_from_url(
                "chrome-extension://user@abcdefghijklmnopabcdefghijklmnop/popup.html"
            )
            .is_none()
        );
        assert!(
            extension_id_from_url("https://abcdefghijklmnopabcdefghijklmnop/popup.html").is_none()
        );
    }

    #[test]
    fn remote_tab_ids_are_bounded_and_header_safe() {
        assert!(valid_remote_tab_id("eya-browser-12"));
        assert!(valid_remote_tab_id("tab_A9"));
        assert!(!valid_remote_tab_id(""));
        assert!(!valid_remote_tab_id("tab/1"));
        assert!(!valid_remote_tab_id("tab\n1"));
        assert!(!valid_remote_tab_id(&"t".repeat(65)));
        assert_eq!(MAX_REMOTE_TABS, 3);
    }

    #[test]
    fn chromium_uses_socks_proxy_and_blocks_local_dns_leaks() {
        let args = chromium_network_args("127.0.0.1:49152".parse().unwrap());
        assert_eq!(args[0], "--proxy-server=socks5://127.0.0.1:49152");
        assert_eq!(args[1], "--proxy-bypass-list=<-loopback>");
        assert_eq!(args[2], "--dns-prefetch-disable");
        assert_eq!(
            args[3],
            "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"
        );
    }

    #[test]
    fn chromium_gpu_mode_uses_vulkan_only_when_selected_and_available() {
        assert_eq!(chromium_graphics_args("auto", false), vec!["--disable-gpu"]);
        assert_eq!(chromium_graphics_args("off", true), vec!["--disable-gpu"]);
        let auto = chromium_graphics_args("auto", true);
        assert_eq!(auto, chromium_graphics_args("vulkan", false));
        assert!(auto.contains(&"--use-angle=vulkan"));
        assert!(auto.contains(&"--enable-features=Vulkan"));
        assert!(auto.contains(&"--disable-vulkan-surface"));
        assert_eq!(
            chromium_graphics_args("invalid", true),
            vec!["--disable-gpu"]
        );
    }

    #[test]
    fn chromium_resource_args_set_a_soft_renderer_target_and_v8_heap_limit() {
        assert_eq!(
            chromium_resource_args(4, 512),
            [
                "--renderer-process-limit=4".to_owned(),
                "--js-flags=--max_old_space_size=512".to_owned(),
            ]
        );
        assert_eq!(parsed_browser_limit(None, 4, 1, 16), 4);
        assert_eq!(parsed_browser_limit(Some("2"), 4, 1, 16), 2);
        assert_eq!(parsed_browser_limit(Some("0"), 4, 1, 16), 4);
        assert_eq!(parsed_browser_limit(Some("17"), 4, 1, 16), 4);
        assert_eq!(parsed_browser_limit(Some("invalid"), 512, 128, 4096), 512);
    }

    #[test]
    fn browser_cgroup_limits_write_cpu_memory_and_process_caps() {
        let profile = Profile::create().unwrap();
        for name in ["memory.max", "memory.oom.group", "cpu.max", "pids.max"] {
            fs::write(profile.0.join(name), "").unwrap();
        }
        let limits = browser_cgroup_limits(2048, 300, 128);
        write_cgroup_limits(&profile.0, limits).unwrap();
        assert_eq!(
            fs::read_to_string(profile.0.join("memory.max")).unwrap(),
            "2147483648"
        );
        assert_eq!(
            fs::read_to_string(profile.0.join("memory.oom.group")).unwrap(),
            "1"
        );
        assert_eq!(
            fs::read_to_string(profile.0.join("cpu.max")).unwrap(),
            "300000 100000"
        );
        assert_eq!(
            fs::read_to_string(profile.0.join("pids.max")).unwrap(),
            "128"
        );
        assert_eq!(
            configured_browser_cgroup_limits(),
            browser_cgroup_limits(
                configured_browser_limit("EYA_BROWSER_CGROUP_MEMORY_MB", 2048, 512, 8192),
                configured_browser_limit("EYA_BROWSER_CGROUP_CPU_PERCENT", 300, 50, 800),
                configured_browser_limit("EYA_BROWSER_CGROUP_PIDS", 128, 32, 512),
            )
        );
    }

    #[test]
    fn browser_resource_status_reports_only_active_hard_limits() {
        assert_eq!(
            browser_resource_limits_status(None),
            json!({"enforced": false})
        );
        assert_eq!(
            browser_resource_limits_status(Some(browser_cgroup_limits(2048, 300, 128))),
            json!({
                "enforced": true,
                "memoryMb": 2048,
                "cpuPercent": 300,
                "processes": 128
            })
        );
    }

    #[test]
    fn debugger_commands_are_allowlisted_and_breakpoints_are_session_scoped() {
        let breakpoints = std::collections::HashSet::from(["bp-1".to_string()]);
        let sources = std::collections::HashMap::from([(
            "https://example.test/app.js".to_string(),
            "main-frame".to_string(),
        )]);
        assert_eq!(
            debugger_cdp_command("pause", &json!({}), &breakpoints, &sources).unwrap(),
            ("Debugger.pause", json!({}))
        );
        assert_eq!(
            debugger_cdp_command(
                "setBreakpoint",
                &json!({"url":"https://example.test/app.js","line":8}),
                &breakpoints,
                &sources,
            )
            .unwrap(),
            (
                "Debugger.setBreakpointByUrl",
                json!({"url":"https://example.test/app.js","lineNumber":8})
            )
        );
        assert!(
            debugger_cdp_command(
                "setBreakpoint",
                &json!({"url":"https://unlisted.test/evil.js","line":0}),
                &breakpoints,
                &sources,
            )
            .is_err()
        );
        assert!(
            debugger_cdp_command(
                "removeBreakpoint",
                &json!({"breakpointId":"not-owned"}),
                &breakpoints,
                &sources,
            )
            .is_err()
        );
        assert_eq!(
            debugger_cdp_command(
                "removeBreakpoint",
                &json!({"breakpointId":"bp-1"}),
                &breakpoints,
                &sources,
            )
            .unwrap(),
            ("Debugger.removeBreakpoint", json!({"breakpointId":"bp-1"}))
        );
        assert!(
            debugger_cdp_command("Browser.close", &json!({}), &breakpoints, &sources,).is_err()
        );
    }

    #[test]
    fn console_call_frame_evaluation_requires_a_current_pause_frame() {
        let active = std::collections::HashSet::from(["frame-1".to_string()]);
        assert_eq!(validate_call_frame(None, &active), Ok(None));
        assert_eq!(
            validate_call_frame(Some("frame-1"), &active),
            Ok(Some("frame-1"))
        );
        assert!(validate_call_frame(Some("stale-frame"), &active).is_err());
        let oversized = "x".repeat(257);
        assert!(validate_call_frame(Some(&oversized), &active).is_err());
        let decoded: Evaluate = serde_json::from_value(json!({
            "id":5,"tabId":"eya-browser-1","expression":"value","callFrameId":"frame-1"
        }))
        .unwrap();
        assert_eq!(decoded.call_frame_id.as_deref(), Some("frame-1"));
    }

    #[test]
    fn debugger_pause_events_are_compacted_before_the_websocket() {
        let event = json!({
            "method":"Debugger.paused",
            "params":{
                "reason":"other",
                "callFrames":[{
                    "callFrameId":"frame-1",
                    "functionName":"render",
                    "url":"https://example.test/app.js",
                    "location":{"scriptId":"9","lineNumber":12,"columnNumber":4},
                    "scopeChain":[{"object":{"description":"x".repeat(60_000)}}]
                }]
            }
        });
        let compact = client_debug_event(&event).unwrap();
        let bytes = serde_json::to_vec(&compact).unwrap();
        assert!(bytes.len() < 4096);
        assert_eq!(compact["params"]["callFrames"][0]["callFrameId"], "frame-1");
        assert!(
            compact["params"]["callFrames"][0]
                .get("scopeChain")
                .is_none()
        );
        assert!(client_debug_event(&json!({"method":"Unknown.event","params":{}})).is_none());
    }

    #[test]
    fn remote_object_details_and_properties_are_bounded_and_do_not_call_accessors() {
        let evaluation = json!({"result":{"result":{"type":"object","className":"Object","description":"Object","objectId":"object-1"}}});
        assert_eq!(
            evaluation_remote_object(&evaluation).unwrap()["objectId"],
            "object-1"
        );
        let response = json!({"result":{"result":[
            {"name":"count","enumerable":true,"writable":true,"configurable":true,"value":{"type":"number","value":7}},
            {"name":"child","enumerable":true,"value":{"type":"object","description":"Object","objectId":"object-2"}},
            {"name":"danger","enumerable":true,"get":{"type":"function","description":"get danger()"}}
        ]}});
        let properties = remote_object_properties(&response);
        assert_eq!(properties.len(), 3);
        assert_eq!(properties[0]["value"]["value"], 7);
        assert_eq!(properties[1]["value"]["objectId"], "object-2");
        assert_eq!(properties[2]["accessor"], true);
        assert!(properties[2]["value"].is_null());
    }

    #[test]
    fn debugger_scopes_are_compacted_and_limited() {
        let scopes = (0..12).map(|index| json!({
            "type":"local", "name":"scope", "object":{"type":"object","className":"Object","description":"scope","objectId":format!("scope-{index}")}
        })).collect::<Vec<_>>();
        let compact = compact_debugger_scopes(&json!({"scopeChain":scopes}));
        assert_eq!(compact.len(), 8);
        assert_eq!(compact[0]["object"]["objectId"], "scope-0");
        assert!(
            compact_debugger_scopes(
                &json!({"scopeChain":[{"type":"local","object":{"type":"object"}}]})
            )
            .is_empty()
        );
    }

    #[test]
    fn remote_privacy_rules_match_tracker_domains_strip_params_and_decode_settings() {
        assert!(is_builtin_tracker("doubleclick.net"));
        assert!(is_builtin_tracker("ads.eu.doubleclick.net"));
        assert!(!is_builtin_tracker("doubleclick.net.attacker.test"));
        assert_eq!(
            schemeful_site(&reqwest::Url::parse("https://Example.test:8443/a").unwrap()),
            "https://example.test"
        );
        let page = reqwest::Url::parse("https://example.test/").unwrap();
        let third_party = reqwest::Url::parse("https://cdn.example-cdn.test/a.js").unwrap();
        let privacy = RemotePrivacy {
            block_trackers: false,
            block_third_party: true,
            strip_tracking: false,
        };
        assert_eq!(
            privacy_block_reason(
                privacy,
                &third_party,
                Some(&page),
                false,
                &RemoteFilterSet::default(),
                "script"
            ),
            Some("third-party")
        );
        assert_eq!(
            privacy_block_reason(
                privacy,
                &third_party,
                Some(&page),
                true,
                &RemoteFilterSet::default(),
                "document"
            ),
            None,
            "the user's top-level navigation must not be treated as a third-party subresource"
        );
        let tracker = reqwest::Url::parse("https://ads.doubleclick.net/pixel").unwrap();
        assert_eq!(
            privacy_block_reason(
                RemotePrivacy {
                    block_trackers: true,
                    ..privacy
                },
                &tracker,
                Some(&page),
                false,
                &RemoteFilterSet::default(),
                "image"
            ),
            Some("built-in")
        );
        let mut url = reqwest::Url::parse(
            "https://example.test/page?keep=1&utm_source=mail&FBCLID=secret&empty=",
        )
        .unwrap();
        assert!(strip_tracking_parameters(&mut url));
        assert_eq!(url.as_str(), "https://example.test/page?keep=1&empty=");
        assert!(!strip_tracking_parameters(&mut url));
        let settings: PrivacySettings = serde_json::from_str(
            r#"{"blockTrackers":true,"blockThirdParty":true,"stripTracking":false}"#,
        )
        .unwrap();
        let privacy: RemotePrivacy = settings.into();
        assert!(privacy.block_trackers && privacy.block_third_party);
        assert!(!privacy.strip_tracking);
    }

    #[test]
    fn remote_filter_rules_validate_and_match_precedence_and_options() {
        let payload: RemoteFilterSet = serde_json::from_value(json!({
            "version":1,"hosts":["hosts.bad"],"rules":[
                {"host":"ads.example","tokens":"","matchCase":false,"important":false,"types":["script"],"excludedTypes":[],"thirdParty":true,"domains":["docs.example"],"excludedDomains":[],"allow":false},
                {"host":"ads.example","tokens":"/safe.js^*","matchCase":false,"important":false,"types":[],"excludedTypes":[],"thirdParty":null,"domains":[],"excludedDomains":[],"allow":true},
                {"host":"important.example","tokens":"","matchCase":false,"important":true,"types":[],"excludedTypes":[],"thirdParty":null,"domains":[],"excludedDomains":[],"allow":false},
                {"host":"important.example","tokens":"","matchCase":false,"important":false,"types":[],"excludedTypes":[],"thirdParty":null,"domains":[],"excludedDomains":[],"allow":true}
            ]
        })).unwrap();
        let filters = validate_remote_filters(payload, 4, 1).unwrap();
        let page = reqwest::Url::parse("https://docs.example/").unwrap();
        let ad = reqwest::Url::parse("https://ads.example/track.js").unwrap();
        assert!(remote_filter_blocks(&filters, &ad, Some(&page), "script"));
        assert!(
            !remote_filter_blocks(&filters, &ad, Some(&page), "image"),
            "resource type restrictions are honored"
        );
        let allowed = reqwest::Url::parse("https://ads.example/safe.js").unwrap();
        assert!(
            !remote_filter_blocks(&filters, &allowed, Some(&page), "script"),
            "exceptions override ordinary blocks"
        );
        let host_file = reqwest::Url::parse("https://hosts.bad/ad").unwrap();
        assert!(remote_filter_blocks(
            &filters,
            &host_file,
            Some(&page),
            "other"
        ));
        let important = reqwest::Url::parse("https://important.example/safe.js").unwrap();
        assert!(
            remote_filter_blocks(&filters, &important, Some(&page), "script"),
            "important blocks override exceptions"
        );
        assert!(
            validate_remote_filters(filters.clone(), 3, 1).is_err(),
            "declared counts must match the payload"
        );
        let invalid: RemoteFilterSet = serde_json::from_value(json!({"version":1,"hosts":[],"rules":[{"host":"bad host","tokens":"","matchCase":false,"important":false,"types":[],"excludedTypes":[],"thirdParty":null,"domains":[],"excludedDomains":[],"allow":false}]})).unwrap();
        assert!(
            validate_remote_filters(invalid, 1, 0).is_err(),
            "invalid host syntax is rejected before activation"
        );
    }

    #[test]
    fn remote_input_parser_accepts_mouse_and_key_shapes_and_rejects_unknown_actions() {
        let mouse: Input = serde_json::from_str(
            r#"{"type":"mouse","tabId":"eya-browser-1","action":"mouseMoved","x":10,"y":20,"buttons":1}"#,
        )
        .unwrap();
        assert!(mouse.validate().is_ok());
        let key: Input = serde_json::from_str(
            r#"{"type":"key","tabId":"eya-browser-1","action":"keyDown","key":"a","code":"KeyA","keyCode":65}"#,
        )
        .unwrap();
        assert!(key.validate().is_ok());
        let bad: Input =
            serde_json::from_str(r#"{"type":"mouse","tabId":"eya-browser-1","action":"navigate"}"#)
                .unwrap();
        assert!(bad.validate().is_err());
    }

    #[test]
    fn console_result_serialization_is_bounded_and_exceptions_are_extracted() {
        let small = json!({"id":1,"result":{"result":{"type":"number","value":42}}});
        assert_eq!(evaluation_result(&small), (json!(42), Value::Null));
        let large = json!({"id":2,"result":{"result":{"type":"string","value":"x".repeat(MAX_CONSOLE_RESULT_BYTES + 1)}}});
        assert_eq!(
            evaluation_result(&large).0,
            json!("[Console result omitted: exceeds 64 KiB]")
        );
        let exception = json!({"id":3,"result":{"exceptionDetails":{"text":"Uncaught","exception":{"description":"TypeError: bad"}}}});
        assert_eq!(
            evaluation_result(&exception),
            (Value::Null, json!("TypeError: bad"))
        );
    }

    #[test]
    fn remote_sources_are_limited_to_safe_main_frame_text_resources() {
        let tree = json!({"result":{"frameTree":{"frame":{"id":"main"},"resources":[
            {"url":"https://example.test/","type":"Document","mimeType":"text/html"},
            {"url":"https://example.test/app.js","type":"Script","mimeType":"text/javascript"},
            {"url":"https://example.test/site.css","type":"Stylesheet","mimeType":"text/css","contentSize":1024},
            {"url":"https://example.test/image.png","type":"Image","mimeType":"image/png"},
            {"url":"https://example.test/huge.js","type":"Script","mimeType":"text/javascript","contentSize":9999999},
            {"url":"https://user:pass@example.test/private.js","type":"Script","mimeType":"text/javascript"}
        ],"childFrames":[{"frame":{"id":"child"},"resources":[{"url":"https://child.test/app.js","type":"Script"}]}]}}});
        let (sources, allowed) = remote_source_list(&tree, "main").unwrap();
        assert_eq!(sources.len(), 3);
        assert_eq!(sources[0].kind, "Document");
        assert_eq!(sources[1].url, "https://example.test/app.js");
        assert!(!allowed.contains_key("https://example.test/image.png"));
        assert!(!allowed.contains_key("https://example.test/huge.js"));
        assert!(!allowed.contains_key("https://user:pass@example.test/private.js"));
        assert!(!allowed.contains_key("https://child.test/app.js"));
        assert!(remote_source_list(&tree, "stale-frame").is_err());
    }

    #[test]
    fn remote_source_content_is_decoded_and_capped_at_utf8_boundaries() {
        let encoded = BASE64.encode("hello".as_bytes());
        let response = json!({"result":{"result":{"content":encoded,"base64Encoded":true}}});
        assert_eq!(
            remote_source_content(&response).unwrap(),
            ("hello".into(), false)
        );
        let large = "é".repeat(MAX_REMOTE_SOURCE_BYTES / 2 + 8);
        let response = json!({"result":{"result":{"content":large,"base64Encoded":false}}});
        let (text, truncated) = remote_source_content(&response).unwrap();
        assert!(truncated);
        assert_eq!(text.len(), MAX_REMOTE_SOURCE_BYTES);
        assert!(text.is_char_boundary(text.len()));
    }

    #[test]
    fn remote_network_response_body_is_decoded_and_bounded() {
        let response = json!({"result":{"body":"hello","base64Encoded":false}});
        assert_eq!(
            remote_network_body(&response).unwrap(),
            ("hello".into(), false)
        );

        let binary = BASE64.encode([0xff, 0x00, 0x61]);
        let response = json!({"result":{"body":binary,"base64Encoded":true}});
        let (text, truncated) = remote_network_body(&response).unwrap();
        assert!(!truncated);
        assert_eq!(text.as_bytes(), &[0xef, 0xbf, 0xbd, 0x00, 0x61]);

        let invalid_utf8 = BASE64.encode(vec![0xff; MAX_REMOTE_NETWORK_BODY_BYTES]);
        let response = json!({"result":{"body":invalid_utf8,"base64Encoded":true}});
        let (text, truncated) = remote_network_body(&response).unwrap();
        assert!(truncated);
        assert!(text.len() <= MAX_REMOTE_NETWORK_BODY_BYTES);

        let large = "x".repeat(MAX_REMOTE_NETWORK_BODY_BYTES + 1);
        let response = json!({"result":{"body":large,"base64Encoded":false}});
        let (text, truncated) = remote_network_body(&response).unwrap();
        assert!(truncated);
        assert_eq!(text.len(), MAX_REMOTE_NETWORK_BODY_BYTES);

        let large_binary = BASE64.encode(vec![0u8; MAX_REMOTE_NETWORK_BODY_BYTES + 16]);
        let response = json!({"result":{"body":large_binary,"base64Encoded":true}});
        let (text, truncated) = remote_network_body(&response).unwrap();
        assert!(truncated);
        assert_eq!(text.len(), MAX_REMOTE_NETWORK_BODY_BYTES);
    }

    #[test]
    fn download_guids_are_safe_private_profile_filenames() {
        assert!(valid_download_guid("01234567-89ab-cdef-0123-456789abcdef"));
        assert!(!valid_download_guid("../etc/passwd"));
        assert!(!valid_download_guid("short"));
        assert!(!valid_download_guid("a".repeat(65).as_str()));
    }

    #[test]
    fn remote_storage_cookie_results_are_bounded_and_origins_are_canonical() {
        let cookies = json!({"result":{"cookies":[
            {"name":"sid","value":"secret","domain":"example.test","path":"/","httpOnly":true,"secure":true,"sameSite":"Strict"},
            {"name":"x","value":"y","domain":"example.test","path":"/"}
        ]}});
        let rows = remote_cookies(&cookies).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "sid");
        assert!(rows[0].http_only && rows[0].secure);
        assert_eq!(rows[0].same_site, "Strict");
        assert_eq!(
            validated_origin("https://Example.test:8443/a"),
            Some("https://example.test:8443".into())
        );
        assert_eq!(validated_origin("file:///etc/passwd"), None);
        assert_eq!(validated_origin("https://user:pass@example.test/"), None);

        let many = json!({"result":{"cookies":(0..200).map(|index| json!({"name":format!("n{index}"),"value":"v".repeat(512),"domain":"example.test","path":"/"})).collect::<Vec<_>>()}});
        let bounded = remote_cookies(&many).unwrap();
        assert!(serde_json::to_vec(&bounded).unwrap().len() <= 40 * 1024);
        assert!(bounded.len() < 200);
    }

    #[test]
    fn extension_file_manifest_rejects_traversal_duplicates_conflicts_and_limits() {
        let files = vec![
            ExtensionFileMeta {
                path: "manifest.json".into(),
                size: 32,
            },
            ExtensionFileMeta {
                path: "scripts/content.js".into(),
                size: 12,
            },
        ];
        assert_eq!(validate_extension_files(&files), Ok(44));

        for path in [
            "../manifest.json",
            "/manifest.json",
            "a/../manifest.json",
            "C:/manifest.json",
            "a\\b",
            "a//b",
        ] {
            let invalid = vec![ExtensionFileMeta {
                path: path.into(),
                size: 1,
            }];
            assert!(
                validate_extension_files(&invalid).is_err(),
                "accepted {path}"
            );
        }
        let duplicate = vec![
            ExtensionFileMeta {
                path: "manifest.json".into(),
                size: 1,
            },
            ExtensionFileMeta {
                path: "Manifest.json".into(),
                size: 1,
            },
        ];
        assert!(validate_extension_files(&duplicate).is_err());
        let conflict = vec![
            ExtensionFileMeta {
                path: "manifest.json".into(),
                size: 1,
            },
            ExtensionFileMeta {
                path: "assets".into(),
                size: 1,
            },
            ExtensionFileMeta {
                path: "assets/icon.png".into(),
                size: 1,
            },
        ];
        assert!(validate_extension_files(&conflict).is_err());
        let too_large = vec![ExtensionFileMeta {
            path: "manifest.json".into(),
            size: MAX_EXTENSION_FILE_BYTES + 1,
        }];
        assert!(validate_extension_files(&too_large).is_err());
    }

    #[test]
    fn loaded_extensions_have_session_wide_count_and_storage_caps() {
        assert!(validate_extension_capacity(0, 0, MAX_EXTENSION_TOTAL_BYTES).is_ok());
        assert!(
            validate_extension_capacity(
                MAX_LOADED_EXTENSIONS - 1,
                MAX_LOADED_EXTENSION_BYTES - MAX_EXTENSION_TOTAL_BYTES,
                MAX_EXTENSION_TOTAL_BYTES,
            )
            .is_ok()
        );
        assert!(validate_extension_capacity(MAX_LOADED_EXTENSIONS, 0, 1).is_err());
        assert!(validate_extension_capacity(1, MAX_LOADED_EXTENSION_BYTES, 1,).is_err());
        assert!(validate_extension_capacity(1, usize::MAX, 1).is_err());
    }

    #[test]
    fn extension_manifest_requires_mv3_and_denies_browser_escape_permissions() {
        let valid =
            br#"{"manifest_version":3,"name":"Example","version":"1.0","permissions":["storage"]}"#;
        let manifest = validate_extension_manifest(valid).unwrap();
        assert_eq!(manifest.name, "Example");
        assert!(!manifest.has_action);
        let with_action = br#"{"manifest_version":3,"name":"Example","version":"1.0","action":{"default_popup":"popup.html"}}"#;
        assert!(validate_extension_manifest(with_action).unwrap().has_action);
        let mv2 = br#"{"manifest_version":2,"name":"Example","version":"1.0"}"#;
        assert!(validate_extension_manifest(mv2).is_err());
        let forbidden =
            br#"{"manifest_version":3,"name":"Example","version":"1.0","permissions":["proxy"]}"#;
        assert!(validate_extension_manifest(forbidden).is_err());
        let malformed =
            br#"{"manifest_version":3,"name":"Example","version":"1.0","permissions":"storage"}"#;
        assert!(validate_extension_manifest(malformed).is_err());
        let oversized = vec![b' '; MAX_EXTENSION_MANIFEST_BYTES + 1];
        assert!(validate_extension_manifest(&oversized).is_err());
    }

    #[test]
    fn extension_cdp_commands_use_browser_root_without_page_session() {
        let root = cdp_command_payload(
            12,
            "Extensions.loadUnpacked",
            json!({"path":"/private/profile/extensions/upload-1"}),
            None,
        );
        assert_eq!(root["method"], "Extensions.loadUnpacked");
        assert!(root.get("sessionId").is_none());
        let page = cdp_command_payload(
            13,
            "Page.navigate",
            json!({"url":"https://example.test"}),
            Some("page-session"),
        );
        assert_eq!(page["sessionId"], "page-session");
    }

    #[tokio::test]
    async fn extension_upload_requires_ordered_chunks_and_writes_inside_profile() {
        let profile = Profile::create().unwrap();
        let manifest = br#"{"manifest_version":3,"name":"Eya test","version":"1.0"}"#;
        let source = b"console.log('loaded')";
        let files = vec![
            ExtensionFileMeta {
                path: "manifest.json".into(),
                size: manifest.len(),
            },
            ExtensionFileMeta {
                path: "content.js".into(),
                size: source.len(),
            },
        ];
        let total = validate_extension_files(&files).unwrap();
        let mut upload = create_extension_upload(7, files, total, &profile)
            .await
            .unwrap();
        assert!(
            write_extension_chunk(&mut upload, 1, 0, source)
                .await
                .is_err()
        );
        assert_eq!(
            write_extension_chunk(&mut upload, 0, 0, manifest)
                .await
                .unwrap(),
            (1, 0)
        );
        assert_eq!(
            write_extension_chunk(&mut upload, 1, 0, source)
                .await
                .unwrap(),
            (2, 0)
        );
        assert_eq!(upload.next_file, upload.files.len());
        assert_eq!(
            tokio::fs::read(upload.root.join("manifest.json"))
                .await
                .unwrap(),
            manifest
        );
        assert_eq!(
            tokio::fs::read(upload.root.join("content.js"))
                .await
                .unwrap(),
            source
        );
        assert!(upload.root.starts_with(&profile.0));
    }
}
