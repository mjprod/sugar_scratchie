import { dressFetch } from '../lib/dressApi'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import {
  DEFAULT_CAMERA,
  cameraTransform,
  distance,
  midpoint,
  panBy,
  screenToWorld,
  zoomAt,
  zoomByFactor,
  type Camera,
  type Point,
} from '../lib/camera'
import type { CanvasItem, GenMeta, InteractionMode } from '../types'
import { toDataUri } from '../lib/imageData'
import type { ImageMode, PromptSubmitPayload, SelectionRef } from '../lib/promptRefs'
import {
  clearOutgoing,
  computeChainOrder,
  disconnectNodes,
  isLinked,
  linkChain,
  listChainEdges,
  nearestSide,
  portPoint,
  removeFromChain,
  CHAIN_PORT_GAP_PX,
  type ChainMap,
  type Side,
} from '../lib/laneChain'
import {
  buildExportPlan,
  exportImages,
  type ExportScope,
} from '../lib/exportImages'
import { LIBRARY_ADD_EVENT, noteLibraryLanded, readLibraryDrag } from './AssetPanel'
import { CanvasChrome } from './CanvasChrome'
import { CanvasImage } from './CanvasImage'
import { ChainOverlay } from './ChainOverlay'
import { autoBikiniPrompt, cosplayPrompt, dressEditPrompt, pickBikinis, pickCosplay, wornClothingPhoto } from '../lib/dressEdit'
import { flattenOnWhite, isOpaque, loadImage } from '../lib/extractFrame'
import { useCrop916 } from './ExtractPopup'
import { RegenerateDialog } from './RegenerateDialog'
import { StudioDock } from './StudioDock'
import {
  appendImageAssets,
  loadAssets,
  saveAssets,
  type Asset,
} from '../lib/assets'
import { buildRegenPrompt, promptFromCaption } from '../lib/regenPrompt'
import {
  NO_ONSCREEN_TEXT,
  VIDEO_AUDIO_DEFAULT,
  imageProviderLabel,
  loadGenProvider,
  loadImageProvider,
  providerLabel,
  saveGenProvider,
  saveImageProvider,
  type GenProvider,
  type ImageProvider,
} from '../lib/genProvider'

function useGenProviderState(): [GenProvider, (provider: GenProvider) => void] {
  const [provider, setProvider] = useState<GenProvider>(() => loadGenProvider())
  useEffect(() => {
    saveGenProvider(provider)
  }, [provider])
  return [provider, setProvider]
}

function useImageProviderState(): [ImageProvider, (provider: ImageProvider) => void] {
  const [provider, setProvider] = useState<ImageProvider>(() => loadImageProvider())
  useEffect(() => {
    saveImageProvider(provider)
  }, [provider])
  return [provider, setProvider]
}

const GRID_BASE = 40
const ZOOM_STEP = 1.15

/** Layout size on the infinite canvas (world units ≈ CSS px at scale 1).
 * Keep this high enough that camera zoom doesn't upscale a tiny raster —
 * browsers paint `<img>` at layout size, then CSS `transform` scales that bitmap. */
function fitCanvasSize(w: number, h: number) {
  const maxEdge = 1400
  const ratio = Math.min(maxEdge / w, maxEdge / h, 1)
  return {
    width: Math.round(w * ratio),
    height: Math.round(h * ratio),
  }
}

function loadImageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () =>
      resolve(fitCanvasSize(img.naturalWidth, img.naturalHeight))
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = src
  })
}

function loadVideoSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true
    video.onloadedmetadata = () => {
      const w = video.videoWidth || 1280
      const h = video.videoHeight || 720
      resolve(fitCanvasSize(w, h))
    }
    video.onerror = () => reject(new Error('Failed to load video'))
    video.src = src
  })
}

/** Drop a wearer from a worn photo. A product shot is kept whole, so the collar and badges stay. */
async function clothingWithoutWearer(src: string): Promise<string> {
  const img = await loadImage(src)
  const sample = document.createElement('canvas')
  sample.width = 48
  sample.height = Math.max(1, Math.round((48 * img.height) / img.width))
  const ctx = sample.getContext('2d', { willReadFrequently: true })
  if (!ctx) return src
  ctx.drawImage(img, 0, 0, sample.width, sample.height)
  if (!wornClothingPhoto(ctx.getImageData(0, 0, sample.width, sample.height).data)) return src
  try {
    const res = await dressFetch('/extract-clothes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src }),
    })
    if (!res.ok) return src
    const data = (await res.json()) as { src?: string }
    return data.src ? flattenOnWhite(data.src) : src
  } catch {
    return src
  }
}

