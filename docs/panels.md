# Panel workbench

Eya renders the terminal, Files browser, text editors, media previews, and fallback viewers through one workbench. Workspace definitions are stored on the server. A panel is a DOM element plus lifecycle callbacks; a panel group supplies the shared tab strip, and groups form a recursive horizontal/vertical split tree.

Terminal panels use xterm's WebGL renderer when available and fall back to its DOM renderer if WebGL initialization fails or the graphics context is lost.

## User interaction

- Select a tab to activate its panel. Clicking or focusing a panel group makes it the active group for shared controls. In Settings, **Panel focus** also moves keyboard focus into the active panel when the mouse enters its group. Open menus and dialogs keep focus until dismissed. **Highlight focused panel border** draws an outer outline without covering panel contents. These preferences are saved per workspace. File previews open as workbench tabs, never inside the Files browser DOM.
- Drag a tab anywhere inside a group to move or reorder it there, including at its edges. The panel under the pointer receives it. The dragged tab's horizontal center snaps to the nearest gap between tabs, preserving where it was grabbed; vertical distance from the strip does not affect insertion. A vertical line previews the exact drop position. The dragged tab is translucent so the line stays visible. Use the split controls to create another group.
- Choose **Move to next group** in **Panel layout** to move the active tab without dragging, including on touch screens.
- Use **Split right** or **Split down** beside the tabs. If the current group has multiple tabs, its active tab moves into the new group; otherwise the empty group remains available for a new panel or a dragged tab.
- Use **+** beside the tabs to open **New panel**. The launcher has two independently scrollable, searchable lists: panel types and minimized tabs. Panel-type search matches IDs, titles, descriptions, categories, and keywords. Minimized-tab search matches the title, type and saved path. Each terminal opens a separate shell and keeps its own resumable connection. Closing a terminal ends its session; during an outage the page retains its end request until reconnect, while detached sessions also have a server expiry.
- Drag a sash between groups to resize both sides. Double-click a sash to restore equal sizing.
- Use **Panel layout → Minimize panel** to hide the active tab while keeping its DOM, dirty buffers, terminal or Browser session alive. Minimization is available only in this menu for every panel type. Reopen it from **New panel → Minimized tabs**, into that launcher's group. Minimized tabs disappear from tab strips and the mobile switcher.
- Use the tab's **×** to close a closeable panel and release its resources. Empty groups collapse automatically; a deliberately created empty group can also be closed from its group header.

On narrow or touch layouts, only the most recently activated group is shown. The panel selector above the workspace reaches every open panel across all groups. Its tab strip also provides access to panels within that group. Swipe a tab strip horizontally to scroll it. Hold a tab for about half a second before moving it to drag; a translucent floating copy follows the finger and a vertical marker shows its insertion position. Moving before the hold finishes remains a normal scroll. Desktop and mobile tab drops always insert into the hovered group; use explicit split controls to create a group. The terminal key bar appears only while the terminal panel is active. Desktop sashes also accept arrow keys when focused.

**Settings → Appearance → Floating panel switcher on mobile** optionally replaces the top panel selector with a movable button. It becomes very translucent while idle. Tap it to open a map of the workspace's actual split proportions and choose a group; the list beneath the map also reaches very small groups. Drag the button to reposition it, or use arrow keys while focused. Its position is saved with workspace preferences and remains inside the visual viewport when the keyboard or browser controls resize it. Enter opens the map; Escape closes it and returns focus.

## Reusable docking library

`client/docking.js` and `docking.css` provide three independent exports:

