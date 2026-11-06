import { useRef, useState, type ChangeEvent } from 'react'
import { Plus, Sparkle, UploadSimple, X } from '@phosphor-icons/react'
import {
  appendImageAssets,
  ASSET_KINDS,
  type Asset,
  type AssetKind,
} from '../lib/assets'
import { toDataUri } from '../lib/imageData'

/** Library insert event. Listeners add the named asset at the caret. */
export const INSERT_TOKEN_EVENT = 'mxj:insert-token'
/** Listeners add a reference image for the purpose named in the event. */
export const ADD_REF_EVENT = 'mxj:add-ref'
/** Open the chrome media library (生成 / 上傳). */
export const OPEN_LIBRARY_EVENT = 'mxj:open-library'
/** Persist new uploads into the 上傳 library. */
export const LIBRARY_ADD_EVENT = 'mxj:library-add'

export type GeneratedThumb = {
  id: string
  src: string
  kind: 'image' | 'video'
}

type LibraryDrag = { src: string; kind: 'image' | 'video' }
let libraryDrag: LibraryDrag | null = null

export function readLibraryDrag(): LibraryDrag | null {
  return libraryDrag
}

export function setLibraryDrag(item: LibraryDrag | null) {
  libraryDrag = item
}

let libraryLanded = false

/** The canvas accepted this library drag. dragend then closes the popover. */
export function noteLibraryLanded() {
  libraryLanded = true
}

type LibTab = 'generated' | 'uploads'

type Props = {
  assets: Asset[]
  onChange: (assets: Asset[]) => void
  /** Generated canvas items shown in the 已生成 section */
  generated?: GeneratedThumb[]
  /** Selects the item on canvas */
  onPickGenerated?: (id: string) => void
  /** Chrome toolbar popover — upload or pick from library */
  popover?: boolean
  /** `color` picks a colour reference instead of a prompt @ref */
  pickPurpose?: string
  onRequestClose?: () => void
}

function addRef(src: string, label?: string, purpose?: string) {
  window.dispatchEvent(
    new CustomEvent(ADD_REF_EVENT, { detail: { src, label, purpose } }),
  )
}

