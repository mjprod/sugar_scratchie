from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import BaseModel
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from backend.db.models import Creator, MotionCard, PhotoScratchCard, Theme
from backend.themes_store import find_theme_intro

PUBLISHED_ID_PATTERN = re.compile(r"^(?P<card_id>.+)_(?P<slot_id>slot_[0-9]{2})$")


class PhotoScratchCardInfo(BaseModel):
    id: str
    card_id: str
    slot_id: str
    label: str
    background: str
    bikini: str
    clothes: str
    mesh: str
    model_id: str | None = None
    theme_id: str | None = None
    intro: str | None = None
    sort_order: int = 0


def _index_path(root: Path) -> Path:
    return root / "public" / "photo-scratch" / "index.json"


def _themes_dir(root: Path) -> Path:
    return root / "public" / "themes"


def _optional_str(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _parse_published_id(entry_id: str) -> tuple[str, str] | None:
    match = PUBLISHED_ID_PATTERN.match(entry_id.strip())
    if match is None:
        return None
    return match.group("card_id"), match.group("slot_id")


def _row_count(db: Session) -> int:
    return int(db.scalar(select(func.count()).select_from(PhotoScratchCard)) or 0)


def _existing_ids(db: Session, table: type, ids: set[str]) -> set[str]:
    if not ids:
        return set()
    found = db.scalars(select(table.id).where(table.id.in_(ids))).all()
    return set(found)


def _read_legacy_index(root: Path) -> list[dict]:
    path = _index_path(root)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
    except Exception:
        return []
    if not isinstance(data, dict) or not isinstance(data.get("cards"), list):
        return []
    return [entry for entry in data["cards"] if isinstance(entry, dict)]


def _row_to_info(row: PhotoScratchCard, themes_dir: Path) -> PhotoScratchCardInfo:
    intro = find_theme_intro(themes_dir, row.theme_id) if row.theme_id else None
    return PhotoScratchCardInfo(
        id=row.id,
        card_id=row.card_id,
        slot_id=row.slot_id,
        label=row.label,
        background=row.background,
        bikini=row.bikini,
        clothes=row.clothes,
        mesh=row.mesh,
        model_id=row.model_id,
        theme_id=row.theme_id,
        intro=intro,
        sort_order=row.sort_order,
    )


def _info_to_mirror(info: PhotoScratchCardInfo) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": info.id,
        "label": info.label,
        "background": info.background,
        "bikini": info.bikini,
        "clothes": info.clothes,
        "mesh": info.mesh,
    }
    if info.model_id:
        payload["model_id"] = info.model_id
    if info.theme_id:
        payload["theme_id"] = info.theme_id
    if info.intro:
        payload["intro"] = info.intro
    return payload


def list_photo_scratch_cards(db: Session, root: Path) -> list[PhotoScratchCardInfo]:
    themes_dir = _themes_dir(root)
    rows = db.scalars(
        select(PhotoScratchCard).order_by(PhotoScratchCard.sort_order, PhotoScratchCard.id)
    ).all()
    return [_row_to_info(row, themes_dir) for row in rows]


def write_photo_scratch_index(db: Session, root: Path) -> None:
    cards = list_photo_scratch_cards(db, root)
    payload = {"cards": [_info_to_mirror(card) for card in cards]}
    path = _index_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")


