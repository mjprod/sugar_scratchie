/**
 * Scratch sparkle coin awards — optimistic local credit + server persist.
 * Hands are server-issued; amounts are rolled server-side. Client amount is
 * only used for optimistic UI.
 *
 * Persist is fire-and-forget. Do not merge the response wallet into client
 * state — a stale snapshot wipes locally-credited diamonds, can re-credit
 * spent coins, and can leak a balance across logout / account switch.
 * `refreshWallet` remains the later source of truth.
 */

import { ApiError, apiMutate } from "../lib/api";
import { getAuthUserId } from "./auth";

/** Optimistic floor/ceil — single source in sparkleCoinAward (must match backend). */
export {
  SCRATCH_COIN_MAX,
  SCRATCH_COIN_MIN,
} from "../features/game/modules/sparkleCoinAward";

export type ScratchWallet = { diamonds: number; coins: number };

export type ScratchHandResult = {
  handId: string;
  /** False only for an explicit free-play hand: the server mints nothing. */
  rewardsEnabled: boolean;
  milestonesRemaining: number;
  /** Present on older servers that counted a daily hand cap. Unused. */
  handsRemainingToday?: number;
  /** "coins" on standard cards, "diamonds" on Premium / Ultra. */
  currency?: "coins" | "diamonds";
  maxWin?: number;
};

export type ScratchCoinClaimResult = {
  ok: true;
  coins: number;
  diamonds?: number;
  /** Which balance this claim paid. Absent on older responses — treat as coins. */
  currency?: "coins" | "diamonds";
  alreadyClaimed?: boolean;
  wallet: ScratchWallet;
};

export type ScratchCoinClaimBody = {
  handId: string;
  milestone: number;
  cardId?: string;
  /** Optimistic UI only — server ignores and rolls its own amount. */
  amount?: number;
};

/**
 * Scratch hands are not daily-capped. These helpers stay for tests; a 429
 * fails only the start that received it.
 */
export const SCRATCH_HAND_QUOTA_BACKOFF_MS = 15 * 60 * 1000;

/** Set on 429; only blocks starts for the same account until `until`. */
let scratchHandQuotaBlock: { ownerId: string | null; until: number } | null =
  null;
const scratchHandInFlight = new Map<
  string,
  Promise<ScratchHandResult | null>
>();
/** Cards that already received a hand this session. A later open is a replay. */
const scratchHandIssued = new Set<string>();

/**
 * Client wallet after a scratch-coin persist response.
 * Always keeps the local balances: optimistic addCoins is the HUD credit,
 * and refreshWallet is the later source of truth.
 */
export function nextWalletAfterScratchPersist(
  local: ScratchWallet,
  _remote: ScratchWallet | null | undefined,
  _opts: { authed: boolean },
): ScratchWallet {
  // Remote snapshots are never merged — see module doc.
  return local;
}

/**
 * True while a recent 429 for this account is still inside its backoff.
 * A different (or signed-out) account, or an expired backoff, clears it.
 */
export function isScratchHandQuotaExhausted(
  ownerId: string | null = getAuthUserId(),
  now: number = Date.now(),
): boolean {
  const block = scratchHandQuotaBlock;
  if (!block) return false;
  if (block.ownerId !== ownerId || now >= block.until) {
    scratchHandQuotaBlock = null;
    return false;
  }
  return true;
}

/** Record a quota 429 for `ownerId` (exported for self-checks). */
export function markScratchHandQuotaExhausted(
  ownerId: string | null = getAuthUserId(),
  now: number = Date.now(),
): void {
  scratchHandQuotaBlock = { ownerId, until: now + SCRATCH_HAND_QUOTA_BACKOFF_MS };
}

/** Test helper — reset module quota / in-flight state. */
export function resetScratchHandQuotaForTests(): void {
  scratchHandQuotaBlock = null;
  scratchHandInFlight.clear();
  scratchHandIssued.clear();
}

/** True once this card has been issued a hand for the signed-in user. */
export function scratchHandAlreadyIssued(
  cardId?: string,
  ownerId: string | null = getAuthUserId(),
): boolean {
  const id = cardId?.trim();
  if (!id) return false;
  return scratchHandIssued.has(`${ownerId ?? ""}:${id}`);
}

