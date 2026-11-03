/**
 * OpenAI-compatible media for APIMart (and similar relays):
 *   POST /videos/generations → { data:[{ task_id }] } → GET /tasks/{id}
 *   POST /music/generations  → { data:[{ task_id }] } → GET /music/tasks/{id}
 * Also tolerates RouterBase-style { id, status } + GET /videos|/audio/generations/{id}.
 */
import type { ProviderKeys } from './genProvider.ts'

type AsyncStatus = string

type SubmitBody = {
  id?: string
  request_id?: string
  task_id?: string
  status?: AsyncStatus
  code?: number
  data?: Array<{ task_id?: string; id?: string; status?: string }> | {
    task_id?: string
    id?: string
  }
  error?: { message?: string } | string
}

type TaskPoll = {
  code?: number
  id?: string
  status?: AsyncStatus
  data?: {
    id?: string
    status?: AsyncStatus
    error?: { message?: string } | string
    result?: {
      videos?: Array<{ url?: string | string[]; duration?: number }>
      images?: Array<{ url?: string | string[] }>
      music?: Array<{ audio_url?: string; url?: string }>
      url?: string
    }
  }
  video?: { url?: string; duration?: number }
  result?: TaskPoll['data']
  error?: { message?: string } | string
  model?: string
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function errMsg(data: { error?: { message?: string } | string }, status: number) {
  if (typeof data.error === 'string') return data.error
  return data.error?.message || `OpenAI media error (${status})`
}

function extractTaskId(data: SubmitBody): string | null {
  if (data.task_id) return data.task_id
  if (data.id || data.request_id) return data.id || data.request_id || null
  const row = Array.isArray(data.data) ? data.data[0] : data.data
  if (row && typeof row === 'object') {
    return row.task_id || row.id || null
  }
  return null
}

function firstUrl(v: unknown): string | null {
  if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v
  if (Array.isArray(v)) {
    for (const x of v) {
      const u = firstUrl(x)
      if (u) return u
    }
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const key of ['url', 'audio_url', 'video_url', 'src']) {
      const u = firstUrl(o[key])
      if (u) return u
    }
  }
  return null
}

function extractMediaUrl(data: TaskPoll): {
  url: string | null
  duration?: number
} {
  const bag = data.data?.result || data.result || data.data
  if (!bag || typeof bag !== 'object') {
    const direct = firstUrl(data.video?.url) || firstUrl((data as { data?: unknown }).data)
    return { url: direct, duration: data.video?.duration }
  }
  const result = bag as NonNullable<TaskPoll['data']>['result'] & {
    videos?: unknown
    music?: unknown
    images?: unknown
    url?: unknown
  }
  const videos = result?.videos
  if (Array.isArray(videos) && videos[0]) {
    const row = videos[0] as { url?: unknown; duration?: number }
    return { url: firstUrl(row.url), duration: row.duration }
  }
  const music = result?.music
  if (Array.isArray(music) && music[0]) {
    const row = music[0] as { audio_url?: string; url?: string }
    return { url: firstUrl(row.audio_url) || firstUrl(row.url) }
  }
  const images = result?.images
  if (Array.isArray(images) && images[0]) {
    return { url: firstUrl((images[0] as { url?: unknown }).url) }
  }
  return { url: firstUrl(result?.url) || firstUrl(data.video?.url) }
}

function pollStatus(data: TaskPoll): string {
  return String(data.data?.status || data.status || '').toLowerCase()
}

