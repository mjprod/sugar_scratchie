import { api } from "./api";

export type CatalogPhoto = {
  id: string;
  src: string;
};

export type CatalogMotionCard = {
  id: string;
  label: string;
  bottom: string;
  foreground: string;
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
};

type ApiMotionCard = {
  id?: unknown;
  label?: unknown;
  background?: unknown;
  foreground?: unknown;
  bottom?: unknown;
  mesh?: unknown;
  chroma_key?: unknown;
  model_id?: unknown;
  theme_id?: unknown;
  sort_order?: unknown;
  photos?: unknown;
};

type CardsPayload = { cards?: ApiMotionCard[] };
type PhotoPayload = { cards?: CatalogPhotoCard[] };

/** Media prefixes served same-origin (or via the Vite media proxy in frontend-new). */
const PROXIED_MEDIA_PREFIXES = [
  "/api/",
  "/cards/",
  "/models/",
  "/photo-scratch/",
  "/mesh/",
  "/themes/",
  "/lotties/",
] as const;

function isProxiedMediaPath(pathname: string): boolean {
  return PROXIED_MEDIA_PREFIXES.some(
    (prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix),
  );
}

/**
 * Convert a workspace path (`public/cards/...`) to a site URL (`/cards/...`).
 * Absolute http(s) URLs under media prefixes become same-origin paths so
 * canvas/WebGL video textures stay CORS-safe.
 */
export function toPublicMediaUrl(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("blob:") || trimmed.startsWith("data:")) return trimmed;

  if (/^(?:https?:)?\/\//i.test(trimmed)) {
    try {
      const absolute = new URL(trimmed, "https://placeholder.local");
      const pathWithSearch = `${absolute.pathname}${absolute.search}${absolute.hash}`;
      if (isProxiedMediaPath(absolute.pathname)) return pathWithSearch;
      if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("//")) return trimmed;
      return pathWithSearch;
    } catch {
      return trimmed;
    }
  }

  if (trimmed.startsWith("/")) return trimmed;

  const withoutPublic = trimmed.startsWith("public/") ? trimmed.slice("public/".length) : trimmed;
  const parts = withoutPublic.split("/").filter(Boolean);
  return `/${parts.map(encodeURIComponent).join("/")}`;
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
  return {
    id,
    label,
    bottom: toPublicMediaUrl(bottomRaw),
    foreground: toPublicMediaUrl(foregroundRaw),
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
    });
  }
  return cards;
}

export async function fetchCatalogMotionCards(): Promise<CatalogMotionCard[]> {
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

export async function fetchCatalogPhotoCards(): Promise<CatalogPhotoCard[]> {
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
