import { DotLottieReact } from "@lottiefiles/dotlottie-react";
import "@/lib/lottie/setupWasm";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { lottieRenderConfig } from "@/utils/lottieRender";
import { GameSymbolIcon } from "./GameSymbolIcon";
import { resolveFoilCanvasPixelRatio } from "./foilCanvasPixelRatio";
import {
  MATCH_SHAKE_CYCLE_MS,
  MATCH_SHAKE_CYCLES,
  MATCH_SHAKE_START_MS,
} from "./matchFlightPath";
import { SYMBOL_TYPES, TOP_SYMBOL_COUNT } from "./matchGame";
import { noteScratchSoundActivity, stopScratchSounds } from "./scratchSound";
import { getScratchZoomEnabled } from "@/services/scratchZoomPref";

const BRUSH_RADIUS_CSS = 12;
const SLOT_REVEAL_THRESHOLD = 0.55;
const SCRATCH_TEXTURE_URL = "/scratch/scratchTexture.jpg";
const BRUSH_STEP_RATIO = 0.35;
/** Decorative peel cue on the left edge of the centered scratch bar. */
const PEEL_LOTTIE_SRC = "/lottie/peelv2.lottie";
/** "Scratch" text that plays once in the gap the bar leaves as it docks. */
const SCRATCH_TEXT_LOTTIE_SRC = "/lottie/lottieScratchText.lottie";
/** lottieScratchText.lottie is 90 frames @ 60fps (400×190.705). */
const SCRATCH_TEXT_LOTTIE_MS = Math.round((90 / 60) * 1000);
const PEEL_LOTTIE_WIDTH = 52;
/** peelv2.lottie is 180 frames @ 60fps (public/lottie/peelv2.lottie). */
const PEEL_LOTTIE_DURATION_MS = Math.round((180 / 60) * 1000);
/** Hold the last frame this long before remounting for the next play. */
const PEEL_LOTTIE_PAUSE_MS = 1800;
const PEEL_LOTTIE_CYCLE_MS = PEEL_LOTTIE_DURATION_MS + PEEL_LOTTIE_PAUSE_MS;
/** Beat after foil clears before the bar flies up to dock. */
const CLEAR_CELEBRATE_MS = 420;
/** Start the "Scratch" text this far before the dock climb so it leads the bar. */
const SCRATCH_TEXT_LEAD_MS = 180;
/** Center → top climb duration (rAF pixel tween, includes anticipation). */
const DOCK_FLY_MS = 280;
/** Peak CSS blur during dock climb (px) — light motion-blur read. */
const DOCK_FLY_BLUR_PX = 14;
/** Last dormant cascade delay (200ms) + 520ms fade, then a beat before hide. */
const DOCK_SETTLE_MS = 200 + 520 + 280;

function foilCanvasDpr(): number {
  if (typeof window === "undefined") return 1;
  return resolveFoilCanvasPixelRatio({
    coarsePointer: window.matchMedia("(pointer: coarse)").matches,
    devicePixelRatio: window.devicePixelRatio || 1,
  });
}

/** Same tile scale as before; motif height ≈ bar height. */
function foilPatternScale(canvasHeight: number, textureHeight: number) {
  if (textureHeight <= 0) return 1;
  return Math.max((canvasHeight / textureHeight) * 1.15, 0.01);
}

// Flying foil flakes on scratch — colored by sampling the scratch coating.
// Sized in CSS pixels (converted with DPR at spawn) so they stay small on
// retina. Portaled to the full `.stage` so gravity can carry them off-screen.
const FLAKE_COUNT_PER_SCRATCH = 4;
const FLAKE_MAX = 120;
const FLAKE_LIFE = 1.25;
const FLAKE_SCALE_MIN = 0.55;
const FLAKE_SCALE_MAX = 1;
/** Base half-extent in CSS px before DPR. */
const FLAKE_BASE_SIZE_CSS = 5;
const FLAKE_GRAVITY = 980;
const FLAKE_FALLBACK_COLORS = [
  "oklch(0.859 0.008 73.73)",
  "oklch(0.76 0.01 72.63)",
  "oklch(0.673 0.009 67.67)",
  "oklch(0.599 0.01 67.64)",
  "oklch(0.513 0.008 67.65)",
];

function srgbChannelToLinear(c: number) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

