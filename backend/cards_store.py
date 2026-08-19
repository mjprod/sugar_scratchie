from __future__ import annotations

import json
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from backend.cards import (
    CARD_ID_PATTERN,
    ORIGINAL_BACKGROUND,
    ORIGINAL_FOREGROUND,
    ORIGINAL_ID,
    ORIGINAL_MESH,
    PHOTO_EXTENSIONS,
    TRAILER_EXTENSIONS,
    CardInfo,
    CreateCardRequest,
    PhotoInfo,
    UpdateCardRequest,
    card_paths,
    card_photos_dir,
    copy_video,
    find_card_trailer,
    mesh_names,
    public_url,
    relative,
    resolve_source,
    safe_card_id,
)
from backend.photo_scratch_store import prune_published_photo_scratch
from backend.db.models import Creator, MotionCard, Theme


def _photo_counts(cards_dir: Path, card_id: str) -> tuple[int, int, int, int]:
    from backend.cards import _photo_scratch_card_counts

    return _photo_scratch_card_counts(cards_dir, card_id)


def _read_legacy_meta(card_dir: Path, default_label: str) -> dict:
    meta = card_dir / "meta.json"
    if not meta.exists():
        return {"label": default_label}
    try:
        data = json.loads(meta.read_text())
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {"label": default_label}


def _photos_from_json(raw: Any) -> list[PhotoInfo]:
    if not isinstance(raw, list):
        return []
    photos: list[PhotoInfo] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        photo_id = entry.get("id")
        src = entry.get("src")
        if isinstance(photo_id, str) and photo_id.strip() and isinstance(src, str) and src.strip():
            photos.append(PhotoInfo(id=photo_id.strip(), src=src.strip()))
    return photos


def _photos_to_json(photos: list[PhotoInfo]) -> list[dict[str, str]]:
    return [{"id": photo.id, "src": photo.src} for photo in photos]


def _original_card(root: Path, cards_dir: Path, mesh_dir: Path) -> CardInfo:
    del root  # paths are constants under public/
    meshes = mesh_names(mesh_dir)
    return CardInfo(
        id=ORIGINAL_ID,
        label="Original",
        background=ORIGINAL_BACKGROUND,
        foreground=ORIGINAL_FOREGROUND,
        mesh=ORIGINAL_MESH,
        has_mesh=ORIGINAL_MESH in meshes,
        sort_order=0,
    )


def _row_to_info(
    row: MotionCard,
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
) -> CardInfo | None:
    card_dir = cards_dir / row.id
    background = card_dir / "background.mp4"
    foreground = card_dir / "foreground.mp4"
    if not background.is_file() or not foreground.is_file():
        return None
    meshes = mesh_names(mesh_dir)
    mesh = f"{row.id}.json"
    done, draft, mesh_count, symbols_count = _photo_counts(cards_dir, row.id)
    return CardInfo(
        id=row.id,
        label=row.label,
        background=relative(root, background),
        foreground=relative(root, foreground),
        mesh=mesh,
        has_mesh=mesh in meshes,
        model_id=row.model_id,
        sort_order=row.sort_order,
        photos=_photos_from_json(row.photos),
        photo_scratch_done=done,
        photo_scratch_draft=draft,
        photo_scratch_mesh_count=mesh_count,
        photo_scratch_symbols_count=symbols_count,
        theme_id=row.theme_id,
        trailer=find_card_trailer(card_dir, row.id),
    )


def _card_count(db: Session) -> int:
    return int(db.scalar(select(func.count()).select_from(MotionCard)) or 0)


def _validate_model_id(db: Session, model_id: str | None) -> str | None:
    if model_id is None:
        return None
    cleaned = model_id.strip()
    if not cleaned:
        return None
    if db.get(Creator, cleaned) is None:
        raise HTTPException(status_code=404, detail=f"Model not found: {cleaned}")
    return cleaned


