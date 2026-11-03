import { useEffect, useRef, useState } from 'react'
import { Plus, X } from '@phosphor-icons/react'
import { ADD_REF_EVENT, OPEN_LIBRARY_EVENT } from './AssetPanel'
import type { ImageProvider } from '../lib/genProvider'
import type { ImageMode } from '../lib/promptRefs'
import { toDataUri } from '../lib/imageData'
import { useCrop916 } from './ExtractPopup'
import { dressFetch } from '../lib/dressApi'

type Slot = 'person' | 'clothes'
type Category = 'tops' | 'bottoms' | 'one-pieces'
type Photo = 'model' | 'flat-lay'
type Engine = 'fashn' | 'leffa'

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'tops', label: 'Top' },
  { id: 'bottoms', label: 'Bottom' },
  { id: 'one-pieces', label: 'One-piece' },
]

const GARMENT_LINE: Record<Category, string> = {
  tops: 'one top',
  bottoms: 'one bottom garment such as pants, a skirt, or shorts',
  'one-pieces': 'one dress or jumpsuit',
}

type Props = {
  busy: boolean
  error: string | null
  selectionSrc: string | null
  imageProvider: ImageProvider
  imageMode: ImageMode
  onGenBusy: (busy: boolean) => void
  onPlace: (src: string) => Promise<void>
}

