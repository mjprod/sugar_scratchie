export type GarmentBox = { x: number; y: number; w: number; h: number }

/** Tight box around opaque pixels. */
export function opaqueBox(alpha: ArrayLike<number>, w: number, h: number): GarmentBox | null {
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] < 16) continue
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
  }
  if (x1 < x0 || y1 < y0) return null
  const bw = x1 - x0 + 1
  const bh = y1 - y0 + 1
  if (bw < 8 || bh < 8) return null
  return { x: x0, y: y0, w: bw, h: bh }
}

/**
 * Garment size from a person silhouette.
 * The narrow head is left out. Width is the body. Length runs from the shoulders to the feet.
 */
export function bodyGarmentBox(alpha: ArrayLike<number>, w: number, h: number): GarmentBox | null {
  let maxWidth = 0
  const rows: { y: number; x0: number; x1: number; width: number }[] = []
  for (let y = 0; y < h; y++) {
    let x0 = -1
    let x1 = -1
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] < 16) continue
      if (x0 < 0) x0 = x
      x1 = x
    }
    if (x0 < 0) continue
    const width = x1 - x0 + 1
    if (width > maxWidth) maxWidth = width
    rows.push({ y, x0, x1, width })
  }
  if (!rows.length || maxWidth < 8) return null
  const shoulder = rows.find((row) => row.width >= maxWidth * 0.45) ?? rows[0]
  let x0 = w
  let x1 = -1
  let y1 = shoulder.y
  for (const row of rows) {
    if (row.y < shoulder.y) continue
    if (row.x0 < x0) x0 = row.x0
    if (row.x1 > x1) x1 = row.x1
    if (row.y > y1) y1 = row.y
  }
  const bw = x1 - x0 + 1
  const bh = y1 - shoulder.y + 1
  if (bw < 8 || bh < 8) return null
  return { x: x0, y: shoulder.y, w: bw, h: bh }
}

/** Colored pixels. White and empty pixels are not the garment. */
export function garmentInk(data: ArrayLike<number>, w: number, h: number): GarmentBox | null {
  const ink = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4]
    const g = data[i * 4 + 1]
    const b = data[i * 4 + 2]
    const a = data[i * 4 + 3]
    ink[i] = a > 16 && (r < 245 || g < 245 || b < 245) ? 255 : 0
  }
  return opaqueBox(ink, w, h)
}

/** K-pop looks. Three-card Build Dress picks from here, it does not copy the photo. */
export const OUTFIT_LOOKS = [
  'K-pop stage: black cropped blazer, white fitted crop top, pleated black mini skirt, slim belt',
  'K-pop airport: oversized grey zip hoodie, black biker shorts, cropped black coat, baseball cap, mini shoulder bag',
  'K-pop elegant: ivory satin camisole, tailored cream trousers, cropped tweed jacket, thin gold necklace',
  'K-pop cute: baby-pink knit cardigan, white pleated skirt, small ribbon choker',
  'K-pop dark concept: black cropped moto jacket, high-waist black trousers, silver chain belt',
  'K-pop girl crush: red off-shoulder knit, black leather mini skirt, hoop earrings',
  'K-pop performance: silver sequin crop top, black tailored shorts',
  'K-pop preppy: white shirt, navy knit vest, grey plaid pleated skirt',
]

export function pickOutfits(count: number, random: () => number = Math.random): string[] {
  const pool = [...OUTFIT_LOOKS]
  const out: string[] = []
  const n = Math.min(count, pool.length)
  while (out.length < n) {
    const i = Math.min(pool.length - 1, Math.floor(random() * pool.length))
    const look = pool.splice(i, 1)[0]
    if (look) out.push(look)
  }
  return out
}

export function fittedDressPrompt(text: string): string {
  const words = text.trim()
  return [
    'The first image is one person. Use it only for body size and shape. Do not copy the clothes, colors, or outfit in that photo.',
    `Build only this outfit: ${words}. Do not invent a different garment.`,
    'Style it as current K-pop idol fashion: polished, coordinated, and stage-ready.',
    'Catalog product photo of that outfit, front-facing, centered, from the neckline to the knee.',
    'Nothing below the knee.',
    'Seamless light gray studio background.',
    'Invisible mannequin: the clothes hold a worn shape, but there is no person, no head, no face, no hair, and no visible skin. The neck opening is empty.',
    'Clothing only. No legs, no hands, no shoes, no socks, and no boots. Sleeves end empty.',
    'Do not draw a real model. Do not lay the clothes flat on white.',
    'The garment width must match this person\'s shoulder, bust, waist, and hip width.',
    'Do not use a standard model size. Do not make the garment wider or narrower than this body.',
  ].join(' ')
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv
if (argv?.[1]?.includes('buildDressFit')) {
  const w = 20
  const h = 30
  const alpha = new Uint8Array(w * h)
  for (let y = 0; y < 6; y++) {
    for (let x = 8; x <= 11; x++) alpha[y * w + x] = 255
  }
  for (let y = 6; y < 28; y++) {
    for (let x = 2; x <= 17; x++) alpha[y * w + x] = 255
  }
  const box = bodyGarmentBox(alpha, w, h)
  if (!box || box.y !== 6 || box.w !== 16 || box.h !== 22) throw new Error(`body box ${JSON.stringify(box)}`)
  const iw = 10
  const ih = 10
  const ink = new Uint8ClampedArray(iw * ih * 4)
  for (let i = 0; i < iw * ih; i++) {
    const x = i % iw
    ink[i * 4] = x === 0 ? 255 : 20
    ink[i * 4 + 1] = x === 0 ? 255 : 20
    ink[i * 4 + 2] = x === 0 ? 255 : 20
    ink[i * 4 + 3] = 255
  }
  const found = garmentInk(ink, iw, ih)
  if (!found || found.x !== 1 || found.w !== 9) throw new Error('white counted as cloth')
  const prompt = fittedDressPrompt('黑色蕾絲洋裝')
  if (
    !prompt.includes('黑色蕾絲洋裝') ||
    !prompt.includes('Do not copy the clothes') ||
    !prompt.includes('Do not invent a different garment') ||
    !prompt.includes('K-pop idol fashion') ||
    !prompt.includes('Seamless light gray') ||
    !prompt.includes('Invisible mannequin') ||
    !prompt.includes('front-facing') ||
    !prompt.includes('no person') ||
    !prompt.includes('neck opening is empty') ||
    !prompt.includes('Nothing below the knee') ||
    !prompt.includes('No legs, no hands, no shoes') ||
    !prompt.includes('garment width') ||
    prompt.includes('to the shoes') ||
    prompt.includes('Boots, tights') ||
    prompt.includes('plain white') ||
    prompt.includes('Lay that garment flat') ||
    prompt.includes('Rebuild those same clothes')
  ) {
    throw new Error('fitted dress prompt')
  }
  const three = pickOutfits(3, () => 0)
  if (
    three.length !== 3 ||
    new Set(three).size !== 3 ||
    three[0] !== OUTFIT_LOOKS[0] ||
    OUTFIT_LOOKS.some((look) => !look.startsWith('K-pop ') || /boots|shoes|socks|heels|sneakers|loafers|gloves|tights/i.test(look))
  ) {
    throw new Error('outfit pick')
  }
  console.log('build-dress-fit ok')
}
