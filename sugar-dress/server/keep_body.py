"""Put generated clothes inside the original person's outline.

Skin, including the chest and the face, stays the original person.
Old cloth can take the new garment. Outside the person, the original
pixels stay. The generated plate is scaled uniformly and cropped, never
stretched.

ponytail: a new garment cannot cover original bare skin, so the chest
cannot grow past the original skin. A per-row squeeze is not used.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

HEAD_TALL = 0.18
HEAD_WIDE = 0.32
CHANGE = 28


def skin_mask(rgb: np.ndarray) -> np.ndarray:
    r = rgb[..., 0].astype(np.float32)
    g = rgb[..., 1].astype(np.float32)
    b = rgb[..., 2].astype(np.float32)
    yy = 0.299 * r + 0.587 * g + 0.114 * b
    cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
    cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
    chroma = np.hypot(cb - 128, cr - 128)
    return (cr > cb + 2) & (chroma > 6) & (chroma < 48) & (yy > 30) & (yy < 245)


def fit(rgb: np.ndarray, width: int, height: int) -> np.ndarray:
    """Uniform scale, then a center crop. Do not stretch one side."""
    h, w = rgb.shape[:2]
    if h == height and w == width:
        return rgb
    scale = max(width / w, height / h)
    nw = max(width, int(round(w * scale)))
    nh = max(height, int(round(h * scale)))
    im = Image.fromarray(rgb, mode="RGB").resize((nw, nh), Image.Resampling.BOX)
    left = max(0, (nw - width) // 2)
    top = max(0, (nh - height) // 2)
    return np.asarray(im.crop((left, top, left + width, top + height)))


def thin_red_seam(gen: np.ndarray) -> np.ndarray:
    """A 1–2px red line on skin. A filled red garment has too many red neighbours."""
    r = gen[..., 0].astype(np.int16)
    g = gen[..., 1].astype(np.int16)
    b = gen[..., 2].astype(np.int16)
    red = (r > g + 28) & (r > b + 18) & (r > 100) & (r < 240)
    m = red.astype(np.int16)
    c = np.pad(np.cumsum(np.cumsum(m, axis=0), axis=1), ((1, 0), (1, 0)))
    h, w = m.shape
    y = np.arange(h)
    x = np.arange(w)
    y0 = np.clip(y - 2, 0, h)
    y1 = np.clip(y + 3, 0, h)
    x0 = np.clip(x - 2, 0, w)
    x1 = np.clip(x + 3, 0, w)
    count = (
        c[y1[:, None], x1[None, :]]
        - c[y0[:, None], x1[None, :]]
        - c[y1[:, None], x0[None, :]]
        + c[y0[:, None], x0[None, :]]
    )
    return red & (count <= 10)


def keep_body(cut: np.ndarray, generated: np.ndarray) -> np.ndarray:
    height, width = cut.shape[:2]
    gen = fit(generated, width, height)
    alpha = cut[..., 3]
    person = alpha > 16
    if int(person.sum()) < 10:
        person = np.ones((height, width), dtype=bool)
        alpha = np.full((height, width), 255, dtype=np.uint8)
    original = cut[..., :3]
    orig_skin = skin_mask(original) & person
    out_rgb = gen.copy()
    out_rgb[~person] = original[~person]
    out_rgb[orig_skin] = original[orig_skin]
    return np.dstack([out_rgb, alpha])


def self_check() -> None:
    cut = np.zeros((20, 10, 4), dtype=np.uint8)
    cut[:, 1:, 3] = 255
    cut[:8, 1:, :3] = (180, 140, 120)
    cut[8:, 1:, :3] = (200, 20, 40)
    gen = np.zeros((20, 10, 3), dtype=np.uint8)
    gen[..., 2] = 255
    out = keep_body(cut, gen)
    if out[2, 4, 3] != 255 or out[2, 0, 3] != 0:
        raise SystemExit("alpha changed")
    if tuple(int(v) for v in out[2, 4, :3]) != (180, 140, 120):
        raise SystemExit(f"face skin changed {out[2, 4, :3].tolist()}")
    if tuple(int(v) for v in out[14, 4, :3]) != (0, 0, 255):
        raise SystemExit(f"clothes stayed {out[14, 4, :3].tolist()}")
    cut[12, 4, :3] = (180, 140, 120)
    gen[12, 4] = (170, 150, 210)
    cut[11, 4, :3] = (20, 30, 180)
    gen[11, 4] = (240, 240, 240)
    cut[16, 4, :3] = (180, 140, 120)
    gen[16, 4] = (30, 30, 30)
    out = keep_body(cut, gen)
    if tuple(int(v) for v in out[12, 4, :3]) != (180, 140, 120):
        raise SystemExit(f"skin under a garment changed {out[12, 4, :3].tolist()}")
    if tuple(int(v) for v in out[11, 4, :3]) != (240, 240, 240):
        raise SystemExit(f"new cloth on old cloth was dropped {out[11, 4, :3].tolist()}")
    cut[13, 4, :3] = (200, 20, 40)
    gen[13, 4] = (180, 140, 120)
    out = keep_body(cut, gen)
    if tuple(int(v) for v in out[13, 4, :3]) != (180, 140, 120):
        raise SystemExit(f"old cloth stayed where skin was painted {out[13, 4, :3].tolist()}")
    if tuple(int(v) for v in out[16, 4, :3]) != (180, 140, 120):
        raise SystemExit(f"redrawn limb stayed {out[16, 4, :3].tolist()}")
    cut[14, 4, :3] = (180, 140, 120)
    gen[14, 4] = (210, 60, 70)
    out = keep_body(cut, gen)
    if tuple(int(v) for v in out[14, 4, :3]) != (180, 140, 120):
        raise SystemExit(f"red seam stayed {out[14, 4, :3].tolist()}")
    gen[10:16, 2:8] = (210, 40, 50)
    out = keep_body(cut, gen)
    if tuple(int(v) for v in out[12, 4, :3]) != (180, 140, 120):
        raise SystemExit(f"filled garment covered skin {out[12, 4, :3].tolist()}")
    if tuple(int(v) for v in out[11, 4, :3]) == (20, 30, 180):
        raise SystemExit("filled garment missed old cloth")
    wide = np.zeros((30, 60, 3), dtype=np.uint8)
    wide[:] = (0, 0, 255)
    wide[:, 28:32] = (255, 0, 0)
    fitted = fit(wide, 20, 20)
    if fitted.shape[:2] != (20, 20):
        raise SystemExit(f"fit size {fitted.shape}")
    if int(fitted[10, 0, 2]) < 200 or int(fitted[10, 10, 0]) < 200:
        raise SystemExit(f"fit stretched {fitted[10, 0].tolist()} {fitted[10, 10].tolist()}")
    print("keep-body self-check ok")


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--self-check":
        self_check()
        return
    if len(sys.argv) != 4:
        raise SystemExit("usage: keep_body.py cutout generated out | --self-check")
    cut_path, gen_path, out = (Path(p) for p in sys.argv[1:])
    cut = np.asarray(Image.open(cut_path).convert("RGBA"))
    gen = np.asarray(Image.open(gen_path).convert("RGB"))
    Image.fromarray(keep_body(cut, gen), mode="RGBA").save(out)
    print("keep-body: face and outline kept", flush=True)


if __name__ == "__main__":
    main()
