import { useEffect, useRef, useState } from 'react'
import { Plus, X } from '@phosphor-icons/react'
import { ADD_REF_EVENT, OPEN_LIBRARY_EVENT } from './AssetPanel'
import { ExtractPopup, useCrop916 } from './ExtractPopup'
import { toDataUri } from '../lib/imageData'
import { dressFetch } from '../lib/dressApi'

type Slot = 'person' | 'clothes' | 'bg'

type Props = {
  busy: boolean
  error: string | null
  selectionSrc: string | null
  onPlace: (src: string) => Promise<void>
  onDress: (cutout: string, clothing: string | null, prompt: string) => Promise<void>
  onMakeBackground: (
    prompt: string,
    size: { w: number; h: number },
    reference: string | null,
    person: string,
  ) => Promise<{ src: string; person: string }>
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

export function DetailPanel({
  busy,
  error,
  selectionSrc,
  onPlace,
  onDress,
  onMakeBackground,
}: Props) {
  const [person, setPerson] = useState<string | null>(null)
  const [skipSelection, setSkipSelection] = useState<string | null>(null)
  const [clothes, setClothes] = useState<string | null>(null)
  const [clothesPrompt, setClothesPrompt] = useState('')
  const [background, setBackground] = useState<string | null>(null)
  const [bgPrompt, setBgPrompt] = useState('')
  const [cutout, setCutout] = useState<string | null>(null)
  const [frameSize, setFrameSize] = useState<{ w: number; h: number } | null>(null)
  const [popup, setPopup] = useState(false)
  const [localBusy, setLocalBusy] = useState(false)
  const [job, setJob] = useState<'extract' | 'dress' | 'bg' | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const slotRef = useRef<Slot>('person')
  const fileRef = useRef<HTMLInputElement>(null)
  const { ask: askCrop, popup: cropPopup } = useCrop916()
  const source = person ?? (selectionSrc && selectionSrc !== skipSelection ? selectionSrc : null)
  const disabled = busy || localBusy

  useEffect(() => {
    const onAdd = (e: Event) => {
      const detail = (e as CustomEvent<{ src?: string; purpose?: string }>).detail
      if (!detail?.src) return
      if (detail.purpose === 'detail-person') {
        void askCrop(detail.src).then((cropped) => {
          if (!cropped) return
          setPerson(cropped)
          setSkipSelection(null)
        })
      }
      else if (detail.purpose === 'detail-clothes') setClothes(detail.src)
      else if (detail.purpose === 'detail-bg') setBackground(detail.src)
    }
    window.addEventListener(ADD_REF_EVENT, onAdd)
    return () => window.removeEventListener(ADD_REF_EVENT, onAdd)
  }, [])

  const openLibrary = (slot: Slot) => {
    slotRef.current = slot
    const purpose =
      slot === 'person' ? 'detail-person' : slot === 'clothes' ? 'detail-clothes' : 'detail-bg'
    window.dispatchEvent(new CustomEvent(OPEN_LIBRARY_EVENT, { detail: { purpose } }))
  }

  const extract = async (crop: { x: number; y: number; w: number; h: number; method: 'modnet' }) => {
    if (!source) return
    setLocalBusy(true)
    setJob('extract')
    setLocalError(null)
    try {
      const src = await toDataUri(source)
      const res = await dressFetch('/extract-person', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          src,
          x: crop.x,
          y: crop.y,
          w: crop.w,
          h: crop.h,
          method: crop.method,
        }),
      })
      const data = (await res.json()) as { src?: string; error?: string }
      if (!res.ok || !data.src) throw new Error(data.error || 'Extract failed')
      setCutout(data.src)
      setFrameSize({ w: Math.max(1, Math.round(crop.w)), h: Math.max(1, Math.round(crop.h)) })
      await onPlace(data.src)
      setPopup(false)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Extract failed')
    } finally {
      setLocalBusy(false)
      setJob(null)
    }
  }

  const dress = async () => {
    const text = clothesPrompt.trim()
    if (!cutout || (!clothes && !text)) return
    setLocalBusy(true)
    setJob('dress')
    setLocalError(null)
    try {
      await onDress(cutout, clothes, text)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Clothes on failed')
    } finally {
      setLocalBusy(false)
      setJob(null)
    }
  }

  const layBackground = async () => {
    const figure = selectionSrc ?? cutout
    const text = bgPrompt.trim()
    if (!figure || !frameSize || (!background && !text)) return
    setLocalBusy(true)
    setJob('bg')
    setLocalError(null)
    try {
      const made = text ? await onMakeBackground(text, frameSize, background, figure) : null
      const plate = made?.src ?? background
      const person = made?.person ?? figure
      if (!plate) return
      const res = await dressFetch('/composite-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          person: await toDataUri(person),
          background: await toDataUri(plate),
          width: frameSize.w,
          height: frameSize.h,
        }),
      })
      const data = (await res.json()) as { src?: string; error?: string }
      if (!res.ok || !data.src) throw new Error(data.error || 'Background composite failed')
      await onPlace(data.src)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Background composite failed')
    } finally {
      setLocalBusy(false)
      setJob(null)
    }
  }

  const shown = localError || error

  return (
    <div className="prompt-bar detail-panel" onPointerDown={(e) => e.stopPropagation()}>
      <p className="detail-lead">Extract the person, then put on clothes, then add a background. Face, body, and skin stay the original.</p>
      <div className="ref-row">
        <SlotButton
          label="Original"
          src={source}
          disabled={disabled}
          onOpen={() => openLibrary('person')}
          onClear={
            source
              ? () => {
                  setPerson(null)
                  setSkipSelection(selectionSrc)
                }
              : undefined
          }
          filledOpensLibrary
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
        <SlotButton
          label="Background"
          src={background}
          disabled={disabled}
          onOpen={() => openLibrary('bg')}
          onClear={background ? () => setBackground(null) : undefined}
          onFile={() => {
            slotRef.current = 'bg'
            fileRef.current?.click()
          }}
        />
      </div>
      <ol className="detail-steps">
        <li>
          <button
            type="button"
            className={source && !disabled ? 'detail-ready' : undefined}
            disabled={disabled || !source}
            onClick={() => setPopup(true)}
          >
            1. Extract person
          </button>
          <span>Frame the area first. Extract runs when you press Run.</span>
        </li>
        <li>
          <textarea
            className="prompt-input detail-prompt"
            aria-label="Clothes description"
            placeholder="Describe the clothes, for example a red dress. A reference photo is used too."
            value={clothesPrompt}
            disabled={disabled}
            onChange={(e) => setClothesPrompt(e.target.value)}
          />
          <button
            type="button"
            disabled={disabled || !cutout || (!clothes && !clothesPrompt.trim())}
            onClick={() => void dress()}
          >
            {job === 'dress' ? 'Running…' : 'Run'}
          </button>
          <span>Clothes go on when you press Run. They fit the original body. Face and skin stay the original.</span>
        </li>
        <li>
          <span className="detail-note">3. If the colour is off, use Match colour on the image.</span>
        </li>
        <li>
          <textarea
            className="prompt-input detail-prompt"
            aria-label="Background description"
            placeholder="Describe the background, for example a beach at night. A reference photo is used too."
            value={bgPrompt}
            disabled={disabled}
            onChange={(e) => setBgPrompt(e.target.value)}
          />
          <button
            type="button"
            disabled={
              disabled || !frameSize || (!background && !bgPrompt.trim()) || !(selectionSrc ?? cutout)
            }
            onClick={() => void layBackground()}
          >
            {job === 'bg' ? 'Running…' : 'Run'}
          </button>
          <span>The background is applied when you press Run. The result keeps the size from step 1.</span>
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
            else if (slot === 'clothes') setClothes(src)
            else setBackground(src)
          })
        }}
      />
      {popup && source && (
        <ExtractPopup
          src={source}
          busy={disabled}
          onCancel={() => setPopup(false)}
          onExtract={(crop) => void extract(crop)}
        />
      )}
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
  filledOpensLibrary,
}: {
  label: string
  src: string | null
  disabled: boolean
  onOpen: () => void
  onClear?: () => void
  onFile: () => void
  filledOpensLibrary?: boolean
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
    <button
      type="button"
      className="ref-thumb"
      disabled={disabled}
      title={`Replace ${label}`}
      onClick={filledOpensLibrary ? onOpen : onFile}
    >
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
