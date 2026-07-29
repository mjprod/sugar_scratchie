from __future__ import annotations

import json
import re
import time
from pathlib import Path

from fastapi import HTTPException
from pydantic import BaseModel, Field

THEME_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")

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


class CreateThemeRequest(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=120)


class UpdateThemeRequest(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=120)
    sort_order: int | None = None


class ReorderThemesRequest(BaseModel):
    theme_ids: list[str] = Field(min_length=1)


def safe_theme_id(value: str) -> str:
    slug = re.sub(r"[^a-z0-9_]+", "_", value.strip().lower()).strip("_")
    if not slug or not THEME_ID_PATTERN.match(slug):
        raise HTTPException(
            status_code=400,
            detail="Theme id must start with a letter and contain only lowercase letters, numbers, and underscores",
        )
    return slug


def _index_path(themes_dir: Path) -> Path:
    return themes_dir / "index.json"


def _read_index(themes_dir: Path) -> list[dict]:
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


def _write_index(themes_dir: Path, themes: list[ThemeInfo]) -> None:
    themes_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "themes": [
            {
                "id": theme.id,
                "label": theme.label,
                "sort_order": theme.sort_order,
                "created_at": theme.created_at,
            }
            for theme in themes
        ]
    }
    _index_path(themes_dir).write_text(json.dumps(payload, indent=2) + "\n")


def _parse_theme(entry: dict, fallback_order: int) -> ThemeInfo | None:
    theme_id = entry.get("id")
    label = entry.get("label")
    if not isinstance(theme_id, str) or not isinstance(label, str):
        return None
    theme_id = theme_id.strip()
    label = label.strip()
    if not theme_id or not label:
        return None
    sort_order = entry.get("sort_order")
    created_at = entry.get("created_at")
    return ThemeInfo(
        id=theme_id,
        label=label,
        sort_order=sort_order if isinstance(sort_order, int) else fallback_order,
        created_at=created_at if isinstance(created_at, (int, float)) else None,
    )


def ensure_default_themes(themes_dir: Path) -> list[ThemeInfo]:
    """Create the themes index with the starter set if missing/empty."""
    existing = list_themes(themes_dir, ensure_defaults=False)
    if existing:
        return existing
    now = time.time()
    themes = [
        ThemeInfo(id=theme_id, label=label, sort_order=index, created_at=now)
        for index, (theme_id, label) in enumerate(DEFAULT_THEMES)
    ]
    _write_index(themes_dir, themes)
    return themes


def list_themes(themes_dir: Path, *, ensure_defaults: bool = True) -> list[ThemeInfo]:
    if ensure_defaults and not _index_path(themes_dir).exists():
        return ensure_default_themes(themes_dir)

    themes: list[ThemeInfo] = []
    for index, entry in enumerate(_read_index(themes_dir)):
        parsed = _parse_theme(entry, index)
        if parsed:
            themes.append(parsed)

    if ensure_defaults and not themes:
        return ensure_default_themes(themes_dir)

    themes.sort(key=lambda theme: (theme.sort_order, theme.label.lower(), theme.id))
    return themes


def write_themes_index(themes_dir: Path) -> None:
    themes = list_themes(themes_dir)
    _write_index(themes_dir, themes)


def get_theme(themes_dir: Path, theme_id: str) -> ThemeInfo:
    slug = safe_theme_id(theme_id)
    for theme in list_themes(themes_dir):
        if theme.id == slug:
            return theme
    raise HTTPException(status_code=404, detail=f"Theme “{slug}” not found")


def create_theme(themes_dir: Path, request: CreateThemeRequest) -> ThemeInfo:
    theme_id = safe_theme_id(request.id)
    label = request.label.strip()
    if not label:
        raise HTTPException(status_code=400, detail="Theme label is required")

    themes = list_themes(themes_dir)
    if any(theme.id == theme_id for theme in themes):
        raise HTTPException(status_code=409, detail=f"Theme “{theme_id}” already exists")
    if any(theme.label.lower() == label.lower() for theme in themes):
        raise HTTPException(status_code=409, detail=f"Theme label “{label}” already exists")

    next_order = max((theme.sort_order for theme in themes), default=-1) + 1
    created = ThemeInfo(
        id=theme_id,
        label=label,
        sort_order=next_order,
        created_at=time.time(),
    )
    themes.append(created)
    themes.sort(key=lambda theme: (theme.sort_order, theme.label.lower(), theme.id))
    _write_index(themes_dir, themes)
    return created


def update_theme(themes_dir: Path, theme_id: str, request: UpdateThemeRequest) -> ThemeInfo:
    slug = safe_theme_id(theme_id)
    themes = list_themes(themes_dir)
    index = next((i for i, theme in enumerate(themes) if theme.id == slug), None)
    if index is None:
        raise HTTPException(status_code=404, detail=f"Theme “{slug}” not found")

    current = themes[index]
    label = current.label
    if request.label is not None:
        label = request.label.strip()
        if not label:
            raise HTTPException(status_code=400, detail="Theme label is required")
        if any(
            theme.label.lower() == label.lower() and theme.id != slug for theme in themes
        ):
            raise HTTPException(status_code=409, detail=f"Theme label “{label}” already exists")

    sort_order = current.sort_order if request.sort_order is None else request.sort_order
    updated = ThemeInfo(
        id=current.id,
        label=label,
        sort_order=sort_order,
        created_at=current.created_at,
    )
    themes[index] = updated
    themes.sort(key=lambda theme: (theme.sort_order, theme.label.lower(), theme.id))
    _write_index(themes_dir, themes)
    return updated


def delete_theme(themes_dir: Path, theme_id: str) -> None:
    slug = safe_theme_id(theme_id)
    themes = list_themes(themes_dir)
    next_themes = [theme for theme in themes if theme.id != slug]
    if len(next_themes) == len(themes):
        raise HTTPException(status_code=404, detail=f"Theme “{slug}” not found")
    _write_index(themes_dir, next_themes)


def reorder_themes(themes_dir: Path, theme_ids: list[str]) -> list[ThemeInfo]:
    themes = list_themes(themes_dir)
    by_id = {theme.id: theme for theme in themes}
    ordered: list[ThemeInfo] = []
    seen: set[str] = set()
    for raw_id in theme_ids:
        slug = safe_theme_id(raw_id)
        theme = by_id.get(slug)
        if not theme or slug in seen:
            continue
        ordered.append(theme)
        seen.add(slug)
    for theme in themes:
        if theme.id not in seen:
            ordered.append(theme)
    rewritten = [
        ThemeInfo(
            id=theme.id,
            label=theme.label,
            sort_order=index,
            created_at=theme.created_at,
        )
        for index, theme in enumerate(ordered)
    ]
    _write_index(themes_dir, rewritten)
    return rewritten


def resolve_theme_id(themes_dir: Path, theme_or_label: str) -> str | None:
    """Map a theme id or display label to a catalog theme id."""
    raw = (theme_or_label or "").strip()
    if not raw:
        return None
    themes = list_themes(themes_dir)
    lower = raw.lower()
    for theme in themes:
        if theme.id == lower or theme.id == raw:
            return theme.id
    for theme in themes:
        if theme.label.lower() == lower:
            return theme.id
    # Best-effort slug if it already looks like a theme id.
    slug = re.sub(r"[^a-z0-9_]+", "_", lower).strip("_")
    if slug and THEME_ID_PATTERN.match(slug):
        for theme in themes:
            if theme.id == slug:
                return theme.id
    return None
