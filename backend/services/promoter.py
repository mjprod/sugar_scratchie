"""MJ Promoter client.

Sugar Scratchie sells. Promoter calculates commission percentages.
Invite lookup and accept use the same routes TeaseMe's join link uses.
Sales use POST /v2/track/sale. Missing credentials skip every call.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

import httpx
from sqlalchemy import or_
from sqlalchemy.orm import Session

logger = logging.getLogger("sugar.promoter")

INVITE_TIMEOUT_S = 4.0
SALE_TIMEOUT_S = 4.0
WEBHOOK_TIMEOUT_S = 4.0


class PromoterInviteRejected(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


@dataclass(frozen=True)
class InviteLookup:
    status_code: int
    detail: str
    campaign_name: str | None = None
    invitee_email: str | None = None

    @property
    def ok(self) -> bool:
        return self.status_code == 200


def _api_url() -> str:
    return os.environ.get("MJPROMOTER_API_URL", "").strip().rstrip("/")


def _bearer() -> str:
    return os.environ.get("MJPROMOTER_BEARER_TOKEN", "").strip()


def _account_id() -> str:
    return os.environ.get("MJPROMOTER_ACCOUNT_ID", "").strip()


def _webhook_url() -> str:
    return os.environ.get("MJPROMOTER_WEBHOOK_URL", "").strip().rstrip("/")


def _webhook_secret() -> str:
    return os.environ.get("MJPROMOTER_WEBHOOK_SECRET", "").strip()


def configured() -> bool:
    return bool(_api_url() and _bearer() and _account_id())


def webhook_configured() -> bool:
    return bool(_webhook_url() and _webhook_secret())


def lp_public_url() -> str:
    """Origin for published influencer LPs (frontend-new player app)."""
    return (
        os.environ.get("PREINFLUENCER_LP_PUBLIC_URL", "").strip().rstrip("/")
        or "https://localhost:5174"
    )


def _lp_public_url() -> str:
    return lp_public_url()


def _default_lp_model() -> str:
    return os.environ.get("PREINFLUENCER_LP_MODEL", "").strip() or "julianaval"


def _default_lp_card() -> str:
    return os.environ.get("PREINFLUENCER_LP_CARD", "").strip() or "juliana_1"


def build_landing_page_url(
    *,
    model: str | None = None,
    card: str | None = None,
    lp_model: str | None = None,
    invite_code: str | None = None,
    invitee_email: str | None = None,
    invitee_username: str | None = None,
) -> str:
    """Player /join freeplay URL for invite demos and published LPs.

    ``model`` / ``card`` are the scratch demo. ``lp_model`` pins the landing
    page to an influencer when the scratch demo is a shared template. Omitting
    both model and card falls back to the env template pair.     ``invite_code`` /
    ``invitee_email`` / ``invitee_username`` wire the Forms step on the
    default landing page. Username-only invites omit the email.
    """
    explicit_model = (model or "").strip()
    model_id = explicit_model or _default_lp_model()
    card_id = (card or "").strip()
    if not card_id and not explicit_model:
        card_id = _default_lp_card()
    url = (
        f"{_lp_public_url()}/join"
        f"?model={quote(model_id, safe='')}"
        f"&freeplay=1"
    )
    pinned = (lp_model or "").strip()
    if pinned:
        url += f"&lpModel={quote(pinned, safe='')}"
    if card_id:
        url += f"&card={quote(card_id, safe='')}"
    code = (invite_code or "").strip()
    if code:
        url += f"&inviteCode={quote(code, safe='')}"
    email = (invitee_email or "").strip().lower()
    if email:
        url += f"&inviteeEmail={quote(email, safe='')}"
    username = (invitee_username or "").strip().lstrip("@")
    if username:
        url += f"&inviteeUsername={quote(username, safe='')}"
    return url


def pick_default_modal_demo(db: Session) -> tuple[str, str] | None:
    """Lowest-id flagged demo model and its card, or None when none are set.

    Skips (and heals) rows whose card is missing or no longer owned by the model.
    """
    from backend.db.models import Creator, MotionCard

    rows = (
        db.query(Creator)
        .filter(
            Creator.default_modal.is_(True),
            Creator.default_modal_card_id.isnot(None),
        )
        .order_by(Creator.id.asc())
        .all()
    )
    for creator in rows:
        card_id = (creator.default_modal_card_id or "").strip()
        if not card_id:
            creator.default_modal = False
            creator.default_modal_card_id = None
            continue
        owned = (
            db.query(MotionCard.id)
            .filter(MotionCard.id == card_id, MotionCard.model_id == creator.id)
            .first()
        )
        if owned is None:
            creator.default_modal = False
            creator.default_modal_card_id = None
            continue
        return creator.id, card_id
    return None


def first_model_card_id(db: Session, model_id: str) -> str | None:
    """Lowest sort-order motion card published on this model, if any."""
    from backend.db.models import MotionCard

    cleaned = (model_id or "").strip()
    if not cleaned:
        return None
    row = (
        db.query(MotionCard.id)
        .filter(MotionCard.model_id == cleaned)
        .order_by(MotionCard.sort_order.asc(), MotionCard.id.asc())
        .first()
    )
    return row[0] if row else None


def _error_text(response: httpx.Response) -> str:
    try:
        body = response.json()
    except Exception:
        return ""
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, str) and error.strip():
            return error.strip()
    return ""


def _invitee_email_from_referral(referral: object) -> str | None:
    if not isinstance(referral, dict):
        return None
    meta = referral.get("metadata")
    if not isinstance(meta, dict):
        return None
    raw = meta.get("inviteeEmail")
    if isinstance(raw, str) and raw.strip():
        return raw.strip().lower()
    return None


def lookup_invite(code: str) -> InviteLookup:
    if not configured():
        return InviteLookup(503, "Promoter is not configured.")
    url = f"{_api_url()}/referrals/invite/{quote(code, safe='')}"
    try:
        with httpx.Client(timeout=INVITE_TIMEOUT_S) as client:
            response = client.get(url)
    except httpx.HTTPError:
        logger.warning("promoter invite lookup failed code=%s", code)
        return InviteLookup(502, "Could not check this invite.")
    if response.status_code == 200:
        name = None
        invitee_email = None
        try:
            body = response.json()
        except Exception:
            body = None
        referral = body.get("referral") if isinstance(body, dict) else None
        campaign = referral.get("campaign") if isinstance(referral, dict) else None
        if isinstance(campaign, dict) and isinstance(campaign.get("name"), str):
            name = campaign["name"]
        invitee_email = _invitee_email_from_referral(referral)
        return InviteLookup(200, "", name, invitee_email)
    if response.status_code == 404:
        return InviteLookup(404, "This invite is not valid.")
    text = _error_text(response).lower()
    if response.status_code == 400 and "used" in text:
        return InviteLookup(409, "This invite has already been used.")
    if response.status_code == 400:
        return InviteLookup(400, "This invite is no longer active.")
    logger.warning("promoter invite lookup status=%s code=%s", response.status_code, code)
    return InviteLookup(502, "Could not check this invite.")


def notify_step(
    *,
    email: str,
    invite_code: str,
    current_step: int,
    status: str,
    asset_link: str | None = None,
) -> bool:
    """Push pre-influencer step to MJ Promoter's teaseme-step webhook."""
    if not webhook_configured():
        return False
    payload: dict[str, object] = {
        "email": email,
        "inviteCode": invite_code,
        "currentStep": current_step,
        "status": status,
    }
    if asset_link:
        payload["assetLink"] = asset_link
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "x-webhook-secret": _webhook_secret(),
    }
    try:
        with httpx.Client(timeout=WEBHOOK_TIMEOUT_S) as client:
            response = client.post(_webhook_url(), json=payload, headers=headers)
    except httpx.HTTPError:
        logger.warning(
            "promoter step webhook failed invite=%s step=%s",
            invite_code,
            current_step,
        )
        return False
    if response.status_code in (200, 201):
        logger.info(
            "promoter step webhook ok invite=%s step=%s",
            invite_code,
            current_step,
        )
        return True
    logger.warning(
        "promoter step webhook status=%s invite=%s step=%s",
        response.status_code,
        invite_code,
        current_step,
    )
    return False


