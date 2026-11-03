"""Grade a generated image toward a reference. Scene, clothes, and skin all move.

Calls grade-images' global distribution match (strength 0.65, exposure
clamped to ±strength EV, RGB gains held near 0.8–1.25, skin protection off).
Pillow decodes the file first so WebP and AVIF work; match.py itself only
accepts JPEG and PNG.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image

STRENGTH = 0.65
STATS_MAX = 1600


def load_rgb(path: Path) -> np.ndarray:
    with Image.open(path) as im:
        if getattr(im, "n_frames", 1) > 1:
            im.seek(0)
        return np.asarray(im.convert("RGB"), dtype=np.uint8)


def _stats_rgb(rgb: np.ndarray) -> np.ndarray:
    """Same 1600px stats view match.py uses. The render stays full size."""
    image = Image.fromarray(rgb, mode="RGB")
    if max(image.size) > STATS_MAX:
        image.thumbnail((STATS_MAX, STATS_MAX), Image.Resampling.LANCZOS)
    return np.asarray(image, dtype=np.float32) / 255.0


def _grade_modules(scripts: Path):
    folder = str(scripts)
    if folder not in sys.path:
        sys.path.insert(0, folder)
    from grade_core import load_recipe, render_array
    from match import derive_match_recipe

    return derive_match_recipe, load_recipe, render_array


def grade_frame(
    source: np.ndarray, reference: np.ndarray, scripts: Path, template: Path
) -> tuple[np.ndarray | None, str]:
    """Whole-image grade. (None, reason) when the match is not usable."""
    try:
        derive_match_recipe, load_recipe, render_array = _grade_modules(scripts)
        recipe, _diagnostics = derive_match_recipe(
            _stats_rgb(source),
            _stats_rgb(reference),
            load_recipe(template),
            STRENGTH,
            skin_protection=False,
        )
        encoded, _render = render_array(source.astype(np.float32) / 255.0, recipe)
        if encoded.shape[:2] != source.shape[:2] or not np.all(np.isfinite(encoded)):
            return None, "render was empty"
        graded = np.clip(np.rint(encoded * 255.0), 0, 255).astype(np.uint8)
        return graded, ""
    except (OSError, ValueError, RuntimeError, ImportError) as exc:
        return None, str(exc)


def save_png(path: Path, rgb: np.ndarray) -> None:
    Image.fromarray(rgb, mode="RGB").save(path, format="PNG", compress_level=1)


def _skill() -> tuple[Path, Path]:
    skill = Path.home() / ".local/share/mxj-grade-images/skills/grade-images"
    return skill / "scripts", skill / "assets/recipes/neutral-correction.json"


def self_check() -> None:
    assert "skin_core" not in globals() and "match_skin" not in globals()
    scripts, template = _skill()
    assert (scripts / "match.py").is_file(), scripts
    assert template.is_file(), template

    src = np.zeros((96, 96, 3), dtype=np.uint8)
    ref = np.zeros((96, 96, 3), dtype=np.uint8)
    src[:] = (30, 50, 190)
    src[28:68, 28:68] = (190, 140, 110)
    ref[:] = (210, 90, 40)
    out, reason = grade_frame(src, ref, scripts, template)
    assert out is not None, reason
    # A skin mask would leave this blue corner put. Both regions have to move.
    assert abs(int(out[2, 2, 0]) - 30) >= 15, out[2, 2].tolist()
    assert abs(int(out[48, 48, 0]) - 190) >= 15, out[48, 48].tolist()
    assert abs(int(out[2, 2, 2]) - int(out[48, 48, 2])) >= 20, "frame collapsed to one colour"

    same, reason = grade_frame(src, src, scripts, template)
    assert same is not None, reason
    assert int(np.max(np.abs(same.astype(np.int16) - src.astype(np.int16)))) <= 2

    skipped, reason = grade_frame(src, ref, scripts, Path("/tmp/mxj-missing-grade-recipe.json"))
    assert skipped is None and reason, "a broken match should keep the original"

    with io.BytesIO() as webp:
        Image.fromarray(src, mode="RGB").save(webp, format="WEBP")
        webp.seek(0)
        with Image.open(webp) as opened:
            assert opened.format == "WEBP"
            loaded = np.asarray(opened.convert("RGB"))
    assert loaded.shape == src.shape

    import tempfile

    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        for fmt, name in (("JPEG", "a.jpg"), ("PNG", "a.png"), ("WEBP", "a.webp")):
            path = root / name
            Image.fromarray(src, mode="RGB").save(path, format=fmt)
            assert load_rgb(path).shape == src.shape
        avif = root / "a.avif"
        try:
            Image.fromarray(src, mode="RGB").save(avif, format="AVIF")
        except (KeyError, OSError, ValueError):
            pass
        else:
            assert load_rgb(avif).shape == src.shape
    print("colour-match self-check ok")


def main() -> int:
    if len(sys.argv) == 2 and sys.argv[1] == "--self-check":
        self_check()
        return 0

    import argparse

    parser = argparse.ArgumentParser(
        description="Grade the whole image toward a reference. Keep the original if the match cannot be applied."
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("reference", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--scripts", required=True, type=Path)
    parser.add_argument("--template", required=True, type=Path)
    args = parser.parse_args()

    source = load_rgb(args.source)
    reference = load_rgb(args.reference)
    with Image.open(args.source) as opened:
        alpha = opened.getchannel("A") if "A" in opened.getbands() else None
    matched, reason = grade_frame(source, reference, args.scripts, args.template)
    if matched is None:
        print(f"colour-match: skipped, kept original: {reason}", flush=True)
        matched = source
    else:
        print("colour-match: graded whole image toward reference", flush=True)
    if alpha is not None and alpha.size == (matched.shape[1], matched.shape[0]):
        graded = Image.fromarray(matched, mode="RGB")
        graded.putalpha(alpha)
        graded.save(args.output, format="PNG")
    else:
        save_png(args.output, matched)
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
