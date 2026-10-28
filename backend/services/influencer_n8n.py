"""Run the influencer n8n steps on this Mac.

Docker n8n cannot see After Effects. The operator sends the influencer name,
the id, and a clip. This module runs the same steps as the n8n workflow
"Duplicate a folder from a name and an id":

1. Upload the clip to Greenkey and wait for the alpha movie.
2. Copy the ss-influencer template into a new job folder.
3. Write InfluencerName and cardNumberText.
4. Open the copy in After Effects and wait until the relink result starts
   with "Saved".
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import uuid
import urllib.error
import urllib.request
from pathlib import Path

from fastapi import HTTPException

SCRIPT_PATH = Path("/Users/glaucomp/n8n-sugar-scratch/local/after-effects/duplicate_job.py")
TEMPLATE_DIR = Path("/Users/glaucomp/Desktop/PackageMaker/ss-influencer")
JOBS_DIR = Path("/Users/glaucomp/Desktop/PackageMaker/jobs")
PROJECT_FILE = "ss-Influencer.aep"
AE_APP = Path("/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app")
AE_APP_NAME = "Adobe After Effects 2026"
AE_PROCESS_NAME = "After Effects"
RESULT_NAME = "ae-relink-result.txt"
JSX_NAME = "ae-relink.jsx"
SAVED_PREFIX = "Saved "
AE_WAIT_SECONDS = 180
MAX_UPLOAD_BYTES = 250 * 1024 * 1024
CLIP_EXTENSIONS = {".mp4", ".mov"}
RESULT_LINE = "influencer-n8n-result:"
ERROR_LINE = "influencer-n8n-error:"
WEBHOOK_URL = "http://127.0.0.1:5678/webhook/influencer"
WAIT_SECONDS = 7200
FORM_RUN_TOKEN = os.environ.get("INFLUENCER_RUN_TOKEN", "local-influencer-run")

_waiters: dict[str, threading.Event] = {}
_results: dict[str, str] = {}
_wait_lock = threading.Lock()


def save_clip(root: Path, model_id: str, filename: str, data: bytes) -> Path:
    ext = Path(filename or "").suffix.lower()
    if ext not in CLIP_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Clip must be an MP4 or MOV")
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded clip is empty")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="Clip is larger than 250 MB")
    work = root / ".tmp" / "influencer-n8n" / model_id
    work.mkdir(parents=True, exist_ok=True)
    path = work / f"{uuid.uuid4().hex[:12]}{ext}"
    path.write_bytes(data)
    return path


def require_label(value: str, label: str) -> str:
    text = " ".join(value.split())
    if not text:
        raise HTTPException(status_code=400, detail=f"{label} is required")
    if any(char in text for char in "/\\|"):
        raise HTTPException(status_code=400, detail=f"{label} cannot contain / \\ or |")
    return text


def script_command(clip: Path, name: str, card_id: str) -> list[str]:
    script = Path(os.environ.get("INFLUENCER_N8N_SCRIPT", str(SCRIPT_PATH)))
    template = os.environ.get("INFLUENCER_TEMPLATE", str(TEMPLATE_DIR))
    jobs = os.environ.get("INFLUENCER_JOBS", str(JOBS_DIR))
    return [
        sys.executable,
        str(script),
        "--template",
        template,
        "--jobs",
        jobs,
        "--name",
        name,
        "--id",
        card_id,
        "--clip",
        str(clip),
        "--project",
        PROJECT_FILE,
    ]


def _destination_from_output(output: str) -> str:
    for line in reversed(output.splitlines()):
        if line.startswith("AE_JOB "):
            payload = json.loads(line[len("AE_JOB ") :])
            destination = str(payload.get("destination") or "")
            if destination:
                return destination
    raise RuntimeError("The copy step did not report the new folder.")


def run_copy(clip: Path, name: str, card_id: str, env: dict[str, str] | None = None) -> Path:
    command = script_command(clip, name, card_id)
    script = Path(command[1])
    if not script.is_file():
        raise RuntimeError(f"Influencer script not found: {script}")
    print("Greenkey, then copy the template and write the name and id.")
    child_env = os.environ.copy()
    if env:
        child_env.update(env)
    child_env["PYTHONUNBUFFERED"] = "1"
    env = child_env
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
    )
    chunks: list[str] = []
    assert process.stdout is not None
    for line in process.stdout:
        chunks.append(line)
        print(line, end="")
    code = process.wait()
    output = "".join(chunks)
    if code != 0:
        detail = output.strip().splitlines()
        tail = detail[-1] if detail else f"exit {code}"
        raise RuntimeError(tail)
    return Path(_destination_from_output(output))


def result_saved(text: str) -> bool:
    first = text.replace("\r", "").split("\n", 1)[0]
    return first.startswith(SAVED_PREFIX)


def _after_effects_running() -> bool:
    check = subprocess.run(
        ["pgrep", "-x", AE_PROCESS_NAME],
        capture_output=True,
        text=True,
    )
    return check.returncode == 0


def _close_after_effects() -> None:
    """Quit After Effects after the project is saved, before the page is told it is done."""
    if not _after_effects_running():
        print("After Effects is closed.")
        return
    print("Closing After Effects.")
    subprocess.run(
        ["osascript", "-e", f'tell application "{AE_APP_NAME}" to quit'],
        capture_output=True,
        text=True,
        timeout=20,
    )
    deadline = time.time() + 20
    while time.time() < deadline and _after_effects_running():
        time.sleep(0.5)
    if _after_effects_running():
        print("After Effects is still open.")
    else:
        print("After Effects is closed.")


def launch_after_effects(destination: Path) -> str:
    if not destination.is_dir():
        raise RuntimeError(f"Destination folder does not exist: {destination}")
    app = Path(os.environ.get("AFTER_EFFECTS_APP", str(AE_APP)))
    if not app.is_dir():
        raise RuntimeError(f"After Effects was not found: {app}")
    if _after_effects_running():
        print("After Effects is already open. Sending this project to it.")
    jsx = destination / JSX_NAME
    result_path = destination / RESULT_NAME
    if not jsx.is_file():
        raise RuntimeError(f"JSX file not found: {jsx}")
    result_path.unlink(missing_ok=True)
    applescript = (
        "set scriptText to read (POSIX file "
        + json.dumps(str(jsx))
        + ') as «class utf8»\n'
        + f'tell application "{AE_APP_NAME}"\n'
        + "  DoScript scriptText\n"
        + "end tell\n"
    )
    print("Opening After Effects.")
    process = subprocess.Popen(
        ["osascript", "-e", applescript],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    deadline = time.time() + AE_WAIT_SECONDS
    while time.time() < deadline:
        if result_path.is_file() and result_path.stat().st_size > 0:
            text = result_path.read_text(encoding="utf-8", errors="replace")
            print(text, end="" if text.endswith("\n") else "\n")
            if not result_saved(text):
                raise RuntimeError(text.strip() or "After Effects did not save the project.")
            _close_after_effects()
            print(f"Folder: {destination}")
            print("Package done.")
            return text
        if process.poll() is not None and not result_path.is_file():
            output = ""
            if process.stdout is not None:
                output = process.stdout.read()
            raise RuntimeError(output.strip() or "After Effects exited before it saved the project.")
        time.sleep(1)
    process.kill()
    raise RuntimeError("After Effects did not save the project within 3 minutes.")


def progress_url_for(job_id: str) -> str:
    base = os.environ.get("INFLUENCER_PROGRESS_BASE", "http://127.0.0.1:8090").rstrip("/")
    return f"{base}/api/jobs/{job_id}/progress"


def begin_wait(job_id: str) -> threading.Event:
    event = threading.Event()
    with _wait_lock:
        _waiters[job_id] = event
        _results.pop(job_id, None)
    return event


def note_progress(job_id: str, line: str) -> None:
    """Record a live line from n8n. A result or error line ends the wait."""
    if not (line.startswith(RESULT_LINE) or line.startswith(ERROR_LINE)):
        return
    with _wait_lock:
        _results[job_id] = line
        event = _waiters.get(job_id)
    if event is not None:
        event.set()


def _post_json(url: str, payload: dict, token: str, timeout: float) -> bytes:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Progress-Token": token,
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def run_hosted_steps(
    *,
    clip: Path,
    name: str,
    card_id: str,
    progress_url: str,
    progress_token: str,
    kind: str = "",
    model_id: str = "",
    models_dir: Path | None = None,
) -> str:
    """Mac steps used when n8n itself cannot launch After Effects."""
    from backend.services.foil_n8n import FOIL_KINDS

    child_env = {
        "INFLUENCER_PROGRESS_URL": progress_url,
        "INFLUENCER_PROGRESS_TOKEN": progress_token,
    }
    if kind in FOIL_KINDS:
        child_env["FOIL_PACK_KIND"] = kind
    try:
        destination = run_copy(clip, name, card_id, env=child_env)
        launch_after_effects(destination)
        if kind in FOIL_KINDS and model_id and models_dir is not None:
            from backend.services.foil_packages import publish_package_video

            publish_package_video(destination, model_id=model_id, kind=kind, models_dir=models_dir)
        line = f"{RESULT_LINE} {destination}"
        _post_json(progress_url, {"line": line}, progress_token, timeout=30)
        return line
    except Exception as exc:
        line = f"{ERROR_LINE} {exc}"
        try:
            _post_json(progress_url, {"line": line}, progress_token, timeout=30)
        except Exception:
            pass
        raise


def run_form_steps(*, clip: Path, name: str, card_id: str) -> str:
    """Mac steps for the n8n form, which has no progress job."""
    destination = run_copy(clip, name, card_id)
    launch_after_effects(destination)
    return f"{RESULT_LINE} {destination}"


def run_influencer_n8n(*, clip: Path, name: str, card_id: str, job_id: str, progress_token: str) -> str:
    """Ask n8n to run the influencer steps and wait while it reports each line."""
    event = begin_wait(job_id)
    url = os.environ.get("N8N_INFLUENCER_WEBHOOK_URL", WEBHOOK_URL).strip() or WEBHOOK_URL
    payload = {
        "name": name,
        "id": card_id,
        "clip": str(clip),
        "progressUrl": progress_url_for(job_id),
        "progressToken": progress_token,
    }
    print("n8n: workflow started. Live lines show here while it runs.")
    try:
        try:
            _post_json(url, payload, progress_token, timeout=60)
        except urllib.error.HTTPError as exc:
            detail = exc.read(300).decode("utf-8", errors="replace")
            raise RuntimeError(f"n8n webhook returned {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Could not reach n8n: {exc.reason}") from exc
        if not event.wait(WAIT_SECONDS):
            raise RuntimeError("n8n did not finish within 2 hours.")
        with _wait_lock:
            line = _results.get(job_id, "")
        if line.startswith(ERROR_LINE):
            raise RuntimeError(line.split(":", 1)[-1].strip() or "n8n failed")
        if not line.startswith(RESULT_LINE):
            raise RuntimeError("n8n finished without a folder.")
        print(line)
        return line
    finally:
        clip.unlink(missing_ok=True)
        with _wait_lock:
            _waiters.pop(job_id, None)
