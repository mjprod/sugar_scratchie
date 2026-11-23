"""Operator-managed theme sessions.

Default means every catalog theme and is what players see outside a custom
window. A custom session stores its own themes plus a start and an end.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from backend.db.models import Theme, ThemeSession, ThemeSessionTheme, utcnow

DEFAULT_SESSION_ID = "default"
DEFAULT_ACRONYM = "DEF"
SESSION_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")
ACRONYM_PATTERN = re.compile(r"^[A-Z0-9]{2,12}$")


class ThemeSessionInfo(BaseModel):
    id: str
    label: str
    acronym: str | None = None
    is_default: bool = False
    theme_ids: list[str] = Field(default_factory=list)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    status: str
    is_running: bool = False
    sort_order: int = 0


class CreateThemeSessionRequest(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=120)
    acronym: str = Field(min_length=1, max_length=12)


class UpdateThemeSessionRequest(BaseModel):
    id: str | None = Field(default=None, max_length=64)
    label: str = Field(min_length=1, max_length=120)
    acronym: str | None = Field(default=None, max_length=12)


class SetThemeSessionThemesRequest(BaseModel):
    theme_ids: list[str] = Field(default_factory=list)


class SetThemeSessionWindowRequest(BaseModel):
    starts_at: datetime
    ends_at: datetime


def safe_acronym(value: str) -> str:
    acronym = re.sub(r"[^A-Za-z0-9]", "", value.strip()).upper()
    if not ACRONYM_PATTERN.match(acronym):
        raise HTTPException(
            status_code=400,
            detail="Acronym must be 2–12 letters or numbers",
        )
    return acronym


def safe_session_id(value: str) -> str:
    slug = re.sub(r"[^a-z0-9_]+", "_", value.strip().lower()).strip("_")
    if not slug or not SESSION_ID_PATTERN.match(slug):
        raise HTTPException(
            status_code=400,
            detail="Session id must start with a letter and contain only lowercase letters, numbers, and underscores",
        )
    return slug


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def ensure_default_theme_session(db: Session) -> ThemeSession:
    row = db.get(ThemeSession, DEFAULT_SESSION_ID)
    if row is None:
        row = ThemeSession(id=DEFAULT_SESSION_ID, label="Default", acronym=DEFAULT_ACRONYM, sort_order=0)
        db.add(row)
        db.flush()
        return row
    if not (row.acronym or "").strip():
        taken = db.scalar(
            select(ThemeSession.id).where(func.lower(ThemeSession.acronym) == DEFAULT_ACRONYM.lower()).limit(1)
        )
        if taken is None:
            row.acronym = DEFAULT_ACRONYM
            db.flush()
    return row


def _status(row: ThemeSession, now: datetime) -> str:
    if row.id == DEFAULT_SESSION_ID:
        return "fallback"
    if row.starts_at is None or row.ends_at is None:
        return "draft"
    if row.ends_at <= now:
        return "ended"
    if row.starts_at > now:
        return "scheduled"
    return "running"


def _running_row(
    rows: list[ThemeSession],
    now: datetime,
    memberships: dict[str, list[str]],
) -> ThemeSession:
    default = next(row for row in rows if row.id == DEFAULT_SESSION_ID)
    candidates = [
        row
        for row in rows
        if row.id != DEFAULT_SESSION_ID
        and memberships.get(row.id)
        and row.starts_at is not None
        and row.ends_at is not None
        and row.starts_at <= now
        and row.ends_at > now
    ]
    if not candidates:
        return default
    return max(candidates, key=lambda row: row.starts_at or now)


def _memberships(db: Session) -> dict[str, list[str]]:
    rows = db.scalars(
        select(ThemeSessionTheme).order_by(
            ThemeSessionTheme.session_id,
            ThemeSessionTheme.sort_order,
            ThemeSessionTheme.theme_id,
        )
    ).all()
    grouped: dict[str, list[str]] = {}
    for row in rows:
        grouped.setdefault(row.session_id, []).append(row.theme_id)
    return grouped


def _to_info(
    row: ThemeSession,
    theme_ids: list[str],
    now: datetime,
    running_id: str,
) -> ThemeSessionInfo:
    return ThemeSessionInfo(
        id=row.id,
        label=row.label,
        acronym=row.acronym,
        is_default=row.id == DEFAULT_SESSION_ID,
        theme_ids=theme_ids,
        starts_at=row.starts_at,
        ends_at=row.ends_at,
        status=_status(row, now),
        is_running=row.id == running_id,
        sort_order=row.sort_order,
    )


def _sorted_rows(rows: list[ThemeSession]) -> list[ThemeSession]:
    far_future = datetime.max.replace(tzinfo=timezone.utc)

    def key(row: ThemeSession) -> tuple:
        if row.id == DEFAULT_SESSION_ID:
            return (0, far_future, 0, row.id)
        if row.starts_at is None:
            return (2, far_future, row.sort_order, row.id)
        return (1, row.starts_at, row.sort_order, row.id)

    return sorted(rows, key=key)


def list_theme_sessions(db: Session) -> list[ThemeSessionInfo]:
    ensure_default_theme_session(db)
    rows = _sorted_rows(list(db.scalars(select(ThemeSession)).all()))
    now = utcnow()
    themes = _memberships(db)
    running = _running_row(rows, now, themes)
    return [_to_info(row, themes.get(row.id, []), now, running.id) for row in rows]


def running_theme_ids(db: Session, now: datetime | None = None) -> set[str] | None:
    """Theme ids for the session running at `now`. None means every theme.

    An empty membership (a theme delete removed the last one) is not a filter.
    Players keep seeing the full catalog instead of a blank collection.
    """
    ensure_default_theme_session(db)
    moment = now or utcnow()
    rows = list(db.scalars(select(ThemeSession)).all())
    themes = _memberships(db)
    running = _running_row(rows, moment, themes)
    theme_ids = themes.get(running.id, [])
    if running.id == DEFAULT_SESSION_ID or not theme_ids:
        return None
    return set(theme_ids)


def _require(db: Session, session_id: str) -> ThemeSession:
    ensure_default_theme_session(db)
    slug = safe_session_id(session_id)
    row = db.get(ThemeSession, slug)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Session not found: {slug}")
    return row


def _require_custom(db: Session, session_id: str) -> ThemeSession:
    row = _require(db, session_id)
    if row.id == DEFAULT_SESSION_ID:
        raise HTTPException(status_code=400, detail="The default session cannot be changed this way")
    return row


def _reject_ended(row: ThemeSession, now: datetime) -> None:
    if row.ends_at is not None and row.ends_at <= now:
        raise HTTPException(status_code=400, detail="This session has ended")


def _theme_ids_for(db: Session, session_id: str) -> list[str]:
    return _memberships(db).get(session_id, [])


def _reject_acronym_clash(db: Session, acronym: str, *, except_id: str | None = None) -> None:
    query = select(ThemeSession.id).where(func.lower(ThemeSession.acronym) == acronym.lower())
    if except_id is not None:
        query = query.where(ThemeSession.id != except_id)
    clash = db.scalar(query.limit(1))
    if clash is not None:
        raise HTTPException(status_code=409, detail=f"Acronym “{acronym}” is already used")


def create_theme_session(db: Session, request: CreateThemeSessionRequest) -> ThemeSessionInfo:
    ensure_default_theme_session(db)
    session_id = safe_session_id(request.id)
    if session_id == DEFAULT_SESSION_ID:
        raise HTTPException(status_code=400, detail="The default session already exists")
    if db.get(ThemeSession, session_id) is not None:
        raise HTTPException(status_code=409, detail=f"Session already exists: {session_id}")
    label = request.label.strip()
    if not label:
        raise HTTPException(status_code=400, detail="Session name is required")
    acronym = safe_acronym(request.acronym)
    _reject_acronym_clash(db, acronym)
    max_sort = db.scalar(select(func.max(ThemeSession.sort_order))) or 0
    row = ThemeSession(id=session_id, label=label, acronym=acronym, sort_order=int(max_sort) + 1)
    db.add(row)
    db.flush()
    now = utcnow()
    rows = list(db.scalars(select(ThemeSession)).all())
    running = _running_row(rows, now, _memberships(db))
    return _to_info(row, [], now, running.id)


def _rename_session(db: Session, row: ThemeSession, new_id: str) -> ThemeSession:
    if new_id == DEFAULT_SESSION_ID:
        raise HTTPException(status_code=400, detail="The default session already exists")
    if db.get(ThemeSession, new_id) is not None:
        raise HTTPException(status_code=409, detail=f"Session already exists: {new_id}")
    now = utcnow()
    kept_acronym = row.acronym
    row.acronym = None
    db.flush()
    replacement = ThemeSession(
        id=new_id,
        label=row.label,
        acronym=None,
        starts_at=row.starts_at,
        ends_at=row.ends_at,
        sort_order=row.sort_order,
        created_at=row.created_at,
        updated_at=now,
    )
    db.add(replacement)
    db.flush()
    db.execute(
        update(ThemeSessionTheme)
        .where(ThemeSessionTheme.session_id == row.id)
        .values(session_id=new_id)
    )
    db.delete(row)
    db.flush()
    replacement.acronym = kept_acronym
    db.flush()
    return replacement


def update_theme_session(
    db: Session,
    session_id: str,
    request: UpdateThemeSessionRequest,
) -> ThemeSessionInfo:
    row = _require(db, session_id)
    label = request.label.strip()
    if not label:
        raise HTTPException(status_code=400, detail="Session name is required")
    acronym = safe_acronym(request.acronym) if request.acronym is not None else row.acronym
    if not acronym:
        raise HTTPException(status_code=400, detail="Acronym is required")
    _reject_acronym_clash(db, acronym, except_id=row.id)
    if row.id == DEFAULT_SESSION_ID:
        if request.id and safe_session_id(request.id) != DEFAULT_SESSION_ID:
            raise HTTPException(status_code=400, detail="The default session id stays default")
        row.label = label
        row.acronym = acronym
        row.updated_at = utcnow()
        db.flush()
        rows = list(db.scalars(select(ThemeSession)).all())
        running = _running_row(rows, now := utcnow(), _memberships(db))
        return _to_info(row, _theme_ids_for(db, row.id), now, running.id)
    new_id = safe_session_id(request.id) if request.id else row.id
    if new_id != row.id:
        row = _rename_session(db, row, new_id)
    row.label = label
    row.acronym = acronym
    row.updated_at = utcnow()
    db.flush()
    rows = list(db.scalars(select(ThemeSession)).all())
    running = _running_row(rows, now := utcnow(), _memberships(db))
    return _to_info(row, _theme_ids_for(db, row.id), now, running.id)


def set_theme_session_themes(
    db: Session,
    session_id: str,
    request: SetThemeSessionThemesRequest,
) -> ThemeSessionInfo:
    row = _require_custom(db, session_id)
    now = utcnow()
    _reject_ended(row, now)
    requested = [theme_id.strip() for theme_id in request.theme_ids]
    unique_ids: list[str] = []
    seen: set[str] = set()
    for theme_id in requested:
        if not theme_id or theme_id in seen:
            continue
        seen.add(theme_id)
        unique_ids.append(theme_id)
    themes = list(db.scalars(select(Theme).where(Theme.id.in_(unique_ids))).all()) if unique_ids else []
    found = {theme.id for theme in themes}
    missing = [theme_id for theme_id in unique_ids if theme_id not in found]
    if missing:
        raise HTTPException(status_code=400, detail=f"Unknown theme: {missing[0]}")
    if row.starts_at is not None and not themes:
        raise HTTPException(status_code=400, detail="A started session needs at least one theme")
    ordered = sorted(themes, key=lambda theme: (theme.sort_order, theme.label.lower(), theme.id))
    existing = list(
        db.scalars(select(ThemeSessionTheme).where(ThemeSessionTheme.session_id == row.id)).all()
    )
    for item in existing:
        db.delete(item)
    db.flush()
    for index, theme in enumerate(ordered):
        db.add(ThemeSessionTheme(session_id=row.id, theme_id=theme.id, sort_order=index))
    row.updated_at = now
    db.flush()
    rows = list(db.scalars(select(ThemeSession)).all())
    running = _running_row(rows, now, _memberships(db))
    return _to_info(row, [theme.id for theme in ordered], now, running.id)


def set_theme_session_window(
    db: Session,
    session_id: str,
    request: SetThemeSessionWindowRequest,
) -> list[ThemeSessionInfo]:
    row = _require_custom(db, session_id)
    if not _theme_ids_for(db, row.id):
        raise HTTPException(status_code=400, detail="Add at least one theme before setting dates")
    starts_at = _as_utc(request.starts_at)
    ends_at = _as_utc(request.ends_at)
    if ends_at <= starts_at:
        raise HTTPException(status_code=400, detail="End must be after the start")
    row.starts_at = starts_at
    row.ends_at = ends_at
    row.updated_at = utcnow()
    db.flush()
    return list_theme_sessions(db)


def delete_theme_session(db: Session, session_id: str) -> list[ThemeSessionInfo]:
    row = _require_custom(db, session_id)
    if _status(row, utcnow()) == "running":
        raise HTTPException(
            status_code=400,
            detail="Move the end date before deleting the session that is live",
        )
    db.delete(row)
    db.flush()
    return list_theme_sessions(db)
