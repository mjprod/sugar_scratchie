/**
 * Top-symbol-bar foil / flake 2D canvas DPR (Phase 9).
 * Matches game canvas caps so foil does not allocate a full 3× stage buffer
 * on phones while WebGL is already running.
 */
export function resolveFoilCanvasPixelRatio(opts: {
  coarsePointer: boolean;
  devicePixelRatio: number;
}): number {
  const dpr =
    Number.isFinite(opts.devicePixelRatio) && opts.devicePixelRatio > 0
      ? opts.devicePixelRatio
      : 1;
  const cap = opts.coarsePointer ? 1.5 : 2;
  return Math.min(cap, Math.max(1, dpr));
}
