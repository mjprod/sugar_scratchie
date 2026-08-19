import { fetchCatalogMotionCards, fetchCatalogPhotoCards } from "../shared/catalog";
import { api } from "../shared/api";
import type { VideoFlowProject } from "../videoFlow/projects";
import { normalizeTheme } from "../videoFlow/schema";

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
    const data = await api<{ flows: VideoFlowProject[] }>("/api/video-flow");
    for (const flow of data.flows ?? []) {
      const theme = flow.draft?.theme?.trim();
      if (theme) map.set(flow.card_id, normalizeTheme(theme));
    }
  } catch {
    // Offline / no API — fall back to catalog theme_id or label inference.
  }
  return map;
}

export async function loadGameCatalog(): Promise<{
  motion: ThemedMotionCard[];
  photos: PhotoCard[];
}> {
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

  return { motion, photos };
}

/** Pick up to `count` motion cards, each with a distinct theme. */
export function dealUniqueThemeHand(
  pool: ThemedMotionCard[],
  count = GAME_HAND_SIZE,
): ThemedMotionCard[] {
  const byTheme = new Map<string, ThemedMotionCard[]>();
  for (const card of pool) {
    const key = themeKey(card.theme);
    const list = byTheme.get(key) ?? [];
    list.push(card);
    byTheme.set(key, list);
  }

  const themes = shuffleInPlace([...byTheme.keys()]);
  const picked: ThemedMotionCard[] = [];
  for (const theme of themes) {
    if (picked.length >= count) break;
    const options = byTheme.get(theme);
    if (!options || options.length === 0) continue;
    const card = options[Math.floor(Math.random() * options.length)]!;
    picked.push(card);
  }
  return picked;
}

/**
 * Randomly select `count` photocards.
 * Prefers photos whose theme matches the dealt motion themes, then fills from the rest.
 */
export function pickWonPhotocards(
  photos: PhotoCard[],
  count: number,
  preferredThemes: string[],
): PhotoCard[] {
  if (count <= 0 || photos.length === 0) return [];
  const preferredKeys = new Set(preferredThemes.map(themeKey));
  const preferred = shuffleInPlace(
    photos.filter((photo) => preferredKeys.has(themeKey(themeFromPhotoLabel(photo.label)))),
  );
  const rest = shuffleInPlace(
    photos.filter((photo) => !preferredKeys.has(themeKey(themeFromPhotoLabel(photo.label)))),
  );
  const pool = [...preferred, ...rest];
  const unique: PhotoCard[] = [];
  const seen = new Set<string>();
  for (const photo of pool) {
    if (unique.length >= count) break;
    if (seen.has(photo.id)) continue;
    seen.add(photo.id);
    unique.push(photo);
  }
  return unique;
}
