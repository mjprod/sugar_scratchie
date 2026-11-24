"""Motion and photo card status: published or unpublished."""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from backend.db.engine import get_engine
from backend.db.models import Creator, MotionCard, Pack, PhotoScratchCard, Theme, UserCard
from backend.db.wallet import apply_delta
from backend.routers.packs import _deal_pools
from tests.conftest import register_and_login

CARDS_DIR = Path(__file__).resolve().parents[1] / "public" / "cards"


def _stub_card_videos(*card_ids: str) -> None:
    """`/api/cards` only lists rows that have background + foreground clips."""
    for card_id in card_ids:
        card_dir = CARDS_DIR / card_id
        card_dir.mkdir(parents=True, exist_ok=True)
        (card_dir / "background.mp4").write_bytes(b"clip")
        (card_dir / "foreground.mp4").write_bytes(b"clip")


def _cleanup_card_videos(*card_ids: str) -> None:
    for card_id in card_ids:
        shutil.rmtree(CARDS_DIR / card_id, ignore_errors=True)


def _grant(client: TestClient, user_id: str, diamonds: int = 500) -> None:
    with Session(get_engine()) as db:
        apply_delta(
            db,
            user_id=uuid.UUID(user_id),
            currency="diamonds",
            delta=diamonds,
            reason="admin_adjust",
            idempotency_key=f"test-grant:{uuid.uuid4().hex}",
        )
        db.commit()


def test_unpublished_card_hidden_until_owned(client, dashboard_headers):
    suffix = uuid.uuid4().hex[:8]
    model_id = f"cstat_{suffix}"
    theme_id = f"cstattheme_{suffix}"
    live_id = f"cstat_{suffix}_live"
    hidden_id = f"cstat_{suffix}_hid"
    photo_id = f"{hidden_id}_slot_01"
    pack_id = f"cstat-{suffix}-pack"
    _stub_card_videos(live_id, hidden_id)
    try:
        _unpublished_card_hidden_until_owned(
            client, dashboard_headers, model_id, theme_id, live_id, hidden_id, photo_id, pack_id
        )
    finally:
        _cleanup_card_videos(live_id, hidden_id)


def _unpublished_card_hidden_until_owned(
    client,
    dashboard_headers,
    model_id,
    theme_id,
    live_id,
    hidden_id,
    photo_id,
    pack_id,
):
    with Session(get_engine()) as db:
        db.add(Creator(id=model_id, label=f"CardStat {model_id}"))
        db.add(Theme(id=theme_id, label=f"CardStat theme {theme_id}"))
        db.flush()
        db.add(
            MotionCard(
                id=live_id,
                label="Live",
                model_id=model_id,
                theme_id=theme_id,
                price=8,
                status="published",
            )
        )
        db.add(
            MotionCard(
                id=hidden_id,
                label="Hidden",
                model_id=model_id,
                theme_id=theme_id,
                price=12,
                status="unpublished",
            )
        )
        db.add(
            PhotoScratchCard(
                id=photo_id,
                card_id=hidden_id,
                slot_id="slot_01",
                label="Hidden photo",
                model_id=model_id,
                theme_id=theme_id,
                background="b",
                bikini="k",
                clothes="c",
                mesh="m",
                card_price=3,
                status="unpublished",
            )
        )
        db.add(
            Pack(
                id=pack_id,
                model_id=model_id,
                theme_id=theme_id,
                name="CardStat",
                pack_title="CardStat Pack",
                diamond_cost=40,
                card_count=2,
                available=True,
            )
        )
        db.commit()

    _, user = register_and_login(client)
    _grant(client, user["id"])

    # Stranger board omits unpublished cards.
    board = client.get(f"/api/me/creators/{model_id}/board")
    assert board.status_code == 200, board.text
    motion_ids = {
        card["id"]
        for theme in board.json()["themes"]
        for card in theme["motionCards"]
    }
    assert live_id in motion_ids
    assert hidden_id not in motion_ids

    blocked = client.post(
        "/api/me/cards/play", json={"cardKind": "motion", "cardId": hidden_id}
    )
    assert blocked.status_code == 403
    assert blocked.json()["detail"] == "creator_unavailable"

    photo_blocked = client.post(
        "/api/me/cards/play", json={"cardKind": "photo", "cardId": photo_id}
    )
    assert photo_blocked.status_code == 403

    # Public catalog omits unpublished; operator catalog keeps them.
    public_ids = {card["id"] for card in client.get("/api/cards").json()["cards"]}
    assert live_id in public_ids
    assert hidden_id not in public_ids
    operator_ids = {
        card["id"]
        for card in client.get("/api/cards", headers=dashboard_headers).json()["cards"]
    }
    assert hidden_id in operator_ids

    with Session(get_engine()) as db:
        pack = db.get(Pack, pack_id)
        assert pack is not None
        pools = _deal_pools(db, pack)
        assert all(card_id != hidden_id for card_id, _ in pools["motion"])
        assert all(card_id != photo_id for card_id, _ in pools["photo"])
        assert any(card_id == live_id for card_id, _ in pools["motion"])

    with Session(get_engine()) as db:
        db.add(
            UserCard(
                user_id=uuid.UUID(user["id"]),
                card_kind="motion",
                card_id=hidden_id,
                model_id=model_id,
                theme_id=theme_id,
            )
        )
        db.commit()

    owned_board = client.get(f"/api/me/creators/{model_id}/board").json()
    owned_card = next(
        card
        for theme in owned_board["themes"]
        for card in theme["motionCards"]
        if card["id"] == hidden_id
    )
    assert owned_card["status"] == "unlocked"
    assert owned_card["forSale"] is False

    owned_play = client.post(
        "/api/me/cards/play", json={"cardKind": "motion", "cardId": hidden_id}
    )
    assert owned_play.status_code == 200, owned_play.text
    assert owned_play.json()["pricePaid"] == 0


