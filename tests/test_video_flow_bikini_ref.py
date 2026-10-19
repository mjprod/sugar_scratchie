from __future__ import annotations

from pathlib import Path

import pytest

import random

from backend.services.grok import (
    PHOTO_SCRATCH_PLACEMENT_VARIATIONS,
    PHOTO_SCRATCH_POSE_VARIATIONS,
    PhotoScratchVariation,
    apply_photo_scratch_variation_overrides,
    assign_photo_scratch_variations,
    motion_source_style_prompt,
    photo_scratch_background_prompt,
    photo_scratch_background_prompt_locked,
    photo_scratch_bikini_prompt,
    photo_scratch_prompt_with_background,
    default_photo_scratch_variation_catalog,
)

CARD_ID = "test_bikini_ref"
URL = f"/api/video-flow/{CARD_ID}/draft"


@pytest.fixture
def workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    import backend.app as app_module
    import backend.services.video_flow as video_flow

    tmp_path = tmp_path.resolve()
    monkeypatch.setattr(app_module, "ROOT", tmp_path)
    monkeypatch.setattr(video_flow, "WORK_DIR", tmp_path / ".tmp" / "video-flow")
    monkeypatch.setattr(video_flow, "CARDS_DIR", tmp_path / "cards")
    return tmp_path


def _draft(**overrides: str) -> dict:
    return {
        "background_motion_prompt": "motion",
        "dress_prompt": "dress",
        "card_id": CARD_ID,
        "card_label": "Bikini ref",
        **overrides,
    }


