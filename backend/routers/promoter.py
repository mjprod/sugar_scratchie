"""Public invite check and pre-influencer form for the join landing page.

The bearer token stays on the server. The page only learns whether the
manager's code is still open. Form submit upserts pre_influencers and notifies
MJ Promoter. Default / order landing page and package routes are called by
MJ Promoter with an internal token.
"""

from __future__ import annotations

import os
import re
import secrets
from pathlib import Path
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.db.engine import get_session
from backend.db.models import MotionCard, PreInfluencer, utcnow
from backend.models_store import CATALOG_LABEL_MAX
from backend.services.promoter import (
    build_landing_page_url,
    ensure_pre_influencer_model,
    first_model_card_id,
    lookup_invite,
    model_has_pack_video,
    notify_step,
    pick_default_modal_demo,
)

router = APIRouter(prefix="/api/promoter", tags=["promoter"])

_MODELS_DIR = Path(__file__).resolve().parents[2] / "public" / "models"

_CODE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_SLUG = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
_HANDLE = re.compile(r"^@?[A-Za-z0-9._-]{1,80}$")


class FormPreInfluencerBody(BaseModel):
    invite_code: str = Field(min_length=4, max_length=64)
    email: str = Field(min_length=3, max_length=320)
    first_name: str = Field(min_length=1, max_length=CATALOG_LABEL_MAX)
    last_name: str = Field(min_length=1, max_length=CATALOG_LABEL_MAX)
    social_handle: str = Field(min_length=1, max_length=80)


class InviteeBody(BaseModel):
    invite_code: str = Field(min_length=4, max_length=64)
    invitee_email: str = Field(min_length=3, max_length=320)


class DefaultLandingPageBody(BaseModel):
    invite_code: str = Field(min_length=4, max_length=64)
    invitee_email: str | None = Field(default=None, max_length=320)
    invitee_username: str | None = Field(default=None, max_length=80)


class OrderLandingPageBody(InviteeBody):
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


def _normalize_handle(raw: str) -> str:
    handle = raw.strip().lstrip("@")
    if not handle or not _HANDLE.fullmatch(handle):
        raise HTTPException(status_code=422, detail="A valid social handle is required.")
    return handle


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


def _optional_email(raw: str | None) -> str | None:
    if raw is None or not str(raw).strip():
        return None
    return _normalize_email(str(raw))


def _optional_username(raw: str | None) -> str | None:
    if raw is None or not str(raw).strip():
        return None
    return _normalize_handle(str(raw))


def _default_demo_url(
    *,
    invite_code: str,
    invitee_email: str | None,
    invitee_username: str | None,
    db: Session,
) -> str:
    demo = pick_default_modal_demo(db)
    if demo is not None:
        demo_model, demo_card = demo
        return build_landing_page_url(
            model=demo_model,
            card=demo_card,
            invite_code=invite_code,
            invitee_email=invitee_email,
            invitee_username=invitee_username,
        )
    return build_landing_page_url(
        invite_code=invite_code,
        invitee_email=invitee_email,
        invitee_username=invitee_username,
    )


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


@router.post("/pre-influencers/default-landing-page")
def default_landing_page(
    body: DefaultLandingPageBody,
    db: Annotated[Session, Depends(get_session)],
    _: None = Depends(_require_internal_token),
):
    """Return the shared demo /join URL for Forms. Does not advance steps.

    Username-only invites omit ``invitee_email``. The join form collects the
    address; promoter verifies it when the person becomes an influencer.
    """
    code = _normalize_code(body.invite_code)
    email = _optional_email(body.invitee_email)
    username = _optional_username(body.invitee_username)
    if not email and not username:
        raise HTTPException(status_code=422, detail="A username or email is required.")
    result = lookup_invite(code)
    if not result.ok:
        raise HTTPException(status_code=result.status_code, detail=result.detail)
    if email and result.invitee_email and result.invitee_email != email:
        raise HTTPException(
            status_code=400,
            detail="This invite was sent to a different email.",
        )

    asset_link = _default_demo_url(
        invite_code=code,
        invitee_email=email,
        invitee_username=username,
        db=db,
    )
    return {
        "ok": True,
        "asset_link": asset_link,
        "invite_code": code,
        "invitee_email": email,
        "invitee_username": username,
        "survey_step": 0,
    }


