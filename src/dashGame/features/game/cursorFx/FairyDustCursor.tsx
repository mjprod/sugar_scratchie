import { memo, useEffect, useMemo, useRef, useState } from "react";
import { DotLottie } from "@lottiefiles/dotlottie-web";
import "@/lib/lottie/setupWasm";
import { lottieDevicePixelRatio } from "@/utils/lottieRender";
import {
  CURSOR_FX_BURST_SIZE_MUL,
  CURSOR_FX_EMIT_MODE,
  cursorFxBurstVelocity,
  cursorFxSpawnVelocity,
  type CursorFxEmitMode,
} from "../modules/cursorFxCelebrate";
import { shouldSpawnFairyDustForMove } from "../modules/fairyDustSpawnPolicy";

// Ported from sugar-scratch-cursor-test-main's FairyDustCursor. The original
// used `lottie-web` + a hidden DOM host to snapshot animation frames onto
// offscreen canvases; here that's replaced with `@lottiefiles/dotlottie-web`'s
// software render surface (a canvas-less `{width, height}` target), which can
// decode both raw Lottie JSON and .lottie zip archives natively — so frame
// pre-rendering needs no extra host element and no jszip dependency.
export type ParticleType =
  | { id: string; kind: "emoji"; value: string }
  | { id: string; kind: "lottie"; name: string; source: string | ArrayBuffer };

interface FairyDustCursorProps {
  colors?: string[];
  element?: HTMLElement;
  characterSet?: string[];
  particleTypes?: ParticleType[];
  particleSize?: number;
  particleCount?: number;
  gravity?: number;
  /** Unused for visibility — coins stay opaque until they leave the overlay. */
  fadeSpeed?: number;
  initialVelocity?: {
    min: number;
    max: number;
  };
  /**
   * `fall` = coins drop like symbols-foil flakes (product default).
   * `fountain` = legacy upward fireworks burst.
   */
  emitMode?: CursorFxEmitMode;
  /** When false, pointer-move spawning is disabled; bursts can still emit particles. */
  spawnEnabled?: boolean;
  /** Cap overlay backing-store DPR (use 1 on phones). */
  maxDevicePixelRatio?: number;
  /** Bump to force a one-shot burst at the last pointer (or canvas center). */
  burstNonce?: number;
  /** Particles to emit on burst (defaults to particleCount * 3). */
  burstCount?: number;
  /** Milestone-pop size relative to trail coins. Defaults to the desktop pop. */
  burstSizeMul?: number;
  /** Pointer must get this far (px) from the last trail coin to emit another. */
  spawnMinDistance?: number;
  /**
   * Checked per trail coin (not bursts); return false to skip, e.g. while the
   * finger rubs already-scratched fabric. Read through a ref — may change
   * identity freely without restarting the loop.
   */
  spawnGate?: () => boolean;
}

interface Particle {
  x: number;
  y: number;
  typeId: string;
  kind: "emoji" | "lottie";
  character: string;
  color: string;
  vx: number;
  vy: number;
  scale: number;
  sizeMul: number;
  animOffset: number;
}

type LottieCacheEntry = {
  source: string | ArrayBuffer;
  frames: HTMLCanvasElement[];
  frameCount: number;
  ready: boolean;
};

// Defaults live at module scope so they keep a stable identity across renders —
// inline literals would invalidate the memos and effects below every render.
const DEFAULT_COLORS = ["#ffffff"];
const DEFAULT_CHARACTER_SET = ["✨", "⭐", "🌟", "★", "*"];
const DEFAULT_INITIAL_VELOCITY = { min: 0.5, max: 1.5 };

const LOTTIE_RENDER_SIZE_CSS = 128;
const LOTTIE_MAX_FRAMES = 48;
const LOTTIE_FPS = 30;
const EMOJI_RENDER_SIZE_CSS = 72;
// Coins stay fully opaque until they leave the overlay. fadeSpeed is kept on
// the props so saved settings still load, but it no longer drives visibility.
// Soft cap: under the safer defaults (~128 concurrent at hard scratch) this
// rarely bites; if someone cranked fade/count it thins the trail before the
// 2D drawImage loop eats the frame budget.
const MAX_PARTICLES = 250;
const DEFAULT_SPAWN_MIN_DISTANCE = 14;

/** Live cursor-FX cost counters for the debug HUD / settings panel. */
export type FairyDustPerfStats = {
  active: number;
  peak: number;
  /** Last drawFrame wall time in ms. */
  frameMs: number;
  /** EMA of drawFrame wall time (ms). */
  avgFrameMs: number;
};

