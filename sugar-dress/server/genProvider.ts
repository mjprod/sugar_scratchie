/** Env keys: XAI_API_KEY | ARK_API_KEY/DOUBAO_API_KEY | OPENAI_API_KEY | HIGGSFIELD_API_KEY (id:secret) or HIGGSFIELD_KEY_ID+HIGGSFIELD_KEY_SECRET */
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

/** Image providers — separate from video GenProvider. */
export type ImageProvider =
  | 'grok'
  | 'seedream-5-lite'
  | 'seedream-5-pro'
  | 'gpt-image-2.5'
  | 'gpt-image-2'
  | 'flux-3-klein'
  | 'flux-18'

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

export type ProviderKeys = {
  xai: string
  ark: string
  arkBaseUrl: string
  /** Seedream 5.0 Lite — ARK_IMAGE_MODEL_LITE (alias: ARK_IMAGE_MODEL) */
  arkImageModelLite: string
  /** Seedream 5.0 Pro — ARK_IMAGE_MODEL_PRO */
  arkImageModelPro: string
  /** Seedance 2.5 — ARK_VIDEO_MODEL or default model name */
  arkVideoModel: string
  /** Seedance 2.0 — ARK_VIDEO_MODEL_2 (or ARK_SEEDANCE_2_MODEL) */
  arkVideoModel2: string
  /** Ark chat model ids for Director LLM (DeepSeek). Override via env if you use custom endpoints. */
  arkLlmFlashModel: string
  arkLlmProModel: string
  /** OpenAI / OpenAI-compatible image API */
  openai: string
  openaiBaseUrl: string
  /** Default GPT Image 2.5 fast model */
  openaiImageModel25: string
  /** GPT Image 2.5 quality / edit-oriented */
  openaiImageModel25Quality: string
  /** GPT Image 2.0 */
  openaiImageModel2: string
  /** Director LLM — Qwen 3.7 Max (OPENAI chat) */
  openaiLlmQwenMax: string
  /** Suno music model */
  openaiMusicModel: string
  /** Per-provider t2v / i2v model ids (RouterBase-style) */
  openaiVideoSora2T2v: string
  openaiVideoSora2I2v: string
  openaiVideoSora2ProT2v: string
  openaiVideoSora2ProI2v: string
  openaiVideoVeo31T2v: string
  openaiVideoVeo31I2v: string
  openaiVideoKling3T2v: string
  openaiVideoKling3I2v: string
  openaiVideoWan27T2v: string
  openaiVideoWan27I2v: string
  openaiVideoSeedance2T2v: string
  openaiVideoSeedance2I2v: string
  openaiVideoSeedance25T2v: string
  openaiVideoSeedance25I2v: string
  higgsfield: string
  higgsfieldBaseUrl: string
  /** Official MiniMax video key (MiniMax-H3). */
  minimax: string
  minimaxBaseUrl: string
  /** Pixabay stock video. Empty when unset. */
  pixabay: string
  /** Firecrawl search. Empty uses the local firecrawl CLI. */
  firecrawl: string
  /** Hugging Face token for gated FLUX 3 Klein weights. */
  hfToken: string
}

const OPENAI_VIDEO_SET = new Set<string>(OPENAI_VIDEO_PROVIDERS)

export function parseGenProvider(v: unknown): GenProvider {
  // Alias: old localStorage / clients used `doubao` → Seedance 2.5
  if (v === 'seedance' || v === 'doubao') return 'seedance'
  if (v === 'seedance-2' || v === 'seedance-2.0') return 'seedance-2'
  if (v === 'higgsfield' || v === 'grok' || v === 'minimax') return v
  if (typeof v === 'string' && OPENAI_VIDEO_SET.has(v)) return v as GenProvider
  return 'grok'
}

/** Old image ids (grok, gpt, seedream) stay on the Klein path. Flux 18+ is its own local model. */
export function parseImageProvider(v: unknown): ImageProvider {
  if (v === 'flux-18') return 'flux-18'
  return 'flux-3-klein'
}

export function arkModelForImageProvider(
  provider: ImageProvider,
  keys: ProviderKeys,
): string | null {
  if (provider === 'seedream-5-lite') return keys.arkImageModelLite
  if (provider === 'seedream-5-pro') return keys.arkImageModelPro
  return null
}

export function isGptImageProvider(
  provider: ImageProvider,
): provider is 'gpt-image-2.5' | 'gpt-image-2' {
  return provider === 'gpt-image-2.5' || provider === 'gpt-image-2'
}

/** BytePlus ModelArk (intl) uses different model ids than 火山方舟 (China). */
export function isBytePlusArk(baseUrl: string): boolean {
  return /bytepluses|ap-southeast|eu-west/i.test(baseUrl)
}

