from __future__ import annotations

import uuid

from backend.db.wallet import WELCOME_COINS
from tests.conftest import register_and_login


def test_scratch_coins_credit_once(client):
    register_and_login(client)
    hand_id = str(uuid.uuid4())
    body = {
        "amount": 90,
        "handId": hand_id,
        "milestone": 1,
        "cardId": "julianaval_gym",
    }

    first = client.post("/api/rewards/scratch/coins", json=body)
    assert first.status_code == 200, first.text
    first_json = first.json()
    assert first_json["ok"] is True
    assert first_json["coins"] == 90
    assert first_json["wallet"]["coins"] == WELCOME_COINS + 90

    second = client.post("/api/rewards/scratch/coins", json=body)
    assert second.status_code == 200, second.text
    second_json = second.json()
    assert second_json["ok"] is True
    assert second_json["wallet"]["coins"] == WELCOME_COINS + 90


def test_scratch_coins_different_milestones(client):
    register_and_login(client)
    hand_id = str(uuid.uuid4())

    first = client.post(
        "/api/rewards/scratch/coins",
        json={"amount": 80, "handId": hand_id, "milestone": 1},
    )
    second = client.post(
        "/api/rewards/scratch/coins",
        json={"amount": 100, "handId": hand_id, "milestone": 2},
    )
    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["wallet"]["coins"] == WELCOME_COINS + 180


def test_scratch_coins_amount_clamp(client):
    register_and_login(client)
    hand_id = str(uuid.uuid4())

    too_low = client.post(
        "/api/rewards/scratch/coins",
        json={"amount": 79, "handId": hand_id, "milestone": 1},
    )
    assert too_low.status_code == 400

    too_high = client.post(
        "/api/rewards/scratch/coins",
        json={"amount": 101, "handId": hand_id, "milestone": 2},
    )
    assert too_high.status_code == 400

    wallet = client.get("/api/me/wallet")
    assert wallet.status_code == 200
    assert wallet.json()["coins"] == WELCOME_COINS


def test_scratch_coins_requires_auth(client):
    response = client.post(
        "/api/rewards/scratch/coins",
        json={"amount": 90, "handId": "guest-hand", "milestone": 1},
    )
    assert response.status_code == 401
