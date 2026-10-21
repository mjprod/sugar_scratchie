/**
 * Looped ambient MP3 during motion scratch.
 * Gated by the effective background-music pref (Settings switch + in-game
 * master mute).
 *
 * Web Audio buffer looping (gapless) on the shared game AudioContext, which
 * is suspended while the page is hidden. Option 1 mix:
 * - foil / center bar: quiet bed
 * - after dock settles: full level
 * - pause menu open: ducked to the bed level
 * - hand end: fade out
 */

import {
  effectiveBackgroundMusic,
  subscribeGameAudioPrefs,
} from "@/services/gameAudioPrefs";
import {
  getGameAudioContext,
  getGameAudioOutput,
  peekGameAudioContext,
} from "../shared/gameAudioContext";
import { normalizeMediaUrl } from "@/lib/mediaUrl";
import { soundMixOutput } from "../shared/soundMix";
import { resolveMotionScratchBgmGain } from "./motionScratchBgmPolicy";

/**
 * Shipped loop in the player `public/bgm` folder (not a media-proxy path).
 * The themes API replaces this with the dashboard default, or a theme track.
 */
export const MOTION_SCRATCH_BGM_SRC = "/bgm/magnific-nuestra-madre_01.mp3";

/** Quiet bed under foil scratch (linear gain 0–1). */
export const MOTION_SCRATCH_BGM_BED_GAIN = 0.22;
/** Full hunt level after the bar docks. */
export const MOTION_SCRATCH_BGM_FULL_GAIN = 1;

/** Ease into the foil bed. */
export const MOTION_SCRATCH_BGM_FADE_IN_MS = 240;
/** Bed → full after dock. */
export const MOTION_SCRATCH_BGM_BED_TO_FULL_MS = 320;
/** Ease-out when the hand resolves / stage leaves. */
export const MOTION_SCRATCH_BGM_FADE_OUT_MS = 560;
/** Duck / unduck when the pause menu opens or closes. */
export const MOTION_SCRATCH_BGM_DUCK_MS = 240;
/** After a failed fetch/decode, don't refetch on every tap for this long. */
export const MOTION_SCRATCH_BGM_RETRY_MS = 10_000;

export type MotionScratchBgmOptions = {
  /** Target linear gain while active (default full). */
  targetGain?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
};

const buffers = new Map<string, AudioBuffer>();
const bufferPromises = new Map<string, Promise<AudioBuffer | null>>();
const lastLoadFailureAt = new Map<string, number>();
/** URL the stage wants looping. Falls back to the shipped default. */
let requestedSrc = MOTION_SCRATCH_BGM_SRC;
let source: AudioBufferSourceNode | null = null;
let gain: GainNode | null = null;
/** Wall-clock when the current source started (ctx time). */
let sourceStartedAt = 0;
/** Offset into the buffer when the current source started. */
let sourceOffset = 0;
/** True while the stage wants the loop running. */
let desiredPlaying = false;
/** Last requested audible level while desiredPlaying. */
let desiredGain = MOTION_SCRATCH_BGM_FULL_GAIN;
/** Pause menu open — cap the level at the bed. */
let ducked = false;
/** Gain the current source is at or ramping toward. */
let appliedGain = 0;
/** Bumps on every sync so an older unmute's await can't restart after mute. */
let syncGeneration = 0;
let fadeStopTimer: number | null = null;
/** Whether the pending fade-out keeps the loop position (mute) or rewinds. */
let fadeKeepOffset = false;
let prefsUnsub: (() => void) | null = null;

function soundUrl(src: string) {
  if (typeof document === "undefined") return src;
  return new URL(src, document.location.href).href;
}

function bgmAllowed() {
  return effectiveBackgroundMusic();
}

function ensureListeners() {
  if (prefsUnsub || typeof window === "undefined") return;
  // Mute / settings writes are synchronous — resume() must stay in that click
  // so Safari treats it as a user gesture.
  prefsUnsub = subscribeGameAudioPrefs(() => {
    syncMotionScratchBgm();
  });
}

