import { CREATOR_PHOTOS, HOLO_PACKS, PACK_PHOTOS } from "../lib/photos";
import { apiFetch } from "../lib/api";

export type UnopenedPack = {
  id: string;
  name: string;
  creator: string;
  creatorId: string;
  count: number;
  coverUrl: string;
  /** Product / catalog id used when resuming Open Pack. */
  catalogPackId?: string;
};

export type ContinueCollecting = {
  creatorId: string;
  creatorName: string;
  themeName: string;
  coverUrl: string;
  collected: number;
  total: number;
  motionDone: number;
  motionTotal: number;
  photoDone: number;
  photoTotal: number;
  hot?: boolean;
};

export type CreatorSummary = {
  id: string;
  name: string;
  avatarUrl: string;
  coverUrl: string;
  collected: number;
  total: number;
  pct: number;
};

export type ThemeCardData = {
  id: string;
  name: string;
  thumbnailUrl: string;
  collected: number;
  total: number;
  progressColor: "pink" | "green" | "orange";
  badge?: { type: "pack-count" | "alert"; value?: number };
};

export type PhotoCardSlot = {
  index: number;
  isUnlocked: boolean;
  thumbnailUrl?: string;
  readyToScratch?: boolean;
  rarity?: "Rare" | "Super Rare" | "Ultra Rare";
  isNew?: boolean;
  duplicates?: number;
};

export type MotionCardSlot = {
  index: number;
  label: string;
  isUnlocked: boolean;
  thumbnailUrl?: string;
  isNew?: boolean;
};

export type ThemeDetailData = {
  themeId: string;
  themeName: string;
  seriesLabel: string;
  packName: string;
  unopenedPacks: number;
  rewardReady?: boolean;
  photoCards: PhotoCardSlot[];
  motionCards: MotionCardSlot[];
};

export type CreatorPageData = {
  creator: {
    id: string;
    name: string;
    avatarUrl: string;
    coverUrl: string;
    stats: {
      collected: number;
      totalCollectible: number;
      motionCardsUnlocked: number;
      motionCardsTotal: number;
      photoCardsUnlocked: number;
      photoCardsTotal: number;
      themesCompleted: number;
      themeCount: number;
    };
  };
  themes: ThemeCardData[];
  themeDetails: Record<string, ThemeDetailData>;
};

export const COLLECTION_SNAPSHOT = {
  uniqueCards: 38,
  motionCards: 12,
  photoCards: 26,
  creators: 5,
};

export const UNOPENED_PACKS: UnopenedPack[] = [
  {
    id: "up1",
    name: "Summer Nights",
    creator: "Emily",
    creatorId: "emily",
    count: 2,
    coverUrl: PACK_PHOTOS.eb1,
  },
  {
    id: "up2",
    name: "Police Collection",
    creator: "Emily",
    creatorId: "emily",
    count: 1,
    coverUrl: PACK_PHOTOS.en1,
  },
  {
    id: "up3",
    name: "Cyber Nights",
    creator: "Emily",
    creatorId: "emily",
    count: 1,
    coverUrl: PACK_PHOTOS.aa1,
  },
];

export type ScratchReadyGroup = {
  id: string;
  creatorId: string;
  creatorName: string;
  collectionName: string;
  count: number;
  coverUrl: string;
  kind?: "motion" | "photo";
};

export const SCRATCH_READY_GROUPS: ScratchReadyGroup[] = [
  {
    id: "sc1",
    creatorId: "emily",
    creatorName: "Emily",
    collectionName: "Summer Nights",
    count: 3,
    coverUrl: PACK_PHOTOS.eb2,
  },
  {
    id: "sc2",
    creatorId: "sophia",
    creatorName: "Sophia",
    collectionName: "Silk Hour",
    count: 2,
    coverUrl: PACK_PHOTOS.nl2,
  },
];

export const PENDING_CONTENT = {
  unopenedPacks: UNOPENED_PACKS.reduce((sum, pack) => sum + pack.count, 0),
  scratchCards: SCRATCH_READY_GROUPS.reduce((sum, group) => sum + group.count, 0),
};

