import { apiMutate } from "@/lib/api";
import { getAuthUserId } from "@/services/auth";
import type { OpeningSession } from "@/services/purchase";

export type PackScratchLink = {
  readyPackId: string;
  packName: string;
  creator: string;
  /** Board creator id (`GET /api/me/creators/{id}/board`). Display name is `creator`. */
  creatorId?: string;
  coverUrl?: string;
  themeName?: string;
  openingSession: OpeningSession;
  /** Opening fan card id per motion card (parallel to motionCardIds). */
  openingCardIds: string[];
  /** Opening ids already written to collection ledger (fan scratch or motion settle). */
  settledOpeningIds: string[];
  /** Server pack opening row — required for reveal API during motion play. */
  serverOpeningId?: string;
  /** PackOpeningCard ids (parallel to openingCardIds) for server reveal. */
  serverRevealCardIds?: string[];
};

export const GAME_SESSION_KEY = "sugar_scratchie_game_v1";
const SESSIONS_STORE_KEY = "sugar_scratchie_sessions_v1";

export type GameSessionPhase =
  | "motion"
  | "photo_reveal"
  | "photo"
  | "done";

export type GameSession = {
  version: 1;
  phase: GameSessionPhase;
  /** Dealt motion card ids (unique themes), play order. */
  motionCardIds: string[];
  themes: string[];
  /** Model id for the first card (URL convenience). */
  modelId: string;
  completedMotionIds: string[];
  /** Accumulated photo-scratch prizes from motion match games. */
  photoPrizeTotal: number;
  /** Random photocards awarded after the motion hand. */
  wonPhotoIds: string[];
  /**
   * Won ids already counted into the collection ledger. The ledger is a plain
   * additive counter with no per-card dedupe, so the session has to remember
   * this or a hand gets counted again when it settles.
   */
  collectedPhotoIds?: string[];
  completedPhotoIds: string[];
  /** Accumulated diamonds from motion (and legacy photo) match games. */
  diamondTotal: number;
  /**
   * Diamonds from photo-hand scratches only (subset of diamondTotal).
   * Pack settle applies this — motion diamonds already hit the wallet via
   * reveal / PACK_OPENING_REWARD_EVENT and must not be re-applied.
   */
  photoDiamondTotal?: number;
  /** Accumulated coins from motion card wins (hub settle + pack tally). */
  coinTotal?: number;
  /**
   * True after hub wallet settle applied diamondTotal / coinTotal
   * (or pack photoDiamondTotal when openings already credited motion).
   */
  walletCredited: boolean;
  /** Set when motion play continues a pack opening from PurchaseFlow. */
  packScratch?: PackScratchLink;
  /** Photo Cards awarded by the Motion Card that just completed (legacy). */
  lastMotionWinPhotoIds?: string[];
  /** Result overlay waiting for auto-advance to the next motion card. */
  pendingMotionResult?: {
    cardId: string;
    /** Legacy field — motion wins no longer award photo cards. */
    photoIds: string[];
    coins: number;
    diamonds: number;
    prize: number;
    current: number;
    total: number;
  };
  /** Account that created this session — never PUT under a different user. */
  ownerUserId?: string;
};

function isGameSession(value: unknown): value is GameSession {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.phase === "string" &&
    Array.isArray(v.motionCardIds) &&
    Array.isArray(v.themes) &&
    typeof v.modelId === "string" &&
    Array.isArray(v.completedMotionIds) &&
    typeof v.photoPrizeTotal === "number" &&
    Array.isArray(v.wonPhotoIds) &&
    Array.isArray(v.completedPhotoIds) &&
    typeof v.diamondTotal === "number" &&
    (v.walletCredited === undefined || typeof v.walletCredited === "boolean")
  );
}

function normalizeGameSession(session: GameSession): GameSession {
  return {
    ...session,
    walletCredited: session.walletCredited === true,
    // Pre-currency sessions only stored photo-hand diamonds in diamondTotal.
    // New sessions always persist photoDiamondTotal (including 0), so `??`
    // must not treat an explicit 0 as missing.
    photoDiamondTotal: session.photoDiamondTotal ?? session.diamondTotal,
  };
}

type GameSessionStore = {
  version: 1;
  activeKey: string;
  byKey: Record<string, GameSession>;
};

function isGameSessionStore(value: unknown): value is GameSessionStore {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.activeKey === "string" &&
    !!v.byKey &&
    typeof v.byKey === "object"
  );
}

function emptyStore(): GameSessionStore {
  return { version: 1, activeKey: "hub", byKey: {} };
}

