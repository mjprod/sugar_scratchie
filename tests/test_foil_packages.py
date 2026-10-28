from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi import HTTPException

from backend.services.foil_packages import (
    apply_package,
    delete_package,
    list_packages,
    render_main_comp,
    resolve_package,
)

FAKE_MP4 = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 32


def _jobs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "jobs"
    root.mkdir()
    monkeypatch.setenv("INFLUENCER_JOBS", str(root))
    return root


def _package(root: Path, name: str, *, kind: str = "", saved: bool = True) -> Path:
    folder = root / name
    folder.mkdir()
    (folder / "ss-Influencer.aep").write_bytes(b"aep")
    if saved:
        (folder / "ae-relink-result.txt").write_text(
            "Saved Ada (ada). Relinked 6. Fitted the video inside the frame.\n",
            encoding="utf-8",
        )
    if kind:
        (folder / "ae-relink-report.json").write_text(
            json.dumps({"name": "Ada", "id": "ada", "kind": kind}),
            encoding="utf-8",
        )
    return folder


def test_list_packages_keeps_only_this_model(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = _jobs(tmp_path, monkeypatch)
    older = _package(root, "SS-ada Ada", kind="pack-face")
    newer = _package(root, "SS-ada Ada 2")
    os.utime(older, (1_700_000_000, 1_700_000_000))
    os.utime(newer, (1_700_000_100, 1_700_000_100))
    _package(root, "SS-ada2 Ada")
    _package(root, "SS-other Ada")
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "SS-ada escape").symlink_to(outside, target_is_directory=True)

    names = [row["name"] for row in list_packages("ada")]

    assert names == ["SS-ada Ada 2", "SS-ada Ada"]
    first = list_packages("ada")[1]
    assert first["saved"] is True
    assert first["kind"] == "pack-face"
    assert first["hasProject"] is True


def test_resolve_package_rejects_paths_outside_the_jobs_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    root = _jobs(tmp_path, monkeypatch)
    _package(root, "SS-ada Ada")

    with pytest.raises(HTTPException) as missing:
        resolve_package("ada", "SS-other Ada")
    assert missing.value.status_code == 404

    with pytest.raises(HTTPException) as slashed:
        resolve_package("ada", "SS-ada Ada/../../etc")
    assert slashed.value.status_code == 400

    with pytest.raises(HTTPException) as dotted:
        resolve_package("ada", "..")
    assert dotted.value.status_code == 400


def test_delete_package_removes_only_that_folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = _jobs(tmp_path, monkeypatch)
    _package(root, "SS-ada Ada")
    _package(root, "SS-ada Ada 2")

    delete_package("ada", "SS-ada Ada 2")

    assert (root / "SS-ada Ada").is_dir()
    assert not (root / "SS-ada Ada 2").exists()


def test_render_accepts_the_mp4_aerender_writes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    project = tmp_path / "job" / "ss-Influencer.aep"
    project.parent.mkdir()
    project.write_bytes(b"aep")
    output = tmp_path / "out" / "card.mov"
    aerender = tmp_path / "aerender"
    aerender.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    aerender.chmod(0o755)
    monkeypatch.setenv("AERENDER", str(aerender))
    monkeypatch.setattr(
        "backend.services.influencer_n8n._after_effects_running",
        lambda: False,
    )

    def fake_run(command, **_kwargs):
        assert command[command.index("-comp") + 1] == "--Exporter60fps"
        dest = Path(command[command.index("-output") + 1])
        dest.with_suffix(".mp4").write_bytes(FAKE_MP4)

        class Completed:
            returncode = 0
            stdout = ""
            stderr = ""

        return Completed()

    monkeypatch.setattr("backend.services.foil_packages.subprocess.run", fake_run)

    render_main_comp(project, output)

    assert output.read_bytes() == FAKE_MP4
    assert not output.with_suffix(".mp4").exists() or output.suffix == ".mp4"


def test_apply_package_writes_the_chosen_slot(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = _jobs(tmp_path, monkeypatch)
    folder = _package(root, "SS-ada Ada 2", kind="pack-face-2")
    models = tmp_path / "models"

    def fake_render(project: Path, output: Path) -> None:
        assert project == folder / "ss-Influencer.aep"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(FAKE_MP4)

    monkeypatch.setattr("backend.services.foil_packages.render_main_comp", fake_render)

    public = apply_package(
        model_id="ada",
        name="SS-ada Ada 2",
        kind="pack-face-2",
        models_dir=models,
    )

    assert public == "/models/ada/pack-face-2.mp4"
    assert (models / "ada" / "pack-face-2.mp4").read_bytes() == FAKE_MP4


def test_foil_packages_require_operator(client):
    hidden = client.get("/api/jobs/models/someone/foil-packages")
    assert hidden.status_code == 401


def test_foil_packages_use_queues_a_job(client, dashboard_headers, monkeypatch: pytest.MonkeyPatch):
    model_id = f"foilpkg{os.urandom(4).hex()}"
    created = client.post(
        "/api/models",
        headers=dashboard_headers,
        json={"id": model_id, "label": "Ada"},
    )
    assert created.status_code == 200, created.text
    captured: dict = {}

    def fake_enqueue(kind: str, command: list[str], action, **kwargs):
        captured["kind"] = kind
        captured["command"] = command
        captured["action"] = action

        class Job:
            def public(self) -> dict:
                return {
                    "id": "pkg1",
                    "kind": kind,
                    "command": command,
                    "status": "queued",
                    "created_at": 0,
                    "started_at": None,
                    "ended_at": None,
                    "return_code": None,
                    "logs": [],
                }

        return Job()

    monkeypatch.setattr("backend.app.enqueue", fake_enqueue)
    monkeypatch.setattr("backend.services.foil_packages.resolve_package", lambda *_args: Path("/tmp"))
    try:
        listed = client.get(
            f"/api/jobs/models/{model_id}/foil-packages",
            headers=dashboard_headers,
        )
        assert listed.status_code == 200, listed.text
        assert listed.json()["packages"] == []

        rejected = client.post(
            f"/api/jobs/models/{model_id}/foil-packages/use",
            headers=dashboard_headers,
            json={"name": f"SS-{model_id} Ada", "kind": "swipe"},
        )
        assert rejected.status_code == 400

        queued = client.post(
            f"/api/jobs/models/{model_id}/foil-packages/use",
            headers=dashboard_headers,
            json={"name": f"SS-{model_id} Ada", "kind": "pack-face-2"},
        )
        assert queued.status_code == 200, queued.text
        assert captured["kind"] == "foil-package"
        assert captured["command"] == [
            "foil-package",
            model_id,
            "pack-face-2",
            f"SS-{model_id} Ada",
        ]
        assert callable(captured["action"])
    finally:
        client.delete(f"/api/models/{model_id}", headers=dashboard_headers)
