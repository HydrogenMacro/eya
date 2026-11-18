//! Additive extension envelope. Existing frame meanings and Noise prologues are immutable.
use serde_json::{Value, json};
use std::io;

pub const CAPABILITY: &str = "extensions-v1";
pub fn offered(hello: &Value) -> bool {
    hello["capabilities"].as_array().is_some_and(|values| {
        values
            .iter()
            .take(64)
            .any(|v| v.as_str() == Some(CAPABILITY))
    })
}
pub fn selected(enabled: bool) -> Value {
    if enabled {
        json!([CAPABILITY])
    } else {
        json!([])
    }
}
pub fn info() -> Value {
    json!({"server":env!("CARGO_PKG_VERSION"),"client":include_str!("../../VERSION").trim(),
        "terminal":[1,2,3,4],"workspace":[1],"browser":[1],"browserRender":[1],"update":[1],"extensions":[1]})
}
// Unknown optional events are skippable; unknown requests get a correlated error.
// No operation may switch encodings implicitly. Future codecs require a separate
// capability offer/selection and must define their decoded bounds and fallback.
pub fn extension(bytes: &[u8]) -> io::Result<Option<Vec<u8>>> {
    let value: Value = serde_json::from_slice(bytes)?;
    let invalid = || io::Error::new(io::ErrorKind::InvalidData, "Invalid extension envelope");
    if value["v"] != 1 || !value.is_object() {
        return Err(invalid());
    }
    let kind = value["kind"].as_str().ok_or_else(invalid)?;
    let op = value["op"]
        .as_str()
        .filter(|op| !op.is_empty() && op.len() <= 128)
        .ok_or_else(invalid)?;
    if let Some(required) = value.get("required") {
        if !required.is_boolean() {
            return Err(invalid());
        }
    }
    if kind == "event" && value["required"] != true {
        return Ok(None);
    }
    // No server-originated requests exist in v1, so responses cannot be correlated here.
    if kind != "request" {
        return Err(invalid());
    }
    let id = value["id"]
        .as_u64()
        .filter(|id| *id <= u32::MAX as u64)
        .ok_or_else(invalid)?;
    let response = if op == "protocol.info" {
        json!({"v":1,"kind":"response","id":id,"op":op,"ok":true,"data":info()})
    } else {
        json!({"v":1,"kind":"response","id":id,"op":op,"ok":false,"error":{"code":"unsupported_operation"}})
    };
    let mut frame = vec![12];
    frame.extend_from_slice(response.to_string().as_bytes());
    Ok(Some(frame))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extensions_preserve_fallback_and_unknown_operations() {
        assert!(!offered(&json!({})));
        assert!(!offered(&json!({"capabilities":["future-codec"]})));
        assert!(offered(
            &json!({"capabilities":["future-codec",CAPABILITY]})
        ));
        assert_eq!(selected(false), json!([]));
        assert!(
            extension(br#"{"v":1,"kind":"event","op":"future","future":true}"#)
                .unwrap()
                .is_none()
        );
        let response = extension(br#"{"v":1,"kind":"request","id":8,"op":"future","future":true}"#)
            .unwrap()
            .unwrap();
        let response: Value = serde_json::from_slice(&response[1..]).unwrap();
        assert_eq!(response["id"], 8);
        assert_eq!(response["error"]["code"], "unsupported_operation");
        assert!(extension(br#"{"v":2,"kind":"event","op":"future"}"#).is_err());
    }
}
