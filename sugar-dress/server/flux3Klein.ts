import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'

const SCRIPT = path.join(import.meta.dirname, 'flux3_klein.py')
const DEFAULT_PY = path.join(homedir(), '.local/share/mxj-flux3-klein/venv/bin/python')

/** Same table as sugar_scratchie backend/services/bfl.py for the Flux Klein sidecar. */
const SIDECAR_ASPECT_SIZES: Record<string, [number, number]> = {
  '9:16': [768, 1344],
  '16:9': [1344, 768],
  '1:1': [1024, 1024],
  '3:4': [768, 1024],
  '4:3': [1024, 768],
  '2:3': [832, 1248],
  '3:2': [1248, 832],
}

const SIDECAR_USER_AGENT = 'flux-client/1.0'
const SIDECAR_POLL_MS = 2000
const SIDECAR_TIMEOUT_MS = 600_000
const SIDECAR_MAX_SIDE = 2048

const SIZES: Record<string, [number, number]> = {
  '1:1': [1024, 1024],
  '16:9': [1280, 720],
  '9:16': [720, 1280],
  '4:3': [1152, 864],
  '3:4': [864, 1152],
  '3:2': [1216, 832],
  '2:3': [832, 1216],
}

export function sidecarUrl(): string {
  return (process.env.FLUX_KLEIN_URL || '').trim().replace(/\/+$/, '')
}

function kleinToken(): string {
  return (process.env.FLUX_KLEIN_TOKEN || '').trim()
}

function sidecarHeaders(jsonBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': SIDECAR_USER_AGENT,
    Accept: 'application/json, image/png',
  }
  const token = kleinToken()
  if (token) {
    headers.Authorization = `Bearer ${token}`
    headers['X-API-Key'] = token
  }
  if (jsonBody) headers['Content-Type'] = 'application/json'
  return headers
}

/** Multiples of 16, max side 2048 — matches the sidecar size rule. */
function sidecarSize(
  aspect?: string,
  ref?: { w: number; h: number } | null,
): [number, number] {
  if (aspect && SIDECAR_ASPECT_SIZES[aspect]) return SIDECAR_ASPECT_SIZES[aspect]
  if (aspect === 'auto' && ref && ref.w > 0 && ref.h > 0) {
    let w = Math.max(64, Math.round(ref.w / 16) * 16)
    let h = Math.max(64, Math.round(ref.h / 16) * 16)
    const scale = Math.min(1, SIDECAR_MAX_SIDE / Math.max(w, h))
    w = Math.max(64, Math.round((w * scale) / 16) * 16)
    h = Math.max(64, Math.round((h * scale) / 16) * 16)
    return [w, h]
  }
  return SIDECAR_ASPECT_SIZES['9:16']
}

function jobIdFrom(payload: Record<string, unknown>): string {
  for (const key of ['id', 'job_id', 'jid'] as const) {
    const value = String(payload[key] ?? '').trim()
    if (value) return value
  }
  const nested = payload.job
  if (nested && typeof nested === 'object') {
    return jobIdFrom(nested as Record<string, unknown>)
  }
  return ''
}

async function pollSidecarJob(
  base: string,
  jobId: string,
): Promise<{ image?: ArrayBuffer; contentType?: string } | Record<string, unknown>> {
  const deadline = Date.now() + SIDECAR_TIMEOUT_MS
  const url = `${base}/jobs/${jobId}`
  let last = 'queued'
  while (Date.now() < deadline) {
    const resp = await fetch(url, { headers: sidecarHeaders(false) })
    const contentType = (resp.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase()
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 500)
      if (resp.status === 301 || resp.status === 302 || resp.status === 401 || resp.status === 403) {
        throw new Error(
          `FLUX Klein server rejected the request. Set FLUX_KLEIN_TOKEN for the public tunnel. HTTP ${resp.status}: ${detail}`,
        )
      }
      throw new Error(`FLUX Klein server HTTP ${resp.status}: ${detail}`)
    }
    if (contentType.startsWith('image/')) {
      return { image: await resp.arrayBuffer(), contentType }
    }
    const job = (await resp.json()) as Record<string, unknown>
    const status = String(job.status ?? '')
      .trim()
      .toLowerCase()
    last = status || last
    if (status === 'succeeded') return job
    if (status === 'failed' || status === 'cancelled' || status === 'canceled' || status === 'error') {
      const detail = job.error || job.detail || job.message || status
      throw new Error(`FLUX Klein job ${jobId} ${status}: ${detail}`)
    }
    await new Promise((r) => setTimeout(r, SIDECAR_POLL_MS))
  }
  throw new Error(`FLUX Klein job ${jobId} still ${last} after ${SIDECAR_TIMEOUT_MS / 1000}s`)
}

