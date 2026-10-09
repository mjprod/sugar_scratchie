from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from backend.auth.sessions import current_user
from backend.db.card_plays import is_free_playable
from backend.db.engine import get_session
from backend.db.models import (
    Creator,
    MotionCard,
    Pack,
    PhotoScratchCard,
    Theme,
    User,
    UserCard,
    UserCardPlayed,
)

router = APIRouter(prefix="/api/me/creators", tags=["board"])


def _ms(value) -> int | None:
    return int(value.timestamp() * 1000) if value is not None else None


class _UserCardState:
    """Pack ownership + play ledger of one user, keyed by (card_kind, card_id)."""

    def __init__(self, db: Session, user_id, card_ids: list[str]) -> None:
        self.owned: set[tuple[str, str]] = set()
        self.played: dict[tuple[str, str], UserCardPlayed] = {}
        if not card_ids:
            return
        for kind, card_id in db.execute(
            select(UserCard.card_kind, UserCard.card_id).where(
                UserCard.user_id == user_id, UserCard.card_id.in_(card_ids)
            )
        ):
            self.owned.add((kind, card_id))
        for row in db.scalars(
            select(UserCardPlayed).where(
                UserCardPlayed.user_id == user_id, UserCardPlayed.card_id.in_(card_ids)
            )
        ):
            self.played[(row.card_kind, row.card_id)] = row

    def describe(self, kind: str, card_id: str, price: int) -> dict[str, Any]:
        owned = (kind, card_id) in self.owned
        row = self.played.get((kind, card_id))
        return {
            "owned": owned,
            "unlocked": owned or row is not None,
            "freePlayable": is_free_playable(row, owned=owned, price=price),
            "playCount": row.play_count if row is not None else 0,
        }


def _static_card(photo: PhotoScratchCard, state: _UserCardState) -> dict[str, Any]:
    price = photo.card_price or 0
    return {
        "id": photo.id,
        "slotId": photo.slot_id,
        "label": photo.label,
        "price": price,
        **state.describe("photo", photo.id, price),
    }


def _motion_card(
    card: MotionCard, photos: list[PhotoScratchCard], state: _UserCardState
) -> dict[str, Any]:
    statics = [_static_card(photo, state) for photo in photos]
    described = state.describe("motion", card.id, card.price)
    return {
        "id": card.id,
        "label": card.label,
        "tier": card.tier,
        "themeId": card.theme_id,
        "price": card.price,
        "replayPrice": card.replay_price,
        "maxWin": card.max_win,
        **described,
        "status": "unlocked" if described["unlocked"] else "locked",
        "staticCardsOwned": sum(1 for s in statics if s["owned"]),
        "staticCardsTotal": len(statics),
        "staticCards": statics,
    }


@router.get("/{model_id}/board")
def creator_board(
    model_id: str,
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
):
    """Everything the creator screen needs for one player, in one response.

    Prices are diamonds. A card is `unlocked` once revealed from a pack or
    played (the first play is the purchase / unlock). `freePlayable` follows the
    theme free-play rule: played once and bought, pack-revealed, or free.
    """
    creator = db.get(Creator, model_id)
    if creator is None:
        raise HTTPException(status_code=404, detail="Creator not found.")

    cards = list(
        db.scalars(
            select(MotionCard)
            .where(MotionCard.model_id == model_id)
            .order_by(MotionCard.sort_order, MotionCard.id)
        )
    )
    card_ids = [card.id for card in cards]
    photos_by_card: dict[str, list[PhotoScratchCard]] = {card_id: [] for card_id in card_ids}
    if card_ids:
        for photo in db.scalars(
            select(PhotoScratchCard)
            .where(PhotoScratchCard.card_id.in_(card_ids))
            .order_by(PhotoScratchCard.slot_id)
        ):
            photos_by_card[photo.card_id].append(photo)
    photo_ids = [p.id for photos in photos_by_card.values() for p in photos]
    state = _UserCardState(db, user.id, card_ids + photo_ids)

    themes_by_id = {theme.id: theme for theme in db.scalars(select(Theme))}
    theme_entries: dict[str | None, dict[str, Any]] = {}
    ultra: dict[str, Any] | None = None
    for card in cards:
        described = _motion_card(card, photos_by_card[card.id], state)
        if card.tier == "ultra":
            ultra = described
            continue
        theme = themes_by_id.get(card.theme_id) if card.theme_id else None
        entry = theme_entries.setdefault(
            card.theme_id,
            {
                "id": card.theme_id,
                "label": theme.label if theme else "Other",
                "sortOrder": theme.sort_order if theme else 1_000_000,
                "motionCards": [],
                "premium": None,
            },
        )
        if card.tier == "premium":
            entry["premium"] = described
        else:
            entry["motionCards"].append(described)

    pack = db.scalar(
        select(Pack)
        .where(Pack.model_id == model_id, Pack.available.is_(True))
        .order_by(Pack.sort_order)
        .limit(1)
    )
    total_motion_owned = db.scalar(
        select(func.count())
        .select_from(UserCard)
        .where(UserCard.user_id == user.id, UserCard.card_kind == "motion")
    )

    return {
        "creator": {
            "id": creator.id,
            "name": creator.influencer_name or creator.label,
            "label": creator.label,
            "instagramUrl": creator.instagram_url,
            "tiktokUrl": creator.tiktok_url,
            "xUrl": creator.x_url,
            "onlyfansUrl": creator.onlyfans_url,
            "joinedAt": _ms(creator.created_at),
        },
        "pack": (
            {"id": pack.id, "price": pack.diamond_cost, "priceAmountCents": pack.price_amount_cents}
            if pack is not None
            else None
        ),
        "motionCardsOwned": sum(1 for card in cards if ("motion", card.id) in state.owned),
        "totalMotionCardsOwned": int(total_motion_owned or 0),
        "themes": sorted(theme_entries.values(), key=lambda t: (t["sortOrder"], t["label"])),
        "ultra": ultra,
    }
