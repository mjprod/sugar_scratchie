import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from '@phosphor-icons/react'
import { clampFrame, cropImage, frameForAspect } from '../lib/extractFrame'
import { resizeLocked, type Box, type Corner } from '../lib/resizeItem'

function dressPortalTarget(): HTMLElement {
  return document.getElementById('sugar-dress-root') ?? document.body
}

export type ExtractEngine = 'modnet'

type Props = {
  src: string
  busy: boolean
  error?: string | null
  /** `crop` picks a 9:16 window and returns it. Extract still cuts the person out. */
  purpose?: 'extract' | 'crop'
  onCancel: () => void
  onExtract: (crop: { x: number; y: number; w: number; h: number; method: ExtractEngine }) => void
}

export function ExtractPopup({ src, busy, error, purpose = 'extract', onCancel, onExtract }: Props) {
  const stageRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [frame, setFrame] = useState<Box | null>(null)
  const [view, setView] = useState({ scale: 1, ox: 0, oy: 0 })
  const dragRef = useRef<{
    kind: 'move' | Corner
    pointerId: number
    startX: number
    startY: number
    box: Box
  } | null>(null)
  const naturalRef = useRef(natural)
  naturalRef.current = natural
  const scaleRef = useRef(view.scale)
  scaleRef.current = view.scale

  const measure = () => {
    const img = imgRef.current
    const stage = stageRef.current
    if (!img || !stage || !img.naturalWidth) return
    const scale = Math.min(stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight)
    const dw = img.naturalWidth * scale
    const dh = img.naturalHeight * scale
    setView({
      scale,
      ox: (stage.clientWidth - dw) / 2,
      oy: (stage.clientHeight - dh) / 2,
    })
    setNatural({ w: img.naturalWidth, h: img.naturalHeight })
  }

  useEffect(() => {
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [src])

  useEffect(() => {
    if (!natural) return
    setFrame(frameForAspect(natural.w, natural.h, 9, 16))
  }, [natural])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (busy) return
      const node = e.target
      if (!(node instanceof Node) || cardRef.current?.contains(node)) return
      // Backdrop only. Dock controls outside the popup still receive the click.
      if (popRef.current?.contains(node)) {
        e.preventDefault()
        e.stopPropagation()
      }
      cancelRef.current()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [busy])

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return
      const size = naturalRef.current
      // A move with the button up means the release was missed. Stop.
      if (!size || (e.buttons & 1) === 0) {
        dragRef.current = null
        return
      }
      const scale = scaleRef.current || 1
      const dx = (e.clientX - drag.startX) / scale
      const dy = (e.clientY - drag.startY) / scale
      const next =
        drag.kind === 'move'
          ? { ...drag.box, x: drag.box.x + dx, y: drag.box.y + dy }
          : resizeLocked(drag.box, drag.kind, dx, dy)
      setFrame(clampFrame(next, size.w, size.h))
    }
    const onUp = (e: PointerEvent) => {
      if (dragRef.current?.pointerId !== e.pointerId) return
      dragRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  return createPortal(
    <div ref={popRef} className="extract-pop" onPointerDown={(e) => e.stopPropagation()}>
      <div className="extract-card" ref={cardRef}>
        <header>
          <div className="extract-head">
            <h2>{purpose === 'crop' ? 'Crop 9:16' : 'Extract person'}</h2>
            <button
              type="button"
              className="extract-close"
              title="Close"
              aria-label="Close"
              disabled={busy}
              onClick={onCancel}
            >
              <X size={14} weight="bold" />
            </button>
          </div>
          <p>
            {purpose === 'crop'
              ? 'Drag the 9:16 frame over the area to keep. Anything outside stays off the canvas and is not sent to generate.'
              : 'Frame the person to keep. Only the 9:16 inside the frame is extracted, and the background is removed.'}
          </p>
        </header>
        <div ref={stageRef} className="extract-stage">
          <img
            ref={imgRef}
            src={src}
            alt="Original"
            draggable={false}
            onLoad={measure}
            style={
              natural
                ? {
                    position: 'absolute',
                    left: view.ox,
                    top: view.oy,
                    width: natural.w * view.scale,
                    height: natural.h * view.scale,
                  }
                : undefined
            }
          />
          {frame && (
            <div
              className="extract-frame"
              style={{
                left: view.ox + frame.x * view.scale,
                top: view.oy + frame.y * view.scale,
                width: frame.width * view.scale,
                height: frame.height * view.scale,
              }}
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.preventDefault()
                e.stopPropagation()
                dragRef.current = {
                  kind: 'move',
                  pointerId: e.pointerId,
                  startX: e.clientX,
                  startY: e.clientY,
                  box: frame,
                }
              }}
            >
              {(['nw', 'ne', 'se', 'sw'] as const).map((corner) => (
                <button
                  key={corner}
                  type="button"
                  className={`resize-handle corner-${corner}`}
                  aria-label="Resize frame"
                  onPointerDown={(e) => {
                    if (e.button !== 0) return
                    e.preventDefault()
                    e.stopPropagation()
                    dragRef.current = {
                      kind: corner,
                      pointerId: e.pointerId,
                      startX: e.clientX,
                      startY: e.clientY,
                      box: frame,
                    }
                  }}
                />
              ))}
            </div>
          )}
        </div>
        {error && <p className="prompt-error">{error}</p>}
        <div className="extract-actions">
          <button type="button" className="extract-cancel" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="extract-run"
            disabled={busy || !frame}
            onClick={() => {
              if (!frame) return
              onExtract({
                x: frame.x,
                y: frame.y,
                w: frame.width,
                h: frame.height,
                method: 'modnet',
              })
            }}
          >
            {busy ? 'Running…' : purpose === 'crop' ? 'Use this crop' : 'Run'}
          </button>
        </div>
      </div>
    </div>,
    dressPortalTarget(),
  )
}

/** One 9:16 crop dialog. Await it before the photo is stored or placed. */
export function useCrop916() {
  const [src, setSrc] = useState<string | null>(null)
  const pending = useRef<((value: string | null) => void) | null>(null)

  const ask = useCallback((next: string) => {
    return new Promise<string | null>((resolve) => {
      pending.current?.(null)
      pending.current = resolve
      setSrc(next)
    })
  }, [])

  const finish = useCallback(
    async (frame: { x: number; y: number; w: number; h: number } | null) => {
      const current = src
      const resolve = pending.current
      pending.current = null
      setSrc(null)
      if (!resolve) return
      if (!frame || !current) {
        resolve(null)
        return
      }
      try {
        resolve(await cropImage(current, frame))
      } catch {
        resolve(null)
      }
    },
    [src],
  )

  const popup = src ? (
    <ExtractPopup
      purpose="crop"
      src={src}
      busy={false}
      onCancel={() => void finish(null)}
      onExtract={(crop) => void finish(crop)}
    />
  ) : null

  return { ask, popup }
}
