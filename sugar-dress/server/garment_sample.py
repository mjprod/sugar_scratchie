"""Keep a clothing reference intact before it enters the model.

A worn photo used to be replaced by a median colour swatch so another
person's chest could not be copied. That swatch also deleted the
garment, and the model invented a different outfit. The edit prompt
keeps the body. This file keeps the clothes.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image


def keep(src: Path, out: Path) -> None:
    Image.open(src).convert("RGB").save(out)


def self_check() -> None:
    import numpy as np

    rgb = np.zeros((40, 20, 3), dtype=np.uint8)
    rgb[:20] = (220, 150, 170)
    rgb[20:] = (250, 250, 250)
    src = Path("/tmp/garment-sample-self-src.png")
    out = Path("/tmp/garment-sample-self-out.png")
    Image.fromarray(rgb, mode="RGB").save(src)
    keep(src, out)
    kept = np.asarray(Image.open(out).convert("RGB"))
    if kept.shape != rgb.shape or int(np.abs(kept.astype(int) - rgb.astype(int)).sum()):
        raise SystemExit("garment was rewritten")
    src.unlink(missing_ok=True)
    out.unlink(missing_ok=True)
    print("garment-sample self-check ok")


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1] == "--self-check":
        self_check()
        return
    if len(sys.argv) != 3:
        raise SystemExit("usage: garment_sample.py src out | --self-check")
    src, out = (Path(p) for p in sys.argv[1:])
    keep(src, out)
    print("garment-sample: kept the garment", flush=True)


if __name__ == "__main__":
    main()
