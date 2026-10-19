export type FlowNodeId =
  | "source"
  | "picture"
  | "background"
  | "trim"
  | "dress"
  | "boomerang"
  | "compress"
  | "card"
  | "mesh"
  | "symbols"
  | "output";

export type FlowNodeKind = "input" | "grok" | "process" | "output";

export type VideoFlowStepKey =
  | "picture"
  | "background"
  | "trim"
  | "dress"
  | "boomerang"
  | "compress"
  | "card"
  | "mesh"
  | "symbols";

export type FlowNodeDef = {
  id: FlowNodeId;
  kind: FlowNodeKind;
  title: string;
  subtitle: string;
  description: string;
  x: number;
  y: number;
  inputs: { id: string; label: string }[];
  outputs: { id: string; label: string }[];
  step?: VideoFlowStepKey | null;
};

export type FlowWireDef = {
  from: FlowNodeId;
  to: FlowNodeId;
  dashed?: boolean;
};

export type VideoFlowJson = {
  id: string;
  label: string;
  description: string;
  version: number;
  pipeline: VideoFlowStepKey[];
  reviewSteps: VideoFlowStepKey[];
  canvas: { width: number; height: number };
  nodes: FlowNodeDef[];
  wires: FlowWireDef[];
  defaults: {
    background_motion_prompt: string;
    dress_prompt: string;
    dress_reference_image: string;
    resolution: string;
    tracker: "bootstapir" | "cotracker" | "blend" | "all";
    write_webm: boolean;
    compress_preset: "mobile" | "hd" | "master";
    enhance_dress_prompt: boolean;
  };
};

export const FLOW_NODE_WIDTH = 176;
export const FLOW_NODE_HEIGHT = 88;

export const DEFAULT_THEME = "warm beach";

/** Locked card framing. Keep identical to backend/services/grok.py INFLUENCER_POSITION. */
export const INFLUENCER_POSITION =
  "INFLUENCER POSITION — required framing for this card. " +
  "Vertical 9:16. She stands centered and square to the camera, facing forward. " +
  "Arms stay relaxed at her sides, slightly away from her torso, unless the pose only moves her arms. " +
  "Leave a clear empty band across the top, about 8% of the frame: the top of her head sits " +
  "just under that band and must never enter it or be cropped. " +
  "Crop her around mid-thigh so about the bottom 20% of the frame shows only her upper legs. " +
  "Do not show her feet, do not pull back to a distant full-body shot, and do not zoom into " +
  "a face or chest close-up. " +
  "She fills the center, with a gap between her hands and both side edges. " +
  "Do not shift her left or right, closer or farther, and do not change camera height. " +
  "A different pose may move her arms only. Her head height, crop, and scale stay identical.";

export function normalizeTheme(theme: string | undefined | null): string {
  const stripped = (theme ?? "").trim();
  return stripped || DEFAULT_THEME;
}

/** Even light on her body. Scene light stays in the background so the still stays easy to use. */
export const PICTURE_BODY_LIGHT =
  "BODY LIGHT — simple, even, soft light on her body. Her skin, bikini, and hair stay brightly and evenly lit from the front. No hard shadows, no dark side of her body, no dramatic side light, and no rim light on her. Do not relight her body to match the background.";

/** Stock Create-picture prompt. Matches backend scenery_edit_prompt without the per-take lighting line. */
export function picturePromptForTheme(theme: string): string {
  const scenery = normalizeTheme(theme);
  return `Replace the entire background behind the person with a vividly recognizable ${scenery} environment — a clear ${scenery} location/scene, not a vague hint. Completely remove the original backdrop (city skyline, balcony, street, outdoors, studio, plain wall, or any other scene). Keep the same woman, face, identity, hair, skin tone, body, pose, bikini/outfit, hands, and subject scale. ${PICTURE_BODY_LIGHT} Do not crop, zoom, or reframe away from the influencer position. Only change the background scenery.\n\n${INFLUENCER_POSITION}`;
}

/** Previous stock prompt. "Matching lighting" and side light put shadows on her body. */
const LEGACY_SIDE_LIGHT_TAKES = [
  "bright open daylight and vivid colors",
  "golden-hour side light and warmer tones",
  "soft diffused light with richer background detail",
] as const;

function legacySideLightPicturePrompt(theme: string, take: PictureTake): string {
  const scenery = normalizeTheme(theme);
  return `Replace the entire background behind the person with a vividly recognizable ${scenery} environment and matching lighting — a clear ${scenery} location/scene, not a vague hint. Completely remove the original backdrop (city skyline, balcony, street, outdoors, studio, plain wall, or any other scene). Keep the same woman, face, identity, hair, skin tone, body, pose, bikini/outfit, hands, and subject scale. Do not crop, zoom, or reframe away from the influencer position. Only change the background scenery. Lighting for this take: ${LEGACY_SIDE_LIGHT_TAKES[take - 1]}.\n\n${INFLUENCER_POSITION}`;
}

