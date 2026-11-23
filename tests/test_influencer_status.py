"""Influencer status: published, unpublished, and deprecated."""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from backend.db.engine import get_engine
from backend.db.models import Creator, MotionCard, Pack, Theme, UserCard
from backend.db.wallet import apply_delta
from tests.conftest import register_and_login


def _catalog_ids(client: TestClient, headers: dict | None = None) -> set[str]:
    response = client.get("/api/models", headers=headers)
    assert response.status_code == 200, response.text
    return {model["id"] for model in response.json()["models"]}


def test_status_round_trip_and_player_visibility(client, dashboard_headers):
    suffix = uuid.uuid4().hex[:8]
    model_id = f"stat_{suffix}"
    hidden_id = f"hid_{suffix}"
    with Session(get_engine()) as db:
        db.add_all(
            [
                Creator(id=model_id, label=f"Status {suffix}"),
                Creator(id=hidden_id, label=f"Hidden {suffix}"),
            ]
        )
        db.commit()

    created = client.get("/api/models")
    assert created.status_code == 200
    row = next(model for model in created.json()["models"] if model["id"] == model_id)
    assert row["status"] == "published"
    assert model_id in _catalog_ids(client)
    assert hidden_id in _catalog_ids(client)

    unpublished = client.put(
        f"/api/models/{hidden_id}",
        json={"status": "unpublished"},
        headers=dashboard_headers,
    )
    assert unpublished.status_code == 200, unpublished.text
    assert unpublished.json()["status"] == "unpublished"
    assert hidden_id not in _catalog_ids(client)
    assert hidden_id in _catalog_ids(client, dashboard_headers)

    deprecated = client.put(
        f"/api/models/{model_id}",
        json={"status": "deprecated"},
        headers=dashboard_headers,
    )
    assert deprecated.status_code == 200, deprecated.text
    assert deprecated.json()["status"] == "deprecated"
    assert model_id in _catalog_ids(client)
    listed = next(model for model in client.get("/api/models").json()["models"] if model["id"] == model_id)
    assert listed["status"] == "deprecated"

    invalid = client.put(
        f"/api/models/{model_id}",
        json={"status": "gone"},
        headers=dashboard_headers,
    )
    assert invalid.status_code == 422


def test_deprecated_blocks_new_sales_and_keeps_owned_cards(client, dashboard_headers):
    suffix = uuid.uuid4().hex[:8]
    model_id = f"dep_{suffix}"
    theme_id = f"deptheme_{suffix}"
    card_id = f"dep_{suffix}_card"
    pack_id = f"dep-{suffix}-pack"
    with Session(get_engine()) as db:
        db.add(Creator(id=model_id, label=f"Dep {suffix}"))
        db.add(Theme(id=theme_id, label=f"Dep theme {suffix}"))
        db.flush()
        db.add(MotionCard(id=card_id, label="Card", model_id=model_id, theme_id=theme_id, price=10))
        db.add(
            Pack(
                id=pack_id,
                model_id=model_id,
                theme_id=theme_id,
                name="Dep",
                pack_title="Dep Pack",
                diamond_cost=40,
                card_count=1,
                available=True,
            )
        )
        db.commit()

    packs = client.get("/api/packs").json()["packs"]
    assert any(pack["id"] == pack_id for pack in packs)

    _, user = register_and_login(client)
    with Session(get_engine()) as db:
        apply_delta(
            db,
            user_id=uuid.UUID(user["id"]),
            currency="diamonds",
            delta=500,
            reason="admin_adjust",
            idempotency_key=f"test-grant:{uuid.uuid4().hex}",
        )
        db.commit()

    assert client.put(
        f"/api/models/{model_id}",
        json={"status": "deprecated"},
        headers=dashboard_headers,
    ).status_code == 200

    packs = client.get("/api/packs").json()["packs"]
    assert all(pack["id"] != pack_id for pack in packs)
    assert client.post(f"/api/packs/{pack_id}/purchase", json={"quantity": 1}).status_code == 404

    blocked = client.post("/api/me/cards/play", json={"cardKind": "motion", "cardId": card_id})
    assert blocked.status_code == 403
    assert blocked.json()["detail"] == "creator_unavailable"

    board = client.get(f"/api/me/creators/{model_id}/board")
    assert board.status_code == 200, board.text
    assert board.json()["pack"] is None
    assert board.json()["creator"]["id"] == model_id

    with Session(get_engine()) as db:
        db.add(
            UserCard(
                user_id=uuid.UUID(user["id"]),
                card_kind="motion",
                card_id=card_id,
                model_id=model_id,
                theme_id=theme_id,
            )
        )
        db.commit()

    owned = client.post("/api/me/cards/play", json={"cardKind": "motion", "cardId": card_id})
    assert owned.status_code == 200, owned.text
    assert owned.json()["pricePaid"] == 0

    assert client.put(
        f"/api/models/{model_id}",
        json={"status": "unpublished"},
        headers=dashboard_headers,
    ).status_code == 200
    hidden_board = client.get(f"/api/me/creators/{model_id}/board")
    assert hidden_board.status_code == 404
    # She already owns the card, so playback still works even though the profile is hidden.
    still_owned = client.post("/api/me/cards/play", json={"cardKind": "motion", "cardId": card_id})
    assert still_owned.status_code == 200, still_owned.text


