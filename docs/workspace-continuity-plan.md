# Workspace and session continuity plan

This is the specification for a project-wide continuity feature. The server retains workspace definitions, open-tab descriptors, layouts, and live server sessions across client disconnects. Anonymous workspaces remain in server memory until explicitly saved; only saved named workspaces reach disk. Client instances are disposable and do not persist state in localStorage, IndexedDB, cookies, or downloaded client files. The browser may run Eya as a local HTML/SVG file, so cross-instance restoration must use the authenticated server connection.

## Baseline before implementation

Before this change, the client kept its workbench, tabs, dirty editor buffers, viewers, and most panel state in page memory. Some settings and viewer preferences used browser storage. Protocol-v4 terminal sessions already survived a temporary WebSocket detach with offset-based input/output replay and bounded buffers, but only the original client held their resume tokens. A new client could not discover those sessions. Server runtimes were in memory and ended on server restart.

Source review confirmed the former primary **Terminal** doubled as the connection anchor. `app.js` registered it with `retain: true` and opened it at startup. File and machine requests shared its authenticated WebSocket. Closing its tab hid it while retaining its panel/session; creating the default Terminal when that tab was absent returned the retained `terminal` panel ID and reopened the same shell. This hidden master-shell behavior is removed by this plan. Current lifecycle behavior is documented in [panels.md](panels.md).

File and machine requests already rejected pending requests on disconnect. File browsers, editors, media, CAD, Task Manager, and Docker panels mostly had client-owned state. Browser panels used a separate authenticated WebSocket and a Chromium instance/profile tied to that connection. Video had a narrow client-side retry for version-checked range reads while the original page/tab survived, with a 30-second media-worker per-chunk timeout.

See [panels.md](panels.md), [reconnection.md](reconnection.md), [file-manager.md](file-manager.md), [browser.md](browser.md), [system-panels.md](system-panels.md), and [cad.md](cad.md) for current behavior.

## Product decisions

- The server is the only source of state across client instances. Browser storage is never required for recovery.
- A workspace owns its ordered open-tab descriptors and recursive panel layout. Named workspaces and their declarative state survive client replacement and server restart.
- The authenticated workspace connection is independent of terminal sessions. Files, machine APIs, workspace management, and session discovery work with zero terminal tabs open.
- **Connect** authenticates workspace services independently, then opens one ordinary Terminal tab by default. The generator can instead choose File browser, Browser, Task Manager, Docker, New tab or None. This action runs once on initial connection; reconnect never opens another default tab. Restoring a terminal attaches its live session without creating a replacement. There is no special connector terminal.
- A transport disconnect detaches live server work; it does not close it. Explicit tab/session close, expiry, workspace deletion, and server-process failure are distinct events.
- Persist panel identity and arrangement, plus a small number of useful resume fields such as video position. Reset transient details such as CAD camera, selection, chart history, focus, scroll, and menus when a panel is reopened.
- There is no user/account system now. All workspace operations use the existing shared-key Noise authentication and the single-user server authority. Leave room for a future owner scope without implementing users or sharing.

## Workspace model and startup behavior

Keep these concepts separate:

1. **Workspace**: a named or anonymous container for tabs and layout.
2. **Tab descriptor**: a small recipe for reopening a panel, such as file-browser cwd, file path/viewer kind, or stable server-session ID. It is not itself a live process.
3. **Live server session**: a PTY or Chromium session that continues running while disconnected and can be attached by a client. A terminal session exists only because a terminal tab was explicitly created; there is no hidden or specially retained master shell.

Persist explicitly saved named workspace definitions and tab descriptors on the server filesystem in a versioned, bounded format with atomic updates and restrictive permissions. Anonymous definitions live only in bounded server memory. Saved definitions survive server restart. Current PTYs and Chromium processes are in memory and do not; after restart, keep their workspace entries but mark the live session unavailable and require an explicit **Start new session** action.

After authenticating, each new client starts in its own **Anonymous workspace** and opens its configured starting panel. The server issues a page identity kept only in memory. Anonymous tab recipes/layouts stay in server memory with a renewable ten-minute grace period for same-page reconnection. A fresh page gets a new anonymous workspace. Anonymous workspaces never enter the durable JSON store or backup and do not appear in another client’s list. Server restart discards them; a surviving page can rebind its in-memory views to a fresh anonymous record without spawning another startup tab.

