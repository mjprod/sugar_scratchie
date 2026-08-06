import type { CSSProperties } from "react";
import type {
  ChannelKeyframe,
  ChannelTracks,
  CubicBezier,
  FxWindow,
  MotionFxSettings,
  StripProps,
  TransitionKeyframe,
} from "./types";

export const STAGE_WIDTH = 390;
export const STAGE_HEIGHT = 672;
/** Final strip X so B settles slightly short of a hard -3W lock. */
export const DEFAULT_END_X = -1163;
export const TILE_COUNT = 4;
export const STRIP_WIDTH = STAGE_WIDTH * TILE_COUNT;
export const DEFAULT_DURATION_MS = 500;

const DEFAULT_BLUR_PEAK = 12.5;
const DEFAULT_BLUR_WINDOW = { startPct: 5, stopPct: 99 } as const;
const DEFAULT_SCALE_PEAK = 1.03;
const DEFAULT_SCALE_WINDOW = { startPct: 0, stopPct: 92 } as const;
const FX_WINDOW_FADE_IN_END = 0.18;
const FX_WINDOW_FADE_OUT_START = 0.7;

/** Default easing from the "shift left" template. */
export const DEFAULT_EASING: CubicBezier = {
  x1: 0.51,
  y1: 0.02,
  x2: 0.44,
  y2: 1.14,
};

export const IDENTITY: StripProps = {
  x: 0,
  y: 0,
  scale: 1,
  blur: 0,
  brightness: 1,
  opacity: 1,
};

