import { useState } from 'react'
import type { ImageMode, PromptSubmitPayload, SelectionRef } from '../lib/promptRefs'
import type { Asset } from '../lib/assets'
import type { GenProvider, ImageProvider } from '../lib/genProvider'
import { BuildDressPanel } from './BuildDressPanel'
import { DetailPanel } from './DetailPanel'
import { OutfitPanel } from './OutfitPanel'
import { PromptBar } from './PromptBar'

type Props = {
  busy: boolean
  error: string | null
  selectionRefs: SelectionRef[]
  videoProvider: GenProvider
  onVideoProviderChange: (provider: GenProvider) => void
  imageProvider: ImageProvider
  onGenerate: (payload: PromptSubmitPayload) => Promise<void>
  assets?: Asset[]
  onPlace: (src: string) => Promise<void>
  onDress: (cutout: string, clothing: string | null, prompt: string) => Promise<void>
  onMakeBackground: (
    prompt: string,
    size: { w: number; h: number },
    reference: string | null,
    person: string,
  ) => Promise<{ src: string; person: string }>
  imageMode: ImageMode
  onOutfitBusy: (busy: boolean) => void
}

export function StudioDock({
  busy,
  error,
  selectionRefs,
  videoProvider,
  onVideoProviderChange,
  imageProvider,
  onGenerate,
  assets,
  onPlace,
  onDress,
  onMakeBackground,
  imageMode,
  onOutfitBusy,
}: Props) {
  const [tab, setTab] = useState<'quick' | 'detail' | 'outfit' | 'build'>('quick')

  return (
    <aside className="prompt-dock" aria-label="Creation controls">
      <div className="prompt-tabs" role="tablist" aria-label="Features">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'quick'}
          className={tab === 'quick' ? 'prompt-tab active' : 'prompt-tab'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setTab('quick')}
        >
          Quick
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'detail'}
          className={tab === 'detail' ? 'prompt-tab active' : 'prompt-tab'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setTab('detail')}
        >
          Detail
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'outfit'}
          className={tab === 'outfit' ? 'prompt-tab active' : 'prompt-tab'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setTab('outfit')}
        >
          Outfit Change
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'build'}
          className={tab === 'build' ? 'prompt-tab active' : 'prompt-tab'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setTab('build')}
        >
          Build Dress
        </button>
      </div>
      <div className="prompt-dock-body">
        {tab === 'quick' ? (
          <PromptBar
            embedded
            busy={busy}
            error={error}
            selectionRefs={selectionRefs}
            videoProvider={videoProvider}
            onVideoProviderChange={onVideoProviderChange}
            imageProvider={imageProvider}
            imageMode={imageMode}
            onGenerate={onGenerate}
            assets={assets}
          />
        ) : tab === 'detail' ? (
          <DetailPanel
            busy={busy}
            error={error}
            selectionSrc={selectionRefs[0]?.src ?? null}
            onPlace={onPlace}
            onDress={onDress}
            onMakeBackground={onMakeBackground}
          />
        ) : tab === 'outfit' ? (
          <OutfitPanel
            busy={busy}
            error={error}
            selectionSrc={selectionRefs[0]?.src ?? null}
            imageProvider={imageProvider}
            imageMode={imageMode}
            onGenBusy={onOutfitBusy}
            onPlace={onPlace}
          />
        ) : (
          <BuildDressPanel
            busy={busy}
            error={error}
            imageProvider={imageProvider}
            imageMode={imageMode}
            onGenBusy={onOutfitBusy}
            onPlace={onPlace}
          />
        )}
      </div>
    </aside>
  )
}
