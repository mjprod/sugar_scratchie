from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.services.grok import photo_scratch_clothes_prompt

CARD_ID = "test_clothes_ref"
URL = f"/api/cards/{CARD_ID}/photo-scratch/clothes-ref"


@pytest.fixture
def workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    import backend.app as app_module

    tmp_path = tmp_path.resolve()
    monkeypatch.setattr(app_module, "ROOT", tmp_path)
    monkeypatch.setattr(app_module, "CARDS_DIR", tmp_path / "cards")
    uploads = tmp_path / ".tmp" / "uploads"
    uploads.mkdir(parents=True)
    (uploads / "dress.png").write_bytes(b"png")
    (uploads / "jacket.png").write_bytes(b"png")
    return tmp_path


def _index(workspace: Path) -> dict[str, dict]:
    path = workspace / "cards" / CARD_ID / "photo-scratch" / "index.json"
    return {entry["id"]: entry for entry in json.loads(path.read_text())}


def test_apply_to_all_then_override_one_then_clear(client, workspace, dashboard_headers):
    response = client.patch(URL, json={"image": ".tmp/uploads/dress.png"}, headers=dashboard_headers)
    assert response.status_code == 200, response.text
    slots = response.json()["slots"]
    assert len(slots) == 10
    assert {slot["clothes_ref"] for slot in slots} == {".tmp/uploads/dress.png"}

    response = client.patch(
        URL,
        json={"image": ".tmp/uploads/jacket.png", "slot_id": "slot_03"},
        headers=dashboard_headers,
    )
    assert response.status_code == 200, response.text
    assert [slot["id"] for slot in response.json()["slots"]] == ["slot_03"]
    index = _index(workspace)
    assert index["slot_03"]["clothes_ref"] == ".tmp/uploads/jacket.png"
    assert index["slot_01"]["clothes_ref"] == ".tmp/uploads/dress.png"

    response = client.patch(URL, json={"image": "", "slot_id": "slot_01"}, headers=dashboard_headers)
    assert response.status_code == 200, response.text
    assert "clothes_ref" not in _index(workspace)["slot_01"]

    response = client.patch(URL, json={"image": ""}, headers=dashboard_headers)
    assert response.status_code == 200, response.text
    assert all("clothes_ref" not in entry for entry in _index(workspace).values())

    listed = client.get(f"/api/cards/{CARD_ID}/photo-scratch").json()["slots"]
    assert all(slot["clothes_ref"] is None for slot in listed)


@pytest.mark.parametrize(
    ("url", "body", "status"),
    [
        (URL, {"image": ".tmp/uploads/dress.png", "slot_id": "slot_1"}, 400),
        (URL, {"image": ".tmp/uploads/dress.png", "slot_id": "slot_99"}, 404),
        (URL, {"image": ".tmp/uploads/missing.png"}, 404),
        (URL, {"image": "../outside.png"}, 400),
        ("/api/cards/Bad-Id/photo-scratch/clothes-ref", {"image": ""}, 400),
    ],
)
def test_rejects_bad_input(client, workspace, dashboard_headers, url, body, status):
    response = client.patch(url, json=body, headers=dashboard_headers)
    assert response.status_code == status, response.text


def test_requires_operator(client, workspace):
    response = client.patch(URL, json={"image": ".tmp/uploads/dress.png"})
    assert response.status_code == 401


