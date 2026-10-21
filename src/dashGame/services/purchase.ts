import { ApiError, apiFetch, apiMutate } from "../lib/api";
import { isDemoMode } from "../lib/demo";

export type PackQuantity = 1 | 5;

/** Pack handed to the purchase / opening flow. */
export type PurchaseFlowPack = {
  packId: string;
  packName: string;
  price: string;
  creator: string;
  /** Collection theme label when distinct from packName (e.g. Cyber Nights). */
  themeName?: string;
  /**
   * purchase — buy then open
   * open — open an owned sealed pack
   * scratch — resume Ready-to-Scratch (never replays pack opening)
   * cart-tear — open remaining cart packs on the Tear stage
   */
  entry?: "purchase" | "open" | "scratch" | "cart-tear";
  /** Remaining unopened packs — drives the "No Remaining Packs" state. */
  unopenedPacks?: number;
  /** Cart leftovers to open on Tear (video faces included). */
  cartFoils?: Array<{
    id: string;
    label: string;
    videoUrl: string;
    slot?: 1 | 2;
  }>;
  /** Specific owned pack instance when resuming Open Pack. */
  instanceId?: string;
  /** Purchase transaction id — used for multi-pack continuation. */
  purchaseId?: string;
  /** Cart tear queue — open order when checkout spans multiple purchases. */
  tearInstanceIds?: string[];
};

export type OpeningCard = {
  id: string;
  rarity: "Rare" | "Super Rare" | "Ultra Rare";
  reward: number;
  /** Optional designed face (foil video / image from the model API). */
  faceUrl?: string;
  /** Real card dealt by the pack — absent on older openings. */
  cardKind?: string;
  cardId?: string;
  photoSlotId?: string;
};

export type OpeningSession = {
  quantity: PackQuantity;
  diamondCost: number;
  cards: OpeningCard[];
  /** Foil face used on Pack Ready after the user picks a pack. */
  foilFaceUrl?: string;
  foilLabel?: string;
};

export const PACK_OPTIONS: {
  quantity: PackQuantity;
  label: string;
  detail: string;
}[] = [
  { quantity: 1, label: "Play 1 Pack", detail: "3 scratch cards" },
  { quantity: 5, label: "Play 5 Packs", detail: "Bundle preview" },
];

export type CatalogPackProduct = {
  id: string;
  modelId?: string | null;
  diamondCost?: number | null;
};

let packCatalogPromise: Promise<CatalogPackProduct[]> | null = null;
let packCatalogCache: CatalogPackProduct[] | null = null;

/** Live pack products from GET /api/packs (ids like `julianaval-pack`). */
export async function loadPackCatalog(): Promise<CatalogPackProduct[]> {
  if (packCatalogCache) return packCatalogCache;
  packCatalogPromise ??= (async () => {
    const data = await apiFetch<{ packs?: CatalogPackProduct[] }>("/api/packs");
    const packs =
      data && Array.isArray(data.packs)
        ? data.packs.filter(
            (pack): pack is CatalogPackProduct =>
              Boolean(pack) && typeof pack.id === "string" && Boolean(pack.id.trim()),
          )
        : [];
    packCatalogCache = packs;
    return packs;
  })();
  try {
    return await packCatalogPromise;
  } catch {
    packCatalogPromise = null;
    return packCatalogCache ?? [];
  }
}

/**
 * Map UI pack/model/foil ids onto the purchasable catalog product id.
 * CoverFlow/Browse often pass `julianaval` or `julianaval-1`; the API sells `julianaval-pack`.
 */
export function resolvePurchasePackId(
  packs: CatalogPackProduct[],
  candidate: string,
): string {
  const id = candidate.trim();
  if (!id) return id;
  const exact = packs.find((pack) => pack.id === id);
  if (exact) return exact.id;
  const byModel = packs.find((pack) => (pack.modelId ?? "").trim() === id);
  if (byModel) return byModel.id;
  const foilBase = id.replace(/-\d+$/, "");
  if (foilBase !== id) {
    const byFoil = packs.find(
      (pack) =>
        (pack.modelId ?? "").trim() === foilBase || pack.id === `${foilBase}-pack`,
    );
    if (byFoil) return byFoil.id;
  }
  const suffixed = packs.find((pack) => pack.id === `${id}-pack`);
  if (suffixed) return suffixed.id;
  return id;
}

function catalogUnitCost(packId: string): number | null {
  if (!packCatalogCache?.length) return null;
  const resolved = resolvePurchasePackId(packCatalogCache, packId);
  const product = packCatalogCache.find((pack) => pack.id === resolved);
  const cost = product?.diamondCost;
  return typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
}

