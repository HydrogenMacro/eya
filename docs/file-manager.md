# File workspace

Eya's file workspace is a browser-based file manager and viewer carried over the same authenticated, Noise-encrypted WebSocket as the terminal. It works from the generated standalone HTML and SVG clients, including `file://` pages, without exposing a separate HTTP file API.

## Opening and arranging the workspace

Select **Files** in the main header to show or hide the primary browser panel. Use **+ → File browser** for additional independent instances with their own path, search, history, and selection. Use direct split buttons and sashes to place and resize panels. In **Settings → Files** and **Editor**, choose:

- **Starting directory**. An empty value uses `EYA_CWD`, then the server user's home, then `/`.
- **Refresh** from off through 2, 5, 10, or 30 seconds.
- **Hidden files**, file detail columns, and delete confirmation.
- Editor font size, tab size, line wrapping, and line numbers.

The settings dialog has a search field. Its filter matches section names, setting names, and descriptions. Settings are stored in the browser's local storage; they do not alter the generated client or server configuration.

Open Settings from the header's **Workspace menu** or with `Ctrl+,` / `Cmd+,`. Secondary browser controls such as New folder, Refresh, Forward, and Close files are in **File browser menu**. See [interface.md](interface.md) for the compact toolbar layout and keyboard controls.

File previews are independent workbench panels rather than children of the browser interface. They can share a tab group with Files, be dragged to another group, or be split right/down with the group controls. See [panels.md](panels.md) for the complete panel model and API.

On narrow or touch layouts, the active panel group fills the workspace rather than squeezing groups together. Closing Files returns to the terminal and its mobile key bar. Path, search, settings, and CodeMirror editing surfaces use a 16 px size to avoid automatic focus zoom used by mobile Safari and other browsers. Editor focus also keeps the fixed workbench dimensions stable while the software keyboard changes the visual viewport. Native pinch zoom remains available.

## File browser operations

The Browser tab provides:

- Back, forward, parent-directory, direct-path, and refresh navigation.
- A `..` row at the top of ordinary directory listings.
- Recursive, case-insensitive name search below the current directory. Results are capped at 1,000 entries and traversal is capped at 24 directory levels.
- Folder-first directory listings with sizes and modification times.
- Optional hidden files.
- New folder and multi-file upload controls, with Open, Download, Rename, and Delete in the menu beside each file.
- Keyboard navigation: arrows/Home/End select rows; Enter opens; F2 renames; Delete/Backspace deletes the selected file; Alt+Up navigates to the parent. Ctrl/Cmd+L focuses the path; Ctrl/Cmd+F focuses search. Text inputs keep their normal editing behavior.

Select an item once to enable its actions. Double-click a folder to enter it or a file to open it. Deleting a directory is recursive after confirmation. Deletes are not moved to an operating-system trash and cannot be undone.

Renaming refuses an existing destination instead of overwriting it. Open editors follow file/folder renames while preserving edits and undo history. Renaming waits for active saves to finish and refuses conflicts with another open destination editor.

Upload through the icon button or drag files onto a browser panel. Uploads are written to a temporary file in the destination directory, flushed, and atomically renamed when the final encrypted chunk arrives. An interrupted upload is removed. Existing files are not replaced without a second confirmation in the client. Editor saves use the same atomic upload path.

At most eight uploads may be active per connection. Temporary files use short independent names, including when the destination filename reaches the filesystem's name limit. New uploads are private to the account (mode `0600`); overwriting an existing regular file preserves its ordinary permission/execute bits while clearing special set-ID bits. The opened descriptor must be a regular file; a path swapped to a FIFO cannot leave the server waiting for a writer.

Directory listing rejects directories beyond 20,000 entries rather than allocating an unbounded response. Recursive search additionally stops with an explicit error beyond 100,000 examined entries or 4,096 directories; choose a narrower starting directory in that case. Files disappearing during an ordinary directory listing are skipped. Search reports an inaccessible/missing starting directory rather than presenting it as empty.

Downloads are assembled in browser memory before the browser's download flow starts. Local uploads read bounded slices from the browser `File` after the server accepts its size; editor saves use an existing text buffer. `EYA_MAX_FILE_BYTES` limits each transfer and opened file; its default is 268,435,456 bytes (256 MiB). Set it before starting the server, for example:

```sh
EYA_MAX_FILE_BYTES=536870912 EYA_KEY='your password' ./eya-server/target/release/eya-server
```

## Tabs, editor, and viewers

Every opened file receives a generic workbench tab. The Files tab remains available until explicitly closed. A dot on a file tab indicates unsaved editor changes; closing such a tab asks for confirmation.