async function generateViaSidecar(input: {
  prompt: string
  aspect_ratio?: string
  images?: string[]
  image?: string
  image_mode?: 'speed' | 'quality' | '720'
}): Promise<{ src: string; mode: string; model: string; image_mode: string }> {
  const base = sidecarUrl()
  if (!base) throw new Error('FLUX_KLEIN_URL is not set.')
  const refs = [...(input.images ?? []), input.image ?? ''].filter(Boolean)
  const { dir, paths } = await writeRefs(refs)
  try {
    const refSize =
      input.aspect_ratio === 'auto' && paths[0] ? refPixelSize(paths[0]) : null
    const [width, height] = sidecarSize(input.aspect_ratio, refSize)
    shrinkRefs(paths, width, height)
    const images: string[] = []
    for (const file of paths) {
      images.push((await readFile(file)).toString('base64'))
    }
    const body: Record<string, unknown> = {
      prompt: input.prompt,
      width,
      height,
    }
    if (images.length) body.images = images

    process.stderr.write(`[flux3-klein] via ${base}/generate ${width}x${height} ...\n`)
    const submitResp = await fetch(`${base}/generate`, {
      method: 'POST',
      headers: sidecarHeaders(true),
      body: JSON.stringify(body),
    })
    const submitType = (submitResp.headers.get('content-type') || '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase()
    if (!submitResp.ok) {
      const detail = (await submitResp.text()).slice(0, 500)
      if (
        submitResp.status === 301 ||
        submitResp.status === 302 ||
        submitResp.status === 401 ||
        submitResp.status === 403
      ) {
        throw new Error(
          `FLUX Klein server rejected the request. Set FLUX_KLEIN_TOKEN for the public tunnel. HTTP ${submitResp.status}: ${detail}`,
        )
      }
      throw new Error(`FLUX Klein server HTTP ${submitResp.status}: ${detail}`)
    }
    if (submitType.startsWith('image/')) {
      const buf = Buffer.from(await submitResp.arrayBuffer())
      return {
        src: `data:image/png;base64,${buf.toString('base64')}`,
        mode: paths.length ? 'edit' : 'generate',
        model: 'flux-3-image-klein',
        image_mode: input.image_mode ?? 'speed',
      }
    }
    const submit = (await submitResp.json()) as Record<string, unknown>
    const id = jobIdFrom(submit)
    if (!id) throw new Error(`FLUX Klein server did not return a job id: ${JSON.stringify(submit)}`)
    const ready = await pollSidecarJob(base, id)
    if (ready.image instanceof ArrayBuffer) {
      const buf = Buffer.from(ready.image)
      return {
        src: `data:image/png;base64,${buf.toString('base64')}`,
        mode: paths.length ? 'edit' : 'generate',
        model: 'flux-3-image-klein',
        image_mode: input.image_mode ?? 'speed',
      }
    }
    const imageResp = await fetch(`${base}/jobs/${id}/image`, {
      headers: sidecarHeaders(false),
    })
    if (!imageResp.ok) {
      const detail = (await imageResp.text()).slice(0, 500)
      throw new Error(`FLUX Klein image HTTP ${imageResp.status}: ${detail}`)
    }
    const buf = Buffer.from(await imageResp.arrayBuffer())
    return {
      src: `data:image/png;base64,${buf.toString('base64')}`,
      mode: paths.length ? 'edit' : 'generate',
      model: 'flux-3-image-klein',
      image_mode: input.image_mode ?? 'speed',
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function snap16(n: number): number {
  return Math.max(16, Math.round(n / 16) * 16)
}

const KLEIN_MAX_AREA = 1024 * 1024

/** This photo's own pixels. Klein's grid is 32, and it will not hold more than 1024².
 *  A bigger photo scales down evenly. A smaller one is not enlarged to 720. */
function originalFrame(w: number, h: number): [number, number] {
  const ratio = w / h
  const scale = Math.min(1, Math.sqrt(KLEIN_MAX_AREA / (w * h)))
  const startW = Math.max(64, Math.round((w * scale) / 32) * 32)
  const startH = Math.max(64, Math.round((h * scale) / 32) * 32)
  let bestW = startW
  let bestH = startH
  let bestErr = Infinity
  let bestArea = -1
  for (let dw = -192; dw <= 192; dw += 32) {
    for (let dh = -192; dh <= 192; dh += 32) {
      const sw = startW + dw
      const sh = startH + dh
      if (sw < 64 || sh < 64 || sw > w || sh > h) continue
      if (sw * sh > KLEIN_MAX_AREA) continue
      if (Math.max(sw / sh, sh / sw) > 8) continue
      const err = Math.abs(sw / sh - ratio)
      const area = sw * sh
      if (err < bestErr - 1e-6 || (Math.abs(err - bestErr) <= 1e-6 && area > bestArea)) {
        bestErr = err
        bestArea = area
        bestW = sw
        bestH = sh
      }
    }
  }
  return [bestW, bestH]
}
function snapAspect(w: number, h: number): [number, number] {
  const ratio = w / h
  let bestW = snap16(w)
  let bestH = snap16(h)
  let best = Math.abs(bestW / bestH - ratio)
  const baseW = bestW
  const baseH = bestH
  for (const dw of [-32, -16, 0, 16, 32]) {
    for (const dh of [-32, -16, 0, 16, 32]) {
      const sw = Math.max(16, baseW + dw)
      const sh = Math.max(16, baseH + dh)
      const err = Math.abs(sw / sh - ratio)
      if (err < best) {
        best = err
        bestW = sw
        bestH = sh
      }
    }
  }
  return [bestW, bestH]
}

export function kleinSize(
  aspect?: string,
  quality: boolean | '720' = false,
  ref?: { w: number; h: number } | null,
): [number, number] {
  // 9:16 is the only generate frame. A photo uses the largest 9:16 that fits inside it.
  if (aspect === '9:16') {
    const box = ref && ref.w > 0 && ref.h > 0 ? ref : { w: 720, h: 1280 }
    let fw = box.w
    let fh = (fw * 16) / 9
    if (fh > box.h) {
      fh = box.h
      fw = (fh * 9) / 16
    }
    return originalFrame(fw, fh)
  }
  // Auto + a reference follows that photo. Speed and 720 do not pick a different frame.
  if (aspect === 'auto' && ref && ref.w > 0 && ref.h > 0) {
    return originalFrame(ref.w, ref.h)
  }
  const [w, h] = SIZES[aspect ?? ''] ?? [1024, 1024]
  const scale = quality === '720' ? 720 / Math.min(w, h) : quality ? 1.5 : 1
  return snapAspect(w * scale, h * scale)
}

/** Fit a reference into the output's pixel budget. Klein attends over every reference token on all 16 steps, and the library otherwise keeps a reference at 1–4 megapixels.
 *  ponytail: one global downscale, no face crop. Upgrade path is a subject crop when an edit needs more detail than the output grid. */
export function fitRefSize(w: number, h: number, maxW: number, maxH: number): [number, number] {
  const maxArea = Math.max(1, maxW * maxH)
  const scale = Math.min(1, Math.sqrt(maxArea / (w * h)))
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))]
}

/** Pixel size of an image file. null if sips cannot read it. */
export function refPixelSize(file: string): { w: number; h: number } | null {
  try {
    const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], {
      encoding: 'utf8',
    })
    const w = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1])
    const h = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1])
    if (!w || !h) return null
    return { w, h }
  } catch {
    return null
  }
}

