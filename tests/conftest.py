from __future__ import annotations

import os
import subprocess
import sys
import uuid
from collections.abc import Generator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

TEST_DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql+psycopg://sugar:sugar@127.0.0.1:5433/sugar_test",
)
os.environ["DATABASE_URL"] = TEST_DATABASE_URL
os.environ.setdefault("DASHBOARD_TOKEN", "test-dashboard-token")


def _ensure_test_database() -> None:
    admin_url = TEST_DATABASE_URL.rsplit("/", 1)[0] + "/postgres"
    db_name = TEST_DATABASE_URL.rsplit("/", 1)[1]
    engine = create_engine(admin_url, isolation_level="AUTOCOMMIT")
    with engine.connect() as conn:
        exists = conn.execute(
            text("SELECT 1 FROM pg_database WHERE datname = :name"),
            {"name": db_name},
        ).scalar()
        if not exists:
            conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    engine.dispose()


def _run_migrations() -> None:
    alembic = ROOT / ".venv" / "bin" / "alembic"
    cmd = [str(alembic), "-c", "backend/alembic.ini", "upgrade", "head"]
    subprocess.run(cmd, cwd=ROOT, env=os.environ.copy(), check=True)


@pytest.fixture(scope="session", autouse=True)
def setup_test_database() -> Generator[None, None, None]:
    _ensure_test_database()
    _run_migrations()
    from backend.db.seed import seed

    seed()
    yield


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    from backend.app import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def db_session() -> Generator[Session, None, None]:
    from backend.db.engine import get_engine

    connection = get_engine().connect()
    transaction = connection.begin()
    session = Session(bind=connection, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()


@pytest.fixture
def dashboard_headers() -> dict[str, str]:
    token = os.environ.get("DASHBOARD_TOKEN", "test-dashboard-token")
    return {"X-Dashboard-Token": token}


def register_and_login(
    client: TestClient,
    *,
    email: str | None = None,
    password: str = "testpassword123",
) -> tuple[str, dict]:
    suffix = uuid.uuid4().hex[:10]
    address = email or f"test-{suffix}@example.com"
    response = client.post(
        "/api/auth/register",
        json={"email": address, "password": password, "username": f"tester-{suffix}"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    return address, body["user"]


def login(client: TestClient, email: str, password: str = "testpassword123") -> dict:
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return response.json()["user"]
