from __future__ import annotations

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.auth.sessions import current_user
from backend.db.engine import get_session
from backend.db.models import (
    Pack,
    PackInstance,
    PackOpening,
    PackOpeningCard,
    PackPurchase,
    User,
    UserCard,
    utcnow,
)
from backend.db.wallet import InsufficientFunds, apply_delta, ensure_wallet

router = APIRouter(tags=["packs"])

RARITIES: list[str] = ["Rare", "Rare", "Super Rare", "Rare", "Ultra Rare"]


class PurchaseBody(BaseModel):
    quantity: Literal[1, 5] = 1


class OpeningPatch(BaseModel):
    stage: str | None = None
    card_index: int | None = Field(default=None, ge=0)


def _pack_public(pack: Pack) -> dict:
    return {
        "id": pack.id,
        "modelId": pack.model_id,
        "themeId": pack.theme_id,
        "name": pack.name,
        "packTitle": pack.pack_title,
        "coverUrl": pack.cover_url,
        "diamondCost": pack.diamond_cost,
        "cardCount": pack.card_count,
        "isNew": pack.is_new,
        "isLimited": pack.is_limited,
        "isHot": pack.is_hot,
        "available": pack.available,
        "sortOrder": pack.sort_order,
    }


def _instance_public(inst: PackInstance, pack: Pack | None) -> dict:
    pack = pack or Pack(id=inst.pack_id, name=inst.pack_id, pack_title=inst.pack_id)
    return {
        "instanceId": str(inst.id),
        "catalogPackId": inst.pack_id,
        "packName": pack.pack_title,
        "creator": pack.name,
        "creatorId": pack.model_id or pack.id,
        "themeName": pack.pack_title,
        "coverUrl": pack.cover_url or "",
        "status": inst.status,
        "purchaseId": str(inst.pack_purchase_id),
        "savedAt": int(inst.created_at.timestamp() * 1000),
    }


def _opening_session(opening: PackOpening, cards: list[PackOpeningCard], quantity: int) -> dict:
    return {
        "quantity": 1 if quantity == 1 else 5,
        "diamondCost": opening.diamond_cost,
        "cards": [
            {
                "id": str(card.id),
                "rarity": card.rarity,
                "reward": card.reward_diamonds,
                "faceUrl": card.face_url,
            }
            for card in sorted(cards, key=lambda c: c.slot_index)
        ],
        "foilFaceUrl": opening.foil_face_url,
        "foilLabel": opening.foil_label,
    }


def _deal_cards(opening: PackOpening, pack: Pack) -> list[PackOpeningCard]:
    count = pack.card_count if pack.card_count else 3
    rows: list[PackOpeningCard] = []
    for index in range(count):
        rows.append(
            PackOpeningCard(
                opening_id=opening.id,
                slot_index=index,
                card_kind="motion" if index == 0 else "photo",
                card_id=f"{pack.id}-card-{index + 1}",
                rarity=RARITIES[index] if index < len(RARITIES) else "Rare",
                reward_diamonds=50 if index == count - 1 else 10 + index * 5,
                reveal_status="unscratched",
            )
        )
    return rows


@router.get("/api/packs")
def list_packs(db: Annotated[Session, Depends(get_session)]):
    rows = db.query(Pack).filter(Pack.available.is_(True)).order_by(Pack.sort_order).all()
    return {"packs": [_pack_public(p) for p in rows]}


@router.post("/api/packs/{pack_id}/purchase")
def purchase_pack(
    pack_id: str,
    body: PurchaseBody,
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
):
    pack = db.get(Pack, pack_id)
    if pack is None or not pack.available:
        raise HTTPException(status_code=404, detail="Pack not found.")
    key = idempotency_key or f"pack-buy:{user.id}:{pack_id}:{utcnow().isoformat()}"
    existing = db.query(PackPurchase).filter(PackPurchase.idempotency_key == key).one_or_none()
    if existing:
        instances = db.query(PackInstance).filter(PackInstance.pack_purchase_id == existing.id).all()
        wallet = ensure_wallet(db, user.id)
        return {
            "purchaseId": str(existing.id),
            "instances": [_instance_public(i, pack) for i in instances],
            "wallet": {"diamonds": wallet.diamonds, "coins": wallet.coins},
        }

    unit = pack.diamond_cost
    cost = unit if body.quantity == 1 else unit * 3
    try:
        apply_delta(
            db,
            user_id=user.id,
            currency="diamonds",
            delta=-cost,
            reason="pack_purchase",
            idempotency_key=f"{key}:spend",
            ref_type="pack_purchase",
            ref_id=pack_id,
        )
    except InsufficientFunds:
        raise HTTPException(status_code=400, detail="insufficient")

    purchase = PackPurchase(
        user_id=user.id,
        pack_id=pack.id,
        quantity=body.quantity,
        diamond_cost=cost,
        idempotency_key=key,
    )
    db.add(purchase)
    db.flush()
    instances: list[PackInstance] = []
    for _ in range(body.quantity):
        inst = PackInstance(user_id=user.id, pack_id=pack.id, pack_purchase_id=purchase.id, status="unopened")
        db.add(inst)
        instances.append(inst)
    db.flush()
    wallet = ensure_wallet(db, user.id)
    return {
        "purchaseId": str(purchase.id),
        "instances": [_instance_public(i, pack) for i in instances],
        "wallet": {"diamonds": wallet.diamonds, "coins": wallet.coins},
    }


