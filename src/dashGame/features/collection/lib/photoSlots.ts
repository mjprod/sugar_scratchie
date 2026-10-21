/** Total photo-card slots shown under an active motion card. */
export const PHOTO_SLOTS = 10

/** Filled photo slots use the Sugar Scratch card back art when no catalog URL is set. */
export const PHOTO_SLOT_IMAGE = '/img/SugarScratch.png'

/**
 * Published photo-scratch id for a motion card slot.
 * Grid index 0 → `{motionId}_slot_01` (matches public/photo-scratch/index.json).
 */
export function photoScratchIdForSlot(
  motionCardId: string,
  slotIndex: number,
): string {
  const motion = motionCardId.trim()
  const idx = Number.isFinite(slotIndex) ? Math.floor(slotIndex) : 0
  const n = Math.max(0, Math.min(PHOTO_SLOTS - 1, idx)) + 1
  return `${motion}_slot_${String(n).padStart(2, '0')}`
}

/** Strip `_slot_XX` suffix so collection return can reopen the motion card. */
export function motionCardIdFromPhotoScratchId(photoCardId: string): string {
  const id = photoCardId.trim()
  return id.replace(/_slot_\d{2}$/, '') || id
}

export type PhotoSlotFill = {
  /** Preview / collected art (null = empty locked cell). */
  src: string | null
  /** True only when the user has collected this slot. */
  collected: boolean
}

function hashSeed(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

function normalizePhotoUrls(urls?: readonly string[] | null): string[] {
  if (!urls?.length) return []
  // Fixed-length grids keep empty slots so photo-scratch indices stay aligned.
  if (urls.length >= PHOTO_SLOTS || urls.some((url) => !String(url ?? '').trim())) {
    return Array.from({ length: PHOTO_SLOTS }, (_, i) => {
      const url = urls[i]
      return typeof url === 'string' ? url.trim() : ''
    })
  }
  return urls
    .map((url) => (typeof url === 'string' ? url.trim() : ''))
    .filter(Boolean)
    .slice(0, PHOTO_SLOTS)
}

/**
 * Deterministic per-card photo fills.
 *
 * `filledOverride` is user-owned photo count (0–10). Catalog `photoUrls` are
 * previews only — without ownership they render locked (B&W + lock).
 *
 * Without an override, non-empty catalog URLs count as collected (demo decks).
 * The random placeholder path is only for demos with neither URLs nor override.
 */
export function buildPhotoSlotFills(
  cardKey: string,
  filledOverride?: number | null,
  photoUrls?: readonly string[] | null,
): PhotoSlotFill[] {
  const catalogUrls = normalizePhotoUrls(photoUrls)
  const hasOverride =
    typeof filledOverride === 'number' && Number.isFinite(filledOverride)
  const collectedCount = hasOverride
    ? Math.max(0, Math.min(PHOTO_SLOTS, Math.round(filledOverride)))
    : null

  if (catalogUrls.some(Boolean) || hasOverride) {
    return Array.from({ length: PHOTO_SLOTS }, (_, i) => {
      const preview = catalogUrls[i] || null
      const collected =
        collectedCount != null ? i < collectedCount : Boolean(preview)
      const src = collected
        ? preview || PHOTO_SLOT_IMAGE
        : preview
      return { src, collected }
    })
  }

  // Demo-only random fills when the API gave no progress and no previews.
  const rand = mulberry32(hashSeed(cardKey || 'photo-grid'))
  const fills: PhotoSlotFill[] = Array.from({ length: PHOTO_SLOTS }, () => ({
    src: null,
    collected: false,
  }))

  // ~70% of cards get at least one photo; others stay empty.
  if (rand() < 0.3) return fills

  const count = 1 + Math.floor(rand() * 4) // 1..4
  const indices = Array.from({ length: PHOTO_SLOTS }, (_, i) => i)
  // Fisher–Yates with seeded rng
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[indices[i], indices[j]] = [indices[j]!, indices[i]!]
  }

  for (let n = 0; n < count; n++) {
    const slot = indices[n]!
    fills[slot] = { src: PHOTO_SLOT_IMAGE, collected: true }
  }
  return fills
}

/** Count of collected photo slots for a motion card (0–PHOTO_SLOTS). */
export function getPhotoFilledCount(
  cardKey: string,
  filledOverride?: number | null,
  photoUrls?: readonly string[] | null,
): number {
  return buildPhotoSlotFills(cardKey, filledOverride, photoUrls).filter(
    (s) => s.collected,
  ).length
}

/**
 * Number of video cards available for a motion card.
 * Explicit override (including 0) always wins — never invent ownership.
 * Demo decks without an override still get a deterministic 1–2 play count.
 */
export function getVideoCardCount(
  cardKey: string,
  override?: number | null
): number {
  if (typeof override === 'number' && Number.isFinite(override)) {
    return Math.max(0, Math.min(5, Math.round(override)))
  }
  const rand = mulberry32(hashSeed(`video:${cardKey || 'card'}`))
  // Default demo cards always have at least one playable game.
  if (rand() < 0.75) return 1
  return 2
}
