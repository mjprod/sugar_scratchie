from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from backend.cards import public_url
from backend.db.models import Theme

THEME_COLOR_KEYS = (
    "cardOverlayColorStart",
    "cardOverlayColorEnd",
    "cardLightColor1",
    "cardLightColor2",
)

_THEME_COLOR_COLUMNS = {
    "cardOverlayColorStart": "card_overlay_color_start",
    "cardOverlayColorEnd": "card_overlay_color_end",
    "cardLightColor1": "card_light_color_1",
    "cardLightColor2": "card_light_color_2",
}

THEME_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
INTRO_EXTENSIONS = {".mp4", ".webm"}

DEFAULT_THEMES: list[tuple[str, str]] = [
    ("police", "Police"),
    ("teacher", "Teacher"),
    ("nurse", "Nurse"),
    ("gym", "Gym"),
    ("firegirl", "Firegirl"),
]


class ThemeInfo(BaseModel):
    id: str
    label: str
    sort_order: int = 0
    created_at: float | None = None
    # One-time intro clip played in-game before the player's first scratch on
    # any motion card that belongs to this theme.
    intro: str | None = None
    cardOverlayColorStart: str | None = None
    cardOverlayColorEnd: str | None = None
    cardLightColor1: str | None = None
    cardLightColor2: str | None = None


class CreateThemeRequest(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=120)
    cardOverlayColorStart: str | None = Field(default=None, max_length=32)
    cardOverlayColorEnd: str | None = Field(default=None, max_length=32)
    cardLightColor1: str | None = Field(default=None, max_length=32)
    cardLightColor2: str | None = Field(default=None, max_length=32)


class UpdateThemeRequest(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=120)
    sort_order: int | None = None
    cardOverlayColorStart: str | None = Field(default=None, max_length=32)
    cardOverlayColorEnd: str | None = Field(default=None, max_length=32)
    cardLightColor1: str | None = Field(default=None, max_length=32)
    cardLightColor2: str | None = Field(default=None, max_length=32)


class ReorderThemesRequest(BaseModel):
    theme_ids: list[str] = Field(min_length=1)


