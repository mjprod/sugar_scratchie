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

const BRUSH_RADIUS_CSS = 10;
/** Need most of each circle cleared before it counts as revealed. */
const SLOT_REVEAL_THRESHOLD = 0.58;
const SCRATCH_TEXTURE_URL = "/scratch/scratchTexture.jpg";
const FALLBACK_CSS_W = 332;
const FALLBACK_CSS_H = 64;
/** Distance between soft brush stamps along a stroke (fraction of brush radius). */
const BRUSH_STEP_RATIO = 0.35;

export type TopBarPhase = "center" | "docked";

type TopSymbolBarProps = {
  symbols: number[];
  phase: TopBarPhase;
  onAllRevealed: () => void;
  /** Bumps when a new round starts so scratch coatings remount. */
  roundKey?: string | number;
  /** When true, slots are fully revealed without scratching. */
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
    const waiters = scratchTextureWaiters.splice(0);
    for (const notify of waiters) notify();
  };
  img.onerror = () => {
    scratchTexture = null;
    scratchTextureReady = false;
  };
  img.src = SCRATCH_TEXTURE_URL;
}

function whenScratchTextureReady(notify: () => void): void {
  loadScratchTexture();
  if (scratchTextureReady) {
    notify();
    return;
  }
  scratchTextureWaiters.push(notify);
}

loadScratchTexture();

type CoatingCanvas = HTMLCanvasElement & { __scratchLocked?: boolean };

function paintBarCoating(canvas: CoatingCanvas): boolean {
  // Never wipe a canvas the player has already scratched.
  if (canvas.__scratchLocked) return true;

  const w = canvas.width;
  const h = canvas.height;
  if (w < 2 || h < 2) return false;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#a8a39e";
  ctx.fillRect(0, 0, w, h);

  const tex = scratchTexture;
  if (scratchTextureReady && tex && tex.naturalWidth > 0) {
    const pattern = ctx.createPattern(tex, "repeat");
    if (pattern) {
      const scale = Math.max(h / tex.naturalHeight, 1);
      pattern.setTransform(new DOMMatrix().scale(scale, scale));
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, w, h);
    } else {
      const scale = Math.max(w / tex.naturalWidth, h / tex.naturalHeight);
      const dw = tex.naturalWidth * scale;
      const dh = tex.naturalHeight * scale;
      ctx.drawImage(tex, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }
  } else {
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, "#e4e0db");
    gradient.addColorStop(0.45, "#a8a39e");
    gradient.addColorStop(1, "#6f6b67");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    whenScratchTextureReady(() => {
      if (!canvas.__scratchLocked) paintBarCoating(canvas);
    });
  }

  const highlight = ctx.createLinearGradient(0, 0, 0, h * 0.4);
  highlight.addColorStop(0, "rgba(255,255,255,0.28)");
  highlight.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = highlight;
  ctx.fillRect(0, 0, w, h);
  return true;
}

function applyCanvasOverlayStyles(el: HTMLCanvasElement): void {
  el.style.position = "absolute";
  el.style.left = "0";
  el.style.top = "0";
  el.style.right = "0";
  el.style.bottom = "0";
  el.style.width = "100%";
  el.style.height = "100%";
  el.style.borderRadius = "inherit";
  el.style.pointerEvents = "none";
  el.style.zIndex = "2";
  el.style.display = "block";
}

