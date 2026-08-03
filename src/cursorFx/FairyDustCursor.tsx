import { memo, useEffect, useMemo, useRef, useState } from "react";
import { DotLottie } from "@lottiefiles/dotlottie-web";

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
  fadeSpeed?: number;
  initialVelocity?: {
    min: number;
    max: number;
  };
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
  lifeSpan: number;
  scale: number;
  animOffset: number;
}

type LottieCacheEntry = {
  frames: HTMLCanvasElement[];
  frameCount: number;
  ready: boolean;
};

// Defaults live at module scope so they keep a stable identity across renders —
// inline literals would invalidate the memos and effects below every render.
const DEFAULT_COLORS = ["#ffffff"];
const DEFAULT_CHARACTER_SET = ["✨", "⭐", "🌟", "★", "*"];
const DEFAULT_INITIAL_VELOCITY = { min: 0.5, max: 1.5 };

const LOTTIE_RENDER_SIZE = 128;
const LOTTIE_MAX_FRAMES = 48;
const LOTTIE_FPS = 30;
const EMOJI_RENDER_SIZE = 72;
const PARTICLE_LIFESPAN = 100;
// Particles are culled once they fade past this alpha. At the default fade
// speed that ends their life around frame 40 rather than the ~75 frames it
// takes lifeSpan to decay below 0.1, so ~45% of the per-frame work disappears.
const MIN_VISIBLE_ALPHA = 0.02;
const MAX_PARTICLES = 400;
const SPAWN_DISTANCE_SQ = 4;

function defaultTypesFromCharacters(chars: string[]): ParticleType[] {
  return chars.map((value, i) => ({
    id: `emoji-${i}-${value}`,
    kind: "emoji" as const,
    value,
  }));
}

function prerenderLottieFrames(source: string | ArrayBuffer): Promise<HTMLCanvasElement[]> {
  return new Promise((resolve) => {
    let player: DotLottie;
    try {
      player = new DotLottie({
        data: source,
        autoplay: false,
        loop: false,
        canvas: { width: LOTTIE_RENDER_SIZE, height: LOTTIE_RENDER_SIZE },
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
        frame.width = LOTTIE_RENDER_SIZE;
        frame.height = LOTTIE_RENDER_SIZE;
        const ctx = frame.getContext("2d");
        if (ctx) {
          const imageData = new ImageData(new Uint8ClampedArray(buffer), LOTTIE_RENDER_SIZE, LOTTIE_RENDER_SIZE);
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
  const glyph = document.createElement("canvas");
  glyph.width = EMOJI_RENDER_SIZE;
  glyph.height = EMOJI_RENDER_SIZE;
  const ctx = glyph.getContext("2d");
  if (ctx) {
    ctx.font = `${Math.round(EMOJI_RENDER_SIZE * 0.78)}px serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(character, EMOJI_RENDER_SIZE / 2, EMOJI_RENDER_SIZE / 2);
  }
  return glyph;
}

function FairyDustCursorImpl({
  colors = DEFAULT_COLORS,
  element,
  characterSet = DEFAULT_CHARACTER_SET,
  particleTypes,
  particleSize = 21,
  particleCount = 1,
  gravity = 0.02,
  fadeSpeed = 0.98,
  initialVelocity = DEFAULT_INITIAL_VELOCITY,
}: FairyDustCursorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const lastPosRef = useRef({ x: 0, y: 0 });
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
  const configRef = useRef({ colors, particleSize, particleCount, gravity, fadeSpeed, initialVelocity });
  configRef.current = { colors, particleSize, particleCount, gravity, fadeSpeed, initialVelocity };

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
      if (cache.has(type.id)) return;

      const entry: LottieCacheEntry = { frames: [], frameCount: 0, ready: false };
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
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

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
      timeMs += dt;
      clearDirty();

      const { particleSize: size, gravity: g, fadeSpeed: fade } = configRef.current;

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
        particle.lifeSpan *= fade;

        const scale = particle.lifeSpan / PARTICLE_LIFESPAN;
        if (scale <= MIN_VISIBLE_ALPHA) continue;

        particle.scale = scale;
        particles[write] = particle;
        write += 1;

        context.globalAlpha = scale;

        let drawSize = size * scale;
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
      context.globalAlpha = 1;

      if (write > 0) {
        dirtyX = Math.max(0, Math.floor(minX));
        dirtyY = Math.max(0, Math.floor(minY));
        dirtyW = Math.min(width, Math.ceil(maxX)) - dirtyX;
        dirtyH = Math.min(height, Math.ceil(maxY)) - dirtyY;
      }
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

    const spawn = (x: number, y: number) => {
      const types = typesRef.current;
      if (types.length === 0) return;

      const { colors: palette, particleCount: count, initialVelocity: velocity } = configRef.current;
      const spawnCount = Math.min(count, MAX_PARTICLES - particles.length);

      for (let i = 0; i < spawnCount; i += 1) {
        const type = types[Math.floor(Math.random() * types.length)];
        particles.push({
          x,
          y,
          typeId: type.id,
          kind: type.kind,
          character: type.kind === "emoji" ? type.value : "",
          color: palette[Math.floor(Math.random() * palette.length)],
          vx:
            (Math.random() < 0.5 ? -1 : 1) *
            (Math.random() * (velocity.max - velocity.min) + velocity.min),
          vy: -(Math.random() * velocity.max),
          lifeSpan: PARTICLE_LIFESPAN,
          scale: 1,
          animOffset: Math.random(),
        });
      }

      if (spawnCount > 0) ensureRunning();
    };

    const spawnIfMoved = (x: number, y: number) => {
      const dx = x - lastPosRef.current.x;
      const dy = y - lastPosRef.current.y;
      if (dx * dx + dy * dy <= SPAWN_DISTANCE_SQ) return;
      lastPosRef.current.x = x;
      lastPosRef.current.y = y;
      spawn(x, y);
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (element) {
        const rect = targetElement.getBoundingClientRect();
        spawnIfMoved(e.clientX - rect.left, e.clientY - rect.top);
      } else {
        spawnIfMoved(e.clientX, e.clientY);
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".panel, .mobile-settings-sheet")) return;
      e.preventDefault();
      const touch = e.touches[0];
      if (!touch) return;

      if (element) {
        const rect = targetElement.getBoundingClientRect();
        spawnIfMoved(touch.clientX - rect.left, touch.clientY - rect.top);
      } else {
        spawnIfMoved(touch.clientX, touch.clientY);
      }
    };

    targetElement.addEventListener("mousemove", handleMouseMove);
    targetElement.addEventListener("touchmove", handleTouchMove, { passive: false });
    if (particles.length > 0) ensureRunning();

    return () => {
      targetElement.removeEventListener("mousemove", handleMouseMove);
      targetElement.removeEventListener("touchmove", handleTouchMove);
      cancelAnimationFrame(animationFrameId);
    };
  }, [element, canvasSize]);

  return (
    <canvas
      ref={canvasRef}
      width={canvasSize.width}
      height={canvasSize.height}
      style={{
        position: element ? "absolute" : "fixed",
        top: 0,
        left: 0,
        pointerEvents: "none",
        zIndex: 9999,
      }}
    />
  );
}

export const FairyDustCursor = memo(FairyDustCursorImpl);

export default FairyDustCursor;
