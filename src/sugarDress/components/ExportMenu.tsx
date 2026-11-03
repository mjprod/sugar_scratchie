import { useEffect, useRef, useState } from 'react'
import {
  CircleNotch,
  DownloadSimple,
  Export,
} from '@phosphor-icons/react'
import type { ExportScope } from '../lib/exportImages'

type Props = {
  selectedCount: number
  totalCount: number
  busy: boolean
  message: string | null
  onExport: (scope: ExportScope, upscale: boolean) => Promise<void>
}

export function ExportMenu({
  selectedCount,
  totalCount,
  busy,
  message,
  onExport,
}: Props) {
  const [open, setOpen] = useState(false)
  const [upscale, setUpscale] = useState(true)
  const [scope, setScope] = useState<ExportScope>('all')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (selectedCount === 1) setScope('single')
    else if (selectedCount > 1) setScope('selected')
    else setScope('all')
  }, [selectedCount])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const run = async () => {
    await onExport(scope, upscale)
    // Leave open so the status message is readable, then auto-dismiss.
    window.setTimeout(() => setOpen(false), 1800)
  }

  return (
    <div className="export-wrap" ref={rootRef}>
      <button
        type="button"
        className={open ? 'tool-btn active' : 'tool-btn'}
        title="Export images"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={busy || totalCount === 0}
        onClick={() => setOpen((v) => !v)}
      >
        {busy ? (
          <CircleNotch size={18} weight="bold" className="spin" />
        ) : (
          <Export size={18} weight="duotone" />
        )}
      </button>

      {open && (
        <div className="export-popover" role="dialog" aria-label="Export images">
          <div className="export-title">
            <DownloadSimple size={14} weight="bold" />
            Export
          </div>

          <div className="export-scopes" role="radiogroup" aria-label="Export scope">
            <label className={scope === 'single' ? 'export-scope active' : 'export-scope'}>
              <input
                type="radio"
                name="export-scope"
                checked={scope === 'single'}
                disabled={selectedCount !== 1 || busy}
                onChange={() => setScope('single')}
              />
              <span>Single</span>
              <em>{selectedCount === 1 ? '1' : '—'}</em>
            </label>
            <label className={scope === 'selected' ? 'export-scope active' : 'export-scope'}>
              <input
                type="radio"
                name="export-scope"
                checked={scope === 'selected'}
                disabled={selectedCount === 0 || busy}
                onChange={() => setScope('selected')}
              />
              <span>Selected</span>
              <em>{selectedCount || '—'}</em>
            </label>
            <label className={scope === 'all' ? 'export-scope active' : 'export-scope'}>
              <input
                type="radio"
                name="export-scope"
                checked={scope === 'all'}
                disabled={totalCount === 0 || busy}
                onChange={() => setScope('all')}
              />
              <span>All</span>
              <em>{totalCount || '—'}</em>
            </label>
          </div>

          <label className="export-upscale">
            <input
              type="checkbox"
              checked={upscale}
              disabled={busy}
              onChange={(e) => setUpscale(e.target.checked)}
            />
            <span>
              Upscale 2× HD
              <small>High-quality enlarge on export</small>
            </span>
          </label>

          <p className="export-hint">
            Choose a folder (`1.png`, `2.png`…). If folder pick isn’t available,
            multiple images download as one zip.
          </p>

          <button
            type="button"
            className="export-run"
            disabled={
              busy ||
              totalCount === 0 ||
              (scope === 'single' && selectedCount !== 1) ||
              (scope === 'selected' && selectedCount === 0)
            }
            onClick={() => void run()}
          >
            {busy ? (
              <>
                <CircleNotch size={16} weight="bold" className="spin" />
                Exporting…
              </>
            ) : (
              'Choose folder & export'
            )}
          </button>

          {message && <p className="export-msg">{message}</p>}
        </div>
      )}
    </div>
  )
}
