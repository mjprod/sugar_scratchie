import { api } from "./api";

export type ThemeSessionStatus = "fallback" | "draft" | "scheduled" | "running" | "ended";

export type ThemeSessionInfo = {
  id: string;
  label: string;
  acronym?: string | null;
  is_default: boolean;
  theme_ids: string[];
  starts_at?: string | null;
  ends_at?: string | null;
  status: ThemeSessionStatus;
  is_running: boolean;
  sort_order: number;
};

export async function fetchThemeSessions(): Promise<ThemeSessionInfo[]> {
  const data = await api<{ sessions: ThemeSessionInfo[] }>("/api/theme-sessions");
  return Array.isArray(data.sessions) ? data.sessions : [];
}

export async function createThemeSession(
  id: string,
  label: string,
  acronym: string,
): Promise<ThemeSessionInfo> {
  return api<ThemeSessionInfo>("/api/theme-sessions", {
    method: "POST",
    body: JSON.stringify({ id, label, acronym }),
  });
}

export async function updateThemeSession(
  sessionId: string,
  payload: { id: string; label: string; acronym: string },
): Promise<ThemeSessionInfo> {
  return api<ThemeSessionInfo>(`/api/theme-sessions/${encodeURIComponent(sessionId)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function setThemeSessionThemes(
  sessionId: string,
  themeIds: string[],
): Promise<ThemeSessionInfo> {
  return api<ThemeSessionInfo>(`/api/theme-sessions/${encodeURIComponent(sessionId)}/themes`, {
    method: "PUT",
    body: JSON.stringify({ theme_ids: themeIds }),
  });
}

export async function setThemeSessionWindow(
  sessionId: string,
  startsAt: string,
  endsAt: string,
): Promise<ThemeSessionInfo[]> {
  const data = await api<{ sessions: ThemeSessionInfo[] }>(
    `/api/theme-sessions/${encodeURIComponent(sessionId)}/schedule`,
    {
      method: "PUT",
      body: JSON.stringify({ starts_at: startsAt, ends_at: endsAt }),
    },
  );
  return Array.isArray(data.sessions) ? data.sessions : [];
}

export async function deleteThemeSession(sessionId: string): Promise<ThemeSessionInfo[]> {
  const data = await api<{ sessions: ThemeSessionInfo[] }>(
    `/api/theme-sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
  return Array.isArray(data.sessions) ? data.sessions : [];
}
