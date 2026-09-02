from __future__ import annotations

import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import Cookie, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from backend.db.engine import get_session
from backend.db.models import Session as AuthSession
from backend.db.models import User, utcnow

COOKIE_NAME = os.environ.get("SESSION_COOKIE_NAME", "sugar_session")
SESSION_DAYS = 30
PASSWORD_MIN_LENGTH = 8


def _cookie_secure() -> bool:
    raw = os.environ.get("SESSION_COOKIE_SECURE", "").strip()
    if raw:
        return raw not in ("0", "false", "False")
    return False


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _client_ip(request: Request) -> str | None:
    if request.client is None:
        return None
    host = request.client.host
    if not host:
        return None
    try:
        import ipaddress

        ipaddress.ip_address(host)
    except ValueError:
        return None
    return host


def issue_session(db: Session, user: User, request: Request) -> str:
    token = secrets.token_urlsafe(32)
    ip = _client_ip(request)
    db.add(
        AuthSession(
            user_id=user.id,
            token_hash=hash_token(token),
            user_agent=request.headers.get("user-agent"),
            ip=ip,
            expires_at=utcnow() + timedelta(days=SESSION_DAYS),
        )
    )
    user.last_seen_at = utcnow()
    db.flush()
    return token


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        samesite="lax",
        secure=_cookie_secure(),
        path="/",
        max_age=SESSION_DAYS * 24 * 3600,
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/")


def revoke_session(db: Session, token: str | None) -> None:
    if not token:
        return
    row = db.query(AuthSession).filter(AuthSession.token_hash == hash_token(token)).one_or_none()
    if row and row.revoked_at is None:
        row.revoked_at = utcnow()


def get_user_from_token(db: Session, token: str | None) -> User | None:
    if not token:
        return None
    row = db.query(AuthSession).filter(AuthSession.token_hash == hash_token(token)).one_or_none()
    if row is None or row.revoked_at is not None or row.expires_at < utcnow():
        return None
    user = db.get(User, row.user_id)
    if user is None or user.status != "active":
        return None
    user.last_seen_at = utcnow()
    return user


def current_user(
    request: Request,
    db: Annotated[Session, Depends(get_session)],
    sugar_session: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> User:
    token = sugar_session or request.cookies.get(COOKIE_NAME)
    user = get_user_from_token(db, token)
    if user is None:
        raise HTTPException(status_code=401, detail="session-expired")
    return user


def optional_user(
    request: Request,
    db: Annotated[Session, Depends(get_session)],
    sugar_session: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> User | None:
    token = sugar_session or request.cookies.get(COOKIE_NAME)
    return get_user_from_token(db, token)


def new_referral_code() -> str:
    return secrets.token_hex(4)


def new_email_token() -> str:
    return secrets.token_urlsafe(24)
