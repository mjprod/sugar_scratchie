/**
 * One AudioContext for every Web Audio sound in the game (BGM loop, 3-2-1
 * countdown, symbol notes). iOS caps live contexts and each one holds the
 * audio hardware, so modules share this instead of creating their own.
 *
 * Callers must not close() it. While the page is hidden it is suspended —
 * Web Audio keeps playing in background tabs otherwise — and resumed when the
 * page is visible again. iOS may refuse that resume until the next tap, which
 * is why tap handlers still call their unlock helpers.
 *
 * Audible sounds connect to getGameAudioOutput() rather than destination: a
 * limiter there keeps overlapping symbol dings + BGM from clipping.
 */

type WebkitAudioWindow = typeof window & {
  webkitAudioContext?: typeof AudioContext;
};

/**
 * Tones scheduled at currentTime are already late when the audio thread picks
 * them up (worse while scratching loads the main thread), which skips their
 * attack ramp and clicks. Start this far ahead instead.
 */
export const GAME_AUDIO_LOOKAHEAD_S = 0.03;

const LIMITER_THRESHOLD_DB = -3;
const LIMITER_RATIO = 20;

let ctx: AudioContext | null = null;
let output: AudioNode | null = null;
let visibilityWired = false;

function wireVisibility() {
  if (visibilityWired || typeof document === "undefined") return;
  visibilityWired = true;
  document.addEventListener("visibilitychange", () => {
    if (!ctx) return;
    if (document.visibilityState === "hidden") {
      if (ctx.state === "running") void ctx.suspend().catch(() => undefined);
      return;
    }
    if (ctx.state !== "running") void ctx.resume().catch(() => undefined);
  });
}

/** Creates the shared context on first use. Prefer calling from a user gesture. */
export function getGameAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AudioCtor =
      window.AudioContext ?? (window as WebkitAudioWindow).webkitAudioContext;
    if (!AudioCtor) return null;
    ctx = new AudioCtor();
    wireVisibility();
  }
  return ctx;
}

/** The shared context if it already exists — never creates one. */
export function peekGameAudioContext(): AudioContext | null {
  return ctx;
}

function createLimiter(audioCtx: AudioContext): AudioNode {
  const limiter = audioCtx.createDynamicsCompressor();
  limiter.threshold.value = LIMITER_THRESHOLD_DB;
  limiter.knee.value = 0;
  limiter.ratio.value = LIMITER_RATIO;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  // The compressor applies automatic makeup gain of
  // (1 / curve(0 dBFS)) ^ 0.6; trim it back out so sounds below the
  // threshold play at the same level as before the limiter existed.
  const fullRangeDb =
    LIMITER_THRESHOLD_DB + -LIMITER_THRESHOLD_DB / LIMITER_RATIO;
  const trim = audioCtx.createGain();
  trim.gain.value = 10 ** ((0.6 * fullRangeDb) / 20);
  limiter.connect(trim);
  trim.connect(audioCtx.destination);
  return limiter;
}

/** Where audible game sounds connect: limiter → destination. */
export function getGameAudioOutput(audioCtx: AudioContext): AudioNode {
  if (audioCtx !== ctx) return audioCtx.destination;
  output ??= createLimiter(audioCtx);
  return output;
}

/** Start time for a one-shot sound, GAME_AUDIO_LOOKAHEAD_S from now. */
export function gameAudioStartTime(audioCtx: AudioContext): number {
  return audioCtx.currentTime + GAME_AUDIO_LOOKAHEAD_S;
}