/**
 * Ask the server for a new scratch hand id.
 * `visit` distinguishes a replay of the same card — its previous hand is
 * already claimed, so sharing that in-flight request would mint no coins.
 */
export function startScratchHand(
  cardId?: string,
  opts?: { freePlay?: boolean; visit?: number },
): Promise<ScratchHandResult | null> {
  const ownerId = getAuthUserId();
  const freePlay = Boolean(opts?.freePlay);
  const visit = opts?.visit ?? 0;
  const key = `${ownerId ?? ""}:${freePlay ? "free:" : ""}${cardId?.trim() || ""}:${visit}`;
  const pending = scratchHandInFlight.get(key);
  if (pending) return pending;

  let settle!: (value: ScratchHandResult | null) => void;
  const request = new Promise<ScratchHandResult | null>((resolve) => {
    settle = resolve;
  });
  scratchHandInFlight.set(key, request);

  void (async () => {
    try {
      const hand = await apiMutate<ScratchHandResult>(
        "/api/rewards/scratch/hands",
        {
          method: "POST",
          body: JSON.stringify({
            ...(cardId ? { cardId } : {}),
            ...(freePlay ? { freePlay: true } : {}),
          }),
        },
      );
      if (hand?.handId && cardId?.trim()) {
        scratchHandIssued.add(`${ownerId ?? ""}:${cardId.trim()}`);
      }
      settle(hand);
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        try {
          if (import.meta.env?.DEV) {
            console.warn("[scratchCoinReward] hand start was rate-limited");
          }
        } catch {
          // import.meta.env unavailable outside Vite
        }
        settle(null);
        return;
      }
      try {
        if (import.meta.env?.DEV) {
          console.warn("[scratchCoinReward] start hand failed", error);
        }
      } catch {
        // ignore
      }
      settle(null);
    } finally {
      scratchHandInFlight.delete(key);
    }
  })();

  return request;
}

export type ScratchCoinAwardAction = "skip" | "hold" | "persist" | "local";

/**
 * Paid-hand sparkle coins must not hit the HUD until they can be persisted.
 * AutoScratch / a fast first stroke can cross 10% bands while
 * `POST /hands` is still in flight (or after quota/start failure). Optimistic
 * `addCoins` without persist is then wiped by `refreshWallet`, and the
 * already-consumed progress bands are never claimed.
 *
 * `hold` — signed-in, waiting for a server hand: queue milestones and flush
 *           when `handId` arrives.
 * `persist` — have a hand: credit + POST.
 * `local` — guest juice only (no wallet refresh to wipe it).
 * `skip` — practice, or coins disabled for this hand (quota spent or hand
 *          start failed): no coins. Free play is not a skip — the caller shows
 *          the win and gives the wallet back when the card ends. Only coins —
 *          diamonds / card prizes are gated by `practice` alone in the callers.
 */
export function scratchCoinAwardAction(input: {
  freePlay: boolean;
  practice: boolean;
  coinsDisabled: boolean;
  authed: boolean;
  handId: string;
}): ScratchCoinAwardAction {
  if (input.practice || input.coinsDisabled) return "skip";
  if (!input.authed) return "local";
  if (input.handId.trim()) return "persist";
  return "hold";
}

/** Persist a milestone award. Callers should optimistic-addCoins first. */
export async function claimScratchCoins(
  body: ScratchCoinClaimBody,
): Promise<ScratchCoinClaimResult | null> {
  try {
    return await apiMutate<ScratchCoinClaimResult>(
      "/api/rewards/scratch/coins",
      {
        method: "POST",
        body: JSON.stringify({
          handId: body.handId,
          milestone: body.milestone,
          ...(body.cardId ? { cardId: body.cardId } : {}),
        }),
      },
    );
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn("[scratchCoinReward] persist failed", error);
    }
    return null;
  }
}

/** Fire-and-forget persist. Does not write the response into the client wallet. */
export function persistScratchCoins(body: ScratchCoinClaimBody): void {
  void claimScratchCoins(body);
}