/** Demo / offline fixture costs when GET /api/packs has no match yet. */
const DEMO_PACK_DIAMOND_COSTS: Record<string, number> = {
  starter: 50,
};

function demoUnitCost(packId: string, fallbackUsd?: number) {
  if (DEMO_PACK_DIAMOND_COSTS[packId] != null) {
    return DEMO_PACK_DIAMOND_COSTS[packId];
  }
  if (fallbackUsd != null) return Math.max(1, Math.round(fallbackUsd * 10));
  return 10;
}

/**
 * Unit Diamond cost for any pack surface.
 * Prefers live GET /api/packs (via loadPackCatalog); falls back to demo fixtures.
 */
export function packUnitCost(packId = "pack", fallbackUsd?: number) {
  return catalogUnitCost(packId) ?? demoUnitCost(packId, fallbackUsd);
}

/** Coverflow / Buy Pack — linear per-pack pricing, capped at 10. */
export const BUY_PACK_MAX_QUANTITY = 10;

/**
 * A/B coverflow buy path for Juliana packs.
 * Juliana: Buy Pack + Add to Pocket on HUD, with the legacy inline qty confirm.
 * Everyone else: Buy Pack only → opens BuyPackQuantityModal.
 */
export function isJulianaCoverflowBuyAb(
  candidate: string | null | undefined,
): boolean {
  const id = (candidate ?? "").trim().toLowerCase();
  if (!id) return false;
  if (
    id === "julianaval" ||
    id === "julianaval-pack" ||
    id.startsWith("julianaval-")
  ) {
    return true;
  }
  // Display-name / handle fallback (e.g. "Juliana", "@julianaval").
  const compact = id.replace(/[^a-z0-9]/g, "");
  return compact === "juliana" || compact.startsWith("julianaval");
}

export function clampBuyPackQuantity(quantity: number): number {
  const n = Math.floor(quantity);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(BUY_PACK_MAX_QUANTITY, n);
}

export function linearPackTotalCost(packId: string, quantity: number): number {
  return packUnitCost(packId) * clampBuyPackQuantity(quantity);
}

export function packCost(quantity: PackQuantity, packId = "pack") {
  const unit = packUnitCost(packId);
  // ponytail: 5-pack keeps the old 3× demo bundle ratio until real pricing exists.
  return quantity === 1 ? unit : unit * 3;
}

export function buildOpeningSession(
  quantity: PackQuantity,
  packId = "pack",
): OpeningSession {
  const diamondCost = packCost(quantity, packId);
  // ponytail: the prototype caps the five-pack preview at five cards; replace with
  // the backend opening-session payload when pack composition is implemented.
  const cardCount = quantity === 1 ? 3 : 5;
  const rarities: OpeningCard["rarity"][] = ["Rare", "Rare", "Super Rare", "Rare", "Ultra Rare"];

  return {
    quantity,
    diamondCost,
    cards: Array.from({ length: cardCount }, (_, index) => ({
      id: `card-${packId}-${quantity}-${index + 1}`,
      rarity: rarities[index],
      reward: index === cardCount - 1 ? 50 : 10 + index * 5,
    })),
  };
}

export function buildFoilOpeningSession(
  foils: { id: string; label: string; videoUrl: string }[],
  diamondCost = packCost(1),
): OpeningSession {
  const rarities: OpeningCard["rarity"][] = ["Super Rare", "Ultra Rare"];
  return {
    quantity: 1,
    diamondCost,
    cards: foils.slice(0, 2).map((foil, index) => ({
      id: foil.id,
      rarity: rarities[index] ?? "Rare",
      reward: index === 0 ? 25 : 50,
      faceUrl: foil.videoUrl,
    })),
  };
}

/* ---------------------------------------------------------------------------
 * Purchase requests
 * ------------------------------------------------------------------------ */

export type PackInstanceApi = {
  instanceId: string;
  catalogPackId: string;
  packName: string;
  creator: string;
  creatorId?: string;
  themeName: string;
  coverUrl: string;
  status: "unopened" | "opened";
  purchaseId: string;
  savedAt: number;
};

export type PurchaseResult = {
  purchaseId: string;
  instances: PackInstanceApi[];
  wallet: { diamonds: number; coins: number };
  diamondCost: number;
};

export type PurchaseErrorKind = "insufficient" | "failed" | "assets";

