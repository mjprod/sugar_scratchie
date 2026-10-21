/**
 * Persistent Ready-to-Scratch inventory (opened packs with unrevealed cards).
 * Survives navigation, refresh, and logout — ownership is not session-only.
 */
import type { OpeningSession } from "./purchase";
import { resolveInventoryCoverUrl } from "../lib/photos";
import { getPackInstance } from "./packInventory";

export type PackStatus = "unopened" | "opened";
export type CardRevealStatus = "unscratched" | "scratch-in-progress" | "revealed";

export type ReadyScratchPack = {
  packId: string;
  packName: string;
  creator: string;
  creatorId: string;
  themeName: string;
  coverUrl: string;
  packStatus: "opened";
  session: OpeningSession;
  /** Card ids that reached reveal threshold — never reset. */
  revealed: string[];
  savedAt: number;
};

export type ReadyScratchKind = "motion" | "photo";

export type ReadyScratchGroup = {
  id: string;
  creatorId: string;
  creatorName: string;
  collectionName: string;
  count: number;
  coverUrl: string;
  kind: ReadyScratchKind;
};

const KEY = "sugar.v8.readyToScratch";

function readAll(): ReadyScratchPack[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidPack);
  } catch {
    return [];
  }
}

function writeAll(packs: ReadyScratchPack[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(packs));
  } catch {
    /* storage unavailable */
  }
}

function isValidPack(value: unknown): value is ReadyScratchPack {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<ReadyScratchPack>;
  return (
    typeof data.packId === "string" &&
    typeof data.packName === "string" &&
    typeof data.creator === "string" &&
    data.packStatus === "opened" &&
    Array.isArray(data.revealed) &&
    !!data.session &&
    Array.isArray(data.session.cards) &&
    data.session.cards.length > 0
  );
}

export function remainingCount(pack: ReadyScratchPack) {
  return pack.session.cards.filter((card) => !pack.revealed.includes(card.id)).length;
}

export function cardRevealStatus(
  pack: ReadyScratchPack,
  cardId: string,
): CardRevealStatus {
  if (pack.revealed.includes(cardId)) return "revealed";
  return "unscratched";
}

/** Upsert an opened pack. Removes the entry when every card is revealed. */
export function upsertReadyToScratch(
  input: Omit<ReadyScratchPack, "savedAt" | "packStatus" | "coverUrl" | "themeName" | "creatorId"> & {
    coverUrl?: string;
    themeName?: string;
    creatorId?: string;
  },
): ReadyScratchPack | null {
  const revealed = [...new Set(input.revealed)];
  const next: ReadyScratchPack = {
    packId: input.packId,
    packName: input.packName,
    creator: input.creator,
    creatorId: input.creatorId ?? slugId(input.creator),
    themeName: input.themeName ?? input.packName,
    coverUrl: resolveInventoryCoverUrl({
      coverUrl: input.coverUrl,
      packId: input.packId,
      themeName: input.themeName ?? input.packName,
      creator: input.creator,
    }),
    packStatus: "opened",
    session: input.session,
    revealed,
    savedAt: Date.now(),
  };

  const packs = readAll().filter((pack) => pack.packId !== next.packId);
  if (remainingCount(next) === 0) {
    writeAll(packs);
    return null;
  }
  writeAll([next, ...packs]);
  return next;
}

export function getReadyToScratch(packId: string): ReadyScratchPack | null {
  return readAll().find((pack) => pack.packId === packId) ?? null;
}

/** Drop an opened pack from the shelf regardless of per-card reveal bookkeeping. */
export function removeReadyToScratch(packId: string): void {
  const packs = readAll();
  const next = packs.filter((pack) => pack.packId !== packId);
  if (next.length !== packs.length) writeAll(next);
}

export function listReadyToScratch(): ReadyScratchGroup[] {
  return readAll()
    .filter((pack) => {
      // Sealed packs belong under Packs, never Cards — drop ghost entries
      // created if tear settlement fired before a real open.
      const owned = getPackInstance(pack.packId);
      if (owned && owned.status === "unopened") return false;
      return true;
    })
    .map((pack) => ({
      id: pack.packId,
      creatorId: pack.creatorId,
      creatorName: pack.creator,
      collectionName: pack.themeName,
      count: remainingCount(pack),
      coverUrl: resolveInventoryCoverUrl({
        coverUrl: pack.coverUrl,
        packId: pack.packId,
        themeName: pack.themeName,
        creator: pack.creator,
      }),
      kind: "motion" as const,
    }))
    .filter((group) => group.count > 0);
}

export function clearReadyToScratch() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

function slugId(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, "-") || "creator";
}

export function trackScratchEvent(
  event:
    | "Pack Opened"
    | "Scratch Decision Shown"
    | "Scratch Now Selected"
    | "Scratch Later Selected"
    | "Scratch Session Started"
    | "Scratch Session Exited"
    | "Scratch Progress Saved"
    | "Scratch Resumed"
    | "Card Revealed"
    | "Scratch Next Selected"
    | "Finish Later Selected"
    | "Ready To Scratch Viewed"
    | "Ready To Scratch Opened"
    | "All Cards Revealed",
  payload?: Record<string, unknown>,
) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("sugar:analytics", { detail: { event, payload } }),
  );
}
