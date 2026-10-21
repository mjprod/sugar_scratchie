/**
 * Coin roll when scratch progress crosses a 10% band (credited to wallet).
 * Picks a band at random, then an amount inside that band — each band maps
 * to a coins_game SFX length.
 *
 * Floor/ceil must stay in sync with backend `SCRATCH_COIN_MIN/MAX`
 * (`backend/routers/rewards.py`) — server ignores client amount and rolls itself.
 */

export type SparkleCoinBandId = "short" | "medium" | "long";

export type SparkleCoinBand = {
  id: SparkleCoinBandId;
  min: number;
  max: number;
  soundSrc: string;
};

export type SparkleCoinAward = {
  amount: number;
  band: SparkleCoinBandId;
  soundSrc: string;
};

export const SPARKLE_COIN_BANDS: readonly SparkleCoinBand[] = [
  {
    id: "short",
    min: 30,
    max: 60,
    soundSrc: "/coins_game/coins_sound_short.mp3",
  },
  {
    id: "medium",
    min: 61,
    max: 80,
    soundSrc: "/coins_game/coins_sound_medium.mp3",
  },
  {
    id: "long",
    min: 81,
    max: 100,
    soundSrc: "/coins_game/coins_sound_long.mp3",
  },
] as const;

export const SCRATCH_COIN_MIN = SPARKLE_COIN_BANDS[0].min;
export const SCRATCH_COIN_MAX =
  SPARKLE_COIN_BANDS[SPARKLE_COIN_BANDS.length - 1].max;

function rollInclusive(min: number, max: number, random: () => number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(random() * (hi - lo + 1));
}

/** Pick a band uniformly, then an integer amount in that band (inclusive). */
export function rollSparkleCoinAward(
  random: () => number = Math.random,
): SparkleCoinAward {
  const band =
    SPARKLE_COIN_BANDS[
      Math.min(
        SPARKLE_COIN_BANDS.length - 1,
        Math.floor(random() * SPARKLE_COIN_BANDS.length),
      )
    ];
  return {
    amount: rollInclusive(band.min, band.max, random),
    band: band.id,
    soundSrc: band.soundSrc,
  };
}

/** Amount-only helper for call sites that don't need the band/SFX. */
export function rollSparkleCoin(random: () => number = Math.random): number {
  return rollSparkleCoinAward(random).amount;
}

/** Hide bottom coin badge this long after the finger lifts. */
export const COIN_BADGE_IDLE_HIDE_MS = 3000;

/** Keep the badge up longer after a 10% award so the +N / count-up can read. */
export const COIN_BADGE_AWARD_HOLD_MS = 3800;