function shrinkRefs(paths: string[], width: number, height: number) {
  // The first image is the person. Resampling it stretches the body and softens the photo.
  for (const file of paths.slice(1)) {
    const size = refPixelSize(file)
    if (!size) continue
    const long = Math.max(size.w, size.h)
    const cap = Math.min(448, Math.max(width, height))
    if (long <= cap) continue
    const scale = cap / long
    const w = Math.max(1, Math.round(size.w * scale))
    const h = Math.max(1, Math.round(size.h * scale))
    try {
      execFileSync('sips', ['-z', String(h), String(w), file], { stdio: 'ignore' })
    } catch {
      // A format sips cannot resample stays at the library's own cap.
    }
  }
}

function pythonBin(): string {
  return process.env.FLUX3_KLEIN_PYTHON?.trim() || DEFAULT_PY
}

export function kleinInstallError(): string | null {
  if (sidecarUrl()) return null
  if (existsSync(pythonBin()) && existsSync(SCRIPT)) return null
  return (
    '本機 FLUX 3 Klein 還沒裝好。設定 FLUX_KLEIN_URL（公開 tunnel 還要 FLUX_KLEIN_TOKEN），' +
    '或用 python3.13 建 venv 到 ~/.local/share/mxj-flux3-klein，' +
    '裝 torch、diffusers（git）、transformers、accelerate、pillow。'
  )
}

