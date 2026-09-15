from __future__ import annotations

import uuid

from backend.db.wallet import WELCOME_COINS
from tests.conftest import register_and_login


def _start_hand(client, card_id: str | None = "julianaval_gym") -> str:
    body = {"cardId": card_id} if card_id else {}
    response = client.post("/api/rewards/scratch/hands", json=body)
    assert response.status_code == 200, response.text
    hand_id = response.json()["handId"]
    uuid.UUID(hand_id)  # must be a real UUID
    return hand_id


def test_scratch_coins_require_server_hand(client):
    register_and_login(client)
    forged = str(uuid.uuid4())
    response = client.post(
        "/api/rewards/scratch/coins",
        json={"handId": forged, "milestone": 1, "amount": 90},
    )
    assert response.status_code == 404
    wallet = client.get("/api/me/wallet")
    assert wallet.json()["coins"] == WELCOME_COINS


def test_scratch_coins_credit_once(client):
    register_and_login(client)
    hand_id = _start_hand(client)
    body = {
        "handId": hand_id,
        "milestone": 1,
        "cardId": "julianaval_gym",
        "amount": 90,  # ignored by server
    }

    first = client.post("/api/rewards/scratch/coins", json=body)
    assert first.status_code == 200, first.text
    first_json = first.json()
    assert first_json["ok"] is True
    assert first_json["alreadyClaimed"] is False
    assert 80 <= first_json["coins"] <= 100
    awarded = first_json["coins"]
    assert first_json["wallet"]["coins"] == WELCOME_COINS + awarded

    second = client.post("/api/rewards/scratch/coins", json=body)
    assert second.status_code == 200, second.text
    second_json = second.json()
    assert second_json["ok"] is True
    assert second_json["alreadyClaimed"] is True
    assert second_json["coins"] == 0
    assert second_json["wallet"]["coins"] == WELCOME_COINS + awarded


def test_scratch_coins_different_milestones(client):
    register_and_login(client)
    hand_id = _start_hand(client)

    first = client.post(
        "/api/rewards/scratch/coins",
        json={"handId": hand_id, "milestone": 1},
    )
    second = client.post(
        "/api/rewards/scratch/coins",
        json={"handId": hand_id, "milestone": 2},
    )
    assert first.status_code == 200
    assert second.status_code == 200
    total = first.json()["coins"] + second.json()["coins"]
    assert second.json()["wallet"]["coins"] == WELCOME_COINS + total
    assert 160 <= total <= 200


def test_scratch_coins_reject_client_forged_hand_string(client):
    register_and_login(client)
    response = client.post(
        "/api/rewards/scratch/coins",
        json={"handId": "not-a-uuid", "milestone": 1},
    )
    assert response.status_code == 400


def test_scratch_coins_amount_ignored_out_of_range(client):
    """Client amount is ignored; out-of-range values must not 400."""
    register_and_login(client)
    hand_id = _start_hand(client)

    response = client.post(
        "/api/rewards/scratch/coins",
        json={"handId": hand_id, "milestone": 1, "amount": 1_000_000},
    )
    assert response.status_code == 200, response.text
    assert 80 <= response.json()["coins"] <= 100


def test_scratch_hand_rate_limit(client, monkeypatch):
    register_and_login(client)
    monkeypatch.setattr("backend.routers.rewards.SCRATCH_HANDS_PER_DAY", 2)

    assert client.post("/api/rewards/scratch/hands", json={}).status_code == 200
    assert client.post("/api/rewards/scratch/hands", json={}).status_code == 200
    limited = client.post("/api/rewards/scratch/hands", json={})
    assert limited.status_code == 429


def test_scratch_coins_requires_auth(client):
    response = client.post(
        "/api/rewards/scratch/coins",
        json={"handId": str(uuid.uuid4()), "milestone": 1},
    )
    assert response.status_code == 401

    hands = client.post("/api/rewards/scratch/hands", json={})
    assert hands.status_code == 401