def _split_name(display_name: str | None, email: str) -> tuple[str, str | None]:
    text = (display_name or "").strip()
    if not text:
        return email.split("@", 1)[0], None
    parts = text.split()
    if len(parts) == 1:
        return parts[0], None
    return parts[0], " ".join(parts[1:])


def accept_invite(
    *,
    email: str,
    password: str,
    display_name: str | None,
    invite_code: str,
) -> None:
    """Register her on Promoter with the manager's invite code.

    No-op when credentials are unset. A rejected code raises so the caller
    does not create a Sugar Scratchie user for an invite Promoter refused.
    """
    if not configured():
        return
    first_name, last_name = _split_name(display_name, email)
    payload: dict[str, str] = {
        "email": email,
        "password": password,
        "firstName": first_name,
        "inviteCode": invite_code,
    }
    if last_name:
        payload["lastName"] = last_name
    url = f"{_api_url()}/auth/register"
    try:
        with httpx.Client(timeout=INVITE_TIMEOUT_S) as client:
            response = client.post(url, json=payload)
    except httpx.HTTPError as exc:
        logger.warning("promoter invite accept failed code=%s", invite_code)
        raise PromoterInviteRejected(502, "Could not accept this invite.") from exc
    if response.status_code in (200, 201):
        return
    text = _error_text(response)
    if response.status_code == 400 and "already exists" in text.lower():
        return
    if response.status_code == 400 and text:
        raise PromoterInviteRejected(400, text)
    logger.warning("promoter invite accept status=%s code=%s", response.status_code, invite_code)
    raise PromoterInviteRejected(502, "Could not accept this invite.")