export const fairyDustPerf: FairyDustPerfStats = {
  active: 0,
  peak: 0,
  frameMs: 0,
  avgFrameMs: 0,
};

export function resetFairyDustPerfPeak() {
  fairyDustPerf.peak = fairyDustPerf.active;
}

function defaultTypesFromCharacters(chars: string[]): ParticleType[] {
  return chars.map((value, i) => ({
    id: `emoji-${i}-${value}`,
    kind: "emoji" as const,
    value,
  }));
}

function prerenderLottieFrames(source: string | ArrayBuffer): Promise<HTMLCanvasElement[]> {
  return new Promise((resolve) => {
    const renderSize = Math.max(
      LOTTIE_RENDER_SIZE_CSS,
      Math.round(LOTTIE_RENDER_SIZE_CSS * lottieDevicePixelRatio()),
    );
    let player: DotLottie;
    try {
      player = new DotLottie({
        data: source,
        autoplay: false,
        loop: false,
        canvas: { width: renderSize, height: renderSize },
      });
    } catch {
      resolve([]);
      return;
    }

    let settled = false;
    const finish = (frames: HTMLCanvasElement[]) => {
      if (settled) return;
      settled = true;
      player.destroy();
      resolve(frames);
    };

    player.addEventListener("loadError", () => finish([]));
    player.addEventListener("load", () => {
      const total = Math.max(1, player.totalFrames);
      const count = Math.min(total, LOTTIE_MAX_FRAMES);
      const step = total > count ? total / count : 1;
      const frames: HTMLCanvasElement[] = [];

      for (let i = 0; i < count; i += 1) {
        const frameIndex = Math.min(total - 1, Math.floor(i * step));
        player.setFrame(frameIndex);
        const buffer = player.buffer;
        if (!buffer) continue;

        const frame = document.createElement("canvas");
        frame.width = renderSize;
        frame.height = renderSize;
        const ctx = frame.getContext("2d");
        if (ctx) {
          const imageData = new ImageData(new Uint8ClampedArray(buffer), renderSize, renderSize);
          ctx.putImageData(imageData, 0, 0);
        }
        frames.push(frame);
      }

      finish(frames);
    });
  });
}