Workspace selection is explicit. The **Workspaces** manager lists saved workspaces plus the current page’s temporary workspace. **Save workspace** names and atomically persists an anonymous workspace’s current tabs/layout. **New workspace**, **Open**, **Rename**, **Save as**, and **Delete** manage saved workspaces. There is no server-wide last-workspace pointer or user/account system.

The modal has independently searchable, scrollable workspace and current open-tab lists. Opening a workspace closes it automatically. Open tabs includes minimized tabs; Lucide Focus and X buttons reopen/focus or close entries. Drag a tab onto another workspace to atomically move its descriptor/layout membership, with touch-handle and keyboard alternatives. There is no Active sessions display or destination dropdown. Restore tabs independently so one missing file or expired process does not block other tabs.

## Workspace layout

Persist the existing recursive workbench split tree semantically. A leaf is a tab group with ordered visible tab IDs and an active tab. Minimized tabs retain their descriptor with `minimized:true` but appear in no layout group. A split node contains orientation and a normalized ratio from 0 to 1; store proportions, not screen pixels. Stable workspace, group, and tab IDs keep the tree connected to the tab manifest.

Pane minimum dimensions are a built-in panel/workbench feature. Each panel type declares minimum usable width and height, with safe defaults for existing panel types. Split creation, sash dragging, layout restoration, and viewport resizing all enforce these constraints. When a viewport cannot fit the minimums, the workbench collapses to its existing narrow-screen behavior (showing one group at a time) without changing the saved split ratios. Clamp ratios to available dimensions when rendering; do not rewrite saved ratios merely because a screen is small.

Submit tab-manifest, minimized flags and layout changes together as one revisioned workspace update; anonymous updates remain memory-only. Debounce frequent sash movement and flush on meaningful layout changes. If a workspace revision changed on the server since a client loaded it, reject the stale update and ask the client to reload or resolve the conflict; do not silently use last-writer-wins. Temporary mobile collapse, active group, focus, and scroll remain in memory only.

When tabs move, split, minimize, reopen, close, or reorder, update the tab manifest and tree consistently. Minimize keeps the mounted view and runtime alive while deactivating foreground polling; close still runs cleanup. The new-tab launcher has independent searchable, scrollable lists of panel types and minimized tabs, stacking on narrow screens; reopening restores the same instance in the destination group. Collapse empty groups according to current workbench behavior. If a type is unavailable or a descriptor is invalid, retain a recoverable error entry or quarantine it instead of corrupting the rest of the layout. Version the schema and define migrations before adding panel-specific fields.

## State to retain

| Feature/state | Cross-client behavior |
| --- | --- |
| Workspace names, tab descriptors/order, groups, active tabs, split ratios | Store on server. This is the core durable workspace record. |
| Terminal panels (all equal) | Each terminal tab references a stable live-session ID. Server owns PTY, cwd/processes, and bounded replay. A terminal is created by the configured initial panel or an explicit new/replacement action; no hidden primary shell anchors the workspace connection. Detach on transport loss, reattach without creating a shell, and end on explicit close/end or expiry. Server restart ends the PTY but preserves the workspace tab as unavailable. |
| File browsers | Store logical cwd in the tab descriptor; search query/history are optional. Revalidate the path after authentication. Selection, focus, and scroll reset. |
| File viewers, HTML, audio, video | Store path and viewer kind; re-open through authenticated file operations and validate file identity/version. Video may store a small resume time and intended play/pause state, updated at a bounded rate. Do not store media bytes or decoder internals. If the file changed, show that state and require reload rather than mixing versions. |
| Text editors | Store the file descriptor, not unsaved buffer contents in the first version. A dirty buffer is lost when its client instance ends. Warn when closing a dirty tab/workspace; page-close prompts are best-effort, not a recovery guarantee. If draft recovery is later required, design bounded server-side drafts with expiry and conflict handling. |
| CAD | Store model path/type only. Reopen model and sidecars; camera, selections, measurements, and section state reset. During same-page transport recovery, retain the current model while refreshing safely. |
| Task Manager and Docker | Store panel type and configuration needed to reopen. Recreate panels and refresh live data. Polling history and transient filters can reset. Do not replay machine actions. |
| Remote Browser | Store a stable session ID in the tab descriptor and retain the Chromium process/profile across transport disconnect. Reattach through its separate authenticated socket. Explicit close/expiry ends it; server restart loses the process/profile. Resolve the current one-session limit before allowing multiple Browser tabs. |
| Theme and client settings | Do not store in browser storage. Move settings worth retaining to a server-level or workspace preference record; otherwise use defaults on each new client. |
| Focus, scroll, menus, chart history, selected rows, CAD camera, temporary buffers | Keep only in the running client instance; reset when that instance ends. Preserve in-memory state during a same-page reconnect where practical. |
| File mutations and machine actions | Never replay automatically. Report unknown/interrupted results, reconcile current server state, then let the user decide whether to retry. |

