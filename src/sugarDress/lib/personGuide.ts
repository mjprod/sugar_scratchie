/**
 * Face mask and body mesh for a person edit.
 * The face pixels are covered before generation and pasted back after.
 * The mesh is the body width at each height, so the edit has the original shape.
 *
 * ponytail: the mesh is the silhouette chords, not a joint skeleton.
 */

import { headLimit } from './undressLock'

export type FaceRect = { x: number; y: number; w: number; h: number }

/** Tight box around a landmark oval. Too-small detections are ignored. */
export function faceBox(points: number[][]): FaceRect | null {
  if (points.length < 3) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  const w = x1 - x0
  const h = y1 - y0
  if (w < 8 || h < 8) return null
  return { x: x0, y: y0, w, h }
}

export type PersonGuide = {
  masked: Uint8Array
  mesh: Uint8Array
  face: FaceRect | null
  w: number
  h: number
}

function plot(mesh: Uint8Array, w: number, h: number, x: number, y: number) {
  if (x < 0 || y < 0 || x >= w || y >= h) return
  const p = (y * w + x) * 4
  mesh[p] = 40
  mesh[p + 1] = 40
  mesh[p + 2] = 40
  mesh[p + 3] = 255
}

function stroke(mesh: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number) {
  let x = x0
  let y = y0
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx - dy
  for (;;) {
    plot(mesh, w, h, x, y)
    if (x === x1 && y === y1) break
    const e2 = 2 * err
    if (e2 > -dy) {
      err -= dy
      x += sx
    }
    if (e2 < dx) {
      err += dx
      y += sy
    }
  }
}

function skinAt(r: number, g: number, b: number): boolean {
  const yy = 0.299 * r + 0.587 * g + 0.114 * b
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
  const chroma = Math.hypot(cb - 128, cr - 128)
  return cr > cb + 2 && chroma > 6 && chroma < 48 && yy > 75 && yy < 245
}

function median(values: number[]): number {
  values.sort((a, b) => a - b)
  return values[values.length >> 1]
}

/** Cover the face and draw a wireframe of the body. `person` is the matte, 0–255. */
export function buildGuide(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  personAlpha: Uint8Array,
): PersonGuide | null {
  const n = w * h
  const person = new Uint8Array(n)
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  let count = 0
  for (let i = 0; i < n; i++) {
    if (personAlpha[i] <= 16) continue
    person[i] = 1
    count++
    const x = i % w
    const y = (i - x) / w
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (count < 80 || maxY < minY) return null
  const headY = headLimit(person, w, minX, maxX, minY, maxY)
  const masked = new Uint8Array(rgba)
  let face: FaceRect | null = null
  if (headY > minY + 4) {
    const rs: number[] = []
    const gs: number[] = []
    const bs: number[] = []
    const band = Math.max(2, Math.floor((maxY - minY + 1) * 0.08))
    for (let y = headY; y < Math.min(h, headY + band); y++) {
      for (let x = minX; x <= maxX; x++) {
        const i = y * w + x
        if (!person[i]) continue
        const p = i * 4
        if (!skinAt(rgba[p], rgba[p + 1], rgba[p + 2])) continue
        rs.push(rgba[p])
        gs.push(rgba[p + 1])
        bs.push(rgba[p + 2])
      }
    }
    const sr = rs.length ? median(rs) : 180
    const sg = gs.length ? median(gs) : 150
    const sb = bs.length ? median(bs) : 130
    let fx0 = w
    let fx1 = -1
    for (let y = minY; y < headY && y < h; y++) {
      for (let x = minX; x <= maxX; x++) {
        const i = y * w + x
        if (!person[i]) continue
        if (x < fx0) fx0 = x
        if (x > fx1) fx1 = x
        const p = i * 4
        masked[p] = sr
        masked[p + 1] = sg
        masked[p + 2] = sb
      }
    }
    if (fx1 > fx0) face = { x: fx0, y: minY, w: fx1 - fx0 + 1, h: headY - minY }
  }
  const mesh = new Uint8Array(n * 4)
  mesh.fill(255)
  const span = maxY - minY + 1
  const stride = Math.max(4, Math.round(span / 18))
  let prevL: { x: number; y: number } | null = null
  let prevR: { x: number; y: number } | null = null
  const mids: { x: number; y: number }[] = []
  for (let y = minY; y <= maxY; y += stride) {
    let left = -1
    let right = -1
    const row = y * w
    for (let x = minX; x <= maxX; x++) {
      if (!person[row + x]) continue
      if (left < 0) left = x
      right = x
    }
    if (right - left < 4) continue
    stroke(mesh, w, h, left, y, right, y)
    if (prevL && prevR) {
      stroke(mesh, w, h, prevL.x, prevL.y, left, y)
      stroke(mesh, w, h, prevR.x, prevR.y, right, y)
    }
    prevL = { x: left, y }
    prevR = { x: right, y }
    mids.push({ x: (left + right) >> 1, y })
  }
  for (let i = 1; i < mids.length; i++) {
    stroke(mesh, w, h, mids[i - 1].x, mids[i - 1].y, mids[i].x, mids[i].y)
  }
  return { masked, mesh, face, w, h }
}

export function meshLine(index: number): string {
  return `<IMAGE_${index}> is a wireframe mesh of this person's body. Keep that body size and shape, including the chest. Do not draw the mesh lines. The face in <IMAGE_0> is masked. Do not invent a new face.`
}

function canvasOf(w: number, h: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not prepare the person')
  return ctx
}

function pixelsOf(img: HTMLImageElement): { data: Uint8ClampedArray; w: number; h: number } {
  const ctx = canvasOf(img.naturalWidth, img.naturalHeight)
  ctx.drawImage(img, 0, 0)
  const frame = ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight)
  return { data: frame.data, w: img.naturalWidth, h: img.naturalHeight }
}

