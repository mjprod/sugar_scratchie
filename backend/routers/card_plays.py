from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.auth.sessions import current_user
from backend.db.card_plays import FreePlayLocked, card_terms, is_free_playable, owns_from_pack, register_play
from backend.db.engine import get_session
from backend.db.models import User, UserCardPlayed
from backend.db.wallet import InsufficientFunds, ensure_wallet

router = APIRouter(prefix="/api/me/cards", tags=["card-plays"])


class PlayBody(BaseModel):
    cardKind: Literal["motion", "photo"]
    cardId: str = Field(min_length=1, max_length=128)
    # Theme free-play toggle: no charge, no rewards; needs a free-playable card.
    freePlay: bool = False


def _played_public(row: UserCardPlayed) -> dict:
    return {
        "cardKind": row.card_kind,
        "cardId": row.card_id,
        "playCount": row.play_count,
        "pricePaid": row.price_paid,
        "firstPlayedAt": int(row.first_played_at.timestamp() * 1000),
    }


@router.get("/played")
def list_played(db: Annotated[Session, Depends(get_session)], user: Annotated[User, Depends(current_user)]):
    rows = (
        db.query(UserCardPlayed)
        .filter(UserCardPlayed.user_id == user.id)
        .order_by(UserCardPlayed.first_played_at)
        .all()
    )
    return {"played": [_played_public(r) for r in rows]}


@router.post("/play")
def play_card(
    body: PlayBody,
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
):
    card_id = body.cardId.strip()
    terms = card_terms(db, body.cardKind, card_id)
    if terms is None:
        raise HTTPException(status_code=404, detail="Card not found.")
    owned = owns_from_pack(db, user.id, body.cardKind, card_id)
    try:
        result = register_play(
            db, user.id, body.cardKind, card_id, terms, owned=owned, free_play=body.freePlay
        )
    except InsufficientFunds:
        raise HTTPException(status_code=400, detail="insufficient")
    except FreePlayLocked:
        raise HTTPException(status_code=403, detail="free_play_locked")
    wallet = ensure_wallet(db, user.id)
    return {
        "firstPlay": result.first_play,
        # Rewards stay on until the purchased play's scratch hand has been issued.
        "rewardsEnabled": not body.freePlay and result.row.rewarded_hand_id is None,
        "pricePaid": result.charged,
        "freePlayable": is_free_playable(result.row, owned=owned, price=terms.price),
        "played": _played_public(result.row),
        "wallet": {"diamonds": wallet.diamonds, "coins": wallet.coins},
    }
