# CAD as code with build123d

Eya opens binary or ASCII STL, 3MF (`.3mf`), binary glTF (`.glb`), and `.gltf` files with embedded or relative sidecar resources in independent CAD panels. Use GLB for build123d when you want one file: it retains assembly names, colors, and transforms and reloads over the independent encrypted workspace connection. Rendering libraries are bundled into the standalone client; no CDN or additional viewer service is required.

## Why a file viewer instead of ocp_vscode?

`ocp_vscode` can be integrated, but it is not an embeddable file parser. Its architecture relays Python `show()` messages through an extension/WebSocket host to a JavaScript viewer; exact measurements additionally use a Python backend holding BRep shapes. Integrating its shared `ocp-viewer-core` would require a versioned bridge and backend lifecycle management, plus a new route for their messages through Eya's encrypted protocol. Simply embedding its page would not provide remote access to its localhost service from a standalone client.

For this implementation, watching a published GLB is simpler to operate and supports any modeling tool that exports GLB/STL, including build123d. Metadata-only polling avoids repeatedly transferring unchanged meshes; atomic publication avoids half-written files. The viewer preserves the camera and controls when geometry is replaced. This provides a live preview without requiring VS Code or another exposed server.

This choice trades away exact BRep analysis. Current measurements operate on tessellated meshes: they are suitable for inspection, not an independent verification of manufacturing dimensions. Native STEP/BRep parsing, analytic face/edge measurements, and direct `ocp_vscode.show()` streaming are not implemented. Keep an exact STEP export for downstream CAD/manufacturing when needed.

Primary references:

- [build123d import/export API](https://build123d.readthedocs.io/en/latest/import_export.html)
- [OCP viewer integration and measurement backend](https://bernhard-42.github.io/ocp_viewer_docs/viewers/ocp_vscode/concepts/)
- [Three.js STL loader](https://threejs.org/docs/pages/STLLoader.html) and [glTF loader](https://threejs.org/docs/pages/GLTFLoader.html)

## Quick start

Create a Python environment on the host where Eya's terminal runs, then install build123d:

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install build123d
python examples/watch_cad.py examples/cad_model.py
```

The example constructs a mounting plate and publishes `examples/cad_model.glb`. In Eya, open that GLB through Files. Open `examples/cad_model.py` in an editor panel and arrange the editor, terminal, and CAD preview using the panel split controls. Save an edit to the Python file: the watcher reruns it after changes settle, and the viewer reloads the resulting GLB. Python source uses CodeMirror's Python syntax mode.

`watch_cad.py` runs the script initially and again after the script or listed dependencies change. Use the same Python interpreter/environment that has build123d installed:

```sh
python examples/watch_cad.py design.py dimensions.py helpers.py
```

Ctrl+C stops it. A failed build prints its error and leaves the previous successful export available. The helper is optional; you can run your own build commands or watcher in the terminal.

## Publish complete exports

For your own model, write a temporary GLB in the same directory and atomically replace the destination:

```python
from pathlib import Path
import os
from build123d import Box, export_gltf, export_step

part = Box(40, 30, 8)
part.label = "Plate"
target = Path("preview.glb")
temporary = target.with_name("preview.tmp.glb")
if not export_gltf(part, str(temporary), binary=True):
    raise RuntimeError("GLB export failed")
os.replace(temporary, target)

# Optional: exact geometry for downstream CAD, not the live preview.
export_step(part, "plate.step")
```

`binary=True` produces a convenient single-file GLB. Non-binary glTF also works: keep its sibling `.bin` files and textures alongside it, preserving their relative paths. The viewer reads those dependencies through the authenticated, encrypted file connection, including percent-encoded filenames and relative subdirectories. No extra HTTP file route is needed. Remote URLs, absolute URI paths, query strings, and fragments are rejected; embedded data URIs remain supported. Models requiring external Draco/KTX2/Meshopt decoders are not supported by this build.

STL also works. Use `export_stl(part, "preview.tmp.stl")`, then `os.replace("preview.tmp.stl", "preview.stl")`. STL has no standard unit metadata; choose its source units in the viewer. Default STL units are millimetres. Standard glTF coordinates are metres and Y-up; Eya converts them to millimetres and Z-up. Changing display units changes readouts, not geometry.

## Inspection controls

The toolbar provides Fit, Display, and CAD options. Sections, Parts, and Selection use a compact resizable sidebar. The thin handle at the middle-right edge of the viewport opens or closes it. Its side, tab order, split layout, size, and collapsed state survive model reloads. Drag a tab anywhere in another area to merge or reorder it; its center snaps between tabs and a vertical line previews insertion. Use Divide sidebar to create a split. Separators support dragging, arrow keys, and double-click reset. See [panels.md](panels.md) for the docking API.

- Drag to orbit; right-drag, middle-drag, or two fingers pan; wheel or pinch moves forward/backward and changes magnification. Hold Space to capture the pointer and pan without holding a mouse button; release Space or press Escape to release it. The browser must allow pointer lock. Selecting geometry leaves camera controls available. Fit frames the complete model.
- WASD/QE movement is always available when the canvas is focused. W/S moves forward/backward with visible orthographic magnification; A/D strafes and Q/E moves vertically. Holding a key continues movement independently of keyboard repeat. Releasing it, losing focus, or hiding the page stops movement. Shift speeds movement up and Ctrl slows it down by the configured factor. **Keyboard shortcuts → 3D viewer** rebinds movement, pointer pan, speed modifiers, and mouse gestures, including their modifier keys. Alt-right-drag looks around from the camera position by default.
- **Turntable** keeps Z up and clamps pitch at the poles; **Free orbit** rotates around the camera's own up/right axes and can pass over the poles. **Orbit around** chooses the current view target, world origin, or model center. The six colored ±X/±Y/±Z gizmo dots jump to orthographic views; dragging the gizmo uses the same orbit behavior. Its size is configurable.
- XY, XZ, and YZ reference planes use blue, green, and red respectively. **Grid lines** and **Grid fill** are independent: turn lines off for axes only, or leave fill enabled for translucent planes without lines. **Grid planes → Off** hides these references. **Infinite grids** extends the planes beyond the viewport with a horizon fade; finite grids are the default. Reference planes remain continuous across the orthographic camera's near plane. **Grid tick marks** keeps the saved `axisCoordinates` field; subtle labels stay outside the projected model. Cells and ticks choose 1/2/5 spacing from zoom and the shorter viewport dimension.
- **Decimal places** controls displayed measurements, bounds, section coordinates, and grid ticks (0–10, default 3), strips trailing zeros, and normalizes negative zero. Geometry calculations retain their full precision. Tiny positive camera-section distances use compact scientific notation when ordinary rounding would display zero.
- Display offers Flat, Zebra, and Shaded, opacity, and independent Edges and Points. Edges represent sharp tessellation boundaries, rather than original CAD topology. Existing `edges` and `wireframe` configuration values retain their rendering behavior. Missing or invalid imported normals are repaired.
- Parts lists exported mesh names. Visibility and Show all survive reloads; bounds include hidden meshes.
- Sections has X/Y/Z minimum and maximum coordinates on the ends of each shared slider. Touch dragging chooses the nearer handle; when handles coincide, drag direction chooses the endpoint. Moving an endpoint activates its axis automatically. Reset restores the full axis ranges and a small positive camera-section distance. The perpendicular camera section is always applied, just beyond the camera by default, and follows its direction; its distance and flip remain adjustable. Only model geometry is clipped: grids, ticks, axes, and section gizmos remain intact. Display units apply to coordinates; `viewSectionDistance` stores millimetres. Legacy `viewSectionPosition` is preserved without repurposing it.
- Clicking geometry permanently toggles its selection. At most two items can be selected; a third is rejected with a small message at the bottom-left of the viewport. The second item is dark orange. Modifier keys do not change selection behavior. **Pick** chooses Auto (points, edges, or faces), Face, Part, or Boundary. Escape clears selections.
- Selection's **Overview** radio subtab presents a concise measurement table. **Selection 1** and **Selection 2** show detailed tables with **Zoom to selection** and **Deselect** actions below them. Vectors share one X/Y/Z row; cells scroll horizontally. Measurements include coordinates, lengths, face area/perimeter, part surface area, bounds, and volume for closed manifold meshes. Two entities add closest distance and displacement, with angles for edge/edge, face/face, and edge/face combinations. Geometry guides show closest points and perpendicular feet without floating text.
- Closed planar boundaries are checked for circles and rectangles. Recognized circles report approximate radius, diameter, and center; rectangles report side lengths. Circle fitting requires at least twelve segments and rejects radial errors above 0.5%, nonplanar/open/branching boundaries, and self-crossing rings. All results use tessellated geometry, rather than analytic BRep surfaces.

Viewer preferences also appear in Settings → 3D viewer and the standalone generator. Legacy navigation-mode, selection-behavior, and view-section-enable fields are ignored; movement, two-item toggle selection, and the camera section are always active. Unknown embedded configuration fields survive client updates. A fresh client can restore shared settings from a saved server workspace; camera and selections start fresh.

On touch screens, separators have padded 20-pixel resize targets, held tabs drag with a translucent preview and insertion line, slider thumbs are enlarged, and controls preserve touch targets while reducing whitespace. Numeric inputs retain a 16-pixel minimum font size. The fixed workspace uses shared keyboard geometry for every input surface; see [mobile keyboard guidelines](interface.md#mobile-keyboards-and-input-placement). Narrow sidebars keep a bounded canvas area; top/bottom placement gives the canvas more width.

## 3MF files

3MF archives load locally with their core meshes, component transforms, object names, colors, and the materials/extensions supported by the bundled Three.js 3MF loader. Declared micron, millimetre, centimetre, inch, foot, or metre units convert to the workspace's millimetres. The viewer keeps 3MF's Z-up orientation. Embedded textures stay inside archive-backed blob resources; external relationships never trigger HTTP requests. Slicer-specific metadata, unsupported extensions, and mixed-unit submodels are not interpreted as CAD topology.

Archives are limited to 4096 entries, 64 MiB per expanded entry and 128 MiB total compressed/expanded data. Component cycles, nesting beyond 128 levels, and scenes expanding beyond 100,000 nodes or 2,000,000 triangles are rejected before building the scene. Malformed reloads keep the previous model.

## Live reload behavior

The default interval is one second, configurable from 0.5–5 seconds. **Live reload** pauses updates; **Reload** explicitly reads the file. Polling uses an encrypted `stat` operation whose version combines file identity, size, and nanosecond modification/change times. It checks both the model file and its loaded sidecars, so a changed `.bin` or texture reloads the preview even if the `.gltf` JSON is unchanged. A changed version triggers a transfer and parse. Same-sized rebuilds and atomic file replacements are detected.

Only visible CAD panels in the active browser page poll. Closing the Files browser does not stop a visible CAD panel. Each panel prevents overlapping background reload requests. The new geometry is validated before replacing the old model; a failed transfer, missing file, or invalid export keeps the last good model and reports the error in its status line. Atomic exports are recommended because an in-place write may momentarily be a syntactically valid but incomplete model.

The camera position, target, zoom and framing scale, display mode, opacity, edges/points, units, sections, grids, navigation, gizmo settings, sidebar layout, and part visibility survive reload. Measurements and selections are cleared because old picked geometry may no longer exist. If a rebuild moves or greatly enlarges geometry, use **Fit**. Hidden-part identity uses the named scene path and same-name sibling occurrence, so reordering distinct named parts preserves visibility. Replacing anonymous or identically named siblings can change which part that occurrence denotes.

## Panel API and limits

CAD files use the same panel registration and lifecycle as other viewers. They expose `EyaPanels.call(panelId, "fit")` and `EyaPanels.call(panelId, "cadState")` in addition to download/refresh. CAD state returns camera position, target, zoom, revision, navigation/grid settings, active section-plane count, and hovered part for integrations. Version 2.0 removes the obsolete `navigationMode` and `selectionBehavior` state fields; orbit settings and the `navigation` diagnostics describe the unified camera controls. Selection count is limited to two. Closing a CAD tab releases controls, observers, WebGL resources, geometry, and textures.

WebGL2 is required; if unavailable, the panel reports it and its Download button remains available. Very dense models consume browser CPU/GPU memory, including an additional sharp-edge representation. Tune build123d tessellation tolerances and `EYA_MAX_FILE_BYTES` for your workload. The client bundle is larger because it includes the renderer and parsers; compressed HTML generation remains available. No separate network port is opened and previewing a file does not execute its source script.

Run the focused checks after rebuilding the client and server:

```sh
NODE_PATH=client/node_modules node tests/cad-selection.cjs
NODE_PATH=client/node_modules node tests/cad-3mf.cjs
NODE_PATH=client/node_modules node tests/cad-viewer.cjs
NODE_PATH=client/node_modules node tests/cad-mobile.cjs
NODE_PATH=client/node_modules node tests/cad-layout.cjs
NODE_PATH=client/node_modules node tests/cad-selection-ui.cjs
NODE_PATH=client/node_modules node tests/cad-navigation.cjs
NODE_PATH=client/node_modules node tests/cad-grid.cjs
NODE_PATH=client/node_modules node tests/docking.cjs
NODE_PATH=client/node_modules node tests/cad.cjs
```

The last suite starts its own disposable server, or accepts an existing server at port 18765 with `EYA_TEST_ROOT`. Browser tests require WebGL2; the interaction suite explicitly enables Chromium's software renderer. Coverage includes actual picking/modifiers/measurements and camera gestures, all six gizmo views, held movement and speed factors, sections, rendered display modes, sidebar splits/resizing, complete reload state, invalid-export recovery, 3MF unit/transform/archive validation, and encrypted live reload.

`tests/viewer-regressions.cjs` additionally verifies actual Enter-key editing, blank-line undo/redo, glTF sidecar reads, visible model pixels, and sidecar-only reloads in hosted and standalone HTML/SVG clients.
