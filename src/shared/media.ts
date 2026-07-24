/**
 * Safari keeps decoder buffers for <video> unless the element is explicitly
 * unloaded. Prefer reusing elements and swapping src via loadVideoSrc — do not
 * remount with a new React key each card.
 */

export function releaseMediaElement(el: HTMLMediaElement | null | undefined) {
  if (!el) return;
  try {
    el.pause();
  } catch {
    // ignore
  }
  try {
    el.removeAttribute("src");
    el.src = "";
    el.load();
  } catch {
    // ignore
  }
}

/** Unload the current clip, then load `src` on the same element. */
export function loadVideoSrc(
  video: HTMLVideoElement,
  src: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      video.pause();
    } catch {
      // ignore
    }
    // Drop the previous decoder before attaching the next URL.
    try {
      video.removeAttribute("src");
      video.src = "";
      video.load();
    } catch {
      // ignore
    }

    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
      if (ok) resolve();
      else reject(new Error(`Failed to load video: ${src}`));
    };
    const onReady = () => finish(true);
    const onError = () => finish(false);

    video.addEventListener("loadeddata", onReady);
    video.addEventListener("error", onError);
    video.src = src;
    video.load();
    // Cached / already-ready.
    if (video.readyState >= 2) finish(true);
  });
}