function legacySideLightPicturePromptNoTake(theme: string): string {
  const scenery = normalizeTheme(theme);
  return `Replace the entire background behind the person with a vividly recognizable ${scenery} environment and matching lighting — a clear ${scenery} location/scene, not a vague hint. Completely remove the original backdrop (city skyline, balcony, street, outdoors, studio, plain wall, or any other scene). Keep the same woman, face, identity, hair, skin tone, body, pose, bikini/outfit, hands, and subject scale. Do not crop, zoom, or reframe away from the influencer position. Only change the background scenery.\n\n${INFLUENCER_POSITION}`;
}

/** Stock Create-picture prompt from before the influencer position lock. */
export function legacyPicturePromptForTheme(theme: string): string {
  const scenery = normalizeTheme(theme);
  return `Replace the entire background behind the person with a vividly recognizable ${scenery} environment and matching lighting — a clear ${scenery} location/scene, not a vague hint. Completely remove the original backdrop (city skyline, balcony, street, outdoors, studio, plain wall, or any other scene). Keep the same woman, face, identity, hair, skin tone, body, pose, bikini/outfit, hands, framing, and subject scale exactly. Do not crop, zoom, or reframe. Only change the background scenery.`;
}

export const PICTURE_TAKE_LIGHTING = [
  "bright daylight in the background only",
  "warm sunset color in the background only",
  "soft overcast light in the background only",
] as const;

export type PictureTake = 1 | 2 | 3;
export type PictureVariationCount = PictureTake;
/** Compare scenery prompts on one model, or one prompt across image models. */
export type PictureCompareMode = "prompts" | "models";
export type PictureModels = [string, string, string];

export const DEFAULT_PICTURE_MODELS: PictureModels = [
  "grok-imagine",
  "seedream-v5-lite",
  "grok-imagine",
];

export function pictureVariationCountOf(value: unknown): PictureVariationCount {
  const count = Number(value);
  if (count === 1 || count === 2 || count === 3) return count;
  return 3;
}

export function pictureCompareModeOf(value: unknown): PictureCompareMode {
  return value === "models" ? "models" : "prompts";
}

export function normalizePictureModels(value: unknown, fallbackModel = "grok-imagine"): PictureModels {
  const defaults = DEFAULT_PICTURE_MODELS;
  const raw = Array.isArray(value) ? value : [];
  return [0, 1, 2].map((index) => {
    const item = raw[index];
    if (typeof item === "string" && item.trim()) return item.trim();
    return defaults[index] || fallbackModel;
  }) as PictureModels;
}

export type PicturePrompts = [string, string, string];

export function picturePromptForTake(theme: string, take: PictureTake): string {
  const scenery = picturePromptForTheme(theme);
  const marker = `\n\n${INFLUENCER_POSITION}`;
  const lighting = ` Lighting for this take: ${PICTURE_TAKE_LIGHTING[take - 1]}.`;
  if (scenery.endsWith(marker)) {
    return `${scenery.slice(0, -marker.length)}${lighting}${marker}`;
  }
  return `${scenery}${lighting}`;
}

export function defaultPicturePrompts(theme: string): PicturePrompts {
  return [1, 2, 3].map((take) => picturePromptForTake(theme, take as PictureTake)) as PicturePrompts;
}

export function isStockPictureTakePrompt(prompt: string, theme: string, take: PictureTake): boolean {
  const stripped = prompt.trim();
  if (!stripped) return true;
  const scenery = normalizeTheme(theme);
  const legacyTake = `${legacyPicturePromptForTheme(scenery)} Lighting for this take: ${LEGACY_SIDE_LIGHT_TAKES[take - 1]}.`;
  const legacyDefaultTake = `${legacyPicturePromptForTheme(DEFAULT_THEME)} Lighting for this take: ${LEGACY_SIDE_LIGHT_TAKES[take - 1]}.`;
  const legacyNewTake = `${legacyPicturePromptForTheme(scenery)} Lighting for this take: ${PICTURE_TAKE_LIGHTING[take - 1]}.`;
  const legacyNewDefaultTake = `${legacyPicturePromptForTheme(DEFAULT_THEME)} Lighting for this take: ${PICTURE_TAKE_LIGHTING[take - 1]}.`;
  return (
    stripped === picturePromptForTake(scenery, take) ||
    stripped === picturePromptForTake(DEFAULT_THEME, take) ||
    stripped === picturePromptForTheme(scenery) ||
    stripped === picturePromptForTheme(DEFAULT_THEME) ||
    stripped === legacySideLightPicturePrompt(scenery, take) ||
    stripped === legacySideLightPicturePrompt(DEFAULT_THEME, take) ||
    stripped === legacySideLightPicturePromptNoTake(scenery) ||
    stripped === legacySideLightPicturePromptNoTake(DEFAULT_THEME) ||
    stripped === legacyTake ||
    stripped === legacyDefaultTake ||
    stripped === legacyNewTake ||
    stripped === legacyNewDefaultTake ||
    stripped === legacyPicturePromptForTheme(scenery) ||
    stripped === legacyPicturePromptForTheme(DEFAULT_THEME)
  );
}

