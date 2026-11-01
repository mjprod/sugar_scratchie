from pathlib import Path

import pytest

from backend.services.image_refs import (
    bind_prompt_images,
    drop_unbound_image_tokens,
    image_slots,
    replace_image_tokens,
    rewrite_image_tokens,
)


def test_image_slots_keep_first_seen_order():
    assert image_slots("dress @image1 in @image3, then @image1 again") == [1, 3]
    assert image_slots("no tokens") == []


def test_rewrite_matches_attachment_order():
    prompt = "Put the uniform from @image3 on the woman in @image1."
    assert rewrite_image_tokens(prompt, style="grok") == (
        "Put the uniform from <IMAGE_1> on the woman in <IMAGE_0>."
    )
    assert rewrite_image_tokens(prompt, style="seedream") == (
        "Put the uniform from Figure 2 on the woman in Figure 1."
    )


def test_replace_image_tokens_uses_exact_phrases():
    assert replace_image_tokens("wear @image3", {3: "@Image 2"}) == "wear @Image 2"


def test_approve_keeps_the_chosen_still(tmp_path: Path):
    from backend.cards import approve_photo_scratch_layer, list_photo_scratch_slots, set_photo_scratch_pending_choices

    cards = tmp_path / "cards"
    set_photo_scratch_pending_choices(
        cards,
        "demo",
        "slot_01",
        "bikini",
        [
            {"model": "grok-imagine", "label": "Grok", "src": "/cards/demo/photo-scratch/pending/a.jpg"},
            {
                "model": "seedream-v5-lite",
                "label": "Seedream",
                "src": "/cards/demo/photo-scratch/pending/b.jpg",
            },
        ],
    )
    slot = approve_photo_scratch_layer(cards, "demo", "slot_01", "bikini", choice="seedream-v5-lite")
    assert slot.bikini is not None and slot.bikini.endswith("b.jpg")
    assert slot.pending_bikini is None
    assert slot.pending_bikini_choices == []

    listed = list_photo_scratch_slots(cards, "demo")
    saved = next(item for item in listed if item.id == "slot_01")
    assert saved.bikini is not None and saved.bikini.endswith("b.jpg")
    assert saved.pending_bikini_choices == []


def test_bind_prompt_images_requires_the_named_file(tmp_path: Path):
    main = tmp_path / "main.png"
    main.write_bytes(b"png")
    prompt, images = bind_prompt_images("keep @image1", {1: main, 2: None, 3: None})
    assert images == [main]
    assert "@image1" in prompt

    with pytest.raises(RuntimeError, match="@image2"):
        bind_prompt_images("dress @image1 in @image2", {1: main, 2: None})


def test_drop_unbound_image_tokens_keeps_the_photos_that_exist(tmp_path: Path):
    main = tmp_path / "main.png"
    bikini = tmp_path / "bikini.png"
    main.write_bytes(b"png")
    bikini.write_bytes(b"png")
    prompt = "Keep her. @image1 @image2 @image3 @image3"
    trimmed, dropped = drop_unbound_image_tokens(prompt, {1: main, 2: bikini, 3: None})
    assert dropped == [3]
    assert "@image3" not in trimmed
    assert "@image1" in trimmed and "@image2" in trimmed
