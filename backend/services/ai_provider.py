from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from backend.services import grok, wavespeed

AiProvider = Literal["xai", "wavespeed"]
SourceImageModel = Literal["grok-imagine", "seedream-v5-lite"]
BackgroundVideoModel = Literal["grok-imagine", "wan-2.2-spicy"]
DressVideoModel = Literal["grok-imagine", "wan-2.2-video-edit"]
SourceImageRoute = Literal["xai", "wavespeed", "seedream-v5-lite"]


def normalize_provider(provider: str | None) -> AiProvider:
    if provider in ("wavespeed", "seedream-v5-lite"):
        return "wavespeed"
    return "xai"


def normalize_source_image_model(
    image_model: str | None,
    *,
    provider: str | None = None,
) -> SourceImageModel:
    if image_model in ("seedream-v5-lite", "seedream-v5.0-lite") or provider in (
        "seedream-v5-lite",
        "seedream-v5.0-lite",
    ):
        return "seedream-v5-lite"
    return "grok-imagine"


def normalize_background_video_model(model: str | None) -> BackgroundVideoModel:
    if model in ("wan-2.2-spicy", "wan-2.2-spicy/image-to-video"):
        return "wan-2.2-spicy"
    return "grok-imagine"


def normalize_dress_video_model(model: str | None) -> DressVideoModel:
    if model in ("wan-2.2-video-edit", "wan-2.2/video-edit"):
        return "wan-2.2-video-edit"
    return "grok-imagine"


def source_image_route(provider: AiProvider, image_model: SourceImageModel) -> SourceImageRoute:
    if provider == "xai":
        return "xai"
    if image_model == "seedream-v5-lite":
        return "seedream-v5-lite"
    return "wavespeed"


def xai_key_available() -> bool:
    return bool(os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY"))


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
) -> Path:
    route = source_image_route(provider, image_model)
    if route == "seedream-v5-lite":
        return wavespeed.generate_portrait_image_seedream(
            prompt=prompt,
            out=out,
            face_image=face_image,
            aspect_ratio=aspect_ratio,
        )
    return _with_xai_fallback(
        "portrait generation",
        route,
        lambda module: module.generate_portrait_image(
            prompt=prompt,
            out=out,
            face_image=face_image,
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


def edit_image_scenery(
    *,
    provider: AiProvider,
    image_model: SourceImageModel = "grok-imagine",
    image: str | Path,
    theme: str,
    out: Path,
    aspect_ratio: str = "9:16",
) -> Path:
    """Replace backdrop on a still before image-to-video when the theme needs new scenery."""
    route = source_image_route(provider, image_model)
    if route == "seedream-v5-lite":
        return wavespeed.edit_image_scenery_seedream(
            image=image,
            theme=theme,
            out=out,
            aspect_ratio=aspect_ratio,
        )
    return _with_xai_fallback(
        "scenery edit",
        route,
        lambda module: module.edit_image_scenery(
            image=image,
            theme=theme,
            out=out,
            aspect_ratio=aspect_ratio,
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
    aspect_ratio: str = "9:16",
) -> Path:
    """Keep the Flow source girl's identity while building bikini/clothes photo-scratch layers.

    Girl + approved background (and/or a face identity reference) needs a multi-image edit
    (x.ai or Seedream). WaveSpeed Grok Imagine edit is single-image only — when WaveSpeed is
    selected with extra reference images, route through Seedream so we do not silently fall
    back to x.ai moderation.
    """
    route = source_image_route(provider, image_model)
    needs_multi = background_image is not None or face_image is not None

    def _seedream_edit() -> Path:
        # Environment first, woman second, face last — matches photo_scratch bikini prompts.
        images: list[str | Path] = []
        if background_image is not None:
            images.append(background_image)
        images.append(source_image)
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
            wavespeed.SEEDREAM_EDIT_PATH,
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
            aspect_ratio=aspect_ratio,
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
    final_prompt = grok.normalize_background_motion_prompt(prompt)
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

    if background_video_model == "wan-2.2-spicy":
        wavespeed.image_to_video_wan_spicy(
            image=image,
            prompt=final_prompt,
            out=out,
            resolution=resolution or "720p",
        )
        return
    # Already enhanced above when possible; avoid a second chat pass in grok.image_to_video.
    grok.image_to_video(
        image=image,
        prompt=final_prompt,
        out=out,
        model=model,
        resolution=resolution,
        image_field=image_field,
        endpoint=endpoint,
        enhance=False,
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
    reference_field: str = "image",
    dress_video_model: DressVideoModel = "grok-imagine",
) -> None:
    if dress_video_model == "wan-2.2-video-edit":
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
            # Append reference LAST so the caption wins over any enhance rewrite.
            if caption:
                final_prompt = (
                    f"{final_prompt.rstrip()}\n\n"
                    f"CRITICAL — match the dress reference image outfit exactly "
                    f"(shape, color, cut, accessories, emissive glow/shine): {caption}"
                )
        elif enhance and not xai_key_available():
            print("Dress prompt enhancement skipped — XAI_API_KEY not set; using prompt as written.")
        wavespeed.edit_video_wan22(
            video=video,
            prompt=final_prompt,
            out=out,
            resolution=resolution or "720p",
            reference_image=None,
        )
        return
    grok.edit_video(
        video=video,
        prompt=prompt,
        out=out,
        model=model,
        resolution=resolution,
        video_field=video_field,
        enhance=enhance,
        prepare_compatible=prepare_compatible,
        enhance_system=enhance_system,
        reference_image=reference_image,
        reference_field=reference_field,
    )
