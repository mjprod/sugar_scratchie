/**
 * Persistent Collection ledger — revealed cards + started creators.
 * Pack inventory + ready-to-scratch remain source of pending ownership.
 */
import {
  resolveCollectionThemeLabel,
  canonicalThemeKey,
  type CreatorProgress,
} from "./collection";
import {
  countOwnedPacks,
  countUnopened,
  listOwnedPacks,
} from "./packInventory";
import { listStoredGameSessions } from "@/services/gameSessionStore";
import { listReadyToScratch } from "./readyToScratch";
import {
  creatorHasAnyThemeCompletionClaim,
  isThemeCompletionClaimed,
} from "./themeCompletionReward";
import { apiFetch } from "../lib/api";
import { canonicalCreatorId, type BackendModel } from "./models";

type CreatorLedger = {
  id: string;
  name: string;
  collected: number;
  total: number;
  lastActiveAt: number;
  /** Most recent theme / pack collection name, when known. */
  themeName?: string;
};

type CollectionLedger = {
  collectedCardCount: number;
  motionCards: number;
  photoCards: number;
  creators: Record<string, CreatorLedger>;
};

const KEY = "sugar.v8.collectionLedger";

function emptyLedger(): CollectionLedger {
  return {
    collectedCardCount: 0,
    motionCards: 0,
    photoCards: 0,
    creators: {},
  };
}

function readLedger(): CollectionLedger {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyLedger();
    const parsed = JSON.parse(raw) as Partial<CollectionLedger>;
    return {
      collectedCardCount: Number(parsed.collectedCardCount) || 0,
      motionCards: Number(parsed.motionCards) || 0,
      photoCards: Number(parsed.photoCards) || 0,
      creators:
        parsed.creators && typeof parsed.creators === "object"
          ? parsed.creators
          : {},
    };
  } catch {
    return emptyLedger();
  }
}

function writeLedger(ledger: CollectionLedger) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ledger));
  } catch {
    /* storage unavailable */
  }
}


function countReadyPhotoScratch(): number {
  return listStoredGameSessions().reduce((total, session) => {
    if (session.phase !== "photo_reveal" && session.phase !== "photo") {
      return total;
    }
    const won = session.wonPhotoIds ?? [];
    const done = session.completedPhotoIds ?? [];
    return total + won.filter((id) => !done.includes(id)).length;
  }, 0);
}

/** Mid-session motion left when readyToScratch inventory hasn't caught up. */
function countOrphanMotionFromSession(): number {
  const shelfIds = new Set(listReadyToScratch().map((group) => group.id));
  return listStoredGameSessions().reduce((total, session) => {
    if (session.phase !== "motion") return total;
    const remaining = (session.motionCardIds ?? []).filter(
      (id) => !(session.completedMotionIds ?? []).includes(id),
    );
    if (remaining.length === 0) return total;
    const packId = session.packScratch?.readyPackId;
    if (packId && shelfIds.has(packId)) return total;
    return total + remaining.length;
  }, 0);
}
function slugId(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, "-") || "creator";
}

/** Board creator id when the catalog is already loaded; otherwise the stored id. */
function boardCreatorId(
  models: BackendModel[],
  hints: { creatorId?: string | null; name?: string | null; packId?: string | null },
): string {
  if (!models.length) return (hints.creatorId || slugId(hints.name ?? "")).trim();
  return (
    canonicalCreatorId(models, hints) ||
    (hints.creatorId || slugId(hints.name ?? "")).trim()
  );
}

/** Stable API avatar path — never fixture / placeholder pack art. */
function avatarFor(creatorId: string, name: string) {
  const slug = (creatorId || name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9_-]/g, "");
  if (slug && /^[a-z0-9_-]+$/i.test(slug)) {
    return `/models/${slug}/avatar.jpeg`;
  }
  return "";
}

function themeLabelFromPack(
  themeName?: string,
  packName?: string,
  catalogPackId?: string,
  creator?: string,
): string {
  return resolveCollectionThemeLabel({
    themeName,
    packName,
    catalogPackId,
    creator,
  });
}

