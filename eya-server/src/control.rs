//! Authenticated workspace, file and machine services; never starts a PTY.
use super::*;
use serde_json::{Value, json};

async fn workspace(app: &App, op: String, request: Value) -> io::Result<Value> {
    let store = app.workspaces.clone();
    tokio::task::spawn_blocking(move || {
        let mut store = store
            .lock()
            .map_err(|_| io::Error::other("Workspace store unavailable"))?;
        if op == "workspace.start" {
            store.start(request["client"].as_str())
        } else if op == "workspace.renew" {
            match request["workspace"].as_str() {
                Some(id) => store.renew_workspace(id),
                None => store.renew(request["client"].as_str().unwrap_or("")),
            }
        } else {
            store.handle(&op, &request)
        }
    })
    .await
    .map_err(io::Error::other)?
}

pub async fn run(socket: WebSocket, mut noise: snow::TransportState, ready: Value, app: App) {
    let extensions = wire::offered(&ready);
    let server_config_enabled = extensions
        && ready["capabilities"].as_array().is_some_and(|offers| {
            offers
                .iter()
                .take(64)
                .any(|value| value.as_str() == Some(server_config::CAPABILITY))
        });
    let mut capabilities = wire::selected(extensions);
    if server_config_enabled {
        capabilities
            .as_array_mut()
            .unwrap()
            .push(server_config::CAPABILITY.into());
    }
    let (mut sender, mut receiver) = socket.split();
    let mut cipher = vec![0; 65535];
    let mut plain = vec![0; 65535];
    let mut uploads = HashMap::<u32, files::Upload>::new();
    let initial = match workspace(&app, "workspace.start".into(), ready).await {
        Ok(mut response) => {
            response["state"] = "ready".into();
            response["capabilities"] = capabilities.clone();
            response["versions"] = wire::info();
            response
        }
        // A full/unwritable store must not prevent authenticated cleanup and
        // discovery. The client can manage old records before creating a new one.
        Err(error) => match workspaces::new_id() {
            Ok(client) => {
                json!({"state":"ready","client":client,"workspace":null,"warning":error.to_string(),"capabilities":capabilities.clone(),"versions":wire::info()})
            }
            Err(_) => return,
        },
    };
    let mut state = vec![7];
    state.extend_from_slice(initial.to_string().as_bytes());
    if send_encrypted(&state, &mut sender, &mut noise, &mut cipher)
        .await
        .is_err()
        || initial["state"] != "ready"
    {
        return;
    }
    let client = initial["client"].as_str().unwrap().to_owned();
    let mut jobs = tokio::task::JoinSet::<Value>::new();
    let mut last_activity = tokio::time::Instant::now();
    let mut lease = tokio::time::interval(Duration::from_secs(60));
    loop {
        tokio::select! {
            incoming = receiver.next() => {
                let result: io::Result<()> = async {
                    match incoming {
                        Some(Ok(Message::Binary(bytes))) => {
                            last_activity = tokio::time::Instant::now();
                            let count = noise.read_message(&bytes, &mut plain).map_err(|_| invalid_config("Invalid encrypted request"))?;
                            match &plain[..count] {
                                [12, data @ ..] if extensions => {
                                    if let Some(response) = wire::extension(data)? { send_encrypted(&response, &mut sender, &mut noise, &mut cipher).await?; }
                                }
                                [3, data @ ..] if data.len() == 8 => send_encrypted(&plain[..count], &mut sender, &mut noise, &mut cipher).await?,
                                [4, data @ ..] => {
                                    let mut request: Value = serde_json::from_slice(data)?;
                                    let id = request["id"].as_u64().and_then(|id| u32::try_from(id).ok()).ok_or_else(|| invalid_config("Invalid request ID"))?;
                                    let op = request["op"].as_str().unwrap_or("").to_owned();
                                    if matches!(op.as_str(), "workspace.start" | "workspace.list") { request["client"] = client.clone().into(); }
                                    if op.starts_with("server.config.") || op.starts_with("workspace.") || op.starts_with("session.") || op.starts_with("system.") || op.starts_with("docker.") || op.starts_with("compose.") {
                                        if jobs.len() >= 4 {
                                            send_file_error(id, "Service busy; retry shortly", &mut sender, &mut noise, &mut cipher).await?;
                                        } else {
                                            let app = app.clone();
                                            jobs.spawn(async move {
                                                let result = if op.starts_with("server.config.") {
                                                    if !server_config_enabled { Err(io::Error::other("unsupported_feature: server-config-v1 was not negotiated")) }
                                                    else { let count = app.browser_sessions.lock().map(|sessions| sessions.len()).unwrap_or(0); app.server_config.handle(&op, &request, count) }
                                                } else if op.starts_with("workspace.") { workspace(&app, op.clone(), request.clone()).await }
                                                else if op.starts_with("session.") { resume::manage(&app, &op, &request).await }
                                                else {
                                                    match app.machine_slots.clone().try_acquire_owned() {
                                                        Ok(_permit) => match timeout(Duration::from_secs(20), system::handle(&op, &request, &app.files)).await {
                                                            Ok(result) => result,
                                                            Err(_) => Err(io::Error::new(io::ErrorKind::TimedOut, "Machine operation timed out")),
                                                        },
                                                        Err(_) => Err(io::Error::other("Machine tools are busy")),
                                                    }
                                                };
                                                match result {
                                                    Ok(mut value) => { value["id"] = id.into(); value["op"] = op.into(); value["ok"] = true.into(); value },
                                                    Err(error) => json!({"id":id,"ok":false,"error":error.to_string()}),
                                                }
                                            });
                                        }
                                    } else {
                                        handle_file_request(data, &app.files, &mut uploads, &mut sender, &mut noise, &mut cipher).await?;
                                    }
                                }
                                [5, data @ ..] if data.len() >= 5 => {
                                    let id = u32::from_be_bytes(data[..4].try_into().unwrap());
                                    if let Some(mut upload) = uploads.remove(&id) {
                                        let result = upload.write(&data[5..]).await;
                                        let result = if result.is_err() { upload.cancel().await; result }
                                            else if data[4] != 0 { upload.finish().await }
                                            else { uploads.insert(id, upload); Ok(()) };
                                        match result {
                                            Err(error) => send_file_error(id, &error.to_string(), &mut sender, &mut noise, &mut cipher).await?,
                                            Ok(()) if data[4] != 0 => send_file_json(json!({"id":id,"ok":true,"op":"write","done":true}), &mut sender, &mut noise, &mut cipher).await?,
                                            _ => {},
                                        }
                                    } else { send_file_error(id, "Upload is not active", &mut sender, &mut noise, &mut cipher).await?; }
                                }
                                _ => return Err(invalid_config("Unsupported workspace message")),
                            }
                        }
                        Some(Ok(Message::Ping(bytes))) => { timeout(Duration::from_secs(5), sender.send(Message::Pong(bytes))).await.map_err(io::Error::other)?.map_err(io::Error::other)?; }
                        Some(Ok(Message::Pong(_))) => {},
                        _ => return Err(io::Error::other("Connection closed")),
                    }
                    Ok(())
                }.await;
                if result.is_err() { break; }
            }
            Some(Ok(response)) = jobs.join_next(), if !jobs.is_empty() => {
                if send_file_json(response, &mut sender, &mut noise, &mut cipher).await.is_err() { break; }
            }
            _ = lease.tick() => {
                if last_activity.elapsed() > Duration::from_secs(45) { break; }
                if workspace(&app, "workspace.renew".into(), json!({"client":client})).await.is_err() { break; }
            }
        }
    }
    for (_, upload) in uploads {
        upload.cancel().await;
    }
}
