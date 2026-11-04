import { api } from "../../shared/api";
import { readSavedModelId, writeCurrentModelId } from "../../shared/currentModel";

export type DressModel = {
  id: string;
  label: string;
  avatar: string | null;
  influencerName?: string | null;
};

export type GalleryImage = {
  id: string;
  path: string;
  url: string;
  prompt: string;
  created_at: number;
  created?: boolean;
};

export const GALLERY_CHANGED_EVENT = "sugar-dress-gallery-changed";

export function dressModelName(model: Pick<DressModel, "label" | "influencerName">): string {
  return model.influencerName?.trim() || model.label;
}

/** Saved girl from Models wins over a stale ?model= on this page. */
export function readLinkedModelId(): string {
  return readSavedModelId() || new URLSearchParams(window.location.search).get("model")?.trim() || "";
}

/** Remember the girl on this browser and in the address bar, without reloading the canvas. */
export function writeLinkedModelId(id: string) {
  writeCurrentModelId(id);
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("model", id);
  else url.searchParams.delete("model");
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) window.history.replaceState(null, "", next);
}

export async function fetchDressModels(): Promise<DressModel[]> {
  const data = await api<{ models: DressModel[] }>("/api/models");
  return data.models;
}

export async function fetchGallery(modelId: string): Promise<GalleryImage[]> {
  const data = await api<{ images: GalleryImage[] }>(
    `/api/models/${encodeURIComponent(modelId)}/gallery`,
  );
  return data.images;
}

export async function saveGalleryImage(
  modelId: string,
  src: string,
  prompt = "",
): Promise<GalleryImage> {
  return api<GalleryImage>(`/api/models/${encodeURIComponent(modelId)}/gallery`, {
    method: "POST",
    body: JSON.stringify({ src, prompt: prompt.slice(0, 500) }),
  });
}

export async function deleteGalleryImage(modelId: string, imageId: string): Promise<void> {
  await api(`/api/models/${encodeURIComponent(modelId)}/gallery/${encodeURIComponent(imageId)}`, {
    method: "DELETE",
  });
}

export function notifyGalleryChanged(modelId: string) {
  window.dispatchEvent(new CustomEvent(GALLERY_CHANGED_EVENT, { detail: { modelId } }));
}
