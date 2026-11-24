"""List, delete, and apply After Effects foil packages for one model.

Create with n8n writes a folder under PackageMaker/jobs named
``{initials}-{season}-{n}`` (for example ``GP-SN-1``). Older folders still use
``SS-{model id} {name}``. Those folders are not tied to foil 1 or foil 2 until
an operator picks one.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from backend.services.foil_n8n import FOIL_KINDS, write_pack_video
from backend.services.influencer_n8n import (
    PROJECT_FILE,
    RESULT_NAME,
    configured_env_path,
    influencer_jobs,
)

REPORT_NAME = "ae-relink-report.json"
AERENDER = Path("/Applications/Adobe After Effects 2026/aerender")
# Card output is this 60fps comp. MainComp is the design comp nested inside it.
COMP_NAME = "--Exporter60fps"
FOLDER_BASE_PATTERN = re.compile(r"^[A-Z]{1,12}-[A-Z]{2}$")


def jobs_dir() -> Path | None:
    """Jobs folder from INFLUENCER_JOBS. None when that variable is unset.

    Listing treats that the same as a missing directory. Creating or applying
    a package still goes through influencer_jobs, which requires the path.
    """
    return configured_env_path("INFLUENCER_JOBS")


def folder_prefix(model_id: str) -> str:
    return f"SS-{model_id} "


def _ascii_letter(char: str) -> str | None:
    """Map one character to A–Z, stripping accents. Non-Latin letters are dropped."""
    for piece in unicodedata.normalize("NFKD", char):
        if "A" <= piece.upper() <= "Z":
            return piece.upper()
    return None


def influencer_initials(name: str) -> str:
    """First ASCII letter of each word, uppercased. Érica → E, Ángela → A."""
    letters: list[str] = []
    for word in name.split():
        for char in word:
            letter = _ascii_letter(char)
            if letter is not None:
                letters.append(letter)
                break
    if not letters:
        raise HTTPException(status_code=400, detail="Name needs at least one letter for initials")
    return "".join(letters)


def pack_folder_base(name: str, season_acronym: str) -> str:
    """Build ``GP-SN`` from the influencer name and the running season acronym."""
    acronym = re.sub(r"[^A-Za-z]", "", (season_acronym or "").strip()).upper()
    if len(acronym) != 2:
        raise HTTPException(status_code=400, detail="Season acronym must be 2 letters")
    base = f"{influencer_initials(name)}-{acronym}"
    if not FOLDER_BASE_PATTERN.match(base):
        raise HTTPException(status_code=400, detail="Package folder base is not valid")
    return base


def _safe_name(name: str) -> str:
    text = name.strip()
    if (
        not text
        or text in {".", ".."}
        or "/" in text
        or "\\" in text
        or ".." in text
    ):
        raise HTTPException(status_code=400, detail="Package name is not valid")
    return text


def _read_report(folder: Path) -> dict:
    path = folder / REPORT_NAME
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def package_belongs_to_model(folder: Path, model_id: str) -> bool:
    """True for legacy ``SS-{id} …`` folders or new folders whose report id matches."""
    if folder.name.startswith(folder_prefix(model_id)):
        return True
    report_id = str(_read_report(folder).get("id") or "").strip()
    return bool(report_id) and report_id == model_id


def resolve_package(model_id: str, name: str) -> Path:
    """Return the job folder only when it is a direct child of the jobs directory."""
    folder_name = _safe_name(name)
    root = influencer_jobs().resolve()
    dest = (root / folder_name).resolve()
    if dest.parent != root:
        raise HTTPException(status_code=400, detail="Package name is not valid")
    if not dest.is_dir():
        raise HTTPException(status_code=404, detail="Package was not found")
    if not package_belongs_to_model(dest, model_id):
        raise HTTPException(status_code=404, detail="Package was not found")
    return dest


def _read_result(folder: Path) -> str:
    path = folder / RESULT_NAME
    if not path.is_file():
        return ""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    line = text.replace("\r", "").split("\n", 1)[0].strip()
    return line[:240]


def _read_kind(folder: Path) -> str:
    kind = str(_read_report(folder).get("kind") or "")
    return kind if kind in FOIL_KINDS else ""


def list_packages(model_id: str) -> list[dict]:
    root = jobs_dir()
    if root is None or not root.is_dir():
        return []
    resolved_root = root.resolve()
    rows: list[dict] = []
    try:
        children = list(root.iterdir())
    except OSError:
        return []
    for child in children:
        if not child.is_dir():
            continue
        try:
            resolved = child.resolve()
        except OSError:
            continue
        if resolved.parent != resolved_root:
            continue
        if not package_belongs_to_model(child, model_id):
            continue
        modified = child.stat().st_mtime
        result = _read_result(child)
        rows.append(
            {
                "name": child.name,
                "modifiedAt": datetime.fromtimestamp(modified, timezone.utc).isoformat(),
                "saved": result.startswith("Saved "),
                "result": result,
                "kind": _read_kind(child),
                "hasProject": (child / PROJECT_FILE).is_file() or any(child.glob("*.aep")),
                "_modified": modified,
            }
        )
    rows.sort(key=lambda row: float(row["_modified"]), reverse=True)
    for row in rows:
        del row["_modified"]
    return rows


def delete_package(model_id: str, name: str) -> None:
    dest = resolve_package(model_id, name)
    shutil.rmtree(dest)


def project_file(folder: Path) -> Path:
    project = folder / PROJECT_FILE
    if project.is_file():
        return project
    matches = sorted(path for path in folder.glob("*.aep") if path.is_file())
    if len(matches) == 1:
        return matches[0]
    raise RuntimeError(f"Project file was not found in {folder.name}")


def render_main_comp(project: Path, output: Path) -> None:
    from backend.services.influencer_n8n import _after_effects_running

    if _after_effects_running():
        raise RuntimeError("After Effects is open. Close it, then use this package again.")
    aerender = Path(os.environ.get("AERENDER", str(AERENDER)))
    if not aerender.is_file():
        raise RuntimeError(f"aerender was not found: {aerender}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.unlink(missing_ok=True)
    print(f"Rendering {project.parent.name} to the card video.")
    completed = subprocess.run(
        [str(aerender), "-project", str(project), "-comp", COMP_NAME, "-output", str(output)],
        capture_output=True,
        text=True,
    )
    written = output if output.is_file() else output.with_suffix(".mp4")
    if completed.returncode != 0 or not written.is_file() or written.stat().st_size < 32:
        detail = (completed.stderr or completed.stdout or "").strip().splitlines()
        tail = detail[-1] if detail else f"exit {completed.returncode}"
        raise RuntimeError(tail or "After Effects did not write the card video.")
    if written != output:
        written.replace(output)
    print(f"Rendered card ({output.stat().st_size} bytes).")


def publish_package_video(
    folder: Path,
    *,
    model_id: str,
    kind: str,
    models_dir: Path,
) -> str:
    if kind not in FOIL_KINDS:
        raise RuntimeError(f"Unknown foil kind: {kind}")
    project = project_file(folder)
    work = Path(os.environ.get("FOIL_RENDER_DIR", "/tmp/foil-render"))
    output = work / f"{model_id}-{kind}.mp4"
    slot = "foil 2" if kind == "pack-face-2" else "foil 1"
    print(f"Rendering this package onto {slot}.")
    render_main_comp(project, output)
    return write_pack_video(models_dir, model_id, kind, output.read_bytes(), ".mp4")


def apply_package(*, model_id: str, name: str, kind: str, models_dir: Path) -> str:
    if kind not in FOIL_KINDS:
        raise HTTPException(status_code=400, detail="kind must be pack-face or pack-face-2")
    folder = resolve_package(model_id, name)
    return publish_package_video(folder, model_id=model_id, kind=kind, models_dir=models_dir)