export function AssetPanel({
  assets,
  onChange,
  generated = [],
  onPickGenerated,
  popover = false,
  pickPurpose,
  onRequestClose,
}: Props) {
  const [addKind, setAddKind] = useState<AssetKind>('character')
  const [libTab, setLibTab] = useState<LibTab>('uploads')
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  /** Asset id awaiting extra images (null = create new) */
  const targetRef = useRef<string | null>(null)

  const pickFiles = (assetId: string | null) => {
    targetRef.current = assetId
    fileRef.current?.click()
  }

  const onFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter((f) =>
      f.type.startsWith('image/'),
    )
    e.target.value = ''
    if (!files.length) return
    setError(null)

    const images: string[] = []
    for (const file of files.slice(0, 6)) {
      try {
        const blobUrl = URL.createObjectURL(file)
        images.push(await toDataUri(blobUrl))
        URL.revokeObjectURL(blobUrl)
      } catch {
        setError('Some images could not be read')
      }
    }
    if (!images.length) return

    const targetId = targetRef.current
    targetRef.current = null

    if (targetId) {
      onChange(
        assets.map((a) =>
          a.id === targetId
            ? { ...a, images: [...a.images, ...images].slice(0, 6) }
            : a,
        ),
      )
      if (popover) {
        for (const src of images) addRef(src, undefined, pickPurpose)
      }
      return
    }

    if (popover) {
      onChange(appendImageAssets(assets, images))
      setLibTab('uploads')
      for (const src of images) addRef(src, undefined, pickPurpose)
      return
    }

    const base =
      ASSET_KINDS.find((k) => k.value === addKind)?.label ?? 'Asset'
    let n = assets.length + 1
    let name = `${base}${n}`
    while (assets.some((a) => a.name === name)) {
      n += 1
      name = `${base}${n}`
    }
    onChange([
      ...assets,
      { id: crypto.randomUUID(), name, kind: addKind, images },
    ])
  }

  const rename = (id: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (assets.some((a) => a.id !== id && a.name === trimmed)) {
      setError(`The name "${trimmed}" already exists`)
      return
    }
    setError(null)
    onChange(assets.map((a) => (a.id === id ? { ...a, name: trimmed } : a)))
  }

  const remove = (id: string) => {
    onChange(assets.filter((a) => a.id !== id))
  }

  const removeImage = (assetId: string, src: string) => {
    onChange(
      assets.flatMap((a) => {
        if (a.id !== assetId) return [a]
        const images = a.images.filter((s) => s !== src)
        return images.length ? [{ ...a, images }] : []
      }),
    )
  }

  const insertMention = (name: string) => {
    window.dispatchEvent(
      new CustomEvent(INSERT_TOKEN_EVENT, { detail: `@${name}` }),
    )
  }

  const onPickAsset = (asset: Asset) => {
    const src = asset.images[0]
    if (!src) return
    insertMention(asset.name)
  }

  const uploadThumbs = [...assets].reverse().flatMap((asset) =>
    asset.images.map((src, i) => ({
      id: `${asset.id}:${i}`,
      assetId: asset.id,
      src,
      label: asset.images.length > 1 ? `${asset.name} ${i + 1}` : asset.name,
    })),
  )

  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept="image/*"
      multiple
      className="sr-only"
      onChange={(e) => void onFiles(e)}
    />
  )

  if (popover) {
    const thumbs: {
      id: string
      src: string
      kind: 'image' | 'video'
      label: string
      assetId?: string
    }[] =
      libTab === 'generated'
        ? generated.map((g) => ({
            id: g.id,
            src: g.src,
            kind: g.kind,
            label: g.kind === 'video' ? 'Video' : 'Generated',
          }))
        : uploadThumbs.map((t) => ({
            id: t.id,
            src: t.src,
            kind: 'image' as const,
            label: t.label,
            assetId: t.assetId,
          }))

    return (
      <aside
        className="asset-panel is-popover"
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="media-lib">
          <nav className="media-lib-nav" aria-label="Library">
            <button
              type="button"
              className={
                libTab === 'generated'
                  ? 'media-lib-nav-btn active'
                  : 'media-lib-nav-btn'
              }
              onClick={() => setLibTab('generated')}
            >
              <Sparkle size={18} weight="fill" />
              Generated
            </button>
            <button
              type="button"
              className={
                libTab === 'uploads'
                  ? 'media-lib-nav-btn active'
                  : 'media-lib-nav-btn'
              }
              onClick={() => setLibTab('uploads')}
            >
              <UploadSimple size={18} weight="bold" />
              Uploads
            </button>
          </nav>

          <div className="media-lib-body">
            <div className="media-lib-head">
              <span className="asset-panel-title">
                {libTab === 'generated' ? 'Generated' : 'Uploads'}
              </span>
              <div className="media-lib-head-actions">
                <button
                  type="button"
                  className="media-lib-upload"
                  onClick={() => pickFiles(null)}
                >
                  <Plus size={14} weight="bold" />
                  Upload
                </button>
                {onRequestClose && (
                  <button
                    type="button"
                    className="asset-panel-toggle"
                    title="Close"
                    onClick={onRequestClose}
                  >
                    <X size={14} weight="bold" />
                  </button>
                )}
              </div>
            </div>

            {error && <p className="asset-error">{error}</p>}

            {thumbs.length === 0 ? (
              <p className="asset-empty media-lib-empty">
                {libTab === 'generated'
                  ? 'No generated images yet. They show up here after a generate.'
                  : 'No uploads yet. Use Upload to add photos you can pick later.'}
              </p>
            ) : (
              <div className="media-lib-grid">
                {thumbs.map((thumb) => {
                  const assetId = thumb.assetId
                  return (
                  <div key={thumb.id} className="media-lib-cell">
                    <button
                      type="button"
                      className="media-lib-thumb"
                      draggable
                      onDragStart={(e) => {
                        setLibraryDrag({ src: thumb.src, kind: thumb.kind })
                        e.dataTransfer.effectAllowed = 'copy'
                        e.dataTransfer.setData('text/plain', thumb.label)
                        const preview = e.currentTarget.querySelector('img, video')
                        if (preview) e.dataTransfer.setDragImage(preview, 20, 20)
                      }}
                      onDragEnd={() => {
                        setLibraryDrag(null)
                        if (libraryLanded) onRequestClose?.()
                        libraryLanded = false
                      }}
                      title={
                        pickPurpose === 'color'
                          ? `Use as colour reference: ${thumb.label}`
                          : pickPurpose === 'body'
                            ? `Use as pose reference: ${thumb.label}`
                          : pickPurpose === 'clothes' || pickPurpose === 'detail-clothes'
                            ? `Use as clothes: ${thumb.label}`
                            : pickPurpose === 'detail-person' || pickPurpose === 'outfit-person'
                              ? `Use as original: ${thumb.label}`
                              : pickPurpose === 'outfit-clothes'
                                ? `Use as clothes: ${thumb.label}`
                              : pickPurpose === 'detail-bg'
                                ? `Use as background: ${thumb.label}`
                              : `Add to current references: ${thumb.label}`
                      }
                      onClick={() => {
                        if (libTab === 'generated') {
                          if (thumb.kind === 'image') {
                            addRef(thumb.src, 'Generated', pickPurpose)
                          }
                          onPickGenerated?.(thumb.id)
                          return
                        }
                        addRef(thumb.src, thumb.label, pickPurpose)
                      }}
                    >
                      {thumb.kind === 'video' ? (
                        <video
                          src={thumb.src}
                          muted
                          playsInline
                          preload="metadata"
                        />
                      ) : (
                        <img src={thumb.src} alt={thumb.label} />
                      )}
                    </button>
                    {libTab === 'uploads' && assetId && (
                      <button
                        type="button"
                        className="media-lib-remove"
                        title="Remove from library"
                        onClick={(e) => {
                          e.stopPropagation()
                          removeImage(assetId, thumb.src)
                        }}
                      >
                        <X size={10} weight="bold" />
                      </button>
                    )}
                  </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
        {fileInput}
      </aside>
    )
  }

  return (
    <aside
      className="asset-panel"
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="asset-panel-head">
        <span className="asset-panel-title">Library</span>
      </div>

      <div className="asset-add-row">
        <div className="asset-kind-tabs" role="group" aria-label="Asset type">
          {ASSET_KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              className={addKind === k.value ? 'asset-kind active' : 'asset-kind'}
              onClick={() => setAddKind(k.value)}
            >
              {k.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="asset-add-btn"
          title="Upload an image to create an asset"
          onClick={() => pickFiles(null)}
        >
          <Plus size={14} weight="bold" />
          New
        </button>
      </div>

      {error && <p className="asset-error">{error}</p>}

      <div className="asset-list">
        {assets.length === 0 && (
          <p className="asset-empty">
            Upload a person or product photo. Mention it in a prompt with @name.
          </p>
        )}
        {assets.map((asset) => (
          <div key={asset.id} className="asset-card">
            <button
              type="button"
              className="asset-thumb"
              title={`Insert @${asset.name}`}
              onClick={() => onPickAsset(asset)}
            >
              <img src={asset.images[0]} alt={asset.name} />
              {asset.images.length > 1 && (
                <span className="asset-count">{asset.images.length}</span>
              )}
            </button>
            <div className="asset-meta">
              <input
                className="asset-name"
                defaultValue={asset.name}
                key={asset.name}
                aria-label="Asset name"
                onBlur={(e) => rename(asset.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    ;(e.target as HTMLInputElement).blur()
                  }
                }}
              />
              <span className="asset-kind-tag">
                {ASSET_KINDS.find((k) => k.value === asset.kind)?.label}
              </span>
            </div>
            <div className="asset-actions">
              <button
                type="button"
                className="asset-mini-btn"
                title="Add image"
                onClick={() => pickFiles(asset.id)}
              >
                <Plus size={12} weight="bold" />
              </button>
              <button
                type="button"
                className="asset-mini-btn danger"
                title="Delete asset"
                onClick={() => remove(asset.id)}
              >
                <X size={12} weight="bold" />
              </button>
            </div>
          </div>
        ))}
      </div>
      {fileInput}
    </aside>
  )
}
