/**
 * Stretch a generated outfit across the original bust.
 * The new clothes move outward. The original skin is not pasted back.
 *
 * ponytail: the chest is widened against the waist, capped at 1.7.
 * Sleeves are not the chest. Upgrade path is a real cloth simulation.
 */

import { headLimit } from './undressLock'
import { toDataUri } from './imageData'
import { loadImage } from './extractFrame'
import { dressFetch } from './dressApi'

const MIN_SCALE = 1.06
const MAX_SCALE = 1.7

type Box = { minX: number; minY: number; maxX: number; maxY: number }

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
  if (count < 80 || maxY <= minY) return null
  return { minX, minY, maxX, maxY }
}

/** The torso through the row center. A separated arm is not included. */
export function torsoChord(
  person: Uint8Array,
  w: number,
  y: number,
  minX: number,
  maxX: number,
): { left: number; right: number } | null {
  if (y < 0 || y * w >= person.length) return null
  const cx = (minX + maxX) >> 1
  const row = y * w
  let x = cx
  if (person[row + x] <= 16) {
    const limit = Math.max(4, Math.floor((maxX - minX) * 0.18))
    let found = -1
    for (let d = 1; d <= limit; d++) {
      if (cx - d >= 0 && person[row + cx - d] > 16) {
        found = cx - d
        break
      }
      if (cx + d < w && person[row + cx + d] > 16) {
        found = cx + d
        break
      }
    }
    if (found < 0) return null
    x = found
  }
  let left = x
  let right = x
  while (left > 0 && person[row + left - 1] > 16) left--
  while (right < w - 1 && person[row + right + 1] > 16) right++
  if (right - left < 4) return null
  return { left, right }
}

function bandWidth(
  person: Uint8Array,
  w: number,
  box: Box,
  y0: number,
  y1: number,
  pick: 'max' | 'median' | 'min',
): number | null {
  const widths: number[] = []
  const a = Math.max(box.minY, Math.floor(y0))
  const b = Math.min(box.maxY, Math.ceil(y1))
  for (let y = a; y <= b; y++) {
    const chord = torsoChord(person, w, y, box.minX, box.maxX)
    if (chord) widths.push(chord.right - chord.left + 1)
  }
  if (!widths.length) return null
  if (pick === 'max') return Math.max(...widths)
  if (pick === 'min') return Math.min(...widths)
  widths.sort((p, q) => p - q)
  return widths[widths.length >> 1]
}

/** How much wider the bust is than the waist. Sleeves are not part of this. */
export function bustRatio(person: Uint8Array, w: number, h: number): number | null {
  const box = bounds(person, w, h)
  if (!box) return null
  const head = headLimit(person, w, box.minX, box.maxX, box.minY, box.maxY)
  const bodyH = box.maxY - box.minY + 1
  const waist = bandWidth(person, w, box, head + bodyH * 0.3, head + bodyH * 0.58, 'min')
  const bust = bandWidth(person, w, box, head + bodyH * 0.08, head + bodyH * 0.24, 'max')
  if (waist == null || bust == null || waist < 8) return null
  return bust / waist
}

/** Original bust/waist. The generated sleeves do not reduce it. 1 means leave it. */
export function bustScale(
  src: Uint8Array,
  sw: number,
  sh: number,
  _dst: Uint8Array,
  _dw: number,
  _dh: number,
): number {
  const shape = bustRatio(src, sw, sh)
  if (shape == null || shape < MIN_SCALE) return 1
  return Math.min(shape, MAX_SCALE)
}

function weight(y: number, head: number, bodyH: number): number {
  const bust0 = head + bodyH * 0.06
  const bust1 = head + bodyH * 0.2
  const waist = head + bodyH * 0.34
  const smooth = (t: number) => {
    const c = Math.min(1, Math.max(0, t))
    return c * c * (3 - 2 * c)
  }
  if (y <= head || y >= waist) return 0
  if (y < bust0) return smooth((y - head) / (bust0 - head))
  if (y <= bust1) return 1
  return smooth((waist - y) / (waist - bust1))
}

function sample(rgba: Uint8ClampedArray, w: number, x: number, y: number): [number, number, number, number] {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(x)))
  const x1 = Math.max(0, Math.min(w - 1, x0 + 1))
  const t = Math.min(1, Math.max(0, x - x0))
  const p0 = (y * w + x0) * 4
  const p1 = (y * w + x1) * 4
  return [
    rgba[p0] * (1 - t) + rgba[p1] * t,
    rgba[p0 + 1] * (1 - t) + rgba[p1 + 1] * t,
    rgba[p0 + 2] * (1 - t) + rgba[p1 + 2] * t,
    rgba[p0 + 3] * (1 - t) + rgba[p1 + 3] * t,
  ]
}

