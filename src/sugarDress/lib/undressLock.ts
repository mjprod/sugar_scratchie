/**
 * Undress without redrawing the person.
 * Garment pixels that are not skin are filled from the surrounding skin.
 * The face is the narrow head above the shoulders, and those pixels are copied.
 * A skin-coloured garment is not detected. Upgrade path is a garment mask.
 */

const MIN_SKIN = 80

/**
 * Face lock follows the silhouette. A narrow head ends at the shoulders.
 * A torso crop is already wide at the top, so nothing is reserved.
 * A face close-up keeps the top 85%.
 */
export function headLimit(
  person: Uint8Array,
  w: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): number {
  const bw = maxX - minX + 1
  const bh = maxY - minY + 1
  if (bh <= bw * 1.35) return minY + Math.max(1, Math.floor(bh * 0.85))
  const widths = new Array<number>(bh)
  let maxW = 1
  for (let y = minY; y <= maxY; y++) {
    let count = 0
    const row = y * w
    for (let x = minX; x <= maxX; x++) if (person[row + x]) count++
    widths[y - minY] = count
    if (count > maxW) maxW = count
  }
  const topN = Math.max(1, Math.floor(bh * 0.12))
  let topSum = 0
  for (let i = 0; i < topN; i++) topSum += widths[i]
  const topW = topSum / topN
  if (topW > maxW * 0.72) return minY
  const trigger = topW * 1.7
  let run = 0
  for (let i = 0; i < bh; i++) {
    if (widths[i] >= trigger) {
      run++
      if (run >= 2) return minY + Math.max(0, i - 1)
    } else {
      run = 0
    }
  }
  return minY + Math.max(1, Math.floor(bh * 0.16))
}

function isSkin(r: number, g: number, b: number): boolean {
  const yy = 0.299 * r + 0.587 * g + 0.114 * b
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
  const chroma = Math.hypot(cb - 128, cr - 128)
  return cr > cb + 2 && chroma > 6 && chroma < 48 && yy > 75 && yy < 245
}

function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h)
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(w - 1, x + r)
      let v = 0
      for (let xx = x0; xx <= x1; xx++) {
        if (mask[row + xx]) {
          v = 1
          break
        }
      }
      tmp[row + x] = v
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r)
      const y1 = Math.min(h - 1, y + r)
      let v = 0
      for (let yy = y0; yy <= y1; yy++) {
        if (tmp[yy * w + x]) {
          v = 1
          break
        }
      }
      out[y * w + x] = v
    }
  }
  return out
}

function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h)
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(w - 1, x + r)
      let v = 1
      for (let xx = x0; xx <= x1; xx++) {
        if (!mask[row + xx]) {
          v = 0
          break
        }
      }
      tmp[row + x] = v
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r)
      const y1 = Math.min(h - 1, y + r)
      let v = 1
      for (let yy = y0; yy <= y1; yy++) {
        if (!tmp[yy * w + x]) {
          v = 0
          break
        }
      }
      out[y * w + x] = v
    }
  }
  return out
}

function keepLarge(mask: Uint8Array, w: number, h: number, minArea: number): Uint8Array {
  const seen = new Uint8Array(w * h)
  const keep = new Uint8Array(w * h)
  const stack: number[] = []
  const comp: number[] = []
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue
    stack.length = 0
    comp.length = 0
    seen[i] = 1
    stack.push(i)
    while (stack.length) {
      const p = stack.pop() as number
      comp.push(p)
      const x = p % w
      const y = (p - x) / w
      const next = [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, y > 0 ? p - w : -1, y + 1 < h ? p + w : -1]
      for (const q of next) {
        if (q < 0 || seen[q] || !mask[q]) continue
        seen[q] = 1
        stack.push(q)
      }
    }
    if (comp.length >= minArea) {
      for (const p of comp) keep[p] = 1
    }
  }
  return keep
}

function isDarkHair(r: number, g: number, b: number): boolean {
  const yy = 0.299 * r + 0.587 * g + 0.114 * b
  return yy < 90 && r < g + 30
}

function hairFromHead(
  rgba: Uint8ClampedArray | Uint8Array,
  person: Uint8Array,
  skin: Uint8Array,
  head: Uint8Array,
  w: number,
  h: number,
): Uint8Array {
  const hair = new Uint8Array(w * h)
  const stack: number[] = []
  const dark = (i: number) => {
    const p = i * 4
    return isDarkHair(rgba[p], rgba[p + 1], rgba[p + 2])
  }
  for (let i = 0; i < hair.length; i++) {
    if (head[i] && person[i] && !skin[i] && dark(i)) {
      hair[i] = 1
      stack.push(i)
    }
  }
  while (stack.length) {
    const p = stack.pop() as number
    const x = p % w
    const y = (p - x) / w
    const next = [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, y > 0 ? p - w : -1, y + 1 < h ? p + w : -1]
    for (const q of next) {
      if (q < 0 || hair[q] || !person[q] || skin[q] || !dark(q)) continue
      hair[q] = 1
      stack.push(q)
    }
  }
  return hair
}

