from __future__ import annotations

import json
import re
import shutil
import time
from pathlib import Path
from typing import Any

from fastapi import HTTPException, UploadFile
from pydantic import BaseModel, Field

from backend.cards import delete_card, list_cards, public_url

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
    # Display names for the two foil pack slots (product label prefers these over pack Nº).
    "cardPackName",
    "cardPackName2",
)


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
    cardPackName: str | None = None
    cardPackName2: str | None = None
    packFaceVideoUrl: str | None = None
    packFaceVideoUrl2: str | None = None
    swipeVideoUrl: str | None = None
    # theme_id → public URL for model×theme collection avatar.
    theme_avatars: dict[str, str] = Field(default_factory=dict)


class CreateModelRequest(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=120)
    influencerName: str | None = Field(default=None, max_length=120)
    influencerCity: str | None = Field(default=None, max_length=120)
    influencerCountry: str | None = Field(default=None, max_length=120)
    influencerFlag: str | None = Field(default=None, max_length=16)
    cardOverlayColorStart: str | None = Field(default=None, max_length=32)
    cardOverlayColorEnd: str | None = Field(default=None, max_length=32)
    cardPackName: str | None = Field(default=None, max_length=120)
    cardPackName2: str | None = Field(default=None, max_length=120)


class UpdateModelRequest(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=120)
    influencerName: str | None = Field(default=None, max_length=120)
    influencerCity: str | None = Field(default=None, max_length=120)
    influencerCountry: str | None = Field(default=None, max_length=120)
    influencerFlag: str | None = Field(default=None, max_length=16)
    cardOverlayColorStart: str | None = Field(default=None, max_length=32)
    cardOverlayColorEnd: str | None = Field(default=None, max_length=32)
    cardPackName: str | None = Field(default=None, max_length=120)
    cardPackName2: str | None = Field(default=None, max_length=120)


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


def _influencer_from_meta(meta: dict) -> dict[str, str | None]:
    return {key: _clean_optional_str(meta.get(key)) for key in INFLUENCER_META_KEYS}


def _model_info(
    model_id: str,
    *,
    label: str,
    avatar: str | None,
    created_at: float | None,
    influencer: dict[str, str | None] | None = None,
    influencer_flag_svg: str | None = None,
    pack_face_video_url: str | None = None,
    pack_face_video_url_2: str | None = None,
    swipe_video_url: str | None = None,
    theme_avatars: dict[str, str] | None = None,
) -> ModelInfo:
    fields = influencer or {key: None for key in INFLUENCER_META_KEYS}
    return ModelInfo(
        id=model_id,
        label=label,
        avatar=avatar,
        created_at=created_at,
        influencerName=fields.get("influencerName"),
        influencerCity=fields.get("influencerCity"),
        influencerCountry=fields.get("influencerCountry"),
        influencerFlag=fields.get("influencerFlag"),
        influencerFlagSvg=influencer_flag_svg,
        cardOverlayColorStart=fields.get("cardOverlayColorStart"),
        cardOverlayColorEnd=fields.get("cardOverlayColorEnd"),
        cardPackName=fields.get("cardPackName"),
        cardPackName2=fields.get("cardPackName2"),
        packFaceVideoUrl=pack_face_video_url,
        packFaceVideoUrl2=pack_face_video_url_2,
        swipeVideoUrl=swipe_video_url,
        theme_avatars=theme_avatars or {},
    )


def _model_info_from_dir(model_dir: Path, *, label: str, created_at: float | None) -> ModelInfo:
    meta = read_model_meta(model_dir, label)
    videos = find_model_videos(model_dir)
    return _model_info(
        model_dir.name,
        label=label,
        avatar=find_avatar(model_dir),
        created_at=created_at,
        influencer=_influencer_from_meta(meta),
        influencer_flag_svg=find_flag_svg(model_dir),
        pack_face_video_url=videos.get("packFaceVideoUrl"),
        pack_face_video_url_2=videos.get("packFaceVideoUrl2"),
        swipe_video_url=videos.get("swipeVideoUrl"),
        theme_avatars=find_theme_avatars(model_dir),
    )


