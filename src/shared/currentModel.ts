/** The girl selected on Models. Run flow and Dress follow this. */
const STORAGE_KEY = "sugar-operator:model";

export function readSavedModelId(): string {
  try {
    return localStorage.getItem(STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function readCurrentModelId(search = window.location.search): string {
  const fromUrl = new URLSearchParams(search).get("model")?.trim() ?? "";
  if (fromUrl) return fromUrl;
  return readSavedModelId();
}

export function writeCurrentModelId(id: string) {
  const next = id.trim();
  try {
    if (next) localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode */
  }
}

export function hrefWithModel(path: string, modelId: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  const girl = modelId.trim();
  if (girl) params.set("model", girl);
  for (const [key, value] of Object.entries(extra ?? {})) {
    const trimmed = value.trim();
    if (trimmed) params.set(key, trimmed);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