export class PurchaseError extends Error {
  kind: PurchaseErrorKind;
  constructor(kind: PurchaseErrorKind, message?: string) {
    super(message ?? kind);
    this.kind = kind;
    this.name = "PurchaseError";
  }
}

/**
 * ponytail: failures are demo-triggered via `?fail=purchase|assets|session`
 * instead of a random rate, so the error states stay reproducible.
 * Replace with real request outcomes when the API exists.
 */
export function failureMode(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("fail");
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newIdempotencyToken() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

function purchaseIdempotencyStorageKey(packId: string, quantity: PackQuantity) {
  return `sugar.v8.packBuyIdempotency:${packId}:${quantity}`;
}

/** Stable across retries of the same in-flight buy; cleared after the client commits. */
function getPurchaseIdempotencyKey(
  packId: string,
  quantity: PackQuantity,
  explicit?: string,
): string {
  if (explicit) return explicit;
  const storageKey = purchaseIdempotencyStorageKey(packId, quantity);
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing) return existing;
    const key = `pack-buy:${packId}:${quantity}:${newIdempotencyToken()}`;
    sessionStorage.setItem(storageKey, key);
    return key;
  } catch {
    return `pack-buy:${packId}:${quantity}:${newIdempotencyToken()}`;
  }
}

function clearPurchaseIdempotencyKey(packId: string, quantity: PackQuantity) {
  try {
    sessionStorage.removeItem(purchaseIdempotencyStorageKey(packId, quantity));
  } catch {
    /* ignore */
  }
}

/** Drop the in-flight key after the client has fully committed the purchase. */
export function commitPurchaseIdempotencyKey(
  packId: string,
  quantity: PackQuantity,
) {
  clearPurchaseIdempotencyKey(packId, quantity);
}

/** One distinct server purchase per Pack Pocket line at checkout. */
export function cartCheckoutIdempotencyKey(cartItemId: string): string {
  const id = cartItemId.trim();
  return id ? `cart-buy:${id}` : `cart-buy:${newIdempotencyToken()}`;
}

function newDemoInstanceId() {
  return `demo-pack-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newDemoPurchaseId() {
  return `demo-tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** `?demo=1` only — offline fixture when the API is unreachable. */
function purchaseLinearFromDemoFixture(
  quantity: number,
  balance: number,
  packId: string,
  coinBalance: number,
): PurchaseResult {
  const q = clampBuyPackQuantity(quantity);
  const diamondCost = packUnitCost(packId) * q;
  if (diamondCost > balance) throw new PurchaseError("insufficient");
  const purchaseId = newDemoPurchaseId();
  const instances: PackInstanceApi[] = Array.from({ length: q }, () => ({
    instanceId: newDemoInstanceId(),
    catalogPackId: packId,
    packName: packId,
    creator: "Sugar",
    themeName: packId,
    coverUrl: "",
    status: "unopened",
    purchaseId,
    savedAt: Date.now(),
  }));
  return {
    purchaseId,
    instances,
    wallet: {
      diamonds: Math.max(0, balance - diamondCost),
      coins: coinBalance,
    },
    diamondCost,
  };
}

function purchaseFromDemoFixture(
  quantity: PackQuantity,
  balance: number,
  packId: string,
  coinBalance: number,
): PurchaseResult {
  const diamondCost = packCost(quantity, packId);
  if (diamondCost > balance) throw new PurchaseError("insufficient");
  const purchaseId = newDemoPurchaseId();
  const instances: PackInstanceApi[] = Array.from({ length: quantity }, () => ({
    instanceId: newDemoInstanceId(),
    catalogPackId: packId,
    packName: packId,
    creator: "Sugar",
    themeName: packId,
    coverUrl: "",
    status: "unopened",
    purchaseId,
    savedAt: Date.now(),
  }));
  return {
    purchaseId,
    instances,
    wallet: {
      diamonds: Math.max(0, balance - diamondCost),
      coins: coinBalance,
    },
    diamondCost,
  };
}

function linearPurchaseIdempotencyStorageKey(packId: string, quantity: number) {
  return `sugar.purchase.idempotency.linear:${packId}:${quantity}`;
}

function getLinearPurchaseIdempotencyKey(
  packId: string,
  quantity: number,
  override?: string,
) {
  if (override?.trim()) return override.trim();
  try {
    const key = linearPurchaseIdempotencyStorageKey(packId, quantity);
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const created = `pack-buy-linear:${packId}:${quantity}:${newIdempotencyToken()}`;
    sessionStorage.setItem(key, created);
    return created;
  } catch {
    return `pack-buy-linear:${packId}:${quantity}:${newIdempotencyToken()}`;
  }
}

function clearLinearPurchaseIdempotencyKey(packId: string, quantity: number) {
  try {
    sessionStorage.removeItem(
      linearPurchaseIdempotencyStorageKey(packId, quantity),
    );
  } catch {
    /* ignore */
  }
}

export function commitLinearPurchaseIdempotencyKey(
  packId: string,
  quantity: number,
) {
  const q = clampBuyPackQuantity(quantity);
  clearLinearPurchaseIdempotencyKey(packId, q);
  // qty 1|5 delegates to submitPurchase (legacy session keys).
  // Other quantities may fall back to N× qty-1, which also writes the legacy qty-1 key.
  if (q === 1 || q === 5) {
    clearPurchaseIdempotencyKey(packId, q);
  } else {
    clearPurchaseIdempotencyKey(packId, 1);
  }
}

function isInsufficientPurchaseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (message === "insufficient" || message.includes("insufficient")) return true;
  if (error instanceof ApiError && (error.status === 402 || error.status === 409)) {
    return true;
  }
  return false;
}

