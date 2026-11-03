import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowsClockwise, DotsThreeVertical, LinkBreak, Palette, UserFocus, X } from '@phosphor-icons/react'
import type { CanvasItem } from '../types'
import { ADD_REF_EVENT, OPEN_LIBRARY_EVENT } from './AssetPanel'
import { ExtractPopup, type ExtractEngine } from './ExtractPopup'
import { COSPLAY_THEMES } from '../lib/dressEdit'
import { toDataUri } from '../lib/imageData'
import { getPrimaryRef } from '../lib/promptRefs'
import { CHAIN_PORT_GAP_PX, SIDES, type Side } from '../lib/laneChain'
import { resizeLocked, type Box, type Corner } from '../lib/resizeItem'
import { dressFetch } from '../lib/dressApi'

type Props = {
  item: CanvasItem
  selected: boolean
  showHandles: boolean
  showDisconnect: boolean
  showRegenerate?: boolean
  chainOrder?: number
  chainTarget?: boolean
  onSelect: (id: string, opts?: { additive?: boolean }) => void
  onDragStart: (id: string) => void
  onMove: (id: string, dx: number, dy: number) => void
  onResize: (id: string, box: Box) => void
  onDelete: (id: string) => void
  onOpacity: (id: string, opacity: number) => void
  onMatchColour: (id: string, reference: string) => Promise<void>
  onPlaceCutout: (src: string, opacity?: number) => Promise<void>
  srcFor: (id: string) => string | null
  onDisconnect: (id: string) => void
  onRegenerate?: (id: string) => void
  onDressImage?: (src: string, clothing: string | null, prompt: string) => Promise<void>
  onPoseImage?: (src: string) => Promise<void>
  onAutoBikini?: (src: string, count: 1 | 3) => Promise<void>
  onCosplay?: (src: string, themeId: string, count: 1 | 2 | 3) => Promise<void>
  onChainDragStart: (
    id: string,
    side: Side,
    clientX: number,
    clientY: number,
  ) => void
  getScale: () => number
}

function handleStyle(side: Side, gap: number, uiScale: number) {
  const mid = '50%'
  switch (side) {
    case 'top':
      return {
        left: mid,
        top: -gap,
        transform: `translate(-50%, -50%) scale(${uiScale})`,
      }
    case 'right':
      return {
        left: `calc(100% + ${gap}px)`,
        top: mid,
        transform: `translate(-50%, -50%) scale(${uiScale})`,
      }
    case 'bottom':
      return {
        left: mid,
        top: `calc(100% + ${gap}px)`,
        transform: `translate(-50%, -50%) scale(${uiScale})`,
      }
    case 'left':
      return {
        left: -gap,
        top: mid,
        transform: `translate(-50%, -50%) scale(${uiScale})`,
      }
  }
}

