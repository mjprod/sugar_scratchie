import { useEffect, useRef, useState } from "react";
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
  velocity: { x: number; y: number };
  lifeSpan: number;
  initialLifeSpan: number;
  scale: number;
  animOffset: number;
}

type LottieCacheEntry = {
  sourceRef: string | ArrayBuffer;
  frames: HTMLCanvasElement[];
  frameCount: number;
  ready: boolean;
};

const LOTTIE_RENDER_SIZE = 128;
const LOTTIE_MAX_FRAMES = 48;

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

export function FairyDustCursor({
  colors = ["#ffffff"],
  element,
  characterSet = ["✨", "⭐", "🌟", "★", "*"],
  particleTypes,
  particleSize = 21,
  particleCount = 1,
  gravity = 0.02,
  fadeSpeed = 0.98,
  initialVelocity = { min: 0.5, max: 1.5 },
}: FairyDustCursorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const cursorRef = useRef({ x: 0, y: 0 });
  const lastPosRef = useRef({ x: 0, y: 0 });
  const lottieCacheRef = useRef<Map<string, LottieCacheEntry>>(new Map());
  const typesRef = useRef<ParticleType[]>([]);
  const [canvasSize, setCanvasSize] = useState({
    width: typeof window !== "undefined" ? (element ? element.clientWidth : window.innerWidth) : 0,
    height: typeof window !== "undefined" ? (element ? element.clientHeight : window.innerHeight) : 0,
  });

  const resolvedTypes = particleTypes && particleTypes.length > 0 ? particleTypes : defaultTypesFromCharacters(characterSet);

  typesRef.current = resolvedTypes;

  const lottieSig = resolvedTypes
    .filter((t): t is Extract<ParticleType, { kind: "lottie" }> => t.kind === "lottie")
    .map((t) => t.id)
    .join("|");

  useEffect(() => {
    const cache = lottieCacheRef.current;
    const activeIds = new Set(resolvedTypes.map((t) => t.id));

    for (const id of [...cache.keys()]) {
      if (!activeIds.has(id)) cache.delete(id);
    }

    resolvedTypes.forEach((type) => {
      if (type.kind !== "lottie") return;
      const existing = cache.get(type.id);
      if (existing && existing.sourceRef === type.source && existing.ready) return;

      const entry: LottieCacheEntry = {
        sourceRef: type.source,
        frames: [],
        frameCount: 0,
        ready: false,
      };
      cache.set(type.id, entry);

      void prerenderLottieFrames(type.source).then((frames) => {
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
      setCanvasSize({
        width: element ? element.clientWidth : window.innerWidth,
        height: element ? element.clientHeight : window.innerHeight,
      });
    };

    updateCanvasSize();
    window.addEventListener("resize", updateCanvasSize);
    return () => window.removeEventListener("resize", updateCanvasSize);
  }, [element]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const targetElement = element || document.body;
    const context = canvas.getContext("2d");
    if (!context) return;

    canvas.width = canvasSize.width;
    canvas.height = canvasSize.height;

    let animationFrameId: number;
    let timeMs = 0;
    let lastTs = performance.now();

    const createParticle = (x: number, y: number): Particle | null => {
      const types = typesRef.current;
      if (!types.length) return null;

      const type = types[Math.floor(Math.random() * types.length)];
      const randomColor = colors[Math.floor(Math.random() * colors.length)];
      const velocityX = (Math.random() < 0.5 ? -1 : 1) * (Math.random() * (initialVelocity.max - initialVelocity.min) + initialVelocity.min);
      const velocityY = -(Math.random() * initialVelocity.max);

      return {
        x,
        y,
        typeId: type.id,
        kind: type.kind,
        character: type.kind === "emoji" ? type.value : "",
        color: randomColor,
        velocity: { x: velocityX, y: velocityY },
        lifeSpan: 100,
        initialLifeSpan: 100,
        scale: 1,
        animOffset: Math.random(),
      };
    };

    const updateParticles = (dt: number) => {
      timeMs += dt;
      context.clearRect(0, 0, canvasSize.width, canvasSize.height);

      particlesRef.current.forEach((particle) => {
        particle.x += particle.velocity.x;
        particle.y += particle.velocity.y;
        particle.velocity.y += gravity;
        particle.lifeSpan *= fadeSpeed;
        particle.scale = Math.max(particle.lifeSpan / particle.initialLifeSpan, 0);

        const alpha = particle.scale;
        if (alpha <= 0.02) return;

        context.save();
        context.globalAlpha = alpha;

        if (particle.kind === "lottie") {
          const entry = lottieCacheRef.current.get(particle.typeId);
          if (entry?.ready && entry.frames.length > 0) {
            const fps = 30;
            const frameFloat = (timeMs / 1000) * fps + particle.animOffset * entry.frameCount;
            const frameIndex = ((Math.floor(frameFloat) % entry.frameCount) + entry.frameCount) % entry.frameCount;
            const frame = entry.frames[frameIndex];
            const drawSize = particleSize * particle.scale * 1.4;
            context.drawImage(frame, particle.x - drawSize / 2, particle.y - drawSize / 2, drawSize, drawSize);
          } else {
            context.font = `${particleSize * particle.scale}px serif`;
            context.fillStyle = particle.color;
            context.fillText("•", particle.x, particle.y);
          }
        } else {
          context.font = `${particleSize * particle.scale}px serif`;
          context.fillStyle = "#ffffff";
          context.fillText(particle.character, particle.x, particle.y);
        }

        context.restore();
      });

      particlesRef.current = particlesRef.current.filter((particle) => particle.lifeSpan > 0.1);
    };

    const animate = (ts: number) => {
      const dt = Math.min(64, ts - lastTs);
      lastTs = ts;
      updateParticles(dt);
      animationFrameId = requestAnimationFrame(animate);
    };

    const handleMouseMove = (e: MouseEvent) => {
      const rect = element ? targetElement.getBoundingClientRect() : undefined;
      const x = element ? e.clientX - rect!.left : e.clientX;
      const y = element ? e.clientY - rect!.top : e.clientY;

      cursorRef.current = { x, y };

      const distance = Math.hypot(cursorRef.current.x - lastPosRef.current.x, cursorRef.current.y - lastPosRef.current.y);

      if (distance > 2) {
        for (let i = 0; i < particleCount; i++) {
          const p = createParticle(cursorRef.current.x, cursorRef.current.y);
          if (p) particlesRef.current.push(p);
        }
        lastPosRef.current = { ...cursorRef.current };
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".panel, .mobile-settings-sheet")) return;
      e.preventDefault();
      const touch = e.touches[0];
      const rect = element ? targetElement.getBoundingClientRect() : undefined;
      const x = element ? touch.clientX - rect!.left : touch.clientX;
      const y = element ? touch.clientY - rect!.top : touch.clientY;

      for (let i = 0; i < particleCount; i++) {
        const p = createParticle(x, y);
        if (p) particlesRef.current.push(p);
      }
    };

    targetElement.addEventListener("mousemove", handleMouseMove);
    targetElement.addEventListener("touchmove", handleTouchMove, { passive: false });
    animationFrameId = requestAnimationFrame(animate);

    return () => {
      targetElement.removeEventListener("mousemove", handleMouseMove);
      targetElement.removeEventListener("touchmove", handleTouchMove);
      cancelAnimationFrame(animationFrameId);
    };
  }, [colors, element, particleSize, particleCount, gravity, fadeSpeed, initialVelocity, canvasSize, lottieSig]);

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

export default FairyDustCursor;
