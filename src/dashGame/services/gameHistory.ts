/**
 * Game History — client ledger of confirmed scratch/reveal results.
 * Appended at reveal settle; mock seed when empty for demo filters.
 * Display enrich resolves real motion/photo titles + stills from `/api/cards`.
 */

import { catalogMotionIdFromRevealId } from "@/features/game/modules/session";
import {
  fetchCatalogMotionCards,
  fetchCatalogPhotoCards,
} from "@/features/game/shared/catalog";
import { isDemoMode } from "../lib/demo";
import { isVideoSrc } from "./models";
import { getPackInstance } from "./packInventory";

export type GameHistoryResult = "win" | "no_prize" | "reversed";

export type GameRewardType = "COIN" | "DIAMOND" | "AUD";

export type GameRewardStatus =
  | "added_to_wallet"
  | "pending"
  | "claim_required"
  | "claimed"
  | "no_prize"
  | "expired"
  | "reversed";

export type GameHistoryRecord = {
  id: string;
  userId: string;
  revealSessionId?: string;
  revealedAt: string;
  cardId: string;
  cardNameSnapshot: string;
  cardImageSnapshotUrl: string;
  packInstanceId: string;
  packId: string;
  packNameSnapshot: string;
  creatorId: string;
  creatorNameSnapshot: string;
  result: GameHistoryResult;
  rewardType?: GameRewardType;
  rewardAmount?: number;
  rewardStatus: GameRewardStatus;
  rewardTransactionId?: string;
  purchaseTransactionId?: string;
  claimedAt?: string;
  claimDeadline?: string;
};

export type GameHistoryFilter = "all" | "wins" | "no_prize";

const KEY = "sugar.v8.gameHistory";
const SEED_FLAG = "sugar.v8.gameHistory.seeded";

function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readLedger(): GameHistoryRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidRecord);
  } catch {
    return [];
  }
}

function writeLedger(rows: GameHistoryRecord[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(rows));
  } catch {
    /* storage unavailable */
  }
}

function isValidRecord(value: unknown): value is GameHistoryRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<GameHistoryRecord>;
  return (
    typeof row.id === "string" &&
    typeof row.cardId === "string" &&
    typeof row.revealedAt === "string" &&
    typeof row.result === "string"
  );
}

function sortNewest(a: GameHistoryRecord, b: GameHistoryRecord) {
  return (Date.parse(b.revealedAt) || 0) - (Date.parse(a.revealedAt) || 0);
}

function seedMockIfNeeded(existing: GameHistoryRecord[]): GameHistoryRecord[] {
  if (!isDemoMode()) return existing;
  try {
    if (localStorage.getItem(SEED_FLAG) === "1") return existing;
  } catch {
    return existing;
  }

  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const seeded: GameHistoryRecord[] = [
    {
      id: "seed-game-win-1",
      userId: "local",
      revealedAt: new Date(now - 2 * hour).toISOString(),
      cardId: "seed-card-golden",
      cardNameSnapshot: "Golden Ticket",
      cardImageSnapshotUrl: "/images/cards/juliana-card.png",
      packInstanceId: "seed-pack-inst-1",
      packId: "seed-pack-mika",
      packNameSnapshot: "Mika Dreams Pack",
      creatorId: "mika",
      creatorNameSnapshot: "Mika",
      result: "win",
      rewardType: "COIN",
      rewardAmount: 50,
      rewardStatus: "added_to_wallet",
      purchaseTransactionId: "inv-demo",
    },
    {
      id: "seed-game-cash-1",
      userId: "local",
      revealedAt: new Date(now - 26 * hour).toISOString(),
      cardId: "seed-card-cash",
      cardNameSnapshot: "Lucky Cash Card",
      cardImageSnapshotUrl: "/images/cards/themes/juliana-firegirl.jpg",
      packInstanceId: "seed-pack-inst-2",
      packId: "seed-pack-nova",
      packNameSnapshot: "Nova Night Pack",
      creatorId: "nova",
      creatorNameSnapshot: "Nova",
      result: "win",
      rewardType: "AUD",
      rewardAmount: 5,
      rewardStatus: "claimed",
      claimedAt: new Date(now - 25 * hour).toISOString(),
    },
    {
      id: "seed-game-none-1",
      userId: "local",
      revealedAt: new Date(now - 27 * hour).toISOString(),
      cardId: "seed-card-star",
      cardNameSnapshot: "Star Card",
      cardImageSnapshotUrl: "/images/cards/themes/juliana-gym.jpg",
      packInstanceId: "seed-pack-inst-3",
      packId: "seed-pack-leo",
      packNameSnapshot: "Leo Arcade Pack",
      creatorId: "leo",
      creatorNameSnapshot: "Leo",
      result: "no_prize",
      rewardStatus: "no_prize",
    },
  ];

  const merged = [...seeded, ...existing];
  writeLedger(merged);
  try {
    localStorage.setItem(SEED_FLAG, "1");
  } catch {
    /* ignore */
  }
  return merged;
}