export const CONTINUE_COLLECTING: ContinueCollecting = {
  creatorId: "emily",
  creatorName: "Emily",
  themeName: "Summer Nights",
  coverUrl: CREATOR_PHOTOS.emma.portrait,
  collected: 9,
  total: 13,
  motionDone: 3,
  motionTotal: 3,
  photoDone: 6,
  photoTotal: 10,
  hot: true,
};

export type CreatorProgress = CreatorSummary & {
  themesStarted: number;
  themesTotal: number;
  cta: "continue" | "view" | "claim";
  /** Most recent / active theme label for this creator, when known. */
  themeName?: string;
};

export const CREATOR_SUMMARIES: CreatorSummary[] = [
  {
    id: "emily",
    name: "Emily",
    avatarUrl: CREATOR_PHOTOS.emma.avatar,
    coverUrl: CREATOR_PHOTOS.emma.portrait,
    collected: 34,
    total: 65,
    pct: 52,
  },
  {
    id: "sophia",
    name: "Sophia",
    avatarUrl: CREATOR_PHOTOS.nancy.avatar,
    coverUrl: CREATOR_PHOTOS.nancy.portrait,
    collected: 21,
    total: 52,
    pct: 40,
  },
  {
    id: "melisa",
    name: "Melissa",
    avatarUrl: CREATOR_PHOTOS.sam.avatar,
    coverUrl: CREATOR_PHOTOS.sam.portrait,
    collected: 18,
    total: 52,
    pct: 35,
  },
  {
    id: "lucy",
    name: "Lucy",
    avatarUrl: CREATOR_PHOTOS.alex.avatar,
    coverUrl: CREATOR_PHOTOS.alex.portrait,
    collected: 9,
    total: 39,
    pct: 23,
  },
];

export const CREATOR_PROGRESS: CreatorProgress[] = [
  {
    ...CREATOR_SUMMARIES[0],
    themesStarted: 3,
    themesTotal: 5,
    cta: "continue",
  },
  {
    ...CREATOR_SUMMARIES[1],
    themesStarted: 2,
    themesTotal: 5,
    cta: "continue",
  },
  {
    ...CREATOR_SUMMARIES[2],
    themesStarted: 2,
    themesTotal: 5,
    cta: "continue",
  },
  {
    ...CREATOR_SUMMARIES[3],
    themesStarted: 1,
    themesTotal: 4,
    cta: "continue",
  },
];

export type LibraryPreviewCard = {
  id: string;
  coverUrl: string;
  rarity: "Rare" | "Super Rare" | "Ultra Rare";
  isNew?: boolean;
  name: string;
};

export const LIBRARY_PREVIEW_CARDS: LibraryPreviewCard[] = [
  {
    id: "lc1",
    coverUrl: HOLO_PACKS.cyberRevealed,
    rarity: "Ultra Rare",
    isNew: true,
    name: "Neon Pulse",
  },
  {
    id: "lc2",
    coverUrl: HOLO_PACKS.kimonoRevealed,
    rarity: "Super Rare",
    isNew: true,
    name: "Silk Glance",
  },
  {
    id: "lc3",
    coverUrl: HOLO_PACKS.idolRevealed,
    rarity: "Rare",
    name: "Stage Light",
  },
  {
    id: "lc4",
    coverUrl: HOLO_PACKS.nurseHolo,
    rarity: "Super Rare",
    name: "Night Shift",
  },
  {
    id: "lc5",
    coverUrl: HOLO_PACKS.samuraiHolo,
    rarity: "Rare",
    name: "Blade Soft",
  },
  {
    id: "lc6",
    coverUrl: HOLO_PACKS.winterHolo,
    rarity: "Rare",
    name: "Frost Halo",
  },
];

export type CollectionLibraryFilter = "all" | "motion" | "photo";

