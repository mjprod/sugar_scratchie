import {
  fetchCatalogMotionCards,
  fetchCatalogPhotoCards,
} from "../shared/catalog";
import { api } from "../scratch/api";

const DEFAULT_THEME = "warm beach";

function normalizeTheme(theme: string | undefined | null): string {
  const stripped = (theme ?? "").trim();
  return stripped || DEFAULT_THEME;
}

type VideoFlowThemeDraft = {
  card_id: string;
  draft?: { theme?: string };
};

export const GAME_HAND_SIZE = 5;

export type MotionCard = {
  id: string;
  label: string;
  bottom: string;
  foreground: string;
  mesh: string;
  chromaKey: boolean;
  model_id?: string;
  theme_id?: string;
  sort_order?: number;
};

export type ThemedMotionCard = MotionCard & {
  theme: string;
};

export type PhotoCard = {
  id: string;
  label: string;
  model_id?: string;
  theme_id?: string;
  background: string;
  bikini: string;
  clothes: string;
  mesh: string;
};

export type DealtRound = {
  cards: ThemedMotionCard[];
};

/** Deal a unique-theme motion hand (no simulated outcomes — real play decides prizes). */
export function buildDealtRound(
  motionPool: ThemedMotionCard[],
  _photoPool?: PhotoCard[],
): DealtRound | null {
  const cards = dealUniqueThemeHand(motionPool, GAME_HAND_SIZE);
  if (cards.length === 0) return null;
  return { cards };
}

/** Fan reveal ids are `reveal-api-{cardId}`; strip that wrapper for catalog lookup. */
export function catalogMotionIdFromRevealId(cardId: string): string {
  const trimmed = cardId.trim();
  return trimmed.startsWith("reveal-api-")
    ? trimmed.slice("reveal-api-".length)
    : trimmed;
}

/** Local fan ids are `reveal-{role}-{slot}` (see revealCardId). */
const REVEAL_LOCAL_ID_RE =
  /^reveal-(policewoman|nurse|teacher|gym|firefighter)-(\d+)$/i;

const REVEAL_ROLE_THEME: Record<string, string> = {
  policewoman: "Police",
  nurse: "Nurse",
  teacher: "Teacher",
  gym: "Gym",
  firefighter: "Firegirl",
};

/** Theme hint for a local pack-fan id; null for API / catalog ids. */
export function themeHintFromRevealId(cardId: string): string | null {
  const trimmed = cardId.trim();
  if (trimmed.startsWith("reveal-api-")) return null;
  const match = REVEAL_LOCAL_ID_RE.exec(trimmed);
  if (!match) return null;
  const role = match[1]!.toLowerCase();
  return REVEAL_ROLE_THEME[role] ?? null;
}

function cardsForModel(
  motionPool: ThemedMotionCard[],
  modelId?: string | null,
): ThemedMotionCard[] {
  const scope = modelId?.trim().toLowerCase();
  if (!scope) return motionPool;
  return motionPool.filter(
    (card) => (card.model_id?.trim().toLowerCase() || "") === scope,
  );
}

function pickUnusedThemeMatch(
  motionPool: ThemedMotionCard[],
  themeHint: string,
  seen: Set<string>,
): ThemedMotionCard | null {
  const key = costumeThemeBucket(themeKey(themeHint));
  const matches = motionPool.filter(
    (card) =>
      !seen.has(card.id) &&
      costumeThemeBucket(themeKey(card.theme)) === key,
  );
  if (matches.length === 0) return null;
  return matches[Math.floor(Math.random() * matches.length)]!;
}

function fillMotionHand(
  hand: ThemedMotionCard[],
  motionPool: ThemedMotionCard[],
  seen: Set<string>,
): ThemedMotionCard[] {
  if (hand.length >= GAME_HAND_SIZE) return hand.slice(0, GAME_HAND_SIZE);
  const fill = buildDealtRound(
    motionPool.filter((card) => !seen.has(card.id)),
  );
  if (!fill) return hand;
  for (const card of fill.cards) {
    if (hand.length >= GAME_HAND_SIZE) break;
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    hand.push(card);
  }
  return hand;
}

