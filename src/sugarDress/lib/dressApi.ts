/** Dress endpoints live on the Vite process, not FastAPI. */
export const DRESS_API = "/dress-api";

export function dressUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${DRESS_API}${suffix}`;
}

type ErrorBody = {
  error?: string;
  detail?: string | { msg?: string }[];
};

export async function dressFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(dressUrl(path), init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      throw new Error(
        "Dress API unreachable. Keep npm run dev running on :5080 and try again.",
      );
    }
    throw err instanceof Error ? err : new Error(message);
  }
}

export async function readDressError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as ErrorBody;
    if (typeof data.error === "string" && data.error.trim()) return data.error;
    if (typeof data.detail === "string" && data.detail.trim()) return data.detail;
    if (Array.isArray(data.detail) && data.detail[0]?.msg) return String(data.detail[0].msg);
  } catch {
    /* non-JSON */
  }
  return fallback;
}
