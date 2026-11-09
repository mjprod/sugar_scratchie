"""FLUX 3 Image Klein stills.

When ``FLUX_KLEIN_URL`` is set, stills go to that service first:
``POST /generate``, poll ``GET /jobs/{id}`` until ``succeeded``, then
``GET /jobs/{id}/image``. The public tunnel needs ``FLUX_KLEIN_TOKEN`` and a
real User-Agent. A connection failure falls back to the Black Forest Labs API
when ``BFL_API_KEY`` is set.
"""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

from backend.services.grok import (
    DEFAULT_PORTRAIT_PROMPT,
    FACE_GUIDED_PORTRAIT_PROMPT,
    FACE_SWAP_PROMPT,
    PROMPT_WITH_FACE_PREFIX,
    _scenery_prompt_with_face,
    download_image,
    is_stock_portrait_prompt,
    resolve_scenery_prompt,
    with_influencer_position,
)
from backend.services.image_refs import rewrite_image_tokens

POLL_INTERVAL_S = 2
POLL_TIMEOUT_S = 600
CLOUD_TIMEOUT_S = 120
SIDECAR_TIMEOUT_S = 600
MAX_REFERENCES = 10
USER_AGENT = "flux-client/1.0"
# Their service accepts sides from 64 to 2048, multiples of 16.
ASPECT_SIZES = {
    "9:16": (768, 1344),
    "16:9": (1344, 768),
    "1:1": (1024, 1024),
    "3:4": (768, 1024),
    "4:3": (1024, 768),
    "2:3": (832, 1248),
    "3:2": (1248, 832),
}


class SidecarUnreachable(RuntimeError):
    """The Klein service did not accept a connection. The cloud API may still run."""


def api_key() -> str:
    return (os.environ.get("BFL_API_KEY") or "").strip()


def api_base() -> str:
    return (os.environ.get("BFL_API_BASE") or "https://api.bfl.ai").rstrip("/")


def sidecar_url() -> str:
    return (os.environ.get("FLUX_KLEIN_URL") or "").strip().rstrip("/")


def klein_token() -> str:
    return (os.environ.get("FLUX_KLEIN_TOKEN") or "").strip()


def encode_image(value: str | Path) -> str:
    """http(s) URL as-is, or raw base64 for a local file. No data: URI."""
    text = str(value).strip()
    if text.startswith(("http://", "https://")):
        return text
    if text.startswith("data:"):
        comma = text.find(",")
        if comma < 0 or not text[comma + 1 :].strip():
            raise RuntimeError("Image data URI is missing its base64 payload.")
        return text[comma + 1 :]
    path = Path(text)
    if not path.is_file():
        raise RuntimeError(f"File not found: {path}")
    return base64.b64encode(path.read_bytes()).decode("ascii")


def _content_type(headers) -> str:
    raw = ""
    if headers is not None:
        raw = headers.get("Content-Type") or headers.get("content-type") or ""
    return str(raw).split(";", 1)[0].strip().lower()


def _read(req: urllib.request.Request, *, timeout: float) -> tuple[str, bytes]:
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return _content_type(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        raise RuntimeError(f"FLUX 3 Image Klein HTTP {exc.code}: {body}") from exc


def _post_json(url: str, payload: dict, *, key: str, timeout: float) -> tuple[str, bytes]:
    headers = {"Content-Type": "application/json"}
    if key:
        headers["x-key"] = key
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    return _read(req, timeout=timeout)


def _get_json(url: str, *, key: str) -> dict:
    headers = {"x-key": key} if key else {}
    req = urllib.request.Request(url, headers=headers, method="GET")
    content_type, body = _read(req, timeout=CLOUD_TIMEOUT_S)
    if content_type.startswith("image/"):
        raise RuntimeError("FLUX 3 Image Klein poll returned an image instead of status JSON.")
    try:
        data = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"FLUX 3 Image Klein returned non-JSON: {body[:500]!r}") from exc
    if not isinstance(data, dict):
        raise RuntimeError("FLUX 3 Image Klein returned an unexpected payload.")
    return data


