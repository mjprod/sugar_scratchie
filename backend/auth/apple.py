from __future__ import annotations

import hashlib
import hmac
import os
from dataclasses import dataclass

import jwt

ISSUER = "https://appleid.apple.com"
KEYS_URL = "https://appleid.apple.com/auth/keys"
ALGORITHMS = ["RS256"]
KEYS_FETCH_TIMEOUT_S = 10
CLOCK_SKEW_S = 60

_jwks_client = jwt.PyJWKClient(KEYS_URL, cache_keys=True, timeout=KEYS_FETCH_TIMEOUT_S)


class AppleNotConfigured(RuntimeError):
    pass


class AppleAuthError(RuntimeError):
    pass


class AppleUnavailable(RuntimeError):
    """Apple's signing keys could not be fetched (network/outage), not a bad token."""


@dataclass(frozen=True)
class AppleClaims:
    sub: str
    email: str | None


def client_id() -> str:
    """Services ID (web) the ID token must be issued to."""
    return os.environ.get("APPLE_CLIENT_ID", "").strip()


def is_configured() -> bool:
    return bool(client_id())


def nonce_hash(raw_nonce: str) -> str:
    return hashlib.sha256(raw_nonce.encode("utf-8")).hexdigest()


def verify_id_token(id_token: str, raw_nonce: str) -> AppleClaims:
    """Verify a Sign in with Apple JS ID token.

    The browser sends Apple sha256(raw_nonce) and sends us the raw value, so a
    leaked ID token alone cannot be replayed against this endpoint.
    """
    if not is_configured():
        raise AppleNotConfigured("apple_not_configured")
    if not id_token.strip() or not raw_nonce.strip():
        raise AppleAuthError("missing_token")

    try:
        signing_key = _jwks_client.get_signing_key_from_jwt(id_token)
    except jwt.PyJWKClientConnectionError as exc:
        raise AppleUnavailable("apple_keys_unreachable") from exc
    except jwt.PyJWKClientError as exc:
        raise AppleAuthError("signing_key_unavailable") from exc
    except jwt.PyJWTError as exc:
        raise AppleAuthError("invalid_id_token") from exc

    try:
        payload = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=ALGORITHMS,
            audience=client_id(),
            issuer=ISSUER,
            leeway=CLOCK_SKEW_S,
            options={"require": ["sub", "iss", "aud", "exp", "iat"]},
        )
    except jwt.PyJWTError as exc:
        raise AppleAuthError("invalid_id_token") from exc

    return claims_from_payload(payload, raw_nonce)


def _is_true(value: object) -> bool:
    # Apple sends booleans as either JSON true or the string "true".
    return value is True or value == "true"


def claims_from_payload(payload: dict, raw_nonce: str) -> AppleClaims:
    token_nonce = str(payload.get("nonce") or "")
    if not token_nonce or not hmac.compare_digest(token_nonce, nonce_hash(raw_nonce)):
        raise AppleAuthError("nonce_mismatch")

    sub = str(payload.get("sub") or "").strip()
    if not sub:
        raise AppleAuthError("incomplete_claims")

    email = str(payload.get("email") or "").strip() or None
    if email and not _is_true(payload.get("email_verified")):
        raise AppleAuthError("email_not_verified")
    return AppleClaims(sub=sub, email=email)
