import { useCallback, useEffect, useRef, useState } from "react";
import { DotLottieReact, type DotLottie } from "@lottiefiles/dotlottie-react";

/** Match `.top-symbol-bar` dock transition in styles.css. */
export const TOP_BAR_DOCK_MS = 480;

export const INITIAL_COUNTDOWN_SRC = "/lotties/lottieInitialCountdown.json";
export const INITIAL_COUNTDOWN_SOUND_SRC = "/sounds/321_go_countdown.mp3";

/** Animation length: 339 frames @ 60fps (+ small buffer for decode). */
export const INITIAL_COUNTDOWN_MS = Math.ceil((339 / 60) * 1000) + 250;

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

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onCompleteRef.current();
  }, []);

  useEffect(() => {
    const safetyId = window.setTimeout(finish, INITIAL_COUNTDOWN_MS);
    return () => window.clearTimeout(safetyId);
  }, [finish]);

  useEffect(() => {
    if (!dotLottie) return;
    const onDone = () => finish();
    dotLottie.addEventListener("complete", onDone);
    return () => {
      dotLottie.removeEventListener("complete", onDone);
    };
  }, [dotLottie, finish]);

  useEffect(() => {
    if (!soundEnabled) return;
    const audio = new Audio(INITIAL_COUNTDOWN_SOUND_SRC);
    audio.preload = "auto";
    void audio.play().catch(() => undefined);
    return () => {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    };
  }, [soundEnabled]);

  return (
    <div className="initial-countdown" aria-live="polite" aria-label="Get ready">
      <DotLottieReact
        src={INITIAL_COUNTDOWN_SRC}
        autoplay
        loop={false}
        className="initial-countdown-lottie"
        dotLottieRefCallback={setDotLottie}
      />
    </div>
  );
}
