import { useEffect, useRef, type CSSProperties } from "react";

import { GameSymbolIcon } from "./GameSymbolIcon";
import { shouldPreferStaticSymbolLottie } from "./symbolLottiePolicy";
import {
  MATCH_ANTICIPATION_MS,
  MATCH_SEQUENCE_MS,
  MATCH_SHAKE_CYCLE_MS,
  MATCH_SHAKE_CYCLES,
  MATCH_SHAKE_START_MS,
  MATCH_TRAIL_LIFE_MS,
  MATCH_TRAIL_SPAWN_MS,
  MATCH_TRAIL_STOP_PROGRESS,
  MATCH_TRAVEL_MS,
  easeOutCubic,
  flightControlPoint,
  flightOpacity,
  flightScale,
  quadraticBezier,
  type Point,
} from "./matchFlightPath";

const PREFER_STATIC_SYMBOLS =
  typeof window !== "undefined" &&
  shouldPreferStaticSymbolLottie({
    coarsePointer: window.matchMedia("(pointer: coarse)").matches,
  });

type MatchFlightProps = {
  typeId: number;
  /** Stage-relative pixels: where the symbol was revealed on the card. */
  fromX: number;
  fromY: number;
  /** Stage-relative pixels: the centre of the matching top-bar slot. */
  toX: number;
  toY: number;
  /** Stagger when several matches resolve at once. */
  delayMs: number;
  onArrive: () => void;
};

/**
 * One matched symbol flying home. Each instance owns its own progress, arc and
 * trail nodes, so concurrent flights never share mutable state.
 *
 * The in-place anticipation pop is a CSS animation (`matchAnticipate`); this
 * takes over for the travel and drives the arc per frame.
 */
export function MatchFlight({
  typeId,
  fromX,
  fromY,
  toX,
  toY,
  delayMs,
  onArrive,
}: MatchFlightProps) {
  const coinRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<HTMLDivElement>(null);
  const onArriveRef = useRef(onArrive);

  useEffect(() => {
    onArriveRef.current = onArrive;
  }, [onArrive]);

  useEffect(() => {
    // CSS already hides the coin/trail under reduced-motion — skip rAF + DOM
    // trail work and just resolve the flight after the stagger delay.
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      const timer = window.setTimeout(() => {
        onArriveRef.current();
      }, delayMs);
      return () => window.clearTimeout(timer);
    }

    const from: Point = { x: fromX, y: fromY };
    const to: Point = { x: toX, y: toY };
    const control = flightControlPoint(from, to);
    const trail = trailRef.current;

    let raf = 0;
    let travelStart = 0;
    let lastSpawn = 0;
    let started = false;

    const frame = (now: number) => {
      const coin = coinRef.current;

      if (!started) {
        started = true;
        travelStart = now;
        lastSpawn = now;
        // Take the transform over from the anticipation keyframe. A running
        // animation outranks inline styles, so it has to be dropped first.
        if (coin) coin.style.animation = "none";
      }

      const linear = Math.min((now - travelStart) / MATCH_TRAVEL_MS, 1);
      // Easing feeds the curve — easing anything downstream of a linear
      // bezier sweep would change the pace but not the path.
      const eased = easeOutCubic(linear);
      const at = quadraticBezier(from, control, to, eased);

      if (coin) {
        coin.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -50%) scale(${flightScale(eased)})`;
        coin.style.opacity = `${flightOpacity(eased)}`;
      }

      if (
        eased < MATCH_TRAIL_STOP_PROGRESS &&
        now - lastSpawn >= MATCH_TRAIL_SPAWN_MS
      ) {
        lastSpawn = now;
        spawnTrailDot(trail, at);
      }

      if (linear < 1) {
        raf = requestAnimationFrame(frame);
        return;
      }
      onArriveRef.current();
    };

    // Sit out the anticipation rather than spinning rAF through it.
    const timer = window.setTimeout(
      () => {
        raf = requestAnimationFrame(frame);
      },
      delayMs + MATCH_ANTICIPATION_MS,
    );

    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
      // Nothing outlives the flight, however early it was torn down.
      trail?.replaceChildren();
    };
  }, [fromX, fromY, toX, toY, delayMs]);

  return (
    <>
      <div ref={trailRef} className="match-trail" aria-hidden="true" />
      <div
        ref={coinRef}
        className="flying-coin is-match-fly"
        style={
          {
            "--coin-from-x": `${fromX}px`,
            "--coin-from-y": `${fromY}px`,
            "--match-anticipate-ms": `${MATCH_ANTICIPATION_MS}ms`,
            "--match-sequence-ms": `${MATCH_SEQUENCE_MS}ms`,
            "--match-delay-ms": `${delayMs}ms`,
            "--match-shake-start-ms": `${MATCH_SHAKE_START_MS}ms`,
            "--match-shake-cycle-ms": `${MATCH_SHAKE_CYCLE_MS}ms`,
            "--match-shake-cycles": `${MATCH_SHAKE_CYCLES}`,
          } as CSSProperties
        }
        aria-hidden="true"
      >
        <span className="flying-coin-spin">
          <span
            className="flying-coin-plane flying-coin-plane--back"
            aria-hidden="true"
          />
          <span className="flying-coin-face flying-coin-plane flying-coin-plane--mid">
            <GameSymbolIcon
              typeId={typeId}
              size={34}
              pixelScale={5}
              preferStatic={PREFER_STATIC_SYMBOLS}
              paused
            />
          </span>
        </span>
      </div>
    </>
  );
}

/**
 * Drop a dot at the icon's current position. Once spawned it is independent —
 * it fades and unmounts itself instead of tracking the icon.
 */
function spawnTrailDot(host: HTMLDivElement | null, at: Point) {
  if (!host) return;
  const dot = document.createElement("span");
  dot.className = "match-trail-dot";
  dot.style.setProperty("--dot-x", `${at.x}px`);
  dot.style.setProperty("--dot-y", `${at.y}px`);
  dot.style.setProperty("--match-trail-ms", `${MATCH_TRAIL_LIFE_MS}ms`);
  dot.addEventListener("animationend", () => dot.remove(), { once: true });
  host.appendChild(dot);
}
