"""Manager invite lookup, accept, and diamond-sale reporting."""

from __future__ import annotations

import uuid
from typing import Any

import pytest


class _Response:
    def __init__(self, status_code: int, payload: dict[str, Any] | None = None) -> None:
        self.status_code = status_code
        self._payload = payload or {}

    def json(self) -> dict[str, Any]:
        return self._payload


class _Client:
    posts: list[dict[str, Any]] = []
    gets: list[str] = []
    get_response = _Response(200, {"referral": {"campaign": {"name": "Sugar"}}})
    post_response = _Response(201, {"user": {"id": "promoter-user"}})

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        del args, kwargs

    def __enter__(self) -> "_Client":
        return self

    def __exit__(self, *args: Any) -> bool:
        del args
        return False

    def get(self, url: str) -> _Response:
        _Client.gets.append(url)
        return _Client.get_response

    def post(self, url: str, json: dict | None = None, headers: dict | None = None) -> _Response:
        _Client.posts.append({"url": url, "json": json, "headers": headers})
        return _Client.post_response


@pytest.fixture
def promoter_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("MJPROMOTER_API_URL", "http://promoter.test/api")
    monkeypatch.setenv("MJPROMOTER_BEARER_TOKEN", "fp_token_test")
    monkeypatch.setenv("MJPROMOTER_ACCOUNT_ID", "acc_test")
    _Client.posts = []
    _Client.gets = []
    _Client.get_response = _Response(200, {"referral": {"campaign": {"name": "Sugar"}}})
    _Client.post_response = _Response(201, {"user": {"id": "promoter-user"}})
    monkeypatch.setattr("backend.services.promoter.httpx.Client", _Client)


def test_invite_lookup_valid(client, promoter_env):
    del promoter_env
    response = client.get("/api/promoter/invites/Ab12_cd34E")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    assert body["inviteCode"] == "Ab12_cd34E"
    assert body["campaignName"] == "Sugar"
    assert _Client.gets == ["http://promoter.test/api/referrals/invite/Ab12_cd34E"]


def test_invite_lookup_missing(client, promoter_env):
    del promoter_env
    _Client.get_response = _Response(404, {"error": "Invalid invite code"})
    response = client.get("/api/promoter/invites/missingcode")
    assert response.status_code == 404
    assert "not valid" in response.json()["detail"]


def test_invite_lookup_used(client, promoter_env):
    del promoter_env
    _Client.get_response = _Response(400, {"error": "This invite code has already been used"})
    response = client.get("/api/promoter/invites/usedcode01")
    assert response.status_code == 409
    assert "already been used" in response.json()["detail"]


def test_invite_lookup_without_credentials_does_not_call(client, monkeypatch):
    monkeypatch.delenv("MJPROMOTER_API_URL", raising=False)
    monkeypatch.delenv("MJPROMOTER_BEARER_TOKEN", raising=False)
    monkeypatch.delenv("MJPROMOTER_ACCOUNT_ID", raising=False)

    def fail_client(*args, **kwargs):
        del args, kwargs
        raise AssertionError("httpx.Client should not be constructed")

    monkeypatch.setattr("backend.services.promoter.httpx.Client", fail_client)
    response = client.get("/api/promoter/invites/Ab12_cd34E")
    assert response.status_code == 503


