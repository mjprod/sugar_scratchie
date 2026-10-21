/**
 * Scratch GL dispose normally keeps the WebGL2 context (loseContext: false) so
 * StrictMode / same-canvas card remounts don't leave Safari with a dead handle.
 *
 * When a memory transition is leaving the game domain for real, set this flag
 * so the next dispose may call loseContext: true once, then clear it.
 */

let shouldLoseGlContext = false;

/** Arm before navigate when leaving the game domain. */
export function armLoseGlContextOnUnmount(): void {
  shouldLoseGlContext = true;
}

/** Read + clear: one-shot for the unmount dispose path. */
export function consumeLoseGlContextOnUnmount(): boolean {
  const next = shouldLoseGlContext;
  shouldLoseGlContext = false;
  return next;
}

/** Non-consuming peek (tests / diagnostics). */
export function peekLoseGlContextOnUnmount(): boolean {
  return shouldLoseGlContext;
}

export function clearLoseGlContextOnUnmount(): void {
  shouldLoseGlContext = false;
}
