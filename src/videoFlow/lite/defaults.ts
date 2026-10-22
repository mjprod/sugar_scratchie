import { DEFAULT_MESH_TUNE } from "../meshTune";
import {
  backgroundMotionPromptForTheme,
  defaultPicturePrompts,
  dressPromptForThemeWithReference,
} from "../schema";
import { flowStepBody } from "../stepRequest";

export const LITE_TRACKER = "blend";
export const LITE_RESOLUTION = "720p";
export const LITE_COMPRESS_PRESET = "mobile";

export type LiteImageModel = "grok-imagine" | "seedream-v5-lite";

export function liteImageModel(hasXai: boolean, hasWavespeed: boolean): LiteImageModel {
  if (hasXai || !hasWavespeed) return "grok-imagine";
  return "seedream-v5-lite";
}

export type LiteDraftInput = {
  cardId: string;
  cardLabel: string;
  modelId: string;
  image: string;
  bikini: string;
  face: string;
  theme: string;
  costume: string;
  hasXai: boolean;
  hasWavespeed: boolean;
};

/** Fixed settings for the lite canvas. Prompts are filled from the theme and never shown. */
export function liteRequestBody(input: LiteDraftInput) {
  const imageModel = liteImageModel(input.hasXai, input.hasWavespeed);
  return flowStepBody({
    image: input.image,
    theme: input.theme,
    picturePrompts: defaultPicturePrompts(input.theme),
    backgroundMotionPrompt: backgroundMotionPromptForTheme(input.theme),
    dressPrompt: dressPromptForThemeWithReference(input.theme),
    dressReferenceImage: input.costume,
    cardId: input.cardId,
    cardLabel: input.cardLabel.trim() || input.cardId,
    modelId: input.modelId,
    resolution: LITE_RESOLUTION,
    enhanceDressPrompt: true,
    tracker: LITE_TRACKER,
    writeWebm: false,
    compressPreset: LITE_COMPRESS_PRESET,
    meshTune: DEFAULT_MESH_TUNE,
    faceImage: input.face,
    bikiniImage: input.bikini.trim(),
    picturePicked: true,
    provider: imageModel === "seedream-v5-lite" ? "wavespeed" : "xai",
    imageModel,
    backgroundVideoModel: "grok-imagine",
    dressVideoModel: "grok-imagine",
  });
}