def _write_image(out: Path, content_type: str, body: bytes) -> None:
    if content_type.startswith("image/"):
        if not body:
            raise RuntimeError("FLUX 3 Image Klein returned an empty image.")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(body)
        print(f"Saved {out.name} ({len(body)} bytes)")
        return
    try:
        data = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"FLUX 3 Image Klein returned non-JSON: {body[:500]!r}") from exc
    if not isinstance(data, dict):
        raise RuntimeError("FLUX 3 Image Klein returned an unexpected payload.")
    sample = ""
    result = data.get("result")
    if isinstance(result, dict):
        sample = str(result.get("sample") or "")
    if not sample:
        detail = data.get("detail") or data.get("error") or data.get("status") or data
        raise RuntimeError(f"FLUX 3 Image Klein did not return an image: {detail}")
    download_image(sample, out)


def _error_text(data: dict) -> str:
    detail = data.get("error") or data.get("detail") or data.get("status")
    if isinstance(detail, (dict, list)):
        return json.dumps(detail)
    return str(detail or "unknown error")


def _poll(polling_url: str, *, key: str, label: str) -> dict:
    deadline = time.monotonic() + POLL_TIMEOUT_S
    while True:
        data = _get_json(polling_url, key=key)
        status = str(data.get("status") or "").strip().lower()
        if status == "ready":
            sample = ""
            result = data.get("result")
            if isinstance(result, dict):
                sample = str(result.get("sample") or "")
            if not sample:
                raise RuntimeError(f"FLUX 3 Image Klein {label} is ready but has no image URL.")
            return data
        if status in ("", "pending", "processing", "queued", "in_progress"):
            if time.monotonic() > deadline:
                raise RuntimeError(f"FLUX 3 Image Klein {label} timed out after {POLL_TIMEOUT_S}s.")
            print(f"  FLUX 3 Image Klein {label} status={status or 'pending'} ...")
            time.sleep(POLL_INTERVAL_S)
            continue
        raise RuntimeError(f"FLUX 3 Image Klein {label} {status or 'failed'}: {_error_text(data)}")


def _flux_prompt(prompt: str) -> str:
    text = rewrite_image_tokens(prompt, style="flux")
    for index in range(4):
        text = text.replace(f"<IMAGE_{index}>", f"Image {index + 1}")
    return text


def _payload(prompt: str, images: list[str | Path], aspect_ratio: str) -> dict:
    text = _flux_prompt(prompt).strip()
    if not text:
        raise RuntimeError("FLUX 3 Image Klein needs a prompt.")
    body: dict = {
        "prompt": text,
        "aspect_ratio": aspect_ratio or "9:16",
        "resolution": "1k",
        "output_format": "png",
    }
    encoded = [encode_image(image) for image in images[:MAX_REFERENCES]]
    if encoded:
        body["images"] = encoded
    return body


def _server_headers(*, json_body: bool) -> dict[str, str]:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json, image/png"}
    token = klein_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
        headers["X-API-Key"] = token
    if json_body:
        headers["Content-Type"] = "application/json"
    return headers


def _server_payload(payload: dict) -> dict:
    ratio = str(payload.get("aspect_ratio") or "9:16")
    width, height = ASPECT_SIZES.get(ratio, ASPECT_SIZES["9:16"])
    body: dict = {"prompt": payload["prompt"], "width": width, "height": height}
    images = payload.get("images") or []
    if images:
        body["images"] = images
    return body


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_server_opener = urllib.request.build_opener(_NoRedirect)


