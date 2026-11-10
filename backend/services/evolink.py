"""EvoLink generation client (images + videos via async tasks).

Unlike WaveSpeed (path-per-model + data URIs), EvoLink posts a ``model`` id to
unified ``/v1/images/generations`` or ``/v1/videos/generations`` endpoints and
requires publicly reachable ``image_urls`` / ``video_urls``. Local files are
uploaded to the files API first.
"""

from __future__ import annotations

import json
import mimetypes
import os
import time
import uuid
import urllib.error
import urllib.request
from pathlib import Path

from backend.services.grok import (
    API_MAX_RETRIES,
    API_RETRY_BASE_S,
    API_TIMEOUT_S,
    DEFAULT_PORTRAIT_PROMPT,
    INFLUENCER_POSITION,
    POLL_INTERVAL_S,
    POLL_TIMEOUT_S,
    VIDEO_POLL_TIMEOUT_S,
    download_image,
    download_video,
    is_stock_portrait_prompt,
    output_video_ready,
    prepare_compatible_video,
    request_id_sidecar,
    with_influencer_position,
)

IMAGE_GENERATIONS_PATH = "/v1/images/generations"
VIDEO_GENERATIONS_PATH = "/v1/videos/generations"
TASK_PATH = "/v1/tasks/{task_id}"
UPLOAD_STREAM_PATH = "/api/v1/files/upload/stream"
MODELS_PATH = "/v1/models"

DEFAULT_IMAGE_MODEL = "doubao-seedream-5.0-lite"
DEFAULT_I2V_MODEL = "seedance-2.0-image-to-video"
DEFAULT_SEEDANCE_EDIT_MODEL = "seedance-2.0-reference-to-video"
DEFAULT_WAN_EDIT_MODEL = "wan3.0-reference-video"

SEEDREAM_FACE_GUIDED_PORTRAIT_PROMPT = (
    "Portrait photo of the person from the reference image, matching their face and identity. "
    "Casual fitted resort wear, plain white studio background, facing camera, fashion editorial. "
    f"{INFLUENCER_POSITION}"
)
SEEDREAM_PROMPT_WITH_FACE_PREFIX = (
    "Full-body portrait photo of the person from the reference image, matching their face and identity. "
)

MAX_EDIT_DURATION_S = 15.0
MAX_EDIT_SHORT_SIDE = 2160
# Cloudflare's Browser Integrity Check blocks urllib's default Python-urllib UA.
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)


def _headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    return {"User-Agent": USER_AGENT, "Accept": "application/json", **(extra or {})}


def _request(
    url: str,
    key: str,
    *,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    method: str,
) -> urllib.request.Request:
    """Build a request whose bearer token is not forwarded on redirects.

    urllib copies ``Request.headers`` onto the next hop and only drops
    Content-* headers, including across hosts.
    """
    req = urllib.request.Request(url, data=data, headers=_headers(headers), method=method)
    req.add_unredirected_header("Authorization", f"Bearer {key}")
    return req


def api_key() -> str:
    key = os.environ.get("EVOLINK_API_KEY")
    if not key:
        raise RuntimeError("Set EVOLINK_API_KEY with your EvoLink API key.")
    return key


def api_base() -> str:
    return os.environ.get("EVOLINK_API_BASE", "https://api.evolink.ai").rstrip("/")


def files_base() -> str:
    return os.environ.get("EVOLINK_FILES_BASE", "https://files-api.evolink.ai").rstrip("/")


def format_http_error(exc: urllib.error.HTTPError, body: str) -> str:
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return f"EvoLink API error {exc.code}:\n{body}"
    err = data.get("error")
    if isinstance(err, dict):
        message = err.get("message") or err.get("code")
        if isinstance(message, str) and message.strip():
            return f"EvoLink API error: {message}"
    message = data.get("message") or data.get("msg")
    if isinstance(message, str) and message.strip():
        return f"EvoLink API error: {message}"
    return f"EvoLink API error {exc.code}:\n{body}"


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
                    f"  EvoLink API {exc.code} on {req.full_url} "
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
                    f"  EvoLink network error on {req.full_url} "
                    f"(attempt {attempt + 1}/{retries}): {exc}; retry in {wait}s ..."
                )
                time.sleep(wait)
                continue
            break
    raise RuntimeError(f"Network error contacting {req.full_url}: {last_error}") from last_error