function neighbors(i: number, w: number, h: number): number[] {
  const x = i % w
  const y = (i - x) / w
  const next: number[] = []
  if (x > 0) next.push(i - 1)
  if (x + 1 < w) next.push(i + 1)
  if (y > 0) next.push(i - w)
  if (y + 1 < h) next.push(i + w)
  return next
}

/** Grow the fill inward from real skin so the garment is not one flat colour. */
function paintCloth(
  out: Uint8Array,
  mask: Uint8Array,
  skin: Uint8Array,
  w: number,
  h: number,
  sr: number,
  sg: number,
  sb: number,
) {
  const n = w * h
  const known = new Uint8Array(n)
  const queued = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (!mask[i]) known[i] = 1
  let frontier: number[] = []
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue
    for (const j of neighbors(i, w, h)) {
      if (known[j] && skin[j]) {
        frontier.push(i)
        queued[i] = 1
        break
      }
    }
  }
  while (frontier.length) {
    const next: number[] = []
    for (const i of frontier) {
      let r = 0
      let g = 0
      let b = 0
      let c = 0
      for (const j of neighbors(i, w, h)) {
        const fromSkin = known[j] && !mask[j] && skin[j]
        const fromFill = known[j] && mask[j]
        if (!fromSkin && !fromFill) continue
        const p = j * 4
        r += out[p]
        g += out[p + 1]
        b += out[p + 2]
        c++
      }
      const p = i * 4
      if (c === 0) {
        out[p] = sr
        out[p + 1] = sg
        out[p + 2] = sb
      } else {
        out[p] = Math.round(r / c)
        out[p + 1] = Math.round(g / c)
        out[p + 2] = Math.round(b / c)
      }
    }
    for (const i of frontier) known[i] = 1
    for (const i of frontier) {
      for (const j of neighbors(i, w, h)) {
        if (!mask[j] || known[j] || queued[j]) continue
        queued[j] = 1
        next.push(j)
      }
    }
    frontier = next
  }
  for (let i = 0; i < n; i++) {
    if (!mask[i] || known[i]) continue
    const p = i * 4
    out[p] = sr
    out[p + 1] = sg
    out[p + 2] = sb
  }
}

function median(values: number[]): number {
  values.sort((a, b) => a - b)
  return values[values.length >> 1]
}

/** `personAlpha` is the person matte. Omitted: use the image alpha. Opaque frames need a matte. */
export function undressLock(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  personAlpha?: Uint8Array | null,
): Uint8Array {
  const n = w * h
  const out = new Uint8Array(rgba)
  const person = new Uint8Array(n)
  const skin = new Uint8Array(n)
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  let count = 0
  for (let i = 0; i < n; i++) {
    const a = personAlpha ? personAlpha[i] : rgba[i * 4 + 3]
    if (a <= 16) continue
    person[i] = 1
    count++
    const x = i % w
    const y = (i - x) / w
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    const p = i * 4
    if (isSkin(rgba[p], rgba[p + 1], rgba[p + 2])) skin[i] = 1
  }
  if (count < MIN_SKIN) throw new Error('Person not found')
  const headY = headLimit(person, w, minX, maxX, minY, maxY)
  const head = new Uint8Array(n)
  for (let y = minY; y < headY && y < h; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i = y * w + x
      if (person[i]) head[i] = 1
    }
  }
  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  for (let i = 0; i < n; i++) {
    if (!skin[i] || !person[i]) continue
    const p = i * 4
    rs.push(rgba[p])
    gs.push(rgba[p + 1])
    bs.push(rgba[p + 2])
  }
  if (rs.length < MIN_SKIN) throw new Error('Original skin colour not found')
  const sr = median(rs)
  const sg = median(gs)
  const sb = median(bs)
  const hair = hairFromHead(rgba, person, skin, head, w, h)
  const cloth = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (person[i] && !skin[i] && !head[i] && !hair[i]) cloth[i] = 1
  }
  const minArea = Math.max(12, Math.floor(count * 0.005))
  let mask = erode(dilate(keepLarge(cloth, w, h, minArea), w, h, 2), w, h, 2)
  mask = dilate(mask, w, h, 1)
  for (let i = 0; i < n; i++) {
    if (head[i] || hair[i] || !person[i]) mask[i] = 0
  }
  paintCloth(out, mask, skin, w, h, sr, sg, sb)
  return out
}

