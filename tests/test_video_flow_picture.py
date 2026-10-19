from __future__ import annotations

import shutil
import uuid
from collections.abc import Generator
from pathlib import Path

import pytest

from backend.services.grok import INFLUENCER_POSITION, resolve_scenery_prompt, scenery_edit_prompt
from backend.services.video_flow import (
    picture_take_prompts,
    WORK_DIR,
    approve_flow_step,
    first_ready_picture_choice,
    flow_state,
    read_state,
    validate_step_enqueue,
    work_dir,
    write_state,
)


@pytest.fixture
def card_id() -> Generator[str, None, None]:
    value = f"test_picture_{uuid.uuid4().hex[:10]}"
    yield value
    shutil.rmtree(WORK_DIR / value, ignore_errors=True)


def test_each_picture_take_keeps_its_own_prompt():
    prompts = picture_take_prompts(
        ["rooftop at night", "rainy alley", "sunlit pier"],
        "",
        "Firegirl",
    )
    assert [prompt.split("\n", 1)[0] for prompt in prompts] == [
        "rooftop at night",
        "rainy alley",
        "sunlit pier",
    ]
    assert all("BODY LIGHT" in prompt for prompt in prompts)


def test_variation_count_limits_how_many_prompts_are_sent():
    one = picture_take_prompts(["only this"], "", "Firegirl", count=1)
    two = picture_take_prompts(["day", "night"], "", "Firegirl", count=2)
    assert one[0].startswith("only this")
    assert [prompt.split("\n", 1)[0] for prompt in two] == ["day", "night"]
    assert "BODY LIGHT" in one[0]


def test_empty_picture_takes_use_theme_lighting():
    prompts = picture_take_prompts([], "", "Firegirl")
    assert "bright daylight in the background only" in prompts[0]
    assert "warm sunset color in the background only" in prompts[1]
    assert "soft overcast light in the background only" in prompts[2]
    assert "BODY LIGHT" in prompts[0]
    assert "Firegirl" in prompts[0]
    assert "golden-hour" not in prompts[1]


def test_operator_picture_prompt_keeps_their_text_and_adds_lighting():
    from backend.services.grok import PICTURE_BODY_LIGHT

    custom = "Put her in a neon rooftop at night. Keep her pose."
    assert resolve_scenery_prompt("warm beach", "bright open daylight", custom) == (
        "Put her in a neon rooftop at night. Keep her pose. Lighting for this take: bright open daylight."
        f"\n\n{PICTURE_BODY_LIGHT}\n\n{INFLUENCER_POSITION}"
    )
    assert resolve_scenery_prompt("Firegirl") == scenery_edit_prompt("Firegirl")
    assert "INFLUENCER POSITION" in scenery_edit_prompt("Firegirl")
    assert "BODY LIGHT" in scenery_edit_prompt("Firegirl")


def test_saved_side_light_prompt_keeps_even_light_on_her_body():
    old = (
        "Replace the entire background behind the person with a vividly recognizable Egypt "
        "environment and matching lighting — a clear Egypt location/scene. "
        "Lighting for this take: golden-hour side light and warmer tones."
    )
    prompts = picture_take_prompts([old], "", "Egypt", count=1)
    assert "golden-hour" not in prompts[0]
    assert "matching lighting" not in prompts[0]
    assert "BODY LIGHT" in prompts[0]
    assert "warm sunset color in the background only" in prompts[0]


def test_picture_backfill_keeps_later_steps(card_id: str):
    work = work_dir(card_id)
    write_state(work, {"approved": ["background", "trim", "dress"]})
    assert read_state(work)["approved"] == ["picture", "background", "trim", "dress"]


def test_background_stays_locked_until_picture_is_approved(card_id: str):
    with pytest.raises(RuntimeError, match="Create picture"):
        validate_step_enqueue(card_id, "background", image="source.png")