export function isStockPicturePromptText(prompt: string, theme: string): boolean {
  const stripped = prompt.trim();
  if (!stripped) return true;
  return ([1, 2, 3] as const).some((take) => isStockPictureTakePrompt(stripped, theme, take));
}

/** Turn a saved list, or one older shared prompt, into the three take prompts. */
export function normalizePicturePrompts(
  prompts: readonly string[] | undefined,
  theme: string,
  shared?: string,
): PicturePrompts {
  const defaults = defaultPicturePrompts(theme);
  const incoming = (prompts ?? []).slice(0, 3).map((item) => (item ?? "").trim());
  const hasTake = incoming.some(Boolean);
  if (!hasTake && shared?.trim()) {
    const base = shared.trim();
    return [1, 2, 3].map((take) => {
      const index = take as PictureTake;
      if (isStockPictureTakePrompt(base, theme, index)) return defaults[take - 1];
      if (base.includes("Lighting for this take:")) return base;
      return `${base} Lighting for this take: ${PICTURE_TAKE_LIGHTING[take - 1]}.`;
    }) as PicturePrompts;
  }
  return [1, 2, 3].map((take) => {
    const text = incoming[take - 1] ?? "";
    return isStockPictureTakePrompt(text, theme, take as PictureTake) ? defaults[take - 1] : text;
  }) as PicturePrompts;
}

export function backgroundMotionPromptForTheme(theme: string): string {
  const scenery = normalizeTheme(theme);
  // Create picture already baked the themed still. I2V must only animate in place —
  // restaging / "walk into the scene" makes WAN spicy walk and cast scene lights on her.
  return (
    `Animate this approved ${scenery} portrait into a seamless looping boomerang video. ` +
    `The ${scenery} background is already correct in the input still — keep that exact backdrop. ` +
    `Do not replace the scenery or restage her. ` +
    `She wears a bikini. Tiny sway, breathing, and hair motion only — she must not walk at all. ` +
    `STATION LOCK — feet glued to the floor in their exact input positions. Zero steps. ` +
    `No walk cycle, no stride, no approach, no walking in place. Subject scale must not grow. ` +
    `Locked camera: no zoom, dolly, push-in, or pull-back. Framing matches the input image exactly. ` +
    `COLOR AND SKIN LOCK — her skin, hair color, bikini color, white balance, exposure, and saturation ` +
    `stay identical to the input still in every frame, including the loop back. ` +
    `Do not tan, pale, bronze, warm, cool, or relight her. Do not color-grade her body to match the scene. ` +
    `Background lights and glows stay in the scenery only and must not cast colored light onto her body. ` +
    `Perfect loop.`
  );
}

/** Pre-any-bg stock: only asked to replace blank/studio backdrops. */
export function legacyBlankWallBackgroundMotionPromptForTheme(theme: string): string {
  const scenery = normalizeTheme(theme);
  return `Animate this portrait into a seamless looping boomerang video. Place her in a clearly recognizable ${scenery} environment — replace any blank wall, plain studio, or empty backdrop with a vivid ${scenery} location/scene and matching lighting. She wears a bikini, gentle swaying body motion only. She stays on the same spot. Locked camera: no zoom in, no zoom out, no dolly, no push-in, no pull-back, no walking toward or away from camera. Keep subject scale and framing on her body consistent with the input image. Keep her face, identity, hair, and skin tone identical in every frame — same undertone, same lightness, no tan/pale flicker, no color grading shifts on skin. Perfect loop, ${scenery} scenery throughout.`;
}

/** Weaker themed motion prompt before explicit scenery replacement. */
export function legacySoftBackgroundMotionPromptForTheme(theme: string): string {
  const scenery = normalizeTheme(theme);
  return `Animate this portrait into a seamless looping boomerang video. She wears a bikini, gentle swaying body motion only. She stays on the same spot. Locked camera: no zoom in, no zoom out, no dolly, no push-in, no pull-back, no walking toward or away from camera. Keep the exact same framing and subject size as the input image in every frame. Keep her face, identity, hair, and skin tone identical in every frame — same undertone, same lightness, no tan/pale flicker, no color grading shifts on skin. Perfect loop, ${scenery} setting with matching lighting.`;
}

export function dressPromptForTheme(theme: string): string {
  const scenery = normalizeTheme(theme);
  return `Same woman, clothes only — she must stay the exact same person as the input video in every frame. Do not recast, beautify, or replace her. FACE LOCK: same eyes, nose, lips, jaw, makeup, and expression. HAIR LOCK: same hair color, length, style, and parting, fully visible — do not darken, lighten, or recolor her hair, and do not add a wig, hood, headdress, veil, nemes, crown, or any head covering that hides or replaces her hair. SKIN LOCK: same undertone and lightness in every frame — no tan, no pale, no flicker. BODY LOCK: same pose, hands, arms, and motion. Replace her entire bikini with a sexy glamorous ${scenery} costume worn on this same woman (complete opaque top and bottom — unmistakably ${scenery}; if this is a role or profession, use that uniform as clothing only, not a new character). Do not leave any bikini. Do not use a generic emerald evening gown or unrelated fashion dress. Jewelry and trim may sit on the body, but nothing may cover her face or replace her hair. Keep the exact same ${scenery} background, scenery, lighting, camera, framing, subject scale, and motion frame-for-frame. No zoom or camera move.`;
}

