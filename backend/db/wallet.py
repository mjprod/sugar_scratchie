from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.db.models import Wallet, WalletTransaction, utcnow

WELCOME_DIAMONDS = 3
WELCOME_COINS = 120


class InsufficientFunds(Exception):
    pass


def ensure_wallet(session: Session, user_id: uuid.UUID) -> Wallet:
    wallet = session.get(Wallet, user_id, with_for_update=True)
    if wallet is None:
        wallet = Wallet(user_id=user_id, diamonds=0, coins=0)
        session.add(wallet)
        session.flush()
        wallet = session.get(Wallet, user_id, with_for_update=True)
        assert wallet is not None
    return wallet


def apply_delta(
    session: Session,
    *,
    user_id: uuid.UUID,
    currency: str,
    delta: int,
    reason: str,
    idempotency_key: str,
    ref_type: str | None = None,
    ref_id: str | None = None,
) -> Wallet:
    existing = session.scalar(select(WalletTransaction).where(WalletTransaction.idempotency_key == idempotency_key))
    wallet = ensure_wallet(session, user_id)
    if existing is not None:
        return wallet

    current = wallet.diamonds if currency == "diamonds" else wallet.coins
    next_balance = current + delta
    if next_balance < 0:
        raise InsufficientFunds(f"insufficient {currency}")

    if currency == "diamonds":
        wallet.diamonds = next_balance
    else:
        wallet.coins = next_balance
    wallet.updated_at = utcnow()
    session.add(
        WalletTransaction(
            user_id=user_id,
            currency=currency,
            delta=delta,
            balance_after=next_balance,
            reason=reason,
            ref_type=ref_type,
            ref_id=ref_id,
            idempotency_key=idempotency_key,
        )
    )
    session.flush()
    return wallet


def grant_welcome(session: Session, user_id: uuid.UUID) -> Wallet:
    apply_delta(
        session,
        user_id=user_id,
        currency="diamonds",
        delta=WELCOME_DIAMONDS,
        reason="welcome_bonus",
        idempotency_key=f"welcome-diamonds:{user_id}",
    )
    return apply_delta(
        session,
        user_id=user_id,
        currency="coins",
        delta=WELCOME_COINS,
        reason="welcome_bonus",
        idempotency_key=f"welcome-coins:{user_id}",
    )
