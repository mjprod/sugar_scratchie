import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'
import { loadEnv } from 'vite'
import { seedanceGenerateImage } from './seedanceApi.ts'
import {
  arkModelForImageProvider,
  isGptImageProvider,
  keysFromEnv,
  parseImageProvider,
  requireImageKey,
  type ProviderKeys,
} from './genProvider.ts'
import {
  openaiGenerateImage,
  resolveGptImageModel,
} from './openaiImageApi.ts'
import { generateFlux3Klein, prewarmFlux3Klein } from './flux3Klein.ts'
import { generateFlux18 } from './flux18.ts'
import { matchReferenceColour } from './gradeMatch.ts'
import { matchReferenceBody } from './bodyMatch.ts'
import { lockReferenceSkin } from './skinLock.ts'
import { garmentSample, posePlate } from './garmentSample.ts'
import { compositeBackground, extractPerson, keepBody } from './detailCut.ts'
import { extractClothes } from './extractClothes.ts'
import { faceOval } from './faceLandmarker.ts'
import { fashnTryOn, type FashnCategory, type FashnPhoto } from './fashnTryon.ts'
import { leffaTryOn } from './outfitEngines.ts'
import { saveGeneratedImage } from './saveGenerated.ts'
import { handleGenerateVideo } from './videoGenerate.ts'

type Body = {
  prompt?: string
  aspect_ratio?: string
  /** Single data URI / URL — mutually exclusive with `images` */
  image?: string
  /** Up to 3 reference images for multi-image edit */
  images?: string[]
  /** Client uses speed|720. Grok also accepts legacy `quality` (=720). */
  image_mode?: 'speed' | 'quality' | '720'
  /** Quality model only: 1k | 2k */
  resolution?: '1k' | '2k'
  /** grok | gpt-image-2.5 | gpt-image-2 | seedream-5-lite | seedream-5-pro | flux-3-klein | flux-18 */
  provider?: string
  /** Data URI of a colour-grade reference; applied after generation */
  color_match?: string
  /** Data URI of a body reference; person's box is aligned after generation */
  body_match?: string
  /** Index of the clothing photo inside `images`. Its body is stripped before the model sees it. */
  clothing_index?: number
  /** Pose photo inside `images`. Replaced with a gray silhouette before generation. */
  pose_index?: number
  /** Standalone colour grade. Not a generation. */
  src?: string
  reference?: string
  x?: number
  y?: number
  w?: number
  h?: number
  cutout?: string
  generated?: string
  person?: string
  background?: string
  width?: number
  height?: number
  /** Detail extract: corridor | modnet. Missing means CorridorKey. */
  method?: string
  /** FASHN try-on garment image. */
  garment?: string
  /** tops | bottoms | one-pieces */
  category?: string
  /** model | flat-lay */
  photo_type?: string
}

function resolveImageModel(mode: Body['image_mode']): string {
  // Canvas UI sends '720' for the high tier; older clients used 'quality'.
  return mode === 'quality' || mode === '720'
    ? 'grok-imagine-image-quality'
    : 'grok-imagine-image'
}

type XaiImageResponse = {
  error?: { message?: string } | string
  data?: Array<{ b64_json?: string; url?: string }>
}

async function readJson(req: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

function detectDataUriMime(b64: string): string {
  if (b64.startsWith('/9j/')) return 'image/jpeg'
  if (b64.startsWith('iVBOR')) return 'image/png'
  if (b64.startsWith('UklGR')) return 'image/webp'
  return 'image/jpeg'
}

function extractImageSrc(data: XaiImageResponse): string | null {
  const image = data.data?.[0]
  if (!image) return null
  if (image.b64_json) {
    const mime = detectDataUriMime(image.b64_json)
    return `data:${mime};base64,${image.b64_json}`
  }
  if (image.url) return image.url
  return null
}

function errorMessage(data: XaiImageResponse, status: number): string {
  if (typeof data.error === 'string') return data.error
  return data.error?.message || `xAI error (${status})`
}

function asImageUrl(url: string) {
  return { url }
}

async function handleGrokImage(body: Body, apiKey: string) {
  const prompt = body.prompt!.trim()
  const multi = (body.images ?? [])
    .map((u) => u?.trim())
    .filter((u): u is string => Boolean(u))
    .slice(0, 3)
  const single = body.image?.trim()
  const isEdit = multi.length > 0 || Boolean(single)
  const endpoint = isEdit
    ? 'https://api.x.ai/v1/images/edits'
    : 'https://api.x.ai/v1/images/generations'
  const model = resolveImageModel(body.image_mode)
  const isQuality = body.image_mode === 'quality' || body.image_mode === '720'
  const qualityResolution =
    body.resolution === '1k' || body.resolution === '2k'
      ? body.resolution
      : '2k'

  let payload: Record<string, unknown>

  if (multi.length > 1) {
    payload = {
      model,
      prompt,
      images: multi.map(asImageUrl),
      aspect_ratio: body.aspect_ratio ?? 'auto',
      response_format: 'b64_json',
    }
  } else if (multi.length === 1 || single) {
    payload = {
      model,
      prompt,
      image: asImageUrl(multi[0] ?? single!),
      response_format: 'b64_json',
    }
    if (body.aspect_ratio && body.aspect_ratio !== 'auto') {
      payload.aspect_ratio = body.aspect_ratio
    }
  } else {
    payload = {
      model,
      prompt,
      n: 1,
      aspect_ratio: body.aspect_ratio ?? '1:1',
      response_format: 'b64_json',
    }
  }

  if (isQuality) {
    payload.resolution = qualityResolution
  }

  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  })

  const data = (await upstream.json()) as XaiImageResponse
  if (!upstream.ok) {
    throw Object.assign(new Error(errorMessage(data, upstream.status)), {
      status: upstream.status,
    })
  }

  const src = extractImageSrc(data)
  if (!src) throw new Error('No image returned from Grok Imagine')

  return {
    src,
    mode: isEdit ? 'edit' : 'generate',
    model,
    image_mode: body.image_mode ?? 'speed',
    ...(isQuality ? { resolution: qualityResolution } : {}),
  }
}