def _server_read(req: urllib.request.Request, *, timeout: float) -> tuple[str, bytes]:
    try:
        with _server_opener.open(req, timeout=timeout) as resp:
            return _content_type(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        if exc.code in {301, 302, 401, 403}:
            raise RuntimeError(
                "FLUX Klein server rejected the request. "
                "Set FLUX_KLEIN_TOKEN for the public tunnel. "
                f"HTTP {exc.code}: {detail}"
            ) from exc
        raise RuntimeError(f"FLUX Klein server HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, ConnectionResetError, OSError) as exc:
        raise SidecarUnreachable(str(exc)) from exc


def _job_id(payload: dict) -> str:
    for key in ("id", "job_id", "jid"):
        value = str(payload.get(key) or "").strip()
        if value:
            return value
    nested = payload.get("job")
    if isinstance(nested, dict):
        return _job_id(nested)
    return ""


def _poll_job(base: str, job_id: str) -> dict:
    deadline = time.monotonic() + POLL_TIMEOUT_S
    url = f"{base}/jobs/{job_id}"
    last = "queued"
    while time.monotonic() < deadline:
        req = urllib.request.Request(url, method="GET")
        for name, value in _server_headers(json_body=False).items():
            req.add_header(name, value)
        content_type, body = _server_read(req, timeout=60)
        if content_type.startswith("image/"):
            return {"status": "succeeded", "image": body, "content_type": content_type}
        try:
            job = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"FLUX Klein job returned non-JSON: {body[:500]!r}") from exc
        if not isinstance(job, dict):
            raise RuntimeError("FLUX Klein job returned an unexpected payload.")
        status = str(job.get("status") or "").strip().lower()
        last = status or last
        if status == "succeeded":
            return job
        if status in {"failed", "cancelled", "canceled", "error"}:
            detail = job.get("error") or job.get("detail") or job.get("message") or status
            raise RuntimeError(f"FLUX Klein job {job_id} {status}: {detail}")
        time.sleep(POLL_INTERVAL_S)
    raise TimeoutError(f"FLUX Klein job {job_id} still {last} after {POLL_TIMEOUT_S}s")


def _generate_sidecar(url: str, payload: dict, out: Path) -> Path:
    base = url.rstrip("/")
    target = f"{base}/generate"
    print(f"FLUX 3 Image Klein via {target} ...")
    req = urllib.request.Request(
        target,
        data=json.dumps(_server_payload(payload)).encode("utf-8"),
        method="POST",
    )
    for name, value in _server_headers(json_body=True).items():
        req.add_header(name, value)
    content_type, body = _server_read(req, timeout=SIDECAR_TIMEOUT_S)
    if content_type.startswith("image/"):
        _write_image(out, content_type, body)
        return out
    try:
        submit = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"FLUX Klein server returned non-JSON: {body[:500]!r}") from exc
    if not isinstance(submit, dict):
        raise RuntimeError("FLUX Klein server returned an unexpected payload.")
    job_id = _job_id(submit)
    if not job_id:
        raise RuntimeError(f"FLUX Klein server did not return a job id: {submit}")
    ready = _poll_job(base, job_id)
    inline = ready.get("image")
    if isinstance(inline, (bytes, bytearray)):
        _write_image(out, str(ready.get("content_type") or "image/png"), bytes(inline))
        return out
    image_req = urllib.request.Request(f"{base}/jobs/{job_id}/image", method="GET")
    for name, value in _server_headers(json_body=False).items():
        image_req.add_header(name, value)
    image_type, image = _server_read(image_req, timeout=SIDECAR_TIMEOUT_S)
    _write_image(out, image_type, image)
    return out


