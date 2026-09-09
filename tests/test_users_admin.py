from __future__ import annotations

import uuid

from tests.conftest import register_and_login


def test_adjust_wallet_requires_idempotency_key(client, dashboard_headers):
    _, user = register_and_login(client)

    response = client.post(
        f"/api/users/{user['id']}/wallet/adjust",
        json={"currency": "coins", "delta": 5},
        headers=dashboard_headers,
    )

    assert response.status_code == 422


def test_adjust_wallet_reuses_explicit_idempotency_key(client, dashboard_headers):
    _, user = register_and_login(client)
    payload = {
        "currency": "coins",
        "delta": 5,
        "idempotency_key": f"admin-adjust:{uuid.uuid4().hex}",
    }

    first = client.post(
        f"/api/users/{user['id']}/wallet/adjust",
        json=payload,
        headers=dashboard_headers,
    )
    second = client.post(
        f"/api/users/{user['id']}/wallet/adjust",
        json=payload,
        headers=dashboard_headers,
    )

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["idempotencyKey"] == payload["idempotency_key"]
    assert second.json()["idempotencyKey"] == payload["idempotency_key"]
    assert second.json()["wallet"] == first.json()["wallet"]
