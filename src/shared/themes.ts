import { api } from "./api";

export type ThemeInfo = {
  id: string;
  label: string;
  sort_order: number;
  created_at?: number | null;
};

export async function fetchThemes(): Promise<ThemeInfo[]> {
  const data = await api<{ themes: ThemeInfo[] }>("/api/themes");
  return Array.isArray(data.themes) ? data.themes : [];
}

export async function createTheme(id: string, label: string): Promise<ThemeInfo> {
  return api<ThemeInfo>("/api/themes", {
    method: "POST",
    body: JSON.stringify({ id, label }),
  });
}

export async function updateTheme(
  themeId: string,
  payload: { label?: string; sort_order?: number },
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