def read_model_meta(model_dir: Path, default_label: str) -> dict:
    meta = model_dir / "meta.json"
    if not meta.exists():
        return {"label": default_label}
    try:
        data = json.loads(meta.read_text())
        if isinstance(data, dict):
            # Migrate short-lived influencerColor* keys → cardOverlayColor*.
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


def write_model_meta(
    model_dir: Path,
    *,
    label: str,
    created_at: float | None = None,
    influencerName: str | None = None,
    influencerCity: str | None = None,
    influencerCountry: str | None = None,
    influencerFlag: str | None = None,
    cardOverlayColorStart: str | None = None,
    cardOverlayColorEnd: str | None = None,
    cardPackName: str | None = None,
    cardPackName2: str | None = None,
) -> None:
    meta = model_dir / "meta.json"
    data: dict = {}
    if meta.exists():
        try:
            loaded = json.loads(meta.read_text())
            if isinstance(loaded, dict):
                data = loaded
        except Exception:
            pass
    data["label"] = label.strip()
    if created_at is not None:
        data["created_at"] = created_at
    elif "created_at" not in data:
        data["created_at"] = time.time()

    # Drop renamed legacy keys if present.
    data.pop("influencerColorStart", None)
    data.pop("influencerColorEnd", None)

    influencer = {
        "influencerName": influencerName,
        "influencerCity": influencerCity,
        "influencerCountry": influencerCountry,
        "influencerFlag": influencerFlag,
        "cardOverlayColorStart": cardOverlayColorStart,
        "cardOverlayColorEnd": cardOverlayColorEnd,
        "cardPackName": cardPackName,
        "cardPackName2": cardPackName2,
    }
    for key, value in influencer.items():
        cleaned = _clean_optional_str(value)
        if cleaned:
            data[key] = cleaned
        else:
            data.pop(key, None)

    model_dir.mkdir(parents=True, exist_ok=True)
    meta.write_text(json.dumps(data, indent=2) + "\n")


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
            # Cache-bust with mtime so the browser refetches after a re-upload —
            # the filename ("flag.svg") never changes, only its contents.
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


def list_models(models_dir: Path) -> list[ModelInfo]:
    if not models_dir.exists():
        return []
    models: list[ModelInfo] = []
    for directory in sorted(path for path in models_dir.iterdir() if path.is_dir()):
        meta = read_model_meta(directory, directory.name.replace("_", " ").title())
        label = meta.get("label")
        if not isinstance(label, str) or not label.strip():
            label = directory.name.replace("_", " ").title()
        created_at = meta.get("created_at")
        models.append(
            _model_info_from_dir(
                directory,
                label=label.strip(),
                created_at=float(created_at) if isinstance(created_at, (int, float)) else None,
            )
        )
    return models


def write_models_index(models_dir: Path) -> None:
    models = list_models(models_dir)
    payload = {
        "models": [
            {
                "id": model.id,
                "label": model.label,
                "avatar": model.avatar,
                "influencerName": model.influencerName,
                "influencerCity": model.influencerCity,
                "influencerCountry": model.influencerCountry,
                "influencerFlag": model.influencerFlag,
                "influencerFlagSvg": model.influencerFlagSvg,
                "cardOverlayColorStart": model.cardOverlayColorStart,
                "cardOverlayColorEnd": model.cardOverlayColorEnd,
                "cardPackName": model.cardPackName,
                "cardPackName2": model.cardPackName2,
                "packFaceVideoUrl": model.packFaceVideoUrl,
                "packFaceVideoUrl2": model.packFaceVideoUrl2,
                "swipeVideoUrl": model.swipeVideoUrl,
                "theme_avatars": model.theme_avatars,
            }
            for model in models
        ]
    }
    models_dir.mkdir(parents=True, exist_ok=True)
    (models_dir / "index.json").write_text(json.dumps(payload, indent=2) + "\n")


