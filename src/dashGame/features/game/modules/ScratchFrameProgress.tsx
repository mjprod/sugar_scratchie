import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  feedbackLabel,
  FRAME_H,
  FRAME_RX,
  FRAME_W,
  roundedRectPath,
  type NormalizedPoint,
} from "./scratchFrameGeometry";

export type SymbolDiscoveryBatch = {
  key: number;
  positions: NormalizedPoint[];
  foundAfter: number;
};

type ScratchFrameProgressProps = {
  active: boolean;
  found: number;
  total: number;
  batches: SymbolDiscoveryBatch[];
  /** Card resolved with no match — let the accumulated energy fade out. */
  settling?: boolean;
};

/** Keep the stroke fully inside the clipped stage box. */
const FRAME_INSET = 4;
const RECT_W = FRAME_W - FRAME_INSET * 2;
const RECT_H = FRAME_H - FRAME_INSET * 2;
/** Top-left start, clockwise — matches how progress should grow around the card. */
const FRAME_PATH = roundedRectPath(
  FRAME_INSET,
  FRAME_INSET,
  RECT_W,
  RECT_H,
  FRAME_RX,
);
/* Keep in sync with the matching CSS durations in scratch/styles.css. */
const SWEEP_MS = 760;
const PULSE_MS = 280;
const FEEDBACK_SHOW_MS = 1600;
const FEEDBACK_FADE_MS = 360;
/** Baked start origin (clockwise from top-left). */
const FRAME_START = 0.178;

/** Tuned progress gradient + track (no live color lab). */
const PROGRESS_STOPS = [
  { offset: 0, color: "#ff0073" },
  { offset: 45, color: "#ff7c5c" },
  { offset: 75, color: "#ff0073" },
  { offset: 100, color: "#ff7c5c" },
] as const;
/** Pre-progress frame border — soft gold gradient (matches reward gold). */
const TRACK_STOPS = [
  { offset: 0, color: "oklch(0.928 0.103 92.71 / 0.55)" },
  { offset: 35, color: "oklch(0.898 0.124 88.45 / 0.42)" },
  { offset: 70, color: "oklch(0.82 0.13 75 / 0.5)" },
  { offset: 100, color: "oklch(0.928 0.103 92.71 / 0.55)" },
] as const;

