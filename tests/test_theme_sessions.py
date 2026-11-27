"""Theme sessions: a dated window of themes, otherwise Default."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from backend.db.engine import get_engine
from backend.db.models import Creator, MotionCard, Theme


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat()


def _sessions(client: TestClient) -> list[dict]:
    response = client.get("/api/theme-sessions")
    assert response.status_code == 200, response.text
    return response.json()["sessions"]


def _free_acronym(client: TestClient) -> str:
    used = {(session.get("acronym") or "").upper() for session in _sessions(client)}
    for first in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        for second in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
            code = f"{first}{second}"
            if code not in used:
                return code
    raise AssertionError("no free two-letter acronym")


def _restore_default(client: TestClient, headers: dict[str, str]) -> None:
    """Leave Default running so later tests are not filtered by a custom session."""
    now = datetime.now(timezone.utc)
    for session in _sessions(client):
        if session["is_default"] or not session["is_running"]:
            continue
        response = client.put(
            f"/api/theme-sessions/{session['id']}/schedule",
            headers=headers,
            json={
                "starts_at": _iso(now - timedelta(hours=2)),
                "ends_at": _iso(now - timedelta(minutes=1)),
            },
        )
        assert response.status_code == 200, response.text


@pytest.fixture
def restore_default(client: TestClient, dashboard_headers: dict[str, str]):
    yield
    _restore_default(client, dashboard_headers)


def test_default_session_is_the_fallback(client: TestClient, dashboard_headers: dict[str, str]):
    sessions = _sessions(client)
    default = next(session for session in sessions if session["id"] == "default")
    assert default["is_default"] is True
    assert default["status"] == "fallback"
    assert default["is_running"] is True
    assert default["theme_ids"] == []
    assert default["starts_at"] is None
    assert default["ends_at"] is None
    assert default["acronym"] == "DF"

    code = _free_acronym(client)
    renamed = client.put(
        "/api/theme-sessions/default",
        headers=dashboard_headers,
        json={"id": "default", "label": "Everyday", "acronym": code},
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["label"] == "Everyday"
    assert renamed.json()["acronym"] == code
    assert renamed.json()["is_default"] is True

    blocked = client.put(
        "/api/theme-sessions/default",
        headers=dashboard_headers,
        json={"id": "everyday", "label": "Everyday", "acronym": code},
    )
    assert blocked.status_code == 400

    restored = client.put(
        "/api/theme-sessions/default",
        headers=dashboard_headers,
        json={"id": "default", "label": "Default", "acronym": "DF"},
    )
    assert restored.status_code == 200, restored.text


def test_session_lifecycle_and_theme_lists(
    client: TestClient,
    dashboard_headers: dict[str, str],
    restore_default: None,
):
    del restore_default
    suffix = uuid.uuid4().hex[:8]
    theme_a = f"sessa_{suffix}"
    theme_b = f"sessb_{suffix}"
    summer = f"summer_{suffix}"
    winter = f"winter_{suffix}"
    with Session(get_engine()) as db:
        db.add_all(
            [
                Theme(id=theme_a, label=f"Summer theme {suffix}", sort_order=10),
                Theme(id=theme_b, label=f"Winter theme {suffix}", sort_order=11),
            ]
        )
        db.commit()

    summer_code = _free_acronym(client)
    unauthorized = client.post(
        "/api/theme-sessions",
        json={"id": summer, "label": "Summer", "acronym": summer_code},
    )
    assert unauthorized.status_code == 401

    created = client.post(
        "/api/theme-sessions",
        headers=dashboard_headers,
        json={"id": summer, "label": "Summer", "acronym": summer_code},
    )
    assert created.status_code == 200, created.text
    assert created.json()["status"] == "draft"
    assert created.json()["acronym"] == summer_code
    assert created.json()["theme_ids"] == []

    empty = client.put(
        f"/api/theme-sessions/{summer}/schedule",
        headers=dashboard_headers,
        json={
            "starts_at": _iso(datetime.now(timezone.utc) - timedelta(hours=1)),
            "ends_at": _iso(datetime.now(timezone.utc) + timedelta(hours=1)),
        },
    )
    assert empty.status_code == 400

    missing = client.put(
        f"/api/theme-sessions/{summer}/themes",
        headers=dashboard_headers,
        json={"theme_ids": ["no_such_theme"]},
    )
    assert missing.status_code == 400

    default_themes = client.put(
        "/api/theme-sessions/default/themes",
        headers=dashboard_headers,
        json={"theme_ids": [theme_a]},
    )
    assert default_themes.status_code == 400

    assigned = client.put(
        f"/api/theme-sessions/{summer}/themes",
        headers=dashboard_headers,
        json={"theme_ids": [theme_b, theme_a]},
    )
    assert assigned.status_code == 200, assigned.text
    assert assigned.json()["theme_ids"] == [theme_a, theme_b]

    renamed_id = f"sum2_{suffix}"
    renamed = client.put(
        f"/api/theme-sessions/{summer}",
        headers=dashboard_headers,
        json={"id": renamed_id, "label": "Summer edit", "acronym": summer_code},
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["id"] == renamed_id
    assert renamed.json()["label"] == "Summer edit"
    assert renamed.json()["theme_ids"] == [theme_a, theme_b]
    restored = client.put(
        f"/api/theme-sessions/{renamed_id}",
        headers=dashboard_headers,
        json={"id": summer, "label": "Summer", "acronym": summer_code},
    )
    assert restored.status_code == 200, restored.text

    winter_code = _free_acronym(client)
    other = client.post(
        "/api/theme-sessions",
        headers=dashboard_headers,
        json={"id": winter, "label": "Winter", "acronym": winter_code},
    )
    assert other.status_code == 200, other.text
    winter_themes = client.put(
        f"/api/theme-sessions/{winter}/themes",
        headers=dashboard_headers,
        json={"theme_ids": [theme_b]},
    )
    assert winter_themes.status_code == 200, winter_themes.text
    assert winter_themes.json()["theme_ids"] == [theme_b]

    backwards = client.put(
        f"/api/theme-sessions/{summer}/schedule",
        headers=dashboard_headers,
        json={
            "starts_at": _iso(datetime.now(timezone.utc) + timedelta(hours=2)),
            "ends_at": _iso(datetime.now(timezone.utc) - timedelta(hours=2)),
        },
    )
    assert backwards.status_code == 400

    started = client.put(
        f"/api/theme-sessions/{summer}/schedule",
        headers=dashboard_headers,
        json={
            "starts_at": _iso(datetime.now(timezone.utc) - timedelta(hours=2)),
            "ends_at": _iso(datetime.now(timezone.utc) + timedelta(hours=2)),
        },
    )
    assert started.status_code == 200, started.text
    by_id = {session["id"]: session for session in started.json()["sessions"]}
    assert by_id[summer]["status"] == "running"
    assert by_id[summer]["is_running"] is True
    assert by_id["default"]["is_running"] is False

    later = client.put(
        f"/api/theme-sessions/{winter}/schedule",
        headers=dashboard_headers,
        json={
            "starts_at": _iso(datetime.now(timezone.utc) + timedelta(days=2)),
            "ends_at": _iso(datetime.now(timezone.utc) + timedelta(days=3)),
        },
    )
    assert later.status_code == 200, later.text
    by_id = {session["id"]: session for session in later.json()["sessions"]}
    assert by_id[winter]["status"] == "scheduled"
    assert by_id[summer]["is_running"] is True
    assert by_id["default"]["is_running"] is False

    cannot_delete_running = client.delete(
        f"/api/theme-sessions/{summer}",
        headers=dashboard_headers,
    )
    assert cannot_delete_running.status_code == 400
    cannot_delete_default = client.delete("/api/theme-sessions/default", headers=dashboard_headers)
    assert cannot_delete_default.status_code == 400

    ended = client.put(
        f"/api/theme-sessions/{summer}/schedule",
        headers=dashboard_headers,
        json={
            "starts_at": _iso(datetime.now(timezone.utc) - timedelta(hours=3)),
            "ends_at": _iso(datetime.now(timezone.utc) - timedelta(hours=1)),
        },
    )
    assert ended.status_code == 200, ended.text
    by_id = {session["id"]: session for session in ended.json()["sessions"]}
    assert by_id[summer]["status"] == "ended"
    assert by_id["default"]["is_running"] is True


def test_collection_follows_the_running_session(
    client: TestClient,
    dashboard_headers: dict[str, str],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    restore_default: None,
):
    del restore_default
    import backend.app as app_module

    cards_dir = tmp_path / "cards"
    mesh_dir = tmp_path / "mesh"
    mesh_dir.mkdir()
    monkeypatch.setattr(app_module, "ROOT", tmp_path)
    monkeypatch.setattr(app_module, "CARDS_DIR", cards_dir)
    monkeypatch.setattr(app_module, "MESH_DIR", mesh_dir)

    suffix = uuid.uuid4().hex[:8]
    model_id = f"sessmodel_{suffix}"
    theme_a = f"colA_{suffix}"
    theme_b = f"colB_{suffix}"
    card_a = f"sessmodel_{suffix}_a"
    card_b = f"sessmodel_{suffix}_b"
    summer = f"colsummer_{suffix}"
    winter = f"colwinter_{suffix}"
    with Session(get_engine()) as db:
        db.add(Creator(id=model_id, label=f"Session model {suffix}"))
        db.add_all(
            [
                Theme(id=theme_a, label=f"Col A {suffix}", sort_order=1),
                Theme(id=theme_b, label=f"Col B {suffix}", sort_order=2),
            ]
        )
        db.flush()
        db.add_all(
            [
                MotionCard(id=card_a, label="A", model_id=model_id, theme_id=theme_a),
                MotionCard(id=card_b, label="B", model_id=model_id, theme_id=theme_b),
            ]
        )
        db.commit()
    for card_id in (card_a, card_b):
        card_dir = cards_dir / card_id
        card_dir.mkdir(parents=True)
        for name in ("background.mp4", "foreground.mp4"):
            (card_dir / name).write_bytes(b"clip")

    def theme_ids() -> set[str]:
        response = client.get(f"/api/collection?model={model_id}")
        assert response.status_code == 200, response.text
        return {group["themeId"] for group in response.json()["groups"]}

    assert theme_ids() == {theme_a, theme_b}

    for session_id, label, themes in (
        (summer, "Col Summer", [theme_a]),
        (winter, "Col Winter", [theme_b]),
    ):
        created = client.post(
            "/api/theme-sessions",
            headers=dashboard_headers,
            json={"id": session_id, "label": label, "acronym": _free_acronym(client)},
        )
        assert created.status_code == 200, created.text
        saved = client.put(
            f"/api/theme-sessions/{session_id}/themes",
            headers=dashboard_headers,
            json={"theme_ids": themes},
        )
        assert saved.status_code == 200, saved.text

    started = client.put(
        f"/api/theme-sessions/{summer}/schedule",
        headers=dashboard_headers,
        json={
            "starts_at": _iso(datetime.now(timezone.utc) - timedelta(hours=3)),
            "ends_at": _iso(datetime.now(timezone.utc) + timedelta(hours=2)),
        },
    )
    assert started.status_code == 200, started.text
    assert theme_ids() == {theme_a}

    outside = client.put(
        f"/api/theme-sessions/{summer}/schedule",
        headers=dashboard_headers,
        json={
            "starts_at": _iso(datetime.now(timezone.utc) - timedelta(hours=3)),
            "ends_at": _iso(datetime.now(timezone.utc) - timedelta(hours=1)),
        },
    )
    assert outside.status_code == 200, outside.text
    assert theme_ids() == {theme_a, theme_b}

    winter_window = client.put(
        f"/api/theme-sessions/{winter}/schedule",
        headers=dashboard_headers,
        json={
            "starts_at": _iso(datetime.now(timezone.utc) - timedelta(hours=1)),
            "ends_at": _iso(datetime.now(timezone.utc) + timedelta(hours=2)),
        },
    )
    assert winter_window.status_code == 200, winter_window.text
    assert theme_ids() == {theme_b}

    back = client.put(
        f"/api/theme-sessions/{winter}/schedule",
        headers=dashboard_headers,
        json={
            "starts_at": _iso(datetime.now(timezone.utc) - timedelta(hours=3)),
            "ends_at": _iso(datetime.now(timezone.utc) - timedelta(minutes=1)),
        },
    )
    assert back.status_code == 200, back.text
    assert theme_ids() == {theme_a, theme_b}


def test_deleting_the_last_live_theme_keeps_the_catalog(
    client: TestClient,
    dashboard_headers: dict[str, str],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    restore_default: None,
):
    del restore_default
    import backend.app as app_module

    cards_dir = tmp_path / "cards"
    mesh_dir = tmp_path / "mesh"
    mesh_dir.mkdir()
    monkeypatch.setattr(app_module, "ROOT", tmp_path)
    monkeypatch.setattr(app_module, "CARDS_DIR", cards_dir)
    monkeypatch.setattr(app_module, "MESH_DIR", mesh_dir)

    suffix = uuid.uuid4().hex[:8]
    model_id = f"sessmodel_{suffix}"
    gone = f"gone_{suffix}"
    stay = f"stay_{suffix}"
    session_id = f"live_{suffix}"
    with Session(get_engine()) as db:
        db.add(Creator(id=model_id, label=f"Session model {suffix}"))
        db.add_all(
            [
                Theme(id=gone, label=f"Gone {suffix}", sort_order=1),
                Theme(id=stay, label=f"Stay {suffix}", sort_order=2),
            ]
        )
        db.flush()
        db.add_all(
            [
                MotionCard(id=f"{model_id}_gone", label="Gone", model_id=model_id, theme_id=gone),
                MotionCard(id=f"{model_id}_stay", label="Stay", model_id=model_id, theme_id=stay),
            ]
        )
        db.commit()
    for card_id in (f"{model_id}_gone", f"{model_id}_stay"):
        card_dir = cards_dir / card_id
        card_dir.mkdir(parents=True)
        for name in ("background.mp4", "foreground.mp4"):
            (card_dir / name).write_bytes(b"clip")

    created = client.post(
        "/api/theme-sessions",
        headers=dashboard_headers,
        json={"id": session_id, "label": "Live", "acronym": _free_acronym(client)},
    )
    assert created.status_code == 200, created.text
    saved = client.put(
        f"/api/theme-sessions/{session_id}/themes",
        headers=dashboard_headers,
        json={"theme_ids": [gone]},
    )
    assert saved.status_code == 200, saved.text
    started = client.put(
        f"/api/theme-sessions/{session_id}/schedule",
        headers=dashboard_headers,
        json={
            "starts_at": _iso(datetime.now(timezone.utc) - timedelta(hours=1)),
            "ends_at": _iso(datetime.now(timezone.utc) + timedelta(hours=1)),
        },
    )
    assert started.status_code == 200, started.text

    def theme_ids() -> set[str | None]:
        response = client.get(f"/api/collection?model={model_id}")
        assert response.status_code == 200, response.text
        return {group["themeId"] for group in response.json()["groups"]}

    assert theme_ids() == {gone}

    deleted = client.delete(f"/api/themes/{gone}", headers=dashboard_headers)
    assert deleted.status_code == 200, deleted.text

    assert stay in theme_ids()
    sessions = {session["id"]: session for session in _sessions(client)}
    assert sessions["default"]["is_running"] is True
    assert sessions[session_id]["is_running"] is False
    assert sessions[session_id]["theme_ids"] == []
