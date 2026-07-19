from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path


EDITS_PATH = "/v1/videos/edits"
POLL_PATH = "/v1/videos/{request_id}"
CHAT_PATH = "/v1/chat/completions"
IMAGE_GENERATIONS_PATH = "/v1/images/generations"
IMAGE_EDITS_PATH = "/v1/images/edits"

DEFAULT_PORTRAIT_PROMPT = (
    "Medium full-body portrait of a woman in casual fitted resort wear, plain white studio "
    "background, facing camera, fashion editorial photo. Frame from head to mid-thigh so she "
    "fills most of the vertical frame — same camera distance as a standard fashion lookbook "
    "shot. Do not crop as a close-up face shot and do not pull back to a distant full-body "
    "wide shot with empty space."
)
LEGACY_BIKINI_PORTRAIT_PROMPT = (
    "Full-body portrait of a woman in a black bikini, plain white studio background, "
    "facing camera, fashion photo."
)
LEGACY_PORTRAIT_PROMPT = (
    "Full-body portrait of a woman in casual fitted resort wear, plain white studio background, "
    "facing camera, fashion editorial photo."
)

DEFAULT_BACKGROUND_MOTION_PROMPT = (
    "Animate this portrait into a seamless looping boomerang video. She wears a bikini, "
    "gentle swaying body motion only. She stays on the same spot. Locked camera: no zoom in, "
    "no zoom out, no dolly, no push-in, no pull-back, no walking toward or away from camera. "
    "Keep the exact same framing and subject size as the input image in every frame. "
    "Keep her face, identity, hair, and skin tone identical in every frame — same undertone, "
    "same lightness, no tan/pale flicker, no color grading shifts on skin. "
    "Perfect loop, warm beach lighting."
)
LEGACY_BACKGROUND_MOTION_PROMPT = (
    "Animate this portrait into a seamless looping boomerang video. She wears a bikini, "
    "gentle swaying body motion, steady camera, perfect loop, warm beach lighting."
)
LEGACY_LOCKED_CAMERA_MOTION_PROMPT = (
    "Animate this portrait into a seamless looping boomerang video. She wears a bikini, "
    "gentle swaying body motion only. She stays on the same spot. Locked camera: no zoom in, "
    "no zoom out, no dolly, no push-in, no pull-back, no walking toward or away from camera. "
    "Keep the exact same framing and subject size as the input image in every frame. "
    "Perfect loop, warm beach lighting."
)
FACE_SWAP_PROMPT = (
    "Replace the face in <IMAGE_0> with the face from <IMAGE_1>. "
    "Keep body, pose, outfit, background, and lighting identical."
)
PROMPT_WITH_FACE_PREFIX = (
    "Full-body portrait photo of the person from <IMAGE_0>, matching their face and identity. "
)
FACE_GUIDED_PORTRAIT_PROMPT = (
    "Medium full-body portrait photo of the person from <IMAGE_0>, matching their face and identity. "
    "Casual fitted resort wear, plain white studio background, facing camera, fashion editorial. "
    "Frame from head to mid-thigh so she fills most of the vertical frame — not a face close-up "
    "and not a distant wide shot."
)

MAX_DURATION_S = 8.7
MAX_SHORT_SIDE = 720
MAX_INLINE_MB = 18
POLL_INTERVAL_S = 5
POLL_TIMEOUT_S = 600
API_TIMEOUT_S = 120
API_MAX_RETRIES = 6
API_RETRY_BASE_S = 2
DOWNLOAD_MAX_RETRIES = 4

ENHANCE_SYSTEM = (
    "You rewrite a short clothing-change instruction into a single precise prompt "
    "for a video EDIT model. Rules: (1) The ONLY change allowed is the dress/outfit "
    "described. Describe it vividly (fabric, color, cut, length, fit). (2) Then "
    "explicitly command the model to keep EVERYTHING else identical: the same "
    "person, face, identity, hair, skin tone (same undertone and lightness in every "
    "frame — no tan/pale flicker), body, pose, hands, motion, camera, "
    "framing, subject scale / camera distance, background, lighting, shadows and "
    "colors. (3) Do NOT add scenery, style, mood, camera moves, zoom, dolly, "
    "effects or details that are not in the input. "
    "(4) Output ONLY the rewritten prompt, one paragraph, no preamble or quotes."
)

