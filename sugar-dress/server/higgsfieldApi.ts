import type { ProviderKeys } from './genProvider.ts'

type ImageInput = {
  prompt: string
  aspect_ratio?: string
  images?: string[]
  image?: string
  image_mode?: 'speed' | 'quality' | '720'
}

type VideoInput = {
  prompt: string
  aspect_ratio?: string
  duration?: number
  resolution?: string
  startImage?: string
}

type HfSubmit = {
  status?: string
  request_id?: string
  status_url?: string
  detail?: string
  error?: string | { message?: string }
}

type HfStatus = {
  status?: string
  images?: Array<{ url?: string }>
  video?: { url?: string }
  error?: string | { message?: string }
  detail?: string
}

function authHeader(key: string) {
  return { Authorization: `Key ${key}`, 'Content-Type': 'application/json' }
}

function errOf(data: HfSubmit | HfStatus, status: number) {
  if (typeof data.error === 'string') return data.error
  if (data.error && typeof data.error === 'object' && data.error.message) {
    return data.error.message
  }
  if (typeof data.detail === 'string') return data.detail
  return `Higgsfield error (${status})`
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

const POLL_MS = 1000
const MAX_WAIT_MS = 8 * 60 * 1000

const HF_ASPECTS = new Set([
  '9:16',
  '16:9',
  '4:3',
  '3:4',
  '1:1',
  '2:3',
  '3:2',
])

function mapAspect(aspect?: string): string {
  if (aspect && HF_ASPECTS.has(aspect)) return aspect
  return '1:1'
}

/** Upload data URI / buffer to Higgsfield so models that need a public URL work. */
async function toPublicUrl(
  keys: ProviderKeys,
  src: string,
): Promise<string> {
  if (/^https?:\/\//i.test(src)) return src

  const m = /^data:(image\/[\w+.-]+);base64,(.+)$/i.exec(src)
  if (!m) {
    throw new Error(
      'Higgsfield needs a public image URL or data URI for reference / start frame',
    )
  }
  const contentType = m[1]
  const buf = Buffer.from(m[2], 'base64')

  const up = await fetch(`${keys.higgsfieldBaseUrl}/files/generate-upload-url`, {
    method: 'POST',
    headers: authHeader(keys.higgsfield),
    body: JSON.stringify({ content_type: contentType }),
  })
  const upData = (await up.json()) as {
    upload_url?: string
    public_url?: string
    upload_headers?: Record<string, string>
    detail?: string
  }
  if (!up.ok || !upData.upload_url || !upData.public_url) {
    throw new Error(
      upData.detail ||
        `Higgsfield upload URL failed (${up.status}). Check HIGGSFIELD credentials.`,
    )
  }

  const putHeaders = new Headers(upData.upload_headers ?? {})
  if (!putHeaders.has('Content-Type')) {
    putHeaders.set('Content-Type', contentType)
  }
  const put = await fetch(upData.upload_url, {
    method: 'PUT',
    headers: putHeaders,
    body: buf,
  })
  if (!put.ok) {
    throw new Error(`Higgsfield media upload failed (${put.status})`)
  }
  return upData.public_url
}

async function pollHf(
  keys: ProviderKeys,
  statusUrl: string,
): Promise<HfStatus> {
  const deadline = Date.now() + MAX_WAIT_MS
  while (Date.now() < deadline) {
    const poll = await fetch(statusUrl, {
      headers: authHeader(keys.higgsfield),
    })
    const data = (await poll.json()) as HfStatus
    if (!poll.ok) {
      throw Object.assign(new Error(errOf(data, poll.status)), {
        status: poll.status,
      })
    }
    const status = (data.status || '').toLowerCase()
    if (status === 'completed') return data
    if (
      status === 'failed' ||
      status === 'nsfw' ||
      status === 'canceled' ||
      status === 'cancelled'
    ) {
      throw new Error(errOf(data, 502) || `Higgsfield ${status}`)
    }
    await sleep(POLL_MS)
  }
  throw new Error('Higgsfield generation timed out')
}

async function submitAndWait(
  keys: ProviderKeys,
  path: string,
  body: Record<string, unknown>,
): Promise<HfStatus> {
  const url = `${keys.higgsfieldBaseUrl}/${path.replace(/^\//, '')}`
  const start = await fetch(url, {
    method: 'POST',
    headers: authHeader(keys.higgsfield),
    body: JSON.stringify(body),
  })
  const startData = (await start.json()) as HfSubmit
  if (!start.ok || !startData.status_url) {
    throw Object.assign(new Error(errOf(startData, start.status)), {
      status: start.status || 502,
    })
  }
  return pollHf(keys, startData.status_url)
}

/**
 * Soul V2 text-to-image; Soul reference for single-image edit.
 * ponytail: multi-ref unsupported on Soul reference — only first ref is used.
 */
export async function higgsfieldGenerateImage(
  keys: ProviderKeys,
  input: ImageInput,
): Promise<{ src: string; model: string }> {
  const refs = [
    ...(input.images ?? []),
    ...(input.image ? [input.image] : []),
  ]
    .map((u) => u?.trim())
    .filter((u): u is string => Boolean(u))

  const aspect = mapAspect(
    input.aspect_ratio === 'auto' ? '1:1' : input.aspect_ratio,
  )
  const resolution =
    input.image_mode === 'speed' || input.image_mode === '720' ? '720p' : '1080p'

  let model: string
  let result: HfStatus

  if (refs.length > 0) {
    // Soul reference: one image_reference_url only
    model = 'higgsfield-ai/soul/reference'
    const imageUrl = await toPublicUrl(keys, refs[0])
    result = await submitAndWait(keys, model, {
      prompt: input.prompt,
      image_reference_url: imageUrl,
      batch_size: 1,
      resolution,
      aspect_ratio: aspect,
      enhance_prompt: true,
    })
  } else {
    model = 'higgsfield-ai/soul/v2/standard'
    result = await submitAndWait(keys, model, {
      prompt: input.prompt,
      batch_size: 1,
      resolution,
      aspect_ratio: aspect,
      enhance_prompt: true,
    })
  }

  const src = result.images?.[0]?.url
  if (!src) throw new Error('No image returned from Higgsfield')
  return { src, model }
}

/** Kling I2V when start frame present; Kling T2V otherwise. */
export async function higgsfieldGenerateVideo(
  keys: ProviderKeys,
  input: VideoInput,
): Promise<{ url: string; model: string; duration: number }> {
  const duration = Math.min(15, Math.max(3, Number(input.duration) || 5))

  let model: string
  let result: HfStatus

  if (input.startImage) {
    model = 'kling-video/v3.0/std/image-to-video'
    const imageUrl = await toPublicUrl(keys, input.startImage)
    result = await submitAndWait(keys, model, {
      prompt: input.prompt,
      image_url: imageUrl,
      duration,
      sound: 'on',
      cfg_scale: 0.5,
      multi_shots: false,
    })
  } else {
    model = 'kling-video/v2.5-turbo/pro/text-to-video'
    result = await submitAndWait(keys, model, {
      prompt: input.prompt,
      duration,
    })
  }

  const url = result.video?.url
  if (!url) throw new Error('No video returned from Higgsfield')
  return { url, model, duration }
}
