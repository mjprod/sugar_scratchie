import { useEffect, useRef, useState } from "react";
import { DotLottieReact, type DotLottie } from "@lottiefiles/dotlottie-react";
import "@/lib/lottie/setupWasm";
import { lottieRenderConfig } from "@/utils/lottieRender";
import {
  claimPackProgressLottieHook,
  initialCardCountdownPlayKey,
  shouldAutoplayCardCountdown,
  shouldFreezeCardCountdownOnLoad,
} from "./packProgressLottiePolicy";

/** Assets live in public/lottie (singular) — /lotties/* falls through to SPA HTML. */
const CARD_COUNTDOWN_LOTTIE_SRC = "/lottie/lottieCardCountdown.lottie";
const CARD_LOTTIE_SIZE = 28;
/** Keep in sync with `.pack-progress` `--pp-lottie-scale` in scratch/styles.css.
 *  CSS transform enlarges the canvas after paint — boost DPR so the vector stays crisp. */
const CARD_LOTTIE_CSS_SCALE = 1.75;

type PackProgressProps = {
  current: number;
  total: number;
};

/** Compact pack-progress pill — status-row HUD. Card lottie plays when badge shows. */
export function PackProgress({ current, total }: PackProgressProps) {
  // playKey starts > 0 so every mount autoplays once (badge in / remount).
  // Card-index bumps remount the player again for the next one-shot.
  const [playKey, setPlayKey] = useState(() =>
    initialCardCountdownPlayKey(current),
  );
  const prevCurrentRef = useRef<number | null>(null);

  useEffect(() => {
    const prev = prevCurrentRef.current;
    prevCurrentRef.current = current;
    if (prev != null && current !== prev) {
      setPlayKey((n) => n + 1);
    }
  }, [current]);

  if (total <= 0 || current < 1 || current > total) return null;
  const remaining = total - current;
  const isFinal = remaining === 0;
  const shouldPlay = shouldAutoplayCardCountdown(playKey);
  const freezeOnLoad = shouldFreezeCardCountdownOnLoad(shouldPlay);

  return (
    <div
      className={["pack-progress", isFinal ? "is-final" : ""]
        .filter(Boolean)
        .join(" ")}
      role="status"
      aria-live="polite"
      aria-label={
        isFinal
          ? `Final card, card ${current} of ${total}`
          : `${remaining} left, card ${current} of ${total}`
      }
    >
      <span className="pack-progress__icon" aria-hidden="true">
        <DotLottieReact
          key={`card-countdown-${playKey}`}
          // Absolute URL — relative paths can fail inside the lottie worker.
          src={
            typeof window !== "undefined"
              ? new URL(CARD_COUNTDOWN_LOTTIE_SRC, window.location.href).href
              : CARD_COUNTDOWN_LOTTIE_SRC
          }
          autoplay={shouldPlay}
          loop={false}
          width={CARD_LOTTIE_SIZE}
          height={CARD_LOTTIE_SIZE}
          className="pack-progress__lottie"
          renderConfig={lottieRenderConfig({
            extraScale: CARD_LOTTIE_CSS_SCALE,
            autoResize: false,
          })}
          dotLottieRefCallback={(instance: DotLottie | null) => {
            if (!instance) return;
            // Inline callback identity changes every render; DotLottieReact may
            // re-invoke us. Guard so we don't stack load listeners or call
            // play() again after a finished one-shot while the pill stays up.
            const anyInstance = instance as unknown as {
              __packProgressHooked?: boolean;
            };
            if (!claimPackProgressLottieHook(anyInstance)) return;

            if (freezeOnLoad) {
              const paintFirstFrame = () => {
                try {
                  // stop() renders frame 0 — needed so idle icons aren't blank.
                  void instance.stop();
                  instance.pause();
                } catch {
                  /* player may not be ready yet */
                }
              };
              instance.addEventListener("load", paintFirstFrame);
              paintFirstFrame();
              return;
            }
            // Play path: do not stop() — that cancels autoplay. Reinforce play
            // after load in case the player raced past the autoplay flag.
            const ensurePlay = () => {
              try {
                void instance.play();
              } catch {
                /* player may not be ready yet */
              }
            };
            instance.addEventListener("load", ensurePlay);
            ensurePlay();
          }}
        />
      </span>
      <div className="pack-progress__copy">
        <p className="pack-progress__remain">
          {isFinal ? "FINAL CARD" : `${remaining} Left`}
        </p>
        <p className="pack-progress__pos">
          Card {current} of {total}
        </p>
      </div>
    </div>
  );
}