Text files up to 5 MiB open in CodeMirror. Eya detects UTF-8 text and common text extensions, supplies modes for JSON, JavaScript/TypeScript/JSX, HTML, CSS, and Markdown, and supports undo history, indentation, selection, line numbers, wrapping, and `Ctrl`/`Cmd`+`S`. Files above the editor limit can still be downloaded.

PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, and SVG files use an image view. Common MP4, WebM, Ogg video, QuickTime, 3GP, and Matroska extensions use a native `<video>` view with controls and inline mobile playback. MP3, WAV, Ogg/Opus, M4A, AAC, FLAC, and WebM audio use a native `<audio>` view. Actual container and codec support depends on the browser. Unknown or complex formats use the generic viewer, which reports the file size and offers Download.

STL, GLB, and glTF files open in the [CAD viewer](cad.md), with wireframe/edge display, orbit controls, measurements, and independent live reload. Relative glTF buffers and textures are read through the same encrypted file connection and included in live-reload checks. GLB is the recommended single-file build123d preview export; exact STEP/BRep analysis is not provided.

The client viewer selection is an ordered registry. Trusted future viewers can register before the generic fallback through `EyaPanels.registerViewer`:

```js
EyaPanels.registerViewer({
  name: 'example',
  supports: tab => extension(tab.path) === 'example',
  render: tab => renderExample(tab),
});
```

The renderer owns a tab-local DOM node and may create object URLs or other browser-native resources. Follow the existing viewers' cleanup pattern when adding long-lived resources.

## Automatic refresh and conflicts

While the panel is visible and the page is active, automatic refresh reloads the current directory. It also checks the active clean file tab and replaces its contents when the server modification time or file size changes. Dirty editor tabs are never overwritten by refresh. Saving a dirty tab intentionally replaces the server version; Eya does not yet provide three-way merge or collaborative locking.

Browser visibility pauses refresh work in background tabs. Manual refresh is always available. Shell commands that create, rename, or update files appear on the next refresh, which connects terminal workflows and the GUI without filesystem watcher requirements.

## Security model

File control messages and binary chunks are framed inside the established Noise transport. There is no unauthenticated file route. The same shared password grants terminal and file access, so a leaked generated client is equivalent to leaked host access.

Native mode uses the server process's filesystem permissions. Docker host mode resolves logical paths below `/proc/EYA_HOST_PID/root`, reads the selected account from the host's passwd and group databases, and applies the UID, primary group, and supplementary groups of `EYA_HOST_USER` for each filesystem operation. File access therefore follows the same host identity as the terminal. The container itself remains privileged and must still be treated as full host control: keep the listener on loopback or a trusted private network, use HTTPS/WSS through a reverse proxy, and rotate the shared password if a client is lost.

Paths are normalized to an absolute logical path. `..` cannot move above `/`, and deleting `/` is rejected. This is a safety guard, not a sandbox: authenticated users may intentionally navigate to any path the server can access. Symlinks retain the operating system's normal behavior.

## Wire protocol and limits

File messages introduced in protocol v3 are also used by resumable protocol v4. The terminal/session framing is documented in [reconnection.md](reconnection.md). File messages are:

| Type | Direction | Purpose |
| --- | --- | --- |
| `4` | both | UTF-8 JSON request or response |
| `5` | both | file bytes: request id, final flag, and payload |
| `6` | server → client | chunked JSON for unusually large directory/search results |

Requests use monotonically increasing 32-bit IDs so transfers can be matched independently. Binary payloads are at most 60,000 bytes, below the Noise/WebSocket frame limit. The server supports `list`, `stat`, `search`, `mkdir`, `rename`, `delete`, `read`, and `write`; errors are returned to the matching request without terminating the terminal session. `stat` returns file size and an opaque high-resolution `version` token; `read` includes the same token from its open file descriptor. Older v1/v2 clients continue to work as terminals and simply do not send file messages.

## Troubleshooting

- **Connect to browse files**: file access shares the terminal connection; connect first.
- **Permission denied**: verify the native server account's permissions. In Docker, verify `--privileged`, `--pid=host`, `--userns=host`, and `EYA_HOST_PID`.
- **File exceeds the configured transfer limit**: raise `EYA_MAX_FILE_BYTES` and restart the server, or use terminal tools for the file.
- **A video does not play**: download it and check whether the browser supports its container and codec.
- **External edits do not appear**: enable automatic refresh, use Refresh, and ensure the page is visible. Dirty editors deliberately ignore external refreshes.
- **Standalone client cannot connect**: check browser local-network permission, mixed-content policy, certificate trust, and the `ws://`/`wss://` URL as described in the main README.