def test_register_accepts_invite(client, promoter_env):
    del promoter_env
    email = f"join-{uuid.uuid4().hex[:8]}@example.com"
    response = client.post(
        "/api/auth/register",
        json={
            "email": email,
            "password": "testpassword123",
            "display_name": "Juliana Val",
            "promoter_ref": "Ab12_cd34E",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["user"]["promoterRef"] == "Ab12_cd34E"
    assert len(_Client.posts) == 1
    sent = _Client.posts[0]
    assert sent["url"] == "http://promoter.test/api/auth/register"
    assert sent["json"]["inviteCode"] == "Ab12_cd34E"
    assert sent["json"]["email"] == email
    assert sent["json"]["firstName"] == "Juliana"
    assert sent["json"]["lastName"] == "Val"


def test_register_rejects_used_invite(client, promoter_env):
    del promoter_env
    _Client.post_response = _Response(400, {"error": "Invite code already used"})
    email = f"used-{uuid.uuid4().hex[:8]}@example.com"
    response = client.post(
        "/api/auth/register",
        json={
            "email": email,
            "password": "testpassword123",
            "promoter_ref": "usedcode01",
        },
    )
    assert response.status_code == 400
    login = client.post(
        "/api/auth/login",
        json={"email": email, "password": "testpassword123"},
    )
    assert login.status_code == 401


def test_confirmed_purchase_reports_sale_once(client, promoter_env):
    del promoter_env
    email = f"sale-{uuid.uuid4().hex[:8]}@example.com"
    registered = client.post(
        "/api/auth/register",
        json={
            "email": email,
            "password": "testpassword123",
            "promoter_ref": "Ab12_cd34E",
        },
    )
    assert registered.status_code == 200, registered.text
    _Client.posts.clear()

    products = client.get("/api/store/products").json()["products"]
    product = next(item for item in products if item["id"] == "d100")
    purchase = client.post("/api/store/purchases", json={"product_id": product["id"]})
    assert purchase.status_code == 200, purchase.text
    session_id = purchase.json()["session"]["id"]

    verified = client.post(
        f"/api/store/purchases/{session_id}/verify",
        json={"outcome": "completed"},
    )
    assert verified.status_code == 200, verified.text
    assert verified.json()["status"] == "confirmed"
    assert verified.json()["wallet"]["diamonds"] >= product["diamonds"]
    sale_posts = [post for post in _Client.posts if post["url"].endswith("/v2/track/sale")]
    assert len(sale_posts) == 1
    body = sale_posts[0]["json"]
    assert body["event_id"] == f"scratchie:{session_id}"
    assert body["amount"] == 399
    assert body["ref_id"] == "Ab12_cd34E"
    assert body["email"] == email
    assert sale_posts[0]["headers"]["Authorization"] == "Bearer fp_token_test"
    assert sale_posts[0]["headers"]["Account-ID"] == "acc_test"

    again = client.post(
        f"/api/store/purchases/{session_id}/verify",
        json={"outcome": "completed"},
    )
    assert again.status_code == 200
    sale_posts = [post for post in _Client.posts if post["url"].endswith("/v2/track/sale")]
    assert len(sale_posts) == 1


def test_purchase_without_credentials_does_not_call(client, monkeypatch):
    monkeypatch.delenv("MJPROMOTER_API_URL", raising=False)
    monkeypatch.delenv("MJPROMOTER_BEARER_TOKEN", raising=False)
    monkeypatch.delenv("MJPROMOTER_ACCOUNT_ID", raising=False)

    def fail_client(*args, **kwargs):
        del args, kwargs
        raise AssertionError("httpx.Client should not be constructed")

    monkeypatch.setattr("backend.services.promoter.httpx.Client", fail_client)
    email = f"offline-{uuid.uuid4().hex[:8]}@example.com"
    registered = client.post(
        "/api/auth/register",
        json={
            "email": email,
            "password": "testpassword123",
            "promoter_ref": "Ab12_cd34E",
        },
    )
    assert registered.status_code == 200, registered.text
    assert registered.json()["user"]["promoterRef"] == "Ab12_cd34E"
    products = client.get("/api/store/products").json()["products"]
    product = next(item for item in products if item["id"] == "d100")
    purchase = client.post("/api/store/purchases", json={"product_id": product["id"]})
    session_id = purchase.json()["session"]["id"]
    verified = client.post(
        f"/api/store/purchases/{session_id}/verify",
        json={"outcome": "completed"},
    )
    assert verified.status_code == 200
    assert verified.json()["status"] == "confirmed"


def test_promoter_sale_error_still_credits_diamonds(client, promoter_env):
    del promoter_env
    email = f"down-{uuid.uuid4().hex[:8]}@example.com"
    registered = client.post(
        "/api/auth/register",
        json={
            "email": email,
            "password": "testpassword123",
            "promoter_ref": "Ab12_cd34E",
        },
    )
    assert registered.status_code == 200, registered.text
    _Client.post_response = _Response(500, {"error": "down"})

    products = client.get("/api/store/products").json()["products"]
    product = next(item for item in products if item["id"] == "d100")
    purchase = client.post("/api/store/purchases", json={"product_id": product["id"]})
    session_id = purchase.json()["session"]["id"]
    verified = client.post(
        f"/api/store/purchases/{session_id}/verify",
        json={"outcome": "completed"},
    )
    assert verified.status_code == 200, verified.text
    assert verified.json()["wallet"]["diamonds"] >= product["diamonds"]
