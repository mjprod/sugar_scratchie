from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlencode


@dataclass(frozen=True)
class EmailContent:
    subject: str
    html: str
    text: str


def _link(base_url: str, path: str, token: str) -> str:
    query = urlencode({"token": token})
    return f"{base_url.rstrip('/')}{path}?{query}"


def verify_email_content(*, app_url: str, token: str) -> EmailContent:
    link = _link(app_url, "/verify-email", token)
    subject = "Verify your Sugar Scratchie email"
    text = (
        "Welcome to Sugar Scratchie.\n\n"
        f"Verify your email by opening this link:\n{link}\n\n"
        "If you did not create an account, you can ignore this message."
    )
    html = (
        "<p>Welcome to Sugar Scratchie.</p>"
        f'<p><a href="{link}">Verify your email</a></p>'
        "<p>If you did not create an account, you can ignore this message.</p>"
    )
    return EmailContent(subject=subject, html=html, text=text)


def reset_password_content(*, app_url: str, token: str) -> EmailContent:
    link = _link(app_url, "/reset-password", token)
    subject = "Reset your Sugar Scratchie password"
    text = (
        "We received a request to reset your Sugar Scratchie password.\n\n"
        f"Reset it by opening this link:\n{link}\n\n"
        "If you did not request a reset, you can ignore this message."
    )
    html = (
        "<p>We received a request to reset your Sugar Scratchie password.</p>"
        f'<p><a href="{link}">Reset your password</a></p>'
        "<p>If you did not request a reset, you can ignore this message.</p>"
    )
    return EmailContent(subject=subject, html=html, text=text)
