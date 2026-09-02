from __future__ import annotations

import uuid

import pytest

from backend.auth.sessions import new_referral_code
from backend.db.models import User, WalletTransaction
from backend.db.wallet import InsufficientFunds, WELCOME_COINS, WELCOME_DIAMONDS, apply_delta, grant_welcome


def _create_user(db_session) -> uuid.UUID:
    user = User(
        email=f"wallet-{uuid.uuid4().hex[:10]}@example.com",
        auth_provider="email",
        referral_code=new_referral_code(),
    )
    db_session.add(user)
    db_session.flush()
    return user.id


def test_apply_delta_credits_coins(db_session):
    user_id = _create_user(db_session)
    wallet = apply_delta(
        db_session,
        user_id=user_id,
        currency="coins",
        delta=50,
        reason="admin_adjust",
        idempotency_key=f"test:{uuid.uuid4()}",
    )
    assert wallet.coins == 50


def test_apply_delta_insufficient_funds(db_session):
    user_id = _create_user(db_session)
    with pytest.raises(InsufficientFunds):
        apply_delta(
            db_session,
            user_id=user_id,
            currency="diamonds",
            delta=-10,
            reason="admin_adjust",
            idempotency_key=f"test:{uuid.uuid4()}",
        )


def test_apply_delta_idempotent(db_session):
    user_id = _create_user(db_session)
    key = f"idempotent:{uuid.uuid4()}"
    first = apply_delta(
        db_session,
        user_id=user_id,
        currency="diamonds",
        delta=25,
        reason="admin_adjust",
        idempotency_key=key,
    )
    second = apply_delta(
        db_session,
        user_id=user_id,
        currency="diamonds",
        delta=25,
        reason="admin_adjust",
        idempotency_key=key,
    )
    db_session.flush()
    db_session.refresh(first)
    assert first.diamonds == 25
    assert second.diamonds == 25
    tx_count = (
        db_session.query(WalletTransaction)
        .filter(WalletTransaction.idempotency_key == key)
        .count()
    )
    assert tx_count == 1


def test_grant_welcome_once(db_session):
    user_id = _create_user(db_session)
    first = grant_welcome(db_session, user_id)
    second = grant_welcome(db_session, user_id)
    db_session.flush()
    db_session.refresh(first)
    assert first.diamonds == WELCOME_DIAMONDS
    assert first.coins == WELCOME_COINS
    assert second.diamonds == WELCOME_DIAMONDS
    assert second.coins == WELCOME_COINS
