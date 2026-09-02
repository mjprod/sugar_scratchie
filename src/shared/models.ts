import { api, operatorFetch } from "./api";
import {
  DEFAULT_BACKGROUND_MOTION_PROMPT,
  DEFAULT_DRESS_PROMPT,
  DEFAULT_THEME,
} from "../videoFlow/schema";

export type ModelInfluencerProfile = {
  influencerName?: string | null;
  influencerCity?: string | null;
  influencerCountry?: string | null;
  influencerFlag?: string | null;
  /** Uploaded SVG flag URL, e.g. "/models/julianaval/flag.svg". */
  influencerFlagSvg?: string | null;
  /** Card overlay gradient start, e.g. "#ff8fab". */
  cardOverlayColorStart?: string | null;
  /** Card overlay gradient end, e.g. "#ff0a54". */
  cardOverlayColorEnd?: string | null;
  /** Foil pack 3D light 1 (hemisphere sky / key), e.g. "#ffffff". */
  cardLightColor1?: string | null;
  /** Foil pack 3D light 2 (hemisphere ground / fill), e.g. "#1a1020". */
  cardLightColor2?: string | null;
  /** Freeform labels for dashboard filtering, e.g. ["latina", "featured"]. */
  tags?: string[];
};

export type ModelGlobalMedia = {
  /** Foil 3D pack video 1, e.g. "/models/julianaval/pack-face.mp4". */
  packFaceVideoUrl?: string | null;
  /** Foil 3D pack video 2. */
  packFaceVideoUrl2?: string | null;
  /** Home swipe motion video. */
  swipeVideoUrl?: string | null;
  /** Still photo for swipe card / discovery poster, e.g. "/models/julianaval/swipe-poster.jpg". */
  swipePosterUrl?: string | null;
  /** Product label for foil pack 1 (replaces "Pack Nº …" when set). */
  cardPackName?: string | null;
  /** Product label for foil pack 2. */
  cardPackName2?: string | null;
};

export type ModelInfo = {
  id: string;
  label: string;
  avatar: string | null;
  created_at?: number | null;
  /** theme_id → public URL for model×theme collection avatar. */
  theme_avatars?: Record<string, string>;
} & ModelInfluencerProfile &
  ModelGlobalMedia;

export type ModelVideoKind = "pack-face" | "pack-face-2" | "swipe";

export type UpdateModelPayload = {
  label?: string;
} & ModelInfluencerProfile &
  Pick<ModelGlobalMedia, "cardPackName" | "cardPackName2">;

export type PhotoInfo = {
  id: string;
  src: string;
};

export type CardWithModel = {
  id: string;
  label: string;
  model_id?: string;
  photos?: PhotoInfo[];
};

export async function fetchModels(): Promise<ModelInfo[]> {
  try {
    const data = await api<{ models: ModelInfo[] }>("/api/models");
    return data.models;
  } catch {
    try {
      const response = await fetch("/models/index.json", { cache: "no-store" });
      if (!response.ok) return [];
      const data = (await response.json()) as { models?: ModelInfo[] };
      return data.models ?? [];
    } catch {
      return [];
    }
  }
}

export async function createModel(
  id: string,
  label: string,
  profile?: ModelInfluencerProfile,
): Promise<ModelInfo> {
  return api<ModelInfo>("/api/models", {
    method: "POST",
    body: JSON.stringify({ id, label, ...profile }),
  });
}

