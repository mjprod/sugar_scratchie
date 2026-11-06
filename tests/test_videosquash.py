"""VideoSquash client and the Finalize install path. No live HandBrake."""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import urllib.error
from pathlib import Path

import pytest

from backend.services import videosquash
from backend.services.video_prep import (
    delivery_aspect_ok,
    hd_variant_path,
    install_squash_clip,
)

needs_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe not installed",
)


class _Resp:
    def __init__(self, body: bytes, content_type: str = "application/json"):
        self._body = body
        self.headers = {"Content-Type": content_type}

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> _Resp:
        return self

    def __exit__(self, *args: object) -> bool:
        return False


def _clip(path: Path, *, width: int, height: int) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"testsrc=size={width}x{height}:rate=24",
            "-frames:v",
            "4",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
    )
    return path


def test_delivery_aspect_accepts_the_scratch_frame_at_any_size():
    assert delivery_aspect_ok(390, 672)
    assert delivery_aspect_ok(540, 930)
    assert delivery_aspect_ok(720, 1240)
    assert not delivery_aspect_ok(1920, 1080)
    assert not delivery_aspect_ok(1080, 1920)


def test_local_convert_paths_body_and_output_names(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("VIDEOSQUASH_URL", "http://127.0.0.1:8805")
    monkeypatch.delenv("VIDEOSQUASH_TOKEN", raising=False)
    calls: list[object] = []

    def urlopen(req, timeout=0):
        del timeout
        calls.append(req)
        if req.full_url.endswith("/convert/paths"):
            payload = json.loads(req.data)
            out = Path(payload["output_dir"])
            jobs = []
            for raw in payload["paths"]:
                src = Path(raw)
                (out / f"{src.stem}-HD{src.suffix}").write_bytes(b"HD:" + src.name.encode())
                (out / f"{src.stem}-SD-2{src.suffix}").write_bytes(b"SD2:" + src.name.encode())
                jobs.append({"id": f"job-{src.stem}", "source": raw, "status": "queued"})
            return _Resp(json.dumps({"batch": "b1", "jobs": jobs}).encode())
        jid = req.full_url.rstrip("/").rsplit("/", 1)[-1]
        return _Resp(json.dumps({"id": jid, "status": "done", "progress": 1}).encode())

    monkeypatch.setattr(videosquash, "_open", urlopen)
    bg = tmp_path / "in" / "background.mp4"
    fg = tmp_path / "in" / "foreground.mp4"
    bg.parent.mkdir()
    bg.write_bytes(b"bg")
    fg.write_bytes(b"fg")
    output_dir = tmp_path / "out"

    encoded = videosquash.encode_files([bg, fg], output_dir)

    posted = next(req for req in calls if req.full_url.endswith("/convert/paths"))
    payload = json.loads(posted.data)
    assert payload["paths"] == [str(bg.resolve()), str(fg.resolve())]
    assert payload["output_dir"] == str(output_dir.resolve())
    assert payload["variants"] == ["hd", "sd"]
    assert "hd_preset_file" not in payload
    assert "sd_preset_name" not in payload
    assert posted.get_header("Authorization") is None
    assert posted.get_header("User-agent") == videosquash.USER_AGENT
    by_source = {item["source"]: item for item in encoded}
    assert Path(by_source[str(bg.resolve())]["hd"]).read_bytes() == b"HD:background.mp4"
    # Plain SD was absent, so the -2 file VideoSquash writes when it will not overwrite.
    assert Path(by_source[str(bg.resolve())]["sd"]).read_bytes() == b"SD2:background.mp4"
    assert by_source[str(fg.resolve())]["job_id"] == "job-foreground"


def test_remote_upload_sends_bearer_token(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("VIDEOSQUASH_URL", "https://videosquash.mxjprod.work")
    monkeypatch.setenv("VIDEOSQUASH_TOKEN", "secret-token")
    monkeypatch.setattr(videosquash, "TOKEN_FILE", tmp_path / "absent-token")
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"video-bytes")
    seen: list[tuple[str, str | None]] = []

    def urlopen(req, timeout=0):
        del timeout
        auth = req.get_header("Authorization")
        seen.append((req.full_url, auth))
        assert auth == "Bearer secret-token"
        assert req.get_header("X-api-key") == "secret-token"
        if req.full_url.endswith("/convert"):
            assert b'filename="clip.mp4"' in req.data
            assert b"hd,sd" in req.data
            body = json.dumps({"batch": "b", "jobs": [{"id": "job-1", "status": "queued"}]}).encode()
            return _Resp(body)
        if req.full_url.endswith("/download/hd"):
            return _Resp(b"hd-bytes", "video/mp4")
        if req.full_url.endswith("/download/sd"):
            return _Resp(b"sd-bytes", "video/mp4")
        return _Resp(json.dumps({"id": "job-1", "status": "done", "progress": 40}).encode())

    monkeypatch.setattr(videosquash, "_open", urlopen)
    encoded = videosquash.encode_files([clip], tmp_path / "out")

    assert seen[0][0].endswith("/convert")
    assert not any(url.endswith("/convert/paths") for url, _auth in seen)
    assert Path(encoded[0]["hd"]).read_bytes() == b"hd-bytes"
    assert Path(encoded[0]["sd"]).read_bytes() == b"sd-bytes"


def test_remote_download_ignores_local_leftovers(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("VIDEOSQUASH_URL", "https://videosquash.mxjprod.work")
    monkeypatch.setenv("VIDEOSQUASH_TOKEN", "secret-token")
    monkeypatch.setattr(videosquash, "TOKEN_FILE", tmp_path / "absent-token")
    clip = tmp_path / "card" / "clip.mp4"
    clip.parent.mkdir()
    clip.write_bytes(b"source")
    leftover_hd = clip.with_name("clip-HD.mp4")
    leftover_sd = clip.with_name("clip-SD.mp4")
    leftover_hd.write_bytes(b"old-hd")
    leftover_sd.write_bytes(b"old-sd")

    def urlopen(req, timeout=0):
        del timeout
        if req.full_url.endswith("/convert"):
            body = json.dumps({"jobs": [{"id": "job-1", "status": "queued"}]}).encode()
            return _Resp(body)
        if req.full_url.endswith("/download/hd"):
            return _Resp(b"new-hd", "video/mp4")
        if req.full_url.endswith("/download/sd"):
            return _Resp(b"new-sd", "video/mp4")
        return _Resp(json.dumps({"id": "job-1", "status": "done"}).encode())

    monkeypatch.setattr(videosquash, "_open", urlopen)
    encoded = videosquash.encode_files([clip], tmp_path / "out")

    assert Path(encoded[0]["hd"]).read_bytes() == b"new-hd"
    assert Path(encoded[0]["sd"]).read_bytes() == b"new-sd"
    assert leftover_hd.read_bytes() == b"old-hd"
    assert leftover_sd.read_bytes() == b"old-sd"


def test_remote_without_token_raises(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("VIDEOSQUASH_URL", "https://videosquash.mxjprod.work")
    monkeypatch.delenv("VIDEOSQUASH_TOKEN", raising=False)
    monkeypatch.setattr(videosquash, "TOKEN_FILE", tmp_path / "absent-token")
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"video")

    with pytest.raises(RuntimeError, match="VIDEOSQUASH_TOKEN"):
        videosquash.encode_files([clip], tmp_path / "out")


def test_authentik_login_is_not_parsed_as_json(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("VIDEOSQUASH_URL", "https://videosquash.mxjprod.work")
    monkeypatch.setenv("VIDEOSQUASH_TOKEN", "secret-token")
    monkeypatch.setattr(videosquash, "TOKEN_FILE", tmp_path / "absent-token")
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"video")

    def _open(req, timeout=0):
        del req, timeout
        raise urllib.error.HTTPError(
            "https://videosquash.mxjprod.work/convert",
            302,
            "Found",
            hdrs=None,
            fp=io.BytesIO(b"<!DOCTYPE html><html><title>authentik</title>"),
        )

    monkeypatch.setattr(videosquash, "_open", _open)
    with pytest.raises(RuntimeError, match="Authentik") as caught:
        videosquash.encode_files([clip], tmp_path / "out")
    assert "non-JSON" not in str(caught.value)
    assert "DOCTYPE" not in str(caught.value)


def test_failed_job_raises(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("VIDEOSQUASH_URL", "http://127.0.0.1:8805")
    monkeypatch.delenv("VIDEOSQUASH_TOKEN", raising=False)
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"video")

    def urlopen(req, timeout=0):
        del timeout
        if req.full_url.endswith("/convert/paths"):
            body = json.dumps(
                {"jobs": [{"id": "job-1", "source": str(clip.resolve()), "status": "queued"}]}
            ).encode()
            return _Resp(body)
        return _Resp(
            json.dumps({"id": "job-1", "status": "failed", "error": "HD preset missing"}).encode()
        )

    monkeypatch.setattr(videosquash, "_open", urlopen)
    with pytest.raises(RuntimeError, match="HD preset missing"):
        videosquash.encode_files([clip], tmp_path / "out")


@needs_ffmpeg
def test_install_places_sd_and_hd_on_the_card(tmp_path: Path):
    card = tmp_path / "card"
    dst = card / "background.mp4"
    _clip(dst, width=390, height=672)
    sd = _clip(tmp_path / "background-SD.mp4", width=540, height=930)
    hd = _clip(tmp_path / "background-HD.mp4", width=720, height=1240)
    sd_bytes = sd.read_bytes()
    hd_bytes = hd.read_bytes()

    install_squash_clip(
        encoded={"sd": str(sd), "hd": str(hd), "job_id": "job-bg"},
        dst=dst,
        role="background",
    )

    assert dst.read_bytes() == sd_bytes
    assert hd_variant_path(dst).read_bytes() == hd_bytes
    assert not sd.exists()
    assert not hd.exists()


@needs_ffmpeg
def test_sd_file_with_wrong_aspect_fails_before_replace(tmp_path: Path):
    card = tmp_path / "card"
    dst = card / "foreground.mp4"
    dst.parent.mkdir()
    dst.write_bytes(b"keep-me")
    sd = _clip(tmp_path / "foreground-SD.mp4", width=1920, height=1080)
    hd = _clip(tmp_path / "foreground-HD.mp4", width=1920, height=1080)

    with pytest.raises(RuntimeError, match="390:672"):
        install_squash_clip(
            encoded={"sd": str(sd), "hd": str(hd)},
            dst=dst,
            role="foreground",
        )

    assert dst.read_bytes() == b"keep-me"
    assert not hd_variant_path(dst).exists()


@needs_ffmpeg
def test_narrow_source_keeps_the_existing_hd_twin(tmp_path: Path):
    card = tmp_path / "card"
    dst = _clip(card / "background.mp4", width=390, height=672)
    twin = hd_variant_path(dst)
    twin.write_bytes(b"full-res-hd")
    sd = _clip(tmp_path / "background-SD.mp4", width=390, height=672)
    hd = _clip(tmp_path / "background-HD.mp4", width=720, height=1240)
    sd_bytes = sd.read_bytes()

    install_squash_clip(
        encoded={"sd": str(sd), "hd": str(hd), "source": str(dst)},
        dst=dst,
        role="background",
    )

    assert dst.read_bytes() == sd_bytes
    assert twin.read_bytes() == b"full-res-hd"
    assert not hd.exists()


@needs_ffmpeg
def test_disabled_hd_leaves_the_demo_twin_alone(tmp_path: Path):
    card = tmp_path / "public" / "cards"
    dst = _clip(card / "background.mp4", width=720, height=1240)
    twin = hd_variant_path(dst)
    twin.write_bytes(b"leave-me")
    sd = _clip(tmp_path / "background-SD.mp4", width=390, height=672)
    hd = _clip(tmp_path / "background-HD.mp4", width=720, height=1240)

    install_squash_clip(
        encoded={"sd": str(sd), "hd": str(hd), "source": str(dst)},
        dst=dst,
        role="background",
        write_hd=False,
    )

    assert twin.read_bytes() == b"leave-me"
    assert not hd.exists()
