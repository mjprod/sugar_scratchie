from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from backend.cards_store import _validate_tier
from backend.db.engine import get_engine
from backend.db.models import Creator, MotionCard, Pack, PhotoScratchCard, Theme, UserCard
from backend.db.wallet import apply_delta
from tests.conftest import register_and_login

GRANT = 1000


def _grant(user_id: str, diamonds: int = GRANT) -> None:
    with Session(get_engine()) as db:
        apply_delta(
            db,
            user_id=uuid.UUID(user_id),
            currency="diamonds",
            delta=diamonds,
            reason="admin_adjust",
            idempotency_key=f"test-grant:{uuid.uuid4().hex}",
        )
        db.commit()


def _creator_with_cards(*, photo_price: int = 5) -> dict[str, str]:
    """Creator + theme + standard card (2 photo slots) + premium card + ultra card + pack."""
    suffix = uuid.uuid4().hex[:8]
    ids = {
        "model": f"tiers_{suffix}",
        "theme": f"tiertheme_{suffix}",
        "standard": f"tiers_{suffix}_std",
        "premium": f"tiers_{suffix}_prem",
        "ultra": f"tiers_{suffix}_ultra",
        "pack": f"tiers_{suffix}-pack",
    }
    with Session(get_engine()) as db:
        db.add(Creator(id=ids["model"], label=f"Tiers {suffix}", instagram_url="https://instagram.com/x"))
        db.add(Theme(id=ids["theme"], label=f"Theme {suffix}"))
        db.flush()
        db.add_all(
            [
                MotionCard(
                    id=ids["standard"], label="Std", model_id=ids["model"], theme_id=ids["theme"], price=10
                ),
                MotionCard(
                    id=ids["premium"],
                    label="Prem",
                    model_id=ids["model"],
                    theme_id=ids["theme"],
                    tier="premium",
                    price=100,
                    replay_price=20,
                    max_win=200,
                ),
                MotionCard(
                    id=ids["ultra"],
                    label="Ultra",
                    model_id=ids["model"],
                    tier="ultra",
                    price=300,
                    replay_price=50,
                    max_win=7,
                ),
            ]
        )
        db.flush()
        for slot in ("slot_01", "slot_02"):
            db.add(
                PhotoScratchCard(
                    id=f"{ids['standard']}_{slot}",
                    card_id=ids["standard"],
                    slot_id=slot,
                    label=slot,
                    model_id=ids["model"],
                    theme_id=ids["theme"],
                    background="/bg.png",
                    bikini="/bikini.png",
                    clothes="/clothes.png",
                    mesh="/mesh.json",
                    card_price=photo_price,
                )
            )
        db.add(
            Pack(
                id=ids["pack"],
                model_id=ids["model"],
                theme_id=ids["theme"],
                name="Tiers",
                pack_title="Tiers Pack",
                diamond_cost=80,
                card_count=3,
                available=True,
            )
        )
        db.commit()
    return ids


