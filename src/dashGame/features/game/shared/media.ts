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

import { getGameAudioContext } from "./gameAudioContext";
import { soundMixOutput } from "./soundMix";

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** Wait until the element can start playback (or fail / timeout). */
export function waitForVideoCanPlay(
  video: HTMLVideoElement,
  timeoutMs = 8_000,
): Promise<boolean> {
  if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
      window.clearTimeout(timeoutId);
      resolve(ok);
    };
    const onReady = () => finish(true);
    const onError = () => finish(false);
    const timeoutId = window.setTimeout(() => finish(video.readyState >= 2), timeoutMs);

    video.addEventListener("canplay", onReady);
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("error", onError);

    // Kick the network if src is set but nothing has started.
    try {
      if (video.src && video.readyState === 0) video.load();
    } catch {
      // ignore
    }

    if (video.readyState >= 2 && video.videoWidth > 0) finish(true);
  });
}

/**
 * Live mute/unmute for an already-playing theme intro.
 *
 * After sound has been unlocked by a user gesture, mute with volume=0 only —
 * flipping muted=true mid-clip breaks WebKit unmute for the rest of the clip.
 *
 * Without a gesture (cold refresh), never clear muted — unmuted autoplay is
 * blocked and the intro would stall / get dismissed.
 */
const INTRO_SOUND_UNLOCKED = "data-intro-sound-unlocked";

export type ThemeIntroSoundOptions = {
  /** True when called from a click/tap — allowed to clear muted for autoplay. */
  forceUnmute?: boolean;
};

function introSoundUnlocked(video: HTMLVideoElement) {
  return video.hasAttribute(INTRO_SOUND_UNLOCKED);
}

function applyIntroMix(video: HTMLVideoElement) {
  video.volume = 1;
  const ctx = getGameAudioContext();
  const out = soundMixOutput("intro");
  if (!ctx || !out) return;
  const node =
    (video as HTMLVideoElement & { __mixSource?: MediaElementAudioSourceNode })
      .__mixSource ?? ctx.createMediaElementSource(video);
  (video as HTMLVideoElement & { __mixSource?: MediaElementAudioSourceNode }).__mixSource =
    node;
  try {
    node.disconnect();
  } catch {
    // not yet connected
  }
  node.connect(out);
}

function remuteForAutoplay(video: HTMLVideoElement) {
  video.volume = 1;
  video.muted = true;
  video.defaultMuted = true;
  video.setAttribute("muted", "");
  video.removeAttribute(INTRO_SOUND_UNLOCKED);
}

export function setThemeIntroSound(
  video: HTMLVideoElement,
  wantSound: boolean,
  options?: ThemeIntroSoundOptions,
): void {
  if (wantSound) {
    applyIntroMix(video);
    const canUnmute =
      options?.forceUnmute === true || introSoundUnlocked(video);
    if (!canUnmute) {
      // Pref says sound on, but no gesture yet — stay muted so autoplay works.
      video.muted = true;
      video.defaultMuted = true;
      video.setAttribute("muted", "");
      return;
    }
    video.muted = false;
    video.defaultMuted = false;
    video.removeAttribute("muted");
    video.setAttribute(INTRO_SOUND_UNLOCKED, "1");
    applyIntroMix(video);
    return;
  }
  video.volume = 0;
  // Soft-mute only once audio has been unlocked. Never flip muted back to true.
  if (introSoundUnlocked(video) || !video.muted) {
    video.muted = false;
    video.defaultMuted = false;
    video.removeAttribute("muted");
  }
}

/** Currently mounted theme-intro <video>, if any. */
let boundThemeIntroVideo: HTMLVideoElement | null = null;

/**
 * Bumped on every user mute/unmute so in-flight playThemeIntro awaits do not
 * re-assert muted=true over the user's choice.
 */
let themeIntroSoundEpoch = 0;

export function bindThemeIntroVideo(video: HTMLVideoElement | null) {
  if (!video) return;
  // Ensure first paint can autoplay before JS kick runs.
  if (!introSoundUnlocked(video)) {
    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute("muted", "");
  }
  boundThemeIntroVideo = video;
}

export function unbindThemeIntroVideo(video?: HTMLVideoElement | null) {
  if (video && boundThemeIntroVideo && video !== boundThemeIntroVideo) return;
  boundThemeIntroVideo = null;
}

function resolveIntroVideo(): HTMLVideoElement | null {
  return (
    boundThemeIntroVideo ??
    (typeof document !== "undefined"
      ? document.querySelector<HTMLVideoElement>(
          ".photo-scratch-intro-media video",
        )
      : null)
  );
}

/**
 * True when the intro is on screen but still autoplay-muted (no user gesture
 * unlock yet). Prefs may say "sound on" while nothing is audible.
 */
export function introNeedsGestureUnlock(): boolean {
  const video = resolveIntroVideo();
  if (!video) return false;
  return video.muted && !introSoundUnlocked(video);
}

/** True when the theme intro clip is producing audible output. */
export function introVideoIsAudible() {
  const video = resolveIntroVideo();
  if (!video || video.paused || video.ended) return false;
  return !video.muted && video.volume > 0;
}

/**
 * Apply mute pref to the live intro element. Safe to call from the mute
 * button click (same gesture) even if React refs/subscribers lag.
 */
