from __future__ import annotations

import uuid
from contextlib import contextmanager
from datetime import timedelta
from typing import Generator

from sqlalchemy.orm import Session

from backend.auth.sessions import new_referral_code
from backend.db.engine import get_engine
from backend.db.models import (
    DailyRewardClaim,
    EmailToken,
    GameSession,
    InboxMessage,
    InboxRead,
    PackInstance,
    PackOpening,
    PackOpeningCard,
    PackPurchase,
    RedeemCode,
    RedeemRedemption,
    ScratchSession,
    Session as AuthSession,
    StorePurchase,
    User,
    UserCard,
    UserCreatorPref,
    Wallet,
    WalletTransaction,
    utcnow,
)
from backend.db.wallet import apply_delta
from tests.conftest import login, register_and_login


@contextmanager
def _committed_session() -> Generator[Session, None, None]:
    with Session(get_engine()) as session:
        yield session
        session.commit()


def test_adjust_wallet_requires_idempotency_key(client, dashboard_headers):
    _, user = register_and_login(client)

    response = client.post(
        f"/api/users/{user['id']}/wallet/adjust",
        json={"currency": "coins", "delta": 5},
        headers=dashboard_headers,
    )

    assert response.status_code == 422


def test_adjust_wallet_reuses_explicit_idempotency_key(client, dashboard_headers):
    _, user = register_and_login(client)
    payload = {
        "currency": "coins",
        "delta": 5,
        "idempotency_key": f"admin-adjust:{uuid.uuid4().hex}",
    }

    first = client.post(
        f"/api/users/{user['id']}/wallet/adjust",
        json=payload,
        headers=dashboard_headers,
    )
    second = client.post(
        f"/api/users/{user['id']}/wallet/adjust",
        json=payload,
        headers=dashboard_headers,
    )

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["idempotencyKey"] == payload["idempotency_key"]
    assert second.json()["idempotencyKey"] == payload["idempotency_key"]
    assert second.json()["wallet"] == first.json()["wallet"]


def test_adjust_wallet_persists_balance_and_transaction(client, dashboard_headers, db_session):
    _email, user = register_and_login(client)
    user_id = uuid.UUID(user["id"])
    idempotency_key = f"wallet-adjust-{uuid.uuid4().hex}"
    starting_wallet = db_session.get(Wallet, user_id)
    starting_diamonds = 0 if starting_wallet is None else starting_wallet.diamonds
    starting_coins = 0 if starting_wallet is None else starting_wallet.coins

    response = client.post(
        f"/api/users/{user['id']}/wallet/adjust",
        headers=dashboard_headers,
        json={
            "currency": "coins",
            "delta": 75,
            "note": "manual correction",
            "idempotency_key": idempotency_key,
        },
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "wallet": {
            "diamonds": starting_diamonds,
            "coins": starting_coins + 75,
        },
        "idempotencyKey": idempotency_key,
    }

    db_session.expire_all()
    wallet = db_session.get(Wallet, user_id)
    assert wallet is not None
    assert wallet.coins == starting_coins + 75
    assert wallet.diamonds == starting_diamonds

    tx = (
        db_session.query(WalletTransaction)
        .filter(WalletTransaction.user_id == user_id, WalletTransaction.idempotency_key == idempotency_key)
        .one()
    )
    assert tx.currency == "coins"
    assert tx.delta == 75
    assert tx.balance_after == starting_coins + 75
    assert tx.reason == "admin_adjust"
    assert tx.ref_type == "admin_note"
    assert tx.ref_id == "manual correction"