def _generate_cloud(payload: dict, out: Path, *, label: str) -> Path:
    key = api_key()
    if not key:
        raise RuntimeError("Set BFL_API_KEY or FLUX_KLEIN_URL before using FLUX 3 Image Klein.")
    url = f"{api_base()}/v1/flux-3-image-klein"
    print(f"Submitting FLUX 3 Image Klein {label} to {url} ...")
    content_type, body = _post_json(url, payload, key=key, timeout=CLOUD_TIMEOUT_S)
    if content_type.startswith("image/"):
        _write_image(out, content_type, body)
        return out
    try:
        submit = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"FLUX 3 Image Klein returned non-JSON: {body[:500]!r}") from exc
    if not isinstance(submit, dict):
        raise RuntimeError("FLUX 3 Image Klein returned an unexpected payload.")
    polling_url = str(submit.get("polling_url") or "").strip()
    if not polling_url:
        _write_image(out, content_type, body)
        return out
    ready = _poll(polling_url, key=key, label=label)
    result = ready.get("result") if isinstance(ready, dict) else None
    sample = str(result.get("sample") or "") if isinstance(result, dict) else ""
    if not sample:
        raise RuntimeError(f"FLUX 3 Image Klein {label} is ready but has no image URL.")
    download_image(sample, out)
    return out


def generate(
    *,
    prompt: str,
    out: Path,
    images: list[str | Path] | None = None,
    aspect_ratio: str = "9:16",
    label: str = "image",
) -> Path:
    payload = _payload(prompt, list(images or []), aspect_ratio)
    local = sidecar_url()
    if local:
        try:
            return _generate_sidecar(local, payload, out)
        except SidecarUnreachable as exc:
            if not api_key():
                raise RuntimeError(
                    f"FLUX Klein server at {local} is unreachable ({exc})."
                ) from exc
            print(f"FLUX Klein server unreachable ({exc}); using the Black Forest Labs API ...")
    return _generate_cloud(payload, out, label=label)


def generate_portrait_image(
    *,
    prompt: str,
    out: Path,
    face_image: str | Path | None = None,
    aspect_ratio: str = "9:16",
    lock_position: bool = False,
) -> Path:
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
    return generate(
        prompt=final_prompt,
        out=out,
        images=[face_image] if face_image else [],
        aspect_ratio=aspect_ratio,
        label="portrait",
    )


def swap_face_on_image(
    *,
    base_image: str | Path,
    face_image: str | Path,
    out: Path,
    prompt: str | None = None,
    aspect_ratio: str = "9:16",
) -> Path:
    final_prompt = (
        FACE_SWAP_PROMPT
        if is_stock_portrait_prompt(prompt or "")
        else (prompt or FACE_SWAP_PROMPT).strip()
    )
    return generate(
        prompt=final_prompt,
        out=out,
        images=[base_image, face_image],
        aspect_ratio=aspect_ratio,
        label="face swap",
    )


def edit_image_scenery(
    *,
    image: str | Path,
    theme: str,
    out: Path,
    aspect_ratio: str = "9:16",
    variation: str = "",
    prompt: str = "",
    face_image: str | Path | None = None,
) -> Path:
    text = resolve_scenery_prompt(theme, variation, prompt)
    images: list[str | Path] = [image]
    if face_image is not None:
        text = _scenery_prompt_with_face(text, seedream=False)
        images.append(face_image)
    return generate(
        prompt=text,
        out=out,
        images=images,
        aspect_ratio=aspect_ratio,
        label="scenery edit",
    )


def edit_photo_scratch_layer(
    *,
    prompt: str,
    out: Path,
    source_image: str | Path,
    background_image: str | Path | None = None,
    face_image: str | Path | None = None,
    bikini_image: str | Path | None = None,
    aspect_ratio: str = "9:16",
    named_images: list[str | Path] | None = None,
) -> Path:
    """The image being edited is first. Extra references follow."""
    if named_images:
        images = list(named_images)
    else:
        images = [source_image]
        if background_image is not None:
            images.append(background_image)
        if bikini_image is not None:
            images.append(bikini_image)
        if face_image is not None:
            images.append(face_image)
    return generate(
        prompt=prompt,
        out=out,
        images=images,
        aspect_ratio=aspect_ratio,
        label="photo-scratch edit",
    )
