"""Cache-bust query params on in-place media URLs."""

from __future__ import annotations

from pathlib import Path

from backend.cards import (
    find_card_trailer,
    version_public_src,
    versioned_public_url,
    versioned_workspace_path,
)
from backend.models_store import find_model_video


def test_versioned_public_url_appends_mtime(tmp_path: Path) -> None:
    media = tmp_path / "trailer.mp4"
    media.write_bytes(b"x")
    url = versioned_public_url(media, "cards/demo/trailer.mp4")
    assert url.startswith("/cards/demo/trailer.mp4?v=")
    assert url.endswith(str(int(media.stat().st_mtime)))


def test_find_card_trailer_is_versioned(tmp_path: Path) -> None:
    card_dir = tmp_path / "asian_1"
    card_dir.mkdir()
    trailer = card_dir / "trailer.mp4"
    trailer.write_bytes(b"clip")
    found = find_card_trailer(card_dir, "asian_1")
    assert found is not None
    assert "?v=" in found


def test_find_model_video_is_versioned(tmp_path: Path) -> None:
    model_dir = tmp_path / "julianaval"
    model_dir.mkdir()
    video = model_dir / "swipe.mp4"
    video.write_bytes(b"clip")
    found = find_model_video(model_dir, "swipe")
    assert found is not None
    assert "?v=" in found


def test_versioned_workspace_path_uses_public_prefix(tmp_path: Path) -> None:
    root = tmp_path
    public_cards = root / "public" / "cards" / "c1"
    public_cards.mkdir(parents=True)
    bg = public_cards / "background.mp4"
    bg.write_bytes(b"v")
    rel = versioned_workspace_path(root, bg)
    assert rel.startswith("public/cards/c1/background.mp4?v=")


def test_version_public_src_refreshes_stored_layer_url(tmp_path: Path) -> None:
    root = tmp_path
    layer = root / "public" / "cards" / "c1" / "photo-scratch" / "slot_01" / "bikini.jpg"
    layer.parent.mkdir(parents=True)
    layer.write_bytes(b"img")
    stored = "/cards/c1/photo-scratch/slot_01/bikini.jpg"
    refreshed = version_public_src(root, stored)
    assert refreshed is not None
    assert refreshed.startswith(stored)
    assert "?v=" in refreshed
