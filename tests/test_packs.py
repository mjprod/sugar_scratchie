from __future__ import annotations

import uuid

from tests.conftest import login, register_and_login


def test_auth_session_flow(client):
    email, user = register_and_login(client)
    session = client.get("/api/auth/session")
    assert session.status_code == 200
    body = session.json()
    assert body["authenticated"] is True
    assert body["user"]["email"] == email

    client.post("/api/auth/logout")
    session = client.get("/api/auth/session")
    assert session.json()["authenticated"] is False

    login(client, email)
    session = client.get("/api/auth/session")
    assert session.json()["authenticated"] is True
    assert session.json()["user"]["id"] == user["id"]


def test_welcome_claim_idempotent(client):
    register_and_login(client)
    first = client.post("/api/me/welcome/claim")
    assert first.status_code == 200
    first_body = first.json()
    assert first_body["ok"] is True
    assert first_body["welcomeClaimed"] is True
    assert first_body["instance"] is not None

    second = client.post("/api/me/welcome/claim")
    assert second.status_code == 200
    second_body = second.json()
    assert second_body["welcomeClaimed"] is True
    assert second_body["instance"]["instanceId"] == first_body["instance"]["instanceId"]


def test_store_purchase_and_pack_open_reveal(client):
    register_and_login(client)

    products = client.get("/api/store/products").json()["products"]
    product = next(item for item in products if item["id"] == "d100")

    purchase = client.post("/api/store/purchases", json={"product_id": product["id"]})
    assert purchase.status_code == 200
    session_id = purchase.json()["session"]["id"]

    verified = client.post(
        f"/api/store/purchases/{session_id}/verify",
        json={"outcome": "completed"},
    )
    assert verified.status_code == 200
    assert verified.json()["status"] == "confirmed"
    wallet = verified.json()["wallet"]
    assert wallet["diamonds"] >= product["diamonds"]

    packs = client.get("/api/packs").json()["packs"]
    pack = next(item for item in packs if item["id"] == "ep1")

    bought = client.post(
        f"/api/packs/{pack['id']}/purchase",
        json={"quantity": 1},
        headers={"Idempotency-Key": f"test-pack-buy-{uuid.uuid4().hex}"},
    )
    assert bought.status_code == 200
    instance_id = bought.json()["instances"][0]["instanceId"]

    opened = client.post(f"/api/me/packs/{instance_id}/open")
    assert opened.status_code == 200
    opening_id = opened.json()["openingId"]
    card_id = opened.json()["session"]["cards"][0]["id"]

    revealed = client.post(f"/api/me/openings/{opening_id}/cards/{card_id}/reveal")
    assert revealed.status_code == 200
    assert revealed.json()["card"]["revealStatus"] == "revealed"
    assert card_id in revealed.json()["scratched"]