/** Mark a Creator as started (e.g. after first Pack purchase). */
export function noteCreatorStarted(
  creatorId: string,
  creatorName: string,
  themeName?: string,
) {
  const id = creatorId.trim() || slugId(creatorName);
  const ledger = readLedger();
  const theme = themeLabelFromPack(themeName);
  const existing = ledger.creators[id];
  if (existing) {
    existing.lastActiveAt = Date.now();
    existing.name = creatorName || existing.name;
    if (theme) existing.themeName = theme;
  } else {
    ledger.creators[id] = {
      id,
      name: creatorName,
      collected: 0,
      total: 15,
      lastActiveAt: Date.now(),
      themeName: theme || undefined,
    };
  }
  writeLedger(ledger);
}

/** Record newly revealed cards into Collection Summary stats. */
export function recordRevealedCards(input: {
  count: number;
  creatorId: string;
  creatorName: string;
  themeName?: string;
  /** Defaults: ~1/3 motion, rest photo — demo split until rarity metadata exists. */
  motionCount?: number;
}) {
  if (input.count < 1) return;
  const ledger = readLedger();
  const motion = Math.min(
    input.count,
    input.motionCount ?? Math.max(0, Math.round(input.count / 3)),
  );
  const photo = input.count - motion;
  ledger.collectedCardCount += input.count;
  ledger.motionCards += motion;
  ledger.photoCards += photo;

  const id = input.creatorId.trim() || slugId(input.creatorName);
  const theme = themeLabelFromPack(input.themeName);
  const existing = ledger.creators[id];
  if (existing) {
    existing.collected = Math.min(
      existing.total,
      existing.collected + input.count,
    );
    existing.lastActiveAt = Date.now();
    existing.name = input.creatorName || existing.name;
    if (theme) existing.themeName = theme;
  } else {
    const total = 15;
    ledger.creators[id] = {
      id,
      name: input.creatorName,
      collected: Math.min(total, input.count),
      total,
      lastActiveAt: Date.now(),
      themeName: theme || undefined,
    };
  }
  writeLedger(ledger);
}

/** Photo Cards earned from a Motion Card win — owned before the result UI. */
export function recordWonPhotoCards(input: {
  count: number;
  creatorId: string;
  creatorName: string;
}) {
  if (input.count < 1) return;
  recordRevealedCards({
    count: input.count,
    creatorId: input.creatorId,
    creatorName: input.creatorName,
    motionCount: 0,
  });
}

export type CollectionPageState = {
  totalPurchasedPacks: number;
  unopenedPackCount: number;
  unscratchedCardCount: number;
  collectedCardCount: number;
  hasEverPurchasedPack: boolean;
  hasCollectedCards: boolean;
  hasUnopenedPacks: boolean;
  hasUnscratchedCards: boolean;
  hasPendingReveal: boolean;
  isTrueEmpty: boolean;
  hasStartedCollection: boolean;
  summary: {
    /** Absolute revealed/collected card count — never a global denominator. */
    cardsCollected: number;
    /** Unique creators represented by collected cards. */
    creatorsCollectedFrom: number;
    /** Incomplete theme/sets with at least one collected card. */
    collectionsInProgress: number;
    /** Unclaimed theme-completion rewards (> 0 to show Reward Ready). */
    rewardReadyCount: number;
    /** @deprecated Prefer cardsCollected */
    collectedCards: number;
    /** @deprecated Removed from UI — kept for older callers. */
    totalCards: number;
    pct: number;
    creators: number;
    themes: number;
    uniqueCards: number;
    motionCards: number;
    photoCards: number;
  };
  continueCreators: CreatorProgress[];
};

