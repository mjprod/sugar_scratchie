"""EvoLink client: upload, submit, poll, download with mocked HTTP."""

from __future__ import annotations

import json
from pathlib import Path
from urllib.request import Request

import pytest

from backend.services import evolink


class _FakeResponse:
    def __init__(self, payload: dict | bytes, *, status: int = 200):
        self._payload = payload
        self.status = status

    def read(self) -> bytes:
        if isinstance(self._payload, (bytes, bytearray)):
            return bytes(self._payload)
        return json.dumps(self._payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_image_to_video_uploads_submits_polls_and_downloads(monkeypatch, tmp_path):
    monkeypatch.setenv("EVOLINK_API_KEY", "ev-test")
    monkeypatch.setenv("EVOLINK_API_BASE", "https://api.evolink.test")
    monkeypatch.setenv("EVOLINK_FILES_BASE", "https://files.evolink.test")

    still = tmp_path / "still.png"
    still.write_bytes(b"\x89PNG\r\n\x1a\nfake")
    out = tmp_path / "out.mp4"
    calls: list[tuple[str, str]] = []
    downloaded: list[tuple[str, Path]] = []

    def fake_urlopen(req: Request, timeout: float = 0):
        url = req.full_url
        method = req.get_method()
        calls.append((method, url))
        user_agent = req.get_header("User-agent")
        assert user_agent and not user_agent.startswith("Python-urllib")
        if url.endswith("/api/v1/files/upload/stream"):
            assert method == "POST"
            assert b"still.png" in (req.data or b"")
            return _FakeResponse(
                {
                    "success": True,
                    "data": {
                        "file_id": "file_1",
                        "file_url": "https://files.evolink.test/photos/still.png",
                    },
                }
            )
        if url.endswith("/v1/videos/generations"):
            body = json.loads(req.data.decode("utf-8"))
            assert body["model"] == "seedance-2.0-image-to-video"
            assert body["image_urls"] == ["https://files.evolink.test/photos/still.png"]
            assert body["generate_audio"] is False
            assert body["quality"] == "720p"
            return _FakeResponse({"id": "task-video-1", "status": "pending"})
        if url.endswith("/v1/tasks/task-video-1"):
            return _FakeResponse(
                {
                    "id": "task-video-1",
                    "status": "completed",
                    "progress": 100,
                    "results": ["https://cdn.evolink.test/result.mp4"],
                }
            )
        raise AssertionError(f"unexpected request {method} {url}")

    def fake_download(url: str, dest: Path) -> None:
        downloaded.append((url, dest))
        dest.write_bytes(b"mp4-bytes")

    monkeypatch.setattr(evolink.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(evolink, "download_video", fake_download)
    monkeypatch.setattr(evolink, "POLL_INTERVAL_S", 0)

    evolink.image_to_video(
        image=still,
        prompt="tiny sway",
        out=out,
        model="seedance-2.0-image-to-video",
        label="test i2v",
    )

    assert out.read_bytes() == b"mp4-bytes"
    assert downloaded == [("https://cdn.evolink.test/result.mp4", out)]
    assert ("POST", "https://files.evolink.test/api/v1/files/upload/stream") in calls
    assert ("POST", "https://api.evolink.test/v1/videos/generations") in calls
    assert ("GET", "https://api.evolink.test/v1/tasks/task-video-1") in calls


def test_edit_video_reference_sends_video_and_image_urls(monkeypatch, tmp_path):
    monkeypatch.setenv("EVOLINK_API_KEY", "ev-test")
    monkeypatch.setenv("EVOLINK_API_BASE", "https://api.evolink.test")
    monkeypatch.setenv("EVOLINK_FILES_BASE", "https://files.evolink.test")

    clip = tmp_path / "in.mp4"
    clip.write_bytes(b"fake-mp4")
    outfit = tmp_path / "outfit.png"
    outfit.write_bytes(b"\x89PNG\r\n\x1a\noutfit")
    out = tmp_path / "out.mp4"
    uploaded: list[str] = []

    def fake_urlopen(req: Request, timeout: float = 0):
        url = req.full_url
        if url.endswith("/api/v1/files/upload/stream"):
            name = "clip" if b"in.mp4" in (req.data or b"") else "outfit"
            file_url = f"https://files.evolink.test/{name}"
            uploaded.append(file_url)
            return _FakeResponse({"data": {"file_url": file_url}})
        if url.endswith("/v1/videos/generations"):
            body = json.loads(req.data.decode("utf-8"))
            assert body["model"] == "seedance-2.0-reference-to-video"
            assert body["video_urls"] == ["https://files.evolink.test/clip"]
            assert body["image_urls"] == ["https://files.evolink.test/outfit"]
            assert "@video1" in body["prompt"]
            return _FakeResponse({"id": "task-edit-1"})
        if url.endswith("/v1/tasks/task-edit-1"):
            return _FakeResponse({"status": "completed", "results": ["https://cdn.evolink.test/edit.mp4"]})
        raise AssertionError(url)

    def fake_download(url: str, dest: Path) -> None:
        dest.write_bytes(b"edited")

    monkeypatch.setattr(evolink.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(evolink, "download_video", fake_download)
    monkeypatch.setattr(evolink, "POLL_INTERVAL_S", 0)
    monkeypatch.setattr(evolink, "prepare_compatible_video", lambda src, **kwargs: src)

    evolink.edit_video_reference(
        video=clip,
        prompt="Edit @video1. Dress her from @image1.",
        out=out,
        reference_image=outfit,
        model="seedance-2.0-reference-to-video",
    )
    assert out.read_bytes() == b"edited"
    assert uploaded == ["https://files.evolink.test/outfit", "https://files.evolink.test/clip"]


def test_api_key_required(monkeypatch):
    monkeypatch.delenv("EVOLINK_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="EVOLINK_API_KEY"):
        evolink.api_key()
