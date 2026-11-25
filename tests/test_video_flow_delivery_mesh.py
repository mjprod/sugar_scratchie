from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from backend.services import video_flow
from backend.services.mesh_tune import DEFAULT_MESH_TUNE
from backend.services.video_flow import (
    STEP_DEPS,
    STEP_ORDER,
    WORK_DIR,
    rebuild_mesh_for_delivery,
    work_dir,
    write_state,
)


@pytest.fixture
def card_id() -> str:
    return f"delivery_mesh_{uuid.uuid4().hex[:8]}"


def test_pipeline_tracks_delivery_clip_once():
    assert STEP_ORDER.index("compress") < STEP_ORDER.index("mesh")
    assert STEP_ORDER.index("mesh") < STEP_ORDER.index("symbols")
    assert STEP_DEPS["compress"] == ["card"]
    assert STEP_DEPS["mesh"] == ["compress"]
    assert STEP_DEPS["symbols"] == ["mesh"]
    assert STEP_ORDER[-1] == "symbols"


def test_rebuild_mesh_for_delivery_restores_symbol_points(card_id, monkeypatch, tmp_path):
    work = work_dir(card_id)
    cards_dir = work / "fixture-cards"
    mesh_dir = work / "fixture-mesh"
    monkeypatch.setattr(video_flow, "CARDS_DIR", cards_dir)
    monkeypatch.setattr(video_flow, "MESH_DIR", mesh_dir)
    monkeypatch.setattr(video_flow, "ROOT", work)

    card_dir = cards_dir / card_id
    card_dir.mkdir(parents=True)
    fg = card_dir / "foreground.mp4"
    fg.write_bytes(b"delivery-fg")
    monkeypatch.setattr(
        video_flow,
        "output_video_ready",
        lambda path: path == fg and path.is_file(),
    )

    mesh_dir.mkdir(parents=True)
    mesh_out = mesh_dir / f"{card_id}.json"
    points = [{"u": round(i / 11, 4), "v": 0.4} for i in range(12)]
    mesh_out.write_text(
        json.dumps(
            {
                "tracker": "bootstapir",
                "symbolPoints": points,
                "frames": [{"t": 0, "verts": [[0, 0]], "vis": [1]}],
            }
        )
    )

    captured: dict[str, str] = {}

    def fake_generate_mesh(env: dict[str, str]) -> None:
        captured.update(env)
        out = Path(env["OUTPUT_JSON"])
        if not out.is_absolute():
            out = work / out
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(
                {
                    "tracker": env["TRACKER"],
                    "source": env["INPUT_VIDEO"],
                    "frames": [{"t": 0, "verts": [[1, 1]], "vis": [1]}],
                }
            )
        )

    monkeypatch.setattr(video_flow, "generate_mesh", fake_generate_mesh)
    monkeypatch.setattr(
        video_flow,
        "generate_garment_mask",
        lambda path: {"ok": True},
    )

    result = rebuild_mesh_for_delivery(
        card_id=card_id,
        tracker="blend",
        tune=DEFAULT_MESH_TUNE,
    )

    assert result == mesh_out
    assert captured["TRACKER"] == "bootstapir"
    assert "foreground.mp4" in captured["INPUT_VIDEO"]
    data = json.loads(mesh_out.read_text())
    assert data["tracker"] == "bootstapir"
    assert data["symbolPoints"] == points


def test_force_compress_clears_downstream_mesh(card_id, monkeypatch):
    work = work_dir(card_id)
    write_state(
        work,
        {
            "approved": [
                "picture",
                "background",
                "dress",
                "boomerang",
                "card",
                "compress",
                "mesh",
                "symbols",
            ]
        },
    )
    video_flow.reject_flow_step(card_id, "compress")
    approved = video_flow.read_state(work)["approved"]
    assert "compress" not in approved
    assert "mesh" not in approved
    assert "symbols" not in approved
    assert "card" in approved
