#!/usr/bin/env bash
# Copy scratch engine modules from monorepo root into the player app.
# Run after editing src/meshGeometry.ts or src/glRenderer.ts in the operator repo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/frontend-new/src/features/game/scratch"

if [[ ! -d "$DEST" ]]; then
  echo "Player app not found at frontend-new/ — clone or symlink it first." >&2
  exit 1
fi

cp "$ROOT/src/meshGeometry.ts" "$DEST/meshGeometry.ts"
cp "$ROOT/src/glRenderer.ts" "$DEST/glRenderer.ts"
echo "Synced meshGeometry.ts + glRenderer.ts → frontend-new/src/features/game/scratch/"