def test_only_published_influencer_can_be_invite_demo(client, dashboard_headers):
    suffix = uuid.uuid4().hex[:8]
    model_id = f"demo_{suffix}"
    card_id = f"demo_{suffix}_card"
    with Session(get_engine()) as db:
        db.add(Creator(id=model_id, label=f"Demo {suffix}"))
        db.flush()
        db.add(MotionCard(id=card_id, label="Demo card", model_id=model_id))
        db.commit()

    added = client.put(
        f"/api/models/{model_id}",
        json={"defaultModal": True, "defaultModalCardId": card_id},
        headers=dashboard_headers,
    )
    assert added.status_code == 200, added.text
    assert added.json()["defaultModal"] is True

    retired = client.put(
        f"/api/models/{model_id}",
        json={"status": "deprecated"},
        headers=dashboard_headers,
    )
    assert retired.status_code == 200, retired.text
    assert retired.json()["defaultModal"] is False
    assert retired.json()["defaultModalCardId"] is None

    blocked = client.put(
        f"/api/models/{model_id}",
        json={"defaultModal": True, "defaultModalCardId": card_id},
        headers=dashboard_headers,
    )
    assert blocked.status_code == 422
    assert "published" in blocked.json()["detail"].lower()


def test_player_collection_hides_unpublished_and_keeps_deprecated(
    client, dashboard_headers, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    import backend.app as app_module

    cards_dir = tmp_path / "public" / "cards"
    mesh_dir = tmp_path / "public" / "mesh"
    models_dir = tmp_path / "public" / "models"
    themes_dir = tmp_path / "public" / "themes"
    for directory in (cards_dir, mesh_dir, models_dir, themes_dir):
        directory.mkdir(parents=True)
    monkeypatch.setattr(app_module, "ROOT", tmp_path)
    monkeypatch.setattr(app_module, "CARDS_DIR", cards_dir)
    monkeypatch.setattr(app_module, "MESH_DIR", mesh_dir)
    monkeypatch.setattr(app_module, "MODELS_DIR", models_dir)
    monkeypatch.setattr(app_module, "THEMES_DIR", themes_dir)

    suffix = uuid.uuid4().hex[:8]
    model_id = f"colstat_{suffix}"
    theme_id = f"colstattheme_{suffix}"
    card_id = f"colstat_{suffix}_card"
    with Session(get_engine()) as db:
        db.add(Creator(id=model_id, label=f"Col {suffix}"))
        db.add(Theme(id=theme_id, label=f"Col theme {suffix}"))
        db.flush()
        db.add(MotionCard(id=card_id, label="Col card", model_id=model_id, theme_id=theme_id))
        db.commit()
    card_dir = cards_dir / card_id
    card_dir.mkdir()
    for name in ("background.mp4", "foreground.mp4"):
        (card_dir / name).write_bytes(b"clip")

    def model_ids() -> set[str]:
        response = client.get(f"/api/collection?model={model_id}")
        assert response.status_code == 200, response.text
        return {group["modelId"] for group in response.json()["groups"]}

    assert model_id in model_ids()

    assert client.put(
        f"/api/models/{model_id}",
        json={"status": "unpublished"},
        headers=dashboard_headers,
    ).status_code == 200
    assert model_id not in model_ids()

    operator = client.get(f"/api/collection?model={model_id}", headers=dashboard_headers)
    assert model_id in {group["modelId"] for group in operator.json()["groups"]}

    assert client.put(
        f"/api/models/{model_id}",
        json={"status": "deprecated"},
        headers=dashboard_headers,
    ).status_code == 200
    assert model_id in model_ids()