/** `matte` supplies the person alpha. It must be the same size as `original`. */
export async function openGuide(
  original: HTMLImageElement,
  matte: HTMLImageElement,
): Promise<{ masked: string; mesh: string; face: FaceRect | null; w: number; h: number } | null> {
  if (matte.naturalWidth !== original.naturalWidth || matte.naturalHeight !== original.naturalHeight) return null
  const src = pixelsOf(original)
  const cut = pixelsOf(matte)
  const alpha = new Uint8Array(src.w * src.h)
  for (let i = 0; i < alpha.length; i++) alpha[i] = cut.data[i * 4 + 3]
  const guide = buildGuide(src.data, src.w, src.h, alpha)
  if (!guide) return null
  const maskedCtx = canvasOf(src.w, src.h)
  const maskedFrame = maskedCtx.getImageData(0, 0, src.w, src.h)
  maskedFrame.data.set(guide.masked)
  maskedCtx.putImageData(maskedFrame, 0, 0)
  const meshCtx = canvasOf(src.w, src.h)
  const meshFrame = meshCtx.getImageData(0, 0, src.w, src.h)
  meshFrame.data.set(guide.mesh)
  meshCtx.putImageData(meshFrame, 0, 0)
  return {
    masked: maskedCtx.canvas.toDataURL('image/png'),
    mesh: meshCtx.canvas.toDataURL('image/png'),
    face: guide.face,
    w: src.w,
    h: src.h,
  }
}

/** Put the original face back on the generated plate. The body stays the generated pixels. */
export async function pasteLockedFace(
  generated: HTMLImageElement,
  original: HTMLImageElement,
  face: FaceRect,
  srcW: number,
  srcH: number,
): Promise<string> {
  const dw = Math.max(1, Math.round(face.w * (generated.naturalWidth / srcW)))
  const dh = Math.max(1, Math.round(face.h * (generated.naturalHeight / srcH)))
  const dx = Math.round(face.x * (generated.naturalWidth / srcW))
  const dy = Math.round(face.y * (generated.naturalHeight / srcH))
  const ctx = canvasOf(generated.naturalWidth, generated.naturalHeight)
  ctx.drawImage(generated, 0, 0)
  const faceCtx = canvasOf(dw, dh)
  faceCtx.drawImage(original, face.x, face.y, face.w, face.h, 0, 0, dw, dh)
  const frame = faceCtx.getImageData(0, 0, dw, dh)
  const fade = Math.max(2, Math.round(dh * 0.12))
  const side = Math.max(2, Math.round(dw * 0.08))
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const p = (y * dw + x) * 4
      let a = frame.data[p + 3] / 255
      const fromBottom = dh - 1 - y
      if (fromBottom < fade) a *= fromBottom / fade
      const fromSide = Math.min(x, dw - 1 - x)
      if (fromSide < side) a *= fromSide / side
      frame.data[p + 3] = Math.round(a * 255)
    }
  }
  faceCtx.putImageData(frame, 0, 0)
  ctx.drawImage(faceCtx.canvas, dx, dy)
  return ctx.canvas.toDataURL('image/png')
}