/** Prefer this when a dress reference image is attached. */
export function dressPromptForThemeWithReference(theme: string): string {
  const scenery = normalizeTheme(theme);
  return `Same woman, clothes only — she must stay the exact same person as the input video in every frame. Do not recast, beautify, or replace her. FACE LOCK: same eyes, nose, lips, jaw, makeup, and expression. HAIR LOCK: same hair color, length, style, and parting, fully visible — do not darken, lighten, or recolor her hair, and do not add a wig, hood, headdress, veil, nemes, crown, or any head covering that hides or replaces her hair. SKIN LOCK: same undertone and lightness in every frame — no tan, no pale, no flicker. BODY LOCK: same pose, hands, arms, and motion. Match the dress reference image outfit exactly (colors, cut, accessories, materials, glow) and wear it on this same woman. Replace her entire bikini with that full costume (complete opaque top and bottom). Copy the clothes only — do not copy the reference person's face, hair, or body. Keep the exact same ${scenery} background, scenery, lighting, camera, framing, subject scale, and motion frame-for-frame. No zoom or camera move.`;
}

/** Earlier stock dress prompt: emerald satin + theme only in the scenery clause. */
export function legacyEmeraldDressPromptForTheme(theme: string): string {
  const scenery = normalizeTheme(theme);
  return `Replace her entire bikini with a fitted emerald satin dress (top and bottom). Keep the exact same ${scenery} background, scenery, lighting, camera, framing, subject scale, and motion frame-for-frame — only change the outfit. Keep her face, identity, hair, and skin tone identical in every frame (same undertone and lightness — no tan/pale flicker). No zoom or camera move.`;
}

/** Softer themed prompt before costume/role wording was added. */
export function legacySoftThemeDressPromptForTheme(theme: string): string {
  const scenery = normalizeTheme(theme);
  return `Replace her entire bikini with a full dress-up outfit that matches the ${scenery} theme (complete top and bottom — glamorous, cohesive with the setting, not a bikini). Keep the exact same ${scenery} background, scenery, lighting, camera, framing, subject scale, and motion frame-for-frame — only change the outfit. Keep her face, identity, hair, and skin tone identical in every frame (same undertone and lightness — no tan/pale flicker). No zoom or camera move.`;
}

/** Pre-theme stock dress prompt that referenced "beach background". */
export const LEGACY_DEFAULT_DRESS_PROMPT =
  "Replace her entire bikini with a fitted emerald satin dress (top and bottom). Keep the exact same beach background, scenery, lighting, camera, framing, subject scale, and motion frame-for-frame — only change the outfit. Keep her face, identity, hair, and skin tone identical in every frame (same undertone and lightness — no tan/pale flicker). No zoom or camera move.";

export const LEGACY_BACKGROUND_MOTION_PROMPT =
  "Animate this portrait into a seamless looping boomerang video. She wears a bikini, gentle swaying body motion, steady camera, perfect loop, warm beach lighting.";

export const LEGACY_LOCKED_CAMERA_MOTION_PROMPT =
  "Animate this portrait into a seamless looping boomerang video. She wears a bikini, gentle swaying body motion only. She stays on the same spot. Locked camera: no zoom in, no zoom out, no dolly, no push-in, no pull-back, no walking toward or away from camera. Keep the exact same framing and subject size as the input image in every frame. Perfect loop, warm beach lighting.";

/** Pre-theme stock default that ended with fixed "warm beach lighting." */
export const LEGACY_DEFAULT_BACKGROUND_MOTION_PROMPT =
  "Animate this portrait into a seamless looping boomerang video. She wears a bikini, gentle swaying body motion only. She stays on the same spot. Locked camera: no zoom in, no zoom out, no dolly, no push-in, no pull-back, no walking toward or away from camera. Keep the exact same framing and subject size as the input image in every frame. Keep her face, identity, hair, and skin tone identical in every frame — same undertone, same lightness, no tan/pale flicker, no color grading shifts on skin. Perfect loop, warm beach lighting.";

