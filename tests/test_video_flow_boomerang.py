from __future__ import annotations

import json
import shutil
import subprocess
import uuid
from collections.abc import Generator
from pathlib import Path

import pytest

from backend.services import video_flow
from backend.services.mesh_boomerang import mirror_frames_in_time, mirror_mesh_in_time
from backend.services.video_flow import WORK_DIR, read_state, work_dir, write_state
from backend.services.video_prep import make_boomerang, probe_video_timing

needs_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe not installed",
)

FPS = 10
SOURCE_SECONDS = 4


def _frame(t: float, x: float) -> dict:
    return {"t": t, "verts": [[x, 0.0], [x + 1, 1.0]], "vis": [1, 0]}


def _make_clip(path: Path, *, seconds: int = SOURCE_SECONDS) -> None:
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", f"testsrc=size=64x48:rate={FPS}",
            "-t", str(seconds), "-pix_fmt", "yuv420p", str(path),
        ],
        check=True,
    )


def _gray_frame(path: Path, index: int) -> bytes:
    result = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-i", str(path),
            "-vf", f"select=eq(n\\,{index}),format=gray", "-frames:v", "1",
            "-f", "rawvideo", "-",
        ],
        check=True,
        capture_output=True,
    )
    return result.stdout


def _luma_diff(a: bytes, b: bytes) -> float:
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


def test_mirror_frames_interpolates_pivot_and_mirrors_back():
    frames = [_frame(0.0, 0), _frame(0.5, 10), _frame(1.0, 20), _frame(1.5, 30)]
    out = mirror_frames_in_time(frames, 1.25)

    assert [frame["t"] for frame in out] == [0.0, 0.5, 1.0, 1.25, 1.5, 2.0, 2.5]
    assert out[3]["verts"][0] == [25.0, 0.0]
    assert out[4]["verts"] == out[2]["verts"]
    assert out[5]["verts"] == out[1]["verts"]
    assert out[-1]["verts"] == out[0]["verts"]


def test_mirror_frames_reuses_frame_on_pivot():
    frames = [_frame(0.0, 0), _frame(0.5, 10), _frame(1.0, 20), _frame(1.5, 30)]
    out = mirror_frames_in_time(frames, 1.0)

    assert [frame["t"] for frame in out] == [0.0, 0.5, 1.0, 1.5, 2.0]
    assert out[3]["verts"] == out[1]["verts"]
    assert out[-1]["verts"] == out[0]["verts"]


def test_mirror_mesh_keeps_uv_space_data(tmp_path):
    src = tmp_path / "mesh.json"
    dst = tmp_path / "out.json"
    symbols = [{"u": 0.5, "v": 0.5}]
    src.write_text(
        json.dumps(
            {
                "uv": [[0, 0], [1, 1]],
                "garment": [1, 0],
                "symbolPoints": symbols,
                "durationSeconds": 1.5,
                "frames": [_frame(0.0, 0), _frame(0.5, 10), _frame(1.0, 20), _frame(1.5, 30)],
            }
        )
    )
    mirror_mesh_in_time(src, dst, pivot_t=1.0, total_duration=2.0)
    data = json.loads(dst.read_text())

    assert data["durationSeconds"] == 2.0
    assert data["symbolPoints"] == symbols
    assert data["garment"] == [1, 0]
    assert len(data["frames"]) == 5


@needs_ffmpeg
def test_make_boomerang_frame_layout(tmp_path):
    src = tmp_path / "src.mp4"
    dst = tmp_path / "out.mp4"
    _make_clip(src)
    result = make_boomerang(src, dst, seconds=2)

    forward = 2 * FPS
    assert result["forward_frames"] == forward
    assert result["frames_after"] == 2 * forward - 1
    assert probe_video_timing(dst)["frames"] == 2 * forward - 1
    # First reversed frame is the one before the turnaround.
    first_back = _gray_frame(dst, forward)
    assert _luma_diff(first_back, _gray_frame(src, forward - 2)) < _luma_diff(
        first_back, _gray_frame(src, forward - 1)
    )
    # Ends on the same frame it starts with.
    first, last = _gray_frame(dst, 0), _gray_frame(dst, 2 * forward - 2)
    assert _luma_diff(first, last) < _luma_diff(first, _gray_frame(dst, 1))


@pytest.fixture
def card_id() -> Generator[str, None, None]:
    value = f"test_boom_{uuid.uuid4().hex[:10]}"
    yield value
    shutil.rmtree(WORK_DIR / value, ignore_errors=True)