/** Storage bucket: pack readyPackId, or `hub` for GameHub-only sessions. */
export function gameSessionStorageKey(session: GameSession): string {
  return session.packScratch?.readyPackId ?? "hub";
}

function readStoreFromStorage(storage: Storage): GameSessionStore | null {
  try {
    const raw = storage.getItem(SESSIONS_STORE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isGameSessionStore(parsed)) return null;
    const byKey: Record<string, GameSession> = {};
    for (const [key, value] of Object.entries(parsed.byKey)) {
      if (isGameSession(value)) byKey[key] = normalizeGameSession(value);
    }
    return { version: 1, activeKey: parsed.activeKey, byKey };
  } catch {
    return null;
  }
}

function migrateLegacySingleSession(store: GameSessionStore): GameSessionStore {
  if (Object.keys(store.byKey).length > 0 || typeof window === "undefined") {
    return store;
  }
  for (const storage of [window.sessionStorage, window.localStorage]) {
    try {
      const raw = storage.getItem(GAME_SESSION_KEY);
      if (!raw) continue;
      const parsed: unknown = JSON.parse(raw);
      if (!isGameSession(parsed)) continue;
      const session = normalizeGameSession(parsed);
      const key = gameSessionStorageKey(session);
      return { version: 1, activeKey: key, byKey: { [key]: session } };
    } catch {
      continue;
    }
  }
  return store;
}

function readStore(): GameSessionStore {
  if (typeof window === "undefined") return emptyStore();
  const store =
    readStoreFromStorage(window.sessionStorage) ??
    readStoreFromStorage(window.localStorage) ??
    emptyStore();
  return migrateLegacySingleSession(store);
}

function writeStore(store: GameSessionStore): void {
  if (typeof window === "undefined") return;
  try {
    const payload = JSON.stringify(store);
    window.sessionStorage.setItem(SESSIONS_STORE_KEY, payload);
    window.localStorage.setItem(SESSIONS_STORE_KEY, payload);
    const active = store.byKey[store.activeKey];
    if (active) {
      const legacy = JSON.stringify(active);
      window.sessionStorage.setItem(GAME_SESSION_KEY, legacy);
      window.localStorage.setItem(GAME_SESSION_KEY, legacy);
    } else {
      window.sessionStorage.removeItem(GAME_SESSION_KEY);
      window.localStorage.removeItem(GAME_SESSION_KEY);
    }
  } catch {
    // Ignore quota / private mode.
  }
}

function setActiveStoreKey(key: string): GameSession | null {
  const store = readStore();
  const session = store.byKey[key];
  if (!session) return null;
  store.activeKey = key;
  writeStore(store);
  return session;
}

export function listStoredGameSessions(): GameSession[] {
  return Object.values(readStore().byKey);
}

/** The `hub` (GameHub-only) session, if one is stored. */
export function loadHubGameSession(): GameSession | null {
  return readStore().byKey.hub ?? null;
}

export function loadGameSessionForPack(readyPackId: string): GameSession | null {
  return readStore().byKey[readyPackId] ?? null;
}

export function activateGameSessionForPack(readyPackId: string): GameSession | null {
  return setActiveStoreKey(readyPackId);
}

export function loadGameSession(): GameSession | null {
  const store = readStore();
  return store.byKey[store.activeKey] ?? null;
}

export function saveGameSession(session: GameSession): void {
  if (typeof window === "undefined") return;
  const userId = getAuthUserId();
  if (session.ownerUserId && userId && session.ownerUserId !== userId) {
    return;
  }
  const next: GameSession = userId
    ? { ...session, ownerUserId: userId }
    : session;
  const store = readStore();
  const key = gameSessionStorageKey(next);
  store.byKey[key] = next;
  store.activeKey = key;
  writeStore(store);
  // Guests and foreign leftover sessions must not write /api/me/game-session.
  if (!userId) return;
  void apiMutate("/api/me/game-session", {
    method: "PUT",
    body: JSON.stringify(next),
  }).catch(() => undefined);
}

/** Drop every stored game session (logout / account switch). */
export function clearAllGameSessions(): void {
  if (typeof window === "undefined") return;
  writeStore(emptyStore());
  clearPracticeCards();
}

export function clearGameSession(key?: string): void {
  if (typeof window === "undefined") return;
  const store = readStore();
  const target = key ?? store.activeKey;
  delete store.byKey[target];
  const keys = Object.keys(store.byKey);
  if (store.activeKey === target) {
    store.activeKey = keys[0] ?? "hub";
  }
  writeStore(store);
}

