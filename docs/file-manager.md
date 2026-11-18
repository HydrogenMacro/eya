# File workspace

Eya's file workspace is a browser-based file manager and viewer carried over the authenticated, Noise-encrypted workspace connection. It works from the generated standalone HTML and SVG clients, including `file://` pages, without exposing a separate HTTP file API.

## Opening and arranging the workspace

Select **Files** in the main header, or **+ → File browser**, to open an independent browser with its own path, search, history, and selection. Its cwd and tab recipe belong to the selected server workspace. Use direct split buttons and sashes to place and resize panels. In **Settings → Files** and **Editor**, choose:

- **Starting directory**. An empty value uses `EYA_CWD`, then the server user's home, then `/`.
- **Refresh** controls directory refresh and file change-check frequency: off, 2, 5, 10, or 30 seconds. With directory refresh off, open files are still checked every 5 seconds.
- **Automatically reload changed files**, enabled by default. Turn it off to keep the current contents until manual Refresh; change detection remains active.
- **Hidden files**, file detail columns, and delete confirmation.
- **Transfer size units**: bytes (the existing default), KiB, MiB, or automatic scaling. Binary units use 1024 bytes per KiB and 1024 KiB per MiB. This controls read/refresh/search/stream progress and persists with workspace preferences.
- Editor font size, tab size, line wrapping, and line numbers.

The settings dialog has a search field. Its filter matches section names, setting names, and descriptions. Workspace display/editor preferences are stored on the server with the workspace; no browser storage is used. They do not alter the generated client or server configuration.

Open Settings from the header's **Workspace menu** or with `Ctrl+,` / `Cmd+,`. Refresh is available directly in each file browser and viewer toolbar. Viewer panes appear immediately with a loading message while file data is fetched; failed opens retain a message and can be retried with Refresh. Refresh is disabled for editors with unsaved changes. Loading and refreshing show received bytes, total bytes, and percentage once file metadata arrives. Directory/search transfers show bytes received with “total unknown” until the response completes, then the item count; the protocol does not announce their total in advance. HTML and CAD resource reads report their transfer progress, and streamed videos report distinct bytes fetched against the full file size (seeks and repeated reads are not double-counted). Secondary browser controls such as New folder, Forward, and Close files are in **File browser menu**. See [interface.md](interface.md) for the compact toolbar layout and keyboard controls.

Both file browser surfaces have Name, Size, Modified, and Type sort buttons. Each header cycles ascending → descending → none; none restores server ordering. Sorting uses natural numeric names, preserves equal-value order, keeps the parent row first, and applies to search results and keyboard/range selection. Modified shows local “Today at …”, “Yesterday at …”, or a dated time, with the full timestamp in its tooltip and a wider desktop column. File and folder icons come from the pinned `material-icon-theme` npm package and are embedded in the standalone client, including its filename/extension/folder mappings. Drag across file labels to select text; Ctrl/Cmd+C copies selected text when a text selection exists.

Image viewers offer **Download image** and **Copy image** on right-click, alongside their existing toolbar controls. Dismissing the image menu consumes that gesture.

File previews are independent workbench panels rather than children of the browser interface. They can share a tab group with Files, be dragged to another group, or be split right/down with the group controls. See [panels.md](panels.md) for the complete panel model and API.

On narrow or touch layouts, the active panel group fills the workspace rather than squeezing groups together. Closing Files activates another tab in its group or leaves an empty group; no terminal is required. Path, search, settings, and CodeMirror editing surfaces use a 16 px size to avoid automatic focus zoom used by mobile Safari and other browsers. Editor focus also keeps the fixed workbench dimensions stable while the software keyboard changes the visual viewport. Native pinch zoom remains available.

## File browser operations

The Browser tab provides:

- Back, forward, parent-directory, direct-path, and refresh navigation.
- Path and search comboboxes with file/folder suggestions. Arrow Up/Down chooses a suggestion, Home/End moves to the first/last choice, Enter opens it, and Tab completes the selected text while moving focus onward. Escape dismisses the list; typing continues normal editing. Path completion uses the parent directory's listing; search retains the existing recursive name matching.
- Type `../` at the start of search to move up one directory and consume that prefix, keeping any remaining search text. Repeated prefixes keep moving upward, stopping at `/`. In the path field, a trailing `../` immediately removes the previous directory component; Enter or Go navigates to the resulting path.
- A `..` row at the top of ordinary directory listings.
- Recursive, case-insensitive name search below the current directory. Results are capped at 1,000 entries and traversal is capped at 24 directory levels.
- Folder-first directory listings with sizes and modification times.
- Optional hidden files.
- New folder and multi-file upload controls, with Open With…, Download, Copy selected files, Rename, and Delete in the menu beside each file. A selection toolbar provides Copy, Paste, and Delete for the selected entries.
- Keyboard navigation: arrows/Home/End select rows; Enter opens; F2 renames; Delete/Backspace deletes the selected entries; Alt+Up navigates to the parent. Ctrl/Cmd+L focuses the path; Ctrl/Cmd+F focuses search. Text inputs keep their normal editing behavior.

Select an item once to enable its actions. Ctrl/Cmd-click or Alt-click toggles individual entries; Shift-click selects a range. Row checkboxes support multiple selection on touch screens, and the selection toolbar checkbox or Ctrl/Cmd+A selects all listed entries. Refresh preserves selected entries that still exist; navigating to another folder clears selection. Double-click a folder to enter it or a file to open it; on touch screens, double-tap the entry. Scrolling and entry menus do not count as double taps. Deleting a directory is recursive after confirmation. Deletes are not moved to an operating-system trash and cannot be undone.

Copy regular files with the toolbar, entry menu, or Ctrl/Cmd+C, then choose a destination folder in any file-browser pane and use Paste or Ctrl/Cmd+V. The internal clipboard belongs to the current server connection; it does not use the device clipboard. Copies use the saved file contents and transfer one file at a time through the existing encrypted read/upload operations, with the same file-size limits and private-file creation permissions as uploads. Folders and symbolic links are excluded from Copy. Pasting into the source folder creates `name copy.ext`, then numbered copies, without replacing the source. Other filename conflicts ask before replacement and validate the destination version. Copy/paste and deletion batches are limited to 1,000 selected entries.

Deleting multiple entries asks once when delete confirmation is enabled; selected folders include their contents. Unsaved editors affected by deletion require a separate discard confirmation before any file is deleted. Operations stop on the first failure, refresh the browser, and report partial completion. Already completed copies or deletions remain in place. Clipboard contents and selection are temporary and are not saved in the workspace.

Renaming refuses an existing destination instead of overwriting it. Open editors follow file/folder renames while preserving edits and undo history. Renaming waits for active saves to finish and refuses conflicts with another open destination editor.

Upload through the icon button or drag files onto a browser panel. Uploads are written to a temporary file in the destination directory, flushed, and atomically renamed when the final encrypted chunk arrives. An interrupted upload is removed. Existing files are not replaced without a second confirmation in the client. Editor saves use the same atomic upload path.

At most eight uploads may be active per connection. Temporary files use short independent names, including when the destination filename reaches the filesystem's name limit. New uploads are private to the account (mode `0600`); overwriting an existing regular file preserves its ordinary permission/execute bits while clearing special set-ID bits. The opened descriptor must be a regular file; a path swapped to a FIFO cannot leave the server waiting for a writer.

Directory listing rejects directories beyond 20,000 entries rather than allocating an unbounded response. Recursive search additionally stops with an explicit error beyond 100,000 examined entries or 4,096 directories; choose a narrower starting directory in that case. Files disappearing during an ordinary directory listing are skipped. Search reports an inaccessible/missing starting directory rather than presenting it as empty.

