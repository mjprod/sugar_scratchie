/**
 * Scratch SFX — clips ring out in full and pile up (slot-machine chaos).
 *
 * A stroke opens on a short clip; if the finger keeps scratching past the end
 * of that clip, the next one comes from the medium tier, then long. Lifting
 * or holding still never cuts a clip — it plays to its end, and the next
 * stroke layers a fresh clip on top. Rubbing over already-scratched fabric
 * fades them out (after a short grace); mute / leaving the stage silences
 * them outright. Gated by game soundEffect prefs.
 *
 * Clips carry up to 2s of trailing silence, so chaining is timed off each
 * clip's audible end (measured at decode) rather than the file end.
 */

import { effectiveSoundEffect } from "@/services/gameAudioPrefs";
import {
  gameAudioStartTime,
  getGameAudioContext,
  getGameAudioOutput,
} from "../shared/gameAudioContext";
import { soundMixOutput } from "../shared/soundMix";

/**
 * Must not start with "/scratch" (or any other prefix in the vite.config proxy
 * list) — the dev proxy matches by string prefix and would forward these to
 * the media origin, which answers with its SPA HTML.
 */
export const SCRATCH_SOUND_TIERS = {
  short: [
    "/sfx/scratch/scratch_short_sound_1.mp3",
    "/sfx/scratch/scratch_short_sound_2.mp3",
    "/sfx/scratch/scratch_short_sound_3.mp3",
  ],
  medium: [
    "/sfx/scratch/scratch_medium_sound_1.mp3",
    "/sfx/scratch/scratch_medium_sound_2.mp3",
  ],
  long: [
    "/sfx/scratch/scratch_long_sound_1.mp3",
    "/sfx/scratch/scratch_long_sound_2.mp3",
  ],
} as const;

export type ScratchSoundTier = keyof typeof SCRATCH_SOUND_TIERS;

/** Continuous scratching time before the next chained clip is medium / long. */
export const SCRATCH_SOUND_MEDIUM_AFTER_MS = 1000;
export const SCRATCH_SOUND_LONG_AFTER_MS = 2800;
/** Mute / unmount fade. */
const SCRATCH_SOUND_FADE_OUT_S = 0.08;
/** Softer fade when the finger moves onto already-scratched fabric. */
const SCRATCH_SOUND_QUIET_FADE_S = 0.15;
/**
 * How long a stroke may stay on already-scratched fabric before its clips
 * fade — a quick pass across a cleared strip shouldn't chop the sound.
 */
export const SCRATCH_STALE_QUIET_MS = 150;
/** Next clip starts this far before the current one's audible tail ends. */
const SCRATCH_SOUND_CHAIN_OVERLAP_S = 0.06;
const SCRATCH_SOUND_VOLUME = 0.9;
/** ± playback-rate spread so repeated clips don't sound identical. */
const SCRATCH_SOUND_RATE_JITTER = 0.06;
/** ~-40 dBFS; samples below this count as trailing silence. */
const SCRATCH_SOUND_SILENCE_LEVEL = 0.01;
/** A clip that failed to load/decode isn't refetched until this has passed. */
export const SCRATCH_SOUND_RETRY_MS = 10_000;
/**
 * A stamp that landed on a suspended context still plays if the context
 * resumes within this window (covers a tap that lifts before resume settles).
 */
const SCRATCH_SOUND_RESUME_GRACE_MS = 500;

const ALL_SCRATCH_SOUND_SRCS: readonly string[] = Object.values(
  SCRATCH_SOUND_TIERS,
).flat();

type Clip = { buffer: AudioBuffer; audibleEnd: number };
type Voice = {
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** Context time at which the next clip should take over. */
  chainAt: number;
  fading: boolean;
};

const pendingClips = new Map<string, Promise<Clip | null>>();
const readyClips = new Map<string, Clip>();
const failedAtMs = new Map<string, number>();
const liveVoices = new Set<Voice>();
let currentVoice: Voice | null = null;
let strokeStartMs: number | null = null;
let lastSrc: string | null = null;
/** performance.now() of the latest stamp that hit a suspended context. */
let suspendedStampMs: number | null = null;
let resumeWatchedCtx: AudioContext | null = null;
/** performance.now() when the stroke first landed on scratched fabric. */
let staleSinceMs: number | null = null;