@router.post("/pre-influencers/form")
def submit_pre_influencer_form(
    body: FormPreInfluencerBody,
    db: Annotated[Session, Depends(get_session)],
):
    """Forms step: create the pre-influencer + empty model, notify step 1."""
    code = _normalize_code(body.invite_code)
    email = _normalize_email(str(body.email))
    first_name = _normalize_name(body.first_name)
    last_name = _normalize_name(body.last_name)
    social_handle = _normalize_handle(body.social_handle)
    full_name = _normalize_name(f"{first_name} {last_name}")
    _require_open_invite(code, email)

    row = db.query(PreInfluencer).filter(PreInfluencer.invite_code == code).one_or_none()
    if row is None:
        row = PreInfluencer(
            id=uuid4(),
            email=email,
            full_name=full_name,
            social_handle=social_handle,
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
        row.social_handle = social_handle
        row.updated_at = utcnow()
        # Never move a building/live / later-step row backwards.
        if row.survey_step < 1:
            row.survey_step = 1
        if row.status == "pending":
            row.status = "confirmed"
        elif row.status not in ("building", "live") and row.survey_step < 2:
            row.status = "confirmed"

    # Empty operator model so foil n8n can run as step 2.
    row.model_id = ensure_pre_influencer_model(
        db,
        _MODELS_DIR,
        full_name=row.full_name,
        model_id=row.model_id,
    )

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
        "socialHandle": row.social_handle,
        "inviteCode": row.invite_code,
        "status": row.status,
        "surveyStep": row.survey_step,
        "modelId": row.model_id,
        "notified": notified,
    }


def _card_belongs_to_model(db: Session, card_id: str | None, model_id: str) -> bool:
    cleaned = (card_id or "").strip()
    if not cleaned:
        return False
    row = (
        db.query(MotionCard.id)
        .filter(MotionCard.id == cleaned, MotionCard.model_id == model_id)
        .first()
    )
    return row is not None


def _optional_slug(raw: str | None, *, field: str) -> str | None:
    if raw is None:
        return None
    value = raw.strip()
    if not value:
        return None
    if not _SLUG.fullmatch(value):
        raise HTTPException(status_code=422, detail=f"Invalid {field}.")
    return value


@router.post("/pre-influencers/package-workspace")
def package_workspace(
    body: InviteeBody,
    db: Annotated[Session, Depends(get_session)],
    _: None = Depends(_require_internal_token),
):
    """Return the operator packs URL for this invite (does not advance steps)."""
    code = _normalize_code(body.invite_code)
    email = _normalize_email(str(body.invitee_email))

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
            detail="Submit the landing-page form before making the package.",
        )

    row.model_id = ensure_pre_influencer_model(
        db,
        _MODELS_DIR,
        full_name=row.full_name,
        model_id=row.model_id,
    )
    ready = model_has_pack_video(_MODELS_DIR, row.model_id)
    # Repair false step-2 advances (no pack on disk yet).
    if (
        not ready
        and row.survey_step >= 2
        and row.status not in ("building", "live")
    ):
        row.survey_step = 1
        row.updated_at = utcnow()
        if notify_step(
            email=row.email,
            invite_code=row.invite_code,
            current_step=1,
            status=row.status,
            asset_link=row.asset_link,
        ):
            row.mjfp_last_notified_step = 1
    row.updated_at = utcnow()
    db.commit()
    db.refresh(row)

    packs_path = f"/dashboard/packs?model={row.model_id}&embed=1"
    return {
        "ok": True,
        "pre_influencer_id": str(row.id),
        "model_id": row.model_id,
        "survey_step": row.survey_step,
        "package_ready": ready,
        "packs_path": packs_path,
    }


