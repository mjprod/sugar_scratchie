/**
 * Pure policy for the motion-scratch BGM loop — which level the stage wants,
 * and the gain actually applied once the pause menu ducks it.
 *
 * Option 1 mix: quiet bed while the foil bar is centered, full level once the
 * bar has docked, fade out when the stage is no longer warm.
 */
import type { TopBarPhase } from "./TopSymbolBar";

export type MotionScratchBgmLevel = "off" | "bed" | "full" | "keep";

export type MotionScratchBgmPlan = {
  level: MotionScratchBgmLevel;
  /** Step up to full after this delay (docked: hold bed while the bar flies). */
  fullAfterMs?: number;
};

export function resolveMotionScratchBgmPlan(input: {
  warm: boolean;
  topBarPhase: TopBarPhase;
  skipToPlay: boolean;
  dockMs: number;
}): MotionScratchBgmPlan {
  if (!input.warm) return { level: "off" };
  if (input.skipToPlay) return { level: "bed" };
  if (input.topBarPhase === "center" || input.topBarPhase === "docked") {
    return { level: "bed" };
  }
  // showcase: leave the level alone until warm clears.
  return { level: "keep" };
}

/** Pause menu ducks to the bed level; never louder than what the stage asked. */
export function resolveMotionScratchBgmGain(
  desiredGain: number,
  ducked: boolean,
  bedGain: number,
): number {
  return ducked ? Math.min(desiredGain, bedGain) : desiredGain;
}
