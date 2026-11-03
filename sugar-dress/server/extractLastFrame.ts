import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const HOLD_BREATH_SEC = 0.22
const HOLD_MIN_FREEZE_SEC = 0.5
const HOLD_MIN_REMAIN_SEC = 1.2

async function mediaDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
    { timeout: 15000 },
  )
  const n = Number(stdout.trim())
  return Number.isFinite(n) ? n : 0
}

/**
 * Cut a trailing freeze, leaving a short breath.
 * Returns null when the tail is still moving or the hold is too short to cut.
 * ponytail: freezedetect only sees a held frame, not a slow drift.
 * Upgrade path is a tail motion-energy cut.
 */
export async function trimHoldTail(video: Buffer): Promise<Buffer | null> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mxj-hold-'))
  try {
    const inPath = path.join(dir, 'in.mp4')
    const outPath = path.join(dir, 'out.mp4')
    await writeFile(inPath, video)
    const duration = await mediaDuration(inPath)
    if (duration < HOLD_MIN_REMAIN_SEC + HOLD_MIN_FREEZE_SEC) return null
    const { stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-i',
        inPath,
        '-vf',
        'freezedetect=n=-50dB:d=0.35',
        '-map',
        '0:v:0',
        '-f',
        'null',
        '-',
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    )
    const events = [...String(stderr).matchAll(/freeze_(start|end):\s*([0-9.]+)/g)]
    let start: number | null = null
    let end = duration
    for (const event of events) {
      const at = Number(event[2])
      if (event[1] === 'start') {
        start = at
        end = duration
      } else if (event[1] === 'end') {
        end = at
      }
    }
    if (start == null || end < duration - 0.2) return null
    const cut = start + HOLD_BREATH_SEC
    if (cut < HOLD_MIN_REMAIN_SEC) return null
    if (duration - cut < HOLD_MIN_FREEZE_SEC - HOLD_BREATH_SEC) return null
    const cutArgs = ['-y', '-i', inPath, '-t', cut.toFixed(3), '-map', '0:v:0']
    const encode = async (codec: string[]) => {
      const tail = [...codec, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outPath]
      try {
        await execFileAsync(
          'ffmpeg',
          [...cutArgs, '-map', '0:a?', '-c:a', 'aac', ...tail],
          { maxBuffer: 512 * 1024 * 1024 },
        )
      } catch {
        await execFileAsync('ffmpeg', [...cutArgs, '-an', ...tail], {
          maxBuffer: 512 * 1024 * 1024,
        })
      }
    }
    try {
      await encode(['-c:v', 'h264_videotoolbox', '-b:v', '12M'])
    } catch {
      await encode(['-c:v', 'libx264', '-preset', 'veryfast'])
    }
    return await readFile(outPath)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Grab the final frame of a video (Buffer or remote URL) as a PNG buffer.
 */
export async function extractLastFrame(
  video: Buffer | string,
): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mxj-last-'))
  try {
    const inPath = path.join(dir, 'in.mp4')
    await materializeVideo(video, inPath)
    const outPath = path.join(dir, 'last.png')
    await execFileAsync(
      'ffmpeg',
      ['-y', '-sseof', '-0.05', '-i', inPath, '-frames:v', '1', '-q:v', '2', outPath],
      { maxBuffer: 32 * 1024 * 1024 },
    )
    return await readFile(outPath)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function materializeVideo(video: Buffer | string, inPath: string) {
  if (Buffer.isBuffer(video)) {
    await writeFile(inPath, video)
  } else if (video.startsWith('data:')) {
    const b64 = video.split(',')[1]
    if (!b64) throw new Error('Invalid video data URI')
    await writeFile(inPath, Buffer.from(b64, 'base64'))
  } else if (/^https?:\/\//i.test(video)) {
    const res = await fetch(video)
    if (!res.ok) throw new Error(`Failed to download video (${res.status})`)
    await writeFile(inPath, Buffer.from(await res.arrayBuffer()))
  } else {
    throw new Error('Unsupported video source')
  }
}

/**
 * Two JPEG data-URIs for review: early (~15%) and late (~85%) of the clip.
 * Falls back to last frame only if mid extraction fails.
 */
export async function extractReviewFrames(
  video: Buffer | string,
): Promise<string[]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mxj-rev-'))
  try {
    const inPath = path.join(dir, 'in.mp4')
    await materializeVideo(video, inPath)
    const frames: string[] = []
    for (const [name, args] of [
      ['a.jpg', ['-y', '-ss', '0.8', '-i', inPath, '-frames:v', '1', '-q:v', '5', path.join(dir, 'a.jpg')]],
      ['b.jpg', ['-y', '-sseof', '-0.4', '-i', inPath, '-frames:v', '1', '-q:v', '5', path.join(dir, 'b.jpg')]],
    ] as const) {
      try {
        await execFileAsync('ffmpeg', args, { maxBuffer: 32 * 1024 * 1024 })
        const buf = await readFile(path.join(dir, name))
        frames.push(`data:image/jpeg;base64,${buf.toString('base64')}`)
      } catch {
        // skip missing frame
      }
    }
    if (!frames.length) {
      const last = await extractLastFrame(inPath)
      frames.push(`data:image/png;base64,${last.toString('base64')}`)
    }
    return frames
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
