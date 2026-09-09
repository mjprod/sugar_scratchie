from __future__ import annotations

import pytest

from backend.auth.operator import needs_operator, provided_operator_secret


def _scope(method: str, path: str) -> dict:
    return {"type": "http", "method": method, "path": path}


@pytest.mark.parametrize(
    ("method", "path", "expected"),
    [
        ("GET", "/api/health", False),
        ("GET", "/api/health/live", False),
        ("GET", "/api/health/ready", False),
        ("GET", "/api/cards", False),
        ("GET", "/api/auth/session", False),
        ("GET", "/api/auth/operator/session", False),
        ("POST", "/api/auth/operator/login", False),
        ("POST", "/api/auth/register", False),
        ("GET", "/api/store/products", False),
        ("GET", "/api/packs", False),
        ("POST", "/api/cards", True),
        ("PUT", "/api/cards/foo", True),
        ("DELETE", "/api/cards/foo", True),
        ("GET", "/api/jobs", True),
        ("POST", "/api/jobs/generate-mesh", True),
        ("GET", "/api/users", True),
        ("GET", "/api/users/abc", True),
        ("PATCH", "/api/users/abc", True),
        ("OPTIONS", "/api/cards", False),
    ],
)
def test_needs_operator(method: str, path: str, expected: bool):
    assert needs_operator(_scope(method, path)) is expected


def test_provided_operator_secret_prefers_header():
    headers = {
        "x-dashboard-token": "from-header",
        "cookie": "sugar_dashboard=from-cookie",
    }
    assert provided_operator_secret(headers) == "from-header"
    assert provided_operator_secret({"cookie": "a=1; sugar_dashboard=from-cookie"}) == "from-cookie"


def test_operator_login_sets_cookie(client, dashboard_headers):
    token = dashboard_headers["X-Dashboard-Token"]
    bad = client.post("/api/auth/operator/login", json={"token": "wrong-token"})
    assert bad.status_code == 401

    response = client.post("/api/auth/operator/login", json={"token": token})
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert "sugar_dashboard" in response.cookies

    session = client.get("/api/auth/operator/session")
    assert session.status_code == 200

    users = client.get("/api/users")
    assert users.status_code == 200

    logout = client.post("/api/auth/operator/logout")
    assert logout.status_code == 200
    denied = client.get("/api/users")
    assert denied.status_code == 401


def test_operator_header_still_works(client, dashboard_headers):
    response = client.get("/api/users", headers=dashboard_headers)
    assert response.status_code == 200
