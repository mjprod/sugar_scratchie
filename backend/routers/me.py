from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.auth.sessions import current_user
from backend.db.engine import get_session
from backend.db.models import Pack, PackInstance, PackPurchase, User, UserCreatorPref, utcnow
from backend.db.wallet import ensure_wallet
from backend.routers.auth import public_user

router = APIRouter(prefix="/api/me", tags=["me"])

WELCOME_PACK_ID = "ep1"


def _instance_public(inst: PackInstance, pack: Pack | None) -> dict:
    pack = pack or Pack(id=inst.pack_id, name=inst.pack_id, pack_title=inst.pack_id)
    return {
        "instanceId": str(inst.id),
        "catalogPackId": inst.pack_id,
        "packName": pack.pack_title,
        "creator": pack.name,
        "creatorId": pack.model_id or pack.id,
        "themeName": pack.pack_title,
        "coverUrl": pack.cover_url or "",
        "status": inst.status,
        "purchaseId": str(inst.pack_purchase_id),
        "savedAt": int(inst.created_at.timestamp() * 1000),
    }


class ProfilePatch(BaseModel):
    username: str | None = Field(default=None, max_length=40)
    display_name: str | None = Field(default=None, max_length=80)
    avatar_url: str | None = None
    gender_interest: Literal["male", "female", "both"] | None = None
    home_tutorial_done: bool | None = None
    recommendation_status: str | None = None


class CreatorPrefItem(BaseModel):
    model_id: str
    stance: Literal["liked", "passed"]
    source: Literal["feed", "onboarding_swipe"] = "feed"


class CreatorPrefsBody(BaseModel):
    prefs: list[CreatorPrefItem]


@router.get("/profile")
def get_profile(user: Annotated[User, Depends(current_user)], db: Annotated[Session, Depends(get_session)]):
    prefs = db.query(UserCreatorPref).filter(UserCreatorPref.user_id == user.id).all()
    liked = [p.model_id for p in prefs if p.stance == "liked"]
    passed = [p.model_id for p in prefs if p.stance == "passed"]
    return {"user": public_user(user), "likedCreators": liked, "passedCreators": passed}


@router.patch("/profile")
def patch_profile(
    body: ProfilePatch,
    user: Annotated[User, Depends(current_user)],
):
    if body.username is not None:
        user.username = body.username
    if body.display_name is not None:
        user.display_name = body.display_name
    if body.avatar_url is not None:
        user.avatar_url = body.avatar_url
    if body.gender_interest is not None:
        user.gender_interest = body.gender_interest
    if body.home_tutorial_done is not None:
        user.home_tutorial_done = body.home_tutorial_done
    if body.recommendation_status is not None:
        user.recommendation_status = body.recommendation_status
    return {"user": public_user(user)}


@router.put("/prefs/creators")
def put_creator_prefs(
    body: CreatorPrefsBody,
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
):
    existing = {(p.model_id): p for p in db.query(UserCreatorPref).filter(UserCreatorPref.user_id == user.id).all()}
    for item in body.prefs:
        row = existing.get(item.model_id)
        if row:
            row.stance = item.stance
            row.source = item.source
        else:
            db.add(
                UserCreatorPref(
                    user_id=user.id,
                    model_id=item.model_id,
                    stance=item.stance,
                    source=item.source,
                )
            )
    return {"ok": True}


@router.post("/welcome/claim")
def claim_welcome(
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
):
    """Grant starter pack once and mark welcome claimed — idempotent on repeat."""
    idempotency_key = f"welcome-pack:{user.id}"
    existing_purchase = (
        db.query(PackPurchase).filter(PackPurchase.idempotency_key == idempotency_key).one_or_none()
    )

    if existing_purchase or user.welcome_claimed_at is not None:
        if user.welcome_claimed_at is None:
            user.welcome_claimed_at = utcnow()
        purchase = existing_purchase
        if purchase is None:
            purchase = (
                db.query(PackPurchase)
                .filter(
                    PackPurchase.user_id == user.id,
                    PackPurchase.pack_id == WELCOME_PACK_ID,
                    PackPurchase.diamond_cost == 0,
                )
                .order_by(PackPurchase.created_at.asc())
                .first()
            )
        instance = None
        pack = None
        if purchase:
            pack = db.get(Pack, purchase.pack_id)
            instance = (
                db.query(PackInstance)
                .filter(PackInstance.pack_purchase_id == purchase.id)
                .order_by(PackInstance.created_at.asc())
                .first()
            )
        wallet = ensure_wallet(db, user.id)
        return {
            "ok": True,
            "welcomeClaimed": True,
            "instance": _instance_public(instance, pack) if instance else None,
            "wallet": {"diamonds": wallet.diamonds, "coins": wallet.coins},
        }

    pack = db.get(Pack, WELCOME_PACK_ID)
    if pack is None or not pack.available:
        raise HTTPException(status_code=404, detail="unavailable")

    user.welcome_claimed_at = utcnow()
    purchase = PackPurchase(
        user_id=user.id,
        pack_id=pack.id,
        quantity=1,
        diamond_cost=0,
        idempotency_key=idempotency_key,
    )
    db.add(purchase)
    db.flush()
    instance = PackInstance(
        user_id=user.id,
        pack_id=pack.id,
        pack_purchase_id=purchase.id,
        status="unopened",
    )
    db.add(instance)
    db.flush()
    wallet = ensure_wallet(db, user.id)
    return {
        "ok": True,
        "welcomeClaimed": True,
        "instance": _instance_public(instance, pack),
        "wallet": {"diamonds": wallet.diamonds, "coins": wallet.coins},
    }
