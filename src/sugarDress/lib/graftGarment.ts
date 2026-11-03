/**
 * Put the new garment on the original person and clear the old one.
 * The body is not stretched. New cloth is sampled with one scale around the body center.
 * Old lace and straps that the new garment does not cover become nearby original skin.
 * Face, hands, and hair stay.
 *
 * ponytail: leftover cloth is filled from the nearest original skin, not a flat recolor.
 * Upgrade path is a garment mask from the parser.
 */

import type { FaceRect } from './personGuide'
import { toDataUri } from './imageData'
import { loadImage } from './extractFrame'

type Box = { minX: number; minY: number; maxX: number; maxY: number }

function skinAt(r: number, g: number, b: number): boolean {
  const yy = 0.299 * r + 0.587 * g + 0.114 * b
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
  const chroma = Math.hypot(cb - 128, cr - 128)
  return cr > cb + 2 && chroma > 6 && chroma < 48 && yy > 75 && yy < 245
}

/** Bare skin, a tan, or a bright warm highlight. Lace and saturated cloth are not skin. */
function isSkin(r: number, g: number, b: number): boolean {
  if (r > 140 && b > g + 5 && r - g > 25) return false
  if (g < 80 && r - g > 30) return false
  if (skinAt(r, g, b)) return true
  if (Math.abs(r - g) < 14 && Math.abs(r - b) < 14) return false
  const yy = 0.299 * r + 0.587 * g + 0.114 * b
  return g > 80 && r > g && g + 35 >= b && yy > 90 && yy < 245 && r - g < 90 && r - b < 140
}

/** Cloth, including pink lace and white lace. Bare skin and a tan are not cloth. */
export function isFabric(r: number, g: number, b: number): boolean {
  return !isSkin(r, g, b)
}

