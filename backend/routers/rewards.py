from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.auth.sessions import current_user
from backend.db.engine import get_session
from backend.db.models import DailyRewardClaim, Pack, PackInstance, PackPurchase, RedeemCode, RedeemRedemption, User, utcnow
from backend.db.wallet import apply_delta, ensure_wallet

router = APIRouter(prefix="/api/rewards", tags=["rewards"])

DAILY_DIAMONDS = 10


class RedeemBody(BaseModel):
    code: str = Field(min_length=1, max_length=64)


def _next_midnight() -> datetime:
    today = utcnow().date()
    return datetime.combine(today + timedelta(days=1), time.min, tzinfo=timezone.utc)

@router.get("/daily")
def daily_status(db: Annotated[Session, Depends(get_session)], user: Annotated[User, Depends(current_user)]):
    today = date.today()
    claimed = (
        db.query(DailyRewardClaim)
        .filter(DailyRewardClaim.user_id == user.id, DailyRewardClaim.claim_date == today)
        .one_or_none()
    )
    return {
        "claimedToday": claimed is not None,
        "diamonds": DAILY_DIAMONDS,
        "resetAt": int(_next_midnight().timestamp() * 1000),
        "claimDate": today.isoformat(),
    }


@router.post("/daily/claim")
def claim_daily(db: Annotated[Session, Depends(get_session)], user: Annotated[User, Depends(current_user)]):
    today = date.today()
    existing = (
        db.query(DailyRewardClaim)
        .filter(DailyRewardClaim.user_id == user.id, DailyRewardClaim.claim_date == today)
        .one_or_none()
    )
    if existing:
        return {"ok": False, "reason": "already_claimed", "diamonds": 0}
    row = DailyRewardClaim(user_id=user.id, claim_date=today, day_index=1, diamonds=DAILY_DIAMONDS)
    db.add(row)
    apply_delta(
        db,
        user_id=user.id,
        currency="diamonds",
        delta=DAILY_DIAMONDS,
        reason="daily_reward",
        idempotency_key=f"daily:{user.id}:{today.isoformat()}",
        ref_type="daily_reward",
        ref_id=today.isoformat(),
    )
    wallet = ensure_wallet(db, user.id)
    return {"ok": True, "diamonds": DAILY_DIAMONDS, "wallet": {"diamonds": wallet.diamonds, "coins": wallet.coins}}


@router.post("/redeem")
def redeem(body: RedeemBody, db: Annotated[Session, Depends(get_session)], user: Annotated[User, Depends(current_user)]):
    code = body.code.strip().upper()
    row = db.get(RedeemCode, code)
    if row is None:
        return {"success": False, "errorType": "invalid_code"}
    if not row.active:
        return {"success": False, "errorType": "unavailable"}
    if row.expires_at and row.expires_at < utcnow():
        return {"success": False, "errorType": "expired"}
    if row.max_redemptions is not None and row.redemption_count >= row.max_redemptions:
        return {"success": False, "errorType": "unavailable"}
    already = (
        db.query(RedeemRedemption)
        .filter(RedeemRedemption.user_id == user.id, RedeemRedemption.code == code)
        .one_or_none()
    )
    if already:
        return {"success": False, "errorType": "already_redeemed"}

    if row.reward_kind == "diamonds":
        reward = {"type": "diamonds", "amount": row.diamonds}
        apply_delta(
            db,
            user_id=user.id,
            currency="diamonds",
            delta=row.diamonds,
            reason="redeem_code",
            idempotency_key=f"redeem:{user.id}:{code}",
            ref_type="redeem_code",
            ref_id=code,
        )
    else:
        pack = db.get(Pack, row.pack_id) if row.pack_id else None
        if pack is None:
            return {"success": False, "errorType": "unavailable"}
        purchase = PackPurchase(
            user_id=user.id,
            pack_id=pack.id,
            quantity=1,
            diamond_cost=0,
            idempotency_key=f"redeem-pack:{user.id}:{code}",
        )
        db.add(purchase)
        db.flush()
        inst = PackInstance(
            user_id=user.id,
            pack_id=pack.id,
            pack_purchase_id=purchase.id,
            status="unopened",
        )
        db.add(inst)
        db.flush()
        reward = {
            "type": "free_pack",
            "packId": pack.id,
            "creatorHandle": pack.name,
            "sceneName": pack.pack_title,
            "instanceId": str(inst.id),
        }

    row.redemption_count += 1
    db.add(RedeemRedemption(user_id=user.id, code=code, reward=reward))
    return {"success": True, "reward": reward}
