from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from backend.auth.sessions import current_user
from backend.db.engine import get_session
from backend.db.models import User, WalletTransaction
from backend.db.wallet import ensure_wallet

router = APIRouter(prefix="/api/me/wallet", tags=["wallet"])


@router.get("")
def get_wallet(db: Annotated[Session, Depends(get_session)], user: Annotated[User, Depends(current_user)]):
    wallet = ensure_wallet(db, user.id)
    return {"diamonds": wallet.diamonds, "coins": wallet.coins}


@router.get("/transactions")
def list_transactions(db: Annotated[Session, Depends(get_session)], user: Annotated[User, Depends(current_user)]):
    rows = (
        db.query(WalletTransaction)
        .filter(WalletTransaction.user_id == user.id)
        .order_by(WalletTransaction.created_at.desc())
        .limit(100)
        .all()
    )
    return {
        "transactions": [
            {
                "id": str(row.id),
                "currency": row.currency,
                "delta": row.delta,
                "balanceAfter": row.balance_after,
                "reason": row.reason,
                "createdAt": row.created_at.isoformat(),
            }
            for row in rows
        ]
    }