def test_card_status_round_trip_and_influencer_override(client, dashboard_headers):
    suffix = uuid.uuid4().hex[:8]
    model_id = f"cstat2_{suffix}"
    theme_id = f"cstat2theme_{suffix}"
    card_id = f"cstat2_{suffix}_card"
    photo_id = f"{card_id}_slot_01"
    _stub_card_videos(card_id)
    try:
        _card_status_round_trip(
            client, dashboard_headers, model_id, theme_id, card_id, photo_id
        )
    finally:
        _cleanup_card_videos(card_id)


def _card_status_round_trip(
    client, dashboard_headers, model_id, theme_id, card_id, photo_id
):
    with Session(get_engine()) as db:
        db.add(Creator(id=model_id, label=f"CardStat2 {model_id}"))
        db.add(Theme(id=theme_id, label=f"CardStat2 theme {theme_id}"))
        db.flush()
        db.add(
            MotionCard(
                id=card_id,
                label="Card",
                model_id=model_id,
                theme_id=theme_id,
                price=9,
            )
        )
        db.add(
            PhotoScratchCard(
                id=photo_id,
                card_id=card_id,
                slot_id="slot_01",
                label="Photo",
                model_id=model_id,
                theme_id=theme_id,
                background="b",
                bikini="k",
                clothes="c",
                mesh="m",
                card_price=2,
            )
        )
        db.commit()

    listed = next(
        card for card in client.get("/api/cards", headers=dashboard_headers).json()["cards"] if card["id"] == card_id
    )
    assert listed["status"] == "published"

    updated = client.put(
        f"/api/cards/{card_id}",
        json={"status": "unpublished"},
        headers=dashboard_headers,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["status"] == "unpublished"

    invalid = client.put(
        f"/api/cards/{card_id}",
        json={"status": "deprecated"},
        headers=dashboard_headers,
    )
    assert invalid.status_code == 422

    photo_status = client.patch(
        f"/api/cards/{card_id}/photo-scratch/slot_01/status",
        json={"status": "unpublished"},
        headers=dashboard_headers,
    )
    assert photo_status.status_code == 200, photo_status.text
    assert photo_status.json()["status"] == "unpublished"

    # Republish the card; influencer unpublished still blocks first play.
    assert (
        client.put(
            f"/api/cards/{card_id}",
            json={"status": "published"},
            headers=dashboard_headers,
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/cards/{card_id}/photo-scratch/slot_01/status",
            json={"status": "published"},
            headers=dashboard_headers,
        ).status_code
        == 200
    )
    assert (
        client.put(
            f"/api/models/{model_id}",
            json={"status": "unpublished"},
            headers=dashboard_headers,
        ).status_code
        == 200
    )

    register_and_login(client)
    blocked = client.post("/api/me/cards/play", json={"cardKind": "motion", "cardId": card_id})
    assert blocked.status_code == 403
    assert blocked.json()["detail"] == "creator_unavailable"
