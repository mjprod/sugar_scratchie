import {
  loadGameCatalog,
  pickWonPhotocards,
  type ThemedMotionCard,
} from "./session";

export const GAME_SESSION_KEY = "sugar_scratchie_game_v1";

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
  completedPhotoIds: string[];
  /** Accumulated diamonds from photo match games. */
  diamondTotal: number;
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
    typeof v.diamondTotal === "number"
  );
}

export function loadGameSession(): GameSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(GAME_SESSION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isGameSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveGameSession(session: GameSession): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(GAME_SESSION_KEY, JSON.stringify(session));
  } catch {
    // Ignore quota / private mode.
  }
}

export function clearGameSession(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(GAME_SESSION_KEY);
  } catch {
    // ignore
  }
}

export function isGameModeUrl(search = window.location.search): boolean {
  return new URLSearchParams(search).get("game") === "1";
}

export function startMotionSession(hand: ThemedMotionCard[]): GameSession {
  const first = hand[0];
  const session: GameSession = {
    version: 1,
    phase: "motion",
    motionCardIds: hand.map((card) => card.id),
    themes: hand.map((card) => card.theme),
    modelId: first?.model_id?.trim() || "",
    completedMotionIds: [],
    photoPrizeTotal: 0,
    wonPhotoIds: [],
    completedPhotoIds: [],
    diamondTotal: 0,
  };
  saveGameSession(session);
  return session;
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
  return `/?${params.toString()}`;
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

/** Record a finished motion card and its photo-scratch prize units. */
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

/** After all motion cards: pick random photocards and move to reveal. */
export async function finishMotionHand(): Promise<GameSession | null> {
  const session = loadGameSession();
  if (!session) return null;
  if (session.phase !== "motion") return session;

  const catalog = await loadGameCatalog();
  const won = pickWonPhotocards(
    catalog.photos,
    session.photoPrizeTotal,
    session.themes,
  );
  const next: GameSession = {
    ...session,
    phase: "photo_reveal",
    wonPhotoIds: won.map((photo) => photo.id),
  };
  saveGameSession(next);
  return next;
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

export function recordPhotoCardResult(
  cardId: string,
  diamonds: number,
): GameSession | null {
  const session = loadGameSession();
  if (!session || session.phase !== "photo") return session;
  if (session.completedPhotoIds.includes(cardId)) return session;
  const next: GameSession = {
    ...session,
    completedPhotoIds: [...session.completedPhotoIds, cardId],
    diamondTotal: session.diamondTotal + Math.max(0, diamonds),
  };
  saveGameSession(next);
  return next;
}

export function finishPhotoHand(): GameSession | null {
  const session = loadGameSession();
  if (!session) return null;
  const next: GameSession = { ...session, phase: "done" };
  saveGameSession(next);
  return next;
}

export function navigateTo(href: string): void {
  window.location.assign(href);
}
