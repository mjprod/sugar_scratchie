import { normalizeMediaUrl } from "@/lib/mediaUrl";
import { getHdVideoEnabled } from "@/services/videoQualityPrefs";
import { api } from "../scratch/api";

export type CatalogPhoto = {
  id: string;
  src: string;
};

export type CatalogMotionCard = {
  id: string;
  label: string;
  bottom: string;
  foreground: string;
  /** HD twins of bottom/foreground — both set or both absent. */
  bottomHd?: string;
  foregroundHd?: string;
  mesh: string;
  chromaKey: boolean;
  model_id?: string;
  theme_id?: string;
  sort_order?: number;
  photos?: CatalogPhoto[];
};

export type CatalogPhotoCard = {
  id: string;
  label: string;
  background: string;
  bikini: string;
  clothes: string;
  mesh: string;
  model_id?: string;
  theme_id?: string;
  intro?: string;
  /** From the API's `card_price`; undefined when no price is set. */
  cardPrice?: number;
};

type ApiPhotoCard = Omit<CatalogPhotoCard, "cardPrice"> & { card_price?: unknown };

type ApiMotionCard = {
  id?: unknown;
  label?: unknown;
  background?: unknown;
  foreground?: unknown;
  bottom?: unknown;
  background_hd?: unknown;
  foreground_hd?: unknown;
  mesh?: unknown;
  chroma_key?: unknown;
  model_id?: unknown;
  theme_id?: unknown;
  sort_order?: unknown;
  photos?: unknown;
};

type CardsPayload = { cards?: ApiMotionCard[] };
type PhotoPayload = { cards?: ApiPhotoCard[] };

/**
 * Convert a workspace path (`public/cards/...`) to a site URL (`/cards/...`).
 * Absolute http(s) host URLs under Vite media prefixes are rewritten to
 * same-origin paths via normalizeMediaUrl (CORS-safe for WebGL textures).
 */