## Anonymous, named, and concurrent workspaces

An anonymous workspace is not a user account. It is a leased workspace record created for one client instance and protected by the server's existing authentication. It retains manifests and layouts in memory for reconnection, and gains durable persistence only through an explicit Save workspace. New clients see saved workspaces plus their own anonymous record; prior anonymous records are not exposed as saved workspaces.

Each tab/session is assigned to at most one workspace. Opening a named workspace in two clients is allowed for viewing, but writes use revisions. A stale layout/tab update is rejected with a refresh/reload path. Live PTY and Browser sessions permit one active client attachment at a time; an already-attached session is shown as in use. Provide an explicit **Take over** action that warns the other attachment will be detached. Do not let a second client silently steal an interactive session.

Closing a terminal or Browser tab explicitly ends its live session, matching the current additional-terminal semantics. The current primary terminal's hidden retention exception is removed: there is no master terminal panel or shell that remains alive just to carry file/machine requests. The workspace connection remains available independently. Closing a file browser or viewer only removes its descriptor. Deleting a workspace confirms that its assigned live sessions will end, then sends explicit end requests after deleting the manifest. Report uncertain end outcomes; detached sessions remain subject to expiry. Expiring an anonymous manifest does not automatically terminate an attached runtime; the runtime follows its own lifecycle. The session-list protocol remains available for authenticated management but has no separate modal display.

## Disconnect and request lifecycle

Use an authenticated **workspace connection** and lifecycle service shared by `app.js`, file browsers, file routing, media, CAD, Task Manager, Docker, workspace management, and session discovery. It carries workspace/file/machine requests and does not create or require a PTY. It reports authenticated readiness, connection generation, disconnect reason, and whether reconnect is automatic, manually paused, or terminally failed. A WebSocket `open` event is not readiness; notify consumers after Noise authentication and workspace/session protocol negotiation. Terminal panels attach their own explicit live session IDs; whether their traffic uses separate sockets or session-addressed channels on a shared encrypted connection is an implementation choice, but no terminal session may be a prerequisite for the workspace connection. The Browser panel tracks its separate channel and does not infer readiness from the workspace connection.

On workspace-connection loss, retain workspace/session records, stop new workspace/file/machine requests, cancel stale reads and polls, and mark mutations with unknown outcomes. Terminal sessions may remain connected if their session channels are independent; if transport is shared, detach and later reattach each terminal session by its own ID. Keep current DOM and transient state in memory. On authenticated recovery, reconcile workspace/session IDs and reattach detached live processes, then resume bounded idempotent reads. Use deadlines, cancellation, and generation checks so late responses cannot update a newer session or a closed/reopened tab. Bound retry queues. Never direct queued input or actions to a replacement session.

Workspace edits made during a temporary outage can remain in the current page's memory and be submitted after reconnect using the last known revision. Show a pending-sync state. On reconnect, use revision checks; if another client changed the workspace, preserve the current page's in-memory changes and offer reload or conflict resolution. If the client instance closes before its pending workspace update reaches the server, that update is lost; the UI must not imply it was saved. No cross-client local fallback is available.