def create_model(models_dir: Path, request: CreateModelRequest) -> ModelInfo:
    model_id = safe_model_id(request.id)
    model_dir = models_dir / model_id
    if model_dir.exists():
        raise HTTPException(status_code=409, detail=f"Model already exists: {model_id}")
    created_at = time.time()
    influencer = {
        "influencerName": _clean_optional_str(request.influencerName),
        "influencerCity": _clean_optional_str(request.influencerCity),
        "influencerCountry": _clean_optional_str(request.influencerCountry),
        "influencerFlag": _clean_optional_str(request.influencerFlag),
        "cardOverlayColorStart": _clean_optional_str(request.cardOverlayColorStart),
        "cardOverlayColorEnd": _clean_optional_str(request.cardOverlayColorEnd),
        "cardPackName": _clean_optional_str(request.cardPackName),
        "cardPackName2": _clean_optional_str(request.cardPackName2),
    }
    write_model_meta(
        model_dir,
        label=request.label,
        created_at=created_at,
        **influencer,
    )
    write_models_index(models_dir)
    return _model_info(
        model_id,
        label=request.label.strip(),
        avatar=None,
        created_at=created_at,
        influencer=influencer,
        influencer_flag_svg=None,
        pack_face_video_url=None,
        pack_face_video_url_2=None,
        swipe_video_url=None,
    )


def update_model(models_dir: Path, model_id: str, request: UpdateModelRequest) -> ModelInfo:
    model_dir = models_dir / model_id
    if not model_dir.exists():
        raise HTTPException(status_code=404, detail=f"Model not found: {model_id}")
    meta = read_model_meta(model_dir, model_id.replace("_", " ").title())
    label = request.label.strip() if request.label is not None else str(meta.get("label", model_id))
    existing = _influencer_from_meta(meta)
    # Fields present in the JSON body (including null/"") clear or replace;
    # omitted fields keep their stored value.
    set_fields = request.model_fields_set
    influencer = {
        key: (
            _clean_optional_str(getattr(request, key))
            if key in set_fields
            else existing[key]
        )
        for key in INFLUENCER_META_KEYS
    }
    write_model_meta(model_dir, label=label, **influencer)
    write_models_index(models_dir)
    created_at = meta.get("created_at")
    return _model_info_from_dir(
        model_dir,
        label=label,
        created_at=float(created_at) if isinstance(created_at, (int, float)) else None,
    )


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
    root: Path,
    models_dir: Path,
    cards_dir: Path,
    mesh_dir: Path,
    model_id: str,
) -> None:
    """Delete a model and recursively delete all of its motion cards."""
    model_dir = models_dir / model_id
    if not model_dir.exists():
        raise HTTPException(status_code=404, detail=f"Model not found: {model_id}")
    for card_id in _linked_card_ids(root, cards_dir, mesh_dir, model_id):
        try:
            delete_card(root, cards_dir, mesh_dir, card_id)
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
    shutil.rmtree(model_dir)
    write_models_index(models_dir)


async def upload_model_avatar(models_dir: Path, model_id: str, upload: UploadFile) -> ModelInfo:
    model_dir = models_dir / model_id
    if not model_dir.exists():
        raise HTTPException(status_code=404, detail=f"Model not found: {model_id}")
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
    target = model_dir / f"avatar{ext}"
    target.write_bytes(data)
    write_models_index(models_dir)
    meta = read_model_meta(model_dir, model_id.replace("_", " ").title())
    label = str(meta.get("label", model_id))
    created_at = meta.get("created_at")
    return _model_info_from_dir(
        model_dir,
        label=label,
        created_at=float(created_at) if isinstance(created_at, (int, float)) else None,
    )