function photoSlots(
  unlocked: number,
  opts: { scratchReady?: number; newCount?: number; dupeAt?: number } = {},
): PhotoCardSlot[] {
  const images = Object.values(PACK_PHOTOS);
  const scratchReady = opts.scratchReady ?? 0;
  const newCount = opts.newCount ?? 0;
  return Array.from({ length: 10 }, (_, i) => {
    const index = i + 1;
    const isUnlocked = index <= unlocked;
    const scratchOffset = unlocked - scratchReady;
    return {
      index,
      isUnlocked,
      // Locked slots still show a silhouette (never empty black).
      thumbnailUrl: images[i % images.length],
      readyToScratch: isUnlocked && scratchReady > 0 && index > scratchOffset,
      isNew: isUnlocked && newCount > 0 && index > unlocked - newCount,
      duplicates: opts.dupeAt === index ? 2 : undefined,
      rarity: index % 5 === 0 ? "Ultra Rare" : index % 3 === 0 ? "Super Rare" : "Rare",
    };
  });
}

function motionSlots(
  unlocked: number,
  total = 3,
  opts: { newCount?: number } = {},
): MotionCardSlot[] {
  const images = Object.values(PACK_PHOTOS);
  const newCount = opts.newCount ?? 0;
  return Array.from({ length: total }, (_, i) => {
    const index = i + 1;
    const isUnlocked = index <= unlocked;
    return {
      index,
      label: `M${String(index).padStart(2, "0")}`,
      isUnlocked,
      // Locked motion keeps a blurred silhouette under the lock.
      thumbnailUrl: images[(i + 2) % images.length],
      isNew: isUnlocked && newCount > 0 && index > unlocked - newCount,
    };
  });
}

export type StickyCtaMode =
  | "scratch"
  | "open-pack"
  | "buy-theme-pack"
  | "view"
  | "claim"
  | null;

export function scratchReadyCount(detail: ThemeDetailData | null | undefined): number {
  if (!detail) return 0;
  return detail.photoCards.filter((card) => card.isUnlocked && card.readyToScratch).length;
}

/** Strip pack/collection suffixes so "Police Pack" matches "police". */
export function normalizeThemeKey(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .replace(/(pack|collection|theme)$/g, "");
}

const THEME_ALIASES: Record<string, string> = {
  police: "police",
  cop: "police",
  policewoman: "police",
  policewomen: "police",
  summer: "summer",
  sumnights: "summer",
  summernights: "summer",
  cyber: "cyber",
  cybernights: "cyber",
  midnight: "midnight",
  midnightroom: "midnight",
  office: "office",
  officehours: "office",
  nurse: "nurse",
  teacher: "teacher",
  gym: "gym",
  firefighter: "fire",
  firegirl: "fire",
  fire: "fire",
};

export function canonicalThemeKey(value: string | null | undefined): string {
  const key = normalizeThemeKey(value);
  return THEME_ALIASES[key] ?? key;
}

/** Foil slot defaults when the API omits cardPackName (Juliana model packs). */
const JULIANA_FOIL_THEME_BY_SLOT: Record<string, string> = {
  "1": "Firegirl",
  "2": "Gym",
  "3": "Nurse",
  "4": "Police",
  "5": "Teacher",
};

/** Catalog / featured pack ids → theme display names. */
const CATALOG_THEME_LABELS: Record<string, string> = {
  cyber: "Cyber Nights",
  "cyber-holo": "Cyber Nights",
  "juliana-firegirl": "Firegirl",
  "juliana-police": "Police",
  "juliana-gym": "Gym",
  "juliana-nurse": "Nurse",
  "juliana-teacher": "Teacher",
};

const THEME_KEY_DISPLAY: Record<string, string> = {
  cyber: "Cyber Nights",
  summer: "Summer Nights",
  police: "Police",
  fire: "Firegirl",
  firegirl: "Firegirl",
  gym: "Gym",
  nurse: "Nurse",
  teacher: "Teacher",
  midnight: "Midnight Room",
  office: "Office Hours",
};

function isGenericPackLabel(value: string): boolean {
  return /^pack\s*(?:n[ºo°.]?\s*)?\d+$/i.test(value.trim());
}