export function applyBoundThemeIntroSound(wantSound: boolean) {
  themeIntroSoundEpoch += 1;
  const video = resolveIntroVideo();
  if (!video) return;
  boundThemeIntroVideo = video;
  setThemeIntroSound(video, wantSound, { forceUnmute: true });
  if (!wantSound) return;
  // Clearing muted often pauses the element — resume inside this same gesture.
  void video.play().catch(() => undefined);
}

/**
 * Retry intro playback after a failed kick. Never flips muted=true once the
 * user has gesture-unlocked — that permanently breaks WebKit unmute.
 */
export function retryThemeIntroPlayback(video: HTMLVideoElement) {
  if (!introSoundUnlocked(video)) {
    remuteForAutoplay(video);
  }
  void video.play().catch(() => undefined);
}

async function applyIntroSoundAndResume(
  video: HTMLVideoElement,
  wantSound: boolean,
  forceUnmute: boolean,
): Promise<ThemeIntroPlayback> {
  setThemeIntroSound(video, wantSound, { forceUnmute });
  if (video.paused) {
    try {
      await video.play();
    } catch {
      // Never remute after the user unlocked — keep waiting for a gesture play.
      if (!introSoundUnlocked(video)) {
        remuteForAutoplay(video);
        void video.play().catch(() => undefined);
      }
    }
  }
  return {
    muted: video.muted || video.volume === 0,
    playing: !video.paused,
  };
}

/**
 * Kick a theme-intro clip. Starts muted (allowed without a user gesture on
 * Android/iOS — e.g. F5 / post-fetch mount), then tries to unmute when sound
 * is enabled.
 *
 * `wantSound` may be a getter so mute flips during await are respected —
 * otherwise a late unmute can undo a user mute mid-intro.
 *
 * Waits for canplay and retries — calling play() at readyState 0 often rejects
 * (AbortError / background-media pause) and must not tear down the overlay.
 *
 * If mute/unmute bumps the sound epoch (or unlocks) while waiting for canplay,
 * still run the resume play() path — applyBoundThemeIntroSound may have failed
 * play() before the element was ready.
 */
export async function playThemeIntro(
  video: HTMLVideoElement,
  wantSound: boolean | (() => boolean),
): Promise<ThemeIntroPlayback> {
  const soundWanted = () =>
    typeof wantSound === "function" ? wantSound() : wantSound;
  const epochAtStart = themeIntroSoundEpoch;

  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");

  // Already running (or user already unlocked sound) — never re-enter the
  // muted=true autoplay path; that permanently breaks WebKit unmute.
  if ((!video.paused && video.readyState >= 2) || introSoundUnlocked(video)) {
    return applyIntroSoundAndResume(
      video,
      soundWanted(),
      introSoundUnlocked(video),
    );
  }

  remuteForAutoplay(video);

  const ready = await waitForVideoCanPlay(video);
  if (!ready) return { muted: true, playing: false };
  if (themeIntroSoundEpoch !== epochAtStart || introSoundUnlocked(video)) {
    return applyIntroSoundAndResume(
      video,
      soundWanted(),
      introSoundUnlocked(video),
    );
  }

  let playing = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (themeIntroSoundEpoch !== epochAtStart || introSoundUnlocked(video)) {
      return applyIntroSoundAndResume(
        video,
        soundWanted(),
        introSoundUnlocked(video),
      );
    }
    try {
      remuteForAutoplay(video);
      await video.play();
      if (!video.paused) {
        playing = true;
        break;
      }
    } catch {
      // AbortError when decode interrupts play — wait and retry.
    }
    await delay(40 + attempt * 40);
  }

  if (!playing) return { muted: true, playing: false };

  // Apply mute pref without force-unmute. Cold refresh has no gesture — clearing
  // muted here pauses the clip. Sound is enabled from the mute button / entry tap.
  setThemeIntroSound(video, soundWanted());
  applyIntroMix(video);
  return {
    muted: video.muted || video.volume === 0,
    playing: true,
  };
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

function videoHasFrame(video: HTMLVideoElement): boolean {
  return video.readyState >= 2 && video.videoWidth > 1;
}

function currentVideoSrc(video: HTMLVideoElement): string {
  return video.currentSrc || video.src || "";
}

function sameVideoSrc(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  try {
    return new URL(left, window.location.href).href === new URL(right, window.location.href).href;
  } catch {
    return false;
  }
}

/**
 * Attach `src` without wiping a decoded frame first.
 * Calling load() on an empty src flashes black — reuse the current picture
 * until the next clip has HAVE_CURRENT_DATA.
 */
export function loadVideoSrc(
  video: HTMLVideoElement,
  src: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (sameVideoSrc(currentVideoSrc(video), src) && videoHasFrame(video)) {
      resolve();
      return;
    }

    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("error", onError);
      if (ok) resolve();
      else reject(new Error(`Failed to load video: ${src}`));
    };
    const onReady = () => {
      if (videoHasFrame(video)) finish(true);
    };
    const onError = () => finish(false);

    video.addEventListener("loadeddata", onReady);
    video.addEventListener("canplay", onReady);
    video.addEventListener("error", onError);
    video.preload = "auto";
    video.src = src;
    // Cached / already-ready.
    if (videoHasFrame(video) && sameVideoSrc(currentVideoSrc(video), src)) {
      finish(true);
    }
  });
}
