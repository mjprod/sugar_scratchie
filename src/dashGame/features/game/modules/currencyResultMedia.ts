/**
 * Theme-video policy while a per-card result owns the screen:
 * symbol-bar showcase, YOU WON, or NO MATCH. Static backdrop — keep decoders quiet.
 */

/** Watchdog / play-nudge must not revive theme clips under the result. */
export function shouldReviveGameVideos(opts: {
  userPaused: boolean;
  introActive: boolean;
  cardTransitionActive: boolean;
  /** Showcase / currency win / no-match covering the stage. */
  resultOverlayActive: boolean;
}): boolean {
  if (opts.userPaused) return false;
  if (opts.introActive) return false;
  if (opts.cardTransitionActive) return false;
  if (opts.resultOverlayActive) return false;
  return true;
}

/** Card src attach is owned by the result-overlay effect while this is true. */
export function shouldDeferCardVideoAttach(opts: {
  introActive: boolean;
  resultOverlayActive: boolean;
}): boolean {
  return opts.introActive || opts.resultOverlayActive;
}

/** Stage picture must hide for showcase + final result overlays. */
export function shouldClearStagePicture(opts: {
  topBarPhase: string;
  motionOutcome: string | null | undefined;
}): boolean {
  if (opts.topBarPhase === "showcase") return true;
  return opts.motionOutcome === "diamond" || opts.motionOutcome === "no-match";
}
