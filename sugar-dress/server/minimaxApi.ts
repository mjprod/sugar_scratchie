import type { ProviderKeys } from './genProvider.ts'

type VideoInput = {
  prompt: string
  aspect_ratio?: string
  duration?: number
  startImage?: string
}

const RATIOS = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'])

type Submit = { task_id?: string; base_resp?: { status_code?: number; status_msg?: string } }
type Poll = {
  task?: {
    status?: string
    error?: string | { code?: string; message?: string }
    content?: { url?: string }
  }
  base_resp?: { status_code?: number; status_msg?: string }
}

function taskError(task: Poll['task']): string {
  const err = task?.error
  const raw = !err
    ? 'unknown error'
    : typeof err === 'string'
      ? err
      : err.message || err.code || 'unknown error'
  if (/sensitive/i.test(raw)) {
    return 'MiniMax 判定這段提示文字敏感，沒有出片。把驚嚇、暴力、血腥或露骨的句子改掉後再試。'
  }
  return raw
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function apiError(data: { base_resp?: { status_code?: number; status_msg?: string } }, status: number) {
  const code = data.base_resp?.status_code
  if (code && code !== 0) {
    return `MiniMax API error ${code}: ${data.base_resp?.status_msg || ''}`.trim()
  }
  return `MiniMax error (${status})`
}

/**
 * MiniMax-H3 via the official v2 video API.
 * Duration is 4–15s. Resolution is always 2K.
 */
export async function minimaxGenerateVideo(
  keys: ProviderKeys,
  input: VideoInput,
): Promise<{ url: string; duration: number; model: string }> {
  const duration = Math.min(15, Math.max(4, Math.round(input.duration || 6)))
  const asked = input.aspect_ratio || ''
  const ratio = RATIOS.has(asked) ? asked : input.startImage ? 'adaptive' : '16:9'
  const content: Record<string, unknown>[] = [{ type: 'text', text: input.prompt }]
  if (input.startImage) {
    content.push({
      type: 'image_url',
      image_url: { url: input.startImage },
      role: 'first_frame',
    })
  }
  const headers = {
    Authorization: `Bearer ${keys.minimax}`,
    'Content-Type': 'application/json',
  }
  const start = await fetch(`${keys.minimaxBaseUrl}/v2/video_generation`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'MiniMax-H3',
      content,
      resolution: '2K',
      duration,
      ratio,
    }),
  })
  const startData = (await start.json()) as Submit
  if (!start.ok || !startData.task_id) {
    throw new Error(apiError(startData, start.status))
  }

  const deadline = Date.now() + 20 * 60 * 1000
  let lastStatus = 'queued'
  while (Date.now() < deadline) {
    const poll = await fetch(
      `${keys.minimaxBaseUrl}/v2/query/video_generation/${startData.task_id}`,
      { headers },
    )
    const data = (await poll.json()) as Poll
    if (!poll.ok) throw new Error(apiError(data, poll.status))
    const code = data.base_resp?.status_code
    if (code && code !== 0) throw new Error(apiError(data, poll.status))
    const status = (data.task?.status || '').toLowerCase()
    if (status) lastStatus = status
    if (status === 'succeeded') {
      const url = data.task?.content?.url
      if (!url) throw new Error('MiniMax API did not return a download URL.')
      return { url, duration, model: 'MiniMax-H3' }
    }
    if (status === 'failed' || status === 'cancelled') {
      throw new Error(`MiniMax-H3 video generation ${status}: ${taskError(data.task)}`)
    }
    if (status && status !== 'queued' && status !== 'running') {
      throw new Error(`MiniMax-H3 video generation ${status}: ${taskError(data.task)}`)
    }
    await sleep(1000)
  }
  throw new Error(
    `MiniMax video generation timed out after 20 minutes (last status: ${lastStatus}, task ${startData.task_id})`,
  )
}

type MusicResp = {
  data?: { audio?: string; status?: number }
  base_resp?: { status_code?: number; status_msg?: string }
}

/** music-3.0 instrumental bed. Returns mp3 bytes. */
export async function minimaxGenerateMusic(
  keys: ProviderKeys,
  prompt: string,
): Promise<Buffer> {
  const res = await fetch(`${keys.minimaxBaseUrl}/v1/music_generation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${keys.minimax}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'music-3.0',
      prompt: prompt.slice(0, 2000),
      is_instrumental: true,
      output_format: 'hex',
      audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' },
    }),
  })
  const data = (await res.json()) as MusicResp
  const code = data.base_resp?.status_code
  if (!res.ok || (code && code !== 0) || !data.data?.audio) {
    throw new Error(
      data.base_resp?.status_msg || `MiniMax music error (${res.status})`,
    )
  }
  return Buffer.from(data.data.audio, 'hex')
}
