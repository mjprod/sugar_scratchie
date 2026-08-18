from __future__ import annotations

import json
import re
import shutil
import uuid
from pathlib import Path
from urllib.parse import quote

from fastapi import HTTPException, UploadFile
from pydantic import BaseModel, Field


CARD_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")

ORIGINAL_ID = "original"
ORIGINAL_BACKGROUND = "public/cards/ai girl 2.mp4"
ORIGINAL_FOREGROUND = "public/cards/Green bg sample 2 swap.mp4"
ORIGINAL_MESH = "tracked-mesh.json"


class PhotoInfo(BaseModel):
    id: str
    src: str


class CardInfo(BaseModel):
    id: str
    label: str
    background: str
    foreground: str
    mesh: str
    has_mesh: bool
    model_id: str | None = None
    sort_order: int = 0
    photos: list[PhotoInfo] = Field(default_factory=list)
    # Slots with 3 layers + per-slot photo mesh + 12 symbol points.
    photo_scratch_done: int = 0
    # Slots with any layer present but not fully done.
    photo_scratch_draft: int = 0
    # How many slots have a photo-scratch mesh / full symbols (not motion-card mesh).
    photo_scratch_mesh_count: int = 0
    photo_scratch_symbols_count: int = 0
    # Catalog theme id (e.g. "police"), persisted on card meta.
    theme_id: str | None = None
    # Collection trailer preview clip (separate from game background/foreground).
    trailer: str | None = None


class CreateCardRequest(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=120)
    background: str
    foreground: str
    model_id: str | None = None
    theme_id: str | None = None


class UpdateCardRequest(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=120)
    background: str | None = None
    foreground: str | None = None
    model_id: str | None = None
    theme_id: str | None = None
    sort_order: int | None = None


class ReorderCardsRequest(BaseModel):
    card_ids: list[str] = Field(min_length=1)


PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
TRAILER_EXTENSIONS = {".mp4", ".webm"}


