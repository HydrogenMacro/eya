use std::{
    env,
    ffi::CString,
    ffi::OsString,
    fs as stdfs, io,
    os::unix::ffi::OsStrExt,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::UNIX_EPOCH,
};
use tokio::{fs, io::AsyncWriteExt};

pub const DEFAULT_MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
static UPLOAD_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct FileManager {
    root: PathBuf,
    initial: String,
    identity: Option<FsIdentity>,
    pub max_file_bytes: u64,
}

#[derive(Clone)]
struct FsIdentity {
    uid: libc::uid_t,
    gid: libc::gid_t,
    groups: Vec<libc::gid_t>,
}

pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    pub size: u64,
    pub modified: u64,
    pub readonly: bool,
}

impl Entry {
    pub fn into_json(self) -> serde_json::Value {
        serde_json::json!({
            "name": self.name,
            "path": self.path,
            "kind": self.kind,
            "size": self.size,
            "modified": self.modified,
            "readonly": self.readonly,
        })
    }
}

pub struct Upload {
    target: PathBuf,
    temporary: PathBuf,
    identity: Option<FsIdentity>,
    file: fs::File,
    expected: u64,
    received: u64,
    overwrite: bool,
}

impl FileManager {
    pub fn from_env() -> io::Result<Self> {
        let (root, identity) = match env::var_os("EYA_HOST_PID") {
            Some(pid) => {
                let pid = pid.to_string_lossy();
                if pid.parse::<u32>().ok().filter(|value| *value > 0).is_none() {
                    return Err(invalid("EYA_HOST_PID must be a positive integer"));
                }
                let root = PathBuf::from(format!("/proc/{pid}/root"));
                let user = env::var("EYA_HOST_USER")
                    .map_err(|_| invalid("EYA_HOST_USER is required in Docker host mode"))?;
                let identity = host_identity(&root, &user)?;
                (root, Some(identity))
            }
            None => (PathBuf::from("/"), None),
        };
        let initial = env::var_os("EYA_CWD")
            .or_else(|| env::var_os("HOME"))
            .unwrap_or_else(|| OsString::from("/"));
        let initial = normalize(&initial.to_string_lossy(), "/");
        let max_file_bytes = env::var("EYA_MAX_FILE_BYTES")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_MAX_FILE_BYTES);
        Ok(Self {
            root,
            initial,
            identity,
            max_file_bytes,
        })
    }

    pub fn initial(&self) -> &str {
        &self.initial
    }

    pub fn resolve(&self, path: &str, base: &str) -> (String, PathBuf) {
        let logical = normalize(path, base);
        let physical = self.root.join(logical.trim_start_matches('/'));
        (logical, physical)
    }

    pub async fn list(&self, path: &str, show_hidden: bool) -> io::Result<(String, Vec<Entry>)> {
        let (logical, physical) = self.resolve(path, &self.initial);
        let result_path = logical.clone();
        let entries = blocking(self.identity.clone(), "directory listing", move || {
            let mut entries = Vec::new();
            for item in stdfs::read_dir(physical)? {
                let item = item?;
                let name = item.file_name().to_string_lossy().into_owned();
                if !show_hidden && name.starts_with('.') {
                    continue;
                }
                entries.push(entry(&logical, name, item.metadata()?));
            }
            entries.sort_by(|a, b| {
                (a.kind != "directory", a.name.to_lowercase())
                    .cmp(&(b.kind != "directory", b.name.to_lowercase()))
            });
            Ok(entries)
        })
        .await?;
        Ok((result_path, entries))
    }

    pub async fn search(
        &self,
        path: &str,
        query: &str,
        show_hidden: bool,
    ) -> io::Result<(String, Vec<Entry>)> {
        let (logical, physical) = self.resolve(path, &self.initial);
        let query = query.to_lowercase();
        let root = logical.clone();
        let entries = blocking(self.identity.clone(), "file search", move || {
            search_tree(&physical, &root, &query, show_hidden)
        })
        .await?;
        Ok((logical, entries))
    }

    pub async fn metadata(&self, path: &str) -> io::Result<(String, stdfs::Metadata)> {
        let (logical, physical) = self.resolve(path, &self.initial);
        let metadata = blocking(self.identity.clone(), "file metadata", move || {
            stdfs::metadata(physical)
        })
        .await?;
        Ok((logical, metadata))
    }

    pub async fn open(&self, path: &str) -> io::Result<fs::File> {
        let (_, physical) = self.resolve(path, &self.initial);
        let file = blocking(self.identity.clone(), "open file", move || {
            stdfs::File::open(physical)
        })
        .await?;
        Ok(fs::File::from_std(file))
    }

    pub async fn mkdir(&self, path: &str) -> io::Result<String> {
        let (logical, physical) = self.resolve(path, &self.initial);
        blocking(self.identity.clone(), "create directory", move || {
            stdfs::create_dir(physical)
        })
        .await?;
        Ok(logical)
    }

    pub async fn rename(&self, path: &str, new_path: &str) -> io::Result<String> {
        let (logical, physical) = self.resolve(path, &self.initial);
        let (new_logical, new_physical) = self.resolve(new_path, parent(&logical));
        blocking(self.identity.clone(), "rename file", move || {
            stdfs::rename(physical, new_physical)
        })
        .await?;
        Ok(new_logical)
    }

    pub async fn remove(&self, path: &str, recursive: bool) -> io::Result<()> {
        let (logical, physical) = self.resolve(path, &self.initial);
        if logical == "/" {
            return Err(invalid("refusing to remove the filesystem root"));
        }
        blocking(self.identity.clone(), "remove file", move || {
            let metadata = stdfs::symlink_metadata(&physical)?;
            if metadata.is_dir() {
                if recursive {
                    stdfs::remove_dir_all(physical)
                } else {
                    stdfs::remove_dir(physical)
                }
            } else {
                stdfs::remove_file(physical)
            }
        })
        .await
    }

    pub async fn begin_upload(
        &self,
        id: u32,
        path: &str,
        size: u64,
        overwrite: bool,
    ) -> io::Result<Upload> {
        if size > self.max_file_bytes {
            return Err(invalid("file exceeds the configured transfer limit"));
        }
        let (_, target) = self.resolve(path, &self.initial);
        let target_for_open = target.clone();
        let (file, temporary) = blocking(self.identity.clone(), "start upload", move || {
            if !overwrite && target_for_open.try_exists()? {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "a file already exists at that path",
                ));
            }
            let name = target_for_open
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("file");
            loop {
                let sequence = UPLOAD_SEQUENCE.fetch_add(1, Ordering::Relaxed);
                let temporary = target_for_open.with_file_name(format!(
                    ".{name}.eya-upload-{}-{id}-{sequence}.tmp",
                    std::process::id()
                ));
                match stdfs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&temporary)
                {
                    Ok(file) => return Ok((file, temporary)),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(error),
                }
            }
        })
        .await?;
        Ok(Upload {
            target,
            temporary,
            identity: self.identity.clone(),
            file: fs::File::from_std(file),
            expected: size,
            received: 0,
            overwrite,
        })
    }
}