/**
 * Resolve pack-fan card ids into a playable motion hand (fan order preserved).
 * Matches `reveal-api-{id}` to catalog ids, `reveal-{role}-{slot}` by theme,
 * theme-fills any gaps, and only then falls back to a dealt round.
 */
export function resolveMotionHandFromIds(
  cardIds: string[],
  motionPool: ThemedMotionCard[],
  options?: { modelId?: string },
): ThemedMotionCard[] {
  const scoped = cardsForModel(motionPool, options?.modelId);
  const byId = new Map(scoped.map((card) => [card.id, card]));
  const resolved: ThemedMotionCard[] = [];
  const seen = new Set<string>();

  for (const rawId of cardIds) {
    if (resolved.length >= GAME_HAND_SIZE) break;

    const catalogId = catalogMotionIdFromRevealId(rawId);
    if (catalogId && !seen.has(catalogId)) {
      const direct = byId.get(catalogId);
      if (direct) {
        seen.add(direct.id);
        resolved.push(direct);
        continue;
      }
    }

    const themeHint = themeHintFromRevealId(rawId);
    if (!themeHint) continue;
    const match = pickUnusedThemeMatch(scoped, themeHint, seen);
    if (!match) continue;
    seen.add(match.id);
    resolved.push(match);
  }

  if (resolved.length > 0) {
    return fillMotionHand(resolved, scoped, seen);
  }

  return buildDealtRound(scoped)?.cards ?? [];
}

const LABEL_THEME_HINTS: Array<{ theme: string; pattern: RegExp }> = [
  { theme: "Police", pattern: /\b(police|cop)\b/i },
  { theme: "Teacher", pattern: /\bteacher\b/i },
  { theme: "Nurse", pattern: /\bnurse\b/i },
  { theme: "Firegirl", pattern: /\bfire\s?girl\b/i },
  { theme: "Gym", pattern: /\bgym\b/i },
];

function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items;
}

export function themeKey(theme: string): string {
  return normalizeTheme(theme).toLowerCase();
}

export function inferThemeFromLabel(label: string): string | null {
  for (const hint of LABEL_THEME_HINTS) {
    if (hint.pattern.test(label)) return hint.theme;
  }
  return null;
}

export function themeFromPhotoLabel(label: string): string {
  const raw = label.split(/[–—-]/)[0]?.trim() ?? label.trim();
  return normalizeTheme(raw || "warm beach");
}

function themeForMotionCard(
  card: MotionCard,
  themeMap: Map<string, string>,
): string {
  if (card.theme_id) {
    return inferThemeFromLabel(card.theme_id) ?? normalizeTheme(card.theme_id);
  }
  return (
    themeMap.get(card.id) ??
    inferThemeFromLabel(card.label) ??
    normalizeTheme(card.label)
  );
}

async function loadThemeMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const data = await api<{ flows: VideoFlowThemeDraft[] }>("/api/video-flow");
    for (const flow of data.flows ?? []) {
      const theme = flow.draft?.theme?.trim();
      if (theme) map.set(flow.card_id, normalizeTheme(theme));
    }
  } catch {
    // Offline / no API — fall back to catalog theme_id or label inference.
  }
  return map;
}

type GameCatalog = {
  motion: ThemedMotionCard[];
  photos: PhotoCard[];
};

const GAME_CATALOG_TTL_MS = 60_000;
let gameCatalogCache: GameCatalog | null = null;
let gameCatalogCacheAt = 0;
let gameCatalogInflight: Promise<GameCatalog> | null = null;