- `EdgeDockController(root, { getItem, resolveTarget, onDrop })` resolves targets from the pointer position and supplies shared drag feedback. `startNativeDrag(handle, event)` records the grab offset and creates a translucent native drag image; `bindTouch(handle, start, end, { longPress?, ghost? })` uses the same center/gap calculation for touch. Both paths position the insertion marker at any vertical pointer position within the target group and use the same calculation on drop. Workbench and embedded tabs use a 450 ms stationary hold with a floating ghost and native horizontal scrolling before activation. Moving more than 8 pixels before the hold finishes cancels drag initiation. Strip edges scroll to reach off-screen tabs during held dragging, even when the pointer is below the strip. `resolveTarget(event)` supplies `{ element, edges?, canSplit? }` plus caller-owned data; `onDrop(item, target, edge, event)` receives the selected insertion as `target.insertion.beforeId` (null appends). Workbench and sidebar tabs pass `canSplit:false`; the primitive retains optional edge detection/filled previews for other integrations.
- `TabDock(root, { tabs, layout?, axis?, onChange? })` owns a recursive tab/split tree. Tabs are `{ id, title, element }`; axis is `vertical` (stacked areas), `horizontal` (side by side), or `both`. Its `activate`, `move`, `split`, `setAxis`, `snapshot`, and `destroy` methods support embedded inspectors. Snapshots contain tab IDs, active tabs, split axes and ratios, with no content objects. Restoration ignores missing/duplicate tab IDs, bounds nesting and ratios, and adds new tabs to the first group.
- `DockSidebar(root, { content, tabs, side?, size?, collapsed?, layout?, onChange? })` wraps a main content area with a sidebar and resize separator. Left/right sidebars stack splits vertically; top/bottom sidebars split horizontally. `setSide`, `setSize`, `setCollapsed`, `snapshot`, and `destroy` are public. The sidebar occupies at most 60% of its dimension and leaves at least 80 pixels for the main content. Its snapshot is `{ side, size, collapsed, layout }`; pass that object back to restore it. Separators accept pointer dragging, arrow keys, and double-click resets. On coarse pointers their resize targets expand to 20 pixels around a thin visible divider; sidebar and workspace tabs support long-press touch dragging. The Divide sidebar button creates a split; tab drops merge or reorder within the hovered group.

Destroy embedded docks with their owning panel to release global drag listeners and previews. The caller retains ownership of content and resources. `tests/docking.cjs` verifies restoration, explicit split/merge, keyboard resize, and full-panel tab moves. `tests/tab-movement.cjs` checks nearest-gap snapping, grab offsets, pointer-owned destinations, vertical independence, translucent mouse/touch feedback, and drop/cancel cleanup. `tests/mobile-workspace.cjs` uses real touch events to verify strip scrolling, held dragging, feedback/cancellation, split-map navigation, keyboard controls, idle opacity, and visual viewport bounds. `createMobileWorkspaceNavigator({ workbench, onPositionChange })` exposes `update({ enabled, position })`, `snapshot`, and `destroy`; saved positions are normalized `{ x, y }` coordinates from zero to one. Programmatic updates do not emit position changes.

## Public API

The bundled client exposes `globalThis.EyaPanels`. This is intended for bundled future viewers and trusted extensions; a generated client still grants terminal-level authority and is not a sandbox for untrusted scripts.

### Register and open a panel

```js
const element = document.createElement('section');
element.textContent = 'Example panel';

EyaPanels.register({
  id: 'example',
  minWidth: 240, minHeight: 160,
  title: 'Example',
  kind: 'example',
  element,
  closeable: true,
  retain: false,
  beforeClose: () => confirm('Close this panel?'),
  onActivate: () => {},
  onDeactivate: () => {},
  onLayout: () => {},
  onClose: () => {},
  api: { getSelection: () => 'example selection' },
});

EyaPanels.open('example');
```

`id` must be unique and `element` must be a DOM `Element`. Minimization calls `onDeactivate` and hides the mounted view without calling `beforeClose` or `onClose`; dirty views are preserved. Reopening activates the same view. Workspace switching/clearing still closes minimized views with the same detach/cleanup policy as visible tabs. `retain: true` keeps a closed panel registered for later reopening; otherwise closing unregisters it. Returning `false` from `beforeClose` cancels a user close. `onLayout` should remeasure canvas, terminal, editor, or other size-sensitive content.

### Register a panel type

Panel types populate the **Panel types** list in the **New panel** starting panel. A type is a factory, so opening it repeatedly creates independent instances. File viewers remain providers selected by file format.

**Browser** opens server Chromium. **Proxy browser** renders relayed pages on the client and includes **Local HTML** for script-disabled server files. The two panel types have separate lifecycles; opening the proxy does not start Chromium. See [browser.md](browser.md) for their behavior and security boundaries.

```js
EyaPanels.registerType({
  id: 'notes',
  title: 'Notes',
  icon: 'FileCode',
  category: 'Writing',
  description: 'Keep a temporary project scratchpad.',
  keywords: ['memo', 'text', 'scratchpad'],
  order: 20,
  create({ id, groupId, workbench }) {
    const element = document.createElement('textarea');
    element.setAttribute('aria-label', 'Notes');
    return { id, title: 'Notes', element, api: { getText: () => element.value } };
  },
});

await EyaPanels.create('notes');
EyaPanels.openStart();
console.log(EyaPanels.listTypes()); // [{ id, title, icon, category, description, keywords, order }, ...]
```