function mergeStartedCreators(
  ledger: CollectionLedger,
  models: BackendModel[] = [],
): Record<string, CreatorLedger> {
  const creators: Record<string, CreatorLedger> = {};
  for (const creator of Object.values(ledger.creators)) {
    const id = boardCreatorId(models, {
      creatorId: creator.id,
      name: creator.name,
    });
    const row = { ...creator, id };
    const existing = creators[id];
    if (!existing || row.collected > existing.collected) {
      creators[id] = row;
    }
  }
  for (const pack of listOwnedPacks()) {
    const id = boardCreatorId(models, {
      creatorId: pack.creatorId,
      name: pack.creator,
      packId: pack.catalogPackId,
    });
    const theme = themeLabelFromPack(
      pack.themeName,
      pack.packName,
      pack.catalogPackId,
      pack.creator,
    );
    if (!creators[id]) {
      creators[id] = {
        id,
        name: pack.creator,
        collected: 0,
        total: 15,
        lastActiveAt: pack.savedAt,
        themeName: theme || undefined,
      };
    } else {
      const next = { ...creators[id] };
      if (pack.savedAt > next.lastActiveAt) {
        next.lastActiveAt = pack.savedAt;
        next.name = pack.creator || next.name;
      }
      if (theme && (!next.themeName || pack.savedAt >= next.lastActiveAt)) {
        next.themeName = theme;
      }
      creators[id] = next;
    }
  }
  return creators;
}

/** True when the player has no packs / cards / continue progress yet. */
export function isNewUserForHomepageHero(): boolean {
  const s = getCollectionPageState();
  return (
    s.totalPurchasedPacks === 0 &&
    s.collectedCardCount === 0 &&
    s.continueCreators.length === 0 &&
    s.unscratchedCardCount === 0
  );
}

/** Live Collection page visibility + summary inputs. */
export function getCollectionPageState(
  models: BackendModel[] = [],
): CollectionPageState {
  const owned = countOwnedPacks();
  const unopenedPackCount = countUnopened();
  const unscratchedCardCount =
    listReadyToScratch().reduce((sum, group) => sum + group.count, 0) +
    countOrphanMotionFromSession() +
    countReadyPhotoScratch();
  const ledger = readLedger();
  const creators = mergeStartedCreators(ledger, models);

  const collectedCardCount = ledger.collectedCardCount;
  const hasEverPurchasedPack = owned > 0;
  const hasCollectedCards = collectedCardCount > 0;
  const hasUnopenedPacks = unopenedPackCount > 0;
  const hasUnscratchedCards = unscratchedCardCount > 0;
  const hasPendingReveal = hasUnopenedPacks || hasUnscratchedCards;
  const isTrueEmpty =
    owned === 0 &&
    collectedCardCount === 0 &&
    unopenedPackCount === 0 &&
    unscratchedCardCount === 0;

  const ownedPacks = listOwnedPacks();
  const continueCreators: CreatorProgress[] = Object.values(creators)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .map((creator) => {
      const pct = Math.round(
        (creator.collected / Math.max(1, creator.total)) * 100,
      );
      const packTheme = ownedPacks
        .filter(
          (pack) =>
            boardCreatorId(models, {
              creatorId: pack.creatorId,
              name: pack.creator,
              packId: pack.catalogPackId,
            }) === creator.id,
        )
        .sort((a, b) => b.savedAt - a.savedAt)
        .map((pack) =>
          themeLabelFromPack(
            pack.themeName,
            pack.packName,
            pack.catalogPackId,
            pack.creator,
          ),
        )
        .find(Boolean);
      const themeName =
        packTheme ||
        themeLabelFromPack(creator.themeName) ||
        undefined;
      return {
        id: creator.id,
        name: creator.name,
        avatarUrl: avatarFor(creator.id, creator.name),
        coverUrl: avatarFor(creator.id, creator.name),
        collected: creator.collected,
        total: creator.total,
        pct,
        themesStarted: creator.collected > 0 ? 1 : 0,
        themesTotal: 5,
        cta: "continue" as const,
        themeName,
      };
    });

  const creatorsWithProgress = continueCreators.filter((c) => c.collected > 0);
  const collectionsInProgress = creatorsWithProgress.filter(
    (c) => c.collected < c.total,
  ).length;
  // Match claim ledger keys: theme-complete:${creatorId}:${themeId}
  // (never a fake "primary" id — that never gets written on claim).
  const rewardReadyCount = creatorsWithProgress.filter((c) => {
    if (!(c.collected >= c.total && c.total > 0)) return false;
    const themeId = canonicalThemeKey(c.themeName);
    if (themeId) return !isThemeCompletionClaimed(c.id, themeId);
    // No resolvable theme on the hub row — clear after any claim for this creator.
    return !creatorHasAnyThemeCompletionClaim(c.id);
  }).length;

  return {
    totalPurchasedPacks: owned,
    unopenedPackCount,
    unscratchedCardCount,
    collectedCardCount,
    hasEverPurchasedPack,
    hasCollectedCards,
    hasUnopenedPacks,
    hasUnscratchedCards,
    hasPendingReveal,
    isTrueEmpty,
    hasStartedCollection: hasEverPurchasedPack,
    summary: {
      cardsCollected: collectedCardCount,
      creatorsCollectedFrom: creatorsWithProgress.length,
      collectionsInProgress,
      rewardReadyCount,
      collectedCards: collectedCardCount,
      totalCards: 0,
      pct: 0,
      creators: creatorsWithProgress.length,
      themes: collectionsInProgress,
      uniqueCards: collectedCardCount,
      motionCards: ledger.motionCards,
      photoCards: ledger.photoCards,
    },
    continueCreators,
  };
}

