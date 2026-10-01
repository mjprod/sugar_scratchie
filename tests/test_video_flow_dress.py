from __future__ import annotations

import shutil
import uuid
from collections.abc import Generator

import pytest

from backend.services.ai_provider import normalize_dress_video_model
from backend.services.video_flow import WORK_DIR


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
