from __future__ import annotations

import subprocess
import uuid
from pathlib import Path

from backend.services.influencer_n8n import (
    launch_after_effects,
    require_label,
    result_saved,
    run_copy,
    run_influencer_n8n,
    script_command,
)


class FakeProcess:
    def __init__(self, lines: list[str], code: int = 0) -> None:
        self.stdout = iter(lines)
        self._code = code

    def wait(self) -> int:
        return self._code


def test_require_label_rejects_empty_and_pipes():
    from fastapi import HTTPException

    import pytest

    with pytest.raises(HTTPException):
        require_label("  ", "Name")
    with pytest.raises(HTTPException):
        require_label("a|b", "Id")
    assert require_label("  Ada  Vale ", "Name") == "Ada Vale"


def test_script_command_uses_name_id_and_clip(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("INFLUENCER_N8N_SCRIPT", str(tmp_path / "duplicate_job.py"))
    monkeypatch.setenv("INFLUENCER_TEMPLATE", str(tmp_path / "template"))
    monkeypatch.setenv("INFLUENCER_JOBS", str(tmp_path / "jobs"))
    clip = tmp_path / "clip.mp4"
    command = script_command(clip, "Ada", "234")
    assert command[1] == str(tmp_path / "duplicate_job.py")
    assert command[command.index("--template") + 1] == str(tmp_path / "template")
    assert command[command.index("--jobs") + 1] == str(tmp_path / "jobs")
    assert command[2:8] == ["--template", command[3], "--jobs", command[5], "--name", "Ada"]
    assert "--id" in command
    assert command[command.index("--id") + 1] == "234"
    assert command[command.index("--clip") + 1] == str(clip)
    assert command[command.index("--project") + 1] == "ss-Influencer.aep"


def test_result_saved_accepts_only_the_saved_prefix():
    assert result_saved("Saved Ada (234).\nRelinked 6 footage item(s).")
    assert result_saved("Saved Ada.\r\nRelinked 1 footage item(s).")
    assert not result_saved("Failed to open the project.")


def test_run_copy_reads_the_destination(tmp_path: Path, monkeypatch):
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"clip")

    def fake_popen(command, **kwargs):
        assert command[command.index("--name") + 1] == "Ada"
        return FakeProcess(['Greenkey: uploading\n', 'AE_JOB {"destination": "/tmp/SS-234 Ada"}\n'])

    monkeypatch.setattr("backend.services.influencer_n8n.subprocess.Popen", fake_popen)
    monkeypatch.setattr(
        "backend.services.influencer_n8n.script_command",
        lambda path, name, card_id: ["python", str(tmp_path / "duplicate_job.py"), "--name", name],
    )
    (tmp_path / "duplicate_job.py").write_text("# test\n")
    assert run_copy(clip, "Ada", "234") == Path("/tmp/SS-234 Ada")


def test_run_influencer_n8n_shows_lines_pushed_by_n8n(tmp_path: Path, monkeypatch):
    from backend.services import influencer_n8n as service

    clip = tmp_path / "clip.mov"
    clip.write_bytes(b"clip")

    def fake_post(url: str, payload: dict, token: str, timeout: float) -> bytes:
        service.note_progress("job1", "influencer-n8n-result: /tmp/SS-234 Ada")
        return b"{}"

    monkeypatch.setattr(service, "_post_json", fake_post)
    line = service.run_influencer_n8n(
        clip=clip,
        name="Ada",
        card_id="234",
        job_id="job1",
        progress_token="token",
    )
    assert line == "influencer-n8n-result: /tmp/SS-234 Ada"
    assert not clip.exists()


def test_influencer_n8n_requires_operator(client):
    response = client.post(
        "/api/jobs/models/someone/influencer-n8n",
        data={"name": "Ada", "card_id": "234"},
        files={"file": ("clip.mp4", b"\x00\x00\x00\x18ftypisom", "video/mp4")},
    )
    assert response.status_code == 401


