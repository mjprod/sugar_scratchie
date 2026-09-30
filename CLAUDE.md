# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Sugar Scratchie is a scratch-card game: players scratch a video-attached garment layer to reveal the clip underneath. The core mechanic is that scratch marks are stored in **garment-local (mesh UV) coordinates**, so holes follow the moving body instead of noisy 2D silhouette edges.

The workspace has four parts:

- `backend/` — FastAPI + SQLAlchemy/Alembic on Postgres. Auth, wallet, packs, store, rewards, inbox, catalog CRUD and long-running media jobs (Grok/WaveSpeed generation, mesh tracking, Video Flow). Entry point `backend/app.py`, feature routers in `backend/routers/`, pipelines in `backend/services/`.
- `src/` + `public/` — the **operator app** (Vite + React 19 + Radix Themes) on `:5080`. It also serves card media from `public/` to the player app.
- `frontend-new/` — the **player app** (Vite + React 19 + Tailwind + React Router) on `:5173`. It is a **separate git repo** (`mjprod/sugar-scratch-frontend`) ignored by this one; commit its changes there. It has its own `README.md` and conventions.
- `android/` — Kotlin/Compose smoke client against the same API.

## Commands

```bash
./scripts/manage.sh setup | reset-db | start | status | stop   # full local stack
npm run dev:api     # uvicorn backend.app:app on :8090
npm run dev         # operator app + media on https://localhost:5080
npm run dev:all     # both
npm run build       # tsc then vite build (operator app)
npm run test:api    # pytest tests/ (needs TEST_DATABASE_URL)
npm run test        # build + test:api — what CI runs
```

There is no linter for the operator app. `npm run build` (strict `tsc`) plus `npm run test:api` is the correctness gate; run both after non-trivial edits. Postgres runs from `docker-compose.yml` on `:5433`.

## Operator app (`src/`)

`src/main.tsx` is a tiny pathname router (no React Router). `/dashboard/*` pages are wrapped in `OperatorGate`, which requires the operator cookie set by `/dashboard/login` (`DASHBOARD_TOKEN`). The backend enforces the same check in `backend/auth/operator.py` for catalog mutations, `/api/jobs/*` and `/api/users`. Never inject the token via Vite proxy or `VITE_*` env.

Main pages: `Dashboard.tsx` (jobs/logs), `ModelsPage.tsx`, `ThemesPage.tsx`, `SymbolsPage.tsx`, `UsersPage.tsx`, `videoFlow/` (image → card pipeline designer/runner), `pictureFlow/` (photo-scratch cards). `/` renders `ScratchPrototype.tsx`, the operator-side motion scratch player; `/game` and `/photo-scratch` are test players.

The root `vite.config.ts` includes the `mesh-json-index` plugin, which generates `public/mesh/index.json` on build and serves it live in dev. Don't hand-edit that file.

## Scratch engine

Shared by the operator app and (vendored) the player app:

- `src/meshGeometry.ts` — tracked-mesh schema and math. `parseTrackedMesh` validates `{ cols, rows, uv, frames: [{ t, verts, vis }] }` and returns null on mismatch. `sampleTrackedMesh` interpolates vertices at a video time. `trackedWorldToUv` inverts the deformed lattice (per-cell barycentric) to UV on pointer input. `sampleMeshUvToWorld` projects UV back to canvas space. A cell is scratchable only when `cellVisible` (all four corners visible).
- `src/glRenderer.ts` — `GarmentGLRenderer` (WebGL). It draws the bottom video, the foreground (optionally chroma-keyed), and a UV-space scratch mask. `paintScratch(u, v, radius)` writes into that mask, so holes stay glued to the fabric.

After editing either file, run `scripts/sync-player-scratch-shared.sh` to copy them into `frontend-new/src/features/game/scratch/`.

`CANVAS_WIDTH`/`CANVAS_HEIGHT` (390×672) are duplicated in `src/meshGeometry.ts`, `scripts/generate-mesh-tracking.py` and `backend/services/photo_canvas.py`. They must match.

## Mesh tracking (`scripts/generate-mesh-tracking.py`)

```bash
.venv/bin/pip install -r scripts/requirements-tracking.txt
npm run generate:mesh   # PYTORCH_ENABLE_MPS_FALLBACK=1 .venv/bin/python scripts/generate-mesh-tracking.py
```

This runs on Apple-Silicon Torch MPS and needs `ffmpeg`/`ffprobe`. The Video Flow mesh step imports the same module inside the API process (hence `backend/requirements-ml.txt`).

It seeds driver points on the performer in the most frontal frame (chroma-key silhouette minus the SegFormer head mask) and tracks them bidirectionally. It then applies smoothing and loop closure, and extends driver displacements into a full-canvas UV field.

Trackers (`TRACKER`): `cotracker` (default, CoTracker3 via `torch.hub`), `bootstapir` (torch port vendored in `scripts/vendor/tapnet_torch`, wrapped by `scripts/bootstapir_tracker.py`, checkpoint cached in `~/.cache/tapnet/`), or `blend` (per-point, per-frame most confident; best quality on hands/arms). `COMPARE_TRACKERS=1 DEBUG_OVERLAY=1` writes side-by-side overlays and a stats table, then exits.

Other knobs: `REF_IMAGE`, `FPS`, `GRID_COLS`/`GRID_ROWS`, `SMOOTH_METHOD` (`savgol`|`gaussian`), `SMOOTH_SIGMA`, `LOOP_CLOSE`, `PER_FRAME_MASK`, `HEAD_DILATE` (keep small so long hair doesn't delete the arm beneath), `FIELD_NEIGHBORS`, `FIELD_POWER`, `EXTRA_DRIVER_POINTS`/`EXTRA_DRIVER_MIN_DISTANCE`, `FULL_SCREEN_FIELD=0` (legacy performer-only mesh), and `DEBUG_OVERLAY=1` (writes `.tmp/track_overlay/trk*.png` for the field and `drv*.png` for the drivers).

## Conventions

- Per-frame mutable state in render loops (marks, hover, tracked sample) lives in `useRef`, not `useState`; React state is for UI and is throttled.
- Tunable numbers are named `const`s at the top of the file; adjust those rather than inlining literals.
- Pure geometry/render helpers go in `meshGeometry.ts` / `glRenderer.ts` or standalone helpers, not inside components.
- Backend schema changes need an Alembic migration in `backend/db/migrations/versions/`, and an API test in `tests/` when behavior changes.
