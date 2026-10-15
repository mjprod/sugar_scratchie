"""Built-in Video Flow model specs and request-style metadata.

The database catalog can rename these, point them at a new provider path, or
add another model that uses one of these request styles. Dispatch lives in
``ai_provider`` and reads :func:`backend.generation_models_store.resolve_spec`.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AdapterInfo:
    id: str
    label: str
    roles: tuple[str, ...]
    provider: str
    needs_endpoint: bool
    needs_reference_token: bool = False
    needs_variant: bool = False
    endpoint_hint: str = ""


ADAPTERS: tuple[AdapterInfo, ...] = (
    AdapterInfo(
        id="grok_image",
        label="x.ai image (Grok Imagine)",
        roles=("source_image",),
        provider="xai",
        needs_endpoint=False,
    ),
    AdapterInfo(
        id="seedream_image",
        label="WaveSpeed image (Seedream-style)",
        roles=("source_image",),
        provider="wavespeed",
        needs_endpoint=True,
        endpoint_hint="/bytedance/seedream-v5.0-lite",
    ),
    AdapterInfo(
        id="wan_spicy_i2v",
        label="WaveSpeed image-to-video (WAN Spicy-style)",
        roles=("background_video",),
        provider="wavespeed",
        needs_endpoint=True,
        endpoint_hint="/wavespeed-ai/wan-2.2-spicy/image-to-video",
    ),
    AdapterInfo(
        id="grok_i2v",
        label="x.ai image-to-video (Grok Imagine)",
        roles=("background_video",),
        provider="xai",
        needs_endpoint=False,
    ),
    AdapterInfo(
        id="reference_video_edit",
        label="WaveSpeed video edit with a reference image",
        roles=("dress_video",),
        provider="wavespeed",
        needs_endpoint=True,
        needs_reference_token=True,
        needs_variant=True,
        endpoint_hint="/bytedance/seedance-2.0/video-edit",
    ),
    AdapterInfo(
        id="prompt_video_edit",
        label="WaveSpeed video edit, prompt only (WAN 2.2-style)",
        roles=("dress_video",),
        provider="wavespeed",
        needs_endpoint=True,
        endpoint_hint="/wavespeed-ai/wan-2.2/video-edit",
    ),
    AdapterInfo(
        id="grok_video_edit",
        label="x.ai video edit (Grok Imagine)",
        roles=("dress_video",),
        provider="xai",
        needs_endpoint=False,
    ),
)

ADAPTERS_BY_ID: dict[str, AdapterInfo] = {item.id: item for item in ADAPTERS}

ROLES = ("source_image", "background_video", "dress_video")


@dataclass(frozen=True)
class GenerationModelSpec:
    id: str
    role: str
    label: str
    provider: str
    adapter: str
    endpoint_path: str = ""
    reference_token: str = ""
    variant: str = ""
    sort_order: int = 0

    @property
    def takes_reference_image(self) -> bool:
        return self.adapter == "reference_video_edit"


BUILTINS: tuple[GenerationModelSpec, ...] = (
    GenerationModelSpec(
        id="grok-imagine",
        role="source_image",
        label="Grok Imagine",
        provider="xai",
        adapter="grok_image",
        sort_order=0,
    ),
    GenerationModelSpec(
        id="seedream-v5-lite",
        role="source_image",
        label="Seedream v5.0 Lite",
        provider="wavespeed",
        adapter="seedream_image",
        endpoint_path="/bytedance/seedream-v5.0-lite",
        sort_order=1,
    ),
    GenerationModelSpec(
        id="grok-imagine",
        role="background_video",
        label="x.ai Grok Imagine",
        provider="xai",
        adapter="grok_i2v",
        sort_order=0,
    ),
    GenerationModelSpec(
        id="wan-2.2-spicy",
        role="background_video",
        label="WaveSpeed WAN 2.2 Spicy",
        provider="wavespeed",
        adapter="wan_spicy_i2v",
        endpoint_path="/wavespeed-ai/wan-2.2-spicy/image-to-video",
        sort_order=1,
    ),
    GenerationModelSpec(
        id="seedance-2.0-video-edit",
        role="dress_video",
        label="WaveSpeed ByteDance Seedance 2.0 Video Edit",
        provider="wavespeed",
        adapter="reference_video_edit",
        endpoint_path="/bytedance/seedance-2.0/video-edit",
        reference_token="@Image 1",
        variant="seedance",
        sort_order=0,
    ),
    GenerationModelSpec(
        id="wan-3.0-video-edit",
        role="dress_video",
        label="WaveSpeed Alibaba WAN 3.0 Video Edit",
        provider="wavespeed",
        adapter="reference_video_edit",
        endpoint_path="/alibaba/wan-3.0/video-edit",
        reference_token="Image 1",
        variant="wan30",
        sort_order=1,
    ),
    GenerationModelSpec(
        id="wan-2.2-video-edit",
        role="dress_video",
        label="WaveSpeed WAN 2.2 Video Edit",
        provider="wavespeed",
        adapter="prompt_video_edit",
        endpoint_path="/wavespeed-ai/wan-2.2/video-edit",
        sort_order=2,
    ),
    GenerationModelSpec(
        id="grok-imagine",
        role="dress_video",
        label="x.ai Grok Imagine",
        provider="xai",
        adapter="grok_video_edit",
        sort_order=3,
    ),
)

BUILTINS_BY_KEY: dict[tuple[str, str], GenerationModelSpec] = {
    (item.role, item.id): item for item in BUILTINS
}

_DEFAULT_ID = {
    "source_image": "grok-imagine",
    "background_video": "grok-imagine",
    "dress_video": "wan-2.2-video-edit",
}

_BACKGROUND_ALIASES = {
    "wan-2.2-spicy/image-to-video": "wan-2.2-spicy",
}

_DRESS_ALIASES = {
    "grok-imagine-video": "grok-imagine",
    "alibaba/wan-3.0/video-edit": "wan-3.0-video-edit",
    "bytedance/seedance-2.0/video-edit": "seedance-2.0-video-edit",
}

_SOURCE_ALIASES = {
    "seedream-v5.0-lite": "seedream-v5-lite",
}


def builtin_spec(role: str, model_id: str) -> GenerationModelSpec | None:
    return BUILTINS_BY_KEY.get((role, model_id))


def default_spec(role: str) -> GenerationModelSpec:
    spec = BUILTINS_BY_KEY[(role, _DEFAULT_ID[role])]
    return spec


def canonical_model_id(role: str, model_id: str | None) -> str:
    raw = (model_id or "").strip()
    if role == "background_video":
        return _BACKGROUND_ALIASES.get(raw, raw)
    if role == "dress_video":
        return _DRESS_ALIASES.get(raw, raw)
    return _SOURCE_ALIASES.get(raw, raw)
