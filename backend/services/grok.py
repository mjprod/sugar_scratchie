from __future__ import annotations

import base64
import json
import mimetypes
import os
import random
import re
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path


EDITS_PATH = "/v1/videos/edits"
POLL_PATH = "/v1/videos/{request_id}"
CHAT_PATH = "/v1/chat/completions"
IMAGE_GENERATIONS_PATH = "/v1/images/generations"
IMAGE_EDITS_PATH = "/v1/images/edits"

# Card framing from public/guides/influencer-position.png.
# Head stays under the top band; body is centered; crop ends around mid-thigh.
INFLUENCER_POSITION = (
    "INFLUENCER POSITION — required framing for this card. "
    "Vertical 9:16. She stands centered and square to the camera, facing forward. "
    "Arms stay relaxed at her sides, slightly away from her torso, unless the pose only moves her arms. "
    "Leave a clear empty band across the top, about 8% of the frame: the top of her head sits "
    "just under that band and must never enter it or be cropped. "
    "Crop her around mid-thigh so about the bottom 20% of the frame shows only her upper legs. "
    "Do not show her feet, do not pull back to a distant full-body shot, and do not zoom into "
    "a face or chest close-up. "
    "She fills the center, with a gap between her hands and both side edges. "
    "Do not shift her left or right, closer or farther, and do not change camera height. "
    "A different pose may move her arms only. Her head height, crop, and scale stay identical."
)

DEFAULT_PORTRAIT_PROMPT = (
    "Portrait of a woman in casual fitted resort wear, plain white studio background, "
    "facing camera, fashion editorial photo. "
    f"{INFLUENCER_POSITION}"
)
LEGACY_LOOKBOOK_PORTRAIT_PROMPT = (
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
    "Portrait photo of the person from <IMAGE_0>, matching their face and identity. "
    "Casual fitted resort wear, plain white studio background, facing camera, fashion editorial. "
    f"{INFLUENCER_POSITION}"
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
    "person, face, identity, hair color, hair length, hair style, skin tone (same "
    "undertone and lightness in every frame — no tan/pale flicker), body, pose, "
    "hands, motion, camera, framing, subject scale / camera distance, background, "
    "lighting, shadows and colors. Do NOT recast her as a different woman. Do NOT "
    "add a wig, hood, headdress, veil, nemes, crown, or any head covering that hides "
    "or replaces her hair — a themed costume is clothing on this same woman, not a "
    "new character. (3) Do NOT add scenery, style, mood, camera moves, zoom, dolly, "
    "effects or details that are not in the input. "
    "(4) Output ONLY the rewritten prompt, one paragraph, no preamble or quotes."
)

MOTION_ENHANCE_SYSTEM = (
    "You rewrite a short image-to-video motion instruction into a single precise prompt. "
    "Rules: (1) Keep the user's intended motion (sway, loop, boomerang, outfit notes) "
    "but make camera and framing ironclad. (2) Explicitly forbid zoom in/out, dolly, "
    "push-in, pull-back, orbit, and any walking toward or away from camera. (3) She "
    "must stay on the same spot; subject size and framing must match the input image "
    "in every frame. (4) COLOR AND SKIN LOCK is mandatory and must survive the rewrite. "
    "Her skin undertone, lightness, hair color, and outfit color stay identical to the "
    "input portrait in every frame, including the loop back. No tan, pale, bronze, "
    "sunburn, flicker, beauty filter, white-balance shift, exposure change, or saturation "
    "change on her. Do NOT relight or color-grade her to match the new background. "
    "If the instruction says 'matching lighting', that light belongs to the scenery only. "
    "(5) Prefer a seamless looping boomerang "
    "unless the user asked otherwise. (6) If the user asks for a theme, setting, location, or scenery "
    "(e.g. nurse clinic, hospital room, police station, beach, neon city), KEEP and "
    "STRENGTHEN the background only: place her in a clearly recognizable themed environment. Completely "
    "replace ANY existing background — city skylines, balconies, streets, outdoors, busy "
    "photos, studio, or plain walls — not only blank backdrops. Do NOT strip theme or "
    "scenery requests. Do NOT invent unrelated wardrobe changes beyond what the user wrote "
    "(bikini in step 1 stays a bikini). Do NOT warm, cool, or grade her body because the "
    "scene is sunny or dramatic. (7) Output ONLY the rewritten prompt, one "
    "paragraph, no preamble or quotes.")

