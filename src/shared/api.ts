export type UploadedFileInfo = {
  path: string;
  size_bytes: number;
};

const DASHBOARD_TOKEN =
  (import.meta.env.VITE_DASHBOARD_TOKEN as string | undefined)?.trim() ||
  "dev-dashboard";

export function dashboardAuthHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  if (!headers.has("X-Dashboard-Token")) {
    headers.set("X-Dashboard-Token", DASHBOARD_TOKEN);
  }
  return headers;
}

function withDashboardHeaders(init?: RequestInit): Headers {
  return dashboardAuthHeaders(init?.headers);
}

export async function operatorFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
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
    headers,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<UploadedFileInfo>;
}
