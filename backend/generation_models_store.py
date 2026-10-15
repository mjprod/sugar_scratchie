"""CRUD for the Video Flow generation-model catalog."""

from __future__ import annotations

import re

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from backend.db.models import GenerationModel
from backend.services import provider_models as provider_catalog
from backend.services.generation_models import (
    ADAPTERS,
    ADAPTERS_BY_ID,
    BUILTINS,
    BUILTINS_BY_KEY,
    ROLES,
    AdapterInfo,
    GenerationModelSpec,
    builtin_spec,
    canonical_model_id,
    default_spec,
)

MODEL_ID_PATTERN = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
ENDPOINT_PATTERN = re.compile(r"^/[A-Za-z0-9_./-]{1,200}$")
XAI_MODEL_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")


class AdapterInfoModel(BaseModel):
    id: str
    label: str
    roles: list[str]
    provider: str
    needs_endpoint: bool
    needs_reference_token: bool
    needs_variant: bool
    endpoint_hint: str


class GenerationModelInfo(BaseModel):
    id: str
    role: str
    label: str
    provider: str
    adapter: str
    endpoint_path: str
    reference_token: str
    variant: str
    takes_reference_image: bool
    enabled: bool
    sort_order: int
    builtin: bool


class CreateGenerationModelRequest(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    role: str
    label: str = Field(min_length=1, max_length=160)
    adapter: str
    endpoint_path: str = ""
    reference_token: str = ""
    variant: str = ""
    enabled: bool = True


class UpdateGenerationModelRequest(BaseModel):
    label: str = Field(min_length=1, max_length=160)
    adapter: str
    endpoint_path: str = ""
    reference_token: str = ""
    variant: str = ""
    enabled: bool = True
    sort_order: int | None = None


class LookupProviderModelsRequest(BaseModel):
    provider: str
    query: str = ""
    role: str = ""


class CheckProviderModelRequest(BaseModel):
    provider: str
    model_id: str = ""


def adapter_payloads() -> list[AdapterInfoModel]:
    return [
        AdapterInfoModel(
            id=item.id,
            label=item.label,
            roles=list(item.roles),
            provider=item.provider,
            needs_endpoint=item.needs_endpoint,
            needs_reference_token=item.needs_reference_token,
            needs_variant=item.needs_variant,
            endpoint_hint=item.endpoint_hint,
        )
        for item in ADAPTERS
    ]


def safe_model_id(value: str) -> str:
    slug = value.strip().lower().replace(" ", "-")
    slug = re.sub(r"[^a-z0-9._-]+", "-", slug).strip("-._")
    if not slug or not MODEL_ID_PATTERN.match(slug):
        raise HTTPException(
            status_code=400,
            detail=(
                "Model id must start with a letter and contain only lowercase letters, "
                "numbers, dots, hyphens, and underscores"
            ),
        )
    return slug


def _require_role(role: str) -> str:
    cleaned = role.strip()
    if cleaned not in ROLES:
        raise HTTPException(status_code=400, detail="Unknown model step")
    return cleaned


def _adapter_for(adapter_id: str, role: str) -> AdapterInfo:
    info = ADAPTERS_BY_ID.get(adapter_id.strip())
    if info is None or role not in info.roles:
        raise HTTPException(
            status_code=400,
            detail="That request style does not match this step",
        )
    return info


def _clean_endpoint(info: AdapterInfo, raw: str) -> str:
    path = (raw or "").strip()
    if info.provider == "xai":
        if not path:
            return ""
        if not XAI_MODEL_ID_PATTERN.match(path):
            raise HTTPException(
                status_code=400,
                detail="x.ai model id looks like grok-imagine-video-1.5",
            )
        return path
    if not path or not ENDPOINT_PATTERN.match(path) or ".." in path:
        raise HTTPException(
            status_code=400,
            detail="Model path must start with / and look like a WaveSpeed model path, such as /alibaba/wan-2.2/video-edit",
        )
    return path


def _confirm_provider_model(info: AdapterInfo, endpoint: str, *, allow_empty: bool) -> None:
    """Refuse a new id that the provider does not list for this key."""
    if not endpoint:
        if allow_empty:
            return
        if info.provider == "xai":
            raise HTTPException(
                status_code=400,
                detail="Enter an x.ai model id. Look up the list and pick one that exists on your key.",
            )
        return
    try:
        provider_catalog.ensure_remote_model(info.provider, endpoint)
    except provider_catalog.ProviderModelNotFound as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except provider_catalog.ProviderLookupError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def _clean_token(info: AdapterInfo, raw: str) -> str:
    token = (raw or "").strip()
    if not info.needs_reference_token:
        return ""
    if not token or len(token) > 40:
        raise HTTPException(
            status_code=400,
            detail="Reference token is required (for example Image 1 or @Image 1)",
        )
    return token


def _clean_variant(info: AdapterInfo, raw: str) -> str:
    variant = (raw or "").strip()
    if not info.needs_variant:
        return ""
    if variant not in ("wan30", "seedance"):
        raise HTTPException(
            status_code=400,
            detail="Pick a payload style: WAN 3.0 or Seedance",
        )
    return variant


def _clean_label(raw: str) -> str:
    label = raw.strip()
    if not label:
        raise HTTPException(status_code=400, detail="Model name is required")
    return label


def _row_to_spec(row: GenerationModel) -> GenerationModelSpec:
    return GenerationModelSpec(
        id=row.id,
        role=row.role,
        label=row.label,
        provider=row.provider,
        adapter=row.adapter,
        endpoint_path=row.endpoint_path or "",
        reference_token=row.reference_token or "",
        variant=row.variant or "",
        sort_order=row.sort_order,
    )


def _row_to_info(row: GenerationModel) -> GenerationModelInfo:
    spec = _row_to_spec(row)
    return GenerationModelInfo(
        id=row.id,
        role=row.role,
        label=row.label,
        provider=row.provider,
        adapter=row.adapter,
        endpoint_path=row.endpoint_path or "",
        reference_token=row.reference_token or "",
        variant=row.variant or "",
        takes_reference_image=spec.takes_reference_image,
        enabled=row.enabled,
        sort_order=row.sort_order,
        builtin=(row.role, row.id) in BUILTINS_BY_KEY,
    )


def _count(db: Session) -> int:
    return int(db.scalar(select(func.count()).select_from(GenerationModel)) or 0)


def ensure_generation_models_bootstrapped(db: Session) -> None:
    """Insert the built-in models when the table is empty."""
    if _count(db) > 0:
        return
    for spec in BUILTINS:
        db.add(
            GenerationModel(
                id=spec.id,
                role=spec.role,
                label=spec.label,
                provider=spec.provider,
                adapter=spec.adapter,
                endpoint_path=spec.endpoint_path,
                reference_token=spec.reference_token,
                variant=spec.variant,
                enabled=True,
                sort_order=spec.sort_order,
            )
        )
    db.flush()


def list_generation_models(
    db: Session,
    *,
    role: str | None = None,
    ensure_defaults: bool = True,
) -> list[GenerationModelInfo]:
    if ensure_defaults and _count(db) == 0:
        ensure_generation_models_bootstrapped(db)
    stmt = select(GenerationModel).order_by(
        GenerationModel.role,
        GenerationModel.sort_order,
        GenerationModel.label,
    )
    if role:
        stmt = stmt.where(GenerationModel.role == _require_role(role))
    return [_row_to_info(row) for row in db.scalars(stmt).all()]


def _label_taken(db: Session, role: str, label: str, *, ignore_id: str | None = None) -> bool:
    stmt = select(GenerationModel.id).where(
        GenerationModel.role == role,
        func.lower(GenerationModel.label) == label.lower(),
    )
    if ignore_id is not None:
        stmt = stmt.where(GenerationModel.id != ignore_id)
    return db.scalar(stmt) is not None


def _next_sort_order(db: Session, role: str) -> int:
    current = db.scalar(
        select(func.max(GenerationModel.sort_order)).where(GenerationModel.role == role)
    )
    return 0 if current is None else int(current) + 1


def create_generation_model(db: Session, request: CreateGenerationModelRequest) -> GenerationModelInfo:
    role = _require_role(request.role)
    model_id = safe_model_id(request.id)
    info = _adapter_for(request.adapter, role)
    label = _clean_label(request.label)
    if db.get(GenerationModel, (model_id, role)) is not None:
        raise HTTPException(status_code=409, detail="A model with that id already exists for this step")
    if _label_taken(db, role, label):
        raise HTTPException(status_code=409, detail="Another model on this step already uses that name")
    endpoint = _clean_endpoint(info, request.endpoint_path)
    _confirm_provider_model(info, endpoint, allow_empty=False)
    row = GenerationModel(
        id=model_id,
        role=role,
        label=label,
        provider=info.provider,
        adapter=info.id,
        endpoint_path=endpoint,
        reference_token=_clean_token(info, request.reference_token),
        variant=_clean_variant(info, request.variant),
        enabled=request.enabled,
        sort_order=_next_sort_order(db, role),
    )
    db.add(row)
    db.flush()
    return _row_to_info(row)


def update_generation_model(
    db: Session,
    role: str,
    model_id: str,
    request: UpdateGenerationModelRequest,
) -> GenerationModelInfo:
    role = _require_role(role)
    slug = safe_model_id(model_id)
    row = db.get(GenerationModel, (slug, role))
    if row is None:
        raise HTTPException(status_code=404, detail="Model not found")
    info = _adapter_for(request.adapter, role)
    label = _clean_label(request.label)
    if _label_taken(db, role, label, ignore_id=slug):
        raise HTTPException(status_code=409, detail="Another model on this step already uses that name")
    endpoint = _clean_endpoint(info, request.endpoint_path)
    stored = (row.endpoint_path or "").strip()
    if endpoint != stored:
        # A blank x.ai path is the env default. Clearing a pin must stay allowed;
        # a new non-empty id is still checked against the provider list.
        _confirm_provider_model(info, endpoint, allow_empty=not endpoint)
    row.label = label
    row.provider = info.provider
    row.adapter = info.id
    row.endpoint_path = endpoint
    row.reference_token = _clean_token(info, request.reference_token)
    row.variant = _clean_variant(info, request.variant)
    row.enabled = request.enabled
    if request.sort_order is not None:
        row.sort_order = request.sort_order
    db.flush()
    return _row_to_info(row)


def lookup_provider_models(request: LookupProviderModelsRequest) -> list[dict]:
    try:
        rows = provider_catalog.list_remote_models(
            request.provider,
            query=request.query,
            role=request.role,
        )
    except provider_catalog.ProviderLookupError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return [
        {
            "provider": row.provider,
            "model_id": row.model_id,
            "name": row.name,
            "kind": row.kind,
            "suggested_role": row.suggested_role,
            "suggested_adapter": row.suggested_adapter,
            "variant": row.variant,
            "reference_token": row.reference_token,
        }
        for row in rows
    ]


def check_provider_model(request: CheckProviderModelRequest) -> dict:
    provider = request.provider.strip().lower()
    if provider not in ("xai", "wavespeed"):
        raise HTTPException(status_code=400, detail="Provider must be x.ai or WaveSpeed")
    try:
        row = provider_catalog.ensure_remote_model(provider, request.model_id)
    except provider_catalog.ProviderModelNotFound as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except provider_catalog.ProviderLookupError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "provider": row.provider,
        "model_id": row.model_id,
        "name": row.name,
        "kind": row.kind,
        "suggested_role": row.suggested_role,
        "suggested_adapter": row.suggested_adapter,
        "variant": row.variant,
        "reference_token": row.reference_token,
    }


