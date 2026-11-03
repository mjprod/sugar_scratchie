/** Named reusable assets (characters / products / styles) for @名稱 mentions. */

export type AssetKind = 'character' | 'product' | 'style'

export type Asset = {
  id: string
  name: string
  kind: AssetKind
  /** Data URIs; first image is the primary reference sent to the API. */
  images: string[]
  note?: string
}

export const ASSET_KINDS: { value: AssetKind; label: string }[] = [
  { value: 'character', label: 'Person' },
  { value: 'product', label: 'Product' },
  { value: 'style', label: 'Style' },
]

// ---------------------------------------------------------------------------
// Persistence — IndexedDB (data URIs are too large for localStorage)
// ---------------------------------------------------------------------------

const DB_NAME = 'sugar-dress'
const STORE = 'assets'
const KEY = 'all'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

export async function loadAssets(): Promise<Asset[]> {
  try {
    const db = await openDb()
    const rows = await new Promise<Asset[]>((resolve) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(KEY)
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : [])
      req.onerror = () => resolve([])
    })
    const named = rows.map((asset) => {
      const auto = asset.name.match(/^上傳(\d+)$/)
      return auto ? { ...asset, name: `Upload ${auto[1]}` } : asset
    })
    if (named.some((asset, i) => asset.name !== rows[i].name)) {
      void saveAssets(named).catch(() => {})
    }
    return named
  } catch {
    return []
  }
}

export async function saveAssets(assets: Asset[]): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(assets, KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'))
  })
}

/** Append new images to the upload library. Skips srcs already stored. */
export function appendImageAssets(assets: Asset[], srcs: string[]): Asset[] {
  const extra = srcs.filter(
    (src) => src && !assets.some((a) => a.images.includes(src)),
  )
  if (!extra.length) return assets
  const next = [...assets]
  for (const src of extra) {
    let n = next.length + 1
    let name = `Upload ${n}`
    while (next.some((a) => a.name === name)) {
      n += 1
      name = `Upload ${n}`
    }
    next.push({
      id: crypto.randomUUID(),
      name,
      kind: 'character',
      images: [src],
    })
  }
  return next
}

// ---------------------------------------------------------------------------
// @名稱 mention resolution
// ---------------------------------------------------------------------------

export type AssetMentionResult = {
  /** Prompt with @名稱 rewritten to <IMAGE_i> */
  apiPrompt: string
  /** Primary image per mentioned asset, in first-appearance order */
  images: string[]
  /** Names actually matched */
  used: string[]
}

/**
 * Replace `@資產名` tokens with <IMAGE_i>, collecting each asset's primary
 * image. Longest names match first so 「主角A2」 wins over 「主角A」.
 * Numeric @1/@2 mentions are left untouched (handled by resolveReferences).
 */
export function resolveAssetMentions(
  prompt: string,
  assets: Asset[],
  indexOffset = 0,
): AssetMentionResult {
  const named = assets.filter((a) => a.name.trim() && a.images.length > 0)
  if (!named.length) return { apiPrompt: prompt, images: [], used: [] }

  // First-appearance order in the prompt, longest name wins on overlap
  const sorted = [...named].sort((a, b) => b.name.length - a.name.length)
  const hits: { asset: Asset; pos: number }[] = []
  for (const asset of sorted) {
    const token = `@${asset.name}`
    const pos = prompt.indexOf(token)
    if (pos >= 0 && !hits.some((h) => h.asset.id === asset.id)) {
      hits.push({ asset, pos })
    }
  }
  if (!hits.length) return { apiPrompt: prompt, images: [], used: [] }

  hits.sort((a, b) => a.pos - b.pos)

  let apiPrompt = prompt
  const images: string[] = []
  const used: string[] = []
  hits.forEach(({ asset }, i) => {
    apiPrompt = apiPrompt.split(`@${asset.name}`).join(`<IMAGE_${indexOffset + i}>`)
    images.push(asset.images[0])
    used.push(asset.name)
  })

  return { apiPrompt, images, used }
}
