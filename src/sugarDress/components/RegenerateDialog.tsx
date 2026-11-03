import { useState } from 'react'
import { ArrowsClockwise, CircleNotch, X } from '@phosphor-icons/react'
import type { GenProvider, ImageProvider } from '../lib/genProvider'
import type { CanvasItem } from '../types'
import { ProviderSelect } from './ProviderSelect'

export type RegenEdits = {
  prompt: string
  script?: string
  note?: string
  /** Image or video provider chosen in this dialog */
  provider: ImageProvider | GenProvider
}

type Props = {
  item: CanvasItem
  busy: boolean
  imageProvider: ImageProvider
  videoProvider: GenProvider
  onSubmit: (edits: RegenEdits) => void
  onClose: () => void
}

/** Popover for regenerating a generated item: edit prompt / script / note + model. */
export function RegenerateDialog({
  item,
  busy,
  imageProvider,
  videoProvider,
  onSubmit,
  onClose,
}: Props) {
  const meta = item.genMeta!
  const isVideo = meta.mediaKind === 'video'
  const [prompt, setPrompt] = useState(meta.prompt)
  const [script, setScript] = useState(meta.script ?? '')
  const [note, setNote] = useState('')
  const [vidProvider, setVidProvider] = useState<GenProvider>(videoProvider)

  const submit = () => {
    onSubmit({
      prompt: prompt.trim(),
      script: isVideo ? script.trim() || undefined : undefined,
      note: note.trim() || undefined,
      provider: isVideo ? vidProvider : imageProvider,
    })
  }

  return (
    <div
      className="regen-dialog"
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="regen-head">
        <ArrowsClockwise size={14} weight="bold" />
        <span>Regenerate {isVideo ? 'video' : 'image'}</span>
        <div className="regen-model">
          {isVideo && (
            <ProviderSelect
              caption="Model"
              value={vidProvider}
              onChange={setVidProvider}
              disabled={busy}
            />
          )}
        </div>
        <button
          type="button"
          className="regen-close"
          title="Close"
          onClick={onClose}
        >
          <X size={12} weight="bold" />
        </button>
      </div>

      <label className="regen-label">
        {isVideo ? 'Video prompt' : 'Image prompt'}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="Leave empty to use the original prompt"
          disabled={busy}
          autoFocus
        />
      </label>

      {isVideo && (
        <label className="regen-label">
          Spoken line
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            rows={2}
            placeholder="Leave empty for no spoken line"
            disabled={busy}
          />
        </label>
      )}

      <label className="regen-label">
        What should change? (optional)
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="For example: move the camera closer, change the light to dusk… (optional)"
          disabled={busy}
        />
      </label>

      <p className="regen-hint">
        Edit the prompt, or only write what should change. Leave both empty to regenerate with the original prompt.
      </p>

      <button
        type="button"
        className="regen-submit"
        disabled={busy}
        onClick={submit}
      >
        {busy ? (
          <>
            <CircleNotch size={15} weight="bold" className="spin" />
            Regenerating…
          </>
        ) : (
          <>
            <ArrowsClockwise size={15} weight="bold" />
            Regenerate
          </>
        )}
      </button>
    </div>
  )
}
