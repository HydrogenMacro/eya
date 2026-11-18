# Compact interface

The workbench keeps common actions visible and groups secondary controls into labeled menus. Icons are bundled Lucide SVGs, with tooltips and accessible names; there are no external icon/font requests.

## Workspace

The header contains connection status, the workspace dropdown, **Connect/Session**, and the application menu. The workspace dropdown switches directly between workspaces; **Manage workspaces** opens independently searchable workspace and open-tab lists. Manager actions use icons with accessible names. Opening a workspace closes the dialog. Drag a tab onto another workspace to move it, or use the move handle with touch or keyboard. Settings can also be opened with `Ctrl+,` or `Cmd+,`.

The Files browser keeps Back, the editable directory path, Go, Upload, and search visible. Its **File browser menu** contains New folder, Refresh, Parent directory, Forward, and Close files. The `..` row is another way to navigate upward. Each file has its own action menu. Automatic refresh pauses while that menu is open so actions do not disappear under the pointer.

## Panels and editors

Tabs show a content-type icon, name, unsaved marker, and close button. Minimize hides the tab while keeping its view and runtime alive; close disposes it. **+**, **Split right**, and **Split down** remain visible beside the tab strip. **Panel layout** contains Minimize panel, Move to next group, and Close empty group. Tabs remain draggable and split sashes remain resizable.

The **+** button opens the **New panel** launcher with two independently scrollable, searchable lists: panel types and minimized tabs. Panel types group Terminal, File browser, Task Manager, Docker, and future registered types by category and filter across names, descriptions, categories, and keywords. Reopening a minimized tab restores the same instance in the launcher’s group. Terminal and File browser create independent instances; factories and their discovery metadata register through `EyaPanels.registerType`. See [panels.md](panels.md) and [system-panels.md](system-panels.md).

Settings opens an icon-based category menu with global search. Appearance, Terminal, Files, Editor, Browser, Images, Video, Audio, 3D viewer, Task Manager and Docker use the same declarative registry as the generator. Add fields to `client/settings-schema.js` to expose them in both UIs. Settings apply to existing panels and defaults for new ones; panel-local options feed the same saved workspace preferences. Open panels also provide direct access to their own options. The generator additionally configures credentials, starting panel, embedded font and output format. No browser storage is required.

The Connect dialog accepts HTTP(S) server addresses and WS(S) endpoints, has a password visibility toggle, and checks credentials after a 650 ms pause. A spinner covers the debounce and authentication. Invalid addresses, network failures and rejected passwords remain in the dialog. A successful check connects and closes the dialog after the workspace transport is ready. Credential edits or dismissal abort pending checks. Switching an existing connection remains explicit and retains its existing confirmation. The startup command lives in Terminal settings and runs only for a new terminal session. The connected header displays measured ping instead of a separate “Connected” label.

Client updates has its own dialog in the navbar menu. The existing update indicator remains a shortcut for downloading an available release.

Editor toolbars keep the current directory and Save visible. The **File actions** menu contains Download and Copy path. Save and copy operations provide brief status messages without interrupting typing. Unsaved edits remain marked if a save fails or if more edits arrive during a save.

## CAD

The model toolbar keeps Fit, Display, and CAD options visible. Compact Sections, Parts, and Selection tabs use the docking sidebar, with a thin middle-right collapse handle. Section numbers sit on the slider ends; the camera-perpendicular section is always active at a positive distance. Selection permanently toggles up to two items, with Overview/Selection 1/Selection 2 radio subtabs, scrollable tables, dark-orange second highlights, and zoom/deselect actions. A small viewport message explains the selection limit. Decimal places applies to readouts; geometry retains full precision. Grid lines, translucent fill, axes, and infinite planes can be configured independently. Movement is always available; wheel/W/S visibly zoom, Space pans with pointer lock, and keyboard shortcuts include mouse modifiers. Turntable/free orbit and target/origin/model-center pivots share the rotation gizmo. See [cad.md](cad.md) for behavior and mesh-measurement limits.

Parts and selection results remain in their sidebar tabs. Escape clears selections; when the canvas is focused, `F` fits the model.

## Keyboard and touch

