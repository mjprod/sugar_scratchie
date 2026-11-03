import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  CircleNotch,
  CornersOut,
  ImageSquare,
  Plus,
  Sparkle,
  VideoCamera,
  X,
} from '@phosphor-icons/react'
import {
  ASPECT_RATIOS,
  MAX_API_REFS,
  MAX_REFS,
  VIDEO_DURATIONS,
  VIDEO_RESOLUTIONS,
  parseAtMentions,
  setPrimaryRef,
  type AspectRatio,
  type ImageMode,
  type MediaKind,
  type PromptSubmitPayload,
  type SelectionRef,
  type VideoDuration,
  type VideoResolution,
} from '../lib/promptRefs'
import { toDataUri } from '../lib/imageData'
import { useCrop916 } from './ExtractPopup'
import { resolveAssetMentions, type Asset } from '../lib/assets'
import { dressEditPrompt, dressImages, rewriteAtRefs } from '../lib/dressEdit'
import {
  imageProviderLabel,
  providerLabel,
  type GenProvider,
  type ImageProvider,
} from '../lib/genProvider'
import {
  ADD_REF_EVENT,
  INSERT_TOKEN_EVENT,
  LIBRARY_ADD_EVENT,
  OPEN_LIBRARY_EVENT,
} from './AssetPanel'
import { MentionPopup, useAssetMentions } from './assetMention'
import { ProviderSelect } from './ProviderSelect'

type RefSlot = {
  id: string
  src: string
}

type FrameSlot = {
  id: string
  src: string
  from: 'upload' | 'canvas'
}

type Props = {
  busy: boolean
  error: string | null
  /** Ordered canvas selection — becomes @1 @2 @3 */
  selectionRefs: SelectionRef[]
  /** Video provider — shown only in video mode. */
  videoProvider?: GenProvider
  onVideoProviderChange?: (provider: GenProvider) => void
  /** Image provider chosen in the top bar. */
  imageProvider?: ImageProvider
  imageMode: ImageMode
  onGenerate: (payload: PromptSubmitPayload) => Promise<void>
  /** Named assets usable via @名稱 mentions */
  assets?: Asset[]
  /** When true, omit outer prompt-dock wrapper (parent provides it) */
  embedded?: boolean
}

function AspectMark({ ratio }: { ratio: AspectRatio }) {
  const [rw, rh] =
    ratio === 'auto' ? [1, 1] : ratio.split(':').map((part) => Number(part))
  const max = 13
  const scale = max / Math.max(rw, rh)
  const sw = rw * scale
  const sh = rh * scale
  const x = (14 - sw) / 2
  const y = (14 - sh) / 2
  return (
    <svg
      className="aspect-mark"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
    >
      <rect
        x={x}
        y={y}
        width={sw}
        height={sh}
        rx="1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeDasharray={ratio === 'auto' ? '2.2 1.5' : undefined}
      />
    </svg>
  )
}

