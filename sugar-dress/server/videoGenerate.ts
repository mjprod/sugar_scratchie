import type { IncomingMessage, ServerResponse } from 'node:http'
import { minimaxGenerateVideo } from './minimaxApi.ts'
import { seedanceGenerateVideo } from './seedanceApi.ts'
import { extractLastFrame, trimHoldTail } from './extractLastFrame.ts'
import {
  isOpenAIVideoProvider,
  openaiVideoModelId,
  parseGenProvider,
  requireKey,
  type ProviderKeys,
} from './genProvider.ts'
import { higgsfieldGenerateVideo } from './higgsfieldApi.ts'
import { openaiGenerateVideo } from './openaiMediaApi.ts'
import { saveGeneratedImage, saveGeneratedVideo } from './saveGenerated.ts'

type VideoBody = {
  prompt?: string
  aspect_ratio?: string
  duration?: number
  resolution?: string
  provider?: string
  /** First-frame / image-to-video source */
  image?: string
  start_image?: string
  /** Drop a trailing freeze and take the next shot's start from the cut. */
  trim_hold?: boolean
}

type StartResponse = {
  request_id?: string
  error?: { message?: string } | string
}

type PollResponse = {
  status?: 'pending' | 'done' | 'failed' | 'expired'
  video?: { url?: string; duration?: number }
  error?: { message?: string } | string
  model?: string
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  if (!chunks.length) return {} as T
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

function errMsg(data: { error?: { message?: string } | string }, status: number) {
  if (typeof data.error === 'string') return data.error
  return data.error?.message || `xAI video error (${status})`
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

const POLL_MS = 1000
const MAX_WAIT_MS = 8 * 60 * 1000

async function pollVideo(
  apiKey: string,
  requestId: string,
): Promise<{ url: string; duration?: number }> {
  const deadline = Date.now() + MAX_WAIT_MS
  while (Date.now() < deadline) {
    const poll = await fetch(`https://api.x.ai/v1/videos/${requestId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    const data = (await poll.json()) as PollResponse
    if (!poll.ok) {
      throw Object.assign(new Error(errMsg(data, poll.status)), {
        status: poll.status,
      })
    }
    if (data.status === 'done') {
      const url = data.video?.url
      if (!url) throw new Error('No video URL returned')
      return { url, duration: data.video?.duration }
    }
    if (data.status === 'failed' || data.status === 'expired') {
      throw new Error(errMsg(data, 502) || `Video generation ${data.status}`)
    }
    await sleep(POLL_MS)
  }
  throw new Error('Video generation timed out')
}

async function downloadVideoBuffer(url: string): Promise<Buffer> {
  const videoRes = await fetch(url)
  if (!videoRes.ok) throw new Error('Failed to download generated video')
  return Buffer.from(await videoRes.arrayBuffer())
}

export async function handleGenerateVideo(
  req: IncomingMessage,
  res: ServerResponse,
  keys: ProviderKeys,
) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' })
    return
  }

  try {
    const body = await readJsonBody<VideoBody>(req)
    const prompt = body.prompt?.trim()
    if (!prompt) {
      sendJson(res, 400, { error: 'Prompt is required' })
      return
    }

    const provider = parseGenProvider(body.provider)
    const missing = requireKey(provider, keys)
    if (missing) {
      sendJson(res, 500, { error: missing })
      return
    }

    const duration = Math.min(15, Math.max(1, Number(body.duration) || 6))
    const resolution = (['480p', '720p', '1080p'] as const).includes(
      body.resolution as '480p',
    )
      ? body.resolution!
      : '720p'
    const aspect =
      body.aspect_ratio && body.aspect_ratio !== 'auto'
        ? body.aspect_ratio
        : '16:9'

    const startImage =
      body.start_image?.trim() || body.image?.trim() || ''

    let videoUrl: string
    let resultDuration = duration
    let model = 'grok-imagine-video-1.5'

    if (provider === 'seedance' || provider === 'seedance-2') {
      const out = await seedanceGenerateVideo(keys, {
        prompt,
        aspect_ratio: aspect,
        duration,
        resolution,
        startImage: startImage || undefined,
        model:
          provider === 'seedance-2'
            ? keys.arkVideoModel2
            : keys.arkVideoModel,
      })
      videoUrl = out.url
      resultDuration = out.duration
      model = out.model
    } else if (provider === 'minimax') {
      const out = await minimaxGenerateVideo(keys, {
        prompt,
        aspect_ratio: aspect,
        duration,
        startImage: startImage || undefined,
      })
      videoUrl = out.url
      resultDuration = out.duration
      model = out.model
    } else if (isOpenAIVideoProvider(provider)) {
      const oaModel = openaiVideoModelId(provider, Boolean(startImage), keys)
      if (!oaModel) {
        sendJson(res, 400, { error: `Unknown OpenAI video provider: ${provider}` })
        return
      }
      const out = await openaiGenerateVideo(keys, {
        model: oaModel,
        prompt,
        duration,
        aspect_ratio: aspect,
        resolution,
        startImage: startImage || undefined,
      })
      videoUrl = out.url
      resultDuration = out.duration ?? duration
      model = out.model
    } else if (provider === 'higgsfield') {
      const out = await higgsfieldGenerateVideo(keys, {
        prompt,
        aspect_ratio: aspect,
        duration,
        resolution,
        startImage: startImage || undefined,
      })
      videoUrl = out.url
      resultDuration = out.duration
      model = out.model
    } else {
      const apiPrompt = startImage
        ? `${prompt.trim()}\n\nAnimate continuously from the provided first frame; keep subject identity and composition.`
        : prompt.trim()

      const payload: Record<string, unknown> = {
        model,
        prompt: apiPrompt,
        duration,
        aspect_ratio: aspect,
        resolution,
      }
      if (startImage) {
        payload.image = { url: startImage }
      }

      const start = await fetch('https://api.x.ai/v1/videos/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${keys.xai}`,
        },
        body: JSON.stringify(payload),
      })
      const startData = (await start.json()) as StartResponse
      if (!start.ok || !startData.request_id) {
        sendJson(res, start.status || 502, {
          error: errMsg(startData, start.status),
        })
        return
      }

      const result = await pollVideo(keys.xai, startData.request_id)
      videoUrl = result.url
      resultDuration = result.duration ?? duration
    }

    const downloaded = await downloadVideoBuffer(videoUrl)
    let videoBuffer = downloaded
    let trimmedHold = false
    if (body.trim_hold) {
      try {
        const cut = await trimHoldTail(downloaded)
        if (cut) {
          videoBuffer = cut
          trimmedHold = true
        }
      } catch (err) {
        console.error('[trimHoldTail]', err)
      }
    }
    const modeLabel = startImage ? 'image-to-video' : 'text-to-video'
    const savedPath = await saveGeneratedVideo(videoBuffer, { mode: modeLabel })

    let lastFrameSrc: string | null = null
    let lastFrameSavedPath: string | null = null
    try {
      const frameBuf = await extractLastFrame(videoBuffer)
      lastFrameSrc = `data:image/png;base64,${frameBuf.toString('base64')}`
      lastFrameSavedPath = await saveGeneratedImage(lastFrameSrc, {
        mode: 'video-last-frame',
        model: 'frame',
      })
    } catch (err) {
      console.error('[extractLastFrame]', err)
    }

    sendJson(res, 200, {
      src: `data:video/mp4;base64,${videoBuffer.toString('base64')}`,
      lastFrame: lastFrameSrc,
      trimmed: trimmedHold,
      duration: resultDuration,
      resolution,
      mode: modeLabel,
      kind: 'video',
      provider,
      model,
      ...(savedPath ? { savedPath } : {}),
      ...(lastFrameSavedPath ? { lastFrameSavedPath } : {}),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Video generation failed'
    const status =
      err && typeof err === 'object' && 'status' in err
        ? Number((err as { status: number }).status) || 500
        : message.includes('timed out')
          ? 504
          : 500
    sendJson(res, status, { error: message })
  }
}
