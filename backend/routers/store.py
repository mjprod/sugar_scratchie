from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.auth.sessions import current_user
from backend.db.engine import get_session
from backend.db.models import StoreProduct, StorePurchase, User, utcnow
from backend.db.wallet import apply_delta, ensure_wallet

router = APIRouter(prefix="/api/store", tags=["store"])

GatewayOutcome = Literal["completed", "cancelled", "closed", "failed", "pending"]


class CreatePurchaseBody(BaseModel):
    product_id: str


class VerifyBody(BaseModel):
    outcome: GatewayOutcome = "completed"


def _product_public(p: StoreProduct) -> dict:
    return {
        "id": p.id,
        "kind": p.kind,
        "title": p.title,
        "subtitle": p.subtitle,
        "priceLabel": p.price_label,
        "diamonds": p.diamonds,
        "coins": p.coins,
        "badge": p.badge,
        "artworkUrl": p.artwork_url,
        "order": p.sort_order,
        "available": p.available,
    }


def _session_public(row: StorePurchase, product_title: str) -> dict:
    return {
        "id": str(row.id),
        "productId": row.product_id,
        "productTitle": product_title,
        "priceLabel": row.price_label,
        "diamonds": row.diamonds,
        "coins": row.coins,
        "createdAt": int(row.created_at.timestamp() * 1000),
        "gatewayOutcome": row.gateway_outcome,
        "verifiedStatus": row.verified_status,
        "credited": row.credited_at is not None,
    }


@router.get("/products")
def list_products(db: Annotated[Session, Depends(get_session)]):
    rows = db.query(StoreProduct).filter(StoreProduct.available.is_(True)).order_by(StoreProduct.sort_order).all()
    return {"products": [_product_public(p) for p in rows]}


@router.post("/purchases")
def create_purchase(
    body: CreatePurchaseBody,
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
):
    product = db.get(StoreProduct, body.product_id)
    if product is None or not product.available:
        raise HTTPException(status_code=404, detail="Product not found.")
    if product.kind != "diamonds":
        raise HTTPException(status_code=400, detail="Only paid products create a payment session.")
    row = StorePurchase(
        user_id=user.id,
        product_id=product.id,
        price_label=product.price_label,
        diamonds=product.diamonds,
        coins=product.coins,
        gateway="demo",
    )
    db.add(row)
    db.flush()
    return {"session": _session_public(row, product.title)}


@router.post("/purchases/{purchase_id}/verify")
def verify_purchase(
    purchase_id: str,
    body: VerifyBody,
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
):
    row = db.get(StorePurchase, purchase_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="Purchase not found.")
    product = db.get(StoreProduct, row.product_id)
    title = product.title if product else row.product_id
    row.gateway_outcome = body.outcome
    row.updated_at = utcnow()

    if body.outcome == "closed":
        return {"status": "closed", "session": _session_public(row, title)}
    if body.outcome == "cancelled":
        row.verified_status = "cancelled"
        return {"status": "cancelled", "session": _session_public(row, title), "diamonds": 0, "coins": 0}
    if body.outcome == "failed":
        row.verified_status = "failed"
        return {
            "status": "failed",
            "session": _session_public(row, title),
            "message": "Payment could not be verified. No Diamonds were added.",
        }
    if body.outcome == "pending":
        row.verified_status = "pending"
        return {"status": "pending", "session": _session_public(row, title)}

    if row.credited_at is not None:
        row.verified_status = "confirmed"
        return {"status": "confirmed", "session": _session_public(row, title), "diamonds": 0, "coins": 0}

    if row.diamonds:
        apply_delta(
            db,
            user_id=user.id,
            currency="diamonds",
            delta=row.diamonds,
            reason="store_purchase",
            idempotency_key=f"store:{row.id}:diamonds",
            ref_type="store_purchase",
            ref_id=str(row.id),
        )
    if row.coins:
        apply_delta(
            db,
            user_id=user.id,
            currency="coins",
            delta=row.coins,
            reason="store_purchase",
            idempotency_key=f"store:{row.id}:coins",
            ref_type="store_purchase",
            ref_id=str(row.id),
        )
    row.credited_at = utcnow()
    row.verified_status = "confirmed"
    wallet = ensure_wallet(db, user.id)
    return {
        "status": "confirmed",
        "session": _session_public(row, title),
        "diamonds": row.diamonds,
        "coins": row.coins,
        "wallet": {"diamonds": wallet.diamonds, "coins": wallet.coins},
    }


@router.post("/ads/{product_id}/claim")
def claim_ad(
    product_id: str,
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
):
    product = db.get(StoreProduct, product_id)
    if product is None or product.kind != "rewarded-ad" or not product.available:
        raise HTTPException(status_code=404, detail="Reward not available.")
    key = f"ad:{user.id}:{product.id}:{utcnow().date().isoformat()}"
    apply_delta(
        db,
        user_id=user.id,
        currency="diamonds",
        delta=product.diamonds,
        reason="store_purchase",
        idempotency_key=f"{key}:diamonds",
        ref_type="rewarded_ad",
        ref_id=product.id,
    )
    if product.coins:
        apply_delta(
            db,
            user_id=user.id,
            currency="coins",
            delta=product.coins,
            reason="store_purchase",
            idempotency_key=f"{key}:coins",
            ref_type="rewarded_ad",
            ref_id=product.id,
        )
    wallet = ensure_wallet(db, user.id)
    return {"status": "success", "diamonds": product.diamonds, "coins": product.coins, "wallet": {"diamonds": wallet.diamonds, "coins": wallet.coins}}