function bounds(person: Uint8Array, w: number, h: number): Box | null {
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  let count = 0
  for (let i = 0; i < person.length; i++) {
    if (person[i] <= 16) continue
    count++
    const x = i % w
    const y = (i - x) / w
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (count < 40 || maxY <= minY) return null
  return { minX, minY, maxX, maxY }
}

function coversFace(x: number, y: number, face: FaceRect): boolean {
  const left = face.x - face.w * 0.4
  const right = face.x + face.w * 1.4
  const top = face.y - face.h * 0.85
  const bottom = face.y + face.h * 1.08
  return x >= left && x <= right && y >= top && y <= bottom
}

/**
 * Original photo, with the new cloth placed on that body.
 * Returns null only when the person boxes cannot be matched or almost no cloth was found.
 */
export function graftGarment(
  original: Uint8ClampedArray,
  generated: Uint8ClampedArray,
  srcMatte: Uint8Array,
  dstMatte: Uint8Array,
  w: number,
  h: number,
  face: FaceRect | null,
): Uint8ClampedArray | null {
  const srcBox = bounds(srcMatte, w, h)
  const dstBox = bounds(dstMatte, w, h)
  if (!srcBox || !dstBox) return null
  const srcH = srcBox.maxY - srcBox.minY
  const dstH = dstBox.maxY - dstBox.minY
  const srcW = Math.max(1, srcBox.maxX - srcBox.minX)
  const dstW = Math.max(1, dstBox.maxX - dstBox.minX)
  if (srcH < 8 || dstH < 8) return null
  const hRatio = dstH / srcH
  const wRatio = dstW / srcW
  if (hRatio < 0.45 || hRatio > 2.2 || wRatio < 0.45 || wRatio > 2.2) return null
  const scale = (hRatio + wRatio) / 2
  const srcCx = (srcBox.minX + srcBox.maxX) / 2
  const srcCy = (srcBox.minY + srcBox.maxY) / 2
  const dstCx = (dstBox.minX + dstBox.maxX) / 2
  const dstCy = (dstBox.minY + dstBox.maxY) / 2
  const out = new Uint8ClampedArray(original)
  const wrote = new Uint8Array(w * h)
  let copied = 0
  for (let y = srcBox.minY; y <= srcBox.maxY; y++) {
    for (let x = srcBox.minX; x <= srcBox.maxX; x++) {
      if (srcMatte[y * w + x] <= 16) continue
      if (face && coversFace(x, y, face)) continue
      const p = (y * w + x) * 4
      const hand = y > srcBox.minY + srcH * 0.62 && Math.abs(x - srcCx) > srcW * 0.28
      if (hand && isSkin(original[p], original[p + 1], original[p + 2])) continue
      const sx = Math.round(dstCx + (x - srcCx) * scale)
      const sy = Math.round(dstCy + (y - srcCy) * scale)
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue
      if (dstMatte[sy * w + sx] <= 16) continue
      const g = (sy * w + sx) * 4
      if (isSkin(generated[g], generated[g + 1], generated[g + 2])) continue
      out[p] = generated[g]
      out[p + 1] = generated[g + 1]
      out[p + 2] = generated[g + 2]
      out[p + 3] = 255
      wrote[y * w + x] = 1
      copied++
    }
  }
  if (copied < 40) return null
  clearOldCloth(out, original, srcMatte, wrote, w, h, srcBox, face)
  return out
}

/** Old garment pixels the new cloth did not cover, filled from adjacent original skin. */
function clearOldCloth(
  out: Uint8ClampedArray,
  original: Uint8ClampedArray,
  matte: Uint8Array,
  wrote: Uint8Array,
  w: number,
  h: number,
  box: Box,
  face: FaceRect | null,
) {
  const n = w * h
  const hole = new Uint8Array(n)
  const headCut = box.minY + (box.maxY - box.minY) * 0.28
  for (let y = box.minY; y <= box.maxY; y++) {
    for (let x = box.minX; x <= box.maxX; x++) {
      const i = y * w + x
      if (matte[i] <= 16 || wrote[i]) continue
      if (face && coversFace(x, y, face)) continue
      const p = i * 4
      const r = original[p]
      const g = original[p + 1]
      const b = original[p + 2]
      if (isSkin(r, g, b)) continue
      const yy = 0.299 * r + 0.587 * g + 0.114 * b
      if (y < headCut && yy < 85 && Math.abs(r - g) < 30) continue
      hole[i] = 1
    }
  }
  const filled = new Uint8Array(n)
  let frontier: number[] = []
  for (let i = 0; i < n; i++) {
    if (!hole[i]) continue
    const x = i % w
    const y = (i - x) / w
    const near = [x > 0 ? i - 1 : -1, x + 1 < w ? i + 1 : -1, y > 0 ? i - w : -1, y + 1 < h ? i + w : -1]
    for (const j of near) {
      if (j < 0 || hole[j]) continue
      const p = j * 4
      if (!isSkin(original[p], original[p + 1], original[p + 2])) continue
      frontier.push(i)
      break
    }
  }
  while (frontier.length) {
    const next: number[] = []
    for (const i of frontier) {
      if (filled[i]) continue
      const x = i % w
      const y = (i - x) / w
      const near = [x > 0 ? i - 1 : -1, x + 1 < w ? i + 1 : -1, y > 0 ? i - w : -1, y + 1 < h ? i + w : -1]
      let sr = 0
      let sg = 0
      let sb = 0
      let count = 0
      for (const j of near) {
        if (j < 0) continue
        const p = j * 4
        const fromSkin = !hole[j] && isSkin(original[p], original[p + 1], original[p + 2])
        if (!fromSkin && !filled[j]) continue
        sr += fromSkin ? original[p] : out[p]
        sg += fromSkin ? original[p + 1] : out[p + 1]
        sb += fromSkin ? original[p + 2] : out[p + 2]
        count++
      }
      if (!count) continue
      const p = i * 4
      out[p] = Math.round(sr / count)
      out[p + 1] = Math.round(sg / count)
      out[p + 2] = Math.round(sb / count)
      out[p + 3] = 255
      filled[i] = 1
      for (const j of near) {
        if (j >= 0 && hole[j] && !filled[j]) next.push(j)
      }
    }
    frontier = next
  }
}

function scaleAlpha(alpha: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  if (sw === dw && sh === dh) return alpha
  const out = new Uint8Array(dw * dh)
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.round((y * (sh - 1)) / Math.max(1, dh - 1)))
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.round((x * (sw - 1)) / Math.max(1, dw - 1)))
      out[y * dw + x] = alpha[sy * sw + sx]
    }
  }
  return out
}

async function matte(src: string, img: HTMLImageElement): Promise<Uint8Array | null> {
  const res = await fetch('/api/extract-person', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      src: await toDataUri(src),
      x: 0,
      y: 0,
      w: img.naturalWidth,
      h: img.naturalHeight,
      method: 'modnet',
    }),
  })
  const data = (await res.json()) as { src?: string }
  if (!res.ok || !data.src) return null
  const cut = await loadImage(data.src)
  if (cut.naturalWidth !== img.naturalWidth || cut.naturalHeight !== img.naturalHeight) return null
  const canvas = document.createElement('canvas')
  canvas.width = cut.naturalWidth
  canvas.height = cut.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(cut, 0, 0)
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const alpha = new Uint8Array(canvas.width * canvas.height)
  for (let i = 0; i < alpha.length; i++) alpha[i] = frame.data[i * 4 + 3]
  return alpha
}

