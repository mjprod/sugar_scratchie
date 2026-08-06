import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { loadVideoSrc, releaseMediaElement } from "./shared/media";

const CARDS_INDEX_SRC = "/cards/index.json";
const STAGE_WIDTH = 390;
const STAGE_HEIGHT = 672;
const KEYFRAME_EPSILON = 0.01;
/** Tuned lab default / "shift left" template. */
const DEFAULT_DURATION_MS = 500;
const DEFAULT_CARD_A_ID = "original";
const DEFAULT_CARD_B_ID = "asia_gym";
/** Final strip X so B settles slightly short of a hard -3W lock. */
const DEFAULT_END_X = -1163;

/** One continuous strip: [A | A↻ | B↻ | B] */
const TILE_COUNT = 4;
const STRIP_WIDTH = STAGE_WIDTH * TILE_COUNT;

/** Motion FX while the strip is sliding (blur + scale pulse). */
const DEFAULT_BLUR_PEAK = 12.5;
const DEFAULT_BLUR_WINDOW = { startPct: 5, stopPct: 99 } as const;
/** Slight zoom to hide blurred strip edges against the stage bg. */
const DEFAULT_SCALE_PEAK = 1.03;
const DEFAULT_SCALE_WINDOW = { startPct: 0, stopPct: 92 } as const;
/** Fallback only used when importing legacy global windows. */
const DEFAULT_FX_START_PCT = 5;
const DEFAULT_FX_STOP_PCT = 99;
/**
 * Within each FX start→stop window, relative ramp positions
 * (0–1 of that window). Fade in early, hold, then clear before stop.
 */
const FX_WINDOW_FADE_IN_END = 0.18;
const FX_WINDOW_FADE_OUT_START = 0.7;

type TransitionCard = {
  id: string;
  label: string;
  bottom: string;
};

type StripProps = {
  x: number;
  y: number;
  scale: number;
  blur: number;
  /** CSS brightness multiplier (1 = normal). */
  brightness: number;
  opacity: number;
};

type FxWindow = {
  /** 0–100: % of transition duration when this FX begins. */
  startPct: number;
  /** 0–100: % of transition duration when this FX fully ends. */
  stopPct: number;
};

type MotionFxSettings = {
  enabled: boolean;
  blurPeak: number;
  blur: FxWindow;
  /** Peak uniform scale (1 = none). Pulses up then back to 1. */
  scalePeak: number;
  scale: FxWindow;
};

/** CSS-style cubic-bezier control points. */
type CubicBezier = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

/** Legacy combined strip keyframe (v1/v2 export + import). */
type TransitionKeyframe = {
  t: number;
  strip: StripProps;
};

/** Independent scalar key on one transform channel. */
type ChannelKeyframe = {
  t: number;
  value: number;
};

type StripChannelKey = keyof StripProps;

type ChannelKey = StripChannelKey;

type ChannelTracks = Record<ChannelKey, ChannelKeyframe[]>;

type TransitionPattern = "mirror-slide-strip";

type TransitionPreset = {
  version: 2 | 3;
  pattern: TransitionPattern;
  durationMs: number;
  cardAId: string;
  cardBId: string;
  stageWidth: number;
  easing?: CubicBezier;
  motionFx?: MotionFxSettings;
  /** Preferred v3: independent channel tracks. */
  channels?: ChannelTracks;
  /** Legacy v2 combined strip keys (still exported for compatibility). */
  keyframes: TransitionKeyframe[];
};

type TransitionTemplate = {
  id: string;
  label: string;
  preset: TransitionPreset;
};

type CardsIndexResponse = {
  cards?: Array<{
    id?: unknown;
    label?: unknown;
    bottom?: unknown;
  }>;
};

const IDENTITY: StripProps = {
  x: 0,
  y: 0,
  scale: 1,
  blur: 0,
  brightness: 1,
  opacity: 1,
};

function cloneStrip(strip: StripProps): StripProps {
  return { ...strip };
}

const STRIP_CHANNEL_KEYS: StripChannelKey[] = [
  "x",
  "y",
  "scale",
  "blur",
  "brightness",
  "opacity",
];

const CHANNEL_KEYS: ChannelKey[] = [...STRIP_CHANNEL_KEYS];

function cloneChannelKeyframe(frame: ChannelKeyframe): ChannelKeyframe {
  return { t: frame.t, value: frame.value };
}

function sortChannelKeyframes(frames: ChannelKeyframe[]): ChannelKeyframe[] {
  return [...frames].sort((left, right) => left.t - right.t);
}

function isStripChannelKey(key: string): key is StripChannelKey {
  return (STRIP_CHANNEL_KEYS as string[]).includes(key);
}

function roundChannelValue(key: ChannelKey, value: number): number {
  if (key === "scale" || key === "opacity" || key === "brightness") {
    return roundValue(value, 3);
  }
  if (key === "blur") return roundValue(value, 2);
  return roundValue(value, 2);
}

function flatChannel(value: number): ChannelKeyframe[] {
  return [
    { t: 0, value },
    { t: 1, value },
  ];
}

function defaultChannelTracks(): ChannelTracks {
  /**
   * Continuous line:
   *   [ A | A↻ | B↻ | B ]
   *
   * x = 0      → A in frame
   * x = -W     → A↻ in frame
   * x = -2W    → B↻ in frame
   * x = -1163  → B settled (default end)
   *
   * X/Y/Scale are independent tracks — only X moves in the shift-left default.
   */
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

function cloneChannelTracks(tracks: ChannelTracks): ChannelTracks {
  const next = {} as ChannelTracks;
  for (const key of CHANNEL_KEYS) {
    next[key] = sortChannelKeyframes(tracks[key] ?? []).map(cloneChannelKeyframe);
  }
  return next;
}

/** Expand independent channels into dense combined strip keys (export compat). */
function channelsToStripKeyframes(tracks: ChannelTracks): TransitionKeyframe[] {
  const times = new Set<number>();
  for (const key of CHANNEL_KEYS) {
    for (const frame of tracks[key] ?? []) times.add(roundValue(frame.t, 4));
  }
  if (times.size === 0) {
    return [
      { t: 0, strip: cloneStrip(IDENTITY) },
      { t: 1, strip: cloneStrip(IDENTITY) },
    ];
  }
  const sortedT = [...times].sort((a, b) => a - b);
  // Ensure endpoints so sampling never extrapolates oddly for consumers.
  if (sortedT[0] > 0) sortedT.unshift(0);
  if (sortedT[sortedT.length - 1] < 1) sortedT.push(1);

  return sortedT.map((t) => ({
    t,
    strip: sampleChannelTracks(tracks, t, {
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
    }),
  }));
}

/** Split legacy combined strip keys into independent channel tracks. */
function stripKeyframesToChannels(
  frames: TransitionKeyframe[],
): ChannelTracks {
  const sorted = sortKeyframes(frames);
  if (sorted.length === 0) return defaultChannelTracks();

  const tracks = {} as ChannelTracks;
  for (const key of CHANNEL_KEYS) {
    const channelFrames: ChannelKeyframe[] = sorted.map((frame) => ({
      t: clamp(frame.t, 0, 1),
      value: roundChannelValue(key, frame.strip[key]),
    }));
    // Collapse consecutive identical values to keep tracks tidy, but always
    // keep first/last so each channel has a defined range.
    const collapsed: ChannelKeyframe[] = [];
    for (let i = 0; i < channelFrames.length; i += 1) {
      const frame = channelFrames[i];
      const prev = collapsed[collapsed.length - 1];
      const isEndpoint = i === 0 || i === channelFrames.length - 1;
      if (!prev || isEndpoint || Math.abs(prev.value - frame.value) > 1e-6) {
        if (
          prev &&
          !isEndpoint &&
          Math.abs(prev.t - frame.t) < KEYFRAME_EPSILON &&
          Math.abs(prev.value - frame.value) <= 1e-6
        ) {
          continue;
        }
        collapsed.push(frame);
      }
    }
    // Ensure at least two keys.
    if (collapsed.length === 1) {
      collapsed.push({ t: 1, value: collapsed[0].value });
      if (collapsed[0].t > 0) collapsed.unshift({ t: 0, value: collapsed[0].value });
    }
    tracks[key] = sortChannelKeyframes(collapsed);
  }
  return tracks;
}

function defaultKeyframes(): TransitionKeyframe[] {
  return channelsToStripKeyframes(defaultChannelTracks());
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Default easing from the "shift left" template. */
const DEFAULT_EASING: CubicBezier = {
  x1: 0.51,
  y1: 0.02,
  x2: 0.44,
  y2: 1.14,
};

const EASING_PRESETS: Array<{ id: string; label: string; bezier: CubicBezier }> = [
  { id: "linear", label: "Linear", bezier: { x1: 0, y1: 0, x2: 1, y2: 1 } },
  { id: "ease", label: "Ease", bezier: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 } },
  { id: "ease-in", label: "In", bezier: { x1: 0.42, y1: 0, x2: 1, y2: 1 } },
  { id: "ease-out", label: "Out", bezier: { x1: 0, y1: 0, x2: 0.58, y2: 1 } },
  {
    id: "ease-in-out",
    label: "In-Out",
    bezier: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
  },
  {
    id: "smooth",
    label: "Smooth",
    bezier: { x1: 0.45, y1: 0, x2: 0.55, y2: 1 },
  },
];

function cloneEasing(easing: CubicBezier): CubicBezier {
  return { ...easing };
}

function defaultEasing(): CubicBezier {
  return cloneEasing(DEFAULT_EASING);
}

function sanitizeEasing(value: CubicBezier): CubicBezier {
  return {
    x1: clamp(value.x1, 0, 1),
    y1: value.y1,
    x2: clamp(value.x2, 0, 1),
    y2: value.y2,
  };
}

function parseEasing(raw: unknown): CubicBezier | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (
    typeof data.x1 !== "number" ||
    typeof data.y1 !== "number" ||
    typeof data.x2 !== "number" ||
    typeof data.y2 !== "number"
  ) {
    return null;
  }
  return sanitizeEasing({
    x1: data.x1,
    y1: data.y1,
    x2: data.x2,
    y2: data.y2,
  });
}

