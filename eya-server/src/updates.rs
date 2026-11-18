//! Permanent, PTY-free recovery/update bootstrap. Keep v1 usable by every release.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::sync::OnceLock;

const CHUNK: usize = 32768;
fn digest() -> &'static str {
    static DIGEST: OnceLock<String> = OnceLock::new();
    DIGEST.get_or_init(|| hex::encode(Sha256::digest(CLIENT.as_bytes())))
}
fn response(request: &Value) -> Value {
    let id = request["id"].as_u64().filter(|id| *id <= u32::MAX as u64);
    let error = |code: &str| json!({"id":id,"ok":false,"error":{"code":code}});
    if id.is_none() || request["v"] != 1 {
        return error("invalid_request");
    }
    match request["op"].as_str() {
        Some("manifest") => {
            json!({"id":id,"ok":true,"v":1,"client":include_str!("../../VERSION").trim(),
            "server":env!("CARGO_PKG_VERSION"),"sha256":digest(),"bytes":CLIENT.len(),"chunk":CHUNK,
            "artifact":"html-template-v1","config":"eya-config-v1"})
        }
        Some("read") => {
            if request["sha256"].as_str() != Some(digest()) {
                return error("release_changed");
            }
            let Some(offset) = request["offset"]
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .filter(|n| *n < CLIENT.len())
            else {
                return error("invalid_offset");
            };
            let end = offset.saturating_add(CHUNK).min(CLIENT.len());
            json!({"id":id,"ok":true,"v":1,"offset":offset,"data":STANDARD.encode(&CLIENT.as_bytes()[offset..end])})
        }
        _ => error("unsupported_operation"),
    }
}

pub async fn upgrade(State(app): State<App>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.max_message_size(65535)
        .max_frame_size(65535)
        .on_upgrade(move |socket| async move {
            let Ok(_slot) = app.update_slots.clone().try_acquire_owned() else {
                return;
            };
            // A bounded lifetime and per-frame deadlines limit authenticated and unauthenticated peers.
            let _ = timeout(Duration::from_secs(600), run(socket, app)).await;
        })
}
async fn run(mut socket: WebSocket, app: App) -> io::Result<()> {
    let mut handshake = snow::Builder::new(PROTOCOL.parse().map_err(io::Error::other)?)
        .psk(0, app.key.as_ref())
        .prologue(b"eya-update-v1")
        .build_responder()
        .map_err(io::Error::other)?;
    let mut plain = vec![0; 65535];
    let Some(Ok(Message::Binary(first))) = timeout(Duration::from_secs(10), socket.recv())
        .await
        .map_err(io::Error::other)?
    else {
        return Ok(());
    };
    handshake
        .read_message(&first, &mut plain)
        .map_err(io::Error::other)?;
    let count = handshake
        .write_message(&[], &mut plain)
        .map_err(io::Error::other)?;
    timeout(
        Duration::from_secs(10),
        socket.send(Message::Binary(plain[..count].to_vec().into())),
    )
    .await
    .map_err(io::Error::other)?
    .map_err(io::Error::other)?;
    let mut noise = handshake.into_transport_mode().map_err(io::Error::other)?;
    let mut cipher = vec![0; 65535];
    // No unsolicited response: the first encrypted request proves authentication.
    while let Some(Ok(Message::Binary(bytes))) = timeout(Duration::from_secs(30), socket.recv())
        .await
        .map_err(io::Error::other)?
    {
        let count = noise
            .read_message(&bytes, &mut plain)
            .map_err(io::Error::other)?;
        if count > 4096 {
            return Err(invalid_config("Update request too large"));
        }
        let request: Value = serde_json::from_slice(&plain[..count])?;
        let result = response(&request).to_string();
        let count = noise
            .write_message(result.as_bytes(), &mut cipher)
            .map_err(io::Error::other)?;
        timeout(
            Duration::from_secs(10),
            socket.send(Message::Binary(cipher[..count].to_vec().into())),
        )
        .await
        .map_err(io::Error::other)?
        .map_err(io::Error::other)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bootstrap_is_bounded_and_extensible() {
        let manifest = response(&json!({"v":1,"id":1,"op":"manifest","future":true}));
        assert_eq!(manifest["ok"], true);
        assert_eq!(manifest["client"], env!("CARGO_PKG_VERSION"));
        assert_eq!(CLIENT.matches(CLIENT_CONFIG_MARKER).count(), 1);
        assert!(CLIENT.len() <= 32 * 1024 * 1024);
        let mut bytes = Vec::new();
        while bytes.len() < CLIENT.len() {
            let value =
                response(&json!({"v":1,"id":2,"op":"read","sha256":digest(),"offset":bytes.len()}));
            let chunk = STANDARD.decode(value["data"].as_str().unwrap()).unwrap();
            assert!(chunk.len() <= CHUNK);
            bytes.extend(chunk);
        }
        assert_eq!(bytes, CLIENT.as_bytes());
        for (op, code) in [
            ("future", "unsupported_operation"),
            ("read", "release_changed"),
        ] {
            assert_eq!(
                response(&json!({"v":1,"id":3,"op":op}))["error"]["code"],
                code
            );
        }
        assert_eq!(
            response(&json!({"v":1,"id":4,"op":"read","sha256":digest(),"offset":CLIENT.len()}))["error"]
                ["code"],
            "invalid_offset"
        );
    }
}
