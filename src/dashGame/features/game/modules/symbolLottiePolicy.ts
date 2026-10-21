/**
 * DotLottie / symbol-worker quieting + preload (Phase 7).
 *
 * Early Phase 7 forced main-thread (`preferStatic`) icons on coarse pointers to
 * cut Safari worker `message` traffic — those icons looked soft/broken on
 * phones vs the OffscreenCanvas worker path. Prefer the worker everywhere
 * OffscreenCanvas exists; keep preload so Tap-to-play does not fetch mid-hunt.
 */

export function shouldPreferStaticSymbolLottie(opts: {
  coarsePointer: boolean;
}): boolean {
  void opts.coarsePointer;
  return false;
}

/** Only honor an explicit pause (e.g. matched / flight). Never freeze for scratch. */
export function shouldFreezeSymbolLottie(opts: {
  basePaused: boolean;
  coarsePointer: boolean;
  isScratching: boolean;
}): boolean {
  void opts.coarsePointer;
  void opts.isScratching;
  return opts.basePaused;
}

/** Fetch symbol (and related) lottie URLs into HTTP cache before Tap to play. */
export async function preloadLottieUrls(urls: string[]): Promise<void> {
  const unique = [...new Set(urls.filter((u) => typeof u === "string" && u))];
  await Promise.all(
    unique.map(async (url) => {
      try {
        const absolute =
          typeof window !== "undefined"
            ? new URL(url, window.location.href).href
            : url;
        const res = await fetch(absolute, { credentials: "same-origin" });
        if (!res.ok) return;
        await res.arrayBuffer();
      } catch {
        // Best-effort — missing assets must not block play.
      }
    }),
  );
}
