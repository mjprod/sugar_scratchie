#!/usr/bin/env python3
"""Concurrent load test for the player API.

  npm run perf:api
  .venv/bin/python scripts/perf-api-load.py --users 50 --duration 60
  PERF_API=http://127.0.0.1:8090 .venv/bin/python scripts/perf-api-load.py

Each virtual user registers, claims the welcome pack and buys diamonds (the
setup phase, reported separately because argon2 hashing dominates it), then
loops a weighted mix of the screens the player app loads plus pack
purchase → open → reveal, card plays and game-session saves. A screen fires
its requests concurrently, like the app does.

Reports per-endpoint and per-screen p50/p95/p99 and req/s, writes
`.tmp/perf/api-load.json`, and exits 1 when the error rate or a p95 budget is
breached. Perf users are deleted afterwards via the operator API when
DASHBOARD_TOKEN is available (env or root `.env`); pass --keep-users to skip.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import random
import statistics
import sys
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import httpx

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_API = "http://127.0.0.1:8090"
DEFAULT_OUT = ROOT / ".tmp" / "perf" / "api-load.json"
DEFAULT_USERS = 20
DEFAULT_DURATION_S = 30.0
DEFAULT_RAMP_S = 5.0
DEFAULT_THINK_MS = 300.0
DEFAULT_P95_BUDGET_MS = 300.0
DEFAULT_SCREEN_P95_BUDGET_MS = 500.0
DEFAULT_MAX_ERROR_RATE = 0.01
REQUEST_TIMEOUT_S = 30.0
SETUP_CONCURRENCY = 8
PERF_PASSWORD = "perf-load-password"
DIAMOND_PRODUCT_ID = "d2500"
LOCAL_HOSTS = {"127.0.0.1", "localhost", "0.0.0.0", "::1"}

# Relative frequency of each action in the steady-state loop.
ACTION_WEIGHTS: dict[str, int] = {
    "home": 20,
    "store": 8,
    "collection": 14,
    "creator": 14,
    "profile": 6,
    "inbox": 6,
    "rewards": 6,
    "catalog": 6,
    "buy_open_pack": 6,
    "play_card": 8,
    "save_game_session": 6,
}

SCREENS: dict[str, tuple[str, ...]] = {
    "home": ("/api/auth/session", "/api/packs", "/api/me/wallet", "/api/me/packs"),
    "store": ("/api/store/products", "/api/me/wallet"),
    "collection": ("/api/me/collection", "/api/me/packs", "/api/me/cards/played"),
    "creator": ("/api/me/creators/{creator}/board", "/api/me/cards/played"),
    "profile": ("/api/me/profile", "/api/me/wallet/transactions"),
    "inbox": ("/api/inbox",),
    "rewards": ("/api/rewards/daily",),
    "catalog": ("/api/models", "/api/cards", "/api/collection"),
}


def percentile(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        return 0.0
    rank = math.ceil(p / 100 * len(sorted_values))
    return sorted_values[min(len(sorted_values) - 1, max(0, rank - 1))]


@dataclass
class Series:
    samples: list[float] = field(default_factory=list)
    server_ms: list[float] = field(default_factory=list)
    errors: int = 0
    statuses: dict[int, int] = field(default_factory=lambda: defaultdict(int))

    def summary(self, window_s: float) -> dict:
        ordered = sorted(self.samples)
        count = len(ordered)
        return {
            "count": count,
            "errors": self.errors,
            "errorRate": round(self.errors / count, 4) if count else 0.0,
            "rps": round(count / window_s, 2) if window_s > 0 else 0.0,
            "p50": round(percentile(ordered, 50), 1),
            "p95": round(percentile(ordered, 95), 1),
            "p99": round(percentile(ordered, 99), 1),
            "max": round(ordered[-1], 1) if ordered else 0.0,
            "serverP50": round(statistics.median(self.server_ms), 1) if self.server_ms else None,
            "statuses": dict(sorted(self.statuses.items())),
        }


class Recorder:
    def __init__(self) -> None:
        self.endpoints: dict[str, Series] = defaultdict(Series)
        self.screens: dict[str, Series] = defaultdict(Series)

    def endpoint(self, name: str, elapsed_ms: float, status: int, server_ms: float | None) -> None:
        series = self.endpoints[name]
        series.samples.append(elapsed_ms)
        series.statuses[status] += 1
        if server_ms is not None:
            series.server_ms.append(server_ms)
        if status == 0 or status >= 400:
            series.errors += 1

    def screen(self, name: str, elapsed_ms: float, ok: bool) -> None:
        series = self.screens[name]
        series.samples.append(elapsed_ms)
        series.statuses[200 if ok else 500] += 1
        if not ok:
            series.errors += 1

    def totals(self) -> tuple[int, int]:
        count = sum(len(s.samples) for s in self.endpoints.values())
        errors = sum(s.errors for s in self.endpoints.values())
        return count, errors


@dataclass
class Catalog:
    creator_id: str | None
    pack_id: str
    motion_card_ids: list[str]


class VirtualUser:
    def __init__(self, index: int, run_id: str, base: str, recorder: Recorder) -> None:
        self.index = index
        self.email = f"perf-{run_id}-{index}@example.com"
        self.user_id: str | None = None
        self.recorder = recorder
        self.client = httpx.AsyncClient(base_url=base, timeout=REQUEST_TIMEOUT_S)

    async def call(self, method: str, path: str, name: str | None = None, **kwargs) -> httpx.Response | None:
        label = f"{method} {name or path}"
        started = time.perf_counter()
        try:
            response = await self.client.request(method, path, **kwargs)
        except httpx.HTTPError:
            self.recorder.endpoint(label, (time.perf_counter() - started) * 1000, 0, None)
            return None
        elapsed_ms = (time.perf_counter() - started) * 1000
        server = response.headers.get("x-response-time-ms")
        self.recorder.endpoint(label, elapsed_ms, response.status_code, float(server) if server else None)
        return response

    async def setup(self) -> bool:
        registered = await self.call(
            "POST",
            "/api/auth/register",
            json={"email": self.email, "password": PERF_PASSWORD, "username": f"perf{uuid.uuid4().hex[:10]}"},
        )
        if registered is None or registered.status_code != 200:
            return False
        self.user_id = registered.json()["user"]["id"]
        await self.call("POST", "/api/me/welcome/claim")
        return await self.top_up()

    async def top_up(self) -> bool:
        purchase = await self.call("POST", "/api/store/purchases", json={"product_id": DIAMOND_PRODUCT_ID})
        if purchase is None or purchase.status_code != 200:
            return False
        purchase_id = purchase.json()["session"]["id"]
        verified = await self.call(
            "POST",
            f"/api/store/purchases/{purchase_id}/verify",
            name="/api/store/purchases/{id}/verify",
            json={"outcome": "completed"},
        )
        return verified is not None and verified.status_code == 200

    async def screen(self, name: str, catalog: Catalog) -> None:
        paths = SCREENS[name]
        if "{creator}" in "".join(paths) and not catalog.creator_id:
            return
        started = time.perf_counter()
        responses = await asyncio.gather(
            *(
                self.call("GET", path.format(creator=catalog.creator_id), name=path)
                for path in paths
            )
        )
        ok = all(r is not None and r.status_code < 400 for r in responses)
        self.recorder.screen(name, (time.perf_counter() - started) * 1000, ok)

    async def buy_open_pack(self, catalog: Catalog) -> None:
        started = time.perf_counter()
        ok = await self._buy_open_pack(catalog)
        self.recorder.screen("buy_open_pack", (time.perf_counter() - started) * 1000, ok)

    async def _buy_open_pack(self, catalog: Catalog) -> bool:
        bought = await self._buy_pack(catalog.pack_id)
        if bought is not None and bought.status_code == 400 and await self.top_up():
            bought = await self._buy_pack(catalog.pack_id)
        if bought is None or bought.status_code != 200:
            return False
        instance_id = bought.json()["instances"][0]["instanceId"]
        opened = await self.call("POST", f"/api/me/packs/{instance_id}/open", name="/api/me/packs/{id}/open")
        if opened is None or opened.status_code != 200:
            return False
        body = opened.json()
        for card in body["session"]["cards"]:
            revealed = await self.call(
                "POST",
                f"/api/me/openings/{body['openingId']}/cards/{card['id']}/reveal",
                name="/api/me/openings/{id}/cards/{card}/reveal",
            )
            if revealed is None or revealed.status_code != 200:
                return False
        return True

    async def _buy_pack(self, pack_id: str) -> httpx.Response | None:
        return await self.call(
            "POST",
            f"/api/packs/{pack_id}/purchase",
            name="/api/packs/{id}/purchase",
            json={"quantity": 1},
            headers={"Idempotency-Key": f"perf-{uuid.uuid4().hex}"},
        )

    async def play_card(self, catalog: Catalog) -> None:
        if not catalog.motion_card_ids:
            return
        body = {"cardKind": "motion", "cardId": random.choice(catalog.motion_card_ids)}
        played = await self.call("POST", "/api/me/cards/play", json=body)
        if played is not None and played.status_code == 400 and await self.top_up():
            await self.call("POST", "/api/me/cards/play", json=body)

    async def save_game_session(self, catalog: Catalog) -> None:
        await self.call(
            "PUT",
            "/api/me/game-session",
            json={
                "modelId": catalog.creator_id or "perf",
                "phase": "motion",
                "motionCardIds": catalog.motion_card_ids[:3],
                "themes": [],
                "completedMotionIds": [],
                "photoPrizeTotal": 0,
                "wonPhotoIds": [],
                "completedPhotoIds": [],
                "diamondTotal": 0,
                "walletCredited": False,
            },
        )

    async def run(self, catalog: Catalog, deadline: float, think_ms: float) -> None:
        actions = list(ACTION_WEIGHTS)
        weights = [ACTION_WEIGHTS[a] for a in actions]
        while time.monotonic() < deadline:
            action = random.choices(actions, weights)[0]
            if action in SCREENS:
                await self.screen(action, catalog)
            else:
                await getattr(self, action)(catalog)
            await asyncio.sleep(think_ms * random.uniform(0.5, 1.5) / 1000)

    async def close(self) -> None:
        await self.client.aclose()


async def discover_catalog(base: str) -> Catalog:
    async with httpx.AsyncClient(base_url=base, timeout=REQUEST_TIMEOUT_S) as client:
        models = (await client.get("/api/models")).json().get("models", [])
        packs = [p for p in (await client.get("/api/packs")).json().get("packs", []) if p.get("available", True)]
    if not packs:
        raise SystemExit("No available packs in /api/packs — run ./scripts/manage.sh reset-db to seed.")
    creator_id = models[0]["id"] if models else None
    pack = min(packs, key=lambda p: p.get("diamondCost") or 0)
    return Catalog(creator_id=creator_id, pack_id=pack["id"], motion_card_ids=[])


async def discover_board_cards(user: VirtualUser, catalog: Catalog) -> None:
    if not catalog.creator_id:
        return
    board = await user.client.get(f"/api/me/creators/{catalog.creator_id}/board")
    if board.status_code != 200:
        return
    body = board.json()
    cards = [card for theme in body.get("themes", []) for card in theme.get("motionCards", [])]
    catalog.motion_card_ids = [card["id"] for card in cards if not card.get("price")]


def read_dashboard_token() -> str:
    token = os.environ.get("DASHBOARD_TOKEN", "").strip()
    if token:
        return token
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            key, sep, value = line.strip().partition("=")
            if sep and key.strip() == "DASHBOARD_TOKEN":
                return value.strip().strip("\"'")
    return ""


async def delete_users(base: str, users: list[VirtualUser]) -> int:
    token = read_dashboard_token()
    ids = [u.user_id for u in users if u.user_id]
    if not token or not ids:
        return 0
    deleted = 0
    async with httpx.AsyncClient(base_url=base, timeout=REQUEST_TIMEOUT_S, headers={"x-dashboard-token": token}) as client:
        for user_id in ids:
            response = await client.delete(f"/api/users/{user_id}")
            deleted += response.status_code == 200
    return deleted


def print_table(title: str, rows: dict[str, dict]) -> None:
    print(f"\n{title}")
    print(f"  {'name':<52} {'count':>6} {'err':>4} {'rps':>7} {'p50':>7} {'p95':>7} {'p99':>7} {'max':>7} {'srv50':>6}")
    for name, s in sorted(rows.items(), key=lambda item: -item[1]["p95"]):
        server = f"{s['serverP50']:.0f}" if s.get("serverP50") is not None else "-"
        print(
            f"  {name[:52]:<52} {s['count']:>6} {s['errors']:>4} {s['rps']:>7.1f} "
            f"{s['p50']:>7.0f} {s['p95']:>7.0f} {s['p99']:>7.0f} {s['max']:>7.0f} {server:>6}"
        )


async def main(args: argparse.Namespace) -> int:
    base = args.base.rstrip("/")
    host = urlparse(base).hostname or ""
    if host not in LOCAL_HOSTS and not args.allow_remote:
        raise SystemExit(f"Refusing to load-test non-local API {base!r}; pass --allow-remote to override.")

    async with httpx.AsyncClient(base_url=base, timeout=5) as probe:
        try:
            live = await probe.get("/api/health/live")
        except httpx.HTTPError as exc:
            raise SystemExit(f"API not reachable at {base}: {exc}. Start it with `npm run dev:api`.") from exc
        if live.status_code != 200:
            raise SystemExit(f"{base}/api/health/live returned {live.status_code}")

    random.seed(args.seed)
    run_id = uuid.uuid4().hex[:8]
    catalog = await discover_catalog(base)
    setup_recorder = Recorder()
    load_recorder = Recorder()
    users = [VirtualUser(i, run_id, base, setup_recorder) for i in range(args.users)]

    print(f"Setting up {args.users} users against {base} (run {run_id})…")
    setup_started = time.perf_counter()
    gate = asyncio.Semaphore(SETUP_CONCURRENCY)

    async def guarded_setup(user: VirtualUser) -> bool:
        async with gate:
            return await user.setup()

    ready = await asyncio.gather(*(guarded_setup(u) for u in users))
    setup_s = time.perf_counter() - setup_started
    active = [u for u, ok in zip(users, ready) if ok]
    if not active:
        await asyncio.gather(*(u.close() for u in users))
        raise SystemExit("No virtual user finished setup; see errors above.")
    await discover_board_cards(active[0], catalog)
    for user in active:
        user.recorder = load_recorder

    print(
        f"Running {len(active)} users for {args.duration:.0f}s (ramp {args.ramp:.0f}s, think {args.think_ms:.0f}ms) — "
        f"creator={catalog.creator_id} pack={catalog.pack_id} cards={len(catalog.motion_card_ids)}"
    )
    load_started = time.perf_counter()
    deadline = time.monotonic() + args.ramp + args.duration

    async def staggered(user: VirtualUser, delay: float) -> None:
        await asyncio.sleep(delay)
        await user.run(catalog, deadline, args.think_ms)

    step = args.ramp / max(1, len(active))
    await asyncio.gather(*(staggered(u, i * step) for i, u in enumerate(active)))
    window_s = time.perf_counter() - load_started

    deleted = 0 if args.keep_users else await delete_users(base, users)
    await asyncio.gather(*(u.close() for u in users))

    endpoints = {name: s.summary(window_s) for name, s in load_recorder.endpoints.items()}
    screens = {name: s.summary(window_s) for name, s in load_recorder.screens.items()}
    setup = {name: s.summary(setup_s) for name, s in setup_recorder.endpoints.items()}
    count, errors = load_recorder.totals()
    error_rate = errors / count if count else 0.0

    print_table(f"Setup ({setup_s:.1f}s)", setup)
    print_table("Endpoints (ms)", endpoints)
    print_table("Screens (ms, concurrent requests)", screens)

    breaches = [
        f"{name} p95 {s['p95']:.0f}ms > {args.p95_budget_ms:.0f}ms"
        for name, s in endpoints.items()
        if s["p95"] > args.p95_budget_ms
    ] + [
        f"screen {name} p95 {s['p95']:.0f}ms > {args.screen_p95_budget_ms:.0f}ms"
        for name, s in screens.items()
        if s["p95"] > args.screen_p95_budget_ms
    ]
    if error_rate > args.max_error_rate:
        breaches.append(f"error rate {error_rate:.2%} > {args.max_error_rate:.2%}")

    print(
        f"\n{count} requests in {window_s:.1f}s = {count / window_s:.1f} req/s, "
        f"{errors} errors ({error_rate:.2%}), {len(active)}/{args.users} users"
    )
    if args.keep_users:
        print(f"Kept perf users (emails perf-{run_id}-*@example.com).")
    elif deleted:
        print(f"Deleted {deleted} perf users.")
    else:
        print(f"Perf users left in the DB (no DASHBOARD_TOKEN): perf-{run_id}-*@example.com")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {
                "base": base,
                "runId": run_id,
                "users": len(active),
                "durationS": round(window_s, 1),
                "thinkMs": args.think_ms,
                "requests": count,
                "errors": errors,
                "rps": round(count / window_s, 2),
                "budgets": {
                    "p95Ms": args.p95_budget_ms,
                    "screenP95Ms": args.screen_p95_budget_ms,
                    "maxErrorRate": args.max_error_rate,
                },
                "breaches": breaches,
                "setup": setup,
                "endpoints": endpoints,
                "screens": screens,
            },
            indent=2,
        )
    )
    print(f"Wrote {out}")

    if breaches:
        print("\nBudget breaches:\n  " + "\n  ".join(breaches))
        return 1
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default=os.environ.get("PERF_API", DEFAULT_API))
    parser.add_argument("--users", type=int, default=DEFAULT_USERS)
    parser.add_argument("--duration", type=float, default=DEFAULT_DURATION_S, help="seconds of steady load")
    parser.add_argument("--ramp", type=float, default=DEFAULT_RAMP_S, help="seconds to start all users")
    parser.add_argument("--think-ms", type=float, default=DEFAULT_THINK_MS, help="mean pause between actions")
    parser.add_argument("--p95-budget-ms", type=float, default=DEFAULT_P95_BUDGET_MS)
    parser.add_argument("--screen-p95-budget-ms", type=float, default=DEFAULT_SCREEN_P95_BUDGET_MS)
    parser.add_argument("--max-error-rate", type=float, default=DEFAULT_MAX_ERROR_RATE)
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--keep-users", action="store_true")
    parser.add_argument("--allow-remote", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    sys.exit(asyncio.run(main(parse_args())))