async function handleGenerate(
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
    const body = await readJson(req)
    const rawPrompt = body.prompt?.trim()
    if (!rawPrompt) {
      sendJson(res, 400, { error: 'Prompt is required' })
      return
    }
    const provider = parseImageProvider(body.provider)
    // Soften live/真人-ish prompts so relays with person policies don't refuse.
    // Flux 18+ is uncensored local — don't dilute photoreal / 18+ prompts.
    const personGuard =
      'Fictional stylized characters only for a commercial storyboard — not real celebrities, not photoreal identifiable real people.'
    const prompt =
      provider !== 'flux-18' &&
      /真人|celebrity|real person|photoreal/i.test(rawPrompt) &&
      !rawPrompt.includes('Fictional stylized')
        ? `${rawPrompt}\n${personGuard}`
        : rawPrompt
    const missing = requireImageKey(provider, keys)
    if (missing) {
      sendJson(res, 500, { error: missing })
      return
    }

    const multi = (body.images ?? [])
      .map((u) => u?.trim())
      .filter((u): u is string => Boolean(u))
      .slice(0, 3)
    const clothingIndex = body.clothing_index
    if (
      typeof clothingIndex === 'number' &&
      clothingIndex >= 1 &&
      clothingIndex < multi.length
    ) {
      try {
        multi[clothingIndex] = await garmentSample(multi[clothingIndex])
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[garment] sample failed, keeping photo: ${message}\n`)
      }
    }
    const poseIndex = body.pose_index
    if (
      typeof poseIndex === 'number' &&
      poseIndex >= 1 &&
      poseIndex < multi.length &&
      poseIndex !== clothingIndex
    ) {
      try {
        multi[poseIndex] = await posePlate(multi[poseIndex])
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[pose] plate failed, keeping photo: ${message}\n`)
      }
    }
    const single = body.image?.trim()
    const isEdit = multi.length > 0 || Boolean(single)

    let result: {
      src: string
      mode: string
      model: string
      image_mode: string
      resolution?: string
    }

    const arkModel = arkModelForImageProvider(provider, keys)
    if (arkModel && keys.ark) {
      const out = await seedanceGenerateImage(keys, {
        prompt,
        aspect_ratio: body.aspect_ratio,
        images: multi,
        image: single,
        image_mode: body.image_mode,
        model: arkModel,
      })
      result = {
        src: out.src,
        mode: isEdit ? 'edit' : 'generate',
        model: out.model,
        image_mode: body.image_mode ?? 'speed',
      }
    } else if (
      (provider === 'seedream-5-lite' || provider === 'seedream-5-pro') &&
      keys.openai
    ) {
      // APIMart hosts Seedream when Ark key is absent
      const model =
        provider === 'seedream-5-pro'
          ? 'seedream-5-0-pro'
          : 'seedream-5-0-lite'
      const out = await openaiGenerateImage(keys, {
        prompt,
        aspect_ratio: body.aspect_ratio,
        images: multi,
        image: single,
        image_mode: body.image_mode,
        model,
      })
      result = {
        src: out.src,
        mode: isEdit ? 'edit' : 'generate',
        model: out.model,
        image_mode: body.image_mode ?? 'speed',
      }
    } else if (provider === 'flux-3-klein') {
      const out = await generateFlux3Klein({
        prompt,
        aspect_ratio: body.aspect_ratio,
        images: multi,
        image: single,
        image_mode: body.image_mode,
        hfToken: keys.hfToken,
      })
      result = {
        src: out.src,
        mode: out.mode,
        model: out.model,
        image_mode: out.image_mode,
      }
    } else if (provider === 'flux-18') {
      const out = await generateFlux18({
        prompt,
        aspect_ratio: body.aspect_ratio,
        images: multi,
        image: single,
        image_mode: body.image_mode,
      })
      result = {
        src: out.src,
        mode: out.mode,
        model: out.model,
        image_mode: out.image_mode,
      }
    } else if (isGptImageProvider(provider)) {
      const model = resolveGptImageModel(provider, body.image_mode, keys)
      const out = await openaiGenerateImage(keys, {
        prompt,
        aspect_ratio: body.aspect_ratio,
        images: multi,
        image: single,
        image_mode: body.image_mode,
        model,
      })
      result = {
        src: out.src,
        mode: isEdit ? 'edit' : 'generate',
        model: out.model,
        image_mode: body.image_mode ?? 'speed',
      }
    } else if (arkModel) {
      sendJson(res, 500, {
        error:
          'Missing ARK_API_KEY (or use APIMART_API_KEY for Seedream via APIMart).',
      })
      return
    } else {
      // Same prepared prompt + multi as other providers (garment sample, pose plate, person guard).
      result = await handleGrokImage({ ...body, prompt, images: multi }, keys.xai)
    }

    const bodyMatch = body.body_match?.trim()
    if (bodyMatch) {
      try {
        result.src = await matchReferenceBody(result.src, bodyMatch)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[body] match failed, keeping original: ${message}\n`)
      }
    }

    const colorMatch = body.color_match?.trim()
    if (colorMatch) {
      try {
        result.src = await matchReferenceColour(result.src, colorMatch)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[grade] match failed, keeping ungraded: ${message}\n`)
      }
    }

    const person = multi[0]
    if (person) {
      try {
        result.src = await lockReferenceSkin(result.src, person)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[skin] lock failed, keeping generated: ${message}\n`)
      }
    }

    const savedPath = await saveGeneratedImage(result.src, {
      mode: result.mode,
      model: result.model,
    })

    sendJson(res, 200, {
      ...result,
      provider,
      ...(savedPath ? { savedPath } : {}),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Generation failed'
    const status =
      err && typeof err === 'object' && 'status' in err
        ? Number((err as { status: number }).status) || 500
        : 500
    sendJson(res, status, { error: message })
  }
}

async function handleMatchColour(req: IncomingMessage, res: ServerResponse) {
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
    const body = await readJson(req)
    const src = body.src?.trim()
    const reference = body.reference?.trim()
    if (!src || !reference) {
      sendJson(res, 400, { error: '需要圖片和色澤參考' })
      return
    }
    const graded = await matchReferenceColour(src, reference)
    sendJson(res, 200, { src: graded })
  } catch (err) {
    const message = err instanceof Error ? err.message : '對色失敗'
    sendJson(res, 500, { error: message })
  }
}

async function handleExtractClothes(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' })
    return
  }
  try {
    const body = await readJson(req)
    const src = body.src?.trim()
    if (!src) {
      sendJson(res, 400, { error: '需要原圖' })
      return
    }
    const cut = await extractClothes(src)
    sendJson(res, 200, { src: cut })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : '抽出衣服失敗' })
  }
}

async function handleExtractPerson(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' })
    return
  }
  try {
    const body = await readJson(req)
    const src = body.src?.trim()
    if (!src || body.w == null || body.h == null || body.x == null || body.y == null) {
      sendJson(res, 400, { error: '需要原圖和框' })
      return
    }
    const method = body.method === 'modnet' ? 'modnet' : 'corridor'
    const cut = await extractPerson(src, { x: body.x, y: body.y, w: body.w, h: body.h }, method)
    sendJson(res, 200, { src: cut })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : '抽出失敗' })
  }
}

async function handleFaceOval(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' })
    return
  }
  try {
    const body = await readJson(req)
    const src = body.src?.trim()
    if (!src) {
      sendJson(res, 400, { error: '需要原圖' })
      return
    }
    sendJson(res, 200, { points: await faceOval(src) })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : '臉部輪廓失敗' })
  }
}

async function handleKeepBody(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' })
    return
  }
  try {
    const body = await readJson(req)
    const cutout = body.cutout?.trim()
    const generated = body.generated?.trim()
    if (!cutout || !generated) {
      sendJson(res, 400, { error: '需要人物和生成圖' })
      return
    }
    sendJson(res, 200, { src: await keepBody(cutout, generated) })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : '保留身材失敗' })
  }
}

async function handleCompositeBackground(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' })
    return
  }
  try {
    const body = await readJson(req)
    const person = body.person?.trim()
    const background = body.background?.trim()
    if (!person || !background || !body.width || !body.height) {
      sendJson(res, 400, { error: '需要人物、背景和尺寸' })
      return
    }
    sendJson(res, 200, {
      src: await compositeBackground(person, background, body.width, body.height),
    })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : '套背景失敗' })
  }
}

function fashnCategory(value: string | undefined): FashnCategory | null {
  if (value === 'tops' || value === 'bottoms' || value === 'one-pieces') return value
  return null
}

function fashnPhoto(value: string | undefined): FashnPhoto | null {
  if (value === 'model' || value === 'flat-lay') return value
  return null
}

async function handleFashnTryOn(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' })
    return
  }
  try {
    const body = await readJson(req)
    const person = body.person?.trim()
    const garment = body.garment?.trim()
    const category = fashnCategory(body.category)
    const photo = fashnPhoto(body.photo_type)
    if (!person || !garment || !category || !photo) {
      sendJson(res, 400, { error: '需要原圖、衣服圖和衣服種類' })
      return
    }
    const src = await fashnTryOn(person, garment, category, photo)
    const savedPath = await saveGeneratedImage(src, { mode: 'fashn', model: 'fashn-vton-1.5' })
    sendJson(res, 200, { src, ...(savedPath ? { savedPath } : {}) })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : '換裝失敗' })
  }
}

async function handleLeffaTryOn(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' })
    return
  }
  try {
    const body = await readJson(req)
    const person = body.person?.trim()
    const garment = body.garment?.trim()
    const category = fashnCategory(body.category)
    if (!person || !garment || !category) {
      sendJson(res, 400, { error: '需要原圖、衣服圖和衣服種類' })
      return
    }
    const src = await leffaTryOn(person, garment, category)
    const savedPath = await saveGeneratedImage(src, { mode: 'leffa', model: 'leffa' })
    sendJson(res, 200, { src, ...(savedPath ? { savedPath } : {}) })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : '換裝失敗' })
  }
}

function attach(server: ViteDevServer | PreviewServer, keys: ProviderKeys) {
  // /dress-api/* stays on Vite. Do not use /api/* — that proxies to FastAPI.
  server.middlewares.use('/dress-api/fashn-tryon', (req, res) => {
    void handleFashnTryOn(req, res)
  })
  server.middlewares.use('/dress-api/leffa-tryon', (req, res) => {
    void handleLeffaTryOn(req, res)
  })
  server.middlewares.use('/dress-api/extract-person', (req, res) => {
    void handleExtractPerson(req, res)
  })
  server.middlewares.use('/dress-api/extract-clothes', (req, res) => {
    void handleExtractClothes(req, res)
  })
  server.middlewares.use('/dress-api/face-oval', (req, res) => {
    void handleFaceOval(req, res)
  })
  server.middlewares.use('/dress-api/keep-body', (req, res) => {
    void handleKeepBody(req, res)
  })
  server.middlewares.use('/dress-api/composite-background', (req, res) => {
    void handleCompositeBackground(req, res)
  })
  server.middlewares.use('/dress-api/match-colour', (req, res) => {
    void handleMatchColour(req, res)
  })
  server.middlewares.use('/dress-api/generate-image', (req, res) => {
    void handleGenerate(req, res, keys)
  })
  server.middlewares.use('/dress-api/generate-video', (req, res) => {
    void handleGenerateVideo(req, res, keys)
  })
}

function readProviderKeys(mode: string, envDir: string): ProviderKeys {
  const env = loadEnv(mode, envDir, '')
  // File values win when the process env slot is empty, so a key in sugar-dress/.env is used.
  const merged: Record<string, string> = { ...process.env } as Record<string, string>
  for (const [key, value] of Object.entries(env)) {
    if (value) merged[key] = value
  }
  // flux3Klein.ts reads these from process.env for the shared Klein sidecar.
  for (const key of ['FLUX_KLEIN_URL', 'FLUX_KLEIN_TOKEN'] as const) {
    if (merged[key]) process.env[key] = merged[key]
  }
  return keysFromEnv(merged)
}

export function xaiImagineApi(): Plugin {
  let keys: ProviderKeys = keysFromEnv({})

  return {
    name: 'xai-imagine-api',
    configResolved(config) {
      keys = readProviderKeys(config.mode, config.envDir || process.cwd())
    },
    configureServer(server) {
      keys = readProviderKeys(server.config.mode, server.config.envDir || process.cwd())
      attach(server, keys)
      prewarmFlux3Klein(keys.hfToken)
    },
    configurePreviewServer(server) {
      keys = readProviderKeys(server.config.mode, server.config.envDir || process.cwd())
      attach(server, keys)
    },
  }
}