**Keyboard shortcuts** in the application menu groups Global, Files, Editor, Terminal, Browser, 3D viewer, Images, Video, Task Manager, and Docker actions. Search matches action names, categories, and assigned shortcuts across all groups. Select a shortcut and press its replacement; Clear disables it and Reset restores its defaults. Conflicts within a panel, or with a global action, are rejected. Different panel types may share a shortcut. Standard control navigation, menu dismissal, text editing, and keys sent to terminal applications remain native.

Overrides are included in generated client configuration and saved workspace preferences. Missing action IDs retain defaults. Unknown IDs are retained within the same bounded configuration, so an older client does not erase a newer panel's shortcuts. Each action accepts at most four strokes, with up to 128 action overrides. Panel handlers and the shortcuts editor share the same registry; streamed video receives its shortcuts over the private player channel.

Menus open with click/tap or Arrow Down from their trigger. Action menus support arrow-key navigation and Home/End. Escape closes a menu and restores focus to its trigger. Opening Settings dismisses other menus. Popovers use the browser's top layer so they are not clipped by split panels, and their position is constrained to the visible viewport.

`Ctrl/Cmd+,` opens Settings; `Ctrl/Cmd+Shift+P` opens New panel; `Ctrl/Cmd+Shift+Backquote` creates a terminal; `Ctrl/Cmd+Shift+E` opens Files. In browsers, `Ctrl/Cmd+L` focuses the path and `Ctrl/Cmd+F` focuses search. Rows support arrows, Home/End, Enter, F2, and Delete/Backspace. Delete bindings never intercept typing in a text input or CodeMirror.

On touch screens, action menu rows are larger and form fields retain a 16 px font. The mobile panel selector continues to reach every group. Hover is not required to find file actions, and the terminal's swipe-and-hold arrow key remains available while the terminal is active.

The workspace, client generator, and video player suppress mobile page pinch zoom and use at least 16 px for editable controls on touch or narrow screens to avoid focus zoom. Browser accessibility settings may override page zoom restrictions. Content displayed in an embedded third-party page is controlled by that page and its browser sandbox.

### Mobile keyboards and input placement

`client/mobile-viewport.js` owns workspace keyboard geometry. The keyboard can shrink the visual viewport and pan it independently of the layout viewport. The fixed workspace follows both `visualViewport.height` and `visualViewport.offsetTop` through `--eya-viewport-height` and `--eya-viewport-top`. This applies to every panel, including CodeMirror, and to dialogs. Keyboard dismissal restores the full visible area even if an editor remains focused. Browser/accessibility zoom retains native panning.

When adding or changing controls:

- Keep the document fixed and unscrolled. Confine content scrolling to a bounded panel or dialog with `min-height:0` and `overflow:auto`; let flex children shrink when the keyboard opens.
- Reuse the shared viewport variables for workspace and dialog height/position. `100vh`, `100dvh`, and `innerHeight` alone do not account for every mobile keyboard. Do not add panel-specific keyboard offsets, transforms, focus exceptions, or duplicate viewport listeners.
- Reveal a focused field by scrolling its nearest bounded ancestors only. Avoid document-level `scrollIntoView()` or centering the entire page. Use `focus({preventScroll:true})` for programmatic focus when the component controls placement. CodeMirror and terminals own caret scrolling; do not scroll their full content elements into view.
- Keep editable controls at least 16 px on mobile to avoid focus zoom. Retain native typing, selection, and nested touch scrolling.
- Run `NODE_PATH=client/node_modules node tests/mobile-keyboard.cjs` after rebuilding client/server. Cover a bottom input, independent viewport resize and delayed pan, focus changes with the keyboard open, CodeMirror, a scrollable dialog, dismissal, and rotation in HTML and SVG. Headless keyboard events are simulated; validate physical Android/iOS keyboard behavior when devices are available.

The regression suite checks that the header stays at the visible top, the workspace fills the visible height, focused fields remain above the keyboard, and the document stays at its origin. Add cases here when introducing another input surface instead of fixing the same issue separately in each panel.