def test_revoke_sessions_revokes_all_active_sessions(client, dashboard_headers, db_session):
    email, user = register_and_login(client)
    user_id = uuid.UUID(user["id"])
    login(client, email)

    before = (
        db_session.query(AuthSession)
        .filter(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
        .count()
    )
    assert before == 2

    response = client.post(f"/api/users/{user['id']}/sessions/revoke", headers=dashboard_headers)

    assert response.status_code == 200, response.text
    assert response.json() == {"revoked": 2}
    assert (
        db_session.query(AuthSession)
        .filter(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
        .count()
        == 0
    )
    assert client.get("/api/auth/session").json()["authenticated"] is False


def test_patch_user_status_revokes_sessions(client, dashboard_headers, db_session):
    email, user = register_and_login(client)
    user_id = uuid.UUID(user["id"])
    login(client, email)

    response = client.patch(
        f"/api/users/{user['id']}",
        headers=dashboard_headers,
        json={"status": "banned"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["user"]["status"] == "banned"
    assert db_session.get(User, user_id).status == "banned"
    assert (
        db_session.query(AuthSession)
        .filter(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
        .count()
        == 0
    )


def test_delete_user_permanently_removes_owned_rows_and_clears_refs(
    client, dashboard_headers, db_session
):
    _email, user = register_and_login(client)
    user_id = uuid.UUID(user["id"])

    with _committed_session() as session:
        referred_user = User(
            email=f"referred-{uuid.uuid4().hex[:10]}@example.com",
            auth_provider="email",
            referral_code=new_referral_code(),
            referred_by_user_id=user_id,
        )
        other_owner = User(
            email=f"other-owner-{uuid.uuid4().hex[:10]}@example.com",
            auth_provider="email",
            referral_code=new_referral_code(),
        )
        session.add_all([referred_user, other_owner])
        session.flush()

        pack_purchase = PackPurchase(
            user_id=user_id,
            pack_id="ep1",
            quantity=1,
            diamond_cost=80,
            idempotency_key=f"delete-pack-{uuid.uuid4().hex}",
        )
        session.add(pack_purchase)
        session.flush()

        pack_instance = PackInstance(
            user_id=user_id,
            pack_id="ep1",
            pack_purchase_id=pack_purchase.id,
        )
        session.add(pack_instance)
        session.flush()

        opening = PackOpening(pack_instance_id=pack_instance.id, stage="complete")
        session.add(opening)
        session.flush()

        opening_card = PackOpeningCard(
            opening_id=opening.id,
            slot_index=0,
            card_kind="photo",
            card_id=f"opening-card-{uuid.uuid4().hex[:8]}",
            rarity="Rare",
        )
        session.add(opening_card)
        session.flush()

        target_card = UserCard(
            user_id=user_id,
            card_kind="photo",
            card_id=f"target-card-{uuid.uuid4().hex[:8]}",
            photo_slot_id="slot-target",
            source_opening_card_id=opening_card.id,
        )
        external_card = UserCard(
            user_id=other_owner.id,
            card_kind="photo",
            card_id=f"external-card-{uuid.uuid4().hex[:8]}",
            photo_slot_id="slot-external",
            source_opening_card_id=opening_card.id,
        )
        session.add_all([target_card, external_card])
        session.flush()

        session.add(
            ScratchSession(
                user_id=user_id,
                user_card_id=target_card.id,
                reveal_pct=0.5,
                symbols_found=[],
            )
        )
        session.add(UserCreatorPref(user_id=user_id, model_id="creator-1", stance="liked", source="feed"))
        session.add(
            EmailToken(
                user_id=user_id,
                kind="verify_email",
                token_hash=f"token-{uuid.uuid4().hex}",
                expires_at=utcnow() + timedelta(days=1),
            )
        )
        session.add(
            StorePurchase(
                user_id=user_id,
                product_id="d100",
                price_label="$0.99",
            )
        )
        session.add(GameSession(user_id=user_id, model_id="creator-1", phase="motion"))
        session.add(
            DailyRewardClaim(
                user_id=user_id,
                claim_date=utcnow().date(),
                day_index=1,
                diamonds=10,
                coins=0,
            )
        )

        redeem_code = RedeemCode(code=f"DEL-{uuid.uuid4().hex[:8]}", reward_kind="diamonds", diamonds=5)
        session.add(redeem_code)
        session.flush()
        session.add(
            RedeemRedemption(
                user_id=user_id,
                code=redeem_code.code,
                reward={"diamonds": 5},
            )
        )

        message = InboxMessage(
            user_id=user_id,
            type="account_system",
            title="System notice",
            subtitle="For deletion coverage",
        )
        session.add(message)
        session.flush()
        session.add(InboxRead(user_id=user_id, message_id=message.id))

        session.add(
            AuthSession(
                user_id=user_id,
                token_hash=f"hash-{uuid.uuid4().hex}",
                expires_at=utcnow() + timedelta(days=1),
            )
        )
        apply_delta(
            session,
            user_id=user_id,
            currency="diamonds",
            delta=25,
            reason="admin_adjust",
            idempotency_key=f"delete-wallet-{uuid.uuid4().hex}",
        )

        referred_user_id = referred_user.id
        other_owner_id = other_owner.id
        opening_id = opening.id
        opening_card_id = opening_card.id

    response = client.delete(f"/api/users/{user['id']}", headers=dashboard_headers)

    assert response.status_code == 200, response.text
    assert response.json() == {"ok": True, "id": user["id"], "email": user["email"]}
    assert db_session.get(User, user_id) is None
    assert db_session.query(Wallet).filter(Wallet.user_id == user_id).count() == 0
    assert db_session.query(WalletTransaction).filter(WalletTransaction.user_id == user_id).count() == 0
    assert db_session.query(PackPurchase).filter(PackPurchase.user_id == user_id).count() == 0
    assert db_session.query(PackInstance).filter(PackInstance.user_id == user_id).count() == 0
    # Scope to this user's rows — other tests may leave pack openings in the shared DB.
    assert db_session.get(PackOpening, opening_id) is None
    assert db_session.get(PackOpeningCard, opening_card_id) is None
    assert db_session.query(UserCard).filter(UserCard.user_id == user_id).count() == 0
    assert db_session.query(ScratchSession).filter(ScratchSession.user_id == user_id).count() == 0
    assert db_session.query(StorePurchase).filter(StorePurchase.user_id == user_id).count() == 0
    assert db_session.query(GameSession).filter(GameSession.user_id == user_id).count() == 0
    assert db_session.query(DailyRewardClaim).filter(DailyRewardClaim.user_id == user_id).count() == 0
    assert db_session.query(RedeemRedemption).filter(RedeemRedemption.user_id == user_id).count() == 0
    assert db_session.query(InboxRead).filter(InboxRead.user_id == user_id).count() == 0
    assert db_session.query(InboxMessage).filter(InboxMessage.user_id == user_id).count() == 0
    assert db_session.query(UserCreatorPref).filter(UserCreatorPref.user_id == user_id).count() == 0
    assert db_session.query(EmailToken).filter(EmailToken.user_id == user_id).count() == 0
    assert db_session.query(AuthSession).filter(AuthSession.user_id == user_id).count() == 0
    assert db_session.get(User, referred_user_id).referred_by_user_id is None
    assert (
        db_session.query(UserCard)
        .filter(UserCard.user_id == other_owner_id)
        .one()
        .source_opening_card_id
        is None
    )
