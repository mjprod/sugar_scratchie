from __future__ import annotations

import uuid

from sqlalchemy import event, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from backend.db.models import Wallet, WalletTransaction, utcnow

WELCOME_DIAMONDS = 3
WELCOME_COINS = 120
# session.info key. Session.get(with_for_update=True) always emits SQL, so a
# second ensure_wallet in the same transaction would lock the row again.
_LOCKED_WALLETS = "locked_wallet_user_ids"


def _drop_wallet_lock_flag(session: Session) -> None:
    # Commit and rollback both release the row lock. A later call must lock again.
    session.info.pop(_LOCKED_WALLETS, None)


event.listen(Session, "after_commit", _drop_wallet_lock_flag)
event.listen(Session, "after_rollback", _drop_wallet_lock_flag)


class InsufficientFunds(Exception):
    pass


def ensure_wallet(session: Session, user_id: uuid.UUID, *, for_update: bool = True) -> Wallet:
    """Return the user's wallet, creating it when missing.

    Callers that also lock ``user_cards_played`` or ``scratch_coin_hands`` must
    call this first. A later call in the same transaction reuses that lock
    instead of emitting another ``FOR UPDATE`` after those rows are held.
    Balance reads pass ``for_update=False``.
    """
    locked: set[uuid.UUID] = session.info.setdefault(_LOCKED_WALLETS, set())
    if for_update and user_id in locked:
        wallet = session.get(Wallet, user_id)
        if wallet is not None:
            return wallet
    wallet = session.get(Wallet, user_id, with_for_update=for_update)
    if wallet is None:
        wallet = Wallet(user_id=user_id, diamonds=0, coins=0)
        session.add(wallet)
        session.flush()
        wallet = session.get(Wallet, user_id, with_for_update=True)
        assert wallet is not None
    if for_update:
        locked.add(user_id)
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
    if currency not in ("diamonds", "coins"):
        raise ValueError(f"invalid currency: {currency}")

    wallet = ensure_wallet(session, user_id)

    # A replayed key is a no-op even if the balance can no longer cover it.
    already_applied = session.execute(
        select(WalletTransaction.id).where(WalletTransaction.idempotency_key == idempotency_key)
    ).first()
    if already_applied is not None:
        return wallet

    current = wallet.diamonds if currency == "diamonds" else wallet.coins
    next_balance = current + delta
    if next_balance < 0:
        raise InsufficientFunds(f"insufficient {currency}")

    # Use column-based ON CONFLICT so this works even if the unique was
    # created under Postgres's default name (…_idempotency_key_key) instead
    # of wallet_tx_idempotency_key_uq — constraint-name targeting breaks signup.
    stmt = (
        pg_insert(WalletTransaction)
        .values(
            user_id=user_id,
            currency=currency,
            delta=delta,
            balance_after=next_balance,
            reason=reason,
            ref_type=ref_type,
            ref_id=ref_id,
            idempotency_key=idempotency_key,
        )
        .on_conflict_do_nothing(index_elements=["idempotency_key"])
        .returning(WalletTransaction.id)
    )
    inserted_id = session.execute(stmt).scalar_one_or_none()
    if inserted_id is None:
        # duplicate idempotency key — already applied, return current wallet
        return wallet

    if currency == "diamonds":
        wallet.diamonds = next_balance
    else:
        wallet.coins = next_balance
    wallet.updated_at = utcnow()
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
