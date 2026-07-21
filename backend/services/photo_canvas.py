"""Shared 390×672 cover-crop for Photo Scratch stills.

Matches the offline mesh generator / WebGL cover path
(`force_original_aspect_ratio=increase` + center crop), so cutout, mesh, Fix
mesh, Symbols, and the game all see the same pixels.
"""

from __future__ import annotations

from PIL import Image

CANVAS_WIDTH = 390
CANVAS_HEIGHT = 672


def cover_to_canvas(
    image: Image.Image,
    *,
    width: int = CANVAS_WIDTH,
    height: int = CANVAS_HEIGHT,
) -> Image.Image:
    """Resize with aspect preserved, center-crop to canvas (no stretch)."""
    rgb = image.convert("RGB")
    src_w, src_h = rgb.size
    if src_w <= 0 or src_h <= 0:
        raise ValueError("Image has empty dimensions")
    scale = max(width / src_w, height / src_h)
    new_w = max(width, int(round(src_w * scale)))
    new_h = max(height, int(round(src_h * scale)))
    resized = rgb.resize((new_w, new_h), Image.Resampling.LANCZOS)
    left = max(0, (new_w - width) // 2)
    top = max(0, (new_h - height) // 2)
    return resized.crop((left, top, left + width, top + height))
