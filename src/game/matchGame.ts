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

export type SymbolTypeEntry = { src: string; label: string };

export const DEFAULT_SYMBOL_TYPES: SymbolTypeEntry[] = [
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

/** Live catalog used by the match game (mutated when index loads / admin saves). */
export const SYMBOL_TYPES: SymbolTypeEntry[] = DEFAULT_SYMBOL_TYPES.map((entry) => ({
  ...entry,
}));

type CatalogRow = {
  id?: string;
  file?: string;
  label?: string;
  src?: string;
  updated_at?: number;
};

function encodeLottiePath(file: string, updatedAt = 0): string {
  const encoded = encodeURIComponent(file);
  const base = `/lotties/${encoded}`;
  if (updatedAt > 0) return `${base}?v=${Math.floor(updatedAt)}`;
  return base;
}

function rowsToEntries(rows: CatalogRow[]): SymbolTypeEntry[] | null {
  if (!Array.isArray(rows) || rows.length < SYMBOL_TYPE_COUNT) return null;
  const byId = new Map<string, CatalogRow>();
  for (const row of rows) {
    if (row && typeof row.id === "string") byId.set(row.id, row);
  }
  const next: SymbolTypeEntry[] = [];
  for (let i = 0; i < SYMBOL_TYPE_COUNT; i += 1) {
    const id = String(i + 1).padStart(2, "0");
    const row = byId.get(id) ?? rows[i];
    if (!row) return null;
    const label =
      typeof row.label === "string" && row.label.trim()
        ? row.label.trim()
        : DEFAULT_SYMBOL_TYPES[i]!.label;
    const updatedAt =
      typeof row.updated_at === "number" && Number.isFinite(row.updated_at)
        ? row.updated_at
        : 0;
    let src =
      typeof row.src === "string" && row.src.trim()
        ? row.src.trim()
        : typeof row.file === "string" && row.file.trim()
          ? encodeLottiePath(row.file.trim(), updatedAt)
          : DEFAULT_SYMBOL_TYPES[i]!.src;
    if (updatedAt > 0 && !src.includes("?v=")) {
      src = `${src}${src.includes("?") ? "&" : "?"}v=${Math.floor(updatedAt)}`;
    }
    next.push({ src, label });
  }
  return next;
}

export function applySymbolCatalog(rows: CatalogRow[]): boolean {
  const next = rowsToEntries(rows);
  if (!next) return false;
  for (let i = 0; i < SYMBOL_TYPE_COUNT; i += 1) {
    SYMBOL_TYPES[i] = next[i]!;
  }
  return true;
}

let loadPromise: Promise<boolean> | null = null;

/** Fetch `/lotties/index.json` (or API) and update SYMBOL_TYPES. */
export async function loadSymbolTypes(): Promise<boolean> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      try {
        const response = await fetch("/lotties/index.json", { cache: "no-store" });
        if (response.ok) {
          const data = (await response.json()) as { symbols?: CatalogRow[] };
          if (applySymbolCatalog(Array.isArray(data.symbols) ? data.symbols : [])) {
            return true;
          }
        }
      } catch {
        // fall through to API
      }
      try {
        const response = await fetch("/api/symbols", { cache: "no-store" });
        if (!response.ok) return false;
        const data = (await response.json()) as { symbols?: CatalogRow[] };
        return applySymbolCatalog(Array.isArray(data.symbols) ? data.symbols : []);
      } catch {
        return false;
      }
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

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

/**
 * Which top-bar slots light up during the hunt: each revealed body symbol of
 * type T claims one still-dark top slot of type T (left-to-right).
 */
export function matchedTopSlots(
  top: number[],
  body: number[],
  bodyRevealed: readonly boolean[],
): boolean[] {
  const bodyCounts = new Array(SYMBOL_TYPE_COUNT).fill(0);
  const n = Math.min(body.length, bodyRevealed.length);
  for (let i = 0; i < n; i += 1) {
    if (!bodyRevealed[i]) continue;
    const id = body[i];
    if (id >= 0 && id < SYMBOL_TYPE_COUNT) bodyCounts[id] += 1;
  }
  const matched = Array.from({ length: TOP_SYMBOL_COUNT }, () => false);
  for (let i = 0; i < TOP_SYMBOL_COUNT; i += 1) {
    const id = top[i];
    if (id === undefined || id < 0 || id >= SYMBOL_TYPE_COUNT) continue;
    if (bodyCounts[id] > 0) {
      bodyCounts[id] -= 1;
      matched[i] = true;
    }
  }
  return matched;
}

/**
 * Sticky per-body-find hit flags: true when that reveal claimed a top slot.
 * Matches `playBodyFindSounds` order so icons never flip hit↔miss later.
 */
export function applyBodyFindHits(
  top: number[],
  body: number[],
  revealedBefore: readonly boolean[],
  newlyRevealed: readonly number[],
  previousHits: readonly boolean[],
): boolean[] {
  const hits = previousHits.slice();
  while (hits.length < body.length) hits.push(false);
  const revealed = revealedBefore.slice();
  for (const index of newlyRevealed) {
    if (index < 0 || index >= body.length) continue;
    const before = matchedTopSlots(top, body, revealed).filter(Boolean).length;
    revealed[index] = true;
    const after = matchedTopSlots(top, body, revealed).filter(Boolean).length;
    hits[index] = after > before;
  }
  return hits;
}

/** Next still-open top slot of this type (left-to-right), or -1. */
export function claimNextTopSlot(
  top: number[],
  typeId: number,
  alreadyClaimed: readonly boolean[],
): number {
  if (typeId < 0 || typeId >= SYMBOL_TYPE_COUNT) return -1;
  const n = Math.min(TOP_SYMBOL_COUNT, top.length);
  for (let i = 0; i < n; i += 1) {
    if (alreadyClaimed[i]) continue;
    if (top[i] === typeId) return i;
  }
  return -1;
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
