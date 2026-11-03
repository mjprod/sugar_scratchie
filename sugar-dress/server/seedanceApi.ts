import type { ProviderKeys } from './genProvider.ts'

type ImageInput = {
  prompt: string
  aspect_ratio?: string
  images?: string[]
  image?: string
  image_mode?: 'speed' | 'quality' | '720'
  /** Override Ark image model (Seedream 5 lite/pro). Defaults to lite. */
  model?: string
}

type VideoInput = {
  prompt: string
  aspect_ratio?: string
  duration?: number
  resolution?: string
  startImage?: string
  /** Override Ark video model (2.5 vs 2.0). Defaults to keys.arkVideoModel. */
  model?: string
}

type ArkImageResponse = {
  error?: { message?: string } | string
  data?: Array<{ url?: string; b64_json?: string }>
}

type ArkTaskCreate = { id?: string; error?: { message?: string } | string }
type ArkTaskPoll = {
  status?: string
  content?: { video_url?: string }
  error?: { message?: string } | string
}

function errMsg(data: { error?: { message?: string } | string }, status: number) {
  if (typeof data.error === 'string') return data.error
  return data.error?.message || `Seedance/Ark error (${status})`
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Map canvas ratios to Seedream size tokens.
 * Lite (5.0) floor is 2K; Pro accepts 1K. Quality → 2K for both.
 */
function seedreamSize(
  aspect: string | undefined,
  mode: ImageInput['image_mode'],
  model: string,
): string {
  void aspect
  const isPro = model.includes('pro')
  if (!isPro) return '2K'
  return mode === 'speed' || mode === '720' ? '1K' : '2K'
}

/**
 * Seedream on Ark `/images/generations` (same key as Seedance video).
 * ponytail: multi-ref — API accepts `image` as string | string[]; we pass all refs (≤3).
 */
export async function seedanceGenerateImage(
  keys: ProviderKeys,
  input: ImageInput,
): Promise<{ src: string; model: string }> {
  const model = input.model || keys.arkImageModelLite
  const refs = [
    ...(input.images ?? []),
    ...(input.image ? [input.image] : []),
  ]
    .map((u) => u?.trim())
    .filter((u): u is string => Boolean(u))
    .slice(0, 3)

  const payload: Record<string, unknown> = {
    model,
    prompt: input.prompt,
    size: seedreamSize(input.aspect_ratio, input.image_mode, model),
    response_format: 'url',
    watermark: false,
  }
  if (refs.length === 1) payload.image = refs[0]
  else if (refs.length > 1) payload.image = refs

  const res = await fetch(`${keys.arkBaseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${keys.ark}`,
    },
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as ArkImageResponse
  if (!res.ok) throw Object.assign(new Error(errMsg(data, res.status)), { status: res.status })

  const img = data.data?.[0]
  if (img?.b64_json) {
    const mime = img.b64_json.startsWith('iVBOR') ? 'image/png' : 'image/jpeg'
    return {
      src: `data:${mime};base64,${img.b64_json}`,
      model,
    }
  }
  if (img?.url) return { src: img.url, model }
  throw new Error('No image returned from Seedream')
}

const POLL_MS = 1000
const MAX_WAIT_MS = 8 * 60 * 1000

async function pollArkVideo(
  keys: ProviderKeys,
  taskId: string,
): Promise<string> {
  const deadline = Date.now() + MAX_WAIT_MS
  while (Date.now() < deadline) {
    const poll = await fetch(
      `${keys.arkBaseUrl}/contents/generations/tasks/${taskId}`,
      { headers: { Authorization: `Bearer ${keys.ark}` } },
    )
    const data = (await poll.json()) as ArkTaskPoll
    if (!poll.ok) {
      throw Object.assign(new Error(errMsg(data, poll.status)), {
        status: poll.status,
      })
    }
    const status = (data.status || '').toLowerCase()
    if (status === 'succeeded' || status === 'done') {
      const url = data.content?.video_url
      if (!url) throw new Error('No video URL from Seedance')
      return url
    }
    if (status === 'failed' || status === 'expired' || status === 'cancelled') {
      throw new Error(errMsg(data, 502) || `Seedance video ${status}`)
    }
    await sleep(POLL_MS)
  }
  throw new Error('Seedance video generation timed out')
}

/**
 * Seedance (2.5 / 2.0): text-to-video or first-frame image-to-video.
 * Endpoint: POST /contents/generations/tasks (Volcengine Ark).
 * Duration 4–30s. I2V uses ratio `adaptive` (required on 2.5; fine on 2.0).
 */
export async function seedanceGenerateVideo(
  keys: ProviderKeys,
  input: VideoInput,
): Promise<{ url: string; model: string; duration: number }> {
  const model = input.model || keys.arkVideoModel
  const duration = Math.min(30, Math.max(4, Number(input.duration) || 5))
  const hasStart = Boolean(input.startImage)
  // Seedance 2.5 rejects concrete ratios for first-frame / first+last tasks.
  const ratio = hasStart
    ? 'adaptive'
    : input.aspect_ratio && input.aspect_ratio !== 'auto'
      ? input.aspect_ratio
      : '16:9'
  const resolution = (['480p', '720p', '1080p'] as const).includes(
    input.resolution as '720p',
  )
    ? input.resolution!
    : '720p'

  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: input.prompt },
  ]
  if (input.startImage) {
    content.push({
      type: 'image_url',
      image_url: { url: input.startImage },
      role: 'first_frame',
    })
  }

  const start = await fetch(`${keys.arkBaseUrl}/contents/generations/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${keys.ark}`,
    },
    body: JSON.stringify({
      model,
      content,
      resolution,
      ratio,
      duration,
      watermark: false,
    }),
  })
  const startData = (await start.json()) as ArkTaskCreate
  if (!start.ok || !startData.id) {
    throw Object.assign(new Error(errMsg(startData, start.status)), {
      status: start.status || 502,
    })
  }

  const url = await pollArkVideo(keys, startData.id)
  return { url, model, duration }
}