/** Soft round eraser — feathered edge instead of a hard jagged stamp. */
function stampSoftBrush(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
): void {
  const gradient = ctx.createRadialGradient(
    x,
    y,
    radius * 0.12,
    x,
    y,
    radius,
  );
  gradient.addColorStop(0, "rgba(0,0,0,1)");
  gradient.addColorStop(0.45, "rgba(0,0,0,0.9)");
  gradient.addColorStop(0.75, "rgba(0,0,0,0.45)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function stampSoftBrushStroke(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
): void {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const step = Math.max(1, radius * BRUSH_STEP_RATIO);
  const stamps = Math.max(1, Math.ceil(dist / step));
  for (let i = 0; i <= stamps; i += 1) {
    const t = i / stamps;
    stampSoftBrush(ctx, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius);
  }
}

function measureSlotErasedRatio(
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
  const maxW = Math.min(size, canvas.width - left);
  const maxH = Math.min(size, canvas.height - top);
  if (maxW <= 0 || maxH <= 0) return 0;
  const { data, width, height } = ctx.getImageData(left, top, maxW, maxH);
  let transparent = 0;
  let total = 0;
  const r2 = radius * radius;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = left + x + 0.5 - cx;
      const dy = top + y + 0.5 - cy;
      if (dx * dx + dy * dy > r2) continue;
      total += 1;
      if (data[(y * width + x) * 4 + 3] < 40) transparent += 1;
    }
  }
  return total === 0 ? 0 : transparent / total;
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
  const scratchedRef = useRef(false);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
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

  const slotCanvasGeometry = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return [];
    const canvasRect = canvas.getBoundingClientRect();
    if (canvasRect.width <= 0 || canvasRect.height <= 0) return [];
    const sx = canvas.width / canvasRect.width;
    const sy = canvas.height / canvasRect.height;
    return slotElsRef.current.map((el) => {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        cx: (rect.left + rect.width / 2 - canvasRect.left) * sx,
        cy: (rect.top + rect.height / 2 - canvasRect.top) * sy,
        r: (Math.min(rect.width, rect.height) / 2) * ((sx + sy) / 2),
      };
    });
  }, []);

  const ensureCoatingPainted = useCallback(() => {
    const bar = barRef.current;
    const canvas = canvasRef.current;
    if (!bar || !canvas || forceRevealed) return false;
    if (scratchedRef.current || canvas.__scratchLocked) {
      paintedRef.current = true;
      return true;
    }

    applyCanvasOverlayStyles(canvas);

    const measuredW = Math.round(bar.clientWidth);
    const measuredH = Math.round(bar.clientHeight);
    const cssW = measuredW >= 40 ? measuredW : FALLBACK_CSS_W;
    const cssH = measuredH >= 20 ? measuredH : FALLBACK_CSS_H;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const nextW = Math.max(1, Math.round(cssW * dpr));
    const nextH = Math.max(1, Math.round(cssH * dpr));

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
    lastPointRef.current = null;
    scratchedRef.current = false;
    paintedRef.current = false;
    if (canvasRef.current) canvasRef.current.__scratchLocked = false;
  }, [symbols, forceRevealed, roundKey]);

  // Paint once when the coating mounts / round resets — never from reveal re-renders.
  useLayoutEffect(() => {
    if (!showCoating) return;
    ensureCoatingPainted();
    const raf = requestAnimationFrame(() => ensureCoatingPainted());
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === "undefined") {
      return () => cancelAnimationFrame(raf);
    }
    const observer = new ResizeObserver(() => {
      if (drawingRef.current || scratchedRef.current) return;
      ensureCoatingPainted();
    });
    observer.observe(bar);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [ensureCoatingPainted, showCoating, roundKey]);

  const checkReveals = useCallback(() => {
    if (!paintedRef.current || !scratchedRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const geometry = slotCanvasGeometry();
    let changed = false;
    const next = revealedMaskRef.current.slice();
    for (let i = 0; i < TOP_SYMBOL_COUNT; i += 1) {
      if (next[i]) continue;
      const slot = geometry[i];
      if (!slot) continue;
      if (
        measureSlotErasedRatio(canvas, slot.cx, slot.cy, slot.r) >=
        SLOT_REVEAL_THRESHOLD
      ) {
        next[i] = true;
        changed = true;
      }
    }
    if (!changed) return;
    revealedMaskRef.current = next;
    setRevealedMask(next);
    if (next.every(Boolean) && !notifiedRef.current) {
      notifiedRef.current = true;
      setCoatingDone(true);
      onAllRevealedRef.current();
    }
  }, [slotCanvasGeometry]);

  const scratchAt = useCallback(
    (clientX: number, clientY: number) => {
      if (coatingDone || phase !== "center") return;
      if (!paintedRef.current) {
        ensureCoatingPainted();
        if (!paintedRef.current) return;
      }
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x = (clientX - rect.left) * scaleX;
      const y = (clientY - rect.top) * scaleY;
      const brush = BRUSH_RADIUS_CSS * ((scaleX + scaleY) / 2);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "destination-out";
      const last = lastPointRef.current;
      if (last) {
        stampSoftBrushStroke(ctx, last.x, last.y, x, y, brush);
      } else {
        stampSoftBrush(ctx, x, y, brush);
      }
      ctx.globalCompositeOperation = "source-over";
      lastPointRef.current = { x, y };
      scratchedRef.current = true;
      canvas.__scratchLocked = true;
      checkReveals();
    },
    [checkReveals, coatingDone, ensureCoatingPainted, phase],
  );

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (coatingDone || phase !== "center") return;
    event.preventDefault();
    event.stopPropagation();
    drawingRef.current = true;
    lastPointRef.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
    scratchAt(event.clientX, event.clientY);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drawingRef.current || coatingDone || phase !== "center") return;
    event.preventDefault();
    event.stopPropagation();
    scratchAt(event.clientX, event.clientY);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    drawingRef.current = false;
    lastPointRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
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
