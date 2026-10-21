/**
 * Throttle GPU `readPixels` probes used while scratching.
 *
 * Policy (Phase 1 perf):
 * - Fabric alpha: at most one sample per animation frame (skip entirely when
 *   fairy dust is off — that path is the only consumer).
 * - Symbol scratch map: UV distance gate first. A sample may be reused later
 *   in the same frame only if it already meets the reveal threshold — a
 *   below-threshold read is not durable because later stamps in the same rAF
 *   can punch through the same UV.
 */

export type FabricAlphaCache = {
  frame: number;
  alpha: number;
};

export type SymbolScratchProbeCache = {
  frame: number;
  /** Per-slot sample this frame; -1 = not sampled yet. */
  amounts: number[];
};

export function createFabricAlphaCache(): FabricAlphaCache {
  return { frame: -1, alpha: -1 };
}

export function createSymbolScratchProbeCache(
  slotCount: number,
): SymbolScratchProbeCache {
  return {
    frame: -1,
    amounts: Array.from({ length: slotCount }, () => -1),
  };
}

/** Fairy dust is the only consumer of fabric alpha; skip GPU when off. */
export function needsFabricAlphaSample(fairyDustEnabled: boolean): boolean {
  return fairyDustEnabled;
}

export function readCachedFabricAlpha(
  cache: FabricAlphaCache,
  frame: number,
): number | null {
  if (cache.frame === frame) return cache.alpha;
  return null;
}

export function writeCachedFabricAlpha(
  cache: FabricAlphaCache,
  frame: number,
  alpha: number,
): number {
  cache.frame = frame;
  cache.alpha = alpha;
  return alpha;
}

export function isSymbolNearStroke(
  strokeU: number,
  strokeV: number,
  symbolU: number,
  symbolV: number,
  radius: number,
): boolean {
  return Math.hypot(strokeU - symbolU, strokeV - symbolV) <= radius;
}

/**
 * Coalesced / densified strokes only finalize once. A symbol under an
 * intermediate stamp (or when the pointer ends off-mesh) must still count.
 */
export function isSymbolNearAnyStroke(
  strokes: ReadonlyArray<{ u: number; v: number }>,
  symbolU: number,
  symbolV: number,
  radius: number,
): boolean {
  for (let i = 0; i < strokes.length; i += 1) {
    const stroke = strokes[i];
    if (isSymbolNearStroke(stroke.u, stroke.v, symbolU, symbolV, radius)) {
      return true;
    }
  }
  return false;
}

/**
 * Cached amount for this slot/frame, or null if the caller should GPU-sample.
 * Entering a new frame clears all slot samples.
 *
 * `minReusableAmount` (typically the reveal threshold) keeps a failing probe
 * from blocking a later stamp in the same frame after more paint is applied.
 */
export function readCachedSymbolScratchAmount(
  cache: SymbolScratchProbeCache,
  frame: number,
  index: number,
  minReusableAmount = 0,
): number | null {
  if (cache.frame !== frame) {
    cache.frame = frame;
    cache.amounts.fill(-1);
  }
  const amount = cache.amounts[index] ?? -1;
  if (amount < 0) return null;
  if (amount < minReusableAmount) return null;
  return amount;
}

export function writeCachedSymbolScratchAmount(
  cache: SymbolScratchProbeCache,
  frame: number,
  index: number,
  amount: number,
): number {
  if (cache.frame !== frame) {
    cache.frame = frame;
    cache.amounts.fill(-1);
  }
  cache.amounts[index] = amount;
  return amount;
}
