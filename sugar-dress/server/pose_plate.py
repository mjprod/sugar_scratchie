"""Turn a pose photo into a flat gray figure.

The model was copying the reference outfit because it could see it. This
keeps the person's outline and drops the face, clothes, and colors.

ponytail: the outline still includes whatever the clothes added to the
silhouette, such as a wide skirt. Upgrade path is a joint skeleton.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

GRAY = (180, 180, 180)
GROUND = (240, 240, 240)


def paint_pose(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """One gray figure on a plain ground. No garment pixel survives."""
    h, w = rgb.shape[:2]
    if mask.shape != (h, w):
        raise ValueError(f"mask {mask.shape} != image {(h, w)}")
    short = min(h, w)
    side = 48
    if short > side:
        scale = side / short
        nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
        small = Image.fromarray((mask.astype(np.uint8) * 255), mode="L").resize(
            (nw, nh), Image.Resampling.BOX
        )
        mask = np.asarray(small.resize((w, h), Image.Resampling.BOX)) > 127
    out = np.empty_like(rgb)
    out[:] = GROUND
    out[mask] = GRAY
    return out


def pose_plate(rgb: Image.Image) -> Image.Image:
    im = rgb.convert("RGB")
    arr = np.asarray(im)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from extract_person import person_mask

    try:
        mask = person_mask(im)
    except Exception as err:
        print(f"pose-plate: mask failed, dropped color: {err}", flush=True)
        gray = np.asarray(im.convert("L"))
        return Image.fromarray(np.stack([gray, gray, gray], axis=-1), mode="RGB")
    if mask is None or int(mask.sum()) < 30:
        print("pose-plate: no person, dropped color", flush=True)
        gray = np.asarray(im.convert("L"))
        return Image.fromarray(np.stack([gray, gray, gray], axis=-1), mode="RGB")
    print("pose-plate: gray silhouette", flush=True)
    return Image.fromarray(paint_pose(arr, mask), mode="RGB")


def self_check() -> None:
    rgb = np.zeros((40, 20, 3), dtype=np.uint8)
    rgb[:, :] = (10, 20, 30)
    rgb[8:32, 6:14] = (220, 30, 40)
    mask = np.zeros((40, 20), dtype=bool)
    mask[8:32, 6:14] = True
    out = paint_pose(rgb, mask)
    if tuple(int(v) for v in out[16, 10]) != GRAY:
        raise SystemExit(f"figure kept the garment {out[16, 10].tolist()}")
    if tuple(int(v) for v in out[0, 0]) != GROUND:
        raise SystemExit(f"ground changed {out[0, 0].tolist()}")
    if int((out[mask] != GRAY).any()):
        raise SystemExit("a garment color survived")
    print("pose-plate self-check ok")


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--self-check":
        self_check()
        return
    if len(sys.argv) != 3:
        raise SystemExit("usage: pose_plate.py src out | --self-check")
    src, out = (Path(p) for p in sys.argv[1:])
    pose_plate(Image.open(src)).save(out)


if __name__ == "__main__":
    main()