def _clean_optional_str(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _color_fields(source: Any) -> dict[str, str | None]:
    return {key: _clean_optional_str(getattr(source, key, None)) for key in THEME_COLOR_KEYS}


def safe_theme_id(value: str) -> str:
    slug = re.sub(r"[^a-z0-9_]+", "_", value.strip().lower()).strip("_")
    if not slug or not THEME_ID_PATTERN.match(slug):
        raise HTTPException(
            status_code=400,
            detail="Theme id must start with a letter and contain only lowercase letters, numbers, and underscores",
        )
    return slug


def find_theme_intro(themes_dir: Path, theme_id: str) -> str | None:
    theme_dir = themes_dir / theme_id
    if not theme_dir.is_dir():
        return None
    for ext in INTRO_EXTENSIONS:
        candidate = theme_dir / f"intro{ext}"
        if candidate.is_file():
            return public_url(f"themes/{theme_id}/intro{ext}")
    return None


def _created_at_unix(value: datetime | None) -> float | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.timestamp()


def _row_to_info(row: Theme, themes_dir: Path) -> ThemeInfo:
    return ThemeInfo(
        id=row.id,
        label=row.label,
        sort_order=row.sort_order,
        created_at=_created_at_unix(row.created_at),
        intro=find_theme_intro(themes_dir, row.id),
        cardOverlayColorStart=row.card_overlay_color_start,
        cardOverlayColorEnd=row.card_overlay_color_end,
        cardLightColor1=row.card_light_color_1,
        cardLightColor2=row.card_light_color_2,
    )


def _parse_legacy_created_at(value: Any) -> datetime:
    if isinstance(value, (int, float)) and value > 0:
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    return datetime.now(timezone.utc)


def _index_path(themes_dir: Path) -> Path:
    return themes_dir / "index.json"


def _read_legacy_index(themes_dir: Path) -> list[dict]:
    path = _index_path(themes_dir)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
    except Exception:
        return []
    if not isinstance(data, dict):
        return []
    themes = data.get("themes")
    if not isinstance(themes, list):
        return []
    return [entry for entry in themes if isinstance(entry, dict)]


def _theme_count(db: Session) -> int:
    return int(db.scalar(select(func.count()).select_from(Theme)) or 0)


def _insert_defaults(db: Session) -> None:
    now = datetime.now(timezone.utc)
    for index, (theme_id, label) in enumerate(DEFAULT_THEMES):
        db.add(
            Theme(
                id=theme_id,
                label=label,
                sort_order=index,
                created_at=now,
                updated_at=now,
            )
        )
    db.flush()


def _import_legacy_index(db: Session, themes_dir: Path) -> int:
    imported = 0
    for index, entry in enumerate(_read_legacy_index(themes_dir)):
        theme_id = entry.get("id")
        label = entry.get("label")
        if not isinstance(theme_id, str) or not isinstance(label, str):
            continue
        theme_id = theme_id.strip()
        label = label.strip()
        if not theme_id or not label:
            continue
        if db.get(Theme, theme_id) is not None:
            continue
        sort_order = entry.get("sort_order")
        colors = {col: _clean_optional_str(entry.get(key)) for key, col in _THEME_COLOR_COLUMNS.items()}
        db.add(
            Theme(
                id=theme_id,
                label=label,
                sort_order=sort_order if isinstance(sort_order, int) else index,
                created_at=_parse_legacy_created_at(entry.get("created_at")),
                updated_at=datetime.now(timezone.utc),
                **colors,
            )
        )
        imported += 1
    if imported:
        db.flush()
    return imported


def ensure_themes_bootstrapped(db: Session, themes_dir: Path) -> list[ThemeInfo]:
    """Seed themes from legacy index.json (or defaults) when the table is empty."""
    if _theme_count(db) == 0:
        imported = _import_legacy_index(db, themes_dir)
        if imported == 0:
            _insert_defaults(db)
    return list_themes(db, themes_dir, ensure_defaults=False)


def list_themes(
    db: Session,
    themes_dir: Path,
    *,
    ensure_defaults: bool = True,
) -> list[ThemeInfo]:
    if ensure_defaults and _theme_count(db) == 0:
        return ensure_themes_bootstrapped(db, themes_dir)

    rows = db.scalars(select(Theme).order_by(Theme.sort_order, Theme.label, Theme.id)).all()
    if ensure_defaults and not rows:
        return ensure_themes_bootstrapped(db, themes_dir)
    return [_row_to_info(row, themes_dir) for row in rows]


def get_theme(db: Session, themes_dir: Path, theme_id: str) -> ThemeInfo:
    slug = safe_theme_id(theme_id)
    row = db.get(Theme, slug)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Theme “{slug}” not found")
    return _row_to_info(row, themes_dir)


def create_theme(db: Session, themes_dir: Path, request: CreateThemeRequest) -> ThemeInfo:
    theme_id = safe_theme_id(request.id)
    label = request.label.strip()
    if not label:
        raise HTTPException(status_code=400, detail="Theme label is required")

    if db.get(Theme, theme_id) is not None:
        raise HTTPException(status_code=409, detail=f"Theme “{theme_id}” already exists")

    existing_label = db.scalar(select(Theme.id).where(func.lower(Theme.label) == label.lower()).limit(1))
    if existing_label is not None:
        raise HTTPException(status_code=409, detail=f"Theme label “{label}” already exists")

    max_order = db.scalar(select(func.max(Theme.sort_order)))
    next_order = (max_order if max_order is not None else -1) + 1
    colors = _color_fields(request)
    now = datetime.now(timezone.utc)
    row = Theme(
        id=theme_id,
        label=label,
        sort_order=next_order,
        created_at=now,
        updated_at=now,
        card_overlay_color_start=colors["cardOverlayColorStart"],
        card_overlay_color_end=colors["cardOverlayColorEnd"],
        card_light_color_1=colors["cardLightColor1"],
        card_light_color_2=colors["cardLightColor2"],
    )
    db.add(row)
    db.flush()
    return _row_to_info(row, themes_dir)


def update_theme(
    db: Session,
    themes_dir: Path,
    theme_id: str,
    request: UpdateThemeRequest,
) -> ThemeInfo:
    slug = safe_theme_id(theme_id)
    row = db.get(Theme, slug)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Theme “{slug}” not found")

    if request.label is not None:
        label = request.label.strip()
        if not label:
            raise HTTPException(status_code=400, detail="Theme label is required")
        clash = db.scalar(
            select(Theme.id)
            .where(func.lower(Theme.label) == label.lower(), Theme.id != slug)
            .limit(1)
        )
        if clash is not None:
            raise HTTPException(status_code=409, detail=f"Theme label “{label}” already exists")
        row.label = label

    if request.sort_order is not None:
        row.sort_order = request.sort_order

    set_fields = request.model_fields_set
    for api_key, column in _THEME_COLOR_COLUMNS.items():
        if api_key in set_fields:
            setattr(row, column, _clean_optional_str(getattr(request, api_key)))

    row.updated_at = datetime.now(timezone.utc)
    db.flush()
    return _row_to_info(row, themes_dir)


def delete_theme(db: Session, themes_dir: Path, theme_id: str) -> None:
    slug = safe_theme_id(theme_id)
    row = db.get(Theme, slug)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Theme “{slug}” not found")
    db.delete(row)
    db.flush()
    theme_dir = themes_dir / slug
    if theme_dir.is_dir():
        shutil.rmtree(theme_dir, ignore_errors=True)


def reorder_themes(db: Session, themes_dir: Path, theme_ids: list[str]) -> list[ThemeInfo]:
    rows = list(db.scalars(select(Theme)).all())
    by_id = {row.id: row for row in rows}
    ordered: list[Theme] = []
    seen: set[str] = set()
    for raw_id in theme_ids:
        slug = safe_theme_id(raw_id)
        row = by_id.get(slug)
        if not row or slug in seen:
            continue
        ordered.append(row)
        seen.add(slug)
    for row in rows:
        if row.id not in seen:
            ordered.append(row)
    now = datetime.now(timezone.utc)
    for index, row in enumerate(ordered):
        row.sort_order = index
        row.updated_at = now
    db.flush()
    return [_row_to_info(row, themes_dir) for row in ordered]


async def upload_theme_intro(
    db: Session,
    themes_dir: Path,
    theme_id: str,
    upload: UploadFile,
) -> ThemeInfo:
    theme = get_theme(db, themes_dir, theme_id)
    original = Path(upload.filename or "").name
    ext = Path(original).suffix.lower()
    if ext not in INTRO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Intro must be MP4 or WebM")
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded intro is empty")
    theme_dir = themes_dir / theme.id
    theme_dir.mkdir(parents=True, exist_ok=True)
    for old_ext in INTRO_EXTENSIONS:
        old = theme_dir / f"intro{old_ext}"
        if old.exists():
            old.unlink()
    target = theme_dir / f"intro{ext}"
    target.write_bytes(data)
    return get_theme(db, themes_dir, theme.id)


def delete_theme_intro(db: Session, themes_dir: Path, theme_id: str) -> ThemeInfo:
    theme = get_theme(db, themes_dir, theme_id)
    theme_dir = themes_dir / theme.id
    removed = False
    for ext in INTRO_EXTENSIONS:
        path = theme_dir / f"intro{ext}"
        if path.is_file():
            path.unlink()
            removed = True
    if not removed:
        raise HTTPException(status_code=404, detail=f"Intro not found for theme: {theme.id}")
    return get_theme(db, themes_dir, theme.id)


def resolve_theme_id(db: Session, theme_or_label: str) -> str | None:
    """Map a theme id or display label to a catalog theme id."""
    raw = (theme_or_label or "").strip()
    if not raw:
        return None
    lower = raw.lower()
    by_id = db.get(Theme, lower) or db.get(Theme, raw)
    if by_id is not None:
        return by_id.id
    by_label = db.scalar(select(Theme).where(func.lower(Theme.label) == lower).limit(1))
    if by_label is not None:
        return by_label.id
    slug = re.sub(r"[^a-z0-9_]+", "_", lower).strip("_")
    if slug and THEME_ID_PATTERN.match(slug):
        by_slug = db.get(Theme, slug)
        if by_slug is not None:
            return by_slug.id
    return None


def resolve_theme_id_standalone(theme_or_label: str) -> str | None:
    """Resolve a theme id using a short-lived DB session (non-request call sites)."""
    import backend.db.engine as db_engine

    db_engine.get_engine()
    assert db_engine.SessionLocal is not None
    session = db_engine.SessionLocal()
    try:
        return resolve_theme_id(session, theme_or_label)
    finally:
        session.close()


def list_themes_standalone(themes_dir: Path, *, ensure_defaults: bool = True) -> list[ThemeInfo]:
    """List themes using a short-lived DB session (non-request call sites)."""
    import backend.db.engine as db_engine

    db_engine.get_engine()
    assert db_engine.SessionLocal is not None
    session = db_engine.SessionLocal()
    try:
        themes = list_themes(session, themes_dir, ensure_defaults=ensure_defaults)
        if ensure_defaults:
            session.commit()
        return themes
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
