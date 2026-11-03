/** Video generation backend. */
export type GenProvider =
  | 'grok'
  | 'higgsfield'
  | 'seedance'
  | 'seedance-2'
  | 'sora-2'
  | 'sora-2-pro'
  | 'veo-3.1'
  | 'kling-3'
  | 'wan-2.7'
  | 'oa-seedance-2'
  | 'oa-seedance-2.5'
  | 'minimax'

/** Image generation backend. Klein is the default. Flux 18+ is the local uncensored encoder. */
export type ImageProvider = 'flux-3-klein' | 'flux-18'

export const GEN_PROVIDERS: { value: GenProvider; label: string }[] = [
  { value: 'grok', label: 'Grok' },
  { value: 'higgsfield', label: 'Higgsfield' },
  { value: 'seedance', label: 'Seedance 2.5 (Ark)' },
  { value: 'seedance-2', label: 'Seedance 2.0 (Ark)' },
  { value: 'minimax', label: 'MiniMax-H3' },
  { value: 'oa-seedance-2.5', label: 'Seedance 2.5' },
  { value: 'oa-seedance-2', label: 'Seedance 2.0' },
  { value: 'sora-2', label: 'Sora 2' },
  { value: 'sora-2-pro', label: 'Sora 2 Pro' },
  { value: 'veo-3.1', label: 'Veo 3.1' },
  { value: 'kling-3', label: 'Kling 3.0 4K' },
  { value: 'wan-2.7', label: 'Wan 2.7' },
]

/** OpenAI-compatible relay video providers (OPENAI_API_KEY + OPENAI_BASE_URL). */
export const OPENAI_VIDEO_PROVIDERS: GenProvider[] = [
  'sora-2',
  'sora-2-pro',
  'veo-3.1',
  'kling-3',
  'wan-2.7',
  'oa-seedance-2',
  'oa-seedance-2.5',
]

export function isOpenAIVideoProvider(provider: GenProvider): boolean {
  return (OPENAI_VIDEO_PROVIDERS as string[]).includes(provider)
}

export const IMAGE_PROVIDERS: {
  value: ImageProvider
  label: string
  note: string
}[] = [
  { value: 'flux-3-klein', label: 'FLUX 3 Klein', note: 'Local' },
  { value: 'flux-18', label: 'Flux 18+', note: 'Local' },
]

/** Soften live/真人 prompts so relays with person policies don't refuse. */
export const FICTIONAL_PERSON_GUARD =
  'Fictional stylized characters only for a commercial storyboard — not real celebrities, not photoreal identifiable real people.'

/** Appended to every storyboard→video prompt: voice + SFX ok, no BGM. */
export const VIDEO_AUDIO_DEFAULT =
  '可以有環境音效與角色說話聲（口型對齊台詞）。不要背景音樂、配樂、歌曲或哼唱旋律。' +
  ` ${FICTIONAL_PERSON_GUARD}`

/** The only captions are burned after the clip exists. Models that also draw type stack on top. */
export const NO_ONSCREEN_TEXT =
  '畫面裡不要出現任何字幕、標題、貼紙字、歌詞或文案。台詞只用聲音說，不要把字畫在畫面上。'

export const CAPTION_STYLES: {
  value: CaptionStyle
  label: string
}[] = [
  { value: 'none', label: 'No captions' },
  { value: 'clean', label: 'Clean white' },
  { value: 'bold', label: 'Bold yellow' },
  { value: 'outline', label: 'Outlined' },
]

export type CaptionStyle = 'none' | 'clean' | 'bold' | 'outline'

export function parseCaptionStyle(v: unknown): CaptionStyle {
  if (v === 'clean' || v === 'bold' || v === 'outline' || v === 'none') return v
  return 'clean'
}
const STORAGE_KEY = 'sugar-dress-gen-provider'
const IMAGE_STORAGE_KEY = 'sugar-dress-image-provider'

const OPENAI_VIDEO_SET = new Set<string>(OPENAI_VIDEO_PROVIDERS)

export function parseGenProvider(v: unknown): GenProvider {
  // Alias: old localStorage used `doubao` → Seedance 2.5 (Ark)
  if (v === 'seedance' || v === 'doubao') return 'seedance'
  // Accept dotted form if someone typed it by hand
  if (v === 'seedance-2' || v === 'seedance-2.0') return 'seedance-2'
  if (v === 'higgsfield' || v === 'grok' || v === 'minimax') return v
  if (typeof v === 'string' && OPENAI_VIDEO_SET.has(v)) return v as GenProvider
  return 'grok'
}

export function parseImageProvider(v: unknown): ImageProvider {
  if (v === 'flux-18') return 'flux-18'
  return 'flux-3-klein'
}

export function loadGenProvider(): GenProvider {
  try {
    return parseGenProvider(localStorage.getItem(STORAGE_KEY))
  } catch {
    return 'grok'
  }
}

export function saveGenProvider(provider: GenProvider) {
  try {
    localStorage.setItem(STORAGE_KEY, provider)
  } catch {
    /* ignore quota / private mode */
  }
}

export function loadImageProvider(): ImageProvider {
  try {
    return parseImageProvider(localStorage.getItem(IMAGE_STORAGE_KEY))
  } catch {
    return 'flux-3-klein'
  }
}

export function saveImageProvider(provider: ImageProvider) {
  try {
    localStorage.setItem(IMAGE_STORAGE_KEY, provider)
  } catch {
    /* ignore quota / private mode */
  }
}

export function providerLabel(provider: GenProvider): string {
  return GEN_PROVIDERS.find((p) => p.value === provider)?.label ?? provider
}

export function imageProviderLabel(provider: ImageProvider): string {
  return IMAGE_PROVIDERS.find((p) => p.value === provider)?.label ?? provider
}
