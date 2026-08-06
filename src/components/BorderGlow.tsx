import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import "./BorderGlow.css";

function parseHSL(hslStr: string): { h: number; s: number; l: number } {
  const match = hslStr.match(/([\d.]+)\s*([\d.]+)%?\s*([\d.]+)%?/);
  if (!match) return { h: 40, s: 80, l: 80 };
  return { h: parseFloat(match[1]), s: parseFloat(match[2]), l: parseFloat(match[3]) };
}

function buildGlowVars(glowColor: string, intensity: number): CSSProperties {
  const { h, s, l } = parseHSL(glowColor);
  const base = `${h}deg ${s}% ${l}%`;
  const opacities = [100, 60, 50, 40, 30, 20, 10];
  const keys = ["", "-60", "-50", "-40", "-30", "-20", "-10"];
  const vars: Record<string, string> = {};
  for (let i = 0; i < opacities.length; i++) {
    vars[`--glow-color${keys[i]}`] = `hsl(${base} / ${Math.min(opacities[i] * intensity, 100)}%)`;
  }
  return vars as CSSProperties;
}

const GRADIENT_POSITIONS = ["80% 55%", "69% 34%", "8% 6%", "41% 38%", "86% 85%", "82% 18%", "51% 4%"];
const GRADIENT_KEYS = [
  "--gradient-one",
  "--gradient-two",
  "--gradient-three",
  "--gradient-four",
  "--gradient-five",
  "--gradient-six",
  "--gradient-seven",
];
const COLOR_MAP = [0, 1, 2, 0, 1, 2, 1];

function buildGradientVars(colors: string[]): CSSProperties {
  const vars: Record<string, string> = {};
  for (let i = 0; i < 7; i++) {
    const c = colors[Math.min(COLOR_MAP[i], colors.length - 1)] ?? colors[0] ?? "#ffffff";
    vars[GRADIENT_KEYS[i]] = `radial-gradient(at ${GRADIENT_POSITIONS[i]}, ${c} 0px, transparent 50%)`;
  }
  vars["--gradient-base"] = `linear-gradient(${colors[0] ?? "#c299ff"} 0 100%)`;
  return vars as CSSProperties;
}

function easeOutCubic(x: number) {
  return 1 - Math.pow(1 - x, 3);
}
function easeInCubic(x: number) {
  return x * x * x;
}

type AnimateValueArgs = {
  start?: number;
  end?: number;
  duration?: number;
  delay?: number;
  ease?: (x: number) => number;
  onUpdate: (value: number) => void;
  onEnd?: () => void;
};

function animateValue({
  start = 0,
  end = 100,
  duration = 1000,
  delay = 0,
  ease = easeOutCubic,
  onUpdate,
  onEnd,
}: AnimateValueArgs) {
  const t0 = performance.now() + delay;
  let raf = 0;
  let timeout = 0;

  function tick(now: number) {
    const elapsed = now - t0;
    const t = Math.min(elapsed / duration, 1);
    onUpdate(start + (end - start) * ease(t));
    if (t < 1) raf = requestAnimationFrame(tick);
    else onEnd?.();
  }

  timeout = window.setTimeout(() => {
    raf = requestAnimationFrame(tick);
  }, delay);

  return () => {
    window.clearTimeout(timeout);
    cancelAnimationFrame(raf);
  };
}

export type BorderGlowShape = "rounded-rect" | "hex";

export type BorderGlowProps = {
  children?: ReactNode;
  className?: string;
  edgeSensitivity?: number;
  glowColor?: string;
  backgroundColor?: string;
  borderRadius?: number;
  glowRadius?: number;
  glowIntensity?: number;
  coneSpread?: number;
  /** One-shot intro sweep on mount (stock React Bits behavior). */
  animated?: boolean;
  colors?: string[];
  fillOpacity?: number;
  /**
   * Keep the glow visible and continuously orbit the cone —
   * no pointer/hover required.
   */
  alwaysOn?: boolean;
  /** Degrees per second when alwaysOn. */
  orbitSpeed?: number;
  /** Fixed edge proximity 0–100 used while alwaysOn. */
  alwaysOnProximity?: number;
  /** Strip card chrome (border/bg/shadow) for wrapping custom CTAs. */
  bare?: boolean;
  /**
   * Silhouette for mesh rim + outer bloom. `hex` clips glow layers to the
   * pointed chevron (needs shapeWidth/shapeHeight). Default keeps rounded-rect.
   */
  shape?: BorderGlowShape;
  /** Button box used to size hex/squircle glow clips. */
  shapeWidth?: number;
  shapeHeight?: number;
  /** Hex tip depth as a fraction of height (matches CtaButton.hexTip). */
  hexTip?: number;
};

const DEFAULT_COLORS = ["#c084fc", "#f472b6", "#38bdf8"];

