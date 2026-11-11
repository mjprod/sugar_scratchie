"""MJ Promoter client.

Sugar Scratchie sells. Promoter calculates commission percentages.
Invite lookup and accept use the same routes TeaseMe's join link uses.
Sales use POST /v2/track/sale. Missing credentials skip every call.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from urllib.parse import quote

import httpx

logger = logging.getLogger("sugar.promoter")

INVITE_TIMEOUT_S = 4.0
SALE_TIMEOUT_S = 4.0


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

    @property
    def ok(self) -> bool:
        return self.status_code == 200


def _api_url() -> str:
    return os.environ.get("MJPROMOTER_API_URL", "").strip().rstrip("/")


def _bearer() -> str:
    return os.environ.get("MJPROMOTER_BEARER_TOKEN", "").strip()


def _account_id() -> str:
    return os.environ.get("MJPROMOTER_ACCOUNT_ID", "").strip()


def configured() -> bool:
    return bool(_api_url() and _bearer() and _account_id())


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
        try:
            body = response.json()
        except Exception:
            body = None
        referral = body.get("referral") if isinstance(body, dict) else None
        campaign = referral.get("campaign") if isinstance(referral, dict) else None
        if isinstance(campaign, dict) and isinstance(campaign.get("name"), str):
            name = campaign["name"]
        return InviteLookup(200, "", name)
    if response.status_code == 404:
        return InviteLookup(404, "This invite is not valid.")
    text = _error_text(response).lower()
    if response.status_code == 400 and "used" in text:
        return InviteLookup(409, "This invite has already been used.")
    if response.status_code == 400:
        return InviteLookup(400, "This invite is no longer active.")
    logger.warning("promoter invite lookup status=%s code=%s", response.status_code, code)
    return InviteLookup(502, "Could not check this invite.")


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
