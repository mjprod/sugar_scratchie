from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from backend.auth.sessions import current_user
from backend.db.engine import get_session
from backend.db.models import InboxMessage, InboxRead, User, utcnow

router = APIRouter(prefix="/api/inbox", tags=["inbox"])


def _public(msg: InboxMessage, read_ids: set) -> dict:
    return {
        "id": str(msg.id),
        "type": msg.type,
        "title": msg.title,
        "subtitle": msg.subtitle,
        "timestamp": msg.created_at.isoformat(),
        "isRead": msg.id in read_ids,
        "thumbnail": msg.thumbnail,
        "cta": msg.cta,
        "creatorId": msg.creator_id,
    }


@router.get("")
def list_inbox(db: Annotated[Session, Depends(get_session)], user: Annotated[User, Depends(current_user)]):
    now = utcnow()
    rows = (
        db.query(InboxMessage)
        .filter(
            or_(InboxMessage.user_id == user.id, InboxMessage.user_id.is_(None)),
            or_(InboxMessage.expires_at.is_(None), InboxMessage.expires_at > now),
        )
        .order_by(InboxMessage.created_at.desc())
        .all()
    )
    reads = db.query(InboxRead).filter(InboxRead.user_id == user.id).all()
    read_ids = {r.message_id for r in reads}
    return {"messages": [_public(m, read_ids) for m in rows]}


@router.post("/{message_id}/read")
def mark_read(
    message_id: str,
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
):
    msg = db.get(InboxMessage, message_id)
    if msg is None:
        raise HTTPException(status_code=404, detail="Message not found.")
    existing = db.get(InboxRead, {"user_id": user.id, "message_id": msg.id})
    if existing is None:
        db.add(InboxRead(user_id=user.id, message_id=msg.id))
    return {"ok": True}


@router.post("/read-all")
def read_all(db: Annotated[Session, Depends(get_session)], user: Annotated[User, Depends(current_user)]):
    rows = (
        db.query(InboxMessage)
        .filter(or_(InboxMessage.user_id == user.id, InboxMessage.user_id.is_(None)))
        .all()
    )
    reads = {r.message_id for r in db.query(InboxRead).filter(InboxRead.user_id == user.id).all()}
    for msg in rows:
        if msg.id not in reads:
            db.add(InboxRead(user_id=user.id, message_id=msg.id))
    return {"ok": True}
