import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DotLottieReact, type DotLottie } from "@lottiefiles/dotlottie-react";

/** Match `.top-symbol-bar` dock transition in styles.css. */
export const TOP_BAR_DOCK_MS = 480;

export const INITIAL_COUNTDOWN_SRC = "/lotties/lottieInitialCountdown.json";
export const INITIAL_COUNTDOWN_SOUND_SRC = "/sounds/321_go_countdown.mp3";

/** Animation length: 339 frames @ 60fps (+ small buffer for decode). */
export const INITIAL_COUNTDOWN_MS = Math.ceil((339 / 60) * 1000) + 250;

/** Intrinsic draw size for the countdown canvas (matches CSS max). Explicit
 * attributes matter more than CSS alone — without them the player can leave a
 * blank bitmap even when the wrapper is sized. */
const COUNTDOWN_SIZE_PX = 260;

type WebkitAudioWindow = typeof window & {
  webkitAudioContext?: typeof AudioContext;
};

let countdownCtx: AudioContext | null = null;
let countdownBuffer: AudioBuffer | null = null;
let countdownBufferPromise: Promise<AudioBuffer | null> | null = null;
let countdownSource: AudioBufferSourceNode | null = null;
let countdownHtmlAudio: HTMLAudioElement | null = null;
/** Bumped per sound-effect mount so StrictMode cleanup doesn't kill the remount play. */
let countdownPlaySession = 0;
/** True after a user gesture unlocked audio this page lifetime (cleared on refresh). */
let countdownSoundUnlocked = false;

export function isCountdownSoundUnlocked() {
  return countdownSoundUnlocked;
}

function countdownSoundUrl() {
  return new URL(INITIAL_COUNTDOWN_SOUND_SRC, window.location.href).href;
}

function getCountdownContext() {
  if (typeof window === "undefined") return null;
  if (!countdownCtx) {
    const AudioCtor =
      window.AudioContext ??
      (window as WebkitAudioWindow).webkitAudioContext;
    if (!AudioCtor) return null;
    countdownCtx = new AudioCtor();
  }
  return countdownCtx;
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

function stopCountdownAudio() {
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
export async function playCountdownSound() {
  stopCountdownAudio();

  const ctx = getCountdownContext();
  if (ctx) {
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // Still suspended without a gesture — fall through to HTML / reject.
      }
    }
    if (ctx.state === "running") {
      const buffer = await ensureCountdownBuffer();
      if (buffer) {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        countdownSource = source;
        source.onended = () => {
          if (countdownSource === source) countdownSource = null;
        };
        source.start(0);
        return;
      }
    }
  }

  const html = getCountdownHtmlAudio();
  if (!html) throw new Error("Countdown audio unavailable");
  html.muted = false;
  html.volume = 1;
  try {
    html.currentTime = 0;
  } catch {
    // ignore
  }
  await html.play();
}

type InitialCountdownProps = {
  onComplete: () => void;
  /** When false, only the Lottie plays (no countdown SFX). Default true. */
  soundEnabled?: boolean;
};

export function InitialCountdown({
  onComplete,
  soundEnabled = true,
}: InitialCountdownProps) {
  const finishedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const [dotLottie, setDotLottie] = useState<DotLottie | null>(null);
  const lottieSrc = useMemo(
    () =>
      typeof window === "undefined"
        ? INITIAL_COUNTDOWN_SRC
        : new URL(INITIAL_COUNTDOWN_SRC, window.location.href).href,
    [],
  );

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    stopCountdownAudio();
    onCompleteRef.current();
  }, []);

  useEffect(() => {
    if (!dotLottie) return;

    let safetyId = 0;
    let kicked = false;
    const clearSafety = () => {
      if (safetyId !== 0) {
        window.clearTimeout(safetyId);
        safetyId = 0;
      }
    };
    const armSafety = (ms: number) => {
      clearSafety();
      safetyId = window.setTimeout(finish, ms);
    };

    const kick = () => {
      if (kicked) return;
      kicked = true;
      // Safari / first-WASM-load often misses the autoplay flag — play once
      // the animation is actually ready, then start the duration watchdog.
      void dotLottie.play();
      armSafety(INITIAL_COUNTDOWN_MS);
    };
    const onDone = () => finish();
    const onLoadError = () => finish();

    dotLottie.addEventListener("complete", onDone);
    dotLottie.addEventListener("loadError", onLoadError);
    dotLottie.addEventListener("load", kick);

    if (dotLottie.isLoaded) {
      kick();
    } else {
      armSafety(INITIAL_COUNTDOWN_MS + 10_000);
    }

    return () => {
      clearSafety();
      dotLottie.removeEventListener("complete", onDone);
      dotLottie.removeEventListener("loadError", onLoadError);
      dotLottie.removeEventListener("load", kick);
    };
  }, [dotLottie, finish]);

  useEffect(() => {
    if (!soundEnabled) return;
    const session = ++countdownPlaySession;
    void playCountdownSound().catch(() => undefined);

    return () => {
      // Defer stop so React StrictMode's immediate remount can take over the
      // session — otherwise Safari's 3-2-1 is killed on the first effect pass.
      window.setTimeout(() => {
        if (countdownPlaySession === session) stopCountdownAudio();
      }, 0);
    };
  }, [soundEnabled]);

  // Keep the countdown on DotLottieReact (main thread), not DotLottieWorkerReact:
  // this asset is plain Lottie JSON (not .lottie), played once at ~260², and the
  // worker/OffscreenCanvas path was leaving a blank canvas here even with
  // self-hosted WASM. This one-shot overlay is short enough that main-thread
  // decode is acceptable, and setWasmUrl in main.tsx points the player at
  // /wasm/dotlottie-player.wasm.
  return (
    <div className="initial-countdown" aria-live="polite" aria-label="Get ready">
      <DotLottieReact
        src={lottieSrc}
        autoplay
        loop={false}
        width={COUNTDOWN_SIZE_PX}
        height={COUNTDOWN_SIZE_PX}
        className="initial-countdown-lottie"
        style={{ width: COUNTDOWN_SIZE_PX, height: COUNTDOWN_SIZE_PX }}
        dotLottieRefCallback={setDotLottie}
      />
    </div>
  );
}
