"""Run in a build123d environment; open cad_model.glb in Eya's Files panel."""
from pathlib import Path
import os

from build123d import Box, Cylinder, Color, export_gltf

plate = Box(40, 30, 8) - Cylinder(5, 8)
plate.label = "Mounting plate"
plate.color = Color("teal")

# Publish only complete files so live viewers never observe half-written exports.
output = Path(__file__).with_suffix(".glb")
temporary = output.with_name(output.stem + ".tmp.glb")
try:
    if not export_gltf(plate, str(temporary), binary=True):
        raise RuntimeError("GLB export failed")
    os.replace(temporary, output)
finally:
    temporary.unlink(missing_ok=True)
print(f"Published {output}")