# Appended after motion-prompt enhancement. "Matching lighting" was tanning her
# to the new scene, so this lock is last and forbids relighting the subject.
MOTION_COLOR_LOCK = (
    "COLOR AND SKIN LOCK — her color stays identical to the input portrait in every "
    "frame, including the loop back to the first frame. Same skin undertone and lightness "
    "from start to end: no tan, no pale, no bronze, no sunburn, no flicker, no "
    "frame-to-frame shift. Do not relight her, color-grade her, warm her, cool her, or "
    "change exposure, white balance, or saturation on her skin, hair, or bikini to match "
    "the new background. Scene light stays in the background only. Hair color and bikini "
    "color stay exactly as in the input image."
)


def append_motion_color_lock(prompt: str) -> str:
    text = prompt.rstrip()
    marker = "COLOR AND SKIN LOCK — her color stays identical to the input portrait"
    if marker in text:
        return text
    return f"{text}\n\n{MOTION_COLOR_LOCK}"


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
    "theme unmistakable — do NOT replace it with a generic evening gown. The "
    "costume is clothing worn by the woman already in the video, not a recast "
    "character: do NOT change her face, and do NOT add a wig, hood, headdress, "
    "veil, nemes, crown, or any head covering that hides or replaces her hair. "
    "If a reference-outfit caption is present, that outfit wins over any conflicting "
    "description — copy the clothes only, never the reference person's face or hair. "
    "(2) Keep the "
    "EXACT same background, scenery, lighting, shadows, and environment as the "
    "input video — do NOT replace the background with a green screen or any other "
    "scene. (3) Keep the same person, face, identity, hair color, hair length, hair "
    "style, and skin tone frame-for-frame — same undertone and lightness as the "
    "input clip in every frame; no tan/pale flicker, no recoloring exposed skin or "
    "hair. Keep body, pose, hands, motion, camera, framing, subject scale / camera "
    "distance, and timing identical — no zoom, dolly, or reframing. (4) Output ONLY "
    "the rewritten prompt, one paragraph, no preamble or quotes."
)

# Appended after prompt enhancement so a rewrite cannot drop the identity lock.
# The Egypt edit was recasting her (new face, darker hair, hood over the hair).
DRESS_IDENTITY_LOCK = (
    "IDENTITY LOCK — she must be the exact same woman as the input video, only wearing "
    "different clothes. Same face in every frame: same eyes, nose, lips, jaw, makeup, and "
    "expression. Same hair: same color, length, style, and parting, fully visible — do not "
    "darken, lighten, or recolor it, and do not add a wig, hood, headdress, veil, nemes, "
    "crown, or any head covering that hides or replaces her hair. Same skin undertone and "
    "lightness in every frame — no tan, no pale, no flicker. Same body, pose, hands, arms, "
    "and motion. Same background, scenery, lighting, camera, framing, and subject scale — "
    "no zoom or camera move. Do not recast her as a different person."
)


def append_dress_identity_lock(prompt: str) -> str:
    text = prompt.rstrip()
    marker = "IDENTITY LOCK — she must be the exact same woman"
    if marker in text:
        return text
    return f"{text}\n\n{DRESS_IDENTITY_LOCK}"


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


def chosen_image_model(model: str | None = None) -> str:
    chosen = (model or "").strip()
    return chosen or image_generation_model()