MOTION_ENHANCE_SYSTEM = (
    "You rewrite a short image-to-video motion instruction into a single precise prompt. "
    "Rules: (1) Keep the user's intended motion (sway, loop, boomerang, outfit notes) "
    "but make camera and framing ironclad. (2) Explicitly forbid zoom in/out, dolly, "
    "push-in, pull-back, orbit, and any walking toward or away from camera. (3) She "
    "must stay on the same spot; subject size and framing must match the input image "
    "in every frame. (4) Lock identity continuity: same face, hair, and skin tone in "
    "every frame — same undertone and lightness, no skin color flicker, no sudden "
    "tanning/paling, no beauty-filter shifts. (5) Prefer a seamless looping boomerang "
    "unless the user asked otherwise. (6) If the user asks for a theme, setting, location, or scenery "
    "(e.g. nurse clinic, hospital room, police station, beach, neon city), KEEP and "
    "STRENGTHEN that: place her in a clearly recognizable themed environment. Completely "
    "replace ANY existing background — city skylines, balconies, streets, outdoors, busy "
    "photos, studio, or plain walls — not only blank backdrops. Do NOT strip theme or "
    "scenery requests. Do NOT invent unrelated wardrobe changes beyond what the user wrote "
    "(bikini in step 1 stays a bikini). (7) Output ONLY the rewritten prompt, one "
    "paragraph, no preamble or quotes.")

DRESS_CAPTION_SYSTEM = (
    "You describe clothing for a video EDIT prompt. Look ONLY at the outfit worn "
    "by the person. Describe: (1) garment type (bodysuit, dress, top+bottom), cut, "
    "neckline, sleeves, length, fit; (2) the DOMINANT APPARENT COLOR as seen in the "
    "photo — if the fabric self-illuminates or glows, say what color the outfit "
    "READS AS overall (e.g. 'bright electric cyan-blue' not 'black with blue "
    "accents'); (3) emissive details: neon lines, luminous panels, LED shine, "
    "glow intensity (subtle trim vs whole garment blazing), bloom, and how much "
    "of the surface glows vs stays dark. Ignore face, body, hair, pose, background. "
    "Output 2-3 sentences about ONLY the outfit and its self-illumination — no "
    "preamble, no quotes."
)

DRESS_ENHANCE_SYSTEM = (
    "You rewrite a short instruction for a video EDIT model applied to an existing "
    "motion clip. Rules: (1) Replace the entire bikini/outfit with the dress/outfit "
    "described — both top and bottom, not a skirt overlay on a bikini. Describe "
    "fabric, apparent color, cut, length, fit, AND any emissive glow/neon/luminous "
    "shine on the garment vividly — garment glow is part of the outfit, not a scene "
    "effect; preserve glow intensity from the reference description. If the user "
    "names a themed costume or role (police, nurse, beach cover-up, etc.), keep that "
    "theme unmistakable — do NOT replace it with a generic evening gown. If a "
    "reference-outfit caption is present, that outfit wins over any conflicting "
    "description. (2) Keep the "
    "EXACT same background, scenery, lighting, shadows, and environment as the "
    "input video — do NOT replace the background with a green screen or any other "
    "scene. (3) Keep the same person, face, identity, hair, and skin tone "
    "frame-for-frame — same undertone and lightness as the input clip in every "
    "frame; no tan/pale flicker, no recoloring exposed skin. Keep body, pose, "
    "hands, motion, camera, framing, subject scale / camera distance, and timing "
    "identical — no zoom, dolly, or reframing. (4) Output ONLY "
    "the rewritten prompt, one paragraph, no preamble or quotes."
)


def api_key() -> str:
    key = os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")
    if not key:
        raise RuntimeError("Set XAI_API_KEY (or GROK_API_KEY) with your x.ai key.")
    return key


def api_base() -> str:
    return os.environ.get("XAI_API_BASE", "https://api.x.ai")


def chat_model() -> str:
    return os.environ.get("XAI_CHAT_MODEL", "grok-4")


def vision_model() -> str:
    return os.environ.get("XAI_VISION_MODEL", chat_model())


def video_generation_model() -> str:
    return os.environ.get("XAI_VIDEO_MODEL", "grok-imagine-video-1.5")


def video_edit_model(requested: str | None = None) -> str:
    override = os.environ.get("XAI_VIDEO_EDIT_MODEL")
    if override:
        return override
    if requested and requested not in ("grok-imagine-video-1.5",):
        return requested
    return "grok-imagine-video"


def image_generation_model() -> str:
    return os.environ.get("XAI_IMAGE_MODEL", "grok-imagine-image-quality")


def run_media_command(cmd: list[str]) -> bytes:
    result = subprocess.run(cmd, check=False, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed:\n{result.stderr.decode(errors='replace')}")
    return result.stdout


def probe_video(path: Path) -> dict[str, int | float | str]:
    out = run_media_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,codec_name:format=duration",
            "-of",
            "json",
            str(path),
        ]
    )
    info = json.loads(out)
    stream = info["streams"][0]
    return {
        "width": int(stream["width"]),
        "height": int(stream["height"]),
        "codec": stream.get("codec_name", "?"),
        "duration": float(info["format"]["duration"]),
    }


def compatible_size(width: int, height: int) -> tuple[int, int]:
    short_side = min(width, height)
    if short_side <= MAX_SHORT_SIDE:
        return width, height
    scale = MAX_SHORT_SIDE / short_side
    next_width = max(2, round(width * scale / 2) * 2)
    next_height = max(2, round(height * scale / 2) * 2)
    return next_width, next_height


