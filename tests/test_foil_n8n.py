from __future__ import annotations

import json
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

from backend.services.foil_n8n import (
    LOCAL_WEBHOOK_URL,
    find_video_url,
    run_foil_pack_n8n,
    send_clip,
    trim_clip,
    webhook_status,
    webhook_url,
    write_pack_video,
)

needs_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe not installed",
)

FAKE_MP4 = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 32


def _make_clip(path: Path, seconds: int) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=64x48:rate=10",
            "-t",
            str(seconds),
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
    )


def test_find_video_url_prefers_explicit_video_fields():
    payload = {
        "url": "https://cdn.example/poster.png",
        "video_url": "https://cdn.example/pack.mp4",
    }
    assert find_video_url(payload) == "https://cdn.example/pack.mp4"
    assert find_video_url({"output": "https://cdn.example/pack.webm"}) == (
        "https://cdn.example/pack.webm"
    )
    assert find_video_url([{"data": {"videoUrl": "https://cdn.example/b.mov"}}]) == (
        "https://cdn.example/b.mov"
    )
    assert find_video_url({"ok": True, "url": "https://cdn.example/not-a-video"}) is None


def test_write_pack_video_replaces_other_extension(tmp_path: Path):
    model_dir = tmp_path / "ada"
    model_dir.mkdir()
    (model_dir / "pack-face.webm").write_bytes(b"old")

    public = write_pack_video(tmp_path, "ada", "pack-face", FAKE_MP4, ".mp4")

    assert public == "/models/ada/pack-face.mp4"
    assert (model_dir / "pack-face.mp4").read_bytes() == FAKE_MP4
    assert not (model_dir / "pack-face.webm").exists()


def test_write_pack_video_rejects_non_video(tmp_path: Path):
    with pytest.raises(RuntimeError, match="not a video"):
        write_pack_video(tmp_path, "ada", "pack-face", b"hello", ".mp4")