impl Upload {
    pub async fn write(&mut self, data: &[u8]) -> io::Result<()> {
        self.received = self
            .received
            .checked_add(data.len() as u64)
            .ok_or_else(|| invalid("upload size overflow"))?;
        if self.received > self.expected {
            return Err(invalid("upload contained more bytes than declared"));
        }
        self.file.write_all(data).await
    }

    pub async fn finish(mut self) -> io::Result<()> {
        if self.received != self.expected {
            self.cancel().await;
            return Err(invalid("upload ended before all bytes arrived"));
        }
        if let Err(error) = self.file.flush().await {
            self.cancel().await;
            return Err(error);
        }
        if let Err(error) = self.file.sync_all().await {
            self.cancel().await;
            return Err(error);
        }
        drop(self.file);
        let temporary = self.temporary.clone();
        let temporary_on_error = self.temporary;
        let target = self.target;
        let identity = self.identity;
        let overwrite = self.overwrite;
        let result = blocking(identity.clone(), "finish upload", move || {
            rename_upload(&temporary, &target, overwrite)
        })
        .await;
        if result.is_err() {
            let _ = blocking(identity, "clean up upload", move || {
                stdfs::remove_file(temporary_on_error)
            })
            .await;
        }
        result
    }

    pub async fn cancel(self) {
        drop(self.file);
        let path = self.temporary;
        let _ = blocking(self.identity, "cancel upload", move || {
            stdfs::remove_file(path)
        })
        .await;
    }
}