def prepare_compatible_video(src: Path) -> Path:
    meta = probe_video(src)
    next_width, next_height = compatible_size(int(meta["width"]), int(meta["height"]))
    if (next_width, next_height) == (meta["width"], meta["height"]):
        return src

    out = src.parent / f"{src.stem}-grok-compatible.mp4"
    print(
        "Preparing Grok-compatible copy: "
        f"{meta['width']}x{meta['height']} -> {next_width}x{next_height}"
    )
    run_media_command(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(src),
            "-map",
            "0:v:0",
            "-vf",
            f"scale={next_width}:{next_height}",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(out),
        ]
    )
    return out


def check_grok_limits(src: Path) -> None:
    meta = probe_video(src)
    print(f"Input: {meta['width']}x{meta['height']} {meta['codec']} {meta['duration']:.2f}s")

    problems = []
    if float(meta["duration"]) > MAX_DURATION_S:
        problems.append(f"duration {meta['duration']:.2f}s > {MAX_DURATION_S}s")
    if min(int(meta["width"]), int(meta["height"])) > MAX_SHORT_SIDE:
        problems.append(f"resolution {meta['width']}x{meta['height']} exceeds {MAX_SHORT_SIDE}p")
    if problems:
        raise RuntimeError(
            "Incompatible with Grok (not uploading): "
            + "; ".join(problems)
            + ". Provide a clip within the limits."
        )


def to_data_uri(path: Path, mime: str) -> str:
    raw = path.read_bytes()
    mb = len(raw) / 1e6
    if mb > MAX_INLINE_MB:
        raise RuntimeError(
            f"Encoded input is {mb:.1f} MB (> {MAX_INLINE_MB} MB inline cap). "
            "Host it and pass an https URL instead."
        )
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def media_value(value: str | Path, default_mime: str) -> dict[str, str]:
    value_str = str(value)
    if value_str.startswith(("http://", "https://")):
        return {"url": value_str}
    path = Path(value_str)
    if not path.exists():
        raise RuntimeError(f"File not found: {path}")
    mime = mimetypes.guess_type(path.name)[0] or default_mime
    return {"url": to_data_uri(path, mime)}


def image_input(value: str | Path) -> dict[str, str]:
    media = media_value(value, "image/png")
    return {"url": media["url"], "type": "image_url"}


def api_post(path: str, payload: dict, key: str) -> dict:
    req = urllib.request.Request(
        api_base() + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    return send(req)


def api_get(path: str, key: str) -> dict:
    req = urllib.request.Request(
        api_base() + path,
        headers={"Authorization": f"Bearer {key}"},
        method="GET",
    )
    return send(req)


def request_id_sidecar(out: Path) -> Path:
    return out.with_suffix(out.suffix + ".request-id")


def output_video_ready(path: Path) -> bool:
    if not path.exists() or path.stat().st_size == 0:
        return False
    try:
        probe_video(path)
    except RuntimeError:
        return False
    return True


def format_http_error(exc: urllib.error.HTTPError, body: str) -> str:
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return f"API error {exc.code}:\n{body}"
    err = data.get("error") or data.get("message")
    if isinstance(err, str):
        lowered = err.lower()
        if "content moderation" in lowered:
            return (
                "xAI rejected the result (content moderation). "
                "Try WaveSpeed instead of x.ai, soften the prompt, or upload a file instead."
            )
        return f"xAI API error: {err}"
    return f"API error {exc.code}:\n{body}"


def send(req: urllib.request.Request, *, retries: int = API_MAX_RETRIES) -> dict:
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=API_TIMEOUT_S) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode(errors="replace")
            if exc.code in (408, 429, 500, 502, 503, 504) and attempt < retries - 1:
                wait = API_RETRY_BASE_S * (2**attempt)
                print(
                    f"  API {exc.code} on {req.full_url} "
                    f"(attempt {attempt + 1}/{retries}); retry in {wait}s ..."
                )
                time.sleep(wait)
                last_error = exc
                continue
            raise RuntimeError(format_http_error(exc, body)) from exc
        except (urllib.error.URLError, TimeoutError, ConnectionResetError, OSError) as exc:
            last_error = exc
            if attempt < retries - 1:
                wait = API_RETRY_BASE_S * (2**attempt)
                print(
                    f"  network error on {req.full_url} "
                    f"(attempt {attempt + 1}/{retries}): {exc}; retry in {wait}s ..."
                )
                time.sleep(wait)
                continue
            break
    raise RuntimeError(f"Network error contacting {req.full_url}: {last_error}") from last_error


