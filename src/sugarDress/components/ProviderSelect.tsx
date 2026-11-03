import {
  GEN_PROVIDERS,
  IMAGE_PROVIDERS,
  type GenProvider,
  type ImageProvider,
} from '../lib/genProvider'

type BaseProps = {
  caption?: string
  disabled?: boolean
}

type VideoProps = BaseProps & {
  value: GenProvider
  onChange: (provider: GenProvider) => void
}

export function ProviderSelect({ value, onChange, disabled, caption }: VideoProps) {
  return (
    <label className={`provider-select${caption ? ' is-labeled' : ''}`} title={caption ?? 'Video provider'}>
      {caption ? <span className="provider-select-caption">{caption}</span> : <span className="sr-only">Video provider</span>}
      <select
        value={value}
        disabled={disabled}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => onChange(e.target.value as GenProvider)}
      >
        {GEN_PROVIDERS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  )
}

type ImageProps = BaseProps & {
  value: ImageProvider
  onChange: (provider: ImageProvider) => void
}

export function ImageProviderSelect({ value, onChange, disabled, caption }: ImageProps) {
  return (
    <label className={`provider-select${caption ? ' is-labeled' : ''}`} title={caption ?? 'Image provider'}>
      {caption ? <span className="provider-select-caption">{caption}</span> : <span className="sr-only">Image provider</span>}
      <select
        value={value}
        disabled={disabled}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => onChange(e.target.value as ImageProvider)}
      >
        {IMAGE_PROVIDERS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  )
}