type Job = {
  prompt: string
  images: string[]
  width: number
  height: number
  /** Quality only. Speed skips the Qwen3.5 prompt upsampler. */
  upsample: boolean
}

type Reply = { ok: true; path: string } | { ok: false; error: string }

let worker: ChildProcessWithoutNullStreams | null = null
let boot: Promise<void> | null = null
let chain: Promise<unknown> = Promise.resolve()
let waiters: Array<(reply: Reply) => void> = []

export function isKleinServeCommand(command: string): boolean {
  return command.includes('flux3_klein.py') && command.includes('--serve')
}

function kleinServePids(): number[] {
  let raw = ''
  try {
    raw = execFileSync('pgrep', ['-fl', 'flux3_klein.py'], { encoding: 'utf8' })
  } catch {
    return []
  }
  const pids: number[] = []
  for (const line of raw.split('\n')) {
    const match = /^(\d+)\s+(.*)$/.exec(line.trim())
    if (!match || !isKleinServeCommand(match[2])) continue
    pids.push(Number(match[1]))
  }
  return pids
}

/** Vite reloads this module on server-file edits and forgets the old child.
 *  ponytail: pgrep by script name. A renamed entrypoint is invisible. Upgrade path is a pidfile lock. */
function reclaimKleinWorkers() {
  const pids = kleinServePids()
  if (!pids.length) return
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && kleinServePids().length) {
    try {
      execFileSync('sleep', ['0.05'])
    } catch {
      break
    }
  }
}

function startWorker(hfToken: string): Promise<void> {
  if (worker && worker.exitCode === null) return Promise.resolve()
  if (boot) return boot
  boot = new Promise((resolve, reject) => {
    reclaimKleinWorkers()
    const child = spawn(pythonBin(), [SCRIPT, '--serve'], {
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        TRANSFORMERS_VERBOSITY: 'error',
        PYTORCH_MPS_HIGH_WATERMARK_RATIO: '0.0',
        PYTORCH_ENABLE_MPS_FALLBACK: '1',
        ...(hfToken ? { HF_TOKEN: hfToken, HUGGING_FACE_HUB_TOKEN: hfToken } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let ready = false
    const fail = (err: Error) => {
      if (!ready) {
        boot = null
        reject(err)
      }
    }
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.startsWith('FLUX3_JSON:')) return
      let reply: Reply
      try {
        reply = JSON.parse(line.slice('FLUX3_JSON:'.length)) as Reply
      } catch {
        reply = { ok: false, error: line }
      }
      waiters.shift()?.(reply)
    })
    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString()
      process.stderr.write(`[flux3-klein] ${text}`)
      if (!ready && text.includes('FLUX3_READY')) {
        ready = true
        worker = child
        resolve()
      }
    })
    child.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))))
    process.on('exit', () => {
      if (child.exitCode === null && child.pid) {
        try {
          process.kill(child.pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
    })
    child.on('exit', (code) => {
      worker = null
      boot = null
      const err = new Error(`FLUX 3 Klein 進程結束（${code ?? 'signal'}）`)
      while (waiters.length) waiters.shift()?.({ ok: false, error: err.message })
      fail(err)
    })
  })
  return boot
}

function ask(job: Job): Promise<Reply> {
  const child = worker
  if (!child) return Promise.resolve({ ok: false, error: 'FLUX 3 Klein 還沒啟動' })
  return new Promise((resolve) => {
    waiters.push(resolve)
    child.stdin.write(`${JSON.stringify(job)}\n`)
  })
}

async function writeRefs(images: string[]): Promise<{ dir: string; paths: string[] }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'flux3-klein-'))
  const paths: string[] = []
  for (const [i, src] of images.entries()) {
    const m = /^data:([^;]+);base64,(.+)$/s.exec(src)
    if (!m) continue
    const ext = m[1].includes('png') ? 'png' : m[1].includes('webp') ? 'webp' : 'jpg'
    const file = path.join(dir, `ref-${i}.${ext}`)
    await writeFile(file, Buffer.from(m[2], 'base64'))
    paths.push(file)
  }
  return { dir, paths }
}

/** Load weights when the dev server starts so the first Generate is inference only.
 *  Skipped when FLUX_KLEIN_URL points at the shared sidecar. */