fn rename_upload(source: &Path, target: &Path, overwrite: bool) -> io::Result<()> {
    if overwrite {
        return stdfs::rename(source, target);
    }
    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| invalid("upload path contains a NUL byte"))?;
    let target = CString::new(target.as_os_str().as_bytes())
        .map_err(|_| invalid("upload path contains a NUL byte"))?;
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

async fn blocking<T, F>(
    identity: Option<FsIdentity>,
    label: &'static str,
    operation: F,
) -> io::Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> io::Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(move || with_identity(identity, operation))
        .await
        .map_err(|_| invalid(&format!("{label} task failed")))?
}

fn with_identity<T, F>(identity: Option<FsIdentity>, operation: F) -> io::Result<T>
where
    F: FnOnce() -> io::Result<T>,
{
    let Some(identity) = identity else {
        return operation();
    };
    let group_count =
        unsafe { libc::syscall(libc::SYS_getgroups, 0, std::ptr::null::<libc::gid_t>()) };
    if group_count < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut old_groups = vec![0; group_count as usize];
    if group_count > 0
        && unsafe { libc::syscall(libc::SYS_getgroups, group_count, old_groups.as_mut_ptr()) } < 0
    {
        return Err(io::Error::last_os_error());
    }
    if unsafe {
        libc::syscall(
            libc::SYS_setgroups,
            identity.groups.len(),
            identity.groups.as_ptr(),
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    let old_gid = unsafe { libc::setfsgid(identity.gid) } as libc::gid_t;
    if unsafe { libc::setfsgid(!0) } as libc::gid_t != identity.gid {
        unsafe {
            libc::setfsgid(old_gid);
            libc::syscall(libc::SYS_setgroups, old_groups.len(), old_groups.as_ptr());
        }
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "could not assume the host user's group",
        ));
    }
    let old_uid = unsafe { libc::setfsuid(identity.uid) } as libc::uid_t;
    if unsafe { libc::setfsuid(!0) } as libc::uid_t != identity.uid {
        unsafe {
            libc::setfsuid(old_uid);
            libc::setfsgid(old_gid);
            libc::syscall(libc::SYS_setgroups, old_groups.len(), old_groups.as_ptr());
        }
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "could not assume the host user's identity",
        ));
    }
    let guard = IdentityGuard {
        old_uid,
        old_gid,
        old_groups,
    };
    let result = operation();
    drop(guard);
    result
}

struct IdentityGuard {
    old_uid: libc::uid_t,
    old_gid: libc::gid_t,
    old_groups: Vec<libc::gid_t>,
}

impl Drop for IdentityGuard {
    fn drop(&mut self) {
        unsafe {
            libc::setfsuid(self.old_uid);
            libc::setfsgid(self.old_gid);
            libc::syscall(
                libc::SYS_setgroups,
                self.old_groups.len(),
                self.old_groups.as_ptr(),
            );
        }
    }
}

fn host_identity(root: &Path, user: &str) -> io::Result<FsIdentity> {
    let passwd = stdfs::read_to_string(root.join("etc/passwd"))?;
    for line in passwd.lines() {
        let mut fields = line.split(':');
        if fields.next() != Some(user) {
            continue;
        }
        let _password = fields.next();
        let uid = fields
            .next()
            .and_then(|value| value.parse::<libc::uid_t>().ok())
            .ok_or_else(|| invalid("host user has an invalid uid"))?;
        let gid = fields
            .next()
            .and_then(|value| value.parse::<libc::gid_t>().ok())
            .ok_or_else(|| invalid("host user has an invalid gid"))?;
        let mut groups = vec![gid];
        if let Ok(group_file) = stdfs::read_to_string(root.join("etc/group")) {
            for group_line in group_file.lines() {
                let fields: Vec<_> = group_line.split(':').collect();
                if fields.len() >= 4
                    && fields[3].split(',').any(|member| member == user)
                    && let Ok(group) = fields[2].parse::<libc::gid_t>()
                    && !groups.contains(&group)
                {
                    groups.push(group);
                }
            }
        }
        return Ok(FsIdentity { uid, gid, groups });
    }
    Err(invalid(
        "EYA_HOST_USER was not found in the host passwd file",
    ))
}