@pytest.fixture
def card_media(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Point the card API at a temp `public/` and write placeholder clips for the given cards."""
    import backend.app as app_module

    cards_dir = tmp_path / "public" / "cards"
    mesh_dir = tmp_path / "public" / "mesh"
    mesh_dir.mkdir(parents=True)
    monkeypatch.setattr(app_module, "ROOT", tmp_path)
    monkeypatch.setattr(app_module, "CARDS_DIR", cards_dir)
    monkeypatch.setattr(app_module, "MESH_DIR", mesh_dir)

    def write(*card_ids: str) -> None:
        for card_id in card_ids:
            card_dir = cards_dir / card_id
            card_dir.mkdir(parents=True, exist_ok=True)
            for name in ("background.mp4", "foreground.mp4"):
                (card_dir / name).write_bytes(b"clip")

    return write


def _play(client, kind: str, card_id: str, *, free_play: bool = False):
    return client.post(
        "/api/me/cards/play", json={"cardKind": kind, "cardId": card_id, "freePlay": free_play}
    )


def _hand(client, card_id: str, *, free_play: bool = False) -> dict:
    response = client.post(
        "/api/rewards/scratch/hands", json={"cardId": card_id, "freePlay": free_play}
    )
    assert response.status_code == 200, response.text
    return response.json()


def _claim(client, hand_id: str, milestone: int) -> dict:
    response = client.post(
        "/api/rewards/scratch/coins", json={"handId": hand_id, "milestone": milestone}
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_premium_unlock_replay_and_diamond_payout_cap(client):
    _, user = register_and_login(client)
    _grant(user["id"])
    ids = _creator_with_cards()

    unlock = _play(client, "motion", ids["premium"]).json()
    assert unlock["firstPlay"] is True
    assert unlock["pricePaid"] == 100
    assert unlock["freePlayable"] is True

    retry = _play(client, "motion", ids["premium"]).json()
    assert retry["pricePaid"] == 0
    assert retry["rewardsEnabled"] is True

    hand = _hand(client, ids["premium"])
    assert hand["rewardsEnabled"] is True
    assert hand["currency"] == "diamonds"
    assert hand["maxWin"] == 200
    before = client.get("/api/me/wallet").json()
    paid = 0
    for milestone in range(1, 11):
        claim = _claim(client, hand["handId"], milestone)
        assert claim["currency"] == "diamonds"
        assert claim["coins"] == 0
        assert 16 <= claim["diamonds"] <= 20
        paid += claim["diamonds"]
    assert paid <= 200
    after = client.get("/api/me/wallet").json()
    assert after["diamonds"] == before["diamonds"] + paid
    assert after["coins"] == before["coins"]

    replay = _play(client, "motion", ids["premium"]).json()
    assert replay["firstPlay"] is False
    assert replay["pricePaid"] == 20
    assert replay["rewardsEnabled"] is True
    assert replay["wallet"]["diamonds"] == after["diamonds"] - 20
    assert _hand(client, ids["premium"])["rewardsEnabled"] is True


def test_diamond_hands_are_not_daily_limited(client):
    _, user = register_and_login(client)
    _grant(user["id"])
    ids = _creator_with_cards()

    for _ in range(30):
        assert _play(client, "motion", ids["premium"]).status_code == 200
        hand = _hand(client, ids["premium"])
        assert hand["currency"] == "diamonds"
        assert hand["rewardsEnabled"] is True


def test_ultra_payout_never_exceeds_small_max_win(client):
    _, user = register_and_login(client)
    _grant(user["id"])
    ids = _creator_with_cards()
    assert _play(client, "motion", ids["ultra"]).json()["pricePaid"] == 300

    hand = _hand(client, ids["ultra"])
    total = sum(_claim(client, hand["handId"], m)["diamonds"] for m in range(1, 11))
    assert total == 7


def test_diamond_payout_awards_max_win_remainder(client):
    _, user = register_and_login(client)
    _grant(user["id"])
    ids = _creator_with_cards()
    with Session(get_engine()) as db:
        db.get(MotionCard, ids["premium"]).max_win = 15
        db.commit()
    assert _play(client, "motion", ids["premium"]).json()["pricePaid"] == 100

    hand = _hand(client, ids["premium"])
    assert hand["maxWin"] == 15
    payouts = [_claim(client, hand["handId"], m)["diamonds"] for m in range(1, 11)]
    assert payouts == [2] * 5 + [1] * 5
    assert sum(payouts) == 15


def test_free_play_requires_purchase_and_never_charges(client):
    _, user = register_and_login(client)
    _grant(user["id"])
    ids = _creator_with_cards(photo_price=5)
    photo_id = f"{ids['standard']}_slot_01"

    locked = _play(client, "photo", photo_id, free_play=True)
    assert locked.status_code == 403
    assert locked.json()["detail"] == "free_play_locked"

    bought = _play(client, "photo", photo_id).json()
    assert bought["pricePaid"] == 5
    balance = bought["wallet"]["diamonds"]

    free = _play(client, "photo", photo_id, free_play=True).json()
    assert free["pricePaid"] == 0
    assert free["rewardsEnabled"] is False
    assert free["wallet"]["diamonds"] == balance

    practice = _hand(client, photo_id, free_play=True)
    assert practice["rewardsEnabled"] is False
    # The purchased hand is still available after a free-play launch.
    assert _hand(client, photo_id)["rewardsEnabled"] is True


def test_pack_owned_card_plays_free_and_is_free_playable(client):
    _, user = register_and_login(client)
    ids = _creator_with_cards(photo_price=5)
    photo_id = f"{ids['standard']}_slot_02"
    with Session(get_engine()) as db:
        db.add(
            UserCard(
                user_id=uuid.UUID(user["id"]),
                card_kind="photo",
                card_id=photo_id,
                photo_slot_id="slot_02",
                model_id=ids["model"],
            )
        )
        db.commit()

    assert _play(client, "photo", photo_id, free_play=True).status_code == 403
    first = _play(client, "photo", photo_id).json()
    assert first["firstPlay"] is True
    assert first["pricePaid"] == 0
    assert first["freePlayable"] is True
    assert _play(client, "photo", photo_id, free_play=True).status_code == 200


def test_pack_opening_deals_real_standard_cards(client):
    _, user = register_and_login(client)
    _grant(user["id"])
    ids = _creator_with_cards()

    bought = client.post(
        f"/api/packs/{ids['pack']}/purchase",
        json={"quantity": 1},
        headers={"Idempotency-Key": f"test-tiers-{uuid.uuid4().hex}"},
    )
    assert bought.status_code == 200, bought.text
    instance_id = bought.json()["instances"][0]["instanceId"]
    opened = client.post(f"/api/me/packs/{instance_id}/open").json()
    cards = opened["session"]["cards"]
    assert cards[0]["cardKind"] == "motion"
    assert cards[0]["cardId"] == ids["standard"]
    photo_ids = {f"{ids['standard']}_slot_01", f"{ids['standard']}_slot_02"}
    assert {c["cardId"] for c in cards[1:]} == photo_ids
    assert {c["photoSlotId"] for c in cards[1:]} == {"slot_01", "slot_02"}

    for card in cards:
        client.post(f"/api/me/openings/{opened['openingId']}/cards/{card['id']}/reveal")

    board = client.get(f"/api/me/creators/{ids['model']}/board").json()
    standard = board["themes"][0]["motionCards"][0]
    assert standard["id"] == ids["standard"]
    assert standard["status"] == "unlocked"
    assert standard["staticCardsOwned"] == 2
    assert standard["staticCardsTotal"] == 2
    assert board["motionCardsOwned"] == 1


def test_board_shape(client):
    _, user = register_and_login(client)
    _grant(user["id"])
    ids = _creator_with_cards(photo_price=5)
    assert _play(client, "photo", f"{ids['standard']}_slot_01").status_code == 200

    response = client.get(f"/api/me/creators/{ids['model']}/board")
    assert response.status_code == 200, response.text
    board = response.json()
    assert board["creator"]["id"] == ids["model"]
    assert board["creator"]["instagramUrl"] == "https://instagram.com/x"
    assert board["creator"]["joinedAt"] > 0
    assert board["pack"] == {"id": ids["pack"], "price": 80, "priceAmountCents": None}

    [theme] = board["themes"]
    assert theme["id"] == ids["theme"]
    [standard] = theme["motionCards"]
    assert standard["price"] == 10
    assert standard["status"] == "locked"
    assert standard["forSale"] is True
    assert standard["staticCardsTotal"] == 2
    statics = {s["id"]: s for s in standard["staticCards"]}
    bought = statics[f"{ids['standard']}_slot_01"]
    assert bought["price"] == 5
    assert bought["unlocked"] is True
    assert bought["forSale"] is True
    assert bought["freePlayable"] is True
    assert statics[f"{ids['standard']}_slot_02"]["freePlayable"] is False

    premium = theme["premium"]
    assert premium["id"] == ids["premium"]
    assert premium["unlocked"] is False
    assert (premium["price"], premium["replayPrice"], premium["maxWin"]) == (100, 20, 200)

    ultra = board["ultra"]
    assert ultra["id"] == ids["ultra"]
    assert (ultra["price"], ultra["replayPrice"], ultra["maxWin"]) == (300, 50, 7)


def test_board_unknown_creator_404(client):
    register_and_login(client)
    assert client.get("/api/me/creators/nobody_here/board").status_code == 404


def test_tier_validation(db_session):
    ids = _creator_with_cards()
    second_premium = MotionCard(
        id=f"{ids['model']}_prem2",
        label="Prem 2",
        model_id=ids["model"],
        theme_id=ids["theme"],
        tier="premium",
    )
    with pytest.raises(HTTPException) as clash:
        _validate_tier(db_session, second_premium)
    assert clash.value.status_code == 409

    second_ultra = MotionCard(id=f"{ids['model']}_ultra2", label="U2", model_id=ids["model"], tier="ultra")
    with pytest.raises(HTTPException) as clash:
        _validate_tier(db_session, second_ultra)
    assert clash.value.status_code == 409

    themeless = MotionCard(id=f"{ids['model']}_p3", label="P3", model_id=ids["model"], tier="premium")
    with pytest.raises(HTTPException) as missing:
        _validate_tier(db_session, themeless)
    assert missing.value.status_code == 400


def test_detaching_tiered_cards_demotes_to_standard(client, dashboard_headers, card_media):
    ids = _creator_with_cards()
    card_media(ids["standard"], ids["premium"], ids["ultra"])

    def put(key: str, body: dict):
        return client.put(f"/api/cards/{ids[key]}", json=body, headers=dashboard_headers)

    ultra = put("ultra", {"model_id": ""})
    assert ultra.status_code == 200, ultra.text
    assert (ultra.json()["model_id"], ultra.json()["tier"]) == (None, "standard")

    premium = put("premium", {"theme_id": ""})
    assert premium.status_code == 200, premium.text
    assert (premium.json()["theme_id"], premium.json()["tier"]) == (None, "standard")

    assert put("standard", {"model_id": "", "tier": "ultra"}).status_code == 400


def test_standard_cards_never_charge_replays(client, dashboard_headers, card_media):
    ids = _creator_with_cards()
    card_media(ids["premium"])
    downgraded = client.put(
        f"/api/cards/{ids['premium']}",
        json={"tier": "standard", "price": 100, "replay_price": 20, "max_win": 200},
        headers=dashboard_headers,
    )
    assert downgraded.status_code == 200, downgraded.text
    card = downgraded.json()
    assert (card["tier"], card["replay_price"], card["max_win"]) == ("standard", 0, 0)

    legacy_id = f"{ids['model']}_legacy"
    with Session(get_engine()) as db:
        db.add(MotionCard(id=legacy_id, label="Legacy", model_id=ids["model"], price=10, replay_price=20))
        db.commit()

    _, user = register_and_login(client)
    _grant(user["id"])
    for card_id in (ids["premium"], legacy_id):
        assert _play(client, "motion", card_id).json()["firstPlay"] is True
        hand = _hand(client, card_id)
        _claim(client, hand["handId"], 1)
        replay = _play(client, "motion", card_id).json()
        assert replay["pricePaid"] == 0


def test_model_social_links_round_trip(client, dashboard_headers):
    suffix = uuid.uuid4().hex[:8]
    model_id = f"socials_{suffix}"
    with Session(get_engine()) as db:
        db.add(Creator(id=model_id, label=f"Socials {suffix}"))
        db.commit()

    response = client.put(
        f"/api/models/{model_id}",
        json={"tiktokUrl": " https://tiktok.com/@x ", "onlyfansUrl": "https://onlyfans.com/x"},
        headers=dashboard_headers,
    )
    assert response.status_code == 200, response.text
    model = response.json()
    assert model["tiktokUrl"] == "https://tiktok.com/@x"
    assert model["onlyfansUrl"] == "https://onlyfans.com/x"
    assert model["instagramUrl"] is None


def test_default_modal_flag_requires_own_card(client, dashboard_headers):
    suffix = uuid.uuid4().hex[:8]
    model_a = f"dma_{suffix}"
    model_b = f"dmb_{suffix}"
    card_a = f"{model_a}_card"
    card_b = f"{model_b}_card"
    with Session(get_engine()) as db:
        db.add_all(
            [
                Creator(id=model_a, label=f"DMA {suffix}"),
                Creator(id=model_b, label=f"DMB {suffix}"),
            ]
        )
        db.flush()
        db.add_all(
            [
                MotionCard(id=card_a, label="A", model_id=model_a),
                MotionCard(id=card_b, label="B", model_id=model_b),
            ]
        )
        db.commit()

    listed = client.get("/api/models", headers=dashboard_headers)
    assert listed.status_code == 200
    assert "lpPublicUrl" in listed.json()

    foreign = client.put(
        f"/api/models/{model_a}",
        json={"defaultModal": True, "defaultModalCardId": card_b},
        headers=dashboard_headers,
    )
    assert foreign.status_code == 422
    assert "does not belong" in foreign.json()["detail"]

    missing = client.put(
        f"/api/models/{model_a}",
        json={"defaultModal": True},
        headers=dashboard_headers,
    )
    assert missing.status_code == 422
    assert "motion card" in missing.json()["detail"].lower()

    added = client.put(
        f"/api/models/{model_a}",
        json={"defaultModal": True, "defaultModalCardId": card_a},
        headers=dashboard_headers,
    )
    assert added.status_code == 200, added.text
    body = added.json()
    assert body["defaultModal"] is True
    assert body["defaultModalCardId"] == card_a

    removed = client.put(
        f"/api/models/{model_a}",
        json={"defaultModal": False},
        headers=dashboard_headers,
    )
    assert removed.status_code == 200, removed.text
    assert removed.json()["defaultModal"] is False
    assert removed.json()["defaultModalCardId"] is None


def test_default_modal_cleared_when_demo_card_deleted_or_reassigned(
    db_session, tmp_path: Path
):
    from backend.cards import UpdateCardRequest
    from backend.cards_store import delete_card, update_card

    suffix = uuid.uuid4().hex[:8]
    model_a = f"dmd_{suffix}"
    model_b = f"dme_{suffix}"
    card_id = f"dmdcard_{suffix}"
    cards_dir = tmp_path / "cards"
    mesh_dir = tmp_path / "mesh"
    card_dir = cards_dir / card_id
    card_dir.mkdir(parents=True)
    mesh_dir.mkdir(parents=True)
    (card_dir / "background.mp4").write_bytes(b"x")
    (card_dir / "foreground.mp4").write_bytes(b"x")

    db_session.add_all(
        [
            Creator(id=model_a, label=f"DMD {suffix}"),
            Creator(id=model_b, label=f"DME {suffix}"),
        ]
    )
    db_session.flush()
    db_session.add(MotionCard(id=card_id, label="Demo", model_id=model_a))
    owner = db_session.get(Creator, model_a)
    assert owner is not None
    owner.default_modal = True
    owner.default_modal_card_id = card_id
    db_session.commit()

    update_card(
        db_session,
        tmp_path,
        cards_dir,
        mesh_dir,
        card_id,
        UpdateCardRequest(model_id=model_b),
    )
    db_session.commit()
    owner = db_session.get(Creator, model_a)
    assert owner is not None
    assert owner.default_modal is False
    assert owner.default_modal_card_id is None

    card = db_session.get(MotionCard, card_id)
    assert card is not None
    card.model_id = model_a
    owner.default_modal = True
    owner.default_modal_card_id = card_id
    db_session.commit()

    delete_card(db_session, tmp_path, cards_dir, mesh_dir, card_id)
    db_session.commit()
    owner = db_session.get(Creator, model_a)
    assert owner is not None
    assert owner.default_modal is False
    assert owner.default_modal_card_id is None