def _validate_theme_id(db: Session, theme_id: str | None) -> str | None:
    if theme_id is None:
        return None
    cleaned = theme_id.strip()
    if not cleaned:
        return None
    if db.get(Theme, cleaned) is None:
        raise HTTPException(status_code=404, detail=f"Theme not found: {cleaned}")
    return cleaned


def _resolve_fk_or_none(db: Session, model_id: str | None, theme_id: str | None) -> tuple[str | None, str | None]:
    mid = model_id.strip() if isinstance(model_id, str) and model_id.strip() else None
    tid = theme_id.strip() if isinstance(theme_id, str) and theme_id.strip() else None
    if mid and db.get(Creator, mid) is None:
        mid = None
    if tid and db.get(Theme, tid) is None:
        tid = None
    return mid, tid


def _next_sort_order(db: Session, model_id: str | None) -> int:
    if not model_id:
        return 0
    highest = db.scalar(
        select(func.max(MotionCard.sort_order)).where(MotionCard.model_id == model_id)
    )
    return (highest if highest is not None else -1) + 1


def _import_from_disk(db: Session, cards_dir: Path) -> int:
    if not cards_dir.is_dir():
        return 0
    imported = 0
    for directory in sorted(path for path in cards_dir.iterdir() if path.is_dir()):
        card_id = directory.name
        if card_id == ORIGINAL_ID or not CARD_ID_PATTERN.match(card_id):
            continue
        if not (directory / "background.mp4").is_file() or not (directory / "foreground.mp4").is_file():
            continue
        if db.get(MotionCard, card_id) is not None:
            continue
        meta = _read_legacy_meta(directory, card_id.replace("_", " ").title())
        label = meta.get("label")
        if not isinstance(label, str) or not label.strip():
            label = card_id.replace("_", " ").title()
        else:
            label = label.strip()
        raw_model = meta.get("model_id") if isinstance(meta.get("model_id"), str) else None
        raw_theme = meta.get("theme_id") if isinstance(meta.get("theme_id"), str) else None
        model_id, theme_id = _resolve_fk_or_none(db, raw_model, raw_theme)
        sort_order = meta.get("sort_order")
        if isinstance(sort_order, bool):
            sort_order = 0
        elif isinstance(sort_order, float):
            sort_order = int(sort_order)
        elif not isinstance(sort_order, int):
            sort_order = 0
        photos = _photos_to_json(_photos_from_json(meta.get("photos")))
        now = datetime.now(timezone.utc)
        db.add(
            MotionCard(
                id=card_id,
                label=label,
                model_id=model_id,
                theme_id=theme_id,
                sort_order=sort_order,
                photos=photos,
                created_at=now,
                updated_at=now,
            )
        )
        imported += 1
    if imported:
        db.flush()
    return imported


def ensure_cards_bootstrapped(
    db: Session,
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
) -> list[CardInfo]:
    """Seed cards from on-disk meta.json when the table is empty."""
    if _card_count(db) == 0:
        _import_from_disk(db, cards_dir)
    return list_cards(db, root, cards_dir, mesh_dir)


def list_cards(
    db: Session,
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
) -> list[CardInfo]:
    cards = [_original_card(root, cards_dir, mesh_dir)]
    rows = db.scalars(
        select(MotionCard).order_by(MotionCard.model_id.nullsfirst(), MotionCard.sort_order, MotionCard.id)
    ).all()
    for row in rows:
        info = _row_to_info(row, root, cards_dir, mesh_dir)
        if info is not None:
            cards.append(info)
    return cards


