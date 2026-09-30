# Sugar Scratchie

Scratch-card game where players scratch a video-attached garment layer to reveal
the clip underneath. Scratch marks live in garment-local (mesh UV) coordinates,
so holes follow the moving body instead of the 2D silhouette.

## What's in this repo

| Part | Where | Dev URL |
| --- | --- | --- |
| API (FastAPI + Postgres) | `backend/` | `http://127.0.0.1:8090` (`/docs` for OpenAPI) |
| Operator app + media host (Vite + React) | `src/`, `public/` | `https://localhost:5080` |
| Player app | `frontend-new/` — **separate git repo** ([sugar-scratch-frontend](https://github.com/mjprod/sugar-scratch-frontend)) | `https://localhost:5173` |
| Android smoke client | `android/` — see [`android/README.md`](android/README.md) | — |
| Offline mesh tracking + AI media scripts | `scripts/` | — |

The root Vite server does two jobs: it hosts the operator dashboard and serves
card media (`/cards`, `/mesh`, `/models`, `/themes`, `/lotties`, …) from
`public/`. The player app proxies those media paths and `/api` to it and the API.

## Quick start

```bash
./scripts/manage.sh setup      # .venv (backend + mesh-tracking deps) + frontend-new npm install
./scripts/manage.sh reset-db   # Postgres in Docker on :5433, migrate, seed
./scripts/manage.sh start      # API :8090 + operator/media :5080 + player :5173
```

`./scripts/manage.sh help` lists the other commands (`status`, `stop`, `migrate`, …).
Copy `.env.example` to `.env` first and fill in the keys you need.

Running pieces by hand:

```bash
npm install
npm run dev:api          # FastAPI on :8090
npm run dev              # operator app + media on :5080
npm run dev:all          # both of the above
npm --prefix frontend-new run dev   # player app on :5173
```

`backend/requirements.txt` is enough for the API alone. The Video Flow mesh step
runs tracking inside the uvicorn process, so a full install needs
`backend/requirements-ml.txt` (torch, BootsTAPIR deps, …).

## Operator dashboard

Open `https://localhost:5080/dashboard` and sign in at `/dashboard/login` with
`DASHBOARD_TOKEN` (default `dev-dashboard`). The login sets an httpOnly cookie;
don't bake the token into `VITE_*` variables — they ship in the JS bundle.

The dashboard manages models, themes, symbols, users and cards, and runs the
content pipelines:

- [Video Flow](docs/video-flow.md) — one still photo → background + foreground clips → tracked mesh → card
- [Image dress flow](docs/image-dress-flow.md) and [Grok dress edit](docs/grok-dress-edit.md)
- [Mesh generation](docs/generate-mesh.md)

## Tests

```bash
npm run build      # tsc + vite build of the operator app
npm run test:api   # pytest against TEST_DATABASE_URL
npm run test       # both
```

CI (`.github/workflows/ci.yml`) runs the same on every PR with a Postgres
service. The player app has its own gate: `npm --prefix frontend-new run test`.

## Tracked mesh generation

Each card's garment is a deforming triangle lattice tracked across the
foreground clip. The generator seeds driver points on the performer, tracks
them with CoTracker3 and/or BootsTAPIR on Apple-Silicon MPS, and writes
`public/mesh/<id>.json`. It needs `ffmpeg`/`ffprobe` on PATH.

```bash
.venv/bin/pip install -r scripts/requirements-tracking.txt
npm run generate:mesh
```

See [`docs/generate-mesh.md`](docs/generate-mesh.md) and `CLAUDE.md` for the
environment knobs.

## Deploy

`deploy/` contains an EC2 bootstrap script, an nginx site and a systemd unit
for the API. It builds and serves the **operator app** from `dist/` and proxies
`/api` to uvicorn. The player app is built and deployed from its own repo.