@router.post("/pre-influencers/make-package")
def make_package(
    body: InviteeBody,
    db: Annotated[Session, Depends(get_session)],
    _: None = Depends(_require_internal_token),
):
    """Complete Sugar step 2 only when foil pack video exists on the model."""
    code = _normalize_code(body.invite_code)
    email = _normalize_email(str(body.invitee_email))

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
            detail="Submit the landing-page form before making the package.",
        )

    row.model_id = ensure_pre_influencer_model(
        db,
        _MODELS_DIR,
        full_name=row.full_name,
        model_id=row.model_id,
    )
    db.flush()

    if not model_has_pack_video(_MODELS_DIR, row.model_id):
        if row.survey_step >= 2 and row.status not in ("building", "live"):
            row.survey_step = 1
            row.updated_at = utcnow()
            if notify_step(
                email=row.email,
                invite_code=row.invite_code,
                current_step=1,
                status=row.status,
                asset_link=row.asset_link,
            ):
                row.mjfp_last_notified_step = 1
            db.commit()
        raise HTTPException(
            status_code=409,
            detail=(
                f"Pack video not ready on model {row.model_id}. "
                "Use Create with n8n or upload on the packs page first."
            ),
        )

    if row.survey_step < 2:
        row.survey_step = 2
        row.updated_at = utcnow()

    notified = False
    if row.mjfp_last_notified_step is None or row.mjfp_last_notified_step < 2:
        notified = notify_step(
            email=row.email,
            invite_code=row.invite_code,
            current_step=2,
            status=row.status,
            asset_link=row.asset_link,
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
        "model_id": row.model_id,
        "package_ready": True,
        "notified": notified,
    }


@router.post("/pre-influencers/order-landing-page")
def order_landing_page(
    body: OrderLandingPageBody,
    db: Annotated[Session, Depends(get_session)],
    _: None = Depends(_require_internal_token),
):
    code = _normalize_code(body.invite_code)
    email = _normalize_email(str(body.invitee_email))
    _optional_slug(body.model, field="model")
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
            detail="Submit the landing-page form before ordering a landing page.",
        )
    if row.survey_step < 2:
        raise HTTPException(
            status_code=400,
            detail="Finish n8n before ordering a landing page.",
        )

    # Pre-migration live rows finished Order LP before Make package existed.
    # They have no pack video. Creating a model here attaches an empty catalog
    # row and the pack check below would 409, so Promoter never gets step 3
    # even though migration 0024 already marked Sugar complete.
    legacy_live = row.status == "live" and not model_has_pack_video(
        _MODELS_DIR, row.model_id
    )
    if legacy_live:
        asset_link = (row.asset_link or "").strip() or build_landing_page_url()
    else:
        # Reuse the form-time model (create if an older row never got one).
        model_id = ensure_pre_influencer_model(
            db,
            _MODELS_DIR,
            full_name=row.full_name,
            model_id=row.model_id,
        )
        row.model_id = model_id
        if not model_has_pack_video(_MODELS_DIR, model_id):
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Pack video not ready on model {model_id}. "
                    "Finish n8n before ordering the landing page."
                ),
            )

        # Publish this invitee's model. A card is included only when it belongs
        # to that model — a foreign card (the Juliana template) opens the wrong LP.
        # When the invitee has no card, fall back to a flagged Default Modal demo
        # and pin the LP chrome to the invitee via lpModel.
        publish_card = card if _card_belongs_to_model(db, card, model_id) else None
        if not publish_card:
            publish_card = first_model_card_id(db, model_id)
        if publish_card:
            asset_link = build_landing_page_url(model=model_id, card=publish_card)
        else:
            demo = pick_default_modal_demo(db)
            if demo is not None:
                demo_model, demo_card = demo
                asset_link = build_landing_page_url(
                    model=demo_model,
                    card=demo_card,
                    lp_model=model_id,
                )
            else:
                asset_link = build_landing_page_url(model=model_id)
    row.survey_step = 3
    row.status = "live"
    row.asset_link = asset_link
    row.updated_at = utcnow()

    notified = notify_step(
        email=row.email,
        invite_code=row.invite_code,
        current_step=3,
        status="live",
        asset_link=asset_link,
    )
    if notified:
        row.mjfp_last_notified_step = 3

    db.commit()
    db.refresh(row)
    return {
        "ok": True,
        "pre_influencer_id": str(row.id),
        "status": row.status,
        "survey_step": row.survey_step,
        "asset_link": row.asset_link,
        "model_id": row.model_id,
        "notified": notified,
    }
