/**
 * Pack-progress card-countdown Lottie play policy.
 *
 * Stage HUD unmounts the pill after the first scratch, then remounts it on the
 * next card. Any time the cards-left badge mounts (including card 1), the
 * countdown should autoplay once (`loop={false}` in PackProgress).
 */

/** playKey > 0 → autoplay on mount. current is unused; kept for call-site stability. */
export function initialCardCountdownPlayKey(_current: number): number {
  return 1;
}

export function shouldAutoplayCardCountdown(playKey: number): boolean {
  return playKey > 0;
}

/**
 * Idle mounts call stop()+pause to paint frame 0 (blank canvas otherwise).
 * Play mounts must not stop — that cancels DotLottie autoplay.
 */
export function shouldFreezeCardCountdownOnLoad(shouldPlay: boolean): boolean {
  return !shouldPlay;
}

/**
 * Once-per-instance claim for DotLottie load/play wiring.
 * Inline `dotLottieRefCallback`s change identity each render; without this,
 * re-invokes stack `load` listeners and can restart a finished one-shot.
 */
export function claimPackProgressLottieHook(state: {
  __packProgressHooked?: boolean;
}): boolean {
  if (state.__packProgressHooked) return false;
  state.__packProgressHooked = true;
  return true;
}