export function CanvasImage({
  item,
  selected,
  showHandles,
  showDisconnect,
  showRegenerate,
  chainOrder,
  chainTarget,
  onSelect,
  onDragStart,
  onMove,
  onResize,
  onDelete,
  onOpacity,
  onMatchColour,
  onPlaceCutout,
  srcFor,
  onDisconnect,
  onRegenerate,
  onDressImage,
  onPoseImage,
  onAutoBikini,
  onCosplay,
  onChainDragStart,
  getScale,
}: Props) {
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
  } | null>(null)
  const resizeRef = useRef<{
    pointerId: number
    corner: Corner
    startX: number
    startY: number
    box: Box
  } | null>(null)
  const colourFileRef = useRef<HTMLInputElement>(null)
  const [colourOpen, setColourOpen] = useState(false)
  const [colourMode, setColourMode] = useState<'menu' | 'point' | 'file'>('menu')
  const [pointedId, setPointedId] = useState<string | null>(null)
  const [fileSrc, setFileSrc] = useState<string | null>(null)
  const [colourBusy, setColourBusy] = useState(false)
  const [colourError, setColourError] = useState<string | null>(null)
  const [cutOpen, setCutOpen] = useState(false)
  const [cutBusy, setCutBusy] = useState(false)
  const [cutError, setCutError] = useState<string | null>(null)
  const [imageMenu, setImageMenu] = useState<'root' | 'dress' | 'bikini' | 'cosplay' | null>(null)
  const [clothSrc, setClothSrc] = useState<string | null>(null)
  const [line, setLine] = useState('')
  const [actBusy, setActBusy] = useState(false)
  const [bikiniBusy, setBikiniBusy] = useState(false)
  const [bikiniCount, setBikiniCount] = useState<1 | 3>(1)
  const [cosplayTheme, setCosplayTheme] = useState<string | null>(null)
  const [cosplayBusy, setCosplayBusy] = useState(false)
  const [actError, setActError] = useState<string | null>(null)
  const clothFileRef = useRef<HTMLInputElement>(null)
  const opsAt = useRef(0)

  useEffect(() => {
    if (showHandles) return
    setColourOpen(false)
    setCutOpen(false)
    setImageMenu(null)
  }, [showHandles])

  useEffect(() => {
    if (!imageMenu) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (t?.closest?.('[data-image-menu], .asset-panel')) return
      if (t?.closest?.(`[data-item-id="${item.id}"]`)) return
      setImageMenu(null)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [imageMenu, item.id])

  useEffect(() => {
    if (imageMenu !== 'dress') return
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent<{ src?: string; purpose?: string }>).detail
      if (detail?.purpose !== 'image-clothes' || !detail.src) return
      setClothSrc(detail.src)
      setActError(null)
    }
    window.addEventListener(ADD_REF_EVENT, onAdd)
    return () => window.removeEventListener(ADD_REF_EVENT, onAdd)
  }, [imageMenu])

  useEffect(() => {
    if (!colourOpen || colourMode !== 'point') return
    const onDown = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-item-id]')
      const id = el?.getAttribute('data-item-id')
      if (!id || id === item.id) return
      e.preventDefault()
      e.stopPropagation()
      setPointedId(id)
      setColourError(null)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [colourOpen, colourMode, item.id])

  useEffect(() => {
    if (!colourOpen) return
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent<{ src?: string; purpose?: string }>).detail
      if (detail?.purpose !== 'color' || !detail.src) return
      setFileSrc(detail.src)
      setColourMode('file')
      setColourError(null)
    }
    window.addEventListener(ADD_REF_EVENT, onAdd)
    return () => window.removeEventListener(ADD_REF_EVENT, onAdd)
  }, [colourOpen])

  const runColour = async (reference: string) => {
    setColourBusy(true)
    setColourError(null)
    try {
      await onMatchColour(item.id, reference)
      setColourOpen(false)
      setColourMode('menu')
      setPointedId(null)
      setFileSrc(null)
    } catch (err) {
      setColourError(err instanceof Error ? err.message : 'Colour match failed')
    } finally {
      setColourBusy(false)
    }
  }

  const runCut = async (crop: { x: number; y: number; w: number; h: number; method: ExtractEngine }) => {
    setCutBusy(true)
    setCutError(null)
    try {
      const src = await toDataUri(item.src)
      const res = await dressFetch('/extract-person', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ src, x: crop.x, y: crop.y, w: crop.w, h: crop.h, method: crop.method }),
      })
      const data = (await res.json()) as { src?: string; error?: string }
      if (!res.ok || !data.src) throw new Error(data.error || 'Extract failed')
      await onPlaceCutout(data.src)
      setCutOpen(false)
    } catch (err) {
      setCutError(err instanceof Error ? err.message : 'Extract failed')
    } finally {
      setCutBusy(false)
    }
  }

  const runPose = () => {
    if (!onPoseImage) return
    setActBusy(true)
    setActError(null)
    void onPoseImage(item.src)
      .then(() => setImageMenu(null))
      .catch((err: unknown) => {
        setActError(err instanceof Error ? err.message : 'Pose failed')
      })
      .finally(() => setActBusy(false))
  }

  const runAutoBikini = () => {
    if (!onAutoBikini) return
    setBikiniBusy(true)
    setActError(null)
    void onAutoBikini(item.src, bikiniCount)
      .then(() => setImageMenu(null))
      .catch((err: unknown) => {
        setActError(err instanceof Error ? err.message : 'Auto bikini failed')
      })
      .finally(() => setBikiniBusy(false))
  }

  const runCosplay = (count: 1 | 2 | 3) => {
    if (!onCosplay || !cosplayTheme) return
    setCosplayBusy(true)
    setActError(null)
    void onCosplay(item.src, cosplayTheme, count)
      .then(() => setImageMenu(null))
      .catch((err: unknown) => {
        setActError(err instanceof Error ? err.message : 'Cosplay failed')
      })
      .finally(() => setCosplayBusy(false))
  }

  const runDress = async () => {
    const text = line.trim()
    if ((!clothSrc && !text) || !onDressImage) return
    setActBusy(true)
    setActError(null)
    try {
      await onDressImage(item.src, clothSrc, text)
      setImageMenu(null)
    } catch (err) {
      setActError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setActBusy(false)
    }
  }

  const scale = getScale()
  const uiScale = 1 / scale
  const gap = CHAIN_PORT_GAP_PX / Math.max(scale, 0.001)

  return (
    <div
      className={[
        'canvas-item absolute touch-none select-none',
        selected ? 'is-selected' : '',
        chainTarget ? 'is-chain-target' : '',
        chainOrder ? 'in-chain' : '',
      ].join(' ')}
      data-item-id={item.id}
      style={{
        left: item.x,
        top: item.y,
        width: item.width,
        height: item.height,
        zIndex: item.zIndex,
        background: (item.opacity ?? 1) < 1 ? 'transparent' : undefined,
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        onSelect(item.id, { additive: e.shiftKey || e.metaKey || e.ctrlKey })
        onDragStart(item.id)
        e.currentTarget.setPointerCapture(e.pointerId)
        dragRef.current = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
        }
      }}
      onPointerMove={(e) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== e.pointerId) return
        e.stopPropagation()
        const s = getScale()
        const dx = (e.clientX - drag.startX) / s
        const dy = (e.clientY - drag.startY) / s
        onMove(item.id, dx, dy)
      }}
      onPointerUp={(e) => {
        const drag = dragRef.current
        if (drag?.pointerId !== e.pointerId) return
        dragRef.current = null
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch {
          /* already released */
        }
      }}
      onPointerCancel={(e) => {
        if (dragRef.current?.pointerId !== e.pointerId) return
        dragRef.current = null
      }}
    >
      {item.kind === 'video' ? (
        <video
          src={item.src}
          className="h-full w-full object-cover"
          style={{ opacity: item.opacity ?? 1 }}
          muted
          loop
          playsInline
          autoPlay
          controls={selected}
          draggable={false}
        />
      ) : (
        <img
          src={item.src}
          alt=""
          draggable={false}
          className="h-full w-full object-cover"
          style={{ opacity: item.opacity ?? 1 }}
        />
      )}

      {item.caption && (
        <div className="item-caption" title={item.caption}>
          {item.caption}
        </div>
      )}

      {chainOrder != null && (
        <div
          className="chain-order-wrap"
          style={{ transform: `scale(${uiScale})` }}
        >
          <span className="chain-order">{chainOrder}</span>
        </div>
      )}

      {(showHandles || showDisconnect || showRegenerate) && (
        <div
          className="item-actions-wrap"
          style={{ transform: `scale(${uiScale})` }}
        >
          {/* Stack: delete (top) → regenerate (under X) → unlink */}
          {showHandles && item.kind !== 'video' && imageMenu && (
            <div
              className={
                imageMenu === 'cosplay' && !cosplayTheme
                  ? 'colour-menu image-ops is-scroll'
                  : 'colour-menu image-ops'
              }
              data-image-menu
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              {imageMenu === 'root' && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setImageMenu(null)
                      setCutError(null)
                      setCutOpen(true)
                    }}
                  >
                    Extract person
                  </button>
                  <button type="button" onClick={() => setImageMenu('dress')}>
                    Regenerate
                  </button>
                  <button type="button" disabled={actBusy || bikiniBusy || cosplayBusy || !onPoseImage} onClick={runPose}>
                    {actBusy ? 'Posing…' : 'POSING'}
                  </button>
                  <button type="button" disabled={actBusy || bikiniBusy || cosplayBusy || !onAutoBikini} onClick={() => setImageMenu('bikini')}>
                    Auto Bikini
                  </button>
                  <button
                    type="button"
                    disabled={actBusy || bikiniBusy || cosplayBusy || !onCosplay}
                    onClick={() => {
                      setCosplayTheme(null)
                      setImageMenu('cosplay')
                    }}
                  >
                    Cosplay
                  </button>
                </>
              )}
              {imageMenu === 'bikini' && (
                <>
                  <div className="outfit-picks" role="group" aria-label="Looks">
                    <button
                      type="button"
                      className={bikiniCount === 1 ? 'seg-chip active' : 'seg-chip'}
                      disabled={bikiniBusy}
                      onClick={() => setBikiniCount(1)}
                    >
                      1
                    </button>
                    <button
                      type="button"
                      className={bikiniCount === 3 ? 'seg-chip active' : 'seg-chip'}
                      disabled={bikiniBusy}
                      onClick={() => setBikiniCount(3)}
                    >
                      3
                    </button>
                  </div>
                  <button type="button" disabled={bikiniBusy} onClick={runAutoBikini}>
                    {bikiniBusy ? 'Changing…' : 'Auto Bikini'}
                  </button>
                  <button type="button" disabled={bikiniBusy} onClick={() => setImageMenu('root')}>
                    Back
                  </button>
                </>
              )}
              {imageMenu === 'cosplay' && (
                <>
                  {cosplayTheme ? (
                    <>
                      <p>{COSPLAY_THEMES.find((theme) => theme.id === cosplayTheme)?.label}</p>
                      <div className="outfit-picks" role="group" aria-label="Generate count">
                        {([1, 2, 3] as const).map((count) => (
                          <button
                            key={count}
                            type="button"
                            className="seg-chip"
                            disabled={cosplayBusy}
                            onClick={() => runCosplay(count)}
                          >
                            {count}
                          </button>
                        ))}
                      </div>
                      <button type="button" disabled={cosplayBusy} onClick={() => setCosplayTheme(null)}>
                        Back
                      </button>
                    </>
                  ) : (
                    <>
                      {COSPLAY_THEMES.map((theme) => (
                        <button
                          key={theme.id}
                          type="button"
                          disabled={cosplayBusy}
                          onClick={() => setCosplayTheme(theme.id)}
                        >
                          {theme.label}
                        </button>
                      ))}
                      <button type="button" disabled={cosplayBusy} onClick={() => setImageMenu('root')}>
                        Back
                      </button>
                    </>
                  )}
                </>
              )}
              {imageMenu === 'dress' && (
                <>
                  <textarea
                    aria-label="Clothes description"
                    placeholder="Describe the clothes, for example a red dress. A reference photo wins."
                    value={line}
                    disabled={actBusy}
                    onChange={(e) => setLine(e.target.value)}
                  />
                  {clothSrc && <img src={clothSrc} alt="" />}
                  <button
                    type="button"
                    disabled={actBusy}
                    onClick={() => {
                      window.dispatchEvent(
                        new CustomEvent(OPEN_LIBRARY_EVENT, { detail: { purpose: 'image-clothes' } }),
                      )
                    }}
                  >
                    Clothes from library
                  </button>
                  <button type="button" disabled={actBusy} onClick={() => clothFileRef.current?.click()}>
                    Upload clothes
                  </button>
                  {clothSrc && (
                    <button type="button" disabled={actBusy} onClick={() => setClothSrc(null)}>
                      Remove clothes photo
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={actBusy || (!clothSrc && !line.trim())}
                    onClick={() => void runDress()}
                  >
                    {actBusy ? 'Working…' : 'Run'}
                  </button>
                  <button type="button" disabled={actBusy} onClick={() => setImageMenu('root')}>
                    Back
                  </button>
                  <input
                    ref={clothFileRef}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      e.target.value = ''
                      if (!file) return
                      const reader = new FileReader()
                      reader.onload = () => {
                        if (typeof reader.result === 'string') {
                          setClothSrc(reader.result)
                          setActError(null)
                        }
                      }
                      reader.onerror = () => setActError('Could not read the clothes photo')
                      reader.readAsDataURL(file)
                    }}
                  />
                </>
              )}
              {actError && <p className="colour-menu-error">{actError}</p>}
            </div>
          )}
          {showHandles && item.kind !== 'video' && colourOpen && (
                <div
                  className="colour-menu"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                  {colourMode === 'menu' && (
                    <>
                      <button
                        type="button"
                        disabled={colourBusy}
                        onClick={() => {
                          setPointedId(null)
                          setColourMode('point')
                        }}
                      >
                        Point at a canvas image
                      </button>
                      <button
                        type="button"
                        disabled={colourBusy}
                        onClick={() => {
                          setFileSrc(null)
                          setColourMode('file')
                        }}
                      >
                        Add a reference
                      </button>
                      <button
                        type="button"
                        disabled={colourBusy}
                        onClick={() => {
                          const ref = getPrimaryRef() || item.genMeta?.refs?.[0]
                          if (!ref) {
                            setColourError('No @1. Upload the original photo first.')
                            return
                          }
                          void runColour(ref)
                        }}
                      >
                        Match colour to @1
                      </button>
                    </>
                  )}
                  {colourMode === 'point' && (
                    <>
                      <p>{pointedId ? 'Another image is selected' : 'Click another image'}</p>
                      <button
                        type="button"
                        disabled={colourBusy || !pointedId}
                        onClick={() => {
                          const ref = pointedId ? srcFor(pointedId) : null
                          if (!ref) {
                            setColourError('That image was not found')
                            return
                          }
                          void runColour(ref)
                        }}
                      >
                        Match colour
                      </button>
                      <button type="button" onClick={() => setColourMode('menu')}>
                        Back
                      </button>
                    </>
                  )}
                  {colourMode === 'file' && (
                    <>
                      {fileSrc && <img src={fileSrc} alt="" />}
                      <button
                        type="button"
                        disabled={colourBusy}
                        onClick={() => {
                          window.dispatchEvent(
                            new CustomEvent(OPEN_LIBRARY_EVENT, {
                              detail: { purpose: 'color' },
                            }),
                          )
                        }}
                      >
                        From library
                      </button>
                      <button
                        type="button"
                        disabled={colourBusy}
                        onClick={() => colourFileRef.current?.click()}
                      >
                        Upload image
                      </button>
                      <button
                        type="button"
                        disabled={colourBusy || !fileSrc}
                        onClick={() => {
                          if (fileSrc) void runColour(fileSrc)
                        }}
                      >
                        Match colour
                      </button>
                      <button type="button" onClick={() => setColourMode('menu')}>
                        Back
                      </button>
                      <input
                        ref={colourFileRef}
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          e.target.value = ''
                          if (!file) return
                          const reader = new FileReader()
                          reader.onload = () => {
                            if (typeof reader.result === 'string') {
                              setFileSrc(reader.result)
                              setColourError(null)
                            }
                          }
                          reader.onerror = () => setColourError('Could not read the reference')
                          reader.readAsDataURL(file)
                        }}
                      />
                    </>
                  )}
                  {colourBusy && <p>Matching colour…</p>}
                  {colourError && <p className="colour-menu-error">{colourError}</p>}
                </div>
          )}
          {showHandles && (
            <div className="item-opacity-row">
              <label className="item-opacity">
                <span>{Math.round((item.opacity ?? 1) * 100)}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round((item.opacity ?? 1) * 100)}
                  aria-label="Opacity"
                  title="Opacity"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    e.stopPropagation()
                    onOpacity(item.id, Number(e.target.value) / 100)
                  }}
                />
              </label>
              {item.kind !== 'video' && (
                <button
                  type="button"
                  className="item-cut"
                  title="Extract person again"
                  aria-label="Extract person again"
                  disabled={cutBusy}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    setColourOpen(false)
                    setCutError(null)
                    setCutOpen(true)
                  }}
                >
                  <UserFocus size={14} weight="bold" />
                </button>
              )}
              {item.kind !== 'video' && (
                <button
                  type="button"
                  className="item-ops"
                  title="Image actions"
                  aria-label="Image actions"
                  aria-expanded={imageMenu != null}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    const now = performance.now()
                    if (now - opsAt.current < 400) return
                    opsAt.current = now
                    setColourOpen(false)
                    setImageMenu((open) => (open ? null : 'root'))
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    const now = performance.now()
                    if (now - opsAt.current < 400) return
                    opsAt.current = now
                    setColourOpen(false)
                    setImageMenu((open) => (open ? null : 'root'))
                  }}
                >
                  <DotsThreeVertical size={14} weight="bold" />
                </button>
              )}
              {item.kind !== 'video' && (
                <button
                  type="button"
                  className="item-colour"
                  title="Matching colour"
                  aria-label="Matching colour"
                  aria-expanded={colourOpen}
                  disabled={colourBusy}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    setColourError(null)
                    setImageMenu(null)
                    setColourOpen((open) => !open)
                    setColourMode('menu')
                  }}
                >
                  <Palette size={14} weight="bold" />
                </button>
              )}
              <button
                type="button"
                className="item-delete"
                title="Delete"
                aria-label="Delete image"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  e.preventDefault()
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(item.id)
                }}
              >
                <X size={14} weight="bold" />
              </button>
            </div>
          )}
          {showRegenerate && onRegenerate && (
            <button
              type="button"
              className="item-regen"
              title="Regenerate"
              aria-label="Regenerate"
              onPointerDown={(e) => {
                e.stopPropagation()
                e.preventDefault()
              }}
              onClick={(e) => {
                e.stopPropagation()
                onRegenerate(item.id)
              }}
            >
              <ArrowsClockwise size={14} weight="bold" />
            </button>
          )}
          {showDisconnect && (
            <button
              type="button"
              className="item-unlink"
              title="Disconnect"
              aria-label="Disconnect links"
              onPointerDown={(e) => {
                e.stopPropagation()
                e.preventDefault()
              }}
              onClick={(e) => {
                e.stopPropagation()
                onDisconnect(item.id)
              }}
            >
              <LinkBreak size={14} weight="bold" />
            </button>
          )}
        </div>
      )}

      {showHandles &&
        (['nw', 'ne', 'se', 'sw'] as const).map((corner) => (
          <button
            key={corner}
            type="button"
            className={`resize-handle corner-${corner}`}
            style={{ transform: `translate(-50%, -50%) scale(${uiScale})` }}
            title="Scale evenly"
            aria-label="Resize"
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.stopPropagation()
              e.preventDefault()
              dragRef.current = null
              try {
                e.currentTarget.setPointerCapture(e.pointerId)
              } catch {
                /* pointer already gone */
              }
              resizeRef.current = {
                pointerId: e.pointerId,
                corner,
                startX: e.clientX,
                startY: e.clientY,
                box: {
                  x: item.x,
                  y: item.y,
                  width: item.width,
                  height: item.height,
                },
              }
            }}
            onPointerMove={(e) => {
              const resize = resizeRef.current
              if (!resize || resize.pointerId !== e.pointerId) return
              e.stopPropagation()
              const s = getScale()
              onResize(
                item.id,
                resizeLocked(
                  resize.box,
                  resize.corner,
                  (e.clientX - resize.startX) / s,
                  (e.clientY - resize.startY) / s,
                ),
              )
            }}
            onPointerUp={(e) => {
              if (resizeRef.current?.pointerId !== e.pointerId) return
              resizeRef.current = null
            }}
          />
        ))}

      {showHandles &&
        SIDES.map((side) => (
          <button
            key={side}
            type="button"
            className={`chain-handle side-${side}`}
            style={handleStyle(side, gap, uiScale)}
            title={`Drag from ${side} to the next image`}
            aria-label={`Link from ${side}`}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.stopPropagation()
              e.preventDefault()
              dragRef.current = null
              onSelect(item.id)
              onChainDragStart(item.id, side, e.clientX, e.clientY)
            }}
          />
        ))}
      {cutOpen &&
        createPortal(
          <ExtractPopup
            src={item.src}
            busy={cutBusy}
            error={cutError}
            onCancel={() => {
              if (cutBusy) return
              setCutOpen(false)
            }}
            onExtract={(crop) => void runCut(crop)}
          />,
          document.body,
        )}
    </div>
  )
}