export function PromptBar({
  busy,
  error,
  selectionRefs,
  videoProvider = 'grok',
  onVideoProviderChange,
  imageProvider = 'flux-3-klein',
  imageMode,
  onGenerate,
  assets = [],
  embedded = false,
}: Props) {
  const { ask: askCrop, popup: cropPopup } = useCrop916()
  const [prompt, setPrompt] = useState('')
  const [mediaKind, setMediaKind] = useState<MediaKind>('image')
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('auto')
  const aspectTouched = useRef(false)
  const [resolution, setResolution] = useState<VideoResolution>('720p')
  const [duration, setDuration] = useState<VideoDuration>(6)
  const [uploads, setUploads] = useState<RefSlot[]>([])
  const [startFrame, setStartFrame] = useState<FrameSlot | null>(null)
  const [bodyMatchOn, setBodyMatchOn] = useState(false)
  const [bodyMatchSrc, setBodyMatchSrc] = useState<string | null>(null)
  const [clothingSrc, setClothingSrc] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const startFileRef = useRef<HTMLInputElement>(null)
  const clothingFileRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [promptBoxH, setPromptBoxH] = useState<number | null>(null)

  /** Uploads win over canvas selection for the @1/@2/@3 pool. */
  const usingUploads = uploads.length > 0
  const usingSelection = !usingUploads && selectionRefs.length > 0
  const displayRefs: RefSlot[] = usingUploads
    ? uploads
    : selectionRefs.slice(0, MAX_REFS).map((r) => ({ id: r.id, src: r.src }))
  setPrimaryRef(displayRefs[0]?.src ?? null)

  const hasAtMentions = /@\d+\b/.test(prompt)
  const multiSelect = usingSelection && selectionRefs.length >= 2
  const singleSelect = usingSelection && selectionRefs.length === 1
  const editMode =
    singleSelect || multiSelect || hasAtMentions || uploads.length > 0
  const isVideo = mediaKind === 'video'

  // Canvas selection → start frame (prefer first selected)
  useEffect(() => {
    if (!isVideo || selectionRefs.length === 0) return
    const a = selectionRefs[0]
    setStartFrame((prev) => {
      if (prev?.from === 'upload') return prev
      return { id: a.id, src: a.src, from: 'canvas' }
    })
  }, [isVideo, selectionRefs])

  const setKind = (kind: MediaKind) => {
    setMediaKind(kind)
    if (kind === 'video' && aspectRatio === 'auto') {
      setAspectRatio('16:9')
    }
    if (kind === 'image' && !aspectTouched.current) {
      setAspectRatio('auto')
    }
  }

  const pickAspect = (value: AspectRatio) => {
    aspectTouched.current = value !== 'auto'
    setAspectRatio(value)
  }

  // 已生成 section adds a generated image into the upload ref pool.
  useEffect(() => {
    const onAddRef = (e: Event) => {
      const { src, purpose } =
        (e as CustomEvent<{ src?: string; purpose?: string }>).detail ?? {}
      if (!src) return
      if (
        purpose === 'color' ||
        purpose === 'detail-person' ||
        purpose === 'detail-clothes' ||
        purpose === 'detail-bg'
      ) {
        return
      }
      if (purpose === 'body') {
        setBodyMatchOn(true)
        setBodyMatchSrc(src)
        return
      }
      if (purpose === 'clothes') {
        setClothingSrc(src)
        return
      }
      setUploads((prev) => {
        if (prev.some((r) => r.src === src) || prev.length >= MAX_REFS) {
          return prev
        }
        return [...prev, { id: crypto.randomUUID(), src }]
      })
    }
    window.addEventListener(ADD_REF_EVENT, onAddRef)
    return () => window.removeEventListener(ADD_REF_EVENT, onAddRef)
  }, [])

  // Asset panel dispatches @名稱 tokens for insertion at the caret.
  useEffect(() => {
    const onInsert = (e: Event) => {
      const token = (e as CustomEvent<string>).detail
      if (typeof token === 'string' && token) insertToken(token)
    }
    window.addEventListener(INSERT_TOKEN_EVENT, onInsert)
    return () => window.removeEventListener(INSERT_TOKEN_EVENT, onInsert)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt])

  const insertAt = (slot: number) => insertToken(`@${slot}`)

  const insertToken = (token: string) => {
    const el = textareaRef.current
    if (!el) {
      setPrompt((p) => (p ? `${p.trim()} ${token}` : token))
      return
    }
    const start = el.selectionStart
    const end = el.selectionEnd
    const before = prompt.slice(0, start)
    const after = prompt.slice(end)
    const needsSpaceBefore = before.length > 0 && !/\s$/.test(before)
    const needsSpaceAfter = after.length > 0 && !/^\s/.test(after)
    const inserted =
      (needsSpaceBefore ? ' ' : '') + token + (needsSpaceAfter ? ' ' : '')
    const next = before + inserted + after
    setPrompt(next)
    requestAnimationFrame(() => {
      const pos = before.length + inserted.length
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  const mentionItems = displayRefs.map((ref, i) => ({
    id: ref.id,
    name: String(i + 1),
    thumb: ref.src,
  }))
  const mentions = useAssetMentions({
    items: mentionItems,
    value: prompt,
    setValue: setPrompt,
    textareaRef,
  })

  const addImageFiles = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (!images.length) return

    setLocalError(null)
    const room = MAX_REFS - uploads.length
    if (room <= 0) {
      setLocalError(`You can upload at most ${MAX_REFS} references (@1–@${MAX_REFS})`)
      return
    }

    const slice = images.slice(0, room)
    if (images.length > room) {
      setLocalError(`Limit reached. Only the first ${room} were added (max ${MAX_REFS})`)
    }

    const created: RefSlot[] = []
    for (const file of slice) {
      try {
        const blobUrl = URL.createObjectURL(file)
        const raw = await toDataUri(blobUrl)
        URL.revokeObjectURL(blobUrl)
        const src = await askCrop(raw)
        if (!src) continue
        created.push({ id: crypto.randomUUID(), src })
      } catch {
        setLocalError('Some images could not be read')
      }
    }
    if (!created.length) return

    const startIndex = uploads.length + 1
    setUploads((prev) => [...prev, ...created].slice(0, MAX_REFS))
    const tokens = created.map((_, i) => `@${startIndex + i}`).join(' ')
    setPrompt((p) => (p.trim() ? `${p.trim()} ${tokens}` : tokens))
    window.dispatchEvent(
      new CustomEvent(LIBRARY_ADD_EVENT, {
        detail: { srcs: created.map((c) => c.src) },
      }),
    )
  }

  const readStartFrameFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = Array.from(e.target.files ?? []).find((f) =>
      f.type.startsWith('image/'),
    )
    e.target.value = ''
    if (!file) return
    setLocalError(null)
    try {
      const blobUrl = URL.createObjectURL(file)
      const src = await toDataUri(blobUrl)
      URL.revokeObjectURL(blobUrl)
      setStartFrame({
        id: crypto.randomUUID(),
        src,
        from: 'upload',
      })
    } catch {
      setLocalError('Could not read the start frame')
    }
  }

  const openBodyLibrary = () => {
    window.dispatchEvent(
      new CustomEvent(OPEN_LIBRARY_EVENT, { detail: { purpose: 'body' } }),
    )
  }

  const openClothingLibrary = () => {
    window.dispatchEvent(
      new CustomEvent(OPEN_LIBRARY_EVENT, { detail: { purpose: 'clothes' } }),
    )
  }

  const setClothingFromFile = async (file: File | undefined) => {
    if (!file?.type.startsWith('image/')) return
    setLocalError(null)
    try {
      const blobUrl = URL.createObjectURL(file)
      const src = await toDataUri(blobUrl)
      URL.revokeObjectURL(blobUrl)
      setClothingSrc(src)
      window.dispatchEvent(
        new CustomEvent(LIBRARY_ADD_EVENT, { detail: { srcs: [src] } }),
      )
    } catch {
      setLocalError('Could not read the clothes reference')
    }
  }

  const setBodyMatchFromFile = async (file: File | undefined) => {
    if (!file?.type.startsWith('image/')) return
    setLocalError(null)
    try {
      const blobUrl = URL.createObjectURL(file)
      const src = await toDataUri(blobUrl)
      URL.revokeObjectURL(blobUrl)
      setBodyMatchSrc(src)
      setBodyMatchOn(true)
    } catch {
      setLocalError('Could not read the pose reference')
    }
  }

  const assignSelectionAsStart = () => {
    if (!selectionRefs.length) {
      setLocalError('Select an image on the canvas first')
      return
    }
    const pick = selectionRefs[0]
    setStartFrame({ id: pick.id, src: pick.src, from: 'canvas' })
    setLocalError(null)
  }

  const removeUpload = (id: string) => {
    setUploads((prev) => {
      const idx = prev.findIndex((r) => r.id === id)
      if (idx < 0) return prev
      const removedSlot = idx + 1
      const oldCount = prev.length
      const next = prev.filter((r) => r.id !== id)

      setPrompt((p) => {
        let result = p.replace(new RegExp(`@${removedSlot}\\b`, 'g'), '')
        for (let n = removedSlot + 1; n <= oldCount; n++) {
          result = result.replace(new RegExp(`@${n}\\b`, 'g'), `__AT_${n - 1}__`)
        }
        result = result.replace(/__AT_(\d+)__/g, '@$1')
        return result.replace(/\s{2,}/g, ' ').trim()
      })

      return next
    })
  }

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    const value = prompt.trim()
    if (busy) return
    if (isVideo && !value) return
    setLocalError(null)

    const poseRef = !isVideo && bodyMatchOn ? bodyMatchSrc : null
    if (!isVideo && bodyMatchOn && !poseRef) {
      setLocalError('Upload a Matching Body pose reference. Without it, the pose stays the original.')
      return
    }

    if (isVideo) {
      await onGenerate({
        prompt: value,
        aspectRatio,
        images: [],
        isEdit: Boolean(startFrame),
        mediaKind: 'video',
        duration,
        resolution,
        startFrame: startFrame?.src ?? null,
      })
      return
    }

    const source = displayRefs[0]?.src
    if (!source) {
      setLocalError('Upload the photo to edit first')
      return
    }
    if (!value && !clothingSrc) {
      setLocalError('Describe the new clothes, or upload a clothes reference')
      return
    }

    const pool = displayRefs.map((r) => r.src)
    const reserved = dressImages({
      source,
      clothing: clothingSrc,
      pose: poseRef,
    })
    const assetResolved = resolveAssetMentions(value, assets, reserved.images.length)
    const mentioned = parseAtMentions(assetResolved.apiPrompt)
      .map((n) => pool[n - 1])
      .filter((src): src is string => Boolean(src))
    const packed = dressImages({
      source,
      clothing: clothingSrc,
      pose: poseRef,
      extras: [...assetResolved.images, ...mentioned],
    })
    if (packed.images.length > MAX_API_REFS) {
      setLocalError(
        `At most ${MAX_API_REFS} images at once (original, clothes, pose, and @ references). Remove some.`,
      )
      return
    }
    const rewritten = rewriteAtRefs(assetResolved.apiPrompt, pool, packed.images)
    if (rewritten.missing.length) {
      setLocalError(
        `Missing reference ${rewritten.missing.map((n) => `@${n}`).join(', ')}. Select or upload those images.`,
      )
      return
    }

    await onGenerate({
      prompt: dressEditPrompt({
        userPrompt: value,
        apiPrompt: rewritten.apiPrompt,
        clothingIndex: packed.clothingIndex,
        poseIndex: packed.poseIndex,
      }),
      aspectRatio: '9:16',
      images: packed.images,
      isEdit: true,
      mediaKind: 'image',
      imageMode,
      bodyMatch: null,
      clothingIndex: packed.clothingIndex,
      poseIndex: packed.poseIndex,
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.onKeyDown(e)) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  const displayError = localError || error
  const brand = isVideo
    ? providerLabel(videoProvider)
    : imageProviderLabel(imageProvider)
  const imageModeLabel = imageMode === '720' ? '720' : 'Speed'
  const modeLabel = isVideo
    ? `${brand} · Video`
    : multiSelect
      ? `${brand} · ${imageModeLabel} · Canvas @`
      : hasAtMentions || uploads.length
        ? `${brand} · ${imageModeLabel} · Reference`
        : singleSelect
          ? `${brand} · ${imageModeLabel} · Edit`
          : `${brand} · ${imageModeLabel}`

  const renderStartFrameCard = () => (
    <div className="frame-card">
      <div className="frame-card-head">
        <span>Start frame</span>
        {startFrame && (
          <button
            type="button"
            className="frame-clear"
            title="Clear"
            disabled={busy}
            onClick={() => setStartFrame(null)}
          >
            <X size={12} weight="bold" />
          </button>
        )}
      </div>
      {startFrame ? (
        <button
          type="button"
          className="frame-thumb"
          title="Replace"
          disabled={busy}
          onClick={() => startFileRef.current?.click()}
        >
          <img src={startFrame.src} alt="Start frame" />
          <em>{startFrame.from === 'canvas' ? 'Canvas' : 'Upload'}</em>
        </button>
      ) : (
        <div className="frame-empty">
          <button
            type="button"
            className="frame-action"
            disabled={busy}
            onClick={() => startFileRef.current?.click()}
          >
            <Plus size={14} weight="bold" />
            Upload
          </button>
          <button
            type="button"
            className="frame-action"
            disabled={busy || selectionRefs.length === 0}
            onClick={assignSelectionAsStart}
          >
            <ImageSquare size={14} weight="bold" />
            Use selection
          </button>
        </div>
      )}
    </div>
  )

  const onPromptResizeDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const ta = textareaRef.current
    if (!ta) return
    const startY = e.clientY
    const startH = ta.getBoundingClientRect().height
    const maxH = Math.min(360, window.innerHeight * 0.4)
    const handle = e.currentTarget
    try {
      handle.setPointerCapture(e.pointerId)
    } catch {
      /* pointer already released */
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      ev.stopPropagation()
      const next = startH + ev.clientY - startY
      setPromptBoxH(Math.round(Math.min(maxH, Math.max(72, next))))
    }
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return
      ev.stopPropagation()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  const body = (
    <>
      <form
        className={`prompt-bar ${editMode ? 'is-edit' : ''} ${isVideo ? 'is-video' : ''} ${embedded ? 'is-embedded' : ''}`}
        onSubmit={(e) => void submit(e)}
      >
        <div className="prompt-meta">
          {isVideo ? (
            <VideoCamera size={14} weight="fill" className="prompt-meta-icon" />
          ) : editMode ? (
            <ImageSquare size={14} weight="fill" className="prompt-meta-icon" />
          ) : (
            <Sparkle size={14} weight="fill" className="prompt-meta-icon" />
          )}
          <span>{modeLabel}</span>
          {isVideo && <span className="prompt-mode-pill">Video</span>}
          {isVideo && startFrame && (
            <span className="prompt-mode-pill">Start frame</span>
          )}
          {!isVideo && (multiSelect || hasAtMentions || uploads.length > 0) && (
            <span className="prompt-mode-pill">@refs</span>
          )}
          {!isVideo && singleSelect && !hasAtMentions && uploads.length === 0 && (
            <span className="prompt-mode-pill">Img2Img</span>
          )}
        </div>

        <div className="prompt-compose">
          <MentionPopup mentions={mentions} />
          <label className="prompt-describe">
            <span className="prompt-describe-label">{isVideo ? 'Describe the video' : 'Describe the clothes'}</span>
            <span className="prompt-input-wrap">
              <textarea
                ref={textareaRef}
                className={promptBoxH != null ? 'prompt-input is-sized' : 'prompt-input'}
                style={promptBoxH != null ? { height: promptBoxH } : undefined}
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value)
                  mentions.sync(e.target.value, e.target.selectionStart)
                }}
                onSelect={(e) => {
                  const el = e.currentTarget
                  mentions.sync(el.value, el.selectionStart)
                }}
                onBlur={mentions.close}
                onKeyDown={onKeyDown}
                onPointerDown={(e) => e.stopPropagation()}
                placeholder={
                  isVideo
                    ? startFrame
                      ? 'From the first frame, how it moves and how it is shot…'
                      : 'Describe the video to generate…'
                    : displayRefs.length
                      ? 'Describe the new clothes. Use @2 and @3 for other references.'
                      : 'Upload the person photo first, then describe the new clothes…'
                }
                rows={3}
                disabled={busy}
              />
              <button
                type="button"
                className="prompt-resize"
                aria-label="Resize the prompt box"
                onPointerDown={onPromptResizeDown}
              >
                <CornersOut size={14} weight="bold" />
              </button>
            </span>
          </label>
        </div>

        {!isVideo && (
          <div
            className={`prompt-refs${dragOver ? ' is-dragover' : ''}`}
            onPointerDown={(e) => e.stopPropagation()}
            onDragEnter={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setDragOver(true)
            }}
            onDragOver={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setDragOver(true)
            }}
            onDragLeave={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (e.currentTarget === e.target) setDragOver(false)
            }}
            onDrop={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setDragOver(false)
              void addImageFiles(Array.from(e.dataTransfer.files ?? []))
            }}
          >
            {displayRefs.map((ref, i) => (
              <button
                key={ref.id}
                type="button"
                className={usingSelection ? 'ref-thumb is-canvas' : 'ref-thumb'}
                title={`Insert @${i + 1} into the prompt`}
                onClick={() => insertAt(i + 1)}
              >
                <img src={ref.src} alt={i === 0 ? 'Original' : `Reference ${i + 1}`} />
                <span className="ref-badge">@{i + 1}</span>
                {i === 0 && <span className="ref-role">Original</span>}
                {usingUploads && (
                  <span
                    className="ref-remove"
                    role="button"
                    tabIndex={0}
                    aria-label={`Remove @${i + 1}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      removeUpload(ref.id)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation()
                        removeUpload(ref.id)
                      }
                    }}
                  >
                    <X size={10} weight="bold" />
                  </span>
                )}
              </button>
            ))}

            {uploads.length < MAX_REFS && (
              <button
                type="button"
                className="ref-add"
                title={
                  displayRefs.length
                    ? 'Add another reference. Point to it in the prompt with @2 or @3'
                    : 'Upload the person photo, or pick one from the library. The first image is the original @1'
                }
                disabled={busy}
                onClick={() =>
                  window.dispatchEvent(new Event(OPEN_LIBRARY_EVENT))
                }
              >
                <Plus size={16} weight="bold" />
                <span>{displayRefs.length ? 'Reference' : 'Original'}</span>
              </button>
            )}
            {clothingSrc ? (
              <button
                type="button"
                className="ref-thumb"
                title="Clothes reference. Click to replace."
                disabled={busy}
                onClick={() => clothingFileRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  void setClothingFromFile(e.dataTransfer.files[0])
                }}
              >
                <img src={clothingSrc} alt="Clothes" />
                <span className="ref-role">Clothes</span>
                <span
                  className="ref-remove"
                  role="button"
                  tabIndex={0}
                  aria-label="Remove clothes reference"
                  onClick={(e) => {
                    e.stopPropagation()
                    setClothingSrc(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation()
                      setClothingSrc(null)
                    }
                  }}
                >
                  <X size={10} weight="bold" />
                </span>
              </button>
            ) : (
              <button
                type="button"
                className="ref-add"
                title="Upload the clothes to put on. The wearer's body is removed before the model sees the photo, leaving the fabric. With no photo, write the clothes in the prompt."
                disabled={busy}
                onClick={openClothingLibrary}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  void setClothingFromFile(e.dataTransfer.files[0])
                }}
              >
                <Plus size={16} weight="bold" />
                <span>Clothes</span>
              </button>
            )}
          </div>
        )}

        {isVideo && (
          <div
            className="video-frames"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {renderStartFrameCard()}
            <p className="prompt-selection-hint video-frame-hint">
              Start frame is optional. After generation the last frame is placed on the canvas. The video and the still are saved to
              Generate.
            </p>
          </div>
        )}

        {!isVideo && (
          <p className="prompt-selection-hint">
            {usingUploads ? (
              <>
                The first image is the person to edit (<code>@1</code>
                ). Use the Clothes slot beside it, or write the clothes in the prompt. The clothes fit the original body and do not change that body. Matching Body
                only borrows pose and motion, not the outfit. When it is off, pose, expression, and skin stay the original.
              </>
            ) : usingSelection ? (
              <>
                The first selected image is the person to edit (<code>@1</code>
                ). Use the Clothes slot beside it, or write the clothes in the prompt. The clothes fit the original body and do not change that body. Matching Body
                only borrows pose and motion, not the outfit. When it is off, pose, expression, and skin stay the original.
              </>
            ) : (
              <>
                Upload the person photo first. Clothes can be a separate upload, or written in the prompt. The clothes fit the original body and do not change that body. @1 and @2
                still point at reference images.
              </>
            )}
          </p>
        )}

        <div className="prompt-toolbar" onPointerDown={(e) => e.stopPropagation()}>
          <div className="media-kind" role="group" aria-label="Media type">
            <button
              type="button"
              className={
                mediaKind === 'image' ? 'media-kind-btn active' : 'media-kind-btn'
              }
              disabled={busy}
              onClick={() => setKind('image')}
              title="Image"
            >
              <ImageSquare
                size={16}
                weight={mediaKind === 'image' ? 'fill' : 'regular'}
              />
              <span>Image</span>
            </button>
            <button
              type="button"
              className={
                mediaKind === 'video' ? 'media-kind-btn active' : 'media-kind-btn'
              }
              disabled={busy}
              onClick={() => setKind('video')}
              title="Video"
            >
              <VideoCamera
                size={16}
                weight={mediaKind === 'video' ? 'fill' : 'regular'}
              />
              <span>Video</span>
            </button>
          </div>

          {isVideo && (
            <>
              {onVideoProviderChange && (
                <ProviderSelect
                  value={videoProvider}
                  onChange={onVideoProviderChange}
                  disabled={busy}
                />
              )}
              <div className="seg-group" role="group" aria-label="Resolution">
                {VIDEO_RESOLUTIONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className={resolution === r ? 'seg-chip active' : 'seg-chip'}
                    disabled={busy}
                    onClick={() => setResolution(r)}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <div className="seg-group" role="group" aria-label="Duration">
                {VIDEO_DURATIONS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={duration === d ? 'seg-chip active' : 'seg-chip'}
                    disabled={busy}
                    onClick={() => setDuration(d)}
                  >
                    {d}s
                  </button>
                ))}
              </div>
            </>
          )}

          {!isVideo && (
            <>
              <div className="color-match">
              <div className="seg-group">
                <button
                  type="button"
                  className={bodyMatchOn ? 'seg-chip active' : 'seg-chip'}
                  disabled={busy}
                  aria-pressed={bodyMatchOn}
                  title="The reference only supplies pose and motion, not the outfit. Face, expression, and skin stay the original. Clothes stay the original unless you specify otherwise. Without this photo, the pose stays the original."
                  onClick={() => setBodyMatchOn((v) => !v)}
                >
                  Matching Body
                </button>
              </div>
              {bodyMatchOn &&
                (bodyMatchSrc ? (
                  <button
                    type="button"
                    className="color-match-thumb"
                    disabled={busy}
                    title="Pick a pose reference from the library. Only the pose and motion are used, not the outfit."
                    onClick={openBodyLibrary}
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      void setBodyMatchFromFile(e.dataTransfer.files[0])
                    }}
                  >
                    <img src={bodyMatchSrc} alt="Body reference" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="color-match-add"
                    disabled={busy}
                    title="Upload a pose reference. Only this photo's pose and motion are used, not the outfit."
                    onClick={openBodyLibrary}
                    onDragOver={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      void setBodyMatchFromFile(e.dataTransfer.files[0])
                    }}
                  >
                    <Plus size={12} weight="bold" />
                  </button>
                ))}
            </div>
            </>
          )}

          {isVideo && (
          <div
            className="seg-group aspect-seg"
            role="group"
            aria-label="Aspect ratio"
          >
            {ASPECT_RATIOS.filter((o) => o.value !== 'auto').map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={
                  aspectRatio === opt.value ? 'seg-chip active' : 'seg-chip'
                }
                disabled={busy}
                onClick={() => pickAspect(opt.value)}
              >
                <AspectMark ratio={opt.value} />
                {opt.label}
              </button>
            ))}
          </div>
          )}
        </div>

        <button
          type="submit"
          className="prompt-submit"
          disabled={busy || (isVideo ? !prompt.trim() : !prompt.trim() && !clothingSrc)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {busy ? (
            <>
              <CircleNotch size={16} weight="bold" className="spin" />
              {isVideo ? 'Rendering' : editMode ? 'Working' : 'Generating'}
            </>
          ) : isVideo ? (
            'Generate Video'
          ) : multiSelect || hasAtMentions || uploads.length ? (
            'Reference'
          ) : singleSelect ? (
            'Edit'
          ) : (
            'Generate'
          )}
        </button>
      </form>

      {displayError && <p className="prompt-error">{displayError}</p>}

      <input
        ref={startFileRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => void readStartFrameFile(e)}
      />
      <input
        ref={clothingFileRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          void setClothingFromFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      {cropPopup}
    </>
  )

  if (embedded) return body

  return <div className="prompt-dock">{body}</div>
}