def relative(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def safe_card_id(value: str) -> str:
    slug = re.sub(r"[^a-z0-9_]+", "_", value.strip().lower()).strip("_")
    if not slug or not CARD_ID_PATTERN.match(slug):
        raise HTTPException(
            status_code=400,
            detail="Card id must start with a letter and contain only lowercase letters, numbers, and underscores",
        )
    return slug


def public_url(workspace_path: str) -> str:
    trimmed = workspace_path.strip()
    if trimmed.startswith("public/"):
        trimmed = trimmed.removeprefix("public/")
    parts = [part for part in trimmed.split("/") if part]
    encoded = "/".join(quote(part) for part in parts)
    return f"/{encoded}"


def find_card_trailer(card_dir: Path, card_id: str) -> str | None:
    for ext in TRAILER_EXTENSIONS:
        candidate = card_dir / f"trailer{ext}"
        if candidate.is_file():
            return public_url(f"cards/{card_id}/trailer{ext}")
    return None


def mesh_names(mesh_dir: Path) -> set[str]:
    if not mesh_dir.exists():
        return set()
    return {path.name for path in mesh_dir.glob("*.json") if path.name != "index.json"}


def resolve_source(root: Path, value: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = root / path
    resolved = path.resolve()
    if root.resolve() not in resolved.parents and resolved != root.resolve():
        raise HTTPException(status_code=400, detail=f"Path is outside the project: {value}")
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail=f"Video not found: {value}")
    return resolved


def copy_video(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def card_paths(root: Path, cards_dir: Path, card_id: str) -> tuple[Path, Path]:
    if card_id == ORIGINAL_ID:
        return root / ORIGINAL_BACKGROUND, root / ORIGINAL_FOREGROUND
    card_dir = cards_dir / card_id
    return card_dir / "background.mp4", card_dir / "foreground.mp4"


def card_directory(cards_dir: Path, card_id: str) -> Path:
    if card_id == ORIGINAL_ID:
        return cards_dir
    return cards_dir / card_id


def card_photos_dir(cards_dir: Path, card_id: str) -> Path:
    if card_id == ORIGINAL_ID:
        raise HTTPException(status_code=400, detail="Cannot add photos to the original card")
    return cards_dir / card_id / "photos"


def prune_published_photo_scratch(root: Path, card_id: str) -> int:
    """Remove published photo-scratch game entries for a motion card.

    Entries are keyed `{card_id}_slot_XX` in public/photo-scratch/index.json.
    Returns how many entries were removed.
    """
    index_path = root / "public" / "photo-scratch" / "index.json"
    if not index_path.exists():
        return 0
    try:
        data = json.loads(index_path.read_text())
    except Exception:
        return 0
    if not isinstance(data, dict) or not isinstance(data.get("cards"), list):
        return 0
    prefix = f"{card_id}_"
    existing = [entry for entry in data["cards"] if isinstance(entry, dict)]
    kept = [entry for entry in existing if not str(entry.get("id", "")).startswith(prefix)]
    removed = len(existing) - len(kept)
    if removed:
        index_path.write_text(json.dumps({"cards": kept}, indent=2) + "\n")
    return removed


def compress_card(
    root: Path,
    cards_dir: Path,
    card_id: str,
    *,
    write_webm: bool = False,
    compress_preset: str = "mobile",
) -> None:
    """Re-encode a card's background/foreground in place using the same settings
    as the Video Flow finalize step. Originals are backed up under .video-backups/
    before being overwritten."""
    from backend.services.video_prep import (
        backup_video,
        compress_video,
        compress_video_webm,
        normalize_compress_preset,
    )

    background, foreground = card_paths(root, cards_dir, card_id)
    if not background.is_file() or not foreground.is_file():
        raise HTTPException(status_code=404, detail=f"Card videos not found: {card_id}")

    preset = normalize_compress_preset(compress_preset)
    backup_dir = root / ".video-backups"
    for src in (background, foreground):
        backup_video(src, backup_dir)
        tmp = src.with_name(f"{src.stem}-compress-tmp{src.suffix}")
        compress_video(src, tmp, preset=preset)
        shutil.move(str(tmp), str(src))
        if write_webm:
            compress_video_webm(src, src.with_suffix(".webm"), preset=preset)


PHOTO_SCRATCH_SLOT_COUNT = 10
PHOTO_SCRATCH_LAYER_NAMES = {"background", "bikini", "clothes"}

# Maps logical layer → (approved_field, pending_field)
PHOTO_SCRATCH_PENDING_FIELDS = {
    "background": ("background", "pending_bg"),
    "bikini": ("bikini", "pending_bikini"),
    "clothes": ("clothes", "pending_clothes"),
}


class PhotoScratchSlot(BaseModel):
    id: str
    label: str
    background: str | None = None
    bikini: str | None = None
    clothes: str | None = None
    pending_bg: str | None = None
    pending_bikini: str | None = None
    pending_clothes: str | None = None
    # Optional per-layer custom AI prompts for this slot.
    prompt_background: str | None = None
    prompt_bikini: str | None = None
    prompt_clothes: str | None = None
    # Per-slot static photo mesh (not the motion-card video mesh).
    mesh: str | None = None
    has_symbols: bool = False
    # Bikini + clothes are RGBA cutouts (girl without background) for the game.
    has_cutout: bool = False
    # Derived cutout PNG URLs (not stored in index — originals stay on bikini/clothes).
    bikini_cutout: str | None = None
    clothes_cutout: str | None = None
    # Pristine pre-zoom cutouts (Zooming live preview source).
    bikini_cutout_src: str | None = None
    clothes_cutout_src: str | None = None
    # Top warped onto bikini pose (before cutout).
    has_match: bool = False
    clothes_matched: str | None = None
    # Difference |bikini − matched| + 50/50 blend (Picture Flow Match QA).
    match_overlay: str | None = None
    match_blend: str | None = None
    match_pose_ok: bool = False
    match_iou: float | None = None
    # Picture Flow Adjust step confirmed (or cutout already exists — legacy).
    has_adjust: bool = False
    # Last manual nudge applied during match (from match_meta.json).
    match_nudge_scale: float | None = None
    match_nudge_tx: float | None = None
    match_nudge_ty: float | None = None
    # Picture Flow Zooming step confirmed (or mesh already exists — legacy).
    has_zoom: bool = False
    # Last zoom applied to cutouts (from zoom_meta.json).
    zoom_scale: float | None = None
    zoom_tx: float | None = None
    zoom_ty: float | None = None


PHOTO_SCRATCH_PROMPT_FIELDS = {
    "background": "prompt_background",
    "bikini": "prompt_bikini",
    "clothes": "prompt_clothes",
}


def _optional_str(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _photo_scratch_dir(cards_dir: Path, card_id: str) -> Path:
    return cards_dir / card_id / "photo-scratch"


def _photo_scratch_index_path(cards_dir: Path, card_id: str) -> Path:
    return _photo_scratch_dir(cards_dir, card_id) / "index.json"


def _default_slot_label(slot_id: str, theme: str) -> str:
    num = slot_id.replace("slot_", "")
    base = str(int(num)) if num.isdigit() else num
    return f"{theme.strip()} – {base}" if theme.strip() else f"Photo {base}"


def _read_photo_scratch_index(cards_dir: Path, card_id: str) -> list[dict]:
    path = _photo_scratch_index_path(cards_dir, card_id)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
        if isinstance(data, list):
            return data
    except Exception:
        pass
    return []


def list_photo_scratch_thumb_urls(cards_dir: Path, card_id: str) -> list[str]:
    """Fast collection thumbs from index.json only (no per-slot FS probes)."""
    raw = {
        entry["id"]: entry
        for entry in _read_photo_scratch_index(cards_dir, card_id)
        if isinstance(entry, dict) and isinstance(entry.get("id"), str)
    }
    urls: list[str] = []
    for index in range(PHOTO_SCRATCH_SLOT_COUNT):
        slot_id = f"slot_{index + 1:02d}"
        entry = raw.get(slot_id) or {}
        thumb = (
            entry.get("clothes")
            or entry.get("pending_clothes")
            or entry.get("bikini")
            or entry.get("pending_bikini")
            or entry.get("background")
            or entry.get("pending_bg")
            or ""
        )
        urls.append(thumb.strip() if isinstance(thumb, str) else "")
    return urls


_PHOTO_SCRATCH_LAYER_KEYS = (
    "background",
    "bikini",
    "clothes",
    "pending_bg",
    "pending_bikini",
    "pending_clothes",
)


def _slot_entry_layers_complete(entry: dict) -> bool:
    return bool(entry.get("background") and entry.get("bikini") and entry.get("clothes"))


def _slot_entry_has_any_layer(entry: dict) -> bool:
    return any(entry.get(key) for key in _PHOTO_SCRATCH_LAYER_KEYS)


def photo_scratch_slot_mesh_path(cards_dir: Path, card_id: str, slot_id: str) -> Path:
    return _photo_scratch_dir(cards_dir, card_id) / slot_id / "mesh.json"


def photo_scratch_slot_mesh_url(card_id: str, slot_id: str) -> str:
    return public_url(f"cards/{card_id}/photo-scratch/{slot_id}/mesh.json")


def photo_scratch_slot_has_mesh(cards_dir: Path, card_id: str, slot_id: str) -> bool:
    return photo_scratch_slot_mesh_path(cards_dir, card_id, slot_id).is_file()


def photo_scratch_slot_layers_complete(slot: PhotoScratchSlot) -> bool:
    return bool(slot.background and slot.bikini and slot.clothes)


def photo_scratch_slot_matched_clothes_path(
    cards_dir: Path, card_id: str, slot_id: str
) -> Path:
    return _photo_scratch_dir(cards_dir, card_id) / slot_id / "clothes_matched.jpg"


def photo_scratch_slot_matched_clothes_url(card_id: str, slot_id: str) -> str:
    return public_url(f"cards/{card_id}/photo-scratch/{slot_id}/clothes_matched.jpg")


def photo_scratch_slot_matched_bikini_path(
    cards_dir: Path, card_id: str, slot_id: str
) -> Path:
    return _photo_scratch_dir(cards_dir, card_id) / slot_id / "bikini_matched.jpg"


def photo_scratch_slot_match_overlay_path(
    cards_dir: Path, card_id: str, slot_id: str
) -> Path:
    return _photo_scratch_dir(cards_dir, card_id) / slot_id / "match_overlay.jpg"


def photo_scratch_slot_match_overlay_url(card_id: str, slot_id: str) -> str:
    return public_url(f"cards/{card_id}/photo-scratch/{slot_id}/match_overlay.jpg")


def photo_scratch_slot_match_blend_path(
    cards_dir: Path, card_id: str, slot_id: str
) -> Path:
    return _photo_scratch_dir(cards_dir, card_id) / slot_id / "match_blend.jpg"


def photo_scratch_slot_match_blend_url(card_id: str, slot_id: str) -> str:
    return public_url(f"cards/{card_id}/photo-scratch/{slot_id}/match_blend.jpg")


def photo_scratch_slot_match_meta_path(
    cards_dir: Path, card_id: str, slot_id: str
) -> Path:
    return _photo_scratch_dir(cards_dir, card_id) / slot_id / "match_meta.json"


def photo_scratch_slot_garment_mask_path(
    cards_dir: Path, card_id: str, slot_id: str
) -> Path:
    return _photo_scratch_dir(cards_dir, card_id) / slot_id / "garment_mask.png"


def photo_scratch_slot_has_match(cards_dir: Path, card_id: str, slot_id: str) -> bool:
    return photo_scratch_slot_matched_clothes_path(cards_dir, card_id, slot_id).is_file()


def _read_match_meta(cards_dir: Path, card_id: str, slot_id: str) -> dict:
    path = photo_scratch_slot_match_meta_path(cards_dir, card_id, slot_id)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_match_meta(cards_dir: Path, card_id: str, slot_id: str, meta: dict) -> None:
    path = photo_scratch_slot_match_meta_path(cards_dir, card_id, slot_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(meta, indent=2) + "\n")


def photo_scratch_slot_has_adjust(cards_dir: Path, card_id: str, slot_id: str) -> bool:
    """Adjust step done when confirmed, or cutout already exists (legacy slots)."""
    if photo_scratch_slot_has_cutout(cards_dir, card_id, slot_id):
        return True
    if not photo_scratch_slot_has_match(cards_dir, card_id, slot_id):
        return False
    return bool(_read_match_meta(cards_dir, card_id, slot_id).get("adjust_ok"))


def confirm_photo_scratch_slot_adjust(
    cards_dir: Path, card_id: str, slot_id: str, theme: str = ""
) -> PhotoScratchSlot:
    """Mark Match alignment as good enough to proceed to Cutout."""
    if card_id == ORIGINAL_ID:
        raise HTTPException(status_code=400, detail="Cannot adjust the original card")
    slots = list_photo_scratch_slots(cards_dir, card_id, theme)
    slot = _get_slot(slots, slot_id)
    if slot is None:
        raise HTTPException(status_code=404, detail=f"Slot not found: {slot_id}")
    if not photo_scratch_slot_has_match(cards_dir, card_id, slot_id):
        raise HTTPException(status_code=400, detail="Match bikini + top first")
    meta = _read_match_meta(cards_dir, card_id, slot_id)
    meta["adjust_ok"] = True
    _write_match_meta(cards_dir, card_id, slot_id, meta)
    return next(
        s for s in list_photo_scratch_slots(cards_dir, card_id, theme) if s.id == slot_id
    )


def photo_scratch_slot_cutout_path(
    cards_dir: Path, card_id: str, slot_id: str, layer: str
) -> Path:
    return _photo_scratch_dir(cards_dir, card_id) / slot_id / f"{layer}.png"


def photo_scratch_slot_cutout_src_path(
    cards_dir: Path, card_id: str, slot_id: str, layer: str
) -> Path:
    """Pristine cutout used as Zooming source (never overwritten by Apply scale)."""
    return _photo_scratch_dir(cards_dir, card_id) / slot_id / f"{layer}_src.png"


def photo_scratch_slot_cutout_url(card_id: str, slot_id: str, layer: str) -> str:
    return public_url(f"cards/{card_id}/photo-scratch/{slot_id}/{layer}.png")


def photo_scratch_slot_cutout_src_url(card_id: str, slot_id: str, layer: str) -> str:
    return public_url(f"cards/{card_id}/photo-scratch/{slot_id}/{layer}_src.png")


def photo_scratch_slot_zoom_meta_path(
    cards_dir: Path, card_id: str, slot_id: str
) -> Path:
    return _photo_scratch_dir(cards_dir, card_id) / slot_id / "zoom_meta.json"


def _read_zoom_meta(cards_dir: Path, card_id: str, slot_id: str) -> dict:
    path = photo_scratch_slot_zoom_meta_path(cards_dir, card_id, slot_id)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_zoom_meta(cards_dir: Path, card_id: str, slot_id: str, meta: dict) -> None:
    path = photo_scratch_slot_zoom_meta_path(cards_dir, card_id, slot_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(meta, indent=2) + "\n")


def _clear_zoom_artifacts(cards_dir: Path, card_id: str, slot_id: str) -> None:
    photo_scratch_slot_zoom_meta_path(cards_dir, card_id, slot_id).unlink(
        missing_ok=True
    )
    for layer in ("bikini", "clothes"):
        photo_scratch_slot_cutout_src_path(cards_dir, card_id, slot_id, layer).unlink(
            missing_ok=True
        )


def _invalidate_mesh_after_zoom(cards_dir: Path, card_id: str, slot_id: str) -> None:
    """Zoom changes cutout geometry — mesh + embedded symbols must be rebuilt."""
    photo_scratch_slot_mesh_path(cards_dir, card_id, slot_id).unlink(missing_ok=True)


def photo_scratch_slot_has_cutout(
    cards_dir: Path, card_id: str, slot_id: str, *, validate_alpha: bool = True
) -> bool:
    """True when bikini + clothes RGBA cutout PNGs exist (girl without scene).

    Set validate_alpha=False for cheap card-list counts (file presence only).
    """
    bikini = photo_scratch_slot_cutout_path(cards_dir, card_id, slot_id, "bikini")
    clothes = photo_scratch_slot_cutout_path(cards_dir, card_id, slot_id, "clothes")
    if not (bikini.is_file() and clothes.is_file()):
        return False
    if not validate_alpha:
        return True
    try:
        from PIL import Image

        for path in (bikini, clothes):
            with Image.open(path) as img:
                if img.mode not in ("RGBA", "LA"):
                    return False
                alpha = img.getchannel("A")
                # Need real transparency — not an opaque PNG rename.
                extrema = alpha.getextrema()
                if extrema is None or extrema[0] >= 250:
                    return False
        return True
    except Exception:
        return False


def photo_scratch_slot_has_zoom(
    cards_dir: Path, card_id: str, slot_id: str, *, validate_cutout: bool = True
) -> bool:
    """Zooming done when confirmed, or legacy (mesh + no pristine src yet)."""
    if not photo_scratch_slot_has_cutout(
        cards_dir, card_id, slot_id, validate_alpha=validate_cutout
    ):
        return False
    if bool(_read_zoom_meta(cards_dir, card_id, slot_id).get("zoom_ok")):
        return True
    # Pre-Zooming slots: already meshed and never wrote bikini_src.png.
    bikini_src = photo_scratch_slot_cutout_src_path(cards_dir, card_id, slot_id, "bikini")
    return photo_scratch_slot_has_mesh(cards_dir, card_id, slot_id) and not bikini_src.is_file()


def _mesh_has_complete_symbols(mesh_path: Path) -> bool:
    """True when mesh.json has 12 symbolPoints — without importing mesh_symbols."""
    if not mesh_path.is_file():
        return False
    try:
        data = json.loads(mesh_path.read_text(encoding="utf-8"))
        points = data.get("symbolPoints")
        return isinstance(points, list) and len(points) == 12
    except Exception:
        return False


def photo_scratch_slot_has_symbols(cards_dir: Path, card_id: str, slot_id: str) -> bool:
    return _mesh_has_complete_symbols(
        photo_scratch_slot_mesh_path(cards_dir, card_id, slot_id)
    )


def photo_scratch_slot_is_done(cards_dir: Path, card_id: str, slot: PhotoScratchSlot) -> bool:
    """Done = layers + match + cutouts + zoom + mesh + symbols.

    Prefer flags already computed on `slot` (from list_photo_scratch_slots) so
    card listings don't re-open every cutout PNG / remesh JSON.
    """
    del cards_dir, card_id
    return bool(
        slot.background
        and slot.bikini
        and slot.clothes
        and slot.has_match
        and slot.has_cutout
        and slot.has_zoom
        and slot.mesh
        and slot.has_symbols
    )


def _photo_scratch_card_counts(cards_dir: Path, card_id: str) -> tuple[int, int, int, int]:
    """Cheap (done, draft, mesh, symbols) counts — no PIL decode of cutouts."""
    raw = {
        entry["id"]: entry
        for entry in _read_photo_scratch_index(cards_dir, card_id)
        if isinstance(entry, dict) and entry.get("id")
    }
    done = 0
    draft = 0
    mesh_count = 0
    symbols_count = 0
    for i in range(1, PHOTO_SCRATCH_SLOT_COUNT + 1):
        slot_id = f"slot_{i:02d}"
        entry = raw.get(slot_id, {})
        has_layers = _slot_entry_layers_complete(entry)
        has_any_layer = _slot_entry_has_any_layer(entry)
        has_match = photo_scratch_slot_has_match(cards_dir, card_id, slot_id)
        has_cutout = photo_scratch_slot_has_cutout(
            cards_dir, card_id, slot_id, validate_alpha=False
        )
        has_mesh = photo_scratch_slot_has_mesh(cards_dir, card_id, slot_id)
        has_zoom = photo_scratch_slot_has_zoom(
            cards_dir, card_id, slot_id, validate_cutout=False
        )
        has_symbols = _mesh_has_complete_symbols(
            photo_scratch_slot_mesh_path(cards_dir, card_id, slot_id)
        )
        if has_mesh:
            mesh_count += 1
        if has_symbols:
            symbols_count += 1
        is_done = (
            has_layers
            and has_match
            and has_cutout
            and has_zoom
            and has_mesh
            and has_symbols
        )
        if is_done:
            done += 1
        elif has_any_layer:
            draft += 1
    return done, draft, mesh_count, symbols_count


def count_layers_complete_photo_scratch_slots(cards_dir: Path, card_id: str) -> int:
    return sum(
        1
        for entry in _read_photo_scratch_index(cards_dir, card_id)
        if isinstance(entry, dict) and _slot_entry_layers_complete(entry)
    )


def count_photo_scratch_mesh_slots(cards_dir: Path, card_id: str) -> int:
    return _photo_scratch_card_counts(cards_dir, card_id)[2]


def count_photo_scratch_symbols_slots(cards_dir: Path, card_id: str) -> int:
    return _photo_scratch_card_counts(cards_dir, card_id)[3]


def count_done_photo_scratch_slots(cards_dir: Path, card_id: str, mesh_dir: Path | None = None) -> int:
    """Count slots that are playable: 3 layers + per-slot mesh + symbols."""
    del mesh_dir  # kept for call-site compatibility; motion-card mesh is unused
    return _photo_scratch_card_counts(cards_dir, card_id)[0]


def count_draft_photo_scratch_slots(cards_dir: Path, card_id: str, mesh_dir: Path | None = None) -> int:
    """Count slots with any layer present but not fully done."""
    del mesh_dir
    return _photo_scratch_card_counts(cards_dir, card_id)[1]


def _write_photo_scratch_index(cards_dir: Path, card_id: str, slots: list[dict]) -> None:
    ps_dir = _photo_scratch_dir(cards_dir, card_id)
    ps_dir.mkdir(parents=True, exist_ok=True)
    _photo_scratch_index_path(cards_dir, card_id).write_text(
        json.dumps(slots, indent=2) + "\n"
    )


def list_photo_scratch_slots(
    cards_dir: Path, card_id: str, theme: str = ""
) -> list[PhotoScratchSlot]:
    """Always returns exactly PHOTO_SCRATCH_SLOT_COUNT slots, filling gaps with empties."""
    raw = {entry["id"]: entry for entry in _read_photo_scratch_index(cards_dir, card_id) if isinstance(entry, dict)}
    slots: list[PhotoScratchSlot] = []
    for i in range(1, PHOTO_SCRATCH_SLOT_COUNT + 1):
        slot_id = f"slot_{i:02d}"
        entry = raw.get(slot_id, {})
        label = entry.get("label") or _default_slot_label(slot_id, theme)
        mesh_path = photo_scratch_slot_mesh_path(cards_dir, card_id, slot_id)
        mesh_url = (
            photo_scratch_slot_mesh_url(card_id, slot_id) if mesh_path.is_file() else None
        )
        has_cutout = photo_scratch_slot_has_cutout(cards_dir, card_id, slot_id)
        has_match = photo_scratch_slot_has_match(cards_dir, card_id, slot_id)
        match_meta = _read_match_meta(cards_dir, card_id, slot_id) if has_match else {}
        zoom_meta = _read_zoom_meta(cards_dir, card_id, slot_id) if has_cutout else {}
        overlay_path = photo_scratch_slot_match_overlay_path(cards_dir, card_id, slot_id)
        blend_path = photo_scratch_slot_match_blend_path(cards_dir, card_id, slot_id)
        slots.append(
            PhotoScratchSlot(
                id=slot_id,
                label=label,
                background=entry.get("background") or None,
                bikini=entry.get("bikini") or None,
                clothes=entry.get("clothes") or None,
                pending_bg=entry.get("pending_bg") or None,
                pending_bikini=entry.get("pending_bikini") or None,
                pending_clothes=entry.get("pending_clothes") or None,
                prompt_background=_optional_str(entry.get("prompt_background")),
                prompt_bikini=_optional_str(entry.get("prompt_bikini")),
                prompt_clothes=_optional_str(entry.get("prompt_clothes")),
                mesh=mesh_url,
                has_symbols=photo_scratch_slot_has_symbols(cards_dir, card_id, slot_id),
                has_cutout=has_cutout,
                bikini_cutout=(
                    photo_scratch_slot_cutout_url(card_id, slot_id, "bikini")
                    if has_cutout
                    else None
                ),
                clothes_cutout=(
                    photo_scratch_slot_cutout_url(card_id, slot_id, "clothes")
                    if has_cutout
                    else None
                ),
                bikini_cutout_src=(
                    photo_scratch_slot_cutout_src_url(card_id, slot_id, "bikini")
                    if has_cutout
                    and photo_scratch_slot_cutout_src_path(
                        cards_dir, card_id, slot_id, "bikini"
                    ).is_file()
                    else None
                ),
                clothes_cutout_src=(
                    photo_scratch_slot_cutout_src_url(card_id, slot_id, "clothes")
                    if has_cutout
                    and photo_scratch_slot_cutout_src_path(
                        cards_dir, card_id, slot_id, "clothes"
                    ).is_file()
                    else None
                ),
                has_match=has_match,
                clothes_matched=(
                    photo_scratch_slot_matched_clothes_url(card_id, slot_id)
                    if has_match
                    else None
                ),
                match_overlay=(
                    photo_scratch_slot_match_overlay_url(card_id, slot_id)
                    if has_match and overlay_path.is_file()
                    else None
                ),
                match_blend=(
                    photo_scratch_slot_match_blend_url(card_id, slot_id)
                    if has_match and blend_path.is_file()
                    else None
                ),
                match_pose_ok=bool(match_meta.get("pose_ok", False)),
                match_iou=(
                    float(match_meta["iou"])
                    if isinstance(match_meta.get("iou"), (int, float))
                    else None
                ),
                has_adjust=has_cutout or bool(match_meta.get("adjust_ok")),
                match_nudge_scale=(
                    float(match_meta["nudge_scale"])
                    if isinstance(match_meta.get("nudge_scale"), (int, float))
                    else None
                ),
                match_nudge_tx=(
                    float(match_meta["nudge_tx"])
                    if isinstance(match_meta.get("nudge_tx"), (int, float))
                    else None
                ),
                match_nudge_ty=(
                    float(match_meta["nudge_ty"])
                    if isinstance(match_meta.get("nudge_ty"), (int, float))
                    else None
                ),
                has_zoom=photo_scratch_slot_has_zoom(cards_dir, card_id, slot_id),
                zoom_scale=(
                    float(zoom_meta["scale"])
                    if isinstance(zoom_meta.get("scale"), (int, float))
                    else None
                ),
                zoom_tx=(
                    float(zoom_meta["tx"])
                    if isinstance(zoom_meta.get("tx"), (int, float))
                    else None
                ),
                zoom_ty=(
                    float(zoom_meta["ty"])
                    if isinstance(zoom_meta.get("ty"), (int, float))
                    else None
                ),
            )
        )
    return slots


def _save_photo_scratch_slots(
    cards_dir: Path, card_id: str, slots: list[PhotoScratchSlot]
) -> None:
    # Derived fields — never persist them in index.json.
    skip = {
        "mesh",
        "has_symbols",
        "has_cutout",
        "bikini_cutout",
        "clothes_cutout",
        "bikini_cutout_src",
        "clothes_cutout_src",
        "has_match",
        "clothes_matched",
        "match_overlay",
        "match_blend",
        "match_pose_ok",
        "match_iou",
        "has_adjust",
        "match_nudge_scale",
        "match_nudge_tx",
        "match_nudge_ty",
        "has_zoom",
        "zoom_scale",
        "zoom_tx",
        "zoom_ty",
    }
    data = [
        {k: v for k, v in slot.dict().items() if v is not None and k not in skip}
        for slot in slots
    ]
    _write_photo_scratch_index(cards_dir, card_id, data)


def _get_slot(slots: list[PhotoScratchSlot], slot_id: str) -> PhotoScratchSlot | None:
    return next((s for s in slots if s.id == slot_id), None)


async def upload_photo_scratch_layer(
    root: Path,
    cards_dir: Path,
    card_id: str,
    slot_id: str,
    layer: str,
    upload: UploadFile,
    theme: str = "",
) -> PhotoScratchSlot:
    if layer not in PHOTO_SCRATCH_LAYER_NAMES:
        raise HTTPException(status_code=400, detail=f"Layer must be one of: {', '.join(sorted(PHOTO_SCRATCH_LAYER_NAMES))}")
    if card_id == ORIGINAL_ID:
        raise HTTPException(status_code=400, detail="Cannot add photo scratch to the original card")
    slots = list_photo_scratch_slots(cards_dir, card_id, theme)
    slot = _get_slot(slots, slot_id)
    if slot is None:
        raise HTTPException(status_code=404, detail=f"Slot not found: {slot_id}")

    original = Path(upload.filename or "").name
    ext = Path(original).suffix.lower()
    if ext not in PHOTO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Image must be JPG, PNG, or WebP")
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    layer_dir = _photo_scratch_dir(cards_dir, card_id) / slot_id
    layer_dir.mkdir(parents=True, exist_ok=True)
    # Replace any existing file for this layer.
    for old in layer_dir.glob(f"{layer}.*"):
        old.unlink(missing_ok=True)
    target = layer_dir / f"{layer}{ext}"
    target.write_bytes(data)

    src = public_url(f"cards/{card_id}/photo-scratch/{slot_id}/{layer}{ext}")
    setattr(slot, layer, src)
    _save_photo_scratch_slots(cards_dir, card_id, slots)
    return slot


def delete_photo_scratch_layer(
    cards_dir: Path, card_id: str, slot_id: str, layer: str, theme: str = ""
) -> PhotoScratchSlot:
    if layer not in PHOTO_SCRATCH_LAYER_NAMES:
        raise HTTPException(status_code=400, detail=f"Layer must be one of: {', '.join(sorted(PHOTO_SCRATCH_LAYER_NAMES))}")
    slots = list_photo_scratch_slots(cards_dir, card_id, theme)
    slot = _get_slot(slots, slot_id)
    if slot is None:
        raise HTTPException(status_code=404, detail=f"Slot not found: {slot_id}")

    layer_dir = _photo_scratch_dir(cards_dir, card_id) / slot_id
    for path in layer_dir.glob(f"{layer}.*"):
        path.unlink(missing_ok=True)
    setattr(slot, layer, None)
    _save_photo_scratch_slots(cards_dir, card_id, slots)
    return slot


def set_photo_scratch_pending_layer(
    cards_dir: Path,
    card_id: str,
    slot_id: str,
    layer_type: str,
    pending_src: str,
    theme: str = "",
) -> None:
    """Write a pending_<layer> URL into the slot index (called from the generation job)."""
    fields = PHOTO_SCRATCH_PENDING_FIELDS.get(layer_type)
    if fields is None:
        raise HTTPException(
            status_code=400,
            detail=f"Layer must be one of: {', '.join(sorted(PHOTO_SCRATCH_PENDING_FIELDS))}",
        )
    _, pending_field = fields
    slots = list_photo_scratch_slots(cards_dir, card_id, theme)
    slot = _get_slot(slots, slot_id)
    if slot is None:
        return
    setattr(slot, pending_field, pending_src)
    _save_photo_scratch_slots(cards_dir, card_id, slots)


def approve_photo_scratch_layer(
    cards_dir: Path, card_id: str, slot_id: str, layer_type: str, theme: str = ""
) -> PhotoScratchSlot:
    """Promote pending_<layer> → the approved layer field."""
    fields = PHOTO_SCRATCH_PENDING_FIELDS.get(layer_type)
    if fields is None:
        raise HTTPException(
            status_code=400,
            detail=f"Layer must be one of: {', '.join(sorted(PHOTO_SCRATCH_PENDING_FIELDS))}",
        )
    approved_field, pending_field = fields
    slots = list_photo_scratch_slots(cards_dir, card_id, theme)
    slot = _get_slot(slots, slot_id)
    if slot is None:
        raise HTTPException(status_code=404, detail=f"Slot not found: {slot_id}")
    pending = getattr(slot, pending_field)
    if not pending:
        raise HTTPException(status_code=400, detail=f"No pending {layer_type} to approve")
    setattr(slot, approved_field, pending)
    setattr(slot, pending_field, None)
    _save_photo_scratch_slots(cards_dir, card_id, slots)
    return slot


def reject_photo_scratch_layer(
    cards_dir: Path, card_id: str, slot_id: str, layer_type: str, theme: str = ""
) -> PhotoScratchSlot:
    """Clear pending_<layer> without promoting it."""
    fields = PHOTO_SCRATCH_PENDING_FIELDS.get(layer_type)
    if fields is None:
        raise HTTPException(
            status_code=400,
            detail=f"Layer must be one of: {', '.join(sorted(PHOTO_SCRATCH_PENDING_FIELDS))}",
        )
    _, pending_field = fields
    slots = list_photo_scratch_slots(cards_dir, card_id, theme)
    slot = _get_slot(slots, slot_id)
    if slot is None:
        raise HTTPException(status_code=404, detail=f"Slot not found: {slot_id}")
    setattr(slot, pending_field, None)
    _save_photo_scratch_slots(cards_dir, card_id, slots)
    return slot


def set_photo_scratch_slot_prompt(
    cards_dir: Path,
    card_id: str,
    slot_id: str,
    layer: str,
    prompt: str,
    theme: str = "",
) -> PhotoScratchSlot:
    """Persist an optional per-slot, per-layer custom prompt (empty clears it)."""
    field = PHOTO_SCRATCH_PROMPT_FIELDS.get(layer)
    if field is None:
        raise HTTPException(
            status_code=400,
            detail=f"Layer must be one of: {', '.join(sorted(PHOTO_SCRATCH_PROMPT_FIELDS))}",
        )
    slots = list_photo_scratch_slots(cards_dir, card_id, theme)
    slot = _get_slot(slots, slot_id)
    if slot is None:
        raise HTTPException(status_code=404, detail=f"Slot not found: {slot_id}")
    setattr(slot, field, prompt.strip() or None)
    _save_photo_scratch_slots(cards_dir, card_id, slots)
    return slot


def slot_layer_prompt(slot: PhotoScratchSlot, layer: str) -> str:
    field = PHOTO_SCRATCH_PROMPT_FIELDS.get(layer)
    if not field:
        return ""
    return (getattr(slot, field, None) or "").strip()


def _resolve_public_media(root: Path, src: str) -> Path:
    """Map a public URL like /cards/id/photo-scratch/... to a filesystem path."""
    trimmed = src.strip()
    if trimmed.startswith("/"):
        trimmed = trimmed[1:]
    if trimmed.startswith("public/"):
        path = root / trimmed
    else:
        path = root / "public" / trimmed
    return path


def match_photo_scratch_slot(
    root: Path,
    cards_dir: Path,
    card_id: str,
    slot_id: str,
    theme: str = "",
    *,
    relock: bool = False,
    nudge_scale: float = 1.0,
    nudge_tx: float = 0.0,
    nudge_ty: float = 0.0,
    confirm_adjust: bool = False,
) -> PhotoScratchSlot:
    """Register bikini + top on the game canvas for cutout.

    Default: ORB similarity + face polish (AI tops still drift scale/framing).
    ``relock=True``: optional AI re-dress when limbs clearly drifted pose.
    Optional ``nudge_*`` applies a final manual affine to every match.
    ``confirm_adjust=True`` marks the Adjust step done (Picture Flow).
    """
    import shutil

    from backend.services.photo_match import match_clothes_to_bikini, relock_clothes_from_bikini

    if card_id == ORIGINAL_ID:
        raise HTTPException(status_code=400, detail="Cannot match the original card")
    slots = list_photo_scratch_slots(cards_dir, card_id, theme)
    slot = _get_slot(slots, slot_id)
    if slot is None:
        raise HTTPException(status_code=404, detail=f"Slot not found: {slot_id}")
    if not (slot.bikini and slot.clothes):
        raise HTTPException(
            status_code=400,
            detail="Approve bikini and top first — match needs both girl layers",
        )

    bikini_path = _resolve_public_media(root, slot.bikini)
    clothes_path = _resolve_public_media(root, slot.clothes)
    if not bikini_path.is_file():
        raise HTTPException(status_code=404, detail=f"Bikini image not found: {slot.bikini}")
    if not clothes_path.is_file():
        raise HTTPException(status_code=404, detail=f"Top image not found: {slot.clothes}")

    slot_dir = _photo_scratch_dir(cards_dir, card_id) / slot_id
    slot_dir.mkdir(parents=True, exist_ok=True)
    # Always refresh composites from the approved index URLs (avoid stale *_full).
    bikini_full = slot_dir / f"bikini_full{bikini_path.suffix.lower()}"
    clothes_full = slot_dir / f"clothes_full{clothes_path.suffix.lower()}"
    if bikini_path.resolve() != bikini_full.resolve():
        shutil.copy2(bikini_path, bikini_full)
    if clothes_path.resolve() != clothes_full.resolve():
        shutil.copy2(clothes_path, clothes_full)

    clothes_for_match = clothes_full
    ai_relock = False
    if relock:
        provider = "xai"
        image_model = "grok-imagine"
        try:
            from backend.services.video_flow import read_flow_draft

            draft = read_flow_draft(card_id) or {}
            provider = str(draft.get("ai_provider") or provider)
            image_model = str(draft.get("source_image_model") or image_model)
        except Exception:
            pass
        clothes_locked = slot_dir / "clothes_locked.jpg"
        try:
            relock_clothes_from_bikini(
                bikini_full,
                clothes_full,
                clothes_locked,
                provider=provider,
                image_model=image_model,
                theme=theme or "",
            )
            clothes_for_match = clothes_locked
            ai_relock = True
        except Exception as exc:
            print(
                f"AI pose-lock failed ({exc}); registering approved top as-is",
                flush=True,
            )

    out = photo_scratch_slot_matched_clothes_path(cards_dir, card_id, slot_id)
    bikini_matched = photo_scratch_slot_matched_bikini_path(cards_dir, card_id, slot_id)
    overlay = photo_scratch_slot_match_overlay_path(cards_dir, card_id, slot_id)
    blend = photo_scratch_slot_match_blend_path(cards_dir, card_id, slot_id)
    garment_mask = photo_scratch_slot_garment_mask_path(cards_dir, card_id, slot_id)
    meta_path = photo_scratch_slot_match_meta_path(cards_dir, card_id, slot_id)
    try:
        stats = match_clothes_to_bikini(
            bikini_full,
            clothes_for_match,
            out,
            overlay,
            bikini_matched_path=bikini_matched,
            blend_path=blend,
            garment_mask_path=garment_mask,
            mode="register",
            nudge_scale=nudge_scale,
            nudge_tx=nudge_tx,
            nudge_ty=nudge_ty,
        )
        stats["ai_relock"] = ai_relock
        if ai_relock:
            stats["method"] = f"ai-relock + {stats.get('method', 'geom')}"
        # Match step clears Adjust; Adjust step re-confirms after a nudge.
        stats["adjust_ok"] = bool(confirm_adjust)
        meta_path.write_text(json.dumps(stats, indent=2) + "\n")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Rematch invalidates both cutouts + zoom sources.
    photo_scratch_slot_cutout_path(cards_dir, card_id, slot_id, "clothes").unlink(
        missing_ok=True
    )
    photo_scratch_slot_cutout_path(cards_dir, card_id, slot_id, "bikini").unlink(
        missing_ok=True
    )
    _clear_zoom_artifacts(cards_dir, card_id, slot_id)

    return next(
        s for s in list_photo_scratch_slots(cards_dir, card_id, theme) if s.id == slot_id
    )


def cutout_photo_scratch_slot(
    root: Path, cards_dir: Path, card_id: str, slot_id: str, theme: str = ""
) -> PhotoScratchSlot:
    """Cut girl out of matched bikini + clothes into RGBA PNGs.

    Keeps the approved original composites on the slot (bikini/clothes URLs
    unchanged). Cutouts live beside them as slot_XX/{bikini,clothes}.png and are
    detected via has_cutout / used at publish time.

    Uses a shared BiRefNet matte from the bikini plate so hair/skin edges match
    byte-for-byte; the top only extends alpha where the garment grows past the
    bikini silhouette (skirts / loose sleeves).
    """
    from backend.services.photo_cutout import cutout_matched_pair

    if card_id == ORIGINAL_ID:
        raise HTTPException(status_code=400, detail="Cannot cut out the original card")
    slots = list_photo_scratch_slots(cards_dir, card_id, theme)
    slot = _get_slot(slots, slot_id)
    if slot is None:
        raise HTTPException(status_code=404, detail=f"Slot not found: {slot_id}")
    if not (slot.bikini and slot.clothes):
        raise HTTPException(
            status_code=400,
            detail="Approve bikini and top first — cutout needs both girl layers",
        )
    if not photo_scratch_slot_has_match(cards_dir, card_id, slot_id):
        raise HTTPException(
            status_code=400,
            detail="Match bikini + top first — cutout needs aligned layers",
        )

    slot_dir = _photo_scratch_dir(cards_dir, card_id) / slot_id
    slot_dir.mkdir(parents=True, exist_ok=True)
    matched_clothes = photo_scratch_slot_matched_clothes_path(cards_dir, card_id, slot_id)
    matched_bikini = photo_scratch_slot_matched_bikini_path(cards_dir, card_id, slot_id)
    if not matched_clothes.is_file() or not matched_bikini.is_file():
        raise HTTPException(
            status_code=400,
            detail="Match bikini + top first — cutout needs aligned layers",
        )

    garment_mask = photo_scratch_slot_garment_mask_path(cards_dir, card_id, slot_id)
    bikini_out = photo_scratch_slot_cutout_path(cards_dir, card_id, slot_id, "bikini")
    clothes_out = photo_scratch_slot_cutout_path(cards_dir, card_id, slot_id, "clothes")
    cutout_matched_pair(
        matched_bikini,
        matched_clothes,
        bikini_out,
        clothes_out,
        garment_mask_path=garment_mask if garment_mask.is_file() else None,
    )

    # Pristine sources for Zooming; reset any prior zoom.
    import shutil

    bikini_src = photo_scratch_slot_cutout_src_path(cards_dir, card_id, slot_id, "bikini")
    clothes_src = photo_scratch_slot_cutout_src_path(
        cards_dir, card_id, slot_id, "clothes"
    )
    shutil.copy2(bikini_out, bikini_src)
    shutil.copy2(clothes_out, clothes_src)
    photo_scratch_slot_zoom_meta_path(cards_dir, card_id, slot_id).unlink(
        missing_ok=True
    )

    # Do not rewrite bikini/clothes — originals stay in the index.
    return next(
        s for s in list_photo_scratch_slots(cards_dir, card_id, theme) if s.id == slot_id
    )


def zoom_photo_scratch_slot(
    cards_dir: Path,
    card_id: str,
    slot_id: str,
    theme: str = "",
    *,
    scale: float = 1.0,
    tx: float = 0.0,
    ty: float = 0.0,
    confirm: bool = False,
    apply: bool = False,
) -> PhotoScratchSlot:
    """Scale cutouts about canvas center (Picture Flow Zooming).

    ``apply=True`` rewrites active PNGs from pristine sources and clears mesh.
    ``confirm=True`` (or apply) marks the step done.
    """
    import shutil

    from backend.services.photo_zoom import zoom_cutout_pair

    if card_id == ORIGINAL_ID:
        raise HTTPException(status_code=400, detail="Cannot zoom the original card")
    if not apply and not confirm:
        raise HTTPException(
            status_code=400, detail="Pass apply=true and/or confirm=true"
        )
    slots = list_photo_scratch_slots(cards_dir, card_id, theme)
    slot = _get_slot(slots, slot_id)
    if slot is None:
        raise HTTPException(status_code=404, detail=f"Slot not found: {slot_id}")
    if not photo_scratch_slot_has_cutout(cards_dir, card_id, slot_id):
        raise HTTPException(status_code=400, detail="Cut out girl first")

    bikini_out = photo_scratch_slot_cutout_path(cards_dir, card_id, slot_id, "bikini")
    clothes_out = photo_scratch_slot_cutout_path(cards_dir, card_id, slot_id, "clothes")
    bikini_src = photo_scratch_slot_cutout_src_path(cards_dir, card_id, slot_id, "bikini")
    clothes_src = photo_scratch_slot_cutout_src_path(
        cards_dir, card_id, slot_id, "clothes"
    )

    # Legacy cutouts (pre-Zooming): seed pristine from the current active PNGs.
    if not bikini_src.is_file() and bikini_out.is_file():
        shutil.copy2(bikini_out, bikini_src)
    if not clothes_src.is_file() and clothes_out.is_file():
        shutil.copy2(clothes_out, clothes_src)
    if not (bikini_src.is_file() and clothes_src.is_file()):
        raise HTTPException(
            status_code=400,
            detail="Cutout sources missing — re-run Cut out girl",
        )

    meta = _read_zoom_meta(cards_dir, card_id, slot_id)

    if apply:
        prev_scale = float(meta["scale"]) if isinstance(meta.get("scale"), (int, float)) else 1.0
        prev_tx = float(meta["tx"]) if isinstance(meta.get("tx"), (int, float)) else 0.0
        prev_ty = float(meta["ty"]) if isinstance(meta.get("ty"), (int, float)) else 0.0
        try:
            applied = zoom_cutout_pair(
                bikini_src,
                clothes_src,
                bikini_out,
                clothes_out,
                scale=scale,
                tx=tx,
                ty=ty,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        meta.update(applied)
        # Rebuild mesh when geometry changes (or first non-identity bake).
        changed = (
            abs(scale - prev_scale) >= 1e-4
            or abs(tx - prev_tx) >= 1e-3
            or abs(ty - prev_ty) >= 1e-3
        )
        non_identity = (
            abs(scale - 1.0) >= 1e-4 or abs(tx) >= 1e-3 or abs(ty) >= 1e-3
        )
        if changed or non_identity:
            _invalidate_mesh_after_zoom(cards_dir, card_id, slot_id)

    if apply or confirm:
        meta["zoom_ok"] = True
        if "scale" not in meta:
            meta["scale"] = round(float(scale), 4)
            meta["tx"] = round(float(tx), 2)
            meta["ty"] = round(float(ty), 2)
        _write_zoom_meta(cards_dir, card_id, slot_id, meta)

    return next(
        s for s in list_photo_scratch_slots(cards_dir, card_id, theme) if s.id == slot_id
    )


def generate_photo_scratch_slot_mesh(
    root: Path, cards_dir: Path, card_id: str, slot_id: str, theme: str = ""
) -> PhotoScratchSlot:
    """Build a static identity mesh for one photo-scratch slot from its TOP (or bikini)."""
    from backend.services.photo_mesh import generate_static_photo_mesh

    if card_id == ORIGINAL_ID:
        raise HTTPException(status_code=400, detail="Cannot mesh the original card")
    slots = list_photo_scratch_slots(cards_dir, card_id, theme)
    slot = _get_slot(slots, slot_id)
    if slot is None:
        raise HTTPException(status_code=404, detail=f"Slot not found: {slot_id}")
    if not photo_scratch_slot_has_cutout(cards_dir, card_id, slot_id):
        raise HTTPException(
            status_code=400,
            detail="Cut out girl first — mesh needs RGBA cutouts",
        )
    if not photo_scratch_slot_has_zoom(cards_dir, card_id, slot_id):
        raise HTTPException(
            status_code=400,
            detail="Finish Zooming first (Apply scale or Looks good)",
        )
    # Prefer TOP cutout PNG when present (cleaner person boundary), else the
    # approved original composite. Bikini stills often under-detect clothing.
    cutout_clothes = photo_scratch_slot_cutout_path(cards_dir, card_id, slot_id, "clothes")
    cutout_bikini = photo_scratch_slot_cutout_path(cards_dir, card_id, slot_id, "bikini")
    if cutout_clothes.is_file():
        image_path = cutout_clothes
        layer_src = photo_scratch_slot_cutout_url(card_id, slot_id, "clothes")
    elif cutout_bikini.is_file():
        image_path = cutout_bikini
        layer_src = photo_scratch_slot_cutout_url(card_id, slot_id, "bikini")
    else:
        layer_src = slot.clothes or slot.bikini
        if not layer_src:
            raise HTTPException(
                status_code=400,
                detail="Approve top (clothes) on this card before creating a mesh",
            )
        image_path = _resolve_public_media(root, layer_src)
    if not image_path.is_file():
        raise HTTPException(status_code=404, detail=f"Layer image not found: {layer_src}")

    out = photo_scratch_slot_mesh_path(cards_dir, card_id, slot_id)
    zoom_meta = _read_zoom_meta(cards_dir, card_id, slot_id)
    zoom_payload = None
    if zoom_meta:
        zoom_payload = {
            "scale": float(zoom_meta.get("scale", 1.0)),
            "tx": float(zoom_meta.get("tx", 0.0)),
            "ty": float(zoom_meta.get("ty", 0.0)),
        }
    generate_static_photo_mesh(
        image_path,
        out,
        source_label=f"photo-scratch {card_id}/{slot_id}",
        zoom=zoom_payload,
    )
    # Refresh derived fields.
    return next(
        s for s in list_photo_scratch_slots(cards_dir, card_id, theme) if s.id == slot_id
    )


def read_photo_scratch_slot_symbols(
    cards_dir: Path, card_id: str, slot_id: str
) -> list[dict[str, float]]:
    from backend.services.mesh_symbols import read_symbol_points

    path = photo_scratch_slot_mesh_path(cards_dir, card_id, slot_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Mesh not found — create mesh first")
    return read_symbol_points(path)


def write_photo_scratch_slot_symbols(
    cards_dir: Path, card_id: str, slot_id: str, points: list[dict[str, float]]
) -> PhotoScratchSlot:
    from backend.services.mesh_symbols import write_symbol_points

    path = photo_scratch_slot_mesh_path(cards_dir, card_id, slot_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Mesh not found — create mesh first")
    try:
        write_symbol_points(path, points)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return next(s for s in list_photo_scratch_slots(cards_dir, card_id) if s.id == slot_id)


def publish_photo_scratch_game(
    root: Path,
    cards_dir: Path,
    card_id: str,
    mesh_dir: Path | None = None,
    slot_id: str | None = None,
    themes_dir: Path | None = None,
) -> dict[str, object]:
    """Publish fully-done photo-scratch slot(s) into public/photo-scratch/index.json.

    Pass `slot_id` to publish one finished card; omit it to publish every done slot.
    Intro clips are resolved from the card's catalog theme (not per motion card).
    """
    del mesh_dir
    if card_id == ORIGINAL_ID:
        raise HTTPException(status_code=400, detail="Cannot publish the original card as a photo game")
    card_dir = cards_dir / card_id
    if not card_dir.is_dir():
        raise HTTPException(status_code=404, detail=f"Card not found: {card_id}")

    slots = list_photo_scratch_slots(cards_dir, card_id)
    if slot_id:
        slot = _get_slot(slots, slot_id)
        if slot is None:
            raise HTTPException(status_code=404, detail=f"Slot not found: {slot_id}")
        if not photo_scratch_slot_is_done(cards_dir, card_id, slot):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"{slot_id} is not done yet "
                    "(need layers + Match + Cutout + Zooming + Create mesh + 12 symbols)"
                ),
            )
        done = [slot]
    else:
        done = [slot for slot in slots if photo_scratch_slot_is_done(cards_dir, card_id, slot)]
        if not done:
            raise HTTPException(
                status_code=400,
                detail=(
                    "No fully done photo-scratch slots "
                    "(need layers + Match + Cutout + Zooming + Create mesh + 12 symbols per card)"
                ),
            )

    model_id = None
    theme_id = None
    import backend.db.engine as db_engine
    from backend.cards_store import card_model_theme_ids

    db_engine.get_engine()
    assert db_engine.SessionLocal is not None
    session = db_engine.SessionLocal()
    try:
        model_id, theme_id = card_model_theme_ids(session, card_id)
    finally:
        session.close()
    intro_url: str | None = None
    if theme_id and themes_dir is not None:
        from backend.themes_store import find_theme_intro

        intro_url = find_theme_intro(themes_dir, theme_id)
    prefix = f"{card_id}_"
    new_entries = []
    for slot in done:
        # Game needs RGBA cutouts; index still stores original composites.
        bikini_url = photo_scratch_slot_cutout_url(card_id, slot.id, "bikini")
        clothes_url = photo_scratch_slot_cutout_url(card_id, slot.id, "clothes")
        new_entries.append(
            {
                "id": f"{card_id}_{slot.id}",
                "label": slot.label,
                **({"model_id": model_id} if model_id else {}),
                **({"theme_id": theme_id} if theme_id else {}),
                "background": slot.background,
                "bikini": bikini_url,
                "clothes": clothes_url,
                "mesh": slot.mesh or photo_scratch_slot_mesh_url(card_id, slot.id),
                **({"intro": intro_url} if intro_url else {}),
            }
        )

    game_dir = root / "public" / "photo-scratch"
    game_dir.mkdir(parents=True, exist_ok=True)
    index_path = game_dir / "index.json"
    existing: list[dict] = []
    if index_path.exists():
        try:
            data = json.loads(index_path.read_text())
            if isinstance(data, dict) and isinstance(data.get("cards"), list):
                existing = [entry for entry in data["cards"] if isinstance(entry, dict)]
        except Exception:
            existing = []

    if slot_id:
        # Replace only this slot entry; keep other published slots for the card.
        entry_id = f"{card_id}_{slot_id}"
        kept = [entry for entry in existing if str(entry.get("id", "")) != entry_id]
        payload = {"cards": [*kept, *new_entries]}
    else:
        kept = [entry for entry in existing if not str(entry.get("id", "")).startswith(prefix)]
        payload = {"cards": [*kept, *new_entries]}
    index_path.write_text(json.dumps(payload, indent=2) + "\n")
    return {
        "published": len(new_entries),
        "card_id": card_id,
        "first_id": new_entries[0]["id"] if new_entries else None,
        "slot_id": slot_id,
    }


def set_photo_scratch_pending_bg(
    cards_dir: Path, card_id: str, slot_id: str, pending_src: str, theme: str = ""
) -> None:
    """Thin wrapper — prefer set_photo_scratch_pending_layer."""
    set_photo_scratch_pending_layer(cards_dir, card_id, slot_id, "background", pending_src, theme)


def approve_photo_scratch_bg(
    cards_dir: Path, card_id: str, slot_id: str, theme: str = ""
) -> PhotoScratchSlot:
    """Thin wrapper — prefer approve_photo_scratch_layer."""
    return approve_photo_scratch_layer(cards_dir, card_id, slot_id, "background", theme)


def reject_photo_scratch_bg(
    cards_dir: Path, card_id: str, slot_id: str, theme: str = ""
) -> PhotoScratchSlot:
    """Thin wrapper — prefer reject_photo_scratch_layer."""
    return reject_photo_scratch_layer(cards_dir, card_id, slot_id, "background", theme)
