import {
  getGameAudioContext,
  getGameAudioOutput,
} from "../shared/gameAudioContext";
import { soundMixOutput } from "../shared/soundMix";

export const INITIAL_COUNTDOWN_SOUND_SRC = "/sounds/321_go_countdown.mp3";

/** Animation length: 339 frames @ 60fps (+ small buffer for decode). */
export const INITIAL_COUNTDOWN_MS = Math.ceil((339 / 60) * 1000) + 250;

let countdownBuffer: AudioBuffer | null = null;
let countdownBufferPromise: Promise<AudioBuffer | null> | null = null;
let countdownSource: AudioBufferSourceNode | null = null;
let countdownHtmlAudio: HTMLAudioElement | null = null;
/** Bumped per sound-effect mount so StrictMode cleanup doesn't kill the remount play. */
let countdownPlaySession = 0;
/** True after a user gesture unlocked audio this page lifetime (cleared on refresh). */
let countdownSoundUnlocked = false;
/**
 * Visual countdown still running — audio may be stopped by mute, but unmute
 * must be able to resume from elapsed time inside the click gesture.
 */
let countdownSessionActive = false;
let countdownSessionStartedAt = 0;
/**
 * Invalidates in-flight playCountdownSound awaits so a later mute cannot be
 * undone when an earlier unmute's async play() finally resolves.
 */
let countdownAudioGeneration = 0;

export function isCountdownSoundUnlocked() {
  return countdownSoundUnlocked;
}

export function isCountdownAudioSessionActive() {
  return countdownSessionActive;
}

/** Arm the session with the visual so unmute can resume from elapsed time. */
export function armCountdownAudioSession() {
  countdownSessionActive = true;
  countdownSessionStartedAt = performance.now();
}

export function nextCountdownPlaySession() {
  countdownPlaySession += 1;
  return countdownPlaySession;
}

export function currentCountdownPlaySession() {
  return countdownPlaySession;
}

/** True while 3-2-1 SFX is actually coming out of the speakers. */
export function isCountdownAudioPlaying() {
  if (countdownSource) return true;
  const html = countdownHtmlAudio;
  return Boolean(html && !html.paused && !html.ended);
}

function countdownSoundUrl() {
  return new URL(INITIAL_COUNTDOWN_SOUND_SRC, document.location.href).href;
}

function getCountdownContext() {
  return getGameAudioContext();
}

function getCountdownHtmlAudio() {
  if (typeof window === "undefined") return null;
  if (!countdownHtmlAudio) {
    const audio = new Audio(countdownSoundUrl());
    audio.preload = "auto";
    audio.muted = false;
    audio.volume = 1;
    // Keep a live element in the document — iOS Safari is more willing to
    // replay this later than a detached `new Audio()`.
    audio.setAttribute("playsinline", "true");
    audio.style.display = "none";
    document.body.appendChild(audio);
    countdownHtmlAudio = audio;
  }
  return countdownHtmlAudio;
}

async function ensureCountdownBuffer() {
  if (countdownBuffer) return countdownBuffer;
  if (!countdownBufferPromise) {
    countdownBufferPromise = (async () => {
      const ctx = getCountdownContext();
      if (!ctx) return null;
      try {
        const response = await fetch(countdownSoundUrl());
        if (!response.ok) return null;
        const raw = await response.arrayBuffer();
        // decodeAudioData detaches the buffer; pass a copy for Safari.
        countdownBuffer = await ctx.decodeAudioData(raw.slice(0));
        return countdownBuffer;
      } catch {
        return null;
      }
    })();
  }
  return countdownBufferPromise;
}

export function ensureCountdownGain(): AudioNode | null {
  return soundMixOutput("countdown");
}

function stopCountdownSources() {
  if (countdownSource) {
    try {
      countdownSource.stop();
    } catch {
      // already stopped
    }
    try {
      countdownSource.disconnect();
    } catch {
      // ignore
    }
    countdownSource = null;
  }
  const html = countdownHtmlAudio;
  if (html) {
    html.pause();
    try {
      html.currentTime = 0;
    } catch {
      // ignore
    }
  }
}

