import type { Box } from './resizeItem'

/** Largest frame of this aspect that sits inside the photo, slightly inset. */
export function frameForAspect(imgW: number, imgH: number, rw: number, rh: number): Box {
  const aspect = rw / rh
  let width = imgW
  let height = width / aspect
  if (height > imgH) {
    height = imgH
    width = height * aspect
  }
  width *= 0.86
  height *= 0.86
  return {
    x: (imgW - width) / 2,
    y: (imgH - height) / 2,
    width,
    height,
  }
}

const ASPECTS: [string, number][] = [
  ['1:1', 1],
  ['16:9', 16 / 9],
  ['9:16', 9 / 16],
  ['4:3', 4 / 3],
  ['3:4', 3 / 4],
  ['3:2', 3 / 2],
  ['2:3', 2 / 3],
]

/** Nearest generate preset for a crop. The composite still uses the exact pixels. */
export function nearestAspect(w: number, h: number): string {
  const ratio = w / Math.max(1, h)
  let best = ASPECTS[0][0]
  let err = Infinity
  for (const [label, value] of ASPECTS) {
    const d = Math.abs(Math.log(value / ratio))
    if (d < err) {
      err = d
      best = label
    }
  }
  return best
}

/** Keep the frame inside the photo without changing its aspect. */
export function clampFrame(frame: Box, imgW: number, imgH: number): Box {
  let { x, y, width, height } = frame
  if (width > imgW) {
    const scale = imgW / width
    width = imgW
    height *= scale
  }
  if (height > imgH) {
    const scale = imgH / height
    height *= scale
    width *= scale
  }
  x = Math.min(Math.max(0, x), Math.max(0, imgW - width))
  y = Math.min(Math.max(0, y), Math.max(0, imgH - height))
  return { x, y, width, height }
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.src = src
  return img.decode().then(() => img)
}

/** True when the photo has no see-through pixels, so a new background cannot show through. */
export async function isOpaque(src: string): Promise<boolean> {
  const img = await loadImage(src)
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return true
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return false
  }
  return true
}

/** The 9:16 window the user framed, in the photo's own pixels. */
export async function cropImage(
  src: string,
  frame: { x: number; y: number; w: number; h: number },
): Promise<string> {
  const img = await loadImage(src)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(frame.w))
  canvas.height = Math.max(1, Math.round(frame.h))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not crop')
  ctx.drawImage(img, frame.x, frame.y, frame.w, frame.h, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.92)
}

/** White plate so the model does not treat transparency as black. The cutout alpha is kept separately. */
export async function flattenOnWhite(src: string): Promise<string> {
  const img = await loadImage(src)
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not prepare the person photo')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0)
  return canvas.toDataURL('image/png')
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv
if (argv?.[1]?.includes('extractFrame')) {
  const frame = frameForAspect(1000, 2000, 9, 16)
  const ratio = frame.width / frame.height
  if (Math.abs(ratio - 9 / 16) > 0.002) throw new Error(`ratio ${ratio}`)
  if (frame.x < 0 || frame.y < 0 || frame.x + frame.width > 1000 || frame.y + frame.height > 2000) {
    throw new Error('frame left the photo')
  }
  const shoved = clampFrame({ x: 900, y: -20, width: 200, height: 400 }, 1000, 500)
  if (shoved.x < 0 || shoved.y < 0 || shoved.x + shoved.width > 1000 || shoved.y + shoved.height > 500) {
    throw new Error('clamp failed ' + JSON.stringify(shoved))
  }
  if (Math.abs(shoved.width / shoved.height - 0.5) > 0.002) throw new Error('clamp changed aspect')
  if (nearestAspect(9, 16) !== '9:16' || nearestAspect(1000, 1000) !== '1:1') {
    throw new Error('nearest aspect')
  }
  console.log('extractFrame ok')
}
