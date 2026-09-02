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

function videoElementFirstFrameJpeg(video: HTMLVideoElement): string | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return null;
  }
}

function captureVideoElementFirstFrame(
  video: HTMLVideoElement,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const existing = videoElementFirstFrameJpeg(video);
    if (existing) {
      resolve(existing);
      return;
    }

    function cleanup() {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
    }

    let settled = false;
    function settle(result?: string, error?: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("Video has no dimensions"));
    }

    function onReady() {
      const frame = videoElementFirstFrameJpeg(video);
      if (frame) settle(frame);
      else settle(undefined, new Error("Video has no dimensions"));
    }

    function onError() {
      settle(undefined, new Error("Video decode failed"));
    }

    video.addEventListener("loadeddata", onReady);
    video.addEventListener("error", onError);

    try {
      video.load();
    } catch (caught) {
      settle(undefined, caught instanceof Error ? caught : new Error("Video load failed"));
    }
}

/** JPEG data URL of the first decoded frame — for upload previews before the clip plays. */
export function captureVideoFirstFrame(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = objectUrl;

  return captureVideoElementFirstFrame(video).finally(() => {
    URL.revokeObjectURL(objectUrl);
    try {
      video.removeAttribute("src");
      video.src = "";
      video.load();
    } catch {
      // ignore
    }
  });
}

/** JPEG data URL of the first decoded frame from a served clip URL. */
export function captureVideoSrcFirstFrame(src: string): Promise<string> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = src;
  return captureVideoElementFirstFrame(video).finally(() => {
    try {
      video.removeAttribute("src");
      video.src = "";
      video.load();
    } catch {
      // ignore
    }
  });
}

/** Turn a canvas/data-URL JPEG into a File for operator upload endpoints. */
export function dataUrlToFile(dataUrl: string, filename: string): File {
  const [header, base64 = ""] = dataUrl.split(",");
  const mime = header?.match(/data:(.*?);/)?.[1] ?? "image/jpeg";
  const bytes = atob(base64);
  const buffer = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);
  return new File([buffer], filename, { type: mime });
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
