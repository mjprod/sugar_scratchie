import { useEffect, useRef } from "react";

// Ported from sugar-scratch-cursor-test-main's RainbowCursor: draws a
// three-band gold/white streak that eases toward the pointer, entirely via
// its own appended canvas (no JSX output besides null).
interface RainbowCursorProps {
  element?: HTMLElement;
  length?: number;
  trailSpeed?: number;
  blur?: number;
  zIndex?: number;
  /** Outer gold stroke color */
  outerColor?: string;
  /** Inner white core color */
  innerColor?: string;
  /** Outer stroke thickness (each side), px — desktop baseline */
  outerWidth?: number;
  /** Inner core thickness, px — desktop baseline */
  innerWidth?: number;
  /** Extra scale on touch / coarse pointers (default ~1.25) */
  touchScale?: number;
}

type Point = { x: number; y: number };

function isTouchLikeDevice() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(pointer: coarse)").matches ||
    window.matchMedia("(hover: none)").matches ||
    navigator.maxTouchPoints > 0
  );
}

export function RainbowCursor({
  element,
  length = 20,
  trailSpeed = 0.4,
  blur = 0,
  zIndex,
  outerColor = "#ffc800",
  innerColor = "#ffffff",
  outerWidth = 2,
  innerWidth = 3,
  touchScale = 1.25,
}: RainbowCursorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const contextRef = useRef<CanvasRenderingContext2D | null>(null);
  const cursorRef = useRef({ x: 0, y: 0 });
  // Three parallel bands: outer / inner / outer — slight speed variance
  const trailsRef = useRef<Point[][]>([]);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const cursorsInittedRef = useRef(false);

  const hexToRgba = (hex: string, alpha: number) => {
    const normalized = hex.replace("#", "");
    const full =
      normalized.length === 3
        ? normalized
            .split("")
            .map((c) => c + c)
            .join("")
        : normalized;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  // Band 0 outer-top, 1 inner, 2 outer-bottom
  const getLineSpeed = (lineIndex: number) => {
    const factors = [0.9, 1.0, 1.1];
    const factor = factors[lineIndex] ?? 1;
    return Math.min(0.95, Math.max(0.08, trailSpeed * factor));
  };

  useEffect(() => {
    const hasWrapperEl = element !== undefined;
    const targetElement = hasWrapperEl ? element! : document.body;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (prefersReducedMotion.matches) return;

    const touch = isTouchLikeDevice();
    const scale = touch ? touchScale : 1;
    const oW = outerWidth * scale;
    const iW = innerWidth * scale;
    const glowBoost = touch ? 1.1 : 1;

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    canvasRef.current = canvas;
    contextRef.current = context;
    trailsRef.current = [];
    cursorsInittedRef.current = false;

    canvas.style.top = "0px";
    canvas.style.left = "0px";
    canvas.style.pointerEvents = "none";
    canvas.style.position = hasWrapperEl ? "absolute" : "fixed";
    canvas.style.zIndex = zIndex != null ? zIndex.toString() : "1";

    const setCanvasSize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const cssW = hasWrapperEl && element ? element.clientWidth : window.innerWidth;
      const cssH = hasWrapperEl && element ? element.clientHeight : window.innerHeight;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.width = Math.max(1, Math.floor(cssW * dpr));
      canvas.height = Math.max(1, Math.floor(cssH * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    if (hasWrapperEl && element) {
      element.appendChild(canvas);
    } else {
      document.body.appendChild(canvas);
    }
    setCanvasSize();

    const bandCount = 3;

    const initTrails = (x: number, y: number) => {
      trailsRef.current = Array.from({ length: bandCount }, () =>
        Array.from({ length }, () => ({ x, y })),
      );
      cursorsInittedRef.current = true;
    };

    const setCursorFromClient = (clientX: number, clientY: number) => {
      if (hasWrapperEl && element) {
        const boundingRect = element.getBoundingClientRect();
        cursorRef.current.x = clientX - boundingRect.left;
        cursorRef.current.y = clientY - boundingRect.top;
      } else {
        cursorRef.current.x = clientX;
        cursorRef.current.y = clientY;
      }

      if (!cursorsInittedRef.current) {
        initTrails(cursorRef.current.x, cursorRef.current.y);
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      setCursorFromClient(e.clientX, e.clientY);
    };

    const isUiOverlayTarget = (target: EventTarget | null) => {
      const t = target as HTMLElement | null;
      return Boolean(t?.closest?.(".panel, .mobile-settings-sheet"));
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!e.touches.length) return;
      if (isUiOverlayTarget(e.target)) return;
      if (!hasWrapperEl) e.preventDefault();
      const touchPoint = e.touches[0];
      setCursorFromClient(touchPoint.clientX, touchPoint.clientY);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (!e.touches.length) return;
      if (isUiOverlayTarget(e.target)) return;
      const touchPoint = e.touches[0];
      setCursorFromClient(touchPoint.clientX, touchPoint.clientY);
    };

    const onWindowResize = () => {
      setCanvasSize();
    };

    const halfInner = iW / 2;
    const outerCenterOffset = halfInner + oW / 2;
    const bandSpecs = [
      { color: outerColor, width: oW, yOffset: -outerCenterOffset },
      { color: innerColor, width: iW, yOffset: 0 },
      { color: outerColor, width: oW, yOffset: outerCenterOffset },
    ];

    const updateParticles = () => {
      if (!contextRef.current || !canvasRef.current) return;
      if (!cursorsInittedRef.current) return;

      const ctx = contextRef.current;
      const c = canvasRef.current;

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.restore();

      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      if (trailsRef.current.length !== bandCount) {
        initTrails(cursorRef.current.x, cursorRef.current.y);
      }

      bandSpecs.forEach((_band, lineIndex) => {
        const trail = trailsRef.current[lineIndex];
        if (!trail || trail.length === 0) return;

        const speed = getLineSpeed(lineIndex);
        let x = cursorRef.current.x;
        let y = cursorRef.current.y;

        for (let i = 0; i < trail.length; i++) {
          trail[i].x = x;
          trail[i].y = y;
          const next = trail[i + 1] ?? trail[i];
          x += (next.x - trail[i].x) * speed;
          y += (next.y - trail[i].y) * speed;
        }
      });

      const glowTrail = trailsRef.current[1] ?? trailsRef.current[0];
      const extraBlur = blur > 0 ? blur : 0;

      const strokeTrail = (trail: Point[], color: string, width: number, yOffset: number, alphaScale: number) => {
        for (let i = 0; i < trail.length - 1; i++) {
          const t = i / Math.max(trail.length - 1, 1);
          const alpha = Math.pow(1 - t, 1.6) * alphaScale;
          if (alpha < 0.02) continue;

          ctx.beginPath();
          ctx.strokeStyle = hexToRgba(color, Math.min(1, alpha));
          ctx.lineWidth = width;
          ctx.shadowColor = "transparent";
          ctx.shadowBlur = 0;
          ctx.moveTo(trail[i].x, trail[i].y + yOffset);
          ctx.lineTo(trail[i + 1].x, trail[i + 1].y + yOffset);
          ctx.stroke();
        }
      };

      if (glowTrail && glowTrail.length > 1) {
        ctx.save();
        ctx.filter = `blur(${(10 + extraBlur) * glowBoost}px)`;
        strokeTrail(glowTrail, "#ffc800", iW + oW * 2 + 10 * glowBoost, 0, 0.55);
        ctx.filter = `blur(${(4 + extraBlur) * glowBoost}px)`;
        strokeTrail(glowTrail, "#ffe566", iW + oW * 2 + 4 * glowBoost, 0, 0.65);
        ctx.restore();
      }

      ctx.save();
      if (extraBlur > 0) {
        ctx.filter = `blur(${extraBlur}px)`;
      }
      bandSpecs.forEach((band, lineIndex) => {
        const trail = trailsRef.current[lineIndex];
        if (!trail || trail.length === 0) return;
        strokeTrail(trail, band.color, band.width, band.yOffset, 1);
      });
      ctx.restore();
    };

    const loop = () => {
      updateParticles();
      animationFrameRef.current = requestAnimationFrame(loop);
    };

    targetElement.addEventListener("mousemove", onMouseMove);
    targetElement.addEventListener("touchstart", onTouchStart, { passive: true });
    targetElement.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("resize", onWindowResize);
    loop();

    return () => {
      if (canvasRef.current) canvasRef.current.remove();
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      targetElement.removeEventListener("mousemove", onMouseMove);
      targetElement.removeEventListener("touchstart", onTouchStart);
      targetElement.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("resize", onWindowResize);
    };
  }, [element, length, trailSpeed, blur, zIndex, outerColor, innerColor, outerWidth, innerWidth, touchScale]);

  return null;
}

export default RainbowCursor;
