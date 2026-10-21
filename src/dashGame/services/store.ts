import { ApiError, apiFetch, apiMutate } from "../lib/api";
import { isDemoMode } from "../lib/demo";

export type StoreBadge =
  | "FREE"
  | "Best Value"
  | "Popular"
  | "Limited Time"
  | "Bonus"
  | "New";

export type StoreProductKind = "rewarded-ad" | "diamonds";

/** Soft-currency exchange — intentionally worse $/Diamond than cash at higher tiers (GD-AC22). */
export const COIN_EXCHANGE_OPTIONS = [
  { id: "x100", diamonds: 100, coins: 100 },
  { id: "x500", diamonds: 500, coins: 780 },
  { id: "x1200", diamonds: 1200, coins: 2400 },
  { id: "x2500", diamonds: 2500, coins: 5800 },
  { id: "x5000", diamonds: 5000, coins: 13000 },
] as const;

export type CoinExchangeOption = (typeof COIN_EXCHANGE_OPTIONS)[number];

/** Highest diamond tier the player can afford with current Coins. */
export function bestAffordableCoinExchange(
  coinBalance: number,
): CoinExchangeOption | null {
  if (!Number.isFinite(coinBalance) || coinBalance <= 0) return null;
  let best: CoinExchangeOption | null = null;
  for (const option of COIN_EXCHANGE_OPTIONS) {
    if (coinBalance < option.coins) continue;
    if (!best || option.diamonds > best.diamonds) best = option;
  }
  return best;
}

/** Compact amount only for hover UI, e.g. "+5K" / "+500" (icon shown separately). */
export function formatExchangeDiamondAmount(diamonds: number): string {
  if (!Number.isFinite(diamonds) || diamonds <= 0) return "+0";
  if (diamonds >= 1000 && diamonds % 1000 === 0) {
    return `+${diamonds / 1000}K`;
  }
  if (diamonds >= 1000) {
    const compact = (diamonds / 1000).toFixed(diamonds % 100 === 0 ? 1 : 2);
    return `+${compact.replace(/\.0$/, "")}K`;
  }
  return `+${diamonds.toLocaleString("en-US")}`;
}

/** Screen-reader / aria form, e.g. "+5K Diamonds". */
export function formatExchangeDiamondPreview(diamonds: number): string {
  return `${formatExchangeDiamondAmount(diamonds)} Diamonds`;
}

export type CoinExchangeResult =
  | { status: "success"; diamonds: number; coins: number }
  | { status: "failed"; message: string };

function resolveCoinExchangeOption(
  option: CoinExchangeOption | { id?: string; diamonds: number; coins: number },
): CoinExchangeOption | null {
  const byId =
    option.id != null
      ? COIN_EXCHANGE_OPTIONS.find((entry) => entry.id === option.id)
      : undefined;
  if (byId) return byId;
  return (
    COIN_EXCHANGE_OPTIONS.find(
      (entry) =>
        entry.diamonds === option.diamonds && entry.coins === option.coins,
    ) ?? null
  );
}

/**
 * Dust → Diamonds exchange.
 * Live path persists via POST /api/store/exchange and returns server wallet.
 * Demo path applies the tier locally so HUD still works offline.
 */
