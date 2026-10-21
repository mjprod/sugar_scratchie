import { noteCoinsReceived } from "@/services/coinReceipt";
import { recordWonPhotoCards } from "@/services/collectionState";
import {
  activateGameSessionForPack,
  clearGameSession,
  coinsForMotionPrize,
  diamondsForMotionPrize,
  gameSessionStorageKey,
  isPracticeCard,
  loadGameSession,
  loadGameSessionForPack,
  loadHubGameSession,
  saveGameSession,
  type GameSession,
  type PackScratchLink,
} from "@/services/gameSessionStore";
import {
  removeReadyToScratch,
  upsertReadyToScratch,
} from "@/services/readyToScratch";
import type { loadGameCatalog, ThemedMotionCard } from "./session";

export * from "@/services/gameSessionStore";

/** Keep opened-pack Ready to Scratch in sync with the live game session. */
export function persistPackScratchInventory(session: GameSession): void {
  const link = session.packScratch;
  if (!link) return;
  // Past the motion phase the pack has no Motion Cards left to scratch, whatever
  // settledOpeningIds says — an opening card the hand never mapped (hand caps at
  // GAME_HAND_SIZE) or a settle that failed would otherwise strand the shelf row
  // forever as a ghost "Resume" tile.
  if (session.phase !== "motion") {
    removeReadyToScratch(link.readyPackId);
    return;
  }
  upsertReadyToScratch({
    packId: link.readyPackId,
    packName: link.packName,
    creator: link.creator,
    session: link.openingSession,
    revealed: link.settledOpeningIds,
    coverUrl: link.coverUrl,
    themeName: link.themeName,
  });
}

export function persistGameProgress(): GameSession | null {
  const session = loadGameSession();
  if (!session) return null;
  saveGameSession(session);
  persistPackScratchInventory(session);
  return session;
}

export type StartMotionSessionOptions = {
  packScratch?: Omit<PackScratchLink, "settledOpeningIds"> & {
    settledOpeningIds?: string[];
  };
  completedMotionIds?: string[];
};

export function startMotionSession(
  hand: ThemedMotionCard[],
  options?: StartMotionSessionOptions,
): GameSession {
  const readyId = options?.packScratch?.readyPackId;
  const existing = readyId
    ? loadGameSessionForPack(readyId)
    : loadHubGameSession();
  if (
    existing &&
    readyId &&
    existing.packScratch?.readyPackId === readyId &&
    existing.phase !== "motion"
  ) {
    activateGameSessionForPack(readyId);
    return existing;
  }
  if (
    existing &&
    readyId &&
    existing.packScratch?.readyPackId === readyId &&
    existing.phase === "motion"
  ) {
    const completed = [
      ...new Set([
        ...existing.completedMotionIds,
        ...(options?.completedMotionIds ?? []),
      ]),
    ];
    const next: GameSession = {
      ...existing,
      completedMotionIds: completed,
      packScratch: options?.packScratch
        ? {
            ...existing.packScratch,
            ...options.packScratch,
            settledOpeningIds:
              options.packScratch.settledOpeningIds ??
              existing.packScratch.settledOpeningIds,
          }
        : existing.packScratch,
    };
    saveGameSession(next);
    persistPackScratchInventory(next);
    return next;
  }

  const first = hand[0];
  const session: GameSession = {
    version: 1,
    phase: "motion",
    motionCardIds: hand.map((card) => card.id),
    themes: hand.map((card) => card.theme),
    modelId: first?.model_id?.trim() || "",
    completedMotionIds: options?.completedMotionIds ?? [],
    photoPrizeTotal: 0,
    wonPhotoIds: [],
    completedPhotoIds: [],
    diamondTotal: 0,
    photoDiamondTotal: 0,
    walletCredited: false,
    packScratch: options?.packScratch
      ? {
          ...options.packScratch,
          settledOpeningIds: options.packScratch.settledOpeningIds ?? [],
        }
      : undefined,
  };
  saveGameSession(session);
  return session;
}

/** Mark hub wallet settle as applied (idempotent). */
export function markWalletCredited(): GameSession | null {
  const session = loadGameSession();
  if (!session) return null;
  if (session.walletCredited) return session;
  const next: GameSession = { ...session, walletCredited: true };
  saveGameSession(next);
  return next;
}

/**
 * Apply session coinTotal + diamondTotal to the app wallet once.
 * Pack-linked hands: motion coins/diamonds were already credited by reveal /
 * PACK_OPENING_REWARD_EVENT — only apply photo-hand diamonds here.
 */
