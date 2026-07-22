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
# Then one lattice erosion (= mask editor "Shrink −1") so the auto paint sits
# just inside the garment edge instead of spilling onto skin/background.
AUTO_GRID_SHRINK = 1
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


def _cover_rgba_to_canvas(image: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    """Cover-crop to canvas; return RGB (gray-backed) + alpha float mask [0,1]."""
    rgba = image.convert("RGBA")
    src_w, src_h = rgba.size
    if src_w <= 0 or src_h <= 0:
        raise ValueError("Image has empty dimensions")
    scale = max(CANVAS_WIDTH / src_w, CANVAS_HEIGHT / src_h)
    new_w = max(CANVAS_WIDTH, int(round(src_w * scale)))
    new_h = max(CANVAS_HEIGHT, int(round(src_h * scale)))
    resized = rgba.resize((new_w, new_h), Image.Resampling.LANCZOS)
    left = max(0, (new_w - CANVAS_WIDTH) // 2)
    top = max(0, (new_h - CANVAS_HEIGHT) // 2)
    cropped = resized.crop((left, top, left + CANVAS_WIDTH, top + CANVAS_HEIGHT))
    arr = np.asarray(cropped, dtype=np.uint8)
    alpha = arr[:, :, 3].astype(np.float32) / 255.0
    # Mid-gray under transparent pixels so SegFormer isn't biased by pure black.
    rgb = arr[:, :, :3].astype(np.float32)
    gray = 140.0
    for c in range(3):
        channel = rgb[:, :, c]
        rgb[:, :, c] = channel * alpha + gray * (1.0 - alpha)
    return np.clip(rgb, 0, 255).astype(np.uint8), alpha


def _garment_from_image(
    rgb: np.ndarray, cols: int, rows: int, alpha: np.ndarray | None = None
) -> list[int]:
    """Clothes-only mask — same SegFormer path as motion-card auto-garment.

    When ``alpha`` is provided (zoomed RGBA cutout), garment cells must sit
    inside the opaque silhouette so the lattice matches the baked zoom scale.
    """
    os.environ.setdefault("DEVICE", "cpu")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    gen = _load_generator()
    gen.GARMENT_CLASSES = set(gen.GARMENT_CLASSES) | EXTRA_GARMENT_CLASSES
    mask = gen.build_garment_mask(rgb)
    if alpha is not None:
        # Keep clothes detections only on the cutout person (post-zoom silhouette).
        mask = mask & (alpha >= 0.25)
    if AUTO_PIXEL_DILATE > 0:
        mask = ndimage.binary_dilation(
            mask, structure=np.ones((3, 3), bool), iterations=AUTO_PIXEL_DILATE
        )
        if alpha is not None:
            mask = mask & (alpha >= 0.08)

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
    if AUTO_GRID_SHRINK > 0 and flags.any():
        flags = ndimage.binary_erosion(flags, iterations=AUTO_GRID_SHRINK)

    on = int(flags.sum())
    min_cells = max(12, (cols * rows) // 40)
    if on < min_cells:
        # Fallback: opaque cutout alpha as scratchable region (still at zoom scale).
        if alpha is not None and float((alpha >= 0.25).mean()) > 0.02:
            print(
                f"Clothes SegFormer mask too small ({on}/{cols * rows}) — "
                "using cutout alpha silhouette so mesh stays on zoom scale",
                flush=True,
            )
            flags = np.zeros((rows, cols), dtype=bool)
            for j in range(rows):
                v = j / (rows - 1)
                y = int(round((CANVAS_HEIGHT - 1) * v))
                for i in range(cols):
                    u = i / (cols - 1)
                    x = int(round((CANVAS_WIDTH - 1) * u))
                    if (
                        0 <= y < CANVAS_HEIGHT
                        and 0 <= x < CANVAS_WIDTH
                        and alpha[y, x] >= 0.25
                    ):
                        flags[j, i] = True
            if AUTO_GRID_SHRINK > 0 and flags.any():
                flags = ndimage.binary_erosion(flags, iterations=AUTO_GRID_SHRINK)
            on = int(flags.sum())
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
    zoom: dict | None = None,
) -> Path:
    """Write a single-frame static mesh JSON for a still image.

    RGBA cutouts (post-Zooming) keep alpha so the garment lattice matches the
    baked girl scale over the room.
    """
    if not image_path.is_file():
        raise FileNotFoundError(f"Image not found: {image_path}")

    opened = Image.open(image_path)
    alpha: np.ndarray | None = None
    if "A" in opened.getbands():
        rgb, alpha = _cover_rgba_to_canvas(opened)
    else:
        plate = cover_to_canvas(opened)
        rgb = np.asarray(plate, dtype=np.uint8)
    uv, verts = _identity_lattice(cols, rows)
    garment = _garment_from_image(rgb, cols, rows, alpha=alpha)
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
        "garmentSource": "auto-detect-alpha" if alpha is not None else "auto-detect",
        "fit": "cover",
    }
    if zoom:
        payload["zoom"] = {
            "scale": float(zoom.get("scale", 1.0)),
            "tx": float(zoom.get("tx", 0.0)),
            "ty": float(zoom.get("ty", 0.0)),
        }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    zoom_note = f", zoom={payload['zoom']}" if zoom else ""
    print(
        f"Photo mesh written: {output_path} "
        f"({cols}x{rows}, garment={sum(garment)}/{len(garment)}, fit=cover{zoom_note})"
    )
    return output_path