def _import_legacy_index(db: Session, root: Path) -> int:
    entries = _read_legacy_index(root)
    if not entries:
        return 0

    parsed: list[tuple[str, str, dict]] = []
    card_ids: set[str] = set()
    model_ids: set[str] = set()
    theme_ids: set[str] = set()
    for entry in entries:
        entry_id = _optional_str(entry.get("id"))
        label = _optional_str(entry.get("label"))
        background = _optional_str(entry.get("background"))
        bikini = _optional_str(entry.get("bikini"))
        clothes = _optional_str(entry.get("clothes"))
        mesh = _optional_str(entry.get("mesh"))
        if not all((entry_id, label, background, bikini, clothes, mesh)):
            continue
        parsed_id = _parse_published_id(entry_id)
        if parsed_id is None:
            continue
        card_id, slot_id = parsed_id
        card_ids.add(card_id)
        model_id = _optional_str(entry.get("model_id"))
        theme_id = _optional_str(entry.get("theme_id"))
        if model_id:
            model_ids.add(model_id)
        if theme_id:
            theme_ids.add(theme_id)
        parsed.append((card_id, slot_id, entry))

    known_cards = _existing_ids(db, MotionCard, card_ids)
    known_models = _existing_ids(db, Creator, model_ids)
    known_themes = _existing_ids(db, Theme, theme_ids)
    card_rows = {
        row.id: row
        for row in db.scalars(select(MotionCard).where(MotionCard.id.in_(known_cards))).all()
    }

    imported = 0
    now = datetime.now(timezone.utc)
    for index, (card_id, slot_id, entry) in enumerate(parsed):
        if card_id not in known_cards:
            continue
        entry_id = str(entry["id"]).strip()
        if db.get(PhotoScratchCard, entry_id) is not None:
            continue
        motion = card_rows.get(card_id)
        model_id = _optional_str(entry.get("model_id"))
        if model_id not in known_models:
            model_id = motion.model_id if motion is not None else None
        theme_id = _optional_str(entry.get("theme_id"))
        if theme_id not in known_themes:
            theme_id = motion.theme_id if motion is not None else None
        db.add(
            PhotoScratchCard(
                id=entry_id,
                card_id=card_id,
                slot_id=slot_id,
                label=str(entry["label"]).strip(),
                model_id=model_id,
                theme_id=theme_id,
                background=str(entry["background"]).strip(),
                bikini=str(entry["bikini"]).strip(),
                clothes=str(entry["clothes"]).strip(),
                mesh=str(entry["mesh"]).strip(),
                sort_order=index,
                created_at=now,
                updated_at=now,
            )
        )
        imported += 1
    if imported:
        db.flush()
    return imported


def ensure_photo_scratch_bootstrapped(db: Session, root: Path) -> list[PhotoScratchCardInfo]:
    """Seed published photo-scratch rows from the legacy index when the table is empty."""
    if _row_count(db) == 0:
        _import_legacy_index(db, root)
    write_photo_scratch_index(db, root)
    return list_photo_scratch_cards(db, root)


def upsert_published(
    db: Session,
    card_id: str,
    entries: list[dict[str, Any]],
    *,
    slot_id: str | None = None,
) -> int:
    """Replace published rows for one slot or every slot of a motion card."""
    now = datetime.now(timezone.utc)
    if slot_id:
        db.execute(
            delete(PhotoScratchCard).where(
                PhotoScratchCard.card_id == card_id,
                PhotoScratchCard.slot_id == slot_id,
            )
        )
    else:
        db.execute(delete(PhotoScratchCard).where(PhotoScratchCard.card_id == card_id))

    max_order = db.scalar(select(func.max(PhotoScratchCard.sort_order)))
    next_order = (max_order if max_order is not None else -1) + 1
    for offset, entry in enumerate(entries):
        entry_id = str(entry["id"]).strip()
        parsed = _parse_published_id(entry_id)
        if parsed is None:
            continue
        parsed_card, parsed_slot = parsed
        db.add(
            PhotoScratchCard(
                id=entry_id,
                card_id=parsed_card,
                slot_id=parsed_slot,
                label=str(entry["label"]).strip(),
                model_id=_optional_str(entry.get("model_id")),
                theme_id=_optional_str(entry.get("theme_id")),
                background=str(entry["background"]).strip(),
                bikini=str(entry["bikini"]).strip(),
                clothes=str(entry["clothes"]).strip(),
                mesh=str(entry["mesh"]).strip(),
                sort_order=next_order + offset,
                created_at=now,
                updated_at=now,
            )
        )
    db.flush()
    return len(entries)


def prune_published_photo_scratch(db: Session, root: Path, card_id: str) -> int:
    """Remove published game entries for a motion card and rewrite the static mirror."""
    prefix = f"{card_id}_"
    rows = list(
        db.scalars(
            select(PhotoScratchCard).where(
                or_(
                    PhotoScratchCard.card_id == card_id,
                    # Literal prefix: SQL LIKE would treat `_` in card ids as a wildcard.
                    PhotoScratchCard.id.startswith(prefix, autoescape=True),
                )
            )
        ).all()
    )
    removed = len(rows)
    if removed:
        for row in rows:
            db.delete(row)
        db.flush()
    write_photo_scratch_index(db, root)
    return removed