/** Paste the original face inside the landmark oval. Pixels outside the oval stay generated. */
export async function pasteFaceOval(
  generated: HTMLImageElement,
  original: HTMLImageElement,
  points: number[][],
  srcW: number,
  srcH: number,
): Promise<string> {
  const genW = generated.naturalWidth
  const genH = generated.naturalHeight
  const sx = genW / srcW
  const sy = genH / srcH
  const maskCtx = canvasOf(genW, genH)
  maskCtx.beginPath()
  maskCtx.moveTo(points[0][0] * sx, points[0][1] * sy)
  for (let i = 1; i < points.length; i++) maskCtx.lineTo(points[i][0] * sx, points[i][1] * sy)
  maskCtx.closePath()
  maskCtx.fillStyle = '#fff'
  maskCtx.fill()
  const softCtx = canvasOf(genW, genH)
  softCtx.filter = 'blur(3px)'
  softCtx.drawImage(maskCtx.canvas, 0, 0)
  const faceCtx = canvasOf(genW, genH)
  faceCtx.drawImage(original, 0, 0, genW, genH)
  faceCtx.globalCompositeOperation = 'destination-in'
  faceCtx.drawImage(softCtx.canvas, 0, 0)
  const ctx = canvasOf(genW, genH)
  ctx.drawImage(generated, 0, 0)
  ctx.drawImage(faceCtx.canvas, 0, 0)
  return ctx.canvas.toDataURL('image/png')
}

/**
 * Similarity that maps one face oval onto the other.
 * Canvas transform is x' = a x + c y + tx, y' = b x + d y + ty.
 */
export function faceSimilarity(
  src: number[][],
  dst: number[][],
): { a: number; b: number; c: number; d: number; tx: number; ty: number; scale: number; turn: number; error: number } | null {
  const n = src.length
  if (n < 8 || n !== dst.length) return null
  let sx = 0
  let sy = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    const s = src[i]
    const d = dst[i]
    if (!s || !d || !Number.isFinite(s[0]) || !Number.isFinite(s[1]) || !Number.isFinite(d[0]) || !Number.isFinite(d[1])) {
      return null
    }
    sx += s[0]
    sy += s[1]
    dx += d[0]
    dy += d[1]
  }
  sx /= n
  sy /= n
  dx /= n
  dy /= n
  let spread = 0
  let dot = 0
  let cross = 0
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - sx
    const y = src[i][1] - sy
    const u = dst[i][0] - dx
    const v = dst[i][1] - dy
    spread += x * x + y * y
    dot += x * u + y * v
    cross += x * v - y * u
  }
  if (spread < 1) return null
  const norm = Math.hypot(dot, cross)
  if (norm < 1e-3) return null
  const scale = norm / spread
  const cos = dot / norm
  const sin = cross / norm
  const a = scale * cos
  const b = scale * sin
  const c = -b
  const d = a
  const tx = dx - (a * sx + c * sy)
  const ty = dy - (b * sx + d * sy)
  let err = 0
  for (let i = 0; i < n; i++) {
    const x = src[i][0]
    const y = src[i][1]
    err += Math.hypot(a * x + c * y + tx - dst[i][0], b * x + d * y + ty - dst[i][1])
  }
  return { a, b, c, d, tx, ty, scale, turn: Math.abs(Math.atan2(sin, cos)) * (180 / Math.PI), error: err / n }
}

function skinPixel(r: number, g: number, b: number): boolean {
  return skinAt(r, g, b)
}

/** Generated tan can sit outside the strict skin chroma cap. Pink cloth has blue above green. */
function paintableSkin(r: number, g: number, b: number): boolean {
  if (b > g + 10) return false
  if (skinPixel(r, g, b)) return true
  const yy = 0.299 * r + 0.587 * g + 0.114 * b
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
  const chroma = Math.hypot(cb - 128, cr - 128)
  return yy > 75 && yy < 245 && chroma >= 6 && chroma < 70 && r > g && g + 10 >= b
}

function medianOf(values: number[]): number {
  values.sort((a, b) => a - b)
  return values[values.length >> 1] ?? 0
}

