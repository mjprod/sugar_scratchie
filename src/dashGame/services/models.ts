/** Creator models and foil packs from `/api/models`. */

import { apiFetch } from "../lib/api";
import { CATALOG_TTL_MS, cachedRequest } from "../lib/cachedRequest";
import { normalizeMediaUrl } from "../lib/mediaUrl";

export type BackendModel = {
  id?: string | null;
  label?: string | null;
  avatar?: string | null;
  created_at?: number | null;
  influencerName?: string | null;
  influencerCity?: string | null;
  influencerCountry?: string | null;
  influencerFlag?: string | null;
  influencerFlagSvg?: string | null;
  cardOverlayColorStart?: string | null;
  cardOverlayColorEnd?: string | null;
  cardLightColor1?: string | null;
  cardLightColor2?: string | null;
  cardPackName?: string | null;
  cardPackName2?: string | null;
  packFaceVideoUrl?: string | null;
  packFaceVideoUrl2?: string | null;
  packFacePosterUrl?: string | null;
  packFacePosterUrl2?: string | null;
  swipeVideoUrl?: string | null;
  swipePosterUrl?: string | null;

  /** Ultra card video trailer, e.g. "/models/julianaval/ultra-card-trailer.mp4". */
  ultraCardTrailerUrl?: string | null;

  ultraCardTrailerPosterUrl?: string | null;
  /** Landscape model cover (recommended 820×312), e.g. "/models/julianaval/cover.webp". */
  coverUrl?: string | null;
  theme_avatars?: Record<string, string> | null;
  tags?: string[];
};

export type FoilSlot = 1 | 2;

export type FoilPack = {
  slot: FoilSlot;
  id: string;
  label: string;
  videoUrl: string;
  /** Still frame for the pack face; cheap to paint before the video decoder runs. */
  posterUrl?: string;
};

export type ModelProfile = {
  id: string;
  name: string;
  collectionLabel: string;
  city: string | null;
  country: string | null;
  flagEmoji: string | null;
  flagSvgUrl: string | null;
  overlayColorStart: string | null;
  overlayColorEnd: string | null;
  swipeVideoUrl: string | null;
  packs: FoilPack[];
};

export function formatCollectionLabel(name: string) {
  const trimmed = name.trim();
  return trimmed ? `${trimmed} Collection` : "Collection";
}

export function isVideoSrc(src: string) {
  return /\.(mp4|webm|mov)(\?|#|$)/i.test(src);
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9]+/g, "");
}

function optionalMedia(value: unknown): string | null {
  const raw = optionalString(value);
  if (!raw) return null;
  return normalizeMediaUrl(raw) || null;
}

export function modelDisplayName(model: BackendModel) {
  return (
    optionalString(model.influencerName) ??
    optionalString(model.label) ??
    optionalString(model.id) ??
    "Model"
  );
}

export function modelId(model: BackendModel, fallbackIndex = 0) {
  return optionalString(model.id) ?? `model-${fallbackIndex + 1}`;
}

function packIdCandidates(packId: string): string[] {
  const raw = packId.trim();
  const stripped = raw.replace(/[-_][12]$/, "");
  return stripped && stripped !== raw ? [raw, stripped] : [raw];
}

export function matchModel(
  models: BackendModel[],
  hints: { packId?: string | null; name?: string | null } = {},
): BackendModel | null {
  if (!models.length) return null;

  const packId = optionalString(hints.packId);
  if (packId) {
    for (const candidate of packIdCandidates(packId)) {
      const exact = models.find((model) => model.id === candidate);
      if (exact) return exact;
      const key = normalizeKey(candidate);
      const fuzzy = models.find((model) => {
        const id = normalizeKey(model.id ?? "");
        const label = normalizeKey(model.label ?? "");
        const name = normalizeKey(model.influencerName ?? "");
        return id === key || label === key || name === key;
      });
      if (fuzzy) return fuzzy;
    }
  }

  const nameKey = normalizeKey(hints.name ?? "");
  if (nameKey) {
    const byName = models.find((model) => {
      const influencer = normalizeKey(model.influencerName ?? "");
      const label = normalizeKey(model.label ?? "");
      return influencer === nameKey || label === nameKey;
    });
    if (byName) return byName;
  }

  return models.length === 1 ? models[0]! : null;
}

/**
 * Creator id for `/api/me/creators/{id}/board` and `/creator/:id`.
 * That id is the catalog model id (`julianaval`), never a display-name slug
 * (`juliana`) — the slug 404s on the board endpoint.
 */
export function canonicalCreatorId(
  models: BackendModel[],
  hints: { packId?: string | null; name?: string | null; creatorId?: string | null } = {},
): string {
  const model = matchModel(models, {
    packId: hints.packId || hints.creatorId,
    name: hints.name,
  });
  if (model?.id) return model.id;
  const explicit = optionalString(hints.creatorId);
  if (explicit) return explicit;
  const name = optionalString(hints.name);
  return name ? normalizeKey(name) : "";
}

export function foilsFromModel(model: BackendModel): FoilPack[] {
  const id = modelId(model);
  const face1 = optionalMedia(model.packFaceVideoUrl);
  const face2 = optionalMedia(model.packFaceVideoUrl2);
  const poster1 = optionalMedia(model.packFacePosterUrl) ?? undefined;
  const poster2 = optionalMedia(model.packFacePosterUrl2) ?? undefined;
  const packs: FoilPack[] = [];
  if (face1) {
    packs.push({
      slot: 1,
      id: `${id}-1`,
      label: optionalString(model.cardPackName) ?? "Pack 1",
      videoUrl: face1,
      posterUrl: poster1,
    });
  }
  if (face2) {
    packs.push({
      slot: 2,
      id: `${id}-2`,
      label: optionalString(model.cardPackName2) ?? "Pack 2",
      videoUrl: face2,
      posterUrl: poster2,
    });
  }
  return packs;
}

