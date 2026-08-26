from __future__ import annotations

import os

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

HEADER = "x-dashboard-token"

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


def _path(scope: Scope) -> str:
    return scope.get("path") or ""


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
    if method in ("GET", "HEAD"):
        return False
    return True


class OperatorAuthMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if needs_operator(scope):
            headers = {
                k.decode("latin-1").lower(): v.decode("latin-1")
                for k, v in (scope.get("headers") or [])
            }
            provided = headers.get(HEADER, "")
            if provided != dashboard_token():
                response = JSONResponse({"detail": "operator-unauthorized"}, status_code=401)
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)
