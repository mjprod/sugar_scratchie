/**
 * Manual / auto scratch stamp budgets (Phase 9).
 * Coarse pointers (phones / Safari) densify fewer stamps per rAF so
 * paintScratch + trackedWorldToUv + FG FBO rebuild stay bounded.
 */
import { CANVAS_HEIGHT } from "../scratch/meshGeometry";

/** Shared manual scratch radius in UV space, kept in sync with ScratchPrototype so budget and stamping behavior stay aligned. */
export const STAMP_SCRATCH_RADIUS_UV = 0.03;

export type ManualScratchBudget = {
  maxPoints: number;
  /** Canvas-space max step between densified stamps. */
  pathStep: number;
};

export type AutoScratchBudget = {
  maxPerFrame: number;
  fillBatch: number;
};

export function resolveManualScratchBudget(opts: {
  coarsePointer: boolean;
}): ManualScratchBudget {
  if (opts.coarsePointer) {
    return {
      maxPoints: 12,
      pathStep: STAMP_SCRATCH_RADIUS_UV * 1.1 * CANVAS_HEIGHT,
    };
  }
  return {
    maxPoints: 40,
    pathStep: STAMP_SCRATCH_RADIUS_UV * 0.65 * CANVAS_HEIGHT,
  };
}

export function resolveAutoScratchBudget(opts: {
  coarsePointer: boolean;
}): AutoScratchBudget {
  if (opts.coarsePointer) {
    return { maxPerFrame: 12, fillBatch: 16 };
  }
  return { maxPerFrame: 32, fillBatch: 36 };
}