/** Move generated skin toward the original face color. Pink or red cloth is left alone. */
export function shiftSkin(
  generated: Uint8ClampedArray,
  original: Uint8ClampedArray,
  ow: number,
  oh: number,
  face: FaceRect | null,
): Uint8ClampedArray {
  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  const x0 = face ? Math.max(0, Math.floor(face.x)) : 0
  const y0 = face ? Math.max(0, Math.floor(face.y)) : 0
  const x1 = face ? Math.min(ow, Math.ceil(face.x + face.w)) : ow
  const y1 = face ? Math.min(oh, Math.ceil(face.y + face.h)) : oh
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * ow + x) * 4
      const r = original[p]
      const g = original[p + 1]
      const b = original[p + 2]
      if (!skinPixel(r, g, b)) continue
      rs.push(r)
      gs.push(g)
      bs.push(b)
    }
  }
  if (rs.length < 8) return generated
  const tr = medianOf(rs)
  const tg = medianOf(gs)
  const tb = medianOf(bs)
  const gr: number[] = []
  const gg: number[] = []
  const gb: number[] = []
  for (let i = 0; i < generated.length; i += 4) {
    const r = generated[i]
    const g = generated[i + 1]
    const b = generated[i + 2]
    if (!paintableSkin(r, g, b)) continue
    gr.push(r)
    gg.push(g)
    gb.push(b)
  }
  if (gr.length < 8) return generated
  const dr = tr - medianOf(gr)
  const dg = tg - medianOf(gg)
  const db = tb - medianOf(gb)
  const out = new Uint8ClampedArray(generated)
  for (let i = 0; i < out.length; i += 4) {
    const r = out[i]
    const g = out[i + 1]
    const b = out[i + 2]
    if (!paintableSkin(r, g, b)) continue
    out[i] = Math.max(0, Math.min(255, Math.round(r + dr)))
    out[i + 1] = Math.max(0, Math.min(255, Math.round(g + dg)))
    out[i + 2] = Math.max(0, Math.min(255, Math.round(b + db)))
  }
  return out
}

/** Put the source face on the generated head. The body pose stays generated. */
export async function pasteMovedFace(
  generated: HTMLImageElement,
  original: HTMLImageElement,
  srcPoints: number[][],
  dstPoints: number[][],
  loose = false,
): Promise<string | null> {
  const dst = faceBox(dstPoints)
  const srcBox = faceBox(srcPoints)
  let fit = faceSimilarity(srcPoints, dstPoints)
  if (!dst || !srcBox) return null
  const genW = generated.naturalWidth
  const genH = generated.naturalHeight
  if (dst.w * dst.h > genW * genH * 0.5) return null
  const scaleOk = (scale: number, turn: number, error: number) =>
    loose
      ? scale >= 0.3 && scale <= 3 && turn <= 50 && error <= dst.h * 0.22
      : scale >= 0.35 && scale <= 2.8 && turn <= 35 && error <= dst.h * 0.12
  if (!fit || !scaleOk(fit.scale, fit.turn, fit.error)) {
    if (!loose) return null
    const scale = dst.w / srcBox.w
    if (scale < 0.3 || scale > 3) return null
    const scx = srcBox.x + srcBox.w / 2
    const scy = srcBox.y + srcBox.h / 2
    const dcx = dst.x + dst.w / 2
    const dcy = dst.y + dst.h / 2
    fit = {
      a: scale,
      b: 0,
      c: 0,
      d: scale,
      tx: dcx - scale * scx,
      ty: dcy - scale * scy,
      scale,
      turn: 0,
      error: 0,
    }
  }
  const faceCtx = canvasOf(genW, genH)
  faceCtx.setTransform(fit.a, fit.b, fit.c, fit.d, fit.tx, fit.ty)
  faceCtx.drawImage(original, 0, 0)
  faceCtx.setTransform(1, 0, 0, 1, 0, 0)
  const maskCtx = canvasOf(genW, genH)
  const cx = dst.x + dst.w / 2
  const cy = dst.y + dst.h / 2
  const grow = loose ? 1.14 : 1.04
  maskCtx.beginPath()
  maskCtx.moveTo(cx + (dstPoints[0][0] - cx) * grow, cy + (dstPoints[0][1] - cy) * grow)
  for (let i = 1; i < dstPoints.length; i++) {
    maskCtx.lineTo(cx + (dstPoints[i][0] - cx) * grow, cy + (dstPoints[i][1] - cy) * grow)
  }
  maskCtx.closePath()
  maskCtx.fillStyle = '#fff'
  maskCtx.fill()
  const softCtx = canvasOf(genW, genH)
  softCtx.filter = `blur(${Math.max(1, Math.round(dst.h * 0.025))}px)`
  softCtx.drawImage(maskCtx.canvas, 0, 0)
  faceCtx.globalCompositeOperation = 'destination-in'
  faceCtx.drawImage(softCtx.canvas, 0, 0)
  const mid = faceCtx.getImageData(Math.round(cx), Math.round(cy), 1, 1).data
  if (mid[3] < 200) return null
  const ctx = canvasOf(genW, genH)
  ctx.drawImage(generated, 0, 0)
  ctx.drawImage(faceCtx.canvas, 0, 0)
  return ctx.canvas.toDataURL('image/png')
}