/** Stop any in-flight 3-2-1 SFX (Web Audio source and HTMLAudio fallback). */
export function stopCountdownAudio() {
  // Bump first so any awaiting playCountdownSound bails before restarting.
  countdownAudioGeneration += 1;
  stopCountdownSources();
}

/** End the visual countdown session — unmute will no longer resume SFX. */
export function endCountdownAudioSession() {
  countdownSessionActive = false;
  countdownSessionStartedAt = 0;
  stopCountdownAudio();
}

/**
 * Resume 3-2-1 SFX from elapsed visual time. Must run inside a user gesture
 * (mute button unmute) — a useEffect play() is blocked on Safari.
 */
export function resumeCountdownAudioIfActive() {
  if (!countdownSessionActive) return;
  const elapsedSec = Math.max(
    0,
    (performance.now() - countdownSessionStartedAt) / 1000,
  );
  const maxSec = INITIAL_COUNTDOWN_MS / 1000;
  if (elapsedSec >= maxSec - 0.05) return;
  void playCountdownSound(elapsedSec).catch(() => undefined);
}

/**
 * Call synchronously from a user-gesture handler (Play / Continue).
 * Resuming AudioContext inside the gesture is what lets Safari play 3-2-1
 * after in-app navigation. Pair with SPA `navigateTo` (not location.assign).
 */
export function unlockCountdownSound() {
  countdownSoundUnlocked = true;
  const ctx = getCountdownContext();
  if (!ctx) {
    getCountdownHtmlAudio();
    return;
  }
  if (ctx.state === "suspended") {
    void ctx.resume();
  }
  // Silent buffer tick — iOS is more likely to keep the context running until
  // the countdown mounts than resume-only.
  try {
    const tick = ctx.createBuffer(1, 1, ctx.sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = tick;
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    // ignore
  }
  void ensureCountdownBuffer();
  getCountdownHtmlAudio();
}

/** Start (or restart) the 3-2-1 SFX via Web Audio, with HTMLAudio fallback. */
export async function playCountdownSound(offsetSec = 0) {
  const gen = ++countdownAudioGeneration;
  stopCountdownSources();

  const startAt = Math.max(0, offsetSec);
  if (!countdownSessionActive) {
    countdownSessionActive = true;
    countdownSessionStartedAt = performance.now() - startAt * 1000;
  }

  const ctx = getCountdownContext();
  if (ctx) {
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // Still suspended without a gesture — fall through to HTML / reject.
      }
    }
    if (gen !== countdownAudioGeneration) return;
    if (ctx.state === "running") {
      const buffer = await ensureCountdownBuffer();
      if (gen !== countdownAudioGeneration) return;
      if (buffer) {
        if (startAt >= buffer.duration) return;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ensureCountdownGain() ?? getGameAudioOutput(ctx));
        countdownSource = source;
        source.onended = () => {
          if (countdownSource === source) countdownSource = null;
        };
        source.start(0, startAt);
        return;
      }
    }
  }

  if (gen !== countdownAudioGeneration) return;
  const html = getCountdownHtmlAudio();
  if (!html) throw new Error("Countdown audio unavailable");
  html.muted = false;
  html.volume = 1;
  if (ctx && html) {
    const node =
      (html as HTMLAudioElement & { __mixSource?: MediaElementAudioSourceNode })
        .__mixSource ?? ctx.createMediaElementSource(html);
    (html as HTMLAudioElement & { __mixSource?: MediaElementAudioSourceNode }).__mixSource =
      node;
    try {
      node.disconnect();
    } catch {
      // not yet connected
    }
    node.connect(ensureCountdownGain() ?? ctx.destination);
  }
  try {
    html.currentTime = startAt;
  } catch {
    // ignore
  }
  await html.play();
  if (gen !== countdownAudioGeneration) {
    stopCountdownSources();
  }
}
