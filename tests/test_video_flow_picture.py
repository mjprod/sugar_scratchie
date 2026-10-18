from __future__ import annotations

import shutil
import uuid
from collections.abc import Generator

import pytest

from backend.services.grok import resolve_scenery_prompt, scenery_edit_prompt
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
    assert picture_take_prompts(
        ["rooftop at night", "rainy alley", "sunlit pier"],
        "",
        "Firegirl",
    ) == ["rooftop at night", "rainy alley", "sunlit pier"]


def test_variation_count_limits_how_many_prompts_are_sent():
    one = picture_take_prompts(["only this"], "", "Firegirl", count=1)
    two = picture_take_prompts(["day", "night"], "", "Firegirl", count=2)
    assert one == ["only this"]
    assert two == ["day", "night"]


def test_empty_picture_takes_use_theme_lighting():
    prompts = picture_take_prompts([], "", "Firegirl")
    assert "bright open daylight" in prompts[0]
    assert "golden-hour" in prompts[1]
    assert "soft diffused" in prompts[2]
    assert "Firegirl" in prompts[0]


def test_operator_picture_prompt_keeps_their_text_and_adds_lighting():
    custom = "Put her in a neon rooftop at night. Keep her pose."
    assert resolve_scenery_prompt("warm beach", "bright open daylight", custom) == (
        "Put her in a neon rooftop at night. Keep her pose. Lighting for this take: bright open daylight."
    )
    assert resolve_scenery_prompt("Firegirl") == scenery_edit_prompt("Firegirl")


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
    assert approved["steps"]["picture"]["artifacts"] == [
        f".tmp/video-flow/{card_id}/picture.png"
    ]
    assert approved["steps"]["background"]["status"] == "ready"


def test_auto_approve_uses_the_first_picture_that_saved(card_id: str):
    work = work_dir(card_id)
    (work / "picture-2.png").write_bytes(b"two")
    (work / "picture-3.png").write_bytes(b"three")
    assert first_ready_picture_choice(work) == 2
    approve_flow_step(card_id, "picture", picture_choice=first_ready_picture_choice(work))
    assert (work / "picture.png").read_bytes() == b"two"


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