export async function exchangeCoinsForDiamonds(
  option: CoinExchangeOption | { id?: string; diamonds: number; coins: number },
  current?: { diamonds: number; coins: number },
): Promise<CoinExchangeResult> {
  const resolved = resolveCoinExchangeOption(option);
  if (!resolved) {
    return { status: "failed", message: "That exchange option is unavailable." };
  }
  if (
    current &&
    (!Number.isFinite(current.coins) || current.coins < resolved.coins)
  ) {
    return { status: "failed", message: "Not enough Coins." };
  }

  try {
    const data = await apiMutate<{
      diamonds?: number;
      coins?: number;
      wallet?: { diamonds?: number; coins?: number };
    }>("/api/store/exchange", {
      method: "POST",
      headers: {
        "Idempotency-Key":
          globalThis.crypto?.randomUUID?.() ??
          `exchange-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
      body: JSON.stringify({
        optionId: resolved.id,
        diamonds: resolved.diamonds,
        coins: resolved.coins,
      }),
    });
    const diamonds = data.wallet?.diamonds ?? data.diamonds;
    const coins = data.wallet?.coins ?? data.coins;
    if (
      typeof diamonds === "number" &&
      Number.isFinite(diamonds) &&
      typeof coins === "number" &&
      Number.isFinite(coins)
    ) {
      return {
        status: "success",
        diamonds: Math.max(0, Math.trunc(diamonds)),
        coins: Math.max(0, Math.trunc(coins)),
      };
    }
  } catch (error) {
    if (error instanceof ApiError) {
      const code = error.message.toLowerCase();
      if (error.status === 400 && code.includes("insufficient")) {
        return { status: "failed", message: "Not enough Coins." };
      }
      if (error.status === 409 && code.includes("exchange_rate_changed")) {
        return {
          status: "failed",
          message: "Exchange rates changed. Refresh and try again.",
        };
      }
    }
  }

  if (isDemoMode() && current) {
    return {
      status: "success",
      diamonds: current.diamonds + resolved.diamonds,
      coins: Math.max(0, current.coins - resolved.coins),
    };
  }

  return {
    status: "failed",
    message: "Exchange could not be completed. Please try again.",
  };
}

export const DAILY_AD_LIMIT = 3;

export type StoreProduct = {
  id: string;
  kind: StoreProductKind;
  title: string;
  /** Short line under the title for rewarded ads / bonuses. */
  subtitle?: string;
  priceLabel: string;
  /** Diamonds granted on success (inclusive of bonusDiamonds when present). */
  diamonds: number;
  /**
   * Explanatory bonus portion already included in `diamonds` (GD-AC10).
   * Display only — not added again on purchase.
   */
  bonusDiamonds?: number;
  /** Bonus Coins granted with this product (not shown on cash package cards). */
  coins?: number;
  badge?: StoreBadge;
  /** Artwork URL — CSS fallback used when empty. */
  artworkUrl?: string;
  /** Remote display order — ascending. */
  order: number;
  available: boolean;
};

export type StoreLoadResult =
  | { status: "ok"; products: StoreProduct[] }
  | { status: "empty" }
  | { status: "error"; message: string };

/** Gateway-side outcomes before Sugar verifies the payment. */
export type GatewayOutcome =
  | "completed"
  | "cancelled"
  | "closed"
  | "failed"
  | "pending";

/**
 * Purchase session — created before redirecting to the payment provider.
 * Sugar never handles card details; this only tracks order + verification.
 */
export type PurchaseSession = {
  id: string;
  productId: string;
  productTitle: string;
  priceLabel: string;
  diamonds: number;
  coins: number;
  createdAt: number;
  /** Set when the gateway returns the user to Sugar. */
  gatewayOutcome?: GatewayOutcome;
  /** Set after Sugar verifies with the payment provider. */
  verifiedStatus?: VerifiedPaymentStatus;
  /** Credits already applied — prevents double grant on resume. */
  credited?: boolean;
};

export type VerifiedPaymentStatus =
  | "confirmed"
  | "pending"
  | "failed"
  | "cancelled";

export type VerifyResult =
  | {
      status: "confirmed";
      session: PurchaseSession;
      diamonds: number;
      coins: number;
    }
  | { status: "pending"; session: PurchaseSession }
  | { status: "failed"; session: PurchaseSession; message: string }
  | { status: "cancelled"; session: PurchaseSession }
  | { status: "closed"; session: PurchaseSession };

export type AdClaimResult =
  | { status: "success"; diamonds: number; coins: number }
  | { status: "failed"; message: string };

const SESSION_KEY = "sugar.v8.storePurchase";
const SESSION_TTL_MS = 1000 * 60 * 30;

/**
 * Fixture catalog for `?demo=1` only. Live store uses `/api/store/products`.
 */
const CATALOG: StoreProduct[] = [
  {
    id: "ad-daily",
    kind: "rewarded-ad",
    title: "Watch Ad",
    subtitle: "Earn 100 free Diamonds",
    priceLabel: "Free",
    diamonds: 100,
    coins: 5,
    badge: "FREE",
    order: 1,
    available: true,
  },
  {
    id: "d100",
    kind: "diamonds",
    title: "100 Diamonds",
    priceLabel: "$3.99",
    diamonds: 100,
    order: 2,
    available: true,
  },
  {
    id: "d500",
    kind: "diamonds",
    title: "500 Diamonds",
    priceLabel: "$7.99",
    diamonds: 500,
    badge: "Popular",
    order: 3,
    available: true,
  },
  {
    id: "d1200",
    kind: "diamonds",
    title: "1200 Diamonds",
    priceLabel: "$19.99",
    diamonds: 1200,
    bonusDiamonds: 200,
    badge: "Best Value",
    order: 4,
    available: true,
  },
  {
    id: "d2500",
    kind: "diamonds",
    title: "2500 Diamonds",
    priceLabel: "$39.99",
    diamonds: 2500,
    bonusDiamonds: 500,
    badge: "Bonus",
    order: 5,
    available: true,
  },
  {
    id: "d5000",
    kind: "diamonds",
    title: "5000 Diamonds",
    priceLabel: "$69.99",
    diamonds: 5000,
    bonusDiamonds: 1200,
    order: 6,
    available: true,
  },
];

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Demo flags: `?store=empty|error` and `?pay=fail|pending|cancel` */
function queryFlag(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(name);
}

function normalizeProductCoins(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return undefined;
}

function normalizeStoreProduct(product: StoreProduct): StoreProduct {
  const coins = normalizeProductCoins(product.coins);
  const bonusDiamonds = normalizeProductCoins(product.bonusDiamonds);
  let next = product;
  if (coins !== undefined) next = { ...next, coins };
  if (bonusDiamonds !== undefined) next = { ...next, bonusDiamonds };
  return next;
}

export function listAvailableProducts(source: StoreProduct[] = CATALOG): StoreProduct[] {
  return source
    .filter((product) => product.available)
    .map(normalizeStoreProduct)
    .slice()
    .sort((a, b) => a.order - b.order);
}

export function findStoreProduct(productId: string): StoreProduct | undefined {
  return CATALOG.find((product) => product.id === productId && product.available);
}

/** Sync snapshot for initial UI paint. */
function loadStoreCatalog(): StoreLoadResult {
  const mode = queryFlag("store");
  if (mode === "error") {
    return { status: "error", message: "Unable to load store items." };
  }
  if (mode === "empty") return { status: "empty" };
  if (!isDemoMode()) {
    return { status: "empty" };
  }
  const products = listAvailableProducts();
  if (!products.length) return { status: "empty" };
  return { status: "ok", products };
}

export function peekStoreProducts(): StoreLoadResult {
  return loadStoreCatalog();
}

export async function fetchStoreProducts(): Promise<StoreLoadResult> {
  const mode = queryFlag("store");
  if (mode === "error") {
    return { status: "error", message: "Unable to load store items." };
  }
  if (mode === "empty") return { status: "empty" };
  const remote = await apiFetch<{ products: StoreProduct[] }>("/api/store/products");
  if (remote?.products) {
    const products = listAvailableProducts(remote.products);
    if (!products.length) return { status: "empty" };
    return { status: "ok", products };
  }
  if (isDemoMode()) {
    const products = listAvailableProducts();
    if (!products.length) return { status: "empty" };
    return { status: "ok", products };
  }
  return { status: "error", message: "Unable to load store items." };
}

function newSessionId() {
  return `ps_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Create a purchase session before handing off to the payment provider. */
export async function createPurchaseSession(
  product: StoreProduct,
): Promise<PurchaseSession> {
  if (product.kind !== "diamonds") {
    throw new Error("Only paid products create a payment session.");
  }
  try {
    const data = await apiMutate<{ session: PurchaseSession }>(
      "/api/store/purchases",
      {
        method: "POST",
        body: JSON.stringify({ product_id: product.id }),
      },
    );
    savePurchaseSession(data.session);
    return data.session;
  } catch (error) {
    if (!isDemoMode()) throw error;
    const session: PurchaseSession = {
      id: newSessionId(),
      productId: product.id,
      productTitle: product.title,
      priceLabel: product.priceLabel,
      diamonds: product.diamonds,
      coins: product.coins ?? 0,
      createdAt: Date.now(),
    };
    savePurchaseSession(session);
    return session;
  }
}

export function savePurchaseSession(session: PurchaseSession) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* ignore */
  }
}

export function clearPurchaseSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export function loadPurchaseSession(): PurchaseSession | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PurchaseSession;
    if (!parsed?.id || !parsed.productId || !parsed.createdAt) {
      clearPurchaseSession();
      return null;
    }
    if (Date.now() - parsed.createdAt > SESSION_TTL_MS) {
      clearPurchaseSession();
      return null;
    }
    return parsed;
  } catch {
    clearPurchaseSession();
    return null;
  }
}

/**
 * Record the gateway return, then verify payment with the provider.
 * Credits are only safe after `confirmed` — callers must check `credited`.
 */
export async function returnFromGateway(
  session: PurchaseSession,
  outcome: GatewayOutcome,
): Promise<VerifyResult> {
  const updated: PurchaseSession = { ...session, gatewayOutcome: outcome };
  savePurchaseSession(updated);
  await wait(1200);

  // Demo override after a successful-looking gateway tap.
  const pay = queryFlag("pay");
  let resolved: GatewayOutcome = outcome;
  if (outcome === "completed" && pay === "fail") resolved = "failed";
  if (outcome === "completed" && pay === "pending") resolved = "pending";
  if (outcome === "completed" && pay === "cancel") resolved = "cancelled";

  if (resolved === "closed") {
    const next = { ...updated, verifiedStatus: undefined };
    savePurchaseSession(next);
    return { status: "closed", session: next };
  }

  if (resolved === "cancelled") {
    const next: PurchaseSession = { ...updated, verifiedStatus: "cancelled" };
    clearPurchaseSession();
    return { status: "cancelled", session: next };
  }

  if (resolved === "failed") {
    const next: PurchaseSession = { ...updated, verifiedStatus: "failed" };
    clearPurchaseSession();
    return {
      status: "failed",
      session: next,
      message: "Payment could not be verified. No Diamonds were added.",
    };
  }

  if (resolved === "pending") {
    const next: PurchaseSession = { ...updated, verifiedStatus: "pending" };
    savePurchaseSession(next);
    return { status: "pending", session: next };
  }

  // Confirmed — mark credited in the same write so a resume cannot double-grant.
  if (updated.credited) {
    const next: PurchaseSession = { ...updated, verifiedStatus: "confirmed" };
    clearPurchaseSession();
    return {
      status: "confirmed",
      session: next,
      diamonds: 0,
      coins: 0,
    };
  }

  try {
    const verified = await apiMutate<{
      status: VerifiedPaymentStatus | "closed";
      session: PurchaseSession;
      diamonds?: number;
      coins?: number;
      message?: string;
    }>(`/api/store/purchases/${session.id}/verify`, {
      method: "POST",
      body: JSON.stringify({ outcome: resolved }),
    });
    if (verified.status === "confirmed") {
      clearPurchaseSession();
      return {
        status: "confirmed",
        session: { ...verified.session, credited: true },
        diamonds: verified.diamonds ?? session.diamonds,
        coins: verified.coins ?? session.coins,
      };
    }
    if (verified.status === "pending") {
      const next: PurchaseSession = {
        ...updated,
        ...verified.session,
        verifiedStatus: "pending",
      };
      savePurchaseSession(next);
      return { status: "pending", session: next };
    }
    if (verified.status === "cancelled") {
      const next: PurchaseSession = { ...updated, verifiedStatus: "cancelled" };
      clearPurchaseSession();
      return { status: "cancelled", session: next };
    }
    if (verified.status === "closed") {
      const next = { ...updated, verifiedStatus: undefined };
      savePurchaseSession(next);
      return { status: "closed", session: next };
    }
    const next: PurchaseSession = { ...updated, verifiedStatus: "failed" };
    clearPurchaseSession();
    return {
      status: "failed",
      session: next,
      message:
        verified.message ??
        "Payment could not be verified. No Diamonds were added.",
    };
  } catch {
    if (!isDemoMode()) {
      const next: PurchaseSession = { ...updated, verifiedStatus: "failed" };
      clearPurchaseSession();
      return {
        status: "failed",
        session: next,
        message: "Payment could not be verified. No Diamonds were added.",
      };
    }
  }

  if (!isDemoMode()) {
    const next: PurchaseSession = { ...updated, verifiedStatus: "failed" };
    clearPurchaseSession();
    return {
      status: "failed",
      session: next,
      message: "Payment could not be verified. No Diamonds were added.",
    };
  }

  const next: PurchaseSession = {
    ...updated,
    verifiedStatus: "confirmed",
    credited: true,
  };
  clearPurchaseSession();
  return {
    status: "confirmed",
    session: next,
    diamonds: next.diamonds,
    coins: next.coins,
  };
}

/** Resume an unfinished session after the user temporarily left Sugar. */
export async function resumePurchaseSession(
  session: PurchaseSession,
): Promise<
  | VerifyResult
  | { status: "resume-gateway"; session: PurchaseSession }
  | { status: "resume-verify"; session: PurchaseSession; outcome: GatewayOutcome }
> {
  // Already waiting on the bank — show pending, don't auto-charge again.
  if (session.verifiedStatus === "pending") {
    return { status: "pending", session };
  }
  // Gateway already returned an outcome but Sugar hadn't finished verifying.
  if (session.gatewayOutcome && session.gatewayOutcome !== "closed") {
    return {
      status: "resume-verify",
      session,
      outcome: session.gatewayOutcome,
    };
  }
  // Still on the payment provider — reopen the card form.
  return { status: "resume-gateway", session };
}

/** Rewarded ads never touch the payment gateway. */
export async function claimRewardedAd(product: StoreProduct): Promise<AdClaimResult> {
  if (queryFlag("store") === "fail") {
    return {
      status: "failed",
      message: "Reward could not be claimed. Please try again.",
    };
  }
  try {
    const data = await apiMutate<{
      status: "success";
      diamonds: number;
      coins: number;
    }>(`/api/store/ads/${product.id}/claim`, { method: "POST" });
    return {
      status: "success",
      diamonds: data.diamonds,
      coins: data.coins,
    };
  } catch {
    if (isDemoMode()) {
      return {
        status: "success",
        diamonds: product.diamonds,
        coins: product.coins ?? 0,
      };
    }
    return {
      status: "failed",
      message: "Reward could not be claimed. Please try again.",
    };
  }
}