export function toPublicMediaUrl(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("blob:") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("/")
  ) {
    return normalizeMediaUrl(trimmed);
  }
  const queryStart = trimmed.search(/[?#]/);
  const pathPart = queryStart >= 0 ? trimmed.slice(0, queryStart) : trimmed;
  const query = queryStart >= 0 ? trimmed.slice(queryStart) : "";
  const withoutPublic = pathPart.startsWith("public/")
    ? pathPart.slice("public/".length)
    : pathPart;
  const parts = withoutPublic.split("/").filter(Boolean);
  return normalizeMediaUrl(`/${parts.map(encodeURIComponent).join("/")}${query}`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parsePhotos(value: unknown): CatalogPhoto[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const photos: CatalogPhoto[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const id = optionalString((entry as { id?: unknown }).id);
    const src = optionalString((entry as { src?: unknown }).src);
    if (id && src) photos.push({ id, src: toPublicMediaUrl(src) });
  }
  return photos.length > 0 ? photos : undefined;
}

function motionFromRow(entry: ApiMotionCard): CatalogMotionCard | null {
  const id = optionalString(entry.id);
  const label = optionalString(entry.label);
  const mesh = optionalString(entry.mesh);
  const bottomRaw = optionalString(entry.bottom) ?? optionalString(entry.background);
  const foregroundRaw = optionalString(entry.foreground);
  if (!id || !label || !mesh || !bottomRaw || !foregroundRaw) return null;
  const bottomHdRaw = optionalString(entry.background_hd);
  const foregroundHdRaw = optionalString(entry.foreground_hd);
  const hd =
    bottomHdRaw && foregroundHdRaw
      ? {
          bottomHd: toPublicMediaUrl(bottomHdRaw),
          foregroundHd: toPublicMediaUrl(foregroundHdRaw),
        }
      : {};
  return {
    id,
    label,
    bottom: toPublicMediaUrl(bottomRaw),
    foreground: toPublicMediaUrl(foregroundRaw),
    ...hd,
    mesh,
    chromaKey: entry.chroma_key === true || id === "original",
    model_id: optionalString(entry.model_id),
    theme_id: optionalString(entry.theme_id),
    sort_order: typeof entry.sort_order === "number" ? entry.sort_order : 0,
    photos: parsePhotos(entry.photos),
  };
}

function parseMotionPayload(data: CardsPayload): CatalogMotionCard[] {
  if (!Array.isArray(data.cards)) return [];
  const cards: CatalogMotionCard[] = [];
  for (const entry of data.cards) {
    const card = motionFromRow(entry);
    if (card) cards.push(card);
  }
  return cards;
}

function parsePhotoPayload(data: PhotoPayload): CatalogPhotoCard[] {
  if (!Array.isArray(data.cards)) return [];
  const cards: CatalogPhotoCard[] = [];
  for (const entry of data.cards) {
    if (
      typeof entry.id !== "string" ||
      typeof entry.label !== "string" ||
      typeof entry.background !== "string" ||
      typeof entry.bikini !== "string" ||
      typeof entry.clothes !== "string" ||
      typeof entry.mesh !== "string"
    ) {
      continue;
    }
    const introRaw = optionalString(entry.intro);
    cards.push({
      id: entry.id,
      label: entry.label,
      background: toPublicMediaUrl(entry.background),
      bikini: toPublicMediaUrl(entry.bikini),
      clothes: toPublicMediaUrl(entry.clothes),
      mesh: toPublicMediaUrl(entry.mesh),
      model_id: optionalString(entry.model_id),
      theme_id: optionalString(entry.theme_id),
      intro: introRaw ? toPublicMediaUrl(introRaw) : undefined,
      cardPrice: typeof entry.card_price === "number" ? entry.card_price : undefined,
    });
  }
  return cards;
}

let motionCatalogPromise: Promise<CatalogMotionCard[]> | null = null;
let photoCatalogPromise: Promise<CatalogPhotoCard[]> | null = null;

async function loadCatalogMotionCards(): Promise<CatalogMotionCard[]> {
  try {
    const data = await api<CardsPayload>("/api/cards");
    const cards = parseMotionPayload(data);
    if (cards.length > 0) return cards;
  } catch {
    // API down — use the static write-through mirror.
  }
  try {
    const response = await fetch("/cards/index.json", { cache: "no-store" });
    if (!response.ok) return [];
    return parseMotionPayload((await response.json()) as CardsPayload);
  } catch {
    return [];
  }
}

async function loadCatalogPhotoCards(): Promise<CatalogPhotoCard[]> {
  try {
    const data = await api<PhotoPayload>("/api/photo-scratch");
    const cards = parsePhotoPayload(data);
    if (cards.length > 0) return cards;
  } catch {
    // API down — use the static write-through mirror.
  }
  try {
    const response = await fetch("/photo-scratch/index.json", { cache: "no-store" });
    if (!response.ok) return [];
    return parsePhotoPayload((await response.json()) as PhotoPayload);
  } catch {
    return [];
  }
}

/**
 * Swap in the HD clips when the player turned on HD Videos and the card has
 * them. Only the scratch game should call this — thumbnails and posters keep
 * the light delivery clips.
 */
export function withPreferredVideoQuality(
  card: CatalogMotionCard,
  hd?: boolean,
): CatalogMotionCard {
  if (!card.bottomHd || !card.foregroundHd) return card;
  const enabled = hd ?? getHdVideoEnabled();
  if (!enabled) return card;
  return { ...card, bottom: card.bottomHd, foreground: card.foregroundHd };
}

/** Page-lifetime memo — settle/enrich callers share one in-flight fetch. */
export function fetchCatalogMotionCards(): Promise<CatalogMotionCard[]> {
  if (!motionCatalogPromise) {
    motionCatalogPromise = loadCatalogMotionCards();
  }
  return motionCatalogPromise;
}

export function fetchCatalogPhotoCards(): Promise<CatalogPhotoCard[]> {
  if (!photoCatalogPromise) {
    photoCatalogPromise = loadCatalogPhotoCards();
  }
  return photoCatalogPromise;
}