Downloads are assembled in browser memory before the browser's download flow starts. Local uploads read bounded slices from the browser `File` after the server accepts its size; editor saves use an existing text buffer. `EYA_MAX_FILE_BYTES` limits each transfer and opened file except streamed video playback and bounded caption reads; its default is 268,435,456 bytes (256 MiB). Set it before starting the server, for example:

```sh
EYA_MAX_FILE_BYTES=536870912 EYA_KEY='your password' ./eya-server/target/release/eya-server
```

## Tabs, editor, and viewers

Every opened file receives a generic workbench tab. The Files tab remains available until explicitly closed. A dot on a file tab indicates unsaved editor changes; closing such a tab asks for confirmation.

Text files up to 5 MiB open in CodeMirror. Larger text files show a read-only preview of the first 5 MiB and retain the complete download. Unknown extensions are classified using the full bounded transfer: NUL, invalid UTF-8, or excessive control bytes select the binary editor. The text editor supplies modes for JSON, JavaScript/TypeScript/JSX, HTML, CSS, and Markdown, and supports undo history, indentation, selection, line numbers, wrapping, and `Ctrl`/`Cmd`+`S`. Files above the editor limit can still be downloaded.

PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, and SVG files use an image view. A checkerboard background makes transparent areas visible by default. The **Image background** visual radio choices select checkerboard, white, or the plain workspace background. Arrow keys move between these choices. The selection is saved per image viewer in the workspace and survives Refresh; it does not change image pixels. Previously saved custom backgrounds retain their colors until a new preset is selected. Drag or use the arrow keys to pan; scroll, use the zoom icons, or press plus/minus to zoom. Reset the view with the reset icon or the 0 key. **Copy image** copies the image pixels as PNG with transparency, independently of the view zoom and background. Animated images copy the current frame. Image copying requires browser Clipboard API support and permission; a failure is reported without changing the image. Images over 32 megapixels can be downloaded instead. MP4, M4V, WebM, Ogg video, QuickTime, 3GP, 3G2, and Matroska videos stream over encrypted, bounded range reads and can be sought without downloading the whole file. The player checks the file version on each read. The browser’s native video player obtains ranges through a local service-worker bridge. The bridge requires the server to be reached at HTTPS or a browser-trusted loopback origin such as localhost. On insecure non-loopback origins videos use the whole-file viewer and its transfer limit. Browser support for each container and codec is still required. MP3, WAV, Ogg/Opus, M4A, AAC, FLAC, and WebM audio use a native `<audio>` view. The video player provides playback, seeking, 10-second skips, volume, fullscreen, playback speed, looping, and embedded subtitle selection and appearance settings. The seek bar shows buffered ranges and a time and image preview; previews use a temporary second decoder and fall back to time only when the browser cannot decode a preview. The video fills its panel without creating a scrolling page; settings scroll within the player. Touch gestures outside the video retain normal client scrolling. A central play/pause button shows the current action. Controls hide after inactivity during playback or when clicking outside the player, and tapping the video reveals them. Settings use translucent category menus with custom choices to avoid native mobile pickers interrupting fullscreen. Subtitle appearance can be reset, and captions move above visible controls. Player-focused shortcuts include Space/K for playback, Left/Right for five-second skips, M for mute, and F for fullscreen. It renders subtitle cues in its own overlay when the client browser exposes the embedded tracks as text tracks. Support for in-band subtitle tracks varies by browser and container; tracks the browser does not expose cannot be displayed. The settings include an ffmpeg example for creating a new MP4 with embedded subtitles. On iOS the player uses inline playback and falls back to an expanded player within the available frame when the Fullscreen API is unavailable. Actual container and codec support depends on the browser. Unknown extensions are classified from their bytes and open in the text or binary editor.

