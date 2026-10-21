/**
 * Media paths that Vite proxies to VITE_MEDIA_PROXY (see vite.config.ts).
 * Absolute URLs under these prefixes are rewritten to same-origin paths so
 * Three.js video textures / <img> loads go through the dev proxy (CORS-safe).
 */
const PROXIED_MEDIA_PREFIXES = [
  "/api/",
  "/cards/",
  "/models/",
  "/photo-scratch/",
  "/mesh/",
  "/themes/",
] as const;

function isProxiedMediaPath(pathname: string): boolean {
  return PROXIED_MEDIA_PREFIXES.some(
    (prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix),
  );
}

/**
 * Normalize backend/catalog media into a browser-loadable URL.
 * - Keeps blob: and data: as-is
 * - Strips a leading `public/` (admin/local paths)
 * - Rewrites absolute http(s) URLs whose path is under a Vite media proxy
 *   prefix into same-origin relative paths (so /models/... hits the proxy)
 * - Leaves other absolute URLs untouched
 */
export function normalizeMediaUrl(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  if (raw.startsWith("blob:") || raw.startsWith("data:")) return raw;

  if (/^(?:https?:)?\/\//i.test(raw)) {
    try {
      const absolute = new URL(raw, "https://placeholder.local");
      const pathWithSearch = `${absolute.pathname}${absolute.search}${absolute.hash}`;
      if (isProxiedMediaPath(absolute.pathname)) return pathWithSearch;
      if (/^https?:\/\//i.test(raw) || raw.startsWith("//")) return raw;
      return pathWithSearch;
    } catch {
      return raw;
    }
  }

  const withoutPublic = raw.replace(/^\.?\/?public\//, "");
  return withoutPublic.startsWith("/") ? withoutPublic : `/${withoutPublic}`;
}