async function readFile(file: File | undefined): Promise<string | null> {
  if (!file?.type.startsWith('image/')) return null
  const url = URL.createObjectURL(file)
  try {
    return await toDataUri(url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function OutfitPanel({
  busy,
  error,
  selectionSrc,
  imageProvider,
  imageMode,
  onGenBusy,
  onPlace,
}: Props) {
  const [person, setPerson] = useState<string | null>(null)
  const [clothes, setClothes] = useState<string | null>(null)
  const [clothesPrompt, setClothesPrompt] = useState('')
  const [category, setCategory] = useState<Category>('tops')
  const [photoType, setPhotoType] = useState<Photo>('model')
  const [localBusy, setLocalBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const [job, setJob] = useState<'garment' | Engine | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const slotRef = useRef<Slot>('person')
  const fileRef = useRef<HTMLInputElement>(null)
  const { ask: askCrop, popup: cropPopup } = useCrop916()
  const source = person ?? selectionSrc
  const text = clothesPrompt.trim()
  const disabled = busy || localBusy
  const ready = Boolean(source && (clothes || text) && !disabled)

  useEffect(() => {
    onGenBusy(localBusy)
  }, [localBusy, onGenBusy])

  useEffect(() => () => onGenBusy(false), [onGenBusy])

  useEffect(() => {
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent<{ src?: string; purpose?: string }>).detail
      if (!detail?.src) return
      if (detail.purpose === 'outfit-person') {
        void askCrop(detail.src).then((cropped) => {
          if (cropped) setPerson(cropped)
        })
      }
      else if (detail.purpose === 'outfit-clothes') setClothes(detail.src)
    }
    window.addEventListener(ADD_REF_EVENT, onAdd)
    return () => window.removeEventListener(ADD_REF_EVENT, onAdd)
  }, [])

  const openLibrary = (slot: Slot) => {
    slotRef.current = slot
    window.dispatchEvent(
      new CustomEvent(OPEN_LIBRARY_EVENT, {
        detail: { purpose: slot === 'person' ? 'outfit-person' : 'outfit-clothes' },
      }),
    )
  }

  const makeGarment = async (prompt: string): Promise<string> => {
    const res = await dressFetch('/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: `Flat-lay product photo of ${GARMENT_LINE[category]} on a plain white background. No person, no mannequin, no face, no text. ${prompt}`,
        images: [],
        aspect_ratio: '9:16',
        image_mode: imageMode,
        provider: imageProvider,
      }),
    })
    const data = (await res.json()) as { src?: string; error?: string }
    if (!res.ok || !data.src) throw new Error(data.error || 'Clothes were not made')
    return data.src
  }

  const run = async (engine: Engine) => {
    if (!source || (!clothes && !text)) return
    setPicking(false)
    setLocalBusy(true)
    setLocalError(null)
    try {
      let garment = clothes
      let photo: Photo = clothes ? photoType : 'flat-lay'
      if (!garment) {
        setJob('garment')
        garment = await makeGarment(text)
        photo = 'flat-lay'
      }
      setJob(engine)
      const person = await toDataUri(source)
      const path = engine === 'fashn' ? '/fashn-tryon' : '/leffa-tryon'
      const res = await dressFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          person,
          garment: await toDataUri(garment),
          category,
          photo_type: photo,
          prompt: text,
        }),
      })
      const data = (await res.json()) as { src?: string; error?: string }
      if (!res.ok || !data.src) throw new Error(data.error || 'Outfit change failed')
      await onPlace(data.src)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Outfit change failed')
    } finally {
      setLocalBusy(false)
      setJob(null)
    }
  }

  const shown = localError || error
  const runLabel = job === 'garment' ? 'Making clothes…' : job ? 'Running…' : 'Run'

  return (
    <div className="prompt-bar detail-panel" onPointerDown={(e) => e.stopPropagation()}>
      <p className="detail-lead">After Run, choose FASHN VTON v1.5 or Leffa. A clothes photo is used as-is. Text only makes a flat garment first, then puts it on.</p>
      <div className="ref-row">
        <SlotButton
          label="Original"
          src={source}
          disabled={disabled}
          onOpen={() => openLibrary('person')}
          onClear={person ? () => setPerson(null) : undefined}
          onFile={() => {
            slotRef.current = 'person'
            fileRef.current?.click()
          }}
        />
        <SlotButton
          label="Clothes"
          src={clothes}
          disabled={disabled}
          onOpen={() => openLibrary('clothes')}
          onClear={clothes ? () => setClothes(null) : undefined}
          onFile={() => {
            slotRef.current = 'clothes'
            fileRef.current?.click()
          }}
        />
      </div>
      <textarea
        className="prompt-input detail-prompt"
        aria-label="Clothes description"
        placeholder="Describe the clothes, for example a red dress. A reference photo wins."
        value={clothesPrompt}
        disabled={disabled}
        onChange={(e) => setClothesPrompt(e.target.value)}
      />
      <ol className="detail-steps">
        <li>
          <div className="outfit-picks" role="group" aria-label="Garment type">
            {CATEGORIES.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={category === opt.id ? 'seg-chip active' : 'seg-chip'}
                disabled={disabled}
                onClick={() => setCategory(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {clothes && (
            <div className="outfit-picks" role="group" aria-label="Clothes photo">
              <button
                type="button"
                className={photoType === 'model' ? 'seg-chip active' : 'seg-chip'}
                disabled={disabled}
                onClick={() => setPhotoType('model')}
              >
                Worn
              </button>
              <button
                type="button"
                className={photoType === 'flat-lay' ? 'seg-chip active' : 'seg-chip'}
                disabled={disabled}
                onClick={() => setPhotoType('flat-lay')}
              >
                Flat lay
              </button>
            </div>
          )}
          {picking ? (
            <>
              <button type="button" className="detail-ready" onClick={() => void run('fashn')}>
                FASHN VTON v1.5
              </button>
              <button type="button" className="detail-ready" onClick={() => void run('leffa')}>
                Leffa
              </button>
              <button type="button" onClick={() => setPicking(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className={ready ? 'detail-ready' : undefined} disabled={!ready} onClick={() => setPicking(true)}>
              {runLabel}
            </button>
          )}
          <span>Worn and flat lay apply to FASHN only. FASHN is 576×864. Leffa is 768×1024.</span>
        </li>
      </ol>
      {shown && <p className="prompt-error">{shown}</p>}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          const slot = slotRef.current
          void readFile(file).then((src) => {
            if (!src) return
            if (slot === 'person') {
              void askCrop(src).then((cropped) => {
                if (cropped) setPerson(cropped)
              })
            }
            else setClothes(src)
          })
        }}
      />
      {cropPopup}
    </div>
  )
}

function SlotButton({
  label,
  src,
  disabled,
  onOpen,
  onClear,
  onFile,
}: {
  label: string
  src: string | null
  disabled: boolean
  onOpen: () => void
  onClear?: () => void
  onFile: () => void
}) {
  if (!src) {
    return (
      <button type="button" className="ref-add" disabled={disabled} onClick={onOpen}>
        <Plus size={16} weight="bold" />
        <span>{label}</span>
      </button>
    )
  }
  return (
    <button type="button" className="ref-thumb" disabled={disabled} title={`Replace ${label}`} onClick={onFile}>
      <img src={src} alt={label} />
      <span className="ref-role">{label}</span>
      {onClear && (
        <span
          className="ref-remove"
          role="button"
          tabIndex={0}
          aria-label={`Remove ${label}`}
          onClick={(e) => {
            e.stopPropagation()
            onClear()
          }}
        >
          <X size={10} weight="bold" />
        </span>
      )}
    </button>
  )
}
