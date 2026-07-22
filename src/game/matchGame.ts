import { SYMBOL_POINT_COUNT } from "../meshGeometry";

export const TOP_SYMBOL_COUNT = 6;
export const BODY_SYMBOL_COUNT = SYMBOL_POINT_COUNT;
export const SYMBOL_TYPE_COUNT = 12;

/** Matches → prize units (photo scratches or diamonds). */
const PRIZE_BY_MATCHES: ReadonlyArray<number> = [0, 0, 0, 1, 2, 3, 5];

export type PrizeMode = "photo_scratches" | "diamonds";

export type MatchGameOutcome = {
  matches: number;
  prize: number;
  result: "win" | "lose";
};

export const SYMBOL_TYPES: { src: string; label: string }[] = [
  { src: "/lotties/01-Heart.lottie", label: "Heart" },
  { src: "/lotties/02-Lock.lottie", label: "Lock" },
  { src: "/lotties/03-GemDiamond.lottie", label: "Gem" },
  { src: "/lotties/04-Star.lottie", label: "Star" },
  { src: "/lotties/05-Diamond.lottie", label: "Diamond" },
  { src: "/lotties/06-Magnet.lottie", label: "Magnet" },
  { src: "/lotties/07-Crown.lottie", label: "Crown" },
  { src: "/lotties/08-Gold%20Coins.lottie", label: "Gold Coins" },
  { src: "/lotties/09-Key.lottie", label: "Key" },
  { src: "/lotties/10-Treasure%20Chest.lottie", label: "Treasure Chest" },
  { src: "/lotties/11-Diamond%20Cards.lottie", label: "Diamond Cards" },
  { src: "/lotties/12-WinnerTrophy.lottie", label: "Trophy" },
];

function randomSymbolIds(count: number): number[] {
  return Array.from({ length: count }, () =>
    Math.floor(Math.random() * SYMBOL_TYPE_COUNT),
  );
}

export function buildTopSymbols(): number[] {
  return randomSymbolIds(TOP_SYMBOL_COUNT);
}

export function buildBodySymbols(): number[] {
  return randomSymbolIds(BODY_SYMBOL_COUNT);
}

/** Pair-off: each top symbol consumes one matching body symbol (once). */
export function countMatches(top: number[], body: number[]): number {
  const bodyCounts = new Array(SYMBOL_TYPE_COUNT).fill(0);
  for (const id of body) {
    if (id >= 0 && id < SYMBOL_TYPE_COUNT) bodyCounts[id] += 1;
  }
  let matches = 0;
  for (const id of top) {
    if (id < 0 || id >= SYMBOL_TYPE_COUNT) continue;
    if (bodyCounts[id] > 0) {
      bodyCounts[id] -= 1;
      matches += 1;
    }
  }
  return matches;
}

export function prizeForMatches(matches: number): number {
  const clamped = Math.max(0, Math.min(TOP_SYMBOL_COUNT, Math.floor(matches)));
  return PRIZE_BY_MATCHES[clamped] ?? 0;
}

export function resolveMatchGame(
  top: number[],
  body: number[],
): MatchGameOutcome {
  const matches = countMatches(top, body);
  const prize = prizeForMatches(matches);
  return {
    matches,
    prize,
    result: prize > 0 ? "win" : "lose",
  };
}

export function prizeLabel(mode: PrizeMode, prize: number): string {
  if (prize <= 0) return "No win";
  if (mode === "diamonds") {
    return prize === 1 ? "You won 1 diamond" : `You won ${prize} diamonds`;
  }
  return prize === 1
    ? "You won 1 photo scratch"
    : `You won ${prize} photo scratches`;
}

export function matchResultDetail(outcome: MatchGameOutcome, mode: PrizeMode) {
  if (outcome.prize <= 0) {
    return `${outcome.matches} match${outcome.matches === 1 ? "" : "es"} — no prize.`;
  }
  return `${outcome.matches} match${outcome.matches === 1 ? "" : "es"} — ${prizeLabel(mode, outcome.prize)}.`;
}
