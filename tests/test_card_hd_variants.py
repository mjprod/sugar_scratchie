from __future__ import annotations

import shutil
import subprocess
import uuid
from pathlib import Path

import pytest
from sqlalchemy.orm import Session

from backend.cards import UpdateCardRequest, backfill_card_hd_variants, compress_card
from backend.cards_store import get_card, update_card
from backend.db.models import MotionCard
from backend.services.grok import probe_video
from backend.services.video_prep import (
    backup_video,
    compress_video,
    drop_out_of_sync_hd_variants,
    hd_variant_path,
    hd_variant_size,
    write_hd_variants,
)


@pytest.fixture
def layout(tmp_path: Path) -> tuple[Path, Path, Path]:
    root = tmp_path
    cards_dir = root / "public" / "cards"
    mesh_dir = root / "public" / "mesh"
    cards_dir.mkdir(parents=True)
    mesh_dir.mkdir(parents=True)
    return root, cards_dir, mesh_dir


def _new_card(db: Session, cards_dir: Path) -> str:
    card_id = f"test_hd_{uuid.uuid4().hex[:8]}"
    db.add(MotionCard(id=card_id, label="HD test"))
    db.flush()
    card_dir = cards_dir / card_id
    card_dir.mkdir()
    for name in ("background.mp4", "foreground.mp4"):
        (card_dir / name).write_bytes(b"clip")
    return card_id


def test_card_info_exposes_hd_pair_only_when_both_exist(db_session, layout):
    root, cards_dir, mesh_dir = layout
    card_id = _new_card(db_session, cards_dir)
    card_dir = cards_dir / card_id

    (card_dir / "background.hd.mp4").write_bytes(b"hd")
    card = get_card(db_session, root, cards_dir, mesh_dir, card_id)
    assert card.background_hd is None
    assert card.foreground_hd is None

    (card_dir / "foreground.hd.mp4").write_bytes(b"hd")
    card = get_card(db_session, root, cards_dir, mesh_dir, card_id)
    assert card.background_hd == f"public/cards/{card_id}/background.hd.mp4"
    assert card.foreground_hd == f"public/cards/{card_id}/foreground.hd.mp4"


def test_replacing_a_clip_drops_hd_pair(db_session, layout):
    root, cards_dir, mesh_dir = layout
    card_id = _new_card(db_session, cards_dir)
    card_dir = cards_dir / card_id
    for name in ("background.hd.mp4", "foreground.hd.mp4"):
        (card_dir / name).write_bytes(b"hd")
    replacement = root / "new-foreground.mp4"
    replacement.write_bytes(b"new")

    card = update_card(
        db_session,
        root,
        cards_dir,
        mesh_dir,
        card_id,
        UpdateCardRequest(foreground=str(replacement.relative_to(root))),
    )

    assert card.background_hd is None
    assert not (card_dir / "background.hd.mp4").exists()
    assert not (card_dir / "foreground.hd.mp4").exists()


def test_label_only_update_keeps_hd_pair(db_session, layout):
    root, cards_dir, mesh_dir = layout
    card_id = _new_card(db_session, cards_dir)
    card_dir = cards_dir / card_id
    for name in ("background.hd.mp4", "foreground.hd.mp4"):
        (card_dir / name).write_bytes(b"hd")

    card = update_card(
        db_session, root, cards_dir, mesh_dir, card_id, UpdateCardRequest(label="Renamed")
    )

    assert card.foreground_hd == f"public/cards/{card_id}/foreground.hd.mp4"


def test_hd_backfill_job_requires_operator(client):
    response = client.post("/api/jobs/cards/hd-variants")
    assert response.status_code == 401


needs_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe not installed",
)


def _test_clip(
    path: Path, *, width: int, height: int, frames: int, pattern: str = "testsrc"
) -> Path:
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", f"{pattern}=size={width}x{height}:rate=24",
            "-frames:v", str(frames),
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            str(path),
        ],
        check=True,
    )
    return path


