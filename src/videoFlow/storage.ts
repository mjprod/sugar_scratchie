import {
  backgroundMotionPromptForTheme,
  DEFAULT_BACKGROUND_MOTION_PROMPT,
  DEFAULT_VIDEO_FLOW_JSON,
  dressPromptForTheme,
  isStockBackgroundMotionPromptText,
  isStockDressPromptText,
  INFLUENCER_POSITION,
  normalizePicturePrompts,
  pictureVariationCountOf,
  type PicturePrompts,
  type PictureVariationCount,
  normalizeTheme,
  parseCompressPreset,
  stringifyVideoFlowJson,
  type CompressPreset,
  type VideoFlowJson,
} from "./schema";
import { DEFAULT_MESH_TUNE, meshTuneFromApi, type MeshTuneSettings } from "./meshTune";

export type SourceImageMode = "upload" | "prompt" | "face_swap";

export type AiProvider = "xai" | "wavespeed";

export type SourceImageModel = string;

export type BackgroundVideoModel = string;

export type DressVideoModel = string;

const GENERATION_MODEL_ID = /^[a-z][a-z0-9._-]{0,63}$/;

export const SOURCE_IMAGE_MODELS: { id: string; label: string; wavespeed: boolean }[] = [
  { id: "grok-imagine", label: "Grok Imagine", wavespeed: false },
  { id: "seedream-v5-lite", label: "Seedream v5.0 Lite", wavespeed: true },
];

export const BACKGROUND_VIDEO_MODELS: { id: string; label: string; wavespeed: boolean }[] = [
  { id: "grok-imagine", label: "x.ai Grok Imagine", wavespeed: false },
  { id: "wan-2.2-spicy", label: "WaveSpeed WAN 2.2 Spicy", wavespeed: true },
];

export const DRESS_VIDEO_MODELS: { id: DressVideoModel; label: string; wavespeed: boolean }[] = [
  { id: "grok-imagine", label: "x.ai Grok Imagine", wavespeed: false },
  { id: "seedance-2.0-video-edit", label: "WaveSpeed ByteDance Seedance 2.0 Video Edit", wavespeed: true },
  { id: "wan-3.0-video-edit", label: "WaveSpeed Alibaba WAN 3.0 Video Edit", wavespeed: true },
  { id: "wan-2.2-video-edit", label: "WaveSpeed WAN 2.2 Video Edit", wavespeed: true },
];

export const DEFAULT_SOURCE_IMAGE_PROVIDER: AiProvider = "wavespeed";
export const DEFAULT_SOURCE_IMAGE_MODEL: SourceImageModel = "seedream-v5-lite";
export const DEFAULT_DRESS_VIDEO_MODEL: DressVideoModel = "grok-imagine";

export function isWavespeedDressVideoModel(model: DressVideoModel): boolean {
  return DRESS_VIDEO_MODELS.some((entry) => entry.id === model && entry.wavespeed);
}

/** WaveSpeed edit models that accept the dress reference image directly (no Grok caption). */
export function dressModelTakesReferenceImage(model: DressVideoModel): boolean {
  return model === "wan-3.0-video-edit" || model === "seedance-2.0-video-edit";
}

export function parseBackgroundVideoModel(value: unknown): BackgroundVideoModel {
  if (value === "wan-2.2-spicy" || value === "wan-2.2-spicy/image-to-video") return "wan-2.2-spicy";
  if (typeof value === "string" && GENERATION_MODEL_ID.test(value)) return value;
  return "grok-imagine";
}

const DRESS_MODEL_ALIASES: Record<string, string> = {
  "grok-imagine-video": "grok-imagine",
  "alibaba/wan-3.0/video-edit": "wan-3.0-video-edit",
  "bytedance/seedance-2.0/video-edit": "seedance-2.0-video-edit",
};

export function parseDressVideoModel(value: unknown): DressVideoModel {
  if (typeof value !== "string") return DEFAULT_DRESS_VIDEO_MODEL;
  const aliased = DRESS_MODEL_ALIASES[value] ?? value;
  if (DRESS_VIDEO_MODELS.some((entry) => entry.id === aliased) || GENERATION_MODEL_ID.test(aliased)) {
    return aliased;
  }
  return DEFAULT_DRESS_VIDEO_MODEL;
}

export function wavespeedPipelineModelValue(
  sourceImageModel: SourceImageModel,
  backgroundVideoModel: BackgroundVideoModel,
  spicyIds: readonly string[] = ["wan-2.2-spicy"],
): string {
  if (spicyIds.includes(backgroundVideoModel)) return backgroundVideoModel;
  return sourceImageModel;
}

export function parseAiProvider(value: unknown): AiProvider {
  return value === "wavespeed" || value === "seedream-v5-lite" ? "wavespeed" : "xai";
}

