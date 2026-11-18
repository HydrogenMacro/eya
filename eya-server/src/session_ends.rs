//! Fence an explicit end against a create confirmation still in flight.
use std::{
    collections::HashMap,
    io,
    sync::Mutex,
    time::{Duration, Instant},
};
const RETENTION: Duration = Duration::from_secs(30); // Greater than the 10s handshake deadline.
const MAX_ENDS: usize = 1024;
#[derive(Default)]
pub struct SessionEnds(Mutex<HashMap<String, Instant>>);
impl SessionEnds {
    pub fn end(&self, id: &str) -> io::Result<()> {
        if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid session ID",
            ));
        }
        let mut ends = self
            .0
            .lock()
            .map_err(|_| io::Error::other("Session lifecycle unavailable"))?;
        ends.retain(|_, expires| *expires > Instant::now());
        if ends.len() >= MAX_ENDS && !ends.contains_key(id) {
            return Err(io::Error::other("Session cleanup is busy; retry shortly"));
        }
        ends.insert(id.to_owned(), Instant::now() + RETENTION);
        Ok(())
    }
    pub fn claim<R>(&self, id: &str, register: impl FnOnce() -> R) -> io::Result<R> {
        let mut ends = self
            .0
            .lock()
            .map_err(|_| io::Error::other("Session lifecycle unavailable"))?;
        ends.retain(|_, expires| *expires > Instant::now());
        if ends.contains_key(id) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "The session was ended explicitly",
            ));
        }
        // Registration and cancellation take this lock in the same order. Once
        // registration wins, end() sees the actor when it queries the registry.
        Ok(register())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_end_prevents_late_creation_and_is_idempotent() {
        let ends = SessionEnds::default();
        let id = "1".repeat(64);
        ends.end(&id).unwrap();
        ends.end(&id).unwrap();
        assert!(
            ends.claim(&id, || panic!("late create must be fenced"))
                .is_err()
        );
        assert_eq!(ends.claim(&"2".repeat(64), || 42).unwrap(), 42);
    }
    #[test]
    fn expired_markers_release_capacity_and_invalid_ids_are_rejected() {
        let ends = SessionEnds::default();
        assert!(ends.end("invalid").is_err());
        for index in 0..MAX_ENDS {
            ends.end(&format!("{index:064x}")).unwrap();
        }
        assert!(ends.end(&"f".repeat(64)).is_err());
        for expiry in ends.0.lock().unwrap().values_mut() {
            *expiry = Instant::now();
        }
        ends.end(&"f".repeat(64)).unwrap();
        assert_eq!(ends.0.lock().unwrap().len(), 1);
    }
}
