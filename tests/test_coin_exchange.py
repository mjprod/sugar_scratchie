from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from backend.db.engine import get_engine
from backend.db.wallet import WELCOME_COINS, WELCOME_DIAMONDS, apply_delta
from tests.conftest import register_and_login


def _grant_coins(user_id: str, coins: int) -> None:
    with Session(get_engine()) as db:
        apply_delta(
            db,
            user_id=uuid.UUID(user_id),
            currency="coins",
            delta=coins,
            reason="admin_adjust",
            idempotency_key=f"test-coins:{uuid.uuid4().hex}",
        )
        db.commit()


def _exchange(client, option_id: str, *, headers: dict | None = None, **amounts):
    return client.post(
        "/api/store/exchange", json={"optionId": option_id, **amounts}, headers=headers or {}
    )


def test_exchange_options_are_public(client):
    options = client.get("/api/store/exchange/options").json()["options"]
    assert {"id": "x100", "diamonds": 100, "coins": 100} in options
    assert [o["id"] for o in options] == ["x100", "x500", "x1200", "x2500", "x5000"]


def test_exchange_moves_coins_to_diamonds(client):
    _, user = register_and_login(client)
    _grant_coins(user["id"], 700)

    response = _exchange(client, "x500", diamonds=500, coins=780)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "success"
    assert body["wallet"] == {
        "diamonds": WELCOME_DIAMONDS + 500,
        "coins": WELCOME_COINS + 700 - 780,
    }

    reasons = [
        (t["currency"], t["delta"])
        for t in client.get("/api/me/wallet/transactions").json()["transactions"]
        if t["reason"] == "coin_exchange"
    ]
    assert sorted(reasons) == [("coins", -780), ("diamonds", 500)]


def test_exchange_insufficient_coins_changes_nothing(client):
    register_and_login(client)
    response = _exchange(client, "x500")
    assert response.status_code == 400
    assert response.json()["detail"] == "insufficient"
    assert client.get("/api/me/wallet").json() == {
        "diamonds": WELCOME_DIAMONDS,
        "coins": WELCOME_COINS,
    }


def test_exchange_rejects_unknown_option_and_stale_rate(client):
    _, user = register_and_login(client)
    _grant_coins(user["id"], 1000)
    assert _exchange(client, "x999").status_code == 404
    stale = _exchange(client, "x100", diamonds=150, coins=100)
    assert stale.status_code == 409
    assert stale.json()["detail"] == "exchange_rate_changed"
    assert client.get("/api/me/wallet").json()["coins"] == WELCOME_COINS + 1000


def test_exchange_idempotency_key_applies_once(client):
    register_and_login(client)
    headers = {"Idempotency-Key": f"test-exchange-{uuid.uuid4().hex}"}
    first = _exchange(client, "x100", headers=headers).json()
    second = _exchange(client, "x100", headers=headers).json()
    assert first["wallet"] == second["wallet"] == {
        "diamonds": WELCOME_DIAMONDS + 100,
        "coins": WELCOME_COINS - 100,
    }


def test_exchange_requires_auth(client):
    assert _exchange(client, "x100").status_code == 401
