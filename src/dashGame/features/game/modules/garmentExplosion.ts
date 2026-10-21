/**
 * Hunt-complete finale: when the last body symbol is found the remaining
 * clothes charge up, explode (WebGL shatter in `glRenderer.explodeForeground`)
 * and the reveal holds briefly before the result overlay. Pure timing/policy
 * so the components and the self-check share one source of truth.
 */

/** Clothes tremble + glow + camera push-in before the burst. */
export const FINALE_CHARGE_MS = 500;
/** Shard flight; keep in sync with `EXPLODE_LIFE_S` in glRenderer. */
export const FINALE_BURST_MS = 1100;
/** Linger on the revealed performer before the result overlay. */
export const FINALE_HOLD_MS = 600;
/** Reduced motion: no charge or shards, quick fade then result. */
export const FINALE_REDUCED_MOTION_MS = 400;

export type FinalePhase = "charge" | "burst" | "hold" | "done";

export type FinaleTimeline = {
  reducedMotion: boolean;
  /** Burst fires at this elapsed time (= end of charge). */
  burstAtMs: number;
  /** Shards are gone; hold starts. */
  burstEndMs: number;
  /** Resolve the game / show the result overlay. */
  resultAtMs: number;
};

export function finaleTimeline({
  reducedMotion,
}: {
  reducedMotion: boolean;
}): FinaleTimeline {
  if (reducedMotion) {
    return {
      reducedMotion: true,
      burstAtMs: 0,
      burstEndMs: 0,
      resultAtMs: FINALE_REDUCED_MOTION_MS,
    };
  }
  const burstAtMs = FINALE_CHARGE_MS;
  const burstEndMs = burstAtMs + FINALE_BURST_MS;
  return {
    reducedMotion: false,
    burstAtMs,
    burstEndMs,
    resultAtMs: burstEndMs + FINALE_HOLD_MS,
  };
}

export function finalePhaseAt(
  elapsedMs: number,
  timeline: FinaleTimeline,
): FinalePhase {
  if (elapsedMs < timeline.burstAtMs) return "charge";
  if (elapsedMs < timeline.burstEndMs) return "burst";
  if (elapsedMs < timeline.resultAtMs) return "hold";
  return "done";
}

/** Eased 0..1 build-up (slow start, fast finish) — 0 outside the charge. */
export function chargeAmount(
  elapsedMs: number,
  timeline: FinaleTimeline,
): number {
  if (timeline.burstAtMs <= 0 || elapsedMs >= timeline.burstAtMs) return 0;
  const t = Math.min(1, Math.max(0, elapsedMs / timeline.burstAtMs));
  return t * t;
}

/** The clothes layer stays drawn (trembling) only while charging. */
export function finaleHidesForeground(phase: FinalePhase): boolean {
  return phase !== "charge";
}

export function shouldExplodeGarment({
  useBodySymbols,
  found,
  total,
  alreadyStarted,
  packRevealBlocked,
}: {
  useBodySymbols: boolean;
  found: number;
  total: number;
  alreadyStarted: boolean;
  packRevealBlocked: boolean;
}): boolean {
  return (
    useBodySymbols &&
    total > 0 &&
    found >= total &&
    !alreadyStarted &&
    !packRevealBlocked
  );
}

/** Claim / resolve gate: an exploded garment counts as fully revealed. */
export function garmentRevealSatisfied({
  exploded,
  fullyRevealed,
}: {
  exploded: boolean;
  fullyRevealed: boolean;
}): boolean {
  return exploded || fullyRevealed;
}

type Point = { x: number; y: number };

/** Burst from the last found symbol; canvas center when none resolved. */
export function explosionOrigin(
  points: ReadonlyArray<Point | null | undefined>,
  fallback: Point,
): Point {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const p = points[i];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      return { x: p.x, y: p.y };
    }
  }
  return { x: fallback.x, y: fallback.y };
}
