from __future__ import annotations

import asyncio
import io
import uuid
from pathlib import Path

import pytest
from fastapi import HTTPException, UploadFile

from backend.db.models import Theme
from backend.themes_store import (
    delete_default_bgm,
    delete_theme_bgm,
    find_default_bgm,
    list_themes,
    upload_default_bgm,
    upload_theme_bgm,
)


def _path(url: str | None) -> str:
    return (url or "").split("?", 1)[0]


def _upload(data: bytes, filename: str) -> UploadFile:
    return UploadFile(file=io.BytesIO(data), filename=filename)


def test_themes_list_includes_default_bgm(client):
    response = client.get("/api/themes")
    assert response.status_code == 200
    body = response.json()
    assert body["default_bgm"].startswith("/themes/_default/bgm.mp3")
    assert isinstance(body["themes"], list)


def test_default_bgm_upload_replace_and_delete(tmp_path: Path):
    public_dir = tmp_path / "public"
    first = asyncio.run(upload_default_bgm(public_dir, _upload(b"track-a", "a.mp3")))
    assert _path(first) == "/themes/_default/bgm.mp3"
    assert (public_dir / "themes" / "_default" / "bgm.mp3").read_bytes() == b"track-a"

    second = asyncio.run(upload_default_bgm(public_dir, _upload(b"track-b", "b.MP3")))
    assert (public_dir / "themes" / "_default" / "bgm.mp3").read_bytes() == b"track-b"
    assert find_default_bgm(public_dir) == second

    delete_default_bgm(public_dir)
    assert find_default_bgm(public_dir) is None
    with pytest.raises(HTTPException) as exc:
        delete_default_bgm(public_dir)
    assert exc.value.status_code == 404


def test_default_bgm_rejects_non_mp3(tmp_path: Path):
    with pytest.raises(HTTPException) as exc:
        asyncio.run(upload_default_bgm(tmp_path, _upload(b"nope", "clip.wav")))
    assert exc.value.status_code == 400
    assert not (tmp_path / "themes" / "_default" / "bgm.mp3").exists()


def test_theme_bgm_upload_replace_and_delete(db_session, tmp_path: Path):
    theme_id = f"bgm_{uuid.uuid4().hex[:8]}"
    db_session.add(Theme(id=theme_id, label=f"Bgm {theme_id}"))
    db_session.flush()
    themes_dir = tmp_path / "themes"

    info = asyncio.run(
        upload_theme_bgm(db_session, themes_dir, theme_id, _upload(b"theme-a", "theme.mp3"))
    )
    assert _path(info.bgm) == f"/themes/{theme_id}/bgm.mp3"
    assert (themes_dir / theme_id / "bgm.mp3").read_bytes() == b"theme-a"

    replaced = asyncio.run(
        upload_theme_bgm(db_session, themes_dir, theme_id, _upload(b"theme-b", "other.mp3"))
    )
    assert (themes_dir / theme_id / "bgm.mp3").read_bytes() == b"theme-b"
    listed = list_themes(db_session, themes_dir, ensure_defaults=False)
    match = next(theme for theme in listed if theme.id == theme_id)
    assert match.bgm == replaced.bgm

    cleared = delete_theme_bgm(db_session, themes_dir, theme_id)
    assert cleared.bgm is None
    with pytest.raises(HTTPException) as exc:
        delete_theme_bgm(db_session, themes_dir, theme_id)
    assert exc.value.status_code == 404