/** Quantity × unit price (not the legacy 5-pack bundle rate). */
export async function submitLinearPackPurchase(
  quantity: number,
  balance: number,
  packId = "pack",
  idempotencyKey?: string,
  coinBalance = 0,
): Promise<PurchaseResult> {
  const q = clampBuyPackQuantity(quantity);
  // Reuse the proven 1|5 purchase path — same pricing + idempotency the app already ships.
  if (q === 1 || q === 5) {
    return submitPurchase(q, balance, packId, idempotencyKey, coinBalance);
  }

  const catalog = await loadPackCatalog();
  const purchasePackId = resolvePurchasePackId(catalog, packId);
  const diamondCost = linearPackTotalCost(purchasePackId, q);
  if (diamondCost > balance) throw new PurchaseError("insufficient");
  if (failureMode() === "purchase") {
    throw new PurchaseError("failed", "Purchase could not be completed.");
  }
  const key = getLinearPurchaseIdempotencyKey(
    purchasePackId,
    q,
    idempotencyKey,
  );
  try {
    const remote = await apiMutate<{
      purchaseId: string;
      instances: PackInstanceApi[];
      wallet: { diamonds: number; coins: number };
    }>(`/api/packs/${encodeURIComponent(purchasePackId)}/purchase`, {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({ quantity: q }),
    });
    const instances = Array.isArray(remote.instances) ? remote.instances : [];
    if (!instances.length) {
      throw new PurchaseError("failed", "Pack ownership failed.");
    }
    return {
      purchaseId: remote.purchaseId,
      instances,
      wallet: remote.wallet,
      diamondCost,
    };
  } catch (error) {
    if (isInsufficientPurchaseError(error)) {
      clearLinearPurchaseIdempotencyKey(purchasePackId, q);
      throw new PurchaseError("insufficient");
    }
    // Backend may only accept quantity 1|5 — buy N single packs and merge.
    if (!isDemoMode()) {
      try {
        return await purchaseLinearAsSingles(
          q,
          balance,
          purchasePackId,
          coinBalance,
        );
      } catch (fallbackError) {
        if (isInsufficientPurchaseError(fallbackError)) {
          throw new PurchaseError("insufficient");
        }
        throw new PurchaseError("failed", "Purchase could not be completed.");
      }
    }
    return purchaseLinearFromDemoFixture(q, balance, purchasePackId, coinBalance);
  }
}

/** ponytail: N× qty-1 when the API rejects multi-qty linear buys. */
async function purchaseLinearAsSingles(
  quantity: number,
  balance: number,
  packId: string,
  coinBalance: number,
): Promise<PurchaseResult> {
  const q = clampBuyPackQuantity(quantity);
  let diamonds = balance;
  let coins = coinBalance;
  let purchaseId = "";
  const instances: PackInstanceApi[] = [];
  let diamondCost = 0;
  for (let i = 0; i < q; i++) {
    // Fresh Idempotency-Key each iteration — reusing the legacy qty-1 session
    // key would make buys 2..N look like retries of the first purchase.
    const singleKey = `pack-buy-linear-single:${packId}:${i}:${newIdempotencyToken()}`;
    const result = await submitPurchase(1, diamonds, packId, singleKey, coins);
    clearPurchaseIdempotencyKey(packId, 1);
    diamonds = result.wallet.diamonds;
    coins = result.wallet.coins;
    diamondCost += result.diamondCost;
    purchaseId = result.purchaseId;
    instances.push(...(Array.isArray(result.instances) ? result.instances : []));
  }
  if (!instances.length) {
    throw new PurchaseError("failed", "Pack ownership failed.");
  }
  return {
    purchaseId,
    instances,
    wallet: { diamonds, coins },
    diamondCost,
  };
}