export function prewarmFlux3Klein(hfToken: string) {
  if (sidecarUrl()) {
    process.stderr.write(`[flux3-klein] using sidecar ${sidecarUrl()}\n`)
    return
  }
  if (kleinInstallError()) return
  void startWorker(hfToken).catch((err) => {
    process.stderr.write(`[flux3-klein] prewarm failed: ${err}\n`)
  })
}

export async function generateFlux3Klein(input: {
  prompt: string
  aspect_ratio?: string
  images?: string[]
  image?: string
  image_mode?: 'speed' | 'quality' | '720'
  hfToken?: string
}): Promise<{ src: string; mode: string; model: string; image_mode: string }> {
  const missing = kleinInstallError()
  if (missing) throw new Error(missing)

  if (sidecarUrl()) {
    return generateViaSidecar(input)
  }

  const refs = [...(input.images ?? []), input.image ?? ''].filter(Boolean)
  const mode = input.image_mode ?? 'speed'
  const { dir, paths } = await writeRefs(refs)
  const [width, height] = kleinSize(
    input.aspect_ratio,
    mode === '720' ? '720' : mode === 'quality',
    input.aspect_ratio === 'auto' && paths[0] ? refPixelSize(paths[0]) : null,
  )
  shrinkRefs(paths, width, height)

  try {
    await startWorker(input.hfToken ?? '')
    // ponytail: one in-flight job; a queue is enough until two GPUs exist
    const reply = (await (chain = chain.then(() =>
      ask({
        prompt: input.prompt,
        images: paths,
        width,
        height,
        // Edits were trained on the upsampler's caption. A raw "stay identical" prompt makes Klein redraw the photo.
        upsample: paths.length > 0 || mode === 'quality',
      }),
    ))) as Reply
    if (!reply.ok) throw new Error(reply.error)
    const buf = await readFile(reply.path)
    return {
      src: `data:image/png;base64,${buf.toString('base64')}`,
      mode: paths.length ? 'edit' : 'generate',
      model: 'flux-3-image-klein',
      image_mode: input.image_mode ?? 'speed',
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const isDirectRun = process.argv[1]?.includes('flux3Klein')
if (isDirectRun) {
  const ratio = kleinSize('auto', false, { w: 1000, h: 1500 })
  const err = Math.abs(ratio[0] / ratio[1] - 1000 / 1500)
  if (err > 0.004 || ratio[0] % 32 || ratio[1] % 32 || ratio[0] * ratio[1] > 1024 * 1024) {
    throw new Error(`ratio ${ratio} err ${err}`)
  }
  const fitted = fitRefSize(1000, 1500, 800, 800)
  const fitErr = Math.abs(fitted[0] / fitted[1] - 1000 / 1500)
  if (fitErr > 0.004) throw new Error(`fit ${fitted}`)
  const hd = kleinSize('auto', '720', { w: 1000, h: 1500 })
  if (hd[0] !== ratio[0] || hd[1] !== ratio[1]) throw new Error(`720 follows original ${hd} ${ratio}`)
  const wide = kleinSize('auto', '720', { w: 1500, h: 1000 })
  const wideErr = Math.abs(wide[0] / wide[1] - 1500 / 1000)
  if (wideErr > 0.004 || wide[0] !== ratio[1] || wide[1] !== ratio[0]) {
    throw new Error(`720 wide ${wide} err ${wideErr}`)
  }
  const small = kleinSize('auto', '720', { w: 400, h: 600 })
  if (Math.min(small[0], small[1]) >= 500) throw new Error(`small enlarged ${small}`)
  const native = kleinSize('auto', '720', { w: 864, h: 1152 })
  if (native[0] !== 864 || native[1] !== 1152) throw new Error(`native ${native}`)
  const portrait = kleinSize('9:16', '720', { w: 1080, h: 1920 })
  const portraitErr = Math.abs(portrait[0] / portrait[1] - 9 / 16)
  if (
    portraitErr > 0.01 ||
    portrait[0] % 32 ||
    portrait[1] % 32 ||
    portrait[0] * portrait[1] > 1024 * 1024
  ) {
    throw new Error(`9:16 ${portrait} err ${portraitErr}`)
  }
  const bare = kleinSize('9:16', '720', null)
  if (Math.abs(bare[0] / bare[1] - 9 / 16) > 0.01) throw new Error(`9:16 bare ${bare}`)
  console.log('klein aspect ok', ratio, fitted, hd, wide, small, native, portrait, bare)
}