fn entry(directory: &str, name: String, metadata: stdfs::Metadata) -> Entry {
    let path = if directory == "/" {
        format!("/{name}")
    } else {
        format!("{directory}/{name}")
    };
    let kind = if metadata.is_dir() {
        "directory"
    } else if metadata.file_type().is_symlink() {
        "symlink"
    } else {
        "file"
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .and_then(|value| u64::try_from(value.as_millis()).ok())
        .unwrap_or(0);
    Entry {
        name,
        path,
        kind,
        size: metadata.len(),
        modified,
        readonly: metadata.permissions().readonly(),
    }
}

fn search_tree(
    root: &Path,
    logical_root: &str,
    query: &str,
    show_hidden: bool,
) -> io::Result<Vec<Entry>> {
    let mut found = Vec::new();
    let mut pending = vec![(root.to_path_buf(), logical_root.to_owned(), 0usize)];
    while let Some((directory, logical, depth)) = pending.pop() {
        if depth > 24 {
            continue;
        }
        let Ok(items) = stdfs::read_dir(directory) else {
            continue;
        };
        for item in items.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            if !show_hidden && name.starts_with('.') {
                continue;
            }
            let Ok(metadata) = item.metadata() else {
                continue;
            };
            let value = entry(&logical, name, metadata);
            let child = (value.kind == "directory").then(|| value.path.clone());
            if value.name.to_lowercase().contains(query) {
                found.push(value);
            }
            if found.len() >= 1000 {
                return Ok(found);
            }
            if let Some(path) = child {
                pending.push((item.path(), path, depth + 1));
            }
        }
    }
    found.sort_by_key(|entry| entry.path.to_lowercase());
    Ok(found)
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/')
        .map(|(value, _)| if value.is_empty() { "/" } else { value })
        .unwrap_or("/")
}

fn normalize(path: &str, base: &str) -> String {
    let source = if path.trim().is_empty() {
        base.to_owned()
    } else if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("{}/{path}", base.trim_end_matches('/'))
    };
    let mut parts = Vec::new();
    for part in Path::new(&source).components() {
        match part {
            Component::Normal(value) => parts.push(value.to_string_lossy().into_owned()),
            Component::ParentDir => {
                parts.pop();
            }
            _ => {}
        }
    }
    if parts.is_empty() {
        "/".into()
    } else {
        format!("/{}", parts.join("/"))
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::{host_identity, normalize, rename_upload};
    use std::{fs, path::PathBuf};

    #[test]
    fn normalizes_absolute_and_relative_paths() {
        assert_eq!(
            normalize("../images/./logo.png", "/home/user/docs"),
            "/home/user/images/logo.png"
        );
        assert_eq!(normalize("../../../../", "/home/user"), "/");
        assert_eq!(normalize("/var//log", "/ignored"), "/var/log");
    }

    #[test]
    fn resolves_host_identity_from_passwd() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-host-identity");
        fs::create_dir_all(root.join("etc")).unwrap();
        fs::write(
            root.join("etc/passwd"),
            "example:x:1234:5678::/home/example:/bin/sh\n",
        )
        .unwrap();
        fs::write(root.join("etc/group"), "shared:x:6789:example,other\n").unwrap();
        let identity = host_identity(&root, "example").unwrap();
        assert_eq!((identity.uid, identity.gid), (1234, 5678));
        assert_eq!(identity.groups, vec![5678, 6789]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn upload_finalization_only_overwrites_when_requested() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-upload-rename");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source");
        let target = root.join("target");
        fs::write(&source, "new").unwrap();
        fs::write(&target, "old").unwrap();

        let error = rename_upload(&source, &target, false).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&source).unwrap(), "new");
        assert_eq!(fs::read_to_string(&target).unwrap(), "old");

        rename_upload(&source, &target, true).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        assert!(!source.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
