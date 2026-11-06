"""HandBrake HD + SD encodes via VideoSquash.

Local (default ``http://127.0.0.1:8805``): ``POST /convert/paths`` with the
files already on this Mac. Any other host uploads with ``POST /convert`` and
downloads the results. The tunnel needs ``VIDEOSQUASH_TOKEN`` or
``~/Movies/VideoSquash/api_token``.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from urllib.request import Request

VARIANTS = ["hd", "sd"]
USER_AGENT = "videosquash-client/1.0"
DEFAULT_URL = "http://127.0.0.1:8805"
POLL_INTERVAL_S = 2.0
POLL_TIMEOUT_S = 7200.0
JSON_TIMEOUT_S = 60.0
TRANSFER_TIMEOUT_S = 600.0
TOKEN_FILE = Path.home() / "Movies" / "VideoSquash" / "api_token"

_DONE = {"done", "complete", "completed", "succeeded", "success", "finished", "ok", "encoded"}
_FAILED = {"failed", "error", "cancelled", "canceled"}
_VERSIONED = re.compile(r"^(?P<head>.+)-(?P<variant>hd|sd)(?:-(?P<rank>\d+))?$", re.IGNORECASE)
_LOGIN = (
    "Authentik redirected this request to the login page before VideoSquash ran. "
    "Bearer and X-API-Key never reached the app. "
    "The videosquash.mxjprod.work proxy is not set to skip login for API tokens "
    "(flux.mxjprod.work accepts this same token). "
    "On the encode Mac, give that proxy the same API-token bypass as Flux, "
    "or set VIDEOSQUASH_URL=http://127.0.0.1:8805 there."
)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A 302 here is Authentik's login page. Following it yields HTML, not JSON."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def _open(req: Request, timeout: float):
    return _opener.open(req, timeout=timeout)


def base_url() -> str:
    return (os.environ.get("VIDEOSQUASH_URL") or DEFAULT_URL).strip().rstrip("/") or DEFAULT_URL


def is_local(url: str | None = None) -> bool:
    host = (urllib.parse.urlparse(url or base_url()).hostname or "").lower()
    return host in {"localhost", "127.0.0.1", "::1"}


def token() -> str:
    env = (os.environ.get("VIDEOSQUASH_TOKEN") or "").strip()
    if env:
        return env
    if is_local():
        return ""
    if TOKEN_FILE.is_file():
        return TOKEN_FILE.read_text(encoding="utf-8").strip()
    return ""


def encode_files(sources: list[Path], output_dir: Path) -> list[dict]:
    """Encode each file to HD then SD. One record per source: source, job_id, hd, sd."""
    if not sources:
        raise RuntimeError("VideoSquash needs at least one video.")
    for src in sources:
        if not src.is_file():
            raise RuntimeError(f"Video not found: {src}")
    output_dir.mkdir(parents=True, exist_ok=True)
    print(f"VideoSquash {base_url()} — {len(sources)} file(s), HD then SD")
    if is_local():
        submitted = _convert_paths(sources, output_dir)
    else:
        submitted = _convert_uploads(sources)
    pairs = _pair_jobs(submitted, sources)
    results: list[dict] = []
    for src, job in pairs:
        jid = _job_id(job)
        finished = wait_job(jid, label=src.name)
        hd = _materialize(finished, src, output_dir, "hd", jid)
        sd = _materialize(finished, src, output_dir, "sd", jid)
        results.append(
            {
                "source": str(src.resolve()),
                "job_id": jid,
                "hd": str(hd),
                "sd": str(sd),
            }
        )
    return results


def result_for(encoded: list[dict], source: Path) -> dict:
    key = str(source.resolve())
    for item in encoded:
        if str(Path(str(item.get("source") or "")).resolve()) == key:
            return item
    raise RuntimeError(f"VideoSquash returned no job for {source.name}")


def wait_job(jid: str, *, label: str) -> dict:
    deadline = time.monotonic() + POLL_TIMEOUT_S
    last = ""
    while True:
        job = get_job(jid)
        status = _status(job)
        progress = _progress_text(job)
        line = f"VideoSquash {label} {jid} {status or 'queued'}"
        if progress:
            line += f" {progress}"
        if line != last:
            print(line)
            last = line
        if _is_failed(job):
            raise RuntimeError(f"VideoSquash job {jid} failed: {_error_text(job)}")
        if status in _DONE:
            return job
        if time.monotonic() > deadline:
            raise RuntimeError(f"VideoSquash job {jid} timed out after {int(POLL_TIMEOUT_S)}s.")
        time.sleep(POLL_INTERVAL_S)


def get_job(jid: str) -> dict:
    return _request_json("GET", f"/jobs/{urllib.parse.quote(jid, safe='')}")


def _convert_paths(sources: list[Path], output_dir: Path) -> list[dict]:
    payload = {
        "paths": [str(src.resolve()) for src in sources],
        "output_dir": str(output_dir.resolve()),
        "variants": list(VARIANTS),
    }
    data = _request_json("POST", "/convert/paths", payload=payload)
    return _jobs_from_submit(data)


def _convert_uploads(sources: list[Path]) -> list[dict]:
    body, boundary = _multipart(sources)
    content_type, raw = _request(
        "POST",
        "/convert",
        body=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        timeout=TRANSFER_TIMEOUT_S,
    )
    data = _parse_json(content_type, raw)
    return _jobs_from_submit(data)


def _materialize(job: dict, src: Path, output_dir: Path, variant: str, jid: str) -> Path:
    suffix = src.suffix or ".mp4"
    dest = output_dir / f"{src.stem}-{variant.upper()}{suffix}"
    hinted = _variant_path(job, variant)
    if hinted:
        candidate = _as_path(hinted, output_dir)
        if candidate.is_file() and candidate.resolve() != src.resolve():
            return _stage(candidate, dest)
    for folder in (output_dir, src.parent):
        found = _versioned_output(folder, src.stem, variant, suffix)
        if found is not None and found.resolve() != src.resolve():
            return _stage(found, dest)
    return _download_variant(jid, variant, dest)


def _stage(src: Path, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if src.resolve() == dest.resolve():
        return dest
    shutil.move(str(src), str(dest))
    return dest


def _download_variant(jid: str, variant: str, dest: Path) -> Path:
    quoted = urllib.parse.quote(jid, safe="")
    _content_type, body = _request(
        "GET",
        f"/jobs/{quoted}/download/{variant}",
        timeout=TRANSFER_TIMEOUT_S,
        accept="*/*",
    )
    if not body:
        raise RuntimeError(f"VideoSquash returned an empty {variant.upper()} file for {jid}.")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(body)
    print(f"Saved {dest.name} ({len(body)} bytes)")
    return dest


def _headers(*, json_body: bool = False, accept: str = "application/json") -> dict[str, str]:
    headers = {"User-Agent": USER_AGENT, "Accept": accept}
    if json_body:
        headers["Content-Type"] = "application/json"
    tok = token()
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
        headers["X-API-Key"] = tok
    elif not is_local():
        raise RuntimeError(
            "VideoSquash tunnel needs a token. "
            f"Set VIDEOSQUASH_TOKEN or write {TOKEN_FILE}."
        )
    return headers


def _request(
    method: str,
    path: str,
    *,
    payload: dict | None = None,
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = JSON_TIMEOUT_S,
    accept: str = "application/json",
) -> tuple[str, bytes]:
    url = base_url() + path
    data = body
    hdrs = _headers(json_body=payload is not None, accept=accept)
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    if headers:
        hdrs.update(headers)
    req = Request(url, data=data, headers=hdrs, method=method)
    try:
        with _open(req, timeout) as resp:
            raw_type = ""
            if resp.headers is not None:
                raw_type = resp.headers.get("Content-Type") or ""
            content_type = str(raw_type).split(";", 1)[0].strip().lower()
            return content_type, resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:400]
        if exc.code in {301, 302, 303, 307, 308, 401, 403} or _is_login_page(detail.encode()):
            raise RuntimeError(f"{_LOGIN} HTTP {exc.code}.") from exc
        raise RuntimeError(f"VideoSquash HTTP {exc.code} {path}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"VideoSquash is not reachable at {base_url()} ({exc.reason}).") from exc


def _request_json(method: str, path: str, *, payload: dict | None = None) -> dict:
    content_type, raw = _request(method, path, payload=payload)
    return _parse_json(content_type, raw)


def _is_login_page(raw: bytes) -> bool:
    head = raw[:1500].lower()
    return b"authentik" in head or b"outpost.goauthentik.io" in head


def _parse_json(content_type: str, raw: bytes) -> dict:
    if _is_login_page(raw):
        raise RuntimeError(_LOGIN)
    if content_type.startswith("video/") or content_type.startswith("application/zip"):
        raise RuntimeError("VideoSquash returned a file where status JSON was expected.")
    try:
        data = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"VideoSquash returned non-JSON: {raw[:180]!r}") from exc
    if not isinstance(data, dict):
        raise RuntimeError("VideoSquash returned an unexpected payload.")
    return data


def _jobs_from_submit(data: dict) -> list[dict]:
    jobs = data.get("jobs")
    if isinstance(jobs, list):
        found = [job for job in jobs if isinstance(job, dict)]
        if found:
            return found
    if data.get("id") or data.get("job_id") or data.get("jid"):
        return [data]
    raise RuntimeError(f"VideoSquash did not return jobs: {data}")


def _pair_jobs(jobs: list[dict], sources: list[Path]) -> list[tuple[Path, dict]]:
    if len(jobs) != len(sources):
        raise RuntimeError(
            f"VideoSquash returned {len(jobs)} job(s) for {len(sources)} file(s)."
        )
    used: set[int] = set()
    pairs: list[tuple[Path, dict]] = []
    for src in sources:
        match = _matching_job(jobs, used, src)
        if match is None:
            match = next(index for index in range(len(jobs)) if index not in used)
        used.add(match)
        pairs.append((src, jobs[match]))
    return pairs


def _matching_job(jobs: list[dict], used: set[int], src: Path) -> int | None:
    resolved = str(src.resolve())
    for index, job in enumerate(jobs):
        if index in used:
            continue
        source = _job_source(job)
        if not source:
            continue
        if source == resolved or Path(source).name == src.name:
            return index
    return None


def _job_source(job: dict) -> str:
    for key in ("source", "input", "path", "src", "filename", "name", "file"):
        value = job.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, dict):
            nested = value.get("path") or value.get("name") or value.get("filename")
            if isinstance(nested, str) and nested.strip():
                return nested.strip()
    return ""


def _job_id(job: dict) -> str:
    for key in ("id", "job_id", "jid"):
        value = job.get(key)
        if value:
            return str(value)
    raise RuntimeError(f"VideoSquash job is missing an id: {job}")


def _status(job: dict) -> str:
    return str(job.get("status") or job.get("state") or "").strip().lower()


def _is_failed(job: dict) -> bool:
    if _status(job) in _FAILED:
        return True
    if job.get("ok") is False or job.get("success") is False:
        return True
    return False


def _error_text(job: dict) -> str:
    detail = job.get("error") or job.get("detail") or job.get("message") or _status(job)
    if isinstance(detail, (dict, list)):
        return json.dumps(detail)
    return str(detail or "failed")


def _progress_text(job: dict) -> str:
    value = None
    for key in ("progress", "percent", "pct"):
        if job.get(key) is not None:
            value = job[key]
            break
    if isinstance(value, dict):
        value = value.get("percent") or value.get("progress") or value.get("text")
    if isinstance(value, bool) or value is None:
        return ""
    if isinstance(value, float) and 0 <= value <= 1:
        return f"{value * 100:.0f}%"
    if isinstance(value, (int, float)):
        return f"{float(value):.0f}%"
    return str(value)


def _variant_path(job: dict, variant: str) -> str | None:
    wanted = variant.lower()
    for key in ("outputs", "output", "files", "paths", "results"):
        found = _find_variant(job.get(key), wanted)
        if found:
            return found
    for key in (f"{wanted}_path", f"{wanted}_output", f"{wanted}_file", wanted):
        value = job.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _find_variant(container: object, wanted: str) -> str | None:
    if isinstance(container, dict):
        for key, value in container.items():
            if str(key).lower() != wanted:
                continue
            if isinstance(value, str) and value.strip():
                return value.strip()
            if isinstance(value, dict):
                path = value.get("path") or value.get("file") or value.get("output")
                if isinstance(path, str) and path.strip():
                    return path.strip()
    if isinstance(container, list):
        for item in container:
            if not isinstance(item, dict):
                continue
            label = str(
                item.get("variant") or item.get("format") or item.get("fmt") or item.get("type") or ""
            ).lower()
            if label != wanted:
                continue
            path = item.get("path") or item.get("file") or item.get("output")
            if isinstance(path, str) and path.strip():
                return path.strip()
    return None


def _as_path(value: str, output_dir: Path) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = output_dir / path
    return path


def _versioned_output(folder: Path, stem: str, variant: str, suffix: str) -> Path | None:
    """`<stem>-SD.mp4`, or `<stem>-SD-2.mp4` when VideoSquash refused to overwrite."""
    if not folder.is_dir():
        return None
    best: tuple[int, Path] | None = None
    suffix_l = suffix.lower()
    for path in folder.iterdir():
        if not path.is_file() or path.suffix.lower() != suffix_l:
            continue
        match = _VERSIONED.match(path.stem)
        if match is None:
            continue
        if match.group("head").lower() != stem.lower():
            continue
        if match.group("variant").lower() != variant.lower():
            continue
        rank = int(match.group("rank") or 0)
        if best is None or rank > best[0]:
            best = (rank, path)
    return best[1] if best else None


def _multipart(sources: list[Path]) -> tuple[bytes, str]:
    boundary = f"----videosquash{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for src in sources:
        filename = src.name.replace('"', "").replace("\r", "").replace("\n", "")
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(
            (
                f'Content-Disposition: form-data; name="files"; filename="{filename}"\r\n'
                "Content-Type: video/mp4\r\n\r\n"
            ).encode()
        )
        chunks.append(src.read_bytes())
        chunks.append(b"\r\n")
    chunks.append(
        (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="variants"\r\n\r\n'
            "hd,sd\r\n"
        ).encode()
    )
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), boundary
