from __future__ import annotations

import re
import uuid
from dataclasses import dataclass

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from backend.db.models import MotionCard, PhotoScratchCard, UserCardPlayed, utcnow
from backend.db.wallet import apply_delta

CARD_KINDS = ("motion", "photo")
PHOTO_CARD_ID_RE = re.compile(r"_slot_\d{2}$")


def card_kind_for_id(card_id: str) -> str:
    return "photo" if PHOTO_CARD_ID_RE.search(card_id) else "motion"


def card_price(db: Session, kind: str, card_id: str) -> int | None:
    """Diamond price of the first play, or None when the card is not in the catalog."""
    if kind == "photo":
        photo = db.get(PhotoScratchCard, card_id)
        return None if photo is None else (photo.card_price or 0)
    return None if db.get(MotionCard, card_id) is None else 0


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


def register_play(db: Session, user_id: uuid.UUID, kind: str, card_id: str, price: int) -> PlayResult:
    """Insert the played row (charging `price` once) or bump the replay counter.

    Raises `InsufficientFunds` before any row is written when the user cannot pay.
    """
    existing = get_played(db, user_id, kind, card_id, lock=True)
    if existing is not None:
        existing.play_count += 1
        existing.last_played_at = utcnow()
        db.flush()
        return PlayResult(existing, first_play=False)

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
    return PlayResult(row, first_play=inserted is not None)