export function clearCollectionLedger() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Empty hub state — used while the API loads or when the account has nothing. */
export function emptyCollectionPageState(): CollectionPageState {
  return {
    totalPurchasedPacks: 0,
    unopenedPackCount: 0,
    unscratchedCardCount: 0,
    collectedCardCount: 0,
    hasEverPurchasedPack: false,
    hasCollectedCards: false,
    hasUnopenedPacks: false,
    hasUnscratchedCards: false,
    hasPendingReveal: false,
    isTrueEmpty: true,
    hasStartedCollection: false,
    summary: {
      cardsCollected: 0,
      creatorsCollectedFrom: 0,
      collectionsInProgress: 0,
      rewardReadyCount: 0,
      collectedCards: 0,
      totalCards: 0,
      pct: 0,
      creators: 0,
      themes: 0,
      uniqueCards: 0,
      motionCards: 0,
      photoCards: 0,
    },
    continueCreators: [],
  };
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeRemoteCreator(raw: unknown): CreatorProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const id = String(data.id ?? data.creatorId ?? "").trim();
  const name = String(data.name ?? data.creatorName ?? "").trim();
  if (!id && !name) return null;
  const collected = Math.max(0, asFiniteNumber(data.collected));
  const total = Math.max(collected, asFiniteNumber(data.total, 0));
  const pct =
    data.pct != null
      ? Math.max(0, Math.min(100, Math.round(asFiniteNumber(data.pct))))
      : total > 0
        ? Math.round((collected / total) * 100)
        : 0;
  const resolvedId = id || slugId(name);
  return {
    id: resolvedId,
    name: name || resolvedId,
    avatarUrl:
      String(data.avatarUrl ?? data.avatar ?? "").trim() ||
      avatarFor(resolvedId, name),
    coverUrl:
      String(data.coverUrl ?? data.avatarUrl ?? data.avatar ?? "").trim() ||
      avatarFor(resolvedId, name),
    collected,
    total,
    pct,
    themesStarted: Math.max(0, asFiniteNumber(data.themesStarted)),
    themesTotal: Math.max(0, asFiniteNumber(data.themesTotal)),
    cta:
      data.cta === "view" || data.cta === "claim" || data.cta === "continue"
        ? data.cta
        : "continue",
    themeName:
      String(data.themeName ?? data.theme ?? "").trim() || undefined,
  };
}

/**
 * Normalize GET /api/me/collection into CollectionPageState.
 * Accepts either the full page-state shape or a summary-only payload.
 */
