from __future__ import annotations


def test_health_ok(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["db"]["ok"] is True


def test_health_live(client):
    response = client.get("/api/health/live")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["live"] is True


def test_health_ready(client):
    response = client.get("/api/health/ready")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["db"]["ok"] is True


def test_get_cards_public(client):
    response = client.get("/api/cards")
    assert response.status_code == 200
    assert "cards" in response.json()


def test_post_cards_requires_token(client):
    response = client.post(
        "/api/cards",
        json={
            "id": "test-card",
            "label": "Test",
            "background": "public/test.mp4",
            "foreground": "public/test.mp4",
        },
    )
    assert response.status_code == 401


def test_register_returns_user(client):
    from tests.conftest import register_and_login

    _, user = register_and_login(client)
    assert user["email"]
    assert user["welcomeClaimed"] is False


def test_store_products_seeded(client):
    response = client.get("/api/store/products")
    assert response.status_code == 200
    products = response.json()["products"]
    assert len(products) >= 1
    ids = {product["id"] for product in products}
    assert "d100" in ids


def test_jobs_require_token(client):
    response = client.post(
        "/api/jobs/generate-mesh",
        json={
            "input_video": "public/mesh/tracked-mesh.json",
            "output_json": ".tmp/test-mesh.json",
        },
    )
    assert response.status_code == 401
