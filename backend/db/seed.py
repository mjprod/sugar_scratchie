from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import select

from backend.db import engine as db_engine
from backend.db.models import InboxMessage, Pack, RedeemCode, StoreProduct

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "public"


def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def seed() -> None:
    db_engine.get_engine()
    assert db_engine.SessionLocal is not None
    session = db_engine.SessionLocal()
    try:
        products = [
            StoreProduct(
                id="ad-daily",
                kind="rewarded-ad",
                title="Watch Ad",
                subtitle="Earn 100 free Diamonds",
                price_label="Free",
                diamonds=100,
                coins=5,
                badge="FREE",
                sort_order=1,
                available=True,
            ),
            StoreProduct(
                id="d100",
                kind="diamonds",
                title="100 Diamonds",
                price_label="$3.99",
                price_amount_cents=399,
                diamonds=100,
                coins=0,
                sort_order=2,
                available=True,
            ),
            StoreProduct(
                id="d500",
                kind="diamonds",
                title="500 Diamonds",
                price_label="$7.99",
                price_amount_cents=799,
                diamonds=500,
                coins=0,
                badge="Popular",
                sort_order=3,
                available=True,
            ),
            StoreProduct(
                id="d1200",
                kind="diamonds",
                title="1200 Diamonds",
                price_label="$19.99",
                price_amount_cents=1999,
                diamonds=1200,
                coins=0,
                badge="Best Value",
                sort_order=4,
                available=True,
            ),
            StoreProduct(
                id="d2500",
                kind="diamonds",
                title="2500 Diamonds",
                price_label="$39.99",
                price_amount_cents=3999,
                diamonds=2500,
                coins=0,
                badge="Bonus",
                sort_order=5,
                available=True,
            ),
            StoreProduct(
                id="d5000",
                kind="diamonds",
                title="5000 Diamonds",
                price_label="$69.99",
                price_amount_cents=6999,
                diamonds=5000,
                coins=0,
                sort_order=6,
                available=True,
            ),
        ]
        for product in products:
            existing = session.get(StoreProduct, product.id)
            if existing is None:
                session.add(product)
            else:
                existing.kind = product.kind
                existing.title = product.title
                existing.subtitle = product.subtitle
                existing.price_label = product.price_label
                existing.price_amount_cents = product.price_amount_cents
                existing.diamonds = product.diamonds
                existing.coins = product.coins if product.coins is not None else 0
                existing.badge = product.badge
                existing.sort_order = product.sort_order
                existing.available = product.available

        from backend.models_store import ensure_models_bootstrapped, list_models
        from backend.themes_store import ensure_themes_bootstrapped

        ensure_themes_bootstrapped(session, PUBLIC / "themes")
        ensure_models_bootstrapped(session, PUBLIC / "models")
        catalog_models = list_models(session, PUBLIC / "models")

        cards = _load_json(PUBLIC / "cards" / "index.json").get("cards") or []
        cards_by_model: dict[str, list[dict]] = {}
        for card in cards:
            mid = card.get("model_id") or ""
            cards_by_model.setdefault(mid, []).append(card)

        for index, model in enumerate(catalog_models):
            model_id = model.id
            if not model_id:
                continue
            name = model.influencerName or model.label or model_id
            model_cards = cards_by_model.get(model_id) or []
            theme_id = None
            if model_cards:
                theme_id = model_cards[0].get("theme_id")
            pack_id = f"{model_id}-pack"
            existing = session.get(Pack, pack_id)
            pack = existing or Pack(id=pack_id)
            pack.model_id = model_id
            pack.theme_id = theme_id
            pack.name = name
            pack.pack_title = model.cardPackName or f"{name} Pack"
            pack.cover_url = model.avatar
            pack.diamond_cost = 80
            pack.card_count = 3
            pack.available = True
            pack.sort_order = index
            pack.is_new = index < 2
            pack.is_hot = index == 0
            if existing is None:
                session.add(pack)

        if session.get(Pack, "ep1") is None:
            session.add(
                Pack(
                    id="ep1",
                    name="Neon Rain",
                    pack_title="Neon Rain",
                    diamond_cost=80,
                    card_count=3,
                    available=True,
                    sort_order=100,
                )
            )

        codes = [
            RedeemCode(code="SUGAR2026", reward_kind="diamonds", diamonds=100, active=True),
            RedeemCode(code="BONUS50", reward_kind="diamonds", diamonds=50, active=True),
            RedeemCode(code="MINA-DROP", reward_kind="free_pack", pack_id="ep1", diamonds=0, active=True),
            RedeemCode(
                code="GONE2025",
                reward_kind="diamonds",
                diamonds=10,
                expires_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
                active=True,
            ),
            RedeemCode(code="LIMITED50", reward_kind="diamonds", diamonds=50, max_redemptions=0, active=False),
        ]
        for code in codes:
            if session.get(RedeemCode, code.code) is None:
                session.add(code)

        has_broadcast = session.scalar(select(InboxMessage.id).where(InboxMessage.user_id.is_(None)).limit(1))
        if has_broadcast is None:
            now = datetime.now(timezone.utc)
            session.add_all(
                [
                    InboxMessage(
                        type="account_system",
                        title="Welcome to Sugar Scratch",
                        subtitle="Verify your email to unlock purchases",
                        thumbnail={"kind": "icon", "icon": "bell"},
                        created_at=now,
                    ),
                    InboxMessage(
                        type="limited_expiring",
                        title="Limited Pack ends soon",
                        subtitle="Featured packs expire — check the store",
                        thumbnail={"kind": "icon", "icon": "gift"},
                        cta={"label": "View Pack", "action": "view_pack", "targetId": "ep1"},
                        created_at=now - timedelta(hours=2),
                    ),
                ]
            )

        session.commit()
        print("seed: ok")
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


if __name__ == "__main__":
    seed()
