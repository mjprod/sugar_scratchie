/** How a generated item was produced — enables in-place regeneration. */
export type GenMeta = {
  mediaKind: 'image' | 'video'
  /** Image prompt, or video motion prompt for clips */
  prompt: string
  /** Voiceover / dialogue line (storyboard clips) */
  script?: string
  /** i2v start frame source (storyboard still / start frame) */
  startSrc?: string
  /** Reference images used for image generation */
  refs?: string[]
  aspect?: string
  imageMode?: 'speed' | '720'
  duration?: number
  resolution?: string
}

export type CanvasItem = {
  id: string
  src: string
  /** Default image when omitted */
  kind?: 'image' | 'video'
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  /** 0–1. Omitted means fully opaque. */
  opacity?: number
  /** Optional note shown under the item (e.g. storyboard script / video prompt) */
  caption?: string
  /** Present on generated items; carries params for regeneration */
  genMeta?: GenMeta
}

export type InteractionMode = 'select' | 'pan'
