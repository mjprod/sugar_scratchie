from __future__ import annotations

from backend.mail.mailer import (
    ConsoleMailer,
    Mailer,
    OutboundMessage,
    RecordingMailer,
    ResendMailer,
    app_public_url,
    get_mailer,
    set_mailer_for_tests,
)
from backend.mail.messages import reset_password_content, verify_email_content

__all__ = [
    "ConsoleMailer",
    "Mailer",
    "OutboundMessage",
    "RecordingMailer",
    "ResendMailer",
    "app_public_url",
    "get_mailer",
    "send_reset_email",
    "send_verify_email",
    "set_mailer_for_tests",
]


def send_verify_email(*, to: str, token: str, mailer: Mailer | None = None) -> None:
    content = verify_email_content(app_url=app_public_url(), token=token)
    (mailer or get_mailer()).send(
        to=to,
        subject=content.subject,
        html=content.html,
        text=content.text,
    )


def send_reset_email(*, to: str, token: str, mailer: Mailer | None = None) -> None:
    content = reset_password_content(app_url=app_public_url(), token=token)
    (mailer or get_mailer()).send(
        to=to,
        subject=content.subject,
        html=content.html,
        text=content.text,
    )