/** Resolve catalog pack id + wallet purchase id from a ready/scratch pack instance. */
export function packHistoryIds(packInstanceId: string) {
  const owned = getPackInstance(packInstanceId);
  return {
    packInstanceId,
    packId: owned?.catalogPackId ?? packInstanceId,
    purchaseTransactionId: owned?.purchaseId,
  };
}

/** Append a confirmed reveal. Idempotent on revealSessionId+cardId when provided. */
export function recordGameReveal(input: {
  cardId: string;
  cardName: string;
  cardImageUrl?: string;
  packInstanceId?: string;
  packId: string;
  packName: string;
  creatorId: string;
  creatorName: string;
  rewardCoins?: number;
  rewardDiamonds?: number;
  revealSessionId?: string;
  purchaseTransactionId?: string;
}): GameHistoryRecord {
  const ledger = readLedger();
  if (input.revealSessionId) {
    const dup = ledger.find(
      (row) =>
        row.revealSessionId === input.revealSessionId &&
        row.cardId === input.cardId,
    );
    if (dup) return dup;
  }

  const coins = input.rewardCoins ?? 0;
  const diamonds = input.rewardDiamonds ?? 0;
  const isWin = coins > 0 || diamonds > 0;
  const now = new Date().toISOString();
  const image = stillSnapshotUrl(input.cardImageUrl);

  const row: GameHistoryRecord = {
    id: newId("gh"),
    userId: "local",
    revealSessionId: input.revealSessionId,
    revealedAt: now,
    cardId: input.cardId,
    cardNameSnapshot: input.cardName || "Card",
    cardImageSnapshotUrl: image,
    packInstanceId: input.packInstanceId ?? input.packId,
    packId: input.packId,
    packNameSnapshot: input.packName,
    creatorId: input.creatorId,
    creatorNameSnapshot: input.creatorName,
    result: isWin ? "win" : "no_prize",
    rewardType: diamonds > 0 ? "DIAMOND" : coins > 0 ? "COIN" : undefined,
    rewardAmount: diamonds > 0 ? diamonds : coins > 0 ? coins : undefined,
    rewardStatus: isWin ? "added_to_wallet" : "no_prize",
    purchaseTransactionId: input.purchaseTransactionId,
  };

  writeLedger([row, ...ledger]);
  return row;
}

export function filterGameHistory(
  rows: GameHistoryRecord[],
  filter: GameHistoryFilter,
): GameHistoryRecord[] {
  if (filter === "all") return rows;
  if (filter === "wins") {
    return rows.filter(
      (row) => row.result === "win" && (row.rewardAmount ?? 0) > 0,
    );
  }
  return rows.filter(
    (row) => row.result === "no_prize" || row.rewardStatus === "no_prize",
  );
}

export function getGameHistoryById(id: string): GameHistoryRecord | null {
  return mergeHistory(readLedger()).find((row) => row.id === id) ?? null;
}

export function listGameHistoryForPurchase(
  purchaseTransactionId: string,
): GameHistoryRecord[] {
  const key = purchaseTransactionId.trim();
  if (!key) return [];
  return mergeHistory(readLedger()).filter(
    (row) => row.purchaseTransactionId === key,
  );
}

function mergeHistory(ledger: GameHistoryRecord[]): GameHistoryRecord[] {
  return seedMockIfNeeded(ledger).sort(sortNewest);
}

function isGenericCardName(name: string) {
  return /^(Rare|Super Rare|Ultra Rare)?\s*Card$/i.test(name.trim());
}

function stillSnapshotUrl(url: string | undefined): string {
  const trimmed = url?.trim() ?? "";
  if (!trimmed || isVideoSrc(trimmed)) return "";
  return trimmed;
}

/**
 * Upgrade generic rarity labels / missing thumbs using the live card catalog.
 * Safe no-op when the catalog is unreachable.
 */