def test_run_saves_video_returned_by_n8n(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")

    def fake_trim(src: Path, dest: Path, start: float) -> Path:
        assert start == 1.5
        dest.write_bytes(FAKE_MP4)
        return dest

    monkeypatch.setattr("backend.services.foil_n8n.trim_clip", fake_trim)
    captured: dict = {}

    def fake_start(**kwargs):
        captured.update(kwargs)
        captured["clip_exists"] = kwargs["clip"].is_file()
        return "influencer-n8n-result: /tmp/SS-ada Ada"

    monkeypatch.setattr("backend.services.foil_n8n.start_foil_flow", fake_start)

    line = run_foil_pack_n8n(
        models_dir=tmp_path / "models",
        model_id="ada",
        kind="pack-face-2",
        source=source,
        start=1.5,
        name="Ada",
        code="ada",
        job_id="job1",
        progress_token="tok",
    )

    assert line == "influencer-n8n-result: /tmp/SS-ada Ada"
    assert captured["name"] == "Ada"
    assert captured["code"] == "ada"
    assert captured["clip_exists"] is True
    assert not source.exists()


def test_run_reports_when_n8n_does_not_return_a_video(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    monkeypatch.setattr(
        "backend.services.foil_n8n.trim_clip",
        lambda src, dest, start: dest.write_bytes(FAKE_MP4) or dest,
    )
    def fake_start(**kwargs):
        raise RuntimeError("n8n failed")

    monkeypatch.setattr("backend.services.foil_n8n.start_foil_flow", fake_start)

    with pytest.raises(RuntimeError, match="n8n failed"):
        run_foil_pack_n8n(
            models_dir=tmp_path / "models",
            model_id="ada",
            kind="pack-face",
            source=source,
            start=0,
            name="Ada",
            code="ada",
            job_id="job1",
            progress_token="tok",
        )

    assert not source.exists()


def test_webhook_defaults_to_local_n8n(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("N8N_FOIL_PACK_WEBHOOK_URL", raising=False)
    assert webhook_url() == LOCAL_WEBHOOK_URL
    assert webhook_status() == {"configured": True, "local": True}


def test_blank_webhook_is_unconfigured(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("N8N_FOIL_PACK_WEBHOOK_URL", "  ")
    with pytest.raises(RuntimeError, match="empty"):
        webhook_url()
    assert webhook_status()["configured"] is False


class _Response:
    def __init__(self, status: int, content: bytes, content_type: str) -> None:
        self.status_code = status
        self.content = content
        self.headers = {"content-type": content_type}

    def json(self) -> object:
        return json.loads(self.content)

    def iter_bytes(self):
        yield self.content


class _Stream:
    def __init__(self, response: _Response) -> None:
        self.response = response

    def __enter__(self) -> _Response:
        return self.response

    def __exit__(self, *args: object) -> bool:
        return False


def test_send_clip_saves_binary_response(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("N8N_FOIL_PACK_WEBHOOK_URL", "https://n8n.example/hook")
    captured: dict = {}

    class Client:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def __enter__(self) -> "Client":
            return self

        def __exit__(self, *args: object) -> bool:
            return False

        def post(self, url: str, data: dict | None = None, files: dict | None = None) -> _Response:
            captured["url"] = url
            captured["data"] = data
            assert files is not None
            captured["file"] = files["file"][1].read()
            return _Response(200, FAKE_MP4, "video/mp4")

    monkeypatch.setattr("backend.services.foil_n8n.httpx.Client", Client)
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"trimmed-bytes")

    saved = send_clip(clip, model_id="ada", kind="pack-face", start=1.25, name="Ada", code="ada")

    assert saved is not None
    data, ext = saved
    assert data == FAKE_MP4
    assert ext == ".mp4"
    assert captured["url"] == "https://n8n.example/hook"
    assert captured["data"]["model_id"] == "ada"
    assert captured["data"]["name"] == "Ada"
    assert captured["data"]["code"] == "ada"
    assert captured["data"]["kind"] == "pack-face"
    assert captured["data"]["duration"] == "4"
    assert captured["file"] == b"trimmed-bytes"


def test_send_clip_downloads_json_video_url(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("N8N_FOIL_PACK_WEBHOOK_URL", "https://n8n.example/hook")

    class Client:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def __enter__(self) -> "Client":
            return self

        def __exit__(self, *args: object) -> bool:
            return False

        def post(self, url: str, data: dict | None = None, files: dict | None = None) -> _Response:
            body = json.dumps({"video_url": "https://cdn.example/out.mp4"}).encode()
            return _Response(200, body, "application/json")

        def stream(self, method: str, url: str) -> _Stream:
            assert method == "GET"
            assert url == "https://cdn.example/out.mp4"
            return _Stream(_Response(200, FAKE_MP4, "video/mp4"))

    monkeypatch.setattr("backend.services.foil_n8n.httpx.Client", Client)
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(FAKE_MP4)

    saved = send_clip(clip, model_id="ada", kind="pack-face-2", start=0, name="Ada", code="ada")

    assert saved == (FAKE_MP4, ".mp4")


@needs_ffmpeg
def test_trim_clip_keeps_four_seconds(tmp_path: Path):
    src = tmp_path / "source.mp4"
    dest = tmp_path / "out.mp4"
    _make_clip(src, 6)

    trim_clip(src, dest, 1.0)

    from backend.services.grok import probe_video

    assert abs(float(probe_video(dest)["duration"]) - 4.0) < 0.3


@needs_ffmpeg
def test_trim_clip_rejects_short_video(tmp_path: Path):
    src = tmp_path / "source.mp4"
    _make_clip(src, 1)
    with pytest.raises(RuntimeError, match="at least 4"):
        trim_clip(src, tmp_path / "out.mp4", 0)


def test_foil_n8n_status(client, dashboard_headers, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("N8N_FOIL_PACK_WEBHOOK_URL", raising=False)
    hidden = client.get("/api/jobs/foil-n8n/status")
    assert hidden.status_code == 401
    missing = client.get("/api/jobs/foil-n8n/status", headers=dashboard_headers)
    assert missing.status_code == 200
    assert missing.json() == {"configured": True, "local": True}
    monkeypatch.setenv("N8N_FOIL_PACK_WEBHOOK_URL", "https://n8n.example/hook")
    ready = client.get("/api/jobs/foil-n8n/status", headers=dashboard_headers)
    assert ready.json() == {"configured": True, "local": False}


def test_foil_n8n_requires_operator(client):
    response = client.post(
        "/api/jobs/models/someone/foil-n8n",
        data={"kind": "pack-face", "start": "0"},
        files={"file": ("clip.mp4", FAKE_MP4, "video/mp4")},
    )
    assert response.status_code == 401


def test_foil_n8n_unknown_model(client, dashboard_headers):
    response = client.post(
        "/api/jobs/models/missingmodel/foil-n8n",
        headers=dashboard_headers,
        data={"kind": "pack-face", "start": "0"},
        files={"file": ("clip.mp4", FAKE_MP4, "video/mp4")},
    )
    assert response.status_code == 404


def test_foil_n8n_queues_job(client, dashboard_headers, monkeypatch: pytest.MonkeyPatch):
    model_id = f"foiln8n{uuid.uuid4().hex[:8]}"
    created = client.post(
        "/api/models",
        headers=dashboard_headers,
        json={"id": model_id, "label": f"Foil {model_id}"},
    )
    assert created.status_code == 200, created.text
    captured: dict = {}

    def fake_enqueue(kind: str, command: list[str], action, **kwargs):
        captured["kind"] = kind
        captured["command"] = command
        captured["action"] = action

        class Job:
            def public(self) -> dict:
                return {
                    "id": "abc",
                    "kind": kind,
                    "command": command,
                    "status": "queued",
                    "created_at": 0,
                    "started_at": None,
                    "ended_at": None,
                    "return_code": None,
                    "logs": [],
                }

        return Job()

    monkeypatch.setattr("backend.app.enqueue", fake_enqueue)
    try:
        response = client.post(
            f"/api/jobs/models/{model_id}/foil-n8n",
            headers=dashboard_headers,
            data={"kind": "pack-face-2", "start": "1.25"},
            files={"file": ("clip.mp4", FAKE_MP4, "video/mp4")},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["kind"] == "foil-n8n"
        assert captured["command"] == [
            "foil-n8n",
            model_id,
            "pack-face-2",
            "1.250",
            f"Foil {model_id}",
            model_id,
        ]
        assert callable(captured["action"])

        rejected = client.post(
            f"/api/jobs/models/{model_id}/foil-n8n",
            headers=dashboard_headers,
            data={"kind": "swipe", "start": "0"},
            files={"file": ("clip.mp4", FAKE_MP4, "video/mp4")},
        )
        assert rejected.status_code == 400
    finally:
        client.delete(f"/api/models/{model_id}", headers=dashboard_headers)
