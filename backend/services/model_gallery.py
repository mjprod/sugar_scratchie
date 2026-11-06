"""Per-model stills saved from Dress, reused as Video Flow pictures."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import threading
import time
from pathlib import Path

from fastapi import HTTPException
from pydantic import BaseModel, Field
from PIL import Image, ImageOps, UnidentifiedImageError

from backend.models_store import safe_model_id

_IMAGE_ID = re.compile(r"^[a-f0-9]{12}$")
_MIME = re.compile(r"^image/[a-zA-Z0-9.+-]+$")
_MAX_EDGE = 2048
_MAX_BYTES = 25 * 1024 * 1024
_PROMPT_MAX = 500

_GUARD = threading.Lock()
_LOCKS: dict[str, threading.Lock] = {}


_KINDS = {"bikini", "cosplay"}
_THEME = re.compile(r"^[a-z0-9-]{1,40}$")


class AddModelGalleryRequest(BaseModel):
    src: str = Field(min_length=1, max_length=40_000_000)
    prompt: str = Field(default="", max_length=2000)
    kind: str = Field(default="", max_length=20)
    theme: str = Field(default="", max_length=40)


def _lock_for(model_id: str) -> threading.Lock:
    with _GUARD:
        lock = _LOCKS.get(model_id)
        if lock is None:
            lock = threading.Lock()
            _LOCKS[model_id] = lock
        return lock


def _gallery_dir(models_dir: Path, model_id: str) -> Path:
    slug = safe_model_id(model_id)
    return models_dir / slug / "gallery"


def _index_path(models_dir: Path, model_id: str) -> Path:
    return _gallery_dir(models_dir, model_id) / "index.json"


def _clean_prompt(value: str) -> str:
    text = " ".join(value.replace("\x00", " ").split())
    return text[:_PROMPT_MAX]


def _read_index(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    images = data.get("images") if isinstance(data, dict) else None
    if not isinstance(images, list):
        return []
    rows: list[dict] = []
    for item in images:
        if not isinstance(item, dict):
            continue
        image_id = item.get("id")
        if not isinstance(image_id, str) or not _IMAGE_ID.fullmatch(image_id):
            continue
        rows.append(item)
    return rows


def _write_index(path: Path, images: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({"images": images}, indent=2) + "\n"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(path)


def _item_prompt(item: dict) -> str:
    prompt = item.get("prompt")
    return prompt if isinstance(prompt, str) else ""


def _item_kind(item: dict) -> str:
    kind = item.get("kind")
    if isinstance(kind, str) and kind in _KINDS:
        return kind
    prompt = _item_prompt(item)
    if prompt.startswith("Bikini"):
        return "bikini"
    if prompt.startswith("Cosplay"):
        return "cosplay"
    return ""


def _item_theme(item: dict) -> str:
    if _item_kind(item) != "cosplay":
        return ""
    theme = item.get("theme")
    if isinstance(theme, str) and _THEME.fullmatch(theme):
        return theme
    return ""


def _clean_kind(kind: str, theme: str) -> tuple[str, str]:
    cleaned_kind = kind.strip().lower()
    cleaned_theme = theme.strip().lower()
    if cleaned_kind not in _KINDS and cleaned_kind != "":
        raise HTTPException(status_code=400, detail="Gallery kind must be bikini or cosplay")
    if cleaned_kind != "cosplay":
        return cleaned_kind, ""
    if cleaned_theme and _THEME.fullmatch(cleaned_theme) is None:
        raise HTTPException(status_code=400, detail="Gallery theme is not a costume id")
    return cleaned_kind, cleaned_theme


def _public_item(model_id: str, item: dict) -> dict:
    image_id = item["id"]
    filename = f"{image_id}.png"
    return {
        "id": image_id,
        # `path` is the repo-relative file Video Flow imports. `url` is served by
        # the API: production nginx only exposes the build's dist/ copy of
        # /models/, which does not include stills saved after deploy.
        "path": f"public/models/{model_id}/gallery/{filename}",
        "url": f"/api/models/{model_id}/gallery/{image_id}.png",
        "prompt": _item_prompt(item),
        "kind": _item_kind(item),
        "theme": _item_theme(item),
        "created_at": item.get("created_at") if isinstance(item.get("created_at"), (int, float)) else 0,
        "created": bool(item.get("created")),
    }


def _decode_png(src: str) -> bytes:
    text = src.strip()
    header, separator, encoded = text.partition(";base64,")
    mime = header.removeprefix("data:").split(";", 1)[0]
    if not separator or not header.startswith("data:") or _MIME.fullmatch(mime) is None:
        raise HTTPException(status_code=400, detail="Gallery image must be a data URI")
    try:
        raw = base64.b64decode(re.sub(r"\s+", "", encoded), validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Gallery image is not valid base64") from exc
    if not raw or len(raw) > _MAX_BYTES:
        raise HTTPException(status_code=400, detail="Gallery image is empty or too large")
    try:
        with Image.open(io.BytesIO(raw)) as opened:
            image = ImageOps.exif_transpose(opened) or opened
            image.load()
            if max(image.size) > _MAX_EDGE:
                image.thumbnail((_MAX_EDGE, _MAX_EDGE), Image.Resampling.LANCZOS)
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
            out = io.BytesIO()
            image.save(out, format="PNG")
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(status_code=400, detail="Gallery image is unreadable") from exc
    encoded = out.getvalue()
    if not encoded:
        raise HTTPException(status_code=400, detail="Gallery image is unreadable")
    return encoded


def gallery_image_file(models_dir: Path, model_id: str, image_id: str) -> Path:
    slug = safe_model_id(model_id)
    if not _IMAGE_ID.fullmatch(image_id):
        raise HTTPException(status_code=404, detail="Gallery image not found")
    folder = _gallery_dir(models_dir, slug).resolve()
    path = (folder / f"{image_id}.png").resolve()
    if folder not in path.parents or not path.is_file():
        raise HTTPException(status_code=404, detail="Gallery image not found")
    return path


def list_gallery(models_dir: Path, model_id: str) -> list[dict]:
    slug = safe_model_id(model_id)
    folder = _gallery_dir(models_dir, slug)
    rows = []
    for item in _read_index(_index_path(models_dir, slug)):
        if not (folder / f"{item['id']}.png").is_file():
            continue
        rows.append(_public_item(slug, item))
    rows.sort(key=lambda row: row["created_at"], reverse=True)
    for row in rows:
        row.pop("created", None)
    return rows


def add_gallery_image(
    *,
    models_dir: Path,
    model_id: str,
    src: str,
    prompt: str = "",
    kind: str = "",
    theme: str = "",
) -> dict:
    slug = safe_model_id(model_id)
    kind, theme = _clean_kind(kind, theme)
    png = _decode_png(src)
    digest = hashlib.sha256(png).hexdigest()
    folder = _gallery_dir(models_dir, slug)
    index = _index_path(models_dir, slug)
    with _lock_for(slug):
        rows = _read_index(index)
        for item in rows:
            if item.get("sha256") == digest and (folder / f"{item['id']}.png").is_file():
                found = _public_item(slug, item)
                found["created"] = False
                return found
        existing_ids = {item["id"] for item in rows}
        image_id = hashlib.sha256(f"{digest}:{time.time_ns()}".encode()).hexdigest()[:12]
        while image_id in existing_ids:
            image_id = hashlib.sha256(f"{image_id}:{time.time_ns()}".encode()).hexdigest()[:12]
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{image_id}.png").write_bytes(png)
        row = {
            "id": image_id,
            "prompt": _clean_prompt(prompt),
            "kind": kind,
            "theme": theme,
            "created_at": round(time.time(), 3),
            "sha256": digest,
        }
        rows.append(row)
        _write_index(index, rows)
    saved = _public_item(slug, row)
    saved["created"] = True
    return saved


def delete_gallery_image(*, models_dir: Path, model_id: str, image_id: str) -> None:
    slug = safe_model_id(model_id)
    if not _IMAGE_ID.fullmatch(image_id):
        raise HTTPException(status_code=404, detail="Gallery image not found")
    folder = _gallery_dir(models_dir, slug)
    index = _index_path(models_dir, slug)
    with _lock_for(slug):
        rows = _read_index(index)
        kept = [item for item in rows if item.get("id") != image_id]
        if len(kept) == len(rows):
            raise HTTPException(status_code=404, detail="Gallery image not found")
        target = folder / f"{image_id}.png"
        target.unlink(missing_ok=True)
        _write_index(index, kept)
