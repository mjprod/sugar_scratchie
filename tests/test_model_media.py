from __future__ import annotations

import asyncio
import io
import uuid
from pathlib import Path

import pytest
from fastapi import HTTPException, UploadFile
from PIL import Image

from backend.db.models import Creator
from backend.models_store import (
    AVATAR_MAX_PX,
    COVER_MAX_PX,
    upload_model_avatar,
    upload_model_poster,
    upload_model_theme_avatar,
)


def _png(width: int, height: int) -> bytes:
    img = Image.radial_gradient("L").resize((width, height)).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _path(url: str | None) -> str:
    return (url or "").split("?", 1)[0]


def _upload(data: bytes, filename: str) -> UploadFile:
    return UploadFile(file=io.BytesIO(data), filename=filename)


@pytest.fixture
def model(db_session, tmp_path: Path) -> tuple[str, Path]:
    model_id = f"test_media_{uuid.uuid4().hex[:8]}"
    db_session.add(Creator(id=model_id, label="Media test"))
    db_session.flush()
    return model_id, tmp_path / "public" / "models"


def test_avatar_upload_is_resized_webp_and_replaces_old(db_session, model):
    model_id, models_dir = model
    model_dir = models_dir / model_id
    model_dir.mkdir(parents=True)
    (model_dir / "avatar.png").write_bytes(b"stale")
    data = _png(3000, 4000)

    info = asyncio.run(
        upload_model_avatar(db_session, models_dir, model_id, _upload(data, "big.png"))
    )

    assert _path(info.avatar) == f"/models/{model_id}/avatar.webp"
    assert not (model_dir / "avatar.png").exists()
    out = model_dir / "avatar.webp"
    assert out.stat().st_size < len(data)
    with Image.open(out) as img:
        assert img.format == "WEBP"
        assert max(img.size) == AVATAR_MAX_PX
        assert img.size == (384, 512)
    backup = models_dir.parent.parent / ".image-backups" / "models" / model_id / "avatar.png"
    assert backup.read_bytes() == data


def test_cover_upload_is_resized_webp(db_session, model):
    model_id, models_dir = model
    data = _png(3280, 1248)

    info = asyncio.run(
        upload_model_poster(db_session, models_dir, model_id, "cover", _upload(data, "cover.png"))
    )

    assert _path(info.coverUrl) == f"/models/{model_id}/cover.webp"
    with Image.open(models_dir / model_id / "cover.webp") as img:
        assert img.format == "WEBP"
        assert img.size == (COVER_MAX_PX, 624)


def test_theme_avatar_upload_is_resized_webp(db_session, model):
    model_id, models_dir = model

    info = asyncio.run(
        upload_model_theme_avatar(
            db_session, models_dir, model_id, "police", _upload(_png(1200, 1200), "a.png")
        )
    )

    assert _path(info.theme_avatars["police"]) == f"/models/{model_id}/themes/police/avatar.webp"
    with Image.open(models_dir / model_id / "themes" / "police" / "avatar.webp") as img:
        assert img.size == (AVATAR_MAX_PX, AVATAR_MAX_PX)


def test_video_paired_poster_keeps_original_bytes(db_session, model):
    model_id, models_dir = model
    data = _png(800, 600)

    asyncio.run(
        upload_model_poster(
            db_session, models_dir, model_id, "swipe-poster", _upload(data, "p.png")
        )
    )

    assert (models_dir / model_id / "swipe-poster.png").read_bytes() == data


def test_unreadable_avatar_is_rejected(db_session, model):
    model_id, models_dir = model

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            upload_model_avatar(
                db_session, models_dir, model_id, _upload(b"not an image", "x.png")
            )
        )

    assert exc.value.status_code == 400
    assert not (models_dir / model_id / "avatar.webp").exists()
    assert not (models_dir.parent.parent / ".image-backups").exists()


def test_avatar_upload_requires_operator(client):
    response = client.post(
        "/api/models/julianaval/avatar",
        files={"file": ("a.png", _png(10, 10), "image/png")},
    )
    assert response.status_code == 401
