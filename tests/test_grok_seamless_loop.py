from __future__ import annotations

from backend.services import grok


def test_image_to_video_pins_last_frame_only_on_imagine_15(tmp_path, monkeypatch):
    image = tmp_path / "still.png"
    image.write_bytes(b"still")
    out = tmp_path / "out.mp4"
    captured: dict = {}

    monkeypatch.setattr(grok, "api_key", lambda: "test-key")

    def fake_submit(*, endpoint, payload, key, out, label):
        del key, out, label
        captured["endpoint"] = endpoint
        captured["payload"] = payload
        return "req-1"

    monkeypatch.setattr(grok, "submit_video_job", fake_submit)
    monkeypatch.setattr(grok, "finish_video_job", lambda *args, **kwargs: None)

    common = {
        "image": image,
        "prompt": "She sways in place.",
        "out": out,
        "resolution": "720p",
        "image_field": "image",
        "endpoint": "/v1/videos/generations",
        "enhance": False,
    }
    grok.image_to_video(model="grok-imagine-video-1.5", **common)

    payload = captured["payload"]
    assert captured["endpoint"] == "/v1/videos/generations"
    assert payload["last_frame"] == payload["image"]
    assert payload["last_frame"]["url"].startswith("data:image/png;base64,")
    assert "seamless looping boomerang" not in payload["prompt"].lower()
    assert "last frame matches the first frame" in payload["prompt"].lower()

    grok.image_to_video(model="grok-imagine-video", **common)
    assert "last_frame" not in captured["payload"]


def test_stock_motion_prompt_asks_for_a_seamless_loop():
    assert "boomerang" not in grok.DEFAULT_BACKGROUND_MOTION_PROMPT.lower() or (
        "do not reverse, rewind, or boomerang" in grok.DEFAULT_BACKGROUND_MOTION_PROMPT.lower()
    )
    assert "last frame matches the first frame" in grok.DEFAULT_BACKGROUND_MOTION_PROMPT.lower()
    assert "do not reverse" in grok.DEFAULT_BACKGROUND_MOTION_PROMPT.lower()
    assert "@image3" in grok.DEFAULT_BACKGROUND_MOTION_PROMPT
    assert "The last frame matches the first frame" in grok.MOTION_ENHANCE_SYSTEM
    assert "Do not reverse, rewind, boomerang" in grok.MOTION_ENHANCE_SYSTEM
    assert grok.is_stock_background_motion_prompt(grok.DEFAULT_BACKGROUND_MOTION_PROMPT)

    saved = (
        "Animate this approved Nurse portrait (@image3). "
        "The Nurse background is already correct in @image3 — keep that exact backdrop."
    )
    named = grok.normalize_background_motion_prompt(saved)
    assert "last frame matches the first frame" in named.lower()
    assert "Nurse" in named


def test_motion_prompt_names_the_picked_picture_as_image3():
    saved = (
        "Animate this approved Nurse portrait into a seamless loop. "
        "The Nurse background is already correct in the input still — keep that exact backdrop. "
        "Framing matches the input image exactly. "
        "Feet glued to the floor in their exact input positions. "
        "stay identical to the input still in every frame."
    )
    named = grok.normalize_background_motion_prompt(saved)
    assert "Nurse" in named
    assert "approved Nurse portrait (@image3)" in named
    assert "correct in @image3" in named
    assert "matches @image3 exactly" in named
    assert "identical to @image3" in named
    assert "exact input positions" in named
    sent = grok.motion_prompt_for_model(named)
    assert "@image3" not in sent
    assert "the input image" in sent
