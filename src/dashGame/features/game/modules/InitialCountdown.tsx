import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DotLottieReact, type DotLottie } from "@lottiefiles/dotlottie-react";
import "@/lib/lottie/setupWasm";
import { lottieRenderConfig } from "@/utils/lottieRender";
import {
  armCountdownAudioSession,
  currentCountdownPlaySession,
  endCountdownAudioSession,
  ensureCountdownGain,
  INITIAL_COUNTDOWN_MS,
  isCountdownSoundUnlocked,
  nextCountdownPlaySession,
  playCountdownSound,
  stopCountdownAudio,
} from "./countdownSound";

export {
  endCountdownAudioSession,
  INITIAL_COUNTDOWN_MS,
  INITIAL_COUNTDOWN_SOUND_SRC,
  isCountdownAudioPlaying,
  isCountdownAudioSessionActive,
  isCountdownSoundUnlocked,
  playCountdownSound,
  resumeCountdownAudioIfActive,
  stopCountdownAudio,
  unlockCountdownSound,
} from "./countdownSound";

/** Match `.top-symbol-bar` dock fly animation in styles.css. */
export const TOP_BAR_DOCK_MS = 720;
/** Later cards in a hand — shorter dock before body scratch unlocks. */
export const TOP_BAR_DOCK_NEXT_CARD_MS = 220;

export const INITIAL_COUNTDOWN_SRC = "/lotties/lottieInitialCountdown.json";

/** Intrinsic draw size for the countdown canvas (matches CSS max). Explicit
 * attributes matter more than CSS alone — without them the player can leave a
 * blank bitmap even when the wrapper is sized. */
const COUNTDOWN_SIZE_PX = 260;

const FALLBACK_LABELS = ["3", "2", "1", "GO"] as const;

type InitialCountdownProps = {
  onComplete: () => void;
  /** When false, only the visual plays (no countdown SFX). Default true. */
  soundEnabled?: boolean;
};

/**
 * 3-2-1-GO overlay. Completion is owned by a fixed timer — DotLottie has
 * emitted spurious early "complete"/"loadError" in the product shell, which
 * skipped the beat. Lottie is visual-only; text steps cover a blank canvas.
 */
export function InitialCountdown({
  onComplete,
  soundEnabled = true,
}: InitialCountdownProps) {
  const finishedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const audioStartedRef = useRef(false);
  const countdownSessionRef = useRef(0);
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const [dotLottie, setDotLottie] = useState<DotLottie | null>(null);
  const [lottieFailed, setLottieFailed] = useState(false);
  const [step, setStep] = useState(0);
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
    endCountdownAudioSession();
    onCompleteRef.current();
  }, []);

  const startCountdownAudioWithVisual = useCallback(() => {
    ensureCountdownGain();
    if (!soundEnabledRef.current || audioStartedRef.current) return;
    // Cold refresh: prefs may be "on" but there is no user gesture yet.
    // Playing here makes the mute icon (still locked) lie — wait for unlock.
    if (!isCountdownSoundUnlocked()) return;
    audioStartedRef.current = true;
    const session = nextCountdownPlaySession();
    countdownSessionRef.current = session;
    requestAnimationFrame(() => {
      if (currentCountdownPlaySession() !== session) return;
      void playCountdownSound(0).catch(() => undefined);
    });
  }, []);

  // Timer owns completion — do not finish from Lottie events.
  // Arm the audio session with the visual so unmute can resume even when the
  // first autoplay SFX attempt failed (cold refresh, no gesture yet).
  useEffect(() => {
    ensureCountdownGain();
    audioStartedRef.current = false;
    countdownSessionRef.current = 0;
    finishedRef.current = false;
    armCountdownAudioSession();
    // Prefs can be on after refresh while the mute icon is still locked — do
    // not let a leftover/autoplay SFX run under a muted icon.
    if (!isCountdownSoundUnlocked()) stopCountdownAudio();
    setStep(0);
    const stepMs = Math.floor(INITIAL_COUNTDOWN_MS / FALLBACK_LABELS.length);
    let current = 0;
    const id = window.setInterval(() => {
      current += 1;
      if (current >= FALLBACK_LABELS.length) {
        window.clearInterval(id);
        finish();
        return;
      }
      setStep(current);
    }, stepMs);
    const safetyId = window.setTimeout(finish, INITIAL_COUNTDOWN_MS + 200);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(safetyId);
      const session = countdownSessionRef.current;
      if (session === 0) {
        endCountdownAudioSession();
        return;
      }
      window.setTimeout(() => {
        if (currentCountdownPlaySession() === session) endCountdownAudioSession();
      }, 0);
    };
  }, [finish]);

  useEffect(() => {
    if (!dotLottie) return;
    const kick = () => {
      void dotLottie.play();
      startCountdownAudioWithVisual();
    };
    const onLoadError = () => setLottieFailed(true);
    dotLottie.addEventListener("load", kick);
    dotLottie.addEventListener("loadError", onLoadError);
    if (dotLottie.isLoaded) kick();
    return () => {
      dotLottie.removeEventListener("load", kick);
      dotLottie.removeEventListener("loadError", onLoadError);
    };
  }, [dotLottie, startCountdownAudioWithVisual]);

  // Fallback path: audio starts when existing step 0 ("3") is shown.
  useEffect(() => {
    if (!lottieFailed || step !== 0) return;
    startCountdownAudioWithVisual();
  }, [lottieFailed, step, startCountdownAudioWithVisual]);

  // Stage mute mid-countdown: keep the visual, silence the SFX immediately.
  // Unmute resume is handled in the click gesture via resumeCountdownAudioIfActive.
  useEffect(() => {
    if (!soundEnabled) stopCountdownAudio();
  }, [soundEnabled]);

  return (
    <div className="initial-countdown" aria-live="polite" aria-label="Get ready">
      {!lottieFailed ? (
        <DotLottieReact
          src={lottieSrc}
          autoplay
          loop={false}
          width={COUNTDOWN_SIZE_PX}
          height={COUNTDOWN_SIZE_PX}
          className="initial-countdown-lottie"
          style={{ width: COUNTDOWN_SIZE_PX, height: COUNTDOWN_SIZE_PX }}
          renderConfig={lottieRenderConfig()}
          dotLottieRefCallback={setDotLottie}
        />
      ) : (
        <div className="initial-countdown-fallback" aria-hidden="true">
          {FALLBACK_LABELS[step] ?? "GO"}
        </div>
      )}
    </div>
  );
}