def test_draft_round_trips_bikini_image(client, workspace, dashboard_headers):
    from backend.services.video_flow import read_flow_draft, save_flow_draft

    response = client.post(
        URL,
        json=_draft(bikini_image=".tmp/uploads/bikini.png", face_image=".tmp/uploads/face.png"),
        headers=dashboard_headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["draft"]["bikini_image"] == ".tmp/uploads/bikini.png"

    got = client.get(URL, headers=dashboard_headers).json()["draft"]
    assert got["bikini_image"] == ".tmp/uploads/bikini.png"

    # Step runs re-save the draft without Setup images — the bikini must survive.
    save_flow_draft(
        image="",
        background_motion_prompt="motion",
        foreground_motion_prompt="motion",
        dress_prompt="dress",
        card_id=CARD_ID,
        card_label="Bikini ref",
        model="m",
        resolution="720p",
        image_field="image",
        endpoint="/e",
        video_field="video",
        enhance_dress_prompt=False,
        tracker="all",
        write_webm=False,
    )
    saved = read_flow_draft(CARD_ID)
    assert saved["bikini_image"] == ".tmp/uploads/bikini.png"
    assert saved["face_image"] == ".tmp/uploads/face.png"

    response = client.post(URL, json=_draft(bikini_image=""), headers=dashboard_headers)
    assert response.status_code == 200, response.text
    assert read_flow_draft(CARD_ID)["bikini_image"] == ""


def test_bikini_prompt_numbers_references_in_send_order():
    full = photo_scratch_bikini_prompt(
        "Cowgirl", with_background=True, with_face=True, with_bikini=True
    )
    assert "Four references" in full
    assert "reference 3 = BIKINI" in full
    assert "reference 4 = FACE" in full
    assert "swimsuit from reference 3" in full
    assert "flattering Cowgirl bikini" not in full
    assert "Keep hair colour, skin tone, and body proportions exactly from reference 2." in full
    assert "Keep face, hair colour" not in full

    no_bg = photo_scratch_bikini_prompt("Cowgirl", with_bikini=True)
    assert "reference 2 = BIKINI" in no_bg
    assert "swimsuit from reference 2" in no_bg
    assert "FACE" not in no_bg

    no_bg_face = photo_scratch_bikini_prompt("Cowgirl", with_bikini=True, with_face=True)
    assert "Three references" in no_bg_face
    assert "reference 1 = WOMAN" in no_bg_face
    assert "reference 2 = BIKINI" in no_bg_face
    assert "reference 3 = FACE" in no_bg_face
    assert "swimsuit from reference 2" in no_bg_face
    assert "LAST reference image" in no_bg_face
    assert "Keep identity, hair, skin tone, and body proportions from reference 1." in no_bg_face
    assert "Keep face, identity" not in no_bg_face
    assert "Do not invent a different woman" in no_bg_face
    assert "Reference 1 = WOMAN, reference 2 = BIKINI." not in no_bg_face

    face_only = photo_scratch_bikini_prompt("Cowgirl", with_face=True)
    assert "Two references" in face_only
    assert "reference 1 = WOMAN" in face_only
    assert "reference 2 = FACE" in face_only
    assert "LAST reference image" in face_only
    assert "Keep identity, hair, skin tone, and body proportions from reference 1." in face_only
    assert "Keep face, identity" not in face_only
    assert "flattering Cowgirl bikini" in face_only
    assert "Do not invent a different woman" in face_only

    unchanged = photo_scratch_bikini_prompt("Cowgirl", with_background=True, with_face=True)
    assert "Three references" in unchanged
    assert "reference 3 = FACE" in unchanged
    assert "flattering Cowgirl bikini" in unchanged


def test_photo_number_does_not_lock_pose_or_position(monkeypatch, tmp_path):
    import backend.services.grok as grok

    monkeypatch.setattr(grok, "VARIATION_CATALOG_PATH", tmp_path / "missing.json")
    slot_ids = [f"slot_{index:02d}" for index in range(1, 11)]
    first = assign_photo_scratch_variations(slot_ids, random.Random(1))
    second = assign_photo_scratch_variations(slot_ids, random.Random(2))

    assert [first[slot_id].pose for slot_id in slot_ids] != PHOTO_SCRATCH_POSE_VARIATIONS
    assert first["slot_01"].pose != second["slot_01"].pose
    assert first["slot_01"].placement != second["slot_01"].placement
    assert len({item.pose for item in first.values()}) == len(PHOTO_SCRATCH_POSE_VARIATIONS)
    assert len({item.placement for item in first.values()}) == len(
        PHOTO_SCRATCH_PLACEMENT_VARIATIONS
    )


def test_bikini_prompt_uses_placement_instead_of_a_fixed_frame():
    placed = photo_scratch_bikini_prompt(
        "Cowgirl",
        "walking pose mid-stride toward camera, full body",
        with_background=True,
        placement="Place her on the left side of the frame, full body visible, with open scene on her right.",
    )
    assert "left side of the frame" in placed
    assert "INFLUENCER POSITION" not in placed
    assert "head near the top third" not in placed

    locked = photo_scratch_bikini_prompt("Cowgirl", with_background=True)
    assert "head near the top third" in locked
    assert "INFLUENCER POSITION" not in locked

    custom = photo_scratch_prompt_with_background(
        "Put her in the room.",
        has_background=True,
        pose="hands clasped behind back, upright stance",
        placement="Place her on the right side of the frame, full body visible, with open scene on her left.",
    )
    assert "right side of the frame" in custom
    assert "INFLUENCER POSITION" not in custom
    assert "hands clasped behind back" in custom
    assert "does not touch, lean on, sit on, or hold any furniture" in custom

    background = photo_scratch_background_prompt("Police", "warm amber tones")
    assert "No furniture and no props" in background
    assert "warm amber tones" in background
    locked_background = photo_scratch_background_prompt_locked("Empty Police room, no people.")
    assert "No furniture and no props" in locked_background
    assert photo_scratch_background_prompt_locked(background) == background


def test_variation_catalog_labels_match_prompt_text():
    catalog = default_photo_scratch_variation_catalog()
    assert [row["text"] for row in catalog["poses"]] == PHOTO_SCRATCH_POSE_VARIATIONS
    assert [row["text"] for row in catalog["placements"]] == PHOTO_SCRATCH_PLACEMENT_VARIATIONS
    assert all(row["label"] and row["text"] for group in catalog.values() for row in group)


def test_variation_overrides_replace_only_the_fields_you_set():
    slot_ids = ["slot_01", "slot_02"]
    planned = assign_photo_scratch_variations(slot_ids, random.Random(1))
    merged = apply_photo_scratch_variation_overrides(
        planned,
        {
            "slot_01": PhotoScratchVariation(
                pose="hands clasped behind back, upright stance",
                scene="",
                placement=(
                    "Place her on the left side of the frame, full body visible, "
                    "with open scene on her right."
                ),
            )
        },
    )
    assert merged["slot_01"].pose == "hands clasped behind back, upright stance"
    assert merged["slot_01"].scene == planned["slot_01"].scene
    assert "left side of the frame" in merged["slot_01"].placement
    assert merged["slot_02"] == planned["slot_02"]


def test_shuffle_uses_saved_variation_catalog(monkeypatch, tmp_path):
    import backend.services.grok as grok

    monkeypatch.setattr(grok, "VARIATION_CATALOG_PATH", tmp_path / "variations.json")
    grok.save_photo_scratch_variation_catalog(
        {
            "poses": [{"label": "Custom lean", "text": "leaning on one elbow, looking at camera"}],
            "scenes": [{"label": "Moon", "text": "moonlight only"}],
            "placements": [{"label": "Far left", "text": "Place her at the far left edge."}],
        }
    )
    slot_ids = [f"slot_{index:02d}" for index in range(1, 4)]
    planned = assign_photo_scratch_variations(slot_ids, random.Random(1))
    assert {item.pose for item in planned.values()} == {"leaning on one elbow, looking at camera"}
    assert {item.scene for item in planned.values()} == {"moonlight only"}
    assert all("far left edge" in item.placement for item in planned.values())
    assert "hands on hips" not in planned["slot_01"].pose


def test_variation_catalog_endpoint(client, dashboard_headers, monkeypatch, tmp_path):
    import backend.services.grok as grok

    monkeypatch.setattr(grok, "VARIATION_CATALOG_PATH", tmp_path / "missing.json")
    response = client.get("/api/photo-scratch/variations", headers=dashboard_headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["poses"]) == 10
    assert body["poses"][0]["label"]
    assert body["placements"][0]["text"]


def test_variation_catalog_can_be_updated(client, dashboard_headers, monkeypatch, tmp_path):
    import backend.services.grok as grok

    monkeypatch.setattr(grok, "VARIATION_CATALOG_PATH", tmp_path / "variations.json")
    current = client.get("/api/photo-scratch/variations", headers=dashboard_headers)
    assert current.status_code == 200, current.text
    catalog = current.json()
    catalog["poses"] = [
        {"label": "Custom lean", "text": "leaning on one elbow, looking at camera"},
        *catalog["poses"][1:],
    ]
    saved = client.put("/api/photo-scratch/variations", json=catalog, headers=dashboard_headers)
    assert saved.status_code == 200, saved.text
    assert saved.json()["poses"][0]["label"] == "Custom lean"
    again = client.get("/api/photo-scratch/variations", headers=dashboard_headers)
    assert again.json()["poses"][0]["text"] == "leaning on one elbow, looking at camera"

    catalog["scenes"] = []
    rejected = client.put("/api/photo-scratch/variations", json=catalog, headers=dashboard_headers)
    assert rejected.status_code == 400, rejected.text


def test_generate_rejects_a_bad_variation_slot(client, dashboard_headers):
    response = client.post(
        "/api/cards/test_bikini_ref/photo-scratch/generate",
        json={
            "layer": "background",
            "variations": [{"slot_id": "photo-3", "pose": "standing", "scene": "", "placement": ""}],
        },
        headers=dashboard_headers,
    )
    assert response.status_code == 400, response.text


def test_step1_style_edit_prefers_seedream_then_falls_back_to_xai(monkeypatch):
    import backend.services.video_flow as video_flow

    monkeypatch.setenv("WAVESPEED_API_KEY", "ws")
    monkeypatch.setenv("XAI_API_KEY", "xai")
    monkeypatch.setattr(video_flow, "normalize_source_image_model", lambda model, **_: model)
    calls: list[str] = []

    def flaky(provider: str, model: str) -> None:
        calls.append(f"{provider}:{model}")
        if provider == "wavespeed":
            raise RuntimeError("blocked")

    video_flow._run_step1_style_edit("face swap", "grok-imagine", flaky)
    assert calls == ["wavespeed:seedream-v5-lite", "xai:grok-imagine"]

    def always_fails(provider: str, model: str) -> None:
        raise RuntimeError("blocked")

    with pytest.raises(RuntimeError, match="Step 1 face swap failed"):
        video_flow._run_step1_style_edit("face swap", "grok-imagine", always_fails)


def test_motion_source_style_prompt_keeps_pose_and_orders_refs():
    both = motion_source_style_prompt(with_bikini=True, with_face=True)
    assert "Three references" in both
    assert "reference 2 = BIKINI" in both
    assert "reference 3 = FACE" in both
    assert "swimsuit from reference 2" in both
    assert "Do not crop, zoom, or reframe" in both

    assert "Completely remove her original swimsuit" in both

    captioned = motion_source_style_prompt(
        with_bikini=True, with_face=False, bikini_caption="black string bandeau bikini"
    )
    assert "That swimsuit is: black string bandeau bikini" in captioned

    face_only = motion_source_style_prompt(with_bikini=False, with_face=True)
    assert "reference 2 = FACE" in face_only
    assert "Keep her swimsuit exactly as in reference 1" in face_only


def test_face_swap_photo_scratch_layer_raises_on_failure(tmp_path, monkeypatch):
    import backend.services.video_flow as video_flow

    layer = tmp_path / "slot_bikini.jpg"
    face = tmp_path / "face.png"
    layer.write_bytes(b"fake")
    face.write_bytes(b"fake")

    def boom(**kwargs):
        raise RuntimeError("provider rejected swap")

    monkeypatch.setattr(video_flow, "lock_setup_face", boom)
    with pytest.raises(RuntimeError, match="Face swap failed"):
        video_flow._face_swap_photo_scratch_layer(
            layer,
            face,
            provider="xai",
            image_model="grok-imagine",
        )