/** Resolve t2v/i2v model id for an OpenAI-compatible video provider. */
export function openaiVideoModelId(
  provider: GenProvider,
  hasStartImage: boolean,
  keys: ProviderKeys,
): string | null {
  const pick = (t2v: string, i2v: string) => (hasStartImage ? i2v : t2v)
  switch (provider) {
    case 'sora-2':
      return pick(keys.openaiVideoSora2T2v, keys.openaiVideoSora2I2v)
    case 'sora-2-pro':
      return pick(keys.openaiVideoSora2ProT2v, keys.openaiVideoSora2ProI2v)
    case 'veo-3.1':
      return pick(keys.openaiVideoVeo31T2v, keys.openaiVideoVeo31I2v)
    case 'kling-3':
      return pick(keys.openaiVideoKling3T2v, keys.openaiVideoKling3I2v)
    case 'wan-2.7':
      return pick(keys.openaiVideoWan27T2v, keys.openaiVideoWan27I2v)
    case 'oa-seedance-2':
      return pick(keys.openaiVideoSeedance2T2v, keys.openaiVideoSeedance2I2v)
    case 'oa-seedance-2.5':
      return pick(keys.openaiVideoSeedance25T2v, keys.openaiVideoSeedance25I2v)
    default:
      return null
  }
}

export function keysFromEnv(env: Record<string, string>): ProviderKeys {
  const hfCombined =
    env.HIGGSFIELD_API_KEY ||
    env.HF_KEY ||
    env.HF_CREDENTIALS ||
    ''
  const hfId = env.HIGGSFIELD_KEY_ID || env.HF_API_KEY_ID || ''
  const hfSecret = env.HIGGSFIELD_KEY_SECRET || env.HF_API_KEY_SECRET || ''
  const higgsfield =
    hfCombined || (hfId && hfSecret ? `${hfId}:${hfSecret}` : '')

  const arkBaseUrl = (
    env.ARK_BASE_URL ||
    // BytePlus / intl keys need ap-southeast; China console keys use Beijing.
    'https://ark.cn-beijing.volces.com/api/v3'
  ).replace(/\/$/, '')
  const byteplus = isBytePlusArk(arkBaseUrl)

  return {
    xai: env.XAI_API_KEY || '',
    ark: env.ARK_API_KEY || env.DOUBAO_API_KEY || '',
    arkBaseUrl,
    // Seedream 5.0 — China: doubao-*; BytePlus: seedream-* / dola-seedream-*
    arkImageModelLite:
      env.ARK_IMAGE_MODEL_LITE ||
      env.ARK_IMAGE_MODEL ||
      (byteplus ? 'seedream-5-0-260128' : 'doubao-seedream-5-0-260128'),
    arkImageModelPro:
      env.ARK_IMAGE_MODEL_PRO ||
      (byteplus
        ? 'dola-seedream-5-0-pro-260628'
        : 'doubao-seedream-5-0-pro-260628'),
    // Seedance — China: doubao-seedance-*; BytePlus: dreamina-seedance-*
    arkVideoModel:
      env.ARK_VIDEO_MODEL ||
      (byteplus
        ? 'dreamina-seedance-2-5-260628'
        : 'doubao-seedance-2-5-260628'),
    arkVideoModel2:
      env.ARK_VIDEO_MODEL_2 ||
      env.ARK_SEEDANCE_2_MODEL ||
      (byteplus
        ? 'dreamina-seedance-2-0-260128'
        : 'doubao-seedance-2-0-260128'),
    // Official Ark GA model ids; set ARK_LLM_*_MODEL to your endpoint id (ep-…) if required.
    arkLlmFlashModel: env.ARK_LLM_FLASH_MODEL || 'deepseek-v4-flash-ga-260731',
    arkLlmProModel: env.ARK_LLM_PRO_MODEL || 'deepseek-v4-pro-ga-260813',
    openai: env.APIMART_API_KEY || env.OPENAI_API_KEY || '',
    openaiBaseUrl: (
      env.OPENAI_BASE_URL ||
      env.OPENAI_API_BASE ||
      env.APIMART_BASE_URL ||
      'https://api.apimart.ai/v1'
    ).replace(/\/$/, ''),
    openaiImageModel25: env.OPENAI_IMAGE_MODEL_25 || 'gpt-image-2.5-flare',
    openaiImageModel25Quality:
      env.OPENAI_IMAGE_MODEL_25_QUALITY || 'gpt-image-2.5-sunburst',
    openaiImageModel2: env.OPENAI_IMAGE_MODEL_2 || 'gpt-image-2',
    openaiLlmQwenMax: env.OPENAI_LLM_QWEN_MAX || 'qwen3.7-max',
    openaiMusicModel: env.OPENAI_MUSIC_MODEL || 'suno',
    // APIMart uses one model id for t2v + i2v (pass image_urls for i2v)
    openaiVideoSora2T2v: env.OPENAI_VIDEO_SORA2_T2V || 'sora-2',
    openaiVideoSora2I2v: env.OPENAI_VIDEO_SORA2_I2V || 'sora-2',
    openaiVideoSora2ProT2v: env.OPENAI_VIDEO_SORA2_PRO_T2V || 'sora-2-pro',
    openaiVideoSora2ProI2v: env.OPENAI_VIDEO_SORA2_PRO_I2V || 'sora-2-pro',
    openaiVideoVeo31T2v: env.OPENAI_VIDEO_VEO31_T2V || 'veo3.1-quality',
    openaiVideoVeo31I2v: env.OPENAI_VIDEO_VEO31_I2V || 'veo3.1-quality',
    openaiVideoKling3T2v: env.OPENAI_VIDEO_KLING3_T2V || 'kling-v3',
    openaiVideoKling3I2v: env.OPENAI_VIDEO_KLING3_I2V || 'kling-v3',
    openaiVideoWan27T2v: env.OPENAI_VIDEO_WAN27_T2V || 'wan2.7',
    openaiVideoWan27I2v: env.OPENAI_VIDEO_WAN27_I2V || 'wan2.7',
    openaiVideoSeedance2T2v: env.OPENAI_VIDEO_SEEDANCE2_T2V || 'seedance-2.0',
    openaiVideoSeedance2I2v: env.OPENAI_VIDEO_SEEDANCE2_I2V || 'seedance-2.0',
    openaiVideoSeedance25T2v:
      env.OPENAI_VIDEO_SEEDANCE25_T2V || 'seedance-2.5',
    openaiVideoSeedance25I2v:
      env.OPENAI_VIDEO_SEEDANCE25_I2V || 'seedance-2.5',
    higgsfield,
    higgsfieldBaseUrl: (
      env.HIGGSFIELD_BASE_URL || 'https://api.higgsfield.ai'
    ).replace(/\/$/, ''),
    minimax: env.MINIMAX_API_KEY || '',
    minimaxBaseUrl: minimaxBaseUrl(env),
    pixabay: env.PIXABAY_API_KEY || '',
    firecrawl: env.FIRECRAWL_API_KEY || '',
    hfToken: env.HF_TOKEN || env.HUGGING_FACE_HUB_TOKEN || '',
  }
}