| Operation class | Recovery behavior |
| --- | --- |
| Terminal input/output | Preserve protocol-v4 offset replay and bounded input policy; stable session attach must not duplicate submitted bytes. Do not persist unacknowledged keystrokes in browser storage. |
| Workspace/tab/layout writes | Send revisioned, bounded updates. Retry only known-unsent idempotent updates; reconcile unknown outcomes by reloading the server revision and comparing IDs. |
| Directory, stat, file read/range, system status | Cancel or expire stale requests; retry bounded idempotent reads after authenticated readiness with current generation and file/session identity checks. |
| Editor save/upload/rename/delete and machine actions | Do not retry automatically. Show unknown/interrupted outcome and reconcile before user retry. Mutation replay needs explicit idempotency keys and server result caching. |
| Video range reads | Retry only bounded version-checked reads. If the media worker timed out, recover that decoder once after readiness. A new client reopens the file and optional saved position, not the old decoder. |
| CAD refresh, chart polling, Task Manager/Docker polling | Cancel obsolete polls; resume bounded polling when panel is active/visible and transport is ready. |
| Remote browser input/frame stream | Reattach its own authenticated browser channel to the retained Chromium session; do not infer readiness from the main socket. |

## Server storage and API

Provide an authenticated workspace connection that can operate with zero terminal sessions, plus operations to create/list/load/update/rename/delete workspaces; create/renew/expire anonymous workspaces; list/attach/detach/take over live sessions; and explicitly end sessions. Workspace and session IDs are identifiers, not credentials. All operations require the current Noise-authenticated shared-key connection. The single-user server has one global store; leave room for a future owner scope without adding user management now.

Persist only named workspace records in a server-controlled data directory with restrictive permissions. Define the storage directory explicitly (for example, configurable `EYA_STATE_DIR` with a per-server-user state-directory default) and document the persistent volume requirement for container deployments. Bound workspace count, tab count, serialized size, descriptor fields, path length, and retention. Use a versioned schema, explicit migrations, atomic/transactional writes, and corruption handling that preserves a backup or reports the damaged workspace without preventing other workspaces from loading. The server should expose the current revision and session status in each response.

Keep PTYs and Chromium runtime records in memory with bounded replay/resource limits and documented detached-session TTL. Detached terminals count against the eight-terminal limit; browser actors and Chromium processes have separate bounds. A workspace descriptor may remain after a live session expires; mark it unavailable and offer an explicit **Start new session** action. Store no plaintext shared key, bearer resume credential, decrypted file content, or terminal input queue. Treat stored file paths as sensitive metadata and return them only after authentication. Revalidate host identity/configuration and file version before restoring file data.

## Feature-specific edge cases

- **Client closes while disconnected:** the server retains last-saved workspace state and detached sessions. Unsynced layout changes and dirty editor buffers are lost; show sync state while connected and warn before explicit workspace/tab close.
- **Terminal input while disconnected:** any input queued only in the current page can be lost if that page ends before reconnect. Keep the existing bounded queue and visible count; never imply queued input reached the PTY, persist it in the workspace, or replay it into a replacement shell.
- **Terminal display history:** preserving the PTY does not guarantee the complete acknowledged screen scrollback on a new client. The current server buffer is for unacknowledged output and is bounded. Restore the live shell and protocol-defined replay; durable full terminal transcripts would be a separate feature.
- **Server restarts:** saved named workspace data survives on disk; anonymous definitions are discarded, but in-memory terminal/browser processes cannot. Keep tab entries and show unavailable state; never silently recreate a terminal or browser.
- **Expired anonymous workspace:** drop its memory-only manifest after its lease. Any detached runtime ends by its own TTL; there is no cross-client anonymous recovery UI.
- **Session appears in multiple workspaces:** reject duplicate assignment unless an explicit future multi-view feature is implemented. Moving a session must update both manifests atomically.
- **Tab restore failure:** preserve a visible placeholder with retry/remove actions; do not discard the saved descriptor or fail the whole workspace.
- **File moved, replaced, or inaccessible:** report the stale path/version and offer browse/relink/remove. Editors must not overwrite a newer file silently; video must not continue with mixed file versions; CAD sidecar failure should retain an actionable error.
- **Concurrent workspace edits:** reject stale revisions. A client should offer reload or a small conflict resolution path; do not merge incompatible split-tree changes silently.
- **Malformed layout tree:** reject cycles, duplicate node/group/tab IDs, visible tabs referenced zero or multiple times, or minimized tabs referenced in a group, invalid orientations, and non-finite/out-of-range ratios. A bad leaf should not make unrelated workspaces unreadable.
- **Takeover races:** attach/takeover must be atomic server operations so two clients cannot both believe they own an interactive session. Notify or detach the former client and fence its old requests by generation.
- **Workspace or tab deletion during a disconnect:** queue only declarative updates with known operation IDs. Resolve uncertain close/end outcomes from server status before displaying success or retrying.
- **Small screens and impossible split constraints:** use panel minimums and existing single-group mobile presentation. Keep stored desktop proportions unchanged, even if the rendered view temporarily collapses groups.
- **Schema/type changes:** unknown panel types remain listed as unavailable; migrations must not erase their descriptors. Validate every restored path, ID, enum, and size on the server.
- **Storage failure/full disk:** fail the workspace update visibly and keep the current page's in-memory layout usable. Do not acknowledge an update as durable until the server commit succeeds.