/** Canvas-safe OKLCH string from 8-bit sRGB channels. */
function rgbBytesToOklch(r: number, g: number, b: number) {
  const lr = srgbChannelToLinear(r);
  const lg = srgbChannelToLinear(g);
  const lb = srgbChannelToLinear(b);
  const l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s_ = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l = Math.cbrt(l_);
  const m = Math.cbrt(m_);
  const s = Math.cbrt(s_);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(A, B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  const lS = Math.min(1, Math.max(0, L)).toFixed(3);
  const cS = (C < 1e-5 ? 0 : C).toFixed(3);
  const hS = (C < 1e-5 ? 0 : H).toFixed(2);
  return `oklch(${lS} ${cS} ${hS})`;
}

export type TopBarPhase = "center" | "docked" | "showcase";

/** Fly back to center + pulse matched finds before advancing. */
export const TOP_BAR_SHOWCASE_MS = 400;

type TopSymbolBarProps = {
  symbols: number[];
  phase: TopBarPhase;
  onAllRevealed: () => void;
  roundKey?: string | number;
  forceRevealed?: boolean;
  /** Docked hunt: slots that have been found on the body (full color again). */
  matchedSlots?: boolean[];
  /** Docked hunt: matching type is shaking with the flying body icon. */
  shakingSlots?: boolean[];
  /** A matched symbol is still flying home — hold the dock until it lands. */
  matchInFlight?: boolean;
  /** Per-slot extra delay (ms) so concurrent matches stagger like the flights. */
  shakeDelayMs?: number[];
  /** Optional mirror of slot DOM nodes for fly-to-slot animations. */
  slotElsOutRef?: MutableRefObject<(HTMLDivElement | null)[]>;
  /** Force symbol lotties onto first frame (iOS scratch / coarse pointer). */
  freezeSymbols?: boolean;
  /** Skip worker-backed symbol players (coarse pointer). */
  preferStaticSymbols?: boolean;
  /** Hide decorative peel lottie (coarse pointer / reduced motion). */
  quietDecorativeLottie?: boolean;
  /** First stroke on the center foil pad (icon revealer). */
  onScratchStart?: () => void;
  /** Docked bar has slid off-screen (finger-down brings it back). */
  onDockHiddenChange?: (hidden: boolean) => void;
  /** After lift, wait this long so zoom-out can finish before AutoScratch drops in. */
  holdAfterPointerMs?: number;
};

let scratchTexture: HTMLImageElement | null = null;
let scratchTextureReady = false;
let scratchTextureSampler: CanvasRenderingContext2D | null = null;
const scratchTextureWaiters: Array<() => void> = [];

function loadScratchTexture(): void {
  if (scratchTexture) return;
  const img = new Image();
  scratchTexture = img;
  img.decoding = "async";
  img.onload = () => {
    scratchTextureReady = true;
    // Cached offscreen copy so flake spawns can read a pixel color back
    // without re-drawing/reading from the live pattern each time.
    const off = document.createElement("canvas");
    off.width = Math.max(1, img.naturalWidth);
    off.height = Math.max(1, img.naturalHeight);
    const offCtx = off.getContext("2d", { willReadFrequently: true });
    if (offCtx) {
      offCtx.drawImage(img, 0, 0);
      scratchTextureSampler = offCtx;
    }
    for (const notify of scratchTextureWaiters.splice(0)) notify();
  };
  img.onerror = () => {
    scratchTexture = null;
    scratchTextureReady = false;
    scratchTextureSampler = null;
    for (const notify of scratchTextureWaiters.splice(0)) notify();
  };
  img.src = SCRATCH_TEXTURE_URL;
}

/** Same tone as the coating at canvas-pixel (px, py) — mirrors the pattern's
 * `paintBarCoating` scale so flakes look torn straight off the foil there. */
function sampleScratchTextureColor(
  px: number,
  py: number,
  canvasHeight: number,
): string {
  const tex = scratchTexture;
  if (
    !scratchTextureReady ||
    !tex ||
    !scratchTextureSampler ||
    tex.naturalWidth <= 0
  ) {
    return FLAKE_FALLBACK_COLORS[
      Math.floor(Math.random() * FLAKE_FALLBACK_COLORS.length)
    ];
  }
  const scale = foilPatternScale(canvasHeight, tex.naturalHeight);
  const sx =
    (((px / scale) % tex.naturalWidth) + tex.naturalWidth) % tex.naturalWidth;
  const sy =
    (((py / scale) % tex.naturalHeight) + tex.naturalHeight) %
    tex.naturalHeight;
  try {
    const [r, g, b] = scratchTextureSampler.getImageData(
      Math.floor(sx),
      Math.floor(sy),
      1,
      1,
    ).data;
    return rgbBytesToOklch(r, g, b);
  } catch {
    return FLAKE_FALLBACK_COLORS[
      Math.floor(Math.random() * FLAKE_FALLBACK_COLORS.length)
    ];
  }
}

function whenScratchTextureReady(notify: () => void): void {
  loadScratchTexture();
  if (scratchTextureReady) notify();
  else scratchTextureWaiters.push(notify);
}

loadScratchTexture();

type CoatingCanvas = HTMLCanvasElement & { __locked?: boolean };

type Flake = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  rotation: number;
  angularVel: number;
  color: string;
};

function paintBarCoating(canvas: CoatingCanvas): boolean {
  if (canvas.__locked) return true;
  const w = canvas.width;
  const h = canvas.height;
  if (w < 2 || h < 2) return false;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, w, h);

  // Fully opaque base — continuous foil across the whole pill.
  ctx.fillStyle = "oklch(0.673 0.009 67.67)";
  ctx.fillRect(0, 0, w, h);

  const tex = scratchTexture;
  if (scratchTextureReady && tex && tex.naturalWidth > 0) {
    const pattern = ctx.createPattern(tex, "repeat");
    if (pattern) {
      const scale = foilPatternScale(h, tex.naturalHeight);
      pattern.setTransform(new DOMMatrix().scale(scale, scale));
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, w, h);
    } else {
      const scale = Math.max(w / tex.naturalWidth, h / tex.naturalHeight);
      ctx.drawImage(
        tex,
        (w - tex.naturalWidth * scale) / 2,
        (h - tex.naturalHeight * scale) / 2,
        tex.naturalWidth * scale,
        tex.naturalHeight * scale,
      );
    }
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, "oklch(0.859 0.008 73.73)");
    g.addColorStop(0.5, "oklch(0.673 0.009 67.67)");
    g.addColorStop(1, "oklch(0.513 0.008 67.65)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    whenScratchTextureReady(() => {
      if (!canvas.__locked) paintBarCoating(canvas);
    });
  }

  // Shine on top of the crest tile — soft-light so embossing stays readable.
  ctx.save();
  ctx.globalCompositeOperation = "soft-light";
  const catchLight = ctx.createLinearGradient(0, 0, 0, h);
  catchLight.addColorStop(0, "oklch(1 0 0 / 0.55)");
  catchLight.addColorStop(0.28, "oklch(1 0 0 / 0.18)");
  catchLight.addColorStop(0.55, "oklch(1 0 0 / 0)");
  catchLight.addColorStop(1, "oklch(0.75 0.02 85 / 0.12)");
  ctx.fillStyle = catchLight;
  ctx.fillRect(0, 0, w, h);

  const gloss = ctx.createLinearGradient(0, 0, w, h);
  gloss.addColorStop(0, "oklch(1 0 0 / 0)");
  gloss.addColorStop(0.42, "oklch(1 0 0 / 0)");
  gloss.addColorStop(0.62, "oklch(1 0 0 / 0.35)");
  gloss.addColorStop(0.78, "oklch(0.95 0.04 90 / 0.2)");
  gloss.addColorStop(1, "oklch(1 0 0 / 0)");
  ctx.fillStyle = gloss;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  // Specular rim — thin highlight, not a wash.
  const rim = ctx.createLinearGradient(0, 0, 0, h * 0.35);
  rim.addColorStop(0, "oklch(1 0 0 / 0.28)");
  rim.addColorStop(1, "oklch(1 0 0 / 0)");
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, w, h);

  return true;
}

function stampBrush(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function stampStroke(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
): void {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const step = Math.max(1, r * BRUSH_STEP_RATIO);
  const n = Math.max(1, Math.ceil(dist / step));
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    stampBrush(ctx, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r);
  }
}

