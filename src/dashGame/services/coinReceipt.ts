/**
 * Coins credited during a game, held until the player lands on My Collection,
 * which opens the wallet popover with a "+N" receipt.
 *
 * Stored per user in sessionStorage so a full-page hop to /collection keeps it
 * and an account switch / logout cannot show another user's receipt.
 */

import { getAuthUserId } from "./auth";

const RECEIPT_KEY = "sugar.coinReceipt";

/** Fired on window with `{ coins }` — the visible CurrencyBalances opens. */
export const WALLET_REVEAL_EVENT = "sugar:wallet-reveal";

export type WalletRevealDetail = {
  coins: number;
  /** Set by the first wallet control that opens, so no second popover appears. */
  handled?: boolean;
};

type StoredReceipt = { ownerId: string | null; amount: number };

function readReceipt(): StoredReceipt | null {
  try {
    const raw = sessionStorage.getItem(RECEIPT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredReceipt>;
    const amount = Number(parsed.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return { ownerId: parsed.ownerId ?? null, amount };
  } catch {
    return null;
  }
}

function clearReceipt() {
  try {
    sessionStorage.removeItem(RECEIPT_KEY);
  } catch {
    // storage unavailable
  }
}

/** Add in-game coins to the pending receipt for `ownerId`. */
export function noteCoinsReceived(
  amount: number,
  ownerId: string | null = getAuthUserId(),
): void {
  if (!Number.isFinite(amount) || amount <= 0) return;
  const current = readReceipt();
  const base = current && current.ownerId === ownerId ? current.amount : 0;
  try {
    sessionStorage.setItem(
      RECEIPT_KEY,
      JSON.stringify({ ownerId, amount: base + amount }),
    );
  } catch {
    // storage unavailable
  }
}

/** Pending receipt amount for `ownerId` (0 if none / other owner). Always clears. */
export function takeCoinReceipt(
  ownerId: string | null = getAuthUserId(),
): number {
  const current = readReceipt();
  clearReceipt();
  if (!current || current.ownerId !== ownerId) return 0;
  return current.amount;
}

/** Ask the visible wallet control to open with a "+coins" receipt. */
export function requestWalletReveal(coins: number): void {
  if (typeof window === "undefined") return;
  if (!Number.isFinite(coins) || coins <= 0) return;
  window.dispatchEvent(
    new CustomEvent<WalletRevealDetail>(WALLET_REVEAL_EVENT, {
      detail: { coins },
    }),
  );
}
