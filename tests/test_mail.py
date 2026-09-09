from __future__ import annotations

import re
import uuid
from urllib.parse import parse_qs, urlparse

import pytest

from backend.mail import (
    RecordingMailer,
    send_reset_email,
    send_verify_email,
    set_mailer_for_tests,
)
from backend.mail.mailer import ConsoleMailer, get_mailer
from backend.mail.messages import reset_password_content, verify_email_content
from tests.conftest import login, register_and_login


class FailingMailer:
    def send(self, *, to: str, subject: str, html: str, text: str) -> None:
        raise RuntimeError("resend unavailable")


@pytest.fixture
def recording_mailer():
    mailer = RecordingMailer()
    set_mailer_for_tests(mailer)
    try:
        yield mailer
    finally:
        set_mailer_for_tests(None)


@pytest.fixture
def failing_mailer():
    mailer = FailingMailer()
    set_mailer_for_tests(mailer)
    try:
        yield mailer
    finally:
        set_mailer_for_tests(None)


def _token_from_message(text: str) -> str:
    for line in text.splitlines():
        if "token=" in line and line.startswith("http"):
            parsed = urlparse(line.strip())
            values = parse_qs(parsed.query).get("token", [])
            assert values, f"missing token in link: {line}"
            return values[0]
    raise AssertionError(f"no link found in mail text:\n{text}")


def _code_from_message(text: str) -> str:
    match = re.search(r"verification code is:\s*(\d{6})", text, flags=re.IGNORECASE)
    assert match, f"no verification code found in mail text:\n{text}"
    return match.group(1)


def test_console_mailer_is_default_without_resend_key(monkeypatch):
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    set_mailer_for_tests(None)
    assert isinstance(get_mailer(), ConsoleMailer)


def test_verify_email_content_includes_code():
    content = verify_email_content(code="123456")
    assert content.subject == "Verify your Sugar Scratchie email"
    assert "123456" in content.text
    assert "123456" in content.html
    assert "15 minutes" in content.text


def test_reset_password_content_builds_link():
    content = reset_password_content(app_url="https://app.example", token="xyz789")
    assert content.subject == "Reset your Sugar Scratchie password"
    assert "https://app.example/reset-password?token=xyz789" in content.text


def test_send_verify_email_uses_mailer(recording_mailer, monkeypatch):
    monkeypatch.setenv("APP_PUBLIC_URL", "https://localhost:5173")
    send_verify_email(to="player@example.com", code="654321")
    assert len(recording_mailer.messages) == 1
    message = recording_mailer.messages[0]
    assert message.to == "player@example.com"
    assert "654321" in message.text
    assert "Verify your Sugar Scratchie email" == message.subject


def test_register_sends_verify_code(client, recording_mailer, monkeypatch):
    monkeypatch.setenv("APP_PUBLIC_URL", "https://localhost:5173")
    email, _user = register_and_login(client)
    assert len(recording_mailer.messages) == 1
    message = recording_mailer.messages[0]
    assert message.to == email
    assert "verify" in message.text.lower()
    code = _code_from_message(message.text)

    confirm = client.post("/api/auth/verify-email/confirm", json={"code": code})
    assert confirm.status_code == 200, confirm.text
    assert confirm.json()["user"]["emailVerified"] is True


def test_forgot_password_sends_reset_email(client, recording_mailer, monkeypatch):
    monkeypatch.setenv("APP_PUBLIC_URL", "https://localhost:5173")
    email, _user = register_and_login(client)
    recording_mailer.messages.clear()

    response = client.post("/api/auth/password/forgot", json={"email": email})
    assert response.status_code == 200, response.text
    assert len(recording_mailer.messages) == 1
    message = recording_mailer.messages[0]
    assert message.to == email
    assert "reset" in message.text.lower()
    token = _token_from_message(message.text)

    reset = client.post(
        "/api/auth/password/reset",
        json={"token": token, "password": "newpassword123"},
    )
    assert reset.status_code == 200, reset.text


def test_forgot_password_unknown_email_sends_nothing(client, recording_mailer):
    response = client.post(
        "/api/auth/password/forgot",
        json={"email": "nobody-exists@example.com"},
    )
    assert response.status_code == 200
    assert recording_mailer.messages == []


