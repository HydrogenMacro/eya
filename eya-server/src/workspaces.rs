//! Single-user workspace metadata. Only explicitly named workspaces are durable.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{self, Read, Write},
    os::fd::AsRawFd,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const SCHEMA: u32 = 1;
const MAX_STORE: usize = 4 * 1024 * 1024;
const MAX_WORKSPACES: usize = 64;
const MAX_ANONYMOUS: usize = 64;
const MAX_TABS: usize = 128;
const MAX_WORKSPACE: usize = 48 * 1024;
pub const ANONYMOUS_TTL: u64 = 10 * 60;

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            Self(env::temp_dir().join(format!("eya-workspaces-{}", new_id().unwrap())))
        }
        fn open(&self) -> Store {
            Store::open(self.0.clone()).unwrap()
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn update(workspace: &Value) -> Value {
        json!({"workspace":workspace["id"],"revision":workspace["revision"],"tabs":workspace["tabs"],"layout":workspace["layout"]})
    }
    fn add_terminal(request: &mut Value, session: &str) {
        request["tabs"] =
            json!([{"id":"tab-1","kind":"terminal","title":"Shell","session":session,"config":{}}]);
        request["layout"]["tabs"] = json!(["tab-1"]);
        request["layout"]["active"] = json!("tab-1");
    }
    #[test]
    fn anonymous_clients_are_isolated_and_only_renew_in_the_same_server() {
        let dir = Directory::new();
        let mut store = dir.open();
        let first = store.start(None).unwrap();
        let second = store.start(None).unwrap();
        assert_ne!(first["client"], second["client"]);
        assert_ne!(first["workspace"]["id"], second["workspace"]["id"]);
        assert_eq!(
            store.start(first["client"].as_str()).unwrap()["workspace"]["id"],
            first["workspace"]["id"]
        );
        assert!(!dir.0.join("workspaces.json").exists());
        let listed = store
            .handle("workspace.list", &json!({"client":first["client"]}))
            .unwrap();
        assert_eq!(listed["workspaces"].as_array().unwrap().len(), 1);
        assert_eq!(listed["workspaces"][0]["id"], first["workspace"]["id"]);
        assert!(listed["workspaces"][0].get("client").is_none());
        assert_eq!(
            store.handle("workspace.list", &json!({})).unwrap()["workspaces"],
            json!([])
        );
        drop(store);
        let mut store = dir.open();
        assert_ne!(
            store.start(first["client"].as_str()).unwrap()["workspace"]["id"],
            first["workspace"]["id"]
        );
        let listed = store.handle("workspace.list", &json!({})).unwrap();
        assert_eq!(listed["workspaces"], json!([]));
    }
    #[test]
    fn durable_compare_and_swap_and_named_workspace() {
        let dir = Directory::new();
        let mut store = dir.open();
        let workspace = store.start(None).unwrap()["workspace"].clone();
        let mut request = update(&workspace);
        add_terminal(
            &mut request,
            "1111111111111111111111111111111111111111111111111111111111111111",
        );
        let saved = store.handle("workspace.update", &request).unwrap();
        assert_eq!(saved["workspace"]["revision"], 2);
        assert_eq!(
            store.handle("workspace.update", &request).unwrap()["conflict"],
            true
        );
        let renamed = store
            .handle(
                "workspace.rename",
                &json!({"workspace":workspace["id"],"revision":2,"name":"Work"}),
            )
            .unwrap();
        assert!(renamed["workspace"]["expires"].is_null());
        drop(store);
        let mut store = dir.open();
        let restored = store
            .handle("workspace.load", &json!({"workspace":workspace["id"]}))
            .unwrap();
        assert_eq!(
            restored["workspace"]["tabs"][0]["session"],
            "1111111111111111111111111111111111111111111111111111111111111111"
        );
        assert_eq!(restored["workspace"]["name"], "Work");
        assert_eq!(
            fs::metadata(dir.0.join("workspaces.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&dir.0).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    #[test]
    fn invalid_layout_and_duplicate_session_assignments_do_not_commit() {
        let dir = Directory::new();
        let mut store = dir.open();
        let first = store.start(None).unwrap()["workspace"].clone();
        let second = store.start(None).unwrap()["workspace"].clone();
        let mut request = update(&first);
        add_terminal(
            &mut request,
            "1111111111111111111111111111111111111111111111111111111111111111",
        );
        request["layout"]["tabs"] = json!(["tab-1", "tab-1"]);
        assert!(store.handle("workspace.update", &request).is_err());
        request["layout"]["tabs"] = json!(["tab-1"]);
        store.handle("workspace.update", &request).unwrap();
        let mut other = update(&second);
        add_terminal(
            &mut other,
            "1111111111111111111111111111111111111111111111111111111111111111",
        );
        assert!(store.handle("workspace.update", &other).is_err());
        other["tabs"][0]["session"] =
            json!("2222222222222222222222222222222222222222222222222222222222222222");
        other["layout"] = json!({"type":"split","id":"split-1","orientation":"vertical","ratio":1.0,"first":other["layout"],"second":{"type":"group","id":"group-2","tabs":[],"active":null}});
        assert!(store.handle("workspace.update", &other).is_err());
        assert_eq!(store.workspaces[second["id"].as_str().unwrap()].revision, 1);
    }
    #[test]
    fn copying_never_shares_runtime_sessions_and_deletion_leaves_them_unassigned() {
        let dir = Directory::new();
        let mut store = dir.open();
        let workspace = store.start(None).unwrap()["workspace"].clone();
        let mut request = update(&workspace);
        add_terminal(
            &mut request,
            "1111111111111111111111111111111111111111111111111111111111111111",
        );
        store.handle("workspace.update", &request).unwrap();
        let copy = store
            .handle(
                "workspace.copy",
                &json!({"workspace":workspace["id"],"revision":2,"name":"Copy"}),
            )
            .unwrap();
        assert!(copy["workspace"]["tabs"][0]["session"].is_null());
        assert_ne!(copy["workspace"]["id"], workspace["id"]);
        let removed = store
            .handle(
                "workspace.delete",
                &json!({"workspace":workspace["id"],"revision":2}),
            )
            .unwrap();
        assert_eq!(
            removed["sessions"],
            json!(["1111111111111111111111111111111111111111111111111111111111111111"])
        );
        assert_eq!(
            store.owner("1111111111111111111111111111111111111111111111111111111111111111"),
            None
        );
    }
    #[test]
    fn moving_a_tab_commits_both_revisions_and_session_ownership_together() {
        let dir = Directory::new();
        let mut store = dir.open();
        let first = store.start(None).unwrap()["workspace"].clone();
        let second = store
            .handle("workspace.create", &json!({"name":"Destination"}))
            .unwrap()["workspace"]
            .clone();
        let mut request = update(&first);
        add_terminal(
            &mut request,
            "1111111111111111111111111111111111111111111111111111111111111111",
        );
        store.handle("workspace.update", &request).unwrap();
        let mut movement = json!({"workspace":first["id"],"revision":2,"target":second["id"],"targetRevision":99,"tab":"tab-1"});
        assert_eq!(
            store.handle("workspace.move_tab", &movement).unwrap()["conflict"],
            true
        );
        assert_eq!(
            store.owner("1111111111111111111111111111111111111111111111111111111111111111"),
            first["id"].as_str()
        );
        movement["targetRevision"] = 1.into();
        let moved = store.handle("workspace.move_tab", &movement).unwrap();
        assert_eq!(moved["workspace"]["tabs"], json!([]));
        assert_eq!(moved["workspace"]["revision"], 3);
        assert_eq!(moved["targetWorkspace"]["revision"], 2);
        assert_eq!(
            store.owner("1111111111111111111111111111111111111111111111111111111111111111"),
            second["id"].as_str()
        );
        drop(store);
        assert_eq!(
            dir.open()
                .owner("1111111111111111111111111111111111111111111111111111111111111111"),
            second["id"].as_str()
        );
    }
    #[test]
    fn storage_failure_keeps_revision_and_memory_unchanged() {
        let dir = Directory::new();
        let mut store = dir.open();
        let workspace = store
            .handle("workspace.create", &json!({"name":"Original"}))
            .unwrap()["workspace"]
            .clone();
        let old = fs::read(dir.0.join("workspaces.json")).unwrap();
        // Deterministic write failure, also works when tests run with uid 0.
        let moved = dir.0.with_extension("moved");
        fs::rename(&dir.0, &moved).unwrap();
        let result = store.handle(
            "workspace.rename",
            &json!({"workspace":workspace["id"],"revision":1,"name":"Changed"}),
        );
        fs::rename(&moved, &dir.0).unwrap();
        assert!(result.is_err());
        assert_eq!(
            store.workspaces[workspace["id"].as_str().unwrap()].revision,
            1
        );
        assert_eq!(fs::read(dir.0.join("workspaces.json")).unwrap(), old);
    }
    #[test]
    fn corruption_recovers_backup_and_preserves_evidence() {
        let dir = Directory::new();
        let mut store = dir.open();
        let first = store
            .handle("workspace.create", &json!({"name":"First"}))
            .unwrap();
        store
            .handle("workspace.create", &json!({"name":"Second"}))
            .unwrap();
        drop(store);
        fs::write(dir.0.join("workspaces.json"), b"broken JSON").unwrap();
        let mut store = dir.open();
        assert!(store.warning.is_some());
        assert_eq!(
            store
                .handle(
                    "workspace.load",
                    &json!({"workspace":first["workspace"]["id"]})
                )
                .unwrap()["workspace"]["id"],
            first["workspace"]["id"]
        );
        assert!(fs::read_dir(&dir.0).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("workspaces.corrupt-")
        }));
    }
    #[test]
    fn leases_expire_without_recreating_deleted_workspaces() {
        let dir = Directory::new();
        let mut store = dir.open();
        let initial = store.start(None).unwrap();
        store
            .workspaces
            .get_mut(initial["workspace"]["id"].as_str().unwrap())
            .unwrap()
            .expires = Some(0);
        store.expire().unwrap();
        assert!(store.workspaces.is_empty());
        assert_eq!(
            store.renew(initial["client"].as_str().unwrap()).unwrap()["renewed"],
            false
        );
        assert!(store.workspaces.is_empty());
    }
    #[test]
    fn one_server_owns_state_directory_and_unknown_schema_is_preserved() {
        let dir = Directory::new();
        let store = dir.open();
        assert!(Store::open(dir.0.clone()).is_err());
        drop(store);
        fs::write(
            dir.0.join("workspaces.json"),
            br#"{"schema":999,"workspaces":[]}"#,
        )
        .unwrap();
        assert!(
            matches!(Store::open(dir.0.clone()), Err(error) if error.kind() == io::ErrorKind::Unsupported)
        );
        assert!(dir.0.join("workspaces.json").exists());
    }
    #[test]
    fn anonymous_replacement_keeps_page_identity_and_selected_workspaces_renew() {
        let dir = Directory::new();
        let mut store = dir.open();
        let original = store.start(None).unwrap();
        store
            .handle(
                "workspace.delete",
                &json!({"workspace":original["workspace"]["id"],"revision":1}),
            )
            .unwrap();
        let replacement = store.start(original["client"].as_str()).unwrap();
        assert_eq!(replacement["client"], original["client"]);
        assert_ne!(replacement["workspace"]["id"], original["workspace"]["id"]);
        let id = replacement["workspace"]["id"].as_str().unwrap();
        store.workspaces.get_mut(id).unwrap().expires = Some(now() + 1);
        assert_eq!(store.renew_workspace(id).unwrap()["renewed"], true);
        assert!(store.workspaces[id].expires.unwrap() >= now() + ANONYMOUS_TTL - 1);
        assert_eq!(
            store.workspaces[id].revision, 1,
            "Lease renewal is not a layout edit"
        );
    }
    #[test]
    fn metadata_bounds_and_invalid_known_resume_fields_are_rejected() {
        let dir = Directory::new();
        let mut store = dir.open();
        let original = store.start(None).unwrap()["workspace"].clone();
        let mut request = update(&original);
        add_terminal(&mut request, "invalid-runtime-id");
        assert!(store.handle("workspace.update", &request).is_err());
        request["tabs"][0] = json!({"id":"tab-1","kind":"file","title":"Video","config":{"path":"/video.webm","time":-1}});
        assert!(store.handle("workspace.update", &request).is_err());
        request["tabs"][0]["config"]["time"] = json!(12.5);
        store.handle("workspace.update", &request).unwrap();
        request["revision"] = 2.into();
        request["tabs"][0]["config"]["path"] = "x".repeat(4097).into();
        assert!(store.handle("workspace.update", &request).is_err());
        request["tabs"][0] = json!({"id":"tab-1","kind":"future-panel","title":"Future","config":{"opaque":{"value":42}}});
        assert!(
            store.handle("workspace.update", &request).is_ok(),
            "Unknown kinds preserve bounded descriptors for future readers"
        );
    }
    #[test]
    fn workspace_count_is_bounded_and_capacity_can_be_recovered() {
        let dir = Directory::new();
        let mut store = dir.open();
        let initial = store.start(None).unwrap();
        for index in 0..MAX_WORKSPACES {
            store
                .handle(
                    "workspace.create",
                    &json!({"name":format!("Workspace {index}")}),
                )
                .unwrap();
        }
        assert!(
            store.start(None).is_ok(),
            "Durable capacity does not prevent an anonymous workspace"
        );
        assert!(
            store
                .handle("workspace.create", &json!({"name":"Too many"}))
                .is_err()
        );
        assert!(store.handle("workspace.rename", &json!({"workspace":initial["workspace"]["id"],"revision":1,"name":"Cannot save yet"})).is_err());
        assert!(
            store.workspaces[initial["workspace"]["id"].as_str().unwrap()]
                .name
                .is_none()
        );
        let named = store
            .workspaces
            .values()
            .find(|workspace| workspace.name.is_some())
            .unwrap()
            .clone();
        store
            .handle(
                "workspace.delete",
                &json!({"workspace":named.id,"revision":named.revision}),
            )
            .unwrap();
        store
            .handle(
                "workspace.rename",
                &json!({"workspace":initial["workspace"]["id"],"revision":1,"name":"Now saved"}),
            )
            .unwrap();
        assert_eq!(store.named_count(), MAX_WORKSPACES);
        for _ in 1..MAX_ANONYMOUS {
            store.start(None).unwrap();
        }
        assert!(
            store.start(None).is_err(),
            "Anonymous memory is independently bounded"
        );
    }

    #[test]
    fn anonymous_changes_never_reach_disk_or_require_writable_storage() {
        let dir = Directory::new();
        let mut store = dir.open();
        store
            .handle("workspace.create", &json!({"name":"Saved"}))
            .unwrap();
        let before = fs::read(dir.0.join("workspaces.json")).unwrap();
        let anonymous = store.start(None).unwrap()["workspace"].clone();
        let mut request = update(&anonymous);
        add_terminal(&mut request, &"1".repeat(64));
        let moved = dir.0.with_extension("unavailable");
        fs::rename(&dir.0, &moved).unwrap();
        let saved = store.handle("workspace.update", &request);
        let another = store.start(None);
        let promoted = store.handle(
            "workspace.rename",
            &json!({"workspace":anonymous["id"],"revision":2,"name":"Explicit save"}),
        );
        fs::rename(&moved, &dir.0).unwrap();
        assert!(saved.is_ok());
        assert!(another.is_ok());
        assert!(promoted.is_err());
        assert!(
            store.workspaces[anonymous["id"].as_str().unwrap()]
                .name
                .is_none()
        );
        assert_eq!(fs::read(dir.0.join("workspaces.json")).unwrap(), before);
        store
            .handle(
                "workspace.rename",
                &json!({"workspace":anonymous["id"],"revision":2,"name":"Explicit save"}),
            )
            .unwrap();
        let persisted: Snapshot =
            serde_json::from_slice(&fs::read(dir.0.join("workspaces.json")).unwrap()).unwrap();
        let backup: Snapshot =
            serde_json::from_slice(&fs::read(dir.0.join("workspaces.backup.json")).unwrap())
                .unwrap();
        assert!(
            persisted
                .workspaces
                .iter()
                .all(|workspace| workspace.name.is_some())
        );
        assert!(
            backup
                .workspaces
                .iter()
                .all(|workspace| workspace.name.is_some())
        );
        drop(store);
        let restored = dir.open();
        assert_eq!(restored.workspaces.len(), 2);
        assert_eq!(
            restored.workspaces[anonymous["id"].as_str().unwrap()]
                .tabs
                .len(),
            1
        );
    }

    #[test]
    fn legacy_anonymous_records_are_not_restored() {
        let dir = Directory::new();
        let mut store = dir.open();
        let anonymous = store.start(None).unwrap()["workspace"].clone();
        store
            .handle("workspace.create", &json!({"name":"Saved"}))
            .unwrap();
        let mut snapshot: Snapshot =
            serde_json::from_slice(&fs::read(dir.0.join("workspaces.json")).unwrap()).unwrap();
        snapshot
            .workspaces
            .push(serde_json::from_value(anonymous).unwrap());
        fs::write(
            dir.0.join("workspaces.json"),
            serde_json::to_vec(&snapshot).unwrap(),
        )
        .unwrap();
        drop(store);
        let restored = dir.open();
        assert_eq!(restored.workspaces.len(), 1);
        assert!(
            restored
                .workspaces
                .values()
                .all(|workspace| workspace.name.is_some())
        );
    }

    #[test]
    fn minimized_tabs_stay_out_of_layout_and_survive_move_copy_and_restart() {
        let dir = Directory::new();
        let mut store = dir.open();
        let first = store.start(None).unwrap()["workspace"].clone();
        let second = store
            .handle("workspace.create", &json!({"name":"Saved"}))
            .unwrap()["workspace"]
            .clone();
        let mut request = update(&first);
        add_terminal(&mut request, &"2".repeat(64));
        request["tabs"][0]["minimized"] = true.into();
        assert!(
            store.handle("workspace.update", &request).is_err(),
            "Minimized tabs cannot remain in a group"
        );
        request["layout"]["tabs"] = json!([]);
        request["layout"]["active"] = Value::Null;
        store.handle("workspace.update", &request).unwrap();
        let moved = store.handle("workspace.move_tab", &json!({"workspace":first["id"],"revision":2,"target":second["id"],"targetRevision":1,"tab":"tab-1"})).unwrap();
        assert_eq!(moved["targetWorkspace"]["tabs"][0]["minimized"], true);
        assert_eq!(moved["targetWorkspace"]["layout"]["tabs"], json!([]));
        let copy = store
            .handle(
                "workspace.copy",
                &json!({"workspace":second["id"],"revision":2,"name":"Copy"}),
            )
            .unwrap();
        assert_eq!(copy["workspace"]["tabs"][0]["minimized"], true);
        assert!(copy["workspace"]["tabs"][0]["session"].is_null());
        drop(store);
        let restored = dir.open();
        assert!(restored.workspaces[second["id"].as_str().unwrap()].tabs[0].minimized);
    }
}
pub fn new_id() -> io::Result<String> {
    let mut bytes = [0; 32];
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(hex::encode(bytes))
}
fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tab {
    pub id: String,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub minimized: bool,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default = "empty_object")]
    pub config: Value,
}
fn empty_object() -> Value {
    json!({})
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Layout {
    Group {
        id: String,
        tabs: Vec<String>,
        active: Option<String>,
    },
    Split {
        id: String,
        orientation: String,
        ratio: f64,
        first: Box<Layout>,
        second: Box<Layout>,
    },
}
impl Layout {
    fn empty() -> io::Result<Self> {
        Ok(Self::Group {
            id: new_id()?,
            tabs: vec![],
            active: None,
        })
    }
    fn remove_tab(&mut self, tab: &str) -> bool {
        match self {
            Self::Group { tabs, active, .. } => {
                tabs.retain(|id| id != tab);
                if active.as_deref() == Some(tab) {
                    *active = tabs.first().cloned();
                }
                tabs.is_empty()
            }
            Self::Split { first, second, .. } => {
                let a = first.remove_tab(tab);
                let b = second.remove_tab(tab);
                if a {
                    *self = (**second).clone();
                } else if b {
                    *self = (**first).clone();
                }
                a && b
            }
        }
    }
    fn append_tab(&mut self, tab: &str, group: Option<&str>) -> bool {
        match self {
            Self::Group { id, tabs, active } if group.is_none_or(|group| group == id) => {
                tabs.push(tab.into());
                *active = Some(tab.into());
                true
            }
            Self::Group { .. } => false,
            Self::Split { first, second, .. } => {
                first.append_tab(tab, group) || second.append_tab(tab, group)
            }
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Workspace {
    pub id: String,
    pub name: Option<String>,
    pub revision: u64,
    pub updated: u64,
    pub expires: Option<u64>,
    pub tabs: Vec<Tab>,
    pub layout: Layout,
    #[serde(default = "empty_object")]
    pub preferences: Value,
    // A page identity, never an authentication credential. Kept off the wire in lists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client: Option<String>,
}
impl Workspace {
    pub fn public(&self) -> Value {
        let mut value = serde_json::to_value(self).expect("workspace serializes");
        value.as_object_mut().unwrap().remove("client");
        value
    }
    fn validate(&self) -> io::Result<()> {
        if !valid_id(&self.id)
            || self
                .name
                .as_ref()
                .is_some_and(|s| s.trim().is_empty() || s.len() > 128)
            || self.tabs.len() > MAX_TABS
            || !self.preferences.is_object()
            || serde_json::to_vec(self)?.len() > MAX_WORKSPACE
        {
            return Err(invalid("Workspace exceeds a bound or has invalid metadata"));
        }
        let mut tabs = HashSet::new();
        for tab in &self.tabs {
            if !valid_id(&tab.id)
                || !valid_id(&tab.kind)
                || tab.title.len() > 256
                || !tabs.insert(tab.id.as_str())
                || !tab.config.is_object()
                || serde_json::to_vec(&tab.config)?.len() > 8192
                || tab.session.as_ref().is_some_and(|id| !valid_id(id))
            {
                return Err(invalid("Invalid or duplicate tab descriptor"));
            }
            if matches!(tab.kind.as_str(), "terminal" | "web-browser")
                && tab.session.as_ref().is_some_and(|id| {
                    id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
            {
                return Err(invalid("Invalid runtime session ID"));
            }
            if tab.kind == "file" {
                if tab.config["path"].as_str().is_none()
                    || tab
                        .config
                        .get("viewer")
                        .is_some_and(|value| value.as_str().is_none_or(|value| !valid_id(value)))
                    || tab
                        .config
                        .get("version")
                        .is_some_and(|value| value.as_str().is_none_or(|value| value.len() > 256))
                    || tab.config.get("time").is_some_and(|value| {
                        value.as_f64().is_none_or(|value| {
                            !value.is_finite() || !(0.0..=1.0e9).contains(&value)
                        })
                    })
                    || tab
                        .config
                        .get("paused")
                        .is_some_and(|value| !value.is_boolean())
                {
                    return Err(invalid("Invalid file viewer descriptor"));
                }
            }
            if let Some(path) = tab.config.get("path").or_else(|| tab.config.get("cwd"))
                && path
                    .as_str()
                    .is_none_or(|path| path.len() > 4096 || path.contains('\0'))
            {
                return Err(invalid("Invalid tab path"));
            }
        }
        fn walk<'a>(
            node: &'a Layout,
            depth: usize,
            nodes: &mut HashSet<&'a str>,
            used: &mut HashSet<&'a str>,
            tabs: &HashSet<&str>,
        ) -> io::Result<()> {
            if depth > 16 || nodes.len() >= 256 {
                return Err(invalid("Layout is too deep"));
            }
            let id = match node {
                Layout::Group { id, .. } | Layout::Split { id, .. } => id,
            };
            if !valid_id(id) || !nodes.insert(id) {
                return Err(invalid("Invalid or duplicate layout node"));
            }
            match node {
                Layout::Group {
                    tabs: members,
                    active,
                    ..
                } => {
                    for id in members {
                        if !tabs.contains(id.as_str()) || !used.insert(id) {
                            return Err(invalid("Invalid or duplicate layout tab"));
                        }
                    }
                    if active.as_ref().is_some_and(|id| !members.contains(id))
                        || (!members.is_empty() && active.is_none())
                    {
                        return Err(invalid("Invalid active tab"));
                    }
                }
                Layout::Split {
                    orientation,
                    ratio,
                    first,
                    second,
                    ..
                } => {
                    if !["vertical", "horizontal"].contains(&orientation.as_str())
                        || !ratio.is_finite()
                        || *ratio <= 0.0
                        || *ratio >= 1.0
                    {
                        return Err(invalid("Invalid split orientation or ratio"));
                    }
                    walk(first, depth + 1, nodes, used, tabs)?;
                    walk(second, depth + 1, nodes, used, tabs)?;
                }
            }
            Ok(())
        }
        let visible: HashSet<_> = self
            .tabs
            .iter()
            .filter(|tab| !tab.minimized)
            .map(|tab| tab.id.as_str())
            .collect();
        let mut used = HashSet::new();
        walk(&self.layout, 0, &mut HashSet::new(), &mut used, &visible)?;
        if used != visible {
            return Err(invalid(
                "Every visible tab must appear in exactly one group",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    schema: u32,
    workspaces: Vec<Workspace>,
}

pub struct Store {
    directory: PathBuf,
    _lock: fs::File,
    workspaces: HashMap<String, Workspace>,
    pub warning: Option<String>,
}
impl Store {
    pub fn from_env() -> io::Result<Self> {
        let directory = if let Some(path) = env::var_os("EYA_STATE_DIR") {
            PathBuf::from(path)
        } else if let Some(path) = env::var_os("XDG_STATE_HOME") {
            PathBuf::from(path).join("eya")
        } else {
            PathBuf::from(env::var_os("HOME").ok_or_else(|| invalid("Set EYA_STATE_DIR or HOME"))?)
                .join(".local/state/eya")
        };
        Self::open(directory)
    }
    pub fn open(directory: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(&directory)?;
        if fs::symlink_metadata(&directory)?.file_type().is_symlink() {
            return Err(invalid("State directory must not be a symlink"));
        }
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(directory.join("workspaces.lock"))?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::other(
                "Another server is using EYA_STATE_DIR; each server needs its own directory",
            ));
        }
        let mut store = Self {
            directory,
            _lock: lock,
            workspaces: HashMap::new(),
            warning: None,
        };
        let path = store.directory.join("workspaces.json");
        if path.exists() {
            match store.load(&path) {
                Ok(records) => store.workspaces = records,
                Err(error) => {
                    // Leave evidence intact and never silently overwrite an unsupported schema.
                    if error.kind() == io::ErrorKind::Unsupported {
                        return Err(error);
                    }
                    fs::rename(
                        &path,
                        store
                            .directory
                            .join(format!("workspaces.corrupt-{}.json", new_id()?)),
                    )?;
                    store.warning = Some("Damaged workspace storage was quarantined; inspect the server state directory.".into());
                    let backup = store.directory.join("workspaces.backup.json");
                    if backup.exists() {
                        match store.load(&backup) {
                            Ok(records) => store.workspaces = records,
                            Err(_) => store.warning = Some("Workspace storage and backup are damaged; preserved in the state directory.".into()),
                        }
                    }
                }
            }
        }
        Ok(store)
    }
    fn load(&mut self, path: &Path) -> io::Result<HashMap<String, Workspace>> {
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)?;
        if !file.metadata()?.is_file() || file.metadata()?.len() > MAX_STORE as u64 {
            return Err(invalid("Invalid workspace storage size"));
        }
        let snapshot: Snapshot = serde_json::from_reader(file.take((MAX_STORE + 1) as u64))?;
        if snapshot.schema != SCHEMA {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Unsupported workspace schema; keep existing state and migrate explicitly",
            ));
        }
        if snapshot.workspaces.len() > MAX_WORKSPACES {
            return Err(invalid("Too many workspaces"));
        }
        let mut records = HashMap::new();
        let mut sessions = HashSet::new();
        for workspace in snapshot.workspaces {
            // Old schema-1 stores included leased anonymous records. They are
            // deliberately discarded rather than resurrected after a restart.
            if workspace.name.is_none() {
                continue;
            }
            if workspace.validate().is_err()
                || records.contains_key(&workspace.id)
                || workspace
                    .tabs
                    .iter()
                    .filter_map(|tab| tab.session.as_ref())
                    .any(|id| sessions.contains(id))
            {
                self.warning = Some("Some workspace records are damaged; the original file is preserved as a backup.".into());
                fs::copy(
                    path,
                    self.directory
                        .join(format!("workspaces.partial-{}.json", new_id()?)),
                )?;
                continue;
            }
            sessions.extend(workspace.tabs.iter().filter_map(|tab| tab.session.clone()));
            records.insert(workspace.id.clone(), workspace);
        }
        Ok(records)
    }
    fn durable_snapshot(records: &HashMap<String, Workspace>) -> io::Result<Vec<u8>> {
        let mut workspaces: Vec<_> = records
            .values()
            .filter(|workspace| workspace.name.is_some())
            .cloned()
            .collect();
        if workspaces.len() > MAX_WORKSPACES {
            return Err(invalid("Workspace limit reached"));
        }
        workspaces.sort_by(|a, b| a.id.cmp(&b.id));
        let data = serde_json::to_vec(&Snapshot {
            schema: SCHEMA,
            workspaces,
        })?;
        if data.len() > MAX_STORE {
            return Err(invalid("Workspace storage is full"));
        }
        Ok(data)
    }
    fn named_count(&self) -> usize {
        self.workspaces
            .values()
            .filter(|workspace| workspace.name.is_some())
            .count()
    }
    fn commit(&mut self, next: HashMap<String, Workspace>) -> io::Result<()> {
        let data = Self::durable_snapshot(&next)?;
        let previous = Self::durable_snapshot(&self.workspaces)?;
        // Anonymous updates, renewals and expiry never touch durable storage.
        // They remain usable even when the state volume is full/unwritable.
        if data == previous {
            self.workspaces = next;
            return Ok(());
        }
        let path = self.directory.join("workspaces.json");
        let temporary = self
            .directory
            .join(format!(".workspaces-{}.tmp", new_id()?));
        let result: io::Result<()> = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)?;
            file.write_all(&data)?;
            file.sync_all()?;
            if path.exists() {
                let backup = self.directory.join("workspaces.backup.json");
                // Replace rather than follow an existing backup symlink.
                let backup_temp = self.directory.join(format!(".backup-{}.tmp", new_id()?));
                let mut backup_file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&backup_temp)?;
                backup_file.write_all(&previous)?;
                backup_file.sync_all()?;
                fs::rename(backup_temp, backup)?;
            }
            fs::rename(&temporary, &path)?;
            fs::File::open(&self.directory)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result?;
        self.workspaces = next;
        Ok(())
    }
    pub fn expire(&mut self) -> io::Result<()> {
        let mut next = self.workspaces.clone();
        next.retain(|_, workspace| workspace.expires.is_none_or(|expires| expires > now()));
        if next.len() != self.workspaces.len() {
            self.commit(next)?;
        }
        Ok(())
    }
    pub fn start(&mut self, client: Option<&str>) -> io::Result<Value> {
        self.expire()?;
        if let Some(client) = client.filter(|id| valid_id(id))
            && let Some(workspace) = self
                .workspaces
                .values()
                .find(|workspace| workspace.client.as_deref() == Some(client))
                .cloned()
        {
            let mut next = self.workspaces.clone();
            let mut workspace = workspace;
            if workspace.expires.is_some() {
                workspace.expires = Some(now() + ANONYMOUS_TTL);
            }
            next.insert(workspace.id.clone(), workspace.clone());
            self.commit(next)?;
            return Ok(
                json!({"client":client,"workspace":workspace.public(),"warning":self.warning}),
            );
        }
        if self
            .workspaces
            .values()
            .filter(|workspace| workspace.name.is_none())
            .count()
            >= MAX_ANONYMOUS
        {
            return Err(invalid(
                "Anonymous workspace limit reached; close or save an existing workspace",
            ));
        }
        let client = match client.filter(|client| valid_id(client)) {
            Some(client) => client.to_owned(),
            None => new_id()?,
        };
        let workspace = Workspace {
            id: new_id()?,
            name: None,
            revision: 1,
            updated: now(),
            expires: Some(now() + ANONYMOUS_TTL),
            tabs: vec![],
            layout: Layout::empty()?,
            preferences: empty_object(),
            client: Some(client.clone()),
        };
        let mut next = self.workspaces.clone();
        next.insert(workspace.id.clone(), workspace.clone());
        self.commit(next)?;
        Ok(json!({"client":client,"workspace":workspace.public(),"warning":self.warning}))
    }
    pub fn renew(&mut self, client: &str) -> io::Result<Value> {
        let id = self
            .workspaces
            .values()
            .find(|workspace| workspace.client.as_deref() == Some(client))
            .map(|workspace| workspace.id.clone());
        match id {
            Some(id) => self.renew_workspace(&id),
            None => Ok(json!({"renewed":false})),
        }
    }
    pub fn renew_workspace(&mut self, id: &str) -> io::Result<Value> {
        self.expire()?;
        let mut next = self.workspaces.clone();
        let Some(workspace) = next.get_mut(id) else {
            return Ok(json!({"renewed":false}));
        };
        if workspace.expires.is_some() {
            workspace.expires = Some(now() + ANONYMOUS_TTL);
            self.commit(next)?;
        }
        Ok(json!({"renewed":true}))
    }
    pub fn owner(&self, session: &str) -> Option<&str> {
        self.workspaces
            .values()
            .find(|workspace| {
                workspace
                    .tabs
                    .iter()
                    .any(|tab| tab.session.as_deref() == Some(session))
            })
            .map(|workspace| workspace.id.as_str())
    }
    pub fn handle(&mut self, op: &str, request: &Value) -> io::Result<Value> {
        self.expire()?;
        if op == "workspace.list" {
            let client = request["client"].as_str();
            let mut list: Vec<_> = self
                .workspaces
                .values()
                .filter(|workspace| {
                    workspace.name.is_some()
                        || (client.is_some() && workspace.client.as_deref() == client)
                })
                .map(Workspace::public)
                .collect();
            list.sort_by_key(|workspace| {
                std::cmp::Reverse(workspace["updated"].as_u64().unwrap_or(0))
            });
            return Ok(
                json!({"workspaces":list,"warning":self.warning,"anonymousTtl":ANONYMOUS_TTL}),
            );
        }
        if op == "workspace.create" {
            if self.named_count() >= MAX_WORKSPACES {
                return Err(invalid("Workspace limit reached"));
            }
            let name = request["name"]
                .as_str()
                .ok_or_else(|| invalid("A workspace name is required"))?;
            let workspace = Workspace {
                id: new_id()?,
                name: Some(name.trim().into()),
                revision: 1,
                updated: now(),
                expires: None,
                tabs: vec![],
                layout: Layout::empty()?,
                preferences: empty_object(),
                client: None,
            };
            workspace.validate()?;
            let mut next = self.workspaces.clone();
            next.insert(workspace.id.clone(), workspace.clone());
            self.commit(next)?;
            return Ok(json!({"workspace":workspace.public()}));
        }
        let id = request["workspace"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or_else(|| invalid("Invalid workspace ID"))?;
        let mut workspace =
            self.workspaces.get(id).cloned().ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "Workspace no longer exists")
            })?;
        if op == "workspace.load" {
            return Ok(json!({"workspace":workspace.public()}));
        }
        if request["revision"].as_u64() != Some(workspace.revision) {
            return Ok(json!({"conflict":true,"workspace":workspace.public()}));
        }
        if op == "workspace.move_tab" {
            let target_id = request["target"]
                .as_str()
                .filter(|target| *target != id)
                .ok_or_else(|| invalid("Choose a different destination workspace"))?;
            let mut target = self
                .workspaces
                .get(target_id)
                .cloned()
                .ok_or_else(|| invalid("Destination workspace is unavailable"))?;
            if request["targetRevision"].as_u64() != Some(target.revision) {
                return Ok(
                    json!({"conflict":true,"workspace":workspace.public(),"targetWorkspace":target.public()}),
                );
            }
            let tab_id = request["tab"]
                .as_str()
                .ok_or_else(|| invalid("Tab ID is required"))?;
            let index = workspace
                .tabs
                .iter()
                .position(|tab| tab.id == tab_id)
                .ok_or_else(|| invalid("Tab is unavailable"))?;
            let tab = workspace.tabs.remove(index);
            if !tab.minimized {
                workspace.layout.remove_tab(tab_id);
            }
            if !tab.minimized && !target.layout.append_tab(tab_id, request["group"].as_str()) {
                return Err(invalid("Destination group is unavailable"));
            }
            target.tabs.push(tab);
            workspace.revision = workspace
                .revision
                .checked_add(1)
                .ok_or_else(|| invalid("Workspace revision exhausted"))?;
            target.revision = target
                .revision
                .checked_add(1)
                .ok_or_else(|| invalid("Workspace revision exhausted"))?;
            workspace.updated = now();
            target.updated = now();
            workspace.validate()?;
            target.validate()?;
            let mut next = self.workspaces.clone();
            next.insert(id.into(), workspace.clone());
            next.insert(target.id.clone(), target.clone());
            self.commit(next)?;
            return Ok(json!({"workspace":workspace.public(),"targetWorkspace":target.public()}));
        }
        let mut next = self.workspaces.clone();
        match op {
            "workspace.update" => {
                workspace.tabs = serde_json::from_value(request["tabs"].clone())?;
                workspace.layout = serde_json::from_value(request["layout"].clone())?;
                if let Some(preferences) = request.get("preferences") {
                    workspace.preferences = preferences.clone();
                }
                workspace.validate()?;
                let mut assigned = HashSet::new();
                for session in workspace
                    .tabs
                    .iter()
                    .filter_map(|tab| tab.session.as_deref())
                {
                    if !assigned.insert(session)
                        || self.owner(session).is_some_and(|owner| owner != id)
                    {
                        return Err(invalid("Session already belongs to a workspace or tab"));
                    }
                }
            }
            "workspace.rename" => {
                workspace.name = Some(
                    request["name"]
                        .as_str()
                        .ok_or_else(|| invalid("Invalid workspace name"))?
                        .trim()
                        .into(),
                );
                workspace.expires = None;
                workspace.validate()?;
            }
            "workspace.copy" => {
                if self.named_count() >= MAX_WORKSPACES {
                    return Err(invalid("Workspace limit reached"));
                }
                workspace.id = new_id()?;
                workspace.client = None;
                workspace.name = Some(
                    request["name"]
                        .as_str()
                        .ok_or_else(|| invalid("Invalid workspace name"))?
                        .trim()
                        .into(),
                );
                workspace.expires = None;
                workspace.revision = 0;
                // Copies preserve process descriptors as unavailable, never share a live process.
                for tab in &mut workspace.tabs {
                    tab.session = None;
                }
                workspace.validate()?;
            }
            "workspace.delete" => {
                next.remove(id);
                let sessions: Vec<_> = workspace
                    .tabs
                    .iter()
                    .filter_map(|tab| tab.session.clone())
                    .collect();
                self.commit(next)?;
                return Ok(json!({"deleted":id,"sessions":sessions}));
            }
            _ => return Err(invalid("Unknown workspace operation")),
        }
        workspace.revision = workspace
            .revision
            .checked_add(1)
            .ok_or_else(|| invalid("Workspace revision exhausted"))?;
        workspace.updated = now();
        if workspace.expires.is_some() {
            workspace.expires = Some(now() + ANONYMOUS_TTL);
        }
        next.insert(workspace.id.clone(), workspace.clone());
        self.commit(next)?;
        Ok(json!({"workspace":workspace.public()}))
    }
}
