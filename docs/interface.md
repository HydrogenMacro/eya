# Compact interface

The workbench keeps common actions visible and groups secondary controls into labeled menus. Icons are bundled Lucide SVGs, with tooltips and accessible names; there are no external icon/font requests.

## Workspace

The header contains connection status, **Files**, **Connect/Session**, and a **Workspace menu**. Open that menu for Settings or Disconnect. **Session** opens the connection dialog, including the explicit End session action. Settings can also be opened with `Ctrl+,` or `Cmd+,`.

The Files browser keeps Back, the editable directory path, Go, Upload, and search visible. Its **File browser menu** contains New folder, Refresh, Parent directory, Forward, and Close files. The `..` row is another way to navigate upward. Each file has its own action menu. Automatic refresh pauses while that menu is open so actions do not disappear under the pointer.

## Panels and editors

Tabs show a content-type icon, name, unsaved marker, and close button. **+**, **Split right**, and **Split down** remain visible beside the tab strip. **Panel layout** contains Move to next group and Close empty group. Tabs remain draggable and split sashes remain resizable.

The **+** button opens the searchable **New panel** app launcher, which groups Terminal, File browser, Task Manager, Docker, and future registered types by category. The catalog scrolls independently in small panels and filters across names, descriptions, categories, and keywords. Terminal and File browser create independent instances; factories and their discovery metadata register through `EyaPanels.registerType`. See [panels.md](panels.md) and [system-panels.md](system-panels.md).

Settings groups Appearance, Terminal, Editor, and Files. The client generator offers seven Nerd Font families and embeds the selected font in the generated client, defaulting to 0xProto. Settings persist locally and apply to existing terminal panels. Four themes, accents, density, UI style, and reduced motion apply to the workspace, editors, terminals, and custom controls. Adaptive local echo and initial file-panel placement/size settings have been removed.

Editor toolbars keep the current directory and Save visible. The **File actions** menu contains Download and Copy path. Save and copy operations provide brief status messages without interrupting typing. Unsaved edits remain marked if a save fails or if more edits arrive during a save.

## CAD

The model toolbar keeps view, display mode, section plane, Fit, Measure, and CAD options visible. **Measure** contains distance/angle mode, vertex snapping, and Clear. **CAD options** groups grid, units, section position, live reload, reload interval, manual reload, part visibility reset, and file actions. A small dot on the options icon indicates that live reload is enabled. Successful reloads update the model without adding persistent status messages; errors remain visible.

The Parts disclosure remains available on the canvas. Measurement results appear only while measuring. Escape cancels the active measurement tool; when the canvas is focused, `F` fits the model.

## Keyboard and touch

Menus open with click/tap or Arrow Down from their trigger. Action menus support arrow-key navigation and Home/End. Escape closes a menu and restores focus to its trigger. Opening Settings dismisses other menus. Popovers use the browser's top layer so they are not clipped by split panels, and their position is constrained to the visible viewport.

`Ctrl/Cmd+,` opens Settings; `Ctrl/Cmd+Shift+P` opens New panel; `Ctrl/Cmd+Shift+Backquote` creates a terminal; `Ctrl/Cmd+Shift+E` opens Files. In browsers, `Ctrl/Cmd+L` focuses the path and `Ctrl/Cmd+F` focuses search. Rows support arrows, Home/End, Enter, F2, and Delete/Backspace. Delete bindings never intercept typing in a text input or CodeMirror.

On touch screens, action menu rows are larger and form fields retain a 16 px font. The mobile panel selector continues to reach every group. Hover is not required to find file actions, and the terminal's swipe-and-hold arrow key remains available while the terminal is active.

The terminal key bar has two rows of labeled SVG keys: Escape, Tab, sticky Ctrl, Home/End, Page Up/Down, Copy/Paste, Ctrl+C, Ctrl+D, Backspace, the swipe-and-hold arrows, and Enter. Actions target the active terminal instance. Sticky Ctrl also modifies navigation keys and Backspace (word erase). The bar does not steal keyboard focus during a tap.

UI chrome uses touch manipulation to avoid double-tap zoom and accidental text highlighting. Editors, input fields, logs, inspector values, and error text remain selectable; native pinch zoom remains available. Direction-aware scroll locking permits gestures only when a scrollable ancestor can consume them; it stops at contained panel boundaries to prevent page scroll/pull-to-refresh. Nested performance dashboards and inspectors remain scrollable. Task graphs keep their rendered dimensions aligned with their SVG coordinates instead of stretching under mobile CSS constraints.

Menus use manually dismissed top-layer popovers. Outside taps and Escape are handled by the shared component rather than racing the browser's native light-dismiss action against a trigger click. Dropdowns nested inside options preserve their parent menu. `tests/mobile-edge-cases.cjs` exercises real compositor touch swipes, repeated/nested menu taps, graph dimensions, rotation and 320 px bounds in both hosted HTML and SVG clients; these are Chromium touch-emulation checks, not a substitute for physical Safari/device testing.

Dropdowns use a shared custom combobox/listbox component with keyboard navigation, type-to-find, disabled options, Escape dismissal, and touch-sized options. Native select elements retain form values and `input`/`change` events for integrations, but do not render native browser dropdown chrome. This also applies to dynamically registered panels. Dropdowns inside option popovers preserve their parent surface.

Upload buttons open a hidden native file picker. The shared `attachFileDropzone` helper adds a custom drag target and forwards dropped files through the same upload handler. The browser's picker remains responsible for granting access to local files.

`client/ui.js` exposes `enhanceSelect(select)`, `startControlEnhancement(root)`, and `attachFileDropzone(element, { onFiles, input, button })`. Enhancement returns a cleanup function; individual controls also expose `sync()` and `destroy()` for components with explicit lifecycles. CSS is in `client/components.css` and inherits workspace theme variables.