def api_post(path: str, payload: dict, key: str) -> dict:
    req = _request(
        api_base() + path,
        key,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    return send(req)


def api_get(path: str, key: str) -> dict:
    req = _request(api_base() + path, key, method="GET")
    return send(req)


def _multipart_file(path: Path) -> tuple[bytes, str]:
    boundary = f"----evolink{uuid.uuid4().hex}"
    filename = path.name.replace('"', "").replace("\r", "").replace("\n", "")
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    chunks = [
        f"--{boundary}\r\n".encode(),
        (
            f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
            f"Content-Type: {mime}\r\n\r\n"
        ).encode(),
        path.read_bytes(),
        b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    return b"".join(chunks), boundary


def upload_file(path: Path, key: str | None = None) -> str:
    """Upload a local file and return its public ``file_url``."""
    src = Path(path)
    if not src.is_file():
        raise RuntimeError(f"File not found: {src}")
    token = key or api_key()
    body, boundary = _multipart_file(src)
    req = _request(
        files_base() + UPLOAD_STREAM_PATH,
        token,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    print(f"Uploading {src.name} to EvoLink files API ...")
    result = send(req)
    data = result.get("data") if isinstance(result.get("data"), dict) else result
    url = data.get("file_url") or data.get("download_url")
    if not isinstance(url, str) or not url.strip():
        raise RuntimeError(f"EvoLink upload returned no file_url:\n{json.dumps(result, indent=2)}")
    return url.strip()


def media_url(value: str | Path, key: str | None = None) -> str:
    value_str = str(value).strip()
    if value_str.startswith(("http://", "https://")):
        return value_str
    return upload_file(Path(value_str), key=key)


def aspect_ratio_to_size(aspect_ratio: str) -> str:
    """Map canvas aspect to EvoLink Seedream ``size`` ratio strings.

    Seedream on EvoLink accepts ratio sizes including ``9:16`` (2K → 1600×2848).
    Do not collapse vertical portraits to ``3:4`` — Video Flow is 9:16 end-to-end.
    """
    mapping = {
        "9:16": "9:16",
        "16:9": "16:9",
        "1:1": "1:1",
        "3:4": "3:4",
        "4:3": "4:3",
        "2:3": "2:3",
        "3:2": "3:2",
        "4:5": "4:5",
        "5:4": "5:4",
        "21:9": "21:9",
        "9:21": "9:21",
    }
    return mapping.get(aspect_ratio.strip(), "9:16")


def _result_urls(payload: dict) -> list[str]:
    urls: list[str] = []
    results = payload.get("results")
    if isinstance(results, list):
        for entry in results:
            if isinstance(entry, str) and entry.strip():
                urls.append(entry.strip())
            elif isinstance(entry, dict):
                url = entry.get("url") or entry.get("file_url")
                if isinstance(url, str) and url.strip():
                    urls.append(url.strip())
    result_data = payload.get("result_data")
    if isinstance(result_data, list):
        for entry in result_data:
            if isinstance(entry, dict):
                url = entry.get("url") or entry.get("file_url")
                if isinstance(url, str) and url.strip():
                    urls.append(url.strip())
    # Prefer unique order-preserving list.
    seen: set[str] = set()
    unique: list[str] = []
    for url in urls:
        if url not in seen:
            seen.add(url)
            unique.append(url)
    return unique


def submit_task(path: str, payload: dict, key: str, *, label: str) -> str:
    print(f"Submitting {label} to {api_base()}{path} ...")
    submit = api_post(path, payload, key)
    task_id = submit.get("id") or submit.get("task_id")
    if not task_id and isinstance(submit.get("data"), dict):
        task_id = submit["data"].get("id") or submit["data"].get("task_id")
    if not task_id:
        raise RuntimeError(f"No task id in EvoLink response:\n{json.dumps(submit, indent=2)}")
    return str(task_id)


def poll_task(
    task_id: str,
    key: str,
    *,
    label: str,
    timeout_s: float = POLL_TIMEOUT_S,
) -> list[str]:
    print(f"EvoLink task {task_id} — polling ...")
    started = time.time()
    while True:
        if time.time() - started > timeout_s:
            raise RuntimeError(f"Timed out waiting for EvoLink {label}.")
        result = api_get(TASK_PATH.format(task_id=task_id), key)
        status = str(result.get("status") or "").lower()
        if status in ("completed", "succeeded", "success"):
            urls = _result_urls(result)
            if not urls:
                raise RuntimeError(
                    f"EvoLink {label} completed but no results:\n{json.dumps(result, indent=2)}"
                )
            return urls
        if status in ("failed", "error", "cancelled", "canceled", "expired", "timeout"):
            err = result.get("error")
            if isinstance(err, dict):
                message = err.get("message") or err.get("code")
                if isinstance(message, str) and message.strip():
                    raise RuntimeError(f"EvoLink {label} failed: {message}")
            if isinstance(err, str) and err.strip():
                raise RuntimeError(f"EvoLink {label} failed: {err}")
            raise RuntimeError(f"EvoLink {label} {status}:\n{json.dumps(result, indent=2)}")
        progress = result.get("progress")
        if progress is not None:
            print(f"  status={status or 'pending'} progress={progress} ...")
        else:
            print(f"  status={status or 'pending'} ...")
        time.sleep(POLL_INTERVAL_S)


def run_image_task(payload: dict, out: Path, *, label: str, force: bool = False) -> None:
    key = api_key()
    if force:
        out.unlink(missing_ok=True)
    elif out.exists() and out.stat().st_size > 0:
        print(f"Using existing {label}: {out.name}")
        return
    task_id = submit_task(IMAGE_GENERATIONS_PATH, payload, key, label=label)
    urls = poll_task(task_id, key, label=label)
    download_image(urls[0], out)


def submit_video_job(*, payload: dict, out: Path, label: str) -> str:
    key = api_key()
    sidecar = request_id_sidecar(out)
    if output_video_ready(out):
        sidecar.unlink(missing_ok=True)
        return ""

    if sidecar.exists():
        task_id = sidecar.read_text(encoding="utf-8").strip()
        if task_id:
            print(f"Resuming EvoLink {label} for task id: {task_id}")
            return task_id

    task_id = submit_task(VIDEO_GENERATIONS_PATH, payload, key, label=label)
    sidecar.write_text(task_id, encoding="utf-8")
    return task_id


def finish_video_job(task_id: str, out: Path, *, label: str) -> None:
    if not task_id:
        return
    key = api_key()
    urls = poll_task(task_id, key, label=label, timeout_s=VIDEO_POLL_TIMEOUT_S)
    download_video(urls[0], out)
    request_id_sidecar(out).unlink(missing_ok=True)


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
    named_images: list[str | Path] | None = None,
) -> Path:
    """Multi- or single-image still edit via EvoLink Seedream-style generation."""
    key = api_key()
    if named_images:
        image_urls = [media_url(img, key=key) for img in named_images]
    else:
        images: list[str | Path] = []
        if background_image is not None:
            images.append(background_image)
        images.append(source_image)
        if bikini_image is not None:
            images.append(bikini_image)
        if face_image is not None:
            images.append(face_image)
        image_urls = [media_url(img, key=key) for img in images]
    payload = {
        "model": (model or "").strip() or DEFAULT_IMAGE_MODEL,
        "prompt": prompt,
        "image_urls": image_urls,
        "size": aspect_ratio_to_size(aspect_ratio),
        "quality": "2K",
    }
    run_image_task(payload, out, label="evolink photo-scratch edit")
    return out


def edit_clothes_layer(
    *,
    prompt: str,
    out: Path,
    source_image: str | Path,
    aspect_ratio: str = "9:16",
    model: str | None = None,
) -> Path:
    """Single-image outfit edit. EvoLink has no Flux Kontext; Seedream edit is the stand-in."""
    return edit_photo_scratch_layer(
        prompt=prompt,
        out=out,
        source_image=source_image,
        aspect_ratio=aspect_ratio,
        model=model,
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
    face_image: str | Path | None = None,
) -> Path:
    from backend.services.grok import resolve_scenery_prompt

    text = resolve_scenery_prompt(theme, variation, prompt)
    key = api_key()
    image_urls = [media_url(image, key=key)]
    if face_image is not None:
        text = f"{text} Keep the face identity from the second reference image."
        image_urls.append(media_url(face_image, key=key))
    payload = {
        "model": (model or "").strip() or DEFAULT_IMAGE_MODEL,
        "prompt": text,
        "image_urls": image_urls,
        "size": aspect_ratio_to_size(aspect_ratio),
        "quality": "2K",
    }
    run_image_task(payload, out, label="evolink scenery edit")
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
    from backend.services.grok import face_replace_prompt

    final_prompt = prompt.strip() if prompt and prompt.strip() else face_replace_prompt(seedream=True)
    key = api_key()
    payload = {
        "model": (model or "").strip() or DEFAULT_IMAGE_MODEL,
        "prompt": final_prompt,
        "image_urls": [media_url(base_image, key=key), media_url(face_image, key=key)],
        "size": aspect_ratio_to_size(aspect_ratio),
        "quality": "2K",
    }
    run_image_task(payload, out, label="evolink face swap")
    return out


def generate_portrait_image(
    *,
    prompt: str,
    out: Path,
    face_image: str | Path | None = None,
    aspect_ratio: str = "9:16",
    model: str | None = None,
    lock_position: bool = False,
) -> Path:
    text = prompt.strip() or DEFAULT_PORTRAIT_PROMPT
    if face_image:
        user_customized = bool(prompt.strip()) and not is_stock_portrait_prompt(prompt)
        final_prompt = (
            f"{SEEDREAM_PROMPT_WITH_FACE_PREFIX}{text}"
            if user_customized
            else SEEDREAM_FACE_GUIDED_PORTRAIT_PROMPT
        )
    else:
        final_prompt = text
    if lock_position:
        final_prompt = with_influencer_position(final_prompt)
    key = api_key()
    payload: dict = {
        "model": (model or "").strip() or DEFAULT_IMAGE_MODEL,
        "prompt": final_prompt,
        "size": aspect_ratio_to_size(aspect_ratio),
        "quality": "2K",
    }
    if face_image:
        payload["image_urls"] = [media_url(face_image, key=key)]
    run_image_task(payload, out, label="evolink portrait generation")
    return out


def image_to_video(
    *,
    image: str | Path,
    prompt: str,
    out: Path,
    resolution: str = "720p",
    duration: int = 5,
    model: str | None = None,
    aspect_ratio: str = "9:16",
    label: str = "evolink image-to-video",
) -> None:
    key = api_key()
    quality = resolution if resolution in ("480p", "720p", "1080p") else "720p"
    dur = 8 if duration == 8 else 5
    payload = {
        "model": (model or "").strip() or DEFAULT_I2V_MODEL,
        "prompt": prompt,
        "image_urls": [media_url(image, key=key)],
        "duration": dur,
        "quality": quality,
        "aspect_ratio": aspect_ratio or "9:16",
        "generate_audio": False,
    }
    task_id = submit_video_job(payload=payload, out=out, label=label)
    finish_video_job(task_id, out, label=label)


def _edit_input_video_url(video: str | Path, *, key: str, model_label: str) -> str:
    video_str = str(video).strip()
    if video_str.startswith(("http://", "https://")):
        return video_str
    src = Path(video_str)
    if not src.exists():
        raise RuntimeError(f"Video not found: {src}")
    src = prepare_compatible_video(src, max_short_side=MAX_EDIT_SHORT_SIDE, model_label=model_label)
    return media_url(src, key=key)


def edit_video_reference(
    *,
    video: str | Path,
    prompt: str,
    out: Path,
    resolution: str = "720p",
    reference_image: str | Path | None = None,
    reference_images: list[str | Path] | None = None,
    model: str | None = None,
    duration: int = 5,
    label: str = "evolink reference video edit",
) -> None:
    """Outfit change via Seedance / WAN reference-to-video models.

    The prompt should address the clip as ``@video1`` and stills as ``@image1``,
    ``@image2``, matching EvoLink Seedance reference-to-video.
    """
    key = api_key()
    quality = resolution if resolution in ("480p", "720p", "1080p", "4k") else "720p"
    refs: list[str] = []
    for image in reference_images or []:
        refs.append(media_url(image, key=key))
    if reference_image is not None and not refs:
        refs.append(media_url(reference_image, key=key))
    payload: dict = {
        "model": (model or "").strip() or DEFAULT_SEEDANCE_EDIT_MODEL,
        "prompt": prompt.strip(),
        "video_urls": [_edit_input_video_url(video, key=key, model_label=label)],
        "duration": duration if duration in (4, 5, 6, 8, 10, 12, 15) else 5,
        "quality": quality,
        "aspect_ratio": "9:16",
        "generate_audio": False,
    }
    if refs:
        payload["image_urls"] = refs
    task_id = submit_video_job(payload=payload, out=out, label=label)
    finish_video_job(task_id, out, label=label)