export function settleHubWalletFromSession(
  addDiamonds: (amount: number) => void,
  addCoins: (amount: number) => void,
): GameSession | null {
  const session = loadGameSession();
  if (!session) return null;
  if (session.walletCredited) return session;
  if (session.packScratch) {
    const photoDiamonds = Math.max(
      0,
      session.photoDiamondTotal ?? session.diamondTotal,
    );
    if (photoDiamonds > 0) addDiamonds(photoDiamonds);
    return markWalletCredited();
  }
  const diamonds = Math.max(0, session.diamondTotal);
  const coins = Math.max(0, session.coinTotal ?? 0);
  if (diamonds > 0) addDiamonds(diamonds);
  if (coins > 0) {
    addCoins(coins);
    noteCoinsReceived(coins);
  }
  return markWalletCredited();
}

/** Record a finished motion card and its prize units (now currency, not photos). */
export function recordMotionCardResult(
  cardId: string,
  prize: number,
): GameSession | null {
  const session = loadGameSession();
  if (!session || session.phase !== "motion") return session;
  if (session.completedMotionIds.includes(cardId)) return session;
  const next: GameSession = {
    ...session,
    completedMotionIds: [...session.completedMotionIds, cardId],
    photoPrizeTotal: session.photoPrizeTotal + Math.max(0, prize),
  };
  saveGameSession(next);
  return next;
}

function packRewardCoinsForMotionCard(
  session: GameSession,
  cardId: string,
): number {
  const { packScratch } = session;
  if (!packScratch) return 0;
  const index = session.motionCardIds.indexOf(cardId);
  if (index < 0) return 0;
  const openingId = packScratch.openingCardIds[index];
  if (!openingId) return 0;
  const card = packScratch.openingSession.cards.find(
    (entry) => entry.id === openingId,
  );
  return Math.max(0, card?.reward ?? 0);
}

/**
 * Bank coin + diamond rewards for this Motion Card win and open the result overlay.
 * Photo cards are no longer awarded from motion wins.
 */
export function awardMotionCardCurrency(
  cardId: string,
  prize: number,
): GameSession | null {
  const session = loadGameSession();
  if (!session) return null;
  const total = Math.max(1, session.motionCardIds.length);
  const current = Math.max(1, session.completedMotionIds.indexOf(cardId) + 1);
  const packLinked = Boolean(session.packScratch);
  const packCoins = packRewardCoinsForMotionCard(session, cardId);
  const practice = isPracticeCard(cardId);
  const coins = practice
    ? 0
    : coinsForMotionPrize(prize, packCoins, { packLinked });
  const diamonds = practice ? 0 : diamondsForMotionPrize(prize);
  const next: GameSession = {
    ...session,
    lastMotionWinPhotoIds: [],
    coinTotal: Math.max(0, session.coinTotal ?? 0) + coins,
    // Always bank diamonds for the hand tally. Hub settles coinTotal +
    // diamondTotal once at done; pack openings credit the wallet via reveal
    // (prize passed through) / PACK_OPENING_REWARD_EVENT.
    diamondTotal: session.diamondTotal + diamonds,
    pendingMotionResult: {
      cardId,
      photoIds: [],
      coins,
      diamonds,
      prize: Math.max(0, prize),
      current,
      total,
    },
  };
  saveGameSession(next);
  persistPackScratchInventory(next);
  return next;
}

/** @deprecated Use awardMotionCardCurrency — motion wins no longer award photos. */
export async function awardMotionCardPhotos(
  cardId: string,
  prize: number,
  _catalog?: Awaited<ReturnType<typeof loadGameCatalog>>,
): Promise<GameSession | null> {
  return awardMotionCardCurrency(cardId, prize);
}

export function clearPendingMotionResult(): GameSession | null {
  const session = loadGameSession();
  if (!session) return null;
  if (!session.pendingMotionResult && !session.lastMotionWinPhotoIds?.length) {
    return session;
  }
  const next: GameSession = {
    ...session,
    pendingMotionResult: undefined,
  };
  saveGameSession(next);
  return next;
}

/**
 * After all motion cards: bank currency and finish the hand.
 * Legacy sessions that already won photo ids still enter photo_reveal.
 */