def enhance_prompt(
    prompt: str,
    key: str,
    model: str | None = None,
    *,
    system: str = ENHANCE_SYSTEM,
) -> str:
    model = model or chat_model()
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.4,
    }
    result = api_post(CHAT_PATH, payload, key)
    try:
        text = result["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError):
        print("Enhance: unexpected chat response, using original prompt.")
        return prompt
    return text or prompt


def describe_outfit(image: str | Path, key: str, *, model: str | None = None) -> str:
    """Caption the outfit in a reference image so a video-edit prompt can apply it.

    The Grok /v1/videos/edits endpoint only conditions on the input video + text
    prompt (any reference-image field is ignored), so we turn the reference into
    words the edit model actually reads. Returns "" if captioning fails.
    """
    model = model or vision_model()
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": DRESS_CAPTION_SYSTEM},
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            "Describe only the outfit in this reference image. "
                            "Lead with the dominant apparent color (especially if "
                            "the garment glows or self-illuminates). Include glow "
                            "intensity and how much of the fabric is luminous."
                        ),
                    },
                    {"type": "image_url", "image_url": media_value(image, "image/png")},
                ],
            },
        ],
        "temperature": 0.2,
    }
    try:
        result = api_post(CHAT_PATH, payload, key)
        text = result["choices"][0]["message"]["content"].strip()
    except (RuntimeError, KeyError, IndexError, TypeError) as exc:
        print(f"Outfit caption failed ({exc}); continuing without reference caption.")
        return ""
    return text


def poll_video(request_id: str, key: str, *, label: str = "video generation") -> str:
    print(f"Request id: {request_id} - polling ...")
    started = time.time()
    while True:
        if time.time() - started > POLL_TIMEOUT_S:
            raise RuntimeError(f"Timed out waiting for {label}.")
        result = api_get(POLL_PATH.format(request_id=request_id), key)
        status = result.get("status")
        if status == "done":
            url = (result.get("video") or {}).get("url")
            if not url:
                raise RuntimeError(f"Done but no video url:\n{json.dumps(result, indent=2)}")
            return url
        if status in ("failed", "expired"):
            raise RuntimeError(f"{label.title()} {status}:\n{json.dumps(result, indent=2)}")
        print(f"  status={status} ...")
        time.sleep(POLL_INTERVAL_S)


