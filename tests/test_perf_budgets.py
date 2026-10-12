"""SQL-query and latency budgets for the hot player endpoints.

Query counts are deterministic, so they carry the real assertions: a budget
breach or a count that grows with the player's data (N+1) fails the build.
Latency is a loose ceiling on the in-process median that only catches
pathological regressions; use `scripts/perf-api-load.py` for real numbers.
"""

from __future__ import annotations

import statistics
import time
import uuid
from collections.abc import Callable, Generator, Iterator
from contextlib import contextmanager
from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import event
from sqlalchemy.orm import Session

from tests.conftest import register_and_login

WARM_RUNS = 5
READ_LATENCY_BUDGET_MS = 250.0
WRITE_LATENCY_BUDGET_MS = 500.0
CATALOG_LATENCY_BUDGET_MS = 1000.0
PERF_PACK_ID = "ep1"
DIAMOND_PRODUCT_ID = "d2500"
SMALL_HISTORY_PACKS = 1
LARGE_HISTORY_PACKS = 3
SMALL_CREATOR_CARDS = 2
LARGE_CREATOR_CARDS = 6

# Pinned to the current counts: raise one deliberately when a change needs it.
READ_QUERY_BUDGETS: dict[str, int] = {
    "/api/auth/session": 3,
    "/api/me/profile": 4,
    "/api/me/wallet": 4,
    "/api/me/wallet/transactions": 4,
    "/api/store/products": 1,
    "/api/packs": 1,
    "/api/me/packs": 5,
    "/api/me/collection": 7,
    "/api/me/cards/played": 4,
    "/api/me/game-session": 4,
    "/api/inbox": 5,
    "/api/rewards/daily": 4,
}
BOARD_QUERY_BUDGET = 10
PACK_PURCHASE_QUERY_BUDGET = 12
PACK_OPEN_QUERY_BUDGET = 11
CARD_REVEAL_QUERY_BUDGET = 17
CARD_PLAY_QUERY_BUDGET = 9

# Lists whose query count must not grow with the player's history.
HISTORY_SCALED_PATHS = (
    "/api/me/wallet/transactions",
    "/api/me/packs",
    "/api/me/collection",
    "/api/me/cards/played",
    "/api/inbox",
)


@dataclass
class Measured:
    response: Response
    queries: int
    elapsed_ms: float


class QueryCounter:
    def __init__(self) -> None:
        self.count = 0

    def __call__(self, *_args) -> None:
        self.count += 1

    @contextmanager
    def window(self) -> Iterator[None]:
        self.count = 0
        yield


@pytest.fixture(scope="module")
def query_counter() -> Generator[QueryCounter, None, None]:
    from backend.db.engine import get_engine

    engine = get_engine()
    counter = QueryCounter()
    event.listen(engine, "before_cursor_execute", counter)
    try:
        yield counter
    finally:
        event.remove(engine, "before_cursor_execute", counter)


def _measure(counter: QueryCounter, call: Callable[[], Response]) -> Measured:
    with counter.window():
        started = time.perf_counter()
        response = call()
        elapsed_ms = (time.perf_counter() - started) * 1000
    assert response.status_code == 200, response.text
    return Measured(response, counter.count, elapsed_ms)


def _warm_median(counter: QueryCounter, call: Callable[[], Response]) -> Measured:
    _measure(counter, call)
    runs = [_measure(counter, call) for _ in range(WARM_RUNS)]
    median_ms = statistics.median(run.elapsed_ms for run in runs)
    return Measured(runs[-1].response, max(run.queries for run in runs), median_ms)


def _create_creator(card_count: int) -> str:
    from backend.db.engine import get_engine
    from backend.db.models import Creator, MotionCard, PhotoScratchCard

    creator_id = f"perf_creator_{uuid.uuid4().hex[:8]}"
    with Session(get_engine()) as db:
        db.add(Creator(id=creator_id, label=creator_id))
        db.flush()
        for index in range(card_count):
            card_id = f"{creator_id}_card_{index}"
            db.add(MotionCard(id=card_id, label=f"Perf card {index}", model_id=creator_id, sort_order=index))
            db.flush()
            db.add(
                PhotoScratchCard(
                    id=f"{card_id}_slot_01",
                    card_id=card_id,
                    slot_id="slot_01",
                    label="Perf slot",
                    background="/bg.png",
                    bikini="/bikini.png",
                    clothes="/clothes.png",
                    mesh="/mesh.json",
                )
            )
        db.commit()
    return creator_id


def _buy_diamonds(client: TestClient) -> None:
    purchase = client.post("/api/store/purchases", json={"product_id": DIAMOND_PRODUCT_ID})
    assert purchase.status_code == 200, purchase.text
    session_id = purchase.json()["session"]["id"]
    verified = client.post(f"/api/store/purchases/{session_id}/verify", json={"outcome": "completed"})
    assert verified.status_code == 200, verified.text


def _buy_pack(client: TestClient) -> Response:
    return client.post(
        f"/api/packs/{PERF_PACK_ID}/purchase",
        json={"quantity": 1},
        headers={"Idempotency-Key": f"perf-pack-{uuid.uuid4().hex}"},
    )


def _open_and_reveal_all(client: TestClient, instance_id: str) -> None:
    opened = client.post(f"/api/me/packs/{instance_id}/open")
    assert opened.status_code == 200, opened.text
    body = opened.json()
    for card in body["session"]["cards"]:
        revealed = client.post(f"/api/me/openings/{body['openingId']}/cards/{card['id']}/reveal")
        assert revealed.status_code == 200, revealed.text