def test_boomerang_requires_operator(client, card_id):
    response = client.post(
        f"/api/video-flow/{card_id}/boomerang",
        json={"card_label": "Test", "seconds": 5},
    )
    assert response.status_code == 401


def test_boomerang_requires_video_edit(client, dashboard_headers, card_id):
    response = client.post(
        f"/api/video-flow/{card_id}/boomerang",
        json={"card_label": "Test", "seconds": 5},
        headers=dashboard_headers,
    )
    assert response.status_code == 400, response.text
    assert "Video edit" in response.json()["detail"]


@needs_ffmpeg
def test_boomerang_before_create_card_gates_publish(card_id):
    work = work_dir(card_id)
    _make_clip(work / "background-raw.mp4")
    _make_clip(work / "foreground-dressed.mp4")
    write_state(work, {"approved": ["background", "trim", "dress"]})

    flow = video_flow.apply_boomerang_step(card_id, card_label="Test", seconds=2)

    forward = 2 * FPS
    assert flow["boomerang"]["frames_after"] == 2 * forward - 1
    assert flow["boomerang"]["mesh_mirrored"] is False
    assert flow["steps"]["boomerang"]["status"] == "review"
    assert flow["steps"]["card"]["status"] == "locked"
    assert "card" not in read_state(work)["approved"]

    flow = video_flow.skip_boomerang_step(card_id, card_label="Test")
    assert flow["boomerang"]["skipped"] is True
    assert probe_video_timing(work / "background-raw.mp4")["frames"] == SOURCE_SECONDS * FPS

    flow = video_flow.approve_flow_step(card_id, "boomerang")
    assert flow["steps"]["boomerang"]["status"] == "approved"
    assert flow["steps"]["card"]["status"] == "ready"


def test_boomerang_backfill_keeps_later_steps(card_id):
    work = work_dir(card_id)
    write_state(
        work,
        {"approved": ["background", "trim", "dress", "card", "mesh", "symbols", "compress"]},
    )
    assert read_state(work)["approved"] == [
        "background",
        "trim",
        "dress",
        "boomerang",
        "card",
        "mesh",
        "symbols",
        "compress",
    ]


@pytest.fixture
def published_card(card_id, monkeypatch) -> dict:
    # flow_state reports paths relative to the repo, so keep fixtures inside it.
    work = work_dir(card_id)
    cards_dir = work / "fixture-cards"
    mesh_dir = work / "fixture-mesh"
    monkeypatch.setattr(video_flow, "CARDS_DIR", cards_dir)
    monkeypatch.setattr(video_flow, "MESH_DIR", mesh_dir)

    def fake_publish(*, card_id, card_label, paths, model_id=None):
        card_dir = cards_dir / card_id
        card_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(paths["background_raw"], card_dir / "background.mp4")
        shutil.copy2(paths["foreground_dressed"], card_dir / "foreground.mp4")

    monkeypatch.setattr(video_flow, "_publish_card", fake_publish)

    _make_clip(work / "background-raw.mp4")
    _make_clip(work / "foreground-dressed.mp4")
    fake_publish(card_id=card_id, card_label="Test", paths=video_flow._paths(work))
    mesh_dir.mkdir(parents=True)
    mesh = mesh_dir / f"{card_id}.json"
    original_mesh = {
        "tracker": "blend",
        "uv": [[0, 0], [1, 1]],
        "symbolPoints": [{"u": 0.1 * i, "v": 0.5} for i in range(12)],
        "durationSeconds": SOURCE_SECONDS,
        "frames": [_frame(i / FPS, i) for i in range(SOURCE_SECONDS * FPS)],
    }
    mesh.write_text(json.dumps(original_mesh))
    write_state(
        work,
        {"approved": ["background", "trim", "dress", "card", "mesh", "symbols", "compress"]},
    )
    return {"work": work, "cards_dir": cards_dir, "mesh": mesh, "original_mesh": original_mesh}