const isDirectRun = String(
  (globalThis as { process?: { argv?: string[] } }).process?.argv?.[1] ?? '',
).includes('personGuide')
if (isDirectRun) {
  const w = 20
  const h = 40
  const rgba = new Uint8Array(w * h * 4)
  const person = new Uint8Array(w * h)
  const inside = (x: number, y: number) => (y < 9 ? x >= 8 && x <= 12 : x >= 2 && x <= 17)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) continue
      const p = (y * w + x) * 4
      person[y * w + x] = 255
      const head = y < 9
      rgba[p] = head ? 200 : 180
      rgba[p + 1] = head ? 20 : 140
      rgba[p + 2] = head ? 40 : 120
      rgba[p + 3] = 255
    }
  }
  const guide = buildGuide(rgba, w, h, person)
  const box = faceBox([
    [10, 20],
    [30, 20],
    [30, 50],
    [10, 50],
  ])
  if (!box || box.x !== 10 || box.y !== 20 || box.w !== 20 || box.h !== 30) throw new Error('face box')
  if (faceBox([[0, 0], [4, 0], [4, 4]])) throw new Error('tiny face kept')
  const oval = [
    [0, 0], [10, 0], [20, 0], [30, 0],
    [0, 10], [10, 10], [20, 10], [30, 10],
  ]
  const moved = oval.map(([x, y]) => [x * 2 + 3, y * 2 - 4])
  const fit = faceSimilarity(oval, moved)
  if (!fit || Math.abs(fit.scale - 2) > 0.02 || fit.error > 0.5 || fit.turn > 1) throw new Error('face similarity')
  const turned = oval.map(([x, y]) => [-y, x])
  const spin = faceSimilarity(oval, turned)
  if (!spin || spin.turn < 80) throw new Error('face turn')
  if (!guide?.face) throw new Error('face missing')
  const facePx = (3 * w + 10) * 4
  if (guide.masked[facePx] === 200) throw new Error('face was not masked')
  const bodyPx = (24 * w + 8) * 4
  if (guide.masked[bodyPx] !== 180) throw new Error('body was masked')
  let dark = 0
  for (let i = 0; i < guide.mesh.length; i += 4) if (guide.mesh[i] === 40) dark++
  if (dark < 20) throw new Error(`mesh too thin ${dark}`)
  if (!meshLine(2).includes('<IMAGE_2>') || !meshLine(2).includes('Do not invent a new face')) {
    throw new Error('mesh line')
  }
  const face = { x: 0, y: 0, w: 4, h: 4 }
  const original = new Uint8ClampedArray(4 * 4 * 4)
  const generatedSkin = new Uint8ClampedArray(4 * 4 * 4)
  for (let i = 0; i < 16; i++) {
    original[i * 4] = 200
    original[i * 4 + 1] = 160
    original[i * 4 + 2] = 140
    original[i * 4 + 3] = 255
    generatedSkin[i * 4] = 230
    generatedSkin[i * 4 + 1] = 150
    generatedSkin[i * 4 + 2] = 110
    generatedSkin[i * 4 + 3] = 255
  }
  generatedSkin[0] = 240
  generatedSkin[1] = 110
  generatedSkin[2] = 150
  const shifted = shiftSkin(generatedSkin, original, 4, 4, face)
  if (shifted[0] !== 240 || Math.abs(shifted[4] - 200) > 12) throw new Error('skin tone')
  console.log('person-guide ok')
}
