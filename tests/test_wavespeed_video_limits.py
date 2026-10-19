from __future__ import annotations

from pathlib import Path

import pytest

from backend.services import grok, wavespeed


def _fake_probe(width: int, height: int, duration: float):
    def probe(_path: Path) -> dict[str, int | float | str]:
        return {"width": width, "height": height, "codec": "h264", "duration": duration}

    return probe


@pytest.fixture
def clip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"fake")
    monkeypatch.setattr(wavespeed, "media_url", lambda value, _mime: f"inline:{value}")
    return path


@pytest.mark.parametrize(
    ("max_duration_s", "max_short_side", "label"),
    [
        (wavespeed.WAN30_MAX_DURATION_S, wavespeed.WAN30_MAX_SHORT_SIDE, "WAN 3.0"),
        (wavespeed.SEEDANCE2_MAX_DURATION_S, wavespeed.SEEDANCE2_MAX_SHORT_SIDE, "Seedance 2.0"),
    ],
)
def test_wan30_and_seedance_accept_clips_over_grok_limits(
    clip: Path,
    monkeypatch: pytest.MonkeyPatch,
    max_duration_s: float,
    max_short_side: int,
    label: str,
) -> None:
    monkeypatch.setattr(grok, "probe_video", _fake_probe(1080, 1920, 14.0))

    url = wavespeed._edit_input_video_url(
        clip, max_duration_s=max_duration_s, max_short_side=max_short_side, model_label=label
    )

    assert url == f"inline:{clip}"


def test_seedance_rejects_clip_over_its_duration(
    clip: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(grok, "probe_video", _fake_probe(1080, 1920, 16.0))

    with pytest.raises(RuntimeError, match="Incompatible with Seedance 2.0"):
        wavespeed._edit_input_video_url(
            clip,
            max_duration_s=wavespeed.SEEDANCE2_MAX_DURATION_S,
            max_short_side=wavespeed.SEEDANCE2_MAX_SHORT_SIDE,
            model_label="Seedance 2.0",
        )


def test_video_poll_waits_past_the_ten_minute_image_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """WAN 3.0 identity-still edits were dying at the 10-minute image poll."""
    assert grok.VIDEO_POLL_TIMEOUT_S == 1800
    assert wavespeed.VIDEO_POLL_TIMEOUT_S == 1800
    out = tmp_path / "out.mp4"
    ticks = iter([0.0, 700.0])
    monkeypatch.setattr(wavespeed.time, "time", lambda: next(ticks))
    monkeypatch.setattr(wavespeed.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(wavespeed, "api_key", lambda: "key")
    monkeypatch.setattr(
        wavespeed,
        "api_get",
        lambda _path, _key: {"status": "completed", "outputs": ["https://cdn.example/v.mp4"]},
    )

    def fake_download(url: str, dest: Path) -> None:
        dest.write_bytes(b"mp4")
        downloaded.append(url)

    downloaded: list[str] = []
    monkeypatch.setattr(wavespeed, "download_video", fake_download)
    wavespeed.finish_video_job("req-1", out, label="wan-3.0 video edit (identity still)")
    assert downloaded == ["https://cdn.example/v.mp4"]


def test_grok_limits_unchanged(clip: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(grok, "probe_video", _fake_probe(720, 1280, 10.0))

    with pytest.raises(RuntimeError, match="Incompatible with Grok"):
        grok.check_grok_limits(clip)