/** Original person, with only the new clothes taken from the generated image. */
export async function graftClothes(
  originalSrc: string,
  generatedSrc: string,
  face: FaceRect | null,
): Promise<string | null> {
  const [original, generated] = await Promise.all([loadImage(originalSrc), loadImage(generatedSrc)])
  const [srcMatte, dstMatte] = await Promise.all([matte(originalSrc, original), matte(generatedSrc, generated)])
  if (!srcMatte || !dstMatte) return null
  const w = original.naturalWidth
  const h = original.naturalHeight
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(original, 0, 0, w, h)
  const src = ctx.getImageData(0, 0, w, h)
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(generated, 0, 0, w, h)
  const gen = ctx.getImageData(0, 0, w, h)
  const grafted = graftGarment(
    src.data,
    gen.data,
    srcMatte,
    scaleAlpha(dstMatte, generated.naturalWidth, generated.naturalHeight, w, h),
    w,
    h,
    face,
  )
  if (!grafted) return null
  src.data.set(grafted)
  ctx.putImageData(src, 0, 0)
  return canvas.toDataURL('image/png')
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv
if (argv?.[1]?.includes('graftGarment')) {
  const w = 24
  const h = 40
  const matteBytes = new Uint8Array(w * h)
  const fill = (x0: number, x1: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) matteBytes[y * w + x] = 255
  }
  fill(9, 14, 2, 8)
  fill(7, 16, 9, 36)
  fill(2, 5, 12, 30)
  const paint = (r: number, g: number, b: number, x0: number, x1: number, y0: number, y1: number, into: Uint8ClampedArray) => {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const p = (y * w + x) * 4
        into[p] = r
        into[p + 1] = g
        into[p + 2] = b
        into[p + 3] = 255
      }
    }
  }
  const original = new Uint8ClampedArray(w * h * 4)
  const generated = new Uint8ClampedArray(w * h * 4)
  paint(200, 160, 140, 0, w - 1, 0, h - 1, original)
  paint(200, 160, 140, 0, w - 1, 0, h - 1, generated)
  paint(180, 30, 40, 7, 16, 10, 13, original)
  paint(180, 30, 40, 8, 8, 24, 28, original)
  paint(230, 170, 180, 7, 16, 10, 13, generated)
  paint(20, 20, 22, 2, 5, 12, 26, generated)
  paint(230, 150, 110, 7, 16, 16, 22, generated)
  paint(10, 10, 10, 10, 13, 3, 7, generated)
  const face = { x: 10, y: 3, w: 4, h: 5 }
  if (!isFabric(20, 20, 22) || !isFabric(230, 170, 180) || !isFabric(250, 248, 245) || !isFabric(120, 40, 55)) {
    throw new Error('cloth missed')
  }
  if (isFabric(200, 160, 140) || isFabric(230, 150, 110) || isFabric(245, 220, 200)) throw new Error('skin marked cloth')
  const out = graftGarment(original, generated, matteBytes, matteBytes, w, h, face)
  if (!out) throw new Error('no graft')
  const at = (buf: Uint8ClampedArray, x: number, y: number) => buf[(y * w + x) * 4]
  if (at(out, 11, 5) !== 200) throw new Error('face moved')
  if (at(out, 10, 18) !== 200) throw new Error('belly moved')
  if (at(out, 3, 18) !== 20) throw new Error('sleeve missed')
  if (at(out, 3, 29) !== 200) throw new Error('hand moved')
  if (at(out, 10, 11) !== 230) throw new Error('lace missed')
  if (at(out, 8, 26) === 180 || Math.abs(at(out, 8, 26) - 200) > 15) throw new Error('old strap stayed')
  const zoomed = new Uint8Array(w * h)
  zoomed.fill(255)
  const reframed = graftGarment(original, generated, matteBytes, zoomed, w, h, face)
  if (reframed && (at(reframed, 11, 5) !== 200 || at(reframed, 10, 18) !== 200)) throw new Error('body was stretched')
  console.log('graft-garment ok')
}
