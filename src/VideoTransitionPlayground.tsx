import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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

/** Blur-only motion FX while the strip is sliding. */
const DEFAULT_BLUR_PEAK = 12.5;
const DEFAULT_BLUR_WINDOW = { startPct: 5, stopPct: 99 } as const;
/** Fallback only used when importing legacy global windows. */
const DEFAULT_FX_START_PCT = 5;
const DEFAULT_FX_STOP_PCT = 99;
/**
 * Within the blur start→stop window, relative ramp positions
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
  opacity: number;
};

type FxWindow = {
  /** 0–100: % of transition duration when blur begins. */
  startPct: number;
  /** 0–100: % of transition duration when blur fully ends. */
  stopPct: number;
};

type MotionFxSettings = {
  enabled: boolean;
  blurPeak: number;
  blur: FxWindow;
};

/** CSS-style cubic-bezier control points. */
type CubicBezier = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type TransitionKeyframe = {
  t: number;
  strip: StripProps;
};

type TransitionPreset = {
  version: 2;
  pattern: "mirror-slide-strip";
  durationMs: number;
  cardAId: string;
  cardBId: string;
  stageWidth: number;
  easing?: CubicBezier;
  motionFx?: MotionFxSettings;
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
  opacity: 1,
};

function cloneStrip(strip: StripProps): StripProps {
  return { ...strip };
}

/**
 * Continuous line:
 *   [ A | A↻ | B↻ | B ]
 *
 * x = 0      → A in frame
 * x = -W     → A↻ in frame
 * x = -2W    → B↻ in frame
 * x = -1163  → B settled (default end)
 */
function defaultKeyframes(): TransitionKeyframe[] {
  return [
    {
      t: 0,
      strip: cloneStrip(IDENTITY),
    },
    {
      t: 1,
      strip: {
        x: DEFAULT_END_X,
        y: 0,
        scale: 1,
        blur: 0,
        opacity: 1,
      },
    },
  ];
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
    opacity: lerp(a.opacity, b.opacity, t),
  };
}

function sortKeyframes(frames: TransitionKeyframe[]): TransitionKeyframe[] {
  return [...frames].sort((left, right) => left.t - right.t);
}

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
    opacity: roundValue(strip.opacity, 3),
  };
}

function stripStyle(strip: StripProps): CSSProperties {
  return {
    opacity: strip.opacity,
    filter: strip.blur > 0.001 ? `blur(${strip.blur}px)` : "none",
    transform: `translate(${strip.x}px, ${strip.y}px) scale(${strip.scale})`,
  };
}

function defaultMotionFx(): MotionFxSettings {
  return {
    enabled: true,
    blurPeak: DEFAULT_BLUR_PEAK,
    blur: { ...DEFAULT_BLUR_WINDOW },
  };
}

function buildShiftLeftPreset(): TransitionPreset {
  return {
    version: 2,
    pattern: "mirror-slide-strip",
    durationMs: DEFAULT_DURATION_MS,
    cardAId: DEFAULT_CARD_A_ID,
    cardBId: DEFAULT_CARD_B_ID,
    stageWidth: STAGE_WIDTH,
    easing: defaultEasing(),
    motionFx: defaultMotionFx(),
    keyframes: defaultKeyframes(),
  };
}

const TRANSITION_TEMPLATES: TransitionTemplate[] = [
  {
    id: "shift-left",
    label: "Shift left",
    preset: buildShiftLeftPreset(),
  },
];

const DEFAULT_TEMPLATE_ID = "shift-left";

function getTemplate(id: string): TransitionTemplate | null {
  return TRANSITION_TEMPLATES.find((entry) => entry.id === id) ?? null;
}

