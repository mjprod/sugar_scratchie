import type { CanvasItem } from '../types'
import { toDataUri } from './imageData'

export type ExportScope = 'single' | 'selected' | 'all'

export type ExportPlanItem = {
  item: CanvasItem
  fileName: string
  order: number
}

/** Prefer lane-chain numbers; fill gaps for unchained frames. Always unique names. */
export function buildExportPlan(
  items: CanvasItem[],
  chainOrder: Record<string, number>,
): ExportPlanItem[] {
  const withOrder = items
    .filter((item) => chainOrder[item.id] != null)
    .sort((a, b) => chainOrder[a.id]! - chainOrder[b.id]!)

  const without = items
    .filter((item) => chainOrder[item.id] == null)
    .sort((a, b) => a.x - b.x || a.y - b.y || a.zIndex - b.zIndex)

  const used = new Set<number>()
  const draft: { item: CanvasItem; order: number }[] = []

  for (const item of withOrder) {
    let order = chainOrder[item.id]!
    while (used.has(order)) order += 1
    used.add(order)
    draft.push({ item, order })
  }

  let next = 1
  for (const item of without) {
    while (used.has(next)) next += 1
    used.add(next)
    draft.push({ item, order: next })
    next += 1
  }

  return draft
    .sort((a, b) => a.order - b.order)
    .map(({ item, order }, index) => ({
      item,
      order,
      // Sequential index guarantees uniqueness even if orders collide.
      fileName: `${index + 1}.png`,
    }))
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image for export'))
    img.src = src
  })
}

const MAX_CANVAS_EDGE = 8192

/** Render source to PNG; optional high-quality 2× upscale. */
export async function rasterizeToPng(
  src: string,
  upscale: boolean,
  factor = 2,
): Promise<Blob> {
  const dataUri = await toDataUri(src)
  const img = await loadHtmlImage(dataUri)

  const scale = upscale ? factor : 1
  let width = Math.max(1, Math.round(img.naturalWidth * scale))
  let height = Math.max(1, Math.round(img.naturalHeight * scale))

  const longest = Math.max(width, height)
  if (longest > MAX_CANVAS_EDGE) {
    const clamp = MAX_CANVAS_EDGE / longest
    width = Math.max(1, Math.round(width * clamp))
    height = Math.max(1, Math.round(height * clamp))
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unsupported')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, width, height)

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  )
  if (!blob) throw new Error('PNG encode failed')
  return blob
}

type DirectoryHandle = {
  getFileHandle: (
    name: string,
    opts?: { create?: boolean },
  ) => Promise<{
    createWritable: () => Promise<{
      write: (data: BufferSource | Blob | string) => Promise<void>
      close: () => Promise<void>
    }>
  }>
}

function canPickDirectory(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

export async function pickExportDirectory(): Promise<DirectoryHandle | null> {
  if (!canPickDirectory()) return null
  try {
    // @ts-expect-error File System Access API
    const handle = (await window.showDirectoryPicker({
      mode: 'readwrite',
      startIn: 'downloads',
    })) as DirectoryHandle
    return handle
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    console.warn('showDirectoryPicker failed, falling back to download', err)
    return null
  }
}

async function writeBlobToDirectory(
  dir: DirectoryHandle,
  fileName: string,
  blob: Blob,
) {
  const file = await dir.getFileHandle(fileName, { create: true })
  const writable = await file.createWritable()
  await writable.write(blob)
  await writable.close()
}

function downloadBlob(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1500)
}

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2)
  b[0] = n & 0xff
  b[1] = (n >>> 8) & 0xff
  return b
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  b[0] = n & 0xff
  b[1] = (n >>> 8) & 0xff
  b[2] = (n >>> 16) & 0xff
  b[3] = (n >>> 24) & 0xff
  return b
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** Minimal ZIP (store / no compression) for multi-file download. */
export async function zipBlobs(
  files: { name: string; blob: Blob }[],
): Promise<Blob> {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name)
    const data = new Uint8Array(await file.blob.arrayBuffer())
    const crc = crc32(data)
    const localHeader = concatBytes([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
    ])
    localParts.push(localHeader, data)

    const central = concatBytes([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes,
    ])
    centralParts.push(central)
    offset += localHeader.length + data.length
  }

  const centralDir = concatBytes(centralParts)
  const end = concatBytes([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ])

  const bytes = concatBytes([...localParts, centralDir, end])
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Blob([copy], { type: 'application/zip' })
}

export type ExportResult = {
  written: number
  mode: 'folder' | 'download'
}

export class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled')
    this.name = 'ExportCancelledError'
  }
}

export async function exportImages(options: {
  plan: ExportPlanItem[]
  upscale: boolean
}): Promise<ExportResult> {
  const { plan, upscale } = options
  if (!plan.length) throw new Error('No images to export')

  let dir: DirectoryHandle | null = null
  try {
    dir = await pickExportDirectory()
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ExportCancelledError()
    }
    throw err
  }

  const rendered: { name: string; blob: Blob }[] = []
  for (const entry of plan) {
    const blob = await rasterizeToPng(entry.item.src, upscale)
    rendered.push({ name: entry.fileName, blob })
  }

  if (dir) {
    for (const file of rendered) {
      await writeBlobToDirectory(dir, file.name, file.blob)
    }
    return { written: rendered.length, mode: 'folder' }
  }

  // One download avoids browser multi-download blockers.
  if (rendered.length === 1) {
    downloadBlob(rendered[0].name, rendered[0].blob)
  } else {
    const zip = await zipBlobs(rendered)
    downloadBlob(`mxj-export-${rendered.length}.zip`, zip)
  }
  return { written: rendered.length, mode: 'download' }
}
