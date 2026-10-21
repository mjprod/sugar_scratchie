/**
 * Game canvas backing-store DPR (Phase 7 + Safari sharpness).
 *
 * Full devicePixelRatio (2–3) on phones balloons every WebGL FBO and was part of
 * the Safari "page" memory spike. Locking to 1 made the stage look soft on
 * retina Safari. Cap instead: 1.5 on coarse pointers, up to 2 on fine.
 */

export function resolveGameCanvasPixelRatio(opts: {
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
