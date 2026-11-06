# Panel workbench

Eya renders the terminal, Files browser, text editors, media previews, and fallback viewers through one workbench. A panel is a DOM element plus lifecycle callbacks; a panel group supplies the shared tab strip, and groups form a recursive horizontal/vertical split tree.

## User interaction

- Select a tab to activate its panel. File previews open as workbench tabs, never inside the Files browser DOM.
- Drag a tab onto another group's tab strip or content area to move it into that group.
- Choose **Move to next group** in **Panel layout** to move the active tab without dragging, including on touch screens.
- Use **Split right** or **Split down** beside the tabs. If the current group has multiple tabs, its active tab moves into the new group; otherwise the empty group remains available for a new panel or a dragged tab.
- Use **+** beside the tabs to open **New panel**. The launcher is an independently scrollable, searchable catalog grouped from each registered type's metadata; search matches IDs, titles, descriptions, categories, and keywords. Each terminal opens a separate shell and keeps its own resumable connection. Closing a connected terminal ends its session; an offline session expires on the server.
- Drag a sash between groups to resize both sides. Double-click a sash to restore equal sizing.
- Use the tab's **×** to close a closeable panel. Empty groups collapse automatically; a deliberately created empty group can also be closed from its group header.

On narrow or touch layouts, only the most recently activated group is shown. The panel selector above the workspace reaches every open panel across all groups. Its tab strip also provides access to panels within that group. The terminal key bar appears only while the terminal panel is active. Desktop sashes also accept arrow keys when focused.

## Public API

The bundled client exposes `globalThis.EyaPanels`. This is intended for bundled future viewers and trusted extensions; a generated client still grants terminal-level authority and is not a sandbox for untrusted scripts.

### Register and open a panel

```js
const element = document.createElement('section');
element.textContent = 'Example panel';

EyaPanels.register({
  id: 'example',
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

`id` must be unique and `element` must be a DOM `Element`. `retain: true` keeps a closed panel registered for later reopening; otherwise closing unregisters it. Returning `false` from `beforeClose` cancels a user close. `onLayout` should remeasure canvas, terminal, editor, or other size-sensitive content.

### Register a panel type

Panel types populate the **New panel** starting panel. A type is a factory, so opening it repeatedly creates independent instances. File viewers remain providers selected by file format.

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

await EyaPanels.create('notes', { groupId: EyaPanels.groupOf('terminal') });
EyaPanels.openStart();
console.log(EyaPanels.listTypes()); // [{ id, title, icon, category, description, keywords, order }, ...]
```

Only `id` and `create` are required. Omitted launcher metadata receives safe generic defaults, so existing and third-party types remain compatible. `category` controls grouping, `description` and `keywords` improve discovery, `order` controls stable placement, and `hidden: true` keeps a programmatically creatable type out of the launcher. Factories may be asynchronous and receive a unique proposed `id`, the destination `groupId`, the workbench, and any extra options passed to `create`. Return a panel definition or the ID of a panel already registered with the workbench. Failures stay in the starting panel so a failed connection or provider does not remove the user's launch point. Newly registered types also appear in starting panels already open without losing the current search.

Additional terminals expose `focus`, `sendInput`, `paste`, `clear`, `reconnect`, `restart`, `end`, `updateOptions`, and `getState`. Their session token and buffered input belong to that terminal instance; a network outage reconnects to that shell. The main terminal's mobile key bar is routed to the active terminal. After an explicit end or expiry, **Start new terminal session** creates a fresh session only when selected. Closing a connected terminal explicitly ends its shell; closing an offline terminal or reloading the page leaves detached sessions to expire according to the server retention setting.

The primary connection terminal is retained when its tab closes so file and machine panels can keep using that connection. Choose Terminal again to restore it; **Session → End session** ends that primary shell explicitly.

### Arrange panels

```js
const group = EyaPanels.groupOf('terminal');
EyaPanels.open('example', { groupId: group }); // tab beside Terminal
EyaPanels.split('example', 'vertical', 'terminal'); // place to the right
EyaPanels.split('example', 'horizontal', 'terminal'); // place below
EyaPanels.move('example', EyaPanels.groupOf('browser'));
EyaPanels.activate('example');
EyaPanels.update('example', { title: 'Renamed', dirty: true });
EyaPanels.close('example');
```

Panels may expose their own callable methods through the `api` field. Call them with `EyaPanels.call('example', 'getSelection')`. The terminal exposes `focus`, `sendInput`, and `clear`; Files exposes `navigate`, `refresh`, and `getPath`; file panels expose `save`, `download`, `refresh`, and `focus`. Saving a non-text panel or refreshing a dirty editor returns `false`.

`layout()` returns groups as `{ id, panels, active }` records. It is useful for UI integration and tests, but callers should use the API operations instead of editing workbench DOM directly.

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