export function scratchSoundTier(activeMs: number): ScratchSoundTier {
  if (activeMs >= SCRATCH_SOUND_LONG_AFTER_MS) return "long";
  if (activeMs >= SCRATCH_SOUND_MEDIUM_AFTER_MS) return "medium";
  return "short";
}

function audibleEnd(buffer: AudioBuffer): number {
  let last = 0;
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = data.length - 1; i > last; i -= 1) {
      if (Math.abs(data[i]) > SCRATCH_SOUND_SILENCE_LEVEL) {
        last = i;
        break;
      }
    }
  }
  return last > 0 ? (last + 1) / buffer.sampleRate : buffer.duration;
}

function loadClip(ctx: AudioContext, src: string): void {
  if (readyClips.has(src) || pendingClips.has(src)) return;
  const failedAt = failedAtMs.get(src);
  if (failedAt != null && performance.now() - failedAt < SCRATCH_SOUND_RETRY_MS)
    return;
  const next = fetch(src)
    .then((response) => {
      if (!response.ok) throw new Error(`Failed to load ${src}`);
      return response.arrayBuffer();
    })
    // decodeAudioData detaches the buffer; pass a copy for Safari.
    .then((data) => ctx.decodeAudioData(data.slice(0)))
    .then((buffer) => {
      const clip = { buffer, audibleEnd: audibleEnd(buffer) };
      readyClips.set(src, clip);
      failedAtMs.delete(src);
      pendingClips.delete(src);
      return clip;
    })
    .catch(() => {
      // Retry after a backoff (offline blip, decode race on iOS) — stamps
      // call preload at pointer-move rate while nothing is ready.
      failedAtMs.set(src, performance.now());
      pendingClips.delete(src);
      return null;
    });
  pendingClips.set(src, next);
}

/** Fetch + decode every scratch clip. Call from a user gesture. */
export function preloadScratchSounds(): void {
  if (typeof fetch === "undefined") return;
  const ctx = getGameAudioContext();
  if (!ctx) return;
  for (const src of ALL_SCRATCH_SOUND_SRCS) loadClip(ctx, src);
}

function pickClip(tier: ScratchSoundTier): { src: string; clip: Clip } | null {
  const tierSrcs: readonly string[] = SCRATCH_SOUND_TIERS[tier];
  const ready = tierSrcs.filter((src) => readyClips.has(src));
  // Tier still decoding on a cold start — any ready clip beats silence.
  const pool = ready.length
    ? ready
    : ALL_SCRATCH_SOUND_SRCS.filter((src) => readyClips.has(src));
  if (!pool.length) return null;
  const fresh = pool.length > 1 ? pool.filter((src) => src !== lastSrc) : pool;
  const src = fresh[Math.floor(Math.random() * fresh.length)]!;
  return { src, clip: readyClips.get(src)! };
}

function startVoice(ctx: AudioContext, clip: Clip) {
  const source = ctx.createBufferSource();
  source.buffer = clip.buffer;
  const rate = 1 + (Math.random() * 2 - 1) * SCRATCH_SOUND_RATE_JITTER;
  source.playbackRate.value = rate;
  const gain = ctx.createGain();
  gain.gain.value = SCRATCH_SOUND_VOLUME;
  source.connect(gain);
  gain.connect(soundMixOutput("scratch") ?? getGameAudioOutput(ctx));
  const startAt = gameAudioStartTime(ctx);
  const voice: Voice = {
    source,
    gain,
    chainAt: startAt + clip.audibleEnd / rate - SCRATCH_SOUND_CHAIN_OVERLAP_S,
    fading: false,
  };
  source.onended = () => {
    liveVoices.delete(voice);
    if (currentVoice === voice) currentVoice = null;
    source.disconnect();
    gain.disconnect();
  };
  liveVoices.add(voice);
  currentVoice = voice;
  source.start(startAt);
}

/**
 * Finger lifted: clips already playing ring out, and the next stroke starts a
 * new short clip on top of them instead of waiting for the chain.
 */
export function endScratchSoundStroke(): void {
  strokeStartMs = null;
  currentVoice = null;
  staleSinceMs = null;
}

