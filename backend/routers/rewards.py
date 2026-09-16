from __future__ import annotations

import random
import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.auth.sessions import current_user
from backend.db.engine import get_session
from backend.db.models import (
    DailyRewardClaim,
    Pack,
    PackInstance,
    PackPurchase,
    RedeemCode,
    RedeemRedemption,
    ScratchCoinHand,
    User,
    utcnow,
)
from backend.db.wallet import apply_delta, ensure_wallet

router = APIRouter(prefix="/api/rewards", tags=["rewards"])

DAILY_DIAMONDS = 10
SCRATCH_COIN_MIN = 80
SCRATCH_COIN_MAX = 100
SCRATCH_MILESTONE_MAX = 10
# Economic bound: inventing hands cannot mint forever.
SCRATCH_HANDS_PER_DAY = 24


class RedeemBody(BaseModel):
    code: str = Field(min_length=1, max_length=64)


class ScratchHandBody(BaseModel):
    cardId: str | None = Field(default=None, max_length=128)


class ScratchCoinsBody(BaseModel):
    handId: str = Field(min_length=1, max_length=128)
    milestone: int = Field(ge=1, le=SCRATCH_MILESTONE_MAX)
    cardId: str | None = Field(default=None, max_length=128)
    # Accepted for backward compatibility with older clients; ignored — server rolls.
    amount: int | None = None


def _next_midnight() -> datetime:
    today = utcnow().date()
    return datetime.combine(today + timedelta(days=1), time.min, tzinfo=timezone.utc)


def _parse_hand_id(raw: str) -> uuid.UUID:
    try:
        return uuid.UUID(raw.strip())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="handId must be a server-issued UUID") from exc


def _claimed_list(hand: ScratchCoinHand) -> list[int]:
    raw: Any = hand.claimed_milestones or []
    if not isinstance(raw, list):
        return []
    out: list[int] = []
    for item in raw:
        try:
            value = int(item)
        except (TypeError, ValueError):
            continue
        if 1 <= value <= SCRATCH_MILESTONE_MAX:
            out.append(value)
    return out


def _hands_started_since(db: Session, user_id: uuid.UUID, since: datetime) -> int:
    return (
        db.query(ScratchCoinHand)
        .filter(ScratchCoinHand.user_id == user_id, ScratchCoinHand.created_at >= since)
        .count()
    )


def _wallet_payload(db: Session, user_id: uuid.UUID) -> dict:
    wallet = ensure_wallet(db, user_id)
    return {"diamonds": wallet.diamonds, "coins": wallet.coins}


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
    return {"ok": True, "diamonds": DAILY_DIAMONDS, "wallet": _wallet_payload(db, user.id)}


@router.post("/scratch/hands")
def start_scratch_hand(
    body: ScratchHandBody,
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
):
    """Issue a scratch hand id. Required before claiming milestone coins."""
    since = utcnow() - timedelta(days=1)
    started = _hands_started_since(db, user.id, since)
    if started >= SCRATCH_HANDS_PER_DAY:
        raise HTTPException(
            status_code=429,
            detail=f"scratch hand limit ({SCRATCH_HANDS_PER_DAY}/day) reached",
        )

    card_id = (body.cardId or "").strip() or None
    hand = ScratchCoinHand(
        user_id=user.id,
        card_id=card_id,
        claimed_milestones=[],
    )
    db.add(hand)
    db.flush()
    return {
        "handId": str(hand.id),
        "milestonesRemaining": SCRATCH_MILESTONE_MAX,
        "handsRemainingToday": max(0, SCRATCH_HANDS_PER_DAY - started - 1),
    }


@router.post("/scratch/coins")
def claim_scratch_coins(
    body: ScratchCoinsBody,
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
):
    hand_uuid = _parse_hand_id(body.handId)
    hand = (
        db.query(ScratchCoinHand)
        .filter(ScratchCoinHand.id == hand_uuid)
        .with_for_update()
        .one_or_none()
    )
    if hand is None or hand.user_id != user.id:
        raise HTTPException(status_code=404, detail="scratch hand not found")

    claimed = _claimed_list(hand)
    if body.milestone in claimed:
        # Idempotent replay of the same milestone.
        return {
            "ok": True,
            "coins": 0,
            "alreadyClaimed": True,
            "wallet": _wallet_payload(db, user.id),
        }

    if len(claimed) >= SCRATCH_MILESTONE_MAX:
        raise HTTPException(status_code=400, detail="scratch hand has no milestones left")

    amount = random.randint(SCRATCH_COIN_MIN, SCRATCH_COIN_MAX)
    apply_delta(
        db,
        user_id=user.id,
        currency="coins",
        delta=amount,
        reason="scratch_reward",
        idempotency_key=f"scratch-coins:{user.id}:{hand.id}:{body.milestone}",
        ref_type="scratch_card",
        ref_id=body.cardId or hand.card_id,
    )
    hand.claimed_milestones = sorted({*claimed, body.milestone})
    db.flush()
    return {
        "ok": True,
        "coins": amount,
        "alreadyClaimed": False,
        "wallet": _wallet_payload(db, user.id),
    }


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
