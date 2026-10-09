from __future__ import annotations

import re
import uuid
from dataclasses import dataclass

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from backend.db.models import MotionCard, PhotoScratchCard, UserCard, UserCardPlayed, utcnow
from backend.db.wallet import apply_delta

CARD_KINDS = ("motion", "photo")
PHOTO_CARD_ID_RE = re.compile(r"_slot_\d{2}$")


class FreePlayLocked(Exception):
    """Free play needs a purchased (or pack-revealed) card that was played once."""


def card_kind_for_id(card_id: str) -> str:
    return "photo" if PHOTO_CARD_ID_RE.search(card_id) else "motion"


@dataclass(frozen=True)
class CardTerms:
    """Diamond pricing of one catalog card."""

    price: int
    replay_price: int = 0
    tier: str = "standard"
    max_win: int = 0


def card_terms(db: Session, kind: str, card_id: str) -> CardTerms | None:
    """Pricing for a catalog card, or None when the card is not in the catalog."""
    if kind == "photo":
        photo = db.get(PhotoScratchCard, card_id)
        return None if photo is None else CardTerms(price=photo.card_price or 0)
    motion = db.get(MotionCard, card_id)
    if motion is None:
        return None
    return CardTerms(
        price=motion.price,
        replay_price=motion.replay_price,
        tier=motion.tier,
        max_win=motion.max_win,
    )


def owns_from_pack(db: Session, user_id: uuid.UUID, kind: str, card_id: str) -> bool:
    return (
        db.query(UserCard.id)
        .filter(UserCard.user_id == user_id, UserCard.card_kind == kind, UserCard.card_id == card_id)
        .first()
        is not None
    )


def is_free_playable(row: UserCardPlayed | None, *, owned: bool, price: int) -> bool:
    """Played once, and either bought, revealed from a pack, or free to begin with."""
    return row is not None and (row.price_paid > 0 or owned or price == 0)


def get_played(db: Session, user_id: uuid.UUID, kind: str, card_id: str, *, lock: bool = False) -> UserCardPlayed | None:
    q = db.query(UserCardPlayed).filter(
        UserCardPlayed.user_id == user_id,
        UserCardPlayed.card_kind == kind,
        UserCardPlayed.card_id == card_id,
    )
    if lock:
        q = q.with_for_update()
    return q.one_or_none()


@dataclass
class PlayResult:
    row: UserCardPlayed
    first_play: bool
    charged: int = 0


def register_play(
    db: Session,
    user_id: uuid.UUID,
    kind: str,
    card_id: str,
    terms: CardTerms,
    *,
    owned: bool = False,
    free_play: bool = False,
) -> PlayResult:
    """Insert the played row (charging `terms.price` once) or record a replay.

    - Pack-revealed cards (`owned`) cost nothing on the first play.
    - A replay after the rewarded hand was used charges `terms.replay_price`
      and re-arms one rewarded hand. A replay before that is a lost-response
      retry and costs nothing.
    - `free_play` never charges and raises `FreePlayLocked` unless the card is
      free-playable.

    Raises `InsufficientFunds` before any row is written when the user cannot pay.
    """
    existing = get_played(db, user_id, kind, card_id, lock=True)
    if free_play:
        if not is_free_playable(existing, owned=owned, price=terms.price):
            raise FreePlayLocked()
        assert existing is not None
        existing.play_count += 1
        existing.last_played_at = utcnow()
        db.flush()
        return PlayResult(existing, first_play=False)

    if existing is not None:
        charged = 0
        if existing.rewarded_hand_id is not None and terms.replay_price > 0:
            apply_delta(
                db,
                user_id=user_id,
                currency="diamonds",
                delta=-terms.replay_price,
                reason="card_replay",
                idempotency_key=f"card-replay:{user_id}:{kind}:{card_id}:{existing.play_count + 1}",
                ref_type=f"{kind}_card",
                ref_id=card_id,
            )
            existing.rewarded_hand_id = None
            charged = terms.replay_price
        existing.play_count += 1
        existing.last_played_at = utcnow()
        db.flush()
        return PlayResult(existing, first_play=False, charged=charged)

    price = 0 if owned else terms.price
    if price > 0:
        apply_delta(
            db,
            user_id=user_id,
            currency="diamonds",
            delta=-price,
            reason="card_purchase",
            idempotency_key=f"card-buy:{user_id}:{kind}:{card_id}",
            ref_type=f"{kind}_card",
            ref_id=card_id,
        )
    stmt = (
        pg_insert(UserCardPlayed)
        .values(
            id=uuid.uuid4(),
            user_id=user_id,
            card_kind=kind,
            card_id=card_id,
            price_paid=price,
            play_count=1,
        )
        .on_conflict_do_nothing(index_elements=["user_id", "card_kind", "card_id"])
        .returning(UserCardPlayed.id)
    )
    inserted = db.execute(stmt).scalar_one_or_none()
    row = get_played(db, user_id, kind, card_id, lock=True)
    assert row is not None
    first_play = inserted is not None
    return PlayResult(row, first_play=first_play, charged=price if first_play else 0)