function fadeLiveVoices(fadeS: number): void {
  if (!liveVoices.size) return;
  const ctx = getGameAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const voice of liveVoices) {
    if (voice.fading) continue;
    voice.fading = true;
    const param = voice.gain.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(0, now + fadeS);
    try {
      voice.source.stop(now + fadeS);
    } catch {
      // Older Safari throws on a second stop(); the fade already silenced it.
    }
  }
}

/** Fade out every scratch clip and end the stroke. Use on mute and unmount. */
export function stopScratchSounds(): void {
  strokeStartMs = null;
  currentVoice = null;
  suspendedStampMs = null;
  staleSinceMs = null;
  fadeLiveVoices(SCRATCH_SOUND_FADE_OUT_S);
}

/**
 * Finger is rubbing already-scratched fabric: fade what's playing and reset
 * the tier so the next fresh scratch opens on a short clip.
 */
export function quietScratchSound(): void {
  strokeStartMs = null;
  currentVoice = null;
  suspendedStampMs = null;
  fadeLiveVoices(SCRATCH_SOUND_QUIET_FADE_S);
}

/** Pure grace-timer step for `noteScratchStamp`. */
export function nextScratchStaleState(
  fresh: boolean,
  staleSince: number | null,
  nowMs: number,
): { staleSince: number | null; quiet: boolean } {
  if (fresh) return { staleSince: null, quiet: false };
  const since = staleSince ?? nowMs;
  return { staleSince: since, quiet: nowMs - since >= SCRATCH_STALE_QUIET_MS };
}

/**
 * Call once per manual scratch apply. `fresh` = the stamps cleared fabric
 * that wasn't scratched yet; only those keep the clips going.
 */
export function noteScratchStamp(
  fresh: boolean,
  nowMs: number = performance.now(),
): void {
  const next = nextScratchStaleState(fresh, staleSinceMs, nowMs);
  staleSinceMs = next.staleSince;
  if (fresh) {
    noteScratchSoundActivity(nowMs);
    return;
  }
  if (next.quiet) quietScratchSound();
}

/**
 * Call whenever a manual scratch stamp lands on the garment. Keeps a clip
 * playing while the finger scratches and chains the next tier when it ends.
 */
export function noteScratchSoundActivity(
  nowMs: number = performance.now(),
): void {
  if (!effectiveSoundEffect()) {
    stopScratchSounds();
    return;
  }
  const ctx = getGameAudioContext();
  if (!ctx || ctx.state === "closed") return;

  strokeStartMs ??= nowMs;
  if (ctx.state !== "running") {
    // Scheduling on a suspended context would burst out on resume, so ask
    // for a resume and play the opening clip once it lands.
    deferUntilResumed(ctx);
    return;
  }
  if (currentVoice && ctx.currentTime < currentVoice.chainAt) return;
  playClip(ctx, scratchSoundTier(nowMs - strokeStartMs));
}

function playClip(ctx: AudioContext, tier: ScratchSoundTier): void {
  const picked = pickClip(tier);
  if (!picked) {
    preloadScratchSounds();
    return;
  }
  lastSrc = picked.src;
  startVoice(ctx, picked.clip);
}

function deferUntilResumed(ctx: AudioContext): void {
  const now = performance.now();
  const resumeInFlight =
    suspendedStampMs != null &&
    now - suspendedStampMs < SCRATCH_SOUND_RESUME_GRACE_MS;
  suspendedStampMs = now;
  if (!resumeInFlight) void ctx.resume().catch(() => undefined);
  if (resumeWatchedCtx === ctx) return;
  resumeWatchedCtx = ctx;
  ctx.addEventListener("statechange", () => {
    if (ctx.state !== "running" || suspendedStampMs == null) return;
    const fresh =
      performance.now() - suspendedStampMs < SCRATCH_SOUND_RESUME_GRACE_MS;
    suspendedStampMs = null;
    if (!fresh || currentVoice || !effectiveSoundEffect()) return;
    playClip(ctx, "short");
    // Finger already lifted (a tap): let the next stroke layer on top.
    if (strokeStartMs == null) currentVoice = null;
  });
}
