/**
 * CPU-only "already scratched" grid in garment UV space.
 * The reveal-progress grid (~14×19) is too sparse to tell a fresh stamp from
 * rubbing over a cleared patch, and GPU probes (`readPixels`) are off the
 * stroke path for perf. Scratch audio and cursor FX gate on this instead.
 */

export const SCRATCH_COVERAGE_SIZE = 64;
/** Share of one stamp's cells that must be new for the stamp to count fresh. */
export const SCRATCH_FRESH_MIN_FRACTION = 0.2;

export type ScratchCoverage = {
  readonly size: number;
  readonly cells: Uint8Array;
  /** Cells marked at creation (off-garment); restored on reset. */
  readonly baseline: Uint8Array;
};

type CoverageMark = { u: number; v: number; radius: number };

export function createScratchCoverage(
  size = SCRATCH_COVERAGE_SIZE,
  garment?: ArrayLike<number> | null,
  cols = 0,
  rows = 0,
): ScratchCoverage {
  const baseline = new Uint8Array(size * size);
  if (garment && cols > 0 && rows > 0 && garment.length === cols * rows) {
    for (let y = 0; y < size; y += 1) {
      const row = Math.round(((y + 0.5) / size) * (rows - 1));
      for (let x = 0; x < size; x += 1) {
        const col = Math.round(((x + 0.5) / size) * (cols - 1));
        // Off-garment reads as already scratched — nothing there to remove.
        if (!garment[row * cols + col]) baseline[y * size + x] = 1;
      }
    }
  }
  return { size, cells: baseline.slice(), baseline };
}

export function resetScratchCoverage(cov: ScratchCoverage): void {
  cov.cells.set(cov.baseline);
}

/** Marks cells whose centre lies inside the stamp; returns how many were new. */
export function stampScratchCoverage(
  cov: ScratchCoverage,
  u: number,
  v: number,
  radius: number,
): number {
  const { size, cells } = cov;
  if (!(radius > 0)) return 0;
  const x0 = Math.max(0, Math.floor((u - radius) * size));
  const x1 = Math.min(size - 1, Math.ceil((u + radius) * size));
  const y0 = Math.max(0, Math.floor((v - radius) * size));
  const y1 = Math.min(size - 1, Math.ceil((v + radius) * size));
  const r2 = radius * radius;
  let fresh = 0;
  for (let y = y0; y <= y1; y += 1) {
    const dv = (y + 0.5) / size - v;
    const rowBase = y * size;
    for (let x = x0; x <= x1; x += 1) {
      const du = (x + 0.5) / size - u;
      if (du * du + dv * dv > r2) continue;
      const idx = rowBase + x;
      if (cells[idx]) continue;
      cells[idx] = 1;
      fresh += 1;
    }
  }
  return fresh;
}

/** True when `newCells` is a meaningful share of one stamp, not an edge graze. */
export function isFreshStamp(
  newCells: number,
  radius: number,
  size = SCRATCH_COVERAGE_SIZE,
): boolean {
  const stampCells = Math.PI * (radius * size) ** 2;
  return newCells >= Math.max(1, stampCells * SCRATCH_FRESH_MIN_FRACTION);
}

/**
 * Share of the area a moving stamp sweeps (2·radius × travel) that must be
 * newly cleared. A stroke on fresh fabric scores ~1; grazing a cleared lane
 * ~0.15; widening a cleared patch with half the stamp on new fabric ~0.5.
 */
export const SCRATCH_FRESH_SWEPT_FRACTION = 0.4;
/** UV travel (× radius) collected before re-deciding — smooths tiny slow-drag steps. */
export const SCRATCH_FRESH_WINDOW_RADII = 0.5;

/** Per-stroke freshness: new cells judged against the distance travelled. */
export type StrokeFreshness = {
  started: boolean;
  fresh: boolean;
  newCells: number;
  travel: number;
};

export function createStrokeFreshness(): StrokeFreshness {
  return { started: false, fresh: false, newCells: 0, travel: 0 };
}

export function resetStrokeFreshness(state: StrokeFreshness): void {
  state.started = false;
  state.fresh = false;
  state.newCells = 0;
  state.travel = 0;
}

/**
 * Feed one stamp: its newly covered cells and its UV distance from the
 * previous stamp in this stroke. Returns whether the stroke is on fresh fabric.
 */
export function noteStrokeStamp(
  state: StrokeFreshness,
  newCells: number,
  travelUv: number,
  radius: number,
  size = SCRATCH_COVERAGE_SIZE,
): boolean {
  if (!state.started) {
    state.started = true;
    state.fresh = isFreshStamp(newCells, radius, size);
    state.newCells = 0;
    state.travel = 0;
    return state.fresh;
  }
  state.newCells += newCells;
  state.travel += Math.max(0, travelUv);
  if (state.travel < radius * SCRATCH_FRESH_WINDOW_RADII) return state.fresh;
  const swept = 2 * radius * state.travel * size * size;
  state.fresh = state.newCells >= swept * SCRATCH_FRESH_SWEPT_FRACTION;
  state.newCells = 0;
  state.travel = 0;
  return state.fresh;
}

export function rebuildScratchCoverage(
  cov: ScratchCoverage,
  marks: Iterable<CoverageMark>,
): void {
  resetScratchCoverage(cov);
  for (const mark of marks) stampScratchCoverage(cov, mark.u, mark.v, mark.radius);
}
