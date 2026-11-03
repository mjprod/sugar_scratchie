import { useEffect, useRef, useState } from 'react'
import {
  ArrowsOutCardinal,
  Cursor,
  ImageSquare,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  ArrowsOut,
} from '@phosphor-icons/react'
import type { InteractionMode } from '../types'
import { IMAGE_MODES, type ImageMode } from '../lib/promptRefs'
import type { ImageProvider } from '../lib/genProvider'
import { ImageProviderSelect } from './ProviderSelect'
import type { ExportScope } from '../lib/exportImages'
import type { Asset } from '../lib/assets'
import { ExportMenu } from './ExportMenu'
import {
  AssetPanel,
  ADD_REF_EVENT,
  OPEN_LIBRARY_EVENT,
  type GeneratedThumb,
} from './AssetPanel'

function formatGenTime(ms: number | null): string {
  if (ms == null) return '—'
  const total = Math.max(0, Math.round(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const ss = String(s).padStart(2, '0')
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`
  return `${m}:${ss}`
}

type Props = {
  mode: InteractionMode
  scale: number
  itemCount: number
  selectedCount: number
  exportBusy: boolean
  exportMessage: string | null
  onModeChange: (mode: InteractionMode) => void
  onZoomIn: () => void
  onZoomOut: () => void
  onResetView: () => void
  onExport: (scope: ExportScope, upscale: boolean) => Promise<void>
  assets: Asset[]
  onAssetsChange: (assets: Asset[]) => void
  generated?: GeneratedThumb[]
  onPickGenerated?: (id: string) => void
  imageMode: ImageMode
  onImageModeChange: (mode: ImageMode) => void
  imageProvider: ImageProvider
  onImageProviderChange: (provider: ImageProvider) => void
  genBusy: boolean
}

export function CanvasChrome({
  mode,
  scale,
  itemCount,
  selectedCount,
  exportBusy,
  exportMessage,
  onModeChange,
  onZoomIn,
  onZoomOut,
  onResetView,
  onExport,
  assets,
  onAssetsChange,
  generated = [],
  onPickGenerated,
  imageMode,
  onImageModeChange,
  imageProvider,
  onImageProviderChange,
  genBusy,
}: Props) {
  const pct = Math.round(scale * 100)
  const [currentMs, setCurrentMs] = useState<number | null>(null)
  const [previousMs, setPreviousMs] = useState<number | null>(null)
  const startedAt = useRef<number | null>(null)
  const finishedMs = useRef<number | null>(null)
  const [assetOpen, setAssetOpen] = useState(false)
  const [pickPurpose, setPickPurpose] = useState<string | undefined>()
  const popRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!genBusy) {
      if (startedAt.current != null) {
        const dur = Date.now() - startedAt.current
        finishedMs.current = dur
        setCurrentMs(dur)
        startedAt.current = null
      }
      return
    }
    setPreviousMs(finishedMs.current)
    startedAt.current = Date.now()
    setCurrentMs(0)
    const id = window.setInterval(() => {
      if (startedAt.current != null) setCurrentMs(Date.now() - startedAt.current)
    }, 1000)
    return () => window.clearInterval(id)
  }, [genBusy])

  useEffect(() => {
    const open = (e: Event) => {
      const purpose = (e as CustomEvent<{ purpose?: string }>).detail?.purpose
      setPickPurpose(purpose)
      setAssetOpen(true)
    }
    window.addEventListener(OPEN_LIBRARY_EVENT, open)
    return () => window.removeEventListener(OPEN_LIBRARY_EVENT, open)
  }, [])

  useEffect(() => {
    const closes = pickPurpose === 'image-clothes' || pickPurpose === 'detail-person'
    if (!assetOpen || !closes) return
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent<{ src?: string; purpose?: string }>).detail
      if (!detail?.src || detail.purpose !== pickPurpose) return
      setAssetOpen(false)
    }
    window.addEventListener(ADD_REF_EVENT, onAdd)
    return () => window.removeEventListener(ADD_REF_EVENT, onAdd)
  }, [assetOpen, pickPurpose])

  useEffect(() => {
    if (!assetOpen) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || toggleRef.current?.contains(t)) return
      setAssetOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAssetOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [assetOpen])

  return (
    <>
      <header className="chrome-bar left-bar">
        <div className="brand-mark">
          <span className="brand-dot" />
          <a className="brand-name" href="/dashboard/video-flow" title="Back to Video Flow">
            Sugar Dress
          </a>
        </div>
        <div className="seg-group" role="group" aria-label="Image mode">
          {IMAGE_MODES.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={imageMode === opt.value ? 'seg-chip active' : 'seg-chip'}
              aria-pressed={imageMode === opt.value}
              disabled={genBusy}
              onClick={() => onImageModeChange(opt.value)}
              title={
                opt.value === 'speed'
                  ? 'Faster when there is no photo. An edit still rewrites the prompt so the clothes can change.'
                  : 'An original photo keeps its own size. With no photo, the short side stays 720.'
              }
            >
              {opt.label}
            </button>
          ))}
        </div>
        <ImageProviderSelect
          value={imageProvider}
          onChange={onImageProviderChange}
          disabled={genBusy}
        />
        <dl className="gen-times chrome-times">
          <div>
            <dt>Current Generate Time</dt>
            <dd>{formatGenTime(genBusy ? (currentMs ?? 0) : currentMs)}</dd>
          </div>
          <div>
            <dt>Previous Generate Time</dt>
            <dd>{formatGenTime(previousMs)}</dd>
          </div>
        </dl>
        <div className="tool-group" role="toolbar" aria-label="Tools">
          <button
            type="button"
            className={mode === 'select' ? 'tool-btn active' : 'tool-btn'}
            onClick={() => onModeChange('select')}
            title="Select / Move (V)"
            aria-pressed={mode === 'select'}
          >
            <Cursor size={18} weight="duotone" />
          </button>
          <button
            type="button"
            className={mode === 'pan' ? 'tool-btn active' : 'tool-btn'}
            onClick={() => onModeChange('pan')}
            title="Pan (Space / H)"
            aria-pressed={mode === 'pan'}
          >
            <ArrowsOutCardinal size={18} weight="duotone" />
          </button>
          <span className="tool-divider" />
          <div className="asset-chrome-wrap">
            <button
              ref={toggleRef}
              type="button"
              className={assetOpen ? 'tool-btn active' : 'tool-btn'}
              onClick={() => {
                setPickPurpose(undefined)
                setAssetOpen((v) => !v)
              }}
              title="Library (generated / uploads)"
              aria-expanded={assetOpen}
              aria-haspopup="dialog"
            >
              <ImageSquare size={18} weight="duotone" />
            </button>
          </div>
        </div>
      </header>
      {assetOpen && (
        <div
          ref={popRef}
          className="asset-chrome-pop"
          role="dialog"
          aria-label="Library"
          onPointerDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <AssetPanel
            popover
            assets={assets}
            onChange={onAssetsChange}
            generated={generated}
            onPickGenerated={onPickGenerated}
            pickPurpose={pickPurpose}
            onRequestClose={() => setAssetOpen(false)}
          />
        </div>
      )}

      <aside className="chrome-bar zoom-bar" aria-label="Zoom and export">
        <ExportMenu
          selectedCount={selectedCount}
          totalCount={itemCount}
          busy={exportBusy}
          message={exportMessage}
          onExport={onExport}
        />
        <span className="tool-divider" />
        <button
          type="button"
          className="tool-btn"
          onClick={onZoomOut}
          title="Zoom out"
        >
          <MagnifyingGlassMinus size={18} weight="bold" />
        </button>
        <button
          type="button"
          className="zoom-readout"
          onClick={onResetView}
          title="Reset view"
        >
          {pct}%
        </button>
        <button
          type="button"
          className="tool-btn"
          onClick={onZoomIn}
          title="Zoom in"
        >
          <MagnifyingGlassPlus size={18} weight="bold" />
        </button>
        <button
          type="button"
          className="tool-btn"
          onClick={onResetView}
          title="Fit / reset"
        >
          <ArrowsOut size={16} weight="bold" />
        </button>
        <span className="item-count">{itemCount}</span>
      </aside>
    </>
  )
}