def test_picture_choices_must_be_picked_before_video(card_id: str):
    work = work_dir(card_id)
    (work / "picture-1.png").write_bytes(b"one")
    (work / "picture-2.png").write_bytes(b"two")
    (work / "picture-3.png").write_bytes(b"three")

    state = flow_state(card_id)
    assert state["steps"]["picture"]["status"] == "review"
    assert state["steps"]["background"]["status"] == "locked"
    assert state["steps"]["picture"]["artifacts"] == [
        f".tmp/video-flow/{card_id}/picture-1.png",
        f".tmp/video-flow/{card_id}/picture-2.png",
        f".tmp/video-flow/{card_id}/picture-3.png",
    ]

    with pytest.raises(RuntimeError, match="Pick one of the pictures"):
        approve_flow_step(card_id, "picture")

    approved = approve_flow_step(card_id, "picture", picture_choice=2)
    assert (work / "picture.png").read_bytes() == b"two"
    assert approved["steps"]["picture"]["status"] == "approved"
    assert approved["picture_choice"] == 2
    assert approved["steps"]["picture"]["artifacts"] == [
        f".tmp/video-flow/{card_id}/picture-1.png",
        f".tmp/video-flow/{card_id}/picture-2.png",
        f".tmp/video-flow/{card_id}/picture-3.png",
    ]
    assert approved["steps"]["background"]["status"] == "ready"


def test_auto_approve_uses_the_first_picture_that_saved(card_id: str):
    work = work_dir(card_id)
    (work / "picture-2.png").write_bytes(b"two")
    (work / "picture-3.png").write_bytes(b"three")
    assert first_ready_picture_choice(work) == 2
    approve_flow_step(card_id, "picture", picture_choice=first_ready_picture_choice(work))
    assert (work / "picture.png").read_bytes() == b"two"


def test_switching_picture_keeps_every_take_and_unlocks_video(card_id: str):
    work = work_dir(card_id)
    (work / "picture-1.png").write_bytes(b"one")
    (work / "picture-2.png").write_bytes(b"two")
    (work / "picture-3.png").write_bytes(b"three")
    approve_flow_step(card_id, "picture", picture_choice=1)
    write_state(work, {"approved": ["picture", "background"]})
    (work / "background-raw.mp4").write_bytes(b"clip")

    switched = approve_flow_step(card_id, "picture", picture_choice=3)

    assert (work / "picture.png").read_bytes() == b"three"
    assert switched["picture_choice"] == 3
    assert "background" not in switched["approved"]
    assert switched["steps"]["picture"]["artifacts"] == [
        f".tmp/video-flow/{card_id}/picture-1.png",
        f".tmp/video-flow/{card_id}/picture-2.png",
        f".tmp/video-flow/{card_id}/picture-3.png",
    ]
    assert not (work / "background-raw.mp4").exists()


def test_picture_file_is_reviewed_before_video(card_id: str):
    work = work_dir(card_id)
    (work / "picture.png").write_bytes(b"png")

    state = flow_state(card_id)
    assert state["steps"]["picture"]["status"] == "review"
    assert state["steps"]["background"]["status"] == "locked"
    assert state["steps"]["picture"]["artifacts"] == [f".tmp/video-flow/{card_id}/picture.png"]

    approved = approve_flow_step(card_id, "picture")
    assert approved["steps"]["picture"]["status"] == "approved"
    assert approved["steps"]["background"]["status"] == "ready"


def test_scenery_edit_sends_the_new_face(monkeypatch, tmp_path):
    from backend.services import grok

    captured: dict = {}

    def fake_edit(**kwargs):
        captured.update(kwargs)
        return {}

    monkeypatch.setattr(grok, "api_key", lambda: "test")
    monkeypatch.setattr(grok, "_edit_image", fake_edit)
    monkeypatch.setattr(grok, "_save_image_response", lambda result, out: None)

    face = tmp_path / "face.jpg"
    face.write_bytes(b"face")
    grok.edit_image_scenery(
        image=tmp_path / "body.png",
        theme="Police",
        out=tmp_path / "out.png",
        prompt="Keep the same woman, face, identity, hair, skin tone, body, pose.",
        face_image=face,
    )

    assert captured["images"] == [tmp_path / "body.png", face]
    assert "face, identity, hair, skin tone" not in captured["prompt"]
    assert "<IMAGE_1> is her real face" in captured["prompt"]
    assert "not a lookalike" in captured["prompt"]
    assert "do not copy bangs" in captured["prompt"]
    assert "not the woman in <IMAGE_0>" in captured["prompt"]


