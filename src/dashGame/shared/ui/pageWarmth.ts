import { Paths } from "@/routes/Paths";

const warmedPageKeys = new Set<string>();
let pageReadyEpoch = 0;

export function pageKey(pathname: string, search: string) {
  return `${pathname}${search}`;
}

/** Routes whose first useful view is async — overlay waits on markReady(). */
export function routeNeedsWait(pathname: string) {
  if (pathname === Paths.preLoader || pathname === Paths.loading) return false;
  if (pathname === Paths.home) return true;
  if (pathname.startsWith(Paths.discover)) return true;
  if (pathname.startsWith(Paths.rank)) return true;
  if (pathname.startsWith(Paths.search)) return true;
  if (pathname.startsWith("/creator/")) return true;
  if (pathname === Paths.recommendSwipe) return true;
  if (pathname.startsWith("/purchase/")) return true;
  if (pathname === Paths.coverflowV2) return true;
  if (pathname === Paths.mobileCarousel) return true;
  return false;
}

export function resetPageReady() {
  pageReadyEpoch += 1;
  warmedPageKeys.clear();
}

export function currentPageReadyEpoch() {
  return pageReadyEpoch;
}

export function isPageKeyWarmed(key: string) {
  return warmedPageKeys.has(key);
}

export function markPageKeyWarmed(key: string) {
  warmedPageKeys.add(key);
}

export function isPageWarmed(pathname: string, search: string) {
  return isPageKeyWarmed(pageKey(pathname, search));
}