function clearFadeStopTimer() {
  if (fadeStopTimer == null) return;
  window.clearTimeout(fadeStopTimer);
  fadeStopTimer = null;
}

function clampGain(value: number) {
  if (!Number.isFinite(value)) return MOTION_SCRATCH_BGM_FULL_GAIN;
  return Math.max(0, Math.min(1, value));
}

/**
 * Resume + silent tick must stay synchronous inside a user gesture.
 * Awaiting fetch/decode first drops Safari's activation token.
 */
function resumeContextForGesture(audioCtx: AudioContext): void {
  if (audioCtx.state === "running") return;
  void audioCtx.resume().catch(() => undefined);
  try {
    const tick = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
    const sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = tick;
    sourceNode.connect(audioCtx.destination);
    sourceNode.start(0);
  } catch {
    // ignore
  }
}

function activeBgmSrc(src?: string | null): string {
  const trimmed = src?.trim() || "";
  if (!trimmed) return MOTION_SCRATCH_BGM_SRC;
  // Catalog URLs are often absolute media-host paths. Rewrite those under
  // Vite proxy prefixes so fetch() stays same-origin (CORS-safe decode).
  return normalizeMediaUrl(trimmed);
}

/**
 * Theme track wins when both a theme key and a theme URL are set.
 * Otherwise the catalog default, then the shipped `/bgm/default.mp3`.
 */
export function resolveMotionScratchBgmSrc(
  themeKey: string,
  themeSrc: string | null | undefined,
  defaultSrc: string | null | undefined,
): string {
  if (themeKey.trim() && themeSrc?.trim()) return activeBgmSrc(themeSrc);
  return activeBgmSrc(defaultSrc);
}

/** Switch the loop. A different URL restarts from the beginning. */
export function setMotionScratchBgmSrc(src: string): void {
  const next = activeBgmSrc(src);
  if (next === requestedSrc) return;
  requestedSrc = next;
  sourceOffset = 0;
  if (source || fadeStopTimer != null) {
    stopSource(false);
    if (gain) gain.gain.value = 0;
  }
  if (desiredPlaying) syncMotionScratchBgm();
}

async function ensureBuffer(src: string): Promise<AudioBuffer | null> {
  const cached = buffers.get(src);
  if (cached) return cached;
  const pending = bufferPromises.get(src);
  if (pending) return pending;
  const failedAt = lastLoadFailureAt.get(src) ?? 0;
  if (failedAt > 0 && Date.now() - failedAt < MOTION_SCRATCH_BGM_RETRY_MS) {
    return null;
  }
  const promise = (async () => {
    const audioCtx = getGameAudioContext();
    if (!audioCtx) return null;
    try {
      const res = await fetch(soundUrl(src));
      if (!res.ok) return null;
      const data = await res.arrayBuffer();
      // copy before decode — some engines detach the buffer
      return await audioCtx.decodeAudioData(data.slice(0));
    } catch {
      return null;
    }
  })().then((decoded) => {
    bufferPromises.delete(src);
    if (decoded) {
      buffers.set(src, decoded);
      lastLoadFailureAt.delete(src);
      return decoded;
    }
    lastLoadFailureAt.set(src, Date.now());
    return null;
  });
  bufferPromises.set(src, promise);
  return promise;
}

function elapsedOffset(audioCtx: AudioContext): number {
  const buf = source?.buffer;
  if (!source || !buf) return sourceOffset;
  const elapsed = Math.max(0, audioCtx.currentTime - sourceStartedAt);
  const dur = buf.duration;
  if (dur <= 0) return 0;
  return (sourceOffset + elapsed) % dur;
}

function stopSource(keepOffset: boolean) {
  clearFadeStopTimer();
  const audioCtx = peekGameAudioContext();
  if (source && audioCtx && keepOffset && source.buffer) {
    sourceOffset = elapsedOffset(audioCtx);
  }
  if (!keepOffset) sourceOffset = 0;
  if (source) {
    try {
      source.onended = null;
      source.stop();
    } catch {
      // already stopped
    }
    try {
      source.disconnect();
    } catch {
      // ignore
    }
    source = null;
  }
  appliedGain = 0;
}

