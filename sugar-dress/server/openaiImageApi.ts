/**
 * OpenAI-compatible GPT Image (2 / 2.5) via /v1/images/generations|edits.
 * Base URL overridable for third-party relays (OPENAI_BASE_URL).
 */
import type { ProviderKeys } from './genProvider.ts'
import {
  extractApimartTaskId,
  openaiPollTaskUrl,
} from './openaiMediaApi.ts'

type ImageMode = 'speed' | 'quality' | undefined

type Input = {
  prompt: string
  aspect_ratio?: string
  images?: string[]
  image?: string
  image_mode?: ImageMode
  /** gpt-image-2 | gpt-image-2.5-flare | gpt-image-2.5-sunburst */
  model: string
}

type OpenAIImageResponse = {
  error?: { message?: string } | string
  data?: Array<{ b64_json?: string; url?: string; task_id?: string }>
  code?: number
}

function detectDataUriMime(b64: string): string {
  if (b64.startsWith('/9j/')) return 'image/jpeg'
  if (b64.startsWith('iVBOR')) return 'image/png'
  if (b64.startsWith('UklGR')) return 'image/webp'
  return 'image/png'
}

function extractSrc(data: OpenAIImageResponse): string | null {
  const image = data.data?.[0]
  if (!image) return null
  if (image.b64_json) {
    return `data:${detectDataUriMime(image.b64_json)};base64,${image.b64_json}`
  }
  if (image.url) return image.url
  return null
}

function errorMessage(data: OpenAIImageResponse, status: number): string {
  if (typeof data.error === 'string') return data.error
  return data.error?.message || `OpenAI image error (${status})`
}

/** Map canvas aspect ratios to GPT Image size enums. */
export function gptImageSize(aspect?: string): string {
  switch (aspect) {
    case '16:9':
      return '1536x1024'
    case '9:16':
      return '1024x1536'
    case '3:2':
      return '1536x1024'
    case '2:3':
      return '1024x1536'
    case '1:1':
    default:
      return '1024x1024'
  }
}

function qualityForMode(mode: ImageMode): 'low' | 'medium' | 'high' {
  return mode === 'quality' ? 'high' : 'medium'
}

function parseDataUri(uri: string): { mime: string; buf: Buffer } | null {
  const m = uri.match(/^data:([^;]+);base64,(.+)$/s)
  if (!m) return null
  return { mime: m[1] || 'image/png', buf: Buffer.from(m[2], 'base64') }
}

async function fetchAsBuffer(url: string): Promise<{ mime: string; buf: Buffer }> {
  if (url.startsWith('data:')) {
    const parsed = parseDataUri(url)
    if (!parsed) throw new Error('Invalid data URI reference image')
    return parsed
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch reference image (${res.status})`)
  const mime = res.headers.get('content-type') || 'image/png'
  const buf = Buffer.from(await res.arrayBuffer())
  return { mime, buf }
}

function extForMime(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  if (mime.includes('webp')) return 'webp'
  return 'png'
}

export function resolveGptImageModel(
  provider: 'gpt-image-2' | 'gpt-image-2.5',
  imageMode: ImageMode,
  keys: ProviderKeys,
): string {
  if (provider === 'gpt-image-2') {
    return keys.openaiImageModel2
  }
  // 2.5: flare = fast everyday; sunburst = edit/precision (quality)
  return imageMode === 'quality'
    ? keys.openaiImageModel25Quality
    : keys.openaiImageModel25
}

export async function openaiGenerateImage(
  keys: ProviderKeys,
  input: Input,
): Promise<{ src: string; model: string }> {
  if (!keys.openai) {
    throw new Error('Missing APIMART_API_KEY or OPENAI_API_KEY')
  }

  const refs = [
    ...(input.images ?? []).map((u) => u?.trim()).filter(Boolean),
    ...(input.image?.trim() ? [input.image.trim()] : []),
  ].slice(0, 3) as string[]
  const isEdit = refs.length > 0
  const base = keys.openaiBaseUrl.replace(/\/$/, '')
  const model = input.model
  const size = gptImageSize(input.aspect_ratio)
  const quality = qualityForMode(input.image_mode)
  const isApimart = /apimart\.ai/i.test(base)

  let upstream: Response

  if (isEdit) {
    const form = new FormData()
    form.append('model', model)
    form.append('prompt', input.prompt)
    form.append('size', size)
    form.append('quality', quality)
    // Prefer b64 so we can persist without a second fetch
    form.append('response_format', 'b64_json')
    for (let i = 0; i < refs.length; i++) {
      const { mime, buf } = await fetchAsBuffer(refs[i])
      const blob = new Blob([buf], { type: mime })
      form.append('image[]', blob, `ref-${i}.${extForMime(mime)}`)
    }
    upstream = await fetch(`${base}/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${keys.openai}` },
      body: form,
    })
  } else {
    upstream = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${keys.openai}`,
      },
      body: JSON.stringify({
        model,
        prompt: input.prompt,
        n: 1,
        size,
        quality,
        // GPT Image returns b64 by default on some relays; ask explicitly
        output_format: 'png',
      }),
    })
  }

  const data = (await upstream.json()) as OpenAIImageResponse
  if (!upstream.ok) {
    throw Object.assign(new Error(errorMessage(data, upstream.status)), {
      status: upstream.status,
    })
  }

  // APIMart async: { code:200, data:[{ task_id }] }
  const taskId = isApimart ? extractApimartTaskId(data) : null
  if (taskId) {
    const url = await openaiPollTaskUrl(keys, taskId)
    if (url.startsWith('data:')) return { src: url, model }
    // fetch remote → data URI for canvas persistence
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Failed to download image (${res.status})`)
    const buf = Buffer.from(await res.arrayBuffer())
    const mime = res.headers.get('content-type') || 'image/png'
    return {
      src: `data:${mime};base64,${buf.toString('base64')}`,
      model,
    }
  }

  const src = extractSrc(data)
  if (!src) throw new Error('No image returned from GPT Image')
  return { src, model }
}
