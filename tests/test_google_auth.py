from __future__ import annotations

import uuid

import pytest

from backend.auth import google as google_auth
from backend.auth.sessions import COOKIE_NAME
from tests.conftest import login, mark_email_verified, register_and_login


def _claims(email: str, sub: str, **overrides) -> dict:
    payload = {
        "sub": sub,
        "email": email,
        "email_verified": True,
        "name": "Google Tester",
        "picture": "https://lh3.googleusercontent.com/a/test",
    }
    payload.update(overrides)
    return payload


@pytest.fixture
def google_identity(monkeypatch):
    """Point exchange_code at a fake identity; returns a setter for the payload."""
    state: dict = {}

    def fake_exchange(code: str) -> google_auth.GoogleClaims:
        assert code == "good-code"
        return google_auth.claims_from_payload(state["payload"])

    monkeypatch.setattr(google_auth, "exchange_code", fake_exchange)

    def set_payload(payload: dict) -> None:
        state["payload"] = payload

    return set_payload


def _unique() -> tuple[str, str]:
    suffix = uuid.uuid4().hex[:10]
    return f"g-{suffix}@example.com", f"sub-{suffix}"


def test_google_login_creates_user_and_session(client, google_identity):
    email, sub = _unique()
    google_identity(_claims(email, sub))

    response = client.post("/api/auth/google", json={"code": "good-code"})
    assert response.status_code == 200, response.text
    user = response.json()["user"]
    assert user["email"] == email
    assert user["provider"] == "google"
    assert user["emailVerified"] is True
    assert user["displayName"] == "Google Tester"
    assert user["avatarUrl"] == "https://lh3.googleusercontent.com/a/test"

    session = client.get("/api/auth/session").json()
    assert session["authenticated"] is True
    assert session["user"]["id"] == user["id"]


def test_google_login_links_verified_email_account(client, google_identity):
    email, sub = _unique()
    _, registered = register_and_login(client, email=email)
    mark_email_verified(registered["id"])
    client.cookies.clear()
    google_identity(_claims(email.upper(), sub))

    response = client.post("/api/auth/google", json={"code": "good-code"})
    assert response.status_code == 200, response.text
    user = response.json()["user"]
    assert user["id"] == registered["id"]
    assert user["provider"] == "email"
    assert user["emailVerified"] is True

    client.cookies.clear()
    assert login(client, email)["id"] == registered["id"]


def test_google_login_takes_over_unverified_email_account(client, google_identity):
    email, sub = _unique()
    _, registered = register_and_login(client, email=email)
    squatter_cookie = client.cookies.get(COOKIE_NAME)
    client.cookies.clear()
    google_identity(_claims(email, sub))

    response = client.post("/api/auth/google", json={"code": "good-code"})
    assert response.status_code == 200, response.text
    assert response.json()["user"]["id"] == registered["id"]

    client.cookies.clear()
    password_login = client.post(
        "/api/auth/login", json={"email": email, "password": "testpassword123"}
    )
    assert password_login.status_code == 401
    client.cookies.set(COOKIE_NAME, squatter_cookie)
    assert client.get("/api/auth/session").json()["authenticated"] is False


def test_google_login_matches_apple_created_account_by_subject(client, google_identity, monkeypatch):
    from backend.auth import apple as apple_auth

    email, sub = _unique()
    monkeypatch.setattr(
        apple_auth,
        "verify_id_token",
        lambda token, nonce: apple_auth.AppleClaims(sub=f"apple-{sub}", email=email),
    )
    apple_user = client.post(
        "/api/auth/apple", json={"id_token": "t", "nonce": "n" * 16}
    ).json()["user"]

    client.cookies.clear()
    google_identity(_claims(email, sub))
    assert client.post("/api/auth/google", json={"code": "good-code"}).status_code == 200

    client.cookies.clear()
    google_identity(_claims(f"changed-{email}", sub))
    again = client.post("/api/auth/google", json={"code": "good-code"})
    assert again.status_code == 200, again.text
    assert again.json()["user"]["id"] == apple_user["id"]


def test_google_login_matches_by_subject(client, google_identity):
    email, sub = _unique()
    google_identity(_claims(email, sub))
    first = client.post("/api/auth/google", json={"code": "good-code"}).json()["user"]

    client.cookies.clear()
    google_identity(_claims(f"changed-{email}", sub))
    second = client.post("/api/auth/google", json={"code": "good-code"})
    assert second.status_code == 200, second.text
    assert second.json()["user"]["id"] == first["id"]


def test_google_login_rejects_email_owned_by_other_subject(client, google_identity):
    email, sub = _unique()
    google_identity(_claims(email, sub))
    first = client.post("/api/auth/google", json={"code": "good-code"}).json()["user"]

    client.cookies.clear()
    google_identity(_claims(f"changed-{email}", sub))
    assert client.post("/api/auth/google", json={"code": "good-code"}).status_code == 200

    client.cookies.clear()
    google_identity(_claims(email, f"other-{sub}"))
    response = client.post("/api/auth/google", json={"code": "good-code"})
    assert response.status_code == 409
    assert response.json()["detail"] == "google_subject_mismatch"
    assert client.get("/api/auth/session").json()["authenticated"] is False

    client.cookies.clear()
    google_identity(_claims(email, sub))
    again = client.post("/api/auth/google", json={"code": "good-code"})
    assert again.json()["user"]["id"] == first["id"]


def test_google_login_rejects_unverified_email(client, google_identity):
    email, sub = _unique()
    google_identity(_claims(email, sub, email_verified=False))

    response = client.post("/api/auth/google", json={"code": "good-code"})
    assert response.status_code == 401
    assert client.get("/api/auth/session").json()["authenticated"] is False


def test_google_login_unconfigured_returns_503(client, monkeypatch):
    monkeypatch.delenv("GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("GOOGLE_CLIENT_SECRET", raising=False)

    response = client.post("/api/auth/google", json={"code": "any-code"})
    assert response.status_code == 503
    assert response.json()["detail"] == "google_not_configured"


def test_exchange_code_verifies_id_token(monkeypatch):
    email, sub = _unique()
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "client-123")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "secret-456")
    sent: dict = {}

    class FakeResponse:
        status_code = 200

        @staticmethod
        def json() -> dict:
            return {"id_token": "raw-id-token"}

    def fake_post(url, data, timeout):
        sent.update(url=url, data=data)
        return FakeResponse()

    def fake_verify(token, transport, audience):
        assert token == "raw-id-token"
        assert audience == "client-123"
        return _claims(email, sub)

    monkeypatch.setattr(google_auth.httpx, "post", fake_post)
    monkeypatch.setattr(google_auth.google_id_token, "verify_oauth2_token", fake_verify)

    claims = google_auth.exchange_code("auth-code")
    assert claims.sub == sub
    assert claims.email == email
    assert sent["url"] == google_auth.TOKEN_URL
    assert sent["data"]["redirect_uri"] == "postmessage"
    assert sent["data"]["client_secret"] == "secret-456"


def test_exchange_code_rejects_invalid_id_token(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "client-123")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "secret-456")

    class FakeResponse:
        status_code = 200

        @staticmethod
        def json() -> dict:
            return {"id_token": "forged"}

    def bad_verify(token, transport, audience):
        raise ValueError("Wrong recipient")

    monkeypatch.setattr(google_auth.httpx, "post", lambda *a, **k: FakeResponse())
    monkeypatch.setattr(google_auth.google_id_token, "verify_oauth2_token", bad_verify)

    with pytest.raises(google_auth.GoogleAuthError):
        google_auth.exchange_code("auth-code")
