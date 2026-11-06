# Backend review

The review covered Noise/session framing, replay offsets and bounded input/output queues, reconnect ownership, authenticated file and machine dispatch, uploads/atomic rename, namespace/user command construction, process identity, subprocess output limits, and filesystem traversal. These checks do not establish that every possible operating-system or deployment behavior is covered.

## Fixes and regression coverage

- Upload sessions are capped at eight open transfers. Short temporary names support destination names up to the filesystem's filename limit. New uploads use private permissions; atomic saves retain existing regular permission and execute bits without retaining special set-ID bits.
- File opens use nonblocking descriptors and validate the actual file type after opening. The initial stat/open race cannot block indefinitely on a FIFO substituted for a regular file.
- Listings skip entries that disappear during enumeration, and have an entry cap. Searches bound examined entries, directories, depth, and results; missing search roots report errors. Symlink loops are not traversed.
- Machine stdout/stderr are read with explicit bounds. Output overflow aborts promptly instead of waiting for a child blocked on a full pipe. Empty-stderr command failures retain an actionable exit-status error.
- Process detail file/link reads go through the host-account filesystem identity, including restricted I/O counters and cwd/executable links.
- Reconnect attachment delivery has a deadline, preventing an unbounded wait behind a session busy with file I/O.

Rust regression tests cover long filenames, executable save modes, incomplete/oversized upload cleanup, special-file rejection, symlink search loops, failed search roots, output overflow, atomic no-overwrite rename, process identity, and replay acknowledgement bounds. Docker integration tests are read-only and opt-in; signal tests target an owned disposable process.

## Deployment boundaries

The hosted HTML client deliberately embeds the shared password, as required by hosted auto-configuration. The listener and hosted pages therefore require trusted-network or proxy access controls; Noise authentication does not protect a password made available to the same requester through HTTP. Standalone clients likewise contain their configured credentials.

Authenticated users have host shell access by design; filesystem access is not a sandbox. Native commands use the server account and host-mode file/process-detail operations use the selected host identity. Host-mode process signaling rechecks start identity before invoking host `kill`; unlike native pidfd signaling, that shell boundary cannot make the identity check and signal a single atomic operation.

Remote/network filesystem syscalls can still block in the operating system. Search size limits bound scope and memory, not kernel I/O latency. V4 Docker/machine jobs run separately from terminal input/output; legacy transports and file streaming retain their existing serialized behavior.
