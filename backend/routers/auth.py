from __future__ import annotations

from datetime import timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.auth.passwords import hash_password, verify_password
from backend.auth.sessions import (
    COOKIE_NAME,
    PASSWORD_MIN_LENGTH,
    clear_session_cookie,
    current_user,
    hash_token,
    issue_session,
    new_email_token,
    new_referral_code,
    optional_user,
    set_session_cookie,
)
from backend.db.engine import get_session
from backend.db.models import EmailToken, User, utcnow
from backend.db.wallet import grant_welcome

router = APIRouter(prefix="/api/auth", tags=["auth"])

AuthProvider = Literal["google", "apple", "email"]


class RegisterRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=PASSWORD_MIN_LENGTH, max_length=200)
    username: str | None = Field(default=None, max_length=40)
    display_name: str | None = Field(default=None, max_length=80)


class LoginRequest(BaseModel):
    email: str
    password: str


class OAuthRequest(BaseModel):
    email: str
    subject: str | None = None
    display_name: str | None = None


class EmailRequest(BaseModel):
    email: str | None = None


class ConfirmTokenRequest(BaseModel):
    token: str


class ResetPasswordRequest(BaseModel):
    token: str
    password: str = Field(min_length=PASSWORD_MIN_LENGTH, max_length=200)


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=PASSWORD_MIN_LENGTH, max_length=200)


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def public_user(user: User) -> dict:
    return {
        "id": str(user.id),
        "email": user.email,
        "provider": user.auth_provider,
        "emailVerified": user.email_verified_at is not None,
        "username": user.username,
        "displayName": user.display_name,
        "avatarUrl": user.avatar_url,
        "genderInterest": user.gender_interest,
        "referralCode": user.referral_code,
        "welcomeClaimed": user.welcome_claimed_at is not None,
        "homeTutorialDone": user.home_tutorial_done,
        "recommendationStatus": user.recommendation_status,
    }


def _create_user(
    db: Session,
    *,
    email: str,
    provider: AuthProvider,
    password: str | None = None,
    username: str | None = None,
    display_name: str | None = None,
    subject: str | None = None,
    verified: bool = False,
) -> User:
    user = User(
        email=email,
        password_hash=hash_password(password) if password else None,
        auth_provider=provider,
        provider_subject=subject,
        username=username,
        display_name=display_name or (username or email.split("@")[0]),
        email_verified_at=utcnow() if verified else None,
        referral_code=new_referral_code(),
    )
    db.add(user)
    db.flush()
    grant_welcome(db, user.id)
    return user


def _issue(response: Response, db: Session, user: User, request: Request) -> dict:
    token = issue_session(db, user, request)
    set_session_cookie(response, token)
    return {"ok": True, "user": public_user(user)}


@router.post("/register")
def register(body: RegisterRequest, request: Request, response: Response, db: Annotated[Session, Depends(get_session)]):
    email = _normalize_email(body.email)
    existing = db.query(User).filter(User.email == email).one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Unable to create account. Please try again.")
    user = _create_user(
        db,
        email=email,
        provider="email",
        password=body.password,
        username=body.username,
        display_name=body.display_name,
    )
    token = new_email_token()
    db.add(
        EmailToken(
            user_id=user.id,
            kind="verify_email",
            token_hash=hash_token(token),
            expires_at=utcnow() + timedelta(days=2),
        )
    )
    print(f"[auth] verify email token for {email}: {token}")
    return _issue(response, db, user, request)


@router.post("/login")
def login(body: LoginRequest, request: Request, response: Response, db: Annotated[Session, Depends(get_session)]):
    email = _normalize_email(body.email)
    user = db.query(User).filter(User.email == email).one_or_none()
    if user is None or not user.password_hash or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Incorrect email or password.")
    if user.status != "active":
        raise HTTPException(status_code=403, detail="Account unavailable.")
    return _issue(response, db, user, request)


