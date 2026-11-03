import { useEffect, useState } from 'react'
import type { ImageProvider } from '../lib/genProvider'
import type { ImageMode } from '../lib/promptRefs'
import { dressFetch } from '../lib/dressApi'

type Props = {
  busy: boolean
  error: string | null
  imageProvider: ImageProvider
  imageMode: ImageMode
  onGenBusy: (busy: boolean) => void
  onPlace: (src: string) => Promise<void>
}

export function buildDressPrompt(text: string): string {
  return [
    'Catalog product photo of one outfit, front-facing, centered, from the neckline to the knee.',
    'Nothing below the knee.',
    'Seamless light gray studio background.',
    'Invisible mannequin: the clothes hold a worn shape, but there is no person, no head, no face, no hair, and no visible skin. The neck opening is empty.',
    'Clothing only. No legs, no hands, no shoes, no socks, and no boots. Sleeves end empty.',
    'Do not draw a real model. Do not lay the clothes flat on white.',
    'Build only the outfit described below. Do not invent a different garment.',
    'Style it as current K-pop idol fashion: polished, coordinated, and stage-ready.',
    text.trim(),
  ].join(' ')
}

export function BuildDressPanel({ busy, error, imageProvider, imageMode, onGenBusy, onPlace }: Props) {
  const [text, setText] = useState('')
  const [localBusy, setLocalBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const disabled = busy || localBusy
  const ready = Boolean(text.trim()) && !disabled

  useEffect(() => {
    onGenBusy(localBusy)
  }, [localBusy, onGenBusy])

  useEffect(() => () => onGenBusy(false), [onGenBusy])

  const build = async () => {
    const prompt = text.trim()
    if (!prompt) return
    setLocalBusy(true)
    setLocalError(null)
    try {
      const res = await dressFetch('/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: buildDressPrompt(prompt),
          images: [],
          aspect_ratio: '9:16',
          image_mode: imageMode,
          provider: imageProvider,
        }),
      })
      const data = (await res.json()) as { src?: string; error?: string }
      if (!res.ok || !data.src) throw new Error(data.error || 'The dress was not made')
      await onPlace(data.src)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'The dress was not made')
    } finally {
      setLocalBusy(false)
    }
  }

  const shown = localError || error

  return (
    <div className="prompt-bar detail-panel" onPointerDown={(e) => e.stopPropagation()}>
      <p className="detail-lead">Describe one outfit. The style is K-pop. It stops at the knee. Clothes only: no legs, hands, or shoes.</p>
      <textarea
        className="prompt-input detail-prompt"
        aria-label="Dress description"
        placeholder="For example a black lace dress, thin straps, above the knee."
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
      />
      <ol className="detail-steps">
        <li>
          <button type="button" className={ready ? 'detail-ready' : undefined} disabled={!ready} onClick={() => void build()}>
            {localBusy ? 'Making the dress…' : 'Build Dress'}
          </button>
          <span>This only makes the clothes. Put them on a person with Outfit Change or Quick.</span>
        </li>
      </ol>
      {shown && <p className="prompt-error">{shown}</p>}
    </div>
  )
}

const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv
if (argv?.[1]?.includes('BuildDressPanel')) {
  const made = buildDressPrompt('黑色蕾絲洋裝')
  if (
    !made.includes('Seamless light gray') ||
    !made.includes('Invisible mannequin') ||
    !made.includes('front-facing') ||
    !made.includes('no person') ||
    !made.includes('neck opening is empty') ||
    !made.includes('Nothing below the knee') ||
    !made.includes('No legs, no hands, no shoes') ||
    made.includes('to the shoes') ||
    made.includes('Boots, tights') ||
    !made.includes('Do not invent a different garment') ||
    !made.includes('K-pop idol fashion') ||
    !made.includes('黑色蕾絲洋裝') ||
    made.includes('empty fabric') ||
    made.includes('plain white') ||
    made.includes('Flat-lay')
  ) {
    throw new Error('build dress prompt')
  }
  console.log('build-dress ok')
}