function tidyThemeLabel(value: string): string {
  return value
    .trim()
    .replace(/\s+Pack$/i, "")
    .replace(/\s·\s(?:Motion|Photos)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/**
 * Prefer a real collection theme over foil placeholders like "Pack 1".
 * Used by My Collection / Ready to Reveal labels.
 */
export function resolveCollectionThemeLabel(input: {
  themeName?: string | null;
  packName?: string | null;
  catalogPackId?: string | null;
  creator?: string | null;
}): string {
  const candidates = [input.themeName, input.packName]
    .map((value) => (value ?? "").trim())
    .filter(Boolean);

  for (const raw of candidates) {
    if (isGenericPackLabel(raw)) continue;
    const key = canonicalThemeKey(raw);
    if (key && THEME_KEY_DISPLAY[key]) return THEME_KEY_DISPLAY[key];
    const cleaned = tidyThemeLabel(raw);
    if (cleaned && !isGenericPackLabel(cleaned)) return cleaned;
  }

  const creator = (input.creator ?? "").toLowerCase();
  for (const raw of candidates) {
    const slot = raw.match(/^pack\s*(?:n[ºo°.]?\s*)?(\d+)$/i)?.[1];
    if (!slot) continue;
    if (creator.includes("juliana")) {
      const mapped = JULIANA_FOIL_THEME_BY_SLOT[slot];
      if (mapped) return mapped;
    }
  }

  const catalogId = (input.catalogPackId ?? "").trim().toLowerCase();
  if (catalogId && CATALOG_THEME_LABELS[catalogId]) {
    return CATALOG_THEME_LABELS[catalogId];
  }
  if (catalogId) {
    for (const part of catalogId.split(/[-_/]+/)) {
      const key = canonicalThemeKey(part);
      if (key && THEME_KEY_DISPLAY[key]) return THEME_KEY_DISPLAY[key];
    }
  }

  return "";
}

export function themesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = canonicalThemeKey(a);
  const right = canonicalThemeKey(b);
  return Boolean(left && right && left === right);
}

export function themeRefMatches(
  value: string | null | undefined,
  theme: Pick<ThemeCardData, "id" | "name">,
): boolean {
  return themesMatch(value, theme.id) || themesMatch(value, theme.name);
}

/** Map a static / URL theme id onto a live API theme id (name + alias aware). */
export function matchLiveThemeId(
  selectedThemeId: string,
  liveThemes: Array<Pick<ThemeCardData, "id" | "name">>,
  staticThemes: Array<Pick<ThemeCardData, "id" | "name">> = [],
): string | undefined {
  if (liveThemes.some((theme) => theme.id === selectedThemeId)) {
    return selectedThemeId;
  }
  const selected = staticThemes.find((theme) => theme.id === selectedThemeId);
  const wanted = [
    canonicalThemeKey(selectedThemeId),
    canonicalThemeKey(selected?.id),
    canonicalThemeKey(selected?.name),
  ].filter(Boolean);
  const match = liveThemes.find((theme) => {
    const keys = [canonicalThemeKey(theme.id), canonicalThemeKey(theme.name)];
    return keys.some((key) => wanted.includes(key));
  });
  return match?.id;
}

export function findThemeDetail(
  theme: Pick<ThemeCardData, "id" | "name"> | undefined,
  themeDetails: Record<string, ThemeDetailData>,
): ThemeDetailData | undefined {
  if (!theme) return undefined;
  const exact = themeDetails[theme.id];
  if (exact) return exact;
  const wanted = canonicalThemeKey(theme.id) || canonicalThemeKey(theme.name);
  if (!wanted) return undefined;
  return Object.values(themeDetails).find(
    (detail) =>
      canonicalThemeKey(detail.themeId) === wanted ||
      canonicalThemeKey(detail.themeName) === wanted,
  );
}

export function emptyThemeDetail(
  theme: Pick<ThemeCardData, "id" | "name">,
  seriesLabel = "Series",
): ThemeDetailData {
  return {
    themeId: theme.id,
    themeName: theme.name,
    seriesLabel,
    packName: `${theme.name} Pack`,
    unopenedPacks: 0,
    photoCards: [],
    motionCards: [],
  };
}

function withScratchReadySlots(
  photoCards: PhotoCardSlot[],
  scratchReady: number,
): PhotoCardSlot[] {
  if (scratchReady <= 0) {
    return photoCards.map((card) => ({ ...card, readyToScratch: false }));
  }
  const ready: PhotoCardSlot[] = Array.from({ length: scratchReady }, (_, i) => ({
    index: i + 1,
    isUnlocked: true,
    readyToScratch: true,
  }));
  const rest = photoCards
    .filter((card) => !card.readyToScratch)
    .map((card, i) => ({ ...card, index: scratchReady + i + 1, readyToScratch: false }));
  return [...ready, ...rest];
}

/**
 * Resolve CTA detail for a theme. Live inventory (when provided) overrides
 * static mock packs / scratch-ready so API theme ids cannot collapse to buy.
 */
export function resolveThemeDetail(
  theme: ThemeCardData | undefined,
  themeDetails: Record<string, ThemeDetailData>,
  live?: {
    unopenedPacks: number;
    scratchReady: number;
    motionCards?: MotionCardSlot[];
  } | null,
): ThemeDetailData {
  const fallback = emptyThemeDetail(
    theme ?? { id: "", name: "Theme" },
    "Series",
  );
  const base = findThemeDetail(theme, themeDetails) ?? fallback;
  if (!live) return base;
  return {
    ...base,
    themeId: theme?.id ?? base.themeId,
    themeName: theme?.name ?? base.themeName,
    packName: theme ? `${theme.name} Pack` : base.packName,
    unopenedPacks: live.unopenedPacks,
    photoCards: withScratchReadySlots(base.photoCards, live.scratchReady),
    motionCards:
      live.motionCards && live.motionCards.length > 0
        ? live.motionCards
        : base.motionCards,
  };
}

export function countMatchingUnopened(
  theme: Pick<ThemeCardData, "id" | "name"> | undefined,
  packs: Array<{ themeName?: string; packName?: string }>,
): number {
  if (!theme) return 0;
  return packs.filter(
    (pack) =>
      themeRefMatches(pack.themeName, theme) ||
      themeRefMatches(pack.packName, theme),
  ).length;
}

export function countMatchingScratchReady(
  theme: Pick<ThemeCardData, "id" | "name"> | undefined,
  groups: Array<{ collectionName?: string; count: number }>,
): number {
  if (!theme) return 0;
  return groups
    .filter((group) => themeRefMatches(group.collectionName, theme))
    .reduce((sum, group) => sum + group.count, 0);
}

/**
 * Sticky CTA priority (one primary):
 * 1 scratch → 2 open-pack → 3 buy → 4 view → 5 claim
 * Claim wins over view when rewardReady on a complete theme.
 */
export function getStickyCtaMode({
  detail,
  collected,
  total,
}: {
  detail: ThemeDetailData | null | undefined;
  theme?: ThemeCardData;
  collected: number;
  total: number;
}): StickyCtaMode {
  if (!detail) return null;

  if (scratchReadyCount(detail) > 0) return "scratch";
  if (detail.unopenedPacks > 0) return "open-pack";

  const complete = total > 0 && collected >= total;
  if (complete) {
    if (detail.rewardReady) return "claim";
    return "view";
  }

  // Incomplete + no packs → buy.
  return "buy-theme-pack";
}

export function getCreatorPage(creatorId: string): CreatorPageData {
  const summary =
    CREATOR_SUMMARIES.find((c) => c.id === creatorId) ?? CREATOR_SUMMARIES[0];

  const themes: ThemeCardData[] = [
    {
      id: "summer",
      name: "Summer Nights",
      thumbnailUrl: PACK_PHOTOS.eb1,
      collected: 9,
      total: 13,
      progressColor: "pink",
      badge: { type: "pack-count", value: 2 },
    },
    {
      id: "police",
      name: "Police",
      thumbnailUrl: PACK_PHOTOS.en1,
      collected: 7,
      total: 13,
      progressColor: "orange",
      badge: { type: "pack-count", value: 1 },
    },
    {
      id: "cyber",
      name: "Cyber Nights",
      thumbnailUrl: PACK_PHOTOS.aa1,
      collected: 13,
      total: 13,
      progressColor: "green",
      badge: { type: "alert" },
    },
    {
      id: "midnight",
      name: "Midnight Room",
      thumbnailUrl: PACK_PHOTOS.nl1,
      collected: 3,
      total: 13,
      progressColor: "orange",
    },
    {
      id: "office",
      name: "Office Hours",
      thumbnailUrl: PACK_PHOTOS.ep1,
      collected: 2,
      total: 13,
      progressColor: "orange",
    },
  ];

  const themeDetails: Record<string, ThemeDetailData> = {
    summer: {
      themeId: "summer",
      themeName: "Summer Nights",
      seriesLabel: `${summary.name} Collection`,
      packName: "Summer Nights Pack",
      unopenedPacks: 2,
      // Scratch-ready for priority demo; packs still available as secondary path.
      photoCards: photoSlots(6, { scratchReady: 2, newCount: 1, dupeAt: 3 }),
      motionCards: motionSlots(3, 3, { newCount: 1 }),
    },
    police: {
      themeId: "police",
      themeName: "Police",
      seriesLabel: `${summary.name} Collection`,
      packName: "Police Pack",
      unopenedPacks: 1,
      photoCards: photoSlots(4),
      motionCards: motionSlots(2),
    },
    cyber: {
      themeId: "cyber",
      themeName: "Cyber Nights",
      seriesLabel: `${summary.name} Collection`,
      packName: "Cyber Nights Pack",
      unopenedPacks: 0,
      rewardReady: true,
      photoCards: photoSlots(10),
      motionCards: motionSlots(3),
    },
    midnight: {
      themeId: "midnight",
      themeName: "Midnight Room",
      seriesLabel: `${summary.name} Collection`,
      packName: "Midnight Room Pack",
      unopenedPacks: 0,
      photoCards: photoSlots(2),
      motionCards: motionSlots(3),
    },
    office: {
      themeId: "office",
      themeName: "Office Hours",
      seriesLabel: `${summary.name} Collection`,
      packName: "Office Hours Pack",
      unopenedPacks: 0,
      photoCards: photoSlots(1),
      motionCards: motionSlots(1),
    },
  };

  let motionUnlocked = 0;
  let motionTotal = 0;
  let photoUnlocked = 0;
  let photoTotal = 0;
  for (const detail of Object.values(themeDetails)) {
    motionTotal += detail.motionCards.length;
    motionUnlocked += detail.motionCards.filter((c) => c.isUnlocked).length;
    photoTotal += detail.photoCards.length;
    photoUnlocked += detail.photoCards.filter((c) => c.isUnlocked).length;
  }
  const themesCompleted = themes.filter((t) => t.collected >= t.total).length;

  return {
    creator: {
      id: summary.id,
      name: summary.name,
      avatarUrl: summary.avatarUrl,
      coverUrl: summary.coverUrl,
      stats: {
        collected: summary.collected,
        totalCollectible: summary.total,
        motionCardsUnlocked: motionUnlocked,
        motionCardsTotal: motionTotal,
        photoCardsUnlocked: photoUnlocked,
        photoCardsTotal: photoTotal,
        themesCompleted,
        themeCount: themes.length,
      },
    },
    themes,
    themeDetails,
  };
}

export function progressTone(pct: number) {
  if (pct >= 100) return "bg-[oklch(0.773_0.153_163.22)]";
  if (pct < 30) return "bg-[oklch(0.769_0.165_70.08)]";
  return "bg-gradient-to-r from-[oklch(0.606_0.219_292.72)] to-[oklch(0.656_0.212_354.31)]";
}

export async function fetchMyCollection() {
  return apiFetch<{
    collectedCardCount: number;
    summary: {
      uniqueCards: number;
      motionCards: number;
      photoCards: number;
      creators: number;
    };
  }>("/api/me/collection");
}