def test_influencer_n8n_queues_job(client, dashboard_headers, monkeypatch):
    model_id = f"infn8n{uuid.uuid4().hex[:8]}"
    created = client.post(
        "/api/models",
        headers=dashboard_headers,
        json={"id": model_id, "label": "Ada", "influencerName": "Ada Vale"},
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
                    "id": "abc",
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
    try:
        response = client.post(
            f"/api/jobs/models/{model_id}/influencer-n8n",
            headers=dashboard_headers,
            data={"card_id": "234"},
            files={"file": ("clip.mp4", b"\x00\x00\x00\x18ftypisom" + b"\x00" * 16, "video/mp4")},
        )
        assert response.status_code == 200, response.text
        assert response.json()["kind"] == "influencer-n8n"
        assert captured["command"] == ["influencer-n8n", model_id, "234", "Ada Vale"]
        assert callable(captured["action"])
    finally:
        client.delete(f"/api/models/{model_id}", headers=dashboard_headers)


def test_launch_sends_the_project_when_after_effects_is_open(tmp_path: Path, monkeypatch):
    destination = tmp_path / "job"
    destination.mkdir()
    (destination / "ae-relink.jsx").write_text("app.beginSuppressDialogs();")
    app = tmp_path / "After Effects.app"
    app.mkdir()
    monkeypatch.setenv("AFTER_EFFECTS_APP", str(app))
    running = {"open": True}
    monkeypatch.setattr(
        "backend.services.influencer_n8n._after_effects_running",
        lambda: running["open"],
    )

    def fake_run(command, **kwargs):
        assert command[0] == "osascript"
        assert "quit" in command[-1]
        running["open"] = False
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr("backend.services.influencer_n8n.subprocess.run", fake_run)

    class Proc:
        stdout = None

        def poll(self):
            return None

        def kill(self):
            return None

    def fake_popen(command, **kwargs):
        assert command[0] == "osascript"
        (destination / "ae-relink-result.txt").write_text("Saved the project\n")
        return Proc()

    monkeypatch.setattr("backend.services.influencer_n8n.subprocess.Popen", fake_popen)

    text = launch_after_effects(destination)

    assert text.startswith("Saved ")


def test_hosted_steps_report_in_process_instead_of_calling_back(tmp_path: Path, monkeypatch):
    from backend.services.influencer_n8n import RESULT_LINE, run_hosted_steps

    destination = tmp_path / "job"
    destination.mkdir()
    reported: list[str] = []

    monkeypatch.setattr(
        "backend.services.influencer_n8n.run_copy",
        lambda *_args, **_kwargs: destination,
    )
    monkeypatch.setattr(
        "backend.services.influencer_n8n.launch_after_effects",
        lambda _destination: "Saved",
    )

    def fail_http(*_args, **_kwargs):
        raise AssertionError("hosted steps must not POST progress back to this API")

    monkeypatch.setattr("backend.services.influencer_n8n._post_json", fail_http)

    line = run_hosted_steps(
        clip=tmp_path / "clip.mp4",
        name="Ada",
        card_id="234",
        progress_url="http://127.0.0.1:8090/api/jobs/job1/progress",
        progress_token="token",
        report_line=reported.append,
    )

    assert line == f"{RESULT_LINE} {destination}"
    assert reported == [line]


def test_progress_url_for_reaches_the_host_from_docker_n8n(monkeypatch):
    from backend.services.influencer_n8n import host_progress_url_for, progress_url_for

    monkeypatch.delenv("INFLUENCER_PROGRESS_BASE", raising=False)
    monkeypatch.delenv("INFLUENCER_PROGRESS_HOST_BASE", raising=False)
    assert progress_url_for("job1") == "http://host.docker.internal:8090/api/jobs/job1/progress"
    assert host_progress_url_for("job1") == "http://127.0.0.1:8090/api/jobs/job1/progress"

    monkeypatch.setenv("INFLUENCER_PROGRESS_BASE", "http://api.internal:8090/")
    monkeypatch.setenv("INFLUENCER_PROGRESS_HOST_BASE", "http://10.0.0.2:8090/")
    assert progress_url_for("job1") == "http://api.internal:8090/api/jobs/job1/progress"
    assert host_progress_url_for("job1") == "http://10.0.0.2:8090/api/jobs/job1/progress"


def test_form_run_rejects_a_missing_clip(client):
    hidden = client.post(
        "/api/internal/influencer-run",
        json={"name": "Ada", "id": "22", "clip": "/tmp/nope.mp4"},
    )
    assert hidden.status_code == 404

    missing = client.post(
        "/api/internal/influencer-run",
        headers={"X-Progress-Token": "local-influencer-run"},
        json={"name": "Ada", "id": "22", "clip": "/tmp/nope.mp4"},
    )
    assert missing.status_code == 400
    assert "Clip file" in missing.json()["detail"]
