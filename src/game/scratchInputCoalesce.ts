/**
 * Coalesce high-frequency pointer/touch moves into one scratch apply per frame.
 * Safari iOS can emit hundreds of touchmove/pointermove events per second;
 * applying densified scratch on each one fuels GC and long event handlers.
 */

export type PendingScratchClient = {
  x: number;
  y: number;
};

export type ScratchInputCoalesce = {
  pending: PendingScratchClient | null;
};

export function createScratchInputCoalesce(): ScratchInputCoalesce {
  return { pending: null };
}

/** Store the latest client point; replaces any prior pending move. */
export function notePendingScratchMove(
  state: ScratchInputCoalesce,
  clientX: number,
  clientY: number,
): void {
  if (state.pending) {
    state.pending.x = clientX;
    state.pending.y = clientY;
    return;
  }
  state.pending = { x: clientX, y: clientY };
}

/** Take and clear the pending point, or null if none. */
export function takePendingScratchMove(
  state: ScratchInputCoalesce,
): PendingScratchClient | null {
  const pending = state.pending;
  state.pending = null;
  return pending;
}

export function clearPendingScratchMove(state: ScratchInputCoalesce): void {
  state.pending = null;
}
