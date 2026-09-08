from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Protocol

logger = logging.getLogger("sugar.mail")

DEFAULT_FROM = "Sugar Scratchie <onboarding@resend.dev>"
DEFAULT_APP_PUBLIC_URL = "https://localhost:5173"


class Mailer(Protocol):
    def send(self, *, to: str, subject: str, html: str, text: str) -> None: ...


@dataclass
class OutboundMessage:
    to: str
    subject: str
    html: str
    text: str


class ConsoleMailer:
    """Local/dev mailer: log the message instead of delivering."""

    def send(self, *, to: str, subject: str, html: str, text: str) -> None:
        import re

        redacted = re.sub(r"(token=)[^&\s]+", r"\1<redacted>", text)
        logger.info("[mail] to=%s subject=%s\n%s", to, subject, redacted)


class RecordingMailer:
    """In-memory mailer for tests."""

    def __init__(self) -> None:
        self.messages: list[OutboundMessage] = []

    def send(self, *, to: str, subject: str, html: str, text: str) -> None:
        self.messages.append(OutboundMessage(to=to, subject=subject, html=html, text=text))


class ResendMailer:
    def __init__(self, api_key: str, from_address: str) -> None:
        self.api_key = api_key
        self.from_address = from_address

    def send(self, *, to: str, subject: str, html: str, text: str) -> None:
        import httpx

        response = httpx.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json={
                "from": self.from_address,
                "to": [to],
                "subject": subject,
                "html": html,
                "text": text,
            },
            timeout=30.0,
        )
        if response.status_code >= 400:
            logger.error(
                "Resend send failed status=%s body=%s",
                response.status_code,
                response.text,
            )
            response.raise_for_status()


_mailer_override: Mailer | None = None


def email_from() -> str:
    return os.environ.get("EMAIL_FROM", "").strip() or DEFAULT_FROM


def app_public_url() -> str:
    return os.environ.get("APP_PUBLIC_URL", "").strip().rstrip("/") or DEFAULT_APP_PUBLIC_URL


def get_mailer() -> Mailer:
    if _mailer_override is not None:
        return _mailer_override
    api_key = os.environ.get("RESEND_API_KEY", "").strip()
    if api_key:
        return ResendMailer(api_key=api_key, from_address=email_from())
    return ConsoleMailer()


def set_mailer_for_tests(mailer: Mailer | None) -> None:
    global _mailer_override
    _mailer_override = mailer