async def upload_model_flag_svg(models_dir: Path, model_id: str, upload: UploadFile) -> ModelInfo:
    model_dir = models_dir / model_id
    if not model_dir.exists():
        raise HTTPException(status_code=404, detail=f"Model not found: {model_id}")
    original = Path(upload.filename or "").name
    ext = Path(original).suffix.lower()
    if ext not in FLAG_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Flag must be an SVG file")
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded flag is empty")
    # Basic sanity check — reject obvious non-SVG payloads.
    head = data[:256].lstrip().lower()
    if b"<svg" not in head and not head.startswith(b"<?xml"):
        raise HTTPException(status_code=400, detail="Flag file does not look like SVG")
    for old_ext in FLAG_EXTENSIONS:
        old = model_dir / f"flag{old_ext}"
        if old.exists():
            old.unlink()
    target = model_dir / f"flag{ext}"
    target.write_bytes(data)
    write_models_index(models_dir)
    meta = read_model_meta(model_dir, model_id.replace("_", " ").title())
    label = str(meta.get("label", model_id))
    created_at = meta.get("created_at")
    return _model_info_from_dir(
        model_dir,
        label=label,
        created_at=float(created_at) if isinstance(created_at, (int, float)) else None,
    )


def delete_model_flag_svg(models_dir: Path, model_id: str) -> ModelInfo:
    model_dir = models_dir / model_id
    if not model_dir.exists():
        raise HTTPException(status_code=404, detail=f"Model not found: {model_id}")
    removed = False
    for ext in FLAG_EXTENSIONS:
        path = model_dir / f"flag{ext}"
        if path.is_file():
            path.unlink()
            removed = True
    if not removed:
        raise HTTPException(status_code=404, detail=f"Flag SVG not found for model {model_id}")
    write_models_index(models_dir)
    meta = read_model_meta(model_dir, model_id.replace("_", " ").title())
    label = str(meta.get("label", model_id))
    created_at = meta.get("created_at")
    return _model_info_from_dir(
        model_dir,
        label=label,
        created_at=float(created_at) if isinstance(created_at, (int, float)) else None,
    )


async def upload_model_video(
    models_dir: Path,
    model_id: str,
    stem: str,
    upload: UploadFile,
) -> ModelInfo:
    if stem not in MODEL_VIDEO_STEMS:
        raise HTTPException(status_code=400, detail=f"Unknown video kind: {stem}")
    model_dir = models_dir / model_id
    if not model_dir.exists():
        raise HTTPException(status_code=404, detail=f"Model not found: {model_id}")
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
    target = model_dir / f"{stem}{ext}"
    target.write_bytes(data)
    write_models_index(models_dir)
    meta = read_model_meta(model_dir, model_id.replace("_", " ").title())
    label = str(meta.get("label", model_id))
    created_at = meta.get("created_at")
    return _model_info_from_dir(
        model_dir,
        label=label,
        created_at=float(created_at) if isinstance(created_at, (int, float)) else None,
    )


async def upload_model_theme_avatar(
    models_dir: Path,
    model_id: str,
    theme_id: str,
    upload: UploadFile,
) -> ModelInfo:
    model_dir = models_dir / model_id
    if not model_dir.exists():
        raise HTTPException(status_code=404, detail=f"Model not found: {model_id}")
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
    target = theme_dir / f"avatar{ext}"
    target.write_bytes(data)
    write_models_index(models_dir)
    meta = read_model_meta(model_dir, model_id.replace("_", " ").title())
    label = str(meta.get("label", model_id))
    created_at = meta.get("created_at")
    return _model_info_from_dir(
        model_dir,
        label=label,
        created_at=float(created_at) if isinstance(created_at, (int, float)) else None,
    )


def delete_model_theme_avatar(
    models_dir: Path,
    model_id: str,
    theme_id: str,
) -> ModelInfo:
    model_dir = models_dir / model_id
    if not model_dir.exists():
        raise HTTPException(status_code=404, detail=f"Model not found: {model_id}")
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
            detail=f"Theme avatar not found for model {model_id} / theme {slug}",
        )
    if theme_dir.is_dir() and not any(theme_dir.iterdir()):
        theme_dir.rmdir()
    write_models_index(models_dir)
    meta = read_model_meta(model_dir, model_id.replace("_", " ").title())
    label = str(meta.get("label", model_id))
    created_at = meta.get("created_at")
    return _model_info_from_dir(
        model_dir,
        label=label,
        created_at=float(created_at) if isinstance(created_at, (int, float)) else None,
    )
