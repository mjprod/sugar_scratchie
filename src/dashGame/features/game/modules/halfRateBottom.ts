/**
 * Bottom-video upload policy (Phase 3 / 8).
 *
 * Full-rate always looked best at idle. On coarse pointers (phones / Safari),
 * drop to every-other bottom frame only while the finger is down — that's when
 * GPU upload + scratch work compete. After claim (FG hidden) always full-rate.
 */
export function shouldHalfRateBottomUploads(opts: {
  hideForeground: boolean;
  isScratching: boolean;
  coarsePointer: boolean;
}): boolean {
  if (opts.hideForeground) return false;
  return opts.coarsePointer && opts.isScratching;
}
