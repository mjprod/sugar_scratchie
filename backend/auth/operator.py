from __future__ import annotations

import os
import secrets
from typing import Mapping

from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send

HEADER = "x-dashboard-token"
COOKIE_NAME = os.environ.get("DASHBOARD_COOKIE_NAME", "sugar_dashboard")
COOKIE_MAX_AGE = 14 * 24 * 3600  # 14 days

# Player-owned prefixes: cookie session (or public GETs) — never this token.
_PLAYER_PREFIXES = (
    "/api/auth",
    "/api/me",
    "/api/store",
    "/api/packs",
    "/api/rewards",
    "/api/inbox",
    "/api/health",
)


def dashboard_token() -> str:
    raw = os.environ.get("DASHBOARD_TOKEN", "dev-dashboard").strip()
    return raw or "dev-dashboard"


def _cookie_secure() -> bool:
    raw = os.environ.get("SESSION_COOKIE_SECURE", "").strip()
    if raw:
        return raw not in ("0", "false", "False")
    return False


def _path(scope: Scope) -> str:
    return scope.get("path") or ""


def _decode_headers(scope: Scope) -> dict[str, str]:
    return {
        k.decode("latin-1").lower(): v.decode("latin-1")
        for k, v in (scope.get("headers") or [])
    }


def _cookie_value(headers: Mapping[str, str], name: str) -> str:
    raw = headers.get("cookie") or ""
    if not raw:
        return ""
    for part in raw.split(";"):
        piece = part.strip()
        if not piece:
            continue
        if "=" not in piece:
            continue
        key, value = piece.split("=", 1)
        if key.strip() == name:
            return value.strip()
    return ""


def provided_operator_secret(headers: Mapping[str, str]) -> str:
    header = (headers.get(HEADER) or "").strip()
    if header:
        return header
    return _cookie_value(headers, COOKIE_NAME)


def operator_secret_ok(provided: str) -> bool:
    expected = dashboard_token()
    if not provided or not expected:
        return False
    return secrets.compare_digest(provided, expected)


def set_operator_cookie(response: Response, token: str | None = None) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value=token or dashboard_token(),
        httponly=True,
        samesite="lax",
        secure=_cookie_secure(),
        path="/",
        max_age=COOKIE_MAX_AGE,
    )


def clear_operator_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/")


def needs_operator(scope: Scope) -> bool:
    if scope.get("type") != "http":
        return False
    method = (scope.get("method") or "GET").upper()
    if method == "OPTIONS":
        return False
    path = _path(scope)
    if not path.startswith("/api/"):
        return False
    if any(path == p or path.startswith(p + "/") for p in _PLAYER_PREFIXES):
        return False
    if path.startswith("/api/jobs"):
        return True
    # Player PII — require operator token for every method, including GET.
    if path == "/api/users" or path.startswith("/api/users/"):
        return True
    if method in ("GET", "HEAD"):
        return False
    return True


class OperatorAuthMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if needs_operator(scope):
            headers = _decode_headers(scope)
            if not operator_secret_ok(provided_operator_secret(headers)):
                response = JSONResponse({"detail": "operator-unauthorized"}, status_code=401)
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)
