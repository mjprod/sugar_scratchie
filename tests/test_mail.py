from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest

from backend.mail import (
    RecordingMailer,
    send_verify_email,
    set_mailer_for_tests,
)
from backend.mail.mailer import ConsoleMailer, get_mailer
from backend.mail.messages import reset_password_content, verify_email_content
from tests.conftest import register_and_login


@pytest.fixture
def recording_mailer():
    mailer = RecordingMailer()
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


def test_console_mailer_is_default_without_resend_key(monkeypatch):
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    set_mailer_for_tests(None)
    assert isinstance(get_mailer(), ConsoleMailer)


def test_verify_email_content_builds_link():
    content = verify_email_content(app_url="https://app.example", token="abc123")
    assert content.subject == "Verify your Sugar Scratchie email"
    assert "https://app.example/verify-email?token=abc123" in content.text
    assert 'href="https://app.example/verify-email?token=abc123"' in content.html


def test_reset_password_content_builds_link():
    content = reset_password_content(app_url="https://app.example", token="xyz789")
    assert content.subject == "Reset your Sugar Scratchie password"
    assert "https://app.example/reset-password?token=xyz789" in content.text


def test_send_verify_email_uses_mailer(recording_mailer, monkeypatch):
    monkeypatch.setenv("APP_PUBLIC_URL", "https://localhost:5173")
    send_verify_email(to="player@example.com", token="tok-verify")
    assert len(recording_mailer.messages) == 1
    message = recording_mailer.messages[0]
    assert message.to == "player@example.com"
    assert "tok-verify" in message.text
    assert "Verify your Sugar Scratchie email" == message.subject


def test_register_sends_verify_email(client, recording_mailer, monkeypatch):
    monkeypatch.setenv("APP_PUBLIC_URL", "https://localhost:5173")
    email, _user = register_and_login(client)
    assert len(recording_mailer.messages) == 1
    message = recording_mailer.messages[0]
    assert message.to == email
    assert "verify" in message.text.lower()
    token = _token_from_message(message.text)

    confirm = client.post("/api/auth/verify-email/confirm", json={"token": token})
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
