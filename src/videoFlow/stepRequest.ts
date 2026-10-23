import { meshTuneToApi, type MeshTuneSettings } from "./meshTune";
import {
  DEFAULT_PICTURE_MODELS,
  ensureImageTokens,
  pictureImageTokens,
  type PictureCompareMode,
  type PictureModels,
} from "./schema";

/** Picture step shared by Run and Lite. Change it here and both pages send it. */
export const FLOW_PICTURE_VARIATION_COUNT = 2;
export const FLOW_PICTURE_COMPARE_MODE: PictureCompareMode = "models";
export const FLOW_PICTURE_MODELS: PictureModels = DEFAULT_PICTURE_MODELS;

export type FlowStepInput = {
  image: string;
  theme: string;
  picturePrompts: readonly string[];
  backgroundMotionPrompt: string;
  dressPrompt: string;
  dressReferenceImage: string;
  cardId: string;
  cardLabel: string;
  modelId: string;
  resolution: string;
  enhanceDressPrompt: boolean;
  tracker: string;
  writeWebm: boolean;
  compressPreset: string;
  meshTune: MeshTuneSettings;
  faceImage: string;
  bikiniImage: string;
  /** The outfit step names the approved picture @image3, the same way Run does. */
  picturePicked?: boolean;
  provider: string;
  imageModel: string;
  backgroundVideoModel: string;
  dressVideoModel: string;
};

/** The job body for picture, moving clip, and outfit. Run and Lite both use this. */
export function flowStepBody(input: FlowStepInput) {
  const tokens = pictureImageTokens(input.image, input.bikiniImage);
  const picturePrompts = input.picturePrompts.map((text) => ensureImageTokens(text, tokens));
  const dressTokens = [...tokens];
  if (input.picturePicked) dressTokens.push("@image3");
  if (input.dressReferenceImage.trim()) dressTokens.push("@image4");
  return {
    image: input.image,
    theme: input.theme,
    picture_prompts: picturePrompts,
    picture_variation_count: FLOW_PICTURE_VARIATION_COUNT,
    picture_compare_mode: FLOW_PICTURE_COMPARE_MODE,
    picture_models: [...FLOW_PICTURE_MODELS],
    background_motion_prompt: input.backgroundMotionPrompt,
    foreground_motion_prompt: input.backgroundMotionPrompt,
    dress_prompt: ensureImageTokens(input.dressPrompt, dressTokens),
    dress_reference_image: input.dressReferenceImage,
    card_id: input.cardId,
    card_label: input.cardLabel,
    model_id: input.modelId,
    resolution: input.resolution,
    enhance_dress_prompt: input.enhanceDressPrompt,
    tracker: input.tracker,
    write_webm: input.writeWebm,
    compress_preset: input.compressPreset,
    mesh_tune: meshTuneToApi(input.meshTune),
    source_mode: "upload" as const,
    face_image: input.faceImage,
    bikini_image: input.bikiniImage,
    provider: input.provider,
    image_model: input.imageModel,
    background_video_model: input.backgroundVideoModel,
    dress_video_model: input.dressVideoModel,
    picture_prompt: picturePrompts[0] ?? "",
  };
}
