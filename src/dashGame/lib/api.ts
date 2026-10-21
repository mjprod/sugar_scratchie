import { API_BASE_URL } from "../env";

const DEFAULT_TIMEOUT_MS = 6_000;

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export type ApiGetFailReason = "unauthorized" | "timeout" | "network" | "http";

export type ApiGetResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: ApiGetFailReason; status: number };

function resolveUrl(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  const base = API_BASE_URL.trim().replace(/\/+$/, "");
  const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return base ? `${base}${normalized}` : normalized;
}

async function request(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { signal: userSignal, headers: userHeaders, ...rest } = init;
    if (userSignal) {
      if (userSignal.aborted) controller.abort();
      else userSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const headers = new Headers(userHeaders);
    if (!headers.has("Content-Type") && typeof rest.body === "string") {
      headers.set("Content-Type", "application/json");
    }

    return await fetch(resolveUrl(path), {
      cache: "no-store",
      credentials: "include",
      headers,
      ...rest,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function apiGet<T>(
  path: string,
  init: RequestInit = {},
): Promise<ApiGetResult<T>> {
  try {
    const response = await request(path, init);
    if (response.status === 401) {
      return { ok: false, reason: "unauthorized", status: 401 };
    }
    if (!response.ok) {
      return { ok: false, reason: "http", status: response.status };
    }
    const text = await response.text();
    if (!text) return { ok: false, reason: "http", status: response.status };
    return { ok: true, data: JSON.parse(text) as T };
  } catch (error) {
    const timeout =
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError");
    return {
      ok: false,
      reason: timeout ? "timeout" : "network",
      status: 0,
    };
  }
}

/**
 * Fail-soft JSON helper. Prefer `apiGet` when you need to tell timeout from 401.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T | null> {
  const result = await apiGet<T>(path, init);
  return result.ok ? result.data : null;
}

/** Strict helper for mutations — throws ApiError on non-OK. */
export async function apiMutate<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await request(path, init, 15_000);
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const detail =
      body && typeof body === "object" && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : response.statusText;
    throw new ApiError(response.status, detail, body);
  }
  return body as T;
}