def track_sale(
    *,
    event_id: str,
    amount_cents: int,
    email: str,
    uid: str,
    ref_id: str,
    plan: str | None,
) -> bool:
    """Report one sale. True when Promoter accepted it, including a duplicate."""
    if not configured():
        return False
    payload: dict[str, object] = {
        "event_id": event_id,
        "amount": amount_cents,
        "email": email,
        "uid": uid,
        "ref_id": ref_id,
    }
    if plan:
        payload["plan"] = plan
    url = f"{_api_url()}/v2/track/sale"
    headers = {
        "Authorization": f"Bearer {_bearer()}",
        "Account-ID": _account_id(),
    }
    try:
        with httpx.Client(timeout=SALE_TIMEOUT_S) as client:
            response = client.post(url, json=payload, headers=headers)
    except httpx.HTTPError:
        logger.warning("promoter sale report failed event_id=%s", event_id)
        return False
    if response.status_code in (200, 201):
        logger.info("promoter sale reported event_id=%s", event_id)
        return True
    logger.warning(
        "promoter sale report status=%s event_id=%s",
        response.status_code,
        event_id,
    )
    return False


def ensure_pre_influencer_model(
    db: Session,
    models_dir: Path,
    *,
    full_name: str,
    model_id: str | None,
) -> str:
    """Create or reuse the empty operator model for this invitee."""
    from backend.models_store import ensure_named_model

    return ensure_named_model(
        db,
        models_dir,
        full_name=full_name,
        model_id=model_id,
    )


def model_has_pack_video(models_dir: Path, model_id: str | None) -> bool:
    """True when foil 1 or foil 2 pack video is on disk for this model."""
    from backend.models_store import find_model_video

    cleaned = (model_id or "").strip()
    if not cleaned:
        return False
    model_dir = models_dir / cleaned
    if not model_dir.is_dir():
        return False
    return bool(
        find_model_video(model_dir, "pack-face")
        or find_model_video(model_dir, "pack-face-2")
    )


def mark_package_ready_for_model(model_id: str) -> bool:
    """Advance a pre-influencer to survey_step 2 when their pack video lands.

    Called from foil / pack upload paths. Opens its own DB session so n8n
    workers can notify without a request-scoped session. Returns True when a
    row was advanced (or already at step ≥ 2).
    """
    from backend.db import engine as db_engine
    from backend.db.models import PreInfluencer, utcnow

    cleaned = (model_id or "").strip()
    if not cleaned:
        return False
    if db_engine.SessionLocal is None:
        db_engine.get_engine()
    assert db_engine.SessionLocal is not None
    session = db_engine.SessionLocal()
    try:
        row = (
            session.query(PreInfluencer)
            .filter(PreInfluencer.model_id == cleaned)
            .one_or_none()
        )
        if row is None:
            return False
        if row.survey_step >= 2:
            return True
        if row.survey_step < 1:
            # Forms must happen first; ignore stray pack writes.
            return False
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
        session.commit()
        logger.info(
            "pre-influencer package ready invite=%s model=%s notified=%s",
            row.invite_code,
            cleaned,
            notified,
        )
        return True
    except Exception:
        session.rollback()
        logger.exception("pre-influencer package ready failed model=%s", cleaned)
        return False
    finally:
        session.close()


def catch_up_live_pre_influencer_step(db: Session) -> int:
    """Notify Promoter that legacy live invites are already on step 3.

    Migration 0024 moves old live rows from step 2 to step 3 without a
    webhook. Those rows never went through Make package and have no pack
    video. Do not create a catalog model for them — an empty model makes
    order-landing-page return 409, so Promoter stays on step 2 while Sugar
    is already complete.
    """
    from backend.db.models import PreInfluencer, utcnow

    rows = (
        db.query(PreInfluencer)
        .filter(
            PreInfluencer.status == "live",
            PreInfluencer.survey_step >= 3,
            or_(
                PreInfluencer.mjfp_last_notified_step.is_(None),
                PreInfluencer.mjfp_last_notified_step < 3,
            ),
        )
        .order_by(PreInfluencer.created_at.asc())
        .all()
    )
    notified_count = 0
    for row in rows:
        notified = notify_step(
            email=row.email,
            invite_code=row.invite_code,
            current_step=3,
            status="live",
            asset_link=row.asset_link,
        )
        if not notified:
            continue
        row.mjfp_last_notified_step = 3
        row.updated_at = utcnow()
        notified_count += 1
        logger.info(
            "pre-influencer step-3 catch-up invite=%s",
            row.invite_code,
        )
    return notified_count