## Implementation phases

1. **Workspace persistence foundation:** define schema, revision, lease, and session-ownership semantics; add server-owned durable storage and authenticated CRUD/list/update APIs with bounds, atomicity, migration, and corruption handling.
2. **Workbench state and responsive constraints:** add panel minimum-size metadata and enforce it in split/create/drag/restore/resize; persist tab descriptors and split tree as one revisioned update; build searchable Workspaces/Open tabs lists, ephemeral Anonymous workspace behavior, minimized tabs and the revised new-tab launcher.
3. **Reconnect lifecycle:** add shared authenticated readiness/generation service, request deadlines/cancellation, safe read recovery, and visible workspace pending-sync/conflict states. Complete video range/decoder recovery and optional saved seek time.
4. **Terminal-independent connection and stable terminal sessions:** remove the retained primary-shell dependency; make the authenticated workspace connection usable without a PTY; create a terminal session only when a terminal panel is requested; catalog and attach every terminal by stable ID while preserving replay/offset safety, explicit end, exclusive attachment/takeover, and TTL.
5. **Remote Browser sessions:** adapt the separate browser transport and Chromium lifecycle to detach/resume, explicit end/expiry, exclusive attachment, and bounded resource policy. Resolve the one-session limit before multi-tab support.
6. **Optional server-side editor drafts:** only if needed, add bounded versioned drafts with explicit restore/discard and conflict handling. Do not add browser-local persistence as a workaround.

## Verification and acceptance

With browser storage disabled, open multiple local HTML/SVG clients. Confirm each gets a distinct Anonymous workspace, reconnecting the same live page renews its lease, a fresh page gets a new anonymous ID, no client silently selects a named workspace, and the manager lists named workspaces plus this page’s anonymous workspace only. Confirm anonymous edits never reach current or backup JSON, even while durable storage is unavailable; explicitly saving persists the complete record. Select a workspace explicitly and verify its tabs, order, groups, active tabs, and split proportions restore.

Restore layouts at different viewport sizes. Confirm panel minimums are enforced during split creation, sash dragging, and restore; narrow layouts collapse without rewriting saved ratios. Test concurrent clients editing the same workspace, stale revisions, atomic tab moves, and simultaneous session takeover.

Confirm initial default Terminal opens once, generated alternatives work, and reconnect never duplicates the startup action. Then close it (or configure None) and exercise the workspace connection with zero terminal tabs: authenticate, list workspaces/sessions, browse files, and use machine status without creating a PTY. Then open multiple terminals and verify each has an independent server session. Confirm closing any terminal ends only that session and does not affect files/machine/workspace connectivity; creating a terminal after closing one creates a new session rather than reopening a hidden shell. Exercise disconnect/reattach for terminals, file browsers, dirty editors, viewers/video, CAD, Task Manager, Docker, and Browser. Cover repeated reconnects, manual Disconnect/Connect, closing a tab during recovery, stale responses from older generations, auth failure, explicit end, ambiguous mutation outcomes, file replacement, and video seek restoration if enabled. Preserve terminal shell identity and exactly-once offset replay. Confirm Browser reattaches through its own socket.