def get_card(
    db: Session,
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
    card_id: str,
) -> CardInfo:
    if card_id == ORIGINAL_ID:
        return _original_card(root, cards_dir, mesh_dir)
    row = db.get(MotionCard, card_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Card not found: {card_id}")
    info = _row_to_info(row, root, cards_dir, mesh_dir)
    if info is None:
        raise HTTPException(status_code=404, detail=f"Card not found: {card_id}")
    return info


def write_cards_index(
    db: Session,
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
) -> None:
    cards = list_cards(db, root, cards_dir, mesh_dir)
    payload = {
        "cards": [
            {
                "id": card.id,
                "label": card.label,
                "bottom": public_url(card.background),
                "foreground": public_url(card.foreground),
                "mesh": card.mesh,
                "chroma_key": card.id == ORIGINAL_ID,
                "sort_order": card.sort_order,
                **({"model_id": card.model_id} if card.model_id else {}),
                **({"theme_id": card.theme_id} if card.theme_id else {}),
                **({"trailer": card.trailer} if card.trailer else {}),
                **(
                    {"photos": [{"id": photo.id, "src": photo.src} for photo in card.photos]}
                    if card.photos
                    else {}
                ),
            }
            for card in cards
        ]
    }
    cards_dir.mkdir(parents=True, exist_ok=True)
    (cards_dir / "index.json").write_text(json.dumps(payload, indent=2) + "\n")


def create_card(
    db: Session,
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
    request: CreateCardRequest,
) -> CardInfo:
    card_id = safe_card_id(request.id)
    if card_id == ORIGINAL_ID:
        raise HTTPException(status_code=400, detail="Cannot create a card with id 'original'")
    if db.get(MotionCard, card_id) is not None:
        raise HTTPException(status_code=409, detail=f"Card already exists: {card_id}")

    card_dir = cards_dir / card_id
    background_dst, foreground_dst = card_paths(root, cards_dir, card_id)
    if card_dir.exists() and (background_dst.is_file() or foreground_dst.is_file()):
        raise HTTPException(status_code=409, detail=f"Card already exists: {card_id}")

    model_id = _validate_model_id(db, request.model_id)
    theme_id = _validate_theme_id(db, request.theme_id)
    sort_order = _next_sort_order(db, model_id) if model_id else 0

    card_dir.mkdir(parents=True, exist_ok=True)
    copy_video(resolve_source(root, request.background), background_dst)
    copy_video(resolve_source(root, request.foreground), foreground_dst)

    now = datetime.now(timezone.utc)
    row = MotionCard(
        id=card_id,
        label=request.label.strip(),
        model_id=model_id,
        theme_id=theme_id,
        sort_order=sort_order,
        photos=[],
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()
    write_cards_index(db, root, cards_dir, mesh_dir)
    info = _row_to_info(row, root, cards_dir, mesh_dir)
    assert info is not None
    return info


def update_card(
    db: Session,
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
    card_id: str,
    request: UpdateCardRequest,
) -> CardInfo:
    if card_id == ORIGINAL_ID:
        background_dst, foreground_dst = card_paths(root, cards_dir, card_id)
        if request.background is not None:
            copy_video(resolve_source(root, request.background), background_dst)
        if request.foreground is not None:
            copy_video(resolve_source(root, request.foreground), foreground_dst)
        write_cards_index(db, root, cards_dir, mesh_dir)
        return _original_card(root, cards_dir, mesh_dir)

    row = db.get(MotionCard, card_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Card not found: {card_id}")

    background_dst, foreground_dst = card_paths(root, cards_dir, card_id)
    if request.background is not None:
        copy_video(resolve_source(root, request.background), background_dst)
    if request.foreground is not None:
        copy_video(resolve_source(root, request.foreground), foreground_dst)

    set_fields = request.model_fields_set
    if request.label is not None:
        label = request.label.strip()
        if not label:
            raise HTTPException(status_code=400, detail="Card label is required")
        row.label = label

    if "model_id" in set_fields:
        previous = row.model_id
        new_model = _validate_model_id(db, request.model_id)
        if new_model and new_model != previous and request.sort_order is None:
            row.sort_order = _next_sort_order(db, new_model)
        row.model_id = new_model

    if request.sort_order is not None:
        row.sort_order = request.sort_order

    if "theme_id" in set_fields:
        row.theme_id = _validate_theme_id(db, request.theme_id)

    row.updated_at = datetime.now(timezone.utc)
    db.flush()
    write_cards_index(db, root, cards_dir, mesh_dir)
    info = _row_to_info(row, root, cards_dir, mesh_dir)
    if info is None:
        raise HTTPException(status_code=404, detail=f"Card not found: {card_id}")
    return info


def set_card_theme_id(
    db: Session,
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
    card_id: str,
    theme_id: str | None,
) -> CardInfo:
    row = db.get(MotionCard, safe_card_id(card_id) if card_id != ORIGINAL_ID else card_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Card not found: {card_id}")
    row.theme_id = _validate_theme_id(db, theme_id) if theme_id else None
    row.updated_at = datetime.now(timezone.utc)
    db.flush()
    write_cards_index(db, root, cards_dir, mesh_dir)
    info = _row_to_info(row, root, cards_dir, mesh_dir)
    if info is None:
        raise HTTPException(status_code=404, detail=f"Card not found: {card_id}")
    return info


def reorder_model_cards(
    db: Session,
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
    model_id: str,
    card_ids: list[str],
) -> list[CardInfo]:
    if not card_ids:
        raise HTTPException(status_code=400, detail="card_ids must not be empty")
    if len(set(card_ids)) != len(card_ids):
        raise HTTPException(status_code=400, detail="card_ids must be unique")
    if db.get(Creator, model_id) is None:
        raise HTTPException(status_code=404, detail=f"Model not found: {model_id}")

    owned = db.scalars(select(MotionCard).where(MotionCard.model_id == model_id)).all()
    owned_ids = {row.id for row in owned}
    if set(card_ids) != owned_ids:
        raise HTTPException(
            status_code=400,
            detail="card_ids must include every motion card for this model, and only those cards",
        )

    now = datetime.now(timezone.utc)
    by_id = {row.id: row for row in owned}
    for index, cid in enumerate(card_ids):
        row = by_id[cid]
        row.sort_order = index
        row.updated_at = now
    db.flush()
    write_cards_index(db, root, cards_dir, mesh_dir)
    return [card for card in list_cards(db, root, cards_dir, mesh_dir) if card.model_id == model_id]


def delete_card(
    db: Session,
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
    card_id: str,
) -> None:
    if card_id == ORIGINAL_ID:
        raise HTTPException(status_code=400, detail="The original card cannot be deleted")

    row = db.get(MotionCard, card_id)
    card_dir = cards_dir / card_id
    mesh_path = mesh_dir / f"{card_id}.json"
    work_dir = root / ".tmp" / "video-flow" / card_id
    found = row is not None or card_dir.exists() or mesh_path.exists() or work_dir.exists()
    if not found:
        removed = prune_published_photo_scratch(db, root, card_id)
        if not removed:
            raise HTTPException(status_code=404, detail=f"Card not found: {card_id}")
        write_cards_index(db, root, cards_dir, mesh_dir)
        return

    if row is not None:
        db.delete(row)
        db.flush()

    if card_dir.exists():
        shutil.rmtree(card_dir)
    if mesh_path.is_file():
        mesh_path.unlink()
    if work_dir.exists():
        shutil.rmtree(work_dir)
    prune_published_photo_scratch(db, root, card_id)
    write_cards_index(db, root, cards_dir, mesh_dir)


async def upload_card_photo(
    db: Session,
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
    card_id: str,
    upload: UploadFile,
) -> PhotoInfo:
    card = get_card(db, root, cards_dir, mesh_dir, card_id)
    original = Path(upload.filename or "").name
    ext = Path(original).suffix.lower()
    if ext not in PHOTO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Photo must be JPG, PNG, or WebP")
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded photo is empty")
    photo_id = uuid.uuid4().hex[:12]
    photos_dir = card_photos_dir(cards_dir, card_id)
    photos_dir.mkdir(parents=True, exist_ok=True)
    (photos_dir / f"{photo_id}{ext}").write_bytes(data)
    src = public_url(f"cards/{card_id}/photos/{photo_id}{ext}")
    photos = [*card.photos, PhotoInfo(id=photo_id, src=src)]
    row = db.get(MotionCard, card_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Card not found: {card_id}")
    row.photos = _photos_to_json(photos)
    row.updated_at = datetime.now(timezone.utc)
    db.flush()
    write_cards_index(db, root, cards_dir, mesh_dir)
    return PhotoInfo(id=photo_id, src=src)


def delete_card_photo(
    db: Session,
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
    card_id: str,
    photo_id: str,
) -> None:
    card = get_card(db, root, cards_dir, mesh_dir, card_id)
    photo = next((entry for entry in card.photos if entry.id == photo_id), None)
    if not photo:
        raise HTTPException(status_code=404, detail=f"Photo not found: {photo_id}")
    photos_dir = card_photos_dir(cards_dir, card_id)
    for path in photos_dir.glob(f"{photo_id}.*"):
        if path.is_file():
            path.unlink()
    remaining = [entry for entry in card.photos if entry.id != photo_id]
    row = db.get(MotionCard, card_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Card not found: {card_id}")
    row.photos = _photos_to_json(remaining)
    row.updated_at = datetime.now(timezone.utc)
    db.flush()
    write_cards_index(db, root, cards_dir, mesh_dir)


async def upload_card_trailer(
    db: Session,
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
    card_id: str,
    upload: UploadFile,
) -> CardInfo:
    if card_id == ORIGINAL_ID:
        raise HTTPException(status_code=400, detail="Cannot upload a trailer for the original card")
    get_card(db, root, cards_dir, mesh_dir, card_id)
    original = Path(upload.filename or "").name
    ext = Path(original).suffix.lower()
    if ext not in TRAILER_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Trailer must be MP4 or WebM")
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded trailer is empty")
    card_dir = cards_dir / card_id
    card_dir.mkdir(parents=True, exist_ok=True)
    for old_ext in TRAILER_EXTENSIONS:
        old = card_dir / f"trailer{old_ext}"
        if old.exists():
            old.unlink()
    (card_dir / f"trailer{ext}").write_bytes(data)
    write_cards_index(db, root, cards_dir, mesh_dir)
    return get_card(db, root, cards_dir, mesh_dir, card_id)


def delete_card_trailer(
    db: Session,
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
    card_id: str,
) -> CardInfo:
    if card_id == ORIGINAL_ID:
        raise HTTPException(status_code=400, detail="Cannot delete a trailer for the original card")
    get_card(db, root, cards_dir, mesh_dir, card_id)
    card_dir = cards_dir / card_id
    removed = False
    for ext in TRAILER_EXTENSIONS:
        path = card_dir / f"trailer{ext}"
        if path.is_file():
            path.unlink()
            removed = True
    if not removed:
        raise HTTPException(status_code=404, detail=f"Trailer not found for card: {card_id}")
    write_cards_index(db, root, cards_dir, mesh_dir)
    return get_card(db, root, cards_dir, mesh_dir, card_id)


def card_model_theme_ids(db: Session, card_id: str) -> tuple[str | None, str | None]:
    row = db.get(MotionCard, card_id)
    if row is None:
        return None, None
    return row.model_id, row.theme_id


def list_cards_standalone(root: Path, cards_dir: Path, mesh_dir: Path) -> list[CardInfo]:
    import backend.db.engine as db_engine

    db_engine.get_engine()
    assert db_engine.SessionLocal is not None
    session = db_engine.SessionLocal()
    try:
        return list_cards(session, root, cards_dir, mesh_dir)
    finally:
        session.close()


def write_cards_index_standalone(root: Path, cards_dir: Path, mesh_dir: Path) -> None:
    import backend.db.engine as db_engine

    db_engine.get_engine()
    assert db_engine.SessionLocal is not None
    session = db_engine.SessionLocal()
    try:
        write_cards_index(session, root, cards_dir, mesh_dir)
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def delete_card_standalone(
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
    card_id: str,
) -> None:
    import backend.db.engine as db_engine

    db_engine.get_engine()
    assert db_engine.SessionLocal is not None
    session = db_engine.SessionLocal()
    try:
        delete_card(session, root, cards_dir, mesh_dir, card_id)
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
