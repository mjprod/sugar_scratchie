"""Lock the generated person's box onto the reference person's box.

ponytail: one scale per axis from the largest COCO person rectangle, then the
whole frame shifts with it. Limbs are not redrawn. Upgrade path is a masked
pose warp. SSDLite320, person label is 1.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

MIN_SCORE = 0.5
MIN_SCALE = 0.5
MAX_SCALE = 2.0
MIN_SIDE = 8

_model = None
_weights = None


def warp(im: Image.Image, gen: tuple[float, float, float, float], ref: tuple[float, float, float, float]) -> Image.Image:
    """Map gen box (x, y, w, h) onto ref box. Output keeps im's size."""
    gx, gy, gw, gh = gen
    rx, ry, rw, rh = ref
    if gw < MIN_SIDE or gh < MIN_SIDE or rw < MIN_SIDE or rh < MIN_SIDE:
        return im
    sx = min(MAX_SCALE, max(MIN_SCALE, rw / gw))
    sy = min(MAX_SCALE, max(MIN_SCALE, rh / gh))
    gcx, gcy = gx + gw / 2, gy + gh / 2
    rcx, rcy = rx + rw / 2, ry + rh / 2
    # output pixel samples input: input = output / scale + (gen_center - ref_center / scale)
    coeff = (
        1 / sx,
        0,
        gcx - rcx / sx,
        0,
        1 / sy,
        gcy - rcy / sy,
    )
    return im.transform(im.size, Image.AFFINE, coeff, resample=Image.NEAREST)


def person_box(path: Path) -> tuple[float, float, float, float] | None:
    global _model, _weights
    import torch
    from torchvision.models.detection import (
        ssdlite320_mobilenet_v3_large,
        SSDLite320_MobileNet_V3_Large_Weights,
    )

    if _model is None:
        _weights = SSDLite320_MobileNet_V3_Large_Weights.DEFAULT
        _model = ssdlite320_mobilenet_v3_large(weights=_weights)
        _model.eval()
    im = Image.open(path).convert("RGB")
    tensor = _weights.transforms()(im)
    with torch.inference_mode():
        pred = _model([tensor])[0]
    tw = float(tensor.shape[-1])
    th = float(tensor.shape[-2])
    w, h = im.size
    best_area = 0.0
    best: tuple[float, float, float, float] | None = None
    for box, label, score in zip(pred["boxes"], pred["labels"], pred["scores"]):
        if int(label) != 1 or float(score) < MIN_SCORE:
            continue
        x1, y1, x2, y2 = (float(v) for v in box)
        area = max(0.0, x2 - x1) * max(0.0, y2 - y1)
        if area <= best_area:
            continue
        best_area = area
        best = (x1 * w / tw, y1 * h / th, (x2 - x1) * w / tw, (y2 - y1) * h / th)
    return best


def self_check() -> None:
    im = Image.new("RGB", (100, 200), (0, 0, 0))
    im.putpixel((20, 50), (255, 0, 0))
    out = warp(im, (10, 20, 20, 60), (40, 30, 40, 120))
    if out.getpixel((60, 90)) != (255, 0, 0):
        raise SystemExit(f"warp missed target, got {out.getpixel((60, 90))}")
    clamped = warp(im, (10, 20, 20, 60), (0, 0, 200, 60))
    # width scale would be 10, clamped to 2. Center still maps.
    if clamped.size != im.size:
        raise SystemExit("size changed")
    print("body-match self-check ok")


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--self-check":
        self_check()
        return
    if len(sys.argv) != 4:
        raise SystemExit("usage: body_match.py src ref out | --self-check")
    src, ref, out = (Path(p) for p in sys.argv[1:])
    im = Image.open(src).convert("RGB")
    try:
        gen = person_box(src)
        target = person_box(ref)
    except Exception as err:
        print(f"body-match: skipped, detector {err}", flush=True)
        im.save(out)
        return
    if gen is None or target is None:
        print("body-match: skipped, no person", flush=True)
        im.save(out)
        return
    aligned = warp(im, gen, target)
    gw, gh = gen[2], gen[3]
    rw, rh = target[2], target[3]
    print(
        f"body-match: {min(MAX_SCALE, max(MIN_SCALE, rw / gw)):.3f} "
        f"{min(MAX_SCALE, max(MIN_SCALE, rh / gh)):.3f}",
        flush=True,
    )
    aligned.save(out)


if __name__ == "__main__":
    main()