@router.post("/logout")
def logout(
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_session)],
):
    from backend.auth.sessions import revoke_session

    revoke_session(db, request.cookies.get(COOKIE_NAME))
    clear_session_cookie(response)
    return {"ok": True}


@router.get("/session")
def session(db: Annotated[Session, Depends(get_session)], user: Annotated[User | None, Depends(optional_user)]):
    if user is None:
        return {"authenticated": False, "user": None}
    return {"authenticated": True, "user": public_user(user)}


@router.post("/oauth/{provider}")
def oauth(
    provider: AuthProvider,
    body: OAuthRequest,
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_session)],
):
    if provider == "email":
        raise HTTPException(status_code=400, detail="Use /register for email.")
    email = _normalize_email(body.email)
    user = db.query(User).filter(User.email == email).one_or_none()
    if user is None:
        user = _create_user(
            db,
            email=email,
            provider=provider,
            display_name=body.display_name,
            subject=body.subject,
            verified=True,
        )
    else:
        user.auth_provider = provider
        if body.subject:
            user.provider_subject = body.subject
        if user.email_verified_at is None:
            user.email_verified_at = utcnow()
    return _issue(response, db, user, request)


@router.post("/verify-email/request")
def request_verify(
    body: EmailRequest,
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
):
    token = new_email_token()
    db.add(
        EmailToken(
            user_id=user.id,
            kind="verify_email",
            token_hash=hash_token(token),
            expires_at=utcnow() + timedelta(days=2),
        )
    )
    print(f"[auth] verify email token for {user.email}: {token}")
    return {"ok": True}


@router.post("/verify-email/confirm")
def confirm_verify(body: ConfirmTokenRequest, db: Annotated[Session, Depends(get_session)]):
    row = (
        db.query(EmailToken)
        .filter(EmailToken.token_hash == hash_token(body.token), EmailToken.kind == "verify_email")
        .one_or_none()
    )
    if row is None or row.consumed_at is not None or row.expires_at < utcnow():
        # Prototype: any logged-in confirm without token is also accepted via empty token + session.
        raise HTTPException(status_code=400, detail="Invalid or expired token.")
    user = db.get(User, row.user_id)
    if user is None:
        raise HTTPException(status_code=400, detail="Invalid or expired token.")
    row.consumed_at = utcnow()
    user.email_verified_at = utcnow()
    return {"ok": True, "user": public_user(user)}


@router.post("/verify-email/mark")
def mark_verified(user: Annotated[User, Depends(current_user)]):
    """Prototype shortcut used by the existing verify modal."""
    user.email_verified_at = utcnow()
    return {"ok": True, "user": public_user(user)}


@router.post("/password/forgot")
def forgot_password(body: EmailRequest, db: Annotated[Session, Depends(get_session)]):
    email = _normalize_email(body.email or "")
    user = db.query(User).filter(User.email == email).one_or_none() if email else None
    if user:
        token = new_email_token()
        db.add(
            EmailToken(
                user_id=user.id,
                kind="reset_password",
                token_hash=hash_token(token),
                expires_at=utcnow() + timedelta(hours=2),
            )
        )
        print(f"[auth] reset password token for {email}: {token}")
    return {"ok": True}


@router.post("/password/reset")
def reset_password(body: ResetPasswordRequest, db: Annotated[Session, Depends(get_session)]):
    row = (
        db.query(EmailToken)
        .filter(EmailToken.token_hash == hash_token(body.token), EmailToken.kind == "reset_password")
        .one_or_none()
    )
    if row is None or row.consumed_at is not None or row.expires_at < utcnow():
        raise HTTPException(status_code=400, detail="Invalid or expired token.")
    user = db.get(User, row.user_id)
    if user is None:
        raise HTTPException(status_code=400, detail="Invalid or expired token.")
    user.password_hash = hash_password(body.password)
    row.consumed_at = utcnow()
    return {"ok": True}


@router.post("/password/change")
def change_password(
    body: ChangePasswordRequest,
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
):
    if not user.password_hash or not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="incorrect_current")
    user.password_hash = hash_password(body.new_password)
    return {"ok": True}