export async function loadGameCatalog(): Promise<GameCatalog> {
  const now = Date.now();
  if (
    gameCatalogCache &&
    now - gameCatalogCacheAt < GAME_CATALOG_TTL_MS
  ) {
    return gameCatalogCache;
  }
  if (gameCatalogInflight) return gameCatalogInflight;

  gameCatalogInflight = (async () => {
    const [motionCards, photos, themeMap] = await Promise.all([
      fetchCatalogMotionCards(),
      fetchCatalogPhotoCards(),
      loadThemeMap(),
    ]);

    const motion = motionCards
      .filter((card) => card.id !== "original")
      .map((card) => ({
        id: card.id,
        label: card.label,
        bottom: card.bottom,
        foreground: card.foreground,
        mesh: card.mesh,
        chromaKey: card.chromaKey,
        model_id: card.model_id,
        theme_id: card.theme_id,
        sort_order: card.sort_order,
        theme: themeForMotionCard(card, themeMap),
      }))
      .filter((card) => Boolean(card.theme.trim()));

    const next = {
      motion,
      photos: photos.map((card) => ({
        id: card.id,
        label: card.label,
        model_id: card.model_id,
        theme_id: card.theme_id,
        background: card.background,
        bikini: card.bikini,
        clothes: card.clothes,
        mesh: card.mesh,
      })),
    };
    gameCatalogCache = next;
    gameCatalogCacheAt = Date.now();
    return next;
  })();

  try {
    return await gameCatalogInflight;
  } finally {
    gameCatalogInflight = null;
  }
}

/** Preferred costume themes for the pack / hub shuffler fan. */
const COSTUME_THEME_KEYS = [
  "police",
  "nurse",
  "teacher",
  "gym",
  "firegirl",
] as const;

/** Collapse aliases so Police/Cop and Firegirl/Firefighter stay one bucket. */
function costumeThemeBucket(key: string): string {
  if (key === "cop" || key === "policewoman") return "police";
  if (key === "firefighter" || key === "fire") return "firegirl";
  return key;
}

/** Pick up to `count` motion cards, each with a distinct theme (always random). */
export function dealUniqueThemeHand(
  pool: ThemedMotionCard[],
  count = GAME_HAND_SIZE,
): ThemedMotionCard[] {
  const byTheme = new Map<string, ThemedMotionCard[]>();
  for (const card of pool) {
    const key = costumeThemeBucket(themeKey(card.theme));
    const list = byTheme.get(key) ?? [];
    list.push(card);
    byTheme.set(key, list);
  }

  // Prefer the five costume themes, then fill from any leftover themes.
  const preferred = COSTUME_THEME_KEYS.filter((key) => byTheme.has(key));
  const preferredSet = new Set<string>(preferred);
  const rest = [...byTheme.keys()].filter((key) => !preferredSet.has(key));
  const themes = [
    ...shuffleInPlace([...preferred]),
    ...shuffleInPlace(rest),
  ];

  const picked: ThemedMotionCard[] = [];
  for (const theme of themes) {
    if (picked.length >= count) break;
    const options = byTheme.get(theme);
    if (!options || options.length === 0) continue;
    const card = options[Math.floor(Math.random() * options.length)]!;
    picked.push(card);
  }
  // Final fan order is always reshuffled so left→right isn't theme-stable.
  return shuffleInPlace(picked);
}

/**
 * Randomly select `count` photocards.
 * Prefers photos whose theme matches the dealt motion themes, then fills from the rest.
 */
export function pickWonPhotocards(
  photos: PhotoCard[],
  count: number,
  preferredThemes: string[],
  excludeIds: readonly string[] = [],
): PhotoCard[] {
  if (count <= 0 || photos.length === 0) return [];
  const excluded = new Set(excludeIds);
  const preferredKeys = new Set(preferredThemes.map(themeKey));
  const preferred = shuffleInPlace(
    photos.filter(
      (photo) =>
        !excluded.has(photo.id) &&
        preferredKeys.has(themeKey(themeFromPhotoLabel(photo.label))),
    ),
  );
  const rest = shuffleInPlace(
    photos.filter(
      (photo) =>
        !excluded.has(photo.id) &&
        !preferredKeys.has(themeKey(themeFromPhotoLabel(photo.label))),
    ),
  );
  const pool = [...preferred, ...rest];
  const unique: PhotoCard[] = [];
  const seen = new Set<string>();
  for (const photo of pool) {
    if (unique.length >= count) break;
    if (seen.has(photo.id) || excluded.has(photo.id)) continue;
    seen.add(photo.id);
    unique.push(photo);
  }
  return unique;
}
