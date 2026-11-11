"""Public invite check for the player join page.

The bearer token stays on the server. The page only learns whether the
manager's code is still open.
"""

from __future__ import annotations

import re
from fastapi import APIRouter, HTTPException

from backend.services.promoter import lookup_invite

router = APIRouter(prefix="/api/promoter", tags=["promoter"])

_CODE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")


@router.get("/invites/{code}")
def get_invite(code: str):
    if not _CODE.fullmatch(code):
        raise HTTPException(status_code=404, detail="This invite is not valid.")
    result = lookup_invite(code)
    if not result.ok:
        raise HTTPException(status_code=result.status_code, detail=result.detail)
    return {
        "ok": True,
        "inviteCode": code,
        "campaignName": result.campaign_name,
    }