export async function finishMotionHand(): Promise<GameSession | null> {
  const session = loadGameSession();
  if (!session) return null;
  if (session.phase !== "motion") return session;

  const wonPhotoIds = session.wonPhotoIds;
  const next: GameSession = {
    ...session,
    phase: wonPhotoIds.length > 0 ? "photo_reveal" : "done",
    wonPhotoIds,
    pendingMotionResult: undefined,
  };
  // Only count collection when legacy photo ids are present.
  const recorded =
    wonPhotoIds.length > 0 ? recordAwardedPhotoCards(next) : next;
  saveGameSession(recorded);
  persistPackScratchInventory(recorded);
  return recorded;
}

export function recordPhotoCardResult(
  cardId: string,
  diamonds: number,
): GameSession | null {
  const session = loadGameSession();
  if (!session || session.phase !== "photo") return session;
  if (session.completedPhotoIds.includes(cardId)) return session;
  const gained = isPracticeCard(cardId) ? 0 : Math.max(0, diamonds);
  const next: GameSession = {
    ...session,
    completedPhotoIds: [...session.completedPhotoIds, cardId],
    diamondTotal: session.diamondTotal + gained,
    photoDiamondTotal: (session.photoDiamondTotal ?? 0) + gained,
  };
  saveGameSession(next);
  return next;
}

export function finishPhotoHand(): GameSession | null {
  const session = loadGameSession();
  if (!session) return null;
  if (session.phase === "done") return session;
  const next: GameSession = { ...session, phase: "done" };
  saveGameSession(next);
  return next;
}

/** True when every won photo id is already in completedPhotoIds. */
export function isPhotoHandFullyComplete(session: GameSession): boolean {
  if (session.wonPhotoIds.length === 0) return false;
  const done = new Set(session.completedPhotoIds);
  return session.wonPhotoIds.every((id) => done.has(id));
}

/**
 * Promote an all-complete photo phase to done (idempotent).
 * Used when the last card was recorded but finish was delayed, or on reload.
 */
export function promoteCompletePhotoHand(): GameSession | null {
  const session = loadGameSession();
  if (!session) return null;
  if (session.phase === "done") return session;
  if (session.phase !== "photo" && session.phase !== "photo_reveal") {
    return session;
  }
  if (!isPhotoHandFullyComplete(session)) return session;
  return finishPhotoHand();
}

/** Won photo ids not yet counted into the collection ledger. */
export function pendingCollectionPhotoIds(session: GameSession): string[] {
  const already = new Set(session.collectedPhotoIds ?? []);
  return session.wonPhotoIds.filter((id) => !already.has(id));
}

/**
 * Count newly awarded photo cards into the collection ledger, once each.
 * Every award path funnels through here — the win overlay claims "Added to your
 * Collection" as each Motion Card resolves, but a catalog miss there would
 * otherwise leave those ids uncounted until the hand settles.
 */
function recordAwardedPhotoCards(session: GameSession): GameSession {
  const pending = pendingCollectionPhotoIds(session);
  if (pending.length === 0) return session;
  const creatorName = session.packScratch?.creator ?? session.themes[0] ?? "Game";
  recordWonPhotoCards({
    count: pending.length,
    creatorId:
      session.packScratch?.creatorId?.trim() ||
      session.modelId?.trim() ||
      "",
    creatorName,
  });
  return {
    ...session,
    collectedPhotoIds: [...(session.collectedPhotoIds ?? []), ...pending],
  };
}

/**
 * Credit wallet (once), write collection, clear done session.
 * Safe to call from Collect, countdown, unmount, or shell exit.
 */
export function settleDonePhotoHand(
  addDiamonds: (amount: number) => void,
  addCoins: (amount: number) => void = () => undefined,
): boolean {
  const promoted = promoteCompletePhotoHand();
  const session = promoted ?? loadGameSession();
  if (!session || session.phase !== "done") return false;

  if (!session.walletCredited) {
    settleHubWalletFromSession(addDiamonds, addCoins);
  }

  const current = loadGameSession();
  if (current?.phase === "done") {
    // Normally a no-op — the award paths already counted these. Still the last
    // net for ids that missed the catalog on the way in. No save: the session
    // is cleared on the next line.
    recordAwardedPhotoCards(current);
    clearCompletedPhotoHand();
  }
  return true;
}

/** Drop a finished photo hand so Collection resume won't reopen the summary. */
export function clearCompletedPhotoHand(): boolean {
  const session = loadGameSession();
  if (!session || session.phase !== "done") return false;
  clearGameSession(gameSessionStorageKey(session));
  return true;
}