async function pollUntilUrl(
  pollUrl: string,
  apiKey: string,
  opts?: { intervalMs?: number; maxWaitMs?: number },
): Promise<{ url: string; duration?: number; model?: string }> {
  const interval = opts?.intervalMs ?? 1000
  const maxWait = opts?.maxWaitMs ?? 12 * 60 * 1000
  const deadline = Date.now() + maxWait

  while (Date.now() < deadline) {
    const poll = await fetch(pollUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const data = (await poll.json()) as TaskPoll
    if (!poll.ok) {
      throw Object.assign(new Error(errMsg(data, poll.status)), {
        status: poll.status,
      })
    }
    const status = pollStatus(data)
    if (status === 'success' || status === 'done' || status === 'completed') {
      const { url, duration } = extractMediaUrl(data)
      if (!url) throw new Error('No media URL returned')
      return { url, duration, model: data.model }
    }
    if (
      status === 'failed' ||
      status === 'error' ||
      status === 'expired' ||
      status === 'cancelled'
    ) {
      const nested =
        typeof data.data?.error === 'string'
          ? data.data.error
          : data.data?.error?.message
      throw new Error(nested || errMsg(data, 502) || `Generation ${status}`)
    }
    await sleep(interval)
  }
  throw new Error('Generation timed out')
}

export type OpenAIVideoInput = {
  model: string
  prompt: string
  duration?: number
  aspect_ratio?: string
  resolution?: string
  /** First-frame for i2v — data URI or https URL */
  startImage?: string
}

export async function openaiGenerateVideo(
  keys: ProviderKeys,
  input: OpenAIVideoInput,
): Promise<{ url: string; duration?: number; model: string }> {
  const payload: Record<string, unknown> = {
    model: input.model,
    prompt: input.prompt,
  }
  if (input.duration != null) payload.duration = input.duration
  if (input.aspect_ratio) {
    payload.aspect_ratio = input.aspect_ratio
  }
  if (input.resolution) payload.resolution = input.resolution
  if (input.startImage) {
    payload.image_urls = [input.startImage]
  }

  const start = await fetch(`${keys.openaiBaseUrl}/videos/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${keys.openai}`,
    },
    body: JSON.stringify(payload),
  })
  const startData = (await start.json()) as SubmitBody
  const id = extractTaskId(startData)
  if (!start.ok || !id) {
    throw Object.assign(new Error(errMsg(startData, start.status)), {
      status: start.status || 502,
    })
  }

  // APIMart: /tasks/{id}; RouterBase-style: /videos/generations/{id}
  const isApimart = /apimart\.ai/i.test(keys.openaiBaseUrl)
  const pollPath = isApimart
    ? `${keys.openaiBaseUrl}/tasks/${id}`
    : `${keys.openaiBaseUrl}/videos/generations/${id}`

  const polled = await pollUntilUrl(pollPath, keys.openai, {
    maxWaitMs: 12 * 60 * 1000,
  })
  return {
    url: polled.url,
    duration: polled.duration ?? input.duration,
    model: polled.model || input.model,
  }
}

export type OpenAIMusicInput = {
  model: string
  prompt: string
  /** Genre / mood tags for Suno */
  style?: string
  title?: string
  /** Default true — BGM without vocals */
  instrumental?: boolean
  /** Suno public version e.g. v6 */
  version?: string
}

export async function openaiGenerateMusic(
  keys: ProviderKeys,
  input: OpenAIMusicInput,
): Promise<{ url: string; model: string }> {
  const isApimart = /apimart\.ai/i.test(keys.openaiBaseUrl)
  const instrumental = input.instrumental !== false

  let startUrl: string
  let payload: Record<string, unknown>

  if (isApimart) {
    // APIMart Suno: custom+instrumental uses style/title; prompt = inspiration or lyrics
    startUrl = `${keys.openaiBaseUrl}/music/generations`
    payload = {
      model: input.model || 'suno',
      version: input.version || 'v6',
      custom: true,
      instrumental,
      prompt: input.prompt,
    }
    if (input.style) payload.style = input.style
    if (input.title) payload.title = input.title
  } else {
    startUrl = `${keys.openaiBaseUrl}/audio/generations`
    payload = {
      model: input.model,
      prompt: input.prompt,
      instrumental,
    }
    if (input.style) {
      payload.style = input.style
      payload.tags = input.style
    }
    if (input.title) payload.title = input.title
  }

  const start = await fetch(startUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${keys.openai}`,
    },
    body: JSON.stringify(payload),
  })
  const startData = (await start.json()) as SubmitBody
  const id = extractTaskId(startData)
  if (!start.ok || !id) {
    throw Object.assign(new Error(errMsg(startData, start.status)), {
      status: start.status || 502,
    })
  }

  const pollPath = isApimart
    ? `${keys.openaiBaseUrl}/music/tasks/${id}`
    : `${keys.openaiBaseUrl}/audio/generations/${id}`

  const polled = await pollUntilUrl(pollPath, keys.openai, {
    maxWaitMs: 8 * 60 * 1000,
  })
  return { url: polled.url, model: polled.model || input.model }
}

/** Poll a generic APIMart async image task (POST already returned task_id). */
export async function openaiPollTaskUrl(
  keys: ProviderKeys,
  taskId: string,
): Promise<string> {
  const polled = await pollUntilUrl(
    `${keys.openaiBaseUrl}/tasks/${taskId}`,
    keys.openai,
    { maxWaitMs: 6 * 60 * 1000 },
  )
  return polled.url
}

export function extractApimartTaskId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  return extractTaskId(data as SubmitBody)
}
