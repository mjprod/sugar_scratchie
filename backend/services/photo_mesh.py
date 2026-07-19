"""Static identity UV mesh for Photo Scratch stills (no video tracker).

Builds a single-frame lattice matching the video mesh schema so PhotoScratchTest
and SymbolPointPicker can reuse the same UV / garment / symbolPoints paths.

The scratchable region matches motion-card auto-garment: SegFormer clothing
classes (+ arms/legs), with the same dilation and coverage cap used by
`backend/services/garment_mask.py`.

Input stills are cover-cropped to 390×672 (same as WebGL / mesh video path).
"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

from PIL import Image
import numpy as np
from scipy import ndimage

from backend.services.photo_canvas import CANVAS_HEIGHT, CANVAS_WIDTH, cover_to_canvas

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_COLS = 24
DEFAULT_ROWS = 36

# Keep in lockstep with backend/services/garment_mask.py defaults.
AUTO_PIXEL_DILATE = 3
# One extra lattice ring vs a tight SegFormer paint — covers sleeve/hem fringe
# so you rarely need a manual Grow +1 in the mask editor.
AUTO_GRID_DILATE = 3
AUTO_MAX_COVERAGE = 0.72
# Same extras as scripts/add-garment-mask.py (legs + arms).
EXTRA_GARMENT_CLASSES = {12, 13, 14, 15}


def _load_generator():
    path = ROOT / "scripts" / "generate-mesh-tracking.py"
    spec = importlib.util.spec_from_file_location("photo_mesh_gen", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load mesh generator: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _identity_lattice(cols: int, rows: int) -> tuple[list[list[float]], list[list[float]]]:
    uv: list[list[float]] = []
    verts: list[list[float]] = []
    for j in range(rows):
        v = j / (rows - 1)
        y = (CANVAS_HEIGHT - 1) * v
        for i in range(cols):
            u = i / (cols - 1)
            x = (CANVAS_WIDTH - 1) * u
            uv.append([round(u, 4), round(v, 4)])
            verts.append([round(x, 2), round(y, 2)])
    return uv, verts


def _shrink_to_cap(grid: np.ndarray, max_coverage: float) -> np.ndarray:
    """Erode on the lattice until coverage is under the motion-card cap."""
    while float(grid.mean()) > max_coverage and grid.any():
        grid = ndimage.binary_erosion(grid, iterations=1)
    return grid


def _garment_from_image(rgb: np.ndarray, cols: int, rows: int) -> list[int]:
    """Clothes-only mask — same SegFormer path as motion-card auto-garment."""
    os.environ.setdefault("DEVICE", "cpu")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    gen = _load_generator()
    gen.GARMENT_CLASSES = set(gen.GARMENT_CLASSES) | EXTRA_GARMENT_CLASSES
    mask = gen.build_garment_mask(rgb)
    if AUTO_PIXEL_DILATE > 0:
        mask = ndimage.binary_dilation(
            mask, structure=np.ones((3, 3), bool), iterations=AUTO_PIXEL_DILATE
        )

    flags = np.zeros((rows, cols), dtype=bool)
    for j in range(rows):
        v = j / (rows - 1)
        y = int(round((CANVAS_HEIGHT - 1) * v))
        for i in range(cols):
            u = i / (cols - 1)
            x = int(round((CANVAS_WIDTH - 1) * u))
            if 0 <= y < CANVAS_HEIGHT and 0 <= x < CANVAS_WIDTH and bool(mask[y, x]):
                flags[j, i] = True

    if AUTO_GRID_DILATE > 0 and flags.any():
        flags = ndimage.binary_dilation(flags, iterations=AUTO_GRID_DILATE)

    on = int(flags.sum())
    min_cells = max(12, (cols * rows) // 40)
    if on < min_cells:
        raise RuntimeError(
            f"Clothes garment mask too small ({on}/{cols * rows}). "
            "Rebuild from the TOP (clothes) layer — bikini/skin-only stills "
            "often miss SegFormer clothing classes."
        )

    if float(flags.mean()) > AUTO_MAX_COVERAGE:
        print(
            f"Photo mesh garment coverage {flags.mean() * 100:.1f}% exceeds "
            f"{AUTO_MAX_COVERAGE * 100:.0f}% — eroding to cap",
            flush=True,
        )
        flags = _shrink_to_cap(flags, AUTO_MAX_COVERAGE)

    return [1 if flag else 0 for flag in flags.reshape(-1).tolist()]


def generate_static_photo_mesh(
    image_path: Path,
    output_path: Path,
    *,
    cols: int = DEFAULT_COLS,
    rows: int = DEFAULT_ROWS,
    source_label: str = "",
) -> Path:
    """Write a single-frame static mesh JSON for a still image."""
    if not image_path.is_file():
        raise FileNotFoundError(f"Image not found: {image_path}")

    plate = cover_to_canvas(Image.open(image_path))
    rgb = np.asarray(plate, dtype=np.uint8)
    uv, verts = _identity_lattice(cols, rows)
    garment = _garment_from_image(rgb, cols, rows)
    vis = list(garment)

    try:
        rel_source = image_path.resolve().relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        rel_source = str(image_path)

    payload = {
        "source": source_label or rel_source,
        "generator": "photo-scratch-static",
        "canvas": {"width": CANVAS_WIDTH, "height": CANVAS_HEIGHT},
        "fps": 1,
        "mesh": {"cols": cols, "rows": rows},
        "uv": uv,
        "frames": [{"t": 0.0, "verts": verts, "vis": vis}],
        "garment": garment,
        "garmentSource": "auto-detect",
        "fit": "cover",
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    print(
        f"Photo mesh written: {output_path} "
        f"({cols}x{rows}, garment={sum(garment)}/{len(garment)}, fit=cover)"
    )
    return output_path
