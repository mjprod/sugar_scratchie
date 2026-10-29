"""Trim a foil-pack source clip to 4 seconds and send it to an n8n flow.

The operator uploads a video for pack-face or pack-face-2. This module keeps
a 4-second window, then POSTs that mp4 to local n8n
(http://127.0.0.1:5678/webhook/foil-pack). Set N8N_FOIL_PACK_WEBHOOK_URL
to send the clip somewhere else. n8n's data lives in the gitignored ./n8n-data folder.

Multipart fields:
  file       video/mp4, the trimmed clip
  model_id   creator id
  name       influencer name
  code       model code (the model id)
  kind       pack-face | pack-face-2
  start      window start, seconds
  duration   always 4

If the webhook responds with a video body, or JSON containing a video URL
(video_url, videoUrl, file_url, download_url, output_url, or a url/output
that ends in .mp4/.webm/.mov), that file is saved as the model's pack video.
A 2xx response with no video means the flow accepted the clip and will
produce the foil video on its own.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import httpx
from fastapi import HTTPException

from backend.models_store import VIDEO_EXTENSIONS
from backend.services.grok import probe_video
from backend.services.video_prep import run_ffmpeg

FOIL_TRIM_SECONDS = 4.0
FOIL_KINDS = frozenset({"pack-face", "pack-face-2"})
SOURCE_EXTENSIONS = {".mp4", ".webm", ".mov", ".m4v"}
MAX_UPLOAD_BYTES = 250 * 1024 * 1024
RESULT_SAVED = "foil-n8n-result: saved"
RESULT_SENT = "foil-n8n-result: sent"
LOCAL_WEBHOOK_URL = "http://127.0.0.1:5678/webhook/foil-pack"

_PREFERRED_URL_KEYS = frozenset(
    {
        "video_url",
        "videourl",
        "file_url",
        "fileurl",
        "download_url",
        "downloadurl",
        "output_url",
        "outputurl",
    }
)


def webhook_url() -> str:
    """Local n8n unless N8N_FOIL_PACK_WEBHOOK_URL overrides it."""
    if "N8N_FOIL_PACK_WEBHOOK_URL" not in os.environ:
        return LOCAL_WEBHOOK_URL
    url = os.environ.get("N8N_FOIL_PACK_WEBHOOK_URL", "").strip()
    if not url:
        raise RuntimeError(
            "N8N_FOIL_PACK_WEBHOOK_URL is empty. Remove it to use local n8n, or set a webhook URL."
        )
    if not url.startswith(("http://", "https://")):
        raise RuntimeError("N8N_FOIL_PACK_WEBHOOK_URL must start with http:// or https://")
    return url


def webhook_status() -> dict[str, bool]:
    try:
        url = webhook_url()
    except RuntimeError:
        return {"configured": False, "local": False}
    local = url.startswith(("http://127.0.0.1:5678/", "http://localhost:5678/"))
    return {"configured": True, "local": local}


def timeout_s() -> float:
    raw = os.environ.get("N8N_FOIL_PACK_TIMEOUT_S", "300").strip() or "300"
    try:
        value = float(raw)
    except ValueError:
        value = 300.0
    return min(max(value, 5.0), 3600.0)


def save_source(root: Path, model_id: str, kind: str, filename: str, data: bytes) -> Path:
    if kind not in FOIL_KINDS:
        raise HTTPException(status_code=400, detail="kind must be pack-face or pack-face-2")
    ext = Path(filename or "").suffix.lower()
    if ext not in SOURCE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Video must be MP4, WebM, or MOV")
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded video is empty")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="Video is larger than 250 MB")
    work = root / ".tmp" / "foil-n8n" / model_id
    work.mkdir(parents=True, exist_ok=True)
    path = work / f"{uuid.uuid4().hex[:12]}-{kind}{ext}"
    path.write_bytes(data)
    return path


def trim_clip(src: Path, dest: Path, start: float) -> Path:
    """Write a 4-second H.264 clip starting at `start` seconds."""
    if start < 0:
        raise RuntimeError("Trim start must be 0 or later")
    meta = probe_video(src)
    duration = float(meta["duration"])
    if duration + 0.05 < FOIL_TRIM_SECONDS:
        raise RuntimeError(
            f"Video is {duration:.2f}s. It needs to be at least {FOIL_TRIM_SECONDS:.0f} seconds."
        )
    latest = max(0.0, duration - FOIL_TRIM_SECONDS)
    if start > latest + 0.05:
        raise RuntimeError(
            f"A {FOIL_TRIM_SECONDS:.0f}-second window starting at {start:.2f}s "
            f"runs past the end of this {duration:.2f}s video."
        )
    start = min(max(0.0, start), latest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(
        f"Trimming {src.name} to {FOIL_TRIM_SECONDS:.0f}s "
        f"starting at {start:.2f}s (source {duration:.2f}s)"
    )
    run_ffmpeg(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(src),
            "-ss",
            f"{start:.3f}",
            "-t",
            f"{FOIL_TRIM_SECONDS:.3f}",
            "-map",
            "0:v:0",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-an",
            str(dest),
        ]
    )
    trimmed = float(probe_video(dest)["duration"])
    if trimmed + 0.25 < FOIL_TRIM_SECONDS:
        raise RuntimeError(f"Trimmed clip is {trimmed:.2f}s, expected about {FOIL_TRIM_SECONDS:.0f}s")
    print(f"Trimmed clip is {trimmed:.2f}s ({dest.stat().st_size} bytes)")
    return dest


def find_video_url(payload: object) -> str | None:
    preferred: list[str] = []
    generic: list[str] = []

    def walk(node: object) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if isinstance(value, str) and value.startswith(("http://", "https://")):
                    normalized = str(key).lower().replace("-", "_")
                    if normalized in _PREFERRED_URL_KEYS:
                        preferred.append(value)
                    elif normalized in ("url", "output") and _videoish(value):
                        generic.append(value)
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(payload)
    if preferred:
        return preferred[0]
    if generic:
        return generic[0]
    return None


def _videoish(url: str) -> bool:
    path = url.split("?", 1)[0].lower()
    return path.endswith((".mp4", ".webm", ".mov", ".m4v"))


def _looks_like_video(data: bytes, content_type: str) -> bool:
    ct = content_type.split(";", 1)[0].strip().lower()
    if ct.startswith("video/"):
        return len(data) > 32
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return True
    if data.startswith(b"\x1a\x45\xdf\xa3"):
        return True
    return False


def _ext_for(data: bytes, content_type: str, url: str = "") -> str:
    ct = content_type.split(";", 1)[0].strip().lower()
    path = url.split("?", 1)[0].lower()
    if "webm" in ct or path.endswith(".webm") or data.startswith(b"\x1a\x45\xdf\xa3"):
        return ".webm"
    return ".mp4"


def _read_limited(response: httpx.Response) -> bytes:
    chunks: list[bytes] = []
    total = 0
    for chunk in response.iter_bytes():
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise RuntimeError("n8n video is larger than 250 MB")
        chunks.append(chunk)
    return b"".join(chunks)


def _download_video(client: httpx.Client, url: str) -> tuple[bytes, str]:
    with client.stream("GET", url) as response:
        if response.status_code < 200 or response.status_code >= 300:
            raise RuntimeError(f"Could not download the n8n video ({response.status_code})")
        data = _read_limited(response)
        content_type = response.headers.get("content-type", "")
    if not _looks_like_video(data, content_type):
        raise RuntimeError("n8n video URL did not return a video file")
    return data, _ext_for(data, content_type, url)


def send_clip(
    path: Path,
    *,
    model_id: str,
    kind: str,
    start: float,
    name: str,
    code: str,
) -> tuple[bytes, str] | None:
    """POST the trimmed mp4. Returns video bytes and extension, or None if n8n only acknowledged."""
    url = webhook_url()
    timeout = timeout_s()
    print(f"Sending 4s clip to n8n for {name} / {code} / {kind}")
    timeout_cfg = httpx.Timeout(timeout, connect=30.0)
    with path.open("rb") as handle:
        files = {"file": (f"{kind}.mp4", handle, "video/mp4")}
        data = {
            "model_id": model_id,
            "name": name,
            "code": code,
            "kind": kind,
            "start": f"{start:.3f}",
            "duration": f"{FOIL_TRIM_SECONDS:.0f}",
        }
        try:
            with httpx.Client(timeout=timeout_cfg, follow_redirects=True) as client:
                response = client.post(url, data=data, files=files)
                return _video_from_response(client, response)
        except httpx.HTTPError as exc:
            raise RuntimeError(f"Could not reach the n8n webhook: {exc}") from exc


def _video_from_response(client: httpx.Client, response: httpx.Response) -> tuple[bytes, str] | None:
    content_type = response.headers.get("content-type", "")
    if response.status_code < 200 or response.status_code >= 300:
        snippet = response.content[:300].decode("utf-8", errors="replace")
        raise RuntimeError(f"n8n webhook returned {response.status_code}: {snippet}")
    ct = content_type.split(";", 1)[0].strip().lower()
    body = response.content
    if "json" in ct or body[:1] in (b"{", b"["):
        try:
            payload = response.json()
        except ValueError as exc:
            raise RuntimeError("n8n webhook returned invalid JSON") from exc
        video_url = find_video_url(payload)
        if not video_url:
            print("n8n accepted the clip and did not return a video")
            return None
        print("n8n returned a video URL")
        return _download_video(client, video_url)
    if len(body) > MAX_UPLOAD_BYTES:
        raise RuntimeError("n8n video is larger than 250 MB")
    if _looks_like_video(body, content_type):
        print(f"n8n returned a video ({len(body)} bytes)")
        return body, _ext_for(body, content_type)
    print(f"n8n accepted the clip ({len(body)} bytes, no video)")
    return None


def _has_video_magic(data: bytes) -> bool:
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return True
    return data.startswith(b"\x1a\x45\xdf\xa3")


def write_pack_video(models_dir: Path, model_id: str, kind: str, data: bytes, ext: str) -> str:
    if kind not in FOIL_KINDS:
        raise RuntimeError(f"Unknown foil kind: {kind}")
    if ext not in VIDEO_EXTENSIONS:
        ext = ".mp4"
    if not _has_video_magic(data):
        raise RuntimeError("Refusing to save a pack video that is not a video file")
    model_dir = models_dir / model_id
    model_dir.mkdir(parents=True, exist_ok=True)
    for old_ext in VIDEO_EXTENSIONS:
        old = model_dir / f"{kind}{old_ext}"
        if old.is_file():
            old.unlink()
    dest = model_dir / f"{kind}{ext}"
    dest.write_bytes(data)
    public = f"/models/{model_id}/{kind}{ext}"
    print(f"Saved foil pack video to {public}")
    return public


def start_foil_flow(
    *,
    clip: Path,
    name: str,
    code: str,
    job_id: str,
    progress_token: str,
    kind: str,
    model_id: str,
    start: float,
) -> str:
    """Start the foil workflow and wait while it posts each line back."""
    from backend.services.influencer_n8n import (
        ERROR_LINE,
        RESULT_LINE,
        WAIT_SECONDS,
        begin_wait,
        progress_url_for,
    )

    event = begin_wait(job_id)
    payload = {
        "name": name,
        "code": code,
        "id": code,
        "clip": str(clip),
        "kind": kind,
        "model_id": model_id,
        "start": f"{start:.3f}",
        "duration": f"{FOIL_TRIM_SECONDS:.0f}",
        "progressUrl": progress_url_for(job_id),
        "progressToken": progress_token,
    }
    print(f"Starting the n8n foil flow for {name} / {code}")
    timeout_cfg = httpx.Timeout(60.0, connect=30.0)
    try:
        with httpx.Client(timeout=timeout_cfg) as client:
            response = client.post(webhook_url(), json=payload)
        if response.status_code < 200 or response.status_code >= 300:
            snippet = response.content[:300].decode("utf-8", errors="replace")
            raise RuntimeError(f"n8n webhook returned {response.status_code}: {snippet}")
        if not event.wait(WAIT_SECONDS):
            raise RuntimeError("n8n did not finish within 2 hours.")
        from backend.services.influencer_n8n import _results, _wait_lock

        with _wait_lock:
            line = _results.get(job_id, "")
        if line.startswith(ERROR_LINE):
            raise RuntimeError(line.split(":", 1)[-1].strip() or "n8n failed")
        if not line.startswith(RESULT_LINE):
            raise RuntimeError("n8n finished without a result.")
        print(line)
        return line
    except httpx.HTTPError as exc:
        raise RuntimeError(f"Could not reach the n8n webhook: {exc}") from exc
    finally:
        from backend.services.influencer_n8n import _wait_lock, _waiters

        with _wait_lock:
            _waiters.pop(job_id, None)


def run_foil_pack_n8n(
    *,
    models_dir: Path,
    model_id: str,
    kind: str,
    source: Path,
    start: float,
    name: str,
    code: str,
    job_id: str,
    progress_token: str,
) -> str:
    """Trim the clip, then run the foil workflow with the name and the code."""
    del models_dir
    trimmed = source.with_name(f"{source.stem}.trim.mp4")
    try:
        trim_clip(source, trimmed, start)
        return start_foil_flow(
            clip=trimmed,
            name=name,
            code=code,
            job_id=job_id,
            progress_token=progress_token,
            kind=kind,
            model_id=model_id,
            start=start,
        )
    finally:
        source.unlink(missing_ok=True)
        if trimmed.is_file():
            trimmed.unlink()
