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

from backend.cards import delete_card, list_cards, public_url
from backend.db.models import Creator

MODEL_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_]*$")

AVATAR_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
FLAG_EXTENSIONS = {".svg"}
VIDEO_EXTENSIONS = {".mp4", ".webm"}

# Stem → ModelInfo field for per-model foil/swipe videos (Global media).
MODEL_VIDEO_STEMS: dict[str, str] = {
    "pack-face": "packFaceVideoUrl",
    "pack-face-2": "packFaceVideoUrl2",
    "swipe": "swipeVideoUrl",
}

INFLUENCER_META_KEYS = (
    "influencerName",
    "influencerCity",
    "influencerCountry",
    "influencerFlag",
    "cardOverlayColorStart",
    "cardOverlayColorEnd",
    "cardLightColor1",
    "cardLightColor2",
    "cardPackName",
    "cardPackName2",
)

_INFLUENCER_COLUMNS = {
    "influencerName": "influencer_name",
    "influencerCity": "influencer_city",
    "influencerCountry": "influencer_country",
    "influencerFlag": "influencer_flag",
    "cardOverlayColorStart": "card_overlay_color_start",
    "cardOverlayColorEnd": "card_overlay_color_end",
    "cardLightColor1": "card_light_color_1",
    "cardLightColor2": "card_light_color_2",
    "cardPackName": "card_pack_name",
    "cardPackName2": "card_pack_name_2",
}


class ModelInfo(BaseModel):
    id: str
    label: str
    avatar: str | None = None
    created_at: float | None = None
    influencerName: str | None = None
    influencerCity: str | None = None
    influencerCountry: str | None = None
    influencerFlag: str | None = None
    influencerFlagSvg: str | None = None
    cardOverlayColorStart: str | None = None
    cardOverlayColorEnd: str | None = None
    cardLightColor1: str | None = None
    cardLightColor2: str | None = None
    cardPackName: str | None = None
    cardPackName2: str | None = None
    packFaceVideoUrl: str | None = None
    packFaceVideoUrl2: str | None = None
    swipeVideoUrl: str | None = None
    # theme_id → public URL for model×theme collection avatar.
    theme_avatars: dict[str, str] = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list)


class CreateModelRequest(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=120)
    influencerName: str | None = Field(default=None, max_length=120)
    influencerCity: str | None = Field(default=None, max_length=120)
    influencerCountry: str | None = Field(default=None, max_length=120)
    influencerFlag: str | None = Field(default=None, max_length=16)
    cardOverlayColorStart: str | None = Field(default=None, max_length=32)
    cardOverlayColorEnd: str | None = Field(default=None, max_length=32)
    cardLightColor1: str | None = Field(default=None, max_length=32)
    cardLightColor2: str | None = Field(default=None, max_length=32)
    cardPackName: str | None = Field(default=None, max_length=120)
    cardPackName2: str | None = Field(default=None, max_length=120)
    tags: list[str] | None = None


class UpdateModelRequest(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=120)
    influencerName: str | None = Field(default=None, max_length=120)
    influencerCity: str | None = Field(default=None, max_length=120)
    influencerCountry: str | None = Field(default=None, max_length=120)
    influencerFlag: str | None = Field(default=None, max_length=16)
    cardOverlayColorStart: str | None = Field(default=None, max_length=32)
    cardOverlayColorEnd: str | None = Field(default=None, max_length=32)
    cardLightColor1: str | None = Field(default=None, max_length=32)
    cardLightColor2: str | None = Field(default=None, max_length=32)
    cardPackName: str | None = Field(default=None, max_length=120)
    cardPackName2: str | None = Field(default=None, max_length=120)
    tags: list[str] | None = None


def safe_model_id(value: str) -> str:
    slug = re.sub(r"[^a-z0-9_]+", "_", value.strip().lower()).strip("_")
    if not slug or not MODEL_ID_PATTERN.match(slug):
        raise HTTPException(
            status_code=400,
            detail="Model id must start with a letter and contain only lowercase letters, numbers, and underscores",
        )
    return slug


