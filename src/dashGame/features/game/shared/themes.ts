import { CATALOG_TTL_MS, cachedRequest } from '../../../lib/cachedRequest'
import { normalizeMediaUrl } from '../../../lib/mediaUrl'
import { api } from '../scratch/api'

export type ThemeInfo = {
  id: string
  label: string
  sort_order: number
  created_at?: number | null
  /** One-time in-game intro clip shared by every motion card in this theme. */
  intro?: string | null
  /** Optional loop that replaces the game-wide default for this theme. */
  bgm?: string | null
  cardOverlayColorStart?: string | null
  cardOverlayColorEnd?: string | null
  cardLightColor1?: string | null
  cardLightColor2?: string | null
}

export type ThemeCatalog = {
  themes: ThemeInfo[]
  defaultBgm: string | null
}

/** Theme intro clips are off for performance; flip to re-enable. */
export const THEME_INTROS_ENABLED = false

function emptyCatalog(): ThemeCatalog {
  return { themes: [], defaultBgm: null }
}

/** Themes plus the game-wide default music URL (read-only, shared across callers). */
export function fetchThemeCatalog(): Promise<ThemeCatalog> {
  return cachedRequest('/api/themes', CATALOG_TTL_MS, async () => {
    try {
      const data = await api<{ themes: ThemeInfo[]; default_bgm?: string | null }>(
        '/api/themes',
      )
      const defaultBgm =
        typeof data.default_bgm === 'string'
          ? normalizeMediaUrl(data.default_bgm.trim())
          : ''
      return {
        themes: Array.isArray(data.themes)
          ? data.themes.map((theme) => {
              const raw = typeof theme?.bgm === 'string' ? theme.bgm.trim() : ''
              return raw ? { ...theme, bgm: normalizeMediaUrl(raw) } : theme
            })
          : [],
        defaultBgm: defaultBgm || null,
      }
    } catch {
      return emptyCatalog()
    }
  })
}

/** Themes list for motion intro clips (read-only, shared across callers). */
export function fetchThemes(): Promise<ThemeInfo[]> {
  return fetchThemeCatalog().then((catalog) => catalog.themes)
}
