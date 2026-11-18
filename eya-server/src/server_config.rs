//! Authenticated process-local admission limits. Lowering a limit never revokes a permit.
use serde_json::{Value, json};
use std::{
    env, io,
    sync::{Arc, Mutex},
};

pub const CAPABILITY: &str = "server-config-v1";

#[derive(Default)]
struct Admission {
    limit: usize,
    active: usize,
}
pub struct Slots {
    state: Mutex<Admission>,
}
pub struct Permit {
    slots: Arc<Slots>,
}
impl Slots {
    fn new(limit: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(Admission { limit, active: 0 }),
        })
    }
    pub fn try_acquire_owned(self: Arc<Self>) -> Result<Permit, ()> {
        {
            let mut state = self.state.lock().map_err(|_| ())?;
            if state.active >= state.limit {
                return Err(());
            }
            state.active += 1;
        }
        Ok(Permit { slots: self })
    }
    pub fn active(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.active)
            .unwrap_or(usize::MAX)
    }
    pub fn limit(&self) -> usize {
        self.state.lock().map(|state| state.limit).unwrap_or(0)
    }
    fn set(&self, limit: usize) {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .limit = limit;
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        let mut state = self
            .slots
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.active = state.active.saturating_sub(1);
    }
}

struct Setting {
    key: &'static str,
    env: &'static str,
    default: usize,
    max: usize,
    slots: Arc<Slots>,
}
pub struct Config {
    revision: Mutex<u64>,
    settings: Vec<Setting>,
}
impl Config {
    pub fn from_env() -> io::Result<Arc<Self>> {
        let mut settings = Vec::new();
        for (key, name, default, max) in [
            ("terminalSessions", "EYA_TERMINAL_SESSIONS", 8, 128),
            ("workspaceConnections", "EYA_WORKSPACE_CONNECTIONS", 32, 256),
            ("handshakeConnections", "EYA_HANDSHAKE_CONNECTIONS", 8, 128),
            (
                "basicBrowserConnections",
                "EYA_BASIC_BROWSER_CONNECTIONS",
                4,
                64,
            ),
            ("fullBrowserSessions", "EYA_FULL_BROWSER_SESSIONS", 4, 64),
            ("fullBrowserRuntimes", "EYA_FULL_BROWSER_RUNTIMES", 2, 16),
            ("machineJobs", "EYA_MACHINE_JOBS", 8, 64),
        ] {
            let limit = match env::var(name) {
                Ok(text) => text
                    .parse::<usize>()
                    .ok()
                    .filter(|value| (1..=max).contains(value))
                    .ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::InvalidInput,
                            format!("{name} must be 1–{max}"),
                        )
                    })?,
                Err(env::VarError::NotPresent) => default,
                Err(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("{name} must be valid text"),
                    ));
                }
            };
            settings.push(Setting {
                key,
                env: name,
                default,
                max,
                slots: Slots::new(limit),
            });
        }
        Ok(Arc::new(Self {
            revision: Mutex::new(1),
            settings,
        }))
    }
    pub fn slots(&self, key: &str) -> Arc<Slots> {
        self.settings
            .iter()
            .find(|setting| setting.key == key)
            .expect("known admission setting")
            .slots
            .clone()
    }
    fn value(&self, revision: u64, browser_sessions: usize) -> Value {
        let mut settings = serde_json::Map::new();
        let mut usage = serde_json::Map::new();
        let mut bounds = serde_json::Map::new();
        for setting in &self.settings {
            settings.insert(setting.key.into(), json!(setting.slots.limit()));
            usage.insert(
                setting.key.into(),
                json!(if setting.key == "fullBrowserSessions" {
                    browser_sessions
                } else {
                    setting.slots.active()
                }),
            );
            bounds.insert(
                setting.key.into(),
                json!({"min":1,"max":setting.max,"default":setting.default,"env":setting.env}),
            );
        }
        json!({"revision":revision,"settings":settings,"usage":usage,"bounds":bounds,"scope":"process"})
    }
    pub fn handle(&self, op: &str, request: &Value, browser_sessions: usize) -> io::Result<Value> {
        let mut revision = self
            .revision
            .lock()
            .map_err(|_| io::Error::other("Server settings unavailable"))?;
        if op == "server.config.set" {
            if request["revision"].as_u64() != Some(*revision) {
                return Err(io::Error::other(
                    "Server settings changed. Refresh before applying.",
                ));
            }
            let patch = request["settings"]
                .as_object()
                .filter(|patch| !patch.is_empty() && patch.len() <= self.settings.len())
                .ok_or_else(|| io::Error::other("A bounded settings object is required"))?;
            let mut changes = Vec::new();
            for (key, value) in patch {
                let setting = self
                    .settings
                    .iter()
                    .find(|setting| setting.key == key)
                    .ok_or_else(|| io::Error::other("Unknown server setting"))?;
                let limit = value
                    .as_u64()
                    .and_then(|value| usize::try_from(value).ok())
                    .filter(|value| (1..=setting.max).contains(value))
                    .ok_or_else(|| {
                        io::Error::other(format!("{} must be 1–{}", setting.key, setting.max))
                    })?;
                changes.push((setting, limit));
            }
            let next_revision = revision
                .checked_add(1)
                .ok_or_else(|| io::Error::other("Settings revision exhausted"))?;
            // Validate the entire patch before changing any admission policy.
            for (setting, limit) in changes {
                setting.slots.set(limit);
            }
            *revision = next_revision;
        } else if op != "server.config.get" {
            return Err(io::Error::other("Unsupported server settings operation"));
        }
        Ok(self.value(*revision, browser_sessions))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lowering_limits_keeps_existing_permits_and_bounds_new_admission() {
        let slots = Slots::new(3);
        let first = slots.clone().try_acquire_owned().unwrap();
        let second = slots.clone().try_acquire_owned().unwrap();
        slots.set(1);
        assert_eq!(slots.active(), 2);
        assert!(slots.clone().try_acquire_owned().is_err());
        drop(first);
        assert!(slots.clone().try_acquire_owned().is_err());
        drop(second);
        let last = slots.clone().try_acquire_owned().unwrap();
        assert_eq!(slots.active(), 1);
        slots.set(2);
        assert!(slots.clone().try_acquire_owned().is_ok());
        drop(last);
        assert_eq!(slots.active(), 0);
    }
    #[test]
    fn settings_validate_atomically_and_check_revisions() {
        let config = Config::from_env().unwrap();
        let initial = config.handle("server.config.get", &json!({}), 2).unwrap();
        let current = config.handle("server.config.set",&json!({"revision":1,"settings":{"terminalSessions":1,"fullBrowserRuntimes":3},"future":true}),2).unwrap();
        assert_eq!(current["revision"], 2);
        assert_eq!(current["settings"]["terminalSessions"], 1);
        assert_eq!(current["usage"]["fullBrowserSessions"], 2);
        assert!(
            config
                .handle(
                    "server.config.set",
                    &json!({"revision":1,"settings":{"terminalSessions":2}}),
                    0
                )
                .is_err()
        );
        assert!(
            config
                .handle(
                    "server.config.set",
                    &json!({"revision":2,"settings":{"terminalSessions":2,"machineJobs":100000}}),
                    0
                )
                .is_err()
        );
        assert_eq!(
            config.handle("server.config.get", &json!({}), 0).unwrap()["settings"]["terminalSessions"],
            1
        );
        for patch in [
            json!({"terminalSessions":0}),
            json!({"terminalSessions":1.5}),
            json!({"terminalSessions":"3"}),
            json!({"unknown":2}),
        ] {
            assert!(
                config
                    .handle(
                        "server.config.set",
                        &json!({"revision":2,"settings":patch}),
                        0
                    )
                    .is_err()
            );
        }
        assert_eq!(initial["bounds"]["machineJobs"]["max"], 64);
    }
}
