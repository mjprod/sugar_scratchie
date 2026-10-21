/** Explicit demo fixtures. Never auto-enable from a dead API. */
export function isDemoMode(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("demo") === "1";
}
