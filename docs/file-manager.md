# File workspace

Eya's file workspace is a browser-based file manager and viewer carried over the same authenticated, Noise-encrypted WebSocket as the terminal. It works from the generated standalone HTML and SVG clients, including `file://` pages, without exposing a separate HTTP file API.

## Opening and arranging the workspace

Select **Files** in the main header to show or hide the workspace. The preference is saved locally. In **Settings → Files and editor**, choose:

- **Show file panel after connecting** to retain its visibility between launches.
- **Terminal/file split** for a side-by-side or stacked desktop layout.
- **File panel size** from 25–75% of the workspace.
- **Starting directory**. An empty value uses `EYA_CWD`, then the server user's home, then `/`.
- **Automatic refresh** from off through 2, 5, 10, or 30 seconds.
- **Show hidden files**, editor line wrapping and line numbers, and delete confirmation.

The settings dialog has a search field. Its filter matches section names, setting names, and descriptions. Settings are stored in the browser's local storage; they do not alter the generated client or server configuration.

On narrow or touch layouts, Files fills the workspace rather than squeezing the terminal. Closing Files returns to the terminal and its mobile key bar. Path, search, and settings fields use a 16 px input size to avoid the automatic focus zoom used by mobile Safari and other browsers. Native pinch zoom remains available.

## File browser operations

The Browser tab provides:

- Back, forward, parent-directory, direct-path, and refresh navigation.
- A `..` row at the top of ordinary directory listings.
- Recursive, case-insensitive name search below the current directory. Results are capped at 1,000 entries and traversal is capped at 24 directory levels.
- Folder-first directory listings with sizes and modification times.
- Optional hidden files.
- New folder and multi-file upload controls, with Open, Download, Rename, and Delete in the menu beside each file.
- Keyboard navigation: focus a row and press Enter to open it.

Select an item once to enable its actions. Double-click a folder to enter it or a file to open it. Deleting a directory is recursive after confirmation. Deletes are not moved to an operating-system trash and cannot be undone.

Uploads are written to a temporary file in the destination directory, flushed, and atomically renamed when the final encrypted chunk arrives. An interrupted upload is removed. Existing files are not replaced without a second confirmation in the client. Editor saves use the same atomic upload path.

Downloads are assembled in browser memory before the browser's download flow starts. Uploads likewise originate from a browser `File` or an editor buffer. `EYA_MAX_FILE_BYTES` limits each transfer and opened file; its default is 268,435,456 bytes (256 MiB). Set it before starting the server, for example:

```sh
EYA_MAX_FILE_BYTES=536870912 EYA_KEY='your password' ./eya-server/target/release/eya-server
```

## Tabs, editor, and viewers

Every opened file receives a tab. The Browser tab always remains available. A dot on a file tab indicates unsaved editor changes; closing such a tab asks for confirmation.

Text files up to 5 MiB open in CodeMirror. Eya detects UTF-8 text and common text extensions, supplies modes for JSON, JavaScript/TypeScript/JSX, HTML, CSS, and Markdown, and supports undo history, indentation, selection, line numbers, wrapping, and `Ctrl`/`Cmd`+`S`. Files above the editor limit can still be downloaded.

PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, and SVG files use an image view. Common MP4, WebM, Ogg video, QuickTime, 3GP, and Matroska extensions use a native `<video>` view with controls and inline mobile playback. MP3, WAV, Ogg/Opus, M4A, AAC, FLAC, and WebM audio use a native `<audio>` view. Actual container and codec support depends on the browser. Unknown or complex formats use the generic viewer, which reports the file size and offers Download.

The client viewer selection is an ordered registry in `client/app.js` named `fileViewers`. To add a complex viewer, add a provider before `generic` with:

```js
{
  name: 'example',
  supports: tab => extension(tab.path) === 'example',
  render: tab => renderExample(tab),
}
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

Protocol v3 retains v2 terminal flow control and adds encrypted message types:

| Type | Direction | Purpose |
| --- | --- | --- |
| `4` | both | UTF-8 JSON request or response |
| `5` | both | file bytes: request id, final flag, and payload |
| `6` | server → client | chunked JSON for unusually large directory/search results |

Requests use monotonically increasing 32-bit IDs so transfers can be matched independently. Binary payloads are at most 60,000 bytes, below the Noise/WebSocket frame limit. The server supports `list`, `search`, `mkdir`, `rename`, `delete`, `read`, and `write`; errors are returned to the matching request without terminating the terminal session. Older v1/v2 clients continue to work as terminals and simply do not send file messages.

## Troubleshooting

- **Connect to browse files**: file access shares the terminal connection; connect first.
- **Permission denied**: verify the native server account's permissions. In Docker, verify `--privileged`, `--pid=host`, `--userns=host`, and `EYA_HOST_PID`.
- **File exceeds the configured transfer limit**: raise `EYA_MAX_FILE_BYTES` and restart the server, or use terminal tools for the file.
- **A video does not play**: download it and check whether the browser supports its container and codec.
- **External edits do not appear**: enable automatic refresh, use Refresh, and ensure the page is visible. Dirty editors deliberately ignore external refreshes.
- **Standalone client cannot connect**: check browser local-network permission, mixed-content policy, certificate trust, and the `ws://`/`wss://` URL as described in the main README.