function minimaxBaseUrl(env: Record<string, string>): string {
  const override = env.MINIMAX_BASE_URL?.trim()
  if (override) return override.replace(/\/$/, '')
  const region = (env.MINIMAX_REGION || 'global').trim().toLowerCase()
  return region === 'cn' || region === 'cn_zh'
    ? 'https://api.minimaxi.com'
    : 'https://api.minimax.io'
}

export function requireKey(
  provider: GenProvider,
  keys: ProviderKeys,
): string | null {
  if (provider === 'grok') {
    return keys.xai
      ? null
      : 'Missing XAI_API_KEY. Add it to canvas/.env and restart.'
  }
  if (provider === 'seedance' || provider === 'seedance-2') {
    return keys.ark
      ? null
      : 'Missing ARK_API_KEY (or DOUBAO_API_KEY). Add it to canvas/.env and restart.'
  }
  if (provider === 'minimax') {
    return keys.minimax
      ? null
      : 'Missing MINIMAX_API_KEY. Add it to canvas/.env and restart.'
  }
  if (isOpenAIVideoProvider(provider)) {
    return keys.openai
      ? null
      : 'Missing APIMART_API_KEY or OPENAI_API_KEY. Add it to canvas/.env and restart.'
  }
  return keys.higgsfield
    ? null
    : 'Missing HIGGSFIELD_API_KEY (KEY_ID:KEY_SECRET) or HIGGSFIELD_KEY_ID + HIGGSFIELD_KEY_SECRET. Add to canvas/.env and restart.'
}

export function requireImageKey(
  provider: ImageProvider,
  keys: ProviderKeys,
): string | null {
  if (provider === 'flux-3-klein' || provider === 'flux-18') return null
  if (provider === 'grok') {
    return keys.xai
      ? null
      : 'Missing XAI_API_KEY. Add it to canvas/.env and restart.'
  }
  if (isGptImageProvider(provider)) {
    return keys.openai
      ? null
      : 'Missing APIMART_API_KEY or OPENAI_API_KEY. Add it to canvas/.env and restart.'
  }
  // Seedream: Ark preferred, APIMart fallback
  if (keys.ark || keys.openai) return null
  return 'Missing ARK_API_KEY or APIMART_API_KEY for Seedream. Add to canvas/.env and restart.'
}

export function requireOpenAIKey(keys: ProviderKeys): string | null {
  return keys.openai
    ? null
    : 'Missing APIMART_API_KEY or OPENAI_API_KEY. Add it to canvas/.env and restart.'
}
