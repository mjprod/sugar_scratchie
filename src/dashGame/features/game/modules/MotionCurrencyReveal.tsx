import { useEffect, useRef, useState, type CSSProperties } from "react";
import { CoinLottie } from "@/components/ui/CoinLottie";
import { DiamondLottie } from "@/components/ui/DiamondLottie";

export type MotionCurrencyRevealProps = {
  coins: number;
  diamonds: number;
  /** Stable id for this result — prevents replay on parent re-render. */
  resultId: string;
  onComplete: () => void;
};

type Phase =
  | "entering"
  | "appearing"
  | "confirmed"
  | "minimizing"
  | "complete";

/** Per-card currency result hold before auto-advance to the next motion card. */
export const CARD_CURRENCY_RESULT_MS = 5000;
const SAFETY_MS = CARD_CURRENCY_RESULT_MS + 800;
const COUNT_MS = 900;

function prefersReducedMotion() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

function useCountUp(target: number, active: boolean, durationMs: number) {
  const [display, setDisplay] = useState(0);
  const displayRef = useRef(0);

  useEffect(() => {
    if (!active || target <= 0) {
      displayRef.current = target;
      setDisplay(target);
      return;
    }

    let reduced = false;
    try {
      reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      reduced = false;
    }
    if (reduced) {
      displayRef.current = target;
      setDisplay(target);
      return;
    }

    const from = 0;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const next = Math.round(from + (target - from) * easeOutCubic(t));
      displayRef.current = next;
      setDisplay(next);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, durationMs, target]);

  return display;
}

/**
 * Per-card coin + diamond win reveal — presentation only.
 * Session/wallet rewards must already be persisted before this mounts.
 * Auto-advances after 5s (or Skip); navigation is handled by the parent.
 */
export function MotionCurrencyReveal({
  coins,
  diamonds,
  resultId,
  onComplete,
}: MotionCurrencyRevealProps) {
  const [phase, setPhase] = useState<Phase>("entering");
  const completedRef = useRef(false);
  const timersRef = useRef<number[]>([]);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const reduced = prefersReducedMotion();
  const counting = phase === "appearing" || phase === "confirmed";
  const coinDisplay = useCountUp(coins, counting, COUNT_MS);
  const diamondDisplay = useCountUp(diamonds, counting, COUNT_MS);

  function clearTimers() {
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];
  }

  function finish() {
    if (completedRef.current) return;
    completedRef.current = true;
    clearTimers();
    setPhase("complete");
    onCompleteRef.current();
  }

  function skipNow() {
    if (completedRef.current) return;
    clearTimers();
    setPhase("minimizing");
    timersRef.current.push(
      window.setTimeout(finish, reduced ? 120 : 280),
    );
  }

  useEffect(() => {
    completedRef.current = false;
    setPhase("entering");
    clearTimers();

    const at = (ms: number, fn: () => void) => {
      timersRef.current.push(window.setTimeout(fn, ms));
    };

    const holdMs = reduced ? 2500 : CARD_CURRENCY_RESULT_MS;

    if (reduced) {
      at(120, () => setPhase("appearing"));
      at(500, () => setPhase("confirmed"));
      at(holdMs - 200, () => setPhase("minimizing"));
      at(holdMs, finish);
      at(SAFETY_MS, finish);
      return () => clearTimers();
    }

    at(200, () => setPhase("appearing"));
    at(900, () => setPhase("confirmed"));
    at(holdMs - 400, () => setPhase("minimizing"));
    at(holdMs, finish);
    at(SAFETY_MS, finish);

    return () => clearTimers();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart timeline per resultId
  }, [resultId]);

  const showHeader =
    phase !== "entering" && phase !== "minimizing" && phase !== "complete";
  const showMini = phase === "minimizing" || phase === "complete";
  const showSkip =
    phase === "appearing" || phase === "confirmed";
  const fading = phase === "complete";
  const showCoins = coins > 0;
  const showDiamonds = diamonds > 0;

  return (
    <div
      className={[
        "motion-currency-reveal",
        `is-${phase}`,
        reduced ? "is-reduced" : "",
        fading ? "is-fading" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="status"
      aria-live="polite"
      aria-label={[
        coins > 0 ? `${coins} coin${coins === 1 ? "" : "s"}` : null,
        diamonds > 0
          ? `${diamonds} diamond${diamonds === 1 ? "" : "s"}`
          : null,
      ]
        .filter(Boolean)
        .join(" and ")}
    >
      <div className="motion-currency-reveal__backdrop" aria-hidden="true" />
      <div className="motion-currency-reveal__glow" aria-hidden="true" />
      <div className="motion-currency-reveal__particles" aria-hidden="true">
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} style={{ "--i": i } as CSSProperties} />
        ))}
      </div>

      <div className="motion-currency-reveal__center">
        {showHeader ? (
          <div className="motion-currency-reveal__header">
            <p className="motion-currency-reveal__won">YOU WON!</p>
            <p className="motion-currency-reveal__count">
              {[
                showDiamonds
                  ? `${diamonds} Diamond${diamonds === 1 ? "" : "s"}`
                  : null,
                showCoins
                  ? `${coins} Coin${coins === 1 ? "" : "s"}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        ) : null}

        <div
          className={[
            "motion-currency-reveal__stack",
            showCoins && showDiamonds ? "has-both" : "",
            phase === "appearing" ||
            phase === "confirmed" ||
            phase === "minimizing"
              ? "is-visible"
              : "",
            showMini ? "is-minimizing" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {showDiamonds ? (
            <div className="motion-currency-reveal__hero is-diamonds">
              <div className="motion-currency-reveal__stack-col">
                <div className="motion-currency-reveal__icon" aria-hidden="true">
                  <DiamondLottie size={72} />
                </div>
                <p className="motion-currency-reveal__amount tabular-nums">
                  {diamondDisplay}
                </p>
                <p className="motion-currency-reveal__label">Diamonds</p>
              </div>
            </div>
          ) : null}
          {showCoins ? (
            <div className="motion-currency-reveal__hero is-coins">
              <div className="motion-currency-reveal__pair">
                <div className="motion-currency-reveal__icon" aria-hidden="true">
                  <CoinLottie size={44} loop autoplay />
                </div>
                <p className="motion-currency-reveal__amount tabular-nums">
                  {coinDisplay}
                </p>
              </div>
              <p className="motion-currency-reveal__label">Coins</p>
            </div>
          ) : null}
        </div>
      </div>

      {showSkip ? (
        <div className="motion-currency-reveal__actions">
          <button
            type="button"
            className="motion-currency-reveal__skip"
            onClick={skipNow}
          >
            Next Card
          </button>
        </div>
      ) : null}

      <div
        className={[
          "motion-currency-reveal__mini",
          showMini ? "is-shown" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-hidden={!showMini}
      >
        {showDiamonds ? (
          <>
            <span className="motion-currency-reveal__mini-icon" aria-hidden="true">
              <DiamondLottie size={22} />
            </span>
            <span className="motion-currency-reveal__mini-new">+{diamonds}</span>
          </>
        ) : null}
        {showCoins ? (
          <>
            <span className="motion-currency-reveal__mini-icon" aria-hidden="true">
              <CoinLottie size={22} loop={false} autoplay />
            </span>
            <span className="motion-currency-reveal__mini-new">+{coins}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}
