from __future__ import annotations

import shutil
import uuid
from collections.abc import Generator
from pathlib import Path

import pytest

from backend.services.ai_provider import normalize_dress_video_model
from backend.services.video_flow import WORK_DIR, _resolve_photo_scratch_media, work_dir, write_state


@pytest.fixture
def card_id() -> Generator[str, None, None]:
    value = f"test_dress_{uuid.uuid4().hex[:10]}"
    yield value
    shutil.rmtree(WORK_DIR / value, ignore_errors=True)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("seedance-2.0-video-edit", "seedance-2.0-video-edit"),
        ("bytedance/seedance-2.0/video-edit", "seedance-2.0-video-edit"),
        ("wan-3.0-video-edit", "wan-3.0-video-edit"),
        ("alibaba/wan-3.0/video-edit", "wan-3.0-video-edit"),
        ("grok-imagine", "grok-imagine"),
        ("wan-2.2-video-edit", "wan-2.2-video-edit"),
        (None, "grok-imagine"),
        ("unknown", "grok-imagine"),
    ],
)
def test_normalize_dress_video_model(raw: str | None, expected: str):
    assert normalize_dress_video_model(raw) == expected


def test_dress_video_default_is_grok():
    from backend.services.generation_models import default_spec

    assert default_spec("dress_video").id == "grok-imagine"
    assert normalize_dress_video_model(None) == "grok-imagine"


def test_resolve_photo_scratch_media_strips_cache_bust(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import backend.services.video_flow as video_flow

    image = tmp_path / "public" / "cards" / "demo" / "photo-scratch" / "pending" / "slot_01_background.jpg"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"jpg")
    monkeypatch.setattr(video_flow, "ROOT", tmp_path)

    resolved = _resolve_photo_scratch_media(
        "/cards/demo/photo-scratch/pending/slot_01_background.jpg?v=1791956870"
    )
    assert resolved == image


def test_import_dress_requires_operator(client, card_id):
    response = client.post(
        f"/api/video-flow/{card_id}/import-dress",
        json={"foreground": "package.json"},
    )
    assert response.status_code == 401


def test_import_dress_requires_fix_frames_approved(client, dashboard_headers, card_id):
    response = client.post(
        f"/api/video-flow/{card_id}/import-dress",
        json={"foreground": "package.json"},
        headers=dashboard_headers,
    )
    assert response.status_code == 400, response.text
    assert "before uploading a dress video" in response.json()["detail"]


def test_import_dress_rejects_paths_outside_project(client, dashboard_headers, card_id):
    response = client.post(
        f"/api/video-flow/{card_id}/import-dress",
        json={"foreground": "/etc/hosts"},
        headers=dashboard_headers,
    )
    assert response.status_code == 400


def test_import_dress_happy_path_moves_to_review_and_resets_downstream(
    client,
    dashboard_headers,
    card_id,
    monkeypatch,
):
    work = work_dir(card_id)
    background = work / "background-raw.mp4"
    dress_new = work / "manual-dress-import.mp4"

    background.write_bytes(b"fake-video")
    dress_new.write_bytes(b"fake-dress-video")
    write_state(work, {"approved": ["background", "trim", "dress", "card", "mesh", "symbols", "compress"]})

    monkeypatch.setattr(
        "backend.services.video_flow.output_video_ready",
        lambda path: path.exists() and path.stat().st_size > 0,
    )
    monkeypatch.setattr(
        "backend.services.video_flow.probe_video",
        lambda path: {"width": 390, "height": 672, "duration": 1.0},
    )

    response = client.post(
        f"/api/video-flow/{card_id}/import-dress",
        json={"foreground": str(dress_new)},
        headers=dashboard_headers,
    )
    assert response.status_code == 200, response.text

    result = response.json()
    assert result["approved"] == ["picture", "background", "trim"]
    assert result["steps"]["dress"]["status"] == "review"
    assert result["steps"]["card"]["status"] == "locked"
    assert result["steps"]["mesh"]["status"] == "locked"
    assert result["steps"]["compress"]["status"] == "locked"