The mobile auxiliary bar uses one full-width row of ten keys: Escape, Tab, Ctrl, page navigation, Shift/Alt, keyboard activation, Fn, Paste, arrows, and a three-dot number/symbol menu. Tap Ctrl or swipe left for Shift and right for Alt to arm one combination. Double tap Ctrl or swipe again on an armed Shift or Alt to lock it. Tap Ctrl or repeat the corresponding swipe to unlock. The keyboard button opens the device keyboard. Active symbols are highlighted, with bold strokes for locked modifiers and no gradients. Swipe Pg up/down for Page Up/Down or left/right for Home/End; hold to repeat, as with arrows. Fn opens six paired keys (F1/F2 through F11/F12), three blank spaces, and Back. Swipe left for odd function keys or right for even keys; selected symbols are highlighted. One-shot Fn returns after one function key; double tap the Fn position to lock the overlay, with bold labels. Back exits it. Paste uses the native clipboard API with a native-menu fallback and no prompt. The menu opens a persistent row of 1–9 and 0. Swipe up for `! @ # $ % ^ & * ( )`, or down for slash, period, hyphen, underscore, equals, plus, brackets, and backslash on the first nine keys; swipe down on 0 to return. Grey alternate legends preview the swipe choices; the selected symbol grows and moves to the center with drag distance as the other legends fade. Reduced-motion settings keep previews centered. Keys are 46 px tall and use shading only while pressed, without hover colors. The bar targets the active terminal or Browser panel; changing panels clears modifiers and stops repeats.

UI chrome uses touch manipulation to avoid double-tap zoom and accidental text highlighting. Editors, input fields, logs, inspector values, and error text remain selectable; native pinch zoom remains available. Direction-aware scroll locking permits gestures only when a scrollable ancestor can consume them; it stops at contained panel boundaries to prevent page scroll/pull-to-refresh. Nested performance dashboards and inspectors remain scrollable. Task graphs keep their rendered dimensions aligned with their SVG coordinates instead of stretching under mobile CSS constraints.

Menus use manually dismissed top-layer popovers. Outside taps and Escape are handled by the shared component rather than racing the browser's native light-dismiss action against a trigger click. Dropdowns nested inside options preserve their parent menu. `tests/mobile-edge-cases.cjs` exercises real compositor touch swipes, repeated/nested menu taps, graph dimensions, rotation and 320 px bounds in both hosted HTML and SVG clients; these are Chromium touch-emulation checks, not a substitute for physical Safari/device testing.

Dropdowns use a shared custom combobox/listbox component with keyboard navigation, type-to-find, disabled options, Escape dismissal, and touch-sized options. Native select elements retain form values and `input`/`change` events for integrations, but do not render native browser dropdown chrome. This also applies to dynamically registered panels. Dropdowns inside option popovers preserve their parent surface.

Upload buttons open a hidden native file picker. The shared `attachFileDropzone` helper adds a custom drag target and forwards dropped files through the same upload handler. The browser's picker remains responsible for granting access to local files.

`client/ui.js` exposes `enhanceSelect(select)`, `startControlEnhancement(root)`, and `attachFileDropzone(element, { onFiles, input, button })`. Enhancement returns a cleanup function; individual controls also expose `sync()` and `destroy()` for components with explicit lifecycles. CSS is in `client/components.css` and inherits workspace theme variables.

The global menu groups Settings, Server configuration, and Client updates under General. Server configuration opens authenticated process-local admission limits; existing sessions remain running when limits decrease. File entry menus use an adjacent Open With… submenu when multiple viewers are available, and Files settings expose searchable extension defaults.

`client/radio-tabs.js` supplies connected native radio controls through `createRadioTabs({label, options, value, onChange, compact})`. Options accept `value`, `label`, `icon`, and `title`; the returned control exposes `element`, `setValue`, `setDisabled`, and its selected `value`. Arrow keys use native radio navigation, programmatic updates do not emit changes, and icon-only choices retain accessible names. The binary toolbar and embedded edit controls share this component.

Mobile tab strips scroll horizontally with a swipe. A stationary press-and-hold starts dragging, with a floating tab and vertical insertion marker. Appearance settings can replace the top panel selector with a draggable floating button and a workspace split map; its position is saved with the workspace.