function clonePreset(preset: TransitionPreset): TransitionPreset {
  return {
    version: 2,
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
    },
    keyframes: sortKeyframes(preset.keyframes).map((frame) => ({
      t: frame.t,
      strip: cloneStrip(frame.strip),
    })),
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

function sampleMotionFx(t: number, fx: MotionFxSettings): { blur: number } {
  if (!fx.enabled) return { blur: 0 };
  const blurEnv = motionFxEnvelope(t, fx.blur);
  return { blur: fx.blurPeak * blurEnv };
}

/** Keyframe base + procedural blur FX for display only. */
function applyMotionFx(
  base: StripProps,
  t: number,
  fx: MotionFxSettings,
): StripProps {
  const motion = sampleMotionFx(t, fx);
  return {
    ...base,
    blur: Math.max(0, base.blur + motion.blur),
  };
}

function formatTime(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function summarizeStrip(strip: StripProps): string {
  return `x${roundValue(strip.x, 0)} y${roundValue(strip.y, 0)} s${roundValue(strip.scale, 2)} b${roundValue(strip.blur, 1)} o${roundValue(strip.opacity, 2)}`;
}

function isLooseStripProps(value: unknown): value is {
  x: number;
  y: number;
  scale: number;
  blur: number;
  opacity: number;
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
}): StripProps {
  return roundStrip({
    x: value.x,
    y: value.y,
    scale: value.scale,
    blur: value.blur,
    opacity: value.opacity,
  });
}

/** Accept v2 strip keyframes, or legacy v1 dual-group (a/b) by using a.x. */
function parsePreset(raw: unknown): TransitionPreset | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (data.version !== 1 && data.version !== 2) return null;
  if (typeof data.durationMs !== "number" || !Number.isFinite(data.durationMs)) {
    return null;
  }
  if (typeof data.cardAId !== "string" || typeof data.cardBId !== "string") {
    return null;
  }
  if (!Array.isArray(data.keyframes) || data.keyframes.length === 0) return null;

  const keyframes: TransitionKeyframe[] = [];
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

  if (keyframes.length === 0) return null;

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
    };
  }

  const easing = parseEasing(data.easing) ?? defaultEasing();

  return {
    version: 2,
    pattern: "mirror-slide-strip",
    durationMs: sanitizeDurationMs(data.durationMs),
    cardAId: data.cardAId,
    cardBId: data.cardBId,
    stageWidth: STAGE_WIDTH,
    easing,
    motionFx,
    keyframes: sortKeyframes(keyframes),
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

async function loadPairedVideos(
  main: HTMLVideoElement,
  mirror: HTMLVideoElement,
  src: string,
): Promise<void> {
  await Promise.all([loadVideoSrc(main, src), loadVideoSrc(mirror, src)]);
  for (const video of [main, mirror]) {
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
  }
  try {
    mirror.currentTime = main.currentTime;
  } catch {
    // ignore
  }
  await Promise.all([
    main.play().catch(() => undefined),
    mirror.play().catch(() => undefined),
  ]);
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
  { key: "blur", label: "Blur", min: 0, max: 40, step: 0.1 },
  { key: "opacity", label: "Opacity", min: 0, max: 1, step: 0.01 },
];

function visiblePanelLabel(x: number): string {
  const panel = clamp(Math.round(-x / STAGE_WIDTH), 0, 3);
  return ["A", "A↻", "B↻", "B"][panel] ?? "?";
}

export function VideoTransitionPlayground() {
  const videoARef = useRef<HTMLVideoElement | null>(null);
  const videoAMirrorRef = useRef<HTMLVideoElement | null>(null);
  const videoBRef = useRef<HTMLVideoElement | null>(null);
  const videoBMirrorRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const syncRafRef = useRef<number | null>(null);
  const playStartedAtRef = useRef(0);
  const playStartedTRef = useRef(0);
  const playheadTRef = useRef(0);
  const keyframesRef = useRef<TransitionKeyframe[]>(defaultKeyframes());
  const durationMsRef = useRef(DEFAULT_DURATION_MS);
  const motionFxRef = useRef<MotionFxSettings>(defaultMotionFx());
  const easingRef = useRef<CubicBezier>(defaultEasing());
  /** Base keyframed pose without procedural blur (for editing/export). */
  const basePoseRef = useRef<StripProps>(defaultKeyframes()[0].strip);
  const curveSvgRef = useRef<SVGSVGElement | null>(null);
  const dragHandleRef = useRef<"p1" | "p2" | null>(null);

  const [cards, setCards] = useState<TransitionCard[]>([]);
  const [cardAId, setCardAId] = useState("");
  const [cardBId, setCardBId] = useState("");
  const [durationMs, setDurationMs] = useState(DEFAULT_DURATION_MS);
  const [durationInput, setDurationInput] = useState(String(DEFAULT_DURATION_MS));
  const [playheadT, setPlayheadT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [keyframes, setKeyframes] = useState<TransitionKeyframe[]>(() =>
    defaultKeyframes(),
  );
  const [selectedKeyframeIndex, setSelectedKeyframeIndex] = useState(0);
  const [basePose, setBasePose] = useState<StripProps>(
    () => defaultKeyframes()[0].strip,
  );
  const [pose, setPose] = useState<StripProps>(() => defaultKeyframes()[0].strip);
  const [motionFx, setMotionFx] = useState<MotionFxSettings>(() => defaultMotionFx());
  const [easing, setEasing] = useState<CubicBezier>(() => defaultEasing());
  const [status, setStatus] = useState("Loading cards…");
  const [importText, setImportText] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [activeTemplateId, setActiveTemplateId] = useState(DEFAULT_TEMPLATE_ID);

  useEffect(() => {
    playheadTRef.current = playheadT;
  }, [playheadT]);

  useEffect(() => {
    keyframesRef.current = keyframes;
  }, [keyframes]);

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

  const sortedKeyframes = useMemo(() => sortKeyframes(keyframes), [keyframes]);

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

  const applySampledPose = useCallback(
    (
      t: number,
      frames: TransitionKeyframe[],
      fx?: MotionFxSettings,
      ease?: CubicBezier,
    ) => {
      const curve = ease ?? easingRef.current;
      const base = sampleKeyframes(frames, t, curve);
      const settings = fx ?? motionFxRef.current;
      basePoseRef.current = base;
      setBasePose(base);
      setPose(applyMotionFx(base, t, settings));
    },
    [],
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
    const videoAMirror = videoAMirrorRef.current;
    const videoB = videoBRef.current;
    const videoBMirror = videoBMirrorRef.current;
    if (!videoA || !videoAMirror || !videoB || !videoBMirror) return;

    let cancelled = false;

    const run = async () => {
      if (!cardA || !cardB) return;
      setStatus(`Loading ${cardA.label} → ${cardB.label}…`);
      try {
        await Promise.all([
          loadPairedVideos(videoA, videoAMirror, cardA.bottom),
          loadPairedVideos(videoB, videoBMirror, cardB.bottom),
        ]);
        if (!cancelled) {
          setStatus(`${cardA.label} → ${cardB.label} · [A|A↻|B↻|B]`);
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

  useEffect(() => {
    const sync = () => {
      const pairs: Array<[HTMLVideoElement | null, HTMLVideoElement | null]> = [
        [videoARef.current, videoAMirrorRef.current],
        [videoBRef.current, videoBMirrorRef.current],
      ];
      for (const [main, mirror] of pairs) {
        if (!main || !mirror) continue;
        if (!Number.isFinite(main.currentTime) || !Number.isFinite(mirror.currentTime)) {
          continue;
        }
        if (Math.abs(main.currentTime - mirror.currentTime) > 0.045) {
          try {
            mirror.currentTime = main.currentTime;
          } catch {
            // ignore seek races
          }
        }
      }
      syncRafRef.current = requestAnimationFrame(sync);
    };
    syncRafRef.current = requestAnimationFrame(sync);
    return () => {
      if (syncRafRef.current !== null) {
        cancelAnimationFrame(syncRafRef.current);
        syncRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
      releaseMediaElement(videoARef.current);
      releaseMediaElement(videoAMirrorRef.current);
      releaseMediaElement(videoBRef.current);
      releaseMediaElement(videoBMirrorRef.current);
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
      applySampledPose(nextT, keyframesRef.current);
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
    if (opts?.sample !== false) {
      applySampledPose(t, keyframes);
      const nearest = findNearestKeyframeIndex(sortedKeyframes, t);
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

  const addOrUpdateKeyframe = () => {
    setPlaying(false);
    const t = clamp(playheadT, 0, 1);
    const nearest = findNearestKeyframeIndex(sortedKeyframes, t);
    const frame: TransitionKeyframe = {
      t: nearest >= 0 ? sortedKeyframes[nearest].t : roundValue(t, 4),
      strip: roundStrip(basePoseRef.current),
    };

    if (nearest >= 0) {
      const next = sortedKeyframes.map((entry, index) =>
        index === nearest ? frame : entry,
      );
      setKeyframes(next);
      setSelectedKeyframeIndex(nearest);
      setStatus(`Updated keyframe @ ${roundValue(frame.t, 3)}`);
      return;
    }

    const next = sortKeyframes([...sortedKeyframes, frame]);
    setKeyframes(next);
    setSelectedKeyframeIndex(next.findIndex((entry) => entry.t === frame.t));
    setStatus(`Added keyframe @ ${roundValue(frame.t, 3)}`);
  };

  const updateSelectedKeyframe = () => {
    if (
      selectedKeyframeIndex < 0 ||
      selectedKeyframeIndex >= sortedKeyframes.length
    ) {
      return;
    }
    setPlaying(false);
    const selectedT = sortedKeyframes[selectedKeyframeIndex].t;
    const next = sortedKeyframes.map((entry, index) =>
      index === selectedKeyframeIndex
        ? {
            t: entry.t,
            strip: roundStrip(basePoseRef.current),
          }
        : entry,
    );
    setKeyframes(next);
    setStatus(`Updated selected keyframe @ ${roundValue(selectedT, 3)}`);
  };

  const deleteSelectedKeyframe = () => {
    if (sortedKeyframes.length <= 1) {
      setStatus("Keep at least one keyframe");
      return;
    }
    if (
      selectedKeyframeIndex < 0 ||
      selectedKeyframeIndex >= sortedKeyframes.length
    ) {
      return;
    }
    setPlaying(false);
    const removedT = sortedKeyframes[selectedKeyframeIndex].t;
    const next = sortedKeyframes.filter(
      (_, index) => index !== selectedKeyframeIndex,
    );
    setKeyframes(next);
    const nextSelected = clamp(selectedKeyframeIndex, 0, next.length - 1);
    setSelectedKeyframeIndex(nextSelected);
    applySampledPose(playheadT, next);
    setStatus(`Deleted keyframe @ ${roundValue(removedT, 3)}`);
  };

  const jumpToKeyframe = (index: number) => {
    const frame = sortedKeyframes[index];
    if (!frame) return;
    setPlaying(false);
    setSelectedKeyframeIndex(index);
    setPlayheadT(frame.t);
    applySampledPose(frame.t, sortedKeyframes);
  };

  const buildPreset = (): TransitionPreset => ({
    version: 2,
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
    },
    keyframes: sortKeyframes(keyframes).map((frame) => ({
      t: roundValue(frame.t, 4),
      strip: roundStrip(frame.strip),
    })),
  });

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
      const frames = sortKeyframes(preset.keyframes);

      setPlaying(false);
      setDurationMs(preset.durationMs);
      setDurationInput(String(preset.durationMs));
      setKeyframes(frames);
      setMotionFx(nextFx);
      motionFxRef.current = nextFx;
      setEasing(nextEase);
      easingRef.current = nextEase;
      setSelectedKeyframeIndex(0);
      setPlayheadT(frames[0]?.t ?? 0);

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

      applySampledPose(frames[0]?.t ?? 0, frames, nextFx, nextEase);
      setStatus(
        opts?.statusText ??
          `Loaded preset (${preset.durationMs}ms, ${frames.length} keyframes)`,
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
        statusText: `Imported ${parsed.keyframes.length} keyframes (${parsed.durationMs}ms)`,
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
    applySampledPose(playheadT, keyframes, next);
  };

  const patchBlurWindow = (patch: Partial<FxWindow>) => {
    let startPct = patch.startPct ?? motionFx.blur.startPct;
    let stopPct = patch.stopPct ?? motionFx.blur.stopPct;
    startPct = clamp(startPct, 0, 100);
    stopPct = clamp(stopPct, 0, 100);
    if (patch.startPct !== undefined) stopPct = Math.max(stopPct, startPct);
    if (patch.stopPct !== undefined) startPct = Math.min(startPct, stopPct);
    patchMotionFx({
      blur: { startPct, stopPct },
    });
  };

  const updateEasing = useCallback(
    (nextRaw: CubicBezier) => {
      const next = sanitizeEasing(nextRaw);
      setEasing(next);
      easingRef.current = next;
      applySampledPose(
        playheadTRef.current,
        keyframesRef.current,
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
  const nearExisting = findNearestKeyframeIndex(sortedKeyframes, playheadT) >= 0;
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
              <div className="transition-lab-strip" style={stripStyle(pose)}>
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
                <div className="transition-lab-tile is-flipped">
                  <video
                    ref={videoAMirrorRef}
                    className="transition-lab-video"
                    muted
                    loop
                    playsInline
                    preload="auto"
                  />
                  <span className="transition-lab-tile-tag">A↻</span>
                </div>
                <div className="transition-lab-tile is-flipped">
                  <video
                    ref={videoBMirrorRef}
                    className="transition-lab-video"
                    muted
                    loop
                    playsInline
                    preload="auto"
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
                x={roundValue(pose.x, 0)} · blur={roundValue(pose.blur, 1)} ·{" "}
                {visiblePanelLabel(pose.x)} · eased=
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
                {sortedKeyframes.map((frame, index) => (
                  <button
                    key={`marker-${index}-${frame.t}`}
                    type="button"
                    className="transition-lab-marker"
                    style={{ left: `${frame.t * 100}%` }}
                    title={`Keyframe @ ${roundValue(frame.t, 3)}`}
                    onClick={() => jumpToKeyframe(index)}
                  />
                ))}
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
              Blur only. Start/stop are % of transition duration.
            </p>
            <label className="transition-lab-check">
              <input
                type="checkbox"
                checked={motionFx.enabled}
                onChange={(event) => {
                  patchMotionFx({ enabled: event.target.checked });
                }}
              />
              Enable blur FX
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
                      patchBlurWindow({
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
                      patchBlurWindow({
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
          </section>

          <section className="transition-lab-section">
            <h3>Keyframes</h3>
            <div className="button-row">
              <button type="button" onClick={addOrUpdateKeyframe}>
                {nearExisting ? "Update @ playhead" : "Add @ playhead"}
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
              >
                Delete selected
              </button>
              <button type="button" className="secondary-button" onClick={resetDefaults}>
                Reset defaults
              </button>
            </div>
            <ul className="transition-lab-keyframes">
              {sortedKeyframes.map((frame, index) => {
                const selected = index === selectedKeyframeIndex;
                return (
                  <li key={`kf-${index}-${frame.t}`}>
                    <button
                      type="button"
                      className={
                        selected
                          ? "transition-lab-keyframe is-selected"
                          : "transition-lab-keyframe"
                      }
                      onClick={() => jumpToKeyframe(index)}
                    >
                      <strong>t={roundValue(frame.t, 3)}</strong>
                      <span>{summarizeStrip(frame.strip)}</span>
                      <span>shows {visiblePanelLabel(frame.strip.x)}</span>
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
