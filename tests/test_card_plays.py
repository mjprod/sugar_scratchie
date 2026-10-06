from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from backend.db.engine import get_engine
from backend.db.models import MotionCard, PhotoScratchCard
from backend.db.wallet import WELCOME_COINS, WELCOME_DIAMONDS
from tests.conftest import register_and_login


def _create_cards(photo_price: int | None) -> tuple[str, str]:
    """Commit a motion card + one priced photo slot; return (motion_id, photo_id)."""
    motion_id = f"test_play_{uuid.uuid4().hex[:8]}"
    photo_id = f"{motion_id}_slot_01"
    with Session(get_engine()) as db:
        db.add(MotionCard(id=motion_id, label="Play test"))
        db.flush()
        db.add(
            PhotoScratchCard(
                id=photo_id,
                card_id=motion_id,
                slot_id="slot_01",
                label="Play test slot",
                background="/bg.png",
                bikini="/bikini.png",
                clothes="/clothes.png",
                mesh="/mesh.json",
                card_price=photo_price,
            )
        )
        db.commit()
    return motion_id, photo_id


def _play(client, kind: str, card_id: str):
    return client.post("/api/me/cards/play", json={"cardKind": kind, "cardId": card_id})


def _start_hand(client, card_id: str) -> dict:
    response = client.post("/api/rewards/scratch/hands", json={"cardId": card_id})
    assert response.status_code == 200, response.text
    return response.json()


def _claim(client, hand_id: str, milestone: int = 1) -> dict:
    response = client.post(
        "/api/rewards/scratch/coins", json={"handId": hand_id, "milestone": milestone}
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_buy_photo_card_charges_once(client):
    register_and_login(client)
    _, photo_id = _create_cards(photo_price=2)

    first = _play(client, "photo", photo_id)
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["firstPlay"] is True
    assert body["rewardsEnabled"] is True
    assert body["pricePaid"] == 2
    assert body["wallet"]["diamonds"] == WELCOME_DIAMONDS - 2

    second = _play(client, "photo", photo_id)
    assert second.status_code == 200, second.text
    again = second.json()
    assert again["firstPlay"] is False
    assert again["pricePaid"] == 0
    assert again["played"]["playCount"] == 2
    assert again["wallet"]["diamonds"] == WELCOME_DIAMONDS - 2


def test_buy_photo_card_insufficient_creates_no_row(client):
    register_and_login(client)
    _, photo_id = _create_cards(photo_price=WELCOME_DIAMONDS + 50)

    response = _play(client, "photo", photo_id)
    assert response.status_code == 400
    assert response.json()["detail"] == "insufficient"
    played = client.get("/api/me/cards/played").json()["played"]
    assert all(p["cardId"] != photo_id for p in played)
    assert client.get("/api/me/wallet").json()["diamonds"] == WELCOME_DIAMONDS


def test_play_unknown_card_404(client):
    register_and_login(client)
    response = _play(client, "photo", f"missing_{uuid.uuid4().hex[:6]}_slot_01")
    assert response.status_code == 404
    response = _play(client, "motion", f"missing_{uuid.uuid4().hex[:6]}")
    assert response.status_code == 404


def test_first_hand_rewarded_replay_hands_mint_nothing(client):
    register_and_login(client)
    _, photo_id = _create_cards(photo_price=1)
    assert _play(client, "photo", photo_id).status_code == 200

    rewarded = _start_hand(client, photo_id)
    assert rewarded["rewardsEnabled"] is True
    claim = _claim(client, rewarded["handId"])
    assert 80 <= claim["coins"] <= 100

    replay_play = _play(client, "photo", photo_id).json()
    assert replay_play["firstPlay"] is False
    assert replay_play["rewardsEnabled"] is False

    replay = _start_hand(client, photo_id)
    assert replay["rewardsEnabled"] is False
    practice = _claim(client, replay["handId"])
    assert practice["coins"] == 0
    assert practice["practice"] is True
    assert practice["wallet"]["coins"] == WELCOME_COINS + claim["coins"]


def test_lost_purchase_response_retry_keeps_rewarded_hand(client):
    """Client dropped the buy response and POSTed again before any hand started."""
    register_and_login(client)
    _, photo_id = _create_cards(photo_price=3)
    assert _play(client, "photo", photo_id).status_code == 200

    retry = _play(client, "photo", photo_id).json()
    assert retry["firstPlay"] is False
    assert retry["pricePaid"] == 0
    assert retry["rewardsEnabled"] is True
    assert retry["wallet"]["diamonds"] == WELCOME_DIAMONDS - 3

    hand = _start_hand(client, photo_id)
    assert hand["rewardsEnabled"] is True
    assert _claim(client, hand["handId"])["coins"] > 0


def test_unbought_priced_photo_card_gets_practice_hand(client):
    register_and_login(client)
    _, photo_id = _create_cards(photo_price=2)

    hand = _start_hand(client, photo_id)
    assert hand["rewardsEnabled"] is False
    assert _claim(client, hand["handId"])["coins"] == 0
    played = client.get("/api/me/cards/played").json()["played"]
    assert all(p["cardId"] != photo_id for p in played)


def test_free_motion_card_registers_on_first_hand(client):
    register_and_login(client)
    motion_id, _ = _create_cards(photo_price=None)

    first = _start_hand(client, motion_id)
    assert first["rewardsEnabled"] is True
    second = _start_hand(client, motion_id)
    assert second["rewardsEnabled"] is False

    played = client.get("/api/me/cards/played").json()["played"]
    assert [(p["cardKind"], p["cardId"], p["pricePaid"]) for p in played] == [
        ("motion", motion_id, 0)
    ]


def test_cardless_hand_mints_nothing(client):
    register_and_login(client)
    response = client.post("/api/rewards/scratch/hands", json={})
    assert response.status_code == 200
    assert response.json()["rewardsEnabled"] is False
    assert _claim(client, response.json()["handId"])["coins"] == 0


def test_played_list_requires_auth(client):
    assert client.get("/api/me/cards/played").status_code == 401
    assert _play(client, "motion", "anything").status_code == 401
