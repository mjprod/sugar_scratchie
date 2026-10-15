from __future__ import annotations

from pathlib import Path

import pytest

from backend.services.grok import motion_source_style_prompt, photo_scratch_bikini_prompt

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