def test_create_picture_face_locks_each_take_after_scenery(monkeypatch, tmp_path):
    """Setup face reference must hard-swap onto every take after scenery bake."""
    from PIL import Image

    import backend.services.video_flow as video_flow

    monkeypatch.setenv("XAI_API_KEY", "test-key")
    monkeypatch.delenv("WAVESPEED_API_KEY", raising=False)

    source = tmp_path / "source.png"
    face = tmp_path / "face.jpg"
    Image.new("RGB", (8, 8), (10, 20, 30)).save(source)
    Image.new("RGB", (8, 8), (200, 100, 50)).save(face)

    work = tmp_path / "work"
    work.mkdir()
    paths = {
        "picture": work / "picture.png",
        "styled_bikini": work / "styled-bikini.png",
        "styled_face": work / "styled-face.png",
        "styled_source": work / "styled-source.png",
    }
    scenery_calls: list[Path] = []
    post_scenery_swaps: list[Path] = []

    def fake_scenery(**kwargs):
        out = Path(kwargs["out"])
        Image.new("RGB", (8, 8), (40, 40, 40)).save(out)
        scenery_calls.append(out)
        return out

    def fake_lock(**kwargs):
        out = Path(kwargs["out"])
        Image.new("RGB", (8, 8), (255, 0, 0)).save(out)
        base = Path(kwargs["base_image"])
        if Path(base).name.startswith("picture-"):
            post_scenery_swaps.append(Path(base))
        return out

    monkeypatch.setattr(video_flow, "edit_image_scenery", fake_scenery)
    monkeypatch.setattr(video_flow, "lock_setup_face", fake_lock)

    video_flow.build_picture_still(
        image=source,
        theme_text="Police",
        source_model="grok-imagine",
        ai_provider="xai",
        draft={"face_image": str(face)},
        paths=paths,
        picture_variation_count=2,
    )

    assert len(scenery_calls) == 2
    assert post_scenery_swaps == [work / "picture-1.png", work / "picture-2.png"]
    assert Image.open(work / "picture-1.png").getpixel((0, 0)) == (255, 0, 0)


def test_create_picture_models_mode_uses_one_prompt_across_models(monkeypatch, tmp_path):
    from PIL import Image

    import backend.services.video_flow as video_flow

    monkeypatch.setenv("XAI_API_KEY", "test-key")
    monkeypatch.delenv("WAVESPEED_API_KEY", raising=False)

    source = tmp_path / "source.png"
    Image.new("RGB", (8, 8), (10, 20, 30)).save(source)
    work = tmp_path / "work"
    work.mkdir()
    paths = {
        "picture": work / "picture.png",
        "styled_bikini": work / "styled-bikini.png",
        "styled_face": work / "styled-face.png",
        "styled_source": work / "styled-source.png",
    }
    calls: list[tuple[str, str, str]] = []

    def fake_scenery(**kwargs):
        out = Path(kwargs["out"])
        Image.new("RGB", (8, 8), (40, 40, 40)).save(out)
        calls.append((str(kwargs["image_model"]), str(kwargs["provider"]), str(kwargs["prompt"])))
        return out

    monkeypatch.setattr(video_flow, "edit_image_scenery", fake_scenery)
    monkeypatch.setattr(video_flow, "lock_setup_face", lambda **kwargs: Path(kwargs["out"]))

    shared = "Keep her planted in a Police station. BODY LIGHT — even front light."
    video_flow.build_picture_still(
        image=source,
        theme_text="Police",
        source_model="grok-imagine",
        ai_provider="xai",
        draft={
            "picture_compare_mode": "models",
            "picture_models": ["grok-imagine", "seedream-v5-lite"],
            "picture_prompts": [shared, "other unused", "other unused"],
        },
        paths=paths,
        picture_prompts=[shared, "other unused", "other unused"],
        picture_variation_count=2,
    )

    assert len(calls) == 2
    assert calls[0][0] == "grok-imagine"
    assert calls[1][0] == "seedream-v5-lite"
    assert calls[0][2] == calls[1][2]
    assert "other unused" not in calls[0][2]
