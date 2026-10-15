"""Live model lists from WaveSpeed and x.ai, used when an operator adds a model."""

from __future__ import annotations

import re
import time
from dataclasses import dataclass

from backend.services import grok, wavespeed

CACHE_SECONDS = 300

_cache: dict[str, tuple[float, list[RemoteModel]]] = {}


class ProviderLookupError(RuntimeError):
    """The provider catalog could not be read (missing key or HTTP failure)."""


class ProviderModelNotFound(LookupError):
    """The id or path is not in the provider catalog for this key."""


@dataclass(frozen=True)
class RemoteModel:
    provider: str
    model_id: str
    name: str
    kind: str
    suggested_role: str
    suggested_adapter: str
    variant: str = ""
    reference_token: str = ""


def list_remote_models(provider: str, *, query: str = "", role: str = "") -> list[RemoteModel]:
    provider = provider.strip().lower()
    if provider not in ("xai", "wavespeed"):
        raise ProviderLookupError("Provider must be x.ai or WaveSpeed")
    rows = _cached(provider)
    needle = _loose(query)
    matched = []
    for row in rows:
        if role and row.suggested_role != role:
            continue
        haystack = _loose(f"{row.name} {row.model_id} {row.kind}")
        if needle and needle not in haystack:
            continue
        matched.append(row)
    return matched[:40]


def ensure_remote_model(provider: str, model_id: str) -> RemoteModel:
    wanted = _normalize_id(provider, model_id)
    if not wanted:
        raise ProviderModelNotFound("Enter a model id or WaveSpeed path first")
    for row in _cached(provider):
        if _normalize_id(provider, row.model_id) == wanted:
            return row
    label = "x.ai" if provider == "xai" else "WaveSpeed"
    raise ProviderModelNotFound(
        f"{wanted} is not on your {label} key. Look up the current list and pick a model that exists."
    )


def _cached(provider: str) -> list[RemoteModel]:
    cached = _cache.get(provider)
    now = time.monotonic()
    if cached and now - cached[0] < CACHE_SECONDS:
        return cached[1]
    rows = _fetch_xai() if provider == "xai" else _fetch_wavespeed()
    _cache[provider] = (now, rows)
    return rows


def clear_remote_model_cache() -> None:
    _cache.clear()


def _loose(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (text or "").lower())


def _normalize_id(provider: str, model_id: str) -> str:
    raw = (model_id or "").strip()
    if provider == "wavespeed":
        if raw.startswith("/api/v3/"):
            raw = "/" + raw[len("/api/v3/") :]
        elif raw and not raw.startswith("/"):
            raw = "/" + raw
        return raw.rstrip("/")
    return raw


def _fetch_wavespeed() -> list[RemoteModel]:
    try:
        payload = wavespeed.api_get("/models", wavespeed.api_key())
    except RuntimeError as exc:
        raise ProviderLookupError(str(exc)) from exc
    if not isinstance(payload, dict):
        raise ProviderLookupError("WaveSpeed model list was not an object")
    data = payload.get("data")
    rows = data if isinstance(data, list) else []
    found: list[RemoteModel] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        path = _wavespeed_path(row)
        if not path or path in seen:
            continue
        seen.add(path)
        kind = str(row.get("type") or "")
        role, adapter, variant, token = _suggest_wavespeed(path, kind)
        name = str(row.get("name") or row.get("model_id") or path).strip() or path
        found.append(
            RemoteModel(
                provider="wavespeed",
                model_id=path,
                name=name,
                kind=kind,
                suggested_role=role,
                suggested_adapter=adapter,
                variant=variant,
                reference_token=token,
            )
        )
    return found


def _wavespeed_path(row: dict) -> str:
    schema = row.get("api_schema") if isinstance(row.get("api_schema"), dict) else {}
    schemas = schema.get("api_schemas") if isinstance(schema.get("api_schemas"), list) else []
    for item in schemas:
        if not isinstance(item, dict):
            continue
        api_path = str(item.get("api_path") or "").strip()
        if api_path.startswith("/api/v3/"):
            return "/" + api_path[len("/api/v3/") :].rstrip("/")
    model_id = str(row.get("model_id") or "").strip().strip("/")
    if model_id:
        return "/" + model_id
    return ""


def _suggest_wavespeed(path: str, kind: str) -> tuple[str, str, str, str]:
    text = f"{path} {kind}".lower()
    if "image-to-video" in text:
        return "background_video", "wan_spicy_i2v", "", ""
    if "video-edit" in text or "video-to-video" in text:
        if "seedance" in text:
            return "dress_video", "reference_video_edit", "seedance", "@Image 1"
        if any(token in text for token in ("wan-3", "wan-2.7", "wan-2.6", "wan-2.5")):
            return "dress_video", "reference_video_edit", "wan30", "Image 1"
        return "dress_video", "prompt_video_edit", "", ""
    if "seedream" in text or kind in ("text-to-image", "image-to-image"):
        return "source_image", "seedream_image", "", ""
    return "source_image", "seedream_image", "", ""


def _fetch_xai() -> list[RemoteModel]:
    try:
        key = grok.api_key()
    except RuntimeError as exc:
        raise ProviderLookupError(str(exc)) from exc
    by_id: dict[str, dict] = {}
    errors: list[str] = []
    for path, collection in (("/v1/models", "data"), ("/v1/video-generation-models", "models")):
        try:
            payload = grok.api_get(path, key)
        except RuntimeError as exc:
            errors.append(str(exc))
            continue
        rows = payload.get(collection)
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            model_id = str(row.get("id") or "").strip()
            if not model_id:
                continue
            current = by_id.get(model_id, {})
            current.update({key: value for key, value in row.items() if value not in (None, "", [])})
            current["id"] = model_id
            by_id[model_id] = current
    if not by_id:
        detail = errors[0] if errors else "x.ai returned no models"
        raise ProviderLookupError(detail)
    found: list[RemoteModel] = []
    for model_id, row in by_id.items():
        role, adapter = _suggest_xai(model_id, row)
        found.append(
            RemoteModel(
                provider="xai",
                model_id=model_id,
                name=model_id,
                kind=_xai_kind(row),
                suggested_role=role,
                suggested_adapter=adapter,
            )
        )
    found.sort(key=lambda item: item.model_id)
    return found


def _xai_kind(row: dict) -> str:
    outputs = row.get("output_modalities")
    if isinstance(outputs, list) and outputs:
        return ",".join(str(item) for item in outputs)
    return ""


def _suggest_xai(model_id: str, row: dict) -> tuple[str, str]:
    outputs = {str(item) for item in row.get("output_modalities") or []}
    inputs = {str(item) for item in row.get("input_modalities") or []}
    ident = model_id.lower()
    if "video" in outputs and "video" in inputs:
        return "dress_video", "grok_video_edit"
    if "video" in outputs or "video" in ident:
        return "background_video", "grok_i2v"
    return "source_image", "grok_image"