function ensureGain(audioCtx: AudioContext): GainNode {
  if (!gain) {
    gain = audioCtx.createGain();
    gain.gain.value = 0;
    gain.connect(soundMixOutput("bgm") ?? getGameAudioOutput(audioCtx));
  }
  return gain;
}

/** Cancel pending ramps and snap/ramp gain. */
function rampGain(to: number, fadeMs: number) {
  const audioCtx = peekGameAudioContext();
  if (!audioCtx || !gain) return;
  const now = audioCtx.currentTime;
  const param = gain.gain;
  param.cancelScheduledValues(now);
  const target = clampGain(to);
  appliedGain = target;
  if (fadeMs <= 0) {
    param.setValueAtTime(target, now);
    return;
  }
  const current = Math.max(param.value, 0.0001);
  param.setValueAtTime(current, now);
  const end = now + fadeMs / 1000;
  if (target <= 0) {
    param.exponentialRampToValueAtTime(0.0001, end);
    param.setValueAtTime(0, end);
  } else {
    // exponentialRamp can't start at 0 — nudge up first.
    if (param.value < 0.0001) param.setValueAtTime(0.0001, now);
    param.exponentialRampToValueAtTime(Math.max(0.0001, target), end);
  }
}

function startSourceAt(
  audioCtx: AudioContext,
  buf: AudioBuffer,
  target: number,
  fadeInMs: number,
) {
  stopSource(true);
  const g = ensureGain(audioCtx);
  g.gain.value = 0;
  const next = audioCtx.createBufferSource();
  next.buffer = buf;
  next.loop = true;
  // Full-buffer loop is gapless with decoded PCM (unlike HTMLAudio MP3 loop).
  next.loopStart = 0;
  next.loopEnd = buf.duration;
  next.connect(g);
  const offset = buf.duration > 0 ? sourceOffset % buf.duration : 0;
  sourceOffset = offset;
  sourceStartedAt = audioCtx.currentTime;
  next.start(0, offset);
  source = next;
  rampGain(target, fadeInMs);
}

/**
 * Call synchronously from a user-gesture handler (Play / Continue / unmute).
 * Resuming the shared AudioContext inside the gesture is what lets Safari
 * start the loop after in-app navigation. Cheap no-op once running + loaded,
 * so it is safe on every scratch touch.
 */
export function unlockMotionScratchBgm(): void {
  const audioCtx = getGameAudioContext();
  if (!audioCtx) return;
  if (audioCtx.state === "running" && buffers.has(requestedSrc)) return;
  resumeContextForGesture(audioCtx);
  void ensureBuffer(requestedSrc);
}

/**
 * Apply desired + mute + duck state.
 * - Active + unmuted: ensure playing at the (ducked) desired gain.
 * - Muted mid-loop: pause (keep position) with a short fade.
 * - Stage off: fade out, then rewind.
 */