def _clean_optional_str(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _normalize_tags(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        raw = value.split(",")
    elif isinstance(value, list):
        raw = value
    else:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        tag = item.strip().lower()
        if not tag or tag in seen:
            continue
        seen.add(tag)
        out.append(tag)
    return out


def _influencer_fields(source: Any) -> dict[str, str | None]:
    return {key: _clean_optional_str(getattr(source, key, None)) for key in INFLUENCER_META_KEYS}


def read_model_meta(model_dir: Path, default_label: str) -> dict:
    """Read legacy meta.json (bootstrap only)."""
    meta = model_dir / "meta.json"
    if not meta.exists():
        return {"label": default_label}
    try:
        data = json.loads(meta.read_text())
        if isinstance(data, dict):
            if not data.get("cardOverlayColorStart") and data.get("influencerColorStart"):
                data["cardOverlayColorStart"] = data.pop("influencerColorStart")
            elif "influencerColorStart" in data:
                data.pop("influencerColorStart", None)
            if not data.get("cardOverlayColorEnd") and data.get("influencerColorEnd"):
                data["cardOverlayColorEnd"] = data.pop("influencerColorEnd")
            elif "influencerColorEnd" in data:
                data.pop("influencerColorEnd", None)
            return data
    except Exception:
        pass
    return {"label": default_label}


def find_avatar(model_dir: Path) -> str | None:
    for ext in AVATAR_EXTENSIONS:
        candidate = model_dir / f"avatar{ext}"
        if candidate.is_file():
            return public_url(f"models/{model_dir.name}/avatar{ext}")
    return None


def find_theme_avatars(model_dir: Path) -> dict[str, str]:
    """Discover per-theme avatars under models/{id}/themes/{theme_id}/avatar.*."""
    themes_root = model_dir / "themes"
    if not themes_root.is_dir():
        return {}
    found: dict[str, str] = {}
    for theme_dir in sorted(path for path in themes_root.iterdir() if path.is_dir()):
        theme_id = theme_dir.name
        if not MODEL_ID_PATTERN.match(theme_id):
            continue
        for ext in AVATAR_EXTENSIONS:
            candidate = theme_dir / f"avatar{ext}"
            if candidate.is_file():
                found[theme_id] = public_url(
                    f"models/{model_dir.name}/themes/{theme_id}/avatar{ext}"
                )
                break
    return found


def find_flag_svg(model_dir: Path) -> str | None:
    for ext in FLAG_EXTENSIONS:
        candidate = model_dir / f"flag{ext}"
        if candidate.is_file():
            url = public_url(f"models/{model_dir.name}/flag{ext}")
            try:
                version = int(candidate.stat().st_mtime)
            except OSError:
                version = 0
            return f"{url}?v={version}"
    return None


def find_model_video(model_dir: Path, stem: str) -> str | None:
    for ext in VIDEO_EXTENSIONS:
        candidate = model_dir / f"{stem}{ext}"
        if candidate.is_file():
            return public_url(f"models/{model_dir.name}/{stem}{ext}")
    return None


def find_model_videos(model_dir: Path) -> dict[str, str | None]:
    return {
        field: find_model_video(model_dir, stem)
        for stem, field in MODEL_VIDEO_STEMS.items()
    }


def _created_at_unix(value: datetime | None) -> float | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.timestamp()


def _parse_legacy_created_at(value: Any) -> datetime:
    if isinstance(value, (int, float)) and value > 0:
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    return datetime.now(timezone.utc)


def _row_to_info(row: Creator, models_dir: Path) -> ModelInfo:
    model_dir = models_dir / row.id
    videos = find_model_videos(model_dir) if model_dir.is_dir() else {}
    return ModelInfo(
        id=row.id,
        label=row.label,
        avatar=find_avatar(model_dir) if model_dir.is_dir() else None,
        created_at=_created_at_unix(row.created_at),
        influencerName=row.influencer_name,
        influencerCity=row.influencer_city,
        influencerCountry=row.influencer_country,
        influencerFlag=row.influencer_flag,
        influencerFlagSvg=find_flag_svg(model_dir) if model_dir.is_dir() else None,
        cardOverlayColorStart=row.card_overlay_color_start,
        cardOverlayColorEnd=row.card_overlay_color_end,
        cardLightColor1=row.card_light_color_1,
        cardLightColor2=row.card_light_color_2,
        cardPackName=row.card_pack_name,
        cardPackName2=row.card_pack_name_2,
        packFaceVideoUrl=videos.get("packFaceVideoUrl"),
        packFaceVideoUrl2=videos.get("packFaceVideoUrl2"),
        swipeVideoUrl=videos.get("swipeVideoUrl"),
        theme_avatars=find_theme_avatars(model_dir) if model_dir.is_dir() else {},
        tags=_normalize_tags(row.tags),
    )


def _model_count(db: Session) -> int:
    return int(db.scalar(select(func.count()).select_from(Creator)) or 0)


def _require_creator(db: Session, model_id: str) -> Creator:
    slug = safe_model_id(model_id)
    row = db.get(Creator, slug)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Model not found: {slug}")
    return row


def _import_from_disk(db: Session, models_dir: Path) -> int:
    if not models_dir.is_dir():
        return 0
    imported = 0
    for directory in sorted(path for path in models_dir.iterdir() if path.is_dir()):
        model_id = directory.name
        if not MODEL_ID_PATTERN.match(model_id):
            continue
        if db.get(Creator, model_id) is not None:
            continue
        meta = read_model_meta(directory, model_id.replace("_", " ").title())
        label = meta.get("label")
        if not isinstance(label, str) or not label.strip():
            label = model_id.replace("_", " ").title()
        else:
            label = label.strip()
        kwargs = {
            col: _clean_optional_str(meta.get(key)) for key, col in _INFLUENCER_COLUMNS.items()
        }
        db.add(
            Creator(
                id=model_id,
                label=label,
                created_at=_parse_legacy_created_at(meta.get("created_at")),
                updated_at=datetime.now(timezone.utc),
                tags=_normalize_tags(meta.get("tags")),
                **kwargs,
            )
        )
        imported += 1
    if imported:
        db.flush()
    return imported


def ensure_models_bootstrapped(db: Session, models_dir: Path) -> list[ModelInfo]:
    """Seed models from on-disk meta.json when the table is empty."""
    if _model_count(db) == 0:
        _import_from_disk(db, models_dir)
    return list_models(db, models_dir)


def list_models(db: Session, models_dir: Path) -> list[ModelInfo]:
    rows = db.scalars(select(Creator).order_by(Creator.label, Creator.id)).all()
    return [_row_to_info(row, models_dir) for row in rows]


def get_model(db: Session, models_dir: Path, model_id: str) -> ModelInfo:
    row = _require_creator(db, model_id)
    return _row_to_info(row, models_dir)


def model_exists(db: Session, model_id: str) -> bool:
    try:
        slug = safe_model_id(model_id)
    except HTTPException:
        return False
    return db.get(Creator, slug) is not None


def create_model(db: Session, models_dir: Path, request: CreateModelRequest) -> ModelInfo:
    model_id = safe_model_id(request.id)
    label = request.label.strip()
    if not label:
        raise HTTPException(status_code=400, detail="Model label is required")

    if db.get(Creator, model_id) is not None:
        raise HTTPException(status_code=409, detail=f"Model already exists: {model_id}")

    clash = db.scalar(select(Creator.id).where(func.lower(Creator.label) == label.lower()).limit(1))
    if clash is not None:
        raise HTTPException(status_code=409, detail=f"Model label “{label}” already exists")

    influencer = _influencer_fields(request)
    tags = _normalize_tags(request.tags)
    now = datetime.now(timezone.utc)
    row = Creator(
        id=model_id,
        label=label,
        created_at=now,
        updated_at=now,
        tags=tags,
        influencer_name=influencer["influencerName"],
        influencer_city=influencer["influencerCity"],
        influencer_country=influencer["influencerCountry"],
        influencer_flag=influencer["influencerFlag"],
        card_overlay_color_start=influencer["cardOverlayColorStart"],
        card_overlay_color_end=influencer["cardOverlayColorEnd"],
        card_light_color_1=influencer["cardLightColor1"],
        card_light_color_2=influencer["cardLightColor2"],
        card_pack_name=influencer["cardPackName"],
        card_pack_name_2=influencer["cardPackName2"],
    )
    db.add(row)
    db.flush()
    (models_dir / model_id).mkdir(parents=True, exist_ok=True)
    return _row_to_info(row, models_dir)


def update_model(
    db: Session,
    models_dir: Path,
    model_id: str,
    request: UpdateModelRequest,
) -> ModelInfo:
    row = _require_creator(db, model_id)
    set_fields = request.model_fields_set

    if request.label is not None:
        label = request.label.strip()
        if not label:
            raise HTTPException(status_code=400, detail="Model label is required")
        clash = db.scalar(
            select(Creator.id)
            .where(func.lower(Creator.label) == label.lower(), Creator.id != row.id)
            .limit(1)
        )
        if clash is not None:
            raise HTTPException(status_code=409, detail=f"Model label “{label}” already exists")
        row.label = label

    for api_key, column in _INFLUENCER_COLUMNS.items():
        if api_key in set_fields:
            setattr(row, column, _clean_optional_str(getattr(request, api_key)))

    if "tags" in set_fields:
        row.tags = _normalize_tags(request.tags)

    row.updated_at = datetime.now(timezone.utc)
    db.flush()
    return _row_to_info(row, models_dir)


def _linked_card_ids(
    root: Path,
    cards_dir: Path,
    mesh_dir: Path,
    model_id: str,
) -> list[str]:
    """Published cards + video-flow drafts assigned to this model."""
    linked: set[str] = {
        card.id for card in list_cards(root, cards_dir, mesh_dir) if card.model_id == model_id
    }
    work_root = root / ".tmp" / "video-flow"
    if work_root.is_dir():
        for work in work_root.iterdir():
            if not work.is_dir():
                continue
            draft_file = work / "draft.json"
            if not draft_file.is_file():
                continue
            try:
                data = json.loads(draft_file.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(data, dict):
                continue
            draft_model = data.get("model_id")
            if isinstance(draft_model, str) and draft_model.strip() == model_id:
                linked.add(work.name)
    return sorted(linked)


def delete_model(
    db: Session,
    root: Path,
    models_dir: Path,
    cards_dir: Path,
    mesh_dir: Path,
    model_id: str,
) -> None:
    """Delete a model and recursively delete all of its motion cards."""
    row = _require_creator(db, model_id)
    slug = row.id
    for card_id in _linked_card_ids(root, cards_dir, mesh_dir, slug):
        try:
            delete_card(root, cards_dir, mesh_dir, card_id)
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
    db.delete(row)
    db.flush()
    model_dir = models_dir / slug
    if model_dir.is_dir():
        shutil.rmtree(model_dir, ignore_errors=True)


async def upload_model_avatar(
    db: Session,
    models_dir: Path,
    model_id: str,
    upload: UploadFile,
) -> ModelInfo:
    row = _require_creator(db, model_id)
    model_dir = models_dir / row.id
    model_dir.mkdir(parents=True, exist_ok=True)
    original = Path(upload.filename or "").name
    ext = Path(original).suffix.lower()
    if ext not in AVATAR_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Avatar must be JPG, PNG, or WebP")
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded avatar is empty")
    for old_ext in AVATAR_EXTENSIONS:
        old = model_dir / f"avatar{old_ext}"
        if old.exists():
            old.unlink()
    (model_dir / f"avatar{ext}").write_bytes(data)
    return _row_to_info(row, models_dir)


async def upload_model_flag_svg(
    db: Session,
    models_dir: Path,
    model_id: str,
    upload: UploadFile,
) -> ModelInfo:
    row = _require_creator(db, model_id)
    model_dir = models_dir / row.id
    model_dir.mkdir(parents=True, exist_ok=True)
    original = Path(upload.filename or "").name
    ext = Path(original).suffix.lower()
    if ext not in FLAG_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Flag must be an SVG file")
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded flag is empty")
    head = data[:256].lstrip().lower()
    if b"<svg" not in head and not head.startswith(b"<?xml"):
        raise HTTPException(status_code=400, detail="Flag file does not look like SVG")
    for old_ext in FLAG_EXTENSIONS:
        old = model_dir / f"flag{old_ext}"
        if old.exists():
            old.unlink()
    (model_dir / f"flag{ext}").write_bytes(data)
    return _row_to_info(row, models_dir)


def delete_model_flag_svg(db: Session, models_dir: Path, model_id: str) -> ModelInfo:
    row = _require_creator(db, model_id)
    model_dir = models_dir / row.id
    removed = False
    for ext in FLAG_EXTENSIONS:
        path = model_dir / f"flag{ext}"
        if path.is_file():
            path.unlink()
            removed = True
    if not removed:
        raise HTTPException(status_code=404, detail=f"Flag SVG not found for model {row.id}")
    return _row_to_info(row, models_dir)


async def upload_model_video(
    db: Session,
    models_dir: Path,
    model_id: str,
    stem: str,
    upload: UploadFile,
) -> ModelInfo:
    if stem not in MODEL_VIDEO_STEMS:
        raise HTTPException(status_code=400, detail=f"Unknown video kind: {stem}")
    row = _require_creator(db, model_id)
    model_dir = models_dir / row.id
    model_dir.mkdir(parents=True, exist_ok=True)
    original = Path(upload.filename or "").name
    ext = Path(original).suffix.lower()
    if ext not in VIDEO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Video must be MP4 or WebM")
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded video is empty")
    for old_ext in VIDEO_EXTENSIONS:
        old = model_dir / f"{stem}{old_ext}"
        if old.exists():
            old.unlink()
    (model_dir / f"{stem}{ext}").write_bytes(data)
    return _row_to_info(row, models_dir)


async def upload_model_theme_avatar(
    db: Session,
    models_dir: Path,
    model_id: str,
    theme_id: str,
    upload: UploadFile,
) -> ModelInfo:
    row = _require_creator(db, model_id)
    model_dir = models_dir / row.id
    slug = safe_model_id(theme_id)
    original = Path(upload.filename or "").name
    ext = Path(original).suffix.lower()
    if ext not in AVATAR_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Avatar must be JPG, PNG, or WebP")
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded avatar is empty")
    theme_dir = model_dir / "themes" / slug
    theme_dir.mkdir(parents=True, exist_ok=True)
    for old_ext in AVATAR_EXTENSIONS:
        old = theme_dir / f"avatar{old_ext}"
        if old.exists():
            old.unlink()
    (theme_dir / f"avatar{ext}").write_bytes(data)
    return _row_to_info(row, models_dir)


def delete_model_theme_avatar(
    db: Session,
    models_dir: Path,
    model_id: str,
    theme_id: str,
) -> ModelInfo:
    row = _require_creator(db, model_id)
    model_dir = models_dir / row.id
    slug = safe_model_id(theme_id)
    theme_dir = model_dir / "themes" / slug
    removed = False
    for ext in AVATAR_EXTENSIONS:
        path = theme_dir / f"avatar{ext}"
        if path.is_file():
            path.unlink()
            removed = True
    if not removed:
        raise HTTPException(
            status_code=404,
            detail=f"Theme avatar not found for model {row.id} / theme {slug}",
        )
    if theme_dir.is_dir() and not any(theme_dir.iterdir()):
        theme_dir.rmdir()
    return _row_to_info(row, models_dir)


def list_models_standalone(models_dir: Path) -> list[ModelInfo]:
    """List models using a short-lived DB session (non-request call sites)."""
    import backend.db.engine as db_engine

    db_engine.get_engine()
    assert db_engine.SessionLocal is not None
    session = db_engine.SessionLocal()
    try:
        return list_models(session, models_dir)
    finally:
        session.close()
