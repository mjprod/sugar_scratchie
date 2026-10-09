#!/usr/bin/env python3
"""Re-encode existing model avatars, covers and theme avatars to resized WebP.

New uploads are already optimized by backend/models_store.py; this converts
files that were uploaded before that. Runs in place under public/models/ and
keeps each original under .image-backups/models/.

    .venv/bin/python scripts/optimize-model-media.py --dry-run
    .venv/bin/python scripts/optimize-model-media.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.models_store import (  # noqa: E402
    AVATAR_EXTENSIONS,
    AVATAR_MAX_PX,
    COVER_MAX_PX,
    image_backup_dir,
    write_optimized_still,
)

DEFAULT_MODELS_DIR = ROOT / "public" / "models"


def _targets(models_dir: Path) -> list[tuple[Path, str, int]]:
    """(directory, stem, max_px) for every still that exists on disk."""
    found: list[tuple[Path, str, int]] = []
    for model_dir in sorted(p for p in models_dir.iterdir() if p.is_dir()):
        found.append((model_dir, "avatar", AVATAR_MAX_PX))
        found.append((model_dir, "cover", COVER_MAX_PX))
        themes = model_dir / "themes"
        if themes.is_dir():
            for theme_dir in sorted(p for p in themes.iterdir() if p.is_dir()):
                found.append((theme_dir, "avatar", AVATAR_MAX_PX))
    return found


def _source(directory: Path, stem: str) -> Path | None:
    """Prefer a non-WebP original only when it is newer than the WebP."""
    candidates = [directory / f"{stem}{ext}" for ext in sorted(AVATAR_EXTENSIONS)]
    existing = [p for p in candidates if p.is_file()]
    if not existing:
        return None
    newest = max(existing, key=lambda p: p.stat().st_mtime)
    if newest.suffix == ".webp":
        newer_non_webp = [p for p in existing if p.suffix != ".webp" and p.stat().st_mtime >= newest.stat().st_mtime]
        if newer_non_webp:
            return max(newer_non_webp, key=lambda p: p.stat().st_mtime)
    return newest


def _already_optimized(path: Path, max_px: int) -> bool:
    from PIL import Image

    if path.suffix != ".webp":
        return False
    with Image.open(path) as img:
        return max(img.size) <= max_px


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    parser.add_argument("--models-dir", type=Path, default=DEFAULT_MODELS_DIR)
    args = parser.parse_args()

    if not args.models_dir.is_dir():
        print(f"No models dir at {args.models_dir}", file=sys.stderr)
        return 1

    before_total = after_total = 0
    for directory, stem, max_px in _targets(args.models_dir):
        src = _source(directory, stem)
        if src is None or _already_optimized(src, max_px):
            continue
        rel = src.relative_to(args.models_dir)
        data = src.read_bytes()
        before_total += len(data)
        if args.dry_run:
            print(f"would convert {rel} ({len(data) // 1024} KB, max {max_px}px)")
            continue
        backup = image_backup_dir(args.models_dir, *rel.parent.parts) / src.name
        # Re-running over an already-optimized .webp must not clobber the real original.
        has_backup = any(backup.parent.glob(f"{stem}.*"))
        out = write_optimized_still(
            directory,
            stem,
            data,
            max_px,
            backup=None if src.suffix == ".webp" and has_backup else backup,
        )
        size = out.stat().st_size
        after_total += size
        print(f"{rel} -> {out.name}: {len(data) // 1024} KB -> {size // 1024} KB")

    if not args.dry_run and before_total:
        print(f"total {before_total // 1024} KB -> {after_total // 1024} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