def _player_with_history(packs: int) -> TestClient:
    from backend.app import app

    client = TestClient(app)
    client.__enter__()
    register_and_login(client)
    assert client.post("/api/me/welcome/claim").status_code == 200
    _buy_diamonds(client)
    for _ in range(packs):
        bought = _buy_pack(client)
        assert bought.status_code == 200, bought.text
        _open_and_reveal_all(client, bought.json()["instances"][0]["instanceId"])
    return client


@pytest.fixture(scope="module")
def players() -> Generator[dict[str, TestClient], None, None]:
    clients = {
        "small": _player_with_history(SMALL_HISTORY_PACKS),
        "large": _player_with_history(LARGE_HISTORY_PACKS),
    }
    try:
        yield clients
    finally:
        for client in clients.values():
            client.__exit__(None, None, None)


@pytest.mark.parametrize("path", sorted(READ_QUERY_BUDGETS))
def test_read_endpoint_budget(path, players, query_counter):
    measured = _warm_median(query_counter, lambda: players["large"].get(path))
    budget = READ_QUERY_BUDGETS[path]
    assert measured.queries <= budget, f"{path} ran {measured.queries} queries (budget {budget})"
    assert measured.elapsed_ms <= READ_LATENCY_BUDGET_MS, (
        f"{path} median {measured.elapsed_ms:.1f} ms (budget {READ_LATENCY_BUDGET_MS:.0f} ms)"
    )


@pytest.mark.parametrize("path", HISTORY_SCALED_PATHS)
def test_list_queries_do_not_scale_with_history(path, players, query_counter):
    small = _measure(query_counter, lambda: players["small"].get(path))
    large = _measure(query_counter, lambda: players["large"].get(path))
    assert large.queries == small.queries, (
        f"{path}: {small.queries} queries with {SMALL_HISTORY_PACKS} pack(s) vs "
        f"{large.queries} with {LARGE_HISTORY_PACKS} — likely N+1"
    )


def test_creator_board_budget_and_no_n_plus_one(players, query_counter):
    client = players["large"]
    small_id = _create_creator(SMALL_CREATOR_CARDS)
    large_id = _create_creator(LARGE_CREATOR_CARDS)

    small = _warm_median(query_counter, lambda: client.get(f"/api/me/creators/{small_id}/board"))
    large = _warm_median(query_counter, lambda: client.get(f"/api/me/creators/{large_id}/board"))

    assert large.queries <= BOARD_QUERY_BUDGET, f"board ran {large.queries} queries (budget {BOARD_QUERY_BUDGET})"
    assert large.queries == small.queries, (
        f"board: {small.queries} queries for {SMALL_CREATOR_CARDS} cards vs "
        f"{large.queries} for {LARGE_CREATOR_CARDS} — likely N+1"
    )
    assert large.elapsed_ms <= READ_LATENCY_BUDGET_MS, f"board median {large.elapsed_ms:.1f} ms"


def test_pack_purchase_open_reveal_budget(players, query_counter):
    client = players["small"]

    bought = _measure(query_counter, lambda: _buy_pack(client))
    instance_id = bought.response.json()["instances"][0]["instanceId"]
    opened = _measure(query_counter, lambda: client.post(f"/api/me/packs/{instance_id}/open"))
    opening_id = opened.response.json()["openingId"]
    card_id = opened.response.json()["session"]["cards"][0]["id"]
    revealed = _measure(
        query_counter, lambda: client.post(f"/api/me/openings/{opening_id}/cards/{card_id}/reveal")
    )

    for label, measured, budget in (
        ("pack purchase", bought, PACK_PURCHASE_QUERY_BUDGET),
        ("pack open", opened, PACK_OPEN_QUERY_BUDGET),
        ("card reveal", revealed, CARD_REVEAL_QUERY_BUDGET),
    ):
        assert measured.queries <= budget, f"{label} ran {measured.queries} queries (budget {budget})"
        assert measured.elapsed_ms <= WRITE_LATENCY_BUDGET_MS, f"{label} took {measured.elapsed_ms:.1f} ms"


def test_card_play_budget(players, query_counter):
    client = players["small"]
    creator_id = _create_creator(SMALL_CREATOR_CARDS)
    body = {"cardKind": "motion", "cardId": f"{creator_id}_card_0"}

    first = _measure(query_counter, lambda: client.post("/api/me/cards/play", json=body))
    replay = _measure(query_counter, lambda: client.post("/api/me/cards/play", json=body))

    for label, measured in (("first play", first), ("replay", replay)):
        assert measured.queries <= CARD_PLAY_QUERY_BUDGET, (
            f"{label} ran {measured.queries} queries (budget {CARD_PLAY_QUERY_BUDGET})"
        )
        assert measured.elapsed_ms <= WRITE_LATENCY_BUDGET_MS, f"{label} took {measured.elapsed_ms:.1f} ms"


@pytest.mark.parametrize("path", ["/api/cards", "/api/models", "/api/themes"])
def test_catalog_latency_budget(path, players, query_counter):
    measured = _warm_median(query_counter, lambda: players["small"].get(path))
    assert measured.elapsed_ms <= CATALOG_LATENCY_BUDGET_MS, (
        f"{path} median {measured.elapsed_ms:.1f} ms (budget {CATALOG_LATENCY_BUDGET_MS:.0f} ms)"
    )