export default function BorderGlow({
  children,
  className = "",
  edgeSensitivity = 30,
  glowColor = "326 90 30",
  backgroundColor = "#120F17",
  borderRadius = 28,
  glowRadius = 40,
  glowIntensity = 1.0,
  coneSpread = 25,
  animated = false,
  colors = DEFAULT_COLORS,
  fillOpacity = 0.5,
  alwaysOn = false,
  orbitSpeed = 40,
  alwaysOnProximity = 92,
  bare = false,
  shape = "rounded-rect",
  shapeWidth,
  shapeHeight,
  hexTip = 0.27,
}: BorderGlowProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  const getCenterOfElement = useCallback((el: HTMLElement) => {
    const { width, height } = el.getBoundingClientRect();
    return [width / 2, height / 2] as const;
  }, []);

  const getEdgeProximity = useCallback(
    (el: HTMLElement, x: number, y: number) => {
      const [cx, cy] = getCenterOfElement(el);
      const dx = x - cx;
      const dy = y - cy;
      let kx = Infinity;
      let ky = Infinity;
      if (dx !== 0) kx = cx / Math.abs(dx);
      if (dy !== 0) ky = cy / Math.abs(dy);
      return Math.min(Math.max(1 / Math.min(kx, ky), 0), 1);
    },
    [getCenterOfElement],
  );

  const getCursorAngle = useCallback(
    (el: HTMLElement, x: number, y: number) => {
      const [cx, cy] = getCenterOfElement(el);
      const dx = x - cx;
      const dy = y - cy;
      if (dx === 0 && dy === 0) return 0;
      const radians = Math.atan2(dy, dx);
      let degrees = radians * (180 / Math.PI) + 90;
      if (degrees < 0) degrees += 360;
      return degrees;
    },
    [getCenterOfElement],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (alwaysOn) return;
      const card = cardRef.current;
      if (!card) return;

      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const edge = getEdgeProximity(card, x, y);
      const angle = getCursorAngle(card, x, y);

      card.style.setProperty("--edge-proximity", `${(edge * 100).toFixed(3)}`);
      card.style.setProperty("--cursor-angle", `${angle.toFixed(3)}deg`);
    },
    [alwaysOn, getEdgeProximity, getCursorAngle],
  );

  // One-shot intro sweep (stock).
  useEffect(() => {
    if (!animated || alwaysOn || !cardRef.current) return;
    const card = cardRef.current;
    const angleStart = 110;
    const angleEnd = 465;
    card.classList.add("sweep-active");
    card.style.setProperty("--cursor-angle", `${angleStart}deg`);

    const cleanups = [
      animateValue({
        duration: 500,
        onUpdate: (v) => card.style.setProperty("--edge-proximity", String(v)),
      }),
      animateValue({
        ease: easeInCubic,
        duration: 1500,
        end: 50,
        onUpdate: (v) => {
          card.style.setProperty(
            "--cursor-angle",
            `${(angleEnd - angleStart) * (v / 100) + angleStart}deg`,
          );
        },
      }),
      animateValue({
        ease: easeOutCubic,
        delay: 1500,
        duration: 2250,
        start: 50,
        end: 100,
        onUpdate: (v) => {
          card.style.setProperty(
            "--cursor-angle",
            `${(angleEnd - angleStart) * (v / 100) + angleStart}deg`,
          );
        },
      }),
      animateValue({
        ease: easeInCubic,
        delay: 2500,
        duration: 1500,
        start: 100,
        end: 0,
        onUpdate: (v) => card.style.setProperty("--edge-proximity", String(v)),
        onEnd: () => card.classList.remove("sweep-active"),
      }),
    ];

    return () => {
      cleanups.forEach((fn) => fn());
      card.classList.remove("sweep-active");
    };
  }, [animated, alwaysOn]);

  // Continuous orbit — no hover needed.
  useEffect(() => {
    if (!alwaysOn || !cardRef.current) return;
    const card = cardRef.current;
    card.classList.add("always-on");
    card.style.setProperty("--edge-proximity", String(alwaysOnProximity));

    let raf = 0;
    const t0 = performance.now();
    const speed = Math.max(0, orbitSpeed);

    const tick = (now: number) => {
      const elapsedSec = (now - t0) / 1000;
      const deg = (elapsedSec * speed) % 360;
      card.style.setProperty("--cursor-angle", `${deg.toFixed(3)}deg`);
      card.style.setProperty("--edge-proximity", String(alwaysOnProximity));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      card.classList.remove("always-on");
    };
  }, [alwaysOn, orbitSpeed, alwaysOnProximity]);

  const glowVars = buildGlowVars(glowColor, glowIntensity);
  const tipRatio = Math.max(0.12, Math.min(0.55, hexTip));
  const tipPx = shapeHeight != null ? shapeHeight * tipRatio : 0;

  const classes = [
    "border-glow-card",
    bare ? "is-bare" : "",
    alwaysOn ? "always-on" : "",
    shape === "hex" ? "is-shape-hex" : "is-shape-rounded-rect",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const shapeVars: CSSProperties = {};
  if (shapeWidth != null) {
    (shapeVars as Record<string, string>)["--shape-w"] = `${shapeWidth}px`;
  }
  if (shapeHeight != null) {
    (shapeVars as Record<string, string>)["--shape-h"] = `${shapeHeight}px`;
    // Match CtaButton hex tip so glow and face share one silhouette.
    (shapeVars as Record<string, string>)["--shape-tip"] = `${tipPx}px`;
  }
  (shapeVars as Record<string, string>)["--shape-r"] = `${Math.max(0, borderRadius)}px`;

  return (
    <div
      ref={cardRef}
      onPointerMove={handlePointerMove}
      className={classes}
      style={{
        "--card-bg": backgroundColor,
        "--edge-sensitivity": edgeSensitivity,
        "--border-radius": `${borderRadius}px`,
        "--glow-padding": `${glowRadius}px`,
        "--cone-spread": coneSpread,
        "--fill-opacity": fillOpacity,
        ...shapeVars,
        ...glowVars,
        ...buildGradientVars(colors),
      } as CSSProperties}
    >
      <span className="edge-light" aria-hidden="true" />
      <div className="border-glow-inner">{children}</div>
    </div>
  );
}
