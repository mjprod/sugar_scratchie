from __future__ import annotations

import logging

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

logger = logging.getLogger("sugar.mail")

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


def send_verify_email(*, to: str, code: str, mailer: Mailer | None = None) -> None:
    content = verify_email_content(code=code)
    try:
        (mailer or get_mailer()).send(
            to=to,
            subject=content.subject,
            html=content.html,
            text=content.text,
        )
    except Exception:
        # Auth must still succeed when delivery is down (no 500 / DB rollback).
        logger.exception("Failed to send verify email to %s", to)


def send_reset_email(*, to: str, token: str, mailer: Mailer | None = None) -> None:
    content = reset_password_content(app_url=app_public_url(), token=token)
    try:
        (mailer or get_mailer()).send(
            to=to,
            subject=content.subject,
            html=content.html,
            text=content.text,
        )
    except Exception:
        # Always return success from forgot-password; never leak account existence.
        logger.exception("Failed to send reset email to %s", to)