export function parseSourceImageModel(value: unknown, legacyProvider?: unknown): SourceImageModel {
  const legacySeedream =
    legacyProvider === "seedream-v5-lite" || legacyProvider === "seedream-v5.0-lite";
  if (value === "seedream-v5-lite" || value === "seedream-v5.0-lite") return "seedream-v5-lite";
  if (typeof value === "string" && value !== "grok-imagine" && GENERATION_MODEL_ID.test(value)) {
    return value;
  }
  if (legacySeedream) return "seedream-v5-lite";
  return "grok-imagine";
}

export const LEGACY_LOOKBOOK_PORTRAIT_PROMPT =
  "Medium full-body portrait of a woman in casual fitted resort wear, plain white studio background, facing camera, fashion editorial photo. Frame from head to mid-thigh so she fills most of the vertical frame — same camera distance as a standard fashion lookbook shot. Do not crop as a close-up face shot and do not pull back to a distant full-body wide shot with empty space.";

export const DEFAULT_PORTRAIT_PROMPT =
  `Portrait of a woman in casual fitted resort wear, plain white studio background, facing camera, fashion editorial photo. ${INFLUENCER_POSITION}`;

export const LEGACY_PORTRAIT_PROMPT =
  "Full-body portrait of a woman in casual fitted resort wear, plain white studio background, facing camera, fashion editorial photo.";

export const LEGACY_BIKINI_PORTRAIT_PROMPT =
  "Full-body portrait of a woman in a black bikini, plain white studio background, facing camera, fashion photo.";

export function isStockPortraitPrompt(prompt: string): boolean {
  const stripped = prompt.trim();
  return (
    !stripped ||
    stripped === DEFAULT_PORTRAIT_PROMPT ||
    stripped === LEGACY_LOOKBOOK_PORTRAIT_PROMPT ||
    stripped === LEGACY_PORTRAIT_PROMPT ||
    stripped === LEGACY_BIKINI_PORTRAIT_PROMPT
  );
}

function normalizeStoredMotionPrompt(prompt: string | undefined, theme: string): string {
  const scenery = normalizeTheme(theme);
  if (isStockBackgroundMotionPromptText(prompt ?? "", scenery)) {
    return backgroundMotionPromptForTheme(scenery);
  }
  return (prompt ?? "").trim() || DEFAULT_BACKGROUND_MOTION_PROMPT;
}

function normalizeStoredDressPrompt(prompt: string | undefined, theme: string): string {
  const scenery = normalizeTheme(theme);
  if (isStockDressPromptText(prompt ?? "", scenery)) {
    return dressPromptForTheme(scenery);
  }
  return (prompt ?? "").trim();
}

export type StoredVideoFlowDraft = {
  image: string;
  theme: string;
  picturePrompts: PicturePrompts;
  pictureVariationCount: PictureVariationCount;
  backgroundMotionPrompt: string;
  foregroundMotionPrompt: string;
  dressPrompt: string;
  dressReferenceImage: string;
  cardId: string;
  cardLabel: string;
  modelId: string;
  writeWebm: boolean;
  compressPreset: CompressPreset;
  resolution: string;
  tracker: "bootstapir" | "cotracker" | "blend" | "all";
  meshTune: MeshTuneSettings;
  sourceMode: SourceImageMode;
  sourcePrompt: string;
  faceImage: string;
  bikiniImage: string;
  baseImage: string;
  aiProvider: AiProvider;
  sourceImageModel: SourceImageModel;
  backgroundVideoModel: BackgroundVideoModel;
  dressVideoModel: DressVideoModel;
};

const DRAFT_STORAGE_KEY = "sugar-scratchie:video-flow-draft";
const FLOW_JSON_STORAGE_KEY = "sugar-scratchie:video-flow-json";
const ACTIVE_PROJECT_STORAGE_KEY = "sugar-scratchie:video-flow-active-project";

export function readStoredVideoFlowDraft(): StoredVideoFlowDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredVideoFlowDraft> & { picturePrompt?: string };
    if (!parsed.cardId && !parsed.image) return null;
    const theme = normalizeTheme(parsed.theme);
    const rawPicturePrompts = Array.isArray(parsed.picturePrompts) ? parsed.picturePrompts : undefined;
    return {
      image: parsed.image ?? "",
      theme,
      picturePrompts: normalizePicturePrompts(rawPicturePrompts, theme, parsed.picturePrompt),
      pictureVariationCount: pictureVariationCountOf(parsed.pictureVariationCount),
      backgroundMotionPrompt: normalizeStoredMotionPrompt(parsed.backgroundMotionPrompt, theme),
      foregroundMotionPrompt: normalizeStoredMotionPrompt(
        parsed.foregroundMotionPrompt || parsed.backgroundMotionPrompt,
        theme,
      ),
      dressPrompt: normalizeStoredDressPrompt(parsed.dressPrompt, theme),
      dressReferenceImage: parsed.dressReferenceImage ?? "",
      cardId: parsed.cardId ?? "",
      cardLabel: parsed.cardLabel ?? "",
      modelId: parsed.modelId ?? "",
      writeWebm: parsed.writeWebm ?? false,
      compressPreset: parseCompressPreset(parsed.compressPreset),
      resolution: parsed.resolution ?? "720p",
      tracker: parsed.tracker ?? "all",
      meshTune: meshTuneFromApi(parsed.meshTune),
      sourceMode: parsed.sourceMode ?? "upload",
      sourcePrompt: isStockPortraitPrompt(parsed.sourcePrompt ?? "")
        ? DEFAULT_PORTRAIT_PROMPT
        : (parsed.sourcePrompt ?? DEFAULT_PORTRAIT_PROMPT),
      faceImage: parsed.faceImage ?? "",
      bikiniImage: parsed.bikiniImage ?? "",
      baseImage: parsed.baseImage ?? "",
      aiProvider: parseAiProvider(parsed.aiProvider),
      sourceImageModel: parseSourceImageModel(parsed.sourceImageModel, parsed.aiProvider),
      backgroundVideoModel: parseBackgroundVideoModel(parsed.backgroundVideoModel),
      dressVideoModel: parseDressVideoModel(parsed.dressVideoModel),
    };
  } catch {
    return null;
  }
}

