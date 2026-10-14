import { api, operatorFetch } from "./api";

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
  /** Optional loop that replaces the game-wide default for this theme. */
  bgm?: string | null;
} & ThemeCardColors;

export type ThemeCatalog = {
  themes: ThemeInfo[];
  defaultBgm: string | null;
};

export async function fetchThemeCatalog(): Promise<ThemeCatalog> {
  const data = await api<{ themes: ThemeInfo[]; default_bgm?: string | null }>("/api/themes");
  const defaultBgm = typeof data.default_bgm === "string" ? data.default_bgm.trim() : "";
  return {
    themes: Array.isArray(data.themes) ? data.themes : [],
    defaultBgm: defaultBgm || null,
  };
}

export async function fetchThemes(): Promise<ThemeInfo[]> {
  return (await fetchThemeCatalog()).themes;
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
  const response = await operatorFetch(`/api/themes/${encodeURIComponent(themeId)}/intro`, {
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

async function uploadMp3(path: string, file: File): Promise<Response> {
  const form = new FormData();
  form.append("file", file);
  const response = await operatorFetch(path, { method: "POST", body: form });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response;
}

export async function uploadDefaultBgm(file: File): Promise<string> {
  const response = await uploadMp3("/api/bgm/default", file);
  const data = (await response.json()) as { default_bgm?: string | null };
  const url = data.default_bgm?.trim() || "";
  if (!url) throw new Error("Default background music was not stored");
  return url;
}

export async function deleteDefaultBgm(): Promise<void> {
  await api("/api/bgm/default", { method: "DELETE" });
}

export async function uploadThemeBgm(themeId: string, file: File): Promise<ThemeInfo> {
  const response = await uploadMp3(`/api/themes/${encodeURIComponent(themeId)}/bgm`, file);
  return response.json() as Promise<ThemeInfo>;
}

export async function deleteThemeBgm(themeId: string): Promise<ThemeInfo> {
  return api<ThemeInfo>(`/api/themes/${encodeURIComponent(themeId)}/bgm`, {
    method: "DELETE",
  });
}
