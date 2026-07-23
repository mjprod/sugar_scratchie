"""Scale / nudge RGBA photo-scratch cutouts about the canvas center.

Used by Picture Flow Zooming: larger = closer/front, smaller = farther/back.
Always reads pristine ``*_src.png`` and writes the active ``bikini.png`` /
``clothes.png`` used by Mesh / Symbols / Game.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from PIL import Image

def zoom_rgba_cutout(
    src_path: Path,
    out_path: Path,
    *,
    scale: float = 1.0,
    tx: float = 0.0,
    ty: float = 0.0,
) -> Path:
    """Center-anchored scale + pixel translate; transparent border fill.

    ``tx`` / ``ty`` are in cutout pixels (same 3× canvas space as Adjust nudge).
    """
    if not src_path.is_file():
        raise FileNotFoundError(f"Cutout source missing: {src_path}")

    with Image.open(src_path) as img:
        rgba = np.asarray(img.convert("RGBA"), dtype=np.uint8)

    h, w = rgba.shape[:2]
    out = rgba
    if abs(scale - 1.0) >= 1e-4:
        cx, cy = w * 0.5, h * 0.5
        matrix = cv2.getRotationMatrix2D((cx, cy), 0.0, float(scale))
        out = cv2.warpAffine(
            out,
            matrix,
            (w, h),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=(0, 0, 0, 0),
        )
    if abs(tx) >= 1e-3 or abs(ty) >= 1e-3:
        matrix = np.array(
            [[1.0, 0.0, float(tx)], [0.0, 1.0, float(ty)]], dtype=np.float32
        )
        out = cv2.warpAffine(
            out,
            matrix,
            (w, h),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=(0, 0, 0, 0),
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(out, mode="RGBA").save(out_path, format="PNG", optimize=True)
    return out_path


def zoom_cutout_pair(
    bikini_src: Path,
    clothes_src: Path,
    bikini_out: Path,
    clothes_out: Path,
    *,
    scale: float = 1.0,
    tx: float = 0.0,
    ty: float = 0.0,
) -> dict:
    """Apply the same zoom to bikini + clothes cutouts; return meta fields."""
    zoom_rgba_cutout(bikini_src, bikini_out, scale=scale, tx=tx, ty=ty)
    zoom_rgba_cutout(clothes_src, clothes_out, scale=scale, tx=tx, ty=ty)
    return {
        "scale": round(float(scale), 4),
        "tx": round(float(tx), 2),
        "ty": round(float(ty), 2),
    }
