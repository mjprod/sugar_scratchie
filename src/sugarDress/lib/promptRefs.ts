export type AspectRatio =
  | 'auto'
  | '1:1'
  | '16:9'
  | '9:16'
  | '4:3'
  | '3:4'
  | '3:2'
  | '2:3'

export type MediaKind = 'image' | 'video'

/** Klein image size. An original photo keeps its own frame. `720` is the no-photo default. */
export type ImageMode = 'speed' | '720'

export type VideoResolution = '480p' | '720p' | '1080p'
export type VideoDuration = 6 | 10 | 15

export const IMAGE_MODES: { value: ImageMode; label: string }[] = [
  { value: 'speed', label: 'Speed' },
  { value: '720', label: '720' },
]

export const ASPECT_RATIOS: { value: AspectRatio; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: '1:1', label: '1:1' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
  { value: '3:2', label: '3:2' },
  { value: '2:3', label: '2:3' },
]

export const VIDEO_RESOLUTIONS: VideoResolution[] = ['480p', '720p', '1080p']
export const VIDEO_DURATIONS: VideoDuration[] = [6, 10, 15]

/** How many refs can sit in the @ pool (canvas select / upload). */
export const MAX_REFS = 9
/** Grok Imagine edit API hard cap per request. */
export const MAX_API_REFS = 3

export type PromptSubmitPayload = {
  /** Prompt with @n rewritten to <IMAGE_i> for the API */
  prompt: string
  aspectRatio: AspectRatio
  /** Ordered reference data URIs / srcs matching <IMAGE_0>… */
  images: string[]
  /** True when using canvas selection or @ refs */
  isEdit: boolean
  mediaKind: MediaKind
  /** Image: Speed or 720. Header default is 720. */
  imageMode?: ImageMode
  duration?: VideoDuration
  resolution?: VideoResolution
  /** Video: first frame (image-to-video) */
  startFrame?: string | null
  /** Post-grade generated still to this colour-reference data URI */
  colorMatch?: string | null
  /** Unused by the clothing editor. Pose is sent as an image instead. */
  bodyMatch?: string | null
  /** Clothing photo inside `images`. The server strips that photo's body before generation. */
  clothingIndex?: number | null
  /** Pose photo inside `images`. The server turns it into a gray silhouette before generation. */
  poseIndex?: number | null
}

let primaryRefSrc: string | null = null

/** The prompt bar's @1. Matching colour reads this when grading a selected image. */
export function setPrimaryRef(src: string | null) {
  primaryRefSrc = src
}

export function getPrimaryRef() {
  return primaryRefSrc
}

export type SelectionRef = {
  id: string
  src: string
}

/** Unique 1-based @ indices mentioned in prompt, ascending. */
export function parseAtMentions(prompt: string): number[] {
  const found = new Set<number>()
  for (const match of prompt.matchAll(/@(\d+)\b/g)) {
    const n = Number(match[1])
    if (n >= 1) found.add(n)
  }
  return [...found].sort((a, b) => a - b)
}

/**
 * Build API prompt + image list from an ordered ref pool.
 * @1 maps to pool[0], @2 → pool[1], etc.
 */
export function resolveReferences(
  prompt: string,
  pool: string[],
  indexOffset = 0,
): { apiPrompt: string; images: string[]; missing: number[] } {
  const mentions = parseAtMentions(prompt)
  const missing = mentions.filter((n) => n < 1 || n > pool.length)
  const valid = mentions.filter((n) => n >= 1 && n <= pool.length)

  const images = valid.map((n) => pool[n - 1])
  let apiPrompt = prompt
  valid.forEach((n, i) => {
    apiPrompt = apiPrompt.replaceAll(
      new RegExp(`@${n}\\b`, 'g'),
      `<IMAGE_${indexOffset + i}>`,
    )
  })

  return { apiPrompt, images, missing }
}

/**
 * When multiple canvas images are selected and the prompt has no @ tags,
 * still attach all of them as references and annotate the prompt.
 */
export function attachAllSelectionRefs(
  prompt: string,
  pool: string[],
): { apiPrompt: string; images: string[] } {
  if (pool.length < 2) {
    return { apiPrompt: prompt, images: pool.length === 1 ? pool : [] }
  }
  const tags = pool.map((_, i) => `<IMAGE_${i}>`).join(', ')
  const apiPrompt = `${prompt.trim()}\n\nUse these reference images: ${tags}.`
  return { apiPrompt, images: pool }
}
