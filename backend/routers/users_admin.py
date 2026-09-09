from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload

from backend.db.engine import get_session
from backend.db.models import (
    DailyRewardClaim,
    EmailToken,
    GameSession,
    InboxMessage,
    InboxRead,
    PackInstance,
    PackOpening,
    PackOpeningCard,
    PackPurchase,
    RedeemRedemption,
    ScratchSession,
    Session as AuthSession,
    StorePurchase,
    User,
    UserCard,
    UserCreatorPref,
    Wallet,
    WalletTransaction,
    utcnow,
)
from backend.db.wallet import InsufficientFunds, apply_delta

router = APIRouter(prefix="/api/users", tags=["users-admin"])

UserStatus = Literal["active", "banned", "deleted"]
Currency = Literal["diamonds", "coins"]


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _wallet_public(wallet: Wallet | None) -> dict:
    if wallet is None:
        return {"diamonds": 0, "coins": 0}
    return {"diamonds": wallet.diamonds, "coins": wallet.coins}


def _admin_user(user: User, *, active_sessions: int | None = None) -> dict:
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
        "status": user.status,
        "createdAt": _iso(user.created_at),
        "updatedAt": _iso(user.updated_at),
        "lastSeenAt": _iso(user.last_seen_at),
        "wallet": _wallet_public(user.wallet),
        "activeSessions": active_sessions,
    }


class UserPatch(BaseModel):
    status: UserStatus | None = None
    display_name: str | None = Field(default=None, max_length=80)
    username: str | None = Field(default=None, max_length=40)


class WalletAdjustRequest(BaseModel):
    currency: Currency
    delta: int = Field(..., ne=0)
    note: str | None = Field(default=None, max_length=200)
    idempotency_key: str = Field(..., max_length=120)


@router.get("")
def list_users(
    db: Annotated[Session, Depends(get_session)],
    q: str | None = Query(default=None, max_length=200),
    status: UserStatus | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    filters = []
    if status:
        filters.append(User.status == status)
    if q:
        needle = f"%{q.strip()}%"
        filters.append(
            or_(
                User.email.ilike(needle),
                User.username.ilike(needle),
                User.display_name.ilike(needle),
            )
        )

    total = db.query(func.count(User.id)).filter(*filters).scalar() or 0
    rows = (
        db.query(User)
        .options(joinedload(User.wallet))
        .filter(*filters)
        .order_by(User.created_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return {
        "total": int(total),
        "limit": limit,
        "offset": offset,
        "users": [_admin_user(user) for user in rows],
    }


@router.get("/{user_id}")
def get_user(user_id: UUID, db: Annotated[Session, Depends(get_session)]):
    user = db.query(User).options(joinedload(User.wallet)).filter(User.id == user_id).one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="user-not-found")
    active_sessions = (
        db.query(func.count(AuthSession.id))
        .filter(
            AuthSession.user_id == user.id,
            AuthSession.revoked_at.is_(None),
            AuthSession.expires_at > utcnow(),
        )
        .scalar()
        or 0
    )
    recent_tx = (
        db.query(WalletTransaction)
        .filter(WalletTransaction.user_id == user.id)
        .order_by(WalletTransaction.created_at.desc())
        .limit(20)
        .all()
    )
    return {
        "user": _admin_user(user, active_sessions=int(active_sessions)),
        "transactions": [
            {
                "id": str(tx.id),
                "currency": tx.currency,
                "delta": tx.delta,
                "balanceAfter": tx.balance_after,
                "reason": tx.reason,
                "refType": tx.ref_type,
                "refId": tx.ref_id,
                "createdAt": _iso(tx.created_at),
            }
            for tx in recent_tx
        ],
    }


@router.patch("/{user_id}")
def patch_user(
    user_id: UUID,
    body: UserPatch,
    db: Annotated[Session, Depends(get_session)],
):
    user = db.query(User).options(joinedload(User.wallet)).filter(User.id == user_id).one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="user-not-found")

    set_fields = body.model_fields_set
    if body.status is not None:
        user.status = body.status
        if body.status in ("banned", "deleted"):
            (
                db.query(AuthSession)
                .filter(AuthSession.user_id == user.id, AuthSession.revoked_at.is_(None))
                .update({"revoked_at": utcnow()}, synchronize_session=False)
            )
    if "display_name" in set_fields:
        user.display_name = (body.display_name or "").strip() or None
    if "username" in set_fields:
        next_username = (body.username or "").strip() or None
        if next_username:
            clash = (
                db.query(User)
                .filter(User.username == next_username, User.id != user.id)
                .one_or_none()
            )
            if clash is not None:
                raise HTTPException(status_code=409, detail="username-taken")
        user.username = next_username
    user.updated_at = utcnow()
    db.flush()
    return {"user": _admin_user(user)}


@router.post("/{user_id}/wallet/adjust")
def adjust_wallet(
    user_id: UUID,
    body: WalletAdjustRequest,
    db: Annotated[Session, Depends(get_session)],
):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="user-not-found")

    try:
        wallet = apply_delta(
            db,
            user_id=user_id,
            currency=body.currency,
            delta=body.delta,
            reason="admin_adjust",
            idempotency_key=body.idempotency_key,
            ref_type="admin_note",
            ref_id=(body.note or "")[:120] or None,
        )
    except InsufficientFunds as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {
        "wallet": _wallet_public(wallet),
        "idempotencyKey": body.idempotency_key,
    }


