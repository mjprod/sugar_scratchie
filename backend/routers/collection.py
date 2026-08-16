from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from backend.auth.sessions import current_user
from backend.db.engine import get_session
from backend.db.models import GameSession, PackInstance, PackOpening, PackOpeningCard, User, UserCard

router = APIRouter(prefix="/api/me", tags=["collection"])


class GameSessionBody(BaseModel):
    version: Literal[1] = 1
    phase: Literal["motion", "photo_reveal", "photo", "done"]
    motionCardIds: list[str] = []
    themes: list[str] = []
    modelId: str
    completedMotionIds: list[str] = []
    photoPrizeTotal: int = 0
    wonPhotoIds: list[str] = []
    completedPhotoIds: list[str] = []
    diamondTotal: int = 0
    walletCredited: bool = False


def _game_public(row: GameSession) -> dict:
    return {
        "version": 1,
        "phase": row.phase,
        "motionCardIds": row.motion_card_ids or [],
        "themes": row.themes or [],
        "modelId": row.model_id,
        "completedMotionIds": row.completed_motion_ids or [],
        "photoPrizeTotal": row.photo_prize_total,
        "wonPhotoIds": row.won_photo_ids or [],
        "completedPhotoIds": row.completed_photo_ids or [],
        "diamondTotal": row.diamond_total,
        "walletCredited": row.wallet_credited,
    }


@router.get("/collection")
def get_collection(db: Annotated[Session, Depends(get_session)], user: Annotated[User, Depends(current_user)]):
    cards = db.query(UserCard).filter(UserCard.user_id == user.id).all()
    owned = db.query(PackInstance).filter(PackInstance.user_id == user.id).all()
    unopened = [p for p in owned if p.status == "unopened"]
    openings = (
        db.query(PackOpening)
        .join(PackInstance, PackOpening.pack_instance_id == PackInstance.id)
        .filter(PackInstance.user_id == user.id)
        .all()
    )
    opening_ids = [o.id for o in openings]
    unscratched = 0
    if opening_ids:
        unscratched = (
            db.query(func.count(PackOpeningCard.id))
            .filter(
                PackOpeningCard.opening_id.in_(opening_ids),
                PackOpeningCard.reveal_status != "revealed",
            )
            .scalar()
            or 0
        )

    by_model: dict[str, dict[str, Any]] = {}
    motion = photo = 0
    for card in cards:
        if card.card_kind == "motion":
            motion += 1
        else:
            photo += 1
        mid = card.model_id or "unknown"
        bucket = by_model.setdefault(mid, {"id": mid, "collected": 0, "motion": 0, "photo": 0})
        bucket["collected"] += 1
        bucket[card.card_kind] = bucket.get(card.card_kind, 0) + 1

    collected = len(cards)
    return {
        "totalPurchasedPacks": len(owned),
        "unopenedPackCount": len(unopened),
        "unscratchedCardCount": int(unscratched),
        "collectedCardCount": collected,
        "hasEverPurchasedPack": len(owned) > 0,
        "hasCollectedCards": collected > 0,
        "hasUnopenedPacks": len(unopened) > 0,
        "hasUnscratchedCards": int(unscratched) > 0,
        "hasPendingReveal": len(unopened) > 0 or int(unscratched) > 0,
        "isTrueEmpty": len(owned) == 0 and collected == 0,
        "hasStartedCollection": len(owned) > 0,
        "summary": {
            "uniqueCards": collected,
            "motionCards": motion,
            "photoCards": photo,
            "creators": len(by_model),
        },
        "creators": list(by_model.values()),
        "cards": [
            {
                "id": str(c.id),
                "cardKind": c.card_kind,
                "cardId": c.card_id,
                "photoSlotId": c.photo_slot_id,
                "modelId": c.model_id,
                "themeId": c.theme_id,
                "rarity": c.rarity,
                "duplicates": c.duplicates,
            }
            for c in cards
        ],
    }


@router.get("/collection/creators/{model_id}")
def get_creator_collection(
    model_id: str,
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
):
    cards = db.query(UserCard).filter(UserCard.user_id == user.id, UserCard.model_id == model_id).all()
    return {
        "modelId": model_id,
        "collected": len(cards),
        "cards": [
            {
                "id": str(c.id),
                "cardKind": c.card_kind,
                "cardId": c.card_id,
                "themeId": c.theme_id,
                "rarity": c.rarity,
            }
            for c in cards
        ],
    }


@router.get("/game-session")
def get_game_session(
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
    model: str | None = None,
):
    q = db.query(GameSession).filter(GameSession.user_id == user.id)
    if model:
        q = q.filter(GameSession.model_id == model)
    row = q.order_by(GameSession.updated_at.desc()).first()
    return {"session": _game_public(row) if row else None}


@router.put("/game-session")
def put_game_session(
    body: GameSessionBody,
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
):
    row = (
        db.query(GameSession)
        .filter(GameSession.user_id == user.id, GameSession.model_id == body.modelId)
        .one_or_none()
    )
    if row is None:
        row = GameSession(user_id=user.id, model_id=body.modelId, phase=body.phase)
        db.add(row)
    row.phase = body.phase
    row.motion_card_ids = body.motionCardIds
    row.themes = body.themes
    row.completed_motion_ids = body.completedMotionIds
    row.photo_prize_total = body.photoPrizeTotal
    row.won_photo_ids = body.wonPhotoIds
    row.completed_photo_ids = body.completedPhotoIds
    row.diamond_total = body.diamondTotal
    row.wallet_credited = body.walletCredited
    db.flush()
    return {"session": _game_public(row)}