export async function submitPurchase(
  quantity: PackQuantity,
  balance: number,
  packId = "pack",
  idempotencyKey?: string,
  coinBalance = 0,
): Promise<PurchaseResult> {
  const catalog = await loadPackCatalog();
  const purchasePackId = resolvePurchasePackId(catalog, packId);
  const diamondCost = packCost(quantity, purchasePackId);
  if (diamondCost > balance) throw new PurchaseError("insufficient");
  if (failureMode() === "purchase") {
    throw new PurchaseError("failed", "Purchase could not be completed.");
  }
  const key = getPurchaseIdempotencyKey(purchasePackId, quantity, idempotencyKey);
  try {
    const remote = await apiMutate<{
      purchaseId: string;
      instances: PackInstanceApi[];
      wallet: { diamonds: number; coins: number };
    }>(`/api/packs/${encodeURIComponent(purchasePackId)}/purchase`, {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({ quantity }),
    });
    /* keep key until the client fully commits — retries after a lost response
       or a post-charge failure must reuse it */
    return {
      purchaseId: remote.purchaseId,
      instances: remote.instances,
      wallet: remote.wallet,
      diamondCost,
    };
  } catch (error) {
    if (isInsufficientPurchaseError(error)) {
      clearPurchaseIdempotencyKey(purchasePackId, quantity);
      throw new PurchaseError("insufficient");
    }
    if (!isDemoMode()) {
      throw new PurchaseError("failed", "Purchase could not be completed.");
    }
    return purchaseFromDemoFixture(quantity, balance, purchasePackId, coinBalance);
  }
}

export async function loadOpeningAssets(): Promise<void> {
  await wait(450);
  if (failureMode() === "assets") {
    throw new PurchaseError("assets", "Pack assets failed to download.");
  }
}

export type OpenPackResult = {
  openingId: string;
  stage: string;
  cardIndex: number;
  session: OpeningSession;
  scratched: string[];
  instance: PackInstanceApi;
};

function mapOpeningCard(card: {
  id: string;
  rarity: string;
  reward: number;
  faceUrl?: string | null;
  cardKind?: string | null;
  cardId?: string | null;
  photoSlotId?: string | null;
}): OpeningCard {
  return {
    id: card.id,
    rarity: card.rarity as OpeningCard["rarity"],
    reward: card.reward,
    faceUrl: card.faceUrl ?? undefined,
    cardKind: card.cardKind?.trim() || undefined,
    cardId: card.cardId?.trim() || undefined,
    photoSlotId: card.photoSlotId?.trim() || undefined,
  };
}

function mapOpeningSession(raw: {
  quantity: number;
  diamondCost: number;
  cards: Array<{
    id: string;
    rarity: string;
    reward: number;
    faceUrl?: string | null;
    cardKind?: string | null;
    cardId?: string | null;
    photoSlotId?: string | null;
  }>;
  foilFaceUrl?: string | null;
  foilLabel?: string | null;
}): OpeningSession {
  return {
    quantity: (raw.quantity === 5 ? 5 : 1) as PackQuantity,
    diamondCost: raw.diamondCost,
    cards: raw.cards.map(mapOpeningCard),
    foilFaceUrl: raw.foilFaceUrl ?? undefined,
    foilLabel: raw.foilLabel ?? undefined,
  };
}

export type RevealCardResult = {
  card: { id: string; revealStatus: string; reward: number };
  scratched: string[];
  wallet: { diamonds: number; coins: number };
};