function cubicBezierComponent(
  t: number,
  p1: number,
  p2: number,
): number {
  // (1-t)^3*0 + 3(1-t)^2 t p1 + 3(1-t) t^2 p2 + t^3*1
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

function cubicBezierDerivative(
  t: number,
  p1: number,
  p2: number,
): number {
  const u = 1 - t;
  return 3 * u * u * p1 + 6 * u * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

/** Solve Bezier X(t)=x for t, then return Y(t). */
function sampleCubicBezier(easing: CubicBezier, x: number): number {
  const target = clamp(x, 0, 1);
  if (target <= 0) return 0;
  if (target >= 1) return 1;

  let t = target;
  // Newton-Raphson on X curve.
  for (let i = 0; i < 8; i += 1) {
    const xEst = cubicBezierComponent(t, easing.x1, easing.x2);
    const dx = cubicBezierDerivative(t, easing.x1, easing.x2);
    if (Math.abs(dx) < 1e-6) break;
    t = clamp(t - (xEst - target) / dx, 0, 1);
  }

  // Fallback bisection if needed.
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

function formatBezier(easing: CubicBezier): string {
  return `cubic-bezier(${roundValue(easing.x1, 3)}, ${roundValue(easing.y1, 3)}, ${roundValue(easing.x2, 3)}, ${roundValue(easing.y2, 3)})`;
}

function lerpStrip(a: StripProps, b: StripProps, t: number): StripProps {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    scale: lerp(a.scale, b.scale, t),
    blur: lerp(a.blur, b.blur, t),
    brightness: lerp(a.brightness, b.brightness, t),
    opacity: lerp(a.opacity, b.opacity, t),
  };
}

function sortKeyframes(frames: TransitionKeyframe[]): TransitionKeyframe[] {
  return [...frames].sort((left, right) => left.t - right.t);
}

function sampleChannelValue(
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
function sampleChannelTracks(
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

/** Legacy combined-strip sampler (import path / old presets). */
function sampleKeyframes(
  frames: TransitionKeyframe[],
  t: number,
  easing: CubicBezier,
): StripProps {
  if (frames.length === 0) return cloneStrip(IDENTITY);

  const sorted = sortKeyframes(frames);
  const time = clamp(t, 0, 1);
  if (time <= sorted[0].t) return cloneStrip(sorted[0].strip);

  const last = sorted[sorted.length - 1];
  if (time >= last.t) return cloneStrip(last.strip);

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const left = sorted[i];
    const right = sorted[i + 1];
    if (time < left.t || time > right.t) continue;
    const span = Math.max(right.t - left.t, 1e-6);
    const localT = sampleCubicBezier(easing, (time - left.t) / span);
    return lerpStrip(left.strip, right.strip, localT);
  }

  return cloneStrip(last.strip);
}

function findNearestChannelKeyframeIndex(
  frames: ChannelKeyframe[],
  t: number,
): number {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < frames.length; i += 1) {
    const distance = Math.abs(frames[i].t - t);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestDistance <= KEYFRAME_EPSILON ? bestIndex : -1;
}

function quantizeChannelKeyframeT(
  t: number,
  frames: ChannelKeyframe[],
  ignoreIndex = -1,
): number {
  let nextT = roundValue(clamp(t, 0, 1), 4);
  for (let guard = 0; guard < 12; guard += 1) {
    const hit = frames.findIndex(
      (frame, index) =>
        index !== ignoreIndex && Math.abs(frame.t - nextT) < KEYFRAME_EPSILON,
    );
    if (hit < 0) break;
    nextT = clamp(nextT + KEYFRAME_EPSILON * 2, 0, 1);
    nextT = roundValue(nextT, 4);
  }
  return nextT;
}

function setChannelKeyframe(
  tracks: ChannelTracks,
  channel: ChannelKey,
  tRaw: number,
  value: number,
): { tracks: ChannelTracks; index: number; t: number } {
  const frames = sortChannelKeyframes(tracks[channel] ?? []);
  const nearest = findNearestChannelKeyframeIndex(frames, tRaw);
  const t =
    nearest >= 0
      ? frames[nearest].t
      : quantizeChannelKeyframeT(tRaw, frames);
  const frame: ChannelKeyframe = {
    t,
    value: roundChannelValue(channel, value),
  };
  const nextFrames =
    nearest >= 0
      ? sortChannelKeyframes(
          frames.map((entry, index) => (index === nearest ? frame : entry)),
        )
      : sortChannelKeyframes([...frames, frame]);
  const index = nextFrames.findIndex((entry) => Math.abs(entry.t - frame.t) < 1e-6);
  return {
    tracks: {
      ...tracks,
      [channel]: nextFrames,
    },
    index: index >= 0 ? index : 0,
    t: frame.t,
  };
}

function moveChannelKeyframe(
  tracks: ChannelTracks,
  channel: ChannelKey,
  index: number,
  nextTRaw: number,
  nextValue: number,
): { tracks: ChannelTracks; index: number; t: number } {
  const frames = sortChannelKeyframes(tracks[channel] ?? []);
  if (index < 0 || index >= frames.length) {
    return { tracks, index, t: nextTRaw };
  }
  const t = quantizeChannelKeyframeT(nextTRaw, frames, index);
  const frame: ChannelKeyframe = {
    t,
    value: roundChannelValue(channel, nextValue),
  };
  const nextFrames = sortChannelKeyframes(
    frames.map((entry, i) => (i === index ? frame : entry)),
  );
  const nextIndex = nextFrames.findIndex((entry) => Math.abs(entry.t - frame.t) < 1e-6);
  return {
    tracks: {
      ...tracks,
      [channel]: nextFrames,
    },
    index: nextIndex >= 0 ? nextIndex : index,
    t: frame.t,
  };
}

function deleteChannelKeyframe(
  tracks: ChannelTracks,
  channel: ChannelKey,
  index: number,
): ChannelTracks | null {
  const frames = sortChannelKeyframes(tracks[channel] ?? []);
  if (frames.length <= 1) return null;
  if (index < 0 || index >= frames.length) return null;
  return {
    ...tracks,
    [channel]: frames.filter((_, i) => i !== index),
  };
}

function roundValue(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundStrip(strip: StripProps): StripProps {
  return {
    x: roundValue(strip.x, 2),
    y: roundValue(strip.y, 2),
    scale: roundValue(strip.scale, 3),
    blur: roundValue(strip.blur, 2),
    brightness: roundValue(strip.brightness, 3),
    opacity: roundValue(strip.opacity, 3),
  };
}

/** Outer stage layer: blur/brightness + centered scale pulse (covers edge bleed). */
function fxLayerStyle(strip: StripProps): CSSProperties {
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
function stripTravelStyle(strip: StripProps): CSSProperties {
  return {
    transform: `translate(${strip.x}px, ${strip.y}px)`,
  };
}

function defaultMotionFx(): MotionFxSettings {
  return {
    enabled: true,
    blurPeak: DEFAULT_BLUR_PEAK,
    blur: { ...DEFAULT_BLUR_WINDOW },
    scalePeak: DEFAULT_SCALE_PEAK,
    scale: { ...DEFAULT_SCALE_WINDOW },
  };
}

function buildShiftLeftPreset(): TransitionPreset {
  const channels = defaultChannelTracks();
  return {
    version: 3,
    pattern: "mirror-slide-strip",
    durationMs: DEFAULT_DURATION_MS,
    cardAId: DEFAULT_CARD_A_ID,
    cardBId: DEFAULT_CARD_B_ID,
    stageWidth: STAGE_WIDTH,
    easing: defaultEasing(),
    motionFx: defaultMotionFx(),
    channels,
    // Combined keys kept for older consumers / visual markers.
    keyframes: channelsToStripKeyframes(channels),
  };
}

/** Shift-left slide with mid-transition Y bounce + scale/brightness pulse. */
function buildBounceOutPreset(): TransitionPreset {
  const channels: ChannelTracks = {
    x: [
      { t: 0, value: 0 },
      { t: 1, value: DEFAULT_END_X },
    ],
    y: [
      { t: 0, value: 0 },
      { t: 0.1, value: 0 },
      { t: 0.2627, value: -19.64 },
      { t: 0.302, value: 26.79 },
      { t: 0.3415, value: -19.64 },
      { t: 0.4094, value: 32.12 },
      { t: 0.4998, value: -27.59 },
      { t: 0.6, value: 0 },
      { t: 1, value: 0 },
    ],
    scale: [
      { t: 0, value: 1 },
      { t: 0.1004, value: 1 },
      { t: 0.2389, value: 1.11 },
      { t: 0.5011, value: 1.11 },
      { t: 0.7029, value: 1 },
      { t: 1, value: 1 },
    ],
    blur: [
      { t: 0, value: 0 },
      { t: 1, value: 0 },
    ],
    brightness: [
      { t: 0, value: 1 },
      { t: 0.0785, value: 1.004 },
      { t: 0.2136, value: 1.111 },
      { t: 0.5598, value: 1.648 },
      { t: 0.8625, value: 1 },
      { t: 1, value: 1 },
    ],
    opacity: [
      { t: 0, value: 1 },
      { t: 1, value: 1 },
    ],
  };
  return {
    version: 3,
    pattern: "mirror-slide-strip",
    durationMs: 750,
    cardAId: DEFAULT_CARD_A_ID,
    cardBId: DEFAULT_CARD_B_ID,
    stageWidth: STAGE_WIDTH,
    easing: defaultEasing(),
    motionFx: {
      ...defaultMotionFx(),
      blurPeak: 4,
    },
    channels,
    keyframes: channelsToStripKeyframes(channels),
  };
}

/** Hold, then slide left with a mid-transition scale punch. */
function buildZoomUpPreset(): TransitionPreset {
  const channels: ChannelTracks = {
    x: [
      { t: 0, value: 0 },
      { t: 0.1606, value: 0 },
      { t: 1, value: DEFAULT_END_X },
    ],
    y: [
      { t: 0, value: 0 },
      { t: 1, value: 0 },
    ],
    scale: [
      { t: 0, value: 1 },
      { t: 0.3007, value: 1 },
      { t: 0.5985, value: 1.385 },
      { t: 0.7833, value: 1 },
      { t: 1, value: 1 },
    ],
    blur: [
      { t: 0, value: 0 },
      { t: 1, value: 0 },
    ],
    brightness: [
      { t: 0, value: 1 },
      { t: 1, value: 1 },
    ],
    opacity: [
      { t: 0, value: 1 },
      { t: 1, value: 1 },
    ],
  };
  return {
    version: 3,
    pattern: "mirror-slide-strip",
    durationMs: 850,
    cardAId: DEFAULT_CARD_A_ID,
    cardBId: DEFAULT_CARD_B_ID,
    stageWidth: STAGE_WIDTH,
    easing: {
      x1: 0.793,
      y1: -0.013,
      x2: 0.44,
      y2: 1.14,
    },
    motionFx: {
      ...defaultMotionFx(),
      blurPeak: 3.5,
      blur: { startPct: 19, stopPct: 99 },
    },
    channels,
    keyframes: channelsToStripKeyframes(channels),
  };
}

const TRANSITION_TEMPLATES: TransitionTemplate[] = [
  {
    id: "shift-left",
    label: "Shift left",
    preset: buildShiftLeftPreset(),
  },
  {
    id: "bounceout",
    label: "Bounce out",
    preset: buildBounceOutPreset(),
  },
  {
    id: "zoomup",
    label: "Zoom up",
    preset: buildZoomUpPreset(),
  },
];

const DEFAULT_TEMPLATE_ID = "shift-left";

function getTemplate(id: string): TransitionTemplate | null {
  return TRANSITION_TEMPLATES.find((entry) => entry.id === id) ?? null;
}

function clonePreset(preset: TransitionPreset): TransitionPreset {
  const channels = cloneChannelTracks(
    preset.channels ?? stripKeyframesToChannels(preset.keyframes),
  );
  return {
    version: 3,
    pattern: "mirror-slide-strip",
    durationMs: preset.durationMs,
    cardAId: preset.cardAId,
    cardBId: preset.cardBId,
    stageWidth: preset.stageWidth,
    easing: sanitizeEasing(preset.easing ?? defaultEasing()),
    motionFx: {
      enabled: preset.motionFx?.enabled ?? true,
      blurPeak: preset.motionFx?.blurPeak ?? DEFAULT_BLUR_PEAK,
      blur: {
        startPct: preset.motionFx?.blur.startPct ?? DEFAULT_BLUR_WINDOW.startPct,
        stopPct: preset.motionFx?.blur.stopPct ?? DEFAULT_BLUR_WINDOW.stopPct,
      },
      scalePeak: preset.motionFx?.scalePeak ?? DEFAULT_SCALE_PEAK,
      scale: {
        startPct:
          preset.motionFx?.scale.startPct ?? DEFAULT_SCALE_WINDOW.startPct,
        stopPct: preset.motionFx?.scale.stopPct ?? DEFAULT_SCALE_WINDOW.stopPct,
      },
    },
    channels,
    keyframes: channelsToStripKeyframes(channels),
  };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(edge1 - edge0, 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

function normalizeFxWindow(startPct: number, stopPct: number): {
  start: number;
  stop: number;
} {
  const start = clamp(startPct, 0, 100) / 100;
  const stop = clamp(stopPct, 0, 100) / 100;
  return start <= stop ? { start, stop } : { start: stop, stop: start };
}

function parseFxWindow(
  value: unknown,
  fallbackStart: number,
  fallbackStop: number,
): FxWindow {
  if (value && typeof value === "object") {
    const raw = value as Record<string, unknown>;
    const startPct =
      typeof raw.startPct === "number"
        ? clamp(raw.startPct, 0, 100)
        : fallbackStart;
    const stopPct =
      typeof raw.stopPct === "number" ? clamp(raw.stopPct, 0, 100) : fallbackStop;
    return {
      startPct,
      stopPct: Math.max(startPct, stopPct),
    };
  }
  return {
    startPct: fallbackStart,
    stopPct: Math.max(fallbackStart, fallbackStop),
  };
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
    // 1 → peak → 1 within the scale window.
    scale: lerp(1, fx.scalePeak, scaleEnv),
  };
}

/** Keyframe base + procedural blur/scale FX for display only. */
function applyMotionFx(
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

function formatTime(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function summarizeStrip(strip: StripProps): string {
  return `x${roundValue(strip.x, 0)} y${roundValue(strip.y, 0)} s${roundValue(strip.scale, 2)} br${roundValue(strip.brightness, 2)} b${roundValue(strip.blur, 1)} o${roundValue(strip.opacity, 2)}`;
}

function isLooseStripProps(value: unknown): value is {
  x: number;
  y: number;
  scale: number;
  blur: number;
  opacity: number;
  brightness?: number;
} {
  if (!value || typeof value !== "object") return false;
  const strip = value as Record<string, unknown>;
  return (
    typeof strip.x === "number" &&
    typeof strip.y === "number" &&
    typeof strip.scale === "number" &&
    typeof strip.blur === "number" &&
    typeof strip.opacity === "number"
  );
}

function normalizeStrip(value: {
  x: number;
  y: number;
  scale: number;
  blur: number;
  opacity: number;
  brightness?: number;
}): StripProps {
  return roundStrip({
    x: value.x,
    y: value.y,
    scale: value.scale,
    blur: value.blur,
    brightness:
      typeof value.brightness === "number" ? value.brightness : IDENTITY.brightness,
    opacity: value.opacity,
  });
}

function parseChannelTracks(raw: unknown): ChannelTracks | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const tracks = defaultChannelTracks();
  let any = false;
  for (const key of CHANNEL_KEYS) {
    const list = data[key];
    if (!Array.isArray(list) || list.length === 0) continue;
    const frames: ChannelKeyframe[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const frame = entry as Record<string, unknown>;
      if (typeof frame.t !== "number" || typeof frame.value !== "number") continue;
      frames.push({
        t: clamp(frame.t, 0, 1),
        value: roundChannelValue(key, frame.value),
      });
    }
    if (frames.length > 0) {
      tracks[key] = sortChannelKeyframes(frames);
      any = true;
    }
  }
  return any ? tracks : null;
}

/** Accept v3 channel tracks, v2 strip keyframes, or legacy v1 dual-group (a/b). */
function parsePreset(raw: unknown): TransitionPreset | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (data.version !== 1 && data.version !== 2 && data.version !== 3) return null;
  if (typeof data.durationMs !== "number" || !Number.isFinite(data.durationMs)) {
    return null;
  }
  if (typeof data.cardAId !== "string" || typeof data.cardBId !== "string") {
    return null;
  }

  let channels = parseChannelTracks(data.channels);
  const keyframes: TransitionKeyframe[] = [];
  if (Array.isArray(data.keyframes)) {
    for (const entry of data.keyframes) {
      if (!entry || typeof entry !== "object") continue;
      const frame = entry as Record<string, unknown>;
      if (typeof frame.t !== "number") continue;

      if (isLooseStripProps(frame.strip)) {
        keyframes.push({
          t: clamp(frame.t, 0, 1),
          strip: normalizeStrip(frame.strip),
        });
        continue;
      }

      // Legacy v1: prefer outgoing group a as strip x (same slide direction).
      if (isLooseStripProps(frame.a)) {
        keyframes.push({
          t: clamp(frame.t, 0, 1),
          strip: normalizeStrip(frame.a),
        });
      }
    }
  }

  if (!channels) {
    if (keyframes.length === 0) return null;
    channels = stripKeyframesToChannels(keyframes);
  }

  let motionFx = defaultMotionFx();
  if (data.motionFx && typeof data.motionFx === "object") {
    const rawFx = data.motionFx as Record<string, unknown>;
    // Legacy global window falls back for older presets.
    const legacyStart =
      typeof rawFx.startPct === "number"
        ? clamp(rawFx.startPct, 0, 100)
        : DEFAULT_FX_START_PCT;
    const legacyStop =
      typeof rawFx.stopPct === "number"
        ? clamp(rawFx.stopPct, 0, 100)
        : DEFAULT_FX_STOP_PCT;
    motionFx = {
      enabled: rawFx.enabled !== false,
      blurPeak:
        typeof rawFx.blurPeak === "number" ? rawFx.blurPeak : DEFAULT_BLUR_PEAK,
      blur: parseFxWindow(rawFx.blur, legacyStart, legacyStop),
      scalePeak:
        typeof rawFx.scalePeak === "number"
          ? rawFx.scalePeak
          : DEFAULT_SCALE_PEAK,
      scale: parseFxWindow(
        rawFx.scale,
        DEFAULT_SCALE_WINDOW.startPct,
        DEFAULT_SCALE_WINDOW.stopPct,
      ),
    };
  }

  const easing = parseEasing(data.easing) ?? defaultEasing();

  return {
    version: 3,
    pattern: "mirror-slide-strip",
    durationMs: sanitizeDurationMs(data.durationMs),
    cardAId: data.cardAId,
    cardBId: data.cardBId,
    stageWidth: STAGE_WIDTH,
    easing,
    motionFx,
    channels,
    keyframes: channelsToStripKeyframes(channels),
  };
}

/** Any positive finite duration. Falls back only when invalid. */
function sanitizeDurationMs(value: number, fallback = DEFAULT_DURATION_MS): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

async function loadTransitionCards(): Promise<TransitionCard[]> {
  try {
    const response = await fetch(CARDS_INDEX_SRC, { cache: "no-store" });
    if (!response.ok) return [];
    const data = (await response.json()) as CardsIndexResponse;
    if (!Array.isArray(data.cards)) return [];
    const cards: TransitionCard[] = [];
    for (const entry of data.cards) {
      if (
        typeof entry.id !== "string" ||
        typeof entry.label !== "string" ||
        typeof entry.bottom !== "string" ||
        !entry.bottom
      ) {
        continue;
      }
      cards.push({ id: entry.id, label: entry.label, bottom: entry.bottom });
    }
    return cards;
  } catch {
    return [];
  }
}

function findNearestKeyframeIndex(frames: TransitionKeyframe[], t: number): number {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < frames.length; i += 1) {
    const distance = Math.abs(frames[i].t - t);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestDistance <= KEYFRAME_EPSILON ? bestIndex : -1;
}

async function loadLoopingVideo(
  video: HTMLVideoElement,
  src: string,
): Promise<void> {
  await loadVideoSrc(video, src);
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => undefined);
}

/** Draw a horizontally flipped video frame into a canvas mirror tile. */
function drawFlippedVideo(
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

type SliderDef = {
  key: keyof StripProps;
  label: string;
  min: number;
  max: number;
  step: number;
};

const STRIP_SLIDERS: SliderDef[] = [
  { key: "x", label: "X", min: -STAGE_WIDTH * 4, max: STAGE_WIDTH, step: 1 },
  { key: "y", label: "Y", min: -200, max: 200, step: 1 },
  { key: "scale", label: "Scale", min: 0, max: 2, step: 0.01 },
  { key: "brightness", label: "Bright", min: 0, max: 3, step: 0.01 },
  { key: "blur", label: "Blur", min: 0, max: 40, step: 0.1 },
  { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
];

/** Graph-editor channels for exact X / Y / Scale / Brightness keyframing. */
type GraphChannelKey = "x" | "y" | "scale" | "brightness";

type GraphChannelDef = {
  key: GraphChannelKey;
  label: string;
  color: string;
  min: number;
  max: number;
  step: number;
  digits: number;
};

const GRAPH_CHANNELS: GraphChannelDef[] = [
  {
    key: "x",
    label: "X",
    color: "#2a74bf",
    min: -STAGE_WIDTH * 4,
    max: STAGE_WIDTH,
    step: 1,
    digits: 1,
  },
  {
    key: "y",
    label: "Y",
    color: "#2a9d5c",
    min: -200,
    max: 200,
    step: 1,
    digits: 1,
  },
  {
    key: "scale",
    label: "Scale",
    color: "#c45c26",
    min: 0.5,
    max: 1.5,
    step: 0.005,
    digits: 3,
  },
  {
    key: "brightness",
    label: "Bright",
    color: "#c9a227",
    min: 0,
    max: 2.5,
    step: 0.01,
    digits: 2,
  },
];

const GRAPH_VIEW = {
  width: 1000,
  /** Per-lane plot height (stacked independent X/Y/Scale rows). */
  laneH: 110,
  laneGap: 10,
  padL: 54,
  padR: 18,
  padT: 10,
  padB: 22,
  labelW: 44,
} as const;

const GRAPH_PLOT_W = GRAPH_VIEW.width - GRAPH_VIEW.padL - GRAPH_VIEW.padR;
const GRAPH_SAMPLE_COUNT = 120;
const GRAPH_ZOOM_MIN_SPAN_T = 0.02;
const GRAPH_ZOOM_MIN_SPAN_N = 0.02;
const GRAPH_ZOOM_MAX = 50;

type GraphVisibility = Record<GraphChannelKey, boolean>;

const DEFAULT_GRAPH_VISIBILITY: GraphVisibility = {
  x: true,
  y: true,
  scale: true,
  brightness: true,
};

/** Shared time window + per-channel value windows (independent Y zoom). */
type GraphViewport = {
  t0: number;
  t1: number;
  values: Record<GraphChannelKey, { n0: number; n1: number }>;
};

const DEFAULT_GRAPH_VIEWPORT: GraphViewport = {
  t0: 0,
  t1: 1,
  values: {
    x: { n0: 0, n1: 1 },
    y: { n0: 0, n1: 1 },
    scale: { n0: 0, n1: 1 },
    brightness: { n0: 0, n1: 1 },
  },
};

type GraphDragState = {
  index: number;
  channel: GraphChannelKey;
  moved: boolean;
};

type GraphPanState = {
  channel: GraphChannelKey | null;
  startClientX: number;
  startClientY: number;
  origin: GraphViewport;
};

type LaneLayout = {
  key: GraphChannelKey;
  channel: GraphChannelDef;
  top: number;
  height: number;
  plotTop: number;
  plotH: number;
};

function getGraphChannel(key: GraphChannelKey): GraphChannelDef {
  return GRAPH_CHANNELS.find((channel) => channel.key === key) ?? GRAPH_CHANNELS[0];
}

function cloneViewport(view: GraphViewport): GraphViewport {
  return {
    t0: view.t0,
    t1: view.t1,
    values: {
      x: { ...view.values.x },
      y: { ...view.values.y },
      scale: { ...view.values.scale },
      brightness: { ...view.values.brightness },
    },
  };
}

function sanitizeValueWindow(n0Raw: number, n1Raw: number): { n0: number; n1: number } {
  let n0 = clamp(n0Raw, 0, 1);
  let n1 = clamp(n1Raw, 0, 1);
  if (n1 < n0) {
    const swap = n0;
    n0 = n1;
    n1 = swap;
  }
  if (n1 - n0 < GRAPH_ZOOM_MIN_SPAN_N) {
    const mid = (n0 + n1) / 2;
    n0 = clamp(mid - GRAPH_ZOOM_MIN_SPAN_N / 2, 0, 1 - GRAPH_ZOOM_MIN_SPAN_N);
    n1 = n0 + GRAPH_ZOOM_MIN_SPAN_N;
  }
  return { n0, n1 };
}

function sanitizeViewport(view: GraphViewport): GraphViewport {
  let t0 = clamp(view.t0, 0, 1);
  let t1 = clamp(view.t1, 0, 1);
  if (t1 < t0) {
    const swap = t0;
    t0 = t1;
    t1 = swap;
  }
  if (t1 - t0 < GRAPH_ZOOM_MIN_SPAN_T) {
    const mid = (t0 + t1) / 2;
    t0 = clamp(mid - GRAPH_ZOOM_MIN_SPAN_T / 2, 0, 1 - GRAPH_ZOOM_MIN_SPAN_T);
    t1 = t0 + GRAPH_ZOOM_MIN_SPAN_T;
  }

  return {
    t0,
    t1,
    values: {
      x: sanitizeValueWindow(view.values.x.n0, view.values.x.n1),
      y: sanitizeValueWindow(view.values.y.n0, view.values.y.n1),
      scale: sanitizeValueWindow(view.values.scale.n0, view.values.scale.n1),
      brightness: sanitizeValueWindow(
        view.values.brightness.n0,
        view.values.brightness.n1,
      ),
    },
  };
}

function viewportZoomT(view: GraphViewport): number {
  return 1 / Math.max(view.t1 - view.t0, GRAPH_ZOOM_MIN_SPAN_T);
}

function viewportZoomN(
  view: GraphViewport,
  channel: GraphChannelKey,
): number {
  const win = view.values[channel];
  return 1 / Math.max(win.n1 - win.n0, GRAPH_ZOOM_MIN_SPAN_N);
}

function graphHeight(laneCount: number): number {
  const count = Math.max(1, laneCount);
  return (
    GRAPH_VIEW.padT +
    count * GRAPH_VIEW.laneH +
    Math.max(0, count - 1) * GRAPH_VIEW.laneGap +
    GRAPH_VIEW.padB
  );
}

function buildLaneLayouts(visibleKeys: GraphChannelKey[]): LaneLayout[] {
  const keys =
    visibleKeys.length > 0
      ? visibleKeys
      : (["x"] as GraphChannelKey[]);
  return keys.map((key, index) => {
    const top =
      GRAPH_VIEW.padT + index * (GRAPH_VIEW.laneH + GRAPH_VIEW.laneGap);
    return {
      key,
      channel: getGraphChannel(key),
      top,
      height: GRAPH_VIEW.laneH,
      plotTop: top + 16,
      plotH: GRAPH_VIEW.laneH - 28,
    };
  });
}

function graphTToX(t: number, view: GraphViewport): number {
  const span = Math.max(view.t1 - view.t0, 1e-6);
  const u = (t - view.t0) / span;
  return GRAPH_VIEW.padL + u * GRAPH_PLOT_W;
}

function graphXToT(x: number, view: GraphViewport): number {
  const u = (x - GRAPH_VIEW.padL) / Math.max(GRAPH_PLOT_W, 1);
  return view.t0 + u * (view.t1 - view.t0);
}

function valueToNorm(value: number, channel: GraphChannelDef): number {
  const span = Math.max(channel.max - channel.min, 1e-6);
  return (value - channel.min) / span;
}

function normToValue(n: number, channel: GraphChannelDef): number {
  return channel.min + n * (channel.max - channel.min);
}

function graphValueToY(
  value: number,
  channel: GraphChannelDef,
  view: GraphViewport,
  lane: LaneLayout,
): number {
  const n = valueToNorm(value, channel);
  const win = view.values[channel.key];
  const span = Math.max(win.n1 - win.n0, 1e-6);
  const u = (n - win.n0) / span;
  return lane.plotTop + (1 - u) * lane.plotH;
}

function graphYToValue(
  y: number,
  channel: GraphChannelDef,
  view: GraphViewport,
  lane: LaneLayout,
): number {
  const u = 1 - (y - lane.plotTop) / Math.max(lane.plotH, 1);
  const win = view.values[channel.key];
  const n = win.n0 + u * (win.n1 - win.n0);
  const raw = normToValue(n, channel);
  const zoom = viewportZoomN(view, channel.key);
  const step = channel.step / Math.max(1, Math.min(zoom, 20));
  const stepped = Math.round(raw / step) * step;
  return clamp(stepped, channel.min, channel.max);
}

function hitTestLane(y: number, lanes: LaneLayout[]): LaneLayout | null {
  if (lanes.length === 0) return null;
  for (const lane of lanes) {
    if (y >= lane.top && y <= lane.top + lane.height) return lane;
  }
  // Snap to nearest lane if slightly outside.
  let best = lanes[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const lane of lanes) {
    const mid = lane.top + lane.height / 2;
    const dist = Math.abs(y - mid);
    if (dist < bestDist) {
      bestDist = dist;
      best = lane;
    }
  }
  return best;
}

function zoomViewportAt(
  view: GraphViewport,
  factor: number,
  anchorT: number,
  anchorN: number,
  channel: GraphChannelKey | null,
  axes: { time?: boolean; value?: boolean } = { time: true, value: true },
): GraphViewport {
  const next = cloneViewport(view);
  const zoomFactor = clamp(factor, 1 / GRAPH_ZOOM_MAX, GRAPH_ZOOM_MAX);

  if (axes.time !== false) {
    const spanT = view.t1 - view.t0;
    const nextSpanT = clamp(spanT * zoomFactor, GRAPH_ZOOM_MIN_SPAN_T, 1);
    const at = clamp(anchorT, view.t0, view.t1);
    const ratio = spanT <= 1e-9 ? 0.5 : clamp((at - view.t0) / spanT, 0, 1);
    next.t0 = at - nextSpanT * ratio;
    next.t1 = next.t0 + nextSpanT;
    if (next.t0 < 0) {
      next.t0 = 0;
      next.t1 = nextSpanT;
    } else if (next.t1 > 1) {
      next.t1 = 1;
      next.t0 = 1 - nextSpanT;
    }
  }

  if (axes.value !== false && channel) {
    const win = view.values[channel];
    const spanN = win.n1 - win.n0;
    const nextSpanN = clamp(spanN * zoomFactor, GRAPH_ZOOM_MIN_SPAN_N, 1);
    const an = clamp(anchorN, win.n0, win.n1);
    const ratio = spanN <= 1e-9 ? 0.5 : clamp((an - win.n0) / spanN, 0, 1);
    let n0 = an - nextSpanN * ratio;
    let n1 = n0 + nextSpanN;
    if (n0 < 0) {
      n0 = 0;
      n1 = nextSpanN;
    } else if (n1 > 1) {
      n1 = 1;
      n0 = 1 - nextSpanN;
    }
    next.values[channel] = { n0, n1 };
  }

  return sanitizeViewport(next);
}

function panViewport(
  view: GraphViewport,
  dT: number,
  dN: number,
  channel: GraphChannelKey | null,
): GraphViewport {
  const spanT = view.t1 - view.t0;
  let t0 = view.t0 + dT;
  let t1 = view.t1 + dT;
  if (t0 < 0) {
    t0 = 0;
    t1 = spanT;
  } else if (t1 > 1) {
    t1 = 1;
    t0 = 1 - spanT;
  }

  const next = cloneViewport(view);
  next.t0 = t0;
  next.t1 = t1;

  if (channel) {
    const win = view.values[channel];
    const spanN = win.n1 - win.n0;
    let n0 = win.n0 + dN;
    let n1 = win.n1 + dN;
    if (n0 < 0) {
      n0 = 0;
      n1 = spanN;
    } else if (n1 > 1) {
      n1 = 1;
      n0 = 1 - spanN;
    }
    next.values[channel] = { n0, n1 };
  }

  return sanitizeViewport(next);
}

function buildNiceTicks(min: number, max: number, count: number): number[] {
  const span = Math.max(max - min, 1e-9);
  const rough = span / Math.max(count, 1);
  const pow = 10 ** Math.floor(Math.log10(rough));
  const err = rough / pow;
  let step = pow;
  if (err >= 5) step = 5 * pow;
  else if (err >= 2) step = 2 * pow;
  else step = pow;

  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.5; v += step) {
    if (v < min - step * 1e-6 || v > max + step * 1e-6) continue;
    ticks.push(Number(v.toPrecision(12)));
    if (ticks.length > 24) break;
  }
  if (ticks.length === 0) {
    ticks.push(min, max);
  }
  return ticks;
}

function buildChannelPath(
  frames: ChannelKeyframe[],
  easing: CubicBezier,
  channel: GraphChannelDef,
  view: GraphViewport,
  lane: LaneLayout,
): string {
  if (!frames || frames.length === 0) return "";
  const parts: string[] = [];
  const tSpan = Math.max(view.t1 - view.t0, 1e-6);
  const samples = Math.max(
    40,
    Math.round(GRAPH_SAMPLE_COUNT * clamp(1 / tSpan, 1, 6)),
  );
  for (let i = 0; i <= samples; i += 1) {
    const t = view.t0 + (i / samples) * tSpan;
    const value = sampleChannelValue(frames, t, easing, channel.min);
    const x = graphTToX(t, view);
    const y = graphValueToY(value, channel, view, lane);
    parts.push(`${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return parts.join(" ");
}

function visiblePanelLabel(x: number): string {
  const panel = clamp(Math.round(-x / STAGE_WIDTH), 0, 3);
  return ["A", "A↻", "B↻", "B"][panel] ?? "?";
}

function summarizeChannels(tracks: ChannelTracks): string {
  return `x${tracks.x.length} y${tracks.y.length} s${tracks.scale.length} br${tracks.brightness.length}`;
}

export function VideoTransitionPlayground() {
  const videoARef = useRef<HTMLVideoElement | null>(null);
  const videoBRef = useRef<HTMLVideoElement | null>(null);
  const mirrorACanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mirrorBCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const mirrorRafRef = useRef<number | null>(null);
  const mirrorVfcARef = useRef<number | null>(null);
  const mirrorVfcBRef = useRef<number | null>(null);
  const playStartedAtRef = useRef(0);
  const playStartedTRef = useRef(0);
  const playheadTRef = useRef(0);
  const channelsRef = useRef<ChannelTracks>(defaultChannelTracks());
  const durationMsRef = useRef(DEFAULT_DURATION_MS);
  const motionFxRef = useRef<MotionFxSettings>(defaultMotionFx());
  const easingRef = useRef<CubicBezier>(defaultEasing());
  /** Base keyframed pose without procedural blur (for editing/export). */
  const basePoseRef = useRef<StripProps>(
    sampleChannelTracks(defaultChannelTracks(), 0, defaultEasing()),
  );
  const curveSvgRef = useRef<SVGSVGElement | null>(null);
  const dragHandleRef = useRef<"p1" | "p2" | null>(null);
  const graphSvgRef = useRef<SVGSVGElement | null>(null);
  const graphDragRef = useRef<GraphDragState | null>(null);
  const graphPanRef = useRef<GraphPanState | null>(null);
  const graphPointerIdRef = useRef<number | null>(null);
  const graphViewportRef = useRef<GraphViewport>(cloneViewport(DEFAULT_GRAPH_VIEWPORT));
  const graphLanesRef = useRef<LaneLayout[]>([]);

  const [cards, setCards] = useState<TransitionCard[]>([]);
  const [cardAId, setCardAId] = useState("");
  const [cardBId, setCardBId] = useState("");
  const [durationMs, setDurationMs] = useState(DEFAULT_DURATION_MS);
  const [durationInput, setDurationInput] = useState(String(DEFAULT_DURATION_MS));
  const [playheadT, setPlayheadT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [channels, setChannels] = useState<ChannelTracks>(() =>
    defaultChannelTracks(),
  );
  /** Selected key index within the active graph channel track. */
  const [selectedKeyframeIndex, setSelectedKeyframeIndex] = useState(0);
  const [basePose, setBasePose] = useState<StripProps>(() =>
    sampleChannelTracks(defaultChannelTracks(), 0, defaultEasing()),
  );
  const [pose, setPose] = useState<StripProps>(() =>
    sampleChannelTracks(defaultChannelTracks(), 0, defaultEasing()),
  );
  const [motionFx, setMotionFx] = useState<MotionFxSettings>(() => defaultMotionFx());
  const [easing, setEasing] = useState<CubicBezier>(() => defaultEasing());
  const [status, setStatus] = useState("Loading cards…");
  const [importText, setImportText] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [activeTemplateId, setActiveTemplateId] = useState(DEFAULT_TEMPLATE_ID);
  const [graphVisibility, setGraphVisibility] = useState<GraphVisibility>(
    () => ({ ...DEFAULT_GRAPH_VISIBILITY }),
  );
  const [activeGraphChannel, setActiveGraphChannel] =
    useState<GraphChannelKey>("x");
  /** When set, only that channel lane is shown/editable. */
  const [isolatedChannel, setIsolatedChannel] = useState<GraphChannelKey | null>(
    null,
  );
  const [showFxOnGraph, setShowFxOnGraph] = useState(false);
  const [graphViewport, setGraphViewport] = useState<GraphViewport>(() =>
    cloneViewport(DEFAULT_GRAPH_VIEWPORT),
  );

  useEffect(() => {
    playheadTRef.current = playheadT;
  }, [playheadT]);

  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);

  useEffect(() => {
    durationMsRef.current = durationMs;
  }, [durationMs]);

  useEffect(() => {
    motionFxRef.current = motionFx;
  }, [motionFx]);

  useEffect(() => {
    easingRef.current = easing;
  }, [easing]);

  useEffect(() => {
    basePoseRef.current = basePose;
  }, [basePose]);

  useEffect(() => {
    graphViewportRef.current = graphViewport;
  }, [graphViewport]);

  useEffect(() => {
    setDurationInput(String(durationMs));
  }, [durationMs]);

  const cardA = useMemo(
    () => cards.find((card) => card.id === cardAId) ?? null,
    [cards, cardAId],
  );
  const cardB = useMemo(
    () => cards.find((card) => card.id === cardBId) ?? null,
    [cards, cardBId],
  );

  const visibleGraphKeys = useMemo(() => {
    if (isolatedChannel) return [isolatedChannel];
    return GRAPH_CHANNELS.map((channel) => channel.key).filter(
      (key) => graphVisibility[key],
    );
  }, [graphVisibility, isolatedChannel]);

  const graphLanes = useMemo(
    () => buildLaneLayouts(visibleGraphKeys),
    [visibleGraphKeys],
  );

  useEffect(() => {
    graphLanesRef.current = graphLanes;
  }, [graphLanes]);

  const activeChannelFrames = useMemo(
    () => sortChannelKeyframes(channels[activeGraphChannel] ?? []),
    [channels, activeGraphChannel],
  );

  /** Combined marker times across visible transform channels. */
  const markerTimes = useMemo(() => {
    const times = new Set<number>();
    for (const key of visibleGraphKeys) {
      for (const frame of channels[key] ?? []) times.add(frame.t);
    }
    // Always include blur/opacity endpoints lightly? no — keep transform-focused.
    if (times.size === 0) {
      times.add(0);
      times.add(1);
    }
    return [...times].sort((a, b) => a - b);
  }, [channels, visibleGraphKeys]);

  const curvePath = useMemo(() => {
    const parts: string[] = [];
    const samples = 48;
    for (let i = 0; i <= samples; i += 1) {
      const x = i / samples;
      const y = sampleCubicBezier(easing, x);
      const px = x * 100;
      const py = (1 - y) * 100;
      parts.push(`${i === 0 ? "M" : "L"} ${px.toFixed(2)} ${py.toFixed(2)}`);
    }
    return parts.join(" ");
  }, [easing]);

  const graphChannelPaths = useMemo(() => {
    const paths = {} as Record<GraphChannelKey, string>;
    for (const lane of graphLanes) {
      paths[lane.key] = buildChannelPath(
        channels[lane.key] ?? [],
        easing,
        lane.channel,
        graphViewport,
        lane,
      );
    }
    return paths;
  }, [channels, easing, graphViewport, graphLanes]);

  /** Optional overlay of final scale after procedural motion FX. */
  const graphFxScalePath = useMemo(() => {
    if (!showFxOnGraph || !motionFx.enabled) return "";
    const lane = graphLanes.find((entry) => entry.key === "scale");
    if (!lane) return "";
    const parts: string[] = [];
    const tSpan = Math.max(graphViewport.t1 - graphViewport.t0, 1e-6);
    const samples = Math.max(
      40,
      Math.round(GRAPH_SAMPLE_COUNT * clamp(1 / tSpan, 1, 6)),
    );
    for (let i = 0; i <= samples; i += 1) {
      const t = graphViewport.t0 + (i / samples) * tSpan;
      const base = sampleChannelTracks(channels, t, easing);
      const live = applyMotionFx(base, t, motionFx);
      const x = graphTToX(t, graphViewport);
      const y = graphValueToY(live.scale, lane.channel, graphViewport, lane);
      parts.push(`${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`);
    }
    return parts.join(" ");
  }, [showFxOnGraph, motionFx, channels, easing, graphViewport, graphLanes]);

  const graphPlayheadValues = useMemo(() => {
    const values = {} as Record<GraphChannelKey, number>;
    for (const channel of GRAPH_CHANNELS) {
      values[channel.key] = basePose[channel.key];
    }
    return values;
  }, [basePose]);

  const graphTimeTicks = useMemo(
    () => buildNiceTicks(graphViewport.t0, graphViewport.t1, 6),
    [graphViewport.t0, graphViewport.t1],
  );

  const graphValueTicksByChannel = useMemo(() => {
    const ticks = {} as Record<GraphChannelKey, number[]>;
    for (const channel of GRAPH_CHANNELS) {
      const win = graphViewport.values[channel.key];
      const min = normToValue(win.n0, channel);
      const max = normToValue(win.n1, channel);
      ticks[channel.key] = buildNiceTicks(min, max, 4);
    }
    return ticks;
  }, [graphViewport]);

  const graphZoomLabel = useMemo(() => {
    const zT = viewportZoomT(graphViewport);
    const zN = viewportZoomN(graphViewport, activeGraphChannel);
    return `${roundValue(zT, 1)}×t · ${roundValue(zN, 1)}×${activeGraphChannel}`;
  }, [graphViewport, activeGraphChannel]);

  const isGraphZoomed = useMemo(() => {
    if (Math.abs(graphViewport.t0) > 1e-6 || Math.abs(graphViewport.t1 - 1) > 1e-6) {
      return true;
    }
    for (const key of GRAPH_CHANNELS.map((c) => c.key)) {
      const win = graphViewport.values[key];
      if (Math.abs(win.n0) > 1e-6 || Math.abs(win.n1 - 1) > 1e-6) return true;
    }
    return false;
  }, [graphViewport]);

  const graphSvgHeight = graphHeight(Math.max(1, graphLanes.length));

  const updateGraphViewport = useCallback((nextRaw: GraphViewport) => {
    const next = sanitizeViewport(nextRaw);
    graphViewportRef.current = next;
    setGraphViewport(next);
  }, []);

  const resetGraphViewport = useCallback(() => {
    updateGraphViewport(cloneViewport(DEFAULT_GRAPH_VIEWPORT));
  }, [updateGraphViewport]);

  const zoomGraphBy = useCallback(
    (
      factor: number,
      opts?: {
        anchorT?: number;
        anchorN?: number;
        time?: boolean;
        value?: boolean;
        channel?: GraphChannelKey | null;
      },
    ) => {
      const view = graphViewportRef.current;
      const channel = opts?.channel === undefined ? activeGraphChannel : opts.channel;
      const win = channel ? view.values[channel] : { n0: 0, n1: 1 };
      const anchorT = opts?.anchorT ?? (view.t0 + view.t1) / 2;
      const anchorN = opts?.anchorN ?? (win.n0 + win.n1) / 2;
      updateGraphViewport(
        zoomViewportAt(view, factor, anchorT, anchorN, channel, {
          time: opts?.time,
          value: opts?.value,
        }),
      );
    },
    [activeGraphChannel, updateGraphViewport],
  );

  const focusGraphOnPlayhead = useCallback(() => {
    const view = graphViewportRef.current;
    const channelKey = activeGraphChannel;
    const win = view.values[channelKey];
    const spanT = Math.max(view.t1 - view.t0, GRAPH_ZOOM_MIN_SPAN_T);
    const spanN = Math.max(win.n1 - win.n0, GRAPH_ZOOM_MIN_SPAN_N);
    const t = clamp(playheadTRef.current, 0, 1);
    const channel = getGraphChannel(channelKey);
    const n = clamp(valueToNorm(basePoseRef.current[channel.key], channel), 0, 1);
    const nextSpanT = spanT >= 0.999 ? 0.25 : spanT;
    const nextSpanN = spanN >= 0.999 ? 0.35 : spanN;
    let t0 = t - nextSpanT / 2;
    let t1 = t0 + nextSpanT;
    if (t0 < 0) {
      t0 = 0;
      t1 = nextSpanT;
    } else if (t1 > 1) {
      t1 = 1;
      t0 = 1 - nextSpanT;
    }
    let n0 = n - nextSpanN / 2;
    let n1 = n0 + nextSpanN;
    if (n0 < 0) {
      n0 = 0;
      n1 = nextSpanN;
    } else if (n1 > 1) {
      n1 = 1;
      n0 = 1 - nextSpanN;
    }
    const next = cloneViewport(view);
    next.t0 = t0;
    next.t1 = t1;
    next.values[channelKey] = { n0, n1 };
    updateGraphViewport(next);
  }, [activeGraphChannel, updateGraphViewport]);

  const isolateChannel = useCallback((key: GraphChannelKey) => {
    setIsolatedChannel((current) => {
      if (current === key) {
        setStatus(`Exited ${key.toUpperCase()} isolation`);
        return null;
      }
      setActiveGraphChannel(key);
      setGraphVisibility((prev) => ({ ...prev, [key]: true }));
      setStatus(`Isolated ${key.toUpperCase()} — double-click chip again to show all`);
      return key;
    });
  }, []);

  const applySampledPose = useCallback(
    (
      t: number,
      tracks?: ChannelTracks,
      fx?: MotionFxSettings,
      ease?: CubicBezier,
    ) => {
      const curve = ease ?? easingRef.current;
      const source = tracks ?? channelsRef.current;
      const base = sampleChannelTracks(source, t, curve);
      const settings = fx ?? motionFxRef.current;
      basePoseRef.current = base;
      setBasePose(base);
      setPose(applyMotionFx(base, t, settings));
    },
    [],
  );

  const commitChannels = useCallback(
    (
      nextTracks: ChannelTracks,
      opts?: {
        t?: number;
        selectChannel?: GraphChannelKey;
        selectIndex?: number;
        statusText?: string;
      },
    ) => {
      const next = cloneChannelTracks(nextTracks);
      channelsRef.current = next;
      setChannels(next);
      setActiveTemplateId("");
      if (opts?.selectChannel) setActiveGraphChannel(opts.selectChannel);
      if (opts?.selectIndex !== undefined) {
        setSelectedKeyframeIndex(opts.selectIndex);
      }
      const t = opts?.t ?? playheadTRef.current;
      setPlayheadT(t);
      playheadTRef.current = t;
      applySampledPose(t, next);
      if (opts?.statusText) setStatus(opts.statusText);
    },
    [applySampledPose],
  );

  const loadCards = useCallback(async () => {
    setStatus("Loading cards…");
    const nextCards = await loadTransitionCards();
    setCards(nextCards);
    if (nextCards.length < 2) {
      setCardAId(nextCards[0]?.id ?? "");
      setCardBId("");
      setStatus(
        nextCards.length === 0
          ? "No cards found in /cards/index.json"
          : "Need at least two cards with bottom videos",
      );
      return;
    }

    const hasPreferredA = nextCards.some((card) => card.id === DEFAULT_CARD_A_ID);
    const hasPreferredB = nextCards.some((card) => card.id === DEFAULT_CARD_B_ID);
    const preferredA = hasPreferredA ? DEFAULT_CARD_A_ID : nextCards[0].id;
    const preferredB = hasPreferredB
      ? DEFAULT_CARD_B_ID
      : (nextCards.find((card) => card.id !== preferredA)?.id ?? nextCards[1].id);

    setCardAId((current) => {
      if (current && nextCards.some((card) => card.id === current)) return current;
      return preferredA;
    });
    setCardBId((current) => {
      if (
        current &&
        current !== preferredA &&
        nextCards.some((card) => card.id === current)
      ) {
        return current;
      }
      if (preferredB !== preferredA) return preferredB;
      return (
        nextCards.find((card) => card.id !== preferredA)?.id ?? nextCards[1].id
      );
    });
    setStatus(`${nextCards.length} cards loaded · single strip`);
  }, []);

  useEffect(() => {
    void loadCards();
  }, [loadCards]);

  useEffect(() => {
    const videoA = videoARef.current;
    const videoB = videoBRef.current;
    if (!videoA || !videoB) return;

    let cancelled = false;

    const run = async () => {
      if (!cardA || !cardB) return;
      setStatus(`Loading ${cardA.label} → ${cardB.label}…`);
      try {
        // Only two decoders total. Mirrors are canvas clones.
        await Promise.all([
          loadLoopingVideo(videoA, cardA.bottom),
          loadLoopingVideo(videoB, cardB.bottom),
        ]);
        if (!cancelled) {
          drawFlippedVideo(mirrorACanvasRef.current, videoA);
          drawFlippedVideo(mirrorBCanvasRef.current, videoB);
          setStatus(
            `${cardA.label} → ${cardB.label} · [A|A↻|B↻|B] · 2 decoders`,
          );
        }
      } catch (error) {
        if (!cancelled) {
          setStatus(
            error instanceof Error ? error.message : "Failed to load videos",
          );
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [cardA, cardB]);

  // Paint flipped mirrors from the two source videos (no extra decoders).
  useEffect(() => {
    const videoA = videoARef.current;
    const videoB = videoBRef.current;
    if (!videoA || !videoB) return;

    let stopped = false;

    const paint = () => {
      if (stopped) return;
      drawFlippedVideo(mirrorACanvasRef.current, videoA);
      drawFlippedVideo(mirrorBCanvasRef.current, videoB);
    };

    type VideoWithVFC = HTMLVideoElement & {
      requestVideoFrameCallback?: (
        cb: (now: number, metadata: unknown) => void,
      ) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };

    const attachVfc = (
      video: VideoWithVFC,
      store: { current: number | null },
    ) => {
      if (typeof video.requestVideoFrameCallback !== "function") return false;
      const tick = () => {
        if (stopped) return;
        paint();
        store.current = video.requestVideoFrameCallback?.(tick) ?? null;
      };
      store.current = video.requestVideoFrameCallback(tick);
      return true;
    };

    const usedVfcA = attachVfc(videoA as VideoWithVFC, mirrorVfcARef);
    const usedVfcB = attachVfc(videoB as VideoWithVFC, mirrorVfcBRef);

    if (!usedVfcA || !usedVfcB) {
      const loop = () => {
        if (stopped) return;
        paint();
        mirrorRafRef.current = requestAnimationFrame(loop);
      };
      mirrorRafRef.current = requestAnimationFrame(loop);
    } else {
      paint();
    }

    return () => {
      stopped = true;
      if (mirrorRafRef.current !== null) {
        cancelAnimationFrame(mirrorRafRef.current);
        mirrorRafRef.current = null;
      }
      const a = videoA as VideoWithVFC;
      const b = videoB as VideoWithVFC;
      if (
        mirrorVfcARef.current !== null &&
        typeof a.cancelVideoFrameCallback === "function"
      ) {
        a.cancelVideoFrameCallback(mirrorVfcARef.current);
      }
      if (
        mirrorVfcBRef.current !== null &&
        typeof b.cancelVideoFrameCallback === "function"
      ) {
        b.cancelVideoFrameCallback(mirrorVfcBRef.current);
      }
      mirrorVfcARef.current = null;
      mirrorVfcBRef.current = null;
    };
  }, [cardA, cardB]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
      if (mirrorRafRef.current !== null) {
        cancelAnimationFrame(mirrorRafRef.current);
      }
      releaseMediaElement(videoARef.current);
      releaseMediaElement(videoBRef.current);
    };
  }, []);

  useEffect(() => {
    if (!playing) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    playStartedAtRef.current = performance.now();
    playStartedTRef.current = playheadTRef.current;

    const tick = (now: number) => {
      const elapsed = now - playStartedAtRef.current;
      const deltaT = elapsed / Math.max(durationMsRef.current, 1);
      const nextT = clamp(playStartedTRef.current + deltaT, 0, 1);
      setPlayheadT(nextT);
      applySampledPose(nextT, channelsRef.current);
      if (nextT >= 1) {
        setPlaying(false);
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [playing, applySampledPose]);

  const setPlayhead = (nextT: number, opts?: { sample?: boolean }) => {
    const t = clamp(nextT, 0, 1);
    setPlayheadT(t);
    playheadTRef.current = t;
    if (opts?.sample !== false) {
      applySampledPose(t, channels);
      const nearest = findNearestChannelKeyframeIndex(
        channels[activeGraphChannel] ?? [],
        t,
      );
      if (nearest >= 0) setSelectedKeyframeIndex(nearest);
    }
  };

  const updatePose = (next: StripProps) => {
    setPlaying(false);
    basePoseRef.current = next;
    setBasePose(next);
    // Manual slider edits stay clean (no shake baked into keyframes).
    setPose(next);
  };

  /** Add/update only the active channel at the playhead. */
  const addOrUpdateKeyframe = () => {
    setPlaying(false);
    const channel = activeGraphChannel;
    const value = basePoseRef.current[channel];
    const result = setChannelKeyframe(
      channelsRef.current,
      channel,
      playheadT,
      value,
    );
    commitChannels(result.tracks, {
      t: result.t,
      selectChannel: channel,
      selectIndex: result.index,
      statusText: `Set ${channel} @ ${roundValue(result.t, 3)} = ${roundChannelValue(channel, value)}`,
    });
  };

  const updateSelectedKeyframe = () => {
    const frames = activeChannelFrames;
    if (selectedKeyframeIndex < 0 || selectedKeyframeIndex >= frames.length) {
      return;
    }
    setPlaying(false);
    const channel = activeGraphChannel;
    const selectedT = frames[selectedKeyframeIndex].t;
    const value = basePoseRef.current[channel];
    const result = moveChannelKeyframe(
      channelsRef.current,
      channel,
      selectedKeyframeIndex,
      selectedT,
      value,
    );
    commitChannels(result.tracks, {
      t: result.t,
      selectChannel: channel,
      selectIndex: result.index,
      statusText: `Updated ${channel} @ ${roundValue(selectedT, 3)}`,
    });
  };

  const deleteSelectedKeyframe = () => {
    const channel = activeGraphChannel;
    const frames = activeChannelFrames;
    if (frames.length <= 1) {
      setStatus(`Keep at least one ${channel} keyframe`);
      return;
    }
    if (selectedKeyframeIndex < 0 || selectedKeyframeIndex >= frames.length) {
      return;
    }
    setPlaying(false);
    const removedT = frames[selectedKeyframeIndex].t;
    const next = deleteChannelKeyframe(
      channelsRef.current,
      channel,
      selectedKeyframeIndex,
    );
    if (!next) {
      setStatus(`Keep at least one ${channel} keyframe`);
      return;
    }
    const nextFrames = next[channel] ?? [];
    const nextSelected = clamp(selectedKeyframeIndex, 0, nextFrames.length - 1);
    commitChannels(next, {
      selectChannel: channel,
      selectIndex: nextSelected,
      statusText: `Deleted ${channel} keyframe @ ${roundValue(removedT, 3)}`,
    });
  };

  const jumpToChannelKeyframe = (channel: GraphChannelKey, index: number) => {
    const frame = sortChannelKeyframes(channels[channel] ?? [])[index];
    if (!frame) return;
    setPlaying(false);
    setActiveGraphChannel(channel);
    setSelectedKeyframeIndex(index);
    setPlayheadT(frame.t);
    playheadTRef.current = frame.t;
    applySampledPose(frame.t, channels);
  };

  const clientToGraphPoint = useCallback((clientX: number, clientY: number) => {
    const svg = graphSvgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const height = graphHeight(Math.max(1, graphLanesRef.current.length));
    const x = ((clientX - rect.left) / rect.width) * GRAPH_VIEW.width;
    const y = ((clientY - rect.top) / rect.height) * height;
    return { x, y };
  }, []);

  const commitGraphChannelKeyframe = useCallback(
    (
      channel: GraphChannelKey,
      index: number,
      nextT: number,
      nextValue: number,
      opts?: { statusText?: string },
    ): number => {
      const result = moveChannelKeyframe(
        channelsRef.current,
        channel,
        index,
        nextT,
        nextValue,
      );
      commitChannels(result.tracks, {
        t: result.t,
        selectChannel: channel,
        selectIndex: result.index,
        statusText: opts?.statusText,
      });
      return result.index;
    },
    [commitChannels],
  );

  const addGraphKeyframeAt = useCallback(
    (tRaw: number, channel: GraphChannelKey, value: number) => {
      setPlaying(false);
      const result = setChannelKeyframe(
        channelsRef.current,
        channel,
        tRaw,
        value,
      );
      commitChannels(result.tracks, {
        t: result.t,
        selectChannel: channel,
        selectIndex: result.index,
        statusText: `Added ${channel} @ ${roundValue(result.t, 3)} = ${roundChannelValue(channel, value)}`,
      });
    },
    [commitChannels],
  );

  const beginGraphHandleDrag = useCallback(
    (
      event: ReactPointerEvent<SVGCircleElement>,
      index: number,
      channel: GraphChannelKey,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      const frames = channelsRef.current[channel] ?? [];
      if (!frames[index]) return;
      setPlaying(false);
      graphPanRef.current = null;
      setActiveGraphChannel(channel);
      setSelectedKeyframeIndex(index);
      graphDragRef.current = {
        index,
        channel,
        moved: false,
      };
      graphPointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [],
  );

  const beginGraphPan = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>, channel: GraphChannelKey | null) => {
      if (event.button !== 1 && !(event.button === 0 && event.altKey)) return;
      event.preventDefault();
      event.stopPropagation();
      graphDragRef.current = null;
      graphPanRef.current = {
        channel,
        startClientX: event.clientX,
        startClientY: event.clientY,
        origin: cloneViewport(graphViewportRef.current),
      };
      graphPointerIdRef.current = event.pointerId;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [],
  );

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const pan = graphPanRef.current;
      if (pan) {
        const svg = graphSvgRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const height = graphHeight(Math.max(1, graphLanesRef.current.length));
        const dxPx = event.clientX - pan.startClientX;
        const dyPx = event.clientY - pan.startClientY;
        const dxSvg = (dxPx / rect.width) * GRAPH_VIEW.width;
        const dySvg = (dyPx / rect.height) * height;
        const origin = pan.origin;
        const spanT = origin.t1 - origin.t0;
        const channel = pan.channel;
        const win = channel ? origin.values[channel] : { n0: 0, n1: 1 };
        const spanN = win.n1 - win.n0;
        const lane = channel
          ? graphLanesRef.current.find((entry) => entry.key === channel)
          : graphLanesRef.current[0];
        const plotH = lane?.plotH ?? GRAPH_VIEW.laneH;
        const dT = -(dxSvg / Math.max(GRAPH_PLOT_W, 1)) * spanT;
        const dN = (dySvg / Math.max(plotH, 1)) * spanN;
        updateGraphViewport(panViewport(origin, dT, dN, channel));
        return;
      }

      const drag = graphDragRef.current;
      if (!drag) return;
      const point = clientToGraphPoint(event.clientX, event.clientY);
      if (!point) return;
      const lane =
        graphLanesRef.current.find((entry) => entry.key === drag.channel) ??
        hitTestLane(point.y, graphLanesRef.current);
      if (!lane) return;
      drag.moved = true;
      const view = graphViewportRef.current;
      const channel = getGraphChannel(drag.channel);
      const nextT = clamp(graphXToT(point.x, view), 0, 1);
      const nextValue = graphYToValue(point.y, channel, view, lane);
      drag.index = commitGraphChannelKeyframe(
        drag.channel,
        drag.index,
        nextT,
        nextValue,
      );
    };

    const onUp = () => {
      if (graphPanRef.current) {
        graphPanRef.current = null;
        graphPointerIdRef.current = null;
        return;
      }
      const drag = graphDragRef.current;
      if (!drag) return;
      graphDragRef.current = null;
      graphPointerIdRef.current = null;
      if (drag.moved) {
        setStatus(
          `Moved ${drag.channel} keyframe → t=${roundValue(playheadTRef.current, 3)}`,
        );
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [clientToGraphPoint, commitGraphChannelKeyframe, updateGraphViewport]);

  // Wheel zoom on the graph (prevent page scroll while hovering).
  useEffect(() => {
    const svg = graphSvgRef.current;
    if (!svg) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = clientToGraphPoint(event.clientX, event.clientY);
      const view = graphViewportRef.current;
      const lane = point
        ? hitTestLane(point.y, graphLanesRef.current)
        : graphLanesRef.current.find((entry) => entry.key === activeGraphChannel) ??
          graphLanesRef.current[0];
      const channelKey = lane?.key ?? activeGraphChannel;
      if (lane) setActiveGraphChannel(channelKey);
      const channel = getGraphChannel(channelKey);
      const win = view.values[channelKey];
      const anchorT = point
        ? clamp(graphXToT(point.x, view), 0, 1)
        : (view.t0 + view.t1) / 2;
      const anchorN = point && lane
        ? clamp(
            valueToNorm(graphYToValue(point.y, channel, view, lane), channel),
            0,
            1,
          )
        : (win.n0 + win.n1) / 2;

      const timeOnly = event.shiftKey && !event.altKey;
      const valueOnly = event.altKey && !event.shiftKey;
      const factor = event.deltaY > 0 ? 1.12 : 1 / 1.12;
      updateGraphViewport(
        zoomViewportAt(view, factor, anchorT, anchorN, channelKey, {
          time: !valueOnly,
          value: !timeOnly,
        }),
      );
    };

    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      svg.removeEventListener("wheel", onWheel);
    };
  }, [activeGraphChannel, clientToGraphPoint, updateGraphViewport]);

  const buildPreset = (): TransitionPreset => {
    const nextChannels = cloneChannelTracks(channels);
    return {
      version: 3,
      pattern: "mirror-slide-strip",
      durationMs: sanitizeDurationMs(durationMs),
      cardAId,
      cardBId,
      stageWidth: STAGE_WIDTH,
      easing: sanitizeEasing(easing),
      motionFx: {
        enabled: motionFx.enabled,
        blurPeak: motionFx.blurPeak,
        blur: { ...motionFx.blur },
        scalePeak: motionFx.scalePeak,
        scale: { ...motionFx.scale },
      },
      channels: nextChannels,
      keyframes: channelsToStripKeyframes(nextChannels),
    };
  };

  const copyJson = async () => {
    const json = JSON.stringify(buildPreset(), null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setCopyState("copied");
      setStatus("Copied transition JSON");
      setImportText(json);
      window.setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("error");
      setImportText(json);
      setStatus("Clipboard failed — JSON placed in import box");
    }
  };

  const applyPreset = useCallback(
    (
      presetRaw: TransitionPreset,
      opts?: { templateId?: string | null; statusText?: string },
    ) => {
      const preset = clonePreset(presetRaw);
      const nextFx = preset.motionFx ?? defaultMotionFx();
      const nextEase = preset.easing ?? defaultEasing();
      const nextChannels = cloneChannelTracks(
        preset.channels ?? stripKeyframesToChannels(preset.keyframes),
      );

      setPlaying(false);
      setDurationMs(preset.durationMs);
      setDurationInput(String(preset.durationMs));
      channelsRef.current = nextChannels;
      setChannels(nextChannels);
      setMotionFx(nextFx);
      motionFxRef.current = nextFx;
      setEasing(nextEase);
      easingRef.current = nextEase;
      setSelectedKeyframeIndex(0);
      setActiveGraphChannel("x");
      setIsolatedChannel(null);
      setPlayheadT(0);
      playheadTRef.current = 0;

      if (cards.some((card) => card.id === preset.cardAId)) {
        setCardAId(preset.cardAId);
      }
      if (
        cards.some((card) => card.id === preset.cardBId) &&
        preset.cardBId !== preset.cardAId
      ) {
        setCardBId(preset.cardBId);
      }

      if (opts?.templateId !== undefined) {
        setActiveTemplateId(opts.templateId ?? "");
      }

      applySampledPose(0, nextChannels, nextFx, nextEase);
      setStatus(
        opts?.statusText ??
          `Loaded preset (${preset.durationMs}ms, ${summarizeChannels(nextChannels)})`,
      );
    },
    [applySampledPose, cards],
  );

  const applyTemplate = useCallback(
    (templateId: string) => {
      const template = getTemplate(templateId);
      if (!template) {
        setStatus(`Unknown template: ${templateId}`);
        return;
      }
      applyPreset(template.preset, {
        templateId: template.id,
        statusText: `Loaded template “${template.label}”`,
      });
    },
    [applyPreset],
  );

  const importJson = () => {
    try {
      const parsed = parsePreset(JSON.parse(importText));
      if (!parsed) {
        setStatus("Invalid transition JSON");
        return;
      }
      applyPreset(parsed, {
        templateId: null,
        statusText: `Imported ${summarizeChannels(parsed.channels ?? defaultChannelTracks())} (${parsed.durationMs}ms)`,
      });
    } catch {
      setStatus("Could not parse JSON");
    }
  };

  const resetDefaults = () => {
    applyTemplate(DEFAULT_TEMPLATE_ID);
  };

  const snapX = (value: number) => {
    updatePose({ ...basePose, x: value });
  };

  const patchMotionFx = (patch: Partial<MotionFxSettings>) => {
    const next = { ...motionFx, ...patch };
    setMotionFx(next);
    motionFxRef.current = next;
    applySampledPose(playheadT, channels, next);
  };

  const patchFxChannelWindow = (
    channel: "blur" | "scale",
    patch: Partial<FxWindow>,
  ) => {
    const current = motionFx[channel];
    let startPct = patch.startPct ?? current.startPct;
    let stopPct = patch.stopPct ?? current.stopPct;
    startPct = clamp(startPct, 0, 100);
    stopPct = clamp(stopPct, 0, 100);
    if (patch.startPct !== undefined) stopPct = Math.max(stopPct, startPct);
    if (patch.stopPct !== undefined) startPct = Math.min(startPct, stopPct);
    patchMotionFx({
      [channel]: { startPct, stopPct },
    } as Partial<MotionFxSettings>);
  };

  const updateEasing = useCallback(
    (nextRaw: CubicBezier) => {
      const next = sanitizeEasing(nextRaw);
      setEasing(next);
      easingRef.current = next;
      applySampledPose(
        playheadTRef.current,
        channelsRef.current,
        motionFxRef.current,
        next,
      );
    },
    [applySampledPose],
  );

  useEffect(() => {
    const clientToCurve = (clientX: number, clientY: number) => {
      const svg = curveSvgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const x = clamp((clientX - rect.left) / rect.width, 0, 1);
      // Allow overshoot on Y so ease handles can go above/below.
      const y = 1 - (clientY - rect.top) / rect.height;
      return { x, y: clamp(y, -0.5, 1.5) };
    };

    const onMove = (event: PointerEvent) => {
      const handle = dragHandleRef.current;
      if (!handle) return;
      const point = clientToCurve(event.clientX, event.clientY);
      if (!point) return;
      const current = easingRef.current;
      if (handle === "p1") {
        updateEasing({ ...current, x1: point.x, y1: point.y });
      } else {
        updateEasing({ ...current, x2: point.x, y2: point.y });
      }
    };
    const onUp = () => {
      dragHandleRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [updateEasing]);

  const playheadMs = playheadT * durationMs;
  const nearExisting =
    findNearestChannelKeyframeIndex(activeChannelFrames, playheadT) >= 0;
  const easedPlayhead = sampleCubicBezier(easing, playheadT);

  return (
    <main className="transition-lab-page">
      <div className="transition-lab">
        <section className="transition-lab-main">
          <header className="transition-lab-header">
            <div>
              <p className="transition-lab-kicker">
                Desktop lab · single strip
                {activeTemplateId
                  ? ` · template: ${getTemplate(activeTemplateId)?.label ?? activeTemplateId}`
                  : ""}
              </p>
              <h1>Video transition</h1>
              <p className="transition-lab-pattern">
                [A | A↻ | B↻ | B] · stage {STAGE_WIDTH}px · strip {STRIP_WIDTH}px
              </p>
            </div>
            <p className="transition-lab-status">{status}</p>
          </header>

          <div className="transition-lab-stage-wrap">
            <div
              className="transition-lab-stage"
              style={{ aspectRatio: `${STAGE_WIDTH} / ${STAGE_HEIGHT}` }}
            >
              <div
                className="transition-lab-fx-layer"
                style={fxLayerStyle(pose)}
              >
                <div
                  className="transition-lab-strip"
                  style={stripTravelStyle(pose)}
                >
                  <div className="transition-lab-tile">
                    <video
                      ref={videoARef}
                      className="transition-lab-video"
                      muted
                      loop
                      playsInline
                      preload="auto"
                    />
                    <span className="transition-lab-tile-tag">A</span>
                  </div>
                  <div className="transition-lab-tile">
                    <canvas
                      ref={mirrorACanvasRef}
                      className="transition-lab-video transition-lab-mirror"
                    />
                    <span className="transition-lab-tile-tag">A↻</span>
                  </div>
                  <div className="transition-lab-tile">
                    <canvas
                      ref={mirrorBCanvasRef}
                      className="transition-lab-video transition-lab-mirror"
                    />
                    <span className="transition-lab-tile-tag">B↻</span>
                  </div>
                  <div className="transition-lab-tile">
                    <video
                      ref={videoBRef}
                      className="transition-lab-video"
                      muted
                      loop
                      playsInline
                      preload="auto"
                    />
                    <span className="transition-lab-tile-tag">B</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="transition-lab-timeline">
            <div className="transition-lab-transport">
              <button
                type="button"
                onClick={() => {
                  if (playing) {
                    setPlaying(false);
                    return;
                  }
                  if (playheadTRef.current >= 1) {
                    playheadTRef.current = 0;
                    setPlayhead(0);
                  }
                  setPlaying(true);
                }}
              >
                {playing ? "Pause" : "Play"}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setPlaying(false);
                  setPlayhead(0);
                }}
              >
                Stop
              </button>
              <span className="transition-lab-time">
                {formatTime(playheadMs)} / {formatTime(durationMs)}
              </span>
              <span className="transition-lab-time">t={roundValue(playheadT, 3)}</span>
              <span className="transition-lab-time">
                x={roundValue(pose.x, 0)} · s={roundValue(pose.scale, 3)} · br=
                {roundValue(pose.brightness, 2)} · blur=
                {roundValue(pose.blur, 1)} · {visiblePanelLabel(pose.x)} · eased=
                {roundValue(easedPlayhead, 3)}
              </span>
            </div>

            <div className="transition-lab-scrubber">
              <input
                type="range"
                min={0}
                max={1}
                step={0.001}
                value={playheadT}
                onChange={(event) => {
                  setPlaying(false);
                  setPlayhead(Number(event.target.value));
                }}
              />
              <div className="transition-lab-markers" aria-hidden="true">
                {markerTimes.map((t) => (
                  <button
                    key={`marker-${t}`}
                    type="button"
                    className="transition-lab-marker"
                    style={{ left: `${t * 100}%` }}
                    title={`t=${roundValue(t, 3)}`}
                    onClick={() => {
                      setPlaying(false);
                      setPlayhead(t);
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="transition-lab-graph">
              <div className="transition-lab-graph-toolbar">
                <div className="transition-lab-graph-title">
                  <strong>Transform graph</strong>
                  <span>
                    Independent X / Y / Scale / Bright tracks · double-click chip to isolate
                  </span>
                </div>
                <div className="transition-lab-graph-toggles">
                  {GRAPH_CHANNELS.map((channel) => {
                    const active = activeGraphChannel === channel.key;
                    const isolated = isolatedChannel === channel.key;
                    const visible =
                      isolatedChannel === null
                        ? graphVisibility[channel.key]
                        : isolated;
                    return (
                      <button
                        key={channel.key}
                        type="button"
                        className={[
                          "transition-lab-graph-chip",
                          active ? "is-active" : "",
                          isolated ? "is-isolated" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        style={
                          {
                            "--chip-color": channel.color,
                            opacity: visible ? 1 : 0.4,
                          } as CSSProperties
                        }
                        onClick={() => {
                          setActiveGraphChannel(channel.key);
                          if (isolatedChannel && isolatedChannel !== channel.key) {
                            setIsolatedChannel(channel.key);
                          }
                          setGraphVisibility((prev) => ({
                            ...prev,
                            [channel.key]: true,
                          }));
                          const nearest = findNearestChannelKeyframeIndex(
                            channels[channel.key] ?? [],
                            playheadT,
                          );
                          if (nearest >= 0) setSelectedKeyframeIndex(nearest);
                        }}
                        onDoubleClick={(event) => {
                          event.preventDefault();
                          isolateChannel(channel.key);
                        }}
                        title={`${channel.label} · click select · double-click isolate`}
                      >
                        <span
                          className="transition-lab-graph-swatch"
                          style={{ background: channel.color }}
                        />
                        {channel.label}
                        {isolated ? <strong>solo</strong> : null}
                        <em>
                          {roundValue(
                            graphPlayheadValues[channel.key],
                            channel.digits,
                          )}
                        </em>
                      </button>
                    );
                  })}
                  {isolatedChannel ? (
                    <button
                      type="button"
                      className="transition-lab-graph-chip"
                      onClick={() => {
                        setIsolatedChannel(null);
                        setStatus("Showing all channels");
                      }}
                    >
                      Show all
                    </button>
                  ) : null}
                  <label className="transition-lab-graph-fx-toggle">
                    <input
                      type="checkbox"
                      checked={showFxOnGraph}
                      onChange={(event) => setShowFxOnGraph(event.target.checked)}
                    />
                    FX scale
                  </label>
                </div>
              </div>

              <div className="transition-lab-graph-zoombar">
                <div className="transition-lab-graph-zoom-btns">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => zoomGraphBy(1 / 1.25)}
                    title="Zoom in"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => zoomGraphBy(1.25)}
                    title="Zoom out"
                  >
                    −
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => zoomGraphBy(1 / 1.25, { value: false })}
                    title="Zoom time only"
                  >
                    +T
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => zoomGraphBy(1 / 1.25, { time: false })}
                    title="Zoom value only (active channel)"
                  >
                    +V
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={focusGraphOnPlayhead}
                    title="Focus viewport on playhead / active value"
                  >
                    Focus
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={resetGraphViewport}
                    disabled={!isGraphZoomed}
                    title="Reset zoom"
                  >
                    Reset
                  </button>
                </div>
                <span className="transition-lab-graph-zoom-label">
                  {graphZoomLabel}
                  {" · t "}
                  {roundValue(graphViewport.t0, 3)}–{roundValue(graphViewport.t1, 3)}
                  {isolatedChannel ? ` · solo ${isolatedChannel.toUpperCase()}` : ""}
                </span>
              </div>

              <div
                className={
                  isGraphZoomed
                    ? "transition-lab-graph-editor is-zoomed"
                    : "transition-lab-graph-editor"
                }
              >
                <svg
                  ref={graphSvgRef}
                  className="transition-lab-graph-svg"
                  viewBox={`0 0 ${GRAPH_VIEW.width} ${graphSvgHeight}`}
                  preserveAspectRatio="none"
                  style={{ height: Math.max(160, graphLanes.length * 118) }}
                  onPointerDown={(event) => {
                    const point = clientToGraphPoint(event.clientX, event.clientY);
                    const lane = point
                      ? hitTestLane(point.y, graphLanes)
                      : null;
                    if (event.button === 1 || (event.button === 0 && event.altKey)) {
                      beginGraphPan(event, lane?.key ?? activeGraphChannel);
                      return;
                    }
                    if (event.target !== event.currentTarget) {
                      const target = event.target as Element;
                      if (target.closest(".transition-lab-graph-handle")) return;
                    }
                    if (!point) return;
                    if (lane) setActiveGraphChannel(lane.key);
                    setPlaying(false);
                    setPlayhead(clamp(graphXToT(point.x, graphViewport), 0, 1));
                  }}
                  onContextMenu={(event) => {
                    if (event.altKey) event.preventDefault();
                  }}
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    const point = clientToGraphPoint(event.clientX, event.clientY);
                    if (!point) return;
                    const lane =
                      hitTestLane(point.y, graphLanes) ??
                      graphLanes.find((entry) => entry.key === activeGraphChannel) ??
                      graphLanes[0];
                    if (!lane) return;
                    setActiveGraphChannel(lane.key);
                    const t = clamp(graphXToT(point.x, graphViewport), 0, 1);
                    const value = graphYToValue(
                      point.y,
                      lane.channel,
                      graphViewport,
                      lane,
                    );
                    addGraphKeyframeAt(t, lane.key, value);
                  }}
                >
                  <defs>
                    {graphLanes.map((lane) => (
                      <clipPath
                        key={`clip-${lane.key}`}
                        id={`transition-lab-graph-clip-${lane.key}`}
                      >
                        <rect
                          x={GRAPH_VIEW.padL}
                          y={lane.plotTop}
                          width={GRAPH_PLOT_W}
                          height={lane.plotH}
                        />
                      </clipPath>
                    ))}
                  </defs>

                  {graphLanes.map((lane) => {
                    const isActive = activeGraphChannel === lane.key;
                    const ticks = graphValueTicksByChannel[lane.key] ?? [];
                    const frames = sortChannelKeyframes(channels[lane.key] ?? []);
                    const zeroValue =
                      lane.key === "scale" || lane.key === "brightness" ? 1 : 0;
                    return (
                      <g key={`lane-${lane.key}`}>
                        <rect
                          className={
                            isActive
                              ? "transition-lab-graph-lane is-active"
                              : "transition-lab-graph-lane"
                          }
                          x={GRAPH_VIEW.padL - 4}
                          y={lane.top}
                          width={GRAPH_PLOT_W + 8}
                          height={lane.height}
                          rx={6}
                        />
                        <text
                          className="transition-lab-graph-lane-label"
                          x={10}
                          y={lane.top + 14}
                          fill={lane.channel.color}
                        >
                          {lane.channel.label}
                        </text>

                        {/* Time grid */}
                        {graphTimeTicks.map((t) => {
                          const x = graphTToX(t, graphViewport);
                          if (
                            x < GRAPH_VIEW.padL - 1 ||
                            x > GRAPH_VIEW.padL + GRAPH_PLOT_W + 1
                          ) {
                            return null;
                          }
                          return (
                            <line
                              key={`vgrid-${lane.key}-${t}`}
                              className="transition-lab-graph-grid"
                              x1={x}
                              y1={lane.plotTop}
                              x2={x}
                              y2={lane.plotTop + lane.plotH}
                            />
                          );
                        })}

                        {/* Value grid */}
                        {ticks.map((value) => {
                          const y = graphValueToY(
                            value,
                            lane.channel,
                            graphViewport,
                            lane,
                          );
                          if (
                            y < lane.plotTop - 1 ||
                            y > lane.plotTop + lane.plotH + 1
                          ) {
                            return null;
                          }
                          return (
                            <g key={`hgrid-${lane.key}-${value}`}>
                              <line
                                className="transition-lab-graph-grid"
                                x1={GRAPH_VIEW.padL}
                                y1={y}
                                x2={GRAPH_VIEW.padL + GRAPH_PLOT_W}
                                y2={y}
                              />
                              <text
                                className="transition-lab-graph-axis-label"
                                x={GRAPH_VIEW.padL - 8}
                                y={y + 3}
                                textAnchor="end"
                              >
                                {roundValue(value, lane.channel.digits)}
                              </text>
                            </g>
                          );
                        })}

                        <g clipPath={`url(#transition-lab-graph-clip-${lane.key})`}>
                          <line
                            className="transition-lab-graph-zero"
                            x1={GRAPH_VIEW.padL}
                            y1={graphValueToY(
                              zeroValue,
                              lane.channel,
                              graphViewport,
                              lane,
                            )}
                            x2={GRAPH_VIEW.padL + GRAPH_PLOT_W}
                            y2={graphValueToY(
                              zeroValue,
                              lane.channel,
                              graphViewport,
                              lane,
                            )}
                          />

                          <path
                            className={
                              isActive
                                ? "transition-lab-graph-curve is-active"
                                : "transition-lab-graph-curve"
                            }
                            d={graphChannelPaths[lane.key] ?? ""}
                            stroke={lane.channel.color}
                            fill="none"
                            pointerEvents="none"
                          />

                          {lane.key === "scale" &&
                            showFxOnGraph &&
                            graphFxScalePath && (
                              <path
                                className="transition-lab-graph-curve-fx"
                                d={graphFxScalePath}
                                pointerEvents="none"
                              />
                            )}

                          {playheadT >= graphViewport.t0 &&
                            playheadT <= graphViewport.t1 && (
                              <>
                                <line
                                  className="transition-lab-graph-playhead"
                                  x1={graphTToX(playheadT, graphViewport)}
                                  y1={lane.plotTop}
                                  x2={graphTToX(playheadT, graphViewport)}
                                  y2={lane.plotTop + lane.plotH}
                                />
                                <circle
                                  className="transition-lab-graph-live"
                                  cx={graphTToX(playheadT, graphViewport)}
                                  cy={graphValueToY(
                                    graphPlayheadValues[lane.key],
                                    lane.channel,
                                    graphViewport,
                                    lane,
                                  )}
                                  r={isActive ? 4 : 3}
                                  fill={lane.channel.color}
                                  pointerEvents="none"
                                />
                              </>
                            )}

                          {frames.map((frame, index) => {
                            if (
                              frame.t < graphViewport.t0 - 1e-6 ||
                              frame.t > graphViewport.t1 + 1e-6
                            ) {
                              return null;
                            }
                            const selected =
                              isActive && index === selectedKeyframeIndex;
                            const cx = graphTToX(frame.t, graphViewport);
                            const cy = graphValueToY(
                              frame.value,
                              lane.channel,
                              graphViewport,
                              lane,
                            );
                            if (
                              cy < lane.plotTop - 8 ||
                              cy > lane.plotTop + lane.plotH + 8
                            ) {
                              return null;
                            }
                            return (
                              <circle
                                key={`handle-${lane.key}-${index}-${frame.t}`}
                                className={
                                  selected
                                    ? "transition-lab-graph-handle is-active"
                                    : "transition-lab-graph-handle"
                                }
                                cx={cx}
                                cy={cy}
                                r={selected ? 7 : 5.5}
                                fill={lane.channel.color}
                                onPointerDown={(event) =>
                                  beginGraphHandleDrag(event, index, lane.key)
                                }
                                onClick={(event) => {
                                  event.stopPropagation();
                                  jumpToChannelKeyframe(lane.key, index);
                                }}
                              >
                                <title>
                                  {`${lane.channel.label} @ t=${roundValue(frame.t, 3)} · ${roundValue(
                                    frame.value,
                                    lane.channel.digits,
                                  )}`}
                                </title>
                              </circle>
                            );
                          })}
                        </g>
                      </g>
                    );
                  })}

                  {/* Shared time labels under last lane */}
                  {graphLanes.length > 0 &&
                    graphTimeTicks.map((t) => {
                      const x = graphTToX(t, graphViewport);
                      if (
                        x < GRAPH_VIEW.padL - 1 ||
                        x > GRAPH_VIEW.padL + GRAPH_PLOT_W + 1
                      ) {
                        return null;
                      }
                      const last = graphLanes[graphLanes.length - 1];
                      return (
                        <text
                          key={`tlabel-${t}`}
                          className="transition-lab-graph-axis-label"
                          x={x}
                          y={last.top + last.height + 14}
                          textAnchor="middle"
                        >
                          {roundValue(
                            t,
                            t < 0.1 || graphViewport.t1 - graphViewport.t0 < 0.2
                              ? 3
                              : 2,
                          )}
                        </text>
                      );
                    })}
                </svg>
              </div>

              <div className="transition-lab-graph-help">
                <span>
                  Active:{" "}
                  <strong>{getGraphChannel(activeGraphChannel).label}</strong>
                  {isolatedChannel ? " (solo)" : ""}
                  {" · "}
                  double-click lane to add on that channel only · drag handles · wheel zoom
                </span>
                <div className="button-row">
                  <button type="button" onClick={addOrUpdateKeyframe}>
                    {nearExisting
                      ? `Update ${activeGraphChannel} @ playhead`
                      : `Add ${activeGraphChannel} @ playhead`}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={deleteSelectedKeyframe}
                    disabled={activeChannelFrames.length <= 1}
                  >
                    Delete selected
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <aside className="panel transition-lab-panel">
          <section className="transition-lab-section">
            <h3>Template</h3>
            <p className="transition-lab-hint">
              Saved transition recipes. Default is “Shift left”.
            </p>
            <label>
              Active template
              <select
                value={activeTemplateId}
                onChange={(event) => {
                  const nextId = event.target.value;
                  if (!nextId) {
                    setActiveTemplateId("");
                    return;
                  }
                  applyTemplate(nextId);
                }}
              >
                <option value="">Custom / unsaved</option>
                {TRANSITION_TEMPLATES.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="button-row">
              <button
                type="button"
                onClick={() => applyTemplate(DEFAULT_TEMPLATE_ID)}
              >
                Load Shift left
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={resetDefaults}
              >
                Reset defaults
              </button>
            </div>
          </section>

          <section className="transition-lab-section">
            <h3>Sources</h3>
            <label>
              Card A (out)
              <select
                value={cardAId}
                onChange={(event) => {
                  const nextId = event.target.value;
                  setCardAId(nextId);
                  if (nextId === cardBId) {
                    const replacement = cards.find((card) => card.id !== nextId);
                    if (replacement) setCardBId(replacement.id);
                  }
                }}
              >
                {cards.map((card) => (
                  <option key={card.id} value={card.id}>
                    {card.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Card B (in)
              <select
                value={cardBId}
                onChange={(event) => {
                  const nextId = event.target.value;
                  setCardBId(nextId);
                  if (nextId === cardAId) {
                    const replacement = cards.find((card) => card.id !== nextId);
                    if (replacement) setCardAId(replacement.id);
                  }
                }}
              >
                {cards.map((card) => (
                  <option key={card.id} value={card.id}>
                    {card.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="button-row">
              <button type="button" className="secondary-button" onClick={() => void loadCards()}>
                Reload cards
              </button>
              <a className="secondary-button" href="/dashboard">
                Dashboard
              </a>
            </div>
          </section>

          <section className="transition-lab-section">
            <h3>Transition</h3>
            <label>
              Duration (ms)
              <input
                type="text"
                inputMode="decimal"
                value={durationInput}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  setDurationInput(event.target.value);
                  if (raw === "" || raw === "." || raw === "-") return;
                  const next = Number(raw);
                  if (!Number.isFinite(next) || next <= 0) return;
                  setDurationMs(next);
                }}
                onBlur={() => {
                  const next = Number(durationInput);
                  if (!Number.isFinite(next) || next <= 0) {
                    setDurationInput(String(durationMs));
                    return;
                  }
                  setDurationMs(next);
                  setDurationInput(String(next));
                }}
              />
            </label>
            <p className="transition-lab-hint">
              Any positive duration (e.g. 250, 800, 1250.5, 4000).
            </p>
            <p className="transition-lab-hint">
              Snap strip X · W={STAGE_WIDTH} · default end x={DEFAULT_END_X}
            </p>
            <div className="transition-lab-snap-row">
              <button type="button" className="secondary-button" onClick={() => snapX(0)}>
                A (0)
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => snapX(-STAGE_WIDTH)}
              >
                A↻ (-W)
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => snapX(-STAGE_WIDTH * 2)}
              >
                B↻ (-2W)
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => snapX(DEFAULT_END_X)}
              >
                B ({DEFAULT_END_X})
              </button>
            </div>
          </section>

          <section className="transition-lab-section">
            <h3>Easing</h3>
            <p className="transition-lab-hint">
              Drag the handles to shape the cubic-bezier. X is time, Y is progress.
            </p>
            <div className="transition-lab-ease-presets">
              {EASING_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="secondary-button"
                  onClick={() => updateEasing(preset.bezier)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="transition-lab-ease-editor">
              <svg
                ref={curveSvgRef}
                className="transition-lab-ease-svg"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
              >
                <rect
                  className="transition-lab-ease-bg"
                  x="0"
                  y="0"
                  width="100"
                  height="100"
                />
                <line
                  className="transition-lab-ease-grid"
                  x1="0"
                  y1="50"
                  x2="100"
                  y2="50"
                />
                <line
                  className="transition-lab-ease-grid"
                  x1="50"
                  y1="0"
                  x2="50"
                  y2="100"
                />
                <line
                  className="transition-lab-ease-linear"
                  x1="0"
                  y1="100"
                  x2="100"
                  y2="0"
                />
                <path className="transition-lab-ease-curve" d={curvePath} />
                <line
                  className="transition-lab-ease-arm"
                  x1="0"
                  y1="100"
                  x2={easing.x1 * 100}
                  y2={(1 - easing.y1) * 100}
                />
                <line
                  className="transition-lab-ease-arm"
                  x1="100"
                  y1="0"
                  x2={easing.x2 * 100}
                  y2={(1 - easing.y2) * 100}
                />
                <circle
                  className="transition-lab-ease-handle"
                  cx={easing.x1 * 100}
                  cy={(1 - easing.y1) * 100}
                  r="4.5"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    dragHandleRef.current = "p1";
                  }}
                />
                <circle
                  className="transition-lab-ease-handle"
                  cx={easing.x2 * 100}
                  cy={(1 - easing.y2) * 100}
                  r="4.5"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    dragHandleRef.current = "p2";
                  }}
                />
                <line
                  className="transition-lab-ease-playhead"
                  x1={playheadT * 100}
                  y1="0"
                  x2={playheadT * 100}
                  y2="100"
                />
                <circle
                  className="transition-lab-ease-sample"
                  cx={playheadT * 100}
                  cy={(1 - easedPlayhead) * 100}
                  r="2.8"
                />
              </svg>
            </div>
            <p className="transition-lab-hint transition-lab-mono">
              {formatBezier(easing)}
            </p>
            <div className="transition-lab-sliders">
              <label>
                <span className="transition-lab-slider-label">
                  <span>X1</span>
                  <span>{roundValue(easing.x1, 3)}</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={easing.x1}
                  onChange={(event) =>
                    updateEasing({
                      ...easing,
                      x1: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                <span className="transition-lab-slider-label">
                  <span>Y1</span>
                  <span>{roundValue(easing.y1, 3)}</span>
                </span>
                <input
                  type="range"
                  min={-0.5}
                  max={1.5}
                  step={0.01}
                  value={easing.y1}
                  onChange={(event) =>
                    updateEasing({
                      ...easing,
                      y1: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                <span className="transition-lab-slider-label">
                  <span>X2</span>
                  <span>{roundValue(easing.x2, 3)}</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={easing.x2}
                  onChange={(event) =>
                    updateEasing({
                      ...easing,
                      x2: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                <span className="transition-lab-slider-label">
                  <span>Y2</span>
                  <span>{roundValue(easing.y2, 3)}</span>
                </span>
                <input
                  type="range"
                  min={-0.5}
                  max={1.5}
                  step={0.01}
                  value={easing.y2}
                  onChange={(event) =>
                    updateEasing({
                      ...easing,
                      y2: Number(event.target.value),
                    })
                  }
                />
              </label>
            </div>
          </section>

          <section className="transition-lab-section">
            <h3>Strip</h3>
            <p className="transition-lab-hint">
              One long line [A | A↻ | B↻ | B]. Slide left to go A → B using the
              easing curve. Sliders edit base keyframe values (blur FX is separate).
            </p>
            <div className="transition-lab-sliders">
              {STRIP_SLIDERS.map((slider) => {
                const value = basePose[slider.key];
                return (
                  <label key={slider.key}>
                    <span className="transition-lab-slider-label">
                      <span>{slider.label}</span>
                      <span>{roundValue(value, slider.step < 1 ? 2 : 0)}</span>
                    </span>
                    <input
                      type="range"
                      min={slider.min}
                      max={slider.max}
                      step={slider.step}
                      value={value}
                      onChange={(event) =>
                        updatePose({
                          ...basePose,
                          [slider.key]: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                );
              })}
            </div>
          </section>

          <section className="transition-lab-section">
            <h3>Motion FX</h3>
            <p className="transition-lab-hint">
              Blur + scale pulse. Scale is centered on stage to hide edge bleed.
              Start/stop are % of transition duration.
            </p>
            <label className="transition-lab-check">
              <input
                type="checkbox"
                checked={motionFx.enabled}
                onChange={(event) => {
                  patchMotionFx({ enabled: event.target.checked });
                }}
              />
              Enable motion FX
            </label>

            <div className="transition-lab-fx-channel">
              <h4>Blur</h4>
              <div className="transition-lab-sliders">
                <label>
                  <span className="transition-lab-slider-label">
                    <span>Start %</span>
                    <span>
                      {roundValue(motionFx.blur.startPct, 0)}% ·{" "}
                      {formatTime((motionFx.blur.startPct / 100) * durationMs)}
                    </span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={motionFx.blur.startPct}
                    onChange={(event) =>
                      patchFxChannelWindow("blur", {
                        startPct: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  <span className="transition-lab-slider-label">
                    <span>Stop %</span>
                    <span>
                      {roundValue(motionFx.blur.stopPct, 0)}% ·{" "}
                      {formatTime((motionFx.blur.stopPct / 100) * durationMs)}
                    </span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={motionFx.blur.stopPct}
                    onChange={(event) =>
                      patchFxChannelWindow("blur", {
                        stopPct: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  <span className="transition-lab-slider-label">
                    <span>Peak</span>
                    <span>{motionFx.blurPeak}</span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={40}
                    step={0.5}
                    value={motionFx.blurPeak}
                    onChange={(event) =>
                      patchMotionFx({ blurPeak: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
            </div>

            <div className="transition-lab-fx-channel">
              <h4>Scale pulse</h4>
              <div className="transition-lab-sliders">
                <label>
                  <span className="transition-lab-slider-label">
                    <span>Start %</span>
                    <span>
                      {roundValue(motionFx.scale.startPct, 0)}% ·{" "}
                      {formatTime((motionFx.scale.startPct / 100) * durationMs)}
                    </span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={motionFx.scale.startPct}
                    onChange={(event) =>
                      patchFxChannelWindow("scale", {
                        startPct: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  <span className="transition-lab-slider-label">
                    <span>Stop %</span>
                    <span>
                      {roundValue(motionFx.scale.stopPct, 0)}% ·{" "}
                      {formatTime((motionFx.scale.stopPct / 100) * durationMs)}
                    </span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={motionFx.scale.stopPct}
                    onChange={(event) =>
                      patchFxChannelWindow("scale", {
                        stopPct: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  <span className="transition-lab-slider-label">
                    <span>Peak</span>
                    <span>{roundValue(motionFx.scalePeak, 3)}</span>
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={1.2}
                    step={0.005}
                    value={motionFx.scalePeak}
                    onChange={(event) =>
                      patchMotionFx({ scalePeak: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
            </div>
          </section>

          <section className="transition-lab-section">
            <h3>Keyframes · {getGraphChannel(activeGraphChannel).label}</h3>
            <p className="transition-lab-hint">
              Independent tracks. Edits apply only to{" "}
              <strong>{activeGraphChannel.toUpperCase()}</strong>
              {isolatedChannel ? " (solo mode)" : ""}.
            </p>
            <div className="button-row">
              <button type="button" onClick={addOrUpdateKeyframe}>
                {nearExisting
                  ? `Update ${activeGraphChannel} @ playhead`
                  : `Add ${activeGraphChannel} @ playhead`}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={updateSelectedKeyframe}
              >
                Update selected
              </button>
            </div>
            <div className="button-row">
              <button
                type="button"
                className="secondary-button"
                onClick={deleteSelectedKeyframe}
                disabled={activeChannelFrames.length <= 1}
              >
                Delete selected
              </button>
              <button type="button" className="secondary-button" onClick={resetDefaults}>
                Reset defaults
              </button>
            </div>
            <ul className="transition-lab-keyframes">
              {activeChannelFrames.map((frame, index) => {
                const selected = index === selectedKeyframeIndex;
                const channel = getGraphChannel(activeGraphChannel);
                return (
                  <li key={`kf-${activeGraphChannel}-${index}-${frame.t}`}>
                    <button
                      type="button"
                      className={
                        selected
                          ? "transition-lab-keyframe is-selected"
                          : "transition-lab-keyframe"
                      }
                      onClick={() =>
                        jumpToChannelKeyframe(activeGraphChannel, index)
                      }
                    >
                      <strong>t={roundValue(frame.t, 3)}</strong>
                      <span>
                        {channel.label}={roundValue(frame.value, channel.digits)}
                      </span>
                      {activeGraphChannel === "x" ? (
                        <span>shows {visiblePanelLabel(frame.value)}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="transition-lab-section json-stack">
            <h3>Export</h3>
            <div className="button-row">
              <button type="button" onClick={() => void copyJson()}>
                {copyState === "copied" ? "Copied" : "Copy JSON"}
              </button>
              <button type="button" className="secondary-button" onClick={importJson}>
                Import JSON
              </button>
            </div>
            <label>
              Paste / inspect
              <textarea
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                spellCheck={false}
                placeholder="Paste transition JSON here, then Import"
              />
            </label>
          </section>
        </aside>
      </div>
    </main>
  );
}