def run_media_command(cmd: list[str]) -> bytes:
    result = subprocess.run(cmd, check=False, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed:\n{result.stderr.decode(errors='replace')}")
    return result.stdout


def extract_video_still(video: str | Path, out: Path, *, at_s: float = 0.35) -> Path:
    """Grab one frame so a video-edit model can see the woman it must keep."""
    src = Path(video)
    if not src.exists():
        raise RuntimeError(f"Video not found: {src}")
    out.parent.mkdir(parents=True, exist_ok=True)
    run_media_command(
        [
            "ffmpeg",
            "-y",
            "-ss",
            f"{at_s:.3f}",
            "-i",
            str(src),
            "-frames:v",
            "1",
            str(out),
        ]
    )
    if not out.is_file() or out.stat().st_size == 0:
        raise RuntimeError(f"Could not extract a still from {src}")
    return out


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


def compatible_size(
    width: int, height: int, max_short_side: int = MAX_SHORT_SIDE
) -> tuple[int, int]:
    short_side = min(width, height)
    if short_side <= max_short_side:
        return width, height
    scale = max_short_side / short_side
    next_width = max(2, round(width * scale / 2) * 2)
    next_height = max(2, round(height * scale / 2) * 2)
    return next_width, next_height


def prepare_compatible_video(
    src: Path, *, max_short_side: int = MAX_SHORT_SIDE, model_label: str = "Grok"
) -> Path:
    meta = probe_video(src)
    next_width, next_height = compatible_size(
        int(meta["width"]), int(meta["height"]), max_short_side
    )
    if (next_width, next_height) == (meta["width"], meta["height"]):
        return src

    if max_short_side == MAX_SHORT_SIDE:
        out = src.parent / f"{src.stem}-grok-compatible.mp4"
    else:
        out = src.parent / f"{src.stem}-{max_short_side}p-compatible.mp4"
    print(
        f"Preparing {model_label}-compatible copy: "
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


def check_video_limits(
    src: Path, *, max_duration_s: float, max_short_side: int, model_label: str
) -> None:
    meta = probe_video(src)
    print(f"Input: {meta['width']}x{meta['height']} {meta['codec']} {meta['duration']:.2f}s")

    problems = []
    if float(meta["duration"]) > max_duration_s:
        problems.append(f"duration {meta['duration']:.2f}s > {max_duration_s}s")
    if min(int(meta["width"]), int(meta["height"])) > max_short_side:
        problems.append(f"resolution {meta['width']}x{meta['height']} exceeds {max_short_side}p")
    if problems:
        raise RuntimeError(
            f"Incompatible with {model_label} (not uploading): "
            + "; ".join(problems)
            + ". Provide a clip within the limits."
        )


def check_grok_limits(src: Path) -> None:
    check_video_limits(
        src, max_duration_s=MAX_DURATION_S, max_short_side=MAX_SHORT_SIDE, model_label="Grok"
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


def _generate_image(*, prompt: str, aspect_ratio: str, key: str, model: str | None = None) -> dict:
    payload = {
        "model": chosen_image_model(model),
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
    model: str | None = None,
) -> dict:
    payload: dict = {
        "model": chosen_image_model(model),
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


def with_influencer_position(prompt: str) -> str:
    """Append the locked card framing unless this prompt is an empty scene plate."""
    text = (prompt or "").strip()
    if not text or "INFLUENCER POSITION" in text:
        return text
    lowered = text.lower()
    if "no people" in lowered or "no faces" in lowered or "backdrop only" in lowered:
        return text
    return f"{text}\n\n{INFLUENCER_POSITION}"


def generate_portrait_image(
    *,
    prompt: str,
    out: Path,
    face_image: str | Path | None = None,
    aspect_ratio: str = "9:16",
    model: str | None = None,
    lock_position: bool = False,
) -> Path:
    key = api_key()
    text = prompt.strip() or DEFAULT_PORTRAIT_PROMPT
    if face_image:
        user_customized = bool(prompt.strip()) and not is_stock_portrait_prompt(prompt)
        final_prompt = (
            f"{PROMPT_WITH_FACE_PREFIX}{text}" if user_customized else FACE_GUIDED_PORTRAIT_PROMPT
        )
    else:
        final_prompt = text
    if lock_position:
        final_prompt = with_influencer_position(final_prompt)
    if face_image:
        result = _edit_image(
            prompt=final_prompt,
            aspect_ratio=aspect_ratio,
            key=key,
            image=face_image,
            model=model,
        )
    else:
        result = _generate_image(prompt=final_prompt, aspect_ratio=aspect_ratio, key=key, model=model)
    _save_image_response(result, out)
    return out


def is_stock_portrait_prompt(prompt: str) -> bool:
    stripped = prompt.strip()
    return not stripped or stripped in (
        DEFAULT_PORTRAIT_PROMPT,
        LEGACY_LOOKBOOK_PORTRAIT_PROMPT,
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


def scenery_edit_prompt(theme: str, variation: str = "") -> str:
    scenery = (theme or "").strip() or "warm beach"
    lighting = f" Lighting for this take: {variation.strip()}." if variation.strip() else ""
    text = (
        f"Replace the entire background behind the person with a vividly recognizable {scenery} "
        f"environment and matching lighting — a clear {scenery} location/scene, not a vague hint. "
        "Completely remove the original backdrop (city skyline, balcony, street, outdoors, studio, "
        "plain wall, or any other scene). Keep the same woman, face, identity, hair, skin tone, "
        "body, pose, bikini/outfit, hands, and subject scale. Do not crop, zoom, "
        f"or reframe away from the influencer position. Only change the background scenery.{lighting}"
    )
    return with_influencer_position(text)


def resolve_scenery_prompt(theme: str, variation: str = "", prompt: str = "") -> str:
    """Operator prompt when set; otherwise the themed stock prompt. Lighting differs per take."""
    base = prompt.strip()
    if not base:
        return scenery_edit_prompt(theme, variation)
    hint = variation.strip()
    if hint and "Lighting for this take:" not in base:
        base = f"{base} Lighting for this take: {hint}."
    return with_influencer_position(base)


def motion_source_bikini_prompt(caption: str) -> str:
    """Single-image outfit edit for the step-1 still, driven by the bikini model's caption.

    Text-only beats sending the bikini photo as a second reference: multi-image edits keep
    the original top's shape, and the image pair trips x.ai moderation more often.
    """
    return (
        f"Change only her swimsuit. Dress her in this bikini: {caption.strip()} "
        f"Both the top and the bottoms must match that description in style and shape, "
        f"replacing her current top and bottoms entirely. Keep her face, hair, pose, arm, hand "
        f"and leg positions, body shape and proportions, background, lighting, camera framing, "
        f"crop, and subject scale identical. Do not crop, zoom, or reframe. Photorealistic."
    )


def motion_source_style_prompt(
    *, with_bikini: bool, with_face: bool, bikini_caption: str = ""
) -> str:
    """Step 1 prep: dress the Setup source in the bikini model's swimsuit and/or her face ref.

    Pose and framing must not move — the result is animated by image-to-video.
    Reference order matches `edit_photo_scratch_layer`: woman, bikini, face.
    """
    parts = ["reference 1 = WOMAN (pose, body, framing, background)"]
    if with_bikini:
        parts.append("reference 2 = BIKINI (the swimsuit to dress her in)")
    if with_face:
        parts.append(f"reference {len(parts) + 1} = FACE (her exact face)")
    refs = f"{_REF_WORDS.get(len(parts), str(len(parts)))} references: {', '.join(parts)}. "
    swimsuit = (
        f"{photo_scratch_bikini_ref_clause(2, bikini_caption)} "
        if with_bikini
        else "Keep her swimsuit exactly as in reference 1. "
    )
    return (
        f"{refs}"
        f"Edit the woman in reference 1. Keep EXACTLY: her pose, arm, hand and leg positions, "
        f"body shape and proportions, camera framing, crop, subject scale, background, and lighting. "
        f"Do not crop, zoom, or reframe. "
        f"{swimsuit}"
        f"{photo_scratch_face_ref_clause() if with_face else ''}"
        f"Photorealistic, 9:16. Do not invent a different woman."
    )


def edit_image_scenery(
    *,
    image: str | Path,
    theme: str,
    out: Path,
    aspect_ratio: str = "9:16",
    model: str | None = None,
    variation: str = "",
    prompt: str = "",
) -> Path:
    """Bake themed scenery into a still before image-to-video (I2V alone rarely replaces busy BGs)."""
    key = api_key()
    text = resolve_scenery_prompt(theme, variation, prompt)
    take = f", {variation.strip()}" if variation.strip() else ""
    print(f"Editing scenery into still ({(theme or '').strip() or 'warm beach'}{take}) ...")
    result = _edit_image(prompt=text, aspect_ratio=aspect_ratio, key=key, image=image, model=model)
    _save_image_response(result, out)
    return out


# (short label for the review UI, prompt text sent to the image model)
PHOTO_SCRATCH_POSE_OPTIONS: list[tuple[str, str]] = [
    ("Hands on hips, front", "standing centered, hands on hips, confident front-facing pose"),
    ("Three-quarter, hand in hair", "three-quarter turn toward camera, one hand in hair"),
    ("Weight on one hip", "standing with weight on one hip, both feet on the floor, not leaning on anything"),
    ("Ankles crossed", "standing upright with ankles crossed, not sitting"),
    ("Walking toward camera", "walking pose mid-stride toward camera, full body"),
    ("Crouch, weight on one leg", "slight crouch / ready stance, weight on one leg"),
    ("Hands behind back", "hands clasped behind back, upright stance"),
    ("Look over shoulder", "standing, looking back over one shoulder, hands free, not touching any prop"),
    ("Arms crossed", "arms crossed, relaxed hip cock, medium-wide framing"),
    ("Soft S-curve", "soft S-curve pose, weight shifted, looking at camera"),
]

PHOTO_SCRATCH_SCENE_OPTIONS: list[tuple[str, str]] = [
    ("Warm amber", "warm amber tones"),
    ("Cool blue", "cool blue tones"),
    ("Dramatic side light", "dramatic side lighting"),
    ("Bright window light", "bright natural window light"),
    ("Moody low light", "moody low-key lighting"),
    ("Pastel", "pastel colour palette"),
    ("Dark saturated", "dark richly saturated palette"),
    ("Golden hour", "golden hour glow"),
    ("High contrast", "high-contrast cinematic lighting"),
    ("Neon accent", "vivid neon accent lighting"),
]

# One locked card position. Pose and lighting still vary; where she stands does not.
PHOTO_SCRATCH_PLACEMENT_OPTIONS: list[tuple[str, str]] = [
    (
        "Influencer position",
        "Locked card position: centered, head under the top margin, cropped around mid-thigh.",
    ),
]

PHOTO_SCRATCH_POSE_VARIATIONS = [text for _label, text in PHOTO_SCRATCH_POSE_OPTIONS]
PHOTO_SCRATCH_SCENE_VARIATIONS = [text for _label, text in PHOTO_SCRATCH_SCENE_OPTIONS]
PHOTO_SCRATCH_PLACEMENT_VARIATIONS = [text for _label, text in PHOTO_SCRATCH_PLACEMENT_OPTIONS]

_DEFAULT_PLACEMENT = INFLUENCER_POSITION


@dataclass(frozen=True)
class PhotoScratchVariation:
    pose: str
    scene: str
    placement: str


def _shuffled_take(options: list[str], count: int, rng: random.Random) -> list[str]:
    if count <= 0:
        return []
    if not options:
        return [""] * count
    picked: list[str] = []
    while len(picked) < count:
        batch = list(options)
        rng.shuffle(batch)
        picked.extend(batch)
    return picked[:count]


def default_photo_scratch_variation_catalog() -> dict[str, list[dict[str, str]]]:
    """Built-in pose, lighting, and position options."""

    def rows(options: list[tuple[str, str]]) -> list[dict[str, str]]:
        return [{"label": label, "text": text} for label, text in options]

    return {
        "poses": rows(PHOTO_SCRATCH_POSE_OPTIONS),
        "scenes": rows(PHOTO_SCRATCH_SCENE_OPTIONS),
        "placements": rows(PHOTO_SCRATCH_PLACEMENT_OPTIONS),
    }


VARIATION_CATALOG_PATH = Path(__file__).resolve().parents[2] / ".tmp" / "photo-scratch-variations.json"
_VARIATION_GROUPS = ("poses", "scenes", "placements")


def _validate_variation_catalog(raw: object) -> dict[str, list[dict[str, str]]]:
    if not isinstance(raw, dict):
        raise ValueError("Catalog must be an object")
    cleaned: dict[str, list[dict[str, str]]] = {}
    for group in _VARIATION_GROUPS:
        rows = raw.get(group)
        if not isinstance(rows, list) or len(rows) == 0:
            raise ValueError(f"{group} needs at least one option")
        if len(rows) > 30:
            raise ValueError(f"{group} has too many options")
        cleaned_rows: list[dict[str, str]] = []
        seen: set[str] = set()
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError("Each option needs a label and text")
            label = str(row.get("label") or "").strip()
            text = str(row.get("text") or "").strip()
            if not label or not text:
                raise ValueError("Each option needs a label and text")
            if len(label) > 80 or len(text) > 400:
                raise ValueError("Option text is too long")
            if text in seen:
                raise ValueError(f"Duplicate {group} text")
            seen.add(text)
            cleaned_rows.append({"label": label, "text": text})
        cleaned[group] = cleaned_rows
    return cleaned


def _lock_placement_options(
    catalog: dict[str, list[dict[str, str]]],
) -> dict[str, list[dict[str, str]]]:
    """Position is the influencer guide. Pose and lighting stay editable."""
    catalog["placements"] = [
        {"label": label, "text": text} for label, text in PHOTO_SCRATCH_PLACEMENT_OPTIONS
    ]
    return catalog


def photo_scratch_variation_catalog() -> dict[str, list[dict[str, str]]]:
    """Pose, lighting, and position options, including operator edits."""
    path = VARIATION_CATALOG_PATH
    if path.is_file():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            return _lock_placement_options(_validate_variation_catalog(loaded))
        except (OSError, json.JSONDecodeError, ValueError):
            pass
    return default_photo_scratch_variation_catalog()


def save_photo_scratch_variation_catalog(raw: object) -> dict[str, list[dict[str, str]]]:
    """Replace the saved pose, lighting, and position options."""
    catalog = _lock_placement_options(_validate_variation_catalog(raw))
    path = VARIATION_CATALOG_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    return catalog


def apply_photo_scratch_variation_overrides(
    planned: dict[str, PhotoScratchVariation],
    overrides: dict[str, PhotoScratchVariation],
) -> dict[str, PhotoScratchVariation]:
    """Keep the shuffled plan, then replace any field the operator set in the review."""
    merged = dict(planned)
    for slot_id, override in overrides.items():
        base = merged.get(slot_id)
        if base is None:
            merged[slot_id] = override
            continue
        merged[slot_id] = PhotoScratchVariation(
            pose=(override.pose or "").strip() or base.pose,
            scene=(override.scene or "").strip() or base.scene,
            placement=(override.placement or "").strip() or base.placement,
        )
    return merged


def assign_photo_scratch_variations(
    slot_ids: list[str],
    rng: random.Random | None = None,
) -> dict[str, PhotoScratchVariation]:
    """Pick pose, lighting, and frame placement for a generation batch.

    Photo number does not choose the variation. One batch gets distinct options
    until a list runs out, then another shuffled pass. A later run of the same
    slots gets a new shuffle. Options come from the saved catalog, so deleted
    builtins stay gone and custom options can be drawn. Empty operator fields
    keep this shuffle.
    """
    catalog = photo_scratch_variation_catalog()
    chooser = rng or random.Random()

    def texts(group: str, fallback: list[str]) -> list[str]:
        rows = catalog.get(group) or []
        picked = [
            str(row.get("text") or "").strip()
            for row in rows
            if isinstance(row, dict)
        ]
        picked = [text for text in picked if text]
        return picked or fallback

    poses = _shuffled_take(texts("poses", PHOTO_SCRATCH_POSE_VARIATIONS), len(slot_ids), chooser)
    scenes = _shuffled_take(texts("scenes", PHOTO_SCRATCH_SCENE_VARIATIONS), len(slot_ids), chooser)
    placements = _shuffled_take(
        texts("placements", PHOTO_SCRATCH_PLACEMENT_VARIATIONS), len(slot_ids), chooser
    )
    return {
        slot_id: PhotoScratchVariation(poses[index], scenes[index], placements[index])
        for index, slot_id in enumerate(slot_ids)
    }


def photo_scratch_placement_clause(placement: str = "") -> str:
    """Every photo card uses the influencer position. Catalog text cannot move her."""
    del placement
    return _DEFAULT_PLACEMENT


_NO_FURNITURE = (
    "No furniture and no props — no chairs, desks, tables, sofas, beds, counters, or objects. "
    "Bare themed walls and floor only."
)
_NO_FURNITURE_INTERACTION = (
    "She stands on the floor and does not touch, lean on, sit on, or hold any furniture or object."
)


def photo_scratch_background_prompt(theme: str, variation: str = "") -> str:
    """Empty scene plate only — never include the girl (she is composited in the bikini step)."""
    scenery = (theme or "").strip() or "stylish"
    hint = f" {variation.strip()}." if variation.strip() else ""
    return (
        f"Empty {scenery} themed room/scene backdrop only — no people, no faces, no body. "
        f"{_NO_FURNITURE} "
        f"Photorealistic, soft professional lighting, 9:16 vertical, suitable as a "
        f"scratch-card background plate.{hint}"
    )


def photo_scratch_background_prompt_locked(prompt: str) -> str:
    """Keep a custom background prompt, but still forbid furniture and props."""
    text = (prompt or "").strip()
    if not text:
        return text
    if "no furniture" in text.lower():
        return text
    return f"{text} {_NO_FURNITURE}"


def photo_scratch_face_ref_clause() -> str:
    """Identity clause added when a dedicated face reference is the LAST image."""
    return (
        "FACE IDENTITY — the LAST reference image is a close-up of her exact face. "
        "Reproduce that face identically: same eyes, eyebrows, nose, mouth, jawline, "
        "cheekbones, skin tone, and hair colour. Her face in the result must look like "
        "the same real person as that face reference — not a lookalike. "
    )


def photo_scratch_bikini_ref_clause(ref_num: int, caption: str = "") -> str:
    """Swimsuit clause when a dedicated bikini model photo is attached as reference `ref_num`.

    `caption` (a vision description of that swimsuit) is spelled out because image edits
    tend to keep the original top's shape when the reference is only an image.
    """
    caption = (caption or "").strip()
    described = f" That swimsuit is: {caption}" if caption else ""
    return (
        f"Completely remove her original swimsuit/underwear — no trace of its cups, underwire, "
        f"ruffles, straps, or print may remain. "
        f"She wears EXACTLY the bikini/swimsuit from reference {ref_num}: same top style and "
        f"shape, cut, coverage, colours, pattern, straps, ties, and trims.{described} "
        f"Take only the swimsuit from reference {ref_num} — "
        f"not that model's face, hair, body, pose, or background."
    )


_REF_WORDS = {2: "Two", 3: "Three", 4: "Four"}


def photo_scratch_bikini_prompt(
    theme: str,
    variation: str = "",
    *,
    with_background: bool = False,
    with_face: bool = False,
    with_bikini: bool = False,
    bikini_caption: str = "",
    placement: str = "",
) -> str:
    """Identity-locked bikini. With a bg plate: place the woman naturally inside the scene.

    Reference order matches `edit_photo_scratch_layer`: environment, woman, bikini, face.
    """
    scenery = (theme or "").strip() or "stylish"
    pose = (variation or "").strip() or PHOTO_SCRATCH_POSE_VARIATIONS[0]
    framing = photo_scratch_placement_clause(placement)
    face_clause = photo_scratch_face_ref_clause() if with_face else ""
    woman_ref = 2 if with_background else 1
    bikini_ref = woman_ref + 1
    swimsuit = (
        photo_scratch_bikini_ref_clause(bikini_ref, bikini_caption)
        if with_bikini
        else f"She wears a flattering {scenery} bikini/swimwear."
    )
    if with_background:
        parts = ["reference 1 = ENVIRONMENT (the full room/scene)"]
        parts.append(
            "reference 2 = WOMAN (her body)" if with_face else "reference 2 = WOMAN (her face and body only)"
        )
        if with_bikini:
            parts.append(f"reference {bikini_ref} = BIKINI (the swimsuit to dress her in)")
        if with_face:
            parts.append(f"reference {len(parts) + 1} = FACE (her exact face)")
        refs = f"{_REF_WORDS[len(parts)]} references: {', '.join(parts)}. "
        kept = (
            "hair colour, skin tone, and body proportions"
            if with_face
            else "face, hair colour, skin tone, and body proportions"
        )
        return (
            f"{refs}"
            f"Place the woman from reference 2 standing naturally INSIDE the scene from reference 1. "
            f"Rules: "
            f"(1) Her feet must rest on the floor of the scene — correct perspective and scale for the room. "
            f"(2) {framing} "
            f"(3) {swimsuit} "
            f"(4) Pose: {pose}. {_NO_FURNITURE_INTERACTION} "
            f"(5) Her lighting, shadow, and colour temperature must match the room in reference 1. "
            f"(6) Completely erase her original backdrop — only the reference-1 environment shows behind her. "
            f"(7) Keep {kept} exactly from reference 2. "
            f"{face_clause}"
            f"(8) Do not invent a different woman. Photorealistic."
        )
    if with_bikini:
        # Face is attached last (woman, bikini, face). Name it or the face clause
        # points at an image this prompt never introduces.
        if with_face:
            return (
                f"Three references: reference 1 = WOMAN (her body), "
                f"reference 2 = BIKINI (the swimsuit to dress her in), "
                f"reference 3 = FACE (her exact face). "
                f"Using this exact same woman from reference 1, change her outfit and restage her: {pose}. "
                f"{framing} "
                f"{swimsuit} "
                f"Keep identity, hair, skin tone, and body proportions from reference 1. "
                f"{face_clause}"
                f"Clean studio backdrop (no busy scene). "
                f"Photorealistic, 9:16. Do not invent a different woman."
            )
        return (
            f"Reference 1 = WOMAN, reference 2 = BIKINI. "
            f"Using this exact same woman from reference 1, change her outfit and restage her: {pose}. "
            f"{framing} "
            f"{swimsuit} "
            f"Keep face, identity, hair, skin tone, and body proportions from reference 1. "
            f"Clean studio backdrop (no busy scene). "
            f"Photorealistic, 9:16. Do not invent a different woman."
        )
    if with_face:
        # No bikini photo: images are woman, then face. Name both.
        return (
            f"Two references: reference 1 = WOMAN (her body), "
            f"reference 2 = FACE (her exact face). "
            f"Using this exact same woman from reference 1, change her outfit to a "
            f"flattering {scenery} bikini/swimwear and restage her: {pose}. "
            f"{framing} "
            f"Keep identity, hair, skin tone, and body proportions from reference 1. "
            f"{face_clause}"
            f"Clean studio backdrop (no busy scene). "
            f"Photorealistic, 9:16. Do not invent a different woman."
        )
    return (
        f"Using this exact same woman from the reference image, change her outfit to a "
        f"flattering {scenery} bikini/swimwear and restage her: {pose}. "
        f"{framing} "
        f"Keep face, identity, hair, skin tone, and body proportions. "
        f"Clean studio backdrop (no busy scene). "
        f"Photorealistic, 9:16. Do not invent a different woman."
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


def photo_scratch_clothes_prompt(theme: str, variation: str = "", outfit: str = "") -> str:
    """Top layer must fully cover the bikini body — only the outfit fabric changes.

    When `outfit` (a reference-image caption) is set it replaces the themed costume and the
    `variation` accent is dropped so it cannot recolor the referenced outfit.
    """
    scenery = (theme or "").strip() or "stylish"
    outfit = (outfit or "").strip()
    if outfit:
        target = f"this exact outfit from the clothes reference: {outfit}"
        hint = ""
    else:
        target = f"a fully clothed {scenery} costume"
        hint = f" Outfit detail: {variation.strip()}." if variation.strip() else ""
    return (
        f"Change ONLY the bikini fabric to {target} — nothing else. "
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
        f"EXPOSURE LOCK — keep the exact same bright exposure and lighting as the reference; "
        f"do not darken the image, lower brightness, or crush shadows even if the outfit is dark. "
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


def photo_scratch_prompt_with_background(
    custom: str,
    *,
    has_background: bool,
    pose: str = "",
    placement: str = "",
) -> str:
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
    if "does not touch" not in lowered and "not touching" not in lowered:
        extras.append(_NO_FURNITURE_INTERACTION)
    if "INFLUENCER POSITION" not in text:
        extras.append(photo_scratch_placement_clause(placement))
    if not extras:
        return text
    return f"{text} {' '.join(extras)}"


def edit_photo_scratch_layer(
    *,
    prompt: str,
    out: Path,
    source_image: str | Path,
    background_image: str | Path | None = None,
    face_image: str | Path | None = None,
    bikini_image: str | Path | None = None,
    aspect_ratio: str = "9:16",
    model: str | None = None,
) -> Path:
    """Image-edit the Flow source girl (optionally onto a background) for a photo-scratch layer.

    Reference order: ENVIRONMENT first (if any), then WOMAN, then BIKINI (if any), then
    FACE last (if any) — models attend to the scene instead of cloning the source wall,
    and the face ref pins her identity across regenerations.
    """
    key = api_key()
    images: list[str | Path] = []
    labels: list[str] = []
    if background_image is not None:
        images.append(background_image)
        labels.append("environment")
    images.append(source_image)
    labels.append("woman")
    if bikini_image is not None:
        images.append(bikini_image)
        labels.append("bikini")
    if face_image is not None:
        images.append(face_image)
        labels.append("face")
    if len(images) > 1:
        print(f"Editing photo-scratch layer ({len(images)} refs: {' + '.join(labels)}) ...")
        result = _edit_image(
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            key=key,
            images=images,
            model=model,
        )
    else:
        print("Editing photo-scratch layer (1 ref: woman) ...")
        result = _edit_image(
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            key=key,
            image=source_image,
            model=model,
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
    model: str | None = None,
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
        model=model,
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

    # Caption before the identity lock so the outfit match wins on clothes,
    # and the lock still forbids copying the reference person's face or hair.
    if caption:
        final_prompt = (
            f"{final_prompt.rstrip()}\n\n"
            f"CRITICAL — match the dress reference image outfit exactly "
            f"(shape, color, cut, accessories, emissive glow/shine). "
            f"Copy the clothes only, not that person's face or hair: {caption}"
        )
    final_prompt = append_dress_identity_lock(final_prompt)

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
    final_prompt = append_motion_color_lock(final_prompt)
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
