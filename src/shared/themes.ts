import { api } from "./api";

export type ThemeCardColors = {
  cardOverlayColorStart?: string | null;
  cardOverlayColorEnd?: string | null;
  cardLightColor1?: string | null;
  cardLightColor2?: string | null;
};

export type ThemeInfo = {
  id: string;
  label: string;
  sort_order: number;
  created_at?: number | null;
  /** One-time in-game intro clip shared by every motion card in this theme. */
  intro?: string | null;
} & ThemeCardColors;

export async function fetchThemes(): Promise<ThemeInfo[]> {
  const data = await api<{ themes: ThemeInfo[] }>("/api/themes");
  return Array.isArray(data.themes) ? data.themes : [];
}

export async function createTheme(
  id: string,
  label: string,
  colors?: ThemeCardColors,
): Promise<ThemeInfo> {
  return api<ThemeInfo>("/api/themes", {
    method: "POST",
    body: JSON.stringify({ id, label, ...(colors ?? {}) }),
  });
}

export async function updateTheme(
  themeId: string,
  payload: { label?: string; sort_order?: number } & ThemeCardColors,
): Promise<ThemeInfo> {
  return api<ThemeInfo>(`/api/themes/${encodeURIComponent(themeId)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deleteTheme(themeId: string): Promise<void> {
  await api(`/api/themes/${encodeURIComponent(themeId)}`, { method: "DELETE" });
}

export async function reorderThemes(themeIds: string[]): Promise<ThemeInfo[]> {
  const data = await api<{ themes: ThemeInfo[] }>("/api/themes/order", {
    method: "PUT",
    body: JSON.stringify({ theme_ids: themeIds }),
  });
  return Array.isArray(data.themes) ? data.themes : [];
}

/** Uploads the one-time intro clip played in-game before the player's first scratch. */
export async function uploadThemeIntro(themeId: string, file: File): Promise<ThemeInfo> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`/api/themes/${encodeURIComponent(themeId)}/intro`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<ThemeInfo>;
}

export async function deleteThemeIntro(themeId: string): Promise<ThemeInfo> {
  return api<ThemeInfo>(`/api/themes/${encodeURIComponent(themeId)}/intro`, {
    method: "DELETE",
  });
}