export async function enrichGameHistoryRows(
  rows: GameHistoryRecord[],
): Promise<GameHistoryRecord[]> {
  if (!rows.length) return rows;
  const needsWork = rows.some(
    (row) =>
      isGenericCardName(row.cardNameSnapshot) ||
      !stillSnapshotUrl(row.cardImageSnapshotUrl),
  );
  if (!needsWork) return rows;

  try {
    const [motion, photos] = await Promise.all([
      fetchCatalogMotionCards(),
      fetchCatalogPhotoCards(),
    ]);
    const motionById = new Map(motion.map((card) => [card.id, card]));
    const photoById = new Map(photos.map((card) => [card.id, card]));

    let changed = false;
    const next = rows.map((row) => {
      const motionId = catalogMotionIdFromRevealId(row.cardId);
      const motionCard =
        motionById.get(row.cardId) ?? motionById.get(motionId) ?? null;
      if (motionCard) {
        const name = isGenericCardName(row.cardNameSnapshot)
          ? motionCard.label
          : row.cardNameSnapshot;
        const image =
          stillSnapshotUrl(row.cardImageSnapshotUrl) ||
          stillSnapshotUrl(motionCard.bottom) ||
          stillSnapshotUrl(motionCard.foreground);
        if (
          name === row.cardNameSnapshot &&
          image === row.cardImageSnapshotUrl
        ) {
          return row;
        }
        changed = true;
        return {
          ...row,
          cardNameSnapshot: name,
          cardImageSnapshotUrl: image,
        };
      }

      const photo = photoById.get(row.cardId);
      if (photo) {
        const name = isGenericCardName(row.cardNameSnapshot)
          ? photo.label
          : row.cardNameSnapshot;
        const image =
          stillSnapshotUrl(row.cardImageSnapshotUrl) ||
          stillSnapshotUrl(photo.background);
        if (
          name === row.cardNameSnapshot &&
          image === row.cardImageSnapshotUrl
        ) {
          return row;
        }
        changed = true;
        return {
          ...row,
          cardNameSnapshot: name,
          cardImageSnapshotUrl: image,
        };
      }

      // Drop video face URLs that can't render in <img>.
      const still = stillSnapshotUrl(row.cardImageSnapshotUrl);
      if (still !== row.cardImageSnapshotUrl) {
        changed = true;
        return { ...row, cardImageSnapshotUrl: still };
      }
      return row;
    });

    if (changed) writeLedger(next);
    return next;
  } catch {
    return rows;
  }
}

export async function loadGameHistory(): Promise<GameHistoryRecord[]> {
  return enrichGameHistoryRows(mergeHistory(readLedger()));
}

export type GameDateGroup = {
  label: string;
  rows: GameHistoryRecord[];
};

export function groupGameHistoryByLocalDate(
  rows: GameHistoryRecord[],
): GameDateGroup[] {
  const today = startOfLocalDay(new Date());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const buckets = new Map<
    string,
    { label: string; sortKey: number; rows: GameHistoryRecord[] }
  >();

  for (const row of rows) {
    const at = new Date(row.revealedAt);
    const day = startOfLocalDay(at);
    const key = day.toISOString();
    let label: string;
    if (day.getTime() === today.getTime()) label = "Today";
    else if (day.getTime() === yesterday.getTime()) label = "Yesterday";
    else {
      label = at.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    }
    const bucket = buckets.get(key) ?? {
      label,
      sortKey: day.getTime(),
      rows: [],
    };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }

  return [...buckets.values()]
    .sort((a, b) => b.sortKey - a.sortKey)
    .map(({ label, rows: groupRows }) => ({ label, rows: groupRows }));
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function formatRevealWhen(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function rewardOutcomeLabel(row: GameHistoryRecord): string {
  if (row.result === "no_prize" || row.rewardStatus === "no_prize") {
    return "No prize";
  }
  const amount = row.rewardAmount ?? 0;
  let value: string;
  if (row.rewardType === "AUD") value = `Won A$${amount.toFixed(2)}`;
  else if (row.rewardType === "DIAMOND") value = `+${amount} Diamonds`;
  else value = `+${amount} Coins`;

  const status = rewardStatusLabel(row.rewardStatus);
  return status ? `${value} · ${status}` : value;
}

export function rewardStatusLabel(status: GameRewardStatus): string {
  switch (status) {
    case "added_to_wallet":
      // Default win path — amount alone is enough (no "· Added to wallet").
      return "";
    case "pending":
      return "Pending";
    case "claim_required":
      return "Claim required";
    case "claimed":
      return "Claimed";
    case "no_prize":
      return "";
    case "expired":
      return "Expired";
    case "reversed":
      return "Reversed";
    default:
      return status;
  }
}

export function collectionHrefForGame(row: GameHistoryRecord): string {
  const params = new URLSearchParams();
  if (row.cardId) params.set("card", row.cardId);
  const qs = params.toString();
  return `/creator/${encodeURIComponent(row.creatorId)}${qs ? `?${qs}` : ""}`;
}