STL, GLB, glTF, and 3MF files open in the [CAD viewer](cad.md), with wireframe/edge display, orbit controls, measurements, and independent live reload. Relative glTF buffers and textures are read through the same encrypted file connection and included in live-reload checks. GLB is the recommended single-file build123d preview export; exact STEP/BRep analysis is not provided.

HTML and HTM files open in a local document viewer with back/forward navigation, reload, and zoom controls. Relative links to other local documents are resolved against the current file and loaded through the encrypted file connection. Relative stylesheets, images, and fonts use the same connection. Scripts, embedded frames, and external resources are disabled. The server's file root and file access checks continue to apply.

The client viewer selection is an ordered registry. Trusted future viewers can register before the binary fallback through `EyaPanels.registerViewer`:

```js
EyaPanels.registerViewer({
  name: 'example',
  supports: tab => extension(tab.path) === 'example',
  render: tab => renderExample(tab),
});
```

The renderer owns a tab-local DOM node and may create object URLs or other browser-native resources. Follow the existing viewers' cleanup pattern when adding long-lived resources.

## Open With and Markdown

Double-click and Enter use the most specific viewer: Markdown for `.md`/`.markdown`, HTML for web documents, and the corresponding image, media, or 3D panel for recognized formats. Files with multiple openers show **Open With…** in their entry menu, with a panel-type submenu beside it. Hover, click/tap, or Arrow Right opens the submenu; Escape or Arrow Left returns to the parent menu. It flips sides at a viewport edge and stays open while selecting an item. Text and binary editors are available alongside specific viewers. Switching an open file with unsaved changes asks before discarding edits.

**Settings → Files → File openers** contains a searchable extension-to-panel table and **Add extension**. Extension matching ignores case and accepts a leading dot. Choices are embedded in generated clients and saved with workspace preferences; explicit Open With choices belong to the individual saved file tab. Defaults prefer specific viewers. Unmapped types use format matching and then content detection. Up to 256 mappings are accepted.

The Markdown panel renders headings, emphasis, links, lists, tasks, tables, blockquotes and code. Local links and images use the encrypted file connection. Raw HTML is shown as text; scripts, embedded frames, and automatic external image requests are disabled. Previews are bounded to the first 2 MiB, 50,000 syntax nodes, and 128 nesting levels; an explicit notice preserves access through Open With or Download. Local images are bounded to 64 resources and 16 MiB total. External HTTP(S) links use the terminal link destination setting. Choose Text editor in Open With to edit Markdown source.

The **Open directory in terminal** toolbar button creates a new terminal in the current directory. Directory entry menus also offer **Open in terminal**. Paths are shell-quoted; the configured startup command runs once after changing directory. No session is reused or moved.

## Binary editor

The binary editor has a single-row toolbar: **Hex**, **Bin**, **Uint**, or **Int**; connected **1/2/4/8** byte-width and **LE/BE** radio tabs; Find; Go to offset; and Settings. A divider separates format controls from the action group, with balanced button padding. Toolbar, edit-row, Find, and Offset controls share one height (36 px, or 40 px on mobile) and fit a 320 px screen. Find and Offset toggle floating panels instead of reserving permanent rows. Byte pairs and eight-bit groups stay aligned in virtual rows; the data area and long numeric readouts scroll inside the panel.

The compact footer reports `@<offset>: 0b<bits> | 0x<hex> | <value>uint | <value>int`. Values are exact through 64 bits. An incomplete word or the editable end-of-file position shows a dash. Click a byte or text cell, drag or Shift-select a range, use arrow/Page/Home/End keys, or enter a decimal/hex offset. Find supports text in the selected encoding, hex pairs, or binary groups; next/previous searches wrap and move to the match. Patterns are bounded to 4096 bytes and scans yield to the UI.

