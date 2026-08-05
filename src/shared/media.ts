/**
 * Safari keeps decoder buffers for <video> unless the element is explicitly
 * unloaded. Prefer reusing elements and swapping src via loadVideoSrc — do not
 * remount with a new React key each card.
 */

export type ThemeIntroPlayback = {
  /** Whether the element is muted after the kick attempt. */
  muted: boolean;
  /** False when autoplay failed — caller should dismiss the intro overlay. */
  playing: boolean;
};

/**
 * Kick a theme-intro clip. Starts muted (allowed without a user gesture on
 * Android/iOS — e.g. F5 / post-fetch mount), then tries to unmute when sound
 * is enabled.
 */
export async function playThemeIntro(
  video: HTMLVideoElement,
  wantSound: boolean,
): Promise<ThemeIntroPlayback> {
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");

  video.muted = true;
  video.setAttribute("muted", "");
  try {
    await video.play();
  } catch {
    return { muted: true, playing: false };
  }

  if (!wantSound) return { muted: true, playing: !video.paused };

  video.muted = false;
  video.removeAttribute("muted");
  try {
    if (video.paused) await video.play();
  } catch {
    video.muted = true;
    video.setAttribute("muted", "");
    void video.play().catch(() => undefined);
    return { muted: true, playing: !video.paused };
  }

  if (video.paused) {
    video.muted = true;
    video.setAttribute("muted", "");
    void video.play().catch(() => undefined);
    return { muted: true, playing: !video.paused };
  }

  return { muted: video.muted, playing: true };
}

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
