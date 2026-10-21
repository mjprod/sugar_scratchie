/**
 * Cursor-FX celebrate + mobile defaults (Phase 5 perf / win-feel).
 * Each 10% band pops a burst that grows as the card nears done, then a short
 * coin trail follows fresh scratching for the celebrate window. Rubbing over
 * already-scratched fabric never spawns coins.
 *
 * Trail emit mode: coins fall down (like TopSymbolBar foil flakes before the
 * hunt). Milestone bursts pop up and out first, then gravity drops them.
 */

export const CURSOR_FX_MILESTONE = 0.1;
/** How long spawn stays armed after a milestone (ms). */
export const CURSOR_FX_CELEBRATE_MS = 1100;
/** Longer arm on phones — finger often stays down past the 10% beat. */
export const CURSOR_FX_CELEBRATE_MS_COARSE = 2400;

/** Product default — match symbols-foil flake fall, not a fountain. */
export type CursorFxEmitMode = "fountain" | "fall";
export const CURSOR_FX_EMIT_MODE: CursorFxEmitMode = "fall";

/** Per-frame velocity range for fall-mode coin trail (FairyDust units). */
export const CURSOR_FX_FALL_VELOCITY = { min: 1.1, max: 2.6 };
/** Stronger pull so fall reads like foil flakes, not a soft drift. */
export const CURSOR_FX_FALL_GRAVITY = 0.22;

/**
 * Desktop draws coins at this fraction of the saved particle size. The desktop
 * stage is a phone-sized frame on a big screen, so full-size coins swamp it;
 * applied at render so saved settings / phone sizes stay untouched.
 */
export const CURSOR_FX_DESKTOP_SIZE_MUL = 0.55;

export type CursorFxDeviceProfile = {
  fairyDust: boolean;
  particleSize: number;
  /** Render-time multiplier on `particleSize` (1 on phones). */
  displaySizeMul: number;
  particleCount: number;
  /** Cap FairyDust overlay canvas DPR (1 on phone / coarse pointer). */
  maxOverlayDpr: number;
  /** True when `(pointer: coarse)` matched at profile resolve time. */
  coarsePointer: boolean;
};

export function progressMilestoneIndex(
  progress: number,
  step = CURSOR_FX_MILESTONE,
): number {
  if (!(progress > 0) || !(step > 0)) return 0;
  return Math.floor(progress / step + 1e-9);
}

/**
 * Every 10% band crossed from `prevProgress` to `nextProgress`
 * (1 = 10%, 2 = 20%, …). Empty when the jump stays in the same band.
 *
 * AutoScratch / a coalesced swipe can span several bands in one finalize;
 * callers that award coins must walk this list or those milestones are lost.
 */
export function crossedProgressMilestones(
  prevProgress: number,
  nextProgress: number,
  step = CURSOR_FX_MILESTONE,
): number[] {
  const prev = progressMilestoneIndex(prevProgress, step);
  const next = progressMilestoneIndex(nextProgress, step);
  if (next <= prev || next <= 0) return [];
  const start = Math.max(prev + 1, 1);
  const bands: number[] = [];
  for (let band = start; band <= next; band += 1) {
    bands.push(band);
  }
  return bands;
}

/**
 * Highest milestone index crossed (1 = 10%, 2 = 20%, …), or null.
 * FX sizing only — coin awards must use `crossedProgressMilestones`.
 */
export function crossedProgressMilestone(
  prevProgress: number,
  nextProgress: number,
  step = CURSOR_FX_MILESTONE,
): number | null {
  const bands = crossedProgressMilestones(prevProgress, nextProgress, step);
  return bands.length > 0 ? bands[bands.length - 1] : null;
}

export function resolveCursorFxDeviceProfile(opts: {
  reducedMotion: boolean;
  coarsePointer: boolean;
  narrowViewport: boolean;
}): CursorFxDeviceProfile {
  if (opts.reducedMotion) {
    return {
      fairyDust: false,
      particleSize: 40,
      displaySizeMul: 1,
      particleCount: 2,
      maxOverlayDpr: 1,
      coarsePointer: opts.coarsePointer,
    };
  }
  const mobile = opts.coarsePointer || opts.narrowViewport;
  if (mobile) {
    return {
      fairyDust: true,
      // Minimal trail — phones struggle with Lottie particle draw calls.
      particleSize: 84,
      displaySizeMul: 1,
      particleCount: 1,
      maxOverlayDpr: 1,
      coarsePointer: opts.coarsePointer,
    };
  }
  return {
    fairyDust: true,
    particleSize: 64,
    displaySizeMul: CURSOR_FX_DESKTOP_SIZE_MUL,
    particleCount: 5,
    maxOverlayDpr: 2,
    coarsePointer: opts.coarsePointer,
  };
}

