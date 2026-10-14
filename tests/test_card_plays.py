from __future__ import annotations

import time
import uuid
from datetime import datetime, timedelta, timezone
from threading import Thread

from sqlalchemy import text
from sqlalchemy.orm import Session

from backend.auth.sessions import COOKIE_NAME, LAST_SEEN_TOUCH_SECONDS, get_user_from_token
from backend.db.card_plays import CardTerms, register_play
from backend.db.engine import get_engine
from backend.db.models import MotionCard, PhotoScratchCard, User
from backend.db.wallet import WELCOME_COINS, WELCOME_DIAMONDS, ensure_wallet
from backend.routers.rewards import ScratchCoinsBody, claim_scratch_coins
from tests.conftest import register_and_login


def _create_cards(photo_price: int | None) -> tuple[str, str]:
    """Commit a motion card + one priced photo slot; return (motion_id, photo_id)."""
    motion_id = f"test_play_{uuid.uuid4().hex[:8]}"
    photo_id = f"{motion_id}_slot_01"
    with Session(get_engine()) as db:
        db.add(MotionCard(id=motion_id, label="Play test"))
        db.flush()
        db.add(
            PhotoScratchCard(
                id=photo_id,
                card_id=motion_id,
                slot_id="slot_01",
                label="Play test slot",
                background="/bg.png",
                bikini="/bikini.png",
                clothes="/clothes.png",
                mesh="/mesh.json",
                card_price=photo_price,
            )
        )
        db.commit()
    return motion_id, photo_id


def _play(client, kind: str, card_id: str):
    return client.post("/api/me/cards/play", json={"cardKind": kind, "cardId": card_id})


def _start_hand(client, card_id: str) -> dict:
    response = client.post("/api/rewards/scratch/hands", json={"cardId": card_id})
    assert response.status_code == 200, response.text
    return response.json()


