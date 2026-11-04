import { useState } from 'react'
import type { ImageMode, PromptSubmitPayload, SelectionRef } from '../lib/promptRefs'
import type { Asset } from '../lib/assets'
import type { GenProvider, ImageProvider } from '../lib/genProvider'
import { BuildDressPanel } from './BuildDressPanel'
import { DetailPanel } from './DetailPanel'
import { OutfitPanel } from './OutfitPanel'
import { PromptBar } from './PromptBar'

/** Parked. Flip a flag to true to show that tab again. */
const SHOW_QUICK_TAB = false
const SHOW_DETAIL_TAB = false
const SHOW_OUTFIT_TAB = false
const SHOW_BUILD_TAB = false

type Tab = 'quick' | 'detail' | 'outfit' | 'build'

function firstVisibleTab(): Tab | null {
  if (SHOW_QUICK_TAB) return 'quick'
  if (SHOW_DETAIL_TAB) return 'detail'
  if (SHOW_OUTFIT_TAB) return 'outfit'
  if (SHOW_BUILD_TAB) return 'build'
  return null
}

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
  const [tab, setTab] = useState<Tab | null>(firstVisibleTab)
  const hidden =
    (tab === 'quick' && !SHOW_QUICK_TAB) ||
    (tab === 'detail' && !SHOW_DETAIL_TAB) ||
    (tab === 'outfit' && !SHOW_OUTFIT_TAB) ||
    (tab === 'build' && !SHOW_BUILD_TAB)
  const visibleTab = hidden || tab == null ? firstVisibleTab() : tab
  if (visibleTab == null) return null

  return (
    <aside className="prompt-dock" aria-label="Creation controls">
      <div className="prompt-tabs" role="tablist" aria-label="Features">
        {SHOW_QUICK_TAB && (
          <button
            type="button"
            role="tab"
            aria-selected={visibleTab === 'quick'}
            className={visibleTab === 'quick' ? 'prompt-tab active' : 'prompt-tab'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setTab('quick')}
          >
            Quick
          </button>
        )}
        {SHOW_DETAIL_TAB && (
          <button
            type="button"
            role="tab"
            aria-selected={visibleTab === 'detail'}
            className={visibleTab === 'detail' ? 'prompt-tab active' : 'prompt-tab'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setTab('detail')}
          >
            Detail
          </button>
        )}
        {SHOW_OUTFIT_TAB && (
          <button
            type="button"
            role="tab"
            aria-selected={visibleTab === 'outfit'}
            className={visibleTab === 'outfit' ? 'prompt-tab active' : 'prompt-tab'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setTab('outfit')}
          >
            Outfit Change
          </button>
        )}
        {SHOW_BUILD_TAB && (
          <button
            type="button"
            role="tab"
            aria-selected={visibleTab === 'build'}
            className={visibleTab === 'build' ? 'prompt-tab active' : 'prompt-tab'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setTab('build')}
          >
            Build Dress
          </button>
        )}
      </div>
      <div className="prompt-dock-body">
        {visibleTab === 'quick' ? (
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
        ) : visibleTab === 'detail' ? (
          <DetailPanel
            busy={busy}
            error={error}
            selectionSrc={selectionRefs[0]?.src ?? null}
            onPlace={onPlace}
            onDress={onDress}
            onMakeBackground={onMakeBackground}
            onGenBusy={onOutfitBusy}
          />
        ) : visibleTab === 'outfit' ? (
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