def delete_generation_model(db: Session, role: str, model_id: str) -> None:
    role = _require_role(role)
    slug = safe_model_id(model_id)
    row = db.get(GenerationModel, (slug, role))
    if row is None:
        raise HTTPException(status_code=404, detail="Model not found")
    db.delete(row)
    db.flush()


def _open_lookup_session() -> Session | None:
    try:
        import backend.db.engine as db_engine

        if db_engine.SessionLocal is None:
            db_engine.get_engine()
        if db_engine.SessionLocal is None:
            return None
        return db_engine.SessionLocal()
    except Exception:
        return None


def _fetch_row(role: str, model_id: str) -> GenerationModel | None:
    session = _open_lookup_session()
    if session is None:
        return None
    try:
        return session.get(GenerationModel, (model_id, role))
    except Exception:
        return None
    finally:
        session.close()


def enabled_ids(role: str) -> set[str] | None:
    """Enabled ids for a step, or None when the catalog cannot be read.

    An empty table means bootstrap has not run yet, so callers keep the built-in ids.
    """
    session = _open_lookup_session()
    if session is None:
        return None
    try:
        any_row = session.scalar(select(GenerationModel.id).limit(1))
        if any_row is None:
            return None
        rows = session.scalars(
            select(GenerationModel.id).where(
                GenerationModel.role == role,
                GenerationModel.enabled.is_(True),
            )
        ).all()
        return set(rows)
    except Exception:
        return None
    finally:
        session.close()


def accept_model_id(role: str, model_id: str | None, *, default: str) -> str:
    """Keep a catalog id. Unknown or disabled ids fall back to the step default."""
    canonical = canonical_model_id(role, model_id)
    enabled = enabled_ids(role)
    if enabled is None:
        if builtin_spec(role, canonical) is not None:
            return canonical
        return default
    if canonical in enabled:
        return canonical
    return default


def resolve_spec(role: str, model_id: str) -> GenerationModelSpec:
    """Row in the catalog wins, including a renamed path. Otherwise the built-in spec."""
    canonical = canonical_model_id(role, model_id)
    row = _fetch_row(role, canonical)
    if row is not None:
        return _row_to_spec(row)
    fallback = builtin_spec(role, canonical)
    if fallback is not None:
        return fallback
    return default_spec(role)


def model_label(role: str, model_id: str) -> str:
    return resolve_spec(role, model_id).label
