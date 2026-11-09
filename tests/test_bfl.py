"""FLUX 3 Image Klein client, catalog route, and MAXMAC command."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.services import bfl
from backend.services.ai_provider import generate_portrait_image, source_image_route, uses_flux_klein


class _Response:
    def __init__(self, body: bytes, content_type: str):
        self._body = body
        self.headers = {"Content-Type": content_type}

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def _install_http(monkeypatch, responses: list[_Response | Exception]):
    calls: list[object] = []

    def urlopen(req, timeout=0):
        calls.append(req)
        item = responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    monkeypatch.setattr(bfl.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(bfl._server_opener, "open", urlopen)
    monkeypatch.setattr(bfl.time, "sleep", lambda *_args, **_kwargs: None)
    return calls


def test_cloud_submit_polls_until_ready(monkeypatch, tmp_path: Path):
    monkeypatch.delenv("FLUX_KLEIN_URL", raising=False)
    monkeypatch.setenv("BFL_API_KEY", "test-key")
    downloaded: list[str] = []

    def fake_download(url: str, out: Path) -> None:
        downloaded.append(url)
        out.write_bytes(b"png-bytes")

    monkeypatch.setattr(bfl, "download_image", fake_download)
    calls = _install_http(
        monkeypatch,
        [
            _Response(
                json.dumps(
                    {"id": "job-1", "polling_url": "https://api.bfl.ai/v1/get_result?id=job-1"}
                ).encode(),
                "application/json",
            ),
            _Response(json.dumps({"status": "Pending"}).encode(), "application/json"),
            _Response(
                json.dumps(
                    {"status": "Ready", "result": {"sample": "https://delivery.example/klein.png"}}
                ).encode(),
                "application/json",
            ),
        ],
    )
    source = tmp_path / "face.png"
    source.write_bytes(b"face")
    out = tmp_path / "out.png"
    bfl.generate(
        prompt="Keep @image1 and change the background.",
        out=out,
        images=[source],
        aspect_ratio="9:16",
    )
    assert out.read_bytes() == b"png-bytes"
    assert downloaded == ["https://delivery.example/klein.png"]
    sent = json.loads(calls[0].data.decode())
    assert sent["prompt"] == "Keep Image 1 and change the background."
    assert sent["aspect_ratio"] == "9:16"
    assert sent["output_format"] == "png"
    assert sent["images"][0] != "" and not str(sent["images"][0]).startswith("data:")
    assert calls[0].get_header("X-key") == "test-key"


def test_klein_server_polls_then_downloads_png(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("FLUX_KLEIN_URL", "https://flux.mxjprod.work")
    monkeypatch.setenv("FLUX_KLEIN_TOKEN", "tunnel-token")
    monkeypatch.delenv("BFL_API_KEY", raising=False)
    monkeypatch.setattr(bfl, "POLL_INTERVAL_S", 0)
    calls = _install_http(
        monkeypatch,
        [
            _Response(json.dumps({"id": "job-9"}).encode(), "application/json"),
            _Response(json.dumps({"id": "job-9", "status": "queued"}).encode(), "application/json"),
            _Response(json.dumps({"id": "job-9", "status": "succeeded"}).encode(), "application/json"),
            _Response(b"local-png", "image/png"),
        ],
    )
    out = tmp_path / "out.png"
    bfl.generate(prompt="A red fox asleep in a suitcase.", out=out, aspect_ratio="9:16")
    assert out.read_bytes() == b"local-png"
    assert [call.full_url for call in calls] == [
        "https://flux.mxjprod.work/generate",
        "https://flux.mxjprod.work/jobs/job-9",
        "https://flux.mxjprod.work/jobs/job-9",
        "https://flux.mxjprod.work/jobs/job-9/image",
    ]
    sent = json.loads(calls[0].data.decode())
    assert sent == {
        "prompt": "A red fox asleep in a suitcase.",
        "width": 768,
        "height": 1344,
    }
    assert calls[0].get_header("User-agent") == "flux-client/1.0"
    assert calls[0].get_header("Authorization") == "Bearer tunnel-token"
    assert calls[0].get_header("X-api-key") == "tunnel-token"


def test_unreachable_sidecar_falls_back_to_the_api(monkeypatch, tmp_path: Path):
    import urllib.error

    monkeypatch.setenv("FLUX_KLEIN_URL", "https://flux.mxjprod.work")
    monkeypatch.setenv("BFL_API_KEY", "test-key")
    monkeypatch.setattr(bfl, "download_image", lambda url, out: out.write_bytes(b"cloud"))
    calls = _install_http(
        monkeypatch,
        [
            urllib.error.URLError("connection refused"),
            urllib.error.URLError("connection refused"),
            _Response(
                json.dumps(
                    {"polling_url": "https://api.bfl.ai/v1/get_result?id=job-2"}
                ).encode(),
                "application/json",
            ),
            _Response(
                json.dumps({"status": "Ready", "result": {"sample": "https://delivery.example/a.png"}}).encode(),
                "application/json",
            ),
        ],
    )
    out = tmp_path / "out.png"
    bfl.generate(prompt="A studio portrait.", out=out)
    assert out.read_bytes() == b"cloud"
    assert calls[0].full_url.startswith("https://flux.mxjprod.work/")
    assert calls[1].full_url.startswith("http://127.0.0.1:8790/")
    assert calls[2].full_url.startswith("https://api.bfl.ai/")


def test_public_tunnel_reset_uses_local_klein(monkeypatch, tmp_path: Path):
    import urllib.error

    monkeypatch.setenv("FLUX_KLEIN_URL", "https://flux.mxjprod.work")
    monkeypatch.setenv("FLUX_KLEIN_TOKEN", "tunnel-token")
    monkeypatch.delenv("BFL_API_KEY", raising=False)
    calls = _install_http(
        monkeypatch,
        [
            urllib.error.URLError("[Errno 54] Connection reset by peer"),
            _Response(b"local-png", "image/png"),
        ],
    )
    out = tmp_path / "out.png"
    bfl.generate(prompt="A studio portrait.", out=out)
    assert out.read_bytes() == b"local-png"
    assert calls[1].full_url == "http://127.0.0.1:8790/generate"


def test_unreachable_klein_names_the_configured_url(monkeypatch, tmp_path: Path):
    import urllib.error

    monkeypatch.setenv("FLUX_KLEIN_URL", "https://flux.mxjprod.work")
    monkeypatch.delenv("BFL_API_KEY", raising=False)
    _install_http(
        monkeypatch,
        [
            urllib.error.URLError("[Errno 54] Connection reset by peer"),
            urllib.error.URLError("connection refused"),
        ],
    )
    with pytest.raises(RuntimeError, match=r"flux\.mxjprod\.work") as raised:
        bfl.generate(prompt="A studio portrait.", out=tmp_path / "out.png")
    assert "BFL_API_KEY" not in str(raised.value)


def test_missing_key_and_sidecar_raises(monkeypatch, tmp_path: Path):
    monkeypatch.delenv("FLUX_KLEIN_URL", raising=False)
    monkeypatch.delenv("BFL_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="BFL_API_KEY"):
        bfl.generate(prompt="A studio portrait.", out=tmp_path / "out.png")


def test_klein_portrait_does_not_call_grok(monkeypatch, tmp_path: Path):
    calls: list[str] = []

    def fake_bfl(**kwargs):
        calls.append("bfl")
        kwargs["out"].write_bytes(b"klein")
        return kwargs["out"]

    def fake_grok(**kwargs):
        calls.append("grok")
        return kwargs["out"]

    monkeypatch.setattr(bfl, "generate_portrait_image", fake_bfl)
    monkeypatch.setattr("backend.services.ai_provider.grok.generate_portrait_image", fake_grok)
    out = tmp_path / "portrait.png"
    generate_portrait_image(
        provider="xai",
        image_model="flux-3-image-klein",
        prompt="A woman in resort wear.",
        out=out,
    )
    assert calls == ["bfl"]
    assert uses_flux_klein("flux-3-image-klein")
    assert source_image_route("xai", "flux-3-image-klein") == "bfl"


def test_bikini_dress_up_uses_only_klein(monkeypatch):
    from backend.services import video_flow

    calls: list[tuple[str, str]] = []
    monkeypatch.setenv("WAVESPEED_API_KEY", "ws")
    monkeypatch.setenv("XAI_API_KEY", "xai")
    video_flow._run_step1_style_edit(
        "bikini dress-up",
        "flux-3-image-klein",
        lambda provider, model: calls.append((provider, model)),
    )
    assert calls == [("bfl", "flux-3-image-klein")]


def test_sidecar_command_passes_every_reference(tmp_path: Path):
    import importlib.util

    path = Path(__file__).resolve().parents[1] / "scripts" / "flux_klein_server.py"
    spec = importlib.util.spec_from_file_location("flux_klein_server", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.MODEL_DIR = "/Users/maxmac/flex/flux-models/q8-quality"
    module.BIN = "flux-klein"
    module.PRESET = "q8-quality-16"
    first = tmp_path / "a.png"
    second = tmp_path / "b.png"
    command = module.build_command(
        prompt_file=tmp_path / "prompt.json",
        out=tmp_path / "out.png",
        images=[first, second],
        aspect_ratio="9:16",
        seed=7,
    )
    assert command[command.index("--width") + 1] == "768"
    assert command[command.index("--height") + 1] == "1344"
    assert command.count("--image") == 2
    assert "q8-quality-16" in command