export async function updateModel(
  modelId: string,
  payload: UpdateModelPayload | string,
): Promise<ModelInfo> {
  const body = typeof payload === "string" ? { label: payload } : payload;
  return api<ModelInfo>(`/api/models/${encodeURIComponent(modelId)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function deleteModel(modelId: string): Promise<void> {
  await api(`/api/models/${encodeURIComponent(modelId)}`, { method: "DELETE" });
}

/** Recursively deletes a motion card (videos, photo-scratch, mesh, video-flow draft). */
export async function deleteCard(cardId: string): Promise<void> {
  await api(`/api/cards/${encodeURIComponent(cardId)}`, { method: "DELETE" });
}

export async function assignCardToModel(cardId: string, modelId: string): Promise<void> {
  await api(`/api/cards/${encodeURIComponent(cardId)}`, {
    method: "PUT",
    body: JSON.stringify({ model_id: modelId }),
  });
}

/** Create an empty Video Flow draft for a new motion card, assigned to a model. */
export async function createMotionCardDraft(
  cardId: string,
  cardLabel: string,
  modelId: string,
): Promise<void> {
  const id = cardId.trim();
  const label = cardLabel.trim() || id;
  await api(`/api/video-flow/${encodeURIComponent(id)}/draft`, {
    method: "POST",
    body: JSON.stringify({
      image: "",
      theme: DEFAULT_THEME,
      background_motion_prompt: DEFAULT_BACKGROUND_MOTION_PROMPT,
      foreground_motion_prompt: DEFAULT_BACKGROUND_MOTION_PROMPT,
      dress_prompt: DEFAULT_DRESS_PROMPT,
      dress_reference_image: "",
      card_id: id,
      card_label: label,
      model_id: modelId.trim(),
      resolution: "720p",
      enhance_dress_prompt: true,
      tracker: "all",
      write_webm: false,
      compress_preset: "mobile",
      source_mode: "upload",
      source_prompt: "",
      face_image: "",
      base_image: "",
    }),
  });
}

export async function reorderModelCards(modelId: string, cardIds: string[]): Promise<void> {
  await api(`/api/models/${encodeURIComponent(modelId)}/cards/order`, {
    method: "PUT",
    body: JSON.stringify({ card_ids: cardIds }),
  });
}

export async function uploadModelAvatar(modelId: string, file: File): Promise<ModelInfo> {
  const form = new FormData();
  form.append("file", file);
  const response = await operatorFetch(`/api/models/${encodeURIComponent(modelId)}/avatar`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<ModelInfo>;
}

export async function uploadModelThemeAvatar(
  modelId: string,
  themeId: string,
  file: File,
): Promise<ModelInfo> {
  const form = new FormData();
  form.append("file", file);
  const response = await operatorFetch(
    `/api/models/${encodeURIComponent(modelId)}/themes/${encodeURIComponent(themeId)}/avatar`,
    {
      method: "POST",
      body: form,
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<ModelInfo>;
}

export async function deleteModelThemeAvatar(
  modelId: string,
  themeId: string,
): Promise<ModelInfo> {
  return api<ModelInfo>(
    `/api/models/${encodeURIComponent(modelId)}/themes/${encodeURIComponent(themeId)}/avatar`,
    { method: "DELETE" },
  );
}

export async function uploadCardTrailer(cardId: string, file: File): Promise<{
  id: string;
  trailer?: string | null;
  theme_id?: string | null;
}> {
  const form = new FormData();
  form.append("file", file);
  const response = await operatorFetch(`/api/cards/${encodeURIComponent(cardId)}/trailer`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<{ id: string; trailer?: string | null; theme_id?: string | null }>;
}

export async function deleteCardTrailer(cardId: string): Promise<{
  id: string;
  trailer?: string | null;
}> {
  return api<{ id: string; trailer?: string | null }>(
    `/api/cards/${encodeURIComponent(cardId)}/trailer`,
    { method: "DELETE" },
  );
}

export async function uploadModelFlagSvg(modelId: string, file: File): Promise<ModelInfo> {
  const form = new FormData();
  form.append("file", file);
  const response = await operatorFetch(`/api/models/${encodeURIComponent(modelId)}/flag`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<ModelInfo>;
}

export async function deleteModelFlagSvg(modelId: string): Promise<ModelInfo> {
  return api<ModelInfo>(`/api/models/${encodeURIComponent(modelId)}/flag`, {
    method: "DELETE",
  });
}

export async function uploadModelVideo(
  modelId: string,
  kind: ModelVideoKind,
  file: File,
): Promise<ModelInfo> {
  const form = new FormData();
  form.append("file", file);
  const response = await operatorFetch(
    `/api/models/${encodeURIComponent(modelId)}/${kind}`,
    {
      method: "POST",
      body: form,
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<ModelInfo>;
}

export async function uploadModelPackFace(modelId: string, file: File): Promise<ModelInfo> {
  return uploadModelVideo(modelId, "pack-face", file);
}

export async function uploadModelPackFace2(modelId: string, file: File): Promise<ModelInfo> {
  return uploadModelVideo(modelId, "pack-face-2", file);
}

export async function uploadModelSwipe(modelId: string, file: File): Promise<ModelInfo> {
  return uploadModelVideo(modelId, "swipe", file);
}

export async function uploadModelSwipePoster(
  modelId: string,
  file: File,
): Promise<ModelInfo> {
  const form = new FormData();
  form.append("file", file);
  const response = await operatorFetch(
    `/api/models/${encodeURIComponent(modelId)}/swipe-poster`,
    {
      method: "POST",
      body: form,
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<ModelInfo>;
}

export async function uploadCardPhoto(cardId: string, file: File): Promise<PhotoInfo> {
  const form = new FormData();
  form.append("file", file);
  const response = await operatorFetch(`/api/cards/${encodeURIComponent(cardId)}/photos`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<PhotoInfo>;
}

export async function deleteCardPhoto(cardId: string, photoId: string): Promise<void> {
  await api(`/api/cards/${encodeURIComponent(cardId)}/photos/${encodeURIComponent(photoId)}`, {
    method: "DELETE",
  });
}

export type PhotoScratchLayerType = "background" | "bikini" | "clothes";

export type PhotoScratchSlot = {
  id: string;
  label: string;
  background?: string;
  bikini?: string;
  clothes?: string;
  pending_bg?: string;
  pending_bikini?: string;
  pending_clothes?: string;
  /** Optional per-slot prompts for each layer. */
  prompt_background?: string;
  prompt_bikini?: string;
  prompt_clothes?: string;
  /** Per-slot static photo mesh URL (not the motion-card video mesh). */
  mesh?: string;
  has_symbols?: boolean;
  /** Bikini + clothes are RGBA cutouts (girl without background). */
  has_cutout?: boolean;
  /** Derived cutout PNG URLs — originals stay on bikini/clothes. */
  bikini_cutout?: string;
  clothes_cutout?: string;
  /** Pristine pre-zoom cutouts for Zooming live preview. */
  bikini_cutout_src?: string;
  clothes_cutout_src?: string;
  /** Top warped onto bikini pose (before cutout). */
  has_match?: boolean;
  clothes_matched?: string;
  /** Difference blend (|bikini − matched|) for Match QA. */
  match_overlay?: string;
  /** 50/50 mixed blend of bikini + matched top. */
  match_blend?: string;
  match_pose_ok?: boolean;
  match_iou?: number | null;
  /** Adjust step confirmed (or cutout already exists). */
  has_adjust?: boolean;
  /** Last manual nudge from match_meta. */
  match_nudge_scale?: number | null;
  match_nudge_tx?: number | null;
  match_nudge_ty?: number | null;
  /** Zooming step confirmed (or legacy meshed slot). */
  has_zoom?: boolean;
  /** Last zoom applied to cutouts (from zoom_meta). */
  zoom_scale?: number | null;
  zoom_tx?: number | null;
  zoom_ty?: number | null;
};

const SLOT_PROMPT_KEY: Record<PhotoScratchLayerType, keyof PhotoScratchSlot> = {
  background: "prompt_background",
  bikini: "prompt_bikini",
  clothes: "prompt_clothes",
};

export function slotLayerPrompt(
  slot: PhotoScratchSlot,
  layer: PhotoScratchLayerType,
): string {
  const value = slot[SLOT_PROMPT_KEY[layer]];
  return typeof value === "string" ? value.trim() : "";
}

/** Default AI prompts (mirrors backend/services/grok.py). Theme is filled from the card theme. */
export function defaultPhotoScratchPrompt(
  layer: PhotoScratchLayerType,
  theme: string,
  options?: { withBackground?: boolean },
): string {
  const scenery = theme.trim() || "stylish";
  if (layer === "background") {
    return (
      `Empty ${scenery} themed room/scene backdrop only — no people, no faces, no body. ` +
      "Photorealistic, soft professional lighting, 9:16 vertical, suitable as a scratch-card background plate."
    );
  }
  if (layer === "bikini") {
    if (options?.withBackground) {
      return (
        `Composite edit with two references: (1) the ENVIRONMENT / room to keep, ` +
        `(2) the WOMAN whose identity to keep. Put the exact same woman from reference 2 ` +
        `into the full scene from reference 1. Completely replace her original plain wall / ` +
        `studio backdrop. She wears a flattering ${scenery} bikini/swimwear. ` +
        `Each card gets a different pose (backend adds one per slot). Keep only face, identity, ` +
        `hair, skin tone, and body proportions — do NOT copy her source pose or camera crop. ` +
        "Full body, photorealistic, 9:16. Do not invent a different woman."
      );
    }
    return (
      `Using this exact same woman from the reference image, change her outfit to a ` +
      `flattering ${scenery} bikini/swimwear and restage her with a new pose (backend varies ` +
      `pose per card). Keep face, identity, hair, skin tone, and body proportions. ` +
      `Clean studio / transparent-friendly backdrop. Full body, photorealistic, 9:16. ` +
      "Do not invent a different woman."
    );
  }
  return (
    `Using this exact same woman, pose, framing, and background, change only her outfit ` +
    `to a fully clothed ${scenery} costume/dress suitable for a scratch-card top layer. ` +
    `Make the costume a little bigger / fuller than skintight: slightly looser sleeves, ` +
    `bodice, and skirt so fabric covers a bit past the bikini silhouette. OPAQUE full ` +
    `coverage — no sheer fabric, no open zipper, no see-through panels. The bikini must ` +
    `be completely hidden; no bikini print or skin where clothing should be. ` +
    `Keep face, identity, hair, skin, hands, body pose, camera angle, and the entire ` +
    `background identical. Lock every limb: same arm angles, elbow bends, hand positions, ` +
    `hip stance, and leg placement as the reference — do not raise, lower, or shift either ` +
    `arm. FRONT VIEW ONLY — she faces the camera as in the reference. Do NOT show her ` +
    `back, rear shoulder, spine, or buttocks, and do NOT twist the torso so one side ` +
    `looks like a back view. If an arm is raised (hand in hair), keep that exact raised ` +
    `arm silhouette — only change fabric; no second sleeve or back-of-body fill in the ` +
    `armpit. Exactly one left arm and one right arm — no ghost limbs or duplicate sleeves. ` +
    `Only replace the bikini with clothing; do not restage the body. ` +
    `EXPOSURE LOCK — keep the exact same bright exposure and lighting as the reference; ` +
    `do not darken the image, lower brightness, or crush shadows even if the outfit is dark. ` +
    `FACE LOCK — keep her face identical to the reference: same eyes, nose, mouth, and ` +
    `expression. No horizontal seams, smears, double mouths, or sliced nose. Keep her ` +
    `face sharp and in focus — clear eyes, natural skin detail, not soft or ` +
    `airbrushed-blurry. Photorealistic, 9:16 framing. Do not invent a different woman ` +
    "or move the camera."
  );
}

export async function fetchPhotoScratchSlots(
  cardId: string,
  theme = "",
): Promise<PhotoScratchSlot[]> {
  const params = theme.trim() ? `?theme=${encodeURIComponent(theme.trim())}` : "";
  const data = await api<{ slots: PhotoScratchSlot[] }>(
    `/api/cards/${encodeURIComponent(cardId)}/photo-scratch${params}`,
  );
  return data.slots;
}

export async function generatePhotoScratchLayer(
  cardId: string,
  layer: PhotoScratchLayerType,
  theme: string,
  provider: string,
  imageModel: string,
  sourceImage = "",
  slotId = "",
  prompt = "",
  count = 10,
  fillEmptyOnly = true,
): Promise<{ id: string; status: string }> {
  return api(`/api/cards/${encodeURIComponent(cardId)}/photo-scratch/generate`, {
    method: "POST",
    body: JSON.stringify({
      theme,
      count: slotId ? 1 : count,
      provider,
      image_model: imageModel,
      layer,
      image: sourceImage,
      slot_id: slotId,
      prompt,
      fill_empty_only: slotId ? false : fillEmptyOnly,
    }),
  });
}

/** @deprecated Prefer generatePhotoScratchLayer(cardId, "background", ...) */
export async function generatePhotoScratchBackgrounds(
  cardId: string,
  theme: string,
  provider: string,
  imageModel: string,
): Promise<{ id: string; status: string }> {
  return generatePhotoScratchLayer(cardId, "background", theme, provider, imageModel);
}

export async function uploadPhotoScratchLayer(
  cardId: string,
  slotId: string,
  layer: PhotoScratchLayerType,
  file: File,
  theme = "",
): Promise<PhotoScratchSlot> {
  const form = new FormData();
  form.append("file", file);
  const params = theme.trim() ? `?theme=${encodeURIComponent(theme.trim())}` : "";
  const response = await operatorFetch(
    `/api/cards/${encodeURIComponent(cardId)}/photo-scratch/${encodeURIComponent(slotId)}/${layer}${params}`,
    { method: "POST", body: form },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<PhotoScratchSlot>;
}

export async function deletePhotoScratchLayer(
  cardId: string,
  slotId: string,
  layer: PhotoScratchLayerType,
  theme = "",
): Promise<PhotoScratchSlot> {
  const params = theme.trim() ? `?theme=${encodeURIComponent(theme.trim())}` : "";
  return api<PhotoScratchSlot>(
    `/api/cards/${encodeURIComponent(cardId)}/photo-scratch/${encodeURIComponent(slotId)}/${layer}${params}`,
    { method: "DELETE" },
  );
}

export async function approvePhotoScratchLayer(
  cardId: string,
  slotId: string,
  layer: PhotoScratchLayerType,
  theme = "",
): Promise<PhotoScratchSlot> {
  const search = new URLSearchParams({ layer });
  if (theme.trim()) search.set("theme", theme.trim());
  return api<PhotoScratchSlot>(
    `/api/cards/${encodeURIComponent(cardId)}/photo-scratch/${encodeURIComponent(slotId)}/approve-layer?${search}`,
    { method: "POST" },
  );
}

export async function rejectPhotoScratchLayer(
  cardId: string,
  slotId: string,
  layer: PhotoScratchLayerType,
  theme = "",
): Promise<PhotoScratchSlot> {
  const search = new URLSearchParams({ layer });
  if (theme.trim()) search.set("theme", theme.trim());
  return api<PhotoScratchSlot>(
    `/api/cards/${encodeURIComponent(cardId)}/photo-scratch/${encodeURIComponent(slotId)}/reject-layer?${search}`,
    { method: "POST" },
  );
}

export async function setPhotoScratchSlotPrompt(
  cardId: string,
  slotId: string,
  layer: PhotoScratchLayerType,
  prompt: string,
  theme = "",
): Promise<PhotoScratchSlot> {
  const params = theme.trim() ? `?theme=${encodeURIComponent(theme.trim())}` : "";
  return api<PhotoScratchSlot>(
    `/api/cards/${encodeURIComponent(cardId)}/photo-scratch/${encodeURIComponent(slotId)}/prompt${params}`,
    {
      method: "PATCH",
      body: JSON.stringify({ layer, prompt }),
    },
  );
}

export async function publishPhotoScratchGame(
  cardId: string,
  slotId = "",
): Promise<{
  published: number;
  card_id: string;
  first_id?: string | null;
  slot_id?: string | null;
}> {
  const params = slotId.trim()
    ? `?slot_id=${encodeURIComponent(slotId.trim())}`
    : "";
  return api(
    `/api/cards/${encodeURIComponent(cardId)}/photo-scratch/publish-game${params}`,
    { method: "POST" },
  );
}

export function photoScratchPlayHref(cardId: string, slotEntryId?: string | null): string {
  const id = (slotEntryId || cardId).trim();
  if (!id) return "/photo-scratch";
  return `/photo-scratch?card=${encodeURIComponent(id)}`;
}

export function photoScratchSlotPlayHref(cardId: string, slotId: string): string {
  return photoScratchPlayHref(`${cardId.trim()}_${slotId.trim()}`);
}

export function photoScratchSlotIsDone(slot: PhotoScratchSlot): boolean {
  return Boolean(
    slot.background &&
      slot.bikini &&
      slot.clothes &&
      slot.has_match &&
      slot.has_cutout &&
      slot.has_zoom &&
      slot.mesh &&
      slot.has_symbols,
  );
}

export async function matchPhotoScratchSlot(
  cardId: string,
  slotId: string,
  theme = "",
  options?: {
    relock?: boolean;
    scale?: number;
    tx?: number;
    ty?: number;
    confirmAdjust?: boolean;
  },
): Promise<{ id: string; status: string }> {
  const params = new URLSearchParams();
  if (theme.trim()) params.set("theme", theme.trim());
  if (options?.relock) params.set("relock", "true");
  if (options?.scale != null) params.set("scale", String(options.scale));
  if (options?.tx != null) params.set("tx", String(options.tx));
  if (options?.ty != null) params.set("ty", String(options.ty));
  if (options?.confirmAdjust) params.set("confirm_adjust", "true");
  const q = params.toString() ? `?${params.toString()}` : "";
  return api(
    `/api/cards/${encodeURIComponent(cardId)}/photo-scratch/${encodeURIComponent(slotId)}/match${q}`,
    { method: "POST" },
  );
}

export async function confirmPhotoScratchSlotAdjust(
  cardId: string,
  slotId: string,
  theme = "",
): Promise<PhotoScratchSlot> {
  const params = theme.trim() ? `?theme=${encodeURIComponent(theme.trim())}` : "";
  return api(
    `/api/cards/${encodeURIComponent(cardId)}/photo-scratch/${encodeURIComponent(slotId)}/confirm-adjust${params}`,
    { method: "POST" },
  );
}

export async function cutoutPhotoScratchSlot(
  cardId: string,
  slotId: string,
  theme = "",
): Promise<{ id: string; status: string }> {
  const params = theme.trim() ? `?theme=${encodeURIComponent(theme.trim())}` : "";
  return api(
    `/api/cards/${encodeURIComponent(cardId)}/photo-scratch/${encodeURIComponent(slotId)}/cutout${params}`,
    { method: "POST" },
  );
}

export async function zoomPhotoScratchSlot(
  cardId: string,
  slotId: string,
  theme = "",
  options?: {
    scale?: number;
    tx?: number;
    ty?: number;
    apply?: boolean;
    confirm?: boolean;
  },
): Promise<PhotoScratchSlot> {
  const params = new URLSearchParams();
  if (theme.trim()) params.set("theme", theme.trim());
  if (options?.scale != null) params.set("scale", String(options.scale));
  if (options?.tx != null) params.set("tx", String(options.tx));
  if (options?.ty != null) params.set("ty", String(options.ty));
  if (options?.apply) params.set("apply", "true");
  if (options?.confirm) params.set("confirm", "true");
  const q = params.toString() ? `?${params.toString()}` : "";
  return api(
    `/api/cards/${encodeURIComponent(cardId)}/photo-scratch/${encodeURIComponent(slotId)}/zoom${q}`,
    { method: "POST" },
  );
}

export async function generatePhotoScratchSlotMesh(
  cardId: string,
  slotId: string,
  theme = "",
): Promise<{ id: string; status: string }> {
  const params = theme.trim() ? `?theme=${encodeURIComponent(theme.trim())}` : "";
  return api(
    `/api/cards/${encodeURIComponent(cardId)}/photo-scratch/${encodeURIComponent(slotId)}/mesh${params}`,
    { method: "POST" },
  );
}

export async function fetchPhotoScratchSlotSymbols(
  cardId: string,
  slotId: string,
): Promise<{ points: Array<{ u: number; v: number }>; required: number; complete: boolean }> {
  return api(
    `/api/cards/${encodeURIComponent(cardId)}/photo-scratch/${encodeURIComponent(slotId)}/symbol-points`,
  );
}

export async function savePhotoScratchSlotSymbols(
  cardId: string,
  slotId: string,
  points: Array<{ u: number; v: number }>,
): Promise<PhotoScratchSlot> {
  return api(
    `/api/cards/${encodeURIComponent(cardId)}/photo-scratch/${encodeURIComponent(slotId)}/symbol-points`,
    {
      method: "POST",
      body: JSON.stringify({ points }),
    },
  );
}

/** @deprecated Prefer approvePhotoScratchLayer(cardId, slotId, "background", ...) */
export async function approvePhotoScratchBg(
  cardId: string,
  slotId: string,
  theme = "",
): Promise<PhotoScratchSlot> {
  return approvePhotoScratchLayer(cardId, slotId, "background", theme);
}

/** @deprecated Prefer rejectPhotoScratchLayer(cardId, slotId, "background", ...) */
export async function rejectPhotoScratchBg(
  cardId: string,
  slotId: string,
  theme = "",
): Promise<PhotoScratchSlot> {
  return rejectPhotoScratchLayer(cardId, slotId, "background", theme);
}
