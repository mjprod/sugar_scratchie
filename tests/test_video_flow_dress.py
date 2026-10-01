from __future__ import annotations

import shutil
import uuid
from collections.abc import Generator

import pytest

from backend.services.ai_provider import normalize_dress_video_model
from backend.services.video_flow import WORK_DIR, work_dir, write_state


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
        (None, "wan-2.2-video-edit"),
        ("unknown", "wan-2.2-video-edit"),
    ],
)
def test_normalize_dress_video_model(raw: str | None, expected: str):
    assert normalize_dress_video_model(raw) == expected


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
    assert result["approved"] == ["background", "trim"]
    assert result["steps"]["dress"]["status"] == "review"
    assert result["steps"]["card"]["status"] == "locked"
    assert result["steps"]["mesh"]["status"] == "locked"
    assert result["steps"]["compress"]["status"] == "locked"