def _claim(client, hand_id: str, milestone: int = 1) -> dict:
    response = client.post(
        "/api/rewards/scratch/coins", json={"handId": hand_id, "milestone": milestone}
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_buy_photo_card_charges_once(client):
    register_and_login(client)
    _, photo_id = _create_cards(photo_price=2)

    first = _play(client, "photo", photo_id)
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["firstPlay"] is True
    assert body["rewardsEnabled"] is True
    assert body["pricePaid"] == 2
    assert body["wallet"]["diamonds"] == WELCOME_DIAMONDS - 2

    second = _play(client, "photo", photo_id)
    assert second.status_code == 200, second.text
    again = second.json()
    assert again["firstPlay"] is False
    assert again["pricePaid"] == 0
    assert again["played"]["playCount"] == 2
    assert again["wallet"]["diamonds"] == WELCOME_DIAMONDS - 2


def test_buy_photo_card_insufficient_creates_no_row(client):
    register_and_login(client)
    _, photo_id = _create_cards(photo_price=WELCOME_DIAMONDS + 50)

    response = _play(client, "photo", photo_id)
    assert response.status_code == 400
    assert response.json()["detail"] == "insufficient"
    played = client.get("/api/me/cards/played").json()["played"]
    assert all(p["cardId"] != photo_id for p in played)
    assert client.get("/api/me/wallet").json()["diamonds"] == WELCOME_DIAMONDS


def test_play_unknown_card_404(client):
    register_and_login(client)
    response = _play(client, "photo", f"missing_{uuid.uuid4().hex[:6]}_slot_01")
    assert response.status_code == 404
    response = _play(client, "motion", f"missing_{uuid.uuid4().hex[:6]}")
    assert response.status_code == 404


def test_first_hand_rewarded_replay_hands_mint_nothing(client):
    register_and_login(client)
    _, photo_id = _create_cards(photo_price=1)
    assert _play(client, "photo", photo_id).status_code == 200

    rewarded = _start_hand(client, photo_id)
    assert rewarded["rewardsEnabled"] is True
    claim = _claim(client, rewarded["handId"])
    assert 80 <= claim["coins"] <= 100

    replay_play = _play(client, "photo", photo_id).json()
    assert replay_play["firstPlay"] is False
    assert replay_play["rewardsEnabled"] is False

    replay = _start_hand(client, photo_id)
    assert replay["rewardsEnabled"] is False
    practice = _claim(client, replay["handId"])
    assert practice["coins"] == 0
    assert practice["practice"] is True
    assert practice["wallet"]["coins"] == WELCOME_COINS + claim["coins"]


def test_lost_purchase_response_retry_keeps_rewarded_hand(client):
    """Client dropped the buy response and POSTed again before any hand started."""
    register_and_login(client)
    _, photo_id = _create_cards(photo_price=3)
    assert _play(client, "photo", photo_id).status_code == 200

    retry = _play(client, "photo", photo_id).json()
    assert retry["firstPlay"] is False
    assert retry["pricePaid"] == 0
    assert retry["rewardsEnabled"] is True
    assert retry["wallet"]["diamonds"] == WELCOME_DIAMONDS - 3

    hand = _start_hand(client, photo_id)
    assert hand["rewardsEnabled"] is True
    assert _claim(client, hand["handId"])["coins"] > 0


def test_unbought_priced_photo_card_gets_practice_hand(client):
    register_and_login(client)
    _, photo_id = _create_cards(photo_price=2)

    hand = _start_hand(client, photo_id)
    assert hand["rewardsEnabled"] is False
    assert _claim(client, hand["handId"])["coins"] == 0
    played = client.get("/api/me/cards/played").json()["played"]
    assert all(p["cardId"] != photo_id for p in played)


def test_free_motion_card_registers_on_first_hand(client):
    register_and_login(client)
    motion_id, _ = _create_cards(photo_price=None)

    first = _start_hand(client, motion_id)
    assert first["rewardsEnabled"] is True
    second = _start_hand(client, motion_id)
    assert second["rewardsEnabled"] is False

    played = client.get("/api/me/cards/played").json()["played"]
    assert [(p["cardKind"], p["cardId"], p["pricePaid"]) for p in played] == [
        ("motion", motion_id, 0)
    ]


def test_cardless_hand_mints_nothing(client):
    register_and_login(client)
    response = client.post("/api/rewards/scratch/hands", json={})
    assert response.status_code == 200
    assert response.json()["rewardsEnabled"] is False
    assert _claim(client, response.json()["handId"])["coins"] == 0


def test_unknown_card_ids_do_not_mint_coins(client):
    """Forged ids must not become free cards. Each one used to mint a coins hand,
    and those coins exchange 1:1 for diamonds at the x100 store rate.
    """
    register_and_login(client)
    before = client.get("/api/me/wallet").json()

    for _ in range(3):
        hand = _start_hand(client, f"forged-{uuid.uuid4().hex}")
        assert hand["rewardsEnabled"] is False
        assert hand["currency"] == "coins"
        assert hand["milestonesRemaining"] == 0
        claim = _claim(client, hand["handId"])
        assert claim["coins"] == 0
        assert claim["practice"] is True

    photo = _start_hand(client, f"forged-{uuid.uuid4().hex[:8]}_slot_01")
    assert photo["rewardsEnabled"] is False
    assert _claim(client, photo["handId"])["coins"] == 0

    assert client.get("/api/me/wallet").json() == before
    assert client.get("/api/me/cards/played").json()["played"] == []


def test_played_list_requires_auth(client):
    assert client.get("/api/me/cards/played").status_code == 401
    assert _play(client, "motion", "anything").status_code == 401


def _wait_for_wallet_waiter(db: Session, box: dict, thread: Thread) -> int:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not thread.is_alive() and "result" in box:
            raise AssertionError(f"work finished without waiting on the wallet: {box['result']}")
        if "error" in box and not thread.is_alive():
            raise AssertionError(f"work failed before waiting on the wallet: {box['error']}")
        pid = db.execute(
            text(
                """
                SELECT pid
                FROM pg_stat_activity
                WHERE pid <> pg_backend_pid()
                  AND wait_event_type = 'Lock'
                  AND query ILIKE '%wallets%'
                LIMIT 1
                """
            )
        ).scalar()
        if pid is not None:
            return int(pid)
        time.sleep(0.02)
    raise AssertionError("timed out waiting for a wallet lock")


def _holds_granted_tuple_lock(db: Session, pid: int, relation: str) -> bool:
    return (
        db.execute(
            text(
                """
                SELECT 1
                FROM pg_locks
                WHERE pid = :pid
                  AND relation = CAST(:relation AS regclass)
                  AND locktype = 'tuple'
                  AND granted
                """
            ),
            {"pid": pid, "relation": relation},
        ).first()
        is not None
    )


def _run_while_wallet_held(user_id: uuid.UUID, relation: str, work):
    """Hold the wallet lock and assert `work` blocks on it before locking `relation`."""
    holder = Session(get_engine())
    thread: Thread | None = None
    box: dict = {}

    def target() -> None:
        session = Session(get_engine())
        try:
            box["result"] = work(session)
            session.commit()
        except Exception as exc:
            session.rollback()
            box["error"] = exc
        finally:
            session.close()

    try:
        ensure_wallet(holder, user_id)
        thread = Thread(target=target)
        thread.start()
        pid = _wait_for_wallet_waiter(holder, box, thread)
        assert not _holds_granted_tuple_lock(holder, pid, relation)
    finally:
        holder.rollback()
        holder.close()
        if thread is not None:
            thread.join(timeout=5)
    assert thread is not None and not thread.is_alive()
    assert "error" not in box, box.get("error")
    return box["result"]


def test_replay_locks_wallet_before_played_row(client):
    _, user = register_and_login(client)
    user_id = uuid.UUID(user["id"])
    motion_id, _photo_id = _create_cards(photo_price=0)
    assert _play(client, "motion", motion_id).status_code == 200

    def replay(session: Session):
        result = register_play(session, user_id, "motion", motion_id, CardTerms(price=0))
        return result.charged, result.row.play_count

    charged, play_count = _run_while_wallet_held(user_id, "user_cards_played", replay)
    assert charged == 0
    assert play_count == 2


def test_scratch_claim_locks_wallet_before_hand(client):
    _, user = register_and_login(client)
    user_id = uuid.UUID(user["id"])
    motion_id, _photo_id = _create_cards(photo_price=0)
    assert _play(client, "motion", motion_id).status_code == 200
    hand_id = _start_hand(client, motion_id)["handId"]

    def claim(session: Session):
        row = session.get(User, user_id)
        assert row is not None
        return claim_scratch_coins(ScratchCoinsBody(handId=hand_id, milestone=1), session, row)

    result = _run_while_wallet_held(user_id, "scratch_coin_hands", claim)
    assert result["ok"] is True
    assert result["coins"] > 0


def test_auth_lookup_does_not_keep_user_row_dirty(client):
    _, user = register_and_login(client)
    user_id = uuid.UUID(user["id"])
    token = client.cookies.get(COOKIE_NAME)
    assert token
    stale = datetime.now(timezone.utc) - timedelta(seconds=LAST_SEEN_TOUCH_SECONDS + 30)
    with Session(get_engine()) as db:
        row = db.get(User, user_id)
        assert row is not None
        row.last_seen_at = stale
        db.commit()

    with Session(get_engine()) as db:
        loaded = get_user_from_token(db, token)
        assert loaded is not None
        assert loaded not in db.dirty
        db.commit()

    with Session(get_engine()) as db:
        seen = db.get(User, user_id)
        assert seen is not None and seen.last_seen_at is not None
        assert seen.last_seen_at > stale + timedelta(seconds=LAST_SEEN_TOUCH_SECONDS)
