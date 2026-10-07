from __future__ import annotations

import time
import uuid
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from backend.auth import apple as apple_auth
from backend.auth.sessions import COOKIE_NAME
from tests.conftest import login, mark_email_verified, register_and_login

RAW_NONCE = "raw-nonce-0123456789abcdef"


def _claims(email: str | None, sub: str, **overrides) -> dict:
    payload = {
        "iss": apple_auth.ISSUER,
        "aud": "com.example.sugar.web",
        "sub": sub,
        "email": email,
        "email_verified": "true",
        "nonce": apple_auth.nonce_hash(RAW_NONCE),
    }
    payload.update(overrides)
    return payload


@pytest.fixture
def apple_identity(monkeypatch):
    """Point verify_id_token at a fake identity; returns a setter for the payload."""
    state: dict = {}

    def fake_verify(id_token: str, raw_nonce: str) -> apple_auth.AppleClaims:
        assert id_token == "good-token"
        return apple_auth.claims_from_payload(state["payload"], raw_nonce)

    monkeypatch.setattr(apple_auth, "verify_id_token", fake_verify)

    def set_payload(payload: dict) -> None:
        state["payload"] = payload

    return set_payload


def _unique() -> tuple[str, str]:
    suffix = uuid.uuid4().hex[:10]
    return f"a-{suffix}@example.com", f"apple-sub-{suffix}"


def _post(client, **overrides):
    body = {"id_token": "good-token", "nonce": RAW_NONCE}
    body.update(overrides)
    return client.post("/api/auth/apple", json=body)


def test_apple_login_creates_user_and_session(client, apple_identity):
    email, sub = _unique()
    apple_identity(_claims(email, sub))

    response = _post(client, name="Apple Tester")
    assert response.status_code == 200, response.text
    user = response.json()["user"]
    assert user["email"] == email
    assert user["provider"] == "apple"
    assert user["emailVerified"] is True
    assert user["displayName"] == "Apple Tester"

    session = client.get("/api/auth/session").json()
    assert session["authenticated"] is True
    assert session["user"]["id"] == user["id"]


def test_apple_login_takes_over_unverified_email_account(client, apple_identity):
    email, sub = _unique()
    _, registered = register_and_login(client, email=email)
    squatter_cookie = client.cookies.get(COOKIE_NAME)
    client.cookies.clear()
    apple_identity(_claims(email, sub))

    response = _post(client)
    assert response.status_code == 200, response.text
    assert response.json()["user"]["id"] == registered["id"]
    assert response.json()["user"]["emailVerified"] is True

    client.cookies.clear()
    password_login = client.post(
        "/api/auth/login", json={"email": email, "password": "testpassword123"}
    )
    assert password_login.status_code == 401
    client.cookies.set(COOKIE_NAME, squatter_cookie)
    assert client.get("/api/auth/session").json()["authenticated"] is False


def test_apple_login_concurrent_first_login_reuses_account(client, apple_identity, monkeypatch):
    from sqlalchemy.orm import Session

    from backend.db.engine import get_engine
    from backend.db.models import User
    from backend.routers import auth as auth_router

    email, sub = _unique()
    apple_identity(_claims(email, sub))
    original_create = auth_router._create_user

    def racing_create(db, **fields):
        with Session(get_engine()) as other:
            original_create(other, **fields)
            other.commit()
        return original_create(db, **fields)

    monkeypatch.setattr(auth_router, "_create_user", racing_create)

    response = _post(client)
    assert response.status_code == 200, response.text
    with Session(get_engine()) as db:
        assert db.query(User).filter(User.email == email).count() == 1
        assert str(db.query(User).filter(User.email == email).one().id) == response.json()["user"]["id"]


def test_apple_login_keys_unreachable_returns_503(client, monkeypatch):
    def unreachable(id_token, raw_nonce):
        raise apple_auth.AppleUnavailable("apple_keys_unreachable")

    monkeypatch.setattr(apple_auth, "verify_id_token", unreachable)
    response = _post(client)
    assert response.status_code == 503
    assert response.json()["detail"] == "apple_unavailable"


def test_apple_login_links_verified_email_account(client, apple_identity):
    email, sub = _unique()
    _, registered = register_and_login(client, email=email)
    mark_email_verified(registered["id"])
    client.cookies.clear()
    apple_identity(_claims(email.upper(), sub))

    response = _post(client)
    assert response.status_code == 200, response.text
    user = response.json()["user"]
    assert user["id"] == registered["id"]
    assert user["provider"] == "email"
    assert user["emailVerified"] is True

    client.cookies.clear()
    assert login(client, email)["id"] == registered["id"]


def test_apple_login_matches_by_subject_without_email(client, apple_identity):
    email, sub = _unique()
    apple_identity(_claims(email, sub))
    first = _post(client).json()["user"]

    client.cookies.clear()
    apple_identity(_claims(None, sub))
    second = _post(client)
    assert second.status_code == 200, second.text
    assert second.json()["user"]["id"] == first["id"]