/** Mild boost on celebrate; coarse stays tiny for frame budget. */
export function celebrateParticleBoost(
  baseCount: number,
  coarsePointer = false,
): number {
  if (coarsePointer) {
    return Math.min(2, Math.max(1, baseCount));
  }
  return Math.min(12, Math.max(baseCount, Math.round(baseCount * 1.6)));
}

export function celebrateDurationMs(coarsePointer: boolean): number {
  return coarsePointer ? CURSOR_FX_CELEBRATE_MS_COARSE : CURSOR_FX_CELEBRATE_MS;
}

/** Launch speed range for milestone pops (FairyDust units per frame). */
export const CURSOR_FX_BURST_VELOCITY = { min: 3.2, max: 6.8 };
/** Burst coins draw larger than trail coins so the pop reads as the reward. */
export const CURSOR_FX_BURST_SIZE_MUL = 1.3;
/**
 * Phones: the biggest coins are the milestone bursts. Cap that pop so the
 * max coin stays under the trail without rewriting the saved size.
 */
export const CURSOR_FX_MOBILE_BURST_SIZE_MUL = 0.81;

/**
 * Coins per milestone pop. Grows with the band crossed so later milestones
 * feel bigger; coarse stays well under the 250 particle cap even mid-trail.
 */
export function celebrateBurstCount(
  milestone: number,
  coarsePointer: boolean,
): number {
  const band = Math.min(10, Math.max(1, Math.floor(milestone) || 1));
  return coarsePointer ? 5 + band : 10 + band * 2;
}

/** Gap between pops when several 10% bands pay in one beat (AutoScratch). */
export const STACKED_COIN_BURST_STAGGER_MS = 140;

/**
 * One pop per crossed band. A single band stays on `celebrateBurstCount`.
 * Several bands (AutoScratch banking the whole card) each pop at 2× so the
 * finale is a coin shower, still capped so a phone stays under the particle pool.
 */
export function stackedCelebrateBurstCounts(
  milestones: readonly number[],
  coarsePointer: boolean,
): number[] {
  const stacked = milestones.length > 1;
  const cap = coarsePointer ? 22 : 36;
  return milestones.map((milestone) => {
    const base = celebrateBurstCount(milestone, coarsePointer);
    if (!stacked) return base;
    return Math.min(cap, base * 2);
  });
}

/** Upward fan (±70° off vertical) so a milestone pops like a win, not a spill. */
export function cursorFxBurstVelocity(
  velocity: { min: number; max: number } = CURSOR_FX_BURST_VELOCITY,
  random: () => number = Math.random,
): { vx: number; vy: number } {
  const span = Math.max(0, velocity.max - velocity.min);
  const speed = velocity.min + random() * span;
  const angle = (random() - 0.5) * Math.PI * 0.78;
  return { vx: Math.sin(angle) * speed, vy: -Math.cos(angle) * speed };
}

/**
 * Initial particle velocity. `fall` mirrors TopSymbolBar foil flakes:
 * small side scatter + always-positive (downward) vy; gravity finishes the arc.
 */
export function cursorFxSpawnVelocity(
  mode: CursorFxEmitMode,
  velocity: { min: number; max: number },
  random: () => number = Math.random,
): { vx: number; vy: number } {
  const span = Math.max(0, velocity.max - velocity.min);
  const speed = velocity.min + random() * span;
  if (mode === "fall") {
    const angle = (random() - 0.5) * Math.PI * 0.9;
    return {
      vx: Math.sin(angle) * speed * 0.45,
      vy: speed * (0.85 + random() * 0.55),
    };
  }
  return {
    vx: (random() < 0.5 ? -1 : 1) * speed,
    vy: -(random() * Math.max(velocity.max, 0)),
  };
}
