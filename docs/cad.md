# CAD as code with build123d

Eya opens binary or ASCII STL, binary glTF (`.glb`), and `.gltf` files with embedded or relative sidecar resources in independent CAD panels. Use GLB for build123d when you want one file: it retains assembly names, colors, and transforms and reloads over the same encrypted connection as the terminal. Rendering libraries are bundled into the standalone client; no CDN or additional viewer service is required.

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

The compact toolbar keeps View, Fit, Measure, Select, Sections, and CAD options available. Secondary controls are grouped in popovers so the canvas keeps its available space.

- Orbit by dragging; pan with right-drag or two fingers; zoom with the wheel or pinch. Camera settings also provide turntable/free orbit and first-person movement: focus the canvas, use WASD to move, Q/E to move vertically, and drag to look. Movement speed, look sensitivity, and inverted look are configurable.
- Choose isometric, front/back, top/bottom, or left/right orthographic views. **Fit** frames the complete model.
- The corner rotation gizmo shows the projected X/Y/Z axes and its colored axis buttons jump to orthographic views. The model helpers can show the XY grid alone or all XY/XZ/YZ grids, plus labeled minimum and maximum axis coordinates.
- Switch between shaded, shaded plus sharp edges, and triangle wireframe. Imported normals are validated and repaired when missing or invalid; the edges are extracted from the mesh and are not original CAD topology.
- **Parts** lists model meshes by their exported names, with visibility checkboxes. **Show all** now lives in that dropdown and restores hidden parts. Bounds report the entire model, including hidden parts.
- **Sections** provides independent minimum and maximum clipping handles for X, Y, and Z. Each end has both a slider and a wheel/keyboard-adjustable numerical coordinate input. A separate camera-normal section stays perpendicular to the current view and can be flipped. Colored in-scene handles and the rotation gizmo are independently toggleable. Sections are visual clipping planes; cut surfaces are not capped or exported.
- **Measure distance** picks two points and reports distance plus X/Y/Z deltas. **Measure angle** picks three points; the second point is the angle's vertex. **Face area** measures a connected coplanar triangle region. **Mesh volume** measures a closed, manifold mesh and rejects open geometry. **Snap vertices** chooses the nearest vertex of the clicked triangle. Measurement points are larger and use a high-contrast configurable color.
- **Select** supports whole parts, connected coplanar faces, and face-boundary loops. Shift-click adds to the current selection. Hover highlighting, annotation colors, and default selection mode are configurable.
- Display units can be mm, cm, or inches. All measurements are explicitly approximate tessellated-mesh measurements. Curved surfaces, hidden topology, and mesh resolution limit their accuracy; no analytic diameter/radius or exact BRep measurements are inferred.

Viewer display defaults, units, grids, gizmos, navigation, hover, measurement styling, selection, snapping, source STL units, live reload, and interval are saved in browser storage. They can be changed directly in each CAD panel; the main **Settings → 3D viewer** section changes the shared defaults and updates open viewers. On mobile the toolbar scrolls within a bounded area, leaving room for the model canvas.

## Live reload behavior

The default interval is one second, configurable from 0.5–5 seconds. **Live reload** pauses updates; **Reload** explicitly reads the file. Polling uses an encrypted `stat` operation whose version combines file identity, size, and nanosecond modification/change times. It checks both the model file and its loaded sidecars, so a changed `.bin` or texture reloads the preview even if the `.gltf` JSON is unchanged. A changed version triggers a transfer and parse. Same-sized rebuilds and atomic file replacements are detected.

Only visible CAD panels in the active browser page poll. Closing the Files browser does not stop a visible CAD panel. Each panel prevents overlapping background reload requests. The new geometry is validated before replacing the old model; a failed transfer, missing file, or invalid export keeps the last good model and reports the error in its status line. Atomic exports are recommended because an in-place write may momentarily be a syntactically valid but incomplete model.

The camera, zoom, display mode, section controls, and hidden-part indices survive reload. Measurements and selections are cleared because old picked geometry may no longer exist. If a rebuild moves or greatly enlarges geometry, use **Fit**. Hidden-part identity is based on mesh order; changing assembly structure can change which mesh an index denotes.

## Panel API and limits

CAD files use the same panel registration and lifecycle as other viewers. They expose `EyaPanels.call(panelId, "fit")` and `EyaPanels.call(panelId, "cadState")` in addition to download/refresh. CAD state returns camera position, target, zoom, revision, navigation/grid settings, active section-plane count, and hovered part for integrations. Closing a CAD tab releases controls, observers, WebGL resources, geometry, and textures.

WebGL2 is required; if unavailable, the panel reports it and its Download button remains available. Very dense models consume browser CPU/GPU memory, including an additional sharp-edge representation. Tune build123d tessellation tolerances and `EYA_MAX_FILE_BYTES` for your workload. The client bundle is larger because it includes the renderer and parsers; compressed HTML generation remains available. No separate network port is opened and previewing a file does not execute its source script.

Run the integration test with a disposable server working directory:

```sh
NODE_PATH=client/node_modules EYA_TEST_ROOT=/path/to/test-directory node tests/cad.cjs
```

The test browser must have WebGL2 support. `tests/Dockerfile.browser` includes Chromium's software renderer for headless CI. The suite verifies invalid-STL-normal repair, STL and GLB dimensions, distance/angle/area/volume measurement, face/loop selection, hover and first-person movement, paired sections, part visibility, camera-preserving reload without Files, same-sized rebuilds, invalid-export recovery, pause, and mobile layout.

`tests/viewer-regressions.cjs` additionally verifies actual Enter-key editing, blank-line undo/redo, glTF sidecar reads, visible model pixels, and sidecar-only reloads in hosted and standalone HTML/SVG clients.