@needs_ffmpeg
def test_boomerang_apply_and_undo(card_id, published_card):
    work = published_card["work"]
    cards_dir = published_card["cards_dir"]
    mesh = published_card["mesh"]
    original_mesh = published_card["original_mesh"]

    flow = video_flow.apply_boomerang_step(card_id, card_label="Test", seconds=2)

    forward = 2 * FPS
    assert flow["boomerang"]["frames_after"] == 2 * forward - 1
    assert flow["boomerang"]["mesh_mirrored"] is True
    assert probe_video_timing(cards_dir / card_id / "foreground.mp4")["frames"] == 2 * forward - 1
    mirrored = json.loads(mesh.read_text())
    assert len(mirrored["frames"]) == 2 * forward - 1
    assert mirrored["frames"][-1]["verts"] == mirrored["frames"][0]["verts"]
    assert mirrored["symbolPoints"] == original_mesh["symbolPoints"]
    candidate = json.loads(video_flow.mesh_candidate_path(work, "blend").read_text())
    assert len(candidate["frames"]) == 2 * forward - 1
    approved = read_state(work)["approved"]
    assert "symbols" in approved and "compress" not in approved

    # Re-running starts from the originals instead of stacking boomerangs.
    video_flow.apply_boomerang_step(card_id, card_label="Test", seconds=1)
    assert probe_video_timing(work / "background-raw.mp4")["frames"] == 2 * FPS - 1

    flow = video_flow.reset_boomerang_step(card_id, card_label="Test")

    assert flow["boomerang"] is None
    assert probe_video_timing(cards_dir / card_id / "background.mp4")["frames"] == SOURCE_SECONDS * FPS
    assert json.loads(mesh.read_text())["frames"] == original_mesh["frames"]
    assert not (work / "background-pre-boomerang.mp4").exists()
    assert not (work / "mesh-pre-boomerang.json").exists()


@needs_ffmpeg
def test_undo_refuses_when_backups_are_missing(card_id, published_card):
    work = published_card["work"]
    video_flow.apply_boomerang_step(card_id, card_label="Test", seconds=2)
    boomerang_frames = probe_video_timing(work / "background-raw.mp4")["frames"]
    (work / "background-pre-boomerang.mp4").unlink()
    (work / "foreground-pre-boomerang.mp4").unlink()

    with pytest.raises(RuntimeError, match="cannot be undone"):
        video_flow.reset_boomerang_step(card_id, card_label="Test")
    with pytest.raises(RuntimeError, match="cannot be undone"):
        video_flow.skip_boomerang_step(card_id, card_label="Test")

    report = video_flow.read_boomerang_report(work)
    assert report is not None and report.get("skipped") is not True
    assert probe_video_timing(work / "background-raw.mp4")["frames"] == boomerang_frames


@needs_ffmpeg
def test_create_card_remake_keeps_boomerang(card_id, published_card):
    work = published_card["work"]
    video_flow.apply_boomerang_step(card_id, card_label="Test", seconds=2)

    video_flow.reject_flow_step(card_id, "card")

    assert video_flow.read_boomerang_report(work) is not None
    assert probe_video_timing(work / "background-raw.mp4")["frames"] == 2 * 2 * FPS - 1
    assert (work / "background-pre-boomerang.mp4").exists()


@needs_ffmpeg
def test_dress_reject_restores_missing_work_clip(card_id, published_card):
    """Published cards often have no work-dir clips left — reject must keep the original."""
    work = published_card["work"]
    cards_dir = published_card["cards_dir"]
    video_flow.apply_boomerang_step(card_id, card_label="Test", seconds=2)
    original_frames = SOURCE_SECONDS * FPS
    published_frames = probe_video_timing(cards_dir / card_id / "background.mp4")["frames"]
    assert published_frames != original_frames

    (work / "background-raw.mp4").unlink()
    (work / "foreground-dressed.mp4").unlink()
    (work / "background-source.mp4").unlink(missing_ok=True)

    video_flow.reject_flow_step(card_id, "dress")

    assert probe_video_timing(work / "background-raw.mp4")["frames"] == original_frames
    assert not (work / "foreground-dressed.mp4").exists()
    assert not (work / "background-pre-boomerang.mp4").exists()


@needs_ffmpeg
def test_trim_reject_restores_missing_source_from_backup(card_id, published_card):
    work = published_card["work"]
    video_flow.apply_boomerang_step(card_id, card_label="Test", seconds=2)
    (work / "background-raw.mp4").unlink()
    (work / "background-source.mp4").unlink(missing_ok=True)

    video_flow.reject_flow_step(card_id, "trim")

    assert probe_video_timing(work / "background-raw.mp4")["frames"] == SOURCE_SECONDS * FPS
    assert not (work / "background-pre-boomerang.mp4").exists()


@needs_ffmpeg
def test_dress_remake_drops_boomerang_backups(card_id, published_card):
    work = published_card["work"]
    video_flow.apply_boomerang_step(card_id, card_label="Test", seconds=2)

    video_flow.reject_flow_step(card_id, "dress")

    assert video_flow.read_boomerang_report(work) is None
    assert not (work / "background-pre-boomerang.mp4").exists()
    assert not (work / "foreground-dressed.mp4").exists()
