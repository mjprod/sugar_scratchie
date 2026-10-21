/**
 * Fairy-dust spawn / fabric-probe policy (Phase 9).
 * Coins only trail inside the celebrate window after each 10% and only while
 * the finger is scratching; FairyDustCursor's `spawnGate` further limits them
 * to unscratched fabric. Coarse pointers still skip fabric readPixels
 * mid-scratch.
 */

export function shouldSpawnFairyDust(opts: {
  playWindow: boolean;
  celebrate: boolean;
  isScratching: boolean;
  cursorOnMesh: boolean;
  coarsePointer: boolean;
}): boolean {
  if (!opts.playWindow || !opts.celebrate || !opts.isScratching) return false;
  if (opts.coarsePointer) return true;
  return opts.cursorOnMesh;
}

/** Fabric readPixels only when fairy dust could use the sample this frame. */
export function shouldSampleFabricAlpha(opts: {
  fairyDust: boolean;
  coarsePointer: boolean;
  isScratching: boolean;
}): boolean {
  if (!opts.fairyDust) return false;
  if (opts.coarsePointer && opts.isScratching) return false;
  return true;
}

/**
 * Distance (px) from the last emitted trail coin before the next one emits.
 * Measured from that anchor — not per move event — so slow strokes still trail.
 */
export function fairyDustSpawnMinDistancePx(coarsePointer: boolean): number {
  return coarsePointer ? 30 : 14;
}

/** `dx`/`dy` are the offset from the last emitted coin (the trail anchor). */
export function shouldSpawnFairyDustForMove(
  dx: number,
  dy: number,
  minDistancePx: number,
): boolean {
  const min = Math.max(0, minDistancePx);
  return dx * dx + dy * dy >= min * min;
}
