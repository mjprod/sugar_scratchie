#!/usr/bin/env bash
# Sugar Scratchie stack manager — Postgres + API + media + frontend-new
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PYTHON="${ROOT}/.venv/bin/python"
ALEMBIC="${ROOT}/.venv/bin/alembic"
UVICORN="${ROOT}/.venv/bin/uvicorn"
API_URL="${API_URL:-http://127.0.0.1:8090}"
MEDIA_URL="${MEDIA_URL:-https://localhost:5080}"
APP_URL="${APP_URL:-https://localhost:5173}"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
cyan() { printf '\033[36m%s\033[0m\n' "$*"; }

usage() {
  cat <<EOF
Sugar Scratchie stack manager

Usage: ./scripts/manage.sh <command>

  setup      Install Python + frontend-new deps
  db-up      Start Postgres + pgAdmin (Docker)
  db-down    Stop Postgres + pgAdmin
  migrate    Run Alembic migrations
  seed       Seed store / packs / redeem codes
  reset-db   db-up + migrate + seed
  start      Start API + media (:5080) + frontend-new (:5173)
  stop       Stop API / media / frontend-new (not Postgres)
  status     Show ports, Docker, and /api/health
  logs       Tail docker postgres logs
  help       Show this help

Typical first run:
  ./scripts/manage.sh setup
  ./scripts/manage.sh reset-db
  ./scripts/manage.sh start

Then open: ${APP_URL}
EOF
}

need_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    red "Docker is not installed."
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    red "Docker daemon is not running. Start Docker Desktop and retry."
    exit 1
  fi
}

need_venv() {
  if [[ ! -x "$PYTHON" ]]; then
    red "Missing .venv. Create it, then: .venv/bin/pip install -r backend/requirements.txt"
    exit 1
  fi
}

cmd_setup() {
  need_venv
  cyan "Installing backend Python deps…"
  "$PYTHON" -m pip install -r backend/requirements.txt
  if [[ -d "${ROOT}/frontend-new" ]]; then
    cyan "Installing frontend-new deps…"
    (cd frontend-new && npm install)
  else
    cyan "frontend-new/ not found; skipping separate frontend install"
  fi
}

cmd_db_up() {
  need_docker
  cyan "Starting Postgres on :5433 and pgAdmin on :5050…"
  docker compose up -d postgres pgadmin
  # Wait until ready
  for _ in $(seq 1 30); do
    if docker compose exec -T postgres pg_isready -U sugar -d sugar >/dev/null 2>&1; then
      green "Postgres is ready"
      green "pgAdmin: http://127.0.0.1:5050  (admin@sugar.local / admin)"
      return 0
    fi
    sleep 1
  done
  red "Postgres did not become ready in time"
  exit 1
}

cmd_db_down() {
  need_docker
  docker compose down
  green "db-down: ok"
}

cmd_migrate() {
  need_venv
  cyan "Running migrations…"
  "$ALEMBIC" -c backend/alembic.ini upgrade head
  green "migrate: ok"
}

cmd_seed() {
  need_venv
  cyan "Seeding player DB…"
  "$PYTHON" -m backend.db.seed
  green "seed: ok"
}

cmd_reset_db() {
  cmd_db_up
  cmd_migrate
  cmd_seed
}

port_pids() {
  local port="$1"
  lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
}

kill_port() {
  local port="$1"
  local pids
  pids="$(port_pids "$port")"
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 0.4
    pids="$(port_pids "$port")"
    if [[ -n "$pids" ]]; then
      # shellcheck disable=SC2086
      kill -9 $pids 2>/dev/null || true
    fi
  fi
}

cmd_stop() {
  cyan "Stopping API / media / app…"
  kill_port 8090
  kill_port 5080
  kill_port 5173
  # concurrently / node children sometimes linger
  pkill -f "uvicorn backend.app:app" 2>/dev/null || true
  pkill -f "vite --host" 2>/dev/null || true
  green "stop: ok (Postgres left running — use db-down to stop it)"
}

cmd_start() {
  need_venv
  need_docker
  cmd_db_up
  cmd_migrate
  cmd_seed

  # Free ports if stale processes linger
  kill_port 8090
  kill_port 5080
  kill_port 5173

  cyan "Starting API (:8090), media (:5080), frontend-new (:5173)…"
  green "App:   ${APP_URL}"
  green "API:   ${API_URL}/api/health"
  green "Media: ${MEDIA_URL}"
  echo

  exec npx concurrently -k --kill-others-on-fail \
    -n api,media,app \
    -c blue,magenta,green \
    "${UVICORN} backend.app:app --host 127.0.0.1 --port 8090 --reload" \
    "npm run dev" \
    "npm --prefix frontend-new run dev"
}

cmd_status() {
  echo "—— Docker Postgres / pgAdmin ——"
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    if docker compose ps postgres 2>/dev/null | grep -q "running\|Up"; then
      green "postgres container is up"
      docker compose ps postgres pgadmin
    elif docker ps --format '{{.Names}}' 2>/dev/null | grep -q "sugar-scratchie-postgres"; then
      green "sugar-scratchie-postgres is running"
      docker ps --filter name=sugar-scratchie- --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    else
      red "Postgres container not running (try: ./scripts/manage.sh db-up)"
    fi
  else
    red "Docker daemon not reachable"
  fi
  echo
  echo "—— Ports ——"
  for port in 5433 5050 8090 5080 5173; do
    pids="$(port_pids "$port")"
    if [[ -n "$pids" ]]; then
      green ":${port} listening (pid ${pids})"
    else
      red ":${port} not listening"
    fi
  done
  echo
  echo "—— API health ——"
  if command -v curl >/dev/null 2>&1; then
    curl -sS --max-time 3 "${API_URL}/api/health" || red "API not reachable"
    echo
  fi
}

cmd_logs() {
  need_docker
  docker compose logs -f postgres
}

main() {
  local cmd="${1:-help}"
  case "$cmd" in
    setup) cmd_setup ;;
    db-up) cmd_db_up ;;
    db-down) cmd_db_down ;;
    migrate) cmd_migrate ;;
    seed) cmd_seed ;;
    reset-db) cmd_reset_db ;;
    start) cmd_start ;;
    stop) cmd_stop ;;
    status) cmd_status ;;
    logs) cmd_logs ;;
    help|-h|--help) usage ;;
    *)
      red "Unknown command: $cmd"
      usage
      exit 1
      ;;
  esac
}

main "$@"
