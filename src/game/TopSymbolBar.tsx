import { DotLottieReact } from "@lottiefiles/dotlottie-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { GameSymbolIcon } from "./GameSymbolIcon";
import { SYMBOL_TYPES, TOP_SYMBOL_COUNT } from "./matchGame";

const BRUSH_RADIUS_CSS = 12;
const SLOT_REVEAL_THRESHOLD = 0.55;
const SCRATCH_TEXTURE_URL = "/scratch/scratchTexture.jpg";
const BRUSH_STEP_RATIO = 0.35;
/** Decorative peel cue on the left edge of the centered scratch bar. */
const PEEL_LOTTIE_SRC = "/lotties/Peel.lottie";
const PEEL_LOTTIE_WIDTH = 52;
/** Peel.lottie is 180 frames @ 60fps (see public/lotties/Peel.lottie). */
const PEEL_LOTTIE_DURATION_MS = Math.round((180 / 60) * 1000);
/** Hold the last frame this long before remounting for the next play. */
const PEEL_LOTTIE_PAUSE_MS = 1800;
const PEEL_LOTTIE_CYCLE_MS = PEEL_LOTTIE_DURATION_MS + PEEL_LOTTIE_PAUSE_MS;
/** Beat after foil clears before the bar flies up to dock. */
const CLEAR_CELEBRATE_MS = 420;

// Flying foil flakes on scratch — colored by sampling the scratch coating.
// Sized in CSS pixels (converted with DPR at spawn) so they stay small on
// retina. Portaled to the full `.stage` so gravity can carry them off-screen.
const FLAKE_COUNT_PER_SCRATCH = 2;
const FLAKE_MAX = 90;
const FLAKE_LIFE = 1.15;
const FLAKE_SCALE_MIN = 0.5;
const FLAKE_SCALE_MAX = 0.85;
/** Base half-extent in CSS px before DPR. */
const FLAKE_BASE_SIZE_CSS = 3.6;
const FLAKE_GRAVITY = 980;
const FLAKE_FALLBACK_COLORS = [
  "#d4d0cb",
  "#b5b0aa",
  "#9a9590",
  "#847f7a",
  "#6a6662",
];

export type TopBarPhase = "center" | "docked" | "showcase";

/** Fly back to center + pulse matched finds before advancing. */
export const TOP_BAR_SHOWCASE_MS = 2400;

type TopSymbolBarProps = {
  symbols: number[];
  phase: TopBarPhase;
  onAllRevealed: () => void;
  roundKey?: string | number;
  forceRevealed?: boolean;
  /** Docked hunt: slots that have been found on the body (full color again). */
  matchedSlots?: boolean[];
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
  const scale = Math.max((canvasHeight / tex.naturalHeight) * 1.15, 1);
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
    return `rgb(${r}, ${g}, ${b})`;
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
  ctx.clearRect(0, 0, w, h);

  // Fully opaque base — continuous foil across the whole pill.
  ctx.fillStyle = "#9a9590";
  ctx.fillRect(0, 0, w, h);

  const tex = scratchTexture;
  if (scratchTextureReady && tex && tex.naturalWidth > 0) {
    const pattern = ctx.createPattern(tex, "repeat");
    if (pattern) {
      const scale = Math.max((h / tex.naturalHeight) * 1.15, 1);
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
    g.addColorStop(0, "#d4d0cb");
    g.addColorStop(0.5, "#9a9590");
    g.addColorStop(1, "#6a6662");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    whenScratchTextureReady(() => {
      if (!canvas.__locked) paintBarCoating(canvas);
    });
  }

  const hi = ctx.createLinearGradient(0, 0, 0, h * 0.4);
  hi.addColorStop(0, "rgba(255,255,255,0.2)");
  hi.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = hi;
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
    const dpr = Math.min(3, window.devicePixelRatio || 1);
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

    const dpr = Math.min(3, window.devicePixelRatio || 1);
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
    setPeelHidden(false);
    setPeelPlayKey(0);
    setFlakesActive(false);
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
  }, [symbols, forceRevealed, roundKey]);

  useLayoutEffect(() => {
    const stage = barRef.current?.closest(".stage");
    setStageEl(stage instanceof HTMLElement ? stage : null);
  }, [phase, showCoating, roundKey]);

  useEffect(() => {
    return () => {
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
      flakeDprRef.current = Math.min(3, window.devicePixelRatio || 1);
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
    return () => window.clearTimeout(id);
  }, [
    clearedBurst,
    forceRevealed,
    phase,
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
      ctx.fillStyle = "#000";
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
      ctx.fillStyle = "#000";
      const last = lastPtRef.current;
      if (last) stampStroke(ctx, last.x, last.y, x, y, brush);
      else stampBrush(ctx, x, y, brush);

      lastPtRef.current = { x, y };
      canvas.__locked = true;
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

  return (
    <div
      ref={barRef}
      className={`symbol-bar top-symbol-bar is-phase-${phase}${
        revealedCount >= TOP_SYMBOL_COUNT ? " is-symbols-complete" : ""
      }${showCoating ? " is-scratchable" : ""}${
        clearedBurst ? " is-cleared" : ""
      }`}
      aria-label="Match symbols — scratch to reveal"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{ touchAction: "none" }}
    >
      {slots.map((typeId, index) => {
        const revealed = revealedMask[index] || forceRevealed || phase === "showcase";
        const matched = Boolean(matchedSlots?.[index]);
        const dormant =
          (phase === "docked" || phase === "showcase") && revealed && !matched;
        const pulsing = phase === "showcase" && matched;
        return (
          <div
            key={`${roundKey}-${index}-${typeId}`}
            ref={(el) => {
              slotElsRef.current[index] = el;
            }}
            className={`symbol-slot top-symbol-slot${
              revealed ? " is-revealed" : ""
            }${dormant ? " is-dormant" : ""}${matched ? " is-matched" : ""}${
              pulsing ? " is-pulsing" : ""
            }`}
            title={revealed ? SYMBOL_TYPES[typeId]?.label : "Scratch to reveal"}
          >
            <GameSymbolIcon
              typeId={typeId}
              size={28}
              paused={!revealed || dormant}
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
      {showCoating ? (
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
            <canvas
              ref={particleCanvasRef}
              className="top-symbol-bar-particle-canvas"
              aria-hidden="true"
            />,
            particleHost,
          )
        : null}
    </div>
  );
}