const isDirectRun = String(
  (globalThis as { process?: { argv?: string[] } }).process?.argv?.[1] ?? '',
).includes('undressLock')
function samePixel(out: Uint8Array, before: Uint8Array, i: number, label: string) {
  if (out[i] !== before[i] || out[i + 1] !== before[i + 1] || out[i + 2] !== before[i + 2] || out[i + 3] !== before[i + 3]) {
    throw new Error(`${label} changed`)
  }
}

if (isDirectRun) {
  const w = 10
  const h = 40
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4
      rgba[p] = 180
      rgba[p + 1] = 140
      rgba[p + 2] = 120
      rgba[p + 3] = x === 0 ? 0 : 255
    }
  }
  for (let y = 22; y <= 32; y++) {
    for (let x = 1; x < w; x++) {
      const p = (y * w + x) * 4
      rgba[p] = 200
      rgba[p + 1] = 20
      rgba[p + 2] = 40
    }
  }
  const lip = (10 * w + 4) * 4
  rgba[lip] = 162
  rgba[lip + 1] = 89
  rgba[lip + 2] = 90
  const lace = (21 * w + 5) * 4
  rgba[lace] = 162
  rgba[lace + 1] = 89
  rgba[lace + 2] = 90
  const speck = (36 * w + 3) * 4
  rgba[speck] = 10
  rgba[speck + 1] = 10
  rgba[speck + 2] = 10
  const before = rgba.slice()
  const out = undressLock(rgba, w, h)
  const dress = (27 * w + 4) * 4
  if (out[dress] !== 180 || out[dress + 1] !== 140 || out[dress + 2] !== 120) {
    throw new Error(`dress stayed ${out[dress]},${out[dress + 1]},${out[dress + 2]}`)
  }
  if (out[lace] !== 180 || out[lace + 1] !== 140 || out[lace + 2] !== 120) {
    throw new Error(`lace edge stayed ${out[lace]},${out[lace + 1]},${out[lace + 2]}`)
  }
  samePixel(out, before, lip, 'lip')
  samePixel(out, before, (8 * w + 4) * 4, 'face')
  samePixel(out, before, (27 * w + 0) * 4, 'background')
  samePixel(out, before, speck, 'speck')

  const sw = 20
  const sh = 40
  const body = new Uint8Array(sw * sh * 4)
  const inside = (x: number, y: number) => (y < 9 ? x >= 8 && x <= 12 : x >= 2 && x <= 17)
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const p = (y * sw + x) * 4
      if (!inside(x, y)) continue
      body[p] = 180
      body[p + 1] = 140
      body[p + 2] = 120
      body[p + 3] = 255
    }
  }
  const eye = (3 * sw + 10) * 4
  body[eye] = 200
  body[eye + 1] = 20
  body[eye + 2] = 40
  for (let y = 24; y <= 34; y++) {
    for (let x = 4; x <= 15; x++) {
      const p = (y * sw + x) * 4
      body[p] = 200
      body[p + 1] = 20
      body[p + 2] = 40
    }
  }
  const bodyBefore = body.slice()
  const bodyOut = undressLock(body, sw, sh)
  samePixel(bodyOut, bodyBefore, eye, 'eye')
  const torso = (28 * sw + 8) * 4
  if (bodyOut[torso] !== 180 || bodyOut[torso + 1] !== 140 || bodyOut[torso + 2] !== 120) {
    throw new Error(`torso dress stayed ${bodyOut[torso]},${bodyOut[torso + 1]},${bodyOut[torso + 2]}`)
  }
  samePixel(bodyOut, bodyBefore, (16 * sw + 8) * 4, 'chest')

  const pw = 30
  const ph = 20
  const portrait = new Uint8Array(pw * ph * 4)
  for (let i = 0; i < pw * ph; i++) {
    const p = i * 4
    portrait[p] = 180
    portrait[p + 1] = 140
    portrait[p + 2] = 120
    portrait[p + 3] = 255
  }
  const mouth = (12 * pw + 15) * 4
  portrait[mouth] = 162
  portrait[mouth + 1] = 89
  portrait[mouth + 2] = 90
  for (let x = 0; x < pw; x++) {
    const p = (19 * pw + x) * 4
    portrait[p] = 200
    portrait[p + 1] = 20
    portrait[p + 2] = 40
  }
  const portraitBefore = portrait.slice()
  const portraitOut = undressLock(portrait, pw, ph)
  samePixel(portraitOut, portraitBefore, mouth, 'portrait mouth')
  const collar = (19 * pw + 8) * 4
  if (portraitOut[collar] !== 180 || portraitOut[collar + 1] !== 140 || portraitOut[collar + 2] !== 120) {
    throw new Error('portrait collar stayed')
  }
  console.log('undress-lock ok')
}
