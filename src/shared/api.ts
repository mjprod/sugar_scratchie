export type UploadedFileInfo = {
  path: string;
  size_bytes: number;
};

/** Optional local override — prefer the httpOnly cookie from /api/auth/operator/login. */
const DASHBOARD_TOKEN =
  (import.meta.env.VITE_DASHBOARD_TOKEN as string | undefined)?.trim() || "";

export function dashboardAuthHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  if (DASHBOARD_TOKEN && !headers.has("X-Dashboard-Token")) {
    headers.set("X-Dashboard-Token", DASHBOARD_TOKEN);
  }
  return headers;
}

function withDashboardHeaders(init?: RequestInit): Headers {
  return dashboardAuthHeaders(init?.headers);
}

export async function operatorFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    credentials: "include",
    ...init,
    headers: dashboardAuthHeaders(init?.headers),
  });
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = withDashboardHeaders(init);
  if (!headers.has("Content-Type") && typeof init?.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<T>;
}

export async function uploadFile(file: File): Promise<UploadedFileInfo> {
  const headers = withDashboardHeaders({
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
    },
  });
  const response = await fetch("/api/files/upload", {
    method: "POST",
    body: file,
    credentials: "include",
    headers,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<UploadedFileInfo>;
}

export async function fetchOperatorSession(): Promise<boolean> {
  const response = await fetch("/api/auth/operator/session", {
    credentials: "include",
    headers: dashboardAuthHeaders(),
  });
  return response.ok;
}

export async function operatorLogin(token: string): Promise<void> {
  const response = await fetch("/api/auth/operator/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401) {
      throw new Error("Invalid dashboard token.");
    }
    if (response.status === 429) {
      throw new Error("Too many attempts — wait a few minutes and try again.");
    }
    throw new Error(text || response.statusText);
  }
}

export async function operatorLogout(): Promise<void> {
  await fetch("/api/auth/operator/logout", {
    method: "POST",
    credentials: "include",
  });
}
