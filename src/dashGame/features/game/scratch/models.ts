import { api } from './api'

export type ModelInfo = {
  id: string
  label: string
  avatar: string | null
  created_at?: number | null
  /** theme_id → public URL for model×theme collection avatar. */
  theme_avatars?: Record<string, string>
  tags?: string[]
}

/** Models list for the scratch game playlist picker. */
export async function fetchModels(): Promise<ModelInfo[]> {
  try {
    const data = await api<{ models: ModelInfo[] }>('/api/models')
    return data.models
  } catch {
    try {
      const response = await fetch('/models/index.json', { cache: 'no-store' })
      if (!response.ok) return []
      const data = (await response.json()) as { models?: ModelInfo[] }
      return data.models ?? []
    } catch {
      return []
    }
  }
}