def download_video(url: str, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading -> {out}")
    last_error: Exception | None = None
    for attempt in range(DOWNLOAD_MAX_RETRIES):
        try:
            urllib.request.urlretrieve(url, out)
            meta = probe_video(out)
            print(f"Saved {out} ({meta['width']}x{meta['height']} {meta['duration']:.2f}s)")
            return
        except (urllib.error.URLError, TimeoutError, ConnectionResetError, OSError, RuntimeError) as exc:
            last_error = exc
            if out.exists():
                out.unlink(missing_ok=True)
            if attempt < DOWNLOAD_MAX_RETRIES - 1:
                wait = API_RETRY_BASE_S * (2**attempt)
                print(
                    f"  download failed (attempt {attempt + 1}/{DOWNLOAD_MAX_RETRIES}): "
                    f"{exc}; retry in {wait}s ..."
                )
                time.sleep(wait)
                continue
            break
    raise RuntimeError(f"Failed to download video to {out}: {last_error}") from last_error


def download_image(url: str, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading image -> {out}")
    last_error: Exception | None = None
    for attempt in range(DOWNLOAD_MAX_RETRIES):
        try:
            urllib.request.urlretrieve(url, out)
            if not out.exists() or out.stat().st_size == 0:
                raise RuntimeError("Downloaded image is empty")
            print(f"Saved {out} ({out.stat().st_size} bytes)")
            return
        except (urllib.error.URLError, TimeoutError, ConnectionResetError, OSError, RuntimeError) as exc:
            last_error = exc
            if out.exists():
                out.unlink(missing_ok=True)
            if attempt < DOWNLOAD_MAX_RETRIES - 1:
                wait = API_RETRY_BASE_S * (2**attempt)
                print(
                    f"  image download failed (attempt {attempt + 1}/{DOWNLOAD_MAX_RETRIES}): "
                    f"{exc}; retry in {wait}s ..."
                )
                time.sleep(wait)
                continue
            break
    raise RuntimeError(f"Failed to download image to {out}: {last_error}") from last_error


def _save_image_bytes(raw: bytes, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(raw)
    print(f"Saved {out} ({len(raw)} bytes)")


def _image_url_from_response(result: dict) -> str | None:
    data = result.get("data")
    if not isinstance(data, list) or not data:
        return None
    entry = data[0]
    if not isinstance(entry, dict):
        return None
    url = entry.get("url")
    return url if isinstance(url, str) and url.strip() else None


def _save_image_response(result: dict, out: Path) -> None:
    data = result.get("data")
    if not isinstance(data, list) or not data:
        raise RuntimeError(f"No image data in response:\n{json.dumps(result, indent=2)}")
    entry = data[0]
    if not isinstance(entry, dict):
        raise RuntimeError(f"Unexpected image entry:\n{json.dumps(result, indent=2)}")
    b64 = entry.get("b64_json")
    if isinstance(b64, str) and b64.strip():
        _save_image_bytes(base64.b64decode(b64), out)
        return
    url = entry.get("url")
    if isinstance(url, str) and url.strip():
        download_image(url, out)
        return
    raise RuntimeError(f"No image url or b64_json in response:\n{json.dumps(result, indent=2)}")


def _generate_image(*, prompt: str, aspect_ratio: str, key: str) -> dict:
    payload = {
        "model": image_generation_model(),
        "prompt": prompt,
        "aspect_ratio": aspect_ratio,
        "response_format": "b64_json",
        "n": 1,
    }
    print(f"Generating image via {api_base()}{IMAGE_GENERATIONS_PATH} ...")
    print(f"Prompt: {prompt[:200]}{'...' if len(prompt) > 200 else ''}")
    return api_post(IMAGE_GENERATIONS_PATH, payload, key)


def _edit_image(
    *,
    prompt: str,
    aspect_ratio: str,
    key: str,
    images: list[str | Path] | None = None,
    image: str | Path | None = None,
) -> dict:
    payload: dict = {
        "model": image_generation_model(),
        "prompt": prompt,
        "aspect_ratio": aspect_ratio,
        "response_format": "b64_json",
        "n": 1,
    }
    if images:
        payload["images"] = [image_input(source) for source in images]
    elif image is not None:
        payload["image"] = image_input(image)
    else:
        raise RuntimeError("Image edit requires at least one source image.")
    print(f"Editing image via {api_base()}{IMAGE_EDITS_PATH} ...")
    print(f"Prompt: {prompt[:200]}{'...' if len(prompt) > 200 else ''}")
    return api_post(IMAGE_EDITS_PATH, payload, key)


def generate_portrait_image(
    *,
    prompt: str,
    out: Path,
    face_image: str | Path | None = None,
    aspect_ratio: str = "9:16",
) -> Path:
    key = api_key()
    text = prompt.strip() or DEFAULT_PORTRAIT_PROMPT
    if face_image:
        user_customized = bool(prompt.strip()) and not is_stock_portrait_prompt(prompt)
        final_prompt = (
            f"{PROMPT_WITH_FACE_PREFIX}{text}" if user_customized else FACE_GUIDED_PORTRAIT_PROMPT
        )
        result = _edit_image(
            prompt=final_prompt,
            aspect_ratio=aspect_ratio,
            key=key,
            image=face_image,
        )
    else:
        result = _generate_image(prompt=text, aspect_ratio=aspect_ratio, key=key)
    _save_image_response(result, out)
    return out


def is_stock_portrait_prompt(prompt: str) -> bool:
    stripped = prompt.strip()
    return not stripped or stripped in (
        DEFAULT_PORTRAIT_PROMPT,
        LEGACY_PORTRAIT_PROMPT,
        LEGACY_BIKINI_PORTRAIT_PROMPT,
    )


def is_stock_background_motion_prompt(prompt: str) -> bool:
    stripped = prompt.strip()
    return not stripped or stripped in (
        DEFAULT_BACKGROUND_MOTION_PROMPT,
        LEGACY_BACKGROUND_MOTION_PROMPT,
        LEGACY_LOCKED_CAMERA_MOTION_PROMPT,
    )


def normalize_background_motion_prompt(prompt: str) -> str:
    """Upgrade legacy/empty motion prompts to the locked-camera default."""
    if is_stock_background_motion_prompt(prompt):
        return DEFAULT_BACKGROUND_MOTION_PROMPT
    return prompt.strip()


def scenery_edit_prompt(theme: str) -> str:
    scenery = (theme or "").strip() or "warm beach"
    return (
        f"Replace the entire background behind the person with a vividly recognizable {scenery} "
        f"environment and matching lighting — a clear {scenery} location/scene, not a vague hint. "
        "Completely remove the original backdrop (city skyline, balcony, street, outdoors, studio, "
        "plain wall, or any other scene). Keep the same woman, face, identity, hair, skin tone, "
        "body, pose, bikini/outfit, hands, framing, and subject scale exactly. Do not crop, zoom, "
        "or reframe. Only change the background scenery."
    )


def edit_image_scenery(
    *,
    image: str | Path,
    theme: str,
    out: Path,
    aspect_ratio: str = "9:16",
) -> Path:
    """Bake themed scenery into a still before image-to-video (I2V alone rarely replaces busy BGs)."""
    key = api_key()
    text = scenery_edit_prompt(theme)
    print(f"Editing scenery into still ({(theme or '').strip() or 'warm beach'}) ...")
    result = _edit_image(prompt=text, aspect_ratio=aspect_ratio, key=key, image=image)
    _save_image_response(result, out)
    return out


# Per-slot pose / composition variety for bikini (and scene mood for backgrounds).
PHOTO_SCRATCH_POSE_VARIATIONS = [
    "standing centered, hands on hips, confident front-facing pose",
    "three-quarter turn toward camera, one hand in hair",
    "leaning casually against furniture or a wall prop in the scene",
    "seated on the edge of a chair or desk in the scene, legs crossed",
    "walking pose mid-stride toward camera, full body",
    "slight crouch / ready stance, weight on one leg",
    "hands clasped behind back, upright stance",
    "one hand on a desk or prop, looking over shoulder",
    "arms crossed, relaxed hip cock, medium-wide framing",
    "soft S-curve pose, weight shifted, looking at camera",
]

PHOTO_SCRATCH_SCENE_VARIATIONS = [
    "warm amber tones",
    "cool blue tones",
    "dramatic side lighting",
    "bright natural window light",
    "moody low-key lighting",
    "pastel colour palette",
    "dark richly saturated palette",
    "golden hour glow",
    "high-contrast cinematic lighting",
    "vivid neon accent lighting",
]


def photo_scratch_background_prompt(theme: str, variation: str = "") -> str:
    """Empty scene plate only — never include the girl (she is composited in the bikini step)."""
    scenery = (theme or "").strip() or "stylish"
    hint = f" {variation.strip()}." if variation.strip() else ""
    return (
        f"Empty {scenery} themed room/scene backdrop only — no people, no faces, no body. "
        f"Photorealistic, soft professional lighting, 9:16 vertical, suitable as a "
        f"scratch-card background plate.{hint}"
    )


def photo_scratch_bikini_prompt(
    theme: str,
    variation: str = "",
    *,
    with_background: bool = False,
) -> str:
    """Identity-locked bikini. With a bg plate: place the woman naturally inside the scene."""
    scenery = (theme or "").strip() or "stylish"
    pose = (variation or "").strip() or PHOTO_SCRATCH_POSE_VARIATIONS[0]
    if with_background:
        return (
            f"Two references: reference 1 = ENVIRONMENT (the full room/scene), "
            f"reference 2 = WOMAN (her face and body only). "
            f"Place the woman from reference 2 standing naturally INSIDE the scene from reference 1. "
            f"Rules: "
            f"(1) Her feet must rest on the floor of the scene — correct perspective and scale for the room. "
            f"(2) Full body from head to toe clearly visible. She must fill the 9:16 frame — "
            f"head near the top third, feet near the bottom edge, body occupying most of the vertical height. "
            f"Do NOT zoom out or leave large empty space above/below her. "
            f"(3) She wears a flattering {scenery} bikini/swimwear. "
            f"(4) Pose: {pose}. "
            f"(5) Her lighting, shadow, and colour temperature must match the room in reference 1. "
            f"(6) Completely erase her original backdrop — only the reference-1 environment shows behind her. "
            f"(7) Keep face, hair colour, skin tone, and body proportions exactly from reference 2. "
            f"(8) Do not invent a different woman. Photorealistic."
        )
    return (
        f"Using this exact same woman from the reference image, change her outfit to a "
        f"flattering {scenery} bikini/swimwear and restage her: {pose}. "
        f"Keep face, identity, hair, skin tone, and body proportions. "
        f"Clean studio backdrop (no busy scene). "
        f"Full body from head to toe, photorealistic, 9:16. Do not invent a different woman."
    )


def photo_scratch_clothes_pose_locks() -> str:
    """Shared limb / orientation locks for top-layer edits (raised-arm poses fail often)."""
    return (
        "FRONT VIEW ONLY — she faces the camera exactly as in the reference. "
        "Do NOT show her back, rear shoulder blade, spine, or buttocks. "
        "Do NOT twist the torso so one side looks like a back view. "
        "If an arm is raised (hand in hair / behind head), keep that exact raised-arm "
        "silhouette: same elbow height, same underarm opening, same hand in the hair — "
        "only change fabric on that arm. Do not invent a second sleeve, a flat blue "
        "panel, or a back-of-body fill in the armpit gap. "
        "Exactly one left arm and one right arm in the same places as the reference — "
        "no ghost limbs, no duplicate sleeves, no extra hands."
    )


def photo_scratch_clothes_prompt(theme: str, variation: str = "") -> str:
    """Top layer must fully cover the bikini body — only the outfit fabric changes."""
    scenery = (theme or "").strip() or "stylish"
    hint = f" Outfit detail: {variation.strip()}." if variation.strip() else ""
    return (
        f"Change ONLY the bikini fabric to a fully clothed {scenery} costume — nothing else. "
        f"The body underneath does NOT change: every curve, the bust size and projection, "
        f"waist, and hips stay exactly as they appear in the reference. "
        f"Make the costume a little bigger / fuller than a skintight wrap: slightly looser "
        f"sleeves, bodice, and skirt so fabric covers a bit past the bikini silhouette. "
        f"OPAQUE full coverage — no sheer fabric, no open zipper, no see-through panels. "
        f"The bikini must be completely hidden; no bikini print or skin where clothing "
        f"should be (sides, underarms, chest, hem). "
        f"Do not flatten, reduce, or reshape the chest or any other curve. "
        f"CRITICAL — the following must also be completely identical to the reference: "
        f"camera zoom level, focal length, crop, frame edges, body scale in frame, "
        f"head position in frame, feet position in frame, "
        f"body pose, arm angles, elbow bends, hand positions, hip stance, leg placement, "
        f"face, identity, hair, skin tone, background, room, lighting, shadow direction, "
        f"and BODY SHAPE — bust size, waist curve, hip width must be identical to the reference. "
        f"{photo_scratch_clothes_pose_locks()} "
        f"The outfit MUST fully cover the bikini body with a little extra fabric volume — "
        f"not skintight-shrunk. "
        f"Do NOT zoom out, widen the shot, or move the camera — the girl must fill "
        f"the same area of the 9:16 frame as in the reference.{hint} "
        f"FACE LOCK — keep her face identical to the reference: same eyes, nose, mouth, "
        f"and expression. No horizontal seams, smears, double mouths, or sliced nose "
        f"across the face. Sharp, natural skin — not airbrushed. "
        f"Photorealistic. Do not invent a different woman."
    )


def photo_scratch_custom_locks_source_pose(prompt: str) -> bool:
    """True when a user/FE prompt still asks to clone the source pose/studio wall."""
    lowered = (prompt or "").lower()
    return any(
        needle in lowered
        for needle in (
            "pose, and framing identical",
            "body, pose",
            "keep face, identity, hair, skin tone, body, pose",
            "transparent-friendly backdrop",
            "clean studio",
        )
    )


def photo_scratch_prompt_with_background(custom: str, *, has_background: bool, pose: str = "") -> str:
    """When a custom prompt is used with a bg plate, force scene placement + optional pose."""
    text = (custom or "").strip()
    if not text or not has_background:
        return text
    if photo_scratch_custom_locks_source_pose(text):
        # Stale studio/pose-lock text — rebuild from the with-bg template using theme words if any.
        return ""
    lowered = text.lower()
    extras: list[str] = []
    if "environment" not in lowered and "reference 1" not in lowered and "second reference" not in lowered:
        extras.append(
            "Use reference 1 as the full environment and reference 2 as the woman; "
            "completely replace her source backdrop with the environment."
        )
    if pose and pose.lower() not in lowered:
        extras.append(f"Pose and framing for this card: {pose}.")
    if not extras:
        return text
    return f"{text} {' '.join(extras)}"


def edit_photo_scratch_layer(
    *,
    prompt: str,
    out: Path,
    source_image: str | Path,
    background_image: str | Path | None = None,
    aspect_ratio: str = "9:16",
) -> Path:
    """Image-edit the Flow source girl (optionally onto a background) for a photo-scratch layer.

    When a background plate is present, send ENVIRONMENT first then WOMAN so models attend to
    the scene instead of cloning the source wall.
    """
    key = api_key()
    if background_image is not None:
        images: list[str | Path] = [background_image, source_image]
        print("Editing photo-scratch layer (2 refs: environment + woman) ...")
        result = _edit_image(
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            key=key,
            images=images,
        )
    else:
        print("Editing photo-scratch layer (1 ref: woman) ...")
        result = _edit_image(
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            key=key,
            image=source_image,
        )
    _save_image_response(result, out)
    return out


def swap_face_on_image(
    *,
    base_image: str | Path,
    face_image: str | Path,
    out: Path,
    prompt: str | None = None,
    aspect_ratio: str = "9:16",
) -> Path:
    key = api_key()
    final_prompt = (
        FACE_SWAP_PROMPT
        if is_stock_portrait_prompt(prompt or "")
        else (prompt or FACE_SWAP_PROMPT).strip()
    )
    result = _edit_image(
        prompt=final_prompt,
        aspect_ratio=aspect_ratio,
        key=key,
        images=[base_image, face_image],
    )
    _save_image_response(result, out)
    return out


def submit_video_job(
    *,
    endpoint: str,
    payload: dict,
    key: str,
    out: Path,
    label: str,
) -> str:
    sidecar = request_id_sidecar(out)
    if output_video_ready(out):
        meta = probe_video(out)
        print(
            f"Using existing {label}: {out.name} "
            f"({meta['width']}x{meta['height']} {meta['duration']:.2f}s)"
        )
        sidecar.unlink(missing_ok=True)
        return ""

    if sidecar.exists():
        request_id = sidecar.read_text(encoding="utf-8").strip()
        if request_id:
            print(f"Resuming {label} for request id: {request_id}")
            return request_id

    print(f"Submitting {label} to {api_base()}{endpoint} (model={payload.get('model')}) ...")
    submit = api_post(endpoint, payload, key)
    request_id = submit.get("request_id") or submit.get("id")
    if not request_id:
        raise RuntimeError(f"No request_id in response:\n{json.dumps(submit, indent=2)}")
    sidecar.write_text(request_id, encoding="utf-8")
    return request_id


def finish_video_job(request_id: str, key: str, out: Path, *, label: str) -> None:
    if not request_id:
        return
    video_url = poll_video(request_id, key, label=label)
    download_video(video_url, out)
    request_id_sidecar(out).unlink(missing_ok=True)


def edit_video(
    *,
    video: str | Path,
    prompt: str,
    out: Path,
    model: str,
    resolution: str,
    video_field: str,
    enhance: bool,
    prepare_compatible: bool,
    enhance_system: str = ENHANCE_SYSTEM,
    reference_image: str | Path | None = None,
    reference_field: str = "image",
) -> None:
    key = api_key()
    video_str = str(video)
    if video_str.startswith(("http://", "https://")):
        video_value = {"url": video_str}
        print(f"Using remote video URL: {video_str}")
    else:
        src = Path(video_str)
        if not src.exists():
            raise RuntimeError(f"Video not found: {src}")
        if prepare_compatible:
            src = prepare_compatible_video(src)
        check_grok_limits(src)
        video_value = {"url": to_data_uri(src, "video/mp4")}
        print("Encoded video inline (base64 data URI).")

    final_prompt = prompt
    reference_str = str(reference_image).strip() if reference_image is not None else ""
    caption = ""
    if reference_str:
        print(f"Captioning dress reference image via {vision_model()} ...")
        caption = describe_outfit(reference_str, key) or ""
        if caption:
            print(f"Reference outfit caption:\n  {caption}\n")
        else:
            print("Warning: reference image provided but outfit caption was empty.")

    if enhance:
        print(f"Enhancing prompt via {chat_model()} ...")
        final_prompt = enhance_prompt(final_prompt, key, system=enhance_system)
        print(f"Enhanced prompt:\n  {final_prompt}\n")

    # Append reference LAST so the caption wins over any enhance rewrite.
    if caption:
        final_prompt = (
            f"{final_prompt.rstrip()}\n\n"
            f"CRITICAL — match the dress reference image outfit exactly "
            f"(shape, color, cut, accessories, emissive glow/shine): {caption}"
        )

    edit_model = video_edit_model(model)
    if edit_model != model:
        print(f"Edit model: {edit_model} (replacing {model}, which does not support /v1/videos/edits)")

    payload = {"model": edit_model, "prompt": final_prompt, video_field: video_value}
    if reference_str:
        # Kept in case the endpoint later honors a reference field; today it is
        # ignored server-side, which is why we also fold the caption into the prompt.
        payload[reference_field] = media_value(reference_str, "image/png")
        print(f"Attached dress reference image via '{reference_field}' field: {reference_str}")
    request_id = submit_video_job(
        endpoint=EDITS_PATH,
        payload=payload,
        key=key,
        out=out,
        label="video edit",
    )
    finish_video_job(request_id, key, out, label="edit")


def image_to_video(
    *,
    image: str | Path,
    prompt: str,
    out: Path,
    model: str,
    resolution: str,
    image_field: str,
    endpoint: str,
    enhance: bool = True,
) -> None:
    key = api_key()
    final_prompt = normalize_background_motion_prompt(prompt)
    if enhance:
        print(f"Enhancing motion prompt via {chat_model()} ...")
        final_prompt = enhance_prompt(final_prompt, key, system=MOTION_ENHANCE_SYSTEM)
        print(f"Enhanced motion prompt:\n  {final_prompt}\n")
    payload = {
        "model": model,
        "prompt": final_prompt,
        image_field: media_value(image, "image/png"),
    }
    if resolution:
        payload["resolution"] = resolution

    request_id = submit_video_job(
        endpoint=endpoint,
        payload=payload,
        key=key,
        out=out,
        label="image-to-video",
    )
    finish_video_job(request_id, key, out, label="video generation")


def image_dress_flow(
    *,
    image: str | Path,
    motion_prompt: str,
    dress_prompt: str,
    base_video_out: Path,
    out: Path,
    enhance_dress_prompt: bool,
    model: str,
    resolution: str,
    image_field: str,
    video_field: str,
    endpoint: str,
) -> None:
    image_to_video(
        image=image,
        prompt=motion_prompt,
        out=base_video_out,
        model=model,
        resolution=resolution,
        image_field=image_field,
        endpoint=endpoint,
        enhance=True,
    )
    print("Starting dress edit on generated video ...")
    edit_video(
        video=base_video_out,
        prompt=dress_prompt,
        out=out,
        model=model,
        resolution=resolution,
        video_field=video_field,
        enhance=enhance_dress_prompt,
        prepare_compatible=True,
    )
    print(f"Flow complete: {out}")