@needs_ffmpeg
def test_write_hd_variants_matches_delivery_crop_and_timing(tmp_path):
    src_bg = _test_clip(tmp_path / "src-bg.mp4", width=720, height=1280, frames=12)
    src_fg = _test_clip(tmp_path / "src-fg.mp4", width=720, height=1280, frames=12)
    card_dir = tmp_path / "card"
    bg = compress_video(src_bg, card_dir / "background.mp4", preset="mobile")
    fg = compress_video(src_fg, card_dir / "foreground.mp4", preset="mobile")

    report = write_hd_variants(
        background_src=src_bg,
        foreground_src=src_fg,
        background_dst=bg,
        foreground_dst=fg,
        work_dir=tmp_path / "work",
    )

    assert report["written"] is True
    width, height = hd_variant_size()
    assert (width, height) == (720, 1240)
    meta = probe_video(hd_variant_path(fg))
    assert (int(meta["width"]), int(meta["height"])) == (width, height)
    assert drop_out_of_sync_hd_variants(bg, fg) is True


@needs_ffmpeg
def test_hd_variants_never_upscale_and_drop_when_out_of_sync(tmp_path):
    card_dir = tmp_path / "card"
    card_dir.mkdir()
    bg = _test_clip(card_dir / "background.mp4", width=390, height=672, frames=12)
    fg = _test_clip(card_dir / "foreground.mp4", width=390, height=672, frames=12)

    report = write_hd_variants(
        background_src=bg,
        foreground_src=fg,
        background_dst=bg,
        foreground_dst=fg,
        work_dir=tmp_path / "work",
    )
    assert report["written"] is False
    assert not hd_variant_path(bg).exists()

    _test_clip(hd_variant_path(bg), width=720, height=1240, frames=12)
    _test_clip(hd_variant_path(fg), width=720, height=1240, frames=10)
    assert drop_out_of_sync_hd_variants(bg, fg) is False
    assert not hd_variant_path(bg).exists()
    assert not hd_variant_path(fg).exists()


@needs_ffmpeg
def test_recompress_keeps_full_res_backups_for_hd_backfill(layout):
    root, cards_dir, _ = layout
    card_id = f"test_hd_{uuid.uuid4().hex[:8]}"
    card_dir = cards_dir / card_id
    card_dir.mkdir()
    backup_dir = root / ".video-backups"
    backup_dir.mkdir()
    for name in ("background.mp4", "foreground.mp4"):
        original = _test_clip(
            backup_dir / f"{card_id}_{name}", width=720, height=1280, frames=12
        )
        compress_video(original, card_dir / name, preset="mobile")

    compress_card(root, cards_dir, card_id, compress_preset="mobile")

    for name in ("background.mp4", "foreground.mp4"):
        assert int(probe_video(backup_dir / f"{card_id}_{name}")["width"]) == 720
    result = backfill_card_hd_variants(root, cards_dir, card_id)
    assert result["available"] is True, result


@needs_ffmpeg
def test_backup_replaces_wider_leftover_of_a_different_clip(tmp_path):
    card_dir = tmp_path / "card"
    card_dir.mkdir()
    backup_dir = tmp_path / ".video-backups"
    backup_dir.mkdir()
    leftover = _test_clip(
        backup_dir / "card_background.mp4", width=720, height=1280, frames=12, pattern="smptebars"
    )
    src = _test_clip(card_dir / "background.mp4", width=390, height=672, frames=12)

    assert backup_video(src, backup_dir) == leftover
    assert int(probe_video(leftover)["width"]) == 390


@needs_ffmpeg
def test_stale_backups_with_matching_timing_never_publish_hd(layout):
    root, cards_dir, _ = layout
    card_id = f"test_hd_{uuid.uuid4().hex[:8]}"
    card_dir = cards_dir / card_id
    card_dir.mkdir()
    backup_dir = root / ".video-backups"
    backup_dir.mkdir()
    for name in ("background.mp4", "foreground.mp4"):
        _test_clip(
            backup_dir / f"{card_id}_{name}", width=720, height=1280, frames=12, pattern="smptebars"
        )
        _test_clip(card_dir / name, width=390, height=672, frames=12)

    result = backfill_card_hd_variants(root, cards_dir, card_id)

    assert result["available"] is False, result
    assert not hd_variant_path(card_dir / "background.mp4").exists()
    assert not hd_variant_path(card_dir / "foreground.mp4").exists()