/** Widen the chest of `rgba`. Pixels outside the chest band stay. */
export function widenChest(
  rgba: Uint8ClampedArray,
  person: Uint8Array,
  w: number,
  h: number,
  scale: number,
): Uint8ClampedArray {
  if (scale < MIN_SCALE) return rgba
  const box = bounds(person, w, h)
  if (!box) return rgba
  const head = headLimit(person, w, box.minX, box.maxX, box.minY, box.maxY)
  const bodyH = box.maxY - box.minY + 1
  let waistChord: { left: number; right: number } | null = null
  const pinch0 = Math.floor(head + bodyH * 0.3)
  const pinch1 = Math.ceil(head + bodyH * 0.58)
  for (let y = pinch0; y <= pinch1; y++) {
    const chord = torsoChord(person, w, y, box.minX, box.maxX)
    if (!chord) continue
    if (!waistChord || chord.right - chord.left < waistChord.right - waistChord.left) waistChord = chord
  }
  if (!waistChord) return rgba
  const column = waistChord.right - waistChord.left + 1
  const cx = (waistChord.left + waistChord.right) / 2
  const out = new Uint8ClampedArray(rgba)
  const y1 = Math.min(h - 1, Math.ceil(head + bodyH * 0.34))
  for (let y = Math.max(0, Math.floor(head)); y <= y1; y++) {
    const gain = weight(y, head, bodyH)
    if (gain < 0.02) continue
    const local = 1 + (scale - 1) * gain
    const half = column / 2
    const newHalf = half * local
    const x0 = Math.max(0, Math.floor(cx - newHalf))
    const x1 = Math.min(w - 1, Math.ceil(cx + newHalf))
    for (let x = x0; x <= x1; x++) {
      const [r, g, b, a] = sample(rgba, w, cx + (x - cx) / local, y)
      const edge = newHalf - Math.abs(x - cx)
      const mix = Math.max(0, Math.min(1, edge < 2 ? edge / 2 : 1))
      const p = (y * w + x) * 4
      out[p] = Math.round(r * mix + rgba[p] * (1 - mix))
      out[p + 1] = Math.round(g * mix + rgba[p + 1] * (1 - mix))
      out[p + 2] = Math.round(b * mix + rgba[p + 2] * (1 - mix))
      out[p + 3] = Math.round(a * mix + rgba[p + 3] * (1 - mix))
    }
  }
  return out
}

async function personAlpha(src: string, img: HTMLImageElement): Promise<Uint8Array | null> {
  const uri = await toDataUri(src)
  const res = await dressFetch('/extract-person', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      src: uri,
      x: 0,
      y: 0,
      w: img.naturalWidth,
      h: img.naturalHeight,
      method: 'modnet',
    }),
  })
  const data = (await res.json()) as { src?: string }
  if (!res.ok || !data.src) return null
  const matte = await loadImage(data.src)
  if (matte.naturalWidth !== img.naturalWidth || matte.naturalHeight !== img.naturalHeight) return null
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(matte, 0, 0)
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const alpha = new Uint8Array(canvas.width * canvas.height)
  for (let i = 0; i < alpha.length; i++) alpha[i] = frame.data[i * 4 + 3]
  return alpha
}

/** Generated clothes, widened at the chest to the original person's bust. */
export async function fitBust(personSrc: string, generatedSrc: string): Promise<string> {
  const [personImg, genImg] = await Promise.all([loadImage(personSrc), loadImage(generatedSrc)])
  const [srcAlpha, dstAlpha] = await Promise.all([
    personAlpha(personSrc, personImg),
    personAlpha(generatedSrc, genImg),
  ])
  if (!srcAlpha || !dstAlpha) return generatedSrc
  const scale = bustScale(
    srcAlpha,
    personImg.naturalWidth,
    personImg.naturalHeight,
    dstAlpha,
    genImg.naturalWidth,
    genImg.naturalHeight,
  )
  if (scale < MIN_SCALE) return generatedSrc
  const canvas = document.createElement('canvas')
  canvas.width = genImg.naturalWidth
  canvas.height = genImg.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return generatedSrc
  ctx.drawImage(genImg, 0, 0)
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const widened = widenChest(frame.data, dstAlpha, canvas.width, canvas.height, scale)
  frame.data.set(widened)
  ctx.putImageData(frame, 0, 0)
  return canvas.toDataURL('image/png')
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv
if (argv?.[1]?.includes('bustFit')) {
  const w = 60
  const h = 100
  const paint = (bustLeft: number, bustRight: number) => {
    const person = new Uint8Array(w * h)
    const fill = (y0: number, y1: number, x0: number, x1: number) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) person[y * w + x] = 255
    }
    fill(8, 18, 26, 34)
    fill(19, 30, 20, 40)
    fill(31, 52, bustLeft, bustRight)
    fill(53, 80, 22, 38)
    return person
  }
  const src = paint(12, 48)
  const dst = paint(20, 40)
  for (let y = 31; y <= 52; y++) {
    for (let x = 4; x <= 56; x++) dst[y * w + x] = 255
  }
  const scale = bustScale(src, w, h, dst, w, h)
  if (scale < 1.2 || scale > MAX_SCALE) throw new Error(`bust scale ${scale}`)
  const rgba = new Uint8ClampedArray(w * h * 4)
  rgba.fill(10)
  const edge = 35 * w + 22
  rgba[edge * 4] = 255
  rgba[edge * 4 + 3] = 255
  const waist = 70 * w + 22
  rgba[waist * 4 + 1] = 200
  rgba[waist * 4 + 3] = 255
  const widened = widenChest(rgba, dst, w, h, scale)
  let peak = 0
  let at = -1
  for (let x = 0; x < w; x++) {
    const v = widened[(35 * w + x) * 4]
    if (v > peak) {
      peak = v
      at = x
    }
  }
  if (at >= 22 || peak < 20) throw new Error(`chest edge at ${at} value ${peak}`)
  if (widened[waist * 4 + 1] !== 200) throw new Error('waist moved')
  if (widened[0] !== 10) throw new Error('corner moved')
  console.log('bust-fit ok')
}
