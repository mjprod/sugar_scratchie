/** Dress endpoints live on the Vite process, not FastAPI. */
export const DRESS_API = "/dress-api";

export function dressUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${DRESS_API}${suffix}`;
}

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
