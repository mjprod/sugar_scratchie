import { DotLottieReact } from "@lottiefiles/dotlottie-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
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

// Flying foil flakes on scratch — same feel as the main game's fabric flakes
// (glRenderer's spawnFlakes/drawFlakes), but colored by sampling the actual
// scratch-coating texture instead of the video fabric.
const FLAKE_COUNT_PER_SCRATCH = 2;
const FLAKE_MAX = 90;
const FLAKE_LIFE = 0.7;
const FLAKE_SCALE_MIN = 0.5;
const FLAKE_SCALE_MAX = 1.1;
const FLAKE_BASE_SIZE = 6;
const FLAKE_GRAVITY = 800;
/** Extra canvas height below the bar (as a multiple of bar height) so flakes
 * stay drawable while gravity pulls them past the pill. */
const FLAKE_FALL_EXTEND_RATIO = 1.2;
const FLAKE_FALLBACK_COLORS = [
  "#d4d0cb",
  "#b5b0aa",
  "#9a9590",
  "#847f7a",
  "#6a6662",
];

export type TopBarPhase = "center" | "docked";

type TopSymbolBarProps = {
  symbols: number[];
  phase: TopBarPhase;
  onAllRevealed: () => void;
  roundKey?: string | number;
  forceRevealed?: boolean;
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
}: TopSymbolBarProps) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<CoatingCanvas | null>(null);
  const particleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const flakesRef = useRef<Flake[]>([]);
  const flakeRafRef = useRef<number | null>(null);
  const flakeLastTsRef = useRef<number | null>(null);
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
  const [peelHidden, setPeelHidden] = useState(false);
  // Bumping this remounts DotLottieReact for the next peel cycle.
  const [peelPlayKey, setPeelPlayKey] = useState(0);

  const slots = symbols.slice(0, TOP_SYMBOL_COUNT);
  while (slots.length < TOP_SYMBOL_COUNT) slots.push(0);

  const showCoating = phase === "center" && !coatingDone && !forceRevealed;

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

  /** Particle canvas matches coating width and X/Y origin, but extends below
   * the bar so falling flakes aren't clipped at the pill edge. */
  const syncParticleCanvasSize = useCallback((w: number, h: number) => {
    const pc = particleCanvasRef.current;
    if (!pc) return;
    const ph = Math.max(1, Math.round(h * (1 + FLAKE_FALL_EXTEND_RATIO)));
    pc.style.position = "absolute";
    pc.style.inset = "auto";
    pc.style.top = "0";
    pc.style.left = "0";
    pc.style.width = "100%";
    pc.style.height = `${(ph / Math.max(1, h)) * 100}%`;
    pc.style.pointerEvents = "none";
    pc.style.display = "block";
    if (pc.width !== w || pc.height !== ph) {
      pc.width = w;
      pc.height = ph;
    }
  }, []);

  const syncAndPaint = useCallback(() => {
    const bar = barRef.current;
    const canvas = canvasRef.current;
    if (!bar || !canvas || forceRevealed) return false;
    if (canvas.__locked) {
      paintedRef.current = true;
      syncParticleCanvasSize(canvas.width, canvas.height);
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
    syncParticleCanvasSize(nextW, nextH);

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
    setPeelHidden(false);
    setPeelPlayKey(0);
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

    const next: Flake[] = [];
    for (const f of flakesRef.current) {
      const age = f.age + dt;
      if (age < f.life) {
        f.age = age;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        f.vy += FLAKE_GRAVITY * dt;
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
    }
  }, []);

  const spawnFlakes = useCallback(
    (
      x: number,
      y: number,
      canvasHeight: number,
      count = FLAKE_COUNT_PER_SCRATCH,
    ) => {
      for (let i = 0; i < count; i += 1) {
        const angle = (Math.random() - 0.5) * Math.PI * 0.9;
        const speed = 50 + Math.random() * 70;
        flakesRef.current.push({
          x: x + (Math.random() - 0.5) * 6,
          y: y + (Math.random() - 0.5) * 6,
          // Bias outward/down: small side scatter, then gravity takes over.
          vx: Math.sin(angle) * speed * 0.55,
          vy: 60 + Math.random() * 90,
          age: 0,
          life: FLAKE_LIFE * (0.85 + Math.random() * 0.3),
          size: FLAKE_BASE_SIZE * (0.75 + Math.random() * 0.5),
          rotation: Math.random() * Math.PI * 2,
          angularVel: (Math.random() - 0.5) * 10,
          color: sampleScratchTextureColor(x, y, canvasHeight),
        });
      }
      while (flakesRef.current.length > FLAKE_MAX) flakesRef.current.shift();
      if (flakeRafRef.current === null) {
        flakeLastTsRef.current = null;
        flakeRafRef.current = requestAnimationFrame(stepFlakes);
      }
    },
    [stepFlakes],
  );

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
      onAllRevealedRef.current();
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
      spawnFlakes(x, y, canvas.height);
      checkReveals();
    },
    [checkReveals, coatingDone, phase, spawnFlakes, syncAndPaint],
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

  return (
    <div
      ref={barRef}
      className={`symbol-bar top-symbol-bar is-phase-${phase}${
        revealedCount >= TOP_SYMBOL_COUNT ? " is-symbols-complete" : ""
      }${showCoating ? " is-scratchable" : ""}`}
      aria-label="Match symbols — scratch to reveal"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{ touchAction: "none" }}
    >
      {slots.map((typeId, index) => {
        const revealed = revealedMask[index] || forceRevealed;
        return (
          <div
            key={`${roundKey}-${index}-${typeId}`}
            ref={(el) => {
              slotElsRef.current[index] = el;
            }}
            className={`symbol-slot top-symbol-slot${
              revealed ? " is-revealed" : ""
            }`}
            title={revealed ? SYMBOL_TYPES[typeId]?.label : "Scratch to reveal"}
          >
            <GameSymbolIcon typeId={typeId} size={28} paused={!revealed} />
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
        <canvas
          ref={particleCanvasRef}
          className="top-symbol-bar-particle-canvas"
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
    </div>
  );
}
