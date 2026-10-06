from __future__ import annotations

import os
from dataclasses import dataclass

import httpx
import requests
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import id_token as google_id_token

TOKEN_URL = "https://oauth2.googleapis.com/token"
# GIS popup code flow: the code is bound to this pseudo redirect URI.
POPUP_REDIRECT_URI = "postmessage"
TOKEN_EXCHANGE_TIMEOUT_S = 10.0

_cert_transport = GoogleRequest(session=requests.Session())


class GoogleNotConfigured(RuntimeError):
    pass


class GoogleAuthError(RuntimeError):
    pass


@dataclass(frozen=True)
class GoogleClaims:
    sub: str
    email: str
    name: str | None
    picture: str | None


def client_id() -> str:
    return os.environ.get("GOOGLE_CLIENT_ID", "").strip()


def client_secret() -> str:
    return os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()


def is_configured() -> bool:
    return bool(client_id() and client_secret())


def exchange_code(code: str) -> GoogleClaims:
    """Trade a GIS popup auth code for a verified Google identity."""
    if not is_configured():
        raise GoogleNotConfigured("google_not_configured")
    if not code.strip():
        raise GoogleAuthError("missing_code")

    try:
        response = httpx.post(
            TOKEN_URL,
            data={
                "code": code,
                "client_id": client_id(),
                "client_secret": client_secret(),
                "redirect_uri": POPUP_REDIRECT_URI,
                "grant_type": "authorization_code",
            },
            timeout=TOKEN_EXCHANGE_TIMEOUT_S,
        )
    except httpx.HTTPError as exc:
        raise GoogleAuthError("token_exchange_failed") from exc
    if response.status_code != 200:
        raise GoogleAuthError("token_exchange_failed")

    try:
        data = response.json()
    except ValueError as exc:
        raise GoogleAuthError("token_exchange_failed") from exc

    raw_token = data.get("id_token")
    if not raw_token:
        raise GoogleAuthError("missing_id_token")

    try:
        claims = google_id_token.verify_oauth2_token(raw_token, _cert_transport, client_id())
    except ValueError as exc:
        raise GoogleAuthError("invalid_id_token") from exc

    return claims_from_payload(claims)


def claims_from_payload(payload: dict) -> GoogleClaims:
    sub = str(payload.get("sub") or "").strip()
    email = str(payload.get("email") or "").strip()
    if not sub or not email:
        raise GoogleAuthError("incomplete_claims")
    if payload.get("email_verified") is not True:
        raise GoogleAuthError("email_not_verified")
    return GoogleClaims(
        sub=sub,
        email=email,
        name=payload.get("name") or None,
        picture=payload.get("picture") or None,
    )
