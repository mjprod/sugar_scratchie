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

type CardsIndexResponse = {
  cards?: Array<{
    id: string;
    label: string;
    bottom: string;
    foreground: string;
    mesh: string;
    chroma_key?: boolean;
    model_id?: string;
    sort_order?: number;
  }>;
};

type PhotoScratchIndexResponse = {
  cards?: Array<{
    id: string;
    label: string;
    model_id?: string;
    background: string;
    bikini: string;
    clothes: string;
    mesh: string;
  }>;
};

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

function parseMotionCards(data: CardsIndexResponse): MotionCard[] {
  if (!Array.isArray(data.cards)) return [];
  const cards: MotionCard[] = [];
  for (const entry of data.cards) {
    if (
      typeof entry.id !== "string" ||
      typeof entry.label !== "string" ||
      typeof entry.bottom !== "string" ||
      typeof entry.foreground !== "string" ||
      typeof entry.mesh !== "string"
    ) {
      continue;
    }
    if (entry.id === "original") continue;
    cards.push({
      id: entry.id,
      label: entry.label,
      bottom: entry.bottom,
      foreground: entry.foreground,
      mesh: entry.mesh,
      chromaKey: entry.chroma_key === true,
      model_id: entry.model_id,
      sort_order: typeof entry.sort_order === "number" ? entry.sort_order : 0,
    });
  }
  return cards;
}

function parsePhotoCards(data: PhotoScratchIndexResponse): PhotoCard[] {
  if (!Array.isArray(data.cards)) return [];
  const cards: PhotoCard[] = [];
  for (const entry of data.cards) {
    if (
      typeof entry.id !== "string" ||
      typeof entry.label !== "string" ||
      typeof entry.background !== "string" ||
      typeof entry.bikini !== "string" ||
      typeof entry.clothes !== "string" ||
      typeof entry.mesh !== "string"
    ) {
      continue;
    }
    cards.push({
      id: entry.id,
      label: entry.label,
      model_id: entry.model_id,
      background: entry.background,
      bikini: entry.bikini,
      clothes: entry.clothes,
      mesh: entry.mesh,
    });
  }
  return cards;
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
    // Offline / no API — fall back to label inference.
  }
  return map;
}

export async function loadGameCatalog(): Promise<{
  motion: ThemedMotionCard[];
  photos: PhotoCard[];
}> {
  const [cardsRes, photosRes, themeMap] = await Promise.all([
    fetch("/cards/index.json", { cache: "no-store" }).then((r) =>
      r.ok ? (r.json() as Promise<CardsIndexResponse>) : { cards: [] },
    ),
    fetch("/photo-scratch/index.json", { cache: "no-store" }).then((r) =>
      r.ok ? (r.json() as Promise<PhotoScratchIndexResponse>) : { cards: [] },
    ),
    loadThemeMap(),
  ]);

  const motion = parseMotionCards(cardsRes)
    .map((card) => {
      const theme =
        themeMap.get(card.id) ??
        inferThemeFromLabel(card.label) ??
        normalizeTheme(card.label);
      return { ...card, theme };
    })
    .filter((card) => Boolean(card.theme.trim()));

  return {
    motion,
    photos: parsePhotoCards(photosRes),
  };
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