// Rasterising a glyph once and blitting it is far cheaper than a `fillText`
// (and its font re-parse) per particle per frame.
function renderGlyph(character: string): HTMLCanvasElement {
  const renderSize = Math.max(
    EMOJI_RENDER_SIZE_CSS,
    Math.round(EMOJI_RENDER_SIZE_CSS * lottieDevicePixelRatio()),
  );
  const glyph = document.createElement("canvas");
  glyph.width = renderSize;
  glyph.height = renderSize;
  const ctx = glyph.getContext("2d");
  if (ctx) {
    ctx.font = `${Math.round(renderSize * 0.78)}px serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(character, renderSize / 2, renderSize / 2);
  }
  return glyph;
}

function FairyDustCursorImpl({
  colors = DEFAULT_COLORS,
  element,
  characterSet = DEFAULT_CHARACTER_SET,
  particleTypes,
  particleSize = 21,
  particleCount = 2,
  gravity = 0.1,
  fadeSpeed = 0.94,
  initialVelocity = DEFAULT_INITIAL_VELOCITY,
  emitMode = CURSOR_FX_EMIT_MODE,
  spawnEnabled = true,
  maxDevicePixelRatio,
  burstNonce = 0,
  burstCount,
  burstSizeMul = CURSOR_FX_BURST_SIZE_MUL,
  spawnMinDistance = DEFAULT_SPAWN_MIN_DISTANCE,
  spawnGate,
}: FairyDustCursorProps) {
  const spawnGateRef = useRef(spawnGate);
  spawnGateRef.current = spawnGate;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const lastPosRef = useRef({ x: 0, y: 0 });
  const trailAnchorRef = useRef({ x: 0, y: 0 });
  const hasPointerRef = useRef(false);
  const pendingBurstRef = useRef(0);
  const lastBurstNonceRef = useRef(0);
  const flushBurstApiRef = useRef<() => void>(() => undefined);
  const lottieCacheRef = useRef<Map<string, LottieCacheEntry>>(new Map());
  const lottieSourceCacheRef = useRef<Map<string | ArrayBuffer, Promise<HTMLCanvasElement[]>>>(new Map());
  const glyphCacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const typesRef = useRef<ParticleType[]>([]);
  const [canvasSize, setCanvasSize] = useState({
    width: typeof window !== "undefined" ? (element ? element.clientWidth : window.innerWidth) : 0,
    height: typeof window !== "undefined" ? (element ? element.clientHeight : window.innerHeight) : 0,
  });

  // The animation loop reads its tunables through this ref, so moving a slider
  // (or any parent re-render) never tears down the loop and its listeners.
  const configRef = useRef({
    colors,
    particleSize,
    particleCount,
    gravity,
    fadeSpeed,
    initialVelocity,
    emitMode,
    spawnEnabled,
    maxDevicePixelRatio,
    spawnMinDistance,
    burstSizeMul,
  });
  configRef.current = {
    colors,
    particleSize,
    particleCount,
    gravity,
    fadeSpeed,
    initialVelocity,
    emitMode,
    spawnEnabled,
    maxDevicePixelRatio,
    spawnMinDistance,
    burstSizeMul,
  };

  const resolvedTypes = useMemo(
    () =>
      particleTypes && particleTypes.length > 0
        ? particleTypes
        : defaultTypesFromCharacters(characterSet),
    [particleTypes, characterSet],
  );

  typesRef.current = resolvedTypes;

  const lottieSig = useMemo(
    () =>
      resolvedTypes
        .filter((t): t is Extract<ParticleType, { kind: "lottie" }> => t.kind === "lottie")
        .map((t) => t.id)
        .join("|"),
    [resolvedTypes],
  );

  useEffect(() => {
    const cache = lottieCacheRef.current;
    const sourceCache = lottieSourceCacheRef.current;
    const activeIds = new Set(resolvedTypes.map((t) => t.id));

    for (const id of [...cache.keys()]) {
      if (!activeIds.has(id)) cache.delete(id);
    }

    resolvedTypes.forEach((type) => {
      if (type.kind !== "lottie") return;
      const cached = cache.get(type.id);
      if (cached?.source === type.source) return;

      const entry: LottieCacheEntry = { source: type.source, frames: [], frameCount: 0, ready: false };
      cache.set(type.id, entry);

      // Presets often repeat the same file to weight its spawn odds; decoding
      // per source rather than per type keeps that free.
      let pending = sourceCache.get(type.source);
      if (!pending) {
        pending = prerenderLottieFrames(type.source);
        sourceCache.set(type.source, pending);
      }

      void pending.then((frames) => {
        entry.frames = frames;
        entry.frameCount = frames.length;
        entry.ready = frames.length > 0;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lottieSig]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const updateCanvasSize = () => {
      const width = element ? element.clientWidth : window.innerWidth;
      const height = element ? element.clientHeight : window.innerHeight;
      setCanvasSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    };

    updateCanvasSize();
    window.addEventListener("resize", updateCanvasSize);
    return () => window.removeEventListener("resize", updateCanvasSize);
  }, [element]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (prefersReducedMotion.matches) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const targetElement = element || document.body;
    const context = canvas.getContext("2d");
    if (!context) return;

    const { width, height } = canvasSize;
    const screenDpr = lottieDevicePixelRatio();
    const dprCap = configRef.current.maxDevicePixelRatio;
    const overlayDpr =
      dprCap != null && Number.isFinite(dprCap)
        ? Math.max(1, Math.min(dprCap, screenDpr))
        : screenDpr;
    const bufferWidth = Math.max(1, Math.round(width * overlayDpr));
    const bufferHeight = Math.max(1, Math.round(height * overlayDpr));
    if (canvas.width !== bufferWidth) canvas.width = bufferWidth;
    if (canvas.height !== bufferHeight) canvas.height = bufferHeight;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(overlayDpr, 0, 0, overlayDpr, 0, 0);

    const particles = particlesRef.current;
    let animationFrameId = 0;
    let running = false;
    let timeMs = 0;
    let lastTs = 0;
    // Only the region touched last frame gets cleared; a full-screen clearRect
    // every frame is pure waste when a handful of sparkles are on screen.
    let dirtyX = 0;
    let dirtyY = 0;
    let dirtyW = 0;
    let dirtyH = 0;

    const clearDirty = () => {
      if (dirtyW <= 0 || dirtyH <= 0) return;
      context.clearRect(dirtyX, dirtyY, dirtyW, dirtyH);
      dirtyW = 0;
      dirtyH = 0;
    };

    const getGlyph = (character: string) => {
      let glyph = glyphCacheRef.current.get(character);
      if (!glyph) {
        glyph = renderGlyph(character);
        glyphCacheRef.current.set(character, glyph);
      }
      return glyph;
    };

    const drawFrame = (dt: number) => {
      const frameStarted = performance.now();
      timeMs += dt;
      clearDirty();

      const { particleSize: size, gravity: g, burstSizeMul: burstMul } =
        configRef.current;
      // A coin can drift this far past the overlay before it is culled, so a
      // fast burst doesn't pop out the instant it crosses the edge.
      const cullPad = size * Math.max(1, burstMul) * 1.4 + 8;

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let write = 0;

      for (let i = 0; i < particles.length; i += 1) {
        const particle = particles[i];
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.vy += g;

        if (
          particle.x < -cullPad ||
          particle.x > width + cullPad ||
          particle.y < -cullPad ||
          particle.y > height + cullPad
        ) {
          continue;
        }

        particle.scale = 1;
        particles[write] = particle;
        write += 1;

        let drawSize = size * particle.sizeMul;
        if (particle.kind === "lottie") {
          const entry = lottieCacheRef.current.get(particle.typeId);
          if (entry?.ready) {
            drawSize *= 1.4;
            const frameFloat = (timeMs / 1000) * LOTTIE_FPS + particle.animOffset * entry.frameCount;
            const frameIndex = ((Math.floor(frameFloat) % entry.frameCount) + entry.frameCount) % entry.frameCount;
            context.drawImage(
              entry.frames[frameIndex],
              particle.x - drawSize / 2,
              particle.y - drawSize / 2,
              drawSize,
              drawSize,
            );
          } else {
            drawSize *= 0.25;
            context.fillStyle = particle.color;
            context.beginPath();
            context.arc(particle.x, particle.y, drawSize / 2, 0, Math.PI * 2);
            context.fill();
          }
        } else {
          const glyph = getGlyph(particle.character);
          context.drawImage(
            glyph,
            particle.x - drawSize / 2,
            particle.y - drawSize / 2,
            drawSize,
            drawSize,
          );
        }

        const half = drawSize / 2 + 1;
        if (particle.x - half < minX) minX = particle.x - half;
        if (particle.y - half < minY) minY = particle.y - half;
        if (particle.x + half > maxX) maxX = particle.x + half;
        if (particle.y + half > maxY) maxY = particle.y + half;
      }

      particles.length = write;

      if (write > 0) {
        dirtyX = Math.max(0, Math.floor(minX));
        dirtyY = Math.max(0, Math.floor(minY));
        dirtyW = Math.min(width, Math.ceil(maxX)) - dirtyX;
        dirtyH = Math.min(height, Math.ceil(maxY)) - dirtyY;
      }

      const frameMs = performance.now() - frameStarted;
      fairyDustPerf.active = write;
      if (write > fairyDustPerf.peak) fairyDustPerf.peak = write;
      fairyDustPerf.frameMs = frameMs;
      // Light EMA so the HUD isn't jittery; ~250ms window at 60fps.
      fairyDustPerf.avgFrameMs =
        fairyDustPerf.avgFrameMs === 0
          ? frameMs
          : fairyDustPerf.avgFrameMs * 0.9 + frameMs * 0.1;
    };

    const animate = (ts: number) => {
      const dt = lastTs === 0 ? 16 : Math.min(64, ts - lastTs);
      lastTs = ts;
      drawFrame(dt);

      if (particles.length > 0) {
        animationFrameId = requestAnimationFrame(animate);
        return;
      }

      // Nothing left to animate: wipe the last trail and let the loop idle
      // until the next spawn instead of burning a frame budget on empty work.
      clearDirty();
      running = false;
      lastTs = 0;
    };

    const ensureRunning = () => {
      if (running) return;
      running = true;
      lastTs = 0;
      animationFrameId = requestAnimationFrame(animate);
    };

    const spawn = (x: number, y: number, countOverride?: number, burst = false) => {
      const types = typesRef.current;
      if (types.length === 0) return;

      const {
        colors: palette,
        particleCount: count,
        initialVelocity: velocity,
        emitMode: mode,
      } = configRef.current;
      const want = countOverride ?? count;
      const spawnCount = Math.min(want, MAX_PARTICLES - particles.length);

      for (let i = 0; i < spawnCount; i += 1) {
        const type = types[Math.floor(Math.random() * types.length)];
        const { vx, vy } = burst
          ? cursorFxBurstVelocity()
          : cursorFxSpawnVelocity(mode, velocity);
        particles.push({
          x,
          y,
          typeId: type.id,
          kind: type.kind,
          character: type.kind === "emoji" ? type.value : "",
          color: palette[Math.floor(Math.random() * palette.length)],
          vx,
          vy,
          scale: 1,
          sizeMul: burst ? configRef.current.burstSizeMul : 1,
          animOffset: Math.random(),
        });
      }

      if (spawnCount > 0) ensureRunning();
    };

    const flushPendingBurst = () => {
      const pending = pendingBurstRef.current;
      if (pending <= 0) return;
      pendingBurstRef.current = 0;
      const x = hasPointerRef.current ? lastPosRef.current.x : width * 0.5;
      const y = hasPointerRef.current ? lastPosRef.current.y : height * 0.4;
      spawn(x, y, pending, true);
    };

    const resetTrailAt = (x: number, y: number) => {
      hasPointerRef.current = true;
      lastPosRef.current.x = x;
      lastPosRef.current.y = y;
      trailAnchorRef.current.x = x;
      trailAnchorRef.current.y = y;
    };

    const spawnIfMoved = (x: number, y: number) => {
      hasPointerRef.current = true;
      lastPosRef.current.x = x;
      lastPosRef.current.y = y;
      flushPendingBurst();
      const anchor = trailAnchorRef.current;
      const gate = spawnGateRef.current;
      if (!configRef.current.spawnEnabled || (gate && !gate())) {
        anchor.x = x;
        anchor.y = y;
        return;
      }
      const min = configRef.current.spawnMinDistance ?? DEFAULT_SPAWN_MIN_DISTANCE;
      if (!shouldSpawnFairyDustForMove(x - anchor.x, y - anchor.y, min)) return;
      anchor.x = x;
      anchor.y = y;
      spawn(x, y);
    };

    const toLocal = (clientX: number, clientY: number) => {
      if (!element) return { x: clientX, y: clientY };
      const rect = targetElement.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const handleMouseDown = (e: MouseEvent) => {
      const p = toLocal(e.clientX, e.clientY);
      resetTrailAt(p.x, p.y);
    };

    const handleMouseMove = (e: MouseEvent) => {
      const p = toLocal(e.clientX, e.clientY);
      spawnIfMoved(p.x, p.y);
    };

    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      const p = toLocal(touch.clientX, touch.clientY);
      resetTrailAt(p.x, p.y);
    };

    const handleTouchMove = (e: TouchEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".panel, .mobile-settings-sheet")) return;
      e.preventDefault();
      const touch = e.touches[0];
      if (!touch) return;
      const p = toLocal(touch.clientX, touch.clientY);
      spawnIfMoved(p.x, p.y);
    };

    targetElement.addEventListener("mousedown", handleMouseDown);
    targetElement.addEventListener("mousemove", handleMouseMove);
    targetElement.addEventListener("touchstart", handleTouchStart, { passive: true });
    targetElement.addEventListener("touchmove", handleTouchMove, { passive: false });
    flushBurstApiRef.current = flushPendingBurst;
    if (particles.length > 0) ensureRunning();
    flushPendingBurst();

    return () => {
      flushBurstApiRef.current = () => undefined;
      targetElement.removeEventListener("mousedown", handleMouseDown);
      targetElement.removeEventListener("mousemove", handleMouseMove);
      targetElement.removeEventListener("touchstart", handleTouchStart);
      targetElement.removeEventListener("touchmove", handleTouchMove);
      cancelAnimationFrame(animationFrameId);
    };
  }, [element, canvasSize, maxDevicePixelRatio]);

  useEffect(() => {
    if (!burstNonce || burstNonce === lastBurstNonceRef.current) return;
    lastBurstNonceRef.current = burstNonce;
    const count =
      burstCount ??
      Math.min(MAX_PARTICLES, Math.max(1, (configRef.current.particleCount || 1) * 3));
    pendingBurstRef.current = count;
    flushBurstApiRef.current();
  }, [burstNonce, burstCount]);

  return (
    <canvas
      ref={canvasRef}
      className="fairy-dust-cursor"
      style={{
        position: element ? "absolute" : "fixed",
        top: 0,
        left: 0,
        width: canvasSize.width,
        height: canvasSize.height,
        pointerEvents: "none",
        zIndex: 9999,
      }}
    />
  );
}

export const FairyDustCursor = memo(FairyDustCursorImpl);

export default FairyDustCursor;