Restart the server and verify saved workspace definitions/layouts remain and anonymous records are discarded while in-memory terminal and Browser processes are reported unavailable. Verify anonymous lease expiry, detached-session expiry, confirmed workspace/session deletion, minimized-runtime continuity, storage corruption/full-disk behavior, and cleanup. Confirm dirty editor contents and unsynced workspace changes are clearly identified as transient. Bound workspace count, tab count, storage size, session count, metadata, retries, and recovery deadlines. Validate physical iOS background/foreground behavior separately; browser emulation does not model operating-system suspension or all media policies.

## Implementation checkpoint

The continuity foundation and the revised workspace/tab interface are implemented. Operational behavior is documented in [workspaces.md](workspaces.md). Anonymous records are memory-only until Save workspace; minimized tabs remain live and persist in saved workspace manifests. Optional server-side editor drafts remain outside this version.

| Area | Acceptance evidence |
| --- | --- |
| Server storage and protocol | All 86 Rust tests passed. Workspace tests cover memory-only anonymous edits with an unavailable disk, explicit durable promotion, legacy anonymous discard, scoped lists, separate 64+64 bounds, revisions, atomic moves, corruption/permissions and minimized descriptor validation/copy/move/restart. `workspace-protocol.cjs` passed authenticated wire checks. |
| Startup and generator | `workspace-startup.cjs` passed the default terminal, reconnect without duplication, actual background terminal execution while minimized, removed Files header, and generated local HTML/SVG starting-panel choices. |
| Workspace manager | `workspace-modal-v2.cjs` and `workspace-manager.cjs` passed explicit save/create/open, automatic close, separate searchable scroll lists, Lucide actions, SVG drag-and-drop and keyboard moves, minimized focus/close, confirmed session cleanup, server switching and 375px modal bounds. |
| Minimized tabs and new-tab launcher | `panel-minimize.cjs` passed mounted DOM/dirty-buffer retention without cleanup on minimize, same-instance reopen, hidden descriptors outside the layout tree, close/clear cleanup, and independent searchable scrolling lists on desktop and mobile. |
| Saved layouts and cross-client recovery | `workspace-continuity.cjs` and `workspace-layout.cjs` passed explicit named save, new-client cwd/layout restoration, unchanged responsive ratios, pane minimums, independent terminal identity, placeholders and restart behavior. |
| Conflicts and failures | `workspace-conflicts.cjs` passed lost-reply reconciliation, stale-revision reload and offline sync. `workspace-edge-cases.cjs` passed bounded authentication retry, uncertain saves without replay, recoverable durable-storage failures, anonymous work at named-store capacity, and a still-open dirty/minimized anonymous editor rebinding after server restart. |
| Other panel recovery | `workspace-viewers.cjs` and `browser-workspace.cjs` passed editor conflicts, CAD, Task Manager/Docker without a PTY, streamed media seek/worker recovery, and real Chromium restoration/takeover/manual detach/end across HTML/SVG clients. |
| Terminal regressions | `panel-factories.cjs` and `terminal-takeover-input.cjs` passed independent terminals, output isolation, reconnect/restart/cleanup and fresh-client input after accepted-but-unwritten bytes. Existing offset/replay behavior is retained. |
| Build checks | Client/generator and embedded server rebuilt. Cargo check/format, JavaScript syntax and whitespace checks passed. |

No browser-local continuity storage or hidden connector terminal is used. Anonymous definitions, dirty editor buffers, queued input and unacknowledged edits remain transient; complete acknowledged terminal transcripts and runtime survival across server restart are outside the feature. Removing the Active sessions display leaves the authenticated session-management protocol available; confirmed workspace deletion ends its assigned sessions, and detached runtimes still have bounded expiry.

Physical iOS suspension/media behavior remains a separate device check. Hard crashes can leave temporary Chromium profile files even though parent-death handling stops Chromium. Some legacy UI suites still target removed controls (including the old advanced Browser and primary-terminal surfaces); the focused acceptance suites above exercise the current interface rather than claiming those obsolete suites pass.