/** Reveal one scratched card — credits pack reward + optional motion prize. */
export async function revealPackCard(
  openingId: string,
  cardId: string,
  opts?: { prize?: number },
): Promise<RevealCardResult> {
  try {
    const prize = Math.max(0, Math.floor(opts?.prize ?? 0));
    const remote = await apiMutate<{
      card: { id: string; revealStatus: string; reward: number };
      scratched: string[];
      wallet: { diamonds: number; coins: number };
    }>(`/api/me/openings/${openingId}/cards/${cardId}/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prize > 0 ? { prize } : {}),
    });
    return {
      card: remote.card,
      scratched: remote.scratched,
      wallet: remote.wallet,
    };
  } catch {
    throw new PurchaseError("failed", "Card reveal could not be completed.");
  }
}

/** Open a sealed pack instance — deals cards on the server when authed. */
export async function openPackInstance(instanceId: string): Promise<OpenPackResult> {
  try {
    const remote = await apiMutate<{
      instance: PackInstanceApi;
      openingId: string;
      stage: string;
      cardIndex: number;
      session: {
        quantity: number;
        diamondCost: number;
        cards: Array<{
          id: string;
          rarity: string;
          reward: number;
          faceUrl?: string | null;
          cardKind?: string | null;
          cardId?: string | null;
          photoSlotId?: string | null;
        }>;
        foilFaceUrl?: string | null;
        foilLabel?: string | null;
      };
      scratched: string[];
    }>(`/api/me/packs/${instanceId}/open`, { method: "POST" });
    return {
      openingId: remote.openingId,
      stage: remote.stage,
      cardIndex: remote.cardIndex,
      session: mapOpeningSession(remote.session),
      scratched: remote.scratched,
      instance: remote.instance,
    };
  } catch {
    throw new PurchaseError("failed", "Pack could not be opened.");
  }
}

/* ---------------------------------------------------------------------------
 * Opening session persistence (resume after interruption)
 * ------------------------------------------------------------------------ */

const OPENING_KEY = "sugar.v8.openingSession";
const SESSION_TTL_MS = 1000 * 60 * 60 * 6;

export type OpeningStage =
  | "ready"
  | "reveal"
  | "cards-ready"
  | "preview"
  | "grid"
  | "scratch"
  | "complete";

export type PersistedOpening = {
  packId: string;
  savedAt: number;
  session: OpeningSession;
  stage: OpeningStage;
  cardIndex: number;
  /** Card ids already fully scratched — never replayed on resume. */
  scratched: string[];
  /** Server opening row — required for reveal API on resume. */
  openingId?: string;
  /** Server PackOpeningCard uuids (parallel to session.cards slots). */
  serverRevealCardIds?: string[];
};

export type RestoreResult =
  | { status: "none" }
  | { status: "expired" }
  | { status: "resume"; data: PersistedOpening };

function isValidOpening(value: unknown): value is PersistedOpening {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<PersistedOpening>;
  return (
    typeof data.packId === "string" &&
    typeof data.savedAt === "number" &&
    typeof data.stage === "string" &&
    typeof data.cardIndex === "number" &&
    Array.isArray(data.scratched) &&
    !!data.session &&
    Array.isArray(data.session.cards) &&
    data.session.cards.length > 0
  );
}

/** Postgres PackOpeningCard id — not fan/reveal placeholder ids. */
export function isServerOpeningCardId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id.trim(),
  );
}

export function areServerRevealCardIds(
  ids: readonly string[] | null | undefined,
): boolean {
  return Boolean(ids?.length && ids.every(isServerOpeningCardId));
}

export function saveOpening(data: Omit<PersistedOpening, "savedAt">) {
  try {
    localStorage.setItem(
      OPENING_KEY,
      JSON.stringify({ ...data, savedAt: Date.now() }),
    );
  } catch {
    /* storage unavailable — resume simply won't be offered */
  }
}

export function clearOpening() {
  try {
    localStorage.removeItem(OPENING_KEY);
  } catch {
    /* ignore */
  }
}

export function restoreOpening(packId: string): RestoreResult {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(OPENING_KEY);
  } catch {
    return { status: "none" };
  }
  if (!raw) return { status: "none" };

  if (failureMode() === "session") {
    clearOpening();
    return { status: "expired" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearOpening();
    return { status: "expired" };
  }

  if (!isValidOpening(parsed)) {
    clearOpening();
    return { status: "expired" };
  }
  if (Date.now() - parsed.savedAt > SESSION_TTL_MS) {
    clearOpening();
    return { status: "expired" };
  }
  // A saved session for another pack is not this pack's business.
  if (parsed.packId !== packId) return { status: "none" };

  return { status: "resume", data: parsed };
}

/** Card ids in `revealedIds` not yet settled (local or server). */
export function freshRevealIds(revealedIds: string[], awarded: ReadonlySet<string>) {
  return revealedIds.filter((id) => !awarded.has(id));
}

/** First card that still needs scratching, or null when the session is done. */
export function nextUnscratchedIndex(
  session: OpeningSession,
  scratched: string[],
): number | null {
  const index = session.cards.findIndex((card) => !scratched.includes(card.id));
  return index === -1 ? null : index;
}