export function isStockBackgroundMotionPromptText(prompt: string, theme: string): boolean {
  const stripped = prompt.trim();
  const scenery = normalizeTheme(theme);
  if (!stripped) return true;
  if (stripped.startsWith("COLOR AND SKIN LOCK")) return true;
  // Current stock: animate the Create-picture still in place (no restage / walk-in).
  if (
    stripped.includes("Animate this approved ") &&
    stripped.includes("background is already correct")
  ) {
    return true;
  }
  if (stripped.endsWith("setting with matching lighting.")) return true;
  // Previous stock: themed scenery plus "matching lighting", which recolored her skin.
  if (
    stripped.includes("Place her in a clearly recognizable ") &&
    stripped.includes("completely replace ANY existing background")
  ) {
    return true;
  }
  // Older hand-edits that only swapped "blank wall" → "background" are still stock themed templates.
  if (
    stripped.includes("Place her in a clearly recognizable ") &&
    stripped.includes(" environment — replace any background, plain studio, or empty backdrop with a vivid ")
  ) {
    return true;
  }
  return (
    stripped === LEGACY_BACKGROUND_MOTION_PROMPT ||
    stripped === LEGACY_LOCKED_CAMERA_MOTION_PROMPT ||
    stripped === LEGACY_DEFAULT_BACKGROUND_MOTION_PROMPT ||
    stripped === legacySoftBackgroundMotionPromptForTheme(scenery) ||
    stripped === legacySoftBackgroundMotionPromptForTheme(DEFAULT_THEME) ||
    stripped === legacyBlankWallBackgroundMotionPromptForTheme(scenery) ||
    stripped === legacyBlankWallBackgroundMotionPromptForTheme(DEFAULT_THEME) ||
    stripped === backgroundMotionPromptForTheme(scenery) ||
    stripped === backgroundMotionPromptForTheme(DEFAULT_THEME)
  );
}

/** True when the dress prompt is still a stock/legacy template (safe to overwrite from theme). */
export function isStockDressPromptText(prompt: string, theme: string): boolean {
  const stripped = prompt.trim();
  const scenery = normalizeTheme(theme);
  const legacyDressNoSkin =
    "Replace her entire bikini with a fitted emerald satin dress (top and bottom). Keep the exact same beach background, scenery, lighting, camera, framing, subject scale, and motion frame-for-frame — only change the outfit. No zoom or camera move.";
  if (!stripped) return true;
  if (stripped.startsWith("Replace her entire bikini with a fitted emerald satin dress")) return true;
  if (stripped.startsWith("Replace her entire bikini with a full dress-up outfit that matches the ")) {
    return true;
  }
  if (stripped.startsWith("Replace her entire bikini with a glamorous ")) return true;
  if (stripped.startsWith("Replace her entire bikini with a sexy glamorous ")) return true;
  if (stripped.startsWith("Same woman, clothes only")) return true;
  if (stripped.startsWith("Match the dress reference image outfit exactly")) return true;
  return (
    stripped === legacyDressNoSkin ||
    stripped === LEGACY_DEFAULT_DRESS_PROMPT ||
    stripped === legacyEmeraldDressPromptForTheme(scenery) ||
    stripped === legacyEmeraldDressPromptForTheme(DEFAULT_THEME) ||
    stripped === legacySoftThemeDressPromptForTheme(scenery) ||
    stripped === legacySoftThemeDressPromptForTheme(DEFAULT_THEME) ||
    stripped === dressPromptForTheme(scenery) ||
    stripped === dressPromptForTheme(DEFAULT_THEME) ||
    stripped === dressPromptForThemeWithReference(scenery) ||
    stripped === dressPromptForThemeWithReference(DEFAULT_THEME)
  );
}

export const DEFAULT_BACKGROUND_MOTION_PROMPT = backgroundMotionPromptForTheme(DEFAULT_THEME);

export const DEFAULT_DRESS_PROMPT = dressPromptForTheme(DEFAULT_THEME);
export type CompressPreset = "mobile" | "hd" | "master";

export const COMPRESS_PRESETS: {
  id: CompressPreset;
  label: string;
  detail: string;
}[] = [
  {
    id: "mobile",
    label: "Mobile delivery",
    detail: "390×672 cover-crop · CRF 23 — exact prototype canvas",
  },
  {
    id: "hd",
    label: "HD delivery",
    detail: "540×930 cover-crop · CRF 20 — same 390∶672 frame, sharper",
  },
  {
    id: "master",
    label: "Master archive",
    detail: "720×1240 cover-crop · CRF 18 — same frame, keep quality",
  },
];

export function parseCompressPreset(value: unknown): CompressPreset {
  return value === "hd" || value === "master" ? value : "mobile";
}