export function isGameModeUrl(search = window.location.search): boolean {
  return new URLSearchParams(search).get("game") === "1";
}

/** Theme Free Play toggle — play the card without charging or minting rewards. */
export function isFreePlayUrl(search = window.location.search): boolean {
  return new URLSearchParams(search).get("freeplay") === "1";
}

/** First motion card in deal order that has not been scratched yet. */
export function firstMissingMotionCardId(session: GameSession): string | undefined {
  return session.motionCardIds.find(
    (id) => !session.completedMotionIds.includes(id),
  );
}

/** Theme label for a motion card in the session hand (parallel arrays). */
export function themeForMotionCard(
  session: GameSession,
  cardId: string,
): string | undefined {
  const index = session.motionCardIds.indexOf(cardId);
  if (index < 0) return undefined;
  return session.themes[index];
}

export function motionPlayHref(session: GameSession, cardId?: string): string {
  const id = cardId ?? firstMissingMotionCardId(session) ?? session.motionCardIds[0] ?? "";
  const params = new URLSearchParams();
  if (session.modelId) params.set("model", session.modelId);
  if (id) params.set("card", id);
  params.set("game", "1");
  return `/game?${params.toString()}`;
}

export function firstMissingPhotoCardId(session: GameSession): string | undefined {
  return session.wonPhotoIds.find(
    (id) => !session.completedPhotoIds.includes(id),
  );
}

export function photoPlayHref(session: GameSession, cardId?: string): string {
  const id =
    cardId ?? firstMissingPhotoCardId(session) ?? session.wonPhotoIds[0] ?? "";
  const params = new URLSearchParams();
  if (id) params.set("card", id);
  params.set("game", "1");
  return `/photo-scratch?${params.toString()}`;
}

/**
 * Explicit free-play hands only (theme toggle). Owning a card no longer
 * zeroes coins or diamonds — every paid play awards.
 * Scoped per signed-in user so flags do not leak across logout / switch.
 */
const practiceCardIdsByOwner = new Map<string, Set<string>>();

function practiceCardsForOwner(ownerId: string | null = getAuthUserId()): Set<string> {
  const owner = ownerId?.trim() || "";
  if (!owner) return new Set();
  let set = practiceCardIdsByOwner.get(owner);
  if (!set) {
    set = new Set();
    practiceCardIdsByOwner.set(owner, set);
  }
  return set;
}

export function setPracticeCard(cardId: string, practice: boolean): void {
  const id = cardId.trim();
  if (!id) return;
  const set = practiceCardsForOwner();
  if (practice) set.add(id);
  else set.delete(id);
}

export function isPracticeCard(cardId: string): boolean {
  const id = cardId.trim();
  if (!id) return false;
  return practiceCardsForOwner().has(id);
}

/** Drop in-memory practice flags (logout / account switch). */
export function clearPracticeCards(): void {
  practiceCardIdsByOwner.clear();
}

/** Coins shown/awarded for a motion win when no pack opening reward exists. */
export const MOTION_COINS_PER_PRIZE = 50;

export function coinsForMotionPrize(
  prize: number,
  packRewardCoins = 0,
  opts?: { packLinked?: boolean },
): number {
  if (prize <= 0) return 0;
  if (opts?.packLinked) return Math.max(0, packRewardCoins);
  return Math.max(0, prize) * MOTION_COINS_PER_PRIZE;
}

export function diamondsForMotionPrize(prize: number): number {
  return Math.max(0, Math.floor(prize));
}

export function beginPhotoPhase(): GameSession | null {
  const session = loadGameSession();
  if (!session) return null;
  if (session.phase !== "photo_reveal" && session.phase !== "photo") {
    return session;
  }
  const next: GameSession = { ...session, phase: "photo" };
  saveGameSession(next);
  return next;
}

type GameNavigateFn = (to: string) => void;

let gameNavigate: GameNavigateFn | null = null;

/** Wire react-router's navigate from AppShell so AudioContext survives SPA hops. */
export function bindGameNavigate(fn: GameNavigateFn | null): void {
  gameNavigate = fn;
}

/**
 * In-app navigation. Must stay on the same document (no full reload) so a
 * Safari AudioContext unlocked on Play/Continue survives into the next
 * scratch screen.
 */
export function navigateTo(href: string): void {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin) {
    window.location.assign(href);
    return;
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (gameNavigate) {
    gameNavigate(next);
    window.scrollTo(0, 0);
    return;
  }
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) {
    window.history.pushState(null, "", next);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}
