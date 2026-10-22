from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from backend.services import grok, wavespeed

AiProvider = Literal["xai", "wavespeed"]
# Catalog ids. Built-ins are grok-imagine / seedream-v5-lite; operators can add more.
SourceImageModel = str
BackgroundVideoModel = str
DressVideoModel = str
# How each WaveSpeed edit model expects the prompt to bind the first reference image.
DRESS_REFERENCE_TOKENS: dict[str, str] = {
    "wan-3.0-video-edit": "Image 1",
    "seedance-2.0-video-edit": "@Image 1",
}
SourceImageRoute = Literal["xai", "wavespeed", "seedream-v5-lite"]


def normalize_provider(provider: str | None) -> AiProvider:
    if provider in ("wavespeed", "seedream-v5-lite"):
        return "wavespeed"
    return "xai"


def _accept(role: str, model_id: str | None, *, default: str) -> str:
    from backend.generation_models_store import accept_model_id

    return accept_model_id(role, model_id, default=default)


def _spec(role: str, model_id: str):
    from backend.generation_models_store import resolve_spec

    return resolve_spec(role, model_id)


def normalize_source_image_model(
    image_model: str | None,
    *,
    provider: str | None = None,
) -> SourceImageModel:
    raw = (image_model or "").strip()
    # Old drafts stored Seedream on ai_provider and left the image model blank or on Grok.
    if provider in ("seedream-v5-lite", "seedream-v5.0-lite") and raw in ("", "grok-imagine"):
        raw = "seedream-v5-lite"
    # Alias mapping and disabled/deleted rows both live in accept_model_id.
    return _accept("source_image", raw, default="grok-imagine")


def normalize_background_video_model(model: str | None) -> BackgroundVideoModel:
    return _accept("background_video", model, default="grok-imagine")


def normalize_dress_video_model(model: str | None) -> DressVideoModel:
    return _accept("dress_video", model, default="grok-imagine")


def source_image_route(provider: AiProvider, image_model: SourceImageModel) -> SourceImageRoute:
    # The image-model dropdown is hidden for x.ai, so a leftover Seedream id
    # (the Video Flow default) must not send stills to WaveSpeed.
    if provider == "xai":
        return "xai"
    if _spec("source_image", image_model).adapter == "seedream_image":
        return "seedream-v5-lite"
    return "wavespeed"


