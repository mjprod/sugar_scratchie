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


def test_clothes_prompt_uses_outfit_caption_instead_of_theme_costume():
    prompt = photo_scratch_clothes_prompt("Police", "warm amber tones", outfit="red satin gown")
    assert "red satin gown" in prompt
    assert "Police costume" not in prompt
    assert "warm amber tones" not in prompt

    fallback = photo_scratch_clothes_prompt("Police", "warm amber tones")
    assert "fully clothed Police costume" in fallback
    assert "warm amber tones" in fallback
