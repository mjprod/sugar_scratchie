/**
 * Geometry and timing for the match flight: a matched body symbol arcing from
 * where it was found on the card up to its slot in the top symbol bar.
 *
 * The travel is a quadratic bezier sampled per frame rather than a CSS
 * keyframe, because interpolating between waypoints gives straight segments
 * with a corner at the midpoint — the arc has to be computed to read as a
 * curve.
 */

export type Point = { x: number; y: number };

/** In-place anticipation pop before the travel (CSS `matchAnticipate`).
 *  Fade-up, 0.3s read, 3× punch, then gather for the climb. */
export const MATCH_ANTICIPATION_MS = 1800;

/** 3× hold inside anticipation (`matchAnticipate` 39%–78%): tilt-shake window. */
export const MATCH_SHAKE_START_MS = Math.round(MATCH_ANTICIPATION_MS * 0.39);
export const MATCH_SHAKE_MS = Math.round(MATCH_ANTICIPATION_MS * 0.39);
export const MATCH_SHAKE_CYCLES = 3;
export const MATCH_SHAKE_CYCLE_MS = Math.round(MATCH_SHAKE_MS / MATCH_SHAKE_CYCLES);

/** Travel: anticipation end → slot. */
export const MATCH_TRAVEL_MS = 620;

/** Whole sequence, for the effects that span both phases (spin, glow). */
export const MATCH_SEQUENCE_MS = MATCH_ANTICIPATION_MS + MATCH_TRAVEL_MS;

/** One trail dot per interval, while the icon is still well short of the slot. */
export const MATCH_TRAIL_SPAWN_MS = 37;
export const MATCH_TRAIL_LIFE_MS = 375;

/** Stop spawning before arrival so the trail doesn't collide with the landing. */
export const MATCH_TRAIL_STOP_PROGRESS = 0.9;

export const MATCH_SCALE_FROM = 1;
export const MATCH_SCALE_TO = 0.55;

/** Barely a dim — the icon has to stay readable for the whole flight. */
export const MATCH_OPACITY_FROM = 1;
export const MATCH_OPACITY_TO = 0.9;

/** Arc height as a share of the vertical distance, floored so short hops bow. */
const ARC_RISE_RATIO = 0.4;
const ARC_RISE_MIN_PX = 80;

/** Fast off the card, decelerating into the slot. */
export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

const lerp = (from: number, to: number, t: number) => from + (to - from) * t;

/**
 * Control point: horizontal midpoint, lifted above whichever end is higher so
 * the arc always bows upward regardless of where on the card the symbol was.
 */
export function flightControlPoint(from: Point, to: Point): Point {
  const rise = Math.max(
    Math.abs(from.y - to.y) * ARC_RISE_RATIO,
    ARC_RISE_MIN_PX,
  );
  return { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - rise };
}

/** `t` must already be eased — easing the bezier input is what shapes the pace. */
export function quadraticBezier(
  from: Point,
  control: Point,
  to: Point,
  t: number,
): Point {
  const inv = 1 - t;
  const fromWeight = inv * inv;
  const controlWeight = 2 * inv * t;
  const toWeight = t * t;
  return {
    x: fromWeight * from.x + controlWeight * control.x + toWeight * to.x,
    y: fromWeight * from.y + controlWeight * control.y + toWeight * to.y,
  };
}

export const flightScale = (easedT: number) =>
  lerp(MATCH_SCALE_FROM, MATCH_SCALE_TO, easedT);

export const flightOpacity = (easedT: number) =>
  lerp(MATCH_OPACITY_FROM, MATCH_OPACITY_TO, easedT);