const CHANNEL_KEYS = [
  "x",
  "y",
  "scale",
  "blur",
  "brightness",
  "opacity",
] as const;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function roundValue(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function flatChannel(value: number): ChannelKeyframe[] {
  return [
    { t: 0, value },
    { t: 1, value },
  ];
}

export function sortChannelKeyframes(frames: ChannelKeyframe[]): ChannelKeyframe[] {
  return [...frames].sort((left, right) => left.t - right.t);
}

export function defaultChannelTracks(): ChannelTracks {
  return {
    x: [
      { t: 0, value: 0 },
      { t: 1, value: DEFAULT_END_X },
    ],
    y: flatChannel(0),
    scale: flatChannel(1),
    blur: flatChannel(0),
    brightness: flatChannel(1),
    opacity: flatChannel(1),
  };
}

/** Expand independent channels into dense combined strip keys (export compat). */
export function channelsToStripKeyframes(
  tracks: ChannelTracks,
): TransitionKeyframe[] {
  const times = new Set<number>();
  for (const key of CHANNEL_KEYS) {
    for (const frame of tracks[key] ?? []) times.add(roundValue(frame.t, 4));
  }
  if (times.size === 0) {
    return [
      { t: 0, strip: { ...IDENTITY } },
      { t: 1, strip: { ...IDENTITY } },
    ];
  }
  const sortedT = [...times].sort((a, b) => a - b);
  if (sortedT[0] > 0) sortedT.unshift(0);
  if (sortedT[sortedT.length - 1] < 1) sortedT.push(1);

  return sortedT.map((t) => ({
    t,
    strip: sampleChannelTracks(tracks, t, { x1: 0, y1: 0, x2: 1, y2: 1 }),
  }));
}

export function cloneEasing(easing: CubicBezier): CubicBezier {
  return { ...easing };
}

export function defaultEasing(): CubicBezier {
  return cloneEasing(DEFAULT_EASING);
}

function cubicBezierComponent(t: number, p1: number, p2: number): number {
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

function cubicBezierDerivative(t: number, p1: number, p2: number): number {
  const u = 1 - t;
  return 3 * u * u * p1 + 6 * u * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

/** Solve Bezier X(t)=x for t, then return Y(t). */
export function sampleCubicBezier(easing: CubicBezier, x: number): number {
  const target = clamp(x, 0, 1);
  if (target <= 0) return 0;
  if (target >= 1) return 1;

  let t = target;
  for (let i = 0; i < 8; i += 1) {
    const xEst = cubicBezierComponent(t, easing.x1, easing.x2);
    const dx = cubicBezierDerivative(t, easing.x1, easing.x2);
    if (Math.abs(dx) < 1e-6) break;
    t = clamp(t - (xEst - target) / dx, 0, 1);
  }

  let xEst = cubicBezierComponent(t, easing.x1, easing.x2);
  if (Math.abs(xEst - target) > 1e-4) {
    let lo = 0;
    let hi = 1;
    t = target;
    for (let i = 0; i < 20; i += 1) {
      t = (lo + hi) / 2;
      xEst = cubicBezierComponent(t, easing.x1, easing.x2);
      if (xEst < target) lo = t;
      else hi = t;
    }
  }

  return cubicBezierComponent(t, easing.y1, easing.y2);
}

export function sampleChannelValue(
  frames: ChannelKeyframe[],
  t: number,
  easing: CubicBezier,
  fallback = 0,
): number {
  if (!frames || frames.length === 0) return fallback;
  const sorted = sortChannelKeyframes(frames);
  const time = clamp(t, 0, 1);
  if (time <= sorted[0].t) return sorted[0].value;
  const last = sorted[sorted.length - 1];
  if (time >= last.t) return last.value;

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const left = sorted[i];
    const right = sorted[i + 1];
    if (time < left.t || time > right.t) continue;
    const span = Math.max(right.t - left.t, 1e-6);
    const localT = sampleCubicBezier(easing, (time - left.t) / span);
    return lerp(left.value, right.value, localT);
  }
  return last.value;
}

/** Sample independent X/Y/Scale(/blur/brightness/opacity) tracks into a strip pose. */
export function sampleChannelTracks(
  tracks: ChannelTracks,
  t: number,
  easing: CubicBezier,
): StripProps {
  return {
    x: sampleChannelValue(tracks.x, t, easing, IDENTITY.x),
    y: sampleChannelValue(tracks.y, t, easing, IDENTITY.y),
    scale: sampleChannelValue(tracks.scale, t, easing, IDENTITY.scale),
    blur: sampleChannelValue(tracks.blur, t, easing, IDENTITY.blur),
    brightness: sampleChannelValue(
      tracks.brightness,
      t,
      easing,
      IDENTITY.brightness,
    ),
    opacity: sampleChannelValue(tracks.opacity, t, easing, IDENTITY.opacity),
  };
}

export function defaultMotionFx(): MotionFxSettings {
  return {
    enabled: true,
    blurPeak: DEFAULT_BLUR_PEAK,
    blur: { ...DEFAULT_BLUR_WINDOW },
    scalePeak: DEFAULT_SCALE_PEAK,
    scale: { ...DEFAULT_SCALE_WINDOW },
  };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(edge1 - edge0, 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

function normalizeFxWindow(
  startPct: number,
  stopPct: number,
): { start: number; stop: number } {
  const start = clamp(startPct, 0, 100) / 100;
  const stop = clamp(stopPct, 0, 100) / 100;
  return start <= stop ? { start, stop } : { start: stop, stop: start };
}

/**
 * Envelope is 0 outside [startPct, stopPct], ramps inside the window,
 * and returns to 0 by stop so blur clears before settle when stop < 100.
 */
function motionFxEnvelope(t: number, window: FxWindow): number {
  const time = clamp(t, 0, 1);
  const { start, stop } = normalizeFxWindow(window.startPct, window.stopPct);
  if (stop - start < 1e-6) return 0;
  if (time <= start || time >= stop) return 0;
  const u = (time - start) / (stop - start);
  const fadeIn = smoothstep(0, FX_WINDOW_FADE_IN_END, u);
  const fadeOut = 1 - smoothstep(FX_WINDOW_FADE_OUT_START, 1, u);
  return fadeIn * fadeOut;
}

function sampleMotionFx(
  t: number,
  fx: MotionFxSettings,
): { blur: number; scale: number } {
  if (!fx.enabled) return { blur: 0, scale: 1 };
  const blurEnv = motionFxEnvelope(t, fx.blur);
  const scaleEnv = motionFxEnvelope(t, fx.scale);
  return {
    blur: fx.blurPeak * blurEnv,
    scale: lerp(1, fx.scalePeak, scaleEnv),
  };
}

/** Keyframe base + procedural blur/scale FX. */
export function applyMotionFx(
  base: StripProps,
  t: number,
  fx: MotionFxSettings,
): StripProps {
  const motion = sampleMotionFx(t, fx);
  return {
    ...base,
    blur: Math.max(0, base.blur + motion.blur),
    scale: base.scale * motion.scale,
  };
}

export function fxLayerStyle(strip: StripProps): CSSProperties {
  const filters: string[] = [];
  if (strip.blur > 0.001) filters.push(`blur(${strip.blur}px)`);
  if (Math.abs(strip.brightness - 1) > 0.001) {
    filters.push(`brightness(${strip.brightness})`);
  }
  return {
    opacity: strip.opacity,
    filter: filters.length > 0 ? filters.join(" ") : "none",
    transform: `scale(${strip.scale})`,
  };
}

/** Inner strip: horizontal slide only (left-edge anchored). */
export function stripTravelStyle(strip: StripProps): CSSProperties {
  return {
    transform: `translate(${strip.x}px, ${strip.y}px)`,
  };
}

/** Draw a horizontally flipped video frame into a canvas mirror tile. */
export function drawFlippedVideo(
  canvas: HTMLCanvasElement | null,
  video: HTMLVideoElement | null,
) {
  if (!canvas || !video) return;
  if (video.readyState < 2) return;

  const width = Math.max(1, video.videoWidth || STAGE_WIDTH);
  const height = Math.max(1, video.videoHeight || STAGE_HEIGHT);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.translate(width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, width, height);
  ctx.restore();
}