export function syncMotionScratchBgm(options?: MotionScratchBgmOptions): void {
  if (options?.targetGain != null) {
    desiredGain = clampGain(options.targetGain);
  }
  const fadeInMs = options?.fadeInMs ?? MOTION_SCRATCH_BGM_FADE_IN_MS;
  const fadeOutMs = options?.fadeOutMs ?? MOTION_SCRATCH_BGM_FADE_OUT_MS;

  if (desiredPlaying && bgmAllowed()) {
    const audioCtx = getGameAudioContext();
    if (!audioCtx) return;
    const target = resolveMotionScratchBgmGain(
      desiredGain,
      ducked,
      MOTION_SCRATCH_BGM_BED_GAIN,
    );
    // Already looping at this level — nothing to do (every scratch touch
    // lands here, so keep it allocation-free). A live slider move snaps.
    const src = requestedSrc;
    const cached = buffers.get(src);
    if (
      source &&
      cached &&
      source.buffer === cached &&
      fadeStopTimer == null &&
      audioCtx.state === "running"
    ) {
      if (appliedGain !== target) rampGain(target, fadeInMs);
      return;
    }
    const gen = ++syncGeneration;
    clearFadeStopTimer();
    // Safari: resume + silent tick MUST run before any await (gesture token).
    resumeContextForGesture(audioCtx);
    void (async () => {
      const buf = await ensureBuffer(src);
      if (
        gen !== syncGeneration ||
        !buf ||
        requestedSrc !== src ||
        !desiredPlaying ||
        !bgmAllowed()
      ) {
        return;
      }
      if (source && source.buffer !== buf) {
        sourceOffset = 0;
        stopSource(false);
      }
      // Context may still be catching up after a sync resume(); don't await.
      if (audioCtx.state === "suspended") {
        void audioCtx.resume().catch(() => undefined);
      }
      if (!source) {
        startSourceAt(audioCtx, buf, target, fadeInMs);
      } else {
        // Already looping — ramp level (bed ↔ full, duck, or unmute restore).
        rampGain(target, fadeInMs);
      }
    })();
    return;
  }

  syncGeneration += 1;
  // Muted but still on stage: freeze position after fade. Left stage: rewind.
  const keepOffset = desiredPlaying;
  if (source && gain && fadeOutMs > 0) {
    fadeKeepOffset = keepOffset;
    // A fade-out is already running — let it finish instead of restarting.
    if (fadeStopTimer != null) return;
    rampGain(0, fadeOutMs);
    fadeStopTimer = window.setTimeout(() => {
      fadeStopTimer = null;
      stopSource(fadeKeepOffset);
      if (gain) gain.gain.value = 0;
    }, fadeOutMs + 24);
    return;
  }
  stopSource(keepOffset);
  if (gain) gain.gain.value = 0;
}

/** Arm or disarm the loop; optional targetGain for bed vs full. */
export function setMotionScratchBgmActive(
  active: boolean,
  options?: MotionScratchBgmOptions,
): void {
  ensureListeners();
  desiredPlaying = active;
  if (options?.targetGain != null) {
    desiredGain = clampGain(options.targetGain);
  } else if (active && desiredGain <= 0) {
    desiredGain = MOTION_SCRATCH_BGM_FULL_GAIN;
  }
  if (active) preloadMotionScratchBgm();
  syncMotionScratchBgm(options);
}

/** Convenience: foil bed level. */
export function setMotionScratchBgmBed(options?: MotionScratchBgmOptions): void {
  setMotionScratchBgmActive(true, {
    fadeInMs: MOTION_SCRATCH_BGM_FADE_IN_MS,
    ...options,
    targetGain: options?.targetGain ?? MOTION_SCRATCH_BGM_BED_GAIN,
  });
}

/** Convenience: full hunt level. */
export function setMotionScratchBgmFull(options?: MotionScratchBgmOptions): void {
  setMotionScratchBgmActive(true, {
    fadeInMs: MOTION_SCRATCH_BGM_BED_TO_FULL_MS,
    ...options,
    targetGain: options?.targetGain ?? MOTION_SCRATCH_BGM_FULL_GAIN,
  });
}

export function stopMotionScratchBgm(options?: MotionScratchBgmOptions): void {
  setMotionScratchBgmActive(false, options);
}

/** Pause menu open: cap the loop at the bed level until it closes. */
export function setMotionScratchBgmDucked(next: boolean): void {
  if (ducked === next) return;
  ducked = next;
  syncMotionScratchBgm({ fadeInMs: MOTION_SCRATCH_BGM_DUCK_MS });
}

export function preloadMotionScratchBgm(): void {
  void ensureBuffer(requestedSrc);
}

/** True while the buffer source is actually outputting. */
export function isMotionScratchBgmPlaying(): boolean {
  const audioCtx = peekGameAudioContext();
  return Boolean(
    desiredPlaying &&
      bgmAllowed() &&
      source &&
      audioCtx &&
      audioCtx.state === "running",
  );
}
