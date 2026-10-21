/**
 * Shopping cart — packs added via Buy Pack, opened from the cart cover-flow.
 */

export type CartPack = {
  cartItemId: string;
  packId: string;
  packName: string;
  creator: string;
  characterId: string;
  price: number;
  videoUrl: string;
  packNumber: number;
  flagEmoji: string;
  flagSvgUrl?: string;
  city?: string;
  country?: string;
  overlayColorStart?: string;
  overlayColorEnd?: string;
  backgroundColor: string;
  addedAt: number;
};

export type CartAddInput = {
  packId: string;
  packName: string;
  creator: string;
  characterId?: string;
  price?: number | string;
  videoUrl?: string;
  packNumber?: number;
  flagEmoji?: string;
  flagSvgUrl?: string;
  city?: string;
  country?: string;
  overlayColorStart?: string;
  overlayColorEnd?: string;
  backgroundColor?: string;
};

const KEY = "sugar.v8.packCart";
export const CART_CHANGED_EVENT = "sugar:cart-changed";
export const CART_REMOVE_INTENT_EVENT = "sugar:cart-remove-intent";

const DEFAULT_GLOW = "oklch(0.798 0.104 207.84)";

function parsePrice(value: number | string | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const match = value.replace(/,/g, "").match(/(\d+(\.\d+)?)/);
    if (match) return Number(match[1]);
  }
  return 0;
}

function newId() {
  return `cart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isValid(value: unknown): value is CartPack {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<CartPack>;
  return (
    typeof data.cartItemId === "string" &&
    typeof data.packId === "string" &&
    typeof data.packName === "string" &&
    typeof data.creator === "string"
  );
}

function readAll(): CartPack[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValid);
  } catch {
    return [];
  }
}

function writeAll(packs: CartPack[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(packs));
  } catch {
    /* storage unavailable */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CART_CHANGED_EVENT));
  }
}

export function listCartPacks(): CartPack[] {
  return readAll();
}

export function countCartPacks(): number {
  return readAll().length;
}

/** True when this catalog pack (or its character) is already in Pack Pocket. */
export function isPackInCart(...ids: Array<string | null | undefined>): boolean {
  const wanted = new Set(
    ids.map((id) => id?.trim()).filter((id): id is string => Boolean(id)),
  );
  if (!wanted.size) return false;
  // packId may be a foil id on Browse/Featured and a model id on CoverFlowV2.
  return readAll().some(
    (pack) => wanted.has(pack.packId) || wanted.has(pack.characterId),
  );
}

export function addPackToCart(input: CartAddInput): CartPack {
  const item: CartPack = {
    cartItemId: newId(),
    packId: input.packId,
    packName: input.packName,
    creator: input.creator,
    characterId: input.characterId?.trim() || input.packId,
    price: parsePrice(input.price),
    videoUrl: input.videoUrl ?? "",
    packNumber: input.packNumber ?? 101,
    flagEmoji: input.flagEmoji ?? "",
    flagSvgUrl: input.flagSvgUrl,
    city: input.city,
    country: input.country,
    overlayColorStart: input.overlayColorStart,
    overlayColorEnd: input.overlayColorEnd,
    backgroundColor: input.backgroundColor || DEFAULT_GLOW,
    addedAt: Date.now(),
  };
  writeAll([item, ...readAll()]);
  return item;
}

export function removePackFromCart(cartItemId: string): CartPack[] {
  const next = readAll().filter((pack) => pack.cartItemId !== cartItemId);
  writeAll(next);
  return next;
}

export function clearCart() {
  writeAll([]);
}

export function subscribeCart(onChange: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const handler = () => onChange();
  window.addEventListener(CART_CHANGED_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(CART_CHANGED_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

/** Fire as soon as the user confirms remove, before the pack-drop animation finishes. */
export function notifyCartRemoveIntent() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CART_REMOVE_INTENT_EVENT));
}

export function subscribeCartRemoveIntent(onRemove: () => void) {
  if (typeof window === "undefined") return () => undefined;
  const handler = () => onRemove();
  window.addEventListener(CART_REMOVE_INTENT_EVENT, handler);
  return () => window.removeEventListener(CART_REMOVE_INTENT_EVENT, handler);
}