@router.get("/api/me/packs")
def list_my_packs(db: Annotated[Session, Depends(get_session)], user: Annotated[User, Depends(current_user)]):
    instances = (
        db.query(PackInstance)
        .filter(PackInstance.user_id == user.id)
        .order_by(PackInstance.created_at.desc())
        .all()
    )
    packs = {p.id: p for p in db.query(Pack).all()}
    return {"packs": [_instance_public(i, packs.get(i.pack_id)) for i in instances]}


@router.post("/api/me/packs/{instance_id}/open")
def open_pack(
    instance_id: str,
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
):
    inst = db.get(PackInstance, instance_id)
    if inst is None or inst.user_id != user.id:
        raise HTTPException(status_code=404, detail="Pack not found.")
    pack = db.get(Pack, inst.pack_id)
    if pack is None:
        raise HTTPException(status_code=404, detail="Pack catalog missing.")
    opening = db.query(PackOpening).filter(PackOpening.pack_instance_id == inst.id).one_or_none()
    if opening is None:
        inst.status = "opened"
        inst.opened_at = utcnow()
        opening = PackOpening(pack_instance_id=inst.id, stage="ready", diamond_cost=pack.diamond_cost)
        db.add(opening)
        db.flush()
        db.add_all(_deal_cards(opening, pack))
        db.flush()
    cards = db.query(PackOpeningCard).filter(PackOpeningCard.opening_id == opening.id).all()
    return {
        "instance": _instance_public(inst, pack),
        "openingId": str(opening.id),
        "stage": opening.stage,
        "cardIndex": opening.card_index,
        "session": _opening_session(opening, cards, 1),
        "scratched": [str(c.id) for c in cards if c.reveal_status == "revealed"],
    }


@router.patch("/api/me/openings/{opening_id}")
def patch_opening(
    opening_id: str,
    body: OpeningPatch,
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
):
    opening = db.get(PackOpening, opening_id)
    if opening is None:
        raise HTTPException(status_code=404, detail="Opening not found.")
    inst = db.get(PackInstance, opening.pack_instance_id)
    if inst is None or inst.user_id != user.id:
        raise HTTPException(status_code=404, detail="Opening not found.")
    if body.stage:
        opening.stage = body.stage
        if body.stage == "complete":
            opening.completed_at = utcnow()
    if body.card_index is not None:
        opening.card_index = body.card_index
    opening.updated_at = utcnow()
    return {"ok": True, "stage": opening.stage, "cardIndex": opening.card_index}


@router.post("/api/me/openings/{opening_id}/cards/{card_id}/reveal")
def reveal_card(
    opening_id: str,
    card_id: str,
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
):
    opening = db.get(PackOpening, opening_id)
    if opening is None:
        raise HTTPException(status_code=404, detail="Opening not found.")
    inst = db.get(PackInstance, opening.pack_instance_id)
    if inst is None or inst.user_id != user.id:
        raise HTTPException(status_code=404, detail="Opening not found.")
    card = db.get(PackOpeningCard, card_id)
    if card is None or card.opening_id != opening.id:
        raise HTTPException(status_code=404, detail="Card not found.")
    pack = db.get(Pack, inst.pack_id)
    if card.reveal_status != "revealed":
        card.reveal_status = "revealed"
        card.revealed_at = utcnow()
        if card.reward_diamonds:
            apply_delta(
                db,
                user_id=user.id,
                currency="diamonds",
                delta=card.reward_diamonds,
                reason="pack_reward",
                idempotency_key=f"reveal:{card.id}",
                ref_type="pack_opening_card",
                ref_id=str(card.id),
            )
        existing = (
            db.query(UserCard)
            .filter(
                UserCard.user_id == user.id,
                UserCard.card_kind == card.card_kind,
                UserCard.card_id == card.card_id,
                UserCard.photo_slot_id == card.photo_slot_id,
            )
            .one_or_none()
        )
        if existing:
            existing.duplicates += 1
        else:
            db.add(
                UserCard(
                    user_id=user.id,
                    card_kind=card.card_kind,
                    card_id=card.card_id,
                    photo_slot_id=card.photo_slot_id,
                    model_id=pack.model_id if pack else None,
                    theme_id=pack.theme_id if pack else None,
                    rarity=card.rarity,
                    source_opening_card_id=card.id,
                )
            )
    cards = db.query(PackOpeningCard).filter(PackOpeningCard.opening_id == opening.id).all()
    return {
        "card": {"id": str(card.id), "revealStatus": card.reveal_status, "reward": card.reward_diamonds},
        "scratched": [str(c.id) for c in cards if c.reveal_status == "revealed"],
        "wallet": {"diamonds": ensure_wallet(db, user.id).diamonds, "coins": ensure_wallet(db, user.id).coins},
    }