The one-line edit field includes Number/Text icon radio tabs, Apply, and **Row actions**. Edits overwrite existing bytes; applying at the end of the file appends. Row actions includes Insert row, Delete selection, Undo, Redo, Save, Refresh, Download and Copy path. Insert row adds a zero-filled row at the selected offset. Delete selection removes the selected bytes; undo/redo restores both contents and length. Empty files remain editable at offset zero. Save and its configured shortcut use the same version-checked atomic upload as the text editor. New edits during a save stay dirty, conflicting saves retain the buffer, and downloads include unsaved edits.

**Settings → Binary viewer** controls display, width, byte order, automatic or fixed bytes per row, group size/spacing, text column, offsets, line numbers, ASCII/UTF-8/Windows-1252/UTF-16 encoding, offset format, hexadecimal case, font/size, row height, alternating rows, dimmed zeros, and selection/search colors. Changes apply to open binary viewers and become defaults for new ones. Per-tab settings and position are retained in saved workspaces; defaults are also available in the client generator.

Edits and clipboard operations are bounded to 1 MiB each; undo/redo retains up to 1000 edits or 8 MiB. Insertion is bounded to 256 MiB total; files already above that local limit can still be overwritten or shrunk. The server's configured file-transfer limit also applies to saving. Virtual scrolling bounds mounted rows and scroll height independently of file length.

## Automatic refresh and conflicts

While a file pane is visible and the page is active, version checks detect disk changes, including in dirty editors. A **Changed on disk** indicator remains visible when autoreload is disabled or the editor has unsaved changes. With autoreload enabled, clean viewers reload and show **Updated from disk**. CAD also respects its per-viewer live-reload setting. Streamed videos require manual Refresh to adopt a new version, preserving playback until then. Directory refresh continues independently of the file autoreload setting.

Dirty editors are never overwritten. Saves validate the loaded file version and reject external conflicts while retaining the local buffer; Eya does not provide three-way merge.

Browser visibility pauses refresh work in background tabs. Manual refresh is always available. Shell commands that create, rename, or update files appear on the next refresh, which connects terminal workflows and the GUI without filesystem watcher requirements.

## Security model

File control messages and binary chunks are framed inside the established Noise transport. There is no unauthenticated file route. For native video streaming the server also serves a static player and service worker; the worker accepts byte ranges only from its own player and receives file bytes through the authenticated client connection, not from an HTTP file endpoint. The same shared password grants terminal and file access, so a leaked generated client is equivalent to leaked host access.

Native mode uses the server process's filesystem permissions. Docker host mode resolves logical paths below `/proc/EYA_HOST_PID/root`, reads the selected account from the host's passwd and group databases, and applies the UID, primary group, and supplementary groups of `EYA_HOST_USER` for each filesystem operation. File access therefore follows the same host identity as the terminal. The container itself remains privileged and must still be treated as full host control: keep the listener on loopback or a trusted private network, use HTTPS/WSS through a reverse proxy, and rotate the shared password if a client is lost.

Paths are normalized to an absolute logical path. `..` cannot move above `/`, and deleting `/` is rejected. This is a safety guard, not a sandbox: authenticated users may intentionally navigate to any path the server can access. Symlinks retain the operating system's normal behavior.

## Wire protocol and limits

File messages introduced in protocol v3 are also used by resumable protocol v4. The terminal/session framing is documented in [reconnection.md](reconnection.md). File messages are:

| Type | Direction | Purpose |
| --- | --- | --- |
| `4` | both | UTF-8 JSON request or response |
| `5` | both | file bytes: request id, final flag, and payload |
| `6` | server → client | chunked JSON for unusually large directory/search results |

Requests use monotonically increasing 32-bit IDs so transfers can be matched independently. Binary payloads are at most 60,000 bytes, below the Noise/WebSocket frame limit. The server supports `list`, `stat`, `search`, `mkdir`, `rename`, `delete`, `read`, `read_range`, and `write`; errors are returned to the matching request without terminating the terminal session. `stat` returns file size and an opaque high-resolution `version` token; `read` includes the same token from its open file descriptor. Older v1/v2 clients continue to work as terminals and simply do not send file messages.