export const DEFAULT_VIDEO_FLOW_JSON: VideoFlowJson = {
  id: "image-to-card",
  label: "Image To Card",
  description:
    "Create a themed still from the source image and approve it, then animate that picture. Fix white edge frames, then a dress edit on the same frames. Boomerang (or keep as-is) comes next, then the card and mesh; place symbol points, then compress.",
  version: 1,
  pipeline: [
    "picture",
    "background",
    "trim",
    "dress",
    "boomerang",
    "card",
    "mesh",
    "symbols",
    "compress",
  ],
  reviewSteps: ["picture", "background", "trim", "dress", "boomerang"],
  canvas: { width: 2020, height: 200 },
  nodes: [
    {
      id: "source",
      kind: "input",
      title: "Flow input",
      subtitle: "Source image",
      description:
        "Upload a source still, optional bikini model, and optional face reference (face-swapped onto every AI generation)",
      x: 20,
      y: 56,
      step: null,
      inputs: [],
      outputs: [{ id: "image", label: "image" }],
    },
    {
      id: "picture",
      kind: "grok",
      title: "Create picture",
      subtitle: "Pick one",
      description:
        "Choose 1, 2, or 3. Each picture has its own prompt. Pick one before image-to-video.",
      x: 220,
      y: 56,
      step: "picture",
      inputs: [{ id: "image", label: "image" }],
      outputs: [{ id: "image", label: "picture" }],
    },
    {
      id: "background",
      kind: "grok",
      title: "Image to video",
      subtitle: "Bikini background",
      description: "Animate the approved picture — beach / bikini reveal",
      x: 420,
      y: 56,
      step: "background",
      inputs: [{ id: "image", label: "image" }],
      outputs: [{ id: "video", label: "video" }],
    },
    {
      id: "trim",
      kind: "process",
      title: "Fix frames",
      subtitle: "Delete white frames",
      description: "Drop near-white flash frames from the start/end of the bikini clip before dress-up",
      x: 560,
      y: 56,
      step: "trim",
      inputs: [{ id: "video", label: "background" }],
      outputs: [{ id: "video", label: "video" }],
    },
    {
      id: "dress",
      kind: "grok",
      title: "Video edit",
      subtitle: "Foreground dress",
      description: "Dress edit on the approved background clip — same scenery, same frames",
      x: 720,
      y: 56,
      step: "dress",
      inputs: [{ id: "video", label: "trimmed" }],
      outputs: [{ id: "video", label: "video" }],
    },
    {
      id: "boomerang",
      kind: "process",
      title: "Boomerang",
      subtitle: "Forward + reverse",
      description:
        "Play the first N seconds of both clips forward, then the same frames backwards — or keep them as-is",
      x: 900,
      y: 56,
      step: "boomerang",
      inputs: [
        { id: "background", label: "background" },
        { id: "foreground", label: "foreground" },
      ],
      outputs: [{ id: "clips", label: "clips" }],
    },
    {
      id: "card",
      kind: "process",
      title: "Create card",
      subtitle: "public/cards/",
      description: "Publish the boomerang (or original) clips under public/cards/<id>/, or import both videos by hand",
      x: 1080,
      y: 56,
      step: "card",
      inputs: [
        { id: "background", label: "background" },
        { id: "foreground", label: "foreground" },
      ],
      outputs: [{ id: "card", label: "card" }],
    },
    {
      id: "mesh",
      kind: "process",
      title: "Generate mesh",
      subtitle: "Garment tracking",
      description: "Track the foreground for garment-local scratching",
      x: 1260,
      y: 56,
      step: "mesh",
      inputs: [{ id: "card", label: "card" }],
      outputs: [{ id: "mesh", label: "mesh" }],
    },
    {
      id: "symbols",
      kind: "process",
      title: "Place symbols",
      subtitle: "12 mesh points",
      description: "Place 12 symbol points randomly (or by click) on the garment mesh",
      x: 1440,
      y: 56,
      step: "symbols",
      inputs: [{ id: "mesh", label: "mesh" }],
      outputs: [{ id: "points", label: "points" }],
    },
    {
      id: "compress",
      kind: "process",
      title: "Finalize",
      subtitle: "390∶672 delivery",
      description: "Cover-crop both clips to the prototype canvas, encode delivery MP4s, optional WebM",
      x: 1620,
      y: 56,
      step: "compress",
      inputs: [
        { id: "background", label: "background" },
        { id: "foreground", label: "foreground" },
      ],
      outputs: [{ id: "clips", label: "clips" }],
    },
    {
      id: "output",
      kind: "output",
      title: "Flow output",
      subtitle: "Scratch card",
      description: "Playable card in the scratch prototype",
      x: 1800,
      y: 56,
      step: null,
      inputs: [{ id: "mesh", label: "mesh" }],
      outputs: [],
    },
  ],
  wires: [
    { from: "source", to: "picture" },
    { from: "picture", to: "background" },
    { from: "background", to: "trim" },
    { from: "trim", to: "dress" },
    { from: "trim", to: "boomerang" },
    { from: "dress", to: "boomerang" },
    { from: "boomerang", to: "card" },
    { from: "card", to: "mesh" },
    { from: "mesh", to: "symbols" },
    { from: "symbols", to: "compress" },
    { from: "card", to: "compress" },
    { from: "boomerang", to: "compress" },
    { from: "mesh", to: "output" },
  ],
  defaults: {
    background_motion_prompt: DEFAULT_BACKGROUND_MOTION_PROMPT,
    dress_prompt: DEFAULT_DRESS_PROMPT,
    dress_reference_image: "",
    resolution: "720p",
    tracker: "blend",
    write_webm: false,
    compress_preset: "mobile",
    enhance_dress_prompt: true,
  },
};