def test_tagged_top_prompt_attaches_the_theme_uniform(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import backend.cards as cards
    import backend.services.video_flow as video_flow
    from backend.cards import PhotoScratchSlot

    root = tmp_path.resolve()
    girl = root / "girl.png"
    uniform = root / "uniform.png"
    bikini = root / "public" / "cards" / "demo" / "photo-scratch" / "bikini.jpg"
    girl.write_bytes(b"girl")
    uniform.write_bytes(b"uniform")
    bikini.parent.mkdir(parents=True)
    bikini.write_bytes(b"bikini")
    monkeypatch.setattr(video_flow, "ROOT", root)
    monkeypatch.setattr(video_flow, "CARDS_DIR", root / "public" / "cards")
    monkeypatch.setattr(video_flow, "WORK_DIR", root / "work")

    slot = PhotoScratchSlot(
        id="slot_01",
        label="1",
        bikini="/cards/demo/photo-scratch/bikini.jpg",
        clothes_ref=str(uniform),
        prompt_clothes="Keep this woman @image1. Replace her bikini with the Police costume.",
    )
    monkeypatch.setattr(cards, "list_photo_scratch_slots", lambda *_args, **_kwargs: [slot])
    monkeypatch.setattr(cards, "set_photo_scratch_pending_choices", lambda *_args, **_kwargs: None)
    seen: dict = {}

    def capture(**kwargs):
        seen["prompt"] = kwargs["prompt"]
        seen["images"] = list(kwargs["named_images"])
        return [{"model": "grok-imagine", "label": "Grok", "src": "/cards/demo/x.jpg"}]

    monkeypatch.setattr(video_flow, "_render_photo_choices", capture)
    video_flow.run_generate_photo_scratch_layer(
        card_id="demo",
        layer_type="clothes",
        source_image=str(girl),
        slot_id="slot_01",
        theme="Police",
        approve=False,
    )

    assert "costume in @image4" in seen["prompt"]
    assert "@image1" in seen["prompt"]
    assert seen["images"] == [girl, uniform]


def test_tagged_top_prompt_captions_a_remote_uniform(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import backend.cards as cards
    import backend.services.video_flow as video_flow
    from backend.cards import PhotoScratchSlot

    root = tmp_path.resolve()
    girl = root / "girl.png"
    dress = root / "dress.png"
    bikini = root / "public" / "cards" / "demo" / "photo-scratch" / "bikini.jpg"
    girl.write_bytes(b"girl")
    dress.write_bytes(b"dress")
    bikini.parent.mkdir(parents=True)
    bikini.write_bytes(b"bikini")
    work = root / "work" / "demo"
    work.mkdir(parents=True)
    (work / "draft.json").write_text(json.dumps({"dress_reference_image": str(dress)}))
    monkeypatch.setattr(video_flow, "ROOT", root)
    monkeypatch.setattr(video_flow, "CARDS_DIR", root / "public" / "cards")
    monkeypatch.setattr(video_flow, "WORK_DIR", root / "work")
    monkeypatch.setattr(video_flow, "_caption_clothes_ref", lambda ref, cache: "navy police minidress")

    slot = PhotoScratchSlot(
        id="slot_01",
        label="1",
        bikini="/cards/demo/photo-scratch/bikini.jpg",
        clothes_ref="https://example.com/uniform.png",
        prompt_clothes="Dress @image1 in @image4",
    )
    monkeypatch.setattr(cards, "list_photo_scratch_slots", lambda *_args, **_kwargs: [slot])
    monkeypatch.setattr(cards, "set_photo_scratch_pending_choices", lambda *_args, **_kwargs: None)
    seen: dict = {}

    def capture(**kwargs):
        seen["prompt"] = kwargs["prompt"]
        seen["images"] = list(kwargs["named_images"])
        return [{"model": "grok-imagine", "label": "Grok", "src": "/cards/demo/x.jpg"}]

    monkeypatch.setattr(video_flow, "_render_photo_choices", capture)
    video_flow.run_generate_photo_scratch_layer(
        card_id="demo",
        layer_type="clothes",
        source_image=str(girl),
        slot_id="slot_01",
        theme="Police",
        approve=False,
    )

    assert "navy police minidress" in seen["prompt"]
    assert "@image4" not in seen["prompt"]
    assert dress not in seen["images"]
    assert seen["images"] == [girl]


def test_unbound_image_tokens_are_dropped_and_the_slot_still_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    import backend.cards as cards
    import backend.services.video_flow as video_flow
    from backend.cards import PhotoScratchSlot

    root = tmp_path.resolve()
    girl = root / "girl.png"
    girl.write_bytes(b"girl")
    monkeypatch.setattr(video_flow, "ROOT", root)
    monkeypatch.setattr(video_flow, "CARDS_DIR", root / "public" / "cards")
    monkeypatch.setattr(video_flow, "WORK_DIR", root / "work")

    slot = PhotoScratchSlot(
        id="slot_01",
        label="1",
        prompt_bikini="Keep this woman @image1 in the bikini @image2 from the picture @image3.",
    )
    monkeypatch.setattr(cards, "list_photo_scratch_slots", lambda *_args, **_kwargs: [slot])
    monkeypatch.setattr(cards, "set_photo_scratch_pending_choices", lambda *_args, **_kwargs: None)
    seen: dict = {}

    def capture(**kwargs):
        seen["prompt"] = kwargs["prompt"]
        seen["images"] = kwargs["named_images"]
        return [{"model": "grok-imagine", "label": "Grok", "src": "/cards/demo/x.jpg"}]

    monkeypatch.setattr(video_flow, "_render_photo_choices", capture)
    video_flow.run_generate_photo_scratch_layer(
        card_id="demo",
        layer_type="bikini",
        source_image=str(girl),
        slot_id="slot_01",
        theme="Police",
        approve=False,
    )

    assert seen["images"] == [girl]
    assert "@image1" in seen["prompt"]
    assert "@image2" not in seen["prompt"]
    assert "@image3" not in seen["prompt"]


def test_clothes_prompt_uses_outfit_caption_instead_of_theme_costume():
    prompt = photo_scratch_clothes_prompt("Police", "warm amber tones", outfit="red satin gown")
    assert "red satin gown" in prompt
    assert "Police costume" not in prompt
    assert "warm amber tones" not in prompt

    fallback = photo_scratch_clothes_prompt("Police", "warm amber tones")
    assert "fully clothed Police costume" in fallback
    assert "warm amber tones" in fallback
