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


def verify_email_content(*, code: str) -> EmailContent:
    subject = "Verify your Sugar Scratchie email"
    text = (
        "Welcome to Sugar Scratchie.\n\n"
        f"Your verification code is: {code}\n\n"
        "Enter this code in the app to verify your email. "
        "It expires in 15 minutes.\n\n"
        "If you did not create an account, you can ignore this message."
    )
    html = (
        "<p>Welcome to Sugar Scratchie.</p>"
        f"<p>Your verification code is:</p>"
        f'<p style="font-size:28px;font-weight:700;letter-spacing:0.12em">{code}</p>'
        "<p>Enter this code in the app to verify your email. "
        "It expires in 15 minutes.</p>"
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
