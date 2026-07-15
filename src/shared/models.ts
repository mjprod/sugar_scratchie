import { api } from "./api";
import {
  DEFAULT_BACKGROUND_MOTION_PROMPT,
  DEFAULT_DRESS_PROMPT,
  DEFAULT_THEME,
} from "../videoFlow/schema";

export type ModelInfo = {
  id: string;
  label: string;
  avatar: string | null;
  created_at?: number | null;
};

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

export async function createModel(id: string, label: string): Promise<ModelInfo> {
  return api<ModelInfo>("/api/models", {
    method: "POST",
    body: JSON.stringify({ id, label }),
  });
}

export async function updateModel(modelId: string, label: string): Promise<ModelInfo> {
  return api<ModelInfo>(`/api/models/${encodeURIComponent(modelId)}`, {
    method: "PUT",
    body: JSON.stringify({ label }),
  });
}

export async function deleteModel(modelId: string): Promise<void> {
  await api(`/api/models/${encodeURIComponent(modelId)}`, { method: "DELETE" });
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
      write_webm: true,
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
  const response = await fetch(`/api/models/${encodeURIComponent(modelId)}/avatar`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<ModelInfo>;
}

export async function uploadCardPhoto(cardId: string, file: File): Promise<PhotoInfo> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`/api/cards/${encodeURIComponent(cardId)}/photos`, {
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

export type PhotoScratchSlot = {
  id: string;
  label: string;
  background?: string;
  bikini?: string;
  clothes?: string;
  pending_bg?: string;
  pending_bikini?: string;
  pending_clothes?: string;
};

export type PhotoScratchLayerType = "background" | "bikini" | "clothes";

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
    `Keep face, identity, hair, skin, hands, body pose, camera angle, and the entire ` +
    `background identical. Only replace the bikini with clothing. ` +
    "Photorealistic, 9:16 framing. Do not invent a different woman or move the camera."
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
): Promise<{ id: string; status: string }> {
  return api(`/api/cards/${encodeURIComponent(cardId)}/photo-scratch/generate`, {
    method: "POST",
    body: JSON.stringify({
      theme,
      count: slotId ? 1 : 10,
      provider,
      image_model: imageModel,
      layer,
      image: sourceImage,
      slot_id: slotId,
      prompt,
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
  const response = await fetch(
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