Only `id` and `create` are required. Panel types may declare `minWidth` and `minHeight`; the workbench defaults to 240 × 160 CSS pixels, enforces nested split constraints, and collapses to one group when the viewport cannot fit them. Omitted launcher metadata receives safe generic defaults, so existing and third-party types remain compatible. `category` controls grouping, `description` and `keywords` improve discovery, `order` controls stable placement, and `hidden: true` keeps a programmatically creatable type out of the launcher. Factories may be asynchronous and receive a unique proposed `id`, the destination `groupId`, the workbench, and any extra options passed to `create`. Return a panel definition or the ID of a panel already registered with the workbench. Failures stay in the starting panel so a failed connection or provider does not remove the user's launch point. Newly registered types also appear in starting panels already open without losing the current search.

Additional terminals expose `focus`, `sendInput`, `paste`, `clear`, `reconnect`, `restart`, `end`, `updateOptions`, `zoomFont`, and `getState`. `zoomFont(delta)` adjusts terminal font size within 8–36 pixels and refits the terminal. The terminal factory accepts `openLink(url)` for validated HTTP(S) link navigation and `onFontSize(size)` to synchronize font preferences; `getState().fontSize` reports the rendered setting. `viewText()` opens the copyable text modal; `getText('all')` returns the active screen and scrollback, while `getText('screen')` returns the visible viewport. The server owns their stable session IDs; unacknowledged input belongs to the running terminal instance; a network outage reconnects to that shell. Focusing a retained terminal automatically takes over its attachment without recreating its shell. The shared mobile key bar is routed to the active terminal. After an explicit end or expiry, **Start new terminal session** creates a fresh session only when selected. Closing a terminal explicitly ends its shell; when disconnected, the current page retains that end request until reconnect. Closing/reloading a page leaves detached sessions discoverable until their server retention expires.

Connect opens an independent workspace connection and then creates the configured initial panel (Terminal by default). Reconnect preserves the existing workbench rather than creating another initial panel. All terminal panels are equal: explicit tab close ends that session, workspace switching detaches it, and files/machine/workspace services continue with zero terminal tabs. Retained tabs, layouts, session discovery, revision conflicts and pane minimums are described in [workspaces.md](workspaces.md).

### Arrange panels

```js
const terminalId = await EyaPanels.create('terminal');
const filesId = await EyaPanels.create('files');
const group = EyaPanels.groupOf(terminalId);
EyaPanels.open('example', { groupId: group }); // tab beside Terminal
EyaPanels.split('example', 'vertical', terminalId); // place to the right
EyaPanels.split('example', 'horizontal', terminalId); // place below
EyaPanels.move('example', EyaPanels.groupOf(filesId));
EyaPanels.activate('example');
EyaPanels.minimize('example'); // keep it alive, hide its tab
EyaPanels.open('example'); // reopen the same instance
EyaPanels.update('example', { title: 'Renamed', dirty: true });
EyaPanels.close('example');
```

Panels may expose their own callable methods through the `api` field. Call them with `EyaPanels.call('example', 'getSelection')`. The terminal exposes `focus`, `sendInput`, and `clear`; Files exposes `navigate`, `refresh`, and `getPath`; file panels expose `save`, `download`, `refresh`, and `focus`. Saving a non-text panel or refreshing a dirty editor returns `false`.

Saved workspace descriptors retain a `minimized` boolean. Minimized descriptors stay in the tab manifest but are absent from the split tree; reopening adds them to the current group. Their session identities remain assigned to the same workspace. `layout()` returns visible groups as `{ id, panels, active }` records. It is useful for UI integration and tests, but callers should use the API operations instead of editing workbench DOM directly.

### Register a file viewer

Viewer providers are ordered before the generic fallback:

```js
EyaPanels.registerViewer({
  name: 'example-viewer',
  supports: tab => tab.path.endsWith('.example'),
  render(tab) {
    const element = document.createElement('div');
    element.textContent = `${tab.name}: ${tab.bytes.length} bytes`;
    return element;
  },
});
```

`supports(tab)` selects the provider. `render(tab)` returns the panel element and may populate `tab.view` or `tab.url`; follow the built-in viewers' cleanup pattern for long-lived resources. Viewer controls should remain inside the returned panel, while tabbing, splitting, resizing, activation, and closing remain workbench responsibilities.

`EyaPanels.openFile(path, viewerName)` optionally selects a file viewer (`markdown`, `text`, `binary`, `html`, `image`, `video`, `audio`, or `cad`). Omitting the second argument uses the configured extension default, format matching and content detection. Switching an existing dirty file asks before discarding edits; an active save/rename must finish first. Legacy `generic` file recipes remain restorable.