/** Pick foil 1/2 from a catalog id (`model-2`) or pack/theme label. */
export function foilForInventoryHints(
  model: BackendModel,
  hints: {
    packId?: string | null;
    packName?: string | null;
    themeName?: string | null;
  } = {},
): FoilPack | null {
  const packs = foilsFromModel(model);
  if (!packs.length) return null;

  const packId = optionalString(hints.packId);
  if (packId) {
    const exact = packs.find((pack) => pack.id === packId);
    if (exact) return exact;
    const slot = packId.match(/(?:^|[-_])([12])$/)?.[1];
    if (slot === "1" || slot === "2") {
      const bySlot = packs.find((pack) => pack.slot === Number(slot));
      if (bySlot) return bySlot;
    }
  }

  const name =
    optionalString(hints.packName) ?? optionalString(hints.themeName);
  if (name) {
    const key = normalizeKey(name);
    const byLabel = packs.find((pack) => normalizeKey(pack.label) === key);
    if (byLabel) return byLabel;
    const slot = name.match(/^pack\s*(?:n[ºo°.]?\s*)?(\d+)$/i)?.[1];
    if (slot === "1" || slot === "2") {
      const bySlot = packs.find((pack) => pack.slot === Number(slot));
      if (bySlot) return bySlot;
    }
  }

  return packs[0] ?? null;
}

/** API pack product name — omit generic "Pack 1" placeholders. */
export function cardPackNameFromModel(
  model: BackendModel | null | undefined,
  hints: {
    packId?: string | null;
    packName?: string | null;
    themeName?: string | null;
  } = {},
): string | null {
  if (!model) return null;
  const foil = foilForInventoryHints(model, hints);
  if (!foil) return optionalString(model.cardPackName);
  const named =
    foil.slot === 2
      ? optionalString(model.cardPackName2)
      : optionalString(model.cardPackName);
  return named ?? optionalString(model.cardPackName);
}

export function packFaceVideoFromModel(
  model: BackendModel | null | undefined,
  hints: {
    packId?: string | null;
    packName?: string | null;
    themeName?: string | null;
  } = {},
): string | null {
  if (!model) return null;
  const foil = foilForInventoryHints(model, hints);
  return foil?.videoUrl ?? optionalMedia(model.packFaceVideoUrl);
}

/** API pack-face still for inventory tiles (cheap under / before the decoder). */
export function packFacePosterFromModel(
  model: BackendModel | null | undefined,
  hints: {
    packId?: string | null;
    packName?: string | null;
    themeName?: string | null;
  } = {},
): string | null {
  if (!model) return null;
  const foil = foilForInventoryHints(model, hints);
  return (
    foil?.posterUrl?.trim() ||
    optionalMedia(model.packFacePosterUrl) ||
    null
  );
}

export function modelAvatarUrl(model: BackendModel | null | undefined) {
  return optionalMedia(model?.avatar);
}

export function modelCoverUrl(model: BackendModel | null | undefined) {
  return optionalMedia(model?.coverUrl);
}

export function modelSwipePosterUrl(model: BackendModel | null | undefined) {
  return optionalMedia(model?.swipePosterUrl);
}

/** API Ultra Card trailer video for the creator page teaser. */
export function modelUltraCardTrailerUrl(
  model: BackendModel | null | undefined,
) {
  return optionalMedia(model?.ultraCardTrailerUrl);
}

/** API Ultra Card trailer poster / still frame. */
export function modelUltraCardTrailerPosterUrl(
  model: BackendModel | null | undefined,
) {
  return optionalMedia(model?.ultraCardTrailerPosterUrl);
}

export function profileFromModel(model: BackendModel): ModelProfile {
  const name = modelDisplayName(model);
  return {
    id: modelId(model),
    name,
    collectionLabel: formatCollectionLabel(name),
    city: optionalString(model.influencerCity),
    country: optionalString(model.influencerCountry),
    flagEmoji: optionalString(model.influencerFlag),
    flagSvgUrl: optionalMedia(model.influencerFlagSvg),
    overlayColorStart: optionalString(model.cardOverlayColorStart),
    overlayColorEnd: optionalString(model.cardOverlayColorEnd),
    swipeVideoUrl: optionalMedia(model.swipeVideoUrl),
    packs: foilsFromModel(model),
  };
}

function sortModels(models: BackendModel[]) {
  return [...models].sort((a, b) => {
    const aCreated =
      typeof a.created_at === "number" && Number.isFinite(a.created_at)
        ? a.created_at
        : Number.POSITIVE_INFINITY;
    const bCreated =
      typeof b.created_at === "number" && Number.isFinite(b.created_at)
        ? b.created_at
        : Number.POSITIVE_INFINITY;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return modelDisplayName(a).localeCompare(modelDisplayName(b));
  });
}

export async function fetchModels(): Promise<BackendModel[]> {
  const data = await apiFetch<{ models?: BackendModel[] }>("/api/models");
  return data && Array.isArray(data.models) ? sortModels(data.models) : [];
}

/** Preferred entry point: shares one `/api/models` request across the screen. */
export function loadModels() {
  return cachedRequest("/api/models", CATALOG_TTL_MS, fetchModels);
}

export async function loadModelProfile(
  packId: string,
  name?: string | null,
): Promise<ModelProfile | null> {
  const models = await loadModels();
  const model = matchModel(models, { packId, name });
  return model ? profileFromModel(model) : null;
}