function measureSlotErased(
  canvas: HTMLCanvasElement,
  cx: number,
  cy: number,
  radius: number,
): number {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return 0;
  const left = Math.max(0, Math.floor(cx - radius));
  const top = Math.max(0, Math.floor(cy - radius));
  const size = Math.max(1, Math.ceil(radius * 2));
  const tw = Math.min(size, canvas.width - left);
  const th = Math.min(size, canvas.height - top);
  if (tw <= 0 || th <= 0) return 0;
  const { data, width, height } = ctx.getImageData(left, top, tw, th);
  let clear = 0;
  let total = 0;
  const r2 = radius * radius;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = left + x + 0.5 - cx;
      const dy = top + y + 0.5 - cy;
      if (dx * dx + dy * dy > r2) continue;
      total += 1;
      if (data[(y * width + x) * 4 + 3] < 40) clear += 1;
    }
  }
  return total === 0 ? 0 : clear / total;
}

export function TopSymbolBar({
  symbols,
  phase,
  onAllRevealed,
  roundKey = 0,
  forceRevealed = false,
  matchedSlots,
  shakingSlots,
  matchInFlight = false,
  shakeDelayMs,
  slotElsOutRef,
  freezeSymbols = false,
  preferStaticSymbols = false,
  quietDecorativeLottie = false,
  onScratchStart,
  onDockHiddenChange,
  holdAfterPointerMs = 0,
}: TopSymbolBarProps) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<CoatingCanvas | null>(null);
  const particleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const flakesRef = useRef<Flake[]>([]);
  const flakeRafRef = useRef<number | null>(null);
  const flakeLastTsRef = useRef<number | null>(null);
  const flakeDprRef = useRef(1);
  const slotElsRef = useRef<(HTMLDivElement | null)[]>(
    Array.from({ length: TOP_SYMBOL_COUNT }, () => null),
  );
  const paintedRef = useRef(false);
  const drawingRef = useRef(false);
  const lastPtRef = useRef<{ x: number; y: number } | null>(null);
  const revealedMaskRef = useRef<boolean[]>(
    Array.from({ length: TOP_SYMBOL_COUNT }, () => forceRevealed),
  );
  const notifiedRef = useRef(forceRevealed);
  const onAllRevealedRef = useRef(onAllRevealed);
  onAllRevealedRef.current = onAllRevealed;
  const onScratchStartRef = useRef(onScratchStart);
  onScratchStartRef.current = onScratchStart;
  useEffect(() => stopScratchSounds, []);

  const [revealedMask, setRevealedMask] = useState<boolean[]>(() =>
    Array.from({ length: TOP_SYMBOL_COUNT }, () => forceRevealed),
  );
  const [coatingDone, setCoatingDone] = useState(forceRevealed);
  const [clearedBurst, setClearedBurst] = useState(false);
  const [peelHidden, setPeelHidden] = useState(false);
  // Bumping this remounts DotLottieReact for the next peel cycle.
  const [peelPlayKey, setPeelPlayKey] = useState(0);
  /** Stage host for the full-screen flake layer (portaled out of the pill). */
  const [stageEl, setStageEl] = useState<HTMLElement | null>(null);
  /** Only mount the flake canvas once scratching starts — never during idle/load. */
  const [flakesActive, setFlakesActive] = useState(false);
  /**
   * Dock fly: keep center layout; WAAPI pure-px translateY+scale (opacity 1);
   * settle docked only after WAAPI finishes.
   */
  const [dockExiting, setDockExiting] = useState(false);
  /** One-shot "Scratch" text, started just before the dock climb. */
  const [scratchTextPlay, setScratchTextPlay] = useState(false);
  /** After the dock sequence settles, slide the bar up until a finger is down. */
  const [dockPeek, setDockPeek] = useState(false);
  /** Armed once the first hide starts, so the return slides instead of snapping. */
  const [dockAutohide, setDockAutohide] = useState(false);
  const dockPeekRef = useRef(false);
  dockPeekRef.current = dockPeek;
  const matchInFlightRef = useRef(matchInFlight);
  matchInFlightRef.current = matchInFlight;
  const wasMatchInFlightRef = useRef(matchInFlight);
  const onDockHiddenChangeRef = useRef(onDockHiddenChange);
  onDockHiddenChangeRef.current = onDockHiddenChange;
  const prevPhaseRef = useRef<TopBarPhase>(phase);
  /** Last center-phase bar rect (viewport coords). */
  const centerBarRectRef = useRef<DOMRect | null>(null);
  /** Bumps so a cancelled/stale rAF fly can't clear a newer one. */
  const dockFlyGenRef = useRef(0);
  const dockRafRef = useRef<number | null>(null);

  function clearDockInlineStyles(el: HTMLElement | null) {
    if (!el) return;
    el.style.top = "";
    el.style.left = "";
    el.style.right = "";
    el.style.marginLeft = "";
    el.style.marginRight = "";
    el.style.transform = "";
    el.style.opacity = "";
    el.style.filter = "";
    el.style.willChange = "";
  }

  function cancelDockAnim() {
    dockFlyGenRef.current += 1;
    if (dockRafRef.current != null) {
      cancelAnimationFrame(dockRafRef.current);
      dockRafRef.current = null;
    }
    clearDockInlineStyles(barRef.current);
  }

  /** Docked chrome top Y in viewport coordinates. */
  function dockTargetViewportY(el: HTMLElement): number {
    const stage = el.closest(".stage");
    const stageTop =
      stage instanceof HTMLElement ? stage.getBoundingClientRect().top : 0;
    const approx =
      Math.max(12, 0) +
      (typeof window !== "undefined" ? window.innerHeight * 0.015 : 8);
    try {
      const host = el.closest(".stage-game") ?? document.documentElement;
      const raw = getComputedStyle(host as Element)
        .getPropertyValue("--game-top-hud")
        .trim();
      if (raw.endsWith("px")) {
        return stageTop + (parseFloat(raw) || approx);
      }
    } catch {
      /* use approx */
    }
    return stageTop + approx;
  }

  const slots = symbols.slice(0, TOP_SYMBOL_COUNT);
  while (slots.length < TOP_SYMBOL_COUNT) slots.push(0);

  const showCoating = phase === "center" && !coatingDone && !forceRevealed;
  // Flakes only while the player is scratching (or the clear burst). Idle /
  // peel / entrance must not show a particle layer.
  const showParticles =
    flakesActive &&
    phase === "center" &&
    !forceRevealed &&
    (!coatingDone || clearedBurst);

  // Timed remount loop: play 3s → hold last frame 1.8s → remount + autoplay.
  // Does not rely on DotLottie's `complete` event (unreliable with this player).
  useEffect(() => {
    if (!showCoating || peelHidden) return;
    let cancelled = false;
    let cycleId = 0;

    const scheduleNextCycle = () => {
      cycleId = window.setTimeout(() => {
        if (cancelled) return;
        setPeelPlayKey((key) => key + 1);
        scheduleNextCycle();
      }, PEEL_LOTTIE_CYCLE_MS);
    };
    scheduleNextCycle();

    return () => {
      cancelled = true;
      window.clearTimeout(cycleId);
    };
  }, [showCoating, peelHidden, roundKey]);

  /** Slot circles in canvas-pixel space (from on-screen rects — mobile safe). */
  const slotGeometry = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return [];
    const cRect = canvas.getBoundingClientRect();
    if (cRect.width < 1 || cRect.height < 1) return [];
    const sx = canvas.width / cRect.width;
    const sy = canvas.height / cRect.height;
    return slotElsRef.current.map((el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        cx: (r.left + r.width / 2 - cRect.left) * sx,
        cy: (r.top + r.height / 2 - cRect.top) * sy,
        r: (Math.min(r.width, r.height) / 2) * ((sx + sy) / 2),
      };
    });
  }, []);

  /** Full-stage flake canvas so gravity can carry flecks past the small pill. */
  const syncParticleCanvasSize = useCallback(() => {
    const pc = particleCanvasRef.current;
    const stage = stageEl ?? barRef.current?.closest(".stage");
    if (!pc || !stage) return;
    const rect = stage.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    if (cssW < 2 || cssH < 2) return;
    // Beat product-embed cover rules (`.stage-game .stage > canvas…`) that
    // otherwise pin this layer to letterbox-center — flakes then draw off-screen
    // while :5080 (no stage-game cover) looks correct. Inline !important wins.
    const s = pc.style;
    s.setProperty("position", "absolute", "important");
    s.setProperty("inset", "0", "important");
    s.setProperty("left", "0", "important");
    s.setProperty("top", "0", "important");
    s.setProperty("right", "0", "important");
    s.setProperty("bottom", "0", "important");
    s.setProperty("width", "100%", "important");
    s.setProperty("height", "100%", "important");
    s.setProperty("max-width", "none", "important");
    s.setProperty("max-height", "none", "important");
    s.setProperty("transform", "none", "important");
    s.setProperty("border-radius", "0", "important");
    s.setProperty("pointer-events", "none", "important");
    s.setProperty("z-index", "10", "important");
    s.setProperty("display", "block", "important");
    const dpr = foilCanvasDpr();
    flakeDprRef.current = dpr;
    const nextW = Math.max(1, Math.round(cssW * dpr));
    const nextH = Math.max(1, Math.round(cssH * dpr));
    if (pc.width !== nextW || pc.height !== nextH) {
      pc.width = nextW;
      pc.height = nextH;
    }
  }, [stageEl]);

  const syncAndPaint = useCallback(() => {
    const bar = barRef.current;
    const canvas = canvasRef.current;
    if (!bar || !canvas || forceRevealed) return false;
    if (canvas.__locked) {
      paintedRef.current = true;
      syncParticleCanvasSize();
      return true;
    }

    // Always size from the visual box — matches touch mapping on mobile.
    const rect = bar.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    if (cssW < 40 || cssH < 20) return false;

    const dpr = foilCanvasDpr();
    const nextW = Math.max(1, Math.round(cssW * dpr));
    const nextH = Math.max(1, Math.round(cssH * dpr));

    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.borderRadius = "inherit";
    canvas.style.pointerEvents = "none";
    canvas.style.zIndex = "2";
    canvas.style.display = "block";
    syncParticleCanvasSize();

    if (canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW;
      canvas.height = nextH;
      paintedRef.current = false;
    }
    if (!paintedRef.current) {
      paintedRef.current = paintBarCoating(canvas);
    }
    return paintedRef.current;
  }, [forceRevealed, syncParticleCanvasSize]);

  useEffect(() => {
    revealedMaskRef.current = Array.from(
      { length: TOP_SYMBOL_COUNT },
      () => forceRevealed,
    );
    notifiedRef.current = forceRevealed;
    setRevealedMask(
      Array.from({ length: TOP_SYMBOL_COUNT }, () => forceRevealed),
    );
    setCoatingDone(forceRevealed);
    setClearedBurst(false);
    setScratchTextPlay(false);
    setPeelHidden(false);
    setPeelPlayKey(0);
    setFlakesActive(false);
    // Don't kill an in-flight center→dock climb on forceRevealed/symbols churn.
    if (dockRafRef.current == null) {
      cancelDockAnim();
      setDockExiting(false);
      prevPhaseRef.current = phase;
    }
    centerBarRectRef.current = null;
    drawingRef.current = false;
    lastPtRef.current = null;
    paintedRef.current = false;
    if (canvasRef.current) canvasRef.current.__locked = false;
    flakesRef.current = [];
    if (flakeRafRef.current !== null) {
      cancelAnimationFrame(flakeRafRef.current);
      flakeRafRef.current = null;
    }
    flakeLastTsRef.current = null;
    const pc = particleCanvasRef.current;
    if (pc) pc.getContext("2d")?.clearRect(0, 0, pc.width, pc.height);
    // phase intentionally omitted: dock fly is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- round/symbols/force only
  }, [symbols, forceRevealed, roundKey]);

  // Sample center bar while centered (mid-screen only).
  useLayoutEffect(() => {
    if (phase !== "center" && !dockExiting) return;
    const el = barRef.current;
    if (!el) return;
    if (!el.classList.contains("is-phase-center") && !dockExiting) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 8 && rect.height > 8 && rect.top > 80) {
      centerBarRectRef.current = DOMRect.fromRect(rect);
    }
  }, [phase, dockExiting]);

  // Center → docked: one rAF pixel climb. Gen-guarded; never cancelled by re-render.
  useLayoutEffect(() => {
    const prev = prevPhaseRef.current;

    if (phase === "docked" && prev === "center") {
      let reduced = false;
      try {
        reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      } catch {
        reduced = false;
      }
      if (reduced) {
        cancelDockAnim();
        setDockExiting(false);
        prevPhaseRef.current = "docked";
        return;
      }

      // Already flying — do not re-enter or cancel.
      if (dockRafRef.current != null) return;

      const el = barRef.current;
      if (!el) {
        prevPhaseRef.current = "docked";
        return;
      }

      const live = el.getBoundingClientRect();
      const stored = centerBarRectRef.current;
      const origin =
        live.width > 8 && live.height > 8 && live.top > 60
          ? live
          : stored && stored.height > 8 && stored.top > 60
            ? stored
            : null;
      if (!origin) {
        prevPhaseRef.current = "docked";
        return;
      }

      const stage = el.closest(".stage");
      const stageTop =
        stage instanceof HTMLElement ? stage.getBoundingClientRect().top : 0;
      const startTopPx = origin.top - stageTop;
      const dy = dockTargetViewportY(el) - origin.top;
      // Hold prevPhaseRef at "center" for visualPhase until finish.
      const gen = ++dockFlyGenRef.current;
      const durationMs = DOCK_FLY_MS;
      const t0 = performance.now();
      // Hold the DOM node in the closure — barRef can be briefly null on re-render
      // and a `if (!barRef.current) return` was aborting the climb at ~200ms.
      const node = el;

      setDockExiting(true);
      if (!quietDecorativeLottie) {
        const stage = node.closest(".stage");
        if (stage instanceof HTMLElement) setStageEl(stage);
        setScratchTextPlay(true);
      }

      node.style.top = `${startTopPx}px`;
      node.style.left = "50%";
      node.style.right = "auto";
      node.style.marginLeft = "0";
      node.style.marginRight = "0";
      node.style.willChange = "transform, filter";
      node.style.opacity = "1";
      node.style.filter = "blur(0px)";
      node.style.transform = "translateX(-50%) translateY(0px) scale(1)";
      node.dataset.dockFly = "1";
      node.dataset.dockFlyDy = String(Math.round(dy));
      node.dataset.dockFlyDur = String(durationMs);

      const finishFly = () => {
        if (dockFlyGenRef.current !== gen) return;
        if (dockRafRef.current != null) {
          cancelAnimationFrame(dockRafRef.current);
          dockRafRef.current = null;
        }
        delete node.dataset.dockFly;
        delete node.dataset.dockFlyDy;
        delete node.dataset.dockFlyDur;
        delete node.dataset.dockFlyT;
        delete node.dataset.dockFlyElapsed;

        // Handoff without flash:
        // 1) Pin the bar at the docked rest pose with inline styles still on.
        // 2) flip visualPhase → docked (is-phase-docked) in the same turn.
        // 3) ONLY THEN drop fly styles. Clearing while still is-phase-center
        //    painted the bar back at mid-screen for one frame (the flash).
        const stage = node.closest(".stage");
        const stageTop =
          stage instanceof HTMLElement
            ? stage.getBoundingClientRect().top
            : 0;
        const dockTopPx = Math.max(0, dockTargetViewportY(node) - stageTop);
        node.style.top = `${dockTopPx}px`;
        node.style.left = "50%";
        node.style.right = "auto";
        node.style.marginLeft = "0";
        node.style.marginRight = "0";
        node.style.transform = "translateX(-50%) translateY(0) scale(1)";
        node.style.opacity = "1";
        node.style.filter = "blur(0px)";
        node.style.willChange = "auto";

        prevPhaseRef.current = "docked";
        flushSync(() => {
          setDockExiting(false);
        });
        // DOM now has is-phase-docked; safe to release fly overrides.
        clearDockInlineStyles(node);
      };

      const tick = (now: number) => {
        if (dockFlyGenRef.current !== gen) return;

        const elapsed = now - t0;
        const t = Math.min(1, elapsed / durationMs);
        // 0–22%: anticipation opposite travel (dip + grow).
        // 22–100%: climb full measured dy with soft ease-in-out.
        let ty: number;
        let scale: number;
        let blur: number;
        if (t < 0.22) {
          const u = t / 0.22;
          // ease-out into the dip
          const e = 1 - (1 - u) * (1 - u);
          ty = 14 * e;
          scale = 1 + 0.08 * e;
          blur = DOCK_FLY_BLUR_PX * 0.25 * u;
        } else {
          const u = (t - 0.22) / 0.78;
          // smoothstep climb
          const e = u * u * (3 - 2 * u);
          ty = 14 + (dy - 14) * e;
          scale = 1.08 + (0.84 - 1.08) * e;
          // blur peaks mid-climb then clears for land
          blur = DOCK_FLY_BLUR_PX * Math.sin(Math.PI * u);
        }
        node.style.transform = `translateX(-50%) translateY(${ty}px) scale(${scale})`;
        node.style.filter = `blur(${blur.toFixed(2)}px)`;
        node.style.opacity = "1";

        if (t < 1) {
          dockRafRef.current = requestAnimationFrame(tick);
          return;
        }
        finishFly();
      };
      dockRafRef.current = requestAnimationFrame(tick);
      return;
    }

    // Leaving docked/center fly path — only cancel when going back to a non-dock phase.
    if (phase === "center" || phase === "showcase") {
      prevPhaseRef.current = phase;
      if (dockRafRef.current != null || dockExiting) {
        cancelDockAnim();
        setDockExiting(false);
      }
      return;
    }

    if (phase === "docked" && prevPhaseRef.current === "docked") {
      // Settled docked; peek/hide is handled below.
      return;
    }

    prevPhaseRef.current = phase;
  }, [phase, quietDecorativeLottie]);

  useEffect(() => {
    if (!scratchTextPlay) return;
    const id = window.setTimeout(
      () => setScratchTextPlay(false),
      SCRATCH_TEXT_LOTTIE_MS + 80,
    );
    return () => window.clearTimeout(id);
  }, [scratchTextPlay, roundKey]);

  useLayoutEffect(() => {
    const stage = barRef.current?.closest(".stage");
    setStageEl(stage instanceof HTMLElement ? stage : null);
  }, [phase, showCoating, roundKey]);

  // After the dock fly + grayscale cascade settle, slide the bar up out of view.
  // A finger on the screen brings it back; lifting hides it again. A symbol
  // still flying home holds the dock until it lands.
  useEffect(() => {
    if (phase !== "docked" || dockExiting) {
      setDockPeek(false);
      setDockAutohide(false);
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let hideTimer = 0;
    // Last symbol just landed on a dock we were holding — slide it now,
    // don't wait out another foil-settle.
    const landedWhileHeld =
      wasMatchInFlightRef.current && !matchInFlight && !dockPeekRef.current;
    wasMatchInFlightRef.current = matchInFlight;

    const hideDock = () => {
      if (matchInFlightRef.current && !dockPeekRef.current) return;
      setDockAutohide(true);
      setDockPeek(true);
    };
    const armHide = (delay: number) => {
      window.clearTimeout(hideTimer);
      // A symbol still climbing into a visible dock has to land first.
      // Once the dock is already up, later matches don't pull it back.
      if (matchInFlightRef.current && !dockPeekRef.current) return;
      hideTimer = window.setTimeout(hideDock, delay);
    };
    const show = () => {
      window.clearTimeout(hideTimer);
      setDockPeek(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".stage-game__auto-scratch")
      ) {
        return;
      }
      show();
    };
    const onPointerEnd = () => {
      if (dockPeekRef.current) return;
      const zoomHold =
        getScratchZoomEnabled() && holdAfterPointerMs > 0
          ? holdAfterPointerMs
          : 0;
      armHide(Math.max(DOCK_SETTLE_MS, zoomHold));
    };

    armHide(landedWhileHeld ? 0 : DOCK_SETTLE_MS);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerEnd, true);
    window.addEventListener("pointercancel", onPointerEnd, true);
    return () => {
      window.clearTimeout(hideTimer);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerEnd, true);
      window.removeEventListener("pointercancel", onPointerEnd, true);
      onDockHiddenChangeRef.current?.(false);
    };
  }, [phase, dockExiting, roundKey, matchInFlight, holdAfterPointerMs]);

  // AutoScratch fills the slot as soon as the dock leaves. A returning dock
  // hides it again.
  useEffect(() => {
    const hidden = phase === "docked" && !dockExiting && dockPeek;
    onDockHiddenChangeRef.current?.(hidden);
  }, [phase, dockExiting, dockPeek]);

  useEffect(() => {
    return () => {
      cancelDockAnim();
      if (flakeRafRef.current !== null)
        cancelAnimationFrame(flakeRafRef.current);
    };
  }, []);

  const stepFlakes = useCallback((ts: number) => {
    const pc = particleCanvasRef.current;
    if (!pc) {
      flakeRafRef.current = null;
      flakeLastTsRef.current = null;
      return;
    }
    const last = flakeLastTsRef.current;
    const dt = last === null ? 0 : Math.min(0.05, (ts - last) / 1000);
    flakeLastTsRef.current = ts;

    const dpr = flakeDprRef.current || 1;
    const next: Flake[] = [];
    for (const f of flakesRef.current) {
      const age = f.age + dt;
      if (age < f.life) {
        f.age = age;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        f.vy += FLAKE_GRAVITY * dpr * dt;
        f.rotation += f.angularVel * dt;
        next.push(f);
      }
    }
    flakesRef.current = next;

    const ctx = pc.getContext("2d");
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pc.width, pc.height);
      for (const f of next) {
        const t = f.age / f.life;
        const ease = 1 - (1 - t) * (1 - t);
        const size =
          f.size *
          (FLAKE_SCALE_MIN + (FLAKE_SCALE_MAX - FLAKE_SCALE_MIN) * ease);
        const alpha = t < 0.65 ? 1 : Math.max(0, 1 - (t - 0.65) / 0.35);
        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.rotate(f.rotation);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = f.color;
        ctx.beginPath();
        // Slightly irregular quad (not a perfect square) to read as a torn
        // fleck of foil rather than a clean particle.
        ctx.moveTo(-size, -size * 0.75);
        ctx.lineTo(size * 0.85, -size);
        ctx.lineTo(size, size * 0.7);
        ctx.lineTo(-size * 0.7, size);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    if (next.length > 0) {
      flakeRafRef.current = requestAnimationFrame(stepFlakes);
    } else {
      flakeRafRef.current = null;
      flakeLastTsRef.current = null;
      setFlakesActive(false);
    }
  }, []);

  /** Spawn at stage-canvas pixel coords; `sampleX/Y/H` stay in coating space
   * so flake color still matches the foil under the brush. Canvas mounts via
   * `flakesActive` — the layout effect below kicks the RAF once it's in the DOM. */
  const spawnFlakesAtStage = useCallback(
    (
      stageX: number,
      stageY: number,
      sampleX: number,
      sampleY: number,
      coatingHeight: number,
      count = FLAKE_COUNT_PER_SCRATCH,
    ) => {
      flakeDprRef.current = foilCanvasDpr();
      const dpr = flakeDprRef.current;
      const sizePx = FLAKE_BASE_SIZE_CSS * dpr;
      for (let i = 0; i < count; i += 1) {
        const angle = (Math.random() - 0.5) * Math.PI * 0.9;
        const speed = (70 + Math.random() * 110) * dpr;
        flakesRef.current.push({
          x: stageX + (Math.random() - 0.5) * 6 * dpr,
          y: stageY + (Math.random() - 0.5) * 6 * dpr,
          // Bias outward/down: small side scatter, then gravity takes over.
          vx: Math.sin(angle) * speed * 0.45,
          vy: (40 + Math.random() * 80) * dpr,
          age: 0,
          life: FLAKE_LIFE * (0.85 + Math.random() * 0.35),
          size: sizePx * (0.7 + Math.random() * 0.45),
          rotation: Math.random() * Math.PI * 2,
          angularVel: (Math.random() - 0.5) * 12,
          color: sampleScratchTextureColor(sampleX, sampleY, coatingHeight),
        });
      }
      while (flakesRef.current.length > FLAKE_MAX) flakesRef.current.shift();
      setFlakesActive(true);
      if (particleCanvasRef.current && flakeRafRef.current === null) {
        syncParticleCanvasSize();
        flakeLastTsRef.current = null;
        flakeRafRef.current = requestAnimationFrame(stepFlakes);
      }
    },
    [stepFlakes, syncParticleCanvasSize],
  );

  // Canvas is portaled only while flakes are active — size it and start the
  // loop as soon as the node lands (covers the first-scratch mount race).
  useLayoutEffect(() => {
    if (!showParticles) return;
    syncParticleCanvasSize();
    if (flakesRef.current.length > 0 && flakeRafRef.current === null) {
      flakeLastTsRef.current = null;
      flakeRafRef.current = requestAnimationFrame(stepFlakes);
    }
  }, [showParticles, stepFlakes, syncParticleCanvasSize]);

  // Foil just cleared — burst flakes across the bar, hold celebrate, then dock.
  useEffect(() => {
    if (!clearedBurst || phase !== "center" || forceRevealed) return;
    const bar = barRef.current;
    const stage = stageEl ?? bar?.closest(".stage");
    const coating = canvasRef.current;
    if (bar && stage && coating && coating.width > 1) {
      syncParticleCanvasSize();
      const barRect = bar.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const dpr = flakeDprRef.current || 1;
      for (let i = 0; i < 8; i += 1) {
        const cssX = barRect.left - stageRect.left + (barRect.width * (i + 0.5)) / 8;
        const cssY = barRect.top - stageRect.top + barRect.height * 0.45;
        spawnFlakesAtStage(
          cssX * dpr,
          cssY * dpr,
          (coating.width * (i + 0.5)) / 8,
          coating.height * 0.45,
          coating.height,
          3,
        );
      }
    }
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const delay = reduceMotion ? 0 : CLEAR_CELEBRATE_MS;
    const id = window.setTimeout(() => {
      onAllRevealedRef.current();
    }, delay);
    // Lead the dock fly so the text is already playing when the bar starts up.
    // Pin the portal host now — the bar is still centered, so .stage is stable.
    const lead = reduceMotion
      ? 0
      : Math.max(0, delay - SCRATCH_TEXT_LEAD_MS);
    const leadId =
      !quietDecorativeLottie && lead < delay
        ? window.setTimeout(() => {
            const host = barRef.current?.closest(".stage");
            if (host instanceof HTMLElement) setStageEl(host);
            setScratchTextPlay(true);
          }, lead)
        : 0;
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(leadId);
    };
  }, [
    clearedBurst,
    forceRevealed,
    phase,
    quietDecorativeLottie,
    spawnFlakesAtStage,
    stageEl,
    syncParticleCanvasSize,
  ]);

  useLayoutEffect(() => {
    if (!showCoating) return;
    let cancelled = false;
    let rafId = 0;

    // Mobile's fixed/dvh stage can report a 0×0 bar for several frames while
    // layout settles — keep retrying (bounded) instead of giving up after one rAF,
    // or the coating canvas is left blank/transparent and symbols show with no scratch.
    const tick = (attemptsLeft: number) => {
      if (cancelled) return;
      const painted = syncAndPaint();
      if (!painted && attemptsLeft > 0) {
        rafId = requestAnimationFrame(() => tick(attemptsLeft - 1));
      }
    };
    tick(60);

    const bar = barRef.current;
    const onWindowChange = () => {
      if (drawingRef.current || canvasRef.current?.__locked) return;
      tick(10);
    };
    window.addEventListener("resize", onWindowChange);
    window.addEventListener("orientationchange", onWindowChange);

    let ro: ResizeObserver | undefined;
    if (bar && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        if (drawingRef.current || canvasRef.current?.__locked) return;
        tick(10);
      });
      ro.observe(bar);
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onWindowChange);
      window.removeEventListener("orientationchange", onWindowChange);
      ro?.disconnect();
    };
  }, [showCoating, roundKey, syncAndPaint]);

  const checkReveals = useCallback(() => {
    if (!paintedRef.current || !canvasRef.current?.__locked) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const geo = slotGeometry();
    let changed = false;
    const next = revealedMaskRef.current.slice();
    for (let i = 0; i < TOP_SYMBOL_COUNT; i += 1) {
      if (next[i]) continue;
      const slot = geo[i];
      if (!slot) continue;
      if (
        measureSlotErased(canvas, slot.cx, slot.cy, slot.r) <
        SLOT_REVEAL_THRESHOLD
      )
        continue;
      next[i] = true;
      changed = true;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "oklch(0 0 0)";
      ctx.beginPath();
      ctx.arc(slot.cx, slot.cy, slot.r + 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
    }
    if (!changed) return;
    revealedMaskRef.current = next;
    setRevealedMask(next);
    if (next.every(Boolean) && !notifiedRef.current) {
      notifiedRef.current = true;
      setCoatingDone(true);
      setClearedBurst(true);
      stopScratchSounds();
    }
  }, [slotGeometry]);

  const scratchAt = useCallback(
    (clientX: number, clientY: number) => {
      if (coatingDone || phase !== "center") return;
      if (!paintedRef.current && !syncAndPaint()) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const cRect = canvas.getBoundingClientRect();
      if (cRect.width < 1 || cRect.height < 1) return;

      const x = ((clientX - cRect.left) / cRect.width) * canvas.width;
      const y = ((clientY - cRect.top) / cRect.height) * canvas.height;
      const brush =
        BRUSH_RADIUS_CSS *
        ((canvas.width / cRect.width + canvas.height / cRect.height) / 2);

      // Erase anywhere over the bar — the whole foil is scratchable, not just
      // the tight circle around each symbol. Reveal is still measured per
      // circle in checkReveals, independent of where the brush actually landed.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "oklch(0 0 0)";
      const last = lastPtRef.current;
      if (last) stampStroke(ctx, last.x, last.y, x, y, brush);
      else stampBrush(ctx, x, y, brush);

      lastPtRef.current = { x, y };
      canvas.__locked = true;
      noteScratchSoundActivity();
      // First scratch stroke — peel cue gets out of the way immediately.
      setPeelHidden(true);

      const stage = stageEl ?? barRef.current?.closest(".stage");
      if (stage) {
        syncParticleCanvasSize();
        const stageRect = stage.getBoundingClientRect();
        const dpr = flakeDprRef.current || 1;
        spawnFlakesAtStage(
          (clientX - stageRect.left) * dpr,
          (clientY - stageRect.top) * dpr,
          x,
          y,
          canvas.height,
        );
      }
      checkReveals();
    },
    [
      checkReveals,
      coatingDone,
      phase,
      spawnFlakesAtStage,
      stageEl,
      syncAndPaint,
      syncParticleCanvasSize,
    ],
  );

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (coatingDone || phase !== "center") return;
    e.preventDefault();
    e.stopPropagation();
    drawingRef.current = true;
    lastPtRef.current = null;
    // Parent uses this to reverse-animate cards-left off on first foil stroke.
    onScratchStartRef.current?.();
    e.currentTarget.setPointerCapture(e.pointerId);
    scratchAt(e.clientX, e.clientY);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drawingRef.current || coatingDone || phase !== "center") return;
    e.preventDefault();
    e.stopPropagation();
    scratchAt(e.clientX, e.clientY);
  }

  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    drawingRef.current = false;
    lastPtRef.current = null;
    stopScratchSounds();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  const revealedCount = revealedMask.filter(Boolean).length;
  const particleHost =
    stageEl ??
    (barRef.current?.closest(".stage") instanceof HTMLElement
      ? (barRef.current.closest(".stage") as HTMLElement)
      : null);

  // Keep center layout for the WHOLE fly — including the first paint after
  // parent sets phase=docked (dockExiting state hasn't committed yet).
  // prevPhaseRef is only advanced in the dock layout effect, so it still
  // reads "center" on that first docked render.
  const visualPhase: TopBarPhase =
    dockExiting || (phase === "docked" && prevPhaseRef.current === "center")
      ? "center"
      : phase;
  const settleDocked = visualPhase === "docked";

  return (
    <div
      ref={barRef}
      data-tutorial-target="foil"
      className={`symbol-bar top-symbol-bar is-phase-${visualPhase}${
        revealedCount >= TOP_SYMBOL_COUNT ? " is-symbols-complete" : ""
      }${showCoating ? " is-scratchable" : ""}${
        clearedBurst && !dockExiting ? " is-cleared" : ""
      }${forceRevealed ? " is-force-revealed" : ""}${
        dockExiting ? " is-dock-exiting" : ""
      }${dockAutohide && visualPhase === "docked" ? " is-dock-autohide" : ""}${
        dockPeek && visualPhase === "docked" ? " is-dock-peek" : ""
      }`}
      aria-label="Match symbols — scratch to reveal"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={
        {
          touchAction: "none",
          "--match-shake-start-ms": `${MATCH_SHAKE_START_MS}ms`,
          "--match-shake-cycle-ms": `${MATCH_SHAKE_CYCLE_MS}ms`,
          "--match-shake-cycles": `${MATCH_SHAKE_CYCLES}`,
        } as CSSProperties
      }
    >
      {slots.map((typeId, index) => {
        const revealed =
          revealedMask[index] || forceRevealed || phase === "showcase";
        const matched = Boolean(matchedSlots?.[index]);
        const shaking = Boolean(shakingSlots?.[index]);
        const dormant =
          (settleDocked || phase === "showcase") &&
          revealed &&
          !matched &&
          !shaking;
        const pulsing = phase === "showcase" && matched;
        const slotShakeDelay = shakeDelayMs?.[index] ?? 0;
        return (
          <div
            key={`${roundKey}-${index}-${typeId}`}
            ref={(el) => {
              slotElsRef.current[index] = el;
              if (slotElsOutRef) slotElsOutRef.current[index] = el;
            }}
            className={`symbol-slot top-symbol-slot${
              revealed ? " is-revealed" : ""
            }${dormant ? " is-dormant" : ""}${matched ? " is-matched" : ""}${
              pulsing ? " is-pulsing" : ""
            }${shaking ? " is-match-shaking" : ""}`}
            style={
              shaking
                ? ({
                    "--match-delay-ms": `${slotShakeDelay}ms`,
                  } as CSSProperties)
                : undefined
            }
            title={revealed ? SYMBOL_TYPES[typeId]?.label : "Scratch to reveal"}
          >
            <GameSymbolIcon
              typeId={typeId}
              // 28px when first revealed (center) and when docked.
              size={28}
              pixelScale={2}
              preferStatic={preferStaticSymbols}
              // Only animate during the center foil reveal. Docked / showcase
              // use CSS (dormant desat, pulse) — keeps DotLottie workers frozen
              // for the whole hunt, which is the long expensive stretch.
              paused={
                freezeSymbols ||
                !revealed ||
                dormant ||
                visualPhase !== "center"
              }
            />
          </div>
        );
      })}
      {showCoating ? (
        <canvas
          ref={canvasRef}
          className="top-symbol-bar-scratch-canvas"
          aria-hidden="true"
        />
      ) : null}
      {showCoating && !quietDecorativeLottie ? (
        <div
          className={`lottie-clipper${peelHidden ? " is-faded" : ""}`}
          aria-hidden="true"
        >
          <div className="lottie-clipper-peel">
            <DotLottieReact
              key={`peel-${roundKey}-${peelPlayKey}`}
              src={PEEL_LOTTIE_SRC}
              autoplay
              loop={false}
              width={PEEL_LOTTIE_WIDTH}
              height={PEEL_LOTTIE_WIDTH}
              className="lottie-clipper-peel-player"
              renderConfig={lottieRenderConfig({
                extraScale: 1.8,
                autoResize: false,
              })}
              style={{
                width: "100%",
                height: "100%",
                pointerEvents: "none",
              }}
            />
          </div>
        </div>
      ) : null}
      {showParticles && particleHost
        ? createPortal(
            // Wrapper div: product embed CSS targets `.stage > canvas` for
            // video cover. A bare flake <canvas> matched that and drew off-screen
            // (https://localhost:5080 has no stage-game cover, so it looked fine).
            <div
              className="top-symbol-bar-particle-layer"
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                pointerEvents: "none",
                zIndex: 10,
                overflow: "visible",
              }}
            >
              <canvas
                ref={particleCanvasRef}
                className="top-symbol-bar-particle-canvas"
                aria-hidden="true"
              />
            </div>,
            particleHost,
          )
        : null}
      {scratchTextPlay && particleHost
        ? createPortal(
            <div
              className="scratch-text-lottie"
              aria-hidden="true"
              style={{ pointerEvents: "none" }}
            >
              <DotLottieReact
                key={`scratch-text-${roundKey}`}
                src={SCRATCH_TEXT_LOTTIE_SRC}
                autoplay
                loop={false}
                className="scratch-text-lottie-player"
                renderConfig={lottieRenderConfig({ autoResize: false })}
                style={{
                  width: "100%",
                  height: "100%",
                  pointerEvents: "none",
                }}
              />
            </div>,
            particleHost,
          )
        : null}
    </div>
  );
}