export function writeStoredVideoFlowDraft(draft: StoredVideoFlowDraft) {
  localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
}

export function readStoredFlowJson(): VideoFlowJson | null {
  try {
    const raw = localStorage.getItem(FLOW_JSON_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as VideoFlowJson;
  } catch {
    return null;
  }
}

export function writeStoredFlowJson(flow: VideoFlowJson) {
  localStorage.setItem(FLOW_JSON_STORAGE_KEY, JSON.stringify(flow));
}

export function readActiveProjectId(): string {
  return localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY)?.trim() ?? "";
}

export function writeActiveProjectId(projectId: string) {
  if (projectId.trim()) {
    localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, projectId.trim());
  } else {
    localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
  }
}

export function canUseAiProvider(
  provider: AiProvider,
  health: { xai_key_loaded?: boolean; wavespeed_key_loaded?: boolean } | null,
): boolean {
  if (!health) return false;
  if (provider === "xai") return Boolean(health.xai_key_loaded);
  return Boolean(health.wavespeed_key_loaded);
}

export function readFlowJsonText(): string {
  const stored = readStoredFlowJson();
  return stringifyVideoFlowJson(stored ?? DEFAULT_VIDEO_FLOW_JSON);
}

export function storedDraftFromApi(draft?: {
  image?: string;
  theme?: string;
  picture_prompt?: string;
  picture_prompts?: string[];
  picture_variation_count?: number;
  background_motion_prompt?: string;
  foreground_motion_prompt?: string;
  dress_prompt?: string;
  dress_reference_image?: string;
  card_id?: string;
  card_label?: string;
  model_id?: string;
  write_webm?: boolean;
  compress_preset?: string;
  resolution?: string;
  tracker?: string;
  source_mode?: string;
  source_prompt?: string;
  face_image?: string;
  bikini_image?: string;
  base_image?: string;
  mesh_tune?: unknown;
  ai_provider?: string;
  source_image_model?: string;
  background_video_model?: string;
  dress_video_model?: string;
}): StoredVideoFlowDraft | null {
  if (!draft?.card_id) return null;
  const theme = normalizeTheme(draft.theme);
  return {
    image: draft.image ?? "",
    theme,
    picturePrompts: normalizePicturePrompts(draft.picture_prompts, theme, draft.picture_prompt),
    pictureVariationCount: pictureVariationCountOf(draft.picture_variation_count),
    backgroundMotionPrompt: draft.background_motion_prompt ?? "",
    foregroundMotionPrompt: draft.foreground_motion_prompt ?? "",
    dressPrompt: normalizeStoredDressPrompt(draft.dress_prompt, theme),
    dressReferenceImage: draft.dress_reference_image ?? "",
    cardId: draft.card_id,
    cardLabel: draft.card_label ?? "",
    modelId: draft.model_id ?? "",
    writeWebm: draft.write_webm ?? false,
    compressPreset: parseCompressPreset(draft.compress_preset),
    resolution: draft.resolution ?? "720p",
    tracker: (draft.tracker as StoredVideoFlowDraft["tracker"]) ?? "all",
    meshTune: meshTuneFromApi(draft.mesh_tune),
    // Clamp to known modes for backward compatibility.
    sourceMode:
      draft.source_mode === "prompt" || draft.source_mode === "face_swap" || draft.source_mode === "upload"
        ? (draft.source_mode as SourceImageMode)
        : "upload",
    sourcePrompt: draft.source_prompt ?? "",
    faceImage: draft.face_image ?? "",
    bikiniImage: draft.bikini_image ?? "",
    baseImage: draft.base_image ?? "",
    aiProvider: parseAiProvider(draft.ai_provider),
    sourceImageModel: parseSourceImageModel(draft.source_image_model, draft.ai_provider),
    backgroundVideoModel: parseBackgroundVideoModel(draft.background_video_model),
    dressVideoModel: parseDressVideoModel(draft.dress_video_model),
  };
}
