# Task Manager and Docker

Use the **+** beside panel tabs, then choose **Task Manager** or **Docker**. Instances can be moved, split, and closed like other panels.

## Task Manager

The full interface and customization guide is in [task-manager.md](task-manager.md): Processes/Performance views, CPU/memory/network history, per-core and interface metrics, process trees, configurable columns, inspector, export, and refresh/display settings.

The resource summary shows CPU utilization, used/total memory, the 1/5/15-minute load averages, and cumulative network traffic. CPU usage uses the server’s retained aggregate samples, with two live samples as the fallback for older servers. Per-process CPU is expressed as a percentage of one logical CPU, so multithreaded processes can exceed 100%.

Filter processes by name, PID, command, or numeric UID, and sort by CPU, memory, name, or PID. Select a process for **End task**, or open its action menu for Force kill, Pause, and Resume. Delete/Backspace on a focused process row requests termination. Termination, force-kill, and pause require confirmation. The process's start-time identity is checked before sending the signal, and PID 1 and the native Eya server cannot be targeted. Native deployments bind signals to Linux pidfds to avoid PID reuse (a kernel with pidfd support is required); host-mode signals recheck identity before executing the host's `kill`. OS permissions still apply.

Linux `/proc` supplies the statistics. A snapshot is capped at 8192 processes. Process polling defaults to 500 ms and runs only while the panel is visible and active; switch off **Live** to poll manually. Open action menus suspend polling so controls remain stable.

## Docker and Compose

See [docker.md](docker.md) for container resource histories, structured details, filtered/live logs, process inspection, Compose service controls, image/network/volume inventory, and per-instance UI options. Compose files and bind mounts open in the workspace editor or file browser; container shells open independent terminal panels.

The Docker panel lists stopped and running containers, status, images, ports, and CPU/memory usage. Container menus provide Start/Stop, Restart, Pause/Resume, Logs, and Inspect. Logs default to 200 lines and can request up to 5000, with time/timestamp/filter options; Inspect displays Docker's JSON response. Stop and restart require confirmation.

The **Compose** view lists projects, status, and configuration paths. Project menus provide Start, Up, Stop, Restart, and Services. Opening Services exposes equivalent controls for a single service. Up uses `docker compose up --detach`; it can create containers from the project's existing configuration. This UI does not remove containers, images, volumes, or Compose stacks.

Commands execute using the server's Docker CLI and its normal Docker context. The CLI, daemon access, and Compose v2 plugin must already be installed/configured. Missing commands or daemon permissions appear as panel errors. A failed stats query does not hide the container list. Inspect/log detail views suspend automatic polling while open.

## Authentication and host deployments

Machine requests use the same authenticated, Noise-encrypted request transport as files; there is no separate unauthenticated management endpoint. Any authenticated Eya user already has terminal access with this machine identity. Native deployments run commands as the Eya server user. With `EYA_HOST_PID`, statistics come from the target host `/proc`, and machine commands enter the same host namespaces and login as `EYA_HOST_USER`, using `EYA_NSENTER`/`EYA_HOST_SU`.

Only enumerated operations/signals are accepted. Container/project/service identifiers are validated; Compose configuration files are resolved from Docker's project list. Commands receive distinct arguments, with shell quoting only for the host-mode login boundary. The server removes `EYA_KEY` from command environments. Output and runtime are bounded (512 KiB stdout, 32 KiB stderr, 12 seconds per command). Workspace machine requests work with zero terminal tabs, with at most four jobs per connection/eight server-wide and a 20-second operation deadline. Legacy v4 terminal channels retain their machine APIs. Disconnecting cancels pending jobs. Operations that exceed the deadline report an error; Docker may still finish an operation already submitted to its daemon. Polling errors retain the last displayed data.

## Extension API

`client/system-panels.js` re-exports `createTaskManager` and `createDockerPanel` from their dedicated modules. Both accept `{ request, openFile, openTerminal, refreshInterval }` and return an `element`, lifecycle hooks, and an `api` including `refresh` and `focusSearch`. The app's file callback routes directories to a new browser and files to a viewer; terminal callbacks create independent resumable shells. Request operations and limits are documented in each panel guide. Shared SVG history charts are documented in [charts.md](charts.md).

`tests/system-panels.cjs` checks the UI with deterministic data and simulated controls. Rust tests cover `/proc` parsing, real metrics, input validation, and signaling an owned disposable process. Set `EYA_TEST_DOCKER=1` when running `cargo test` to include read-only Docker/Compose integration checks.

Bundle `tests/system-protocol.js` with esbuild the same way as `tests/file-protocol.js`, then run it against the isolated test server on port 18765. With `EYA_TEST_DOCKER=1`, it also checks read-only Docker/Compose data and confirms terminal output continues while a Docker query is pending.

## Live server limits

Navbar menu → **Server settings** edits global admission limits on the connected server. These settings apply immediately to this server process; restarting restores the environment configuration. Lowering a limit keeps existing sessions, runtimes and operations running. New admissions wait until usage falls below the limit. Reattaching to an existing terminal or Full browser session remains possible above the reduced session limit. Refresh shows current usage and limits; Apply checks the revision so another client's changes cannot be overwritten silently.

| Limit | Environment default | Default | Allowed |
| --- | --- | --- | --- |
| Terminal sessions, including detached sessions | `EYA_TERMINAL_SESSIONS` | 8 | 1–128 |
| Workspace service connections | `EYA_WORKSPACE_CONNECTIONS` | 32 | 1–256 |
| Concurrent handshakes and legacy terminal connections | `EYA_HANDSHAKE_CONNECTIONS` | 8 | 1–128 |
| Basic browser connections | `EYA_BASIC_BROWSER_CONNECTIONS` | 4 | 1–64 |
| Retained Full browser sessions | `EYA_FULL_BROWSER_SESSIONS` | 4 | 1–64 |
| Running Full browser Chromium runtimes | `EYA_FULL_BROWSER_RUNTIMES` | 2 | 1–16 |
| Machine operations, including Task Manager and Docker | `EYA_MACHINE_JOBS` | 8 | 1–64 |

A running Full browser session acquires a separate runtime slot when Chromium starts. Retaining its session does not reserve a runtime slot. Legacy terminal connections keep their original connection-slot accounting. Update-v1 keeps its independent fixed admission limit; live settings cannot consume its four slots or change its authentication, size limits or artifact contract. Listener addresses, shared keys, host identity, filesystem boundaries, replay accounting and per-operation security limits remain startup configuration.

Live configuration is available only over the authenticated workspace service after both peers explicitly negotiate `server-config-v1` alongside `extensions-v1`. New clients on older servers show an unsupported message without sending settings mutations. Frame 4 retains its existing request/response encoding. `server.config.get` returns `revision`, `settings`, `usage`, `bounds`, and `scope:"process"`; `server.config.set` requires that revision and a nonempty partial `settings` object. The server validates the whole bounded patch before changing any limit, rejects unknown settings and stale revisions, and ignores unknown outer request fields. Mutations are never replayed automatically after a disconnect. Any authenticated client already has the server's terminal authority; settings do not expose the shared key or environment contents.

Checks: `tests/server-settings.cjs` covers negotiated and old peers, quota reductions, retained sessions and reattachment, atomic validation, revision conflicts and restart defaults. `tests/server-settings-ui.cjs` covers unsupported peers, applying changes, input bounds and uncertain-mutation recovery.