const STEP_IDS = new Set<VideoFlowStepKey>([
  "picture",
  "background",
  "trim",
  "dress",
  "boomerang",
  "card",
  "mesh",
  "symbols",
  "compress",
]);
const NODE_IDS = new Set<FlowNodeId>([
  "source",
  "picture",
  "background",
  "trim",
  "dress",
  "boomerang",
  "compress",
  "card",
  "mesh",
  "symbols",
  "output",
]);

export function stringifyVideoFlowJson(flow: VideoFlowJson): string {
  return `${JSON.stringify(flow, null, 2)}\n`;
}

/** Upgrade flows saved before symbols / trim steps existed. */
function migrateVideoFlow(flow: Partial<VideoFlowJson>): Partial<VideoFlowJson> {
  let pipeline = Array.isArray(flow.pipeline) ? [...flow.pipeline] : [];
  let nodes = Array.isArray(flow.nodes) ? [...flow.nodes] : [];
  let reviewSteps = Array.isArray(flow.reviewSteps) ? [...flow.reviewSteps] : [];
  let changed = false;

  if (!pipeline.includes("symbols") && pipeline.includes("mesh")) {
    const meshIndex = pipeline.indexOf("mesh");
    pipeline.splice(meshIndex + 1, 0, "symbols");
    if (!nodes.some((node) => node?.id === "symbols")) {
      const symbolsNode = DEFAULT_VIDEO_FLOW_JSON.nodes.find((node) => node.id === "symbols");
      if (symbolsNode) nodes.push(symbolsNode);
    }
    changed = true;
  }

  if (!pipeline.includes("picture")) {
    const backgroundIndex = pipeline.indexOf("background");
    pipeline.splice(backgroundIndex >= 0 ? backgroundIndex : 0, 0, "picture");
    if (!nodes.some((node) => node?.id === "picture")) {
      const template = DEFAULT_VIDEO_FLOW_JSON.nodes.find((node) => node.id === "picture");
      const sourceNode = nodes.find((node) => node?.id === "source");
      const insertX = sourceNode ? sourceNode.x + 200 : (template?.x ?? 220);
      nodes = nodes.map((node) =>
        node && typeof node.x === "number" && node.x >= insertX ? { ...node, x: node.x + 200 } : node,
      );
      if (template) {
        nodes.push({ ...template, x: insertX, y: sourceNode?.y ?? template.y });
      }
    }
    if (!reviewSteps.includes("picture")) {
      reviewSteps = ["picture", ...reviewSteps];
    }
    changed = true;
  }

  if (!pipeline.includes("trim") && pipeline.includes("background")) {
    const backgroundIndex = pipeline.indexOf("background");
    pipeline.splice(backgroundIndex + 1, 0, "trim");
    if (!nodes.some((node) => node?.id === "trim")) {
      const trimNode = DEFAULT_VIDEO_FLOW_JSON.nodes.find((node) => node.id === "trim");
      if (trimNode) nodes.push(trimNode);
    }
    if (!reviewSteps.includes("trim")) {
      reviewSteps = [...reviewSteps, "trim"];
    }
    changed = true;
  }

  if (!pipeline.includes("boomerang") && pipeline.includes("dress")) {
    const dressIndex = pipeline.indexOf("dress");
    pipeline.splice(dressIndex + 1, 0, "boomerang");
    if (!nodes.some((node) => node?.id === "boomerang")) {
      const template = DEFAULT_VIDEO_FLOW_JSON.nodes.find((node) => node.id === "boomerang");
      if (template) {
        const dressNode = nodes.find((node) => node?.id === "dress");
        const cardNode = nodes.find((node) => node?.id === "card");
        const x =
          dressNode && cardNode ? Math.round((dressNode.x + cardNode.x) / 2) : template.x;
        const y = dressNode ? dressNode.y : template.y;
        nodes.push({ ...template, x, y });
      }
    }
    if (!reviewSteps.includes("boomerang")) {
      reviewSteps = [...reviewSteps, "boomerang"];
    }
    changed = true;
  }

  if (!changed) {
    return migrateLockedCameraDefaults(flow);
  }
  return migrateLockedCameraDefaults({
    ...flow,
    pipeline,
    nodes,
    reviewSteps,
    wires: DEFAULT_VIDEO_FLOW_JSON.wires,
    description: DEFAULT_VIDEO_FLOW_JSON.description,
    canvas: {
      width: Math.max(
        typeof flow.canvas?.width === "number" ? flow.canvas.width : 0,
        DEFAULT_VIDEO_FLOW_JSON.canvas.width,
      ),
      height:
        typeof flow.canvas?.height === "number"
          ? flow.canvas.height
          : DEFAULT_VIDEO_FLOW_JSON.canvas.height,
    },
  });
}

