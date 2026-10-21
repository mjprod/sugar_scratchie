/**
 * AutoScratch presentation order.
 * Paint + symbol finds stay on the scratch frames. Match flights and sparkle
 * coins wait until every symbol is found, then play on a later turn so they
 * don't share frames with the stamp loop.
 */

/** Beat after the last symbol before coins launch. Inside the finale charge. */
export const AUTO_SCRATCH_COIN_REVEAL_MS = 180;

export function shouldDeferAutoScratchCoins(opts: {
  autoEnabled: boolean;
  symbolsFound: number;
  symbolTotal: number;
  /** True from the moment the hunt completes until the delayed reveal runs. */
  revealPending: boolean;
}): boolean {
  if (opts.revealPending) return true;
  if (!opts.autoEnabled) return false;
  if (!(opts.symbolTotal > 0)) return false;
  return opts.symbolsFound < opts.symbolTotal;
}

/** Append this frame's finds. Earlier queued indices stay in order. */
export function queueDeferredMatchIndices(
  queued: readonly number[],
  newlyRevealed: readonly number[],
): number[] {
  if (newlyRevealed.length === 0) return queued.slice();
  const next = queued.slice();
  for (const index of newlyRevealed) next.push(index);
  return next;
}