function prefersReducedMotion() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export const ScratchFrameProgress = memo(function ScratchFrameProgress({
  active,
  found,
  total,
  batches,
  settling = false,
}: ScratchFrameProgressProps) {
  const uid = useId().replace(/:/g, "");
  const reducedMotion = prefersReducedMotion();
  const [feedback, setFeedback] = useState<{
    found: number;
    fading: boolean;
  } | null>(null);
  const [completeSweep, setCompleteSweep] = useState(false);
  const [completePulse, setCompletePulse] = useState(false);
  const processedBatchKeys = useRef(new Set<number>());
  const feedbackTimerRef = useRef<number | null>(null);

  // pathLength=1. Visible arc = progress; gap = rest.
  const progress = total > 0 ? Math.min(1, found / total) : 0;
  const solidRing = progress >= 1;
  const dashProgress = solidRing
    ? 1
    : Math.min(1, progress + (progress > 0.9 ? 0.01 : 0));
  const progressStroke = solidRing
    ? {
        strokeDasharray: "none",
        strokeDashoffset: 0,
        strokeLinecap: "butt" as const,
      }
    : {
        // Two values required — a single number becomes "n n" and leaves a hole.
        strokeDasharray: `${dashProgress} ${Math.max(0, 1 - dashProgress)}`,
        strokeDashoffset: -FRAME_START,
        strokeLinecap: "round" as const,
      };

  useEffect(() => {
    if (!active) return;
    for (const batch of batches) {
      if (processedBatchKeys.current.has(batch.key)) continue;
      processedBatchKeys.current.add(batch.key);

      setFeedback({ found: batch.foundAfter, fading: false });
      if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = window.setTimeout(() => {
        setFeedback((current) =>
          current ? { ...current, fading: true } : current,
        );
        window.setTimeout(() => setFeedback(null), FEEDBACK_FADE_MS);
      }, FEEDBACK_SHOW_MS);

      if (reducedMotion) continue;

      if (batch.foundAfter === total) {
        setCompleteSweep(true);
        window.setTimeout(() => {
          setCompleteSweep(false);
          setCompletePulse(true);
        }, SWEEP_MS);
        window.setTimeout(() => setCompletePulse(false), SWEEP_MS + PULSE_MS);
      }
    }
  }, [active, batches, reducedMotion, total]);

  // `found === 0` also resets: the frame stays mounted across the no-match
  // settle, so a card handoff can happen without `active` ever going false.
  useEffect(() => {
    if (!active || found === 0) {
      processedBatchKeys.current.clear();
      setFeedback(null);
      setCompleteSweep(false);
      setCompletePulse(false);
    }
  }, [active, found]);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  if (!active) return null;

  const frameClass = [
    "scratch-frame-progress",
    // White track can stay on; colored arc is hidden until progress moves.
    progress <= 0 && !settling ? "is-empty" : "is-active",
    settling ? "is-settling" : "",
    solidRing || found >= total ? "is-complete" : "",
    found === 4 ? "is-milestone-4" : "",
    found === 8 ? "is-milestone-8" : "",
    found === 11 ? "is-almost" : "",
    completeSweep ? "is-sweeping" : "",
    completePulse ? "is-pulsing" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const feedbackCopy = feedback
    ? feedbackLabel(feedback.found, total)
    : null;

  // Prefer the status-row notifications cell; fall back to body if missing.
  const toastHost =
    typeof document !== "undefined"
      ? document.querySelector<HTMLElement>("[data-progress-toast-slot]")
      : null;

  const feedbackNode =
    feedback && feedbackCopy ? (
      <div
        className={[
          "scratch-frame-progress__feedback",
          feedback.fading ? "is-fading" : "",
          feedbackCopy.primary.startsWith("Almost there")
            ? "is-almost-there"
            : "",
        ]
          .filter(Boolean)
          .join(" ")}
        role="status"
        aria-live="polite"
      >
        <strong>{feedbackCopy.primary}</strong>
        {feedbackCopy.secondary ? <span>{feedbackCopy.secondary}</span> : null}
      </div>
    ) : null;

  return (
    <div
      className={frameClass}
      aria-hidden={toastHost ? "true" : undefined}
      style={
        {
          ["--frame-start" as string]: String(FRAME_START),
        } as CSSProperties
      }
    >
      <svg
        className="scratch-frame-progress__svg"
        viewBox={`0 0 ${FRAME_W} ${FRAME_H}`}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient
            id={`${uid}-track-gradient`}
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="0"
            x2={FRAME_W}
            y2={FRAME_H}
          >
            {TRACK_STOPS.map((stop, index) => (
              <stop
                key={index}
                offset={`${stop.offset}%`}
                stopColor={stop.color}
              />
            ))}
          </linearGradient>
          <linearGradient
            id={`${uid}-progress-gradient`}
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="0"
            x2={FRAME_W}
            y2={FRAME_H}
          >
            {PROGRESS_STOPS.map((stop, index) => (
              <stop
                key={index}
                offset={`${stop.offset}%`}
                stopColor={stop.color}
              />
            ))}
          </linearGradient>
        </defs>
        <path
          className="scratch-frame-progress__track"
          d={FRAME_PATH}
          pathLength={1}
          stroke={`url(#${uid}-track-gradient)`}
          vectorEffect="non-scaling-stroke"
        />
        <path
          className={[
            "scratch-frame-progress__progress",
            solidRing ? "is-ring-closed" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          d={FRAME_PATH}
          pathLength={1}
          stroke={`url(#${uid}-progress-gradient)`}
          vectorEffect="non-scaling-stroke"
          strokeDasharray={progressStroke.strokeDasharray}
          strokeDashoffset={progressStroke.strokeDashoffset}
          strokeLinecap={progressStroke.strokeLinecap}
        />
        {completeSweep ? (
          <path
            className="scratch-frame-progress__sweep is-ring-closed"
            d={FRAME_PATH}
            pathLength={1}
            stroke={`url(#${uid}-progress-gradient)`}
            vectorEffect="non-scaling-stroke"
            strokeDasharray="none"
            strokeDashoffset={0}
            strokeLinecap="butt"
          />
        ) : null}
      </svg>

      {feedbackNode
        ? toastHost
          ? createPortal(feedbackNode, toastHost)
          : feedbackNode
        : null}
    </div>
  );
});
