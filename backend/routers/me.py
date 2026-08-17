from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.auth.sessions import current_user
from backend.db.engine import get_session
from backend.db.models import User, UserCreatorPref
from backend.routers.auth import public_user

router = APIRouter(prefix="/api/me", tags=["me"])


class ProfilePatch(BaseModel):
    username: str | None = Field(default=None, max_length=40)
    display_name: str | None = Field(default=None, max_length=80)
    avatar_url: str | None = None
    gender_interest: Literal["male", "female", "both"] | None = None
    home_tutorial_done: bool | None = None
    recommendation_status: str | None = None


class CreatorPrefItem(BaseModel):
    model_id: str
    stance: Literal["liked", "passed"]
    source: Literal["feed", "onboarding_swipe"] = "feed"


class CreatorPrefsBody(BaseModel):
    prefs: list[CreatorPrefItem]


@router.get("/profile")
def get_profile(user: Annotated[User, Depends(current_user)], db: Annotated[Session, Depends(get_session)]):
    prefs = db.query(UserCreatorPref).filter(UserCreatorPref.user_id == user.id).all()
    liked = [p.model_id for p in prefs if p.stance == "liked"]
    passed = [p.model_id for p in prefs if p.stance == "passed"]
    return {"user": public_user(user), "likedCreators": liked, "passedCreators": passed}


@router.patch("/profile")
def patch_profile(
    body: ProfilePatch,
    user: Annotated[User, Depends(current_user)],
):
    if body.username is not None:
        user.username = body.username
    if body.display_name is not None:
        user.display_name = body.display_name
    if body.avatar_url is not None:
        user.avatar_url = body.avatar_url
    if body.gender_interest is not None:
        user.gender_interest = body.gender_interest
    if body.home_tutorial_done is not None:
        user.home_tutorial_done = body.home_tutorial_done
    if body.recommendation_status is not None:
        user.recommendation_status = body.recommendation_status
    return {"user": public_user(user)}


@router.put("/prefs/creators")
def put_creator_prefs(
    body: CreatorPrefsBody,
    db: Annotated[Session, Depends(get_session)],
    user: Annotated[User, Depends(current_user)],
):
    existing = {(p.model_id): p for p in db.query(UserCreatorPref).filter(UserCreatorPref.user_id == user.id).all()}
    for item in body.prefs:
        row = existing.get(item.model_id)
        if row:
            row.stance = item.stance
            row.source = item.source
        else:
            db.add(
                UserCreatorPref(
                    user_id=user.id,
                    model_id=item.model_id,
                    stance=item.stance,
                    source=item.source,
                )
            )
    return {"ok": True}