def xai_key_available() -> bool:
    return bool(os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY"))


def _stored_xai_model(role: str, model_id: str) -> str:
    """Catalog id for an x.ai row. Empty means the env default still runs."""
    path = (_spec(role, model_id).endpoint_path or "").strip()
    if not path or path.startswith("/"):
        return ""
    return path


def is_moderation_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(
        term in msg
        for term in (
            "content moderation",
            "potentially sensitive",
            "flagged as potentially sensitive",
            "flagged",
        )
    )


def _with_xai_fallback(label: str, route: SourceImageRoute, action):
    if route != "wavespeed":
        return action(grok)
    try:
        return action(wavespeed)
    except RuntimeError as exc:
        if is_moderation_error(exc) and xai_key_available():
            print(f"WaveSpeed {label} blocked by moderation — retrying via x.ai ...")
            try:
                return action(grok)
            except RuntimeError as grok_exc:
                if is_moderation_error(grok_exc):
                    raise RuntimeError(
                        f"Both WaveSpeed and x.ai blocked this {label} (content moderation). "
                        "Use a neutral, fully-clothed studio portrait prompt, or upload a source image instead."
                    ) from grok_exc
                raise
        raise


def generate_portrait_image(
    *,
    provider: AiProvider,
    image_model: SourceImageModel = "grok-imagine",
    prompt: str,
    out: Path,
    face_image: str | Path | None = None,
    aspect_ratio: str = "9:16",
    lock_position: bool = False,
) -> Path:
    route = source_image_route(provider, image_model)
    if route == "seedream-v5-lite":
        return wavespeed.generate_portrait_image_seedream(
            prompt=prompt,
            out=out,
            face_image=face_image,
            aspect_ratio=aspect_ratio,
            endpoint=_spec("source_image", image_model).endpoint_path,
            lock_position=lock_position,
        )
    stored = _stored_xai_model("source_image", image_model)
    if route == "xai" and stored:
        return grok.generate_portrait_image(
            prompt=prompt,
            out=out,
            face_image=face_image,
            aspect_ratio=aspect_ratio,
            model=stored,
            lock_position=lock_position,
        )
    return _with_xai_fallback(
        "portrait generation",
        route,
        lambda module: module.generate_portrait_image(
            prompt=prompt,
            out=out,
            face_image=face_image,
            lock_position=lock_position,
            aspect_ratio=aspect_ratio,
        ),
    )


def swap_face_on_image(
    *,
    provider: AiProvider,
    image_model: SourceImageModel = "grok-imagine",
    base_image: str | Path,
    face_image: str | Path,
    out: Path,
    prompt: str | None = None,
    aspect_ratio: str = "9:16",
) -> Path:
    route = source_image_route(provider, image_model)
    if route == "seedream-v5-lite":
        return wavespeed.swap_face_on_image_seedream(
            base_image=base_image,
            face_image=face_image,
            out=out,
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            endpoint=_spec("source_image", image_model).endpoint_path,
        )
    stored = _stored_xai_model("source_image", image_model)
    if route == "xai" and stored:
        return grok.swap_face_on_image(
            base_image=base_image,
            face_image=face_image,
            out=out,
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            model=stored,
        )
    return _with_xai_fallback(
        "face swap",
        route,
        lambda module: module.swap_face_on_image(
            base_image=base_image,
            face_image=face_image,
            out=out,
            prompt=prompt,
            aspect_ratio=aspect_ratio,
        ),
    )


def lock_setup_face(
    *,
    base_image: str | Path,
    face_image: str | Path,
    out: Path,
    provider: AiProvider = "xai",
    image_model: SourceImageModel = "grok-imagine",
    aspect_ratio: str = "9:16",
) -> Path:
    """Hard identity lock for Setup face reference.

    Prefer WaveSpeed's dedicated image-face-swap (face region only). Edit-based
    Seedream/Grok swaps often transplant bangs/hair from selfie face refs and
    look pasted-on — those stay as fallbacks only.
    """
    if os.environ.get("WAVESPEED_API_KEY"):
        try:
            print("Face lock via WaveSpeed image-face-swap …")
            return wavespeed.swap_face_on_image(
                base_image=base_image,
                face_image=face_image,
                out=out,
                aspect_ratio=aspect_ratio,
            )
        except RuntimeError as exc:
            print(f"WaveSpeed image-face-swap failed ({exc}); falling back to edit swap …")
    return swap_face_on_image(
        provider=provider,
        image_model=image_model,
        base_image=base_image,
        face_image=face_image,
        out=out,
        prompt=None,
        aspect_ratio=aspect_ratio,
    )


def edit_image_scenery(
    *,
    provider: AiProvider,
    image_model: SourceImageModel = "grok-imagine",
    image: str | Path,
    theme: str,
    out: Path,
    aspect_ratio: str = "9:16",
    variation: str = "",
    prompt: str = "",
    face_image: str | Path | None = None,
) -> Path:
    """Replace backdrop on a still before image-to-video when the theme needs new scenery."""
    route = source_image_route(provider, image_model)
    if route == "seedream-v5-lite":
        return wavespeed.edit_image_scenery_seedream(
            image=image,
            theme=theme,
            out=out,
            aspect_ratio=aspect_ratio,
            endpoint=_spec("source_image", image_model).endpoint_path,
            variation=variation,
            prompt=prompt,
            face_image=face_image,
        )
    stored = _stored_xai_model("source_image", image_model)
    if route == "xai" and stored:
        return grok.edit_image_scenery(
            image=image,
            theme=theme,
            out=out,
            aspect_ratio=aspect_ratio,
            model=stored,
            variation=variation,
            prompt=prompt,
            face_image=face_image,
        )
    return _with_xai_fallback(
        "scenery edit",
        route,
        lambda module: module.edit_image_scenery(
            image=image,
            theme=theme,
            out=out,
            aspect_ratio=aspect_ratio,
            variation=variation,
            prompt=prompt,
            face_image=face_image,
        ),
    )


def edit_clothes_layer(
    *,
    provider: AiProvider,
    image_model: SourceImageModel = "grok-imagine",
    prompt: str,
    out: Path,
    source_image: str | Path,
    aspect_ratio: str = "9:16",
) -> Path:
    """Generate the TOP (clothes) layer from the bikini using Flux Kontext Pro.

    Kontext keeps every pixel that the prompt doesn't ask to change — pose, framing,
    background, and face are locked by construction, so no Match alignment is needed.
    Falls back to Grok edit when WaveSpeed key is unavailable.
    """
    route = source_image_route(provider, image_model)
    if route in ("wavespeed", "seedream-v5-lite"):
        return wavespeed.edit_clothes_layer_kontext(
            prompt=prompt,
            out=out,
            source_image=source_image,
            aspect_ratio=aspect_ratio,
        )
    # x.ai / Grok fallback — use standard single-image edit
    if provider == "xai" and xai_key_available():
        from backend.services import grok as grok_mod
        return grok_mod.edit_photo_scratch_layer(
            prompt=prompt,
            out=out,
            source_image=source_image,
            aspect_ratio=aspect_ratio,
            model=_stored_xai_model("source_image", image_model) or None,
        )
    return wavespeed.edit_clothes_layer_kontext(
        prompt=prompt,
        out=out,
        source_image=source_image,
        aspect_ratio=aspect_ratio,
    )


def edit_photo_scratch_layer(
    *,
    provider: AiProvider,
    image_model: SourceImageModel = "grok-imagine",
    prompt: str,
    out: Path,
    source_image: str | Path,
    background_image: str | Path | None = None,
    face_image: str | Path | None = None,
    bikini_image: str | Path | None = None,
    aspect_ratio: str = "9:16",
    images: list[str | Path] | None = None,
) -> Path:
    """Keep the Flow source girl's identity while building bikini/clothes photo-scratch layers.

    Girl + approved background (and/or a face identity reference) needs a multi-image edit
    (x.ai or Seedream). WaveSpeed Grok Imagine edit is single-image only — when WaveSpeed is
    selected with extra reference images, route through Seedream so we do not silently fall
    back to x.ai moderation.
    """
    route = source_image_route(provider, image_model)
    if images:
        from backend.services.image_refs import rewrite_image_tokens

        seedream = route == "seedream-v5-lite" or provider == "wavespeed"
        text = rewrite_image_tokens(prompt, style="seedream" if seedream else "grok")
        if seedream:
            payload = {
                "prompt": text,
                "images": [wavespeed.media_url(img, "image/png") for img in images],
                "size": wavespeed.aspect_ratio_to_seedream_size(aspect_ratio),
                "output_format": "png",
                "enable_base64_output": False,
                "enable_sync_mode": False,
            }
            wavespeed.run_image_task(
                wavespeed.seedream_paths(_spec("source_image", image_model).endpoint_path)[1],
                payload,
                out,
                label="seedream photo-scratch edit",
            )
            return out
        return grok.edit_photo_scratch_layer(
            prompt=text,
            out=out,
            source_image=images[0],
            aspect_ratio=aspect_ratio,
            model=_stored_xai_model("source_image", image_model) or None,
            named_images=images,
        )
    needs_multi = (
        background_image is not None or face_image is not None or bikini_image is not None
    )

    def _seedream_edit() -> Path:
        # Environment, woman, bikini, face last — matches photo_scratch bikini prompts.
        images: list[str | Path] = []
        if background_image is not None:
            images.append(background_image)
        images.append(source_image)
        if bikini_image is not None:
            images.append(bikini_image)
        if face_image is not None:
            images.append(face_image)
        payload = {
            "prompt": prompt,
            "images": [wavespeed.media_url(img, "image/png") for img in images],
            "size": wavespeed.aspect_ratio_to_seedream_size(aspect_ratio),
            "output_format": "png",
            "enable_base64_output": False,
            "enable_sync_mode": False,
        }
        wavespeed.run_image_task(
            wavespeed.seedream_paths(_spec("source_image", image_model).endpoint_path)[1],
            payload,
            out,
            label="seedream photo-scratch edit",
        )
        return out

    if route == "seedream-v5-lite":
        return _seedream_edit()

    # WaveSpeed + extra refs: Seedream can take them all; Grok Imagine edit cannot.
    if needs_multi and provider == "wavespeed":
        print("Photo-scratch: using Seedream for multi-reference composite (WaveSpeed)")
        return _seedream_edit()

    if provider == "xai" and xai_key_available():
        return grok.edit_photo_scratch_layer(
            prompt=prompt,
            out=out,
            source_image=source_image,
            background_image=background_image,
            face_image=face_image,
            bikini_image=bikini_image,
            aspect_ratio=aspect_ratio,
            model=_stored_xai_model("source_image", image_model) or None,
        )

    # WaveSpeed single-image edit (outfit change only — no background plate).
    return wavespeed.edit_photo_scratch_layer(
        prompt=prompt,
        out=out,
        source_image=source_image,
        aspect_ratio=aspect_ratio,
    )


def image_to_video(
    *,
    provider: AiProvider,
    image: str | Path,
    prompt: str,
    out: Path,
    model: str,
    resolution: str,
    image_field: str,
    endpoint: str,
    background_video_model: BackgroundVideoModel = "grok-imagine",
    enhance_motion_prompt: bool = True,
) -> None:
    final_prompt = grok.motion_prompt_for_model(grok.normalize_background_motion_prompt(prompt))
    if enhance_motion_prompt and xai_key_available():
        print(f"Enhancing motion prompt via {grok.chat_model()} ...")
        final_prompt = grok.enhance_prompt(
            final_prompt,
            grok.api_key(),
            system=grok.MOTION_ENHANCE_SYSTEM,
        )
        print(f"Enhanced motion prompt:\n  {final_prompt}\n")
    elif enhance_motion_prompt and not xai_key_available():
        print("Motion prompt enhancement skipped — XAI_API_KEY not set; using locked-camera prompt as written.")
    final_prompt = grok.append_motion_locks(final_prompt)

    spec = _spec("background_video", background_video_model)
    if spec.adapter == "wan_spicy_i2v":
        wavespeed.image_to_video_wan_spicy(
            image=image,
            prompt=final_prompt,
            out=out,
            resolution=resolution or "720p",
            path=spec.endpoint_path,
            label=spec.label,
        )
        return
    stored = (spec.endpoint_path or "").strip()
    grok_model = stored if stored and not stored.startswith("/") else model
    # Already enhanced above when possible; avoid a second chat pass in grok.image_to_video.
    grok.image_to_video(
        image=image,
        prompt=final_prompt,
        out=out,
        model=grok_model,
        resolution=resolution,
        image_field=image_field,
        endpoint=endpoint,
        enhance=False,
    )


def _numbered_reference_token(token: str, index: int) -> str:
    base = token or "Image 1"
    if "1" in base:
        return base.replace("1", str(index))
    return f"{base} {index}"


def _identity_still_clause(token: str) -> str:
    return (
        f"{token} is a still of the exact woman in this video. "
        f"Keep her face, hair color, hair length, hair style, skin tone, body, pose, and hands "
        f"identical to {token}. Change only her clothes."
    )


def edit_video(
    *,
    provider: AiProvider,
    video: str | Path,
    prompt: str,
    out: Path,
    model: str,
    resolution: str,
    video_field: str,
    enhance: bool,
    prepare_compatible: bool,
    enhance_system: str = grok.DRESS_ENHANCE_SYSTEM,
    reference_image: str | Path | None = None,
    identity_image: str | Path | None = None,
    reference_field: str = "image",
    dress_video_model: DressVideoModel = "grok-imagine",
) -> None:
    spec = _spec("dress_video", dress_video_model)
    native_reference_token = spec.reference_token or DRESS_REFERENCE_TOKENS.get(dress_video_model)
    identity_str = str(identity_image).strip() if identity_image is not None else ""
    if spec.adapter == "reference_video_edit":
        # These models take the reference image directly — no Grok captioning needed.
        token = native_reference_token or "Image 1"
        final_prompt = prompt
        reference_str = str(reference_image).strip() if reference_image is not None else ""
        if enhance and xai_key_available():
            print(f"Enhancing dress prompt via {grok.chat_model()} (for {dress_video_model}) ...")
            final_prompt = grok.enhance_prompt(final_prompt, grok.api_key(), system=enhance_system)
            print(f"Enhanced dress prompt:\n  {final_prompt}\n")
        elif enhance:
            print("Dress prompt enhancement skipped — XAI_API_KEY not set; using prompt as written.")
        if identity_str:
            who = _numbered_reference_token(token, 1)
            final_prompt = f"{_identity_still_clause(who)} {final_prompt}"
        if reference_str:
            outfit_token = _numbered_reference_token(token, 2 if identity_str else 1)
            final_prompt = (
                f"{final_prompt.rstrip()}\n\n"
                f"CRITICAL — dress her in the exact outfit shown in {outfit_token} "
                "(shape, color, cut, accessories, emissive glow/shine). "
                "Copy the clothes only — do not copy that person's face, hair, or body. "
                "Keep her face, hair, body, pose, motion, framing, and background unchanged."
            )
        final_prompt = grok.append_dress_identity_lock(final_prompt)
        images = [item for item in (identity_str, reference_str) if item]
        edit_fn = (
            wavespeed.edit_video_seedance2
            if spec.variant == "seedance"
            else wavespeed.edit_video_wan30
        )
        edit_fn(
            video=video,
            prompt=final_prompt,
            out=out,
            resolution=resolution or "720p",
            reference_image=None if identity_str else (reference_str or None),
            reference_images=images if identity_str else None,
            path=spec.endpoint_path,
            label=spec.label,
        )
        return
    if spec.adapter == "prompt_video_edit":
        final_prompt = prompt
        reference_str = str(reference_image).strip() if reference_image is not None else ""
        caption = ""
        if (enhance or reference_str) and xai_key_available():
            key = grok.api_key()
            if reference_str:
                print(f"Captioning dress reference image via {grok.vision_model()} ...")
                caption = grok.describe_outfit(reference_str, key) or ""
                if caption:
                    print(f"Reference outfit caption:\n  {caption}\n")
            if enhance:
                print(f"Enhancing dress prompt via {grok.chat_model()} (for WAN edit) ...")
                final_prompt = grok.enhance_prompt(final_prompt, key, system=enhance_system)
                print(f"Enhanced dress prompt:\n  {final_prompt}\n")
            # Caption before the identity lock: outfit match wins on clothes, lock forbids a recast.
            if caption:
                final_prompt = (
                    f"{final_prompt.rstrip()}\n\n"
                    f"CRITICAL — match the dress reference image outfit exactly "
                    f"(shape, color, cut, accessories, emissive glow/shine). "
                    f"Copy the clothes only, not that person's face or hair: {caption}"
                )
        elif enhance and not xai_key_available():
            print("Dress prompt enhancement skipped — XAI_API_KEY not set; using prompt as written.")
        final_prompt = grok.append_dress_identity_lock(final_prompt)
        if identity_str:
            # WAN 2.2 is prompt-only and recasts her face. WAN 3.0 can take the
            # still, but that edit times out. Grok edits the clip itself.
            print(
                "Prompt-only video edit recasts her face. "
                "Using Grok video edit so she stays the woman in the clip."
            )
            grok.edit_video(
                video=video,
                prompt=final_prompt,
                out=out,
                model=model,
                resolution=resolution,
                video_field=video_field,
                enhance=False,
                prepare_compatible=prepare_compatible,
                enhance_system=enhance_system,
                reference_image=None,
            )
            return
        wavespeed.edit_video_wan22(
            video=video,
            prompt=final_prompt,
            out=out,
            resolution=resolution or "720p",
            reference_image=None,
            path=spec.endpoint_path,
            label=spec.label,
        )
        return
    stored = (spec.endpoint_path or "").strip()
    grok_model = stored if stored and not stored.startswith("/") else model
    grok.edit_video(
        video=video,
        prompt=prompt,
        out=out,
        model=grok_model,
        resolution=resolution,
        video_field=video_field,
        enhance=enhance,
        prepare_compatible=prepare_compatible,
        enhance_system=enhance_system,
        reference_image=reference_image,
        reference_field=reference_field,
    )
