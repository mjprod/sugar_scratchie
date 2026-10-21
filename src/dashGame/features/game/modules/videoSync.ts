/**
 * Dual-video sync policy (Phase 4 perf).
 * Prefer tolerating 1–2 frames of drift over seeking; seek storms at loop wrap
 * are the multi-hundred-ms hitch. Use shortest-path drift so a wrap does not
 * look like an 18s discontinuity, and never seek across a loop edge when the
 * lagging clip is about to wrap naturally.
 */

export const HARD_SEEK_DRIFT_S = 0.45;
/** ~2 frames @ 30fps — ignore smaller offsets instead of soft-seeking. */
export const SOFT_SEEK_DRIFT_S = 0.08;
export const SOFT_SEEK_CONFIRM_MS = 200;
/** Applies to soft and hard seeks — avoids loop-boundary seek storms. */
export const SEEK_COOLDOWN_MS = 2500;
/** Treat times within this of 0 / duration as "on the loop edge". */
export const LOOP_EDGE_S = 0.25;

export type VideoSyncState = {
  driftSince: number;
  lastSeekAt: number;
};

export type VideoSyncDecision =
  | { action: "none" }
  | { action: "seek"; reason: "hard" | "soft" };

export function createVideoSyncState(): VideoSyncState {
  return { driftSince: 0, lastSeekAt: 0 };
}

/** Shortest signed delta on a looping timeline (handles wrap without a huge jump). */
export function shortestMediaDrift(
  desired: number,
  actual: number,
  duration: number,
): number {
  let d = desired - actual;
  if (!(duration > 0) || !Number.isFinite(duration)) return d;
  d -= duration * Math.round(d / duration);
  return d;
}

/** One clip near start, the other near end — natural wrap will close the gap. */
export function isLoopEdgeDesync(
  desired: number,
  actual: number,
  duration: number,
  edgeS = LOOP_EDGE_S,
): boolean {
  if (!(duration > 0) || !Number.isFinite(duration)) return false;
  const nearStart = (t: number) => t <= edgeS;
  const nearEnd = (t: number) => t >= duration - edgeS;
  return (
    (nearStart(desired) && nearEnd(actual)) ||
    (nearEnd(desired) && nearStart(actual))
  );
}

export function decideVideoSync(opts: {
  drift: number;
  now: number;
  state: VideoSyncState;
  /** When set with duration, suppress seeks across a pending natural wrap. */
  desiredTime?: number;
  actualTime?: number;
  duration?: number;
  /** Phase 9: suppress soft seeks while the finger is down (hard still allowed). */
  isScratching?: boolean;
  hardDriftS?: number;
  softDriftS?: number;
  confirmMs?: number;
  cooldownMs?: number;
}): VideoSyncDecision {
  const hard = opts.hardDriftS ?? HARD_SEEK_DRIFT_S;
  const soft = opts.softDriftS ?? SOFT_SEEK_DRIFT_S;
  const confirmMs = opts.confirmMs ?? SOFT_SEEK_CONFIRM_MS;
  const cooldownMs = opts.cooldownMs ?? SEEK_COOLDOWN_MS;
  const { drift, now, state } = opts;
  const abs = Math.abs(drift);
  // lastSeekAt === 0 means never sought — do not treat epoch as "just sought".
  const cooling =
    state.lastSeekAt > 0 && now - state.lastSeekAt < cooldownMs;

  // Loop race: bottom already wrapped, FG still at the tail (or vice versa).
  // Seeking FG to ~0 stalls decode for ~1s; waiting ~edgeS lets it wrap itself.
  if (
    opts.duration != null &&
    opts.desiredTime != null &&
    opts.actualTime != null &&
    isLoopEdgeDesync(opts.desiredTime, opts.actualTime, opts.duration) &&
    abs < hard
  ) {
    state.driftSince = 0;
    return { action: "none" };
  }

  if (abs > hard) {
    if (cooling) {
      return { action: "none" };
    }
    state.driftSince = 0;
    state.lastSeekAt = now;
    return { action: "seek", reason: "hard" };
  }

  // Soft seeks while scratching hitch Safari mid-stroke; wait for pointer-up.
  if (opts.isScratching) {
    return { action: "none" };
  }

  if (abs > soft) {
    if (state.driftSince === 0) {
      state.driftSince = now;
      return { action: "none" };
    }
    if (now - state.driftSince >= confirmMs && !cooling) {
      state.driftSince = 0;
      state.lastSeekAt = now;
      return { action: "seek", reason: "soft" };
    }
    return { action: "none" };
  }

  state.driftSince = 0;
  return { action: "none" };
}