export function InfiniteCanvas() {
  const viewportRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const cameraRef = useRef<Camera>({ ...DEFAULT_CAMERA })
  const [scaleUi, setScaleUi] = useState(DEFAULT_CAMERA.scale)
  const [mode, setMode] = useState<InteractionMode>('select')
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [items, setItems] = useState<CanvasItem[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectedEdgeFromId, setSelectedEdgeFromId] = useState<string | null>(
    null,
  )
  const [marquee, setMarquee] = useState<{
    x1: number
    y1: number
    x2: number
    y2: number
  } | null>(null)
  const [chainMap, setChainMap] = useState<ChainMap>({})
  const [chainPreview, setChainPreview] = useState<{
    x1: number
    y1: number
    x2: number
    y2: number
    fromSide: Side
  } | null>(null)
  const [chainHoverId, setChainHoverId] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [generatingKind, setGeneratingKind] = useState<'image' | 'video' | null>(null)
  /** Refcount so overlapping dress/pose/gen jobs don't clear the busy overlay early. */
  const genJobsRef = useRef(0)
  const beginGen = useCallback((kind?: 'image' | 'video') => {
    genJobsRef.current += 1
    if (kind) setGeneratingKind(kind)
    setGenerating(true)
  }, [])
  const endGen = useCallback(() => {
    genJobsRef.current = Math.max(0, genJobsRef.current - 1)
    if (genJobsRef.current === 0) {
      setGenerating(false)
      setGeneratingKind(null)
    }
  }, [])
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  /** Item id whose regenerate dialog is open */
  const [regenId, setRegenId] = useState<string | null>(null)
  const [videoProvider, setVideoProvider] = useGenProviderState()
  const videoProviderRef = useRef(videoProvider)
  videoProviderRef.current = videoProvider
  const [imageProvider, setImageProvider] = useImageProviderState()
  const imageProviderRef = useRef(imageProvider)
  imageProviderRef.current = imageProvider
  const [imageMode, setImageMode] = useState<ImageMode>('720')
  const imageModeRef = useRef(imageMode)
  imageModeRef.current = imageMode
  const chainDrag = useRef<{ fromId: string; fromSide: Side } | null>(null)
  const chainListeners = useRef<{
    move: (e: PointerEvent) => void
    up: (e: PointerEvent) => void
  } | null>(null)
  const dragOrigins = useRef<Record<string, { x: number; y: number }>>({})
  const marqueeSession = useRef<{
    pointerId: number
    startX: number
    startY: number
    additive: boolean
  } | null>(null)
  const marqueeRef = useRef(marquee)
  marqueeRef.current = marquee
  const selectedIdsRef = useRef(selectedIds)
  selectedIdsRef.current = selectedIds
  const selectedEdgeRef = useRef(selectedEdgeFromId)
  selectedEdgeRef.current = selectedEdgeFromId
  const itemsRef = useRef(items)
  itemsRef.current = items

  const panSession = useRef<{
    pointerId: number
    lastX: number
    lastY: number
  } | null>(null)

  const pinchSession = useRef<{
    pointers: Map<number, Point>
    lastDistance: number
    lastMidpoint: Point
  } | null>(null)

  const zCounter = useRef(1)

  useEffect(() => {
    void loadAssets().then(setAssets)
  }, [])

  const updateAssets = useCallback((next: Asset[]) => {
    setAssets(next)
    void saveAssets(next).catch((err) =>
      console.error('Asset save failed', err),
    )
  }, [])

  useEffect(() => {
    const onLibraryAdd = (e: Event) => {
      const srcs = (e as CustomEvent<{ srcs?: string[] }>).detail?.srcs
      if (!srcs?.length) return
      setAssets((prev) => {
        const next = appendImageAssets(prev, srcs)
        if (next !== prev) {
          void saveAssets(next).catch((err) =>
            console.error('Asset save failed', err),
          )
        }
        return next
      })
    }
    window.addEventListener(LIBRARY_ADD_EVENT, onLibraryAdd)
    return () => window.removeEventListener(LIBRARY_ADD_EVENT, onLibraryAdd)
  }, [])

  const applyCamera = useCallback((next: Camera) => {
    const prevScale = cameraRef.current.scale
    cameraRef.current = next
    const world = worldRef.current
    const grid = gridRef.current
    if (world) {
      world.style.transform = cameraTransform(next)
    }
    if (grid) {
      const size = GRID_BASE * next.scale
      grid.style.backgroundSize = `${size}px ${size}px`
      grid.style.backgroundPosition = `${next.x}px ${next.y}px`
    }
    // Only re-render chrome when zoom changes — pan updates the DOM directly
    if (prevScale !== next.scale) {
      setScaleUi(next.scale)
    }
  }, [])

  const getViewportPoint = useCallback(
    (clientX: number, clientY: number): Point => {
      const rect = viewportRef.current!.getBoundingClientRect()
      return {
        x: clientX - rect.left,
        y: clientY - rect.top,
      }
    },
    [],
  )

  const getViewportCenter = useCallback((): Point => {
    const el = viewportRef.current
    if (!el) return { x: 0, y: 0 }
    return { x: el.clientWidth / 2, y: el.clientHeight / 2 }
  }, [])

  const getScale = useCallback(() => cameraRef.current.scale, [])

  const zoomToward = useCallback(
    (anchor: Point, factor: number) => {
      applyCamera(zoomByFactor(cameraRef.current, anchor, factor))
    },
    [applyCamera],
  )

  const resetView = useCallback(() => {
    applyCamera({ ...DEFAULT_CAMERA })
  }, [applyCamera])

  const { ask: askCrop, popup: cropPopup } = useCrop916()

  const addMediaFromSrc = useCallback(
    async (
      src: string,
      placement:
        | { kind: 'screen'; screen: Point }
        | { kind: 'world'; x: number; y: number },
      mediaKind: 'image' | 'video' = 'image',
      extra?: Partial<Pick<CanvasItem, 'caption' | 'genMeta' | 'opacity'>>,
    ): Promise<CanvasItem> => {
      const size =
        mediaKind === 'video'
          ? await loadVideoSize(src)
          : await loadImageSize(src)
      let x: number
      let y: number
      if (placement.kind === 'screen') {
        const world = screenToWorld(placement.screen, cameraRef.current)
        x = world.x - size.width / 2
        y = world.y - size.height / 2
      } else {
        x = placement.x
        y = placement.y
      }
      zCounter.current += 1
      const item: CanvasItem = {
        id: crypto.randomUUID(),
        src,
        kind: mediaKind,
        x,
        y,
        width: size.width,
        height: size.height,
        zIndex: zCounter.current,
        ...extra,
      }
      setItems((prev) => [...prev, item])
      setSelectedIds([item.id])
      setSelectedEdgeFromId(null)
      return item
    },
    [],
  )

  const addImagesAtScreen = useCallback(
    async (files: FileList | File[], screen: Point) => {
      const list = Array.from(files).filter((f) => f.type.startsWith('image/'))
      if (!list.length) return
      for (let i = 0; i < list.length; i++) {
        const file = list[i]
        const blob = URL.createObjectURL(file)
        try {
          const raw = await toDataUri(blob)
          const cropped = await askCrop(raw)
          if (!cropped) continue
          await addMediaFromSrc(cropped, {
            kind: 'screen',
            screen: { x: screen.x + i * 28, y: screen.y + i * 28 },
          })
        } catch {
          /* unreadable file */
        } finally {
          URL.revokeObjectURL(blob)
        }
      }
    },
    [addMediaFromSrc, askCrop],
  )

  /** Mark a generated item as Made-from its source on the chain. */
  const linkMade = useCallback((fromId: string | null | undefined, toId: string) => {
    if (!fromId || fromId === toId) return
    setChainMap((prev) => linkChain(prev, fromId, toId, 'right', 'left', 'made'))
  }, [])

  const findIdBySrc = useCallback((src: string | null | undefined) => {
    if (!src) return null
    return itemsRef.current.find((it) => it.src === src)?.id ?? null
  }, [])

  const generateFromPrompt = useCallback(
    async (payload: PromptSubmitPayload) => {
      beginGen(payload.mediaKind === 'video' ? 'video' : 'image')
      setGenerateError(null)
      try {
        const selectedSingle =
          selectedIds.length === 1
            ? items.find((item) => item.id === selectedIds[0]) ?? null
            : null
        const selectedImage =
          selectedSingle?.kind === 'video' ? null : selectedSingle

        let images = payload.images
        let prompt = payload.prompt

        if (images.length) {
          images = await Promise.all(images.map((src) => toDataUri(src)))
        } else if (selectedImage && payload.mediaKind === 'image') {
          images = [await toDataUri(selectedImage.src)]
        } else if (selectedImage && payload.mediaKind === 'video') {
          images = [await toDataUri(selectedImage.src)]
        }

        if (payload.mediaKind === 'video') {
          const startFrame = payload.startFrame
            ? await toDataUri(payload.startFrame)
            : images[0] ?? null
          const startSourceId =
            findIdBySrc(payload.startFrame) ??
            (selectedIds.length === 1 ? selectedIds[0] : null)

          const res = await dressFetch('/generate-video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt,
              aspect_ratio: payload.aspectRatio,
              duration: payload.duration ?? 6,
              resolution: payload.resolution ?? '720p',
              provider: videoProviderRef.current,
              ...(startFrame ? { start_image: startFrame } : {}),
            }),
          })
          const data = (await res.json()) as {
            src?: string
            lastFrame?: string | null
            error?: string
          }
          if (!res.ok || !data.src) {
            throw new Error(data.error || 'Video generation failed')
          }
          const sourceItem = startSourceId
            ? itemsRef.current.find((it) => it.id === startSourceId)
            : null
          const videoItem = await addMediaFromSrc(
            data.src,
            sourceItem
              ? {
                  kind: 'world',
                  x: sourceItem.x + sourceItem.width + 36,
                  y: sourceItem.y,
                }
              : {
                  kind: 'screen',
                  screen: getViewportCenter(),
                },
            'video',
            {
              genMeta: {
                mediaKind: 'video',
                prompt,
                startSrc: startFrame ?? undefined,
                aspect: payload.aspectRatio,
                duration: payload.duration ?? 6,
                resolution: payload.resolution ?? '720p',
              },
            },
          )
          linkMade(startSourceId, videoItem.id)
          // Place last-frame still to the right of the video
          if (data.lastFrame) {
            const lastStill = await addMediaFromSrc(
              data.lastFrame,
              {
                kind: 'world',
                x: videoItem.x + videoItem.width + 48,
                y: videoItem.y,
              },
              'image',
            )
            linkMade(videoItem.id, lastStill.id)
          }
          return
        }

        const imageMode = imageModeRef.current
        const colorMatch = payload.colorMatch
          ? await toDataUri(payload.colorMatch)
          : undefined
        const bodyMatch = payload.bodyMatch
          ? await toDataUri(payload.bodyMatch)
          : undefined
        const clothAt = payload.clothingIndex
        if (clothAt != null && images[clothAt]) {
          images = images.slice()
          images[clothAt] = await clothingWithoutWearer(images[clothAt])
        }
        const sourceRefs = images.slice()
        const res = await dressFetch('/generate-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            images.length
              ? {
                  prompt,
                  images,
                  aspect_ratio: payload.aspectRatio,
                  image_mode: imageMode,
                  provider: imageProviderRef.current,
                  ...(colorMatch ? { color_match: colorMatch } : {}),
                  ...(bodyMatch ? { body_match: bodyMatch } : {}),
                  ...(payload.clothingIndex != null
                    ? { clothing_index: payload.clothingIndex }
                    : {}),
                  ...(payload.poseIndex != null ? { pose_index: payload.poseIndex } : {}),
                }
              : {
                  prompt,
                  aspect_ratio: payload.aspectRatio,
                  image_mode: imageMode,
                  provider: imageProviderRef.current,
                  ...(colorMatch ? { color_match: colorMatch } : {}),
                  ...(bodyMatch ? { body_match: bodyMatch } : {}),
                  ...(payload.clothingIndex != null
                    ? { clothing_index: payload.clothingIndex }
                    : {}),
                  ...(payload.poseIndex != null ? { pose_index: payload.poseIndex } : {}),
                },
          ),
        })
        const data = (await res.json()) as { src?: string; error?: string }
        if (!res.ok || !data.src) {
          throw new Error(data.error || 'Generation failed')
        }
        const placed = data.src

        const imageGenMeta = {
          genMeta: {
            mediaKind: 'image' as const,
            prompt,
            refs: sourceRefs.length ? sourceRefs : undefined,
            aspect: payload.aspectRatio,
            imageMode,
          },
        }
        const sourceId =
          selectedImage?.id ??
          (payload.images[0] ? findIdBySrc(payload.images[0]) : null) ??
          (selectedIds.length === 1 ? selectedIds[0] : null)

        const created =
          selectedImage && payload.images.length === 0
            ? await addMediaFromSrc(
                placed,
                {
                  kind: 'world',
                  x: selectedImage.x + selectedImage.width + 36,
                  y: selectedImage.y,
                },
                'image',
                imageGenMeta,
              )
            : await addMediaFromSrc(
                placed,
                {
                  kind: 'screen',
                  screen: getViewportCenter(),
                },
                'image',
                imageGenMeta,
              )
        linkMade(sourceId, created.id)
      } catch (err) {
        setGenerateError(err instanceof Error ? err.message : 'Generation failed')
      } finally {
        endGen()
      }
    },
    [addMediaFromSrc, findIdBySrc, getViewportCenter, items, linkMade, selectedIds],
  )

  const handleWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      e.preventDefault()
      const anchor = getViewportPoint(e.clientX, e.clientY)

      // Pinch-zoom on trackpads reports ctrlKey; ⌘/Ctrl+wheel also zoom
      const isZoom = e.ctrlKey || e.metaKey
      if (isZoom) {
        const intensity = e.deltaMode === 1 ? 0.05 : 0.0022
        const factor = Math.exp(-e.deltaY * intensity)
        zoomToward(anchor, factor)
        return
      }

      applyCamera(
        panBy(cameraRef.current, {
          x: -e.deltaX,
          y: -e.deltaY,
        }),
      )
    },
    [applyCamera, getViewportPoint, zoomToward],
  )

  const panModeActive = mode === 'pan' || spaceHeld

  const beginPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return
    e.currentTarget.setPointerCapture(e.pointerId)
    panSession.current = {
      pointerId: e.pointerId,
      lastX: e.clientX,
      lastY: e.clientY,
    }
    setIsPanning(true)
  }

  const clearSelection = useCallback(() => {
    setSelectedIds([])
    setSelectedEdgeFromId(null)
  }, [])

  const beginMarquee = (
    e: ReactPointerEvent<HTMLDivElement>,
    additive: boolean,
  ) => {
    const pt = getViewportPoint(e.clientX, e.clientY)
    e.currentTarget.setPointerCapture(e.pointerId)
    marqueeSession.current = {
      pointerId: e.pointerId,
      startX: pt.x,
      startY: pt.y,
      additive,
    }
    setMarquee({ x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y })
    setSelectedEdgeFromId(null)
    if (!additive) setSelectedIds([])
  }

  const onViewportPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') {
      const pt = getViewportPoint(e.clientX, e.clientY)
      if (!pinchSession.current) {
        pinchSession.current = {
          pointers: new Map(),
          lastDistance: 0,
          lastMidpoint: pt,
        }
      }
      pinchSession.current.pointers.set(e.pointerId, pt)
      e.currentTarget.setPointerCapture(e.pointerId)

      if (pinchSession.current.pointers.size === 2) {
        const pts = [...pinchSession.current.pointers.values()]
        pinchSession.current.lastDistance = distance(pts[0], pts[1])
        pinchSession.current.lastMidpoint = midpoint(pts[0], pts[1])
        panSession.current = null
        marqueeSession.current = null
        setMarquee(null)
        setIsPanning(true)
      } else if (pinchSession.current.pointers.size === 1 && panModeActive) {
        beginPan(e)
      } else if (!panModeActive) {
        beginMarquee(e, false)
      }
      return
    }

    if (e.button === 1 || panModeActive) {
      e.preventDefault()
      beginPan(e)
      return
    }

    if (e.button === 0) {
      beginMarquee(e, e.shiftKey || e.metaKey || e.ctrlKey)
    }
  }

  const onViewportPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const pinch = pinchSession.current
    if (pinch?.pointers.has(e.pointerId)) {
      pinch.pointers.set(e.pointerId, getViewportPoint(e.clientX, e.clientY))

      if (pinch.pointers.size >= 2) {
        const pts = [...pinch.pointers.values()]
        const mid = midpoint(pts[0], pts[1])
        const dist = distance(pts[0], pts[1])

        const panDelta = {
          x: mid.x - pinch.lastMidpoint.x,
          y: mid.y - pinch.lastMidpoint.y,
        }
        let cam = panBy(cameraRef.current, panDelta)

        if (pinch.lastDistance > 0) {
          const factor = dist / pinch.lastDistance
          cam = zoomAt(cam, mid, cam.scale * factor)
        }

        pinch.lastDistance = dist
        pinch.lastMidpoint = mid
        applyCamera(cam)
        return
      }
    }

    const box = marqueeSession.current
    if (box && box.pointerId === e.pointerId) {
      const pt = getViewportPoint(e.clientX, e.clientY)
      setMarquee({
        x1: box.startX,
        y1: box.startY,
        x2: pt.x,
        y2: pt.y,
      })
      return
    }

    const pan = panSession.current
    if (!pan || pan.pointerId !== e.pointerId) return
    const dx = e.clientX - pan.lastX
    const dy = e.clientY - pan.lastY
    pan.lastX = e.clientX
    pan.lastY = e.clientY
    applyCamera(panBy(cameraRef.current, { x: dx, y: dy }))
  }

  const finishMarquee = useCallback(() => {
    const session = marqueeSession.current
    const rect = marqueeRef.current
    marqueeSession.current = null
    setMarquee(null)
    if (!session || !rect) return

    const w = Math.abs(rect.x2 - rect.x1)
    const h = Math.abs(rect.y2 - rect.y1)
    if (w < 4 && h < 4) {
      if (!session.additive) clearSelection()
      return
    }

    const cam = cameraRef.current
    const left = Math.min(rect.x1, rect.x2)
    const right = Math.max(rect.x1, rect.x2)
    const top = Math.min(rect.y1, rect.y2)
    const bottom = Math.max(rect.y1, rect.y2)
    const tl = screenToWorld({ x: left, y: top }, cam)
    const br = screenToWorld({ x: right, y: bottom }, cam)
    const wx1 = Math.min(tl.x, br.x)
    const wx2 = Math.max(tl.x, br.x)
    const wy1 = Math.min(tl.y, br.y)
    const wy2 = Math.max(tl.y, br.y)

    const hit = itemsRef.current
      .filter(
        (item) =>
          item.x < wx2 &&
          item.x + item.width > wx1 &&
          item.y < wy2 &&
          item.y + item.height > wy1,
      )
      .map((item) => item.id)

    setSelectedEdgeFromId(null)
    setSelectedIds((prev) => {
      if (!session.additive) return hit
      const set = new Set(prev)
      hit.forEach((id) => set.add(id))
      return [...set]
    })
  }, [clearSelection])

  const endPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (marqueeSession.current?.pointerId === e.pointerId) {
      finishMarquee()
    }

    const pinch = pinchSession.current
    if (pinch?.pointers.has(e.pointerId)) {
      pinch.pointers.delete(e.pointerId)
      if (pinch.pointers.size < 2) {
        pinch.lastDistance = 0
        if (pinch.pointers.size === 0) {
          pinchSession.current = null
          setIsPanning(false)
        } else {
          const remaining = [...pinch.pointers.values()][0]
          pinch.lastMidpoint = remaining
        }
      }
    }

    if (panSession.current?.pointerId === e.pointerId) {
      panSession.current = null
      if (!pinchSession.current || pinchSession.current.pointers.size < 2) {
        setIsPanning(false)
      }
    }

    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragOver(false)
    const screen = getViewportPoint(e.clientX, e.clientY)
    const dragged = readLibraryDrag()
    if (dragged) {
      noteLibraryLanded()
      if (dragged.kind === 'video') {
        await addMediaFromSrc(dragged.src, { kind: 'screen', screen }, dragged.kind)
        return
      }
      try {
        const cropped = await askCrop(await toDataUri(dragged.src))
        if (cropped) await addMediaFromSrc(cropped, { kind: 'screen', screen })
      } catch {
        setGenerateError('This image is not on the canvas')
      }
      return
    }
    await addImagesAtScreen(e.dataTransfer.files, screen)
  }

  const onItemMove = useCallback((_id: string, dx: number, dy: number) => {
    const origins = dragOrigins.current
    if (!Object.keys(origins).length) return
    setItems((prev) =>
      prev.map((item) => {
        const origin = origins[item.id]
        if (!origin) return item
        return { ...item, x: origin.x + dx, y: origin.y + dy }
      }),
    )
  }, [])

  const onItemDragStart = useCallback((id: string) => {
    const selected = selectedIdsRef.current
    const moving = selected.includes(id) ? selected : [id]
    const origins: Record<string, { x: number; y: number }> = {}
    for (const item of itemsRef.current) {
      if (moving.includes(item.id)) {
        origins[item.id] = { x: item.x, y: item.y }
      }
    }
    dragOrigins.current = origins
  }, [])

  const onItemSelect = useCallback(
    (id: string, opts?: { additive?: boolean }) => {
      setSelectedEdgeFromId(null)
      setSelectedIds((prev) => {
        let next: string[]
        if (opts?.additive) {
          next = prev.includes(id)
            ? prev.filter((x) => x !== id)
            : [...prev, id]
        } else if (prev.includes(id)) {
          next = prev
        } else {
          next = [id]
        }
        selectedIdsRef.current = next
        return next
      })
      setItems((prev) => {
        const maxZ = prev.reduce((m, it) => Math.max(m, it.zIndex), 0)
        return prev.map((item) =>
          item.id === id ? { ...item, zIndex: maxZ + 1 } : item,
        )
      })
      zCounter.current += 1
    },
    [],
  )

  const onItemOpacity = useCallback((id: string, opacity: number) => {
    const next = Math.min(1, Math.max(0, opacity))
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, opacity: next } : item)),
    )
  }, [])

  const onItemDelete = useCallback((id: string) => {
    setItems((prev) => {
      const target = prev.find((item) => item.id === id)
      if (target?.src.startsWith('blob:')) {
        URL.revokeObjectURL(target.src)
      }
      return prev.filter((item) => item.id !== id)
    })
    setChainMap((prev) => removeFromChain(prev, id))
    setSelectedIds((current) => current.filter((x) => x !== id))
    setSelectedEdgeFromId((edge) => (edge === id ? null : edge))
  }, [])

  const onSelectEdge = useCallback((fromId: string) => {
    setSelectedIds([])
    setSelectedEdgeFromId(fromId)
  }, [])

  const hitTestItem = useCallback(
    (clientX: number, clientY: number, excludeId?: string) => {
      const cam = cameraRef.current
      const world = screenToWorld(getViewportPoint(clientX, clientY), cam)
      // Include port halo so dropping on / near connection dots still hits.
      const pad =
        CHAIN_PORT_GAP_PX / Math.max(cam.scale, 0.001) +
        28 / Math.max(cam.scale, 0.001)

      const sorted = [...itemsRef.current].sort((a, b) => b.zIndex - a.zIndex)
      for (const item of sorted) {
        if (item.id === excludeId) continue
        if (
          world.x >= item.x - pad &&
          world.x <= item.x + item.width + pad &&
          world.y >= item.y - pad &&
          world.y <= item.y + item.height + pad
        ) {
          return item
        }
      }
      return null
    },
    [getViewportPoint],
  )

  const stopChainListeners = useCallback(() => {
    const listeners = chainListeners.current
    if (!listeners) return
    window.removeEventListener('pointermove', listeners.move)
    window.removeEventListener('pointerup', listeners.up)
    window.removeEventListener('pointercancel', listeners.up)
    chainListeners.current = null
  }, [])

  const onChainDragStart = useCallback(
    (id: string, side: Side, clientX: number, clientY: number) => {
      const item = itemsRef.current.find((it) => it.id === id)
      if (!item) return

      stopChainListeners()
      chainDrag.current = { fromId: id, fromSide: side }

      const updatePreview = (x: number, y: number) => {
        const session = chainDrag.current
        if (!session) return
        const from = itemsRef.current.find((it) => it.id === session.fromId)
        if (!from) return
        const gap = CHAIN_PORT_GAP_PX / Math.max(cameraRef.current.scale, 0.001)
        const origin = portPoint(from, session.fromSide, gap)
        const cursor = screenToWorld(
          getViewportPoint(x, y),
          cameraRef.current,
        )
        setChainPreview({
          x1: origin.x,
          y1: origin.y,
          x2: cursor.x,
          y2: cursor.y,
          fromSide: session.fromSide,
        })
        const hit = hitTestItem(x, y, session.fromId)
        setChainHoverId(hit?.id ?? null)
      }

      updatePreview(clientX, clientY)

      const onMove = (e: PointerEvent) => {
        e.preventDefault()
        updatePreview(e.clientX, e.clientY)
      }

      const onUp = (e: PointerEvent) => {
        stopChainListeners()
        const session = chainDrag.current
        chainDrag.current = null
        setChainPreview(null)
        setChainHoverId(null)
        if (!session) return

        // Only link on a valid hit — never clear existing edges on a miss
        // (that made failed drags look like the line “disappeared”).
        const hit = hitTestItem(e.clientX, e.clientY, session.fromId)
        if (!hit) return

        const gap = CHAIN_PORT_GAP_PX / Math.max(cameraRef.current.scale, 0.001)
        const cursor = screenToWorld(
          getViewportPoint(e.clientX, e.clientY),
          cameraRef.current,
        )
        const toSide = nearestSide(hit, cursor, gap)
        setChainMap((prev) =>
          linkChain(prev, session.fromId, hit.id, session.fromSide, toSide),
        )
        setSelectedIds([hit.id])
        selectedIdsRef.current = [hit.id]
        setSelectedEdgeFromId(null)
      }

      chainListeners.current = { move: onMove, up: onUp }
      window.addEventListener('pointermove', onMove, { passive: false })
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [getViewportPoint, hitTestItem, stopChainListeners],
  )

  useEffect(() => () => stopChainListeners(), [stopChainListeners])

  const onItemDisconnect = useCallback((id: string) => {
    setChainMap((prev) => disconnectNodes(prev, [id]))
    setSelectedEdgeFromId(null)
  }, [])

  const onDisconnectSelection = useCallback(() => {
    const ids = selectedIdsRef.current
    if (!ids.length) return
    setChainMap((prev) => disconnectNodes(prev, ids))
    setSelectedEdgeFromId(null)
  }, [])

  const chainOrder = computeChainOrder(
    chainMap,
    items.map((item) => item.id),
  )
  const chainEdges = listChainEdges(
    chainMap,
    items.map((item) => item.id),
  )

  const handleExport = useCallback(
    async (scope: ExportScope, upscale: boolean) => {
      setExportBusy(true)
      setExportMessage(null)
      try {
        // Snapshot selection at click time (refs stay fresh across async gaps).
        const ids = [...selectedIdsRef.current]
        let target = items
        if (scope === 'single') {
          if (ids.length !== 1) {
            throw new Error('Select exactly one image for single export')
          }
          target = items.filter((item) => item.id === ids[0])
        } else if (scope === 'selected') {
          if (!ids.length) {
            throw new Error('Select at least one image')
          }
          const idSet = new Set(ids)
          target = items.filter((item) => idSet.has(item.id))
        }

        if (!target.length) {
          throw new Error('No images to export')
        }

        const exportable = target.filter((item) => item.kind !== 'video')
        if (!exportable.length) {
          throw new Error('Selected items are videos — PNG export supports images only')
        }
        const plan = buildExportPlan(exportable, chainOrder)
        const result = await exportImages({ plan, upscale })
        setExportMessage(
          result.mode === 'folder'
            ? `Exported ${result.written} file${result.written === 1 ? '' : 's'} to folder${upscale ? ' (2×)' : ''}`
            : result.written === 1
              ? `Downloaded 1 file${upscale ? ' (2×)' : ''}`
              : `Downloaded zip with ${result.written} files${upscale ? ' (2×)' : ''}`,
        )
      } catch (err) {
        if (
          (err instanceof DOMException && err.name === 'AbortError') ||
          (err instanceof Error && err.name === 'ExportCancelledError')
        ) {
          setExportMessage(null)
        } else {
          setExportMessage(
            err instanceof Error ? err.message : 'Export failed',
          )
        }
      } finally {
        setExportBusy(false)
      }
    },
    [chainOrder, items],
  )

  /**
   * Re-run generation for an existing generated item in place: same spot,
   * new prompt/script (and optional change note), replacing src + caption.
   */
  const regenerateItem = useCallback(
    async (
      id: string,
      edits: {
        prompt: string
        script?: string
        note?: string
        provider?: ImageProvider | GenProvider
      },
    ) => {
      const item = itemsRef.current.find((it) => it.id === id)
      if (!item) throw new Error('This item has no generation settings and cannot be regenerated')
      const meta: GenMeta | null =
        item.genMeta ??
        (() => {
          const prompt = promptFromCaption(item.caption)
          if (!prompt) return null
          return {
            mediaKind: (item.kind === 'video' ? 'video' : 'image') as
              | 'image'
              | 'video',
            prompt,
          }
        })()
      if (!meta) throw new Error('This item has no generation settings and cannot be regenerated')

      beginGen(meta.mediaKind === 'video' ? 'video' : 'image')
      setGenerateError(null)
      try {
        const basePrompt = edits.prompt.trim() || meta.prompt
        const withNote = buildRegenPrompt(meta.prompt, {
          prompt: edits.prompt,
          note: edits.note,
        })

        let newSrc: string
        if (meta.mediaKind === 'video') {
          const prompt = [
            edits.script
              ? `${withNote}\n\nSpoken line: "${edits.script}"`
              : withNote,
            NO_ONSCREEN_TEXT,
            VIDEO_AUDIO_DEFAULT,
          ].join('\n\n')
          const res = await dressFetch('/generate-video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt,
              aspect_ratio: meta.aspect ?? '16:9',
              duration: meta.duration ?? 6,
              resolution: meta.resolution ?? '720p',
              provider: edits.provider ?? videoProviderRef.current,
              ...(meta.startSrc
                ? { start_image: await toDataUri(meta.startSrc) }
                : {}),
            }),
          })
          const data = (await res.json()) as { src?: string; error?: string }
          if (!res.ok || !data.src) {
            throw new Error(data.error || 'Video regenerate failed')
          }
          newSrc = data.src
        } else {
          const sourceRefs = meta.refs ?? []
          const prompt = withNote
          const images = sourceRefs
          const res = await dressFetch('/generate-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt,
              ...(images.length ? { images } : {}),
              aspect_ratio: meta.aspect ?? '9:16',
              image_mode: meta.imageMode ?? imageModeRef.current,
              provider:
                (edits.provider as ImageProvider | undefined) ??
                imageProviderRef.current,
            }),
          })
          const data = (await res.json()) as { src?: string; error?: string }
          if (!res.ok || !data.src) {
            throw new Error(data.error || 'Image regenerate failed')
          }
          newSrc = data.src
        }

        const size =
          meta.mediaKind === 'video'
            ? await loadVideoSize(newSrc)
            : await loadImageSize(newSrc)

        const captionParts = [
          meta.mediaKind === 'video' ? `Video | ${basePrompt}` : null,
          edits.script ? `Voiceover | ${edits.script}` : null,
        ].filter(Boolean)

        setItems((prev) =>
          prev.map((it) =>
            it.id === id
              ? {
                  ...it,
                  src: newSrc,
                  width: size.width,
                  height: size.height,
                  caption: captionParts.length
                    ? captionParts.join('\n')
                    : it.caption,
                  genMeta: {
                    ...meta,
                    prompt: basePrompt,
                    script: edits.script || undefined,
                    ...(meta.mediaKind === 'image'
                      ? {
                          aspect: meta.aspect ?? '9:16',
                          imageMode: meta.imageMode ?? imageModeRef.current,
                        }
                      : {}),
                  },
                }
              : it,
          ),
        )
        setSelectedIds([id])
      } catch (err) {
        setGenerateError(
          err instanceof Error ? err.message : 'Regeneration failed',
        )
        throw err
      } finally {
        endGen()
      }
    },
    [],
  )

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable

      if (e.code === 'Space' && !e.repeat && !typing) {
        e.preventDefault()
        setSpaceHeld(true)
      }
      if (typing) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const edgeId = selectedEdgeRef.current
        if (edgeId) {
          e.preventDefault()
          setChainMap((prev) => clearOutgoing(prev, edgeId))
          setSelectedEdgeFromId(null)
          return
        }
        const ids = selectedIdsRef.current
        if (ids.length) {
          e.preventDefault()
          const idSet = new Set(ids)
          setItems((prev) => {
            for (const item of prev) {
              if (idSet.has(item.id) && item.src.startsWith('blob:')) {
                URL.revokeObjectURL(item.src)
              }
            }
            return prev.filter((item) => !idSet.has(item.id))
          })
          setChainMap((prev) => {
            let next = prev
            for (const id of ids) next = removeFromChain(next, id)
            return next
          })
          setSelectedIds([])
          return
        }
      }

      if (e.key === 'v' || e.key === 'V') setMode('select')
      if (e.key === 'h' || e.key === 'H') setMode('pan')
      if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        zoomToward(getViewportCenter(), ZOOM_STEP)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '-') {
        e.preventDefault()
        zoomToward(getViewportCenter(), 1 / ZOOM_STEP)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault()
        resetView()
      }
      if (e.key === 'Escape') {
        clearSelection()
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', onKeyDown, { passive: false })
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [clearSelection, getViewportCenter, resetView, zoomToward])

  useEffect(() => {
    const prevent = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault()
    }
    document.addEventListener('wheel', prevent, { passive: false })
    return () => document.removeEventListener('wheel', prevent)
  }, [])

  useLayoutEffect(() => {
    // Re-assert camera on the DOM after React commits — avoid the JSX
    // `style={{ transform: DEFAULT }}` reset that wiped zoom/pan on re-render.
    const world = worldRef.current
    const grid = gridRef.current
    const cam = cameraRef.current
    if (world) world.style.transform = cameraTransform(cam)
    if (grid) {
      const size = GRID_BASE * cam.scale
      grid.style.backgroundSize = `${size}px ${size}px`
      grid.style.backgroundPosition = `${cam.x}px ${cam.y}px`
    }
  })

  const regenTarget = (() => {
    if (!regenId) return null
    const item = items.find((i) => i.id === regenId)
    if (!item) return null
    if (item.genMeta) return item
    const prompt = promptFromCaption(item.caption)
    if (!prompt) return null
    return {
      ...item,
      genMeta: {
        mediaKind: (item.kind === 'video' ? 'video' : 'image') as
          | 'image'
          | 'video',
        prompt,
      },
    }
  })()
  const generatedItems = items
    .filter((i) => i.genMeta || promptFromCaption(i.caption))
    .map((i) => ({ id: i.id, src: i.src, kind: i.kind ?? ('image' as const) }))

  const onPickGenerated = useCallback((id: string) => {
    const item = itemsRef.current.find((i) => i.id === id)
    if (!item) return
    setSelectedIds([id])
    setSelectedEdgeFromId(null)
  }, [])

  const placeAtCenter = async (src: string) => {
    await addMediaFromSrc(src, { kind: 'screen', screen: getViewportCenter() })
  }

  const runAutoBikini = async (personSrc: string, count: 1 | 3) => {
    const looks = pickBikinis(count)
    if (!looks[0]) return
    beginGen('image')
    setGenerateError(null)
    try {
      const src = await toDataUri(personSrc)
      const flat = await flattenOnWhite(src)
      const scene = await isOpaque(personSrc)
      const ground = scene
        ? 'Keep the background exactly as in the first image. Do not replace the room.'
        : 'The white around the person is empty. Do not add a background.'
      for (let i = 0; i < looks.length; i++) {
        const res = await dressFetch('/generate-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: `${autoBikiniPrompt(looks[i])}\n${ground}`,
            images: [flat],
            aspect_ratio: '9:16',
            image_mode: imageModeRef.current,
            provider: imageProviderRef.current,
          }),
        })
        const generated = (await res.json()) as { src?: string; error?: string }
        if (!res.ok || !generated.src) throw new Error(generated.error || 'Auto bikini failed')
        const center = getViewportCenter()
        await addMediaFromSrc(generated.src, {
          kind: 'screen',
          screen: { x: center.x + i * 36, y: center.y + i * 28 },
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Auto bikini failed'
      setGenerateError(message)
      throw err
    } finally {
      endGen()
    }
  }

  const runCosplay = async (personSrc: string, themeId: string, count: 1 | 2 | 3) => {
    const costumes = pickCosplay(themeId, count)
    if (!costumes[0]) return
    beginGen('image')
    setGenerateError(null)
    try {
      const src = await toDataUri(personSrc)
      const flat = await flattenOnWhite(src)
      const scene = await isOpaque(personSrc)
      const ground = scene
        ? 'Keep the background exactly as in the first image. Do not replace the room.'
        : 'The white around the person is empty. Do not add a background.'
      for (let i = 0; i < costumes.length; i++) {
        const res = await dressFetch('/generate-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: `${cosplayPrompt(costumes[i])}\n${ground}`,
            images: [flat],
            aspect_ratio: '9:16',
            image_mode: imageModeRef.current,
            provider: imageProviderRef.current,
          }),
        })
        const generated = (await res.json()) as { src?: string; error?: string }
        if (!res.ok || !generated.src) throw new Error(generated.error || 'Cosplay failed')
        const center = getViewportCenter()
        await addMediaFromSrc(generated.src, {
          kind: 'screen',
          screen: { x: center.x + i * 36, y: center.y + i * 28 },
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Cosplay failed'
      setGenerateError(message)
      throw err
    } finally {
      endGen()
    }
  }

  const runDress = async (cutout: string, clothing: string | null, text: string, bare = false) => {
    beginGen('image')
    setGenerateError(null)
    try {
      const flat = await flattenOnWhite(cutout)
      const clothingUri = clothing && !bare ? await clothingWithoutWearer(await toDataUri(clothing)) : null
      const scene = await isOpaque(cutout)
      const ground = scene
        ? 'Keep the background exactly as in the first image. Do not replace the room.'
        : 'The white around the person is empty. Do not add a background.'
      const prompt = `${dressEditPrompt({
        userPrompt: text,
        apiPrompt: text,
        clothingIndex: clothingUri ? 1 : null,
        poseIndex: null,
        undress: bare,
      })}\n${ground}`
      const res = await dressFetch('/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          images: clothingUri ? [flat, clothingUri] : [flat],
          aspect_ratio: '9:16',
          image_mode: imageModeRef.current,
          provider: bare ? 'flux-3-klein' : imageProviderRef.current,
          ...(clothingUri ? { clothing_index: 1 } : {}),
        }),
      })
      const generated = (await res.json()) as { src?: string; error?: string }
      if (!res.ok || !generated.src) throw new Error(generated.error || (bare ? 'Undress failed' : 'Clothes on failed'))
      const sourceId = findIdBySrc(cutout)
      const source = sourceId
        ? itemsRef.current.find((it) => it.id === sourceId)
        : null
      const created = await addMediaFromSrc(
        generated.src,
        source
          ? { kind: 'world', x: source.x + source.width + 36, y: source.y }
          : { kind: 'screen', screen: getViewportCenter() },
        'image',
      )
      linkMade(sourceId, created.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : bare ? 'Undress failed' : 'Clothes on failed'
      setGenerateError(message)
      throw err
    } finally {
      endGen()
    }
  }

  const runPose = async (personSrc: string) => {
    beginGen('image')
    setGenerateError(null)
    try {
      const pose = await toDataUri('/pose-default.png')
      const scene = await isOpaque(personSrc)
      const ground = scene
        ? 'Keep the background exactly as in the first image. Do not replace the room.'
        : 'The white around the person is empty. Do not add a background.'
      const prompt = `${dressEditPrompt({
        userPrompt: '',
        apiPrompt: '',
        clothingIndex: null,
        poseIndex: 1,
        lockFace: true,
      })}\n${ground}`
      const res = await dressFetch('/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          images: [await flattenOnWhite(personSrc), pose],
          aspect_ratio: '9:16',
          image_mode: imageModeRef.current,
          provider: imageProviderRef.current,
          pose_index: 1,
        }),
      })
      const generated = (await res.json()) as { src?: string; error?: string }
      if (!res.ok || !generated.src) throw new Error(generated.error || 'Pose failed')
      const sourceId = findIdBySrc(personSrc)
      const source = sourceId
        ? itemsRef.current.find((it) => it.id === sourceId)
        : null
      const created = await addMediaFromSrc(
        generated.src,
        source
          ? { kind: 'world', x: source.x + source.width + 36, y: source.y }
          : { kind: 'screen', screen: getViewportCenter() },
        'image',
      )
      linkMade(sourceId, created.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Pose failed'
      setGenerateError(message)
      throw err
    } finally {
      endGen()
    }
  }

  /** Empty scene plate for Detail → background composite. Person is returned unchanged. */
  const makeBackground = async (
    prompt: string,
    size: { w: number; h: number },
    reference: string | null,
    person: string,
  ): Promise<{ src: string; person: string }> => {
    beginGen('image')
    setGenerateError(null)
    try {
      const images = reference ? [await toDataUri(reference)] : []
      const res = await dressFetch('/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: [
            'Empty background plate only. No people, no mannequin, no face.',
            `Frame about ${Math.round(size.w)}×${Math.round(size.h)} pixels.`,
            prompt.trim(),
          ].join('\n'),
          ...(images.length ? { images } : {}),
          aspect_ratio: '9:16',
          image_mode: imageModeRef.current,
          provider: imageProviderRef.current,
        }),
      })
      const data = (await res.json()) as { src?: string; error?: string }
      if (!res.ok || !data.src) throw new Error(data.error || 'Background generate failed')
      return { src: data.src, person }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Background generate failed'
      setGenerateError(message)
      throw err
    } finally {
      endGen()
    }
  }

  const selectionRefs: SelectionRef[] = selectedIds.flatMap((id) => {
    const item = items.find((it) => it.id === id)
    return item ? [{ id: item.id, src: item.src }] : []
  })

  const cursorClass = isPanning
    ? 'cursor-grabbing'
    : panModeActive
      ? 'cursor-grab'
      : 'cursor-default'

  return (
    <div className="canvas-app">
      <div
        ref={viewportRef}
        className={`canvas-viewport ${cursorClass} ${isDragOver ? 'is-drop-target' : ''}`}
        onWheel={handleWheel}
        onPointerDown={onViewportPointerDown}
        onPointerMove={onViewportPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDragEnter={(e) => {
          e.preventDefault()
          setIsDragOver(true)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setIsDragOver(true)
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={onDrop}
      >
        <div ref={gridRef} className="canvas-grid" aria-hidden />
        <div ref={worldRef} className="canvas-world">
          {items.map((item) => {
            const selected = selectedIds.includes(item.id)
            const linked = isLinked(chainMap, item.id)
            return (
              <CanvasImage
                key={item.id}
                item={item}
                selected={selected}
                showHandles={
                  selectedIds.length === 1 && selectedIds[0] === item.id
                }
                showDisconnect={selected && linked}
                showRegenerate={
                  selectedIds.length === 1 &&
                  selectedIds[0] === item.id &&
                  Boolean(item.genMeta || promptFromCaption(item.caption))
                }
                chainOrder={chainOrder[item.id]}
                chainTarget={chainHoverId === item.id}
                onSelect={onItemSelect}
                onDragStart={onItemDragStart}
                onMove={onItemMove}
                onResize={(id, box) => {
                  setItems((prev) =>
                    prev.map((item) => (item.id === id ? { ...item, ...box } : item)),
                  )
                }}
                onDelete={onItemDelete}
                onOpacity={onItemOpacity}
                onPlaceCutout={async (src, opacity) => {
                  await addMediaFromSrc(
                    src,
                    { kind: 'screen', screen: getViewportCenter() },
                    'image',
                    opacity == null ? undefined : { opacity },
                  )
                }}
                onMatchColour={async (id, reference) => {
                  const target = items.find((item) => item.id === id)
                  if (!target) throw new Error('Image not found')
                  const src = await toDataUri(target.src)
                  const ref = await toDataUri(reference)
                  const res = await dressFetch('/match-colour', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ src, reference: ref }),
                  })
                  const data = (await res.json()) as { src?: string; error?: string }
                  if (!res.ok || !data.src) throw new Error(data.error || 'Colour match failed')
                  const graded = data.src
                  setItems((prev) =>
                    prev.map((item) => (item.id === id ? { ...item, src: graded } : item)),
                  )
                }}
                srcFor={(id) => items.find((item) => item.id === id)?.src ?? null}
                onDisconnect={onItemDisconnect}
                onRegenerate={setRegenId}
                onChainDragStart={onChainDragStart}
                onDressImage={runDress}
                onPoseImage={runPose}
                onAutoBikini={runAutoBikini}
                onCosplay={runCosplay}
                getScale={getScale}
              />
            )
          })}
          <ChainOverlay
            items={items}
            edges={chainEdges}
            scale={scaleUi}
            selectedEdgeFromId={selectedEdgeFromId}
            preview={chainPreview}
            onSelectEdge={onSelectEdge}
            clothesBusy={generating}
            onClothesOn={(fromId, toId) => {
              const from = items.find((item) => item.id === fromId)
              const to = items.find((item) => item.id === toId)
              if (!from || !to || from.kind === 'video' || to.kind === 'video') return
              void runDress(to.src, from.src, '')
                .then(() => {
                  setChainMap((prev) => clearOutgoing(prev, fromId))
                  setSelectedEdgeFromId((cur) => (cur === fromId ? null : cur))
                })
                .catch(() => {})
            }}
            onMergeIn={(fromId, toId) => {
              setItems((prev) => {
                const from = prev.find((item) => item.id === fromId)
                const to = prev.find((item) => item.id === toId)
                if (!from || !to) return prev
                zCounter.current = Math.max(zCounter.current, to.zIndex) + 1
                const z = zCounter.current
                return prev.map((item) =>
                  item.id === fromId
                    ? {
                        ...item,
                        width: to.width,
                        height: to.height,
                        x: to.x,
                        y: to.y,
                        zIndex: z,
                      }
                    : item,
                )
              })
              setChainMap((prev) => clearOutgoing(prev, fromId))
              setSelectedEdgeFromId((cur) => (cur === fromId ? null : cur))
            }}
          />
        </div>

        {items.length === 0 && !generating && (
          <div className="empty-state">
            <p className="empty-title">Infinite canvas</p>
            <p className="empty-body">
              Drop a person photo here. Use the menu on the image to change the clothes.
            </p>
          </div>
        )}

        {generating && (
          <div className="gen-overlay" aria-live="polite">
            <span className="gen-pulse" />
            {generatingKind === 'video'
              ? `Generating video with ${providerLabel(videoProvider)}…`
              : `Generating with ${imageProviderLabel(imageProvider)} · ${imageMode === '720' ? '720' : 'Speed'}…`}
          </div>
        )}

        {generateError && !generating && (
          <div className="gen-error" role="alert">
            <p>{generateError}</p>
            <button
              type="button"
              className="gen-error-dismiss"
              aria-label="Dismiss error"
              onClick={() => setGenerateError(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        {isDragOver && <div className="drop-veil" aria-hidden />}

        {marquee && (
          <div
            className="marquee-rect"
            style={{
              left: Math.min(marquee.x1, marquee.x2),
              top: Math.min(marquee.y1, marquee.y2),
              width: Math.abs(marquee.x2 - marquee.x1),
              height: Math.abs(marquee.y2 - marquee.y1),
            }}
          />
        )}

        {selectedIds.length > 1 &&
          selectedIds.some((id) => isLinked(chainMap, id)) && (
            <div className="selection-actions" role="toolbar" aria-label="Selection">
              <button
                type="button"
                className="selection-action-btn"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={onDisconnectSelection}
              >
                Disconnect
              </button>
            </div>
          )}
      </div>

      <StudioDock
        busy={generating}
        error={generateError}
        selectionRefs={selectionRefs}
        videoProvider={videoProvider}
        onVideoProviderChange={setVideoProvider}
        imageProvider={imageProvider}
        onGenerate={generateFromPrompt}
        assets={assets}
        onPlace={placeAtCenter}
        onDress={runDress}
        onMakeBackground={makeBackground}
        imageMode={imageMode}
        onOutfitBusy={(busy) => {
          if (busy) {
            beginGen('image')
            setGenerateError(null)
          } else {
            endGen()
          }
        }}
      />

      <CanvasChrome
        mode={mode}
        scale={scaleUi}
        itemCount={items.length}
        selectedCount={selectedIds.length}
        exportBusy={exportBusy}
        exportMessage={exportMessage}
        onModeChange={setMode}
        onZoomIn={() => zoomToward(getViewportCenter(), ZOOM_STEP)}
        onZoomOut={() => zoomToward(getViewportCenter(), 1 / ZOOM_STEP)}
        onResetView={resetView}
        onExport={handleExport}
        assets={assets}
        onAssetsChange={updateAssets}
        generated={generatedItems}
        onPickGenerated={onPickGenerated}
        imageMode={imageMode}
        onImageModeChange={setImageMode}
        imageProvider={imageProvider}
        onImageProviderChange={setImageProvider}
        genBusy={generating}
      />

      {regenTarget && (
        <RegenerateDialog
          key={regenTarget.id}
          item={regenTarget}
          busy={generating}
          imageProvider={imageProvider}
          videoProvider={videoProvider}
          onClose={() => setRegenId(null)}
          onSubmit={(edits) => {
            void regenerateItem(regenTarget.id, edits)
              .then(() => setRegenId(null))
              .catch(() => undefined)
          }}
        />
      )}

      {cropPopup}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        onChange={async (e) => {
          if (!e.target.files?.length) return
          await addImagesAtScreen(e.target.files, getViewportCenter())
          e.target.value = ''
        }}
      />
    </div>
  )
}