export function normalizeCollectionPageStateRemote(
  raw: unknown,
): CollectionPageState | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const summaryRaw =
    data.summary && typeof data.summary === "object"
      ? (data.summary as Record<string, unknown>)
      : {};

  const continueRaw = Array.isArray(data.continueCreators)
    ? data.continueCreators
    : Array.isArray(data.creators)
      ? data.creators
      : [];
  const continueCreators = continueRaw
    .map(normalizeRemoteCreator)
    .filter((creator): creator is CreatorProgress => Boolean(creator));

  const collectedCardCount = Math.max(
    0,
    asFiniteNumber(
      data.collectedCardCount ??
        summaryRaw.cardsCollected ??
        summaryRaw.collectedCards ??
        summaryRaw.uniqueCards,
    ),
  );
  const unopenedPackCount = Math.max(
    0,
    asFiniteNumber(data.unopenedPackCount ?? data.unopenedPacks),
  );
  const unscratchedCardCount = Math.max(
    0,
    asFiniteNumber(
      data.unscratchedCardCount ?? data.scratchCards ?? data.readyToScratch,
    ),
  );
  const totalPurchasedPacks = Math.max(
    0,
    asFiniteNumber(data.totalPurchasedPacks ?? data.purchasedPacks),
  );
  const creatorsWithProgress = continueCreators.filter((c) => c.collected > 0);
  const collectionsInProgress = Math.max(
    0,
    asFiniteNumber(
      summaryRaw.collectionsInProgress ?? summaryRaw.themes,
      creatorsWithProgress.filter((c) => c.collected < c.total || c.total === 0)
        .length,
    ),
  );
  const creatorsCollectedFrom = Math.max(
    0,
    asFiniteNumber(
      summaryRaw.creatorsCollectedFrom ?? summaryRaw.creators,
      creatorsWithProgress.length,
    ),
  );
  const rewardReadyCount = Math.max(
    0,
    asFiniteNumber(summaryRaw.rewardReadyCount),
  );
  const hasEverPurchasedPack =
    typeof data.hasEverPurchasedPack === "boolean"
      ? data.hasEverPurchasedPack
      : totalPurchasedPacks > 0 || unopenedPackCount > 0;
  const hasCollectedCards =
    typeof data.hasCollectedCards === "boolean"
      ? data.hasCollectedCards
      : collectedCardCount > 0;
  const hasUnopenedPacks =
    typeof data.hasUnopenedPacks === "boolean"
      ? data.hasUnopenedPacks
      : unopenedPackCount > 0;
  const hasUnscratchedCards =
    typeof data.hasUnscratchedCards === "boolean"
      ? data.hasUnscratchedCards
      : unscratchedCardCount > 0;
  const hasPendingReveal =
    typeof data.hasPendingReveal === "boolean"
      ? data.hasPendingReveal
      : hasUnopenedPacks || hasUnscratchedCards;
  const isTrueEmpty =
    typeof data.isTrueEmpty === "boolean"
      ? data.isTrueEmpty
      : !hasEverPurchasedPack &&
        !hasCollectedCards &&
        !hasUnopenedPacks &&
        !hasUnscratchedCards;

  return {
    totalPurchasedPacks,
    unopenedPackCount,
    unscratchedCardCount,
    collectedCardCount,
    hasEverPurchasedPack,
    hasCollectedCards,
    hasUnopenedPacks,
    hasUnscratchedCards,
    hasPendingReveal,
    isTrueEmpty,
    hasStartedCollection:
      typeof data.hasStartedCollection === "boolean"
        ? data.hasStartedCollection
        : hasEverPurchasedPack,
    summary: {
      cardsCollected: collectedCardCount,
      creatorsCollectedFrom,
      collectionsInProgress,
      rewardReadyCount,
      collectedCards: collectedCardCount,
      totalCards: Math.max(0, asFiniteNumber(summaryRaw.totalCards)),
      pct: Math.max(0, Math.min(100, asFiniteNumber(summaryRaw.pct))),
      creators: creatorsCollectedFrom,
      themes: collectionsInProgress,
      uniqueCards: Math.max(
        0,
        asFiniteNumber(summaryRaw.uniqueCards, collectedCardCount),
      ),
      motionCards: Math.max(0, asFiniteNumber(summaryRaw.motionCards)),
      photoCards: Math.max(0, asFiniteNumber(summaryRaw.photoCards)),
    },
    continueCreators,
  };
}

/**
 * Live Collection hub payload from GET /api/me/collection.
 * Returns null when unauthenticated / unreachable — callers must not invent fixtures.
 */
export async function fetchCollectionPageStateRemote(): Promise<CollectionPageState | null> {
  const raw = await apiFetch<unknown>("/api/me/collection");
  return normalizeCollectionPageStateRemote(raw);
}
