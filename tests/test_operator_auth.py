from __future__ import annotations

import pytest

from backend.auth.operator import needs_operator


def _scope(method: str, path: str) -> dict:
    return {"type": "http", "method": method, "path": path}


@pytest.mark.parametrize(
    ("method", "path", "expected"),
    [
        ("GET", "/api/health", False),
        ("GET", "/api/health/live", False),
        ("GET", "/api/health/ready", False),
        ("GET", "/api/cards", False),
        ("GET", "/api/auth/session", False),
        ("POST", "/api/auth/register", False),
        ("GET", "/api/store/products", False),
        ("GET", "/api/packs", False),
        ("POST", "/api/cards", True),
        ("PUT", "/api/cards/foo", True),
        ("DELETE", "/api/cards/foo", True),
        ("GET", "/api/jobs", True),
        ("POST", "/api/jobs/generate-mesh", True),
        ("OPTIONS", "/api/cards", False),
    ],
)
def test_needs_operator(method: str, path: str, expected: bool):
    assert needs_operator(_scope(method, path)) is expected
