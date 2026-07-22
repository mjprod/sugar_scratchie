import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { GameSymbolIcon } from "./GameSymbolIcon";
import { SYMBOL_TYPES, TOP_SYMBOL_COUNT } from "./matchGame";

const SLOT_SIZE = 44;
const BRUSH_RADIUS = 12;
const REVEAL_THRESHOLD = 0.38;

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

function paintSlotCoating(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  const size = canvas.width;
  ctx.clearRect(0, 0, size, size);
  const gradient = ctx.createRadialGradient(
    size * 0.35,
    size * 0.3,
    size * 0.1,
    size * 0.5,
    size * 0.5,
    size * 0.55,
  );
  gradient.addColorStop(0, "#d8d4cf");
  gradient.addColorStop(0.55, "#9a9590");
  gradient.addColorStop(1, "#6e6a66");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function measureErasedRatio(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return 0;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let transparent = 0;
  const total = canvas.width * canvas.height;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 40) transparent += 1;
  }
  return transparent / total;
}

export function TopSymbolBar({
  symbols,
  phase,
  onAllRevealed,
  roundKey = 0,
  forceRevealed = false,
}: TopSymbolBarProps) {
  const slotElsRef = useRef<(HTMLDivElement | null)[]>(
    Array.from({ length: TOP_SYMBOL_COUNT }, () => null),
  );
  const canvasElsRef = useRef<(HTMLCanvasElement | null)[]>(
    Array.from({ length: TOP_SYMBOL_COUNT }, () => null),
  );
  const drawingRef = useRef(false);
  const revealedMaskRef = useRef<boolean[]>(
    Array.from({ length: TOP_SYMBOL_COUNT }, () => forceRevealed),
  );
  const notifiedRef = useRef(forceRevealed);
  const onAllRevealedRef = useRef(onAllRevealed);
  onAllRevealedRef.current = onAllRevealed;
  const [revealedMask, setRevealedMask] = useState<boolean[]>(() =>
    Array.from({ length: TOP_SYMBOL_COUNT }, () => forceRevealed),
  );

  const slots = symbols.slice(0, TOP_SYMBOL_COUNT);
  while (slots.length < TOP_SYMBOL_COUNT) slots.push(0);

  useEffect(() => {
    revealedMaskRef.current = Array.from(
      { length: TOP_SYMBOL_COUNT },
      () => forceRevealed,
    );
    notifiedRef.current = forceRevealed;
    setRevealedMask(
      Array.from({ length: TOP_SYMBOL_COUNT }, () => forceRevealed),
    );
    drawingRef.current = false;
    // Repaint coatings for a new round after canvases remount.
    requestAnimationFrame(() => {
      for (let i = 0; i < TOP_SYMBOL_COUNT; i += 1) {
        const canvas = canvasElsRef.current[i];
        if (canvas && !revealedMaskRef.current[i]) paintSlotCoating(canvas);
      }
    });
  }, [symbols, forceRevealed, roundKey]);

  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  const markRevealed = useCallback((index: number) => {
    if (revealedMaskRef.current[index]) return;
    const next = revealedMaskRef.current.slice();
    next[index] = true;
    revealedMaskRef.current = next;
    setRevealedMask(next);
    if (next.every(Boolean) && !notifiedRef.current) {
      notifiedRef.current = true;
      onAllRevealedRef.current();
    }
  }, []);

  /** Pick only the circle under the finger — never multiple slots at once. */
  function hitSlotIndex(clientX: number, clientY: number): number {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < TOP_SYMBOL_COUNT; i += 1) {
      if (revealedMaskRef.current[i]) continue;
      const el = slotElsRef.current[i];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const radius = Math.min(rect.width, rect.height) / 2;
      const dist = Math.hypot(clientX - cx, clientY - cy);
      // Must be inside the circle (tiny slack for fat fingers, still < half gap).
      if (dist <= radius + 4 && dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  const scratchSlot = useCallback(
    (index: number, clientX: number, clientY: number) => {
      const canvas = canvasElsRef.current[index];
      if (!canvas || revealedMaskRef.current[index]) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const x = ((clientX - rect.left) / rect.width) * canvas.width;
      const y = ((clientY - rect.top) / rect.height) * canvas.height;
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(x, y, BRUSH_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
      if (measureErasedRatio(canvas) >= REVEAL_THRESHOLD) {
        markRevealed(index);
      }
    },
    [markRevealed],
  );

  const scratchAtPoint = useCallback(
    (clientX: number, clientY: number) => {
      if (phase !== "center") return;
      const index = hitSlotIndex(clientX, clientY);
      if (index < 0) {
        lastPointRef.current = { x: clientX, y: clientY };
        return;
      }
      const last = lastPointRef.current;
      if (last) {
        const dx = clientX - last.x;
        const dy = clientY - last.y;
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 6));
        for (let s = 1; s <= steps; s += 1) {
          const t = s / steps;
          const x = last.x + dx * t;
          const y = last.y + dy * t;
          // Stay locked to the slot under each sample so a stroke across the
          // bar only scratches one circle at a time.
          const stepIndex = hitSlotIndex(x, y);
          if (stepIndex >= 0) scratchSlot(stepIndex, x, y);
        }
      } else {
        scratchSlot(index, clientX, clientY);
      }
      lastPointRef.current = { x: clientX, y: clientY };
    },
    [phase, scratchSlot],
  );

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (phase !== "center") return;
    if (revealedMaskRef.current.every(Boolean)) return;
    event.preventDefault();
    event.stopPropagation();
    drawingRef.current = true;
    lastPointRef.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
    scratchAtPoint(event.clientX, event.clientY);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drawingRef.current || phase !== "center") return;
    event.preventDefault();
    event.stopPropagation();
    scratchAtPoint(event.clientX, event.clientY);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    drawingRef.current = false;
    lastPointRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const revealedCount = revealedMask.filter(Boolean).length;
  const scratchable =
    phase === "center" && !forceRevealed && revealedCount < TOP_SYMBOL_COUNT;

  return (
    <div
      className={`symbol-bar top-symbol-bar is-phase-${phase}${
        revealedCount >= TOP_SYMBOL_COUNT ? " is-symbols-complete" : ""
      }${scratchable ? " is-scratchable" : ""}`}
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
            {revealed ? <GameSymbolIcon typeId={typeId} size={28} /> : null}
            {!revealed ? (
              <canvas
                ref={(el) => {
                  canvasElsRef.current[index] = el;
                  if (el) paintSlotCoating(el);
                }}
                className="top-symbol-scratch-canvas"
                width={SLOT_SIZE}
                height={SLOT_SIZE}
                aria-hidden="true"
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