def test_apple_login_links_google_account(client, apple_identity, monkeypatch):
    from backend.auth import google as google_auth

    email, sub = _unique()
    monkeypatch.setattr(
        google_auth,
        "exchange_code",
        lambda code: google_auth.GoogleClaims(sub=f"g-{sub}", email=email, name=None, picture=None),
    )
    google_user = client.post("/api/auth/google", json={"code": "c"}).json()["user"]

    client.cookies.clear()
    apple_identity(_claims(email, sub))
    response = _post(client)
    assert response.status_code == 200, response.text
    assert response.json()["user"]["id"] == google_user["id"]

    client.cookies.clear()
    again = client.post("/api/auth/google", json={"code": "c"})
    assert again.json()["user"]["id"] == google_user["id"]


def test_apple_login_rejects_email_owned_by_other_subject(client, apple_identity):
    email, sub = _unique()
    apple_identity(_claims(email, sub))
    first = _post(client).json()["user"]

    client.cookies.clear()
    apple_identity(_claims(email, f"other-{sub}"))
    response = _post(client)
    assert response.status_code == 409
    assert response.json()["detail"] == "apple_subject_mismatch"
    assert client.get("/api/auth/session").json()["authenticated"] is False

    client.cookies.clear()
    apple_identity(_claims(email, sub))
    assert _post(client).json()["user"]["id"] == first["id"]


def test_apple_login_new_subject_without_email_is_rejected(client, apple_identity):
    _, sub = _unique()
    apple_identity(_claims(None, sub))

    response = _post(client)
    assert response.status_code == 401
    assert response.json()["detail"] == "apple_email_missing"


def test_apple_login_rejects_nonce_mismatch(client, apple_identity):
    email, sub = _unique()
    apple_identity(_claims(email, sub))

    response = _post(client, nonce="a-different-raw-nonce-value")
    assert response.status_code == 401
    assert client.get("/api/auth/session").json()["authenticated"] is False


def test_apple_login_rejects_unverified_email(client, apple_identity):
    email, sub = _unique()
    apple_identity(_claims(email, sub, email_verified="false"))

    assert _post(client).status_code == 401


def test_apple_login_unconfigured_returns_503(client, monkeypatch):
    monkeypatch.delenv("APPLE_CLIENT_ID", raising=False)

    response = _post(client)
    assert response.status_code == 503
    assert response.json()["detail"] == "apple_not_configured"


@pytest.fixture
def signing_key(monkeypatch):
    """Sign tokens with a local RSA key and serve its public half as Apple's JWKS."""
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    monkeypatch.setenv("APPLE_CLIENT_ID", "com.example.sugar.web")
    monkeypatch.setattr(
        apple_auth._jwks_client,
        "get_signing_key_from_jwt",
        lambda token: SimpleNamespace(key=private_key.public_key()),
    )

    def sign(payload: dict) -> str:
        now = int(time.time())
        claims = {"iat": now, "exp": now + 600, **payload}
        return jwt.encode(claims, private_key, algorithm="RS256", headers={"kid": "test"})

    return sign


def test_verify_id_token_accepts_signed_token(signing_key):
    email, sub = _unique()
    claims = apple_auth.verify_id_token(signing_key(_claims(email, sub)), RAW_NONCE)
    assert claims.sub == sub
    assert claims.email == email


@pytest.mark.parametrize(
    "overrides",
    [
        {"aud": "com.someone.else"},
        {"iss": "https://evil.example.com"},
        {"exp": int(time.time()) - 3600},
    ],
)
def test_verify_id_token_rejects_bad_claims(signing_key, overrides):
    email, sub = _unique()
    with pytest.raises(apple_auth.AppleAuthError):
        apple_auth.verify_id_token(signing_key(_claims(email, sub, **overrides)), RAW_NONCE)


def test_verify_id_token_maps_key_fetch_failure_to_unavailable(signing_key, monkeypatch):
    def fail(token):
        raise jwt.PyJWKClientConnectionError("down")

    monkeypatch.setattr(apple_auth._jwks_client, "get_signing_key_from_jwt", fail)
    email, sub = _unique()
    with pytest.raises(apple_auth.AppleUnavailable):
        apple_auth.verify_id_token(signing_key(_claims(email, sub)), RAW_NONCE)


def test_verify_id_token_rejects_forged_signature(signing_key):
    email, sub = _unique()
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    forged = jwt.encode(
        {"iat": int(time.time()), "exp": int(time.time()) + 600, **_claims(email, sub)},
        other_key,
        algorithm="RS256",
    )
    with pytest.raises(apple_auth.AppleAuthError):
        apple_auth.verify_id_token(forged, RAW_NONCE)
