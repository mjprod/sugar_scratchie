import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Generated files for this app only. Canvas keeps its own Generate folder. */
export const GENERATE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../Generate',
)

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
}

function stamp() {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `-${p(d.getMilliseconds(), 3)}`
  )
}

function shortId() {
  return Math.random().toString(36).slice(2, 8)
}

function parseDataUri(src: string): { mime: string; buffer: Buffer } | null {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(src)
  if (!m) return null
  return { mime: m[1], buffer: Buffer.from(m[2], 'base64') }
}

async function ensureDir() {
  await mkdir(GENERATE_DIR, { recursive: true })
}

function fileName(tag: string | undefined, ext: string) {
  return `${stamp()}${tag ? `-${tag}` : ''}-${shortId()}.${ext}`
}

/**
 * Persist a generated image (data URI or remote URL) under Generate/.
 * Returns the absolute path written, or null on failure (non-fatal).
 */
export async function saveGeneratedImage(
  src: string,
  meta?: { mode?: string; model?: string },
): Promise<string | null> {
  try {
    await ensureDir()

    let buffer: Buffer
    let ext = 'png'
    const data = parseDataUri(src)
    if (data) {
      buffer = data.buffer
      ext = EXT_BY_MIME[data.mime] ?? 'bin'
    } else if (/^https?:\/\//i.test(src)) {
      const res = await fetch(src)
      if (!res.ok) throw new Error(`Download failed (${res.status})`)
      const ctype = res.headers.get('content-type')?.split(';')[0]?.trim()
      if (ctype && EXT_BY_MIME[ctype]) ext = EXT_BY_MIME[ctype]
      buffer = Buffer.from(await res.arrayBuffer())
    } else {
      throw new Error('Unsupported image source')
    }

    const tag = [meta?.mode, meta?.model?.replace(/^grok-imagine-image-?/, '')]
      .filter(Boolean)
      .join('_')
    const filePath = path.join(GENERATE_DIR, fileName(tag || undefined, ext))
    await writeFile(filePath, buffer)
    return filePath
  } catch (err) {
    console.error('[saveGeneratedImage]', err)
    return null
  }
}

/**
 * Persist a generated video buffer or remote URL under Generate/.
 */
export async function saveGeneratedVideo(
  source: Buffer | string,
  meta?: { mode?: string },
): Promise<string | null> {
  try {
    await ensureDir()

    let buffer: Buffer
    let ext = 'mp4'
    if (Buffer.isBuffer(source)) {
      buffer = source
    } else {
      const data = parseDataUri(source)
      if (data) {
        buffer = data.buffer
        ext = EXT_BY_MIME[data.mime] ?? 'mp4'
      } else if (/^https?:\/\//i.test(source)) {
        const res = await fetch(source)
        if (!res.ok) throw new Error(`Download failed (${res.status})`)
        const ctype = res.headers.get('content-type')?.split(';')[0]?.trim()
        if (ctype && EXT_BY_MIME[ctype]) ext = EXT_BY_MIME[ctype]
        buffer = Buffer.from(await res.arrayBuffer())
      } else {
        throw new Error('Unsupported video source')
      }
    }

    const tag = ['video', meta?.mode].filter(Boolean).join('_')
    const filePath = path.join(GENERATE_DIR, fileName(tag, ext))
    await writeFile(filePath, buffer)
    return filePath
  } catch (err) {
    console.error('[saveGeneratedVideo]', err)
    return null
  }
}

/** Persist a generated audio buffer or remote URL under Generate/. */
export async function saveGeneratedAudio(
  source: Buffer | string,
  meta?: { mode?: string },
): Promise<string | null> {
  try {
    await ensureDir()

    let buffer: Buffer
    let ext = 'mp3'
    if (Buffer.isBuffer(source)) {
      buffer = source
    } else {
      const data = parseDataUri(source)
      if (data) {
        buffer = data.buffer
        ext = EXT_BY_MIME[data.mime] ?? 'mp3'
      } else if (/^https?:\/\//i.test(source)) {
        const res = await fetch(source)
        if (!res.ok) throw new Error(`Download failed (${res.status})`)
        const ctype = res.headers.get('content-type')?.split(';')[0]?.trim()
        if (ctype && EXT_BY_MIME[ctype]) ext = EXT_BY_MIME[ctype]
        buffer = Buffer.from(await res.arrayBuffer())
      } else {
        throw new Error('Unsupported audio source')
      }
    }

    const tag = ['audio', meta?.mode].filter(Boolean).join('_')
    const filePath = path.join(GENERATE_DIR, fileName(tag, ext))
    await writeFile(filePath, buffer)
    return filePath
  } catch (err) {
    console.error('[saveGeneratedAudio]', err)
    return null
  }
}