@router.post("/{user_id}/sessions/revoke")
def revoke_sessions(user_id: UUID, db: Annotated[Session, Depends(get_session)]):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="user-not-found")
    updated = (
        db.query(AuthSession)
        .filter(AuthSession.user_id == user.id, AuthSession.revoked_at.is_(None))
        .update({"revoked_at": utcnow()}, synchronize_session=False)
    )
    return {"revoked": int(updated)}


@router.delete("/{user_id}")
def delete_user_permanently(user_id: UUID, db: Annotated[Session, Depends(get_session)]):
    """Hard-delete a player and all owned rows. Irreversible."""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="user-not-found")

    # Clear self-referential referrals pointing at this user.
    (
        db.query(User)
        .filter(User.referred_by_user_id == user.id)
        .update({"referred_by_user_id": None}, synchronize_session=False)
    )

    # Pack opening chain: opening cards → openings → instances → purchases.
    instance_ids = [
        row[0]
        for row in db.query(PackInstance.id).filter(PackInstance.user_id == user.id).all()
    ]
    if instance_ids:
        opening_ids = [
            row[0]
            for row in db.query(PackOpening.id)
            .filter(PackOpening.pack_instance_id.in_(instance_ids))
            .all()
        ]
        if opening_ids:
            opening_card_ids = [
                row[0]
                for row in db.query(PackOpeningCard.id)
                .filter(PackOpeningCard.opening_id.in_(opening_ids))
                .all()
            ]
            if opening_card_ids:
                (
                    db.query(UserCard)
                    .filter(UserCard.source_opening_card_id.in_(opening_card_ids))
                    .update({"source_opening_card_id": None}, synchronize_session=False)
                )
                db.query(PackOpeningCard).filter(PackOpeningCard.id.in_(opening_card_ids)).delete(
                    synchronize_session=False
                )
            db.query(PackOpening).filter(PackOpening.id.in_(opening_ids)).delete(
                synchronize_session=False
            )
        db.query(PackInstance).filter(PackInstance.id.in_(instance_ids)).delete(
            synchronize_session=False
        )

    # Scratch sessions reference user_cards.
    card_ids = [row[0] for row in db.query(UserCard.id).filter(UserCard.user_id == user.id).all()]
    if card_ids:
        db.query(ScratchSession).filter(ScratchSession.user_card_id.in_(card_ids)).delete(
            synchronize_session=False
        )
    db.query(ScratchSession).filter(ScratchSession.user_id == user.id).delete(
        synchronize_session=False
    )
    db.query(UserCard).filter(UserCard.user_id == user.id).delete(synchronize_session=False)
    db.query(PackPurchase).filter(PackPurchase.user_id == user.id).delete(synchronize_session=False)

    # Inbox reads before user-owned messages.
    db.query(InboxRead).filter(InboxRead.user_id == user.id).delete(synchronize_session=False)
    db.query(InboxMessage).filter(InboxMessage.user_id == user.id).delete(synchronize_session=False)

    db.query(RedeemRedemption).filter(RedeemRedemption.user_id == user.id).delete(
        synchronize_session=False
    )
    db.query(DailyRewardClaim).filter(DailyRewardClaim.user_id == user.id).delete(
        synchronize_session=False
    )
    db.query(GameSession).filter(GameSession.user_id == user.id).delete(synchronize_session=False)
    db.query(StorePurchase).filter(StorePurchase.user_id == user.id).delete(
        synchronize_session=False
    )
    db.query(WalletTransaction).filter(WalletTransaction.user_id == user.id).delete(
        synchronize_session=False
    )
    db.query(Wallet).filter(Wallet.user_id == user.id).delete(synchronize_session=False)
    db.query(UserCreatorPref).filter(UserCreatorPref.user_id == user.id).delete(
        synchronize_session=False
    )
    db.query(EmailToken).filter(EmailToken.user_id == user.id).delete(synchronize_session=False)
    db.query(AuthSession).filter(AuthSession.user_id == user.id).delete(synchronize_session=False)

    email = user.email
    db.delete(user)
    db.flush()
    return {"ok": True, "id": str(user_id), "email": email}
