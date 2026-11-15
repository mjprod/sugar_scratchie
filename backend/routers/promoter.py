"""Public invite check and pre-influencer confirm for the join page.

The bearer token stays on the server. The page only learns whether the
manager's code is still open. Confirm upserts pre_influencers and notifies
MJ Promoter. Order landing page is called by MJ Promoter with an internal token.
"""

from __future__ import annotations

import os
import re
import secrets
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.db.engine import get_session
from backend.db.models import PreInfluencer, utcnow
from backend.services.promoter import build_landing_page_url, lookup_invite, notify_step

router = APIRouter(prefix="/api/promoter", tags=["promoter"])

_CODE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_SLUG = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


class ConfirmPreInfluencerBody(BaseModel):
    invite_code: str = Field(min_length=4, max_length=64)
    email: str = Field(min_length=3, max_length=320)
    full_name: str = Field(min_length=1, max_length=200)


class OrderLandingPageBody(BaseModel):
    invite_code: str = Field(min_length=4, max_length=64)
    invitee_email: str = Field(min_length=3, max_length=320)
    model: str | None = Field(default=None, max_length=80)
    card: str | None = Field(default=None, max_length=80)


def _normalize_code(raw: str) -> str:
    code = raw.strip()
    if not _CODE.fullmatch(code):
        raise HTTPException(status_code=404, detail="This invite is not valid.")
    return code


def _normalize_email(raw: str) -> str:
    email = str(raw).strip().lower()
    if not _EMAIL.fullmatch(email):
        raise HTTPException(status_code=422, detail="A valid email is required.")
    return email


def _normalize_name(raw: str) -> str:
    name = " ".join(raw.split())
    if not name:
        raise HTTPException(status_code=422, detail="Name is required.")
    return name


def _internal_token() -> str:
    return os.environ.get("MJPROMOTER_INTERNAL_TOKEN", "").strip()


def _require_internal_token(x_internal_token: Annotated[str | None, Header()] = None) -> None:
    expected = _internal_token()
    provided = (x_internal_token or "").strip()
    if not expected or not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _require_open_invite(code: str, email: str):
    result = lookup_invite(code)
    if not result.ok:
        raise HTTPException(status_code=result.status_code, detail=result.detail)
    if result.invitee_email and result.invitee_email != email:
        raise HTTPException(
            status_code=400,
            detail="This invite was sent to a different email.",
        )
    return result


@router.get("/invites/{code}")
def get_invite(code: str):
    normalized = _normalize_code(code)
    result = lookup_invite(normalized)
    if not result.ok:
        raise HTTPException(status_code=result.status_code, detail=result.detail)
    return {
        "ok": True,
        "inviteCode": normalized,
        "campaignName": result.campaign_name,
        "inviteeEmail": result.invitee_email,
    }


@router.post("/pre-influencers/confirm")
def confirm_pre_influencer(
    body: ConfirmPreInfluencerBody,
    db: Annotated[Session, Depends(get_session)],
):
    code = _normalize_code(body.invite_code)
    email = _normalize_email(str(body.email))
    full_name = _normalize_name(body.full_name)
    _require_open_invite(code, email)

    row = db.query(PreInfluencer).filter(PreInfluencer.invite_code == code).one_or_none()
    if row is None:
        row = PreInfluencer(
            id=uuid4(),
            email=email,
            full_name=full_name,
            invite_code=code,
            status="confirmed",
            survey_step=1,
        )
        db.add(row)
    else:
        if row.email.lower() != email:
            raise HTTPException(
                status_code=400,
                detail="This invite was already confirmed with a different email.",
            )
        row.full_name = full_name
        row.updated_at = utcnow()
        # Never move a building/live / step-2 row backwards.
        if row.survey_step < 1:
            row.survey_step = 1
        if row.status == "pending":
            row.status = "confirmed"
        elif row.status not in ("building", "live") and row.survey_step < 2:
            row.status = "confirmed"

    notified = False
    if row.mjfp_last_notified_step is None or row.mjfp_last_notified_step < row.survey_step:
        notified = notify_step(
            email=row.email,
            invite_code=row.invite_code,
            current_step=row.survey_step,
            status=row.status,
            asset_link=row.asset_link,
        )
        if notified:
            row.mjfp_last_notified_step = row.survey_step

    db.commit()
    db.refresh(row)
    return {
        "ok": True,
        "preInfluencerId": str(row.id),
        "email": row.email,
        "fullName": row.full_name,
        "inviteCode": row.invite_code,
        "status": row.status,
        "surveyStep": row.survey_step,
        "notified": notified,
    }


def _optional_slug(raw: str | None, *, field: str) -> str | None:
    if raw is None:
        return None
    value = raw.strip()
    if not value:
        return None
    if not _SLUG.fullmatch(value):
        raise HTTPException(status_code=422, detail=f"Invalid {field}.")
    return value


@router.post("/pre-influencers/order-landing-page")
def order_landing_page(
    body: OrderLandingPageBody,
    db: Annotated[Session, Depends(get_session)],
    _: None = Depends(_require_internal_token),
):
    code = _normalize_code(body.invite_code)
    email = _normalize_email(str(body.invitee_email))
    model = _optional_slug(body.model, field="model")
    card = _optional_slug(body.card, field="card")

    row = db.query(PreInfluencer).filter(PreInfluencer.invite_code == code).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Pre-influencer not found.")
    if row.email.lower() != email:
        raise HTTPException(
            status_code=400,
            detail="invitee_email does not match this invite.",
        )
    if row.survey_step < 1:
        raise HTTPException(
            status_code=400,
            detail="Confirm email and name before ordering a landing page.",
        )

    # Jorlyn's Order Landing Page publishes the player freeplay join URL.
    asset_link = build_landing_page_url(model=model, card=card)
    row.survey_step = 2
    row.status = "live"
    row.asset_link = asset_link
    row.updated_at = utcnow()

    notified = notify_step(
        email=row.email,
        invite_code=row.invite_code,
        current_step=2,
        status="live",
        asset_link=asset_link,
    )
    if notified:
        row.mjfp_last_notified_step = 2

    db.commit()
    db.refresh(row)
    return {
        "ok": True,
        "pre_influencer_id": str(row.id),
        "status": row.status,
        "survey_step": row.survey_step,
        "asset_link": row.asset_link,
        "notified": notified,
    }
