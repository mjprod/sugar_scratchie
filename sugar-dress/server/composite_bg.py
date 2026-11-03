"""Lay the cut-out person on a background at the frame size from step 1.

The person is not scaled when it is already that size. A larger cutout is
scaled down with one factor. The background is the only image that is
cropped to fill the frame.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

from keep_body import cover


def composite(person: Image.Image, background: np.ndarray, width: int, height: int) -> Image.Image:
    bg = Image.fromarray(cover(background, width, height), mode="RGB").convert("RGBA")
    cut = person.convert("RGBA")
    if cut.size != (width, height):
        scale = min(width / cut.width, height / cut.height, 1)
        if scale < 1:
            cut = cut.resize(
                (max(1, int(round(cut.width * scale))), max(1, int(round(cut.height * scale)))),
                Image.Resampling.BOX,
            )
        plate = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        plate.paste(cut, ((width - cut.width) // 2, (height - cut.height) // 2), cut)
        cut = plate
    bg.alpha_composite(cut)
    return bg


def self_check() -> None:
    person = Image.new("RGBA", (4, 4), (0, 0, 0, 0))
    person.putpixel((1, 1), (255, 0, 0, 255))
    bg = np.zeros((4, 4, 3), dtype=np.uint8)
    bg[..., 2] = 255
    out = composite(person, bg, 4, 4)
    if out.size != (4, 4):
        raise SystemExit(f"size {out.size}")
    if out.getpixel((1, 1))[:3] != (255, 0, 0):
        raise SystemExit(f"person moved {out.getpixel((1, 1))}")
    if out.getpixel((0, 0))[:3] != (0, 0, 255):
        raise SystemExit(f"background missed {out.getpixel((0, 0))}")
    print("composite-bg self-check ok")


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--self-check":
        self_check()
        return
    if len(sys.argv) != 6:
        raise SystemExit("usage: composite_bg.py person background out width height | --self-check")
    person, background, out = (Path(p) for p in sys.argv[1:4])
    width, height = int(sys.argv[4]), int(sys.argv[5])
    bg = np.asarray(Image.open(background).convert("RGB"))
    composite(Image.open(person), bg, width, height).convert("RGB").save(out)
    print(f"composite: {width}x{height}", flush=True)


if __name__ == "__main__":
    main()
