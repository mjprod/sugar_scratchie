from __future__ import annotations

import json
import uuid
from collections.abc import Generator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from backend.cards import CARD_PRICE_MAX, optional_card_price
from backend.db.models import MotionCard, PhotoScratchCard
from backend.photo_scratch_store import list_photo_scratch_cards, upsert_published


@pytest.fixture
def cards_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    import backend.app as app_module

    path = tmp_path / "cards"
    monkeypatch.setattr(app_module, "CARDS_DIR", path)
    return path


@pytest.fixture
def price_client(cards_dir: Path, db_session: Session) -> Generator[TestClient, None, None]:
    """Client whose request sessions share the rolled-back `db_session` transaction."""
    from backend.app import app
    from backend.db.engine import get_session

    def _session() -> Generator[Session, None, None]:
        yield db_session

    app.dependency_overrides[get_session] = _session
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.pop(get_session, None)


def _new_card(db: Session) -> str:
    card_id = f"test_price_{uuid.uuid4().hex[:8]}"
    db.add(MotionCard(id=card_id, label="Price test"))
    db.flush()
    return card_id


def _publish_slot(db: Session, card_id: str, slot_id: str, card_price: object) -> str:
    entry_id = f"{card_id}_{slot_id}"
    upsert_published(
        db,
        card_id,
        [
            {
                "id": entry_id,
                "label": "Price test slot",
                "background": "/bg.png",
                "bikini": "/bikini.png",
                "clothes": "/clothes.png",
                "mesh": "/mesh.json",
                "card_price": card_price,
            }
        ],
        slot_id=slot_id,
    )
    return entry_id


def _slot_index_entry(cards_dir: Path, card_id: str, slot_id: str) -> dict:
    index = json.loads((cards_dir / card_id / "photo-scratch" / "index.json").read_text())
    return next(entry for entry in index if entry["id"] == slot_id)


def _price_url(card_id: str, slot_id: str) -> str:
    return f"/api/cards/{card_id}/photo-scratch/{slot_id}/price"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (0, 0),
        (25, 25),
        (CARD_PRICE_MAX, CARD_PRICE_MAX),
        (CARD_PRICE_MAX + 1, None),
        (-1, None),
        (True, None),
        ("12", None),
        (12.5, None),
        (None, None),
    ],
)
def test_optional_card_price(raw, expected):
    assert optional_card_price(raw) == expected


def test_publish_carries_price_to_catalog(db_session, tmp_path):
    card_id = _new_card(db_session)
    entry_id = _publish_slot(db_session, card_id, "slot_01", 25)

    cards = {card.id: card for card in list_photo_scratch_cards(db_session, tmp_path)}
    assert cards[entry_id].card_price == 25


def test_publish_drops_invalid_price(db_session, tmp_path):
    card_id = _new_card(db_session)
    entry_id = _publish_slot(db_session, card_id, "slot_01", CARD_PRICE_MAX + 1)

    cards = {card.id: card for card in list_photo_scratch_cards(db_session, tmp_path)}
    assert cards[entry_id].card_price is None


def test_patch_price_updates_slot_and_published_row(
    price_client, db_session, cards_dir, dashboard_headers
):
    card_id = _new_card(db_session)
    entry_id = _publish_slot(db_session, card_id, "slot_01", 10)

    response = price_client.patch(
        _price_url(card_id, "slot_01"), json={"card_price": 40}, headers=dashboard_headers
    )
    assert response.status_code == 200, response.text
    assert response.json()["card_price"] == 40
    assert _slot_index_entry(cards_dir, card_id, "slot_01")["card_price"] == 40
    assert db_session.get(PhotoScratchCard, entry_id).card_price == 40


def test_patch_price_null_clears_slot_and_published_row(
    price_client, db_session, cards_dir, dashboard_headers
):
    card_id = _new_card(db_session)
    entry_id = _publish_slot(db_session, card_id, "slot_01", 10)
    url = _price_url(card_id, "slot_01")

    assert price_client.patch(url, json={"card_price": 40}, headers=dashboard_headers).status_code == 200
    response = price_client.patch(url, json={"card_price": None}, headers=dashboard_headers)
    assert response.status_code == 200, response.text
    assert response.json()["card_price"] is None
    assert "card_price" not in _slot_index_entry(cards_dir, card_id, "slot_01")
    assert db_session.get(PhotoScratchCard, entry_id).card_price is None


def test_patch_price_on_unpublished_slot_only_updates_index(
    price_client, db_session, cards_dir, dashboard_headers
):
    card_id = _new_card(db_session)

    response = price_client.patch(
        _price_url(card_id, "slot_02"), json={"card_price": 7}, headers=dashboard_headers
    )
    assert response.status_code == 200, response.text
    assert _slot_index_entry(cards_dir, card_id, "slot_02")["card_price"] == 7
    assert db_session.get(PhotoScratchCard, f"{card_id}_slot_02") is None


@pytest.mark.parametrize("bad_price", [-1, CARD_PRICE_MAX + 1, 12.5, "abc"])
def test_patch_price_rejects_invalid_values(
    price_client, db_session, cards_dir, dashboard_headers, bad_price
):
    card_id = _new_card(db_session)
    entry_id = _publish_slot(db_session, card_id, "slot_01", 10)

    response = price_client.patch(
        _price_url(card_id, "slot_01"), json={"card_price": bad_price}, headers=dashboard_headers
    )
    assert response.status_code == 422, response.text
    assert not (cards_dir / card_id / "photo-scratch" / "index.json").exists()
    assert db_session.get(PhotoScratchCard, entry_id).card_price == 10


@pytest.mark.parametrize(
    ("card_id", "slot_id", "status"),
    [
        ("Bad-Id", "slot_01", 400),
        ("valid_card", "slot_1", 400),
        ("valid_card", "slot_99", 404),
    ],
)
def test_patch_price_rejects_bad_ids(price_client, dashboard_headers, card_id, slot_id, status):
    response = price_client.patch(
        _price_url(card_id, slot_id), json={"card_price": 5}, headers=dashboard_headers
    )
    assert response.status_code == status, response.text


def test_patch_price_requires_operator(price_client, db_session):
    card_id = _new_card(db_session)

    response = price_client.patch(_price_url(card_id, "slot_01"), json={"card_price": 5})
    assert response.status_code == 401
