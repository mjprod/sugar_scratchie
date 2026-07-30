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
const scratchTextureWaiters: Array<() => void> = [];

function loadScratchTexture(): void {
  if (scratchTexture) return;
  const img = new Image();
  scratchTexture = img;
  img.decoding = "async";
  img.onload = () => {
    scratchTextureReady = true;
    for (const notify of scratchTextureWaiters.splice(0)) notify();
  };
  img.onerror = () => {
    scratchTexture = null;
    scratchTextureReady = false;
  };
  img.src = SCRATCH_TEXTURE_URL;
}

function whenScratchTextureReady(notify: () => void): void {
  loadScratchTexture();
  if (scratchTextureReady) notify();
  else scratchTextureWaiters.push(notify);
}

loadScratchTexture();

type CoatingCanvas = HTMLCanvasElement & { __locked?: boolean };

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

  const slots = symbols.slice(0, TOP_SYMBOL_COUNT);
  while (slots.length < TOP_SYMBOL_COUNT) slots.push(0);

  const showCoating = phase === "center" && !coatingDone && !forceRevealed;

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

  const syncAndPaint = useCallback(() => {
    const bar = barRef.current;
    const canvas = canvasRef.current;
    if (!bar || !canvas || forceRevealed) return false;
    if (canvas.__locked) {
      paintedRef.current = true;
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

    if (canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW;
      canvas.height = nextH;
      paintedRef.current = false;
    }
    if (!paintedRef.current) {
      paintedRef.current = paintBarCoating(canvas);
    }
    return paintedRef.current;
  }, [forceRevealed]);

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
    drawingRef.current = false;
    lastPtRef.current = null;
    paintedRef.current = false;
    if (canvasRef.current) canvasRef.current.__locked = false;
  }, [symbols, forceRevealed, roundKey]);

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
      if (measureSlotErased(canvas, slot.cx, slot.cy, slot.r) < SLOT_REVEAL_THRESHOLD)
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
      checkReveals();
    },
    [checkReveals, coatingDone, phase, syncAndPaint],
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
            <GameSymbolIcon typeId={typeId} size={28} />
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
    </div>
  );
}
