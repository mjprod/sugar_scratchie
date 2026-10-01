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


def test_grok_limits_unchanged(clip: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(grok, "probe_video", _fake_probe(720, 1280, 10.0))

    with pytest.raises(RuntimeError, match="Incompatible with Grok"):
        grok.check_grok_limits(clip)