## Troubleshooting

- **Connect to browse files**: file access uses the workspace connection; connect first without creating a terminal.
- **Permission denied**: verify the native server account's permissions. In Docker, verify `--privileged`, `--pid=host`, `--userns=host`, and `EYA_HOST_PID`.
- **File exceeds the configured transfer limit**: raise `EYA_MAX_FILE_BYTES` and restart the server, or use terminal tools for the file.
- **A video does not play**: check whether the browser supports its container and codecs. Streaming requires HTTPS or a browser-trusted loopback server origin so its service worker can start; videos on other origins are subject to the whole-file transfer limit.
- **External edits do not appear**: enable automatic refresh, use Refresh, and ensure the page is visible. Dirty editors report external changes but keep their local buffer.
- **Standalone client cannot connect**: check browser local-network permission, mixed-content policy, certificate trust, and the `ws://`/`wss://` URL as described in the main README.

`read_range` reads an arbitrary byte offset from a regular file, with a required length between 1 and 1,048,576 bytes. It bypasses the whole-file transfer limit but bounds each response; an optional `version` rejects reads if the file has changed. Its metadata reports the full size, offset, returned length, and descriptor version. All supported video viewers use these reads.

### Video player rendering and recovery

Background taps toggle the controls without changing playback; use the central or toolbar play/pause buttons (or keyboard shortcuts) to change playback. The compact settings menu aligns with its button. The seek rail displays played and buffered ranges, and its preview places the decoded image above the timestamp. Loading controls appear before media metadata is ready.

Embedded cues use the browser's WebVTT parser with a restricted DOM renderer for bold, italic, underline, ruby, voice/language annotations, and standard cue colors. A separate subtitle library is unnecessary for these features. Arbitrary WebVTT stylesheet blocks and full region/layout fidelity are not implemented; browser exposure of embedded tracks remains required.

Brief transport outages retain the player and defer/retry only idempotent video range reads, within a 20-second reconnection wait window. Reads still validate the original file version and session identity. Authenticated recovery can rebuild a failed decoder, and a new client can reopen the saved file/version and playback position. A changed file requires explicit reload. See [workspace continuity](workspaces.md) and [the project continuity specification](workspace-continuity-plan.md).

### External video subtitles

Opening or refreshing a video scans its own directory for `basename[.language][.flags].srt`, `.vtt`, `.ass`, and `.ssa` files. For `Movie.mkv`, examples are `Movie.srt`, `Movie.en.srt`, and `Movie.en.forced.vtt`; `Movie2.en.srt` is excluded. The subtitle menu labels tracks with their suffixes (including forced/SDH labels). Tracks start Off; forced/default suffixes do not automatically enable them. Both streamed and whole-file players support these tracks.

Sidecars are read through the authenticated file APIs, up to 16 files, 2 MiB each, and 8 MiB total. Reads use bounded ranges with a pinned version; malformed/unreadable files are skipped. Text is decoded as UTF-8. SRT is converted to WebVTT; ASS/SSA supports dialogue text and line breaks with styling/positioning flattened, excluding drawing cues. Cue markup still passes through the restricted subtitle renderer. Track object URLs are revoked on close/refresh. No subtitle HTTP file endpoint is added. When using an older streaming server, the player must advertise `sidecar-subtitles-v1` over its private MessagePort; absent support produces an explicit notice while video playback continues.

## Shared viewer settings

Settings includes Images, Video, Audio, Editor and 3D viewer submenus. Defaults are embedded by the generator and saved with workspace preferences; changes apply to open viewers. Video playback and subtitle styling travel to the streaming player over its private channel, including live changes and configured shortcuts. Player changes update the workspace settings. Older media players ignore optional initial preferences and retain their own baseline controls. File/image/video/editor shortcuts can be changed in Navbar → Keyboard shortcuts.