def test_verify_email_request_sends_mail(client, recording_mailer, monkeypatch):
    monkeypatch.setenv("APP_PUBLIC_URL", "https://localhost:5173")
    email, _user = register_and_login(client)
    recording_mailer.messages.clear()

    response = client.post("/api/auth/verify-email/request", json={})
    assert response.status_code == 200, response.text
    assert len(recording_mailer.messages) == 1
    assert recording_mailer.messages[0].to == email
    assert _code_from_message(recording_mailer.messages[0].text)


def test_verify_email_send_alias_sends_mail(client, recording_mailer, monkeypatch):
    monkeypatch.setenv("APP_PUBLIC_URL", "https://localhost:5173")
    email, _user = register_and_login(client)
    recording_mailer.messages.clear()

    response = client.post("/api/auth/verify-email/send")
    assert response.status_code == 200, response.text
    assert len(recording_mailer.messages) == 1
    assert recording_mailer.messages[0].to == email
    code = _code_from_message(recording_mailer.messages[0].text)

    confirm = client.post("/api/auth/verify-email/confirm", json={"code": code})
    assert confirm.status_code == 200, confirm.text
    assert confirm.json()["user"]["emailVerified"] is True


def test_verify_email_confirm_rejects_bad_code(client, recording_mailer):
    register_and_login(client)
    response = client.post("/api/auth/verify-email/confirm", json={"code": "000000"})
    assert response.status_code == 400


def test_verify_email_confirm_accepts_legacy_token(client, recording_mailer, monkeypatch):
    from datetime import timedelta

    from sqlalchemy.orm import Session

    from backend.auth.sessions import hash_token
    from backend.db.engine import get_engine
    from backend.db.models import EmailToken, User, utcnow

    monkeypatch.setenv("APP_PUBLIC_URL", "https://localhost:5173")
    email, _user = register_and_login(client)
    legacy_token = "tok-legacy_-123"

    with Session(bind=get_engine()) as db:
        user = db.query(User).filter(User.email == email).one()
        db.add(
            EmailToken(
                user_id=user.id,
                kind="verify_email",
                token_hash=hash_token(legacy_token),
                expires_at=utcnow() + timedelta(hours=1),
            )
        )
        db.commit()

    confirm = client.post("/api/auth/verify-email/confirm", json={"token": legacy_token})
    assert confirm.status_code == 200, confirm.text
    assert confirm.json()["user"]["emailVerified"] is True


def test_send_helpers_swallow_delivery_errors(failing_mailer, monkeypatch):
    monkeypatch.setenv("APP_PUBLIC_URL", "https://localhost:5173")
    send_verify_email(to="player@example.com", code="111111")
    send_reset_email(to="player@example.com", token="tok-reset")


def test_register_succeeds_when_mail_delivery_fails(client, failing_mailer):
    suffix = uuid.uuid4().hex[:10]
    email = f"mail-down-{suffix}@example.com"
    response = client.post(
        "/api/auth/register",
        json={"email": email, "password": "testpassword123", "username": f"maildown-{suffix}"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    assert response.json()["user"]["email"] == email

    # Account persisted despite delivery failure.
    logged_in = login(client, email)
    assert logged_in["email"] == email


def test_forgot_password_returns_ok_when_mail_delivery_fails(client):
    # Register with a working mailer first, then switch to failing for forgot.
    set_mailer_for_tests(RecordingMailer())
    try:
        email, _user = register_and_login(client)
        set_mailer_for_tests(FailingMailer())

        known = client.post("/api/auth/password/forgot", json={"email": email})
        unknown = client.post(
            "/api/auth/password/forgot",
            json={"email": "nobody-exists@example.com"},
        )
        assert known.status_code == 200, known.text
        assert unknown.status_code == 200, unknown.text
        assert known.json() == unknown.json() == {"ok": True}
    finally:
        set_mailer_for_tests(None)


def test_verify_email_request_succeeds_when_mail_delivery_fails(client):
    set_mailer_for_tests(RecordingMailer())
    try:
        register_and_login(client)
        set_mailer_for_tests(FailingMailer())

        response = client.post("/api/auth/verify-email/request", json={})
        assert response.status_code == 200, response.text
        assert response.json() == {"ok": True}
    finally:
        set_mailer_for_tests(None)