/** Upgrade empty/legacy motion prompts to the locked-camera + skin-stable default. */
function migrateLockedCameraDefaults(flow: Partial<VideoFlowJson>): Partial<VideoFlowJson> {
  const defaults = flow.defaults;
  if (!defaults || typeof defaults !== "object") return flow;
  const motion = defaults.background_motion_prompt?.trim() ?? "";
  const dress = defaults.dress_prompt?.trim() ?? "";
  const nextDefaults = { ...defaults };
  let changed = false;
  if (
    !motion ||
    motion === LEGACY_BACKGROUND_MOTION_PROMPT ||
    motion === LEGACY_LOCKED_CAMERA_MOTION_PROMPT ||
    motion === LEGACY_DEFAULT_BACKGROUND_MOTION_PROMPT ||
    motion === DEFAULT_BACKGROUND_MOTION_PROMPT
  ) {
    nextDefaults.background_motion_prompt = DEFAULT_BACKGROUND_MOTION_PROMPT;
    changed = true;
  }
  if (isStockDressPromptText(dress, DEFAULT_THEME)) {
    nextDefaults.dress_prompt = DEFAULT_DRESS_PROMPT;
    changed = true;
  }
  if (!changed) return flow;
  return {
    ...flow,
    defaults: nextDefaults,
  };
}

export function parseVideoFlowJson(raw: string): VideoFlowJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (caught) {
    throw new Error(`Invalid JSON: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Flow JSON must be an object.");
  }
  const flow = migrateVideoFlow(parsed as Partial<VideoFlowJson>);
  if (!flow.id?.trim()) throw new Error("Flow JSON requires a non-empty id.");
  if (!flow.label?.trim()) throw new Error("Flow JSON requires a non-empty label.");
  if (!Array.isArray(flow.pipeline) || flow.pipeline.length === 0) {
    throw new Error("Flow JSON requires a non-empty pipeline array.");
  }
  for (const step of flow.pipeline) {
    if (!STEP_IDS.has(step as VideoFlowStepKey)) {
      throw new Error(`Unknown pipeline step: ${String(step)}`);
    }
  }
  if (!Array.isArray(flow.reviewSteps)) {
    throw new Error("Flow JSON requires reviewSteps array.");
  }
  for (const step of flow.reviewSteps) {
    if (!STEP_IDS.has(step as VideoFlowStepKey)) {
      throw new Error(`Unknown review step: ${String(step)}`);
    }
  }
  if (!Array.isArray(flow.nodes) || flow.nodes.length === 0) {
    throw new Error("Flow JSON requires at least one node.");
  }
  for (const node of flow.nodes) {
    if (!node?.id || !NODE_IDS.has(node.id)) {
      throw new Error(`Invalid node id: ${String(node?.id)}`);
    }
  }
  if (!Array.isArray(flow.wires)) {
    throw new Error("Flow JSON requires wires array.");
  }
  if (!flow.defaults || typeof flow.defaults !== "object") {
    throw new Error("Flow JSON requires defaults object.");
  }
  return {
    ...DEFAULT_VIDEO_FLOW_JSON,
    ...flow,
    id: flow.id.trim(),
    label: flow.label.trim(),
    description: flow.description?.trim() || DEFAULT_VIDEO_FLOW_JSON.description,
    version: typeof flow.version === "number" ? flow.version : 1,
    canvas: {
      width: flow.canvas?.width ?? DEFAULT_VIDEO_FLOW_JSON.canvas.width,
      height: flow.canvas?.height ?? DEFAULT_VIDEO_FLOW_JSON.canvas.height,
    },
    pipeline: flow.pipeline as VideoFlowStepKey[],
    reviewSteps: flow.reviewSteps as VideoFlowStepKey[],
    nodes: (flow.nodes as FlowNodeDef[]).map((node) => {
      const def = DEFAULT_VIDEO_FLOW_JSON.nodes.find((entry) => entry.id === node.id);
      if (!def) return node;
      return {
        ...node,
        description: def.description,
        ...(node.id === "picture" && node.subtitle === "Theme still"
          ? { subtitle: def.subtitle }
          : {}),
      };
    }),
    wires: flow.wires as FlowWireDef[],
    defaults: {
      ...DEFAULT_VIDEO_FLOW_JSON.defaults,
      ...flow.defaults,
      compress_preset: parseCompressPreset(
        (flow.defaults as VideoFlowJson["defaults"] | undefined)?.compress_preset,
      ),
    },
  };
}

export function stepToNode(flow: VideoFlowJson): Partial<Record<VideoFlowStepKey, FlowNodeId>> {
  const map: Partial<Record<VideoFlowStepKey, FlowNodeId>> = {};
  for (const node of flow.nodes) {
    if (node.step) map[node.step] = node.id;
  }
  return map;
}

export function nodeToStep(flow: VideoFlowJson): Partial<Record<FlowNodeId, VideoFlowStepKey>> {
  const map: Partial<Record<FlowNodeId, VideoFlowStepKey>> = {};
  for (const node of flow.nodes) {
    if (node.step) map[node.id] = node.step;
  }
  return map;
}